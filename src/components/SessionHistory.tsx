import { StreamRun } from "../types";
import { Brain, FileText, Calendar, CheckSquare, ChevronRight } from "lucide-react";

interface SessionHistoryProps {
  runs: StreamRun[];
  selectedRunId: string | null;
  onSelectRun: (id: string) => void;
}

export default function SessionHistory({
  runs,
  selectedRunId,
  onSelectRun
}: SessionHistoryProps) {
  
  const formatDate = (isoStr: string) => {
    const d = new Date(isoStr);
    return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  };

  return (
    <div id="session-history-panel" className="bg-white border border-stone-200 rounded-2xl p-5 shadow-sm space-y-4">
      <div className="flex items-center justify-between pb-3 border-b border-stone-100">
        <h3 className="text-sm font-bold text-stone-800 flex items-center gap-2">
          <Brain className="w-4 h-4 text-amber-600" />
          Brain Dump Archive
        </h3>
        <span className="text-[10px] font-mono bg-stone-100 text-stone-500 border border-stone-200 px-2 py-0.5 rounded-full font-bold">
          {runs.length} Sessions
        </span>
      </div>

      {runs.length === 0 ? (
        <div className="text-center py-6 text-xs text-stone-400 italic">
          No previous sessions saved. Try speaking or typing your first thoughts!
        </div>
      ) : (
        <div className="space-y-2.5 max-h-[300px] overflow-y-auto pr-1">
          {runs.map((run) => {
            const isSelected = run.id === selectedRunId;

            return (
              <button
                key={run.id}
                onClick={() => onSelectRun(run.id)}
                className={`w-full text-left p-3.5 rounded-xl border transition-all flex items-start gap-3 ${
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
                      <span className="bg-amber-500/10 text-amber-800 font-sans px-1.5 py-0.2 rounded text-[9.5px] font-extrabold flex items-center gap-0.5 border border-amber-200/20">
                        TOPIC: {run.analysis.organizedFolder}
                      </span>
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
          })}
        </div>
      )}
    </div>
  );
}
