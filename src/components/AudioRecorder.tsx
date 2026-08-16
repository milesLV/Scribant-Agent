import React, { useState, useEffect, useRef } from "react";
import { Mic, MicOff, Send, HelpCircle, Keyboard, RefreshCw, Sparkles, FileText, SpellCheck, FolderPlus, ScreenShare, ScreenShareOff, Radio, Users } from "lucide-react";
import MarkdownBullets from "./MarkdownBullets";
import { Word, ProofResult } from "../types";
import { applyCorrections, CONFIDENCE_THRESHOLD } from "../utils/transcript";
import { useTabAudioCapture } from "../hooks/useTabAudioCapture";

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
}

declare global {
  interface Window {
    webkitSpeechRecognition: any;
    SpeechRecognition: any;
  }
}

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
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  let total = 0;
  let n: Node | null;
  while ((n = walker.nextNode())) {
    if (n === node) return total + localOffset;
    total += (n.textContent || "").length;
  }
  return total;
}

function pickMimeType(): string {
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"];
  return candidates.find((t) => typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(t)) || "";
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = reader.result as string;
      resolve(result.slice(result.indexOf(",") + 1));
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
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
  savingDrive
}: AudioRecorderProps) {
  const [isListening, setIsListening] = useState(false);
  const [transcript, setTranscript] = useState("");
  const [interimTranscript, setInterimTranscript] = useState("");
  const [recognitionError, setRecognitionError] = useState<string | null>(null);
  const [useKeyboard, setUseKeyboard] = useState(false);
  const [tabAudioError, setTabAudioError] = useState<string | null>(null);

  // Mic MediaRecorder refs for Cloud STT Diarization mode
  const micStreamRef = useRef<MediaStream | null>(null);
  const micRecorderRef = useRef<MediaRecorder | null>(null);
  const micStoppingRef = useRef(false);

  // Helper to check if Diarization is toggled on in settings
  const isDiarizationActive = () => {
    try {
      const saved = localStorage.getItem("scribant_stt_config");
      if (saved) return Boolean(JSON.parse(saved).enableDiarization);
    } catch {}
    return false;
  };

  // Uploads a mic audio chunk directly to Cloud STT /api/transcribe-audio
  const uploadMicChunk = async (blob: Blob) => {
    if (blob.size === 0) return;
    try {
      const base64 = await blobToBase64(blob);
      let enableDiarization = true;
      let minSpeakers = 1;
      let maxSpeakers = 5;
      try {
        const saved = localStorage.getItem("scribant_stt_config");
        if (saved) {
          const parsed = JSON.parse(saved);
          enableDiarization = Boolean(parsed.enableDiarization);
          if (parsed.minSpeakers) minSpeakers = Number(parsed.minSpeakers);
          if (parsed.maxSpeakers) maxSpeakers = Number(parsed.maxSpeakers);
        }
      } catch {}

      const res = await fetch("/api/transcribe-audio", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          audio: base64,
          mimeType: blob.type || "audio/webm",
          source: "mic",
          enableDiarization,
          minSpeakers,
          maxSpeakers,
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const text = String(data.text || "").trim();
      if (text) {
        setTranscript((prev) => {
          const cleanedPrev = prev.trim();
          if (!cleanedPrev) return text;
          const isDialogue = text.includes("Speaker ") || cleanedPrev.includes("Speaker ");
          const separator = isDialogue ? "\n\n" : " ";
          return cleanedPrev + separator + text;
        });
        setInterimTranscript("");
      }
    } catch (err) {
      console.warn("[mic-chunk] diarization chunk transcription failed:", err);
    }
  };

  // Loops recording chunks while mic is active in diarization mode
  const recordNextMicChunk = () => {
    const stream = micStreamRef.current;
    if (!stream || micStoppingRef.current) return;
    const rec = new MediaRecorder(stream, { mimeType: pickMimeType() });
    const parts: Blob[] = [];
    rec.ondataavailable = (e) => {
      if (e.data.size > 0) parts.push(e.data);
    };
    rec.onstop = () => {
      uploadMicChunk(new Blob(parts, { type: rec.mimeType }));
      recordNextMicChunk();
    };
    micRecorderRef.current = rec;
    rec.start();
    setTimeout(() => {
      if (rec.state === "recording") rec.stop();
    }, 8000);
  };

  // Ref to block recognition results after a clear signal
  const ignoreSpeechResultsRef = useRef(false);

  // Persistent desired listening state. Web Speech stops itself on silence; we auto-restart only if shouldListenRef is true.
  const shouldListenRef = useRef(false);

  const [isEditingTranscript, setIsEditingTranscript] = useState(false);
  // Where to place the cursor once the read-only view swaps for the textarea — computed from the
  // click point BEFORE the swap, since the textarea is a fresh element with no memory of where in
  // the div the user clicked. null means "couldn't compute it" (unsupported browser); leave it alone.
  const pendingCaretRef = useRef<number | null>(null);
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
  // transcript to be a list of tagged segments instead of one flat string.
  const { isSharing: isSharingTab, start: startTabAudio, stop: stopTabAudio } = useTabAudioCapture({
    onChunk: ({ text }) => {
      setTranscript((prev) => {
        const cleanedPrev = prev.trim();
        if (!cleanedPrev) return text;
        const isDialogue = text.includes("Speaker ") || cleanedPrev.includes("Speaker ") || text.startsWith("[Meeting");
        const separator = isDialogue ? "\n\n" : " ";
        return cleanedPrev + separator + text;
      });
    },
    onError: (msg) => setTabAudioError(msg),
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

  // The textarea just replaced the read-only view (click-to-edit) — land the cursor where the click
  // actually landed instead of wherever the browser's own autoFocus default puts it.
  useEffect(() => {
    if (!isEditingTranscript || pendingCaretRef.current === null) return;
    const el = textareaRef.current;
    if (!el) return;
    const pos = Math.min(pendingCaretRef.current, el.value.length);
    el.focus();
    el.setSelectionRange(pos, pos);
    pendingCaretRef.current = null;
  }, [isEditingTranscript]);

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
        setTranscript((prev: string) => {
          const cleanedPrev = prev.trim();
          // Collapse internal whitespace — the recognizer prefixes continued results with a space,
          // which doubles up against the space we append and reflows the line.
          const cleanedFinal = finalStr.replace(/\s+/g, " ").trim();
          if (!cleanedPrev) return cleanedFinal + " ";
          return cleanedPrev + " " + cleanedFinal + " ";
        });
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
        // Safe to ignore minor timeouts — onend will auto-restart only if shouldListenRef is true.
      } else {
        setRecognitionError(`Speech recognition error: ${event.error}`);
      }
    };

    rec.onend = () => {
      // Auto-restart only if the user explicitly wants to keep listening
      if (!shouldListenRef.current) {
        setIsListening(false);
        return;
      }
      try {
        rec.start();
      } catch {
        setIsListening(false);
        shouldListenRef.current = false;
      }
    };

    recognitionRef.current = rec;

    return () => {
      if (recognitionRef.current) {
        shouldListenRef.current = false;
        try { recognitionRef.current.abort(); } catch {}
      }
    };
  }, []);

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
      shouldListenRef.current = false;
      setIsListening(false);
      setInterimTranscript("");
      try {
        recognitionRef.current?.abort();
      } catch {
        try { recognitionRef.current?.stop(); } catch {}
      }
      // Stop mic MediaRecorder if running in diarization mode
      micStoppingRef.current = true;
      if (micRecorderRef.current?.state === "recording") micRecorderRef.current.stop();
      micStreamRef.current?.getTracks().forEach((t) => t.stop());
      micStreamRef.current = null;
    } else {
      shouldListenRef.current = true;
      ignoreSpeechResultsRef.current = false;
      setRecognitionError(null);
      setIsEditingTranscript(false);
      setIsListening(true);

      // Start Cloud STT chunking loop if Diarization mode is active
      if (isDiarizationActive()) {
        try {
          const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
          micStreamRef.current = stream;
          micStoppingRef.current = false;
          recordNextMicChunk();
        } catch (err: any) {
          console.warn("[mic-chunk] Failed to get mic stream for diarization:", err);
        }
      }

      // Also start Web Speech API for instant client-side preview
      try {
        setInterimTranscript("");
        recognitionRef.current?.start();
      } catch (err: any) {
        // If Web Speech API fails, but MediaRecorder is running, continue with MediaRecorder
        if (!micStreamRef.current) {
          console.error("Failed to start voice recognition:", err);
          setRecognitionError("Could not initialize microphone. Please reload or dump your thoughts directly in the typewriter box.");
          shouldListenRef.current = false;
          setIsListening(false);
        }
      }
    }
  };

  const handleFormSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const fullText = (transcript + " " + interimTranscript).trim();
    if (!fullText) return;

    if (isListening || shouldListenRef.current) {
      shouldListenRef.current = false;
      setIsListening(false);
      setInterimTranscript("");
      try { recognitionRef.current?.abort(); } catch {}
      micStoppingRef.current = true;
      if (micRecorderRef.current?.state === "recording") micRecorderRef.current.stop();
      micStreamRef.current?.getTracks().forEach((t) => t.stop());
      micStreamRef.current = null;
    }

    setIsEditingTranscript(false);
    onAnalyze(fullText);
  };

  const handleClear = () => {
    shouldListenRef.current = false;
    setIsListening(false);
    ignoreSpeechResultsRef.current = true;
    try { recognitionRef.current?.abort(); } catch {}
    micStoppingRef.current = true;
    if (micRecorderRef.current?.state === "recording") micRecorderRef.current.stop();
    micStreamRef.current?.getTracks().forEach((t) => t.stop());
    micStreamRef.current = null;
    setTranscript("");
    setInterimTranscript("");
    setIsEditingTranscript(false);
    setWords(null);
    setActiveChip(null);
    proofedTextRef.current = "";
  };

  const flagCount = words ? words.filter(w => w.confidence < CONFIDENCE_THRESHOLD).length : 0;

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

  // Render raw or unproofed text formatted as structured dialogue turns
  const renderSpeakerText = (text: string) => {
    if (!text || !text.trim()) return null;

    // Check if the text contains speaker turn patterns
    const speakerRegex = /(?:\[(?:Meeting(?::\s*[^\]]+)?)\]|\b(?:Speaker\s*\d+|You|[A-Z][a-z]+):)/;
    if (!speakerRegex.test(text)) {
      return <span className="whitespace-pre-wrap">{text}</span>;
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
    <div id="audio-recorder-panel" className="bg-white border border-stone-200 rounded-2xl p-6 shadow-sm transition-all hover:shadow-md">
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

      {!useKeyboard && (
        <div className="flex flex-col items-center justify-center py-4 border-b border-stone-100/75 mb-4">
          <div className="flex items-center justify-center gap-6">
            {/* Pulse Recording Trigger */}
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
      )}

      {/* Grid containing Input/Transcript on the left, Summarized Notes on the right */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-5 mb-2">
        
        {/* Left Column: Input Box (Live Transcript or Textarea) */}
        <div className="border border-stone-200 bg-stone-50/20 rounded-xl p-4 flex flex-col h-[280px] space-y-3">
          <div className="flex items-center justify-between border-b border-stone-100 pb-2">
            <div className="flex items-center gap-1.5">
              {useKeyboard || isEditingTranscript ? (
                <Keyboard className="w-3.5 h-3.5 text-stone-500" />
              ) : (
                <FileText className="w-3.5 h-3.5 text-stone-500" />
              )}
              <span className="text-[10px] font-bold text-stone-700 uppercase tracking-widest font-mono">
                {useKeyboard || isEditingTranscript ? "Editable Input Text" : "Live Transcript"}
              </span>
            </div>
            <div className="flex items-center gap-2">
              {flagCount > 0 && !isEditingTranscript && (
                <span className="text-[9px] font-bold text-amber-700 bg-amber-50 border border-amber-200 px-1.5 py-0.5 rounded">
                  {flagCount} misheard
                </span>
              )}
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
              <textarea
                id="type-thoughts-textarea"
                ref={textareaRef}
                value={transcript}
                onChange={(e) => setTranscript(e.target.value)}
                onBlur={() => setIsEditingTranscript(false)}
                autoFocus={isEditingTranscript && !useKeyboard}
                disabled={isProcessing}
                placeholder="Write down whatever is on your mind. For example:&#10;'Today was busy, but good. I got a lot done on the product roadmap and Alice and I will meet tomorrow at 2 to discuss it. I need to make a mockup before it. Also, remember to grab more coffee beans on the way home.'"
                className="w-full flex-1 bg-transparent border-0 p-0 text-xs text-stone-700 leading-normal focus:ring-0 outline-none resize-none font-sans"
              />
            ) : (
              <div
                onClick={(e) => {
                  if (isListening) return;
                  pendingCaretRef.current = (transcript || interimTranscript)
                    ? caretOffsetFromPoint(e.clientX, e.clientY, e.currentTarget)
                    : 0;
                  setIsEditingTranscript(true);
                }}
                className="w-full flex-1 overflow-y-auto text-xs text-stone-700 leading-relaxed font-sans cursor-text whitespace-pre-wrap pr-1"
                title={isListening ? "Listening..." : "Click anywhere to edit transcript text"}
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

        {/* Right Column: AI Live Summarized Notes */}
        <div className="border border-stone-200 bg-stone-50/20 rounded-xl p-4 flex flex-col h-[280px] space-y-3">
          <div className="flex items-center justify-between border-b border-stone-100 pb-2">
            <div className="flex items-center gap-1.5">
              <Sparkles className="w-3.5 h-3.5 text-amber-500" />
              <span className="text-[10px] font-bold text-stone-700 uppercase tracking-widest font-mono">
                AI Live Notes Summary
              </span>
            </div>
            
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onSaveToDrive}
                disabled={savingDrive || !liveSummary.trim()}
                title="Save these live notes to a Google Drive folder for this session"
                className="p-1 text-stone-500 hover:text-amber-700 hover:bg-stone-100 rounded transition-colors disabled:opacity-40 cursor-pointer"
              >
                {savingDrive ? (
                  <RefreshCw className="w-3.5 h-3.5 animate-spin text-amber-600" />
                ) : (
                  <FolderPlus className="w-3.5 h-3.5" />
                )}
              </button>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto pr-1">
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
            <div className="pt-2 border-t border-stone-150/70 flex items-center justify-between text-[9px] text-stone-400 font-mono">
              <span className="flex items-center gap-1">
                <div className={`w-1.5 h-1.5 rounded-full ${busy.summary ? 'bg-amber-400 animate-pulse' : 'bg-stone-300'}`} />
                {busy.summary ? "Updating bullets..." : "Notes synchronized"}
              </span>
              <button
                type="button"
                onClick={() => {
                  navigator.clipboard.writeText(liveSummary);
                  onShowToast("Summarized live notes copied to clipboard!");
                }}
                className="hover:text-stone-700 hover:underline cursor-pointer"
              >
                Copy Notes
              </button>
            </div>
          )}
        </div>

      </div>

      {/* Control Buttons */}
      <div className="flex items-center justify-end gap-2.5 mt-4 pt-3 border-t border-stone-100">
        {(transcript || interimTranscript) && (
          <button
            onClick={handleClear}
            disabled={isProcessing}
            className="flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-stone-500 hover:text-stone-800 bg-stone-100/50 hover:bg-stone-100 rounded-lg transition-colors border border-stone-200/50 cursor-pointer"
          >
            Clear Text
          </button>
        )}
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
      </div>
    </div>
  );
}
