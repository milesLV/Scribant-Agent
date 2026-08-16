import { useState, useEffect } from "react";
import {
  Zap,
  Layers,
  Database,
  ArrowRight,
  Sparkles,
  TrendingDown,
  BarChart3,
  Search,
  ShieldCheck,
  RefreshCw,
  BrainCircuit,
  Cpu,
} from "lucide-react";
import {
  AdkEvent,
  TokenStatsResponse,
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
  const [loading, setLoading] = useState(false);
  const [queryInput, setQueryInput] = useState("Spain vacation");
  const [testResult, setTestResult] = useState<any>(null);
  const [testingQuery, setTestingQuery] = useState(false);
  const [activeTab, setActiveTab] = useState<"comparison" | "compaction" | "subagents">("comparison");
  const [simulatedMode, setSimulatedMode] = useState<"memory_bank" | "legacy_stuffing">("memory_bank");

  // Extract latest memory retrieval event to show exactly what data was fetched from memory
  const latestRetrieveEvent = events.find((e: any) => {
    const delta = e.actions?.stateDelta || e.stateDelta || {};
    return e.author === "memory" && (delta.eventType === "memory:retrieve" || delta.query || e.content?.parts?.some((p: any) => p.text?.includes("[Memory Retrieve]")));
  });

  const latestMemories: { text: string; author: string; timestamp?: string }[] =
    latestRetrieveEvent?.actions?.stateDelta?.memories ||
    latestRetrieveEvent?.stateDelta?.memories ||
    [];

  const displayedMemories = testResult?.memories?.length
    ? testResult.memories
    : latestMemories.length
    ? latestMemories
    : [
        {
          text: "Identity: Named Laxmi; lives in Bangalore; favorite color is black.",
          author: "user",
          timestamp: "2026-08-13T23:04:36.175Z",
        },
        {
          text: "Travel Plans: Passionate about traveling, next dream destination is Spain.",
          author: "user",
          timestamp: "2026-08-15T23:02:53.096Z",
        },
      ];

  // Fetch token stats from server
  const fetchTokenStats = async () => {
    try {
      setLoading(true);
      const res = await fetch(
        `/api/tokens/stats?text=${encodeURIComponent(rawTranscript)}&summary=${encodeURIComponent(liveSummary)}`
      );
      if (res.ok) {
        const data = await res.json();
        setStats(data);
      }
    } catch (e) {
      console.warn("Failed to fetch token stats:", e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchTokenStats();
  }, [rawTranscript, liveSummary, events.length]);

  // Compute live local estimates if stats haven't loaded yet
  const estimateCharsToTokens = (str: string) => Math.max(0, Math.ceil((str || "").trim().length / 3.8));
  const rawTokens = stats?.compaction?.rawTokens ?? estimateCharsToTokens(rawTranscript);
  const summaryTokens = stats?.compaction?.compactedTokens ?? estimateCharsToTokens(liveSummary);
  const compactionRatio = stats?.compaction?.ratioPercent ?? (rawTokens > summaryTokens && rawTokens > 0 ? Number((((rawTokens - summaryTokens) / rawTokens) * 100).toFixed(1)) : 0);

  const archiveTokens = stats?.archive?.totalArchiveTokens ?? 0;
  const sessionCount = stats?.archive?.sessionCount ?? 0;
  const basePromptTokens = 320;
  const injectedMemoryTokens = stats?.efficiency?.injectedMemoryTokens || 45;

  const legacyTotalTokens = basePromptTokens + archiveTokens + rawTokens;
  const memoryBankTotalTokens = basePromptTokens + injectedMemoryTokens + rawTokens;
  const tokenSavingsPercent = legacyTotalTokens > 0
    ? Number((((legacyTotalTokens - memoryBankTotalTokens) / legacyTotalTokens) * 100).toFixed(1))
    : 0;
  const efficiencyMultiplier = memoryBankTotalTokens > 0
    ? (legacyTotalTokens / memoryBankTotalTokens).toFixed(1)
    : "1.0";

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

  return (
    <div className="p-5 space-y-5 font-sans bg-stone-50/40">
      
      {/* Top 3 Real-time Metric Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        
        {/* Card 1: Active Prompt Tokens */}
        <div className="bg-white border border-stone-200/90 rounded-2xl p-4 shadow-2xs space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-mono font-bold uppercase text-stone-500 flex items-center gap-1.5">
              <Zap className="w-3.5 h-3.5 text-amber-500" />
              Active Prompt Tokens
            </span>
            <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-amber-50 text-amber-800 border border-amber-200 font-bold">
              Live Tick
            </span>
          </div>
          <div>
            <div className="text-2xl font-mono font-extrabold text-stone-900 tracking-tight">
              {simulatedMode === "memory_bank" ? memoryBankTotalTokens.toLocaleString() : legacyTotalTokens.toLocaleString()}
              <span className="text-xs text-stone-500 font-normal ml-1 font-mono">tokens</span>
            </div>
            <div className="text-[11px] text-stone-600 flex items-center gap-2 mt-1">
              <span>Base: <b className="text-stone-800 font-mono">{basePromptTokens}</b></span>
              <span>•</span>
              <span>Memory: <b className="text-emerald-700 font-mono">{simulatedMode === "memory_bank" ? `+${injectedMemoryTokens}` : `+${archiveTokens.toLocaleString()}`}</b></span>
            </div>
          </div>
          <div className="w-full bg-stone-100 rounded-full h-1.5 overflow-hidden flex">
            <div style={{ width: "40%" }} className="bg-sky-500 h-full" title="Base Prompt & Tools" />
            <div style={{ width: simulatedMode === "memory_bank" ? "10%" : "55%" }} className={simulatedMode === "memory_bank" ? "bg-emerald-500 h-full" : "bg-red-500 h-full"} title="Injected Memory" />
            <div style={{ width: "50%" }} className="bg-amber-500 h-full" title="Active Transcript" />
          </div>
        </div>

        {/* Card 2: Context Compaction Ratio */}
        <div className="bg-white border border-stone-200/90 rounded-2xl p-4 shadow-2xs space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-mono font-bold uppercase text-stone-500 flex items-center gap-1.5">
              <TrendingDown className="w-3.5 h-3.5 text-sky-600" />
              Context Compaction
            </span>
            <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-sky-50 text-sky-800 border border-sky-200 font-bold">
              Live Summarizer
            </span>
          </div>
          <div>
            <div className="text-2xl font-mono font-extrabold text-sky-700 tracking-tight">
              ⚡ {compactionRatio}%
              <span className="text-xs text-stone-500 font-normal ml-1.5 font-sans">compacted</span>
            </div>
            <div className="text-[11px] text-stone-600 mt-1">
              Raw: <b className="text-stone-800 font-mono">{rawTokens} tok</b> <ArrowRight className="w-2.5 h-2.5 inline mx-0.5 text-stone-400" /> Compact: <b className="text-sky-700 font-mono">{summaryTokens} tok</b>
            </div>
          </div>
          <div className="w-full bg-stone-100 rounded-full h-1.5 overflow-hidden">
            <div style={{ width: `${compactionRatio}%` }} className="bg-sky-500 h-full rounded-full transition-all duration-500" />
          </div>
        </div>

        {/* Card 3: Vertex AI Memory Bank Savings */}
        <div className="bg-white border border-stone-200/90 rounded-2xl p-4 shadow-2xs space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-mono font-bold uppercase text-stone-500 flex items-center gap-1.5">
              <Database className="w-3.5 h-3.5 text-emerald-600" />
              Memory Bank Efficiency
            </span>
            <span className="text-[10px] font-mono px-2.5 py-0.5 rounded-full bg-emerald-50 text-emerald-800 border border-emerald-200 font-bold">
              {efficiencyMultiplier}x Gain
            </span>
          </div>
          <div>
            <div className="text-2xl font-mono font-extrabold text-emerald-700 tracking-tight">
              {tokenSavingsPercent}%
              <span className="text-xs text-stone-500 font-normal ml-1 font-sans">token reduction</span>
            </div>
            <div className="text-[11px] text-stone-600 mt-1">
              Saved <b className="text-emerald-700 font-mono">{(legacyTotalTokens - memoryBankTotalTokens).toLocaleString()} tokens</b> per prompt turn
            </div>
          </div>
          <div className="w-full bg-stone-100 rounded-full h-1.5 overflow-hidden">
            <div style={{ width: `${tokenSavingsPercent}%` }} className="bg-emerald-500 h-full rounded-full transition-all duration-500" />
          </div>
        </div>

      </div>

      {/* Navigation Tabs for Visualizer Sub-views */}
      <div className="flex flex-wrap items-center justify-between border-b border-stone-200/90 pb-3 gap-3">
        <div className="flex items-center gap-2 bg-stone-100 p-1 rounded-xl border border-stone-200/80">
          <button
            type="button"
            onClick={() => setActiveTab("comparison")}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all cursor-pointer flex items-center gap-1.5 ${
              activeTab === "comparison"
                ? "bg-white text-stone-900 shadow-2xs font-bold border border-stone-200"
                : "text-stone-600 hover:text-stone-900"
            }`}
          >
            <BarChart3 className="w-3.5 h-3.5 text-amber-600" />
            <span>Memory Bank: Before vs After</span>
          </button>

          <button
            type="button"
            onClick={() => setActiveTab("compaction")}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all cursor-pointer flex items-center gap-1.5 ${
              activeTab === "compaction"
                ? "bg-white text-stone-900 shadow-2xs font-bold border border-stone-200"
                : "text-stone-600 hover:text-stone-900"
            }`}
          >
            <Layers className="w-3.5 h-3.5 text-sky-600" />
            <span>Context Compaction Funnel</span>
          </button>

          <button
            type="button"
            onClick={() => setActiveTab("subagents")}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all cursor-pointer flex items-center gap-1.5 ${
              activeTab === "subagents"
                ? "bg-white text-stone-900 shadow-2xs font-bold border border-stone-200"
                : "text-stone-600 hover:text-stone-900"
            }`}
          >
            <Cpu className="w-3.5 h-3.5 text-purple-600" />
            <span>Agent Pipeline Breakdown</span>
          </button>
        </div>

        <button
          type="button"
          onClick={fetchTokenStats}
          disabled={loading}
          className="p-2 text-stone-500 hover:text-stone-800 hover:bg-white rounded-xl border border-stone-200/80 transition-all cursor-pointer shadow-2xs"
          title="Refresh token stats"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin text-amber-600" : ""}`} />
        </button>
      </div>

      {/* TAB 1: BEFORE VS AFTER MEMORY BANK COMPARISON */}
      {activeTab === "comparison" && (
        <div className="space-y-4 font-sans">
          
          {/* Interactive A/B Toggle Switch */}
          <div className="bg-white border border-stone-200/90 rounded-2xl p-4 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 shadow-2xs">
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <span className="text-xs font-bold text-stone-800 uppercase tracking-wide font-mono">
                  Live Showcase Mode
                </span>
                <span className="text-[10px] px-2.5 py-0.5 rounded-full bg-stone-100 text-stone-700 border border-stone-200 font-mono font-bold">
                  {sessionCount} Historical Sessions Archived ({archiveTokens.toLocaleString()} tokens)
                </span>
              </div>
            </div>

            <div className="flex items-center bg-stone-100 p-1 rounded-xl border border-stone-200/80 shrink-0">
              <button
                type="button"
                onClick={() => setSimulatedMode("legacy_stuffing")}
                className={`px-3 py-1.5 rounded-lg text-xs font-mono font-bold transition-all cursor-pointer ${
                  simulatedMode === "legacy_stuffing"
                    ? "bg-red-100 text-red-900 border border-red-200 shadow-2xs"
                    : "text-stone-600 hover:text-stone-900"
                }`}
              >
                🔴 Before: Context Stuffing
              </button>
              <button
                type="button"
                onClick={() => setSimulatedMode("memory_bank")}
                className={`px-3 py-1.5 rounded-lg text-xs font-mono font-bold transition-all cursor-pointer ${
                  simulatedMode === "memory_bank"
                    ? "bg-emerald-100 text-emerald-900 border border-emerald-200 shadow-2xs"
                    : "text-stone-600 hover:text-stone-900"
                }`}
              >
                🟢 After: Vertex AI Memory Bank
              </button>
            </div>
          </div>

          {/* Side-by-Side Visual Gauge Bars */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            
            {/* BEFORE: Legacy Full Archive Dump */}
            <div className={`rounded-2xl p-5 border transition-all shadow-2xs ${
              simulatedMode === "legacy_stuffing"
                ? "bg-red-50/50 border-red-300 ring-1 ring-red-200"
                : "bg-white border-stone-200/90 opacity-70"
            }`}>
              <div className="flex items-center justify-between pb-3 border-b border-stone-200/80">
                <span className="text-xs font-bold text-red-700 font-mono flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-full bg-red-500" />
                  BEFORE: Monolithic Prompt Injection
                </span>
                <span className="text-xs font-mono font-bold text-red-800">
                  {legacyTotalTokens.toLocaleString()} tokens
                </span>
              </div>

              <div className="py-3 space-y-3">
                <div className="text-xs text-stone-700 leading-relaxed">
                  Sends the entire history of <b>{sessionCount} past sessions</b> into the context window on every turn.
                </div>
                <div className="space-y-1.5 text-xs font-mono text-stone-600 bg-stone-50 p-3 rounded-xl border border-stone-200/80">
                  <div className="flex justify-between">
                    <span>Base Instructions:</span>
                    <span>{basePromptTokens} tokens</span>
                  </div>
                  <div className="flex justify-between text-red-700 font-semibold">
                    <span>Full Past Transcripts ({sessionCount} sessions):</span>
                    <span>+{archiveTokens.toLocaleString()} tokens</span>
                  </div>
                  <div className="flex justify-between">
                    <span>Active Session Input:</span>
                    <span>+{rawTokens} tokens</span>
                  </div>
                </div>

                <div className="p-3 bg-red-50/80 rounded-xl border border-red-200 text-xs text-red-900 space-y-1">
                  <div>⚠️ <b>Latency:</b> ~2.8s – 3.5s per turn</div>
                  <div>⚠️ <b>Cost Scaling:</b> $O(N)$ linear growth with session history</div>
                  <div>⚠️ <b>Attention Risk:</b> Lost-in-the-middle context dilution</div>
                </div>
              </div>
            </div>

            {/* AFTER: Vertex AI Memory Bank */}
            <div className={`rounded-2xl p-5 border transition-all shadow-2xs ${
              simulatedMode === "memory_bank"
                ? "bg-emerald-50/50 border-emerald-300 ring-1 ring-emerald-200"
                : "bg-white border-stone-200/90 opacity-70"
            }`}>
              <div className="flex items-center justify-between pb-3 border-b border-stone-200/80">
                <span className="text-xs font-bold text-emerald-800 font-mono flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
                  AFTER: Vertex AI Memory Bank
                </span>
                <span className="text-xs font-mono font-bold text-emerald-800">
                  {memoryBankTotalTokens.toLocaleString()} tokens
                </span>
              </div>

              <div className="py-3 space-y-3">
                <div className="text-xs text-stone-700 leading-relaxed">
                  Queries Vertex AI Memory Bank via ADK callback and injects only <b>the top 2 relevant facts</b>.
                </div>
                <div className="space-y-1.5 text-xs font-mono text-stone-600 bg-stone-50 p-3 rounded-xl border border-stone-200/80">
                  <div className="flex justify-between">
                    <span>Base Instructions:</span>
                    <span>{basePromptTokens} tokens</span>
                  </div>
                  <div className="flex justify-between text-emerald-700 font-semibold">
                    <span>Targeted Memory Recall:</span>
                    <span>+{injectedMemoryTokens} tokens</span>
                  </div>
                  <div className="flex justify-between">
                    <span>Active Session Input:</span>
                    <span>+{rawTokens} tokens</span>
                  </div>
                </div>

                <div className="p-3 bg-emerald-50/80 rounded-xl border border-emerald-200 text-xs text-emerald-900 space-y-1">
                  <div>⚡ <b>Latency:</b> Sub-second (~0.4s response)</div>
                  <div>⚡ <b>Cost Scaling:</b> $O(1)$ constant flat token overhead forever</div>
                  <div>⚡ <b>Precision:</b> 100% focused semantic grounding</div>
                </div>

                {/* Explicit Visual Box showing exact data fetched from Memory Bank */}
                <div className="p-3 bg-white rounded-xl border border-emerald-200 space-y-2 shadow-2xs">
                  <div className="flex items-center justify-between text-xs font-mono text-emerald-800 font-bold border-b border-emerald-100 pb-1.5">
                    <span className="flex items-center gap-1.5">
                      <BrainCircuit className="w-3.5 h-3.5 text-emerald-600" />
                      Data Fetched from Memory Bank:
                    </span>
                    <span className="text-[10px] text-emerald-800 bg-emerald-100 px-2 py-0.5 rounded-md border border-emerald-200">
                      +{injectedMemoryTokens} tokens
                    </span>
                  </div>
                  <div className="space-y-1.5">
                    {displayedMemories.slice(0, 2).map((m: any, idx: number) => (
                      <div key={idx} className="p-2 bg-emerald-50/50 rounded-lg border border-emerald-100 text-xs font-mono text-stone-800">
                        <span className="text-[10px] text-emerald-700 font-bold block mb-0.5">
                          • {m.author ? `[Author: ${m.author}]` : "[Memory Fact]"} {m.timestamp ? `(${new Date(m.timestamp).toLocaleDateString()})` : ""}:
                        </span>
                        <span className="text-stone-700 font-sans text-xs leading-normal block">{m.text}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>

          </div>

          {/* Interactive Semantic Recall Playground */}
          <div className="bg-white border border-stone-200/90 rounded-2xl p-5 space-y-3 shadow-2xs">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold text-stone-800 font-mono flex items-center gap-1.5">
                <Search className="w-3.5 h-3.5 text-amber-600" />
                Live Semantic Recall Tester
              </span>
              <span className="text-[10px] font-mono text-stone-500">
                ADK beforeModelCallback Simulation
              </span>
            </div>

            <div className="flex items-center gap-2">
              <input
                type="text"
                value={queryInput}
                onChange={(e) => setQueryInput(e.target.value)}
                placeholder="Search semantic memory (e.g. 'green tea', 'Kyoto', 'roadmap presentation')..."
                className="flex-1 bg-stone-50 border border-stone-200 rounded-xl px-3 py-2 text-xs text-stone-800 font-sans focus:outline-none focus:border-amber-500"
              />
              <button
                type="button"
                onClick={handleTestMemoryRecall}
                disabled={testingQuery || !queryInput.trim()}
                className="px-3.5 py-2 bg-stone-900 hover:bg-stone-800 text-white font-sans font-bold text-xs rounded-xl transition-all disabled:opacity-50 cursor-pointer shrink-0 flex items-center gap-1.5 shadow-2xs"
              >
                {testingQuery ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5 text-amber-400" />}
                <span>Recall Memory</span>
              </button>
            </div>

            {testResult && (
              <div className="p-3 bg-stone-50 rounded-xl border border-stone-200 space-y-2">
                <div className="flex items-center justify-between text-xs font-mono text-stone-600 border-b border-stone-200 pb-1.5">
                  <span>Found {testResult.count || 0} matching memory fragment(s)</span>
                  <span className="text-emerald-700 font-bold">
                    Injected Tokens: ~{testResult.efficiency?.injectedMemoryTokens || 45} tok
                  </span>
                </div>
                {testResult.memories && testResult.memories.length > 0 ? (
                  <div className="space-y-1.5">
                    {testResult.memories.map((m: any, idx: number) => (
                      <div key={idx} className="p-2.5 bg-white rounded-lg border border-stone-200/80 text-xs font-mono text-stone-800">
                        <span className="text-[10px] text-amber-700 font-bold block mb-0.5">
                          Author: {m.author} • {new Date(m.timestamp).toLocaleTimeString()}
                        </span>
                        <span className="font-sans text-stone-700">{m.text}</span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="text-xs text-stone-500 italic py-1">No matching memory items found.</div>
                )}
              </div>
            )}
          </div>

        </div>
      )}

      {/* TAB 2: CONTEXT COMPACTION FUNNEL */}
      {activeTab === "compaction" && (
        <div className="space-y-4 font-sans">
          <div className="bg-white border border-stone-200/90 rounded-2xl p-5 space-y-4 shadow-2xs">
            <div className="flex items-center justify-between border-b border-stone-100 pb-3">
              <span className="text-xs font-bold text-sky-800 font-mono flex items-center gap-1.5">
                <Layers className="w-4 h-4 text-sky-600" />
                Live Context Compaction Pipeline
              </span>
              <span className="text-xs font-mono font-bold text-emerald-800 bg-emerald-50 border border-emerald-200 px-2.5 py-0.5 rounded-full">
                ⚡ {compactionRatio}% Compression
              </span>
            </div>

            <p className="text-xs text-stone-600 leading-relaxed">
              Instead of streaming raw speech history into expensive reasoning sub-agents on every 15-second tick, the <b>Live Summarizer</b> continuously compacts spoken dialogue into dense, structured markdown bullet points.
            </p>

            {/* Visual Funnel Comparison */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-1">
              
              {/* Raw Speech Input */}
              <div className="p-4 bg-stone-50 rounded-2xl border border-stone-200/80 space-y-2">
                <div className="flex items-center justify-between text-xs font-mono text-stone-600 border-b border-stone-200 pb-1.5">
                  <span>1. Raw Speech Stream (Noisy)</span>
                  <span className="text-amber-700 font-bold">{rawTokens} tokens</span>
                </div>
                <div className="text-xs font-sans text-stone-700 leading-relaxed bg-white p-3 rounded-xl border border-stone-200/80">
                  {rawTranscript || "Today was super busy. We talked about building the new token counter and integrating Vertex AI Memory Bank. Alice said she will prepare the slide deck, and Bob mentioned reviewing backend API performance..."}
                </div>
              </div>

              {/* Compacted Output */}
              <div className="p-4 bg-sky-50/40 rounded-2xl border border-sky-200 space-y-2">
                <div className="flex items-center justify-between text-xs font-mono text-stone-600 border-b border-sky-200 pb-1.5">
                  <span>2. Compacted Working State</span>
                  <span className="text-sky-700 font-bold">{summaryTokens} tokens</span>
                </div>
                <div className="text-xs font-sans text-stone-800 leading-relaxed bg-white p-3 rounded-xl border border-sky-100">
                  {liveSummary || "• Token Counter & Vertex AI Memory Bank integration underway\n• Alice to prepare roadmap slide deck\n• Bob reviewing backend API performance"}
                </div>
              </div>

            </div>

            {/* Engineering Takeaway */}
            <div className="p-3.5 bg-sky-50 rounded-xl border border-sky-200 text-xs text-sky-900 space-y-1">
              <div className="font-bold flex items-center gap-1.5">
                <ShieldCheck className="w-4 h-4 text-sky-600" />
                Engineering Principle: State-Driven Multi-Agent Design
              </div>
              <p className="text-xs text-stone-600 leading-relaxed">
                Downstream sub-agents (e.g. <code className="text-stone-800 font-mono">intentClassifier</code>) receive the compacted state with <code className="text-stone-800 font-mono">includeContents: 'none'</code>, eliminating quadratic context growth.
              </p>
            </div>

          </div>
        </div>
      )}

      {/* TAB 3: AGENT PIPELINE BREAKDOWN */}
      {activeTab === "subagents" && (
        <div className="space-y-4 font-sans">
          <div className="bg-white border border-stone-200/90 rounded-2xl p-5 space-y-4 shadow-2xs">
            <div className="flex items-center justify-between border-b border-stone-100 pb-3">
              <span className="text-xs font-bold text-purple-800 font-mono flex items-center gap-1.5">
                <Cpu className="w-4 h-4 text-purple-600" />
                Sub-Agent Token & Execution Breakdown
              </span>
              <span className="text-[10px] font-mono text-stone-500">
                ADK Ephemeral Runner Pipeline
              </span>
            </div>

            <div className="space-y-3">
              
              {/* Proofreader */}
              <div className="p-4 bg-stone-50 rounded-xl border border-stone-200/80 flex items-center justify-between">
                <div className="space-y-0.5">
                  <div className="text-xs font-sans font-bold text-stone-800">1. Proofreader Sub-Agent</div>
                  <div className="text-xs text-stone-500">Fast word confidence scoring & acoustic phonetic fixes</div>
                </div>
                <div className="text-right font-mono">
                  <div className="text-xs font-bold text-amber-700">~120 tokens</div>
                  <div className="text-[10px] text-stone-400">Latency: 0.25s</div>
                </div>
              </div>

              {/* Live Summarizer */}
              <div className="p-4 bg-stone-50 rounded-xl border border-stone-200/80 flex items-center justify-between">
                <div className="space-y-0.5">
                  <div className="text-xs font-sans font-bold text-stone-800">2. Live Summarizer (Compaction)</div>
                  <div className="text-xs text-stone-500">Rolling markdown synthesis & context compaction</div>
                </div>
                <div className="text-right font-mono">
                  <div className="text-xs font-bold text-sky-700">~{summaryTokens + 180} tokens</div>
                  <div className="text-[10px] text-stone-400">Latency: 0.45s</div>
                </div>
              </div>

              {/* Intent Classifier */}
              <div className="p-4 bg-stone-50 rounded-xl border border-stone-200/80 flex items-center justify-between">
                <div className="space-y-0.5">
                  <div className="text-xs font-sans font-bold text-stone-800">3. Intent Classifier & Resolver</div>
                  <div className="text-xs text-stone-500">Extracts calendar events, tasks, search queries with speaker attribution</div>
                </div>
                <div className="text-right font-mono">
                  <div className="text-xs font-bold text-purple-700">~380 tokens</div>
                  <div className="text-[10px] text-stone-400">Latency: 0.60s</div>
                </div>
              </div>

            </div>
          </div>
        </div>
      )}

    </div>
  );
}
