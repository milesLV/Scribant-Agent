import { useState, useEffect, useRef } from "react";
import Header, { AppTab } from "./components/Header";
import AudioRecorder from "./components/AudioRecorder";
import ActiveSession from "./components/ActiveSession";
import AdminMonitoring from "./components/AdminMonitoring";
import ApiDocsView from "./components/ApiDocsView";
import { StreamRun, AnalysisResult, ProofResult, AutonomyMode } from "./types";
import {
  createCalendarEvent,
  updateCalendarEvent,
  createGoogleTask,
  updateGoogleTask,
  createDriveFolder,
  uploadDriveFile,
  deleteCreatedItem,
  resetSandboxState
} from "./utils/google-workspace";
import { Info, Lock, FolderSync, Trash2 } from "lucide-react";
import { isAutoExecutable } from "./utils/autonomy";
import { mergeList, isSameItem, PlanList } from "./utils/plan-merge";
import { applyCorrections } from "./utils/transcript";

// New characters of speech required before the expensive classifier stage re-runs.
const PLAN_MIN_GROWTH = 15;
// The live pipeline waits for a quiet gap, capped during non-stop speech.
const LIVE_QUIET_MS = 500;
const LIVE_MAX_WAIT_MS = 2500;

const TOKEN_KEY = "gcp_access_token";
const EXPIRY_KEY = "gcp_access_token_expiry";
const tokenExpired = () => Date.now() >= Number(localStorage.getItem(EXPIRY_KEY) || 0);
// Store (with a TTL in seconds) or clear the OAuth token.
function storeToken(token: string | null, ttlSec = 3600) {
  if (!token) return localStorage.removeItem(TOKEN_KEY), localStorage.removeItem(EXPIRY_KEY);
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(EXPIRY_KEY, String(Date.now() + ttlSec * 1000));
}

// State mirrored to localStorage as JSON. Old plain-string values fail JSON.parse and are kept raw.
function useLocalStorage<T>(key: string, initial: T) {
  const [value, setValue] = useState<T>(() => {
    const raw = localStorage.getItem(key);
    if (raw == null) return initial;
    try { return JSON.parse(raw); } catch { return raw as unknown as T; }
  });
  useEffect(() => { localStorage.setItem(key, JSON.stringify(value)); }, [key, value]);
  return [value, setValue] as const; // setValue accepts the updater-fn form too, same as useState
}

export default function App() {
  const [token, setToken] = useState<string | null>(() => {
    if (!tokenExpired()) return localStorage.getItem(TOKEN_KEY);
    storeToken(null);
    return null;
  });
  const [clientId, setClientId] = useLocalStorage("gcp_client_id", "");
  const [autonomyMode, setAutonomyMode] = useLocalStorage<AutonomyMode>("autonomy_mode", "consent");
  const [allowUncertain, setAllowUncertain] = useLocalStorage("autonomy_allow_uncertain", false);
  const [activeTab, setActiveTab] = useState<AppTab>("workspace");
  const [eventsCount, setEventsCount] = useState(0);
  const [savingDrive, setSavingDrive] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  // Bumped on Clear All; AudioRecorder resets its text without stopping capture.
  const [clearSignal, setClearSignal] = useState(0);
  const [liveTranscript, setLiveTranscript] = useState("");
  const [liveDraft, setLiveDraft] = useState<AnalysisResult | null>(null);
  const [liveSummary, setLiveSummary] = useState("");
  const [autoRun, setAutoRun] = useState(true);
  // Proofread result handed down for AudioRecorder to splice into the visible transcript.
  const [proofResult, setProofResult] = useState<ProofResult | null>(null);
  // Per-stage spinners: the stream resolves them one at a time, not all at the end.
  const [busy, setBusy] = useState({ proof: false, summary: false, plan: false });

  const liveTimerRef = useRef<NodeJS.Timeout | null>(null);
  const inFlightRef = useRef(false);
  const lastSentTextRef = useRef("");
  const lastLiveErrorRef = useRef<string | null>(null);
  const lastPlannedLenRef = useRef(0);
  const abortControllerRef = useRef<AbortController | null>(null);
  // Minted on the first non-empty transcript and reused by every /api/live tick, so the session
  // auto-saves to one server-side file. Cleared whenever liveTranscript resets to "".
  const sessionIdRef = useRef<string | null>(null);
  // When the CURRENT unsent change first appeared — reset once a cycle is scheduled for it. Lets the
  // debounce below cap the wait instead of resetting forever while speech keeps streaming in.
  const pendingSinceRef = useRef<number | null>(null);
  // Live-draft items whose auto-write is in flight, so a re-plan landing before the create returns
  // can't fire it again. Matched by identity: a re-plan can reorder the list mid-write.
  const autoFiringRef = useRef<{ list: PlanList; item: any }[]>([]);
  const showToast = (msg: string) => {
    setToastMessage(msg);
    setTimeout(() => setToastMessage(null), 5000);
  };

  // Normalize a raw classifier plan (the live pipeline's plan stage),
  // merged over the draft it replaces so settled rows keep their status, ids and answers while
  // scheduled/created rows still take refined details (rules and self-check in plan-merge.ts).
  const toAnalysisResult = (rawRes: any, rawText: string, prev?: AnalysisResult | null): AnalysisResult => ({
    summary: rawRes.ideasSummary || prev?.summary || "",
    rawText,
    calendarEvents: mergeList("calendarEvents", (rawRes.calendarEvents || [])
      .filter((evt: any) => evt && evt.title && evt.title.trim() !== "")
      .map((evt: any) => ({ ...evt, uncertain: !!evt.uncertain, allDay: !!evt.allDay })),
      prev?.calendarEvents || []),
    tasks: mergeList("tasks", (rawRes.tasks || [])
      .filter((t: any) => t && t.title && t.title.trim() !== "")
      .map((t: any) => ({ ...t, uncertain: !!t.uncertain, dueDate: t.dueDate?.trim() || undefined })),
      prev?.tasks || []),
    searchQueries: mergeList("searchQueries", (rawRes.searchQueries || [])
      .filter((q: any) => q && q.query && q.query.trim() !== ""),
      prev?.searchQueries || []),
  });

  const handleSetToken = (newToken: string | null) => {
    setToken(newToken);
    storeToken(newToken);
  };

  // OAuth implicit-grant redirect: the token arrives in the URL hash.
  useEffect(() => {
    const params = new URLSearchParams(window.location.hash.slice(1));
    const accessToken = params.get("access_token");
    if (!accessToken) return;
    storeToken(accessToken, Number(params.get("expires_in") || 3600));
    setToken(accessToken);
    showToast("Connected successfully! Google Workspace integration is now ONLINE.");
    window.history.replaceState({}, document.title, window.location.pathname); // drop the secret hash
  }, []);

  useEffect(() => {
    if (!token) return;
    const interval = setInterval(() => {
      if (!tokenExpired()) return;
      handleSetToken(null);
      showToast("Your Google session has expired. Reverted to Sandbox Preview Mode.");
    }, 10000);
    return () => clearInterval(interval);
  }, [token]);

  // Always sync the client ID from the server's credentials.json if present.
  useEffect(() => {
    fetch("/api/config")
      .then(r => r.json())
      .then(d => { if (d.googleClientId) setClientId(d.googleClientId); })
      .catch(() => {});
  }, []);

  // ONE capture cycle: proofread → summary + plan, streamed back stage by stage. One timer, not one
  // per stage — independent timers race each other and stack up 429s. Deliberately not keyed on
  // liveSummary either: an arriving summary would otherwise reset the timer that produced it.
  const runLive = async (text: string) => {
    // A cycle is mid-flight. Retry shortly rather than returning: the effect only re-arms on the NEXT
    // transcript change, so dropping here loses this text outright if the user has stopped talking.
    if (inFlightRef.current) {
      if (liveTimerRef.current) clearTimeout(liveTimerRef.current);
      liveTimerRef.current = setTimeout(() => runLive(text), 1000);
      return;
    }
    inFlightRef.current = true;
    abortControllerRef.current?.abort();
    const controller = new AbortController();
    abortControllerRef.current = controller;

    // The classifier is the expensive stage; only re-plan once enough new speech has landed.
    const withPlan = !liveDraft || text.length - lastPlannedLenRef.current >= PLAN_MIN_GROWTH;
    lastSentTextRef.current = text;
    setBusy(b => ({ ...b, summary: true, plan: withPlan }));

    try {
      const res = await fetch("/api/live", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, currentLocalTime: new Date().toISOString(), liveSummary, withPlan, sessionId: sessionIdRef.current }),
        signal: controller.signal,
      });
      if (!res.ok || !res.body) throw new Error(`Live pipeline failed (HTTP ${res.status}).`);

      // NDJSON: one JSON object per line, flushed as each stage finishes.
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? ""; // trailing partial line waits for the next chunk
        for (const line of lines) {
          if (line.trim()) handleStage(JSON.parse(line));
        }
      }
    } catch (error: any) {
      if (error.name !== "AbortError") handleStage({ stage: "pipeline", error: error.message });
    } finally {
      inFlightRef.current = false;
      setBusy(b => ({ ...b, summary: false, plan: false })); // proof is owned by proofreadOnStop
    }
  };

  // Proofreading runs once when the mic stops, not per live tick: measured per tick it doubled
  // time-to-plan without changing the plan (summary/plan agents already read past casing and
  // punctuation). It only makes the transcript itself readable. AudioRecorder applies the result.
  const proofreadOnStop = async () => {
    const text = liveTranscript.trim();
    if (text.length < 15) return;
    setBusy(b => ({ ...b, proof: true }));
    try {
      const res = await fetch("/api/transcribe-correct", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
      const { corrections, words } = await res.json();
      // That text was already summarized and planned: the correction is cosmetic, so it mustn't
      // re-arm the debounce and buy the same answer twice. If it was NOT sent yet, leave the ref so
      // the pending final tick still runs.
      if (lastSentTextRef.current === text) lastSentTextRef.current = applyCorrections(text, words, corrections).text;
      setProofResult({ text, corrections, words });
    } catch (err: any) {
      console.error("Proofread failed:", err);
      showToast(`Proofread failed: ${err.message}`);
    } finally {
      setBusy(b => ({ ...b, proof: false }));
    }
  };

  const handleStage = (msg: any) => {
    if (msg.error) {
      console.warn(`[live] ${msg.stage} stage failed:`, msg.error);
      // Once per distinct error, not once per tick — a dead credential fails every cycle.
      if (msg.error !== lastLiveErrorRef.current) showToast(`Live ${msg.stage} failed: ${msg.error}`);
      lastLiveErrorRef.current = msg.error;
    }
    else if (msg.stage === "summary") { setLiveSummary(msg.summary); lastLiveErrorRef.current = null; }
    else if (msg.stage === "plan") {
      setLiveDraft(prev => toAnalysisResult(msg.plan, msg.text, prev));
      lastPlannedLenRef.current = (msg.text || "").length;
    }
    // "fatal" carries no stage of its own — guard so it can't invent a busy key.
    if (msg.stage in busy) setBusy(b => ({ ...b, [msg.stage]: false }));
  };

  // Debounce with a cap: continuous speech would keep resetting the quiet gap forever, so once a
  // change has waited LIVE_MAX_WAIT_MS it runs on the next tick.
  useEffect(() => {
    const text = liveTranscript.trim();
    if (!text) {
      setLiveDraft(null);
      lastSentTextRef.current = "";
      lastPlannedLenRef.current = 0;
      pendingSinceRef.current = null;
      sessionIdRef.current = null;
      return;
    }
    if (!sessionIdRef.current) sessionIdRef.current = `run-${Date.now()}`;
    if (!autoRun || text.length < 15 || text === lastSentTextRef.current) return;

    if (pendingSinceRef.current === null) pendingSinceRef.current = Date.now();
    const waited = Date.now() - pendingSinceRef.current;
    const delay = waited >= LIVE_MAX_WAIT_MS ? 0 : LIVE_QUIET_MS;

    if (liveTimerRef.current) clearTimeout(liveTimerRef.current);
    liveTimerRef.current = setTimeout(() => { pendingSinceRef.current = null; runLive(text); }, delay);
    return () => { if (liveTimerRef.current) clearTimeout(liveTimerRef.current); };
  }, [liveTranscript, autoRun]);

  const handleSetClientId = (id: string) => {
    setClientId(id);
    showToast("GCP Client Credentials configured.");
  };

  const handleGoogleSignIn = () => {
    if (!clientId) {
      setShowSettings(true);
      showToast("Add your Google OAuth Client ID below to sign in — see the README for the 5-minute GCP setup.");
      return;
    }
    const scope = ["calendar.events", "tasks", "drive", "documents", "spreadsheets", "userinfo.profile"]
      .map(s => `https://www.googleapis.com/auth/${s}`).join(" ");
    window.location.href = "https://accounts.google.com/o/oauth2/v2/auth?" + new URLSearchParams({
      client_id: clientId, redirect_uri: window.location.origin, response_type: "token",
      scope, include_granted_scopes: "true", prompt: "consent",
    });
  };

  const runSearch = async (query: string) => {
    const res = await fetch("/api/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query })
    });
    if (!res.ok) {
      const e = await res.json().catch(() => ({}));
      throw new Error(e.error || `Search failed (HTTP ${res.status}).`);
    }
    const data = await res.json();
    return { condensed: data.condensed, answer: data.inDepth, sources: data.sources };
  };

  // Exactly the field values a write sends to Google. Stamped onto the item after every successful
  // write; if it no longer matches, the speaker refined the item and the remote copy is stale.
  const eventFingerprint = (e: any) => JSON.stringify([e.title, e.description, e.start, e.end, e.allDay]);
  const taskFingerprint = (t: any) => JSON.stringify([t.title, t.notes, t.dueDate]);

  // One row per executable kind. The approve buttons and the autonomy pass both read this table, so
  // manual and automatic execution can't drift apart.
  const KINDS = {
    calendar: {
      list: "calendarEvents",
      idKey: "eventId" as const,
      fingerprint: eventFingerprint,
      update: async (e: any) => ({ synced: eventFingerprint(e), eventId: await updateCalendarEvent(token, e.eventId, e) }),
      exec: async (e: any) => ({ status: "scheduled", synced: eventFingerprint(e), eventId: await createCalendarEvent(token, e) }),
      done: (e: any) => `Successfully scheduled "${e.title}" on Google Calendar!`,
      auto: (e: any) => `Auto-scheduled "${e.title}" on Google Calendar, as requested.`,
      failed: (msg: string) => `Calendar Integration Failed: ${msg}`,
      undo: { idKey: "eventId", where: "Google Calendar", action: "create_calendar_event" },
    },
    task: {
      list: "tasks",
      idKey: "taskId" as const,
      fingerprint: taskFingerprint,
      update: async (t: any) => ({ synced: taskFingerprint(t), taskId: await updateGoogleTask(token, t.taskId, t) }),
      exec: async (t: any) => ({ status: "created", synced: taskFingerprint(t), taskId: await createGoogleTask(token, t) }),
      done: (t: any) => `Successfully added task "${t.title}" to Google Tasks list!`,
      auto: (t: any) => `Auto-logged "${t.title}" to Google Tasks, as requested.`,
      failed: (msg: string) => `Tasks Integration Failed: ${msg}`,
      undo: { idKey: "taskId", where: "Google Tasks", action: "create_task" },
    },
    search: {
      list: "searchQueries",
      // A finished search has no remote resource to keep in sync — the answer is already on screen.
      idKey: null,
      fingerprint: null,
      update: null,
      exec: async (q: any) => ({ status: "completed", ...(await runSearch(q.query)) }),
      done: (q: any) => `Researched facts retrieved for query: "${q.query}"`,
      auto: (q: any) => `Auto-searched "${q.query}", as requested.`,
      failed: (msg: string) => `Facts query search failed: ${msg}`,
      undo: null, // a search wrote nothing to undo
    },
  } as const;
  type Kind = keyof typeof KINDS;

  // Update one row, found by identity (a re-plan mid-write can reorder the list). `update` gets the
  // row as it is now, not as it was clicked.
  const patchItem = (a: AnalysisResult, list: PlanList, original: any, update: (row: any) => any): AnalysisResult => {
    if (!original) return a;
    const rows = [...(a as any)[list]];
    let at = rows.indexOf(original);
    if (at < 0) at = rows.findIndex(x => isSameItem(list, x, original));
    // Re-planned away mid-write — keep the result anyway rather than lose the id it just created.
    if (at < 0) rows.push(update(original)); else rows[at] = update(rows[at]);
    return { ...a, [list]: rows };
  };

  // Execute ONE reviewed item, then fold the result — or the failure — back into what's on screen.
  const executeItem = async (kind: Kind, index: number) => {
    const { list, exec, done, failed } = KINDS[kind];
    const item: any = (liveDraft as any)?.[list]?.[index];
    if (!item) return;
    try {
      const patch = await exec(item);
      updateActiveAnalysis(a => patchItem(a, list, item, row => ({ ...row, ...patch })));
      showToast(done(item));
    } catch (err: any) {
      console.error(err);
      updateActiveAnalysis(a => patchItem(a, list, item, row => ({ ...row, status: "failed", error: err.message })));
      showToast(failed(err.message));
    }
  };

  // Autonomy: write any live-draft item isAutoExecutable allows, without a button. exec() flips it off
  // "pending" (kept across re-plans by plan-merge); autoFiringRef covers the gap until it lands.
  useEffect(() => {
    if (!liveDraft || autonomyMode === "manual") return;
    for (const { list, exec, auto, update, fingerprint, idKey } of Object.values(KINDS)) {
      const items: any[] = (liveDraft as any)[list] ?? [];
      items.forEach(item => {
        if (autoFiringRef.current.some(f => f.list === list && isSameItem(list, f.item, item))) return;

        // A new write is gated by consent; re-syncing an item already written (refined mid-sentence)
        // is not a new decision, so only the mode check above gates it.
        const stale = !!update && !!idKey && !!item[idKey] && !!item.synced && fingerprint(item) !== item.synced;
        const run = stale ? update : isAutoExecutable(item, autonomyMode, allowUncertain) ? exec : null;
        if (!run) return;

        const inFlight = { list, item };
        autoFiringRef.current.push(inFlight);
        (async () => {
          try {
            const patch = await run(item);
            setLiveDraft(a => (a ? patchItem(a, list, item, row => ({ ...row, ...patch })) : a));
            showToast(stale ? `Updated "${item.title}" — you added details while talking.` : auto(item));
          } catch (err: any) {
            console.error(err);
            // A failed re-sync isn't a failed item (it exists remotely). Stamp the fingerprint anyway
            // so a permanently failing update doesn't retry every tick.
            setLiveDraft(a => (a ? patchItem(a, list, item, row => stale
              ? { ...row, synced: fingerprint(item), error: err.message }
              : { ...row, status: "failed", error: err.message }) : a));
          } finally {
            // Safe to release: the item is no longer "pending", so the gate above blocks it now.
            autoFiringRef.current = autoFiringRef.current.filter(f => f !== inFlight);
          }
        })();
      });
    }
  }, [liveDraft, autonomyMode, allowUncertain]);

  // Save a markdown report into this session's Drive folder (created on first save, reused after).
  // Two tool calls behind one approval — the button IS the consent, same as every other write here.
  const handleSaveToDrive = async (folderName: string, fileName: string, markdown: string) => {
    if (!markdown.trim()) {
      showToast("Nothing to save yet — no notes have been generated.");
      return;
    }
    setSavingDrive(true);
    try {
      const folderId = await createDriveFolder(token, folderName || "Scribant Session");
      await uploadDriveFile(token, fileName, markdown, folderId);
      showToast(token
        ? `Saved "${fileName}" to Google Drive → ${folderName}.`
        : `Sandbox: "${fileName}" saved to a simulated Drive folder.`);
    } catch (err: any) {
      const msg = String(err?.message || err);
      // Tokens issued before the drive.file scope existed come back 403 — say what to do about it.
      showToast(/permission|insufficient|unauthorized|403/i.test(msg)
        ? "Drive access not granted — sign in with Google again to authorize Drive."
        : `Drive save failed: ${msg}`);
    } finally {
      setSavingDrive(false);
    }
  };

  // "undone", not "pending": the button returns, but auto mode must not re-create it.
  const handleUndo = async (kind: Exclude<Kind, "search">, index: number) => {
    const { list, undo } = KINDS[kind];
    const item: any = (liveDraft as any)?.[list]?.[index];
    if (!item?.[undo.idKey]) return;
    try {
      await deleteCreatedItem(token, undo.action, item[undo.idKey]);
      updateActiveAnalysis(a => patchItem(a, list, item, row => ({ ...row, status: "undone", [undo.idKey]: undefined })));
      showToast(`Removed "${item.title}" from ${undo.where}.`);
    } catch (err: any) {
      console.error(err);
      showToast(`Undo failed: ${err.message}`);
    }
  };

  const updateActiveAnalysis = (updater: (a: AnalysisResult) => AnalysisResult) =>
    setLiveDraft(prev => (prev ? updater(prev) : prev));

  const handleClearAll = () => {
    if (window.confirm("Are you sure you want to clear everything? This will reset the transcript, AI notes, main ideas, calendar events, search queries, and to-dos.")) {
      abortControllerRef.current?.abort();
      abortControllerRef.current = null;
      setClearSignal(k => k + 1);
      setLiveTranscript("");
      setLiveDraft(null);
      setLiveSummary("");
      setProofResult(null);
      setBusy({ proof: false, summary: false, plan: false });
      inFlightRef.current = false;
      lastSentTextRef.current = "";
      lastPlannedLenRef.current = 0;
      sessionIdRef.current = null;
      resetSandboxState();
      showToast("All session data cleared.");
    }
  };

  const displayedRun: StreamRun | null = liveTranscript.trim()
    ? { id: "live-draft", timestamp: new Date().toISOString(), rawText: liveTranscript,
        status: busy.plan ? "processing" : "completed", analysis: liveDraft || undefined }
    : null;

  return (
    <div className="min-h-screen bg-stone-100/40 text-stone-900 flex flex-col font-sans selection:bg-amber-100">
      
      {/* Toast Alert overlay */}
      {toastMessage && (
        <div id="toast-banner-msg" className="fixed bottom-6 right-6 z-50 bg-stone-900 border border-stone-800 text-stone-100 text-xs font-semibold px-4 py-3 rounded-xl shadow-lg flex items-center gap-2.5 max-w-sm animate-fade-in animate-slide-up">
          <Info className="w-4 h-4 text-amber-500 shrink-0" />
          <span>{toastMessage}</span>
        </div>
      )}

      {/* Main Container spacing */}
      <div className="w-full max-w-7xl mx-auto px-4 md:px-6 py-6 space-y-6 flex-1">
        
        {/* Navigation & configurations */}
        <Header
          token={token}
          onSetToken={handleSetToken}
          clientId={clientId}
          onSetClientId={handleSetClientId}
          onSignIn={handleGoogleSignIn}
          showConfig={showSettings}
          onShowConfigChange={setShowSettings}
          autonomyMode={autonomyMode}
          onSetAutonomyMode={setAutonomyMode}
          allowUncertain={allowUncertain}
          onSetAllowUncertain={setAllowUncertain}
          autoRun={autoRun}
          onAutoRunChange={setAutoRun}
          activeTab={activeTab}
          onTabChange={setActiveTab}
          eventsCount={eventsCount}
        />

        {/* View 1: Workspace Tab */}
        <div className={activeTab === "workspace" ? "space-y-6" : "hidden"}>
          {/* Sync Mode Info Header banner */}
          {!token && (
            <div className="bg-amber-50 border border-amber-200/50 rounded-2xl p-4 flex flex-col md:flex-row md:items-center justify-between gap-4 shadow-inner">
              <div className="flex items-start gap-2.5">
                <Lock className="w-4 h-4 text-amber-700 shrink-0 mt-0.5" />
                <div className="space-y-0.5">
                  <p className="text-xs font-bold text-stone-800 font-sans">Currently running in Sandbox Preview Mode (Simulated APIs)</p>
                  <p className="text-[11px] text-stone-500 leading-normal font-sans">
                    No active Google data is modified. Click Sign in with Google on the right to authorize real Google Calendar and Tasks.
                  </p>
                </div>
              </div>
              <button
                onClick={handleGoogleSignIn}
                className="px-4.5 py-2 text-xs font-bold bg-stone-900 hover:bg-stone-800 text-stone-100 hover:text-white rounded-lg border border-stone-950 shadow-sm flex items-center justify-center gap-1.5 transition-all self-start md:self-auto shrink-0 w-full md:w-auto"
              >
                <FolderSync className="w-4 h-4" /> Sign in with Google
              </button>
            </div>
          )}

          {/* Content layout: Top Row (Microphone) */}
          <div className="w-full">
            <AudioRecorder
              clearSignal={clearSignal}
              onShowToast={showToast}
              onChangeTranscript={setLiveTranscript}
              liveSummary={liveSummary}
              proofResult={proofResult}
              busy={busy}
              onRunNow={() => runLive(liveTranscript.trim())}
              onStopListening={proofreadOnStop}
              onSaveToDrive={() => handleSaveToDrive("Scribant Session", "Live Notes.md", liveSummary)}
              savingDrive={savingDrive}
              mainIdeas={liveDraft?.summary || ""}
              onSaveMainIdeasToDrive={() => handleSaveToDrive("Scribant Session", "Session Summary.md", liveDraft?.summary || "")}
            />
          </div>

          {/* Results layout: rendered cleanly underneath the Microphone */}
          <div className="pt-2">
            <ActiveSession
              run={displayedRun}
              onExecuteCalendar={i => executeItem("calendar", i)}
              onExecuteTask={i => executeItem("task", i)}
              onExecuteSearch={i => executeItem("search", i)}
              onUndoCalendar={i => handleUndo("calendar", i)}
              onUndoTask={i => handleUndo("task", i)}
              onUpdateCalendar={(i, u) => updateActiveAnalysis(a => patchItem(a, "calendarEvents", liveDraft?.calendarEvents[i], () => u))}
              onUpdateTask={(i, u) => updateActiveAnalysis(a => patchItem(a, "tasks", liveDraft?.tasks[i], () => u))}
              isLiveAnalyzing={busy.plan}
            />
          </div>

          {/* Clear All Session Data button */}
          <div className="pt-4 flex justify-center">
            <button
              onClick={handleClearAll}
              className="flex items-center gap-2 px-5 py-2.5 text-xs font-semibold text-stone-400 hover:text-red-600 bg-transparent hover:bg-red-50 border border-dashed border-stone-200 hover:border-red-300 rounded-xl transition-all cursor-pointer"
            >
              <Trash2 className="w-3.5 h-3.5" />
              Clear All Session Data
            </button>
          </div>
        </div>

        {/* View 2: Administration & Monitoring Tab */}
        <div id="admin-monitoring-section" className={activeTab === "admin" ? "pt-2" : "hidden"}>
          <AdminMonitoring
            onEventsCountChange={setEventsCount}
            rawTranscript={liveTranscript}
            liveSummary={liveSummary}
          />
        </div>

        {/* View 3: API Documentation Tab */}
        <div id="api-docs-section" className={activeTab === "docs" ? "pt-2" : "hidden"}>
          <ApiDocsView />
        </div>

      </div>

      {/* Humble aesthetic footer */}
      <footer className="border-t border-stone-200 bg-stone-50/50 py-4 text-center text-[10px] text-stone-400 uppercase tracking-widest font-mono" />

    </div>
  );
}
