import { useState, useEffect, useRef } from "react";
import {
  Activity,
  ArrowDownToLine,
  ArrowUpFromLine,
  CheckCircle2,
  AlertCircle,
  Clock,
  Database,
  Search,
  Sparkles,
  Trash2,
  Copy,
  Check,
  ChevronDown,
  ChevronRight,
  RefreshCw,
  Zap,
  Terminal,
  Cpu,
  Bot,
  Wrench,
  Lightbulb,
  FileCode,
  ShieldCheck,
  Server,
  Layers,
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
  const [autoScroll, setAutoScroll] = useState(true);
  const [serverConfig, setServerConfig] = useState<any>(null);

  const eventListRef = useRef<HTMLDivElement>(null);
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

  // Auto-scroll when new events arrive
  useEffect(() => {
    if (autoScroll && eventListRef.current && events.length > 0) {
      eventListRef.current.scrollTo({ top: 0, behavior: "smooth" });
    }
  }, [events.length, autoScroll]);

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
      const timestamp = new Date().toISOString();
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

    // 1. Event Type Filter
    if (eventTypeFilter !== "all" && classified.category !== eventTypeFilter) {
      return false;
    }

    // 2. Author Filter
    if (authorFilter !== "all" && ev.author !== authorFilter) {
      return false;
    }

    // 3. Status Filter
    if (statusFilter !== "all" && classified.status !== statusFilter) {
      return false;
    }

    // 4. Search Query Filter
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      const rawText = JSON.stringify(ev).toLowerCase();
      return rawText.includes(q) || classified.summaryText.toLowerCase().includes(q);
    }

    return true;
  });

  // Calculate quick stats
  const totalCount = events.length;
  const insertCount = events.filter((e) => classifyEvent(e).category === "memory:insert").length;
  const retrieveCount = events.filter((e) => classifyEvent(e).category === "memory:retrieve").length;
  const toolCount = events.filter((e) => classifyEvent(e).category === "tool_call").length;
  const errorCount = events.filter((e) => classifyEvent(e).status === "error").length;

  const authors = Array.from(new Set(events.map((e) => e.author).filter(Boolean))) as string[];

  return (
    <div className="w-full bg-stone-900 border border-stone-800 rounded-2xl shadow-xl overflow-hidden flex flex-col font-sans transition-all">
      {/* Top Header & Navigation Banner */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 p-4 bg-stone-950 border-b border-stone-800">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-indigo-500/10 border border-indigo-500/20 rounded-xl text-indigo-400">
            <Activity className="w-5 h-5" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-bold text-stone-100 font-mono tracking-tight">
                Administration &amp; Monitoring
              </h2>
              {/* SSE Live Status Indicator */}
              <div className="flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-stone-900 border border-stone-800">
                <span
                  className={`w-2 h-2 rounded-full ${
                    isLiveConnected
                      ? "bg-emerald-400 animate-pulse ring-2 ring-emerald-400/30"
                      : "bg-amber-400"
                  }`}
                />
                <span className="text-[10px] font-mono text-stone-300 font-bold">
                  {isLiveConnected ? "LIVE SSE" : "CONNECTING..."}
                </span>
              </div>
            </div>
            <p className="text-xs text-stone-400 font-sans">
              Real-time ADK telemetry, Vertex AI Memory Bank analytics, and token optimization engine
            </p>
          </div>
        </div>

        {/* Action Controls & Sub-Tab Switcher */}
        <div className="flex flex-wrap items-center gap-2 self-stretch sm:self-auto justify-between sm:justify-end">
          {/* Sub-Tab Switcher */}
          <div className="flex items-center bg-stone-900 p-1 rounded-xl border border-stone-800">
            <button
              type="button"
              onClick={() => setActiveSubTab("tokens")}
              className={`px-3 py-1.5 rounded-lg text-xs font-mono font-bold transition-all cursor-pointer flex items-center gap-1.5 ${
                activeSubTab === "tokens"
                  ? "bg-amber-500/20 text-amber-300 border border-amber-500/40 shadow-xs"
                  : "text-stone-400 hover:text-stone-200"
              }`}
            >
              <Zap className="w-3.5 h-3.5 text-amber-400" />
              <span>Token Engine</span>
            </button>

            <button
              type="button"
              onClick={() => setActiveSubTab("telemetry")}
              className={`px-3 py-1.5 rounded-lg text-xs font-mono font-bold transition-all cursor-pointer flex items-center gap-1.5 ${
                activeSubTab === "telemetry"
                  ? "bg-indigo-500/20 text-indigo-300 border border-indigo-500/40 shadow-xs"
                  : "text-stone-400 hover:text-stone-200"
              }`}
            >
              <Terminal className="w-3.5 h-3.5 text-indigo-400" />
              <span>ADK Telemetry</span>
              <span className="text-[10px] px-1.5 py-0.2 rounded-full bg-stone-950 text-stone-300 font-mono">
                {totalCount}
              </span>
            </button>

            <button
              type="button"
              onClick={() => setActiveSubTab("infra")}
              className={`px-3 py-1.5 rounded-lg text-xs font-mono font-bold transition-all cursor-pointer flex items-center gap-1.5 ${
                activeSubTab === "infra"
                  ? "bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 shadow-xs"
                  : "text-stone-400 hover:text-stone-200"
              }`}
            >
              <Server className="w-3.5 h-3.5 text-emerald-400" />
              <span>GCP Status</span>
            </button>
          </div>

          <button
            type="button"
            onClick={handleClearEvents}
            disabled={events.length === 0}
            title="Clear all recorded events"
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-stone-400 hover:text-red-400 hover:bg-stone-800 border border-stone-800 rounded-xl transition-colors disabled:opacity-30 cursor-pointer font-mono"
          >
            <Trash2 className="w-3.5 h-3.5" />
            <span className="hidden md:inline">Clear Events</span>
          </button>
        </div>
      </div>

      {/* Main Tab Content */}
      <div className="flex-1 min-h-0 bg-stone-900/95">
        {activeSubTab === "tokens" && (
          <TokenVisualizer
            events={events}
            rawTranscript={rawTranscript}
            liveSummary={liveSummary}
          />
        )}

        {activeSubTab === "infra" && (
          <div className="p-6 space-y-6 max-w-4xl">
            <div className="bg-stone-950 border border-stone-800 rounded-2xl p-5 space-y-4">
              <div className="flex items-center gap-2.5 text-emerald-400">
                <ShieldCheck className="w-5 h-5" />
                <h3 className="text-sm font-bold font-mono tracking-wide uppercase">
                  Connected Google Cloud Infrastructure
                </h3>
              </div>
              <p className="text-xs text-stone-400 leading-relaxed">
                Scribant is linked to Vertex AI Agent Engine with Application Default Credentials (ADC) and Google Cloud IAM.
              </p>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-3 pt-2">
                <div className="p-3 bg-stone-900/80 border border-stone-800 rounded-xl space-y-1 font-mono text-xs">
                  <span className="text-[10px] text-stone-500 uppercase tracking-wider block">GCP Project</span>
                  <span className="text-stone-200 font-bold">{serverConfig?.projectId || "scribant-dev-sincere-labrador"}</span>
                </div>

                <div className="p-3 bg-stone-900/80 border border-stone-800 rounded-xl space-y-1 font-mono text-xs">
                  <span className="text-[10px] text-stone-500 uppercase tracking-wider block">Vertex AI Region</span>
                  <span className="text-stone-200 font-bold">{serverConfig?.location || "us-central1"}</span>
                </div>

                <div className="p-3 bg-stone-900/80 border border-stone-800 rounded-xl space-y-1 font-mono text-xs">
                  <span className="text-[10px] text-stone-500 uppercase tracking-wider block">Reasoning Engine ID</span>
                  <span className="text-emerald-400 font-bold">{serverConfig?.agentEngineId || "1566436282941308928"}</span>
                </div>

                <div className="p-3 bg-stone-900/80 border border-stone-800 rounded-xl space-y-1 font-mono text-xs">
                  <span className="text-[10px] text-stone-500 uppercase tracking-wider block">Gemini Model</span>
                  <span className="text-amber-300 font-bold">gemini-3.7-flash</span>
                </div>
              </div>
            </div>

            <div className="bg-stone-950 border border-stone-800 rounded-2xl p-5 space-y-3">
              <h4 className="text-xs font-bold text-stone-300 font-mono uppercase tracking-wider">
                Memory Service Architecture
              </h4>
              <p className="text-xs text-stone-400 leading-relaxed">
                ADK orchestrates sub-agents (`proofreader`, `intentClassifier`, `liveSummarizer`, `audioTranscriber`) with dynamic session memory. High-value memories are indexed in Vertex AI Agent Engine, avoiding context stuffing on repeated audio chunks.
              </p>
            </div>
          </div>
        )}

        {activeSubTab === "telemetry" && (
          <div className="flex flex-col min-h-0">
            {/* Controls Bar: Filters & Quick Test Buttons */}
            <div className="p-3 bg-stone-950/60 border-b border-stone-800/80 space-y-2.5 shrink-0">
              {/* Top row: Event Type Filter Tabs & Quick Test Buttons */}
              <div className="flex flex-wrap items-center justify-between gap-2.5">
                {/* Event Type Filter Tabs */}
                <div className="flex flex-wrap items-center gap-1 bg-stone-900 p-1 rounded-xl border border-stone-800">
                  <button
                    type="button"
                    onClick={() => setEventTypeFilter("all")}
                    className={`px-2 py-1 rounded-lg text-xs font-mono font-semibold transition-all flex items-center gap-1.5 cursor-pointer ${
                      eventTypeFilter === "all"
                        ? "bg-stone-800 text-stone-100 shadow-sm border border-stone-700 ring-1 ring-stone-600"
                        : "text-stone-400 hover:text-stone-200"
                    }`}
                  >
                    <Activity className="w-3 h-3" />
                    <span>All</span>
                    <span className="text-[10px] px-1.5 py-0.2 rounded-full bg-stone-950 text-stone-400">
                      {totalCount}
                    </span>
                  </button>

                  <button
                    type="button"
                    onClick={() => setEventTypeFilter((prev) => (prev === "memory:insert" ? "all" : "memory:insert"))}
                    className={`px-2 py-1 rounded-lg text-xs font-mono font-semibold transition-all flex items-center gap-1.5 cursor-pointer ${
                      eventTypeFilter === "memory:insert"
                        ? "bg-emerald-950 text-emerald-300 shadow-sm border border-emerald-600 ring-1 ring-emerald-500/50"
                        : "text-stone-400 hover:text-emerald-400"
                    }`}
                  >
                    <ArrowDownToLine className="w-3 h-3 text-emerald-400" />
                    <span>memory:insert</span>
                    <span className="text-[10px] px-1.5 py-0.2 rounded-full bg-stone-950 text-emerald-400 font-bold">
                      {insertCount}
                    </span>
                  </button>

                  <button
                    type="button"
                    onClick={() => setEventTypeFilter((prev) => (prev === "memory:retrieve" ? "all" : "memory:retrieve"))}
                    className={`px-2 py-1 rounded-lg text-xs font-mono font-semibold transition-all flex items-center gap-1.5 cursor-pointer ${
                      eventTypeFilter === "memory:retrieve"
                        ? "bg-sky-950 text-sky-300 shadow-sm border border-sky-600 ring-1 ring-sky-500/50"
                        : "text-stone-400 hover:text-sky-400"
                    }`}
                  >
                    <ArrowUpFromLine className="w-3 h-3 text-sky-400" />
                    <span>memory:retrieve</span>
                    <span className="text-[10px] px-1.5 py-0.2 rounded-full bg-stone-950 text-sky-400 font-bold">
                      {retrieveCount}
                    </span>
                  </button>

                  <button
                    type="button"
                    onClick={() => setEventTypeFilter((prev) => (prev === "tool_call" ? "all" : "tool_call"))}
                    className={`px-2 py-1 rounded-lg text-xs font-mono font-semibold transition-all flex items-center gap-1.5 cursor-pointer ${
                      eventTypeFilter === "tool_call"
                        ? "bg-purple-950 text-purple-300 shadow-sm border border-purple-600 ring-1 ring-purple-500/50"
                        : "text-stone-400 hover:text-purple-400"
                    }`}
                  >
                    <Wrench className="w-3 h-3 text-purple-400" />
                    <span>tools</span>
                    <span className="text-[10px] px-1.5 py-0.2 rounded-full bg-stone-950 text-purple-400 font-bold">
                      {toolCount}
                    </span>
                  </button>

                  {errorCount > 0 && (
                    <button
                      type="button"
                      onClick={() => setEventTypeFilter((prev) => (prev === "error" ? "all" : "error"))}
                      className={`px-2 py-1 rounded-lg text-xs font-mono font-semibold transition-all flex items-center gap-1.5 cursor-pointer ${
                        eventTypeFilter === "error"
                          ? "bg-red-950 text-red-300 shadow-sm border border-red-600 ring-1 ring-red-500/50"
                          : "text-red-400 hover:text-red-300"
                      }`}
                    >
                      <AlertCircle className="w-3 h-3 text-red-400" />
                      <span>errors</span>
                      <span className="text-[10px] px-1.5 py-0.2 rounded-full bg-stone-950 text-red-400 font-bold">
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
                    className="flex items-center gap-1 px-2.5 py-1 text-xs font-mono font-semibold rounded-lg bg-emerald-950/60 hover:bg-emerald-900/80 text-emerald-300 border border-emerald-700/50 hover:border-emerald-500 transition-all disabled:opacity-50 cursor-pointer"
                  >
                    {isTestingAction === "insert" ? (
                      <RefreshCw className="w-3 h-3 animate-spin" />
                    ) : (
                      <ArrowDownToLine className="w-3 h-3 text-emerald-400" />
                    )}
                    <span>Test Ingest</span>
                  </button>

                  <button
                    type="button"
                    onClick={handleTriggerTestRetrieve}
                    disabled={isTestingAction !== null}
                    className="flex items-center gap-1 px-2.5 py-1 text-xs font-mono font-semibold rounded-lg bg-sky-950/60 hover:bg-sky-900/80 text-sky-300 border border-sky-700/50 hover:border-sky-500 transition-all disabled:opacity-50 cursor-pointer"
                  >
                    {isTestingAction === "retrieve" ? (
                      <RefreshCw className="w-3 h-3 animate-spin" />
                    ) : (
                      <ArrowUpFromLine className="w-3 h-3 text-sky-400" />
                    )}
                    <span>Test Search</span>
                  </button>
                </div>
              </div>

              {/* Bottom row: Search input, Author dropdown, Status filter, Auto-scroll toggle */}
              <div className="flex flex-wrap items-center justify-between gap-2 pt-1 border-t border-stone-800/60 text-xs">
                <div className="flex flex-wrap items-center gap-2 flex-1 min-w-[200px]">
                  {/* Search Box */}
                  <div className="relative flex-1 max-w-xs">
                    <Search className="w-3.5 h-3.5 text-stone-500 absolute left-2.5 top-1/2 -translate-y-1/2" />
                    <input
                      type="text"
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      placeholder="Search telemetry events..."
                      className="w-full bg-stone-900 border border-stone-800 focus:border-stone-700 rounded-lg pl-8 pr-2.5 py-1 text-xs text-stone-200 placeholder-stone-500 font-mono outline-none"
                    />
                    {searchQuery && (
                      <button
                        type="button"
                        onClick={() => setSearchQuery("")}
                        className="absolute right-2 top-1/2 -translate-y-1/2 text-stone-500 hover:text-stone-300"
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
                      className="bg-stone-900 border border-stone-800 text-stone-300 rounded-lg px-2.5 py-1 text-xs font-mono outline-none cursor-pointer"
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
                  <div className="flex items-center bg-stone-900 border border-stone-800 rounded-lg p-0.5">
                    {(["all", "success", "error"] as StatusFilterType[]).map((st) => (
                      <button
                        key={st}
                        type="button"
                        onClick={() => setStatusFilter(st)}
                        className={`px-2 py-0.5 rounded text-[11px] font-mono capitalize transition-colors ${
                          statusFilter === st
                            ? "bg-stone-800 text-stone-100 font-bold"
                            : "text-stone-400 hover:text-stone-200"
                        }`}
                      >
                        {st}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Auto Scroll Checkbox */}
                <label className="flex items-center gap-1.5 text-[11px] font-mono text-stone-400 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={autoScroll}
                    onChange={(e) => setAutoScroll(e.target.checked)}
                    className="accent-indigo-500 rounded"
                  />
                  <span>Auto-scroll to latest</span>
                </label>
              </div>
            </div>

            {/* Event List */}
            <div
              ref={eventListRef}
              className="p-3 space-y-2 overflow-y-auto max-h-[600px] min-h-[300px] font-mono text-xs"
            >
              {filteredEvents.length === 0 ? (
                <div className="py-12 text-center text-stone-500 space-y-2">
                  <Activity className="w-8 h-8 mx-auto opacity-30 animate-pulse" />
                  <p className="text-xs font-mono">No ADK telemetry events match current filters.</p>
                  <p className="text-[11px] text-stone-600 font-sans">
                    Speak into the microphone or click "Test Ingest" / "Test Search" to generate live events.
                  </p>
                </div>
              ) : (
                filteredEvents.map((ev) => {
                  const classified = classifyEvent(ev);
                  const isExpanded = expandedEventId === ev.id;
                  const isCopied = copiedId === ev.id;
                  const timestampStr = new Date(ev.timestamp || Date.now()).toLocaleTimeString();

                  // Category visual style tokens
                  let badgeBg = "bg-stone-800 text-stone-300 border-stone-700";
                  let Icon = Activity;

                  if (classified.category === "memory:insert") {
                    badgeBg = "bg-emerald-950/80 text-emerald-300 border-emerald-700/60";
                    Icon = ArrowDownToLine;
                  } else if (classified.category === "memory:retrieve") {
                    badgeBg = "bg-sky-950/80 text-sky-300 border-sky-700/60";
                    Icon = ArrowUpFromLine;
                  } else if (classified.category === "thought") {
                    badgeBg = "bg-amber-950/80 text-amber-300 border-amber-700/60";
                    Icon = Lightbulb;
                  } else if (classified.category === "tool_call") {
                    badgeBg = "bg-purple-950/80 text-purple-300 border-purple-700/60";
                    Icon = Wrench;
                  }

                  if (classified.status === "error") {
                    badgeBg = "bg-red-950/80 text-red-300 border-red-700/60";
                    Icon = AlertCircle;
                  }

                  return (
                    <div
                      key={ev.id}
                      className={`border rounded-xl transition-all ${
                        isExpanded
                          ? "bg-stone-950 border-stone-700 shadow-md ring-1 ring-stone-700/50"
                          : "bg-stone-950/60 border-stone-800/80 hover:bg-stone-950 hover:border-stone-700"
                      }`}
                    >
                      {/* Event Row Header */}
                      <div
                        onClick={() => setExpandedEventId(isExpanded ? null : ev.id)}
                        className="p-2.5 flex items-center justify-between gap-2.5 cursor-pointer select-none"
                      >
                        <div className="flex items-center gap-2 min-w-0 flex-1">
                          <button
                            type="button"
                            className="text-stone-500 hover:text-stone-300 shrink-0"
                          >
                            {isExpanded ? (
                              <ChevronDown className="w-3.5 h-3.5" />
                            ) : (
                              <ChevronRight className="w-3.5 h-3.5" />
                            )}
                          </button>

                          {/* Event Category Badge */}
                          <span
                            className={`px-2 py-0.5 rounded-md text-[10.5px] font-mono font-bold border flex items-center gap-1 shrink-0 ${badgeBg}`}
                          >
                            <Icon className="w-3 h-3" />
                            <span>{classified.label}</span>
                          </span>

                          {/* Author Badge */}
                          {ev.author && (
                            <span className="px-1.5 py-0.5 rounded bg-stone-900 text-stone-400 border border-stone-800 text-[10px] shrink-0 font-mono">
                              @{ev.author}
                            </span>
                          )}

                          {/* Summary Text Snippet */}
                          <span className="text-stone-300 text-xs truncate flex-1 font-sans">
                            {classified.summaryText}
                          </span>
                        </div>

                        {/* Right Meta Info */}
                        <div className="flex items-center gap-2 shrink-0">
                          {typeof classified.durationMs === "number" && (
                            <span className="text-[10px] font-mono text-stone-500 flex items-center gap-1">
                              <Clock className="w-2.5 h-2.5" />
                              {classified.durationMs}ms
                            </span>
                          )}

                          <span className="text-[10px] font-mono text-stone-500">
                            {timestampStr}
                          </span>

                          {/* Copy JSON Button */}
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleCopyJson(ev);
                            }}
                            title="Copy full JSON event"
                            className="p-1 text-stone-400 hover:text-stone-200 hover:bg-stone-800 rounded transition-colors"
                          >
                            {isCopied ? (
                              <Check className="w-3 h-3 text-emerald-400" />
                            ) : (
                              <Copy className="w-3 h-3" />
                            )}
                          </button>
                        </div>
                      </div>

                      {/* Expanded Event Details & JSON Payload */}
                      {isExpanded && (
                        <div className="p-3 border-t border-stone-800/80 bg-stone-900/60 space-y-2.5">
                          {/* Key details */}
                          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-[11px] font-mono">
                            <div className="bg-stone-950 p-2 rounded-lg border border-stone-800">
                              <span className="text-stone-500 block text-[10px]">EVENT ID</span>
                              <span className="text-stone-300 truncate block">{ev.id}</span>
                            </div>
                            <div className="bg-stone-950 p-2 rounded-lg border border-stone-800">
                              <span className="text-stone-500 block text-[10px]">AUTHOR</span>
                              <span className="text-stone-300 truncate block">{ev.author || "system"}</span>
                            </div>
                            <div className="bg-stone-950 p-2 rounded-lg border border-stone-800">
                              <span className="text-stone-500 block text-[10px]">SERVICE</span>
                              <span className="text-stone-300 truncate block">{classified.service || "vertex_ai"}</span>
                            </div>
                            <div className="bg-stone-950 p-2 rounded-lg border border-stone-800">
                              <span className="text-stone-500 block text-[10px]">STATUS</span>
                              <span
                                className={`font-bold block uppercase ${
                                  classified.status === "error"
                                    ? "text-red-400"
                                    : classified.status === "success"
                                    ? "text-emerald-400"
                                    : "text-sky-400"
                                }`}
                              >
                                {classified.status}
                              </span>
                            </div>
                          </div>

                          {/* Raw JSON Code Block */}
                          <div className="space-y-1">
                            <div className="flex items-center justify-between text-[10px] text-stone-400 font-mono">
                              <span className="flex items-center gap-1">
                                <FileCode className="w-3 h-3" /> Raw ADK Event Payload
                              </span>
                              <button
                                type="button"
                                onClick={() => handleCopyJson(ev)}
                                className="hover:text-stone-200 transition-colors flex items-center gap-1"
                              >
                                {isCopied ? "Copied!" : "Copy Payload"}
                              </button>
                            </div>
                            <pre className="p-3 bg-stone-950 border border-stone-800 rounded-xl text-[11px] text-stone-300 overflow-x-auto max-h-60 leading-relaxed font-mono select-text">
                              {JSON.stringify(ev, null, 2)}
                            </pre>
                          </div>
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
