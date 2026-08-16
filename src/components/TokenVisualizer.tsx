import { useState, useEffect, useRef } from "react";
import {
  Zap,
  Layers,
  Database,
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
  FileText,
  Activity,
} from "lucide-react";
import {
  AdkEvent,
  TokenStatsResponse,
  TokenMetricRecord,
  TimeSeriesPoint,
  TokenAggregateStats,
} from "../types";

interface TokenVisualizerProps {
  events: AdkEvent[];
  rawTranscript?: string;
  liveSummary?: string;
}

export default function TokenVisualizer({
  events,
  rawTranscript = "",
  liveSummary = "",
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
  const [timeWindow, setTimeWindow] = useState<"1m" | "5m" | "10s">("1m");
  const [hoveredPoint, setHoveredPoint] = useState<TimeSeriesPoint | null>(null);

  const sseRef = useRef<EventSource | null>(null);

  // Fetch standard token & compaction stats
  const fetchTokenStats = async () => {
    try {
      setLoading(true);
      const [statsRes, tsRes, aggRes] = await Promise.all([
        fetch(`/api/tokens/stats?text=${encodeURIComponent(rawTranscript)}&summary=${encodeURIComponent(liveSummary)}`),
        fetch(`/api/tokens/telemetry/timeseries?interval=${timeWindow}`),
        fetch(`/api/tokens/telemetry/aggregate`),
      ]);

      if (statsRes.ok) {
        const data = await statsRes.json();
        setStats(data);
      }
      if (tsRes.ok) {
        const tsData = await tsRes.json();
        setTimeSeries(tsData.points || []);
      }
      if (aggRes.ok) {
        const aggData = await aggRes.json();
        setAggregate(aggData);
      }
    } catch (e) {
      console.warn("Failed to fetch token telemetry:", e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchTokenStats();
  }, [rawTranscript, liveSummary, timeWindow]);

  // Connect to SSE token telemetry stream
  useEffect(() => {
    let es: EventSource | null = null;
    const connectSSE = () => {
      try {
        es = new EventSource("/api/tokens/telemetry/stream");
        sseRef.current = es;

        es.onmessage = (ev) => {
          try {
            const record = JSON.parse(ev.data) as TokenMetricRecord;
            setLiveRecords((prev) => [record, ...prev.slice(0, 49)]);
            // Refresh time-series and aggregate stats on new record
            fetch(`/api/tokens/telemetry/timeseries?interval=${timeWindow}`)
              .then((r) => r.json())
              .then((d) => setTimeSeries(d.points || []))
              .catch(() => {});
            fetch(`/api/tokens/telemetry/aggregate`)
              .then((r) => r.json())
              .then((d) => setAggregate(d))
              .catch(() => {});
          } catch (err) {
            console.warn("Failed to parse token SSE:", err);
          }
        };

        es.onerror = () => {
          es?.close();
          setTimeout(connectSSE, 4000);
        };
      } catch (err) {
        console.warn("Token SSE error:", err);
      }
    };

    connectSSE();
    return () => {
      es?.close();
    };
  }, [timeWindow]);

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
      if (res.ok) {
        const data = await res.json();
        setTestResult(data);
      }
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
    latestRetrieveEvent?.actions?.stateDelta?.memories ||
    latestRetrieveEvent?.stateDelta?.memories ||
    [];

  const displayedMemories = testResult?.memories?.length
    ? testResult.memories
    : latestMemories;

  const rawTokens = stats?.compaction?.rawTokens ?? Math.ceil(rawTranscript.length / 3.8);
  const summaryTokens = stats?.compaction?.compactedTokens ?? Math.ceil(liveSummary.length / 3.8);
  const compactionRatio = stats?.compaction?.ratioPercent ?? (rawTokens > summaryTokens && rawTokens > 0 ? Number((((rawTokens - summaryTokens) / rawTokens) * 100).toFixed(1)) : 0);

  // Maximum tokens across time-series buckets for chart scale
  const maxBucketTokens = Math.max(
    ...timeSeries.map((p) => p.totalTokens),
    100
  );

  return (
    <div className="flex-1 flex flex-col min-h-0 bg-stone-50 text-stone-900 p-4 space-y-4 overflow-y-auto font-sans">
      
      {/* Top 4 KPI Metrics Header */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 shrink-0">
        
        {/* Card 1: Total Model Tokens */}
        <div className="bg-white border border-stone-200 rounded-xl p-3.5 shadow-xs flex flex-col justify-between space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-mono font-semibold uppercase text-stone-500 flex items-center gap-1.5">
              <Zap className="w-3.5 h-3.5 text-amber-600" />
              Total Model Tokens
            </span>
            <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-amber-50 text-amber-800 border border-amber-200">
              Live Billing
            </span>
          </div>
          <div className="flex items-baseline gap-2">
            <span className="text-2xl font-bold font-mono text-stone-900">
              {(aggregate?.totalTokens || 0).toLocaleString()}
            </span>
            <span className="text-xs font-mono text-stone-500">tok</span>
          </div>
          <div className="text-[11px] text-stone-500 flex items-center justify-between border-t border-stone-100 pt-1.5 font-mono">
            <span>In: {(aggregate?.totalPromptTokens || 0).toLocaleString()}</span>
            <span>Out: {(aggregate?.totalCandidatesTokens || 0).toLocaleString()}</span>
          </div>
        </div>

        {/* Card 2: Audio Modality Tokens */}
        <div className="bg-white border border-stone-200 rounded-xl p-3.5 shadow-xs flex flex-col justify-between space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-mono font-semibold uppercase text-stone-500 flex items-center gap-1.5">
              <Mic className="w-3.5 h-3.5 text-blue-600" />
              Audio Ingested
            </span>
            <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-blue-50 text-blue-800 border border-blue-200">
              STT Encoder
            </span>
          </div>
          <div className="flex items-baseline gap-2">
            <span className="text-2xl font-bold font-mono text-stone-900">
              {(aggregate?.totalAudioTokens || 0).toLocaleString()}
            </span>
            <span className="text-xs font-mono text-stone-500">audio tok</span>
          </div>
          <div className="text-[11px] text-stone-500 flex items-center justify-between border-t border-stone-100 pt-1.5 font-mono">
            <span>Reasoning Out: {(aggregate?.totalThoughtsTokens || 0).toLocaleString()}</span>
          </div>
        </div>

        {/* Card 3: Invocations & Latency */}
        <div className="bg-white border border-stone-200 rounded-xl p-3.5 shadow-xs flex flex-col justify-between space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-mono font-semibold uppercase text-stone-500 flex items-center gap-1.5">
              <Clock className="w-3.5 h-3.5 text-emerald-600" />
              Requests & Latency
            </span>
            <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-800 border border-emerald-200">
              Performance
            </span>
          </div>
          <div className="flex items-baseline gap-2">
            <span className="text-2xl font-bold font-mono text-stone-900">
              {aggregate?.requestCount || 0}
            </span>
            <span className="text-xs font-mono text-stone-500">reqs • {aggregate?.avgLatencyMs || 0}ms avg</span>
          </div>
          <div className="text-[11px] text-stone-500 flex items-center justify-between border-t border-stone-100 pt-1.5 font-mono">
            <span>Model: {stats?.archive?.sessionCount ? `${stats.archive.sessionCount} sessions` : "gemini-3.7-flash"}</span>
          </div>
        </div>

        {/* Card 4: Estimated API Cost */}
        <div className="bg-white border border-stone-200 rounded-xl p-3.5 shadow-xs flex flex-col justify-between space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-mono font-semibold uppercase text-stone-500 flex items-center gap-1.5">
              <DollarSign className="w-3.5 h-3.5 text-amber-600" />
              Estimated Cost
            </span>
            <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-amber-50 text-amber-800 border border-amber-200">
              Standard Rates
            </span>
          </div>
          <div className="flex items-baseline gap-2">
            <span className="text-2xl font-bold font-mono text-stone-900">
              ${(aggregate?.totalCostUsd || 0).toFixed(5)}
            </span>
            <span className="text-xs font-mono text-stone-500">USD</span>
          </div>
          <div className="text-[11px] text-stone-500 flex items-center justify-between border-t border-stone-100 pt-1.5 font-mono">
            <span>Compaction: {compactionRatio}% saved</span>
          </div>
        </div>

      </div>

      {/* Sub-Navigation Tabs */}
      <div className="flex items-center justify-between border-b border-stone-200 pb-2">
        <div className="flex items-center space-x-1">
          <button
            type="button"
            onClick={() => setActiveTab("timeseries")}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium font-mono transition-colors flex items-center gap-1.5 cursor-pointer ${
              activeTab === "timeseries"
                ? "bg-amber-600 text-white font-semibold shadow-xs"
                : "bg-white text-stone-600 hover:bg-stone-100 border border-stone-200"
            }`}
          >
            <BarChart3 className="w-3.5 h-3.5" />
            Time-Series Telemetry
          </button>
          <button
            type="button"
            onClick={() => setActiveTab("subagents")}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium font-mono transition-colors flex items-center gap-1.5 cursor-pointer ${
              activeTab === "subagents"
                ? "bg-amber-600 text-white font-semibold shadow-xs"
                : "bg-white text-stone-600 hover:bg-stone-100 border border-stone-200"
            }`}
          >
            <Cpu className="w-3.5 h-3.5" />
            Sub-Agent Attribution
          </button>
          <button
            type="button"
            onClick={() => setActiveTab("compaction")}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium font-mono transition-colors flex items-center gap-1.5 cursor-pointer ${
              activeTab === "compaction"
                ? "bg-amber-600 text-white font-semibold shadow-xs"
                : "bg-white text-stone-600 hover:bg-stone-100 border border-stone-200"
            }`}
          >
            <Layers className="w-3.5 h-3.5" />
            Context Compaction & Memory
          </button>
        </div>

        {activeTab === "timeseries" && (
          <div className="flex items-center gap-1.5">
            <span className="text-[11px] font-mono text-stone-500">Interval:</span>
            {(["10s", "1m", "5m"] as const).map((win) => (
              <button
                key={win}
                type="button"
                onClick={() => setTimeWindow(win)}
                className={`px-2 py-1 text-[11px] font-mono rounded cursor-pointer ${
                  timeWindow === win
                    ? "bg-stone-900 text-white font-bold"
                    : "bg-white text-stone-600 hover:bg-stone-100 border border-stone-200"
                }`}
              >
                {win}
              </button>
            ))}
            <button
              type="button"
              onClick={fetchTokenStats}
              disabled={loading}
              className="p-1 text-stone-500 hover:text-stone-800 rounded hover:bg-stone-100 cursor-pointer ml-1"
              title="Refresh telemetry"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
            </button>
          </div>
        )}
      </div>

      {/* TAB 1: REAL-TIME TIME-SERIES TELEMETRY */}
      {activeTab === "timeseries" && (
        <div className="space-y-4">
          
          {/* Visual Time-Series Chart Box */}
          <div className="bg-white border border-stone-200 rounded-xl p-4 shadow-xs space-y-3">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-stone-100 pb-2">
              <span className="text-xs font-bold font-mono text-stone-800 flex items-center gap-1.5 shrink-0">
                <Activity className="w-4 h-4 text-amber-600" />
                Live Token Consumption Over Time ({timeWindow} resolution)
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
                  <span className="flex items-center gap-1 shrink-0">
                    <span className="w-2.5 h-2.5 rounded-sm bg-amber-500 inline-block" />
                    Prompt (Input)
                  </span>
                  <span className="flex items-center gap-1 shrink-0">
                    <span className="w-2.5 h-2.5 rounded-sm bg-emerald-500 inline-block" />
                    Candidates (Output)
                  </span>
                  <span className="flex items-center gap-1 shrink-0">
                    <span className="w-2.5 h-2.5 rounded-sm bg-blue-500 inline-block" />
                    Audio (STT)
                  </span>
                  <span className="flex items-center gap-1 shrink-0">
                    <span className="w-2.5 h-2.5 rounded-sm bg-purple-500 inline-block" />
                    Thoughts (Reasoning)
                  </span>
                </div>
              )}
            </div>

            {/* Bar Chart Canvas */}
            <div className="relative min-h-[200px] flex items-end gap-2 pt-8 pb-2 border-b border-stone-100 overflow-visible">
              {timeSeries.length > 0 ? (
                timeSeries.map((pt, idx) => {
                  const total = pt.totalTokens;
                  const heightPercent = total > 0 ? Math.max(12, Math.round((total / maxBucketTokens) * 100)) : 4;
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
                      className="flex-1 min-w-[28px] max-w-[48px] flex flex-col items-center gap-1 group relative h-full justify-end cursor-pointer"
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

                      {/* Stacked Bar */}
                      <div
                        className={`w-full rounded-t-sm flex flex-col justify-end overflow-hidden transition-all duration-200 bg-stone-100 ${
                          isHovered ? "ring-2 ring-amber-500/80 shadow-sm opacity-100" : "group-hover:opacity-90"
                        }`}
                        style={{ height: `${heightPercent}%` }}
                      >
                        {pt.thoughtsTokens > 0 && (
                          <div
                            className="bg-purple-500 w-full"
                            style={{ height: `${(pt.thoughtsTokens / (total || 1)) * 100}%` }}
                          />
                        )}
                        {pt.candidatesTokens > 0 && (
                          <div
                            className="bg-emerald-500 w-full"
                            style={{ height: `${(pt.candidatesTokens / (total || 1)) * 100}%` }}
                          />
                        )}
                        {pt.audioTokens > 0 && (
                          <div
                            className="bg-blue-500 w-full"
                            style={{ height: `${(pt.audioTokens / (total || 1)) * 100}%` }}
                          />
                        )}
                        {pt.promptTokens > 0 && (
                          <div
                            className="bg-amber-500 w-full"
                            style={{ height: `${(pt.promptTokens / (total || 1)) * 100}%` }}
                          />
                        )}
                      </div>

                      {/* X-axis Label */}
                      <span className={`text-[9px] font-mono truncate w-full text-center ${isHovered ? "text-amber-700 font-bold" : "text-stone-500"}`}>
                        {pt.timeLabel}
                      </span>
                    </div>
                  );
                })
              ) : (
                <div className="w-full h-full flex items-center justify-center text-xs font-mono text-stone-500">
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
                    <th className="pb-2 font-medium">Timestamp</th>
                    <th className="pb-2 font-medium">Agent / Stage</th>
                    <th className="pb-2 font-medium">Modality</th>
                    <th className="pb-2 font-medium">Model</th>
                    <th className="pb-2 font-medium text-right">Prompt</th>
                    <th className="pb-2 font-medium text-right">Output</th>
                    <th className="pb-2 font-medium text-right">Thinking</th>
                    <th className="pb-2 font-medium text-right">Total</th>
                    <th className="pb-2 font-medium text-right">Latency</th>
                    <th className="pb-2 font-medium text-right">Cost</th>
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
                      <td colSpan={10} className="py-6 text-center text-stone-500 italic">
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

          </div>
        </div>
      )}

      {/* TAB 3: CONTEXT COMPACTION & SEMANTIC MEMORY */}
      {activeTab === "compaction" && (
        <div className="space-y-4">
          
          {/* Live Context Compaction Card */}
          <div className="bg-white border border-stone-200 rounded-xl p-4 shadow-xs space-y-3">
            <div className="flex items-center justify-between border-b border-stone-100 pb-2">
              <span className="text-xs font-bold text-stone-800 font-mono flex items-center gap-1.5">
                <Layers className="w-4 h-4 text-amber-600" />
                Live Context Compaction Pipeline
              </span>
              <span className="text-xs font-mono font-bold text-emerald-800 bg-emerald-50 border border-emerald-200 px-2 py-0.5 rounded-full">
                ⚡ {compactionRatio}% Compression
              </span>
            </div>

            <p className="text-xs text-stone-600 leading-relaxed">
              Instead of streaming raw speech history into expensive reasoning sub-agents on every tick, the <b>Live Summarizer</b> continuously compacts spoken dialogue into dense, structured markdown bullet points.
            </p>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 pt-2">
              {/* Raw Speech Input */}
              <div className="p-3 bg-stone-50 rounded-xl border border-stone-200 space-y-2">
                <div className="flex items-center justify-between text-[11px] font-mono text-stone-600 border-b border-stone-200/80 pb-1">
                  <span>1. Raw Speech Stream</span>
                  <span className="text-amber-700 font-bold">{rawTokens} tokens</span>
                </div>
                <div className="text-xs font-mono text-stone-800 bg-white p-2.5 rounded border border-stone-200 max-h-28 overflow-y-auto whitespace-pre-wrap">
                  {rawTranscript || <span className="text-stone-400 italic">No raw transcript yet...</span>}
                </div>
              </div>

              {/* Compacted Output */}
              <div className="p-3 bg-stone-50 rounded-xl border border-stone-200 space-y-2">
                <div className="flex items-center justify-between text-[11px] font-mono text-stone-600 border-b border-stone-200/80 pb-1">
                  <span>2. Compacted Context</span>
                  <span className="text-emerald-700 font-bold">{summaryTokens} tokens</span>
                </div>
                <div className="text-xs font-mono text-stone-800 bg-white p-2.5 rounded border border-stone-200 max-h-28 overflow-y-auto whitespace-pre-wrap">
                  {liveSummary || <span className="text-stone-400 italic">No active live summary yet...</span>}
                </div>
              </div>
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
                Reasoning Engine ID: 1566436282941308928
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

        </div>
      )}

    </div>
  );
}
