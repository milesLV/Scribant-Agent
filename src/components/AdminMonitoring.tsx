import { useState, useEffect, useRef } from "react";
import {
  Activity,
  ArrowDownToLine,
  ArrowUpFromLine,
  AlertCircle,
  Trash2,
  Search,
  ChevronDown,
  ChevronRight,
  RefreshCw,
  Zap,
  Terminal,
  Wrench,
  ShieldCheck,
  Server,
  Copy,
  Check,
} from "lucide-react";
import { AdkEvent } from "../types";
import TokenVisualizer from "./TokenVisualizer";
import { classifyEvent, EventFilterCategory, StatusFilterType } from "./DebugPanel";

interface AdminMonitoringProps {
  onEventsCountChange?: (count: number) => void;
  rawTranscript?: string;
  liveSummary?: string;
}

export default function AdminMonitoring({
  onEventsCountChange,
  rawTranscript = "",
  liveSummary = "",
}: AdminMonitoringProps) {
  const [events, setEvents] = useState<AdkEvent[]>([]);
  const [activeSubTab, setActiveSubTab] = useState<"tokens" | "telemetry" | "infra">("tokens");
  const [eventTypeFilter, setEventTypeFilter] = useState<EventFilterCategory>("all");
  const [authorFilter, setAuthorFilter] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<StatusFilterType>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [expandedEventId, setExpandedEventId] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [isLiveConnected, setIsLiveConnected] = useState(false);
  const [isTestingAction, setIsTestingAction] = useState<"insert" | "retrieve" | "tool_call" | null>(null);
  const [serverConfig, setServerConfig] = useState<any>(null);

  const eventSourceRef = useRef<EventSource | null>(null);

  // Notify parent of total event count
  useEffect(() => {
    onEventsCountChange?.(events.length);
  }, [events.length, onEventsCountChange]);

  // Fetch server config info
  useEffect(() => {
    fetch("/api/config")
      .then((res) => res.json())
      .then((data) => setServerConfig(data))
      .catch(() => {});
  }, []);

  // Connect to SSE stream
  useEffect(() => {
    let es: EventSource | null = null;

    const connectSSE = () => {
      try {
        es = new EventSource("/api/memory/events/stream");
        eventSourceRef.current = es;

        es.onopen = () => {
          setIsLiveConnected(true);
        };

        es.onmessage = (messageEvent) => {
          try {
            const payload = JSON.parse(messageEvent.data);
            if (payload.type === "init" && Array.isArray(payload.events)) {
              setEvents(payload.events);
            } else if (payload.type === "event" && payload.event) {
              setEvents((prev) => {
                const existingIndex = prev.findIndex((e) => e.id === payload.event.id);
                if (existingIndex >= 0) {
                  const next = [...prev];
                  next[existingIndex] = payload.event;
                  return next;
                }
                return [payload.event, ...prev];
              });
            }
          } catch (err) {
            console.warn("[AdminMonitoring] Failed to parse SSE message:", err);
          }
        };

        es.onerror = () => {
          setIsLiveConnected(false);
          es?.close();
          setTimeout(connectSSE, 3000);
        };
      } catch (err) {
        console.warn("[AdminMonitoring] SSE connection error:", err);
        setIsLiveConnected(false);
      }
    };

    connectSSE();

    return () => {
      es?.close();
    };
  }, []);

  const handleClearEvents = async () => {
    try {
      await fetch("/api/memory/events/clear", { method: "POST" });
      setEvents([]);
    } catch (e) {
      console.warn("Failed to clear memory events:", e);
    }
  };

  const handleTriggerTestInsert = async () => {
    setIsTestingAction("insert");
    try {
      await fetch("/api/memory/ingest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: `[ADK Event Test @ ${new Date().toLocaleTimeString()}]: User prefers meeting summaries delivered in markdown bullet points.`,
          sessionId: `adk-session-${Date.now()}`,
          userId: "default_user",
          plan: {
            ideasSummary: "User preference recorded via ADK event",
            calendarEvents: [],
            tasks: [],
            searches: [],
          },
        }),
      });
    } catch (e) {
      console.error("Test insert failed:", e);
    } finally {
      setTimeout(() => setIsTestingAction(null), 500);
    }
  };

  const handleTriggerTestRetrieve = async () => {
    setIsTestingAction("retrieve");
    try {
      await fetch("/api/memory/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: "What formatting or meeting preferences does the user have?",
          userId: "default_user",
        }),
      });
    } catch (e) {
      console.error("Test retrieve failed:", e);
    } finally {
      setTimeout(() => setIsTestingAction(null), 500);
    }
  };

  const handleCopyJson = (event: AdkEvent) => {
    navigator.clipboard.writeText(JSON.stringify(event, null, 2));
    setCopiedId(event.id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  // Filter logic
  const filteredEvents = events.filter((ev) => {
    const classified = classifyEvent(ev);

    if (eventTypeFilter !== "all" && classified.category !== eventTypeFilter) {
      return false;
    }
    if (authorFilter !== "all" && ev.author !== authorFilter) {
      return false;
    }
    if (statusFilter !== "all" && classified.status !== statusFilter) {
      return false;
    }
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      const rawText = JSON.stringify(ev).toLowerCase();
      return rawText.includes(q) || classified.summaryText.toLowerCase().includes(q);
    }

    return true;
  });

  const totalCount = events.length;
  const insertCount = events.filter((e) => classifyEvent(e).category === "memory:insert").length;
  const retrieveCount = events.filter((e) => classifyEvent(e).category === "memory:retrieve").length;
  const toolCount = events.filter((e) => classifyEvent(e).category === "tool_call").length;
  const errorCount = events.filter((e) => classifyEvent(e).status === "error").length;

  const authors = Array.from(new Set(events.map((e) => e.author).filter(Boolean))) as string[];

  return (
    <div className="w-full bg-white border border-stone-200/90 rounded-2xl shadow-xs overflow-hidden flex flex-col font-sans transition-all">
      {/* Top Header & Navigation Banner */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 p-5 bg-stone-50/70 border-b border-stone-200/90">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-indigo-500/10 border border-indigo-500/20 rounded-xl text-indigo-600">
            <Activity className="w-5 h-5" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-bold text-stone-900 font-sans tracking-tight">
                Administration &amp; Monitoring
              </h2>
              {/* SSE Live Status Indicator */}
              <div className="flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-white border border-stone-200/80 shadow-2xs">
                <span
                  className={`w-2 h-2 rounded-full ${
                    isLiveConnected
                      ? "bg-emerald-500 animate-pulse ring-2 ring-emerald-500/20"
                      : "bg-amber-500"
                  }`}
                />
                <span className="text-[10px] font-mono text-stone-700 font-bold">
                  {isLiveConnected ? "LIVE SSE" : "CONNECTING..."}
                </span>
              </div>
            </div>
            <p className="text-xs text-stone-500 font-sans mt-0.5">
              Real-time ADK telemetry, Vertex AI Memory Bank analytics, and token optimization engine
            </p>
          </div>
        </div>

        {/* Action Controls & Sub-Tab Switcher */}
        <div className="flex flex-wrap items-center gap-2 self-stretch sm:self-auto justify-between sm:justify-end">
          {/* Sub-Tab Switcher */}
          <div className="flex items-center bg-stone-100 p-1 rounded-xl border border-stone-200/80">
            <button
              type="button"
              onClick={() => setActiveSubTab("tokens")}
              className={`px-3 py-1.5 rounded-lg text-xs font-sans font-bold transition-all cursor-pointer flex items-center gap-1.5 ${
                activeSubTab === "tokens"
                  ? "bg-white text-stone-900 shadow-2xs border border-stone-200"
                  : "text-stone-600 hover:text-stone-900 hover:bg-stone-200/60"
              }`}
            >
              <Zap className={`w-3 h-3 ${activeSubTab === "tokens" ? "text-amber-600" : "text-stone-400"}`} />
              <span>Token Engine</span>
            </button>

            <button
              type="button"
              onClick={() => setActiveSubTab("telemetry")}
              className={`px-3 py-1.5 rounded-lg text-xs font-sans font-bold transition-all cursor-pointer flex items-center gap-1.5 ${
                activeSubTab === "telemetry"
                  ? "bg-white text-stone-900 shadow-2xs border border-stone-200"
                  : "text-stone-600 hover:text-stone-900 hover:bg-stone-200/60"
              }`}
            >
              <Terminal className={`w-3.5 h-3.5 ${activeSubTab === "telemetry" ? "text-indigo-600" : "text-stone-400"}`} />
              <span>ADK Telemetry</span>
              <span className="text-[10px] px-1.5 py-0.2 rounded-full bg-stone-200/80 text-stone-700 font-mono font-bold">
                {totalCount}
              </span>
            </button>

            <button
              type="button"
              onClick={() => setActiveSubTab("infra")}
              className={`px-3 py-1.5 rounded-lg text-xs font-sans font-bold transition-all cursor-pointer flex items-center gap-1.5 ${
                activeSubTab === "infra"
                  ? "bg-white text-stone-900 shadow-2xs border border-stone-200"
                  : "text-stone-600 hover:text-stone-900 hover:bg-stone-200/60"
              }`}
            >
              <Server className={`w-3.5 h-3.5 ${activeSubTab === "infra" ? "text-emerald-600" : "text-stone-400"}`} />
              <span>GCP Status</span>
            </button>
          </div>

          <button
            type="button"
            onClick={handleClearEvents}
            disabled={events.length === 0}
            title="Clear all recorded events"
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-stone-600 hover:text-red-600 hover:bg-red-50 border border-stone-200/80 rounded-xl transition-colors disabled:opacity-30 cursor-pointer font-sans"
          >
            <Trash2 className="w-3.5 h-3.5" />
            <span className="hidden md:inline">Clear Events</span>
          </button>
        </div>
      </div>

      {/* Main Tab Content */}
      <div className="bg-stone-50/30">
        {activeSubTab === "tokens" && (
          <TokenVisualizer
            events={events}
            rawTranscript={rawTranscript}
            liveSummary={liveSummary}
          />
        )}

        {activeSubTab === "infra" && (
          <div className="p-6 space-y-6 max-w-4xl">
            <div className="bg-white border border-stone-200/90 rounded-2xl p-5 space-y-4 shadow-2xs">
              <div className="flex items-center gap-2.5 text-emerald-700">
                <ShieldCheck className="w-5 h-5 text-emerald-600" />
                <h3 className="text-sm font-bold font-sans tracking-wide uppercase">
                  Connected Google Cloud Infrastructure
                </h3>
              </div>
              <p className="text-xs text-stone-600 leading-relaxed">
                Scribant is linked to Vertex AI Agent Engine with Application Default Credentials (ADC) and Google Cloud IAM.
              </p>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-3 pt-2">
                <div className="p-3 bg-stone-50 border border-stone-200/80 rounded-xl space-y-1 font-mono text-xs">
                  <span className="text-[10px] text-stone-500 uppercase tracking-wider block">GCP Project</span>
                  <span className="text-stone-900 font-bold">{serverConfig?.projectId || "scribant-dev-sincere-labrador"}</span>
                </div>

                <div className="p-3 bg-stone-50 border border-stone-200/80 rounded-xl space-y-1 font-mono text-xs">
                  <span className="text-[10px] text-stone-500 uppercase tracking-wider block">Vertex AI Region</span>
                  <span className="text-stone-900 font-bold">{serverConfig?.location || "us-central1"}</span>
                </div>

                <div className="p-3 bg-stone-50 border border-stone-200/80 rounded-xl space-y-1 font-mono text-xs">
                  <span className="text-[10px] text-stone-500 uppercase tracking-wider block">Reasoning Engine ID</span>
                  <span className="text-emerald-700 font-bold">{serverConfig?.agentEngineId || "1566436282941308928"}</span>
                </div>

                <div className="p-3 bg-stone-50 border border-stone-200/80 rounded-xl space-y-1 font-mono text-xs">
                  <span className="text-[10px] text-stone-500 uppercase tracking-wider block">Gemini Model</span>
                  <span className="text-amber-700 font-bold">gemini-3.7-flash</span>
                </div>
              </div>
            </div>

            <div className="bg-white border border-stone-200/90 rounded-2xl p-5 space-y-3 shadow-2xs">
              <h4 className="text-xs font-bold text-stone-800 font-sans uppercase tracking-wider">
                Memory Service Architecture
              </h4>
              <p className="text-xs text-stone-600 leading-relaxed">
                ADK orchestrates sub-agents (<code className="text-stone-800 font-mono">proofreader</code>, <code className="text-stone-800 font-mono">intentClassifier</code>, <code className="text-stone-800 font-mono">liveSummarizer</code>, <code className="text-stone-800 font-mono">audioTranscriber</code>) with dynamic session memory. High-value memories are indexed in Vertex AI Agent Engine, avoiding context stuffing on repeated audio chunks.
              </p>
            </div>
          </div>
        )}

        {activeSubTab === "telemetry" && (
          <div className="flex flex-col space-y-4 p-5 font-sans">
            {/* Controls Bar: Filters & Quick Test Buttons */}
            <div className="p-4 bg-white border border-stone-200/90 rounded-2xl shadow-2xs space-y-3">
              {/* Top row: Event Type Filter Tabs & Quick Test Buttons */}
              <div className="flex flex-wrap items-center justify-between gap-3">
                {/* Event Type Filter Tabs */}
                <div className="flex flex-wrap items-center gap-1.5 bg-stone-100 p-1 rounded-xl border border-stone-200/80">
                  <button
                    type="button"
                    onClick={() => setEventTypeFilter("all")}
                    className={`px-2.5 py-1 rounded-lg text-xs font-semibold transition-all flex items-center gap-1.5 cursor-pointer ${
                      eventTypeFilter === "all"
                        ? "bg-white text-stone-900 shadow-2xs font-bold border border-stone-200"
                        : "text-stone-600 hover:text-stone-900"
                    }`}
                  >
                    <Activity className="w-3 h-3 text-stone-500" />
                    <span>All</span>
                    <span className="text-[10px] px-1.5 py-0.2 rounded-full bg-stone-200/80 text-stone-700 font-mono font-bold">
                      {totalCount}
                    </span>
                  </button>

                  <button
                    type="button"
                    onClick={() => setEventTypeFilter((prev) => (prev === "memory:insert" ? "all" : "memory:insert"))}
                    className={`px-2.5 py-1 rounded-lg text-xs font-semibold transition-all flex items-center gap-1.5 cursor-pointer ${
                      eventTypeFilter === "memory:insert"
                        ? "bg-emerald-50 text-emerald-800 shadow-2xs border border-emerald-300 font-bold"
                        : "text-stone-600 hover:text-emerald-700"
                    }`}
                  >
                    <ArrowDownToLine className="w-3 h-3 text-emerald-600" />
                    <span>memory:insert</span>
                    <span className="text-[10px] px-1.5 py-0.2 rounded-full bg-emerald-100 text-emerald-800 font-bold font-mono">
                      {insertCount}
                    </span>
                  </button>

                  <button
                    type="button"
                    onClick={() => setEventTypeFilter((prev) => (prev === "memory:retrieve" ? "all" : "memory:retrieve"))}
                    className={`px-2.5 py-1 rounded-lg text-xs font-semibold transition-all flex items-center gap-1.5 cursor-pointer ${
                      eventTypeFilter === "memory:retrieve"
                        ? "bg-sky-50 text-sky-800 shadow-2xs border border-sky-300 font-bold"
                        : "text-stone-600 hover:text-sky-700"
                    }`}
                  >
                    <ArrowUpFromLine className="w-3 h-3 text-sky-600" />
                    <span>memory:retrieve</span>
                    <span className="text-[10px] px-1.5 py-0.2 rounded-full bg-sky-100 text-sky-800 font-bold font-mono">
                      {retrieveCount}
                    </span>
                  </button>

                  <button
                    type="button"
                    onClick={() => setEventTypeFilter((prev) => (prev === "tool_call" ? "all" : "tool_call"))}
                    className={`px-2.5 py-1 rounded-lg text-xs font-semibold transition-all flex items-center gap-1.5 cursor-pointer ${
                      eventTypeFilter === "tool_call"
                        ? "bg-purple-50 text-purple-800 shadow-2xs border border-purple-300 font-bold"
                        : "text-stone-600 hover:text-purple-700"
                    }`}
                  >
                    <Wrench className="w-3 h-3 text-purple-600" />
                    <span>tools</span>
                    <span className="text-[10px] px-1.5 py-0.2 rounded-full bg-purple-100 text-purple-800 font-bold font-mono">
                      {toolCount}
                    </span>
                  </button>

                  {errorCount > 0 && (
                    <button
                      type="button"
                      onClick={() => setEventTypeFilter((prev) => (prev === "error" ? "all" : "error"))}
                      className={`px-2.5 py-1 rounded-lg text-xs font-semibold transition-all flex items-center gap-1.5 cursor-pointer ${
                        eventTypeFilter === "error"
                          ? "bg-red-50 text-red-800 shadow-2xs border border-red-300 font-bold"
                          : "text-red-600 hover:text-red-800"
                      }`}
                    >
                      <AlertCircle className="w-3 h-3 text-red-600" />
                      <span>errors</span>
                      <span className="text-[10px] px-1.5 py-0.2 rounded-full bg-red-100 text-red-800 font-bold font-mono">
                        {errorCount}
                      </span>
                    </button>
                  )}
                </div>

                {/* Quick Simulation / Test Buttons */}
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={handleTriggerTestInsert}
                    disabled={isTestingAction !== null}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-xl bg-emerald-50 hover:bg-emerald-100 text-emerald-800 border border-emerald-200 transition-all disabled:opacity-50 cursor-pointer shadow-2xs"
                  >
                    {isTestingAction === "insert" ? (
                      <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <ArrowDownToLine className="w-3.5 h-3.5 text-emerald-600" />
                    )}
                    <span>Test Ingest</span>
                  </button>

                  <button
                    type="button"
                    onClick={handleTriggerTestRetrieve}
                    disabled={isTestingAction !== null}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-xl bg-sky-50 hover:bg-sky-100 text-sky-800 border border-sky-200 transition-all disabled:opacity-50 cursor-pointer shadow-2xs"
                  >
                    {isTestingAction === "retrieve" ? (
                      <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <ArrowUpFromLine className="w-3.5 h-3.5 text-sky-600" />
                    )}
                    <span>Test Search</span>
                  </button>
                </div>
              </div>

              {/* Bottom row: Search input, Author dropdown, Status filter */}
              <div className="flex flex-wrap items-center justify-between gap-3 pt-2 border-t border-stone-100 text-xs">
                <div className="flex flex-wrap items-center gap-2 flex-1 min-w-[200px]">
                  {/* Search Box */}
                  <div className="relative flex-1 max-w-xs">
                    <Search className="w-3.5 h-3.5 text-stone-400 absolute left-3 top-1/2 -translate-y-1/2" />
                    <input
                      type="text"
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      placeholder="Search telemetry events..."
                      className="w-full bg-stone-50 border border-stone-200 rounded-xl pl-8 pr-2.5 py-1.5 text-xs text-stone-800 placeholder-stone-400 font-sans outline-none focus:border-amber-500"
                    />
                    {searchQuery && (
                      <button
                        type="button"
                        onClick={() => setSearchQuery("")}
                        className="absolute right-2.5 top-1/2 -translate-y-1/2 text-stone-400 hover:text-stone-600"
                      >
                        ×
                      </button>
                    )}
                  </div>

                  {/* Author Filter Dropdown */}
                  {authors.length > 0 && (
                    <select
                      value={authorFilter}
                      onChange={(e) => setAuthorFilter(e.target.value)}
                      className="bg-stone-50 border border-stone-200 text-stone-700 rounded-xl px-2.5 py-1.5 text-xs font-sans outline-none cursor-pointer"
                    >
                      <option value="all">All Authors</option>
                      {authors.map((a) => (
                        <option key={a} value={a}>
                          Author: {a}
                        </option>
                      ))}
                    </select>
                  )}

                  {/* Status Filter */}
                  <div className="flex items-center bg-stone-100 border border-stone-200 rounded-xl p-0.5">
                    {(["all", "success", "error"] as StatusFilterType[]).map((st) => (
                      <button
                        key={st}
                        type="button"
                        onClick={() => setStatusFilter(st)}
                        className={`px-2.5 py-1 rounded-lg text-xs font-sans capitalize transition-colors cursor-pointer ${
                          statusFilter === st
                            ? "bg-white text-stone-900 font-bold shadow-2xs"
                            : "text-stone-600 hover:text-stone-900"
                        }`}
                      >
                        {st}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </div>

            {/* Event List (Expands vertically on the page without max-h scroll limits!) */}
            <div className="space-y-3">
              {filteredEvents.length === 0 ? (
                <div className="p-8 text-center bg-white border border-stone-200/90 rounded-2xl text-stone-500 space-y-2">
                  <Activity className="w-8 h-8 mx-auto opacity-30 text-stone-400 animate-pulse" />
                  <p className="text-xs font-semibold text-stone-700">No ADK telemetry events match current filters.</p>
                  <p className="text-xs text-stone-500">
                    Speak into the microphone or click "Test Ingest" / "Test Search" to generate live events.
                  </p>
                </div>
              ) : (
                filteredEvents.map((ev) => {
                  const classified = classifyEvent(ev);
                  const isExpanded = expandedEventId === ev.id;
                  const isCopied = copiedId === ev.id;
                  const timestampStr = new Date(ev.timestamp || Date.now()).toLocaleTimeString();

                  let badgeBg = "bg-stone-100 text-stone-800 border-stone-200";
                  let Icon = Activity;

                  if (classified.category === "memory:insert") {
                    badgeBg = "bg-emerald-50 text-emerald-800 border-emerald-200";
                    Icon = ArrowDownToLine;
                  } else if (classified.category === "memory:retrieve") {
                    badgeBg = "bg-sky-50 text-sky-800 border-sky-200";
                    Icon = ArrowUpFromLine;
                  } else if (classified.category === "tool_call") {
                    badgeBg = "bg-purple-50 text-purple-800 border-purple-200";
                    Icon = Wrench;
                  } else if (classified.status === "error") {
                    badgeBg = "bg-red-50 text-red-800 border-red-200";
                    Icon = AlertCircle;
                  }

                  return (
                    <div
                      key={ev.id}
                      className="bg-white border border-stone-200/90 rounded-2xl overflow-hidden shadow-2xs transition-all hover:border-stone-300"
                    >
                      <button
                        onClick={() => setExpandedEventId(isExpanded ? null : ev.id)}
                        className="w-full text-left p-4 flex items-center justify-between gap-3 hover:bg-stone-50/70 transition-colors cursor-pointer"
                      >
                        <div className="flex flex-wrap items-center gap-3">
                          <span className={`px-2.5 py-1 text-xs font-mono font-bold rounded-lg border flex items-center gap-1.5 ${badgeBg}`}>
                            <Icon className="w-3.5 h-3.5" />
                            <span>{classified.category}</span>
                          </span>

                          <span className="text-xs font-mono font-bold text-stone-800">
                            {ev.author || "system"}
                          </span>

                          <span className="text-xs text-stone-600 font-sans border-l border-stone-200 pl-3 line-clamp-1">
                            {classified.summaryText}
                          </span>
                        </div>

                        <div className="flex items-center gap-3 shrink-0">
                          <span className="text-[11px] font-mono text-stone-400">
                            {timestampStr}
                          </span>
                          {isExpanded ? (
                            <ChevronDown className="w-4 h-4 text-stone-600" />
                          ) : (
                            <ChevronRight className="w-4 h-4 text-stone-400" />
                          )}
                        </div>
                      </button>

                      {isExpanded && (
                        <div className="p-4 pt-0 border-t border-stone-100 bg-stone-50/40 space-y-3 text-xs">
                          <div className="flex items-center justify-between pt-3">
                            <span className="font-mono text-[11px] font-bold text-stone-600 uppercase tracking-wider">
                              Event Payload JSON
                            </span>
                            <button
                              onClick={() => handleCopyJson(ev)}
                              className="flex items-center gap-1 text-xs font-semibold text-stone-600 hover:text-stone-900 cursor-pointer"
                            >
                              {isCopied ? (
                                <>
                                  <Check className="w-3.5 h-3.5 text-emerald-600" />
                                  <span className="text-emerald-600">Copied!</span>
                                </>
                              ) : (
                                <>
                                  <Copy className="w-3.5 h-3.5" />
                                  <span>Copy JSON</span>
                                </>
                              )}
                            </button>
                          </div>
                          <pre className="p-3 bg-stone-900 text-stone-200 rounded-xl font-mono text-[11px] overflow-x-auto border border-stone-800 leading-normal">
                            {JSON.stringify(ev, null, 2)}
                          </pre>
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
