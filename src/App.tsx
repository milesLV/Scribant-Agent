import { useState, useEffect, useRef } from "react";
import Header from "./components/Header";
import AudioRecorder from "./components/AudioRecorder";
import ActiveSession from "./components/ActiveSession";
import SessionHistory from "./components/SessionHistory";
import { StreamRun, AnalysisResult, ProofResult, AutonomyMode } from "./types";
import {
  createCalendarEvent,
  createGoogleTask,
  createDriveFolder,
  uploadDriveFile,
  deleteCreatedItem,
  resetSandboxState
} from "./utils/google-workspace";
import { Info, Lock, FolderSync, Trash2 } from "lucide-react";
import { isAutoExecutable } from "./utils/autonomy";

// New characters of speech required before the expensive classifier stage re-runs. Below this, the
// cycle still proofreads and re-summarizes; the previous plan stays on screen. Tune if drafts feel
// stale (lower) or the free-tier quota bites (higher).
const PLAN_MIN_GROWTH = 80;

// Who the server files transcripts under. The Google account id once signed in; otherwise a
// per-browser uuid so sandbox sessions still land in their own folder instead of one shared heap.
const localUserId = () => {
  let id = localStorage.getItem("scribant_local_user_id");
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem("scribant_local_user_id", id);
  }
  return id;
};

export default function App() {
  const [token, setToken] = useState<string | null>(() => {
    const storedToken = localStorage.getItem("gcp_access_token");
    const storedExpiry = localStorage.getItem("gcp_access_token_expiry");
    if (storedToken && storedExpiry) {
      const expiryTime = parseInt(storedExpiry, 10);
      if (Date.now() < expiryTime) {
        return storedToken;
      } else {
        localStorage.removeItem("gcp_access_token");
        localStorage.removeItem("gcp_access_token_expiry");
      }
    }
    return null;
  });
  const [clientId, setClientId] = useState<string>(() => {
    return localStorage.getItem("gcp_client_id") || "";
  });
  const [runs, setRuns] = useState<StreamRun[]>(() => {
    const data = localStorage.getItem("stream_runs_archive");
    return data ? JSON.parse(data) : [];
  });
  const [selectedRunId, setSelectedRunId] = useState<string | null>(() => {
    const data = localStorage.getItem("stream_runs_archive");
    if (!data) return null;
    const parsed: StreamRun[] = JSON.parse(data);
    return parsed.length > 0 ? parsed[0].id : null;
  });
  const [autonomyMode, setAutonomyMode] = useState<AutonomyMode>(() =>
    (localStorage.getItem("autonomy_mode") as AutonomyMode) || "consent");
  const [allowUncertain, setAllowUncertain] = useState<boolean>(() =>
    localStorage.getItem("autonomy_allow_uncertain") === "true");
  const [userId, setUserId] = useState<string>(() => localStorage.getItem("gcp_user_id") || localUserId());
  const [savingDrive, setSavingDrive] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  // Bumped on Clear All and used as AudioRecorder's `key` — remounting is the reset, so the
  // component's own mic/recognizer/proofread state never needs a second reset path to keep in sync.
  const [recorderKey, setRecorderKey] = useState(0);
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
  const lastPlannedLenRef = useRef(0);
  const abortControllerRef = useRef<AbortController | null>(null);

  const showToast = (msg: string) => {
    setToastMessage(msg);
    setTimeout(() => setToastMessage(null), 5000);
  };

  // Normalize a raw classifier plan (from either /api/analyze or the live pipeline's plan stage).
  const toAnalysisResult = (rawRes: any, rawText: string): AnalysisResult => ({
    summary: rawRes.ideasSummary || "",
    rawText,
    calendarEvents: (rawRes.calendarEvents || [])
      .filter((evt: any) => evt && evt.title && evt.title.trim() !== "")
      .map((evt: any) => ({ ...evt, status: "pending" as const, uncertain: !!evt.uncertain, allDay: !!evt.allDay })),
    tasks: (rawRes.tasks || [])
      .filter((t: any) => t && t.title && t.title.trim() !== "")
      .map((t: any) => ({ ...t, status: "pending" as const, uncertain: !!t.uncertain, dueDate: t.dueDate?.trim() || undefined })),
    searchQueries: (rawRes.searchQueries || [])
      .filter((q: any) => q && q.query && q.query.trim() !== "")
      .map((q: any) => ({ ...q, status: "pending" as const })),
    organizedFolder: rawRes.organizedFolderName || "Session Notes"
  });

  // Apply an updater to whichever analysis is selected (live draft or an archived run).
  const updateActiveAnalysis = (updater: (a: AnalysisResult) => AnalysisResult) => {
    if (selectedRunId === "live-draft") {
      setLiveDraft(prev => (prev ? updater(prev) : prev));
    } else {
      setRuns(prev => prev.map(r =>
        r.id === selectedRunId && r.analysis ? { ...r, analysis: updater(r.analysis) } : r
      ));
    }
  };

  const handleSetToken = (newToken: string | null) => {
    setToken(newToken);
    if (newToken) {
      localStorage.setItem("gcp_access_token", newToken);
      if (!localStorage.getItem("gcp_access_token_expiry")) {
        const expiryTime = Date.now() + 3600 * 1000;
        localStorage.setItem("gcp_access_token_expiry", expiryTime.toString());
      }
    } else {
      localStorage.removeItem("gcp_access_token");
      localStorage.removeItem("gcp_access_token_expiry");
    }
  };

  // Authenticate implicitly on URL redirect hash matching
  useEffect(() => {
    const hash = window.location.hash;
    if (hash) {
      const params = new URLSearchParams(hash.substring(1));
      const accessToken = params.get("access_token");
      const expiresIn = params.get("expires_in") || "3600";
      if (accessToken) {
        const expiryTime = Date.now() + parseInt(expiresIn, 10) * 1000;
        localStorage.setItem("gcp_access_token", accessToken);
        localStorage.setItem("gcp_access_token_expiry", expiryTime.toString());
        setToken(accessToken);
        showToast("Connected successfully! Google Workspace integration is now ONLINE.");
        // Clear secret hash parameters from browser history
        window.history.replaceState({}, document.title, window.location.pathname);
      }
    }
  }, []);

  // Resolve the Google account id once per token (the userinfo.profile scope is already requested),
  // and fall back to the local uuid when signed out. Only `sub` is kept — no profile data.
  useEffect(() => {
    if (!token) {
      localStorage.removeItem("gcp_user_id");
      setUserId(localUserId());
      return;
    }
    fetch("https://www.googleapis.com/oauth2/v3/userinfo", { headers: { Authorization: `Bearer ${token}` } })
      .then(r => (r.ok ? r.json() : null))
      .then(d => {
        if (!d?.sub) return;
        localStorage.setItem("gcp_user_id", d.sub);
        setUserId(d.sub);
      })
      .catch(() => {});
  }, [token]);

  // Monitor token expiration periodically
  useEffect(() => {
    if (!token) return;
    const interval = setInterval(() => {
      const storedExpiry = localStorage.getItem("gcp_access_token_expiry");
      if (storedExpiry) {
        const expiryTime = parseInt(storedExpiry, 10);
        if (Date.now() >= expiryTime) {
          handleSetToken(null);
          showToast("Your Google session has expired. Reverted to Sandbox Preview Mode.");
        }
      }
    }, 10000);
    return () => clearInterval(interval);
  }, [token]);

  // Sync state to local storage
  useEffect(() => {
    localStorage.setItem("stream_runs_archive", JSON.stringify(runs));
  }, [runs]);

  useEffect(() => {
    if (clientId) {
      localStorage.setItem("gcp_client_id", clientId);
    } else {
      localStorage.removeItem("gcp_client_id");
    }
  }, [clientId]);

  useEffect(() => { localStorage.setItem("autonomy_mode", autonomyMode); }, [autonomyMode]);
  useEffect(() => { localStorage.setItem("autonomy_allow_uncertain", String(allowUncertain)); }, [allowUncertain]);

  // Default the client ID from the server's credentials.json when none is saved.
  useEffect(() => {
    if (clientId) return;
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
    setBusy({ proof: true, summary: true, plan: withPlan });

    try {
      const res = await fetch("/api/live", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, currentLocalTime: new Date().toISOString(), liveSummary, withPlan }),
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
      if (error.name !== "AbortError") console.error("Live pipeline failed:", error);
    } finally {
      inFlightRef.current = false;
      setBusy({ proof: false, summary: false, plan: false });
    }
  };

  const handleStage = (msg: any) => {
    if (msg.error) { console.warn(`[live] ${msg.stage} stage failed:`, msg.error); }
    else if (msg.stage === "proof") {
      setProofResult({ text: msg.text, corrections: msg.corrections, words: msg.words });
      // This cycle already reasoned over the corrected text, so don't let applying the correction
      // re-arm the debounce and buy the same answer twice.
      if (msg.corrected) lastSentTextRef.current = msg.corrected;
    }
    else if (msg.stage === "summary") setLiveSummary(msg.summary);
    else if (msg.stage === "plan") {
      setLiveDraft(toAnalysisResult(msg.plan, msg.text));
      lastPlannedLenRef.current = (msg.text || "").length;
    }
    // "fatal" carries no stage of its own — guard so it can't invent a busy key.
    if (msg.stage in busy) setBusy(b => ({ ...b, [msg.stage]: false }));
  };

  // Debounce: one cycle 2s after the transcript stops changing.
  useEffect(() => {
    const text = liveTranscript.trim();
    if (!text) {
      setLiveDraft(null);
      lastSentTextRef.current = "";
      lastPlannedLenRef.current = 0;
      return;
    }
    if (!autoRun || text.length < 15 || text === lastSentTextRef.current) return;

    if (liveTimerRef.current) clearTimeout(liveTimerRef.current);
    liveTimerRef.current = setTimeout(() => runLive(text), 2000);
    return () => { if (liveTimerRef.current) clearTimeout(liveTimerRef.current); };
  }, [liveTranscript, autoRun]);

  // Sync selectedRunId to live-draft or fallback to archive
  useEffect(() => {
    const text = liveTranscript.trim();
    const selectedRun = runs.find(r => r.id === selectedRunId);
    const isShowingFinalizedRun = selectedRun && selectedRun.rawText.trim() === text;

    if (text) {
      if (!isShowingFinalizedRun && selectedRunId !== "live-draft") {
        setSelectedRunId("live-draft");
      }
    } else {
      if (selectedRunId === "live-draft") {
        setSelectedRunId(runs.length > 0 ? runs[0].id : null);
      }
    }
  }, [liveTranscript, selectedRunId, runs]);

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
    const redirectUri = window.location.origin;
    // drive.file is least privilege: this app only ever sees the files it created itself.
    const scope = "https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/tasks https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/userinfo.profile";

    // Standard Implicit Grant Flow auth URL
    const googleAuthUrl = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=token&scope=${encodeURIComponent(scope)}&include_granted_scopes=true&prompt=consent`;

    window.location.href = googleAuthUrl;
  };

  const handleAnalyzeStream = async (text: string) => {
    setIsProcessing(true);
    // Minted before the request so the server files the transcript under the same id the archived
    // run gets — one JSONL file per session, matching what the user sees in their history.
    const runId = `run-${Date.now()}`;

    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }

    try {
      // Finalize: the full classifier pass behind the "Analyze Thoughts" button. The capture loop
      // uses /api/live instead, so this runs once per session and is never cancelled.
      const res = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, currentLocalTime: new Date().toISOString(), liveSummary, userId, sessionId: runId }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Brain dump categorization failed.");
      }

      const rawRes = await res.json();

      const analysis = toAnalysisResult(rawRes, text);

      // Consent-gated autonomy. Finalize only — the live draft re-plans continuously, so running
      // this there would re-fire the same writes every cycle. Mutates the local object before it
      // enters state, so the index-based handlers below aren't involved.
      await autoExecute(analysis);

      const newRun: StreamRun = {
        id: runId,
        timestamp: new Date().toISOString(),
        rawText: text,
        status: "completed",
        analysis
      };

      setRuns(prev => [newRun, ...prev]);
      setSelectedRunId(newRun.id);
      
      // Clear live draft and transcript so no more tokens are consumed after finalization
      setLiveTranscript("");
      setLiveDraft(null);
      setLiveSummary("");
      
      showToast("Thoughts structured! Actionable items detected.");
    } catch (error: any) {
      console.error(error);
      showToast(`Analyzer Error: ${error.message || "Failed to process speech intents."}`);
    } finally {
      setIsProcessing(false);
    }
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

  // One row per executable item kind: which analysis list it lives in, how to run it, and what to
  // say afterwards. The approve buttons and the autonomy pass both read this table, so a manual
  // execution and an automatic one can never drift apart.
  const KINDS = {
    calendar: {
      list: "calendarEvents",
      exec: async (e: any) => ({ status: "scheduled", eventId: await createCalendarEvent(token, e) }),
      done: (e: any) => `Successfully scheduled "${e.title}" on Google Calendar!`,
      auto: (e: any) => `Auto-scheduled "${e.title}" on Google Calendar, as requested.`,
      failed: (msg: string) => `Calendar Integration Failed: ${msg}`,
      undo: { idKey: "eventId", where: "Google Calendar", action: "create_calendar_event" },
    },
    task: {
      list: "tasks",
      exec: async (t: any) => ({ status: "created", taskId: await createGoogleTask(token, t) }),
      done: (t: any) => `Successfully logged task "${t.title}" to Google Tasks list!`,
      auto: (t: any) => `Auto-logged "${t.title}" to Google Tasks, as requested.`,
      failed: (msg: string) => `Tasks Integration Failed: ${msg}`,
      undo: { idKey: "taskId", where: "Google Tasks", action: "create_task" },
    },
    search: {
      list: "searchQueries",
      exec: async (q: any) => ({ status: "completed", ...(await runSearch(q.query)) }),
      done: (q: any) => `Researced facts retrieved for query: "${q.query}"`,
      auto: (q: any) => `Auto-searched "${q.query}", as requested.`,
      failed: (msg: string) => `Facts query search failed: ${msg}`,
      undo: null, // a search wrote nothing to undo
    },
  } as const;
  type Kind = keyof typeof KINDS;

  // Replace one item in one of the analysis lists, leaving everything else untouched.
  const patchAt = (a: AnalysisResult, list: string, index: number, value: any): AnalysisResult => {
    const next = [...(a as any)[list]];
    next[index] = value;
    return { ...a, [list]: next };
  };

  // Execute ONE reviewed item, then fold the result — or the failure — back into what's on screen.
  const executeItem = async (kind: Kind, index: number) => {
    const { list, exec, done, failed } = KINDS[kind];
    const item: any = (activeAnalysis as any)?.[list]?.[index];
    if (!item) return;
    try {
      const patch = await exec(item);
      updateActiveAnalysis(a => patchAt(a, list, index, { ...item, ...patch }));
      showToast(done(item));
    } catch (err: any) {
      console.error(err);
      updateActiveAnalysis(a => patchAt(a, list, index, { ...item, status: "failed", error: err.message }));
      showToast(failed(err.message));
    }
  };

  // Execute whatever the current autonomy mode allows (see isAutoExecutable for the gate), mutating
  // the analysis in place. A failure marks that item failed but never blocks the rest.
  const autoExecute = async (analysis: AnalysisResult) => {
    if (autonomyMode === "manual") return;
    for (const { list, exec, auto } of Object.values(KINDS)) {
      const items: any[] = (analysis as any)[list];
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (!isAutoExecutable(item, autonomyMode, allowUncertain)) continue;
        try {
          items[i] = { ...item, ...(await exec(item)) };
          showToast(auto(item));
        } catch (err: any) {
          items[i] = { ...item, status: "failed", error: err.message };
        }
      }
    }
  };

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

  // The analysis currently shown (live draft or selected archive run).
  const activeAnalysis = selectedRunId === "live-draft"
    ? liveDraft
    : runs.find(r => r.id === selectedRunId)?.analysis ?? null;

  // Undo a created calendar event / task: delete by the id the create returned, then reset the item
  // to pending so its button comes back.
  const handleUndo = async (kind: Exclude<Kind, "search">, index: number) => {
    const { list, undo } = KINDS[kind];
    const item: any = (activeAnalysis as any)?.[list]?.[index];
    if (!item?.[undo.idKey]) return;
    try {
      await deleteCreatedItem(token, undo.action, item[undo.idKey]);
      updateActiveAnalysis(a => patchAt(a, list, index, { ...item, status: "pending", [undo.idKey]: undefined }));
      showToast(`Removed "${item.title}" from ${undo.where}.`);
    } catch (err: any) {
      console.error(err);
      showToast(`Undo failed: ${err.message}`);
    }
  };

  const handleClearAll = () => {
    if (window.confirm("Are you sure you want to clear everything? This will reset the transcript, AI notes, bulletins, calendar events, search queries, and to-dos.")) {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
        abortControllerRef.current = null;
      }
      setRuns([]);
      setSelectedRunId(null);
      setRecorderKey(k => k + 1);
      setLiveTranscript("");
      setLiveDraft(null);
      setLiveSummary("");
      setIsProcessing(false);
      setProofResult(null);
      setBusy({ proof: false, summary: false, plan: false });
      inFlightRef.current = false;
      lastSentTextRef.current = "";
      lastPlannedLenRef.current = 0;
      resetSandboxState();
      showToast("All session data cleared.");
    }
  };

  const selectedRun = runs.find(r => r.id === selectedRunId);

  const displayedRun: StreamRun | null = selectedRunId === "live-draft"
    ? {
        id: "live-draft",
        timestamp: new Date().toISOString(),
        rawText: liveTranscript,
        status: busy.plan ? "processing" : "completed",
        analysis: liveDraft || undefined
      }
    : (selectedRun || null);

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
        />

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
            key={recorderKey}
            onAnalyze={handleAnalyzeStream}
            isProcessing={isProcessing}
            onShowToast={showToast}
            onChangeTranscript={setLiveTranscript}
            liveSummary={liveSummary}
            proofResult={proofResult}
            busy={busy}
            onRunNow={() => runLive(liveTranscript.trim())}
            onSaveToDrive={() => handleSaveToDrive(
              liveDraft?.organizedFolder || "Scribant Session",
              "Live Notes.md",
              liveSummary,
            )}
            savingDrive={savingDrive}
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
            onUpdateCalendar={(i, u) => updateActiveAnalysis(a => patchAt(a, "calendarEvents", i, u))}
            onUpdateTask={(i, u) => updateActiveAnalysis(a => patchAt(a, "tasks", i, u))}
            onSaveToDrive={() => handleSaveToDrive(
              activeAnalysis?.organizedFolder || "Scribant Session",
              "Session Summary.md",
              activeAnalysis?.summary || "",
            )}
            savingDrive={savingDrive}
            isLiveAnalyzing={busy.plan}
          />
        </div>

        {/* Brain Dump Archive: moved all the way to the bottom of the screen */}
        <div id="brain-dump-archive-section" className="pt-6 border-t border-stone-200/65 space-y-4">
          {runs.length > 0 ? (
            <SessionHistory
              runs={runs}
              selectedRunId={selectedRunId}
              onSelectRun={setSelectedRunId}
            />
          ) : (
            <div className="bg-white/40 border border-stone-200/50 rounded-2xl p-5 text-center text-xs text-stone-400 italic">
              No past sessions yet. Record your thoughts to start building an archive.
            </div>
          )}
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

      {/* Humble aesthetic footer */}
      <footer className="border-t border-stone-200 bg-stone-50/50 py-4 text-center text-[10px] text-stone-400 uppercase tracking-widest font-mono" />

    </div>
  );
}
