import { useState } from "react";
import { StreamRun, CalendarEvent, TaskItem } from "../types";
import {
  Calendar, CheckSquare, Search, FileText, Check,
  ExternalLink, Play, Sparkles, AlertCircle, RefreshCw, ChevronDown, Undo2, FolderPlus
} from "lucide-react";
import MarkdownBullets from "./MarkdownBullets";

// Completed-state chip ("Marked"/"Logged") that turns into an Undo button on hover. Undo deletes
// exactly the resource this chip's create returned the id for.
function UndoChip({ label, color, onUndo }: { label: string; color: "emerald" | "purple"; onUndo: () => Promise<void> }) {
  const palette = {
    emerald: "text-emerald-700 bg-emerald-100/50 border-emerald-200",
    purple: "text-purple-700 bg-purple-100/30 border-purple-200/50",
  }[color];
  return (
    <button
      onClick={onUndo}
      className={`group/chip text-[11px] font-bold border px-2.5 py-1 rounded-md flex items-center gap-1 transition-colors hover:text-red-700 hover:bg-red-50 hover:border-red-200 ${palette}`}
    >
      <span className="flex items-center gap-1 group-hover/chip:hidden"><Check className="w-3.5 h-3.5" /> {label}</span>
      <span className="hidden items-center gap-1 group-hover/chip:flex"><Undo2 className="w-3.5 h-3.5" /> Undo</span>
    </button>
  );
}

// Per-kind literal class strings — Tailwind only ships classes it can see in the source, so these
// can never be built by interpolating a colour name.
const TONE = {
  emerald: {
    uncertainCard: "opacity-65 border-dashed border-amber-300 bg-amber-50/5",
    uncertainBadge: "text-amber-700 bg-amber-100 border-amber-250/30",
    doneCard: "border-emerald-100 bg-emerald-50/20",
    focus: "focus:border-amber-500",
  },
  purple: {
    uncertainCard: "opacity-65 border-dashed border-purple-300 bg-purple-50/5",
    uncertainBadge: "text-purple-700 bg-purple-100 border-purple-200/50",
    doneCard: "border-purple-100 bg-purple-50/10",
    focus: "focus:border-purple-500",
  },
} as const;

// One proposed item: two editable text fields, an approve button that becomes an Undo chip once the
// item exists in Google, and whatever kind-specific controls the caller passes as children.
function ItemCard({
  tone, uncertain, uncertainLabel, badge, isDone, error, chip, button, children,
  title, onTitle, titlePlaceholder, subtitle, onSubtitle, subtitlePlaceholder,
}: {
  tone: keyof typeof TONE;
  uncertain: boolean;
  uncertainLabel: string;
  badge?: React.ReactNode;
  isDone: boolean;
  error?: string;
  chip: React.ReactNode;
  button: React.ReactNode;
  children?: React.ReactNode;
  title: string;
  onTitle: (v: string) => void;
  titlePlaceholder: string;
  subtitle: string;
  onSubtitle: (v: string) => void;
  subtitlePlaceholder: string;
}) {
  const t = TONE[tone];
  const field = `font-sans bg-transparent border-b border-transparent hover:border-stone-200 outline-none w-full py-0.5 ${t.focus}`;
  return (
    <div className={`border rounded-xl p-4 transition-all ${
      uncertain ? t.uncertainCard : isDone ? t.doneCard : "border-stone-150 bg-white"
    }`}>
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1.5 flex-1 min-w-0">
          {uncertain && (
            <span className={`inline-block text-[9px] font-bold border px-1.5 py-0.2 rounded-full uppercase tracking-wider mb-1 font-mono ${t.uncertainBadge}`}>
              {uncertainLabel}
            </span>
          )}
          {badge}
          <input
            type="text"
            value={title}
            onChange={(e) => onTitle(e.target.value)}
            placeholder={titlePlaceholder}
            className={`text-xs font-bold text-stone-850 ${field}`}
          />
          <input
            type="text"
            value={subtitle}
            onChange={(e) => onSubtitle(e.target.value)}
            placeholder={subtitlePlaceholder}
            className={`text-[11px] text-stone-500 ${field}`}
          />
          {children}
        </div>

        <div className="shrink-0">{isDone ? chip : button}</div>
      </div>

      {error && (
        <p className="text-[10px] text-red-600 bg-red-50 p-2 rounded mt-2 flex items-center gap-1">
          <AlertCircle className="w-3.5 h-3.5" /> Integration issue: {error}
        </p>
      )}
    </div>
  );
}

// The approve button, spinner-while-running.
function ActionButton({ busy, disabled, onClick, icon: Icon, label }: {
  busy: boolean; disabled: boolean; onClick: () => void; icon: typeof Calendar; label: string;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="text-[11px] font-bold text-stone-700 hover:text-stone-900 bg-stone-50 hover:bg-stone-100 border border-stone-300 rounded-md px-2.5 py-1 flex items-center gap-1.5"
    >
      {busy ? <RefreshCw className="w-3 h-3 animate-spin" /> : <Icon className="w-3.5 h-3.5 text-stone-500" />}
      {label}
    </button>
  );
}

// The card shell every panel shares — also used by SessionHistory, which is why it's exported.
export function Panel({ icon: Icon, iconClass, title, action, children }: {
  icon: typeof Calendar; iconClass: string; title: React.ReactNode; action?: React.ReactNode; children: React.ReactNode;
}) {
  return (
    <div className="bg-white border border-stone-200 rounded-2xl p-5 shadow-sm space-y-4">
      <h3 className="text-sm font-bold text-stone-800 flex items-center justify-between gap-2 border-b border-stone-100 pb-3">
        <span className="flex items-center gap-2">
          <Icon className={`w-4 h-4 ${iconClass}`} />
          {title}
        </span>
        {action}
      </h3>
      {children}
    </div>
  );
}

interface ActiveSessionProps {
  run: StreamRun | null;
  onExecuteCalendar: (index: number) => Promise<void>;
  onExecuteTask: (index: number) => Promise<void>;
  onExecuteSearch: (index: number) => Promise<void>;
  onUndoCalendar: (index: number) => Promise<void>;
  onUndoTask: (index: number) => Promise<void>;
  onUpdateCalendar: (index: number, updated: CalendarEvent) => void;
  onUpdateTask: (index: number, updated: TaskItem) => void;
  onSaveToDrive: () => void;  // saves this session's summary into its Drive folder
  savingDrive: boolean;
  isLiveAnalyzing?: boolean;
}

export default function ActiveSession({
  run,
  onExecuteCalendar,
  onExecuteTask,
  onExecuteSearch,
  onUndoCalendar,
  onUndoTask,
  onUpdateCalendar,
  onUpdateTask,
  onSaveToDrive,
  savingDrive,
  isLiveAnalyzing = false
}: ActiveSessionProps) {
  // Which row (if any) of each list is mid-write. One record instead of three parallel useStates —
  // a kind can only ever have one row executing at a time, same as before.
  const [executing, setExecuting] = useState<Record<"calendar" | "task" | "search", number | null>>({
    calendar: null, task: null, search: null,
  });

  const analysis = run?.analysis;
  
  if (run && !analysis && run.id !== "live-draft") {
    return (
      <div className="bg-white border border-stone-200 rounded-2xl p-8 text-center shadow-sm">
        <Sparkles className="w-8 h-8 mx-auto text-stone-300 animate-pulse mb-3" />
        <h3 className="text-sm font-semibold text-stone-700">Analyzing your thoughts...</h3>
        <p className="text-xs text-stone-400 mt-1 max-w-sm mx-auto">Gemini is structuring your thoughts — detecting appointments, tasks, and questions worth researching.</p>
      </div>
    );
  }

  // Spinner-on-the-clicked-row for a write: optional confirm, mark the row busy, always clear it.
  const runOnRow = async (
    kind: "calendar" | "task" | "search",
    idx: number,
    exec: () => Promise<void>,
    confirmMsg?: string,
  ) => {
    if (confirmMsg && !window.confirm(confirmMsg)) return;
    setExecuting(e => ({ ...e, [kind]: idx }));
    try {
      await exec();
    } finally {
      setExecuting(e => ({ ...e, [kind]: null }));
    }
  };

  const handleCalClick = (idx: number, event: CalendarEvent) =>
    runOnRow("calendar", idx, () => onExecuteCalendar(idx),
      `Confirm Action: Double-check schedule details.\n\nEvent: ${event.title}\nStarts: ${new Date(event.start).toLocaleString()}\nEnds: ${new Date(event.end).toLocaleString()}\n\nDo you want to confirm and schedule this event on Google Calendar?`);

  const handleTaskClick = (idx: number, task: TaskItem) =>
    runOnRow("task", idx, () => onExecuteTask(idx),
      `Confirm Action: Log to-do task.\n\nTask: ${task.title}\nNotes: ${task.notes || "None"}\n\nDo you want to push this to Google Tasks?`);

  const handleSearchClick = (idx: number) =>
    runOnRow("search", idx, () => onExecuteSearch(idx));

  const toDatetimeLocalString = (isoString: string): string => {
    const d = new Date(isoString);
    if (!isoString || isNaN(d.getTime())) return "";
    return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
  };

  return (
    <div id="active-session-panel" className="space-y-6">
      
      {isLiveAnalyzing && (
        <div className="flex items-center justify-center gap-2 py-2 px-4 bg-amber-50 border border-amber-200/50 text-amber-800 text-xs font-semibold rounded-2xl animate-pulse shadow-sm max-w-xs mx-auto">
          <RefreshCw className="w-3.5 h-3.5 animate-spin text-amber-500" />
          <span>Analyzing your thoughts live...</span>
        </div>
      )}
      
      {/* Grid of parsed actions */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        
        {/* General Summary / Bulletin */}
        <Panel
          icon={FileText}
          iconClass="text-amber-600"
          title={<>Bulletins &amp; General Ideas</>}
          action={
            <button
              type="button"
              onClick={onSaveToDrive}
              disabled={savingDrive || !analysis?.summary?.trim()}
              title="Save this summary to a Google Drive folder for the session"
              className="text-[11px] font-semibold text-stone-600 hover:text-amber-700 bg-stone-50 hover:bg-stone-100 border border-stone-200 rounded-md px-2 py-1 flex items-center gap-1 disabled:opacity-40 transition-colors"
            >
              {savingDrive ? (
                <RefreshCw className="w-3 h-3 animate-spin text-amber-600" />
              ) : (
                <FolderPlus className="w-3.5 h-3.5" />
              )}
              Save to Drive
            </button>
          }
        >
          <div className="prose prose-sm text-stone-600 leading-relaxed text-sm font-sans max-h-[300px] overflow-y-auto pr-1">
            {analysis ? (
              <MarkdownBullets text={analysis.summary} />
            ) : (
              <p className="text-xs text-stone-400 italic py-2 leading-relaxed">No bulletin ideas generated yet. Speak or type your thoughts to see summarized ideas.</p>
            )}
          </div>
        </Panel>

        {/* Web query searches */}
        <Panel icon={Search} iconClass="text-blue-600" title="Real-time Info Queries">
          {!analysis ? (
            <p className="text-xs text-stone-400 italic py-2 leading-relaxed">No search queries identified yet. Ask questions in your thoughts (e.g. &ldquo;I wonder who designed the Concorde&rdquo;) to trigger research actions.</p>
          ) : analysis.searchQueries.length === 0 ? (
            <p className="text-xs text-stone-400 italic py-2">No search topics identified in this stream.</p>
          ) : (
            <div className="space-y-4 max-h-[300px] overflow-y-auto pr-1">
              {analysis.searchQueries.map((item, idx) => {
                const queryLine = (
                  <p className="text-xs font-semibold text-stone-700 italic font-sans">
                    &ldquo;{item.query}&rdquo;
                  </p>
                );

                // Completed answers collapse/expand on click (native <details>); body caps at 150px and scrolls.
                if (item.status === 'completed' && item.answer) {
                  return (
                    <details key={idx} className="group border border-stone-100 rounded-xl bg-stone-50/50">
                      <summary className="flex items-start justify-between gap-3 p-4 cursor-pointer select-none list-none [&::-webkit-details-marker]:hidden">
                        <div className="min-w-0">
                          {queryLine}
                          {item.condensed && (
                            <p className="text-xs text-stone-600 leading-relaxed mt-1 font-sans font-normal">{item.condensed}</p>
                          )}
                        </div>
                        <ChevronDown className="w-3.5 h-3.5 text-stone-400 shrink-0 mt-0.5 transition-transform group-open:rotate-180" />
                      </summary>
                      <div className="px-4 pb-4">
                        <div className="text-xs text-stone-600 leading-relaxed bg-white border border-stone-100 p-3 rounded-lg font-sans max-h-[150px] overflow-y-auto">
                          <p className="mb-2 font-normal whitespace-pre-wrap">{item.answer}</p>
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
                      </div>
                    </details>
                  );
                }

                return (
                  <div key={idx} className="border border-stone-100 rounded-xl p-4 bg-stone-50/50 space-y-2.5">
                    <div className="flex items-start justify-between gap-3">
                      {queryLine}
                      {item.status === 'pending' && (
                        <button
                          onClick={() => handleSearchClick(idx)}
                          disabled={executing.search !== null}
                          className="text-[11px] font-semibold text-blue-600 hover:text-blue-800 bg-blue-50 border border-blue-200 px-2.5 py-1 rounded-md shrink-0 flex items-center gap-1"
                        >
                          {executing.search === idx ? (
                            <RefreshCw className="w-3 h-3 animate-spin" />
                          ) : (
                            <Play className="w-2.5 h-2.5" />
                          )}
                          Research
                        </button>
                      )}
                    </div>

                    {item.status === 'failed' && (
                      <div className="text-xs text-red-600 bg-red-50 border border-red-100 p-2.5 rounded-lg flex items-center gap-1.5">
                        <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                        <span>Search failed: {item.error}</span>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </Panel>

      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">

        {/* Schedule Calendar appointments */}
        <Panel icon={Calendar} iconClass="text-emerald-600" title="Detected Calendar Schedules">
          {!analysis ? (
            <p className="text-xs text-stone-400 italic py-2 leading-relaxed">No calendar events scheduled yet. Say things like &ldquo;Let's meet tomorrow at 3pm&rdquo; to suggest calendar actions.</p>
          ) : analysis.calendarEvents.length === 0 ? (
            <p className="text-xs text-stone-400 italic py-2">No calendar matches found in this stream of thoughts.</p>
          ) : (
            <div className="space-y-3.5 max-h-[350px] overflow-y-auto pr-1">
              {analysis.calendarEvents.map((item, idx) => {
                const setDate = (field: "start" | "end") => (e: React.ChangeEvent<HTMLInputElement>) => {
                  try {
                    onUpdateCalendar(idx, { ...item, [field]: e.target.value ? new Date(e.target.value).toISOString() : "" });
                  } catch {}
                };
                return (
                  <ItemCard
                    key={idx}
                    tone="emerald"
                    uncertain={!!item.uncertain}
                    uncertainLabel="Uncertain Draft"
                    badge={
                      <>
                        {item.allDay && (
                          <span className="inline-block text-[9px] font-bold text-emerald-700 bg-emerald-100 border border-emerald-200/40 px-1.5 py-0.2 rounded-full uppercase tracking-wider mb-1 ml-1 font-mono">
                            All-day
                          </span>
                        )}
                        {item.speaker && (
                          <span className="inline-block text-[9px] font-bold text-emerald-800 bg-emerald-100/70 border border-emerald-250/50 px-1.5 py-0.2 rounded-full mb-1 ml-1 font-mono">
                            Speaker: {item.speaker}
                          </span>
                        )}
                      </>
                    }
                    isDone={item.status === 'scheduled'}
                    error={item.status === 'failed' ? item.error : undefined}
                    title={item.title}
                    onTitle={v => onUpdateCalendar(idx, { ...item, title: v })}
                    titlePlaceholder="Configure title..."
                    subtitle={item.description}
                    onSubtitle={v => onUpdateCalendar(idx, { ...item, description: v })}
                    subtitlePlaceholder="Configure description..."
                    chip={<UndoChip label="Hooked" color="emerald" onUndo={() => onUndoCalendar(idx)} />}
                    button={<ActionButton busy={executing.calendar === idx} disabled={executing.calendar !== null}
                      onClick={() => handleCalClick(idx, item)} icon={Calendar} label="Add Event" />}
                  >
                    <div className="grid grid-cols-2 gap-2 text-[10px] font-sans pt-1 w-full">
                      {(["start", "end"] as const).map(field => (
                        <input
                          key={field}
                          type="datetime-local"
                          value={toDatetimeLocalString(item[field])}
                          onChange={setDate(field)}
                          className="bg-stone-50 hover:bg-stone-100 border border-stone-200 rounded px-1.5 py-1 focus:border-amber-500 focus:bg-white outline-none font-mono text-[10px] text-stone-600 w-full min-w-0"
                        />
                      ))}
                    </div>
                  </ItemCard>
                );
              })}
            </div>
          )}
        </Panel>

        {/* Actionable Tasks to Google Tasks */}
        <Panel icon={CheckSquare} iconClass="text-purple-600" title={<>Identified Actions &amp; To-Dos</>}>
          {!analysis ? (
            <p className="text-xs text-stone-400 italic py-2 leading-relaxed">No checklist actions logged yet. State tasks in your thoughts (e.g. &ldquo;Pick up groceries on the way home&rdquo;, &ldquo;Drop package off at the post office&rdquo;, &rdquo;Water plants in the garden&rdquo;) to see todo suggestions.</p>
          ) : analysis.tasks.length === 0 ? (
            <p className="text-xs text-stone-400 italic py-2">No checklist elements identified.</p>
          ) : (
            <div className="space-y-3 max-h-[350px] overflow-y-auto pr-1">
              {analysis.tasks.map((item, idx) => (
                <ItemCard
                  key={idx}
                  tone="purple"
                  uncertain={!!item.uncertain}
                  uncertainLabel="Uncertain To-Do"
                  isDone={item.status === 'created'}
                  error={item.status === 'failed' ? item.error : undefined}
                  title={item.title}
                  onTitle={v => onUpdateTask(idx, { ...item, title: v })}
                  titlePlaceholder="Configure task..."
                  subtitle={item.notes}
                  onSubtitle={v => onUpdateTask(idx, { ...item, notes: v })}
                  subtitlePlaceholder="Add notes..."
                  chip={<UndoChip label="Logged" color="purple" onUndo={() => onUndoTask(idx)} />}
                  button={<ActionButton busy={executing.task === idx} disabled={executing.task !== null}
                    onClick={() => handleTaskClick(idx, item)} icon={CheckSquare} label="Log To-Do" />}
                >
                  <div className="flex flex-wrap items-center gap-1.5 mt-1">
                    {item.assignee && (
                      <span className="text-[9px] font-bold text-purple-800 bg-purple-100 border border-purple-200/60 px-1.5 py-0.5 rounded font-mono">
                        Assignee: {item.assignee}
                      </span>
                    )}
                    {item.requestedBy && (
                      <span className="text-[9px] font-semibold text-stone-600 bg-stone-100 border border-stone-200/70 px-1.5 py-0.5 rounded font-mono">
                        Requested by: {item.requestedBy}
                      </span>
                    )}
                    {item.dueDate && (
                      <span className="text-[9px] font-bold text-purple-700 bg-purple-50 border border-purple-200/50 px-1.5 py-0.5 rounded font-mono">
                        Due {new Date(item.dueDate + "T00:00:00").toLocaleDateString()}
                      </span>
                    )}
                  </div>
                </ItemCard>
              ))}
            </div>
          )}
        </Panel>

      </div>

    </div>
  );
}
