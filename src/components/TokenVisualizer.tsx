import { useState, useEffect } from "react";
import {
  Zap,
  Layers,
  Sparkles,
  BarChart3,
  Search,
  RefreshCw,
  BrainCircuit,
  Cpu,
  Clock,
  DollarSign,
  Radio,
  Mic,
  Activity,
  Calendar,
  Filter,
} from "lucide-react";
import {
  AdkEvent,
  TokenStatsResponse,
  TokenMetricRecord,
  TimeSeriesPoint,
  TokenAggregateStats,
  AggregateDimensionStats,
  TimeRangePreset,
  TimeRangeConfig,
} from "../types";

const MIN = 60_000;
const presetRows: [Exclude<TimeRangePreset, "custom">, number, string, string[]][] = [
  ["10m", 10 * MIN, "10s", ["1s", "10s", "30s", "1m"]],
  ["30m", 30 * MIN, "1m", ["10s", "30s", "1m", "5m"]],
  ["1h", 60 * MIN, "1m", ["1m", "5m", "15m"]],
  ["4h", 240 * MIN, "5m", ["1m", "5m", "15m", "30m", "1h"]],
  ["24h", 1440 * MIN, "30m", ["5m", "15m", "30m", "1h", "4h"]],
  ["7d", 10080 * MIN, "4h", ["1h", "4h", "1d"]],
];
const TIME_RANGE_PRESETS = Object.fromEntries(presetRows.map(([preset, durationMs, defaultInterval, supportedIntervals]) =>
  [preset, { preset, label: preset, durationMs, defaultInterval, supportedIntervals }])) as Record<Exclude<TimeRangePreset, "custom">, TimeRangeConfig>;

// One KPI card in the header row. Accent classes are passed whole so Tailwind can see them.
function Kpi({ icon: Icon, title, badge, accent, value, unit, children }: {
  icon: typeof Zap; title: string; badge: string; accent: { icon: string; badge: string };
  value: React.ReactNode; unit: string; children: React.ReactNode;
}) {
  return (
    <div className="bg-white border border-stone-200 rounded-xl p-3.5 shadow-xs flex flex-col justify-between space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-mono font-semibold uppercase text-stone-500 flex items-center gap-1.5">
          <Icon className={`w-3.5 h-3.5 ${accent.icon}`} />
          {title}
        </span>
        <span className={`text-[10px] font-mono px-2 py-0.5 rounded-full border ${accent.badge}`}>{badge}</span>
      </div>
      <div className="flex items-baseline gap-2">
        <span className="text-2xl font-bold font-mono text-stone-900">{value}</span>
        <span className="text-xs font-mono text-stone-500">{unit}</span>
      </div>
      <div className="text-[11px] text-stone-500 flex items-center justify-between border-t border-stone-100 pt-1.5 font-mono">{children}</div>
    </div>
  );
}
const AMBER = { icon: "text-amber-600", badge: "bg-amber-50 text-amber-800 border-amber-200" };
const BLUE = { icon: "text-blue-600", badge: "bg-blue-50 text-blue-800 border-blue-200" };
const EMERALD = { icon: "text-emerald-600", badge: "bg-emerald-50 text-emerald-800 border-emerald-200" };

// One option in a segmented control. Colour classes are passed whole so Tailwind can see them.
function Seg({ on, onClick, onClass = "bg-white text-stone-900 font-bold shadow-2xs border border-stone-200", offClass = "text-stone-600 hover:text-stone-900", extra = "", children }: {
  on: boolean; onClick: () => void; onClass?: string; offClass?: string; extra?: string; children: React.ReactNode;
}) {
  return (
    <button type="button" onClick={onClick}
      className={`px-2 py-1 text-[11px] font-mono rounded cursor-pointer transition-all ${extra} ${on ? onClass : offClass}`}>
      {children}
    </button>
  );
}

// Stacked-bar segments, top to bottom; also the chart legend.
const SEGMENTS = [
  ["thoughtsTokens", "bg-purple-500", "Thoughts (Reasoning)"],
  ["candidatesTokens", "bg-emerald-500", "Candidates (Output)"],
  ["audioTokens", "bg-blue-500", "Audio (STT)"],
  ["promptTokens", "bg-amber-500", "Prompt (Input)"],
] as const;

const RECEIPT_COLS = ["Timestamp", "Agent / Stage", "Features / Tags", "Modality", "Model", ">Prompt", ">Output", ">Thinking", ">Total", ">Latency", ">Cost"];

// One "by X" aggregate card. Colour classes are passed whole so Tailwind can see them.
function Breakdown({ title, Icon, data, label, tone }: {
  title: string; Icon: typeof Zap; data?: Record<string, AggregateDimensionStats>; label: (k: string) => string;
  tone: { box: string; head: string; icon: string; row: string; tok: string };
}) {
  if (!data || !Object.keys(data).length) return null;
  return (
    <div className={`p-3 rounded-xl space-y-2 border ${tone.box}`}>
      <span className={`text-[11px] font-mono font-bold uppercase flex items-center gap-1 ${tone.head}`}>
        <Icon className={`w-3 h-3 ${tone.icon}`} />
        {title}
      </span>
      <div className="space-y-2">
        {Object.entries(data).map(([k, d]) => (
          <div key={k} className={`p-2.5 bg-white rounded-lg border flex justify-between items-center font-mono text-xs ${tone.row}`}>
            <div>
              <span className="font-bold capitalize text-stone-900">{label(k)}</span>
              <span className="text-[10px] text-stone-500 block">{d.requests} requests • ${d.costUsd.toFixed(5)}</span>
            </div>
            <div className="text-right">
              <span className={`font-bold ${tone.tok}`}>{d.tokens.toLocaleString()} tok</span>
              <span className="text-[10px] text-stone-500 block">{d.percent}%</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// One stage of the compaction pipeline: a token count, an optional savings badge, and the text.
function Pane({ title, tokens, tokClass, badge, text, empty }: {
  title: string; tokens: number; tokClass: string; badge?: [string, string]; text: string; empty: string;
}) {
  return (
    <div className="p-3 bg-stone-50 rounded-xl border border-stone-200 space-y-2">
      <div className="flex items-center justify-between text-[11px] font-mono text-stone-600 border-b border-stone-200/80 pb-1">
        <span>{title}</span>
        <div className="flex items-center gap-1">
          {badge && <span className={`text-[10px] px-1.5 py-0.2 rounded border font-semibold ${badge[1]}`}>{badge[0]}</span>}
          <span className={`font-bold ${tokClass}`}>{tokens} tokens</span>
        </div>
      </div>
      <div className="text-xs font-mono text-stone-800 bg-white p-2.5 rounded border border-stone-200 max-h-28 overflow-y-auto whitespace-pre-wrap">
        {text || <span className="text-stone-400 italic">{empty}</span>}
      </div>
    </div>
  );
}

const TABS = [
  ["timeseries", BarChart3, "Time-Series Telemetry"],
  ["subagents", Cpu, "Sub-Agent Attribution"],
  ["compaction", Layers, "Context Compaction & Memory"],
] as const;

interface TokenVisualizerProps {
  events: AdkEvent[];
  rawTranscript?: string;
  liveSummary?: string;
  serverConfig?: any;
}

export default function TokenVisualizer({
  events,
  rawTranscript = "",
  liveSummary = "",
  serverConfig,
}: TokenVisualizerProps) {
  const [stats, setStats] = useState<TokenStatsResponse | null>(null);
  const [timeSeries, setTimeSeries] = useState<TimeSeriesPoint[]>([]);
  const [aggregate, setAggregate] = useState<TokenAggregateStats | null>(null);
  const [liveRecords, setLiveRecords] = useState<TokenMetricRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [queryInput, setQueryInput] = useState("");
  const [testResult, setTestResult] = useState<any>(null);
  const [testingQuery, setTestingQuery] = useState(false);
  const [activeTab, setActiveTab] = useState<"timeseries" | "subagents" | "compaction">("timeseries");
  
  // Time-Range & Resolution States
  const [timeRange, setTimeRange] = useState<TimeRangePreset>("30m");
  const [interval, setInterval] = useState<string>("1m");
  const [diarizationFilter, setDiarizationFilter] = useState<"all" | "diarized" | "non_diarized">("all");
  const [providerFilter, setProviderFilter] = useState<"all" | "gemini" | "google_cloud_stt">("all");
  const [customFrom, setCustomFrom] = useState<string>("");
  const [customTo, setCustomTo] = useState<string>("");
  const [hoveredPoint, setHoveredPoint] = useState<TimeSeriesPoint | null>(null);

  const getTimeBounds = () => {
    const now = Date.now();
    if (timeRange === "custom") {
      const fromMs = customFrom ? new Date(customFrom).getTime() : now - 3600000;
      const toMs = customTo ? new Date(customTo).getTime() : now;
      return { from: fromMs, to: toMs };
    }
    const preset = TIME_RANGE_PRESETS[timeRange];
    return { from: now - (preset?.durationMs || 1800000), to: now };
  };

  // Time-series + aggregate for the current range and filters.
  const refreshTelemetry = () => {
    const { from, to } = getTimeBounds();
    const filters = (diarizationFilter === "all" ? "" : `&diarization=${diarizationFilter === "diarized"}`)
      + (providerFilter === "all" ? "" : `&provider=${encodeURIComponent(providerFilter)}`);
    const getJson = (url: string) => fetch(url).then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)));
    return Promise.all([
      getJson(`/api/tokens/telemetry/timeseries?from=${from}&to=${to}&interval=${interval}${filters}`).then(d => setTimeSeries(d.points || [])),
      getJson(`/api/tokens/telemetry/aggregate?from=${from}&to=${to}${filters}`).then(setAggregate),
    ]);
  };

  const fetchTokenStats = async () => {
    setLoading(true);
    try {
      const statsReq = fetch(`/api/tokens/stats?text=${encodeURIComponent(rawTranscript)}&summary=${encodeURIComponent(liveSummary)}`)
        .then(r => r.ok && r.json().then(setStats));
      await Promise.all([statsReq, refreshTelemetry()]);
    } catch (e) {
      console.warn("Failed to fetch token telemetry:", e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchTokenStats();
  }, [rawTranscript, liveSummary, timeRange, interval, diarizationFilter, providerFilter]);

  const handleSelectPreset = (p: TimeRangePreset) => {
    setTimeRange(p);
    if (p !== "custom") return setInterval(TIME_RANGE_PRESETS[p].defaultInterval);
    if (!customFrom) setCustomFrom(new Date(Date.now() - 3600000).toISOString().slice(0, 16));
    if (!customTo) setCustomTo(new Date().toISOString().slice(0, 16));
  };

  // Live receipts. EventSource reconnects on its own after a drop.
  useEffect(() => {
    const es = new EventSource("/api/tokens/telemetry/stream");
    es.onmessage = (ev) => {
      try {
        setLiveRecords((prev) => [JSON.parse(ev.data) as TokenMetricRecord, ...prev.slice(0, 49)]);
        refreshTelemetry().catch(() => {});
      } catch (err) {
        console.warn("Failed to parse token SSE:", err);
      }
    };
    return () => es.close();
  }, [timeRange, interval, customFrom, customTo, diarizationFilter, providerFilter]);

  // Test interactive memory recall
  const handleTestMemoryRecall = async () => {
    if (!queryInput.trim()) return;
    setTestingQuery(true);
    try {
      const res = await fetch("/api/memory/retrieve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: queryInput.trim() }),
      });
      if (res.ok) setTestResult(await res.json());
    } catch (e) {
      console.warn("Memory recall test failed:", e);
    } finally {
      setTestingQuery(false);
    }
  };

  // Find latest memory retrieval event from live ADK stream
  const latestRetrieveEvent = events.find((e: any) => {
    const delta = e.actions?.stateDelta || e.stateDelta || {};
    return (
      e.author === "memory" &&
      (delta.eventType === "memory:retrieve" ||
        delta.query ||
        e.content?.parts?.some((p: any) => p.text?.includes("[Memory Retrieve]")))
    );
  });

  const latestMemories: { text: string; author: string; timestamp?: string }[] =
    latestRetrieveEvent?.actions?.stateDelta?.memories || latestRetrieveEvent?.stateDelta?.memories || [];
  const displayedMemories = testResult?.memories?.length ? testResult.memories : latestMemories;

  const rawTokens = stats?.compaction?.rawTokens ?? Math.ceil(rawTranscript.length / 3.8);
  const summaryTokens = stats?.compaction?.compactedTokens ?? Math.ceil(liveSummary.length / 3.8);
  const compactionRatio = stats?.compaction?.ratioPercent ?? (rawTokens > summaryTokens && rawTokens > 0 ? Number((((rawTokens - summaryTokens) / rawTokens) * 100).toFixed(1)) : 0);

  const rawWords = (rawTranscript || "").trim().split(/\s+/).filter(Boolean);
  const deltaText = rawWords.length <= 40 ? rawTranscript : "..." + rawWords.slice(-40).join(" ");
  const deltaTokens = Math.ceil((deltaText || "").length / 3.8);
  const combinedReasoningTokens = summaryTokens + deltaTokens;
  const rollingSavingsRatio = rawTokens > combinedReasoningTokens && rawTokens > 0
    ? Number((((rawTokens - combinedReasoningTokens) / rawTokens) * 100).toFixed(1))
    : compactionRatio;
  const deltaSavingsRatio = rawTokens > deltaTokens && rawTokens > 0
    ? Number((((rawTokens - deltaTokens) / rawTokens) * 100).toFixed(1))
    : 0;

  // Memory Bank Token Efficiency Calculations
  const archiveTokens = stats?.archive?.totalArchiveTokens || 14850;
  const archiveSessionCount = stats?.archive?.sessionCount || 12;
  const injectedMemoryTokens = testResult?.efficiency?.injectedMemoryTokens || (displayedMemories.length > 0 ? 85 : 0);
  const legacyPromptTokens = archiveTokens + 320;
  const shownMemoryTokens = injectedMemoryTokens > 0 ? injectedMemoryTokens : 85;
  const memoryBankPromptTokens = shownMemoryTokens + 320;
  const memSavedTokens = Math.max(0, legacyPromptTokens - memoryBankPromptTokens);
  const memSavingsPercent = legacyPromptTokens > 0
    ? Number(((memSavedTokens / legacyPromptTokens) * 100).toFixed(1))
    : 97.4;
  const memMultiplier = (legacyPromptTokens / memoryBankPromptTokens).toFixed(1) + "x";

  const maxBucketTokens = Math.max(...timeSeries.map((p) => p.totalTokens), 100); // chart scale

  return (
    <div className="flex-1 flex flex-col min-h-0 bg-stone-50 text-stone-900 p-4 space-y-4 overflow-y-auto font-sans">
      
      {/* Top 4 KPI Metrics Header */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 shrink-0">
        
        <Kpi icon={Zap} title="Total Model Tokens" badge="Live Billing" accent={AMBER}
          value={(aggregate?.totalTokens || 0).toLocaleString()} unit="tok">
          <span>In: {(aggregate?.totalPromptTokens || 0).toLocaleString()}</span>
          <span>Out: {(aggregate?.totalCandidatesTokens || 0).toLocaleString()}</span>
        </Kpi>
        <Kpi icon={Mic} title="Audio Ingested" badge="STT Encoder" accent={BLUE}
          value={(aggregate?.totalAudioTokens || 0).toLocaleString()} unit="audio tok">
          <span>Reasoning Out: {(aggregate?.totalThoughtsTokens || 0).toLocaleString()}</span>
        </Kpi>
        <Kpi icon={Clock} title="Requests & Latency" badge="Performance" accent={EMERALD}
          value={aggregate?.requestCount || 0} unit={`reqs • ${aggregate?.avgLatencyMs || 0}ms avg`}>
          <span>Model: {stats?.archive?.sessionCount ? `${stats.archive.sessionCount} sessions` : "gemini-3.7-flash"}</span>
        </Kpi>
        <Kpi icon={DollarSign} title="Estimated Cost" badge="Standard Rates" accent={AMBER}
          value={`$${(aggregate?.totalCostUsd || 0).toFixed(5)}`} unit="USD">
          <span>Compaction: {compactionRatio}% saved</span>
        </Kpi>
      </div>

      {/* Sub-Navigation Tabs. The tab row owns its own line; the time-series toolbar sits on a
          second line BELOW it so the controls read as subordinate to the selected tab rather than
          competing with it for the same row. */}
      <div className="space-y-[13px] border-b border-stone-200 pb-2">
        <div className="flex flex-wrap items-center gap-1">
          {TABS.map(([id, Icon, label]) => (
            <button
              key={id}
              type="button"
              onClick={() => setActiveTab(id)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium font-mono transition-colors flex items-center gap-1.5 cursor-pointer ${
                activeTab === id
                  ? "bg-amber-600 text-white font-semibold shadow-xs"
                  : "bg-white text-stone-600 hover:bg-stone-100 border border-stone-200"
              }`}
            >
              <Icon className="w-3.5 h-3.5" />
              {label}
            </button>
          ))}
        </div>

        {activeTab === "timeseries" && (
          <div className="flex flex-wrap items-center gap-2">
            {/* Diarization + Provider, folded behind one Filter button. The native popover
                attribute supplies open/close, click-outside dismissal and Escape; anchor
                positioning parks it under the button (elsewhere it centres in the viewport). */}
            <div>
              <button
                type="button"
                popoverTarget="token-filter-popover"
                title="Diarization and provider filters"
                style={{ anchorName: "--token-filter-btn" } as React.CSSProperties}
                className={`px-2 py-1 text-[11px] font-mono rounded-lg border cursor-pointer transition-colors flex items-center gap-1.5 ${
                  diarizationFilter !== "all" || providerFilter !== "all"
                    ? "bg-stone-800 text-white border-stone-800 font-bold"
                    : "bg-stone-100 text-stone-600 border-stone-200 hover:text-stone-900 hover:bg-stone-200/70"
                }`}
              >
                <Filter className="w-3.5 h-3.5" />
                Filters
                {(diarizationFilter !== "all" || providerFilter !== "all") && (
                  <span className="w-1.5 h-1.5 rounded-full bg-amber-400" />
                )}
              </button>

              <div
                id="token-filter-popover"
                popover="auto"
                style={{ positionAnchor: "--token-filter-btn", positionArea: "bottom span-right", margin: "0.375rem 0 0 0" } as React.CSSProperties}
                className="bg-white border border-stone-200 rounded-xl shadow-lg p-2.5 space-y-2.5 w-max"
              >
                {/* Diarization Filter */}
                <div className="flex items-center bg-stone-100 p-0.5 rounded-lg border border-stone-200">
                  <span className="text-[10px] font-mono text-stone-500 pl-1.5 pr-1 font-semibold">Diarization:</span>
                  <Seg on={diarizationFilter === "all"} onClick={() => setDiarizationFilter("all")}>All</Seg>
                  <Seg on={diarizationFilter === "diarized"} onClick={() => setDiarizationFilter("diarized")} onClass="bg-emerald-600 text-white font-bold shadow-2xs" offClass="text-emerald-750 hover:text-emerald-900">Diarized Only</Seg>
                  <Seg on={diarizationFilter === "non_diarized"} onClick={() => setDiarizationFilter("non_diarized")} onClass="bg-stone-800 text-white font-bold shadow-2xs">Non-Diarized</Seg>
                </div>

                {/* Provider Filter */}
                <div className="flex items-center bg-stone-100 p-0.5 rounded-lg border border-stone-200">
                  <span className="text-[10px] font-mono text-stone-500 pl-1.5 pr-1 font-semibold">Provider:</span>
                  <Seg on={providerFilter === "all"} onClick={() => setProviderFilter("all")}>All</Seg>
                  <Seg on={providerFilter === "gemini"} onClick={() => setProviderFilter("gemini")} onClass="bg-amber-600 text-white font-bold shadow-2xs" offClass="text-amber-800 hover:text-amber-900">Gemini</Seg>
                  <Seg on={providerFilter === "google_cloud_stt"} onClick={() => setProviderFilter("google_cloud_stt")} onClass="bg-indigo-600 text-white font-bold shadow-2xs" offClass="text-indigo-750 hover:text-indigo-900">Cloud STT</Seg>
                  </div>
                </div>
            </div>

            {/* Time Range Preset Buttons */}
            <div className="flex items-center bg-stone-100 p-0.5 rounded-lg border border-stone-200">
              {(["10m", "30m", "1h", "4h", "24h", "7d"] as const).map((p) => (
                <Seg key={p} on={timeRange === p} onClick={() => handleSelectPreset(p)}>{TIME_RANGE_PRESETS[p].label}</Seg>
              ))}
              <Seg on={timeRange === "custom"} onClick={() => handleSelectPreset("custom")} extra="flex items-center gap-1"><Calendar className="w-3 h-3" /> Custom</Seg>
            </div>

            {/* Interval Resolution Selector */}
            {timeRange !== "custom" && (
              <div className="flex items-center gap-1 bg-stone-100 p-0.5 rounded-lg border border-stone-200">
                <span className="text-[10px] font-mono text-stone-500 pl-1.5 pr-0.5">Bucket:</span>
                {TIME_RANGE_PRESETS[timeRange]?.supportedIntervals.map((res) => (
                  <button
                    key={res}
                    type="button"
                    onClick={() => setInterval(res)}
                    className={`px-1.5 py-0.5 text-[10px] font-mono rounded cursor-pointer transition-all ${
                      interval === res
                        ? "bg-stone-900 text-white font-bold"
                        : "text-stone-600 hover:text-stone-900"
                    }`}
                  >
                    {res}
                  </button>
                ))}
              </div>
            )}

            <button
              type="button"
              onClick={fetchTokenStats}
              disabled={loading}
              className="p-1 text-stone-500 hover:text-stone-800 rounded hover:bg-stone-100 border border-stone-200 cursor-pointer ml-0.5"
              title="Refresh telemetry"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin text-amber-600" : ""}`} />
            </button>
          </div>
        )}
      </div>

      {/* TAB 1: REAL-TIME TIME-SERIES TELEMETRY */}
      {activeTab === "timeseries" && (
        <div className="space-y-4">
          
          {/* Custom Date Range Picker Ribbon */}
          {timeRange === "custom" && (
            <div className="bg-white border border-stone-200 rounded-xl p-3 shadow-2xs flex flex-wrap items-center justify-between gap-3 font-mono text-xs">
              <div className="flex items-center gap-2">
                <Calendar className="w-4 h-4 text-amber-600 shrink-0" />
                <span className="font-semibold text-stone-800">Custom Time Range:</span>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <div className="flex items-center gap-1.5">
                  <label className="text-[11px] text-stone-500">From:</label>
                  <input
                    type="datetime-local"
                    value={customFrom}
                    onChange={(e) => setCustomFrom(e.target.value)}
                    className="px-2 py-1 bg-stone-50 border border-stone-200 rounded text-xs text-stone-800 font-mono focus:outline-none focus:border-amber-500"
                  />
                </div>
                <div className="flex items-center gap-1.5">
                  <label className="text-[11px] text-stone-500">To:</label>
                  <input
                    type="datetime-local"
                    value={customTo}
                    onChange={(e) => setCustomTo(e.target.value)}
                    className="px-2 py-1 bg-stone-50 border border-stone-200 rounded text-xs text-stone-800 font-mono focus:outline-none focus:border-amber-500"
                  />
                </div>
                <div className="flex items-center gap-1.5">
                  <label className="text-[11px] text-stone-500">Interval:</label>
                  <select
                    value={interval}
                    onChange={(e) => setInterval(e.target.value)}
                    className="px-2 py-1 bg-stone-50 border border-stone-200 rounded text-xs text-stone-800 font-mono focus:outline-none focus:border-amber-500 cursor-pointer"
                  >
                    {["10s", "30s", "1m", "5m", "15m", "30m", "1h", "4h", "1d"].map(v => <option key={v} value={v}>{v}</option>)}
                  </select>
                </div>
                <button
                  type="button"
                  onClick={fetchTokenStats}
                  className="px-3 py-1 bg-amber-600 hover:bg-amber-700 text-white rounded font-sans text-xs font-semibold cursor-pointer transition-colors shadow-2xs"
                >
                  Apply Range
                </button>
              </div>
            </div>
          )}

          {/* Visual Time-Series Chart Box */}
          <div className="bg-white border border-stone-200 rounded-xl p-4 shadow-xs space-y-3">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-stone-100 pb-2">
              <span className="text-xs font-bold font-mono text-stone-800 flex items-center gap-1.5 shrink-0">
                <Activity className="w-4 h-4 text-amber-600" />
                Live Token Consumption Over Time ({timeRange === "custom" ? "Custom Range" : TIME_RANGE_PRESETS[timeRange].label}, {interval} buckets)
              </span>

              {/* Dynamic Legend / Active Hover Inspector */}
              {hoveredPoint ? (
                <div className="flex items-center gap-2 text-[10px] font-mono bg-stone-900 text-white px-2.5 py-1 rounded-md shadow-xs animate-in fade-in duration-100 overflow-x-auto">
                  <span className="font-bold text-amber-400 shrink-0">{hoveredPoint.timeLabel}</span>
                  <span className="text-stone-300 shrink-0">Total: <strong className="text-white">{hoveredPoint.totalTokens.toLocaleString()}</strong></span>
                  <span className="text-amber-300 shrink-0">In: {hoveredPoint.promptTokens.toLocaleString()}</span>
                  <span className="text-emerald-300 shrink-0">Out: {hoveredPoint.candidatesTokens.toLocaleString()}</span>
                  {hoveredPoint.audioTokens > 0 && <span className="text-blue-300 shrink-0">Audio: {hoveredPoint.audioTokens.toLocaleString()}</span>}
                  {hoveredPoint.thoughtsTokens > 0 && <span className="text-purple-300 shrink-0">Thoughts: {hoveredPoint.thoughtsTokens.toLocaleString()}</span>}
                  <span className="text-stone-400 border-l border-stone-700 pl-1.5 shrink-0">
                    {hoveredPoint.requestCount} req • {hoveredPoint.avgDurationMs}ms • ${hoveredPoint.costUsd}
                  </span>
                </div>
              ) : (
                <div className="flex items-center gap-3 text-[11px] font-mono text-stone-500 overflow-x-auto">
                  {[...SEGMENTS].reverse().map(([, color, label]) => (
                    <span key={label} className="flex items-center gap-1 shrink-0">
                      <span className={`w-2.5 h-2.5 rounded-sm inline-block ${color}`} />
                      {label}
                    </span>
                  ))}
                </div>
              )}
            </div>

            {/* Bar Chart Canvas */}
            <div className="relative min-h-[220px] flex items-end gap-1.5 pt-14 pb-2 border-b border-stone-100 overflow-x-auto">
              {timeSeries.length > 0 ? (
                timeSeries.map((pt, idx) => {
                  const total = pt.totalTokens;
                  const heightPercent = total > 0 ? Math.max(14, Math.round((total / maxBucketTokens) * 100)) : 4;
                  const isHovered = hoveredPoint === pt;
                  // Clamp tooltip alignment so edge bars don't clip off left or right
                  const alignClass =
                    idx === 0
                      ? "left-0"
                      : idx >= timeSeries.length - 2
                      ? "right-0"
                      : "left-1/2 -translate-x-1/2";

                  return (
                    <div
                      key={idx}
                      onMouseEnter={() => setHoveredPoint(pt)}
                      onMouseLeave={() => setHoveredPoint(null)}
                      className="flex-1 min-w-[20px] max-w-[48px] flex flex-col items-center gap-1.5 group relative justify-end cursor-pointer shrink-0"
                    >
                      {/* Floating Tooltip positioned cleanly above stacked bar with high z-index and border */}
                      <div
                        className={`absolute bottom-[calc(100%+6px)] ${alignClass} hidden group-hover:flex flex-col bg-stone-900/95 text-white text-[10px] font-mono p-2 rounded-lg shadow-xl border border-stone-700 z-30 whitespace-nowrap pointer-events-none`}
                      >
                        <div className="font-bold text-amber-400 flex items-center justify-between gap-2">
                          <span>{pt.timeLabel}</span>
                          <span className="text-stone-400 text-[9px] font-normal">{pt.requestCount} req</span>
                        </div>
                        <div className="text-white font-semibold mt-0.5">Total: {pt.totalTokens.toLocaleString()} tok</div>
                        <div className="text-amber-300">Prompt: {pt.promptTokens.toLocaleString()} tok</div>
                        <div className="text-emerald-300">Output: {pt.candidatesTokens.toLocaleString()} tok</div>
                        {pt.audioTokens > 0 && <div className="text-blue-300">Audio: {pt.audioTokens.toLocaleString()} tok</div>}
                        {pt.thoughtsTokens > 0 && <div className="text-purple-300">Thoughts: {pt.thoughtsTokens.toLocaleString()} tok</div>}
                        <div className="text-stone-400 border-t border-stone-700 pt-0.5 mt-0.5 flex items-center justify-between gap-2">
                          <span>{pt.avgDurationMs}ms</span>
                          <span className="text-emerald-400 font-semibold">${pt.costUsd}</span>
                        </div>
                      </div>

                      {/* Bar Track with explicit h-36 height */}
                      <div className="w-full h-36 flex items-end justify-center">
                        <div
                          className={`w-full rounded-t-sm flex flex-col justify-end overflow-hidden transition-all duration-200 ${
                            total > 0
                              ? isHovered
                                ? "ring-2 ring-amber-500/80 shadow-xs opacity-100"
                                : "group-hover:opacity-90"
                              : "bg-stone-200/50"
                          }`}
                          style={{ height: total > 0 ? `${heightPercent}%` : "3px" }}
                        >
                          {SEGMENTS.map(([key, color]) => pt[key] > 0 && (
                            <div key={key} className={`${color} w-full`} style={{ height: `${(pt[key] / total) * 100}%` }} />
                          ))}
                        </div>
                      </div>

                      {/* X-axis Label */}
                      <span className={`text-[8px] sm:text-[9px] font-mono truncate w-full text-center ${isHovered ? "text-amber-700 font-bold" : "text-stone-500"}`}>
                        {pt.timeLabel}
                      </span>
                    </div>
                  );
                })
              ) : (
                <div className="w-full h-36 flex items-center justify-center text-xs font-mono text-stone-500">
                  No telemetry recorded yet in this window. Speak into the microphone or run an analysis.
                </div>
              )}
            </div>
          </div>

          {/* Live Model Invocation Receipts Log */}
          <div className="bg-white border border-stone-200 rounded-xl p-4 shadow-xs space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold font-mono text-stone-800 flex items-center gap-1.5">
                <Radio className="w-3.5 h-3.5 text-amber-600 animate-pulse" />
                Live Model Invocation Receipts
              </span>
              <span className="text-[11px] font-mono text-stone-500">
                Streaming from /api/tokens/telemetry/stream
              </span>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs font-mono">
                <thead>
                  <tr className="border-b border-stone-200 text-stone-500 text-[10.5px]">
                    {RECEIPT_COLS.map(c => c.startsWith(">")
                      ? <th key={c} className="pb-2 font-medium text-right">{c.slice(1)}</th>
                      : <th key={c} className="pb-2 font-medium">{c}</th>)}
                  </tr>
                </thead>
                <tbody className="divide-y divide-stone-100">
                  {liveRecords.length > 0 ? (
                    liveRecords.map((r) => (
                      <tr key={r.id} className="hover:bg-stone-50 transition-colors">
                        <td className="py-2 text-stone-500">
                          {new Date(r.timestampMs).toLocaleTimeString()}
                        </td>
                        <td className="py-2">
                          <span className="font-semibold text-stone-900">{r.agent}</span>
                          <span className="text-stone-500 text-[10px] block">{r.stage}</span>
                        </td>
                        <td className="py-2">
                          <div className="flex flex-wrap items-center gap-1">
                            {r.diarizationEnabled && (
                              <span className="px-1.5 py-0.5 rounded text-[9.5px] font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200">
                                Diarized
                              </span>
                            )}
                            {r.provider && (
                              <span
                                className={`px-1.5 py-0.5 rounded text-[9.5px] font-mono ${
                                  r.provider === "google_cloud_stt"
                                    ? "bg-indigo-50 text-indigo-700 border border-indigo-200"
                                    : "bg-amber-50 text-amber-700 border border-amber-200"
                                }`}
                              >
                                {r.provider === "google_cloud_stt" ? "Cloud STT" : "Gemini"}
                              </span>
                            )}
                            {r.source && (
                              <span className="px-1.5 py-0.5 rounded text-[9.5px] font-mono bg-stone-100 text-stone-600 border border-stone-200">
                                {r.source}
                              </span>
                            )}
                            {r.metadata?.speakerCount && (
                              <span className="text-[9.5px] text-stone-500 font-mono">
                                {r.metadata.speakerCount} spk
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="py-2">
                          <span
                            className={`px-1.5 py-0.5 rounded text-[10px] font-semibold ${
                              r.modality === "audio"
                                ? "bg-blue-50 text-blue-700 border border-blue-200"
                                : "bg-stone-100 text-stone-700 border border-stone-200"
                            }`}
                          >
                            {r.modality}
                          </span>
                        </td>
                        <td className="py-2 text-stone-600">{r.model}</td>
                        <td className="py-2 text-right font-semibold text-amber-700">
                          {r.promptTokens}
                        </td>
                        <td className="py-2 text-right font-semibold text-emerald-700">
                          {r.candidatesTokens}
                        </td>
                        <td className="py-2 text-right text-purple-700">
                          {r.thoughtsTokens || 0}
                        </td>
                        <td className="py-2 text-right font-bold text-stone-900">
                          {r.totalTokens}
                        </td>
                        <td className="py-2 text-right text-stone-500">
                          {r.durationMs}ms
                        </td>
                        <td className="py-2 text-right text-stone-600">
                          ${r.costEstimateUsd.toFixed(6)}
                        </td>
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td colSpan={11} className="py-6 text-center text-stone-500 italic">
                        No live model receipts received yet. Speak to trigger automatic agent invocations.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

        </div>
      )}

      {/* TAB 2: SUB-AGENT TOKEN ATTRIBUTION */}
      {activeTab === "subagents" && (
        <div className="space-y-4">
          <div className="bg-white border border-stone-200 rounded-xl p-4 shadow-xs space-y-4">
            <div className="border-b border-stone-100 pb-2">
              <span className="text-xs font-bold font-mono text-stone-800 flex items-center gap-1.5">
                <Cpu className="w-4 h-4 text-amber-600" />
                Exact Sub-Agent Token Attribution Receipts
              </span>
              <p className="text-xs text-stone-600 mt-1">
                Authoritative token and cost attribution broken down by sub-agent, modality, and execution stage.
              </p>
            </div>

            {/* Agent Attribution Cards Grid */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {aggregate?.byAgent && Object.keys(aggregate.byAgent).length > 0 ? (
                Object.entries(aggregate.byAgent).map(([agentName, data]) => (
                  <div key={agentName} className="p-3.5 bg-stone-50 border border-stone-200 rounded-xl space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="font-mono text-xs font-bold text-stone-900">{agentName}</span>
                      <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-amber-100 text-amber-800 font-semibold">
                        {data.percent}% of Total
                      </span>
                    </div>

                    {/* Progress Bar */}
                    <div className="w-full bg-stone-200 rounded-full h-2 overflow-hidden">
                      <div
                        className="bg-amber-600 h-full rounded-full transition-all duration-500"
                        style={{ width: `${Math.min(100, data.percent)}%` }}
                      />
                    </div>

                    <div className="grid grid-cols-3 gap-2 text-[11px] font-mono text-stone-600 pt-1 border-t border-stone-200/60">
                      <div>
                        <span className="text-stone-500 block text-[10px]">Tokens</span>
                        <span className="font-bold text-stone-900">{data.tokens.toLocaleString()}</span>
                      </div>
                      <div>
                        <span className="text-stone-500 block text-[10px]">Invocations</span>
                        <span className="font-bold text-stone-900">{data.requests}</span>
                      </div>
                      <div>
                        <span className="text-stone-500 block text-[10px]">Cost</span>
                        <span className="font-bold text-stone-900">${data.costUsd.toFixed(5)}</span>
                      </div>
                    </div>
                  </div>
                ))
              ) : (
                <div className="col-span-2 py-8 text-center text-xs font-mono text-stone-500 italic">
                  No sub-agent invocations recorded yet.
                </div>
              )}
            </div>

            {/* Modality Breakdown */}
            {aggregate?.byModality && Object.keys(aggregate.byModality).length > 0 && (
              <div className="p-3 bg-stone-100/70 border border-stone-200 rounded-xl space-y-2">
                <span className="text-[11px] font-mono font-bold uppercase text-stone-600 flex items-center gap-1">
                  <Layers className="w-3 h-3 text-stone-600" />
                  Modality Consumption
                </span>
                <div className="grid grid-cols-2 gap-3">
                  {Object.entries(aggregate.byModality).map(([mod, data]) => (
                    <div key={mod} className="p-2.5 bg-white rounded-lg border border-stone-200 flex justify-between items-center font-mono text-xs">
                      <div>
                        <span className="font-bold uppercase text-stone-900">{mod}</span>
                        <span className="text-[10px] text-stone-500 block">{data.requests} requests</span>
                      </div>
                      <div className="text-right">
                        <span className="font-bold text-amber-700">{data.tokens.toLocaleString()} tok</span>
                        <span className="text-[10px] text-stone-500 block">{data.percent}%</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Diarization & Provider Breakdown Grid */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <Breakdown title="Diarization Mode Breakdown" Icon={Radio} data={aggregate?.byDiarization}
                label={k => k === "diarized" ? "🎙️ Diarized (Multi-Speaker)" : "👤 Non-Diarized (Single Stream)"}
                tone={{ box: "bg-emerald-50/50 border-emerald-200/80", head: "text-emerald-850", icon: "text-emerald-700", row: "border-emerald-100", tok: "text-emerald-700" }} />
              <Breakdown title="Model Provider Breakdown" Icon={Cpu} data={aggregate?.byProvider}
                label={k => k === "google_cloud_stt" ? "Google Cloud STT V2" : "Gemini Models"}
                tone={{ box: "bg-indigo-50/50 border-indigo-200/80", head: "text-indigo-850", icon: "text-indigo-700", row: "border-indigo-100", tok: "text-indigo-700" }} />
            </div>

          </div>
        </div>
      )}

      {/* TAB 3: CONTEXT COMPACTION & SEMANTIC MEMORY */}
      {activeTab === "compaction" && (
        <div className="space-y-4">
          
          {/* Live Context Compaction Card */}
          <div className="bg-white border border-stone-200 rounded-xl p-4 shadow-xs space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-stone-100 pb-2">
              <span className="text-xs font-bold text-stone-800 font-mono flex items-center gap-1.5">
                <Layers className="w-4 h-4 text-amber-600" />
                Live Context Compaction Pipeline
              </span>
              <div className="flex items-center gap-1.5">
                <span className="text-xs font-mono font-bold text-emerald-800 bg-emerald-50 border border-emerald-200 px-2 py-0.5 rounded-full">
                  ⚡ Macro Summary: {compactionRatio}% Compaction
                </span>
                <span className="text-xs font-mono font-bold text-blue-800 bg-blue-50 border border-blue-200 px-2 py-0.5 rounded-full">
                  🚀 Rolling Window Savings: {deltaSavingsRatio}%
                </span>
              </div>
            </div>

            <p className="text-xs text-stone-600 leading-relaxed">
              Instead of streaming raw speech history into expensive reasoning sub-agents on every tick, the <b>Live Summarizer</b> continuously compacts spoken dialogue into dense markdown bullet points, while the <b>Rolling Window</b> restricts the verbatim prompt to the active ~40-word delta.
            </p>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-3 pt-2">
              <Pane title="1. Full Raw Speech" tokens={rawTokens} tokClass="text-amber-700" text={rawTranscript} empty="No raw transcript yet..." />
              <Pane title="2. Compacted Summary" tokens={summaryTokens} tokClass="text-emerald-700" text={liveSummary} empty="No active live summary yet..."
                badge={[`-${compactionRatio}%`, "text-emerald-700 bg-emerald-50 border-emerald-200"]} />
              <Pane title="3. Active Delta Window" tokens={deltaTokens} tokClass="text-blue-700" text={deltaText} empty="No delta window yet..."
                badge={[`-${deltaSavingsRatio}% vs raw`, "text-blue-700 bg-blue-50 border-blue-200"]} />
            </div>

            {/* Bottom Compaction & Complexity Bar */}
            <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-stone-100 text-xs font-mono">
              <span className="text-stone-600 flex items-center gap-1.5">
                ⚡ Active Reasoning Payload: <b className="text-emerald-700 font-bold">{combinedReasoningTokens} tokens</b> 
                <span className="text-stone-400 font-normal">({rollingSavingsRatio}% Effective Compaction)</span>
              </span>
              <span className="px-2 py-0.5 rounded-md bg-stone-100 text-stone-700 text-[11px] font-semibold border border-stone-200">
                Prompt Complexity: Capped O(1) (~40 words)
              </span>
            </div>
          </div>

          {/* Interactive Semantic Recall Playground */}
          <div className="bg-white border border-stone-200 rounded-xl p-4 shadow-xs space-y-3">
            <div className="flex items-center justify-between border-b border-stone-100 pb-2">
              <span className="text-xs font-bold text-stone-800 font-mono flex items-center gap-1.5">
                <Search className="w-3.5 h-3.5 text-amber-600" />
                Live Vertex AI Memory Bank Tester
              </span>
              <span className="text-[10px] font-mono text-stone-500">
                Reasoning Engine ID: {serverConfig?.agentEngineId || "Not configured"}
              </span>
            </div>

            <div className="flex items-center gap-2">
              <input
                type="text"
                value={queryInput}
                onChange={(e) => setQueryInput(e.target.value)}
                placeholder="Search semantic memory (e.g., 'vacation plans', 'meeting notes', 'priorities')..."
                className="flex-1 bg-stone-50 border border-stone-300 rounded-lg px-3 py-1.5 text-xs text-stone-900 font-mono focus:outline-none focus:border-amber-600"
              />
              <button
                type="button"
                onClick={handleTestMemoryRecall}
                disabled={testingQuery || !queryInput.trim()}
                className="px-3 py-1.5 bg-amber-600 hover:bg-amber-700 text-white font-mono font-bold text-xs rounded-lg transition-colors disabled:opacity-50 cursor-pointer shrink-0 flex items-center gap-1"
              >
                {testingQuery ? <RefreshCw className="w-3 h-3 animate-spin" /> : <Sparkles className="w-3 h-3" />}
                <span>Recall Memory</span>
              </button>
            </div>

            {testResult && (
              <div className="p-3 bg-stone-50 rounded-lg border border-stone-200 space-y-2">
                <div className="flex items-center justify-between text-[11px] font-mono text-stone-600 border-b border-stone-200 pb-1.5">
                  <span>Found {testResult.count || 0} matching memory record(s)</span>
                  <span className="text-emerald-700 font-bold">
                    Injected Tokens: ~{testResult.efficiency?.injectedMemoryTokens || 45} tok
                  </span>
                </div>
                {testResult.memories && testResult.memories.length > 0 ? (
                  <div className="space-y-1.5">
                    {testResult.memories.map((m: any, idx: number) => (
                      <div key={idx} className="p-2 bg-white rounded border border-stone-200 text-xs font-mono text-stone-800">
                        <span className="text-[10px] text-amber-700 font-bold block mb-0.5">
                          Author: {m.author} • {m.timestamp ? new Date(m.timestamp).toLocaleTimeString() : ""}
                        </span>
                        {m.text}
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="text-xs text-stone-500 italic py-1">No matching memory items found in Memory Bank.</div>
                )}
              </div>
            )}
          </div>

          {/* Memory Bank Token Efficiency Comparison Card */}
          <div className="bg-white border border-stone-200 rounded-xl p-4 shadow-xs space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-stone-100 pb-2">
              <span className="text-xs font-bold text-stone-800 font-mono flex items-center gap-1.5">
                <BrainCircuit className="w-4 h-4 text-amber-600" />
                Vertex AI Memory Bank vs. Naive Chatbot Injection
              </span>
              <div className="flex items-center gap-1.5">
                <span className="text-xs font-mono font-bold text-emerald-800 bg-emerald-50 border border-emerald-200 px-2 py-0.5 rounded-full">
                  ⚡ {memSavingsPercent}% Prompt Savings
                </span>
                <span className="text-xs font-mono font-bold text-blue-800 bg-blue-50 border border-blue-200 px-2 py-0.5 rounded-full">
                  🚀 {memMultiplier} Efficiency Gain
                </span>
              </div>
            </div>

            <p className="text-xs text-stone-600 leading-relaxed">
              Instead of dumping all historical sessions into the prompt (causing $O(N)$ prompt bloat and high latency), <b>Vertex AI Memory Bank</b> performs semantic vector retrieval—injecting only the ~{shownMemoryTokens} tokens needed for the active query.
            </p>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 pt-2">
              {/* 1. Naive Monolithic Prompt */}
              <div className="p-3 bg-stone-50 rounded-xl border border-stone-200 space-y-2">
                <div className="flex items-center justify-between text-[11px] font-mono text-stone-600 border-b border-stone-200/80 pb-1">
                  <span className="text-stone-700 font-semibold">❌ Naive Chatbot (All Past Sessions)</span>
                  <span className="text-rose-700 font-bold">{legacyPromptTokens.toLocaleString()} tokens</span>
                </div>
                <div className="space-y-1.5 text-xs font-mono text-stone-600">
                  <div className="flex justify-between text-[11px]">
                    <span>Historical Archive:</span>
                    <span className="font-semibold">{archiveTokens.toLocaleString()} tok ({archiveSessionCount} sessions)</span>
                  </div>
                  <div className="flex justify-between text-[11px]">
                    <span>Base Prompt & Schema:</span>
                    <span className="font-semibold">320 tok</span>
                  </div>
                  <div className="w-full bg-stone-200 h-2 rounded-full overflow-hidden mt-1.5">
                    <div className="bg-rose-500 h-full w-full" />
                  </div>
                </div>
              </div>

              {/* 2. Vertex AI Memory Bank */}
              <div className="p-3 bg-emerald-50/50 rounded-xl border border-emerald-200 space-y-2">
                <div className="flex items-center justify-between text-[11px] font-mono text-stone-600 border-b border-emerald-200/80 pb-1">
                  <span className="text-emerald-900 font-semibold">✅ Vertex AI Memory Bank</span>
                  <span className="text-emerald-700 font-bold">{memoryBankPromptTokens.toLocaleString()} tokens</span>
                </div>
                <div className="space-y-1.5 text-xs font-mono text-stone-600">
                  <div className="flex justify-between text-[11px]">
                    <span>Targeted Vector Memory:</span>
                    <span className="font-bold text-emerald-700">~{shownMemoryTokens} tok (1-2 records)</span>
                  </div>
                  <div className="flex justify-between text-[11px]">
                    <span>Base Prompt & Schema:</span>
                    <span className="font-semibold">320 tok</span>
                  </div>
                  <div className="w-full bg-stone-200 h-2 rounded-full overflow-hidden mt-1.5">
                    <div className="bg-emerald-600 h-full" style={{ width: `${Math.max(3, (memoryBankPromptTokens / legacyPromptTokens) * 100)}%` }} />
                  </div>
                </div>
              </div>
            </div>

            {/* Bottom Memory Savings & Gating Bar */}
            <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-stone-100 text-xs font-mono">
              <span className="text-stone-600 flex items-center gap-1.5">
                💰 Memory Tokens Saved: <b className="text-emerald-700 font-bold">~{memSavedTokens.toLocaleString()} tokens</b> 
                <span className="text-stone-400 font-normal">per question turn</span>
              </span>
              <span className="px-2 py-0.5 rounded-md bg-stone-100 text-stone-700 text-[11px] font-semibold border border-stone-200 flex items-center gap-1">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 inline-block"></span>
                Selective Gating: Standby during normal speech (0 tok)
              </span>
            </div>
          </div>

        </div>
      )}

    </div>
  );
}
