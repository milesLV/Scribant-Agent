import { useState } from "react";
import { StreamRun } from "../types";
import { Brain, FileText, Calendar, CheckSquare, ChevronRight, Search, Sparkles, RefreshCw } from "lucide-react";
import { Panel } from "./ActiveSession";

interface SessionHistoryProps {
  runs: StreamRun[];
  selectedRunId: string | null;
  onSelectRun: (id: string) => void;
}

interface MemoryResult {
  text: string;
  author: string;
  timestamp: string;
}

// App only renders this component when runs.length > 0 (see App.tsx), so there is no empty state
// to handle here — one place shows "no sessions yet", not two with different copy.
export default function SessionHistory({
  runs,
  selectedRunId,
  onSelectRun
}: SessionHistoryProps) {
  const [searchQuery, setSearchQuery] = useState("");
  const [isSearchingMemory, setIsSearchingMemory] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [syncStatus, setSyncStatus] = useState<string | null>(null);
  const [memoryAnswer, setMemoryAnswer] = useState<string | null>(null);
  const [memoryResults, setMemoryResults] = useState<MemoryResult[] | null>(null);

  const formatDate = (isoStr: string) =>
    new Date(isoStr).toLocaleString([], { dateStyle: "short", timeStyle: "short" });

  const handleSearchMemoryBank = async () => {
    const q = searchQuery.trim();
    if (!q) {
      setMemoryResults(null);
      setMemoryAnswer(null);
      return;
    }
    setIsSearchingMemory(true);
    try {
      const res = await fetch("/api/memory/retrieve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: q }),
      });
      if (res.ok) {
        const data = await res.json();
        setMemoryResults(data.memories || []);
        setMemoryAnswer(data.answer || null);
      }
    } catch (e) {
      console.warn("Memory bank search failed:", e);
    } finally {
      setIsSearchingMemory(false);
    }
  };

  const handleSyncMemoryBank = async () => {
    setIsSyncing(true);
    setSyncStatus(null);
    try {
      const res = await fetch("/api/memory/sync", { method: "POST" });
      if (res.ok) {
        const data = await res.json();
        setSyncStatus(`Synced ${data.syncedCount ?? 0} session(s)`);
        setTimeout(() => setSyncStatus(null), 4000);
      }
    } catch (e) {
      console.warn("Memory bank sync failed:", e);
      setSyncStatus("Sync failed");
      setTimeout(() => setSyncStatus(null), 4000);
    } finally {
      setIsSyncing(false);
    }
  };

  const filteredRuns = searchQuery.trim()
    ? runs.filter(r => r.rawText.toLowerCase().includes(searchQuery.toLowerCase()) || r.analysis?.summary?.toLowerCase().includes(searchQuery.toLowerCase()))
    : runs;

  return (
    <div id="session-history-panel">
      <Panel
        icon={Brain}
        iconClass="text-amber-600"
        title="Memory Bank &amp; Archive"
        action={
          <div className="flex items-center gap-2">
            {syncStatus && (
              <span className="text-[10px] font-mono text-emerald-600 bg-emerald-50 border border-emerald-200 px-2 py-0.5 rounded-full font-bold">
                {syncStatus}
              </span>
            )}
            <button
              type="button"
              onClick={handleSyncMemoryBank}
              disabled={isSyncing}
              title="Sync local captures to Memory Bank"
              className="text-[10px] font-mono bg-stone-100 hover:bg-stone-200 text-stone-600 border border-stone-200 px-2 py-0.5 rounded-full font-bold flex items-center gap-1 transition-colors disabled:opacity-50 cursor-pointer"
            >
              <RefreshCw className={`w-2.5 h-2.5 ${isSyncing ? "animate-spin text-amber-600" : ""}`} />
              Sync Bank
            </button>
            <span className="text-[10px] font-mono bg-stone-100 text-stone-500 border border-stone-200 px-2 py-0.5 rounded-full font-bold">
              {runs.length} Sessions
            </span>
          </div>
        }
      >
        <div className="space-y-3">
          {/* Search bar for local history & Memory Bank */}
          <div className="flex items-center gap-1.5">
            <div className="relative flex-1">
              <Search className="w-3.5 h-3.5 text-stone-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => {
                  setSearchQuery(e.target.value);
                  if (!e.target.value.trim()) {
                    setMemoryResults(null);
                    setMemoryAnswer(null);
                  }
                }}
                onKeyDown={(e) => { if (e.key === "Enter") handleSearchMemoryBank(); }}
                placeholder="Ask or search past memories (e.g. What is my name?)..."
                className="w-full text-xs bg-stone-50 border border-stone-200 focus:bg-white rounded-lg pl-8 pr-3 py-1.5 outline-none focus:ring-1 focus:ring-amber-500/20 text-stone-700 font-sans"
              />
            </div>
            <button
              type="button"
              onClick={handleSearchMemoryBank}
              disabled={isSearchingMemory || !searchQuery.trim()}
              title="Search Vertex AI Memory Bank"
              className="text-[11px] font-semibold text-stone-700 hover:text-amber-800 bg-stone-100 hover:bg-stone-200/80 border border-stone-200 rounded-lg px-2.5 py-1.5 flex items-center gap-1 shrink-0 disabled:opacity-40 transition-colors cursor-pointer"
            >
              {isSearchingMemory ? (
                <RefreshCw className="w-3 h-3 animate-spin text-amber-600" />
              ) : (
                <Sparkles className="w-3 h-3 text-amber-600" />
              )}
              Query Bank
            </button>
          </div>

          {/* Memory Bank Results */}
          {(memoryResults !== null || memoryAnswer !== null) && (
            <div className="p-3.5 bg-amber-50/50 border border-amber-200/70 rounded-xl space-y-2.5">
              <div className="flex items-center justify-between text-[10.5px] font-mono text-amber-800 font-bold">
                <span className="flex items-center gap-1.5">
                  <Sparkles className="w-3.5 h-3.5 text-amber-600" /> Vertex AI Memory Bank Response
                </span>
                <button
                  type="button"
                  onClick={() => {
                    setMemoryResults(null);
                    setMemoryAnswer(null);
                  }}
                  className="text-stone-400 hover:text-stone-600 font-sans text-xs cursor-pointer"
                >
                  Clear
                </button>
              </div>

              {/* Direct AI Answer synthesized from memories */}
              {memoryAnswer && (
                <div className="p-3 bg-white/90 border border-amber-300/80 rounded-lg shadow-2xs space-y-1">
                  <p className="text-[10px] font-mono font-bold text-amber-700 uppercase tracking-wide">Direct Answer</p>
                  <p className="text-xs text-stone-800 font-sans font-medium leading-relaxed">
                    {memoryAnswer}
                  </p>
                </div>
              )}

              {/* Source memory snippets */}
              {memoryResults && memoryResults.length > 0 && (
                <div className="space-y-1.5 pt-1">
                  <p className="text-[10px] font-mono text-stone-500 font-bold">
                    Vertex AI Grounded Memories ({memoryResults.length})
                  </p>
                  <div className="space-y-1.5 max-h-[160px] overflow-y-auto pr-1">
                    {memoryResults.map((mem, idx) => (
                      <div key={idx} className="p-2.5 bg-white/70 rounded-lg border border-amber-100 text-xs text-stone-700 leading-relaxed font-sans">
                        <p className="font-normal whitespace-pre-wrap">{mem.text}</p>
                        <p className="text-[9.5px] text-stone-400 font-mono mt-1">{formatDate(mem.timestamp)}</p>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {memoryResults?.length === 0 && !memoryAnswer && (
                <p className="text-xs text-stone-400 italic">No matching facts or memories found in Vertex AI Memory Bank.</p>
              )}
            </div>
          )}

          {/* Local Session Runs */}
          <div className="space-y-2.5 max-h-[280px] overflow-y-auto pr-1">
            {filteredRuns.length === 0 ? (
              <p className="text-xs text-stone-400 italic text-center py-4">
                {runs.length === 0
                  ? "No active recording sessions. Use 'Query Bank' above to search your Google Cloud Vertex AI Memory Bank."
                  : "No matching sessions found."}
              </p>
            ) : (
              filteredRuns.map((run) => {
                const isSelected = run.id === selectedRunId;

                return (
                  <button
                    key={run.id}
                    onClick={() => onSelectRun(run.id)}
                    className={`w-full text-left p-3.5 rounded-xl border transition-all flex items-start gap-3 cursor-pointer ${
                      isSelected
                        ? "border-amber-500 bg-amber-50/20 shadow-sm"
                        : "border-stone-150 bg-stone-50/30 hover:bg-stone-50/80"
                    }`}
                  >
                    <div className={`mt-0.5 p-2 rounded-lg shrink-0 ${
                      isSelected ? "bg-amber-100 text-amber-700" : "bg-stone-100 text-stone-500"
                    }`}>
                      <FileText className="w-3.5 h-3.5" />
                    </div>

                    <div className="space-y-1 w-full min-w-0">
                      <div className="flex items-center justify-between gap-2">
                        <p className="text-[10.5px] font-semibold text-stone-400 font-mono tracking-tight">{formatDate(run.timestamp)}</p>
                        <ChevronRight className={`w-3.5 h-3.5 ${isSelected ? "text-amber-600" : "text-stone-300"}`} />
                      </div>

                      <p className="text-xs font-medium text-stone-700 font-sans leading-tight mt-0.5 truncate w-full">
                        {run.rawText}
                      </p>

                      {run.analysis && (
                        <div className="flex items-center gap-3 pt-2 text-[10px] font-mono text-stone-400 flex-wrap">
                          <span className="flex items-center gap-0.5">
                            <Calendar className="w-3 h-3 text-stone-300" /> {run.analysis.calendarEvents.length} APPOINTMENTS
                          </span>
                          <span className="flex items-center gap-0.5">
                            <CheckSquare className="w-3 h-3 text-stone-300" /> {run.analysis.tasks.length} TO-DOS
                          </span>
                        </div>
                      )}
                    </div>
                  </button>
                );
              })
            )}
          </div>
        </div>
      </Panel>
    </div>
  );
}
