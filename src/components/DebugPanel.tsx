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
  X,
  Maximize2,
  Minimize2,
  Terminal,
  Cpu,
  Bot,
  Wrench,
  Lightbulb,
  FileCode,
} from "lucide-react";
import { AdkEvent } from "../types";

interface DebugPanelProps {
  isOpen: boolean;
  onClose: () => void;
  onEventsCountChange?: (count: number) => void;
}

export type EventFilterCategory =
  | "all"
  | "memory:insert"
  | "memory:retrieve"
  | "thought"
  | "tool_call"
  | "content"
  | "error";

export type StatusFilterType = "all" | "success" | "error";

/**
 * Classifies an ADK Event into a category for filtering and visualization.
 */
export function classifyEvent(event: AdkEvent): {
  category: EventFilterCategory | string;
  label: string;
  isMemory: boolean;
  status: "success" | "error" | "info";
  summaryText: string;
  durationMs?: number;
  service?: string;
  query?: string;
  answer?: string;
  error?: string;
} {
  const anyEvt = event as any;
  const delta = event.actions?.stateDelta || anyEvt.actions?.state_delta || anyEvt.stateDelta || {};
  const explicitType =
    (typeof anyEvt.type === "string" && anyEvt.type !== "event" ? anyEvt.type : null) ||
    delta.eventType ||
    delta.event_type ||
    anyEvt.eventType ||
    event.customMetadata?.eventType ||
    anyEvt.customMetadata?.event_type;

  // 1. Is it Memory Insert?
  const isMemoryInsert =
    explicitType === "memory:insert" ||
    (event.author === "memory" && (delta.text || anyEvt.text || event.content?.parts?.some((p) => typeof p.text === "string" && p.text.includes("[Memory Ingest]")))) ||
    (event.author === "memory" && !delta.query && !anyEvt.query && !event.content?.parts?.some((p) => typeof p.text === "string" && p.text.includes("[Memory Retrieve]")));

  // 2. Is it Memory Retrieve?
  const isMemoryRetrieve =
    explicitType === "memory:retrieve" ||
    (event.author === "memory" && (delta.query || anyEvt.query || event.content?.parts?.some((p) => typeof p.text === "string" && p.text.includes("[Memory Retrieve]"))));

  if (isMemoryInsert) {
    const isError = delta.status === "error" || anyEvt.status === "error" || Boolean(delta.error) || Boolean(anyEvt.error) || Boolean(event.errorCode);
    const textVal = delta.text || anyEvt.text || event.content?.parts?.map((p) => p.text).filter(Boolean).join(" ") || "Memory Ingestion";
    return {
      category: "memory:insert",
      label: "memory:insert",
      isMemory: true,
      status: isError ? "error" : "success",
      summaryText: textVal,
      durationMs: typeof delta.durationMs === "number" ? delta.durationMs : anyEvt.durationMs,
      service: delta.service || anyEvt.service,
      error: delta.error || anyEvt.error || (event.errorMessage || (event.errorCode ? `Error ${event.errorCode}` : undefined)),
    };
  }

  if (isMemoryRetrieve) {
    const isError = delta.status === "error" || anyEvt.status === "error" || Boolean(delta.error) || Boolean(anyEvt.error) || Boolean(event.errorCode);
    const queryVal = delta.query || anyEvt.query || "";
    const countVal = typeof delta.count === "number" ? delta.count : (typeof anyEvt.count === "number" ? anyEvt.count : (Array.isArray(delta.memories) ? delta.memories.length : 0));
    const summary = queryVal
      ? `Query: "${queryVal}" (${countVal} match${countVal === 1 ? "" : "es"})`
      : event.content?.parts?.map((p) => p.text).filter(Boolean).join(" ") || "Memory Retrieval";

    return {
      category: "memory:retrieve",
      label: "memory:retrieve",
      isMemory: true,
      status: isError ? "error" : "success",
      summaryText: summary,
      durationMs: typeof delta.durationMs === "number" ? delta.durationMs : anyEvt.durationMs,
      service: delta.service || anyEvt.service,
      query: queryVal,
      answer: delta.answer || anyEvt.answer,
      error: delta.error || anyEvt.error || (event.errorMessage || (event.errorCode ? `Error ${event.errorCode}` : undefined)),
    };
  }

  // Check errors
  if (event.errorCode || event.errorMessage || anyEvt.error) {
    return {
      category: "error",
      label: `error ${event.errorCode || ""}`,
      isMemory: false,
      status: "error",
      summaryText: event.errorMessage || anyEvt.error || `Error ${event.errorCode}`,
      error: event.errorMessage || anyEvt.error || String(event.errorCode),
    };
  }

  // Check parts for tool calls, thoughts, or content
  const parts = event.content?.parts || [];
  const hasToolCall = parts.some((p) => p.functionCall);
  const hasToolResponse = parts.some((p) => p.functionResponse);
  const hasThought = parts.some((p) => p.thought);

  if (hasToolCall || delta.eventType === "tool_call" || explicitType === "tool_call") {
    const call = parts.find((p) => p.functionCall)?.functionCall;
    const toolName = call?.name || delta.toolName || "call";
    const toolArgs = call?.args || delta.args || {};
    return {
      category: "tool_call",
      label: `tool: ${toolName}`,
      isMemory: false,
      status: "info",
      summaryText: `Calling ${toolName}(${JSON.stringify(toolArgs)})`,
    };
  }

  if (hasToolResponse || delta.eventType === "tool_result" || explicitType === "tool_result") {
    const res = parts.find((p) => p.functionResponse)?.functionResponse;
    const toolName = res?.name || delta.toolName || "result";
    const toolResp = res?.response || delta.result || delta.resultId || {};
    const isError = delta.status === "error" || Boolean(delta.error);
    return {
      category: "tool_call",
      label: `tool_result: ${toolName}`,
      isMemory: false,
      status: isError ? "error" : "success",
      summaryText: `Result from ${toolName}: ${JSON.stringify(toolResp).slice(0, 120)}`,
      error: delta.error,
    };
  }

  if (hasThought) {
    const thought = parts.find((p) => p.thought)?.text || "";
    return {
      category: "thought",
      label: "model:thought",
      isMemory: false,
      status: "info",
      summaryText: thought || "Reasoning trace",
    };
  }

  // Content or state delta from agents
  const textContent = parts.map((p) => p.text).filter(Boolean).join(" ");
  if (textContent) {
    return {
      category: "content",
      label: event.author ? `agent:${event.author}` : "content",
      isMemory: false,
      status: "success",
      summaryText: textContent,
    };
  }

  if (Object.keys(delta).length > 0) {
    return {
      category: "content",
      label: event.author ? `state:${event.author}` : "state_delta",
      isMemory: false,
      status: "success",
      summaryText: `State update: keys [${Object.keys(delta).join(", ")}]`,
    };
  }

  return {
    category: "content",
    label: event.author || "adk:event",
    isMemory: false,
    status: "info",
    summaryText: `Event from ${event.author || "agent"}`,
  };
}

export default function DebugPanel({
  isOpen,
  onClose,
  onEventsCountChange,
}: DebugPanelProps) {
  const [events, setEvents] = useState<AdkEvent[]>([]);
  const [eventTypeFilter, setEventTypeFilter] = useState<EventFilterCategory>("all");
  const [authorFilter, setAuthorFilter] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<StatusFilterType>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [expandedEventId, setExpandedEventId] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [isLiveConnected, setIsLiveConnected] = useState(false);
  const [isTestingAction, setIsTestingAction] = useState<"insert" | "retrieve" | "tool_call" | null>(null);
  const [isMinimized, setIsMinimized] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);

  const eventListRef = useRef<HTMLDivElement>(null);
  const eventSourceRef = useRef<EventSource | null>(null);

  // Notify parent of total event count
  useEffect(() => {
    onEventsCountChange?.(events.length);
  }, [events.length, onEventsCountChange]);

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
            console.warn("[DebugPanel] Failed to parse SSE message:", err);
          }
        };

        es.onerror = () => {
          setIsLiveConnected(false);
          es?.close();
          setTimeout(connectSSE, 3000);
        };
      } catch (err) {
        console.warn("[DebugPanel] SSE connection error:", err);
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
            tasks: [{ title: "Verify ADK event stream" }],
            calendarEvents: [{ title: "ADK Stream Review", start: timestamp }],
          },
        }),
      });
    } catch (e) {
      console.warn("Test memory insert failed:", e);
    } finally {
      setIsTestingAction(null);
    }
  };

  const handleTriggerTestRetrieve = async () => {
    setIsTestingAction("retrieve");
    try {
      await fetch("/api/memory/retrieve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: "meeting summaries markdown bullet points",
          userId: "default_user",
        }),
      });
    } catch (e) {
      console.warn("Test memory retrieve failed:", e);
    } finally {
      setIsTestingAction(null);
    }
  };

  const handleTriggerTestToolCall = async () => {
    setIsTestingAction("tool_call");
    try {
      await fetch("/api/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: "create_task",
          item: {
            title: "Make the presentation",
            notes: "Prepare key slides and speaker notes for sprint demo",
            dueDate: new Date().toISOString().slice(0, 10),
          },
          accessToken: "sandbox",
        }),
      });
    } catch (e) {
      console.warn("Test tool call failed:", e);
    } finally {
      setIsTestingAction(null);
    }
  };

  const handleCopyJson = (event: AdkEvent) => {
    navigator.clipboard.writeText(JSON.stringify(event, null, 2));
    setCopiedId(event.id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const formatTimestamp = (ts: number | string) => {
    try {
      const date = typeof ts === "number" ? new Date(ts) : new Date(ts);
      return date.toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        fractionalSecondDigits: 3,
      });
    } catch {
      return String(ts);
    }
  };

  // Event counts for badge calculation
  const totalCount = events.length;
  const insertCount = events.filter((e) => classifyEvent(e).category === "memory:insert").length;
  const retrieveCount = events.filter((e) => classifyEvent(e).category === "memory:retrieve").length;
  const toolCount = events.filter((e) => classifyEvent(e).category === "tool_call").length;
  const thoughtCount = events.filter((e) => classifyEvent(e).category === "thought").length;
  const contentCount = events.filter((e) => classifyEvent(e).category === "content").length;
  const errorCount = events.filter((e) => classifyEvent(e).status === "error").length;

  // Unique authors list for author filter
  const authors = Array.from(new Set(events.map((e) => e.author).filter(Boolean))) as string[];

  // Filtered event list
  const filteredEvents = events.filter((e) => {
    const classified = classifyEvent(e);

    // 1. Event Type filter
    if (eventTypeFilter !== "all") {
      if (classified.category !== eventTypeFilter) {
        return false;
      }
    }

    // 2. Author filter (only if eventTypeFilter is all, or if author explicitly matches)
    if (authorFilter !== "all" && e.author !== authorFilter && !(classified.isMemory && authorFilter === "memory")) {
      return false;
    }

    // 3. Status filter
    if (statusFilter !== "all" && classified.status !== statusFilter) {
      return false;
    }

    // 4. Search query filter
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      const rawJson = JSON.stringify(e).toLowerCase();
      return rawJson.includes(q);
    }

    return true;
  });

  if (!isOpen) return null;

  return (
    <div
      id="memory-debug-panel"
      className={`bg-stone-900 border border-stone-800 text-stone-100 rounded-2xl shadow-2xl transition-all duration-200 overflow-hidden flex flex-col ${
        isMinimized ? "h-14" : "h-[580px]"
      }`}
    >
      {/* Panel Header */}
      <div className="bg-stone-950 px-4 py-3 border-b border-stone-800 flex items-center justify-between gap-3 shrink-0">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="p-1.5 bg-amber-500/20 text-amber-400 rounded-lg border border-amber-500/30 shrink-0">
            <Terminal className="w-4 h-4" />
          </div>
          <div className="flex items-center gap-2 truncate">
            <span className="font-bold text-xs text-stone-100 tracking-wide font-mono uppercase">
              ADK Event Stream Debugger
            </span>
            <span className="text-[10px] font-mono font-bold px-2 py-0.5 rounded-full bg-stone-800 text-stone-300 border border-stone-700">
              {totalCount} events
            </span>
          </div>

          {/* SSE Live Status Indicator */}
          <div className="flex items-center gap-1.5 ml-2">
            <span
              className={`w-2 h-2 rounded-full ${
                isLiveConnected
                  ? "bg-emerald-400 animate-pulse ring-2 ring-emerald-400/30"
                  : "bg-amber-400"
              }`}
            />
            <span className="text-[10px] font-mono text-stone-400 hidden sm:inline">
              {isLiveConnected ? "ADK STREAM LIVE" : "CONNECTING..."}
            </span>
          </div>
        </div>

        {/* Quick Header Actions */}
        <div className="flex items-center gap-1.5 shrink-0">
          <button
            type="button"
            onClick={handleClearEvents}
            disabled={events.length === 0}
            title="Clear all recorded events"
            className="p-1.5 text-stone-400 hover:text-red-400 hover:bg-stone-800 rounded-lg transition-colors disabled:opacity-30 cursor-pointer"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>

          <button
            type="button"
            onClick={() => setIsMinimized(!isMinimized)}
            title={isMinimized ? "Expand Panel" : "Minimize Panel"}
            className="p-1.5 text-stone-400 hover:text-stone-200 hover:bg-stone-800 rounded-lg transition-colors cursor-pointer"
          >
            {isMinimized ? (
              <Maximize2 className="w-3.5 h-3.5" />
            ) : (
              <Minimize2 className="w-3.5 h-3.5" />
            )}
          </button>

          <button
            type="button"
            onClick={onClose}
            title="Close Debug Panel"
            className="p-1.5 text-stone-400 hover:text-stone-200 hover:bg-stone-800 rounded-lg transition-colors cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Main Panel Content (Hidden if Minimized) */}
      {!isMinimized && (
        <div className="flex-1 flex flex-col min-h-0 bg-stone-900/95">
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
                  onClick={() => setEventTypeFilter((prev) => (prev === "thought" ? "all" : "thought"))}
                  className={`px-2 py-1 rounded-lg text-xs font-mono font-semibold transition-all flex items-center gap-1.5 cursor-pointer ${
                    eventTypeFilter === "thought"
                      ? "bg-amber-950 text-amber-300 shadow-sm border border-amber-600 ring-1 ring-amber-500/50"
                      : "text-stone-400 hover:text-amber-400"
                  }`}
                >
                  <Lightbulb className="w-3 h-3 text-amber-400" />
                  <span>thought</span>
                  <span className="text-[10px] px-1.5 py-0.2 rounded-full bg-stone-950 text-amber-400">
                    {thoughtCount}
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
                  <span>tool_call</span>
                  <span className="text-[10px] px-1.5 py-0.2 rounded-full bg-stone-950 text-purple-400">
                    {toolCount}
                  </span>
                </button>

                <button
                  type="button"
                  onClick={() => setEventTypeFilter((prev) => (prev === "content" ? "all" : "content"))}
                  className={`px-2 py-1 rounded-lg text-xs font-mono font-semibold transition-all flex items-center gap-1.5 cursor-pointer ${
                    eventTypeFilter === "content"
                      ? "bg-stone-800 text-stone-100 shadow-sm border border-stone-600 ring-1 ring-stone-500/50"
                      : "text-stone-400 hover:text-stone-200"
                  }`}
                >
                  <Bot className="w-3 h-3 text-stone-300" />
                  <span>agent_content</span>
                  <span className="text-[10px] px-1.5 py-0.2 rounded-full bg-stone-950 text-stone-400">
                    {contentCount}
                  </span>
                </button>
              </div>

              {/* Quick Test Trigger Buttons */}
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={handleTriggerTestInsert}
                  disabled={isTestingAction !== null}
                  title="Emit an ADK memory:insert event via /api/memory/ingest"
                  className="px-2.5 py-1 bg-emerald-950/60 hover:bg-emerald-900/80 text-emerald-300 border border-emerald-800/60 rounded-lg text-[11px] font-mono font-semibold flex items-center gap-1.5 transition-all disabled:opacity-50 cursor-pointer"
                >
                  {isTestingAction === "insert" ? (
                    <RefreshCw className="w-3 h-3 animate-spin text-emerald-400" />
                  ) : (
                    <Zap className="w-3 h-3 text-emerald-400" />
                  )}
                  Test Ingest
                </button>

                <button
                  type="button"
                  onClick={handleTriggerTestRetrieve}
                  disabled={isTestingAction !== null}
                  title="Emit an ADK memory:retrieve event via /api/memory/retrieve"
                  className="px-2.5 py-1 bg-sky-950/60 hover:bg-sky-900/80 text-sky-300 border border-sky-800/60 rounded-lg text-[11px] font-mono font-semibold flex items-center gap-1.5 transition-all disabled:opacity-50 cursor-pointer"
                >
                  {isTestingAction === "retrieve" ? (
                    <RefreshCw className="w-3 h-3 animate-spin text-sky-400" />
                  ) : (
                    <Sparkles className="w-3 h-3 text-sky-400" />
                  )}
                  Test Retrieve
                </button>

                <button
                  type="button"
                  onClick={handleTriggerTestToolCall}
                  disabled={isTestingAction !== null}
                  title="Emit an ADK tool_call & tool_result event via /api/execute"
                  className="px-2.5 py-1 bg-purple-950/60 hover:bg-purple-900/80 text-purple-300 border border-purple-800/60 rounded-lg text-[11px] font-mono font-semibold flex items-center gap-1.5 transition-all disabled:opacity-50 cursor-pointer"
                >
                  {isTestingAction === "tool_call" ? (
                    <RefreshCw className="w-3 h-3 animate-spin text-purple-400" />
                  ) : (
                    <Wrench className="w-3 h-3 text-purple-400" />
                  )}
                  Test Tool Call
                </button>
              </div>
            </div>

            {/* Bottom row: Search filter, Author filter & Status tabs */}
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="relative flex-1 min-w-[200px]">
                <Search className="w-3.5 h-3.5 text-stone-500 absolute left-2.5 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Filter events by text, query, author, state, error..."
                  className="w-full bg-stone-900 border border-stone-800 focus:border-amber-500/50 rounded-lg pl-8 pr-3 py-1 text-xs text-stone-200 placeholder-stone-500 outline-none font-sans"
                />
                {searchQuery && (
                  <button
                    type="button"
                    onClick={() => setSearchQuery("")}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-stone-500 hover:text-stone-300 text-xs"
                  >
                    ×
                  </button>
                )}
              </div>

              {/* Author dropdown filter */}
              {authors.length > 0 && (
                <div className="flex items-center gap-1 text-[11px] font-mono">
                  <span className="text-stone-500 text-[10px]">Author:</span>
                  <select
                    value={authorFilter}
                    onChange={(e) => setAuthorFilter(e.target.value)}
                    className="bg-stone-900 border border-stone-800 text-stone-300 text-[11px] rounded px-2 py-0.5 outline-none font-mono"
                  >
                    <option value="all">All Authors</option>
                    {authors.map((a) => (
                      <option key={a} value={a}>
                        {a}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              <div className="flex items-center gap-3">
                {/* Status Filter */}
                <div className="flex items-center gap-1 text-[11px] font-mono">
                  <span className="text-stone-500 text-[10px]">Status:</span>
                  <button
                    type="button"
                    onClick={() => setStatusFilter("all")}
                    className={`px-2 py-0.5 rounded cursor-pointer ${
                      statusFilter === "all"
                        ? "bg-stone-800 text-stone-200 font-bold"
                        : "text-stone-500 hover:text-stone-300"
                    }`}
                  >
                    All
                  </button>
                  <button
                    type="button"
                    onClick={() => setStatusFilter("success")}
                    className={`px-2 py-0.5 rounded cursor-pointer ${
                      statusFilter === "success"
                        ? "bg-emerald-950 text-emerald-300 font-bold"
                        : "text-stone-500 hover:text-emerald-400"
                    }`}
                  >
                    Success
                  </button>
                  <button
                    type="button"
                    onClick={() => setStatusFilter("error")}
                    className={`px-2 py-0.5 rounded cursor-pointer ${
                      statusFilter === "error"
                        ? "bg-red-950 text-red-300 font-bold"
                        : "text-stone-500 hover:text-red-400"
                    }`}
                  >
                    Error ({errorCount})
                  </button>
                </div>

                {/* Auto Scroll Toggle */}
                <label className="flex items-center gap-1.5 text-[10px] font-mono text-stone-400 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={autoScroll}
                    onChange={(e) => setAutoScroll(e.target.checked)}
                    className="accent-amber-500 w-3 h-3 rounded"
                  />
                  <span>Auto-scroll</span>
                </label>
              </div>
            </div>
          </div>

          {/* Event Stream List */}
          <div
            ref={eventListRef}
            className="flex-1 overflow-y-auto p-3 space-y-2 font-mono text-xs"
          >
            {filteredEvents.length === 0 ? (
              <div className="h-full flex flex-col items-center justify-center text-center p-8 text-stone-500 space-y-2">
                <Database className="w-8 h-8 text-stone-700 stroke-[1.5]" />
                <p className="text-xs font-sans font-medium text-stone-400">
                  {events.length === 0
                    ? "No ADK events recorded in stream yet."
                    : "No events match the selected filters."}
                </p>
                <p className="text-[11px] text-stone-600 max-w-sm">
                  {events.length === 0
                    ? "Speak into the microphone or use 'Test Ingest' / 'Test Retrieve' above to observe live ADK events."
                    : "Try adjusting your search query, author filter, or event type filter."}
                </p>
              </div>
            ) : (
              filteredEvents.map((evt) => {
                const isExpanded = expandedEventId === evt.id;
                const classified = classifyEvent(evt);
                const isInsert = classified.category === "memory:insert";
                const isRetrieve = classified.category === "memory:retrieve";
                const isThought = classified.category === "thought";
                const isTool = classified.category === "tool_call";
                const isSuccess = classified.status === "success";

                return (
                  <div
                    key={evt.id}
                    className={`border rounded-xl transition-all duration-150 overflow-hidden ${
                      isExpanded
                        ? "bg-stone-950/90 border-stone-700 shadow-md"
                        : "bg-stone-950/40 hover:bg-stone-950/70 border-stone-800/80"
                    }`}
                  >
                    {/* Event Summary Header */}
                    <div
                      onClick={() => setExpandedEventId(isExpanded ? null : evt.id)}
                      className="p-3 flex items-start justify-between gap-3 cursor-pointer select-none"
                    >
                      <div className="flex items-start gap-2.5 min-w-0 flex-1">
                        {/* Event Type Icon Badge */}
                        <div
                          className={`p-1.5 rounded-lg shrink-0 mt-0.5 border ${
                            isInsert
                              ? "bg-emerald-950/80 border-emerald-700/60 text-emerald-400"
                              : isRetrieve
                              ? "bg-sky-950/80 border-sky-700/60 text-sky-400"
                              : isThought
                              ? "bg-amber-950/80 border-amber-700/60 text-amber-400"
                              : isTool
                              ? "bg-purple-950/80 border-purple-700/60 text-purple-400"
                              : "bg-stone-800 border-stone-700 text-stone-300"
                          }`}
                        >
                          {isInsert ? (
                            <ArrowDownToLine className="w-3.5 h-3.5" />
                          ) : isRetrieve ? (
                            <ArrowUpFromLine className="w-3.5 h-3.5" />
                          ) : isThought ? (
                            <Lightbulb className="w-3.5 h-3.5" />
                          ) : isTool ? (
                            <Wrench className="w-3.5 h-3.5" />
                          ) : (
                            <Bot className="w-3.5 h-3.5" />
                          )}
                        </div>

                        {/* Title & Metadata */}
                        <div className="space-y-1 min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            {/* Type Label */}
                            <span
                              className={`text-[11px] font-bold tracking-tight uppercase px-1.5 py-0.2 rounded border ${
                                isInsert
                                  ? "text-emerald-300 bg-emerald-950/50 border-emerald-800/50"
                                  : isRetrieve
                                  ? "text-sky-300 bg-sky-950/50 border-sky-800/50"
                                  : isThought
                                  ? "text-amber-300 bg-amber-950/50 border-amber-800/50"
                                  : isTool
                                  ? "text-purple-300 bg-purple-950/50 border-purple-800/50"
                                  : "text-stone-300 bg-stone-800/50 border-stone-700/50"
                              }`}
                            >
                              {classified.label}
                            </span>

                            {/* Author Badge */}
                            {evt.author && (
                              <span className="text-[10px] font-mono text-stone-300 bg-stone-800 border border-stone-700 px-1.5 py-0.2 rounded">
                                author: {evt.author}
                              </span>
                            )}

                            {/* Status Tag */}
                            <span
                              className={`text-[10px] font-semibold px-1.5 py-0.2 rounded flex items-center gap-1 ${
                                isSuccess
                                  ? "text-emerald-400 bg-emerald-950/30"
                                  : classified.status === "error"
                                  ? "text-red-400 bg-red-950/50 border border-red-800/50"
                                  : "text-stone-400 bg-stone-800/30"
                              }`}
                            >
                              {isSuccess ? (
                                <CheckCircle2 className="w-2.5 h-2.5" />
                              ) : classified.status === "error" ? (
                                <AlertCircle className="w-2.5 h-2.5" />
                              ) : (
                                <Activity className="w-2.5 h-2.5" />
                              )}
                              {classified.status.toUpperCase()}
                            </span>

                            {/* Duration / Latency */}
                            {typeof classified.durationMs === "number" && (
                              <span className="text-[10px] text-stone-400 bg-stone-900 border border-stone-800 px-1.5 py-0.2 rounded flex items-center gap-1">
                                <Clock className="w-2.5 h-2.5 text-stone-500" />
                                {classified.durationMs}ms
                              </span>
                            )}

                            {/* Service Provider */}
                            {classified.service && (
                              <span className="text-[10px] text-amber-400/90 bg-amber-950/30 border border-amber-900/40 px-1.5 py-0.2 rounded flex items-center gap-1">
                                <Cpu className="w-2.5 h-2.5 text-amber-500" />
                                {classified.service}
                              </span>
                            )}

                            {/* Invocation / Session ID */}
                            {evt.invocationId && (
                              <span className="text-[10px] text-stone-500">
                                inv: {evt.invocationId}
                              </span>
                            )}
                          </div>

                          {/* Primary content preview */}
                          <div className="text-xs text-stone-300 font-sans leading-snug line-clamp-2">
                            {classified.summaryText}
                          </div>

                          {/* Direct AI answer preview if present */}
                          {classified.answer && (
                            <div className="text-[11px] text-amber-300/90 bg-amber-950/30 border border-amber-900/30 rounded p-1.5 font-sans flex items-start gap-1.5">
                              <Sparkles className="w-3 h-3 text-amber-400 shrink-0 mt-0.5" />
                              <span className="line-clamp-2">{classified.answer}</span>
                            </div>
                          )}

                          {/* Error message preview if failed */}
                          {classified.error && (
                            <div className="text-[11px] text-red-400 bg-red-950/40 border border-red-900/40 rounded p-1.5 font-mono">
                              Error: {classified.error}
                            </div>
                          )}
                        </div>
                      </div>

                      {/* Right side: Timestamp & Expand Caret */}
                      <div className="flex items-center gap-2 shrink-0 self-center">
                        <span className="text-[10px] text-stone-500 font-mono">
                          {formatTimestamp(evt.timestamp)}
                        </span>
                        <button
                          type="button"
                          className="text-stone-500 hover:text-stone-300"
                        >
                          {isExpanded ? (
                            <ChevronDown className="w-4 h-4" />
                          ) : (
                            <ChevronRight className="w-4 h-4" />
                          )}
                        </button>
                      </div>
                    </div>

                    {/* Expandable Details Section */}
                    {isExpanded && (
                      <div className="border-t border-stone-800/80 p-3.5 bg-stone-950 space-y-3 font-sans">
                        {/* Action buttons */}
                        <div className="flex items-center justify-between gap-2 pb-2 border-b border-stone-900">
                          <span className="text-[10px] font-mono text-stone-500 uppercase tracking-wider">
                            ADK Event ID: {evt.id}
                          </span>
                          <button
                            type="button"
                            onClick={() => handleCopyJson(evt)}
                            className="px-2 py-1 bg-stone-900 hover:bg-stone-800 text-stone-300 rounded text-[11px] font-mono flex items-center gap-1.5 transition-colors cursor-pointer"
                          >
                            {copiedId === evt.id ? (
                              <>
                                <Check className="w-3 h-3 text-emerald-400" />
                                <span className="text-emerald-400">Copied!</span>
                              </>
                            ) : (
                              <>
                                <Copy className="w-3 h-3 text-stone-400" />
                                <span>Copy ADK Event JSON</span>
                              </>
                            )}
                          </button>
                        </div>

                        {/* State Delta preview */}
                        {evt.actions?.stateDelta && Object.keys(evt.actions.stateDelta).length > 0 && (
                          <div className="space-y-1.5">
                            <p className="text-[11px] font-mono font-bold text-emerald-400">
                              Event Actions &amp; State Delta:
                            </p>
                            <pre className="p-2.5 bg-stone-900/90 rounded border border-stone-800 text-[11px] text-stone-300 font-mono overflow-x-auto max-h-40">
                              {JSON.stringify(evt.actions.stateDelta, null, 2)}
                            </pre>
                          </div>
                        )}

                        {/* Content Parts */}
                        {evt.content?.parts && evt.content.parts.length > 0 && (
                          <div className="space-y-1.5">
                            <p className="text-[11px] font-mono font-bold text-sky-400">
                              Content Parts ({evt.content.parts.length}):
                            </p>
                            <pre className="p-2.5 bg-stone-900/90 rounded border border-stone-800 text-[11px] text-stone-300 font-mono overflow-x-auto max-h-40">
                              {JSON.stringify(evt.content.parts, null, 2)}
                            </pre>
                          </div>
                        )}

                        {/* Raw Full ADK Event JSON Viewer */}
                        <div className="space-y-1">
                          <p className="text-[10px] font-mono text-stone-500 uppercase">
                            Full ADK Event Object (adk.dev/events)
                          </p>
                          <pre className="p-2.5 bg-stone-900 rounded border border-stone-800 text-[10.5px] text-stone-300 font-mono overflow-x-auto max-h-52 leading-relaxed">
                            {JSON.stringify(evt, null, 2)}
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
  );
}
