import React, { useState, useEffect, useRef } from "react";
import { Mic, MicOff, HelpCircle, Keyboard, RefreshCw, Sparkles, FileText, SpellCheck, FolderPlus, ScreenShare, ScreenShareOff, Radio, Users, Copy, Lightbulb, X } from "lucide-react";
import MarkdownBullets from "./MarkdownBullets";
import { ProofResult } from "../types";
import { applyCorrections, preserveHead } from "../utils/transcript";
import {
  foldUtterances, spliceAddition, EMPTY_PARAGRAPH,
  type Utterance, type OpenParagraph,
} from "../utils/paragraphs";
import { useTabAudioCapture } from "../hooks/useTabAudioCapture";
import { readSttConfig } from "../hooks/useChunkedCapture";
import { useLiveCapture } from "../hooks/useLiveCapture";
import { useStickToBottom } from "../hooks/useStickToBottom";
import { useClickToEditCaret } from "../hooks/useClickToEditCaret";
import { usePreservedSelection } from "../hooks/usePreservedSelection";

// The capture cycle lives in App (one debounce timer → /api/live). This component owns the
// transcript and splices in proofread corrections; it receives finished
// stage results as props rather than fetching any of them itself.
interface AudioRecorderProps {
  onShowToast: (msg: string) => void;
  onChangeTranscript: (text: string) => void;
  liveSummary: string;
  proofResult: ProofResult | null;
  busy: { proof: boolean; summary: boolean; plan: boolean };
  onRunNow: () => void;
  onStopListening: () => void; // user turned the mic off — App proofreads the transcript once
  onSaveToDrive: () => void;  // saves the live notes into this session's Drive folder
  savingDrive: boolean;
  // The plan stage's condensed "Main Ideas". Rendered as a slide-out over the summary panel rather
  // than as its own card, so the two summaries sit in one place instead of two screens apart.
  mainIdeas: string;
  onSaveMainIdeasToDrive: () => void;
  // Bumped by App's "Clear All". A counter rather than a remount (`key`) on purpose: remounting
  // would tear down the recognizer and the shared-tab capture as a side effect, and capture only
  // ever stops when the user stops it.
  clearSignal: number;
}

// Copy + Save to Drive. Both the Bullet Point Summary header and the Main Ideas slide-out carry
// the same pair, differing only in what text they act on.
function PanelActions({ text, label, onSave, saving, onShowToast }: {
  text: string;
  label: string;
  onSave: () => void;
  saving: boolean;
  onShowToast: (msg: string) => void;
}) {
  const empty = !text.trim();
  return (
    <>
      <button
        type="button"
        onClick={() => {
          navigator.clipboard.writeText(text);
          onShowToast(`${label} copied to clipboard!`);
        }}
        disabled={empty}
        title={`Copy ${label.toLowerCase()} to the clipboard`}
        aria-label={`Copy ${label.toLowerCase()}`}
        className="text-stone-600 hover:text-amber-700 bg-stone-50 hover:bg-stone-100 border border-stone-200 rounded-md px-1.5 py-1 flex items-center disabled:opacity-40 transition-colors cursor-pointer"
      >
        <Copy className="w-3.5 h-3.5" />
      </button>
      <button
        type="button"
        onClick={onSave}
        disabled={saving || empty}
        title={`Save ${label.toLowerCase()} to a Google Drive folder for this session`}
        className="text-[11px] font-semibold text-stone-600 hover:text-amber-700 bg-stone-50 hover:bg-stone-100 border border-stone-200 rounded-md px-2 py-1 flex items-center gap-1 disabled:opacity-40 transition-colors cursor-pointer"
      >
        {saving ? (
          <RefreshCw className="w-3 h-3 animate-spin text-amber-600" />
        ) : (
          <FolderPlus className="w-3.5 h-3.5" />
        )}
        Save to Drive
      </button>
    </>
  );
}

declare global {
  interface Window {
    webkitSpeechRecognition: any;
    SpeechRecognition: any;
  }
}

// Maps a click point to a character offset in `container`'s rendered text, so click-to-edit lands
// the textarea cursor where the user clicked. The browser APIs return a DOM position, so this sums
// text-node lengths up to the hit. Speaker badges count too: they drop only the ": " of the raw
// "Speaker 1: " tag, so the drift is two characters per turn.
function caretOffsetFromPoint(x: number, y: number, container: Node): number | null {
  const doc = document as any;
  let node: Node | null = null;
  let localOffset = 0;
  if (doc.caretRangeFromPoint) {
    const range = doc.caretRangeFromPoint(x, y);
    if (!range) return null;
    node = range.startContainer;
    localOffset = range.startOffset;
  } else if (doc.caretPositionFromPoint) {
    const pos = doc.caretPositionFromPoint(x, y);
    if (!pos) return null;
    node = pos.offsetNode;
    localOffset = pos.offset;
  } else {
    return null; // unsupported browser — caller leaves the default cursor position alone
  }
  if (!container.contains(node)) return null;
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  let total = 0;
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n === node) return total + localOffset;
    total += (n.textContent || "").length;
  }
  return total;
}

const SPEAKER_COLORS = [
  "bg-indigo-50 text-indigo-800 border-indigo-200/90", "bg-emerald-50 text-emerald-800 border-emerald-200/90",
  "bg-amber-50 text-amber-800 border-amber-200/90", "bg-rose-50 text-rose-800 border-rose-200/90",
  "bg-purple-50 text-purple-800 border-purple-200/90",
];
function getSpeakerBadgeColor(label: string): string {
  const clean = label.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (clean.includes("you")) return "bg-sky-50 text-sky-800 border-sky-200/90";
  const n = Number(clean.match(/^(?:speaker)?([1-5])/)?.[1]);
  if (n) return SPEAKER_COLORS[n - 1];
  return clean.includes("meeting") ? "bg-stone-100 text-stone-800 border-stone-300" : "bg-stone-100 text-stone-800 border-stone-200";
}

// A "Speaker 2:", "You:", "Name:" or "[Meeting: x]" turn tag.
const SPEAKER_TAG = String.raw`\[(?:Meeting(?::\s*[^\]]+)?)\]|\b(?:Speaker\s*\d+|You|[A-Z][a-z]+):`;

// The mic and shared-tab toggles: a big round button with a caption under it.
function PulseButton({ id, active, onClick, title, Icon, ActiveIcon, caption, children }: {
  id: string; active: boolean; onClick: () => void; title?: string;
  Icon: typeof Mic; ActiveIcon: typeof Mic; caption: string; children?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center">
      <button
        id={id}
        onClick={onClick}
        title={title}
        className={`relative flex items-center justify-center w-20 h-20 rounded-full border transition-all duration-300 ${
          active
            ? "bg-red-50 border-red-200 text-red-650 shadow-md scale-105 animate-pulse"
            : "bg-stone-50 border-stone-200 text-stone-700 hover:bg-stone-100 hover:border-stone-300 shadow-sm"
        }`}
      >
        {active && <div className="absolute inset-0 rounded-full border border-red-500/20 wrapper-ping animate-ping" />}
        {active ? <ActiveIcon className="w-7 h-7" /> : <Icon className="w-7 h-7" />}
      </button>
      <p className="mt-3 text-[10px] font-semibold text-stone-500 text-center uppercase tracking-wider font-mono">{caption}</p>
      {children}
    </div>
  );
}

export default function AudioRecorder({
  onShowToast,
  onChangeTranscript,
  liveSummary,
  proofResult,
  busy,
  onRunNow,
  onStopListening,
  onSaveToDrive,
  savingDrive,
  mainIdeas,
  onSaveMainIdeasToDrive,
  clearSignal
}: AudioRecorderProps) {
  const [isListening, setIsListening] = useState(false);
  const [transcript, setTranscriptState] = useState("");
  // Appends (updater form) go through preserveHead so they can't eat leading whitespace the user
  // typed. Direct values (edit, clear, proofread splice) replace the string as-is.
  const setTranscript = React.useCallback((action: React.SetStateAction<string>) => {
    if (typeof action !== "function") return setTranscriptState(action);
    setTranscriptState(prev => preserveHead(prev, action(prev)));
  }, []);
  // The paragraph the next utterance joins or breaks from. A ref: advanced from async callbacks, never rendered.
  const openParagraphRef = useRef<OpenParagraph>(EMPTY_PARAGRAPH);

  // Every producer (Web Speech, mic Cloud STT, shared tab) appends here, so one rule set decides
  // line breaks. Folded outside the updater: React may run an updater twice, which would break twice.
  const appendUtterances = React.useCallback((utterances: Utterance[]) => {
    const { addition, open } = foldUtterances(openParagraphRef.current, utterances);
    if (!addition) return;
    openParagraphRef.current = open;
    setTranscript(prev => spliceAddition(prev, addition));
  }, [setTranscript]);

  const [interimTranscript, setInterimTranscript] = useState("");
  const [recognitionError, setRecognitionError] = useState<string | null>(null);
  const [useKeyboard, setUseKeyboard] = useState(false);
  const [tabAudioError, setTabAudioError] = useState<string | null>(null);

  const isDiarizationActive = () => readSttConfig().enableDiarization;

  // Latched when the mic starts. Reading the toggle live let a mid-session flip either drop every
  // final (ON, no capture running) or append everything twice (OFF, both running).
  const diarizingRef = useRef(false);

  // One capture session id for mic and tab, so speakers heard on either latch both. Not App's
  // orchestrator sessionId, which is nulled between runs.
  const captureSessionRef = useRef(`cap-${Date.now()}`);

  const micCapture = useLiveCapture({
    source: "stt",
    sourceTag: "mic",
    onChunk: ({ utterances }) => {
      appendUtterances(utterances);
      setInterimTranscript("");
    },
    // Cloud STT's own preview while streaming. It replaces Web Speech's, which is suppressed in
    // diarization mode, so the box is never blank while someone is mid-sentence.
    onInterim: text => setInterimTranscript(text),
    onNotice: msg => setTabAudioError(msg),
  });

  const ignoreSpeechResultsRef = useRef(false);

  // Desired state: the mic stays on until the user turns it off. Chrome ends sessions on its own
  // (silence, network, throttling), so onend restarts while this is true. Only the toggle and a
  // permission denial clear it.
  const shouldListenRef = useRef(false);

  // start() throws InvalidStateError while the old session is still tearing down; retry, don't give up.
  const restartTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const pumpRecognition = React.useCallback(() => {
    clearTimeout(restartTimerRef.current ?? undefined);
    restartTimerRef.current = null;
    if (!shouldListenRef.current) return;
    try {
      recognitionRef.current?.start();
    } catch {
      restartTimerRef.current = setTimeout(pumpRecognition, 300);
    }
  }, []);

  const [isEditingTranscript, setIsEditingTranscript] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const recognitionRef = useRef<any>(null);

  // Shared-tab capture is its own pipeline and only appends finished chunks to the same transcript.
  // ponytail: chunks land in completion order, not interleaved by timestamp with mic speech; keep
  // the transcript as tagged segments instead of one string if true ordering matters.
  const { isSharing: isSharingTab, start: startTabAudio, stop: stopTabAudio } = useTabAudioCapture({
    onChunk: ({ utterances }) => appendUtterances(utterances),
    onError: (msg) => setTabAudioError(msg),
    sessionId: captureSessionRef.current,
  });

  // Current values for the proofResult effect without re-running it on every append. Click-to-edit
  // only, not keyboard mode, or typed input would never be corrected.
  const transcriptRef = useRef("");
  const editingRef = useRef(false);
  transcriptRef.current = transcript;
  editingRef.current = isEditingTranscript;

  // Auto-apply a finished proofread, but only while its text is still the transcript's head;
  // after a mid-text edit the offsets are stale and splicing would drop what followed.
  useEffect(() => {
    if (!proofResult) return;
    const base = proofResult.text;
    const current = transcriptRef.current;
    if (!current.startsWith(base)) return;
    if (editingRef.current) return; // don't rewrite text out from under an active cursor

    const { text: corrected } = applyCorrections(base, proofResult.words || [], proofResult.corrections || []);
    if (corrected !== base) setTranscript(corrected + current.slice(base.length));
  }, [proofResult]);

  const { captureClick, isPending } = useClickToEditCaret(
    textareaRef,
    isEditingTranscript && !useKeyboard,
    caretOffsetFromPoint
  );

  // Speech can append mid-edit; keep the cursor on its character.
  const markLocalEdit = usePreservedSelection(textareaRef, transcript, { skip: isPending });

  // Pin panels to their newest content (keyed on length: only growth matters).
  const transcriptScrollRef = useStickToBottom<HTMLDivElement>(transcript.length + interimTranscript.length);
  const summaryScrollRef = useStickToBottom<HTMLDivElement>(liveSummary.length);
  const interimScrollRef = useStickToBottom<HTMLDivElement>(interimTranscript.length);

  // Main Ideas is absolutely positioned inside the summary panel, not a native popover: a popover's
  // containing block is the viewport, so it couldn't size or clip to the panel.
  const [showMainIdeas, setShowMainIdeas] = useState(false);
  const mainIdeasRef = useRef<HTMLDivElement>(null);
  const mainIdeasBtnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!showMainIdeas) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      // The toggle is excluded so its own click doesn't close and reopen in the same gesture.
      if (!mainIdeasRef.current?.contains(t) && !mainIdeasBtnRef.current?.contains(t)) setShowMainIdeas(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setShowMainIdeas(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [showMainIdeas]);

  // Notify parent of transcript modifications (include interim text for real-time live analysis)
  useEffect(() => {
    onChangeTranscript((transcript + " " + interimTranscript).trim());
  }, [transcript, interimTranscript, onChangeTranscript]);

  useEffect(() => {
    // Check for browser support
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      setRecognitionError("Web Speech Recognition API is not supported in this browser. Please type your thoughts below instead!");
      setUseKeyboard(true);
      return;
    }

    const rec = new SpeechRecognition();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = "en-US";

    rec.onstart = () => {
      if (!shouldListenRef.current) {
        try { rec.abort(); } catch {}
        setIsListening(false);
        return;
      }
      ignoreSpeechResultsRef.current = false;
      setIsListening(true);
      setRecognitionError(null);
    };

    rec.onresult = (event: any) => {
      if (ignoreSpeechResultsRef.current || !shouldListenRef.current) return;

      const results = Array.from(event.results as ArrayLike<any>).slice(event.resultIndex);
      const join = (final: boolean) => results.filter(r => r.isFinal === final).map(r => r[0].transcript).join(" ").replace(/\s+/g, " ").trim();
      const finalStr = join(true);
      const interimStr = join(false);

      if (diarizingRef.current) {
        // Cloud STT owns the transcript; Web Speech is only a preview, and only for the chunked
        // transport (streaming sends its own interims, and two writers would fight).
        if (micCapture.mode() !== "streaming") setInterimTranscript(`${finalStr} ${interimStr}`.trim());
        return;
      }

      // No speaker label: the mic is one person, so finals flow together as narration.
      if (finalStr) appendUtterances([{ text: finalStr, source: "speech" }]);
      setInterimTranscript(interimStr);
    };

    rec.onerror = (event: any) => {
      // User-initiated stops abort; no-speech is just a quiet stretch that onend restarts.
      if (!shouldListenRef.current || event.error === "aborted" || event.error === "no-speech") return;
      if (event.error === "not-allowed" || event.error === "service-not-allowed" || event.error === "audio-capture") {
        console.error("Speech recognition error:", event.error);
        shouldListenRef.current = false;
        setIsListening(false);
        setRecognitionError("Microphone access denied. Please grant microphone permissions or type your thoughts below!");
      } else {
        console.warn("Speech recognition error (recovering):", event.error); // onend restarts
      }
    };

    rec.onend = () => {
      // A silence-triggered end lands here too; restarting is how the mic survives a quiet stretch.
      if (!shouldListenRef.current) {
        setIsListening(false);
        return;
      }
      pumpRecognition();
    };

    recognitionRef.current = rec;

    return () => {
      clearTimeout(restartTimerRef.current ?? undefined);
      if (recognitionRef.current) {
        shouldListenRef.current = false;
        try { recognitionRef.current.abort(); } catch {}
      }
    };
  }, [pumpRecognition]);

  // Stop tab capture on unmount. Through a ref with [] deps: stopTabAudio is new every render, and
  // depending on it stopped the capture the instant it started.
  const stopTabAudioRef = useRef(stopTabAudio);
  stopTabAudioRef.current = stopTabAudio;
  useEffect(() => () => stopTabAudioRef.current(), []);

  const handleToggleTabAudio = () => {
    setTabAudioError(null);
    if (isSharingTab) stopTabAudio();
    else startTabAudio();
  };

  const handleToggleListening = async () => {
    if (isListening || shouldListenRef.current) {
      // Clear the flag first so an in-flight restart bails, then cancel any pending retry.
      shouldListenRef.current = false;
      clearTimeout(restartTimerRef.current ?? undefined);
      restartTimerRef.current = null;
      setIsListening(false);
      setInterimTranscript("");
      try {
        recognitionRef.current?.abort();
      } catch {
        try { recognitionRef.current?.stop(); } catch {}
      }
      micCapture.stop();
      onStopListening();
    } else {
      shouldListenRef.current = true;
      ignoreSpeechResultsRef.current = false;
      setRecognitionError(null);
      setIsEditingTranscript(false);
      setIsListening(true);

      diarizingRef.current = isDiarizationActive();
      if (diarizingRef.current) {
        try {
          const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
          micCapture.start(stream, captureSessionRef.current);
        } catch (err: any) {
          diarizingRef.current = false; // no stream: let Web Speech finals land instead
          console.warn("[mic-capture] Failed to get mic stream for diarization:", err);
        }
      }

      setInterimTranscript("");
      pumpRecognition();
    }
  };

  // Clearing text never stops the mic or tab capture.
  const resetTranscriptState = React.useCallback(() => {
    setTranscript("");
    openParagraphRef.current = EMPTY_PARAGRAPH;
    setInterimTranscript("");
    setIsEditingTranscript(false);
  }, [setTranscript]);

  useEffect(() => { resetTranscriptState(); }, [clearSignal, resetTranscriptState]);

  // Render the transcript as speaker turns when it has tags, else as paragraphs.
  const renderSpeakerText = (text: string) => {
    if (!text || !text.trim()) return null;

    if (!new RegExp(SPEAKER_TAG).test(text)) {
      const paragraphs = text.split(/\n\s*\n|\n/);
      return (
        <div className="space-y-2.5">
          {paragraphs.map((p, pIdx) => {
            const trimmed = p.trim();
            if (!trimmed) return null;
            return (
              <p key={pIdx} className="leading-relaxed text-stone-750 font-sans">
                {trimmed}
              </p>
            );
          })}
        </div>
      );
    }

    const rawTurns = text.split(new RegExp(`(?=(?:${SPEAKER_TAG}))`, "g"));

    return (
      <div className="space-y-3">
        {rawTurns.map((turn, tIdx) => {
          const trimmed = turn.trim();
          if (!trimmed) return null;

          const match = trimmed.match(new RegExp(`^(${SPEAKER_TAG})\\s*(.*)$`, "s"));
          if (match) {
            const rawTag = match[1];
            const speakerLabel = rawTag.replace(/^\[|\]$/g, "").replace(/:$/, "").trim();
            const utterance = match[2];
            const badgeColor = getSpeakerBadgeColor(speakerLabel);

            return (
              <div key={tIdx} className="flex items-start gap-2.5">
                <span className={`inline-flex items-center gap-1 text-[10px] font-bold font-mono px-2 py-0.5 rounded-md border shrink-0 select-none shadow-2xs mt-0.5 ${badgeColor}`}>
                  <Users className="w-2.5 h-2.5 opacity-70" />
                  <span>{speakerLabel}</span>
                </span>
                <span className="text-xs text-stone-750 leading-relaxed font-sans flex-1">
                  {utterance}
                </span>
              </div>
            );
          }

          return (
            <div key={tIdx} className="text-xs text-stone-750 leading-relaxed font-sans">
              {trimmed}
            </div>
          );
        })}
      </div>
    );
  };

  return (
    <div id="audio-recorder-panel" className="bg-white border border-stone-200 rounded-2xl p-6 pb-2 shadow-sm transition-all hover:shadow-md">
      <div className="flex items-center justify-between mb-4 pb-3 border-b border-stone-100">
        <div className="flex items-center gap-2">
          <div className={`w-2.5 h-2.5 rounded-full ${isListening ? 'bg-emerald-500 animate-pulse' : 'bg-amber-400'}`} />
          <h2 className="text-sm font-semibold text-stone-800 tracking-tight font-sans">
            {isListening ? "Listening to your thoughts..." : "Capture your thoughts"}
          </h2>
        </div>
      </div>

      {[recognitionError, tabAudioError].map((msg, i) => msg && (
        <div key={i} className="mb-4 text-xs bg-amber-50 text-amber-800 border border-amber-100 rounded-xl p-3.5 leading-relaxed flex items-start gap-2">
          <HelpCircle className="w-4 h-4 shrink-0 text-amber-600 mt-0.5" />
          <span>{msg}</span>
        </div>
      ))}

      <div className="flex flex-col items-center justify-center py-4 border-b border-stone-100/75 mb-4">
          <div className="flex items-center justify-center gap-6">
            {!useKeyboard && (
              <PulseButton id="mic-pulse-button" active={isListening} onClick={handleToggleListening} Icon={Mic} ActiveIcon={MicOff}
                caption={isListening ? "Click to Pause Speech Capture" : "Click to Speak Thoughts"}>
                {isDiarizationActive() && (
                  <span className="mt-1 px-2 py-0.5 rounded-full bg-indigo-50 border border-indigo-200/80 text-indigo-700 text-[9px] font-mono font-bold flex items-center gap-1">
                    <Radio className={`w-2.5 h-2.5 text-indigo-600 ${isListening ? "animate-pulse" : ""}`} />
                    <span>Diarization Active</span>
                  </span>
                )}
              </PulseButton>
            )}

            {typeof navigator.mediaDevices?.getDisplayMedia === "function" && (
              <PulseButton id="tab-audio-share-button" active={isSharingTab} onClick={handleToggleTabAudio} Icon={ScreenShare} ActiveIcon={ScreenShareOff}
                title={isSharingTab ? "Stop capturing the shared tab's audio" : "Share a Chrome tab (e.g. a meeting) and transcribe its audio too"}
                caption={isSharingTab ? "Click to Stop Tab Capture" : "Click to Share Tab Audio"} />
            )}
          </div>
        </div>

      {/* Grid containing Input/Transcript on the left, Summarized Notes on the right */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-5 mb-2">
        
        {/* Left Column: Input Box (Live Transcript or Textarea) */}
        <div className="border border-stone-200 bg-stone-50/20 rounded-xl px-4 pt-2.5 pb-3 flex flex-col h-[400px] space-y-2.5">
          <div className="flex items-center justify-between border-b border-stone-100 pb-2">
            <div className="flex items-center gap-1.5">
              {useKeyboard || isEditingTranscript ? (
                <Keyboard className="w-3.5 h-3.5 text-stone-500" />
              ) : (
                <FileText className="w-3.5 h-3.5 text-stone-500" />
              )}
              <span className="text-xs font-bold text-stone-700 uppercase tracking-widest font-mono">
                {useKeyboard || isEditingTranscript ? "Editable Input Text" : "Live Transcript"}
              </span>
            </div>
            <div className="flex items-center gap-2">
              {!useKeyboard && (
                <button
                  type="button"
                  onClick={onRunNow}
                  disabled={busy.proof || !transcript.trim()}
                  title="Run the live pipeline now — proofread, summary and draft actions"
                  className="p-1 text-stone-500 hover:text-amber-700 hover:bg-stone-100 rounded transition-colors disabled:opacity-40 cursor-pointer"
                >
                  {busy.proof ? (
                    <RefreshCw className="w-3.5 h-3.5 animate-spin text-amber-600" />
                  ) : (
                    <SpellCheck className="w-3.5 h-3.5" />
                  )}
                </button>
              )}
              {!useKeyboard && isListening && (
                <span className="text-[9px] font-medium text-emerald-600 bg-emerald-50 border border-emerald-150 px-1.5 py-0.5 rounded animate-pulse">
                  Active Listening
                </span>
              )}
            </div>
          </div>
          
          <div className="flex-1 flex flex-col min-h-0">
            {useKeyboard || isEditingTranscript ? (
              <>
                {/* No autoFocus — useClickToEditCaret owns focus (see that hook for why).
                    Type scale, line height and right padding must stay identical to the
                    read-only div below, or the text visibly reflows the instant you click in. */}
                <textarea
                  id="type-thoughts-textarea"
                  ref={textareaRef}
                  value={transcript}
                  onChange={(e) => { markLocalEdit(); setTranscript(e.target.value); }}
                  onBlur={() => setIsEditingTranscript(false)}
                  placeholder="Write down whatever is on your mind. For example:&#10;'Today was busy, but good. I got a lot done on the product roadmap and Alice and I will meet tomorrow at 2 to discuss it. I need to make a mockup before it. Also, remember to grab more coffee beans on the way home.'"
                  className="w-full flex-1 bg-transparent border-0 py-0 pl-0 pr-1 text-xs text-stone-700 leading-relaxed focus:ring-0 outline-none resize-none font-sans"
                />
                {/* Read-only, not inside the textarea: in there interim words would be editable
                    and would get committed as real text before the recognizer finalized them. */}
                {isListening && interimTranscript && (
                  <div
                    ref={interimScrollRef}
                    className="shrink-0 pt-1 max-h-20 overflow-y-auto text-[11px] text-amber-500 italic animate-pulse"
                  >
                    {interimTranscript}
                  </div>
                )}
              </>
            ) : (
              <div
                ref={transcriptScrollRef}
                onClick={(e) => {
                  // Editing while the mic is live is supported — don't reintroduce an
                  // isListening guard here.
                  captureClick(e, !!(transcript || interimTranscript));
                  setIsEditingTranscript(true);
                }}
                className="w-full flex-1 overflow-y-auto text-xs text-stone-700 leading-relaxed font-sans cursor-text whitespace-pre-wrap pr-1"
                title="Click anywhere to edit transcript text"
              >
                {(transcript || interimTranscript) ? (
                  <div className="leading-relaxed font-sans text-stone-750">
                    {renderSpeakerText(transcript)}
                    {/* Deliberately uncapped: the whole in-flight utterance stays readable and
                        useStickToBottom on the scroll container follows it down as it wraps.
                        ponytail: in diarization mode interimTranscript is finalStr + interimStr
                        and grows until Cloud STT's authoritative turn lands, so a long preview
                        can push the finalized transcript out of view. Cap it like the edit-mode
                        strip (max-h + overflow-y-auto) if that becomes annoying. */}
                    {interimTranscript && (
                      <div className="mt-2 text-[11px] text-amber-600 italic font-medium animate-pulse flex items-start gap-1.5 bg-amber-50/70 p-1.5 rounded-lg border border-amber-200/60">
                        <Radio className="w-3 h-3 mt-0.5 text-amber-500 animate-spin shrink-0" />
                        <span>{interimTranscript}...</span>
                      </div>
                    )}
                  </div>
                ) : (
                  <span className="text-stone-400 italic font-sans leading-normal">
                    No thoughts captured yet. Click the microphone below to start speaking or click anywhere to type.
                  </span>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Right Column: AI Live Summarized Notes, with Main Ideas sliding out over it. */}
        <div className="relative overflow-hidden border border-stone-200 bg-stone-50/20 rounded-xl px-4 pt-2.5 pb-3 flex flex-col h-[400px] space-y-2.5">
          <div className="flex items-center justify-between border-b border-stone-100 pb-2">
            <div className="flex items-center gap-1.5">
              <Sparkles className="w-3.5 h-3.5 text-amber-500" />
              <span className="text-xs font-bold text-stone-700 uppercase tracking-widest font-mono">
                Bullet Point Summary
              </span>
            </div>
            
            <div className="flex items-center gap-2">
              <PanelActions
                text={liveSummary}
                label="Summarized live notes"
                onSave={onSaveToDrive}
                saving={savingDrive}
                onShowToast={onShowToast}
              />
              <button
                ref={mainIdeasBtnRef}
                type="button"
                onClick={() => setShowMainIdeas(v => !v)}
                disabled={!mainIdeas.trim()}
                aria-expanded={showMainIdeas}
                title="Show the condensed Main Ideas for this session"
                className={`text-[11px] font-semibold border rounded-md px-2 py-1 flex items-center gap-1 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed ${
                  showMainIdeas
                    ? "bg-amber-600 text-white border-amber-600"
                    : "text-stone-600 hover:text-amber-700 bg-stone-50 hover:bg-stone-100 border-stone-200"
                }`}
              >
                <Lightbulb className="w-3.5 h-3.5" />
                Show Main Points
              </button>
            </div>
          </div>

          <div
            ref={summaryScrollRef}
            className={`flex-1 overflow-y-auto pr-1 transition-opacity ${showMainIdeas ? "opacity-40" : ""}`}
          >
            {liveSummary ? (
              <MarkdownBullets text={liveSummary} />
            ) : (
              <div className="text-stone-400 italic text-[11px] h-full flex flex-col justify-center items-center text-center px-4 leading-normal">
                {busy.summary ? (
                  <span className="flex items-center gap-2 text-stone-500 font-medium animate-pulse">
                    <RefreshCw className="w-4 h-4 animate-spin text-amber-500" /> Creating bullet points...
                  </span>
                ) : (
                  <>
                    <span>No summarized notes yet.</span>
                    <span className="mt-1 text-[10px] text-stone-400 font-light">Notes will auto-generate periodically as you speak or type.</span>
                  </>
                )}
              </div>
            )}
          </div>
          
          {liveSummary && (
            <div className={`pt-2 border-t border-stone-150/70 flex items-center text-[9px] text-stone-400 font-mono transition-opacity ${showMainIdeas ? "opacity-40" : ""}`}>
              <span className="flex items-center gap-1">
                <div className={`w-1.5 h-1.5 rounded-full ${busy.summary ? 'bg-amber-400 animate-pulse' : 'bg-stone-300'}`} />
                {busy.summary ? "Updating bullets..." : "Notes synchronized"}
              </span>
            </div>
          )}

          {/* Main Ideas. Always mounted so it can slide rather than pop; parked off-canvas and
              click-through while stowed. */}
          <div
            ref={mainIdeasRef}
            aria-hidden={!showMainIdeas}
            className={`absolute top-0 right-0 h-full w-[85%] z-20 bg-white border-l border-stone-200 shadow-xl rounded-r-xl px-4 pt-2.5 pb-3 flex flex-col space-y-2.5 transition-transform duration-200 ease-out ${
              showMainIdeas ? "translate-x-0" : "translate-x-full pointer-events-none"
            }`}
          >
            <div className="flex items-center justify-between border-b border-stone-100 pb-2">
              <div className="flex items-center gap-1.5">
                <Lightbulb className="w-3.5 h-3.5 text-amber-500" />
                <span className="text-xs font-bold text-stone-700 uppercase tracking-widest font-mono">
                  Main Ideas
                </span>
              </div>
              <div className="flex items-center gap-2">
                <PanelActions
                  text={mainIdeas}
                  label="Main ideas"
                  onSave={onSaveMainIdeasToDrive}
                  saving={savingDrive}
                  onShowToast={onShowToast}
                />
                <button
                  type="button"
                  onClick={() => setShowMainIdeas(false)}
                  title="Hide main points"
                  aria-label="Hide main points"
                  className="text-stone-500 hover:text-stone-800 bg-stone-50 hover:bg-stone-100 border border-stone-200 rounded-md px-1.5 py-1 flex items-center transition-colors cursor-pointer"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto pr-1">
              {mainIdeas.trim() ? (
                <MarkdownBullets text={mainIdeas} />
              ) : (
                <div className="text-stone-400 italic text-[11px] h-full flex flex-col justify-center items-center text-center px-4 leading-normal">
                  <span>No main ideas yet.</span>
                  <span className="mt-1 text-[10px] text-stone-400 font-light">They are distilled from the session once there is enough to condense.</span>
                </div>
              )}
            </div>
          </div>
        </div>

      </div>

      {/* Control Buttons */}
      <div className="flex items-center justify-end gap-2.5 mt-1.5">
        <button
          onClick={resetTranscriptState}
          disabled={!(transcript || interimTranscript).trim()}
          title="Clear the transcript. Does not stop the microphone or tab capture."
          className="px-2 py-0.5 text-[10px] font-semibold text-stone-500 hover:text-stone-800 hover:bg-stone-100 rounded-md transition-colors border border-stone-200/50 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:text-stone-500 disabled:hover:bg-transparent"
        >
          Clear Text
        </button>
      </div>
    </div>
  );
}
