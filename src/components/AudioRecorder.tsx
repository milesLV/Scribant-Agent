import React, { useState, useEffect, useRef } from "react";
import { Mic, MicOff, Send, HelpCircle, Keyboard, RefreshCw, Sparkles, FileText, SpellCheck, FolderPlus, ScreenShare, ScreenShareOff, Radio, Users, Copy, Lightbulb, X } from "lucide-react";
import MarkdownBullets from "./MarkdownBullets";
import { Word, ProofResult } from "../types";
import { applyCorrections, preserveHead, CONFIDENCE_THRESHOLD } from "../utils/transcript";
import {
  foldUtterances, spliceAddition, toUtterances, EMPTY_PARAGRAPH,
  type Utterance, type OpenParagraph,
} from "../utils/paragraphs";
import { useTabAudioCapture } from "../hooks/useTabAudioCapture";
import { useChunkedCapture, readSttConfig } from "../hooks/useChunkedCapture";
import { useStickToBottom } from "../hooks/useStickToBottom";
import { useClickToEditCaret } from "../hooks/useClickToEditCaret";
import { usePreservedSelection } from "../hooks/usePreservedSelection";

// The capture cycle lives in App (one debounce timer → /api/live). This component owns the
// transcript and the correction-splicing that keeps highlight offsets valid; it receives finished
// stage results as props rather than fetching any of them itself.
interface AudioRecorderProps {
  onAnalyze: (text: string) => void;
  isProcessing: boolean;
  onShowToast: (msg: string) => void;
  onChangeTranscript: (text: string) => void;
  liveSummary: string;
  proofResult: ProofResult | null;
  busy: { proof: boolean; summary: boolean; plan: boolean };
  onRunNow: () => void;
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

// Marks a subtree as NOT part of the transcript string. caretOffsetFromPoint sums text nodes to
// derive a string index, so non-transcript text rendered BEFORE the end — a correction-chip
// popover, a speaker badge — must carry `data-transcript-text="false"`, or every click after it
// lands too far right by that text's length. Interim speech needs no marker: it renders last, so
// an offset inside it already exceeds transcript.length and gets clamped by the caller.
const NON_TRANSCRIPT_ATTR = "data-transcript-text";

// Maps a click point to a character offset in `container`'s rendered text, so switching from the
// read-only view to a textarea can land the cursor where the user actually clicked instead of at 0 —
// caretRangeFromPoint/caretPositionFromPoint give a DOM position, not a string index, so this walks
// every text node in document order and sums lengths up to the hit.
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
  const excluded = (n: Node): boolean => {
    for (let el = n.parentElement; el && el !== container; el = el.parentElement) {
      if (el.getAttribute(NON_TRANSCRIPT_ATTR) === "false") return true;
    }
    return false;
  };
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  let total = 0;
  let n: Node | null;
  while ((n = walker.nextNode())) {
    if (n === node) return excluded(n) ? total : total + localOffset;
    if (!excluded(n)) total += (n.textContent || "").length;
  }
  return total;
}

// Maps speaker label strings to distinct badge color styles
function getSpeakerBadgeColor(label: string): string {
  const clean = label.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (clean.includes("you")) return "bg-sky-50 text-sky-800 border-sky-200/90";
  if (clean.includes("speaker1") || clean === "1") return "bg-indigo-50 text-indigo-800 border-indigo-200/90";
  if (clean.includes("speaker2") || clean === "2") return "bg-emerald-50 text-emerald-800 border-emerald-200/90";
  if (clean.includes("speaker3") || clean === "3") return "bg-amber-50 text-amber-800 border-amber-200/90";
  if (clean.includes("speaker4") || clean === "4") return "bg-rose-50 text-rose-800 border-rose-200/90";
  if (clean.includes("speaker5") || clean === "5") return "bg-purple-50 text-purple-800 border-purple-200/90";
  if (clean.includes("meeting")) return "bg-stone-100 text-stone-800 border-stone-300";
  return "bg-stone-100 text-stone-800 border-stone-200";
}

export default function AudioRecorder({
  onAnalyze,
  isProcessing,
  onShowToast,
  onChangeTranscript,
  liveSummary,
  proofResult,
  busy,
  onRunNow,
  onSaveToDrive,
  savingDrive,
  mainIdeas,
  onSaveMainIdeasToDrive,
  clearSignal
}: AudioRecorderProps) {
  const [isListening, setIsListening] = useState(false);
  const [transcript, setTranscriptState] = useState("");
  // See preserveHead: producers append via the updater form and all start with `prev.trim()`,
  // which eats leading whitespace the user typed. Guard it here instead of in each producer —
  // they sit in the block other branches rewrite, and there are several of them. A direct-value
  // call (user edit, clear, proofread splice) replaces the string wholesale and is left alone.
  const setTranscript = React.useCallback((action: React.SetStateAction<string>) => {
    if (typeof action !== "function") return setTranscriptState(action);
    setTranscriptState(prev => preserveHead(prev, action(prev)));
  }, []);
  // The paragraph the next utterance will either join or break away from. A ref rather than state:
  // it is advanced from inside async chunk handlers and the speech callback, and nothing rendered
  // reads it. Cleared alongside the transcript in resetTranscriptState.
  const openParagraphRef = useRef<OpenParagraph>(EMPTY_PARAGRAPH);

  // EVERY producer — Web Speech, the mic's Cloud STT chunks, and shared-tab audio — appends through
  // here and nowhere else, so exactly one rule set decides where a line ends (see utils/paragraphs).
  // Separators are resolved BEFORE the state updater runs: React may invoke an updater more than
  // once, and advancing openParagraphRef inside one would apply each break twice.
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

  // One reader for the diarization toggle, shared with both capture paths — this used to be a
  // third local copy with its own default.
  const isDiarizationActive = () => readSttConfig().enableDiarization;

  // ONE capture session id for both the mic and the shared tab, so a two-speaker exchange heard on
  // either one latches the session for both. It is deliberately NOT App's orchestrator sessionId,
  // which is nulled between runs and would drop the latch mid-conversation.
  const captureSessionRef = useRef(`cap-${Date.now()}`);

  const micCapture = useChunkedCapture({
    source: "stt",
    sourceTag: "mic",
    onChunk: ({ utterances }) => {
      appendUtterances(utterances);
      setInterimTranscript("");
    },
    onDegraded: p => setTabAudioError(`Diarization unavailable — transcribed with ${p} instead, speakers may be merged.`),
  });

  // Ref to block recognition results after a clear signal
  const ignoreSpeechResultsRef = useRef(false);

  // Persistent desired listening state. Web Speech stops itself on silence; we auto-restart only if shouldListenRef is true.
  const shouldListenRef = useRef(false);

  // The mic stays on until the USER turns it off. Chrome ends a SpeechRecognition session on its
  // own all the time — a long silence, an internal `no-speech`/`network` hiccup, a tab throttle —
  // and a bare rec.start() inside onend throws InvalidStateError if the engine hasn't finished
  // tearing the old session down. The previous code treated that throw as "give up", which is
  // exactly the silent shutoff we're eliminating: retry with backoff instead, and never clear
  // shouldListenRef here. Only handleToggleListening and a genuine permission denial clear it.
  const restartTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const pumpRecognition = React.useCallback(() => {
    clearTimeout(restartTimerRef.current ?? undefined);
    restartTimerRef.current = null;
    if (!shouldListenRef.current) return;
    try {
      recognitionRef.current?.start();
    } catch {
      // InvalidStateError just means "already starting/running" — the session is coming back, so
      // re-check shortly rather than tearing the desired state down. One tick is enough.
      restartTimerRef.current = setTimeout(pumpRecognition, 300);
    }
  }, []);

  const [isEditingTranscript, setIsEditingTranscript] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Misheard-word proofread state. `words` are scored against the exact text in proofedTextRef
  // (offsets index into it), so corrections splice safely even as the live transcript moves on.
  const [words, setWords] = useState<Word[] | null>(null);
  const [activeChip, setActiveChip] = useState<number | null>(null);
  const proofedTextRef = useRef("");

  const recognitionRef = useRef<any>(null);

  // Shared-tab capture is entirely separate from the mic's Web Speech pipeline above — its own
  // record/upload/transcribe loop (see the hook) — and only ever APPENDS finished chunks onto the
  // same transcript the mic is building, tagged so they read as a distinct source. Chunks land
  // roughly in completion order (~9s apart), not precisely interleaved by timestamp against
  // concurrent mic speech — good enough for an MVP; true chronological interleaving would need the
  // transcript to be a list of tagged segments instead of one flat string. Chunks now arrive AS
  // tagged segments (see toUtterances), but they are still flattened on append, so ordering is
  // unchanged — the segments exist to decide paragraph breaks, not yet to reorder anything.
  const { isSharing: isSharingTab, start: startTabAudio, stop: stopTabAudio } = useTabAudioCapture({
    onChunk: ({ utterances }) => appendUtterances(utterances),
    onError: (msg) => setTabAudioError(msg),
    sessionId: captureSessionRef.current,
  });

  // Read during the proofResult effect, which must see CURRENT values without re-running every time
  // speech appends or the editor toggles. Assigned in render so they are never a frame stale.
  const transcriptRef = useRef("");
  const editingRef = useRef(false);
  transcriptRef.current = transcript;
  // Click-to-edit only, not keyboard mode — gating on `useKeyboard` too would mean typed input
  // never gets corrected at all.
  editingRef.current = isEditingTranscript;

  // A finished proofread stage arrived: auto-apply the obvious fixes and keep the ambiguous flags,
  // offsets shifted to match. `proofResult.text` is what was scored and must still be the HEAD of
  // the transcript — a mid-text edit invalidates every offset, and splicing anyway would swap in a
  // stale corrected copy, silently discarding whatever came after it.
  useEffect(() => {
    if (!proofResult) return;
    const base = proofResult.text;
    const current = transcriptRef.current;
    if (!current.startsWith(base)) return;
    if (editingRef.current) return; // don't rewrite text out from under an active cursor

    const { text: corrected, words: flags } = applyCorrections(base, proofResult.words || [], proofResult.corrections || []);
    proofedTextRef.current = corrected;
    if (corrected !== base) setTranscript(corrected + current.slice(base.length));
    setWords(flags.length ? flags : null);
    setActiveChip(null);
  }, [proofResult]);

  // The textarea replaces the read-only view (click-to-edit) — land the cursor AND the scroll
  // position where the click actually landed, instead of wherever a fresh element defaults to.
  const { captureClick, isPending } = useClickToEditCaret(
    textareaRef,
    isEditingTranscript && !useKeyboard,
    caretOffsetFromPoint
  );

  // Editing is allowed while the mic is live, so speech can append to `transcript` mid-edit.
  // Keep the user's cursor pinned to the character it was on when that happens.
  const markLocalEdit = usePreservedSelection(textareaRef, transcript, { skip: isPending });

  // Keep the transcript and live-summary panels pinned to their latest content as it streams in,
  // pausing while the user scrolls up to read and resuming 5s after they stop interacting.
  // Keyed on length, not content: only growth matters, and a number compares in O(1).
  const transcriptScrollRef = useStickToBottom<HTMLDivElement>(transcript.length + interimTranscript.length);
  const summaryScrollRef = useStickToBottom<HTMLDivElement>(liveSummary.length);

  // Main Ideas slides out over the summary panel. It is absolutely positioned inside that panel so
  // it can be sized against it (85% of its width, its exact height), which rules out the native
  // popover used elsewhere in the app: a popover lives in the top layer, where its containing block
  // is the viewport and neither the sizing nor the clipping would follow the panel.
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

  // Swap a misheard word for one of its suggestions. Splice into the proofed text and shift every
  // later word's offsets by the length delta, so the OTHER highlights survive the edit intact.
  const correctWord = (i: number, replacement: string) => {
    if (!words) return;
    const w = words[i];
    const base = proofedTextRef.current;
    const delta = replacement.length - (w.end - w.start);
    const newBase = base.slice(0, w.start) + replacement + base.slice(w.end);
    const tail = transcript.startsWith(base) ? transcript.slice(base.length) : "";
    const newWords = words.map((x, j) => {
      if (j === i) return { ...x, text: replacement, end: x.start + replacement.length, confidence: 1, alternatives: undefined };
      if (j > i) return { ...x, start: x.start + delta, end: x.end + delta };
      return x;
    });
    proofedTextRef.current = newBase;
    setWords(newWords);
    setTranscript(newBase + tail);
    setActiveChip(null);
  };

  // "It's fine" — keep the word as transcribed and clear its highlight.
  const keepWord = (i: number) => {
    setWords(ws => ws ? ws.map((w, j) => j === i ? { ...w, confidence: 1 } : w) : ws);
    setActiveChip(null);
  };

  // Scores stay valid as long as the proofed text is still the HEAD of the transcript — appends
  // (new speech) keep the existing highlights; only a mid-text edit invalidates them.
  useEffect(() => {
    if (words && proofedTextRef.current && !transcript.startsWith(proofedTextRef.current)) {
      setWords(null);
      setActiveChip(null);
    }
  }, [transcript, words]);

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

      let finalStr = "";
      let interimStr = "";
      
      for (let i = event.resultIndex; i < event.results.length; ++i) {
        const result = event.results[i];
        const text = result[0].transcript;

        if (result.isFinal) {
          finalStr += text + " ";
        } else {
          interimStr += text + " ";
        }
      }

      if (isDiarizationActive()) {
        // In Diarization mode: Web Speech provides instant live typing preview,
        // while Cloud STT V2 provides authoritative diarized turns into transcript.
        const preview = (finalStr + " " + interimStr).replace(/\s+/g, " ").trim();
        setInterimTranscript(preview);
        return;
      }

      if (finalStr) {
        // No speaker label: the mic is one person, so consecutive finals read as continuous
        // narration and flow together until a structural rule or the length cap breaks them.
        appendUtterances([{ text: finalStr.replace(/\s+/g, " ").trim(), source: "speech" }]);
      }

      setInterimTranscript(interimStr.replace(/\s+/g, " ").trim());
    };

    rec.onerror = (event: any) => {
      // If the user intentionally stopped/aborted speech recognition, suppress the expected error
      if (!shouldListenRef.current || event.error === "aborted") {
        return;
      }
      console.error("Speech recognition error:", event.error);
      if (event.error === "not-allowed" || event.error === "service-not-allowed" || event.error === "audio-capture") {
        shouldListenRef.current = false;
        setIsListening(false);
        setRecognitionError("Microphone access denied. Please grant microphone permissions or type your thoughts below!");
      } else if (event.error === "no-speech") {
        // A quiet stretch is not a stop. Chrome fires this then ends the session; onend pumps it
        // back up, so don't surface an error the user would read as "the mic died".
      } else {
        // network/aborted-by-engine and friends: keep the desired state, let onend restart.
        console.warn("Speech recognition error (recovering):", event.error);
      }
    };

    rec.onend = () => {
      // Auto-restart only if the user explicitly wants to keep listening. A silence-triggered end
      // lands here too, so restarting is the whole reason the mic survives a quiet stretch.
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

  // Unmounting (recorderKey bump on Clear All, in App.tsx) must tear down the shared-tab capture the
  // same way the mic recognizer does above — otherwise the browser keeps recording/uploading a tab
  // that's no longer wired to anything on screen.
  useEffect(() => () => stopTabAudio(), [stopTabAudio]);

  const handleToggleTabAudio = () => {
    setTabAudioError(null);
    if (isSharingTab) stopTabAudio();
    else startTabAudio();
  };

  const handleToggleListening = async () => {
    if (isListening || shouldListenRef.current) {
      // User-initiated stop — the one and only way the mic goes quiet. Clear the desired-state flag
      // FIRST so a restart already in flight sees it and bails, then cancel any pending retry.
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
    } else {
      shouldListenRef.current = true;
      ignoreSpeechResultsRef.current = false;
      setRecognitionError(null);
      setIsEditingTranscript(false);
      setIsListening(true);

      // Start the rolling Cloud STT window if Diarization mode is active
      if (isDiarizationActive()) {
        try {
          const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
          micCapture.start(stream, captureSessionRef.current);
        } catch (err: any) {
          console.warn("[mic-window] Failed to get mic stream for diarization:", err);
        }
      }

      // Also start Web Speech API for instant client-side preview. Goes through the same pump the
      // auto-restart uses, so a still-shutting-down engine is retried rather than reported dead.
      setInterimTranscript("");
      pumpRecognition();
    }
  };

  const handleFormSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const fullText = (transcript + " " + interimTranscript).trim();
    if (!fullText) return;

    // Submitting for analysis leaves capture untouched — the user is the only one who stops the mic.
    setIsEditingTranscript(false);
    onAnalyze(fullText);
  };

  // Clearing text is not "turn the mic off". Wipe the transcript and proofread state only; the
  // recognizer, the diarization chunk loop and the shared-tab capture all keep running, so a clear
  // mid-session just gives you a blank page to keep talking onto.
  const resetTranscriptState = React.useCallback(() => {
    setTranscript("");
    openParagraphRef.current = EMPTY_PARAGRAPH;
    setInterimTranscript("");
    setIsEditingTranscript(false);
    setWords(null);
    setActiveChip(null);
    proofedTextRef.current = "";
  }, [setTranscript]);

  // App's "Clear All" used to reset this component by remounting it. Now it bumps a counter and we
  // reset only the text, leaving the mic and tab capture exactly as the user left them. The extra
  // run on mount is a no-op — everything it clears is already empty.
  useEffect(() => { resetTranscriptState(); }, [clearSignal, resetTranscriptState]);

  // Render the proofed transcript with misheard words as clickable correction chips.
  const renderProofed = () => {
    const base = proofedTextRef.current;
    const out: React.ReactNode[] = [];
    let cursor = 0;
    words!.forEach((w, i) => {
      if (w.start > cursor) out.push(<span key={`g${i}`}>{base.slice(cursor, w.start)}</span>);
      cursor = w.end;
      if (w.confidence >= CONFIDENCE_THRESHOLD) {
        out.push(<span key={`w${i}`}>{base.slice(w.start, w.end)}</span>);
        return;
      }
      const alts = w.alternatives ?? [];
      out.push(
        <span key={`w${i}`} className="relative inline-block">
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); setActiveChip(activeChip === i ? null : i); }}
            title="Possibly misheard — click to correct"
            className="bg-amber-100 text-amber-900 rounded px-0.5 underline decoration-wavy decoration-amber-400 decoration-1 cursor-pointer hover:bg-amber-200 transition-colors"
          >
            {base.slice(w.start, w.end)}
          </button>
          {activeChip === i && (
            <span
              onClick={(e) => e.stopPropagation()}
              data-transcript-text="false"
              className="absolute z-20 left-0 top-full mt-1 min-w-[120px] bg-white border border-stone-200 rounded-lg shadow-lg p-1 flex flex-col text-left"
            >
              {alts.length > 0 ? alts.map((alt, k) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => correctWord(i, alt)}
                  className="text-left text-xs text-stone-700 hover:bg-amber-50 rounded px-2 py-1 transition-colors"
                >
                  {alt}
                </button>
              )) : (
                <span className="text-[10px] text-stone-400 italic px-2 py-1">No suggestion</span>
              )}
              <button
                type="button"
                onClick={() => keepWord(i)}
                className="text-left text-[10px] text-stone-400 hover:text-stone-600 hover:bg-stone-50 rounded px-2 py-1 border-t border-stone-100 mt-1 transition-colors"
              >
                Keep as-is
              </button>
            </span>
          )}
        </span>
      );
    });
    if (cursor < base.length) out.push(<span key="tail">{base.slice(cursor)}</span>);
    // Text spoken/typed after the last proofread isn't scored yet — render it plain (no highlight).
    if (transcript.length > base.length) out.push(<span key="unproofed">{transcript.slice(base.length)}</span>);
    return out;
  };

  // Render raw or unproofed text formatted as structured dialogue turns or paragraphs
  const renderSpeakerText = (text: string) => {
    if (!text || !text.trim()) return null;

    // Check if the text contains speaker turn patterns
    const speakerRegex = /(?:\[(?:Meeting(?::\s*[^\]]+)?)\]|\b(?:Speaker\s*\d+|You|[A-Z][a-z]+):)/;
    if (!speakerRegex.test(text)) {
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

    // Split text into distinct turns across newlines or speaker boundaries
    const rawTurns = text.split(/(?=(?:\[(?:Meeting(?::\s*[^\]]+)?)\]|\b(?:Speaker\s*\d+|You|[A-Z][a-z]+):))/g);

    return (
      <div className="space-y-3">
        {rawTurns.map((turn, tIdx) => {
          const trimmed = turn.trim();
          if (!trimmed) return null;

          const match = trimmed.match(/^(\[(?:Meeting(?::\s*[^\]]+)?)\]|\b(?:Speaker\s*\d+|You|[A-Z][a-z]+):)\s*(.*)$/s);
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

      {recognitionError && (
        <div className="mb-4 text-xs bg-amber-50 text-amber-800 border border-amber-100 rounded-xl p-3.5 leading-relaxed flex items-start gap-2">
          <HelpCircle className="w-4 h-4 shrink-0 text-amber-600 mt-0.5" />
          <span>{recognitionError}</span>
        </div>
      )}

      {tabAudioError && (
        <div className="mb-4 text-xs bg-amber-50 text-amber-800 border border-amber-100 rounded-xl p-3.5 leading-relaxed flex items-start gap-2">
          <HelpCircle className="w-4 h-4 shrink-0 text-amber-600 mt-0.5" />
          <span>{tabAudioError}</span>
        </div>
      )}

      <div className="flex flex-col items-center justify-center py-4 border-b border-stone-100/75 mb-4">
          <div className="flex items-center justify-center gap-6">
            {/* Pulse Recording Trigger */}
            {!useKeyboard && (
            <div className="flex flex-col items-center">
              <button
                id="mic-pulse-button"
                onClick={handleToggleListening}
                className={`relative flex items-center justify-center w-20 h-20 rounded-full border transition-all duration-300 ${
                  isListening
                    ? "bg-red-50 border-red-200 text-red-650 shadow-md scale-105 animate-pulse"
                    : "bg-stone-50 border-stone-200 text-stone-700 hover:bg-stone-100 hover:border-stone-300 shadow-sm"
                }`}
              >
                {isListening ? (
                  <div className="absolute inset-0 rounded-full border border-red-500/20 wrapper-ping animate-ping" />
                ) : null}
                {isListening ? (
                  <MicOff className="w-7 h-7" />
                ) : (
                  <Mic className="w-7 h-7" />
                )}
              </button>
              <p className="mt-3 text-[10px] font-semibold text-stone-500 text-center uppercase tracking-wider font-mono">
                {isListening ? "Click to Pause Speech Capture" : "Click to Speak Thoughts"}
              </p>
              {isDiarizationActive() && (
                <span className="mt-1 px-2 py-0.5 rounded-full bg-indigo-50 border border-indigo-200/80 text-indigo-700 text-[9px] font-mono font-bold flex items-center gap-1">
                  <Radio className={`w-2.5 h-2.5 text-indigo-600 ${isListening ? "animate-pulse" : ""}`} />
                  <span>Diarization Active</span>
                </span>
              )}
            </div>
            )}

            {/* Shared-tab audio capture — a separate pipeline from the mic above (see
                useTabAudioCapture); only shown where getDisplayMedia exists at all. */}
            {typeof navigator !== "undefined" && typeof navigator.mediaDevices?.getDisplayMedia === "function" && (
              <div className="flex flex-col items-center">
                <button
                  id="tab-audio-share-button"
                  onClick={handleToggleTabAudio}
                  title={isSharingTab ? "Stop capturing the shared tab's audio" : "Share a Chrome tab (e.g. a meeting) and transcribe its audio too"}
                  className={`relative flex items-center justify-center w-20 h-20 rounded-full border transition-all duration-300 ${
                    isSharingTab
                      ? "bg-red-50 border-red-200 text-red-650 shadow-md scale-105 animate-pulse"
                      : "bg-stone-50 border-stone-200 text-stone-700 hover:bg-stone-100 hover:border-stone-300 shadow-sm"
                  }`}
                >
                  {isSharingTab ? (
                    <div className="absolute inset-0 rounded-full border border-red-500/20 wrapper-ping animate-ping" />
                  ) : null}
                  {isSharingTab ? (
                    <ScreenShareOff className="w-7 h-7" />
                  ) : (
                    <ScreenShare className="w-7 h-7" />
                  )}
                </button>
                <p className="mt-3 text-[10px] font-semibold text-stone-500 text-center uppercase tracking-wider font-mono">
                  {isSharingTab ? "Click to Stop Tab Capture" : "Click to Share Tab Audio"}
                </p>
              </div>
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
                  disabled={isProcessing}
                  placeholder="Write down whatever is on your mind. For example:&#10;'Today was busy, but good. I got a lot done on the product roadmap and Alice and I will meet tomorrow at 2 to discuss it. I need to make a mockup before it. Also, remember to grab more coffee beans on the way home.'"
                  className="w-full flex-1 bg-transparent border-0 py-0 pl-0 pr-1 text-xs text-stone-700 leading-relaxed focus:ring-0 outline-none resize-none font-sans"
                />
                {/* Read-only, not inside the textarea: in there interim words would be editable
                    and would get committed as real text before the recognizer finalized them. */}
                {isListening && interimTranscript && (
                  <div className="shrink-0 pt-1 text-[11px] text-amber-500 italic animate-pulse truncate">
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
                    {interimTranscript && (
                      <div className="mt-2 text-[11px] text-amber-600 italic font-medium animate-pulse flex items-center gap-1.5 bg-amber-50/70 p-1.5 rounded-lg border border-amber-200/60">
                        <Radio className="w-3 h-3 text-amber-500 animate-spin shrink-0" />
                        <span className="line-clamp-1">{interimTranscript}...</span>
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
          disabled={isProcessing || !(transcript || interimTranscript).trim()}
          title="Clear the transcript. Does not stop the microphone or tab capture."
          className="px-2 py-0.5 text-[10px] font-semibold text-stone-500 hover:text-stone-800 hover:bg-stone-100 rounded-md transition-colors border border-stone-200/50 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:text-stone-500 disabled:hover:bg-transparent"
        >
          Clear Text
        </button>
        {/* "Analyze Thoughts" button commented out — thoughts are analyzed live in real time
        <button
          onClick={handleFormSubmit}
          disabled={isProcessing || !(transcript || interimTranscript).trim()}
          className="flex items-center gap-2 px-5 py-2 text-xs font-semibold text-white bg-amber-600 hover:bg-amber-700 disabled:bg-stone-200 disabled:text-stone-400 rounded-lg transition-colors border border-amber-700 shadow-sm disabled:border-stone-200 cursor-pointer"
        >
          {isProcessing ? (
            <>
              <RefreshCw className="w-3.5 h-3.5 animate-spin" /> Structuring thoughts...
            </>
          ) : (
            <>
              <Send className="w-3.5 h-3.5" /> Analyze Thoughts
            </>
          )}
        </button>
        */}
      </div>
    </div>
  );
}
