import { useState } from "react";
import { StreamRun, CalendarEvent, TaskItem, SearchQueryItem } from "../types";
import { 
  Calendar, CheckSquare, Search, FolderPlus, FileText, Check, 
  ExternalLink, Play, Sparkles, AlertCircle, RefreshCw 
} from "lucide-react";

interface ActiveSessionProps {
  run: StreamRun | null;
  token: string | null;
  onExecuteCalendar: (index: number) => Promise<void>;
  onExecuteTask: (index: number) => Promise<void>;
  onExecuteSearch: (index: number) => Promise<void>;
  onExecuteDrive: () => Promise<void>;
  onUpdateCalendar: (index: number, updated: CalendarEvent) => void;
  onUpdateTask: (index: number, updated: TaskItem) => void;
  isLiveAnalyzing?: boolean;
}

function BulletinsRenderer({ text }: { text: string }) {
  if (!text) return null;
  const lines = text.split("\n");
  return (
    <ul className="list-disc pl-5 space-y-1.5 text-stone-600 font-sans text-xs">
      {lines.map((line, idx) => {
        const cleaned = line.replace(/^[\s*\-•+]+/, "").trim();
        if (!cleaned) return null;

        const parts = cleaned.split(/(\*\*.*?\*\*)/g);
        return (
          <li key={idx} className="leading-relaxed">
            {parts.map((part, pIdx) => {
              if (part.startsWith("**") && part.endsWith("**")) {
                return (
                  <strong key={pIdx} className="font-semibold text-stone-800">
                    {part.slice(2, -2)}
                  </strong>
                );
              }
              return part.replace(/\*\*/g, "");
            })}
          </li>
        );
      })}
    </ul>
  );
}

export default function ActiveSession({
  run,
  token,
  onExecuteCalendar,
  onExecuteTask,
  onExecuteSearch,
  onExecuteDrive,
  onUpdateCalendar,
  onUpdateTask,
  isLiveAnalyzing = false
}: ActiveSessionProps) {
  const [executingCal, setExecutingCal] = useState<number | null>(null);
  const [executingTask, setExecutingTask] = useState<number | null>(null);
  const [executingSearch, setExecutingSearch] = useState<number | null>(null);
  const [executingDrive, setExecutingDrive] = useState(false);

  const analysis = run?.analysis;
  
  if (run && !analysis && run.id !== "live-draft") {
    return (
      <div className="bg-white border border-stone-200 rounded-2xl p-8 text-center shadow-sm">
        <Sparkles className="w-8 h-8 mx-auto text-stone-300 animate-pulse mb-3" />
        <h3 className="text-sm font-semibold text-stone-700">Analysing Stream of Consciousness...</h3>
        <p className="text-xs text-stone-400 mt-1 max-w-sm mx-auto">Gemini is structuring your thoughts, detecting appointments, and aligning action folders.</p>
      </div>
    );
  }

  const handleCalClick = async (idx: number, event: CalendarEvent) => {
    const confirmed = window.confirm(
      `Confirm Action: Double-check schedule details.\n\nEvent: ${event.title}\nStarts: ${new Date(event.start).toLocaleString()}\nEnds: ${new Date(event.end).toLocaleString()}\n\nDo you want to confirm and schedule this event on Google Calendar?`
    );
    if (!confirmed) return;

    setExecutingCal(idx);
    try {
      await onExecuteCalendar(idx);
    } finally {
      setExecutingCal(null);
    }
  };

  const handleTaskClick = async (idx: number, task: TaskItem) => {
    const confirmed = window.confirm(
      `Confirm Action: Log to-do task.\n\nTask: ${task.title}\nNotes: ${task.notes || "None"}\n\nDo you want to push this to Google Tasks?`
    );
    if (!confirmed) return;

    setExecutingTask(idx);
    try {
      await onExecuteTask(idx);
    } finally {
      setExecutingTask(null);
    }
  };

  const handleSearchClick = async (idx: number, qi: SearchQueryItem) => {
    setExecutingSearch(idx);
    try {
      await onExecuteSearch(idx);
    } finally {
      setExecutingSearch(null);
    }
  };

  const handleDriveClick = async () => {
    const confirmed = window.confirm(
      `Confirm Action: Organise Files into Drive Folder.\n\nFolder: "${analysis?.organizedFolder || "Stream Summary"}"\n\nThis will write structured meeting reports and markdown brainstorm bullet files directly into organized subfolders. Proceed?`
    );
    if (!confirmed) return;

    setExecutingDrive(true);
    try {
      await onExecuteDrive();
    } finally {
      setExecutingDrive(false);
    }
  };

  // Helper formats UTC or ISO relative times cleanly
  const formatTimeRange = (startStr: string, endStr: string) => {
    try {
      const start = new Date(startStr);
      const end = new Date(endStr);
      if (isNaN(start.getTime()) || isNaN(end.getTime())) {
        return "Indeterminate schedule";
      }
      return `${start.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })} at ${start.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} – ${end.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    } catch {
      return "Indeterminate schedule";
    }
  };

  const toDatetimeLocalString = (isoString: string): string => {
    if (!isoString) return "";
    try {
      const date = new Date(isoString);
      if (isNaN(date.getTime())) return "";
      const offset = date.getTimezoneOffset();
      const localDate = new Date(date.getTime() - offset * 60 * 1000);
      return localDate.toISOString().slice(0, 16);
    } catch {
      return "";
    }
  };

  return (
    <div id="active-session-panel" className="space-y-6">
      
      {isLiveAnalyzing && (
        <div className="flex items-center justify-center gap-2 py-2 px-4 bg-amber-50 border border-amber-200/50 text-amber-800 text-xs font-semibold rounded-2xl animate-pulse shadow-sm max-w-xs mx-auto">
          <RefreshCw className="w-3.5 h-3.5 animate-spin text-amber-500" />
          <span>Analyzing your thoughts live...</span>
        </div>
      )}
      
      {/* Google Drive Export Compilation banner */}
      <div className="bg-white border border-stone-200 rounded-2xl p-5 shadow-sm flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 border-l-4 border-l-amber-500">
        <div className="flex items-start gap-3">
          <div className="p-2.5 bg-amber-50 rounded-xl text-amber-600 border border-amber-100">
            <FolderPlus className="w-5 h-5" />
          </div>
          <div className="space-y-1">
            <h4 className="text-sm font-bold text-stone-800 font-sans">Compile Documents to Google Drive</h4>
            <p className="text-[11px] text-stone-500 font-sans leading-normal">
              Bundle summary notes, structured insights, and action items inside folder: <span className="font-mono font-semibold bg-stone-100 px-1.5 py-0.5 rounded text-amber-700">{analysis?.organizedFolder || "No active folder"}</span>
            </p>
          </div>
        </div>
        <button
          onClick={handleDriveClick}
          disabled={executingDrive || !analysis}
          className="w-full sm:w-auto px-5 py-2 text-xs font-bold text-white bg-stone-900 hover:bg-stone-800 disabled:bg-stone-200 disabled:text-stone-400 rounded-lg transition-all flex items-center justify-center gap-1.5 shadow-sm border border-stone-950 cursor-pointer shrink-0"
        >
          {executingDrive ? (
            <>
              <RefreshCw className="w-3.5 h-3.5 animate-spin" /> Compiling Folder...
            </>
          ) : (
            <>
              <FolderPlus className="w-3.5 h-3.5" /> Organize Drive Folder
            </>
          )}
        </button>
      </div>

      {/* Grid of parsed actions */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        
        {/* General Summary / Bulletin */}
        <div className="bg-white border border-stone-200 rounded-2xl p-5 shadow-sm space-y-4">
          <h3 className="text-sm font-bold text-stone-800 flex items-center gap-2 border-b border-stone-100 pb-3">
            <FileText className="w-4 h-4 text-amber-600" />
            Bulletins &amp; General Ideas
          </h3>
          <div className="prose prose-sm text-stone-600 leading-relaxed text-sm font-sans max-h-[300px] overflow-y-auto pr-1">
            {analysis ? (
              <BulletinsRenderer text={analysis.summary} />
            ) : (
              <p className="text-xs text-stone-400 italic py-2 leading-relaxed">No bulletin ideas generated yet. Speak or type your thoughts to see summarized ideas.</p>
            )}
          </div>
        </div>

        {/* Web query searches */}
        <div className="bg-white border border-stone-200 rounded-2xl p-5 shadow-sm space-y-4">
          <h3 className="text-sm font-bold text-stone-800 flex items-center gap-2 border-b border-stone-100 pb-3">
            <Search className="w-4 h-4 text-blue-600" />
            Real-time Info Queries
          </h3>
          
          {!analysis ? (
            <p className="text-xs text-stone-400 italic py-2 leading-relaxed">No search queries identified yet. Ask questions in your thoughts (e.g. &ldquo;I wonder who designed the Concorde&rdquo;) to trigger research actions.</p>
          ) : analysis.searchQueries.length === 0 ? (
            <p className="text-xs text-stone-400 italic py-2">No search topics identified in this stream.</p>
          ) : (
            <div className="space-y-4 max-h-[300px] overflow-y-auto pr-1">
              {analysis.searchQueries.map((item, idx) => (
                <div key={idx} className="border border-stone-100 rounded-xl p-4 bg-stone-50/50 space-y-2.5">
                  <div className="flex items-start justify-between gap-3">
                    <p className="text-xs font-semibold text-stone-700 italic font-sans">
                      &ldquo;{item.query}&rdquo;
                    </p>
                    {item.status === 'pending' && (
                      <button
                        onClick={() => handleSearchClick(idx, item)}
                        disabled={executingSearch !== null}
                        className="text-[11px] font-semibold text-blue-600 hover:text-blue-800 bg-blue-50 border border-blue-200 px-2.5 py-1 rounded-md shrink-0 flex items-center gap-1"
                      >
                        {executingSearch === idx ? (
                          <RefreshCw className="w-3 h-3 animate-spin" />
                        ) : (
                          <Play className="w-2.5 h-2.5" />
                        )}
                        Research
                      </button>
                    )}
                  </div>

                  {item.status === 'completed' && item.answer && (
                    <div className="text-xs text-stone-600 leading-relaxed bg-white border border-stone-100 p-3 rounded-lg font-sans">
                      <p className="mb-2 font-normal">{item.answer}</p>
                      {item.sources && item.sources.length > 0 && (
                        <div className="pt-2 border-t border-stone-50">
                          <p className="text-[9px] font-bold text-stone-400 uppercase tracking-wider mb-1.5 font-mono">Sources:</p>
                          <div className="flex flex-wrap gap-1.5">
                            {item.sources.map((src, sIdx) => (
                              <a
                                key={sIdx}
                                href={src.uri}
                                target="_blank"
                                rel="noreferrer"
                                className="text-[10px] text-blue-600 hover:underline bg-stone-50 border border-stone-200/50 px-2 py-0.5 rounded flex items-center gap-0.5"
                              >
                                {src.title} <ExternalLink className="w-2.5 h-2.5" />
                              </a>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  )}

                  {item.status === 'failed' && (
                    <div className="text-xs text-red-600 bg-red-50 border border-red-100 p-2.5 rounded-lg flex items-center gap-1.5">
                      <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                      <span>Search failed: {item.error}</span>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">

        {/* Schedule Calendar appointments */}
        <div className="bg-white border border-stone-200 rounded-2xl p-5 shadow-sm space-y-4">
          <h3 className="text-sm font-bold text-stone-800 flex items-center gap-2 border-b border-stone-100 pb-3">
            <Calendar className="w-4 h-4 text-emerald-600" />
            Detected Calendar Schedules
          </h3>

          {!analysis ? (
            <p className="text-xs text-stone-400 italic py-2 leading-relaxed">No calendar events scheduled yet. Say things like &ldquo;Let's meet tomorrow at 3pm&rdquo; to suggest calendar actions.</p>
          ) : analysis.calendarEvents.length === 0 ? (
            <p className="text-xs text-stone-400 italic py-2">No calendar matches found in this stream of thoughts.</p>
          ) : (
            <div className="space-y-3.5 max-h-[350px] overflow-y-auto pr-1">
              {analysis.calendarEvents.map((item, idx) => {
                const isUncertain = !!item.uncertain;
                return (
                  <div key={idx} className={`border rounded-xl p-4 transition-all ${
                    isUncertain
                      ? 'opacity-65 border-dashed border-amber-300 bg-amber-50/5'
                      : item.status === 'scheduled'
                        ? 'border-emerald-100 bg-emerald-50/20'
                        : 'border-stone-150 bg-white'
                  }`}>
                    <div className="flex items-start justify-between gap-3">
                      <div className="space-y-1.5 flex-1 min-w-0">
                        {isUncertain && (
                          <span className="inline-block text-[9px] font-bold text-amber-700 bg-amber-100 border border-amber-250/30 px-1.5 py-0.2 rounded-full uppercase tracking-wider mb-1 font-mono">
                            Uncertain Draft
                          </span>
                        )}
                        <input
                          type="text"
                          value={item.title}
                          onChange={(e) => onUpdateCalendar(idx, { ...item, title: e.target.value })}
                          className="text-xs font-bold text-stone-850 font-sans bg-transparent border-b border-transparent hover:border-stone-200 focus:border-amber-500 outline-none w-full py-0.5"
                          placeholder="Configure title..."
                        />
                        <input
                          type="text"
                          value={item.description}
                          onChange={(e) => onUpdateCalendar(idx, { ...item, description: e.target.value })}
                          className="text-[11px] text-stone-500 font-sans bg-transparent border-b border-transparent hover:border-stone-200 focus:border-amber-500 outline-none w-full py-0.5"
                          placeholder="Configure description..."
                        />
                        
                        <div className="grid grid-cols-2 gap-2 text-[10px] font-sans pt-1 w-full">
                          <input
                            type="datetime-local"
                            value={toDatetimeLocalString(item.start)}
                            onChange={(e) => {
                              try {
                                const iso = e.target.value ? new Date(e.target.value).toISOString() : "";
                                onUpdateCalendar(idx, { ...item, start: iso });
                              } catch {}
                            }}
                            className="bg-stone-50 hover:bg-stone-100 border border-stone-200 rounded px-1.5 py-1 focus:border-amber-500 focus:bg-white outline-none font-mono text-[10px] text-stone-600 w-full min-w-0"
                          />
                          <input
                            type="datetime-local"
                            value={toDatetimeLocalString(item.end)}
                            onChange={(e) => {
                              try {
                                const iso = e.target.value ? new Date(e.target.value).toISOString() : "";
                                onUpdateCalendar(idx, { ...item, end: iso });
                              } catch {}
                            }}
                            className="bg-stone-50 hover:bg-stone-100 border border-stone-200 rounded px-1.5 py-1 focus:border-amber-500 focus:bg-white outline-none font-mono text-[10px] text-stone-600 w-full min-w-0"
                          />
                        </div>
                      </div>

                    <div className="shrink-0">
                      {item.status === 'scheduled' ? (
                        <span className="text-[11px] font-bold text-emerald-700 bg-emerald-100/50 border border-emerald-200 align-center px-2.5 py-1 rounded-md flex items-center gap-1">
                          <Check className="w-3.5 h-3.5" /> Hooked
                        </span>
                      ) : (
                        <button
                          onClick={() => handleCalClick(idx, item)}
                          disabled={executingCal !== null}
                          className="text-[11px] font-bold text-stone-700 hover:text-stone-900 bg-stone-50 hover:bg-stone-100 border border-stone-300 rounded-md px-2.5 py-1 flex items-center gap-1.5"
                        >
                          {executingCal === idx ? (
                            <RefreshCw className="w-3 h-3 animate-spin" />
                          ) : (
                            <Calendar className="w-3.5 h-3.5 text-stone-500" />
                          )}
                          Configure
                        </button>
                      )}
                    </div>
                  </div>

                  {item.status === 'failed' && (
                    <p className="text-[10px] text-red-600 bg-red-50 p-2 rounded mt-2 flex items-center gap-1">
                      <AlertCircle className="w-3.5 h-3.5" /> Integration issue: {item.error}
                    </p>
                  )}
                </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Actionable Tasks to Google Tasks */}
        <div className="bg-white border border-stone-200 rounded-2xl p-5 shadow-sm space-y-4">
          <h3 className="text-sm font-bold text-stone-800 flex items-center gap-2 border-b border-stone-100 pb-3">
            <CheckSquare className="w-4 h-4 text-purple-600" />
            Identified Actions &amp; To-Dos
          </h3>

          {!analysis ? (
            <p className="text-xs text-stone-400 italic py-2 leading-relaxed">No checklist actions logged yet. State tasks in your thoughts (e.g. &ldquo;Draft mock schema beforehand&rdquo;) to see todo suggestions.</p>
          ) : analysis.tasks.length === 0 ? (
            <p className="text-xs text-stone-400 italic py-2">No checklist elements identified.</p>
          ) : (
            <div className="space-y-3 max-h-[350px] overflow-y-auto pr-1">
              {analysis.tasks.map((item, idx) => {
                const isUncertain = !!item.uncertain;
                return (
                  <div key={idx} className={`border rounded-xl p-4 transition-all ${
                    isUncertain
                      ? 'opacity-65 border-dashed border-purple-300 bg-purple-50/5'
                      : item.status === 'created'
                        ? 'border-purple-100 bg-purple-50/10'
                        : 'border-stone-150 bg-white'
                  }`}>
                    <div className="flex items-start justify-between gap-3">
                      <div className="space-y-1.5 flex-1 min-w-0">
                        {isUncertain && (
                          <span className="inline-block text-[9px] font-bold text-purple-700 bg-purple-100 border border-purple-200/50 px-1.5 py-0.2 rounded-full uppercase tracking-wider mb-1 font-mono">
                            Uncertain To-Do
                          </span>
                        )}
                        <input
                          type="text"
                          value={item.title}
                          onChange={(e) => onUpdateTask(idx, { ...item, title: e.target.value })}
                          className="text-xs font-bold text-stone-850 font-sans bg-transparent border-b border-transparent hover:border-stone-200 focus:border-purple-500 outline-none w-full py-0.5"
                          placeholder="Configure task..."
                        />
                        <input
                          type="text"
                          value={item.notes}
                          onChange={(e) => onUpdateTask(idx, { ...item, notes: e.target.value })}
                          className="text-[11px] text-stone-500 font-sans bg-transparent border-b border-transparent hover:border-stone-200 focus:border-purple-500 outline-none w-full py-0.5"
                          placeholder="Add notes..."
                        />
                      </div>

                    <div className="shrink-0">
                      {item.status === 'created' ? (
                        <span className="text-[11px] font-bold text-purple-700 bg-purple-100/30 border border-purple-200/50 align-center px-2.5 py-1 rounded-md flex items-center gap-1">
                          <Check className="w-3.5 h-3.5" /> Logged
                        </span>
                      ) : (
                        <button
                          onClick={() => handleTaskClick(idx, item)}
                          disabled={executingTask !== null}
                          className="text-[11px] font-bold text-stone-700 hover:text-stone-900 bg-stone-50 hover:bg-stone-100 border border-stone-300 rounded-md px-2.5 py-1 flex items-center gap-1.5"
                        >
                          {executingTask === idx ? (
                            <RefreshCw className="w-3 h-3 animate-spin" />
                          ) : (
                            <CheckSquare className="w-3.5 h-3.5 text-stone-500" />
                          )}
                          Log To-Do
                        </button>
                      )}
                    </div>
                  </div>

                  {item.status === 'failed' && (
                    <p className="text-[10px] text-red-600 bg-red-50 p-2 rounded mt-2 flex items-center gap-1">
                      <AlertCircle className="w-3.5 h-3.5" /> Integration issue: {item.error}
                    </p>
                  )}
                </div>
                );
              })}
            </div>
          )}
        </div>

      </div>

    </div>
  );
}
