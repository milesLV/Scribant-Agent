import React, { useState, useEffect, useRef } from "react";
import { Mic, MicOff, Send, HelpCircle, Keyboard, RefreshCw, Sparkles, FileText, SpellCheck, FolderPlus } from "lucide-react";
import MarkdownBullets from "./MarkdownBullets";
import { Word, ProofResult } from "../types";
import { applyCorrections, CONFIDENCE_THRESHOLD } from "../utils/transcript";

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

  // Ref to block recognition results after a clear signal
  const ignoreSpeechResultsRef = useRef(false);

  // Web Speech stops itself on silence; we auto-restart unless the user (or a fatal error) stopped it.
  const manualStopRef = useRef(false);

  const [isEditingTranscript, setIsEditingTranscript] = useState(false);

  // Misheard-word proofread state. `words` are scored against the exact text in proofedTextRef
  // (offsets index into it), so corrections splice safely even as the live transcript moves on.
  const [words, setWords] = useState<Word[] | null>(null);
  const [activeChip, setActiveChip] = useState<number | null>(null);
  const proofedTextRef = useRef("");

  const recognitionRef = useRef<any>(null);

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
      ignoreSpeechResultsRef.current = false;
      setIsListening(true);
      setRecognitionError(null);
    };

    rec.onresult = (event: any) => {
      if (ignoreSpeechResultsRef.current) return;

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
      console.error("Speech recognition error:", event.error);
      if (event.error === "not-allowed" || event.error === "service-not-allowed" || event.error === "audio-capture") {
        manualStopRef.current = true; // fatal — don't auto-restart
        setRecognitionError("Microphone access denied. Please grant microphone permissions or type your thoughts below!");
      } else if (event.error === "no-speech") {
        // Safe to ignore minor timeouts — onend will auto-restart.
      } else {
        setRecognitionError(`Speech recognition error: ${event.error}`);
      }
    };

    rec.onend = () => {
      // Keep listening through silence-driven stops; only quit when manually stopped.
      if (manualStopRef.current) {
        manualStopRef.current = false;
        setIsListening(false);
        return;
      }
      try {
        rec.start();
      } catch {
        setIsListening(false);
      }
    };

    recognitionRef.current = rec;

    return () => {
      if (recognitionRef.current) {
        manualStopRef.current = true; // unmounting — don't let onend restart
        recognitionRef.current.abort();
      }
    };
  }, []);

  const handleToggleListening = () => {
    if (isListening) {
      manualStopRef.current = true;
      recognitionRef.current?.stop();
    } else {
      ignoreSpeechResultsRef.current = false;
      setRecognitionError(null);
      setIsEditingTranscript(false);
      try {
        // Resume onto the existing transcript instead of wiping it (use "Clear Text" to reset).
        setInterimTranscript("");
        recognitionRef.current?.start();
      } catch (err: any) {
        console.error("Failed to start voice recognition:", err);
        setRecognitionError("Could not initialize microphone. Please reload or dump your thoughts directly in the typewriter box.");
      }
    }
  };

  const handleFormSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const fullText = (transcript + " " + interimTranscript).trim();
    if (!fullText) return;

    if (isListening) {
      manualStopRef.current = true;
      recognitionRef.current?.stop();
    }

    setIsEditingTranscript(false);
    onAnalyze(fullText);
  };

  const handleClear = () => {
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

  return (
    <div id="audio-recorder-panel" className="bg-white border border-stone-200 rounded-2xl p-6 shadow-sm transition-all hover:shadow-md">
      
      <div className="flex items-center justify-between mb-4 pb-3 border-b border-stone-100">
        <div className="flex items-center gap-2">
          <div className={`w-2.5 h-2.5 rounded-full ${isListening ? 'bg-emerald-500 animate-pulse' : 'bg-amber-400'}`} />
          <h2 className="text-sm font-semibold text-stone-800 tracking-tight font-sans">
            {isListening ? "Listening to your thoughts..." : "Capture your thoughts"}
          </h2>
        </div>
        <button
          onClick={() => {
            setUseKeyboard(!useKeyboard);
            setIsEditingTranscript(false);
          }}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-stone-500 hover:text-stone-800 bg-stone-50 hover:bg-stone-100 rounded-lg transition-colors border border-stone-100"
          title="Toggle Manual/Voice mode"
        >
          {useKeyboard ? (
            <>
              <Mic className="w-3.5 h-3.5" /> Use Voice
            </>
          ) : (
            <>
              <Keyboard className="w-3.5 h-3.5" /> Paste / Type Prompt
            </>
          )}
        </button>
      </div>

      {recognitionError && (
        <div className="mb-4 text-xs bg-amber-50 text-amber-800 border border-amber-100 rounded-xl p-3.5 leading-relaxed flex items-start gap-2">
          <HelpCircle className="w-4 h-4 shrink-0 text-amber-600 mt-0.5" />
          <span>{recognitionError}</span>
        </div>
      )}

      {!useKeyboard && (
        <div className="flex flex-col items-center justify-center py-4 border-b border-stone-100/75 mb-4">
          {/* Pulse Recording Trigger */}
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
                {useKeyboard || isEditingTranscript ? "Editable Input Text" : "Live Unfiltered Transcript"}
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
                value={transcript}
                onChange={(e) => setTranscript(e.target.value)}
                onBlur={() => setIsEditingTranscript(false)}
                autoFocus={isEditingTranscript && !useKeyboard}
                disabled={isProcessing}
                placeholder="Write down whatever is on your mind. For example:&#10;'Today is a solid day. Discussing the product roadmap with Alice on June 10 at 2pm. Keep a note to draft the mock schema beforehand. I wonder who designed the Concorde airplane originally? Also, remember to grab coffee on the way home.'"
                className="w-full flex-1 bg-transparent border-0 p-0 text-xs text-stone-700 leading-normal focus:ring-0 outline-none resize-none font-sans"
              />
            ) : (
              <div 
                onClick={() => {
                  if (!isListening) {
                    setIsEditingTranscript(true);
                  }
                }}
                className="w-full flex-1 overflow-y-auto text-xs text-stone-700 leading-relaxed font-sans cursor-text whitespace-pre-wrap pr-1"
                title={isListening ? "Listening..." : "Click anywhere to edit transcript text"}
              >
                {(transcript || interimTranscript) ? (
                  <span className="leading-relaxed font-sans text-stone-750">
                    {words && transcript.startsWith(proofedTextRef.current) ? renderProofed() : transcript}
                    {interimTranscript && (
                      <span className="text-amber-500 italic font-medium animate-pulse">
                        {(transcript && !/\s$/.test(transcript) ? " " : "") + interimTranscript}
                      </span>
                    )}
                  </span>
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

              <button
                type="button"
                onClick={onRunNow}
                disabled={busy.summary || !transcript.trim()}
                title="Run the live pipeline now — proofread, summary and draft actions"
                className="p-1 text-stone-500 hover:text-amber-700 hover:bg-stone-100 rounded transition-colors disabled:opacity-44 cursor-pointer"
              >
                {busy.summary ? (
                  <RefreshCw className="w-3.5 h-3.5 animate-spin text-amber-600" />
                ) : (
                  <Sparkles className="w-3.5 h-3.5 text-stone-600 hover:text-amber-600" />
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
                    <span className="mt-1 text-[10px] text-stone-400 font-light">Notes will auto-generate periodically as you speak or type. Or click the sparkles button to refine draft right now!</span>
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
