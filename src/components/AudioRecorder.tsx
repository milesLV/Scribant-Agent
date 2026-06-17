import React, { useState, useEffect, useRef } from "react";
import { Mic, MicOff, Send, HelpCircle, Keyboard, RefreshCw, Sparkles, FileText } from "lucide-react";
import MarkdownBullets from "./MarkdownBullets";

interface AudioRecorderProps {
  onAnalyze: (text: string) => void;
  isProcessing: boolean;
  onShowToast?: (msg: string) => void;
  clearSignal?: number;
  onChangeTranscript?: (text: string) => void;
  onChangeSummary?: (summary: string) => void;
  onListeningChange?: (isListening: boolean) => void;
}

// Global declaration for SpeechRecognition
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
  clearSignal,
  onChangeTranscript,
  onChangeSummary,
  onListeningChange
}: AudioRecorderProps) {
  const [isListening, setIsListening] = useState(false);
  const [transcript, setTranscript] = useState("");
  const [interimTranscript, setInterimTranscript] = useState("");
  const [recognitionError, setRecognitionError] = useState<string | null>(null);
  const [useKeyboard, setUseKeyboard] = useState(false);
  
  // Custom Live Summarized states
  const [liveSummary, setLiveSummary] = useState<string>("");
  const [isSummarizing, setIsSummarizing] = useState(false);
  const isSummarizingRef = useRef(false);
  const [autoSummarize, setAutoSummarize] = useState(true);
  const lastSummarizedRef = useRef<string>("");
  const lastSummarizedTimeRef = useRef<number>(0);
  const liveSummaryTimerRef = useRef<NodeJS.Timeout | null>(null);
  // Abort controller for in-flight summarize fetches; clearedRef prevents stale responses writing back
  const summarizeAbortControllerRef = useRef<AbortController | null>(null);
  const clearedRef = useRef(false);

  // Silence Duration Config & Timer states
  const [silenceDuration, setSilenceDuration] = useState<number>(8); // default 8 seconds
  const silenceTimerRef = useRef<NodeJS.Timeout | null>(null);

  // Ref to block recognition results after a clear signal
  const ignoreSpeechResultsRef = useRef(false);

  // Correction Dropdown state
  const [isEditingTranscript, setIsEditingTranscript] = useState(false);

  const recognitionRef = useRef<any>(null);

  const triggerLiveSummary = async (textToSummarize: string) => {
    if (!textToSummarize.trim()) {
      setLiveSummary("");
      if (onChangeSummary) onChangeSummary("");
      return;
    }
    if (isSummarizingRef.current) return;
    // Abort any previous in-flight request
    if (summarizeAbortControllerRef.current) {
      summarizeAbortControllerRef.current.abort();
    }
    const controller = new AbortController();
    summarizeAbortControllerRef.current = controller;
    isSummarizingRef.current = true;
    setIsSummarizing(true);
    try {
      const res = await fetch("/api/summarize-live", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ text: textToSummarize }),
        signal: controller.signal,
      });
      // If the session was cleared while the request was in flight, discard the result
      if (clearedRef.current) return;
      if (res.ok) {
        const data = await res.json();
        if (!clearedRef.current) {
          setLiveSummary(data.summary);
          lastSummarizedRef.current = textToSummarize;
          if (onChangeSummary) {
            onChangeSummary(data.summary);
          }
        }
      }
    } catch (err: any) {
      if (err.name !== "AbortError") {
        console.error("Live summarization failed:", err);
      }
    } finally {
      isSummarizingRef.current = false;
      setIsSummarizing(false);
      summarizeAbortControllerRef.current = null;
    }
  };

  // Notify parent of transcript modifications (include interim text for real-time live analysis)
  useEffect(() => {
    if (onChangeTranscript) {
      onChangeTranscript((transcript + " " + interimTranscript).trim());
    }
  }, [transcript, interimTranscript, onChangeTranscript]);

  // Notify parent of microphone listening changes
  useEffect(() => {
    if (onListeningChange) {
      onListeningChange(isListening);
    }
  }, [isListening, onListeningChange]);

  // External clear signal from parent (Clear All button)
  useEffect(() => {
    if (clearSignal && clearSignal > 0) {
      // Mark as cleared so any in-flight requests discard their results
      clearedRef.current = true;
      ignoreSpeechResultsRef.current = true;
      // Abort any in-flight summarize request immediately
      if (summarizeAbortControllerRef.current) {
        summarizeAbortControllerRef.current.abort();
        summarizeAbortControllerRef.current = null;
      }
      // Cancel any pending summarize timer
      if (liveSummaryTimerRef.current) {
        clearTimeout(liveSummaryTimerRef.current);
        liveSummaryTimerRef.current = null;
      }
      isSummarizingRef.current = false;
      setIsSummarizing(false);
      if (isListening) {
        recognitionRef.current?.stop();
        setIsListening(false);
      }
      setTranscript("");
      setInterimTranscript("");
      setLiveSummary("");
      if (onChangeSummary) onChangeSummary("");
      setIsEditingTranscript(false);
      lastSummarizedRef.current = "";
      lastSummarizedTimeRef.current = 0;
    }
  }, [clearSignal]);

  // Live Notes Summary update loop
  useEffect(() => {
    const textToSummarize = (transcript + " " + interimTranscript).trim();
    if (!textToSummarize || !autoSummarize) {
      if (!textToSummarize) {
        setLiveSummary("");
      }
      lastSummarizedRef.current = "";
      return;
    }
    // New content arrived — allow summaries again
    clearedRef.current = false;

    if (textToSummarize.length < 15) {
      return;
    }

    // Clear any existing timer
    if (liveSummaryTimerRef.current) {
      clearTimeout(liveSummaryTimerRef.current);
    }

    const runSummary = () => {
      if (isSummarizingRef.current) return;
      triggerLiveSummary(textToSummarize);
      lastSummarizedRef.current = textToSummarize;
      lastSummarizedTimeRef.current = Date.now();
    };

    const timeSinceLastRun = Date.now() - lastSummarizedTimeRef.current;
    const textHasChanged = textToSummarize !== lastSummarizedRef.current;

    if (textHasChanged && timeSinceLastRun >= 10000) {
      // Periodic check every 10 seconds of active speech
      runSummary();
    } else {
      // Debounce when they pause: fire after 2 seconds
      liveSummaryTimerRef.current = setTimeout(() => {
        const currentText = lastSummarizedRef.current;
        if (textToSummarize !== currentText) {
          runSummary();
        }
      }, 2000);
    }

    return () => {
      if (liveSummaryTimerRef.current) {
        clearTimeout(liveSummaryTimerRef.current);
      }
    };
  }, [transcript, interimTranscript, autoSummarize]);

  // Silence threshold automatic submission timer
  useEffect(() => {
    if (!isListening) {
      if (silenceTimerRef.current) {
        clearTimeout(silenceTimerRef.current);
        silenceTimerRef.current = null;
      }
      return;
    }

    const fullContent = (transcript + " " + interimTranscript).trim();
    if (!fullContent) return;

    if (silenceTimerRef.current) {
      clearTimeout(silenceTimerRef.current);
    }

    silenceTimerRef.current = setTimeout(() => {
      // Auto-submit active stream of thoughts
      recognitionRef.current?.stop();
      setIsListening(false);
      setIsEditingTranscript(false);
      onAnalyze(fullContent);
      if (onShowToast) {
        onShowToast(`Auto-submitted your thoughts due to ${silenceDuration} seconds of silence!`);
      } else {
        alert(`Auto-submitted and structured your stream of thoughts due to ${silenceDuration} seconds of silence!`);
      }
    }, silenceDuration * 1000);

    return () => {
      if (silenceTimerRef.current) {
        clearTimeout(silenceTimerRef.current);
      }
    };
  }, [transcript, interimTranscript, isListening, silenceDuration]);

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
          const cleanedFinal = finalStr.trim();
          if (!cleanedPrev) return cleanedFinal + " ";
          return cleanedPrev + " " + cleanedFinal + " ";
        });
      }

      setInterimTranscript(interimStr.trim());
    };

    rec.onerror = (event: any) => {
      console.error("Speech recognition error:", event.error);
      if (event.error === "not-allowed") {
        setRecognitionError("Microphone access denied. Please grant microphone permissions or type your thoughts below!");
      } else if (event.error === "no-speech") {
        // Safe to ignore minor timeouts
      } else {
        setRecognitionError(`Speech recognition error: ${event.error}`);
      }
    };

    rec.onend = () => {
      setIsListening(false);
    };

    recognitionRef.current = rec;

    return () => {
      if (recognitionRef.current) {
        recognitionRef.current.abort();
      }
    };
  }, []);

  const handleToggleListening = () => {
    if (isListening) {
      recognitionRef.current?.stop();
    } else {
      ignoreSpeechResultsRef.current = false;
      setRecognitionError(null);
      setIsEditingTranscript(false);
      try {
        setTranscript("");
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
      recognitionRef.current?.stop();
    }

    setIsEditingTranscript(false);
    onAnalyze(fullText);
  };

  const handleClear = () => {
    setTranscript("");
    setInterimTranscript("");
    setIsEditingTranscript(false);
  };

  return (
    <div id="audio-recorder-panel" className="bg-white border border-stone-200 rounded-2xl p-6 shadow-sm transition-all hover:shadow-md">
      
      <div className="flex items-center justify-between mb-4 pb-3 border-b border-stone-100">
        <div className="flex items-center gap-2">
          <div className={`w-2.5 h-2.5 rounded-full ${isListening ? 'bg-emerald-500 animate-pulse' : 'bg-amber-400'}`} />
          <h2 className="text-sm font-semibold text-stone-800 tracking-tight font-sans">
            {isListening ? "Listening to your thoughts..." : "Capture your Stream of Consciousness"}
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

          {/* New Silence Threshold Slider inline inside mic container */}
          <div className="flex items-center gap-2 mt-4 text-[11px] text-stone-500 bg-stone-50 p-2 rounded-xl border border-stone-150 shadow-3xs">
            <span className="font-medium font-sans">Silence Detection:</span>
            <input
              type="range"
              min="1"
              max="15"
              value={silenceDuration}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setSilenceDuration(Number(e.target.value))}
              className="w-20 h-1 bg-stone-200 rounded-lg appearance-none cursor-pointer accent-amber-600"
              title="Silence timer before autocommit"
            />
            <span className="bg-amber-100 text-amber-800 font-bold px-1.5 py-0.5 rounded text-[9px] font-mono whitespace-nowrap">
              {silenceDuration}s autorun
            </span>
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
                {useKeyboard || isEditingTranscript ? "Editable Input Text" : "Live Unfiltered Transcript"}
              </span>
              {isEditingTranscript && !useKeyboard && (
                <button
                  type="button"
                  onClick={() => setIsEditingTranscript(false)}
                  className="text-[10px] font-bold text-emerald-800 bg-emerald-50 hover:bg-emerald-100 px-2 py-0.5 rounded border border-emerald-200/50 cursor-pointer transition-all shrink-0 animate-pulse ml-2"
                >
                  ✓ Done Editing
                </button>
              )}
            </div>
            {!useKeyboard && isListening && (
              <span className="text-[9px] font-medium text-emerald-600 bg-emerald-50 border border-emerald-150 px-1.5 py-0.5 rounded animate-pulse">
                Active Listening &bull; Autocommit in {silenceDuration}s
              </span>
            )}
          </div>
          
          <div className="flex-1 flex flex-col min-h-0">
            {useKeyboard || isEditingTranscript ? (
              <textarea
                id="type-thoughts-textarea"
                value={transcript}
                onChange={(e) => setTranscript(e.target.value)}
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
                    {transcript}
                    {interimTranscript && (
                      <span className="text-amber-500 italic font-medium animate-pulse">
                        {" " + interimTranscript}
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
              <label className="flex items-center gap-1 cursor-pointer" title="Auto-summarize periodically as you type or speak">
                <input
                  type="checkbox"
                  checked={autoSummarize}
                  onChange={(e) => setAutoSummarize(e.target.checked)}
                  className="rounded text-amber-600 focus:ring-amber-500 w-3 h-3 border-stone-300"
                />
                <span className="text-[9px] text-stone-500 select-none">Auto</span>
              </label>

              <button
                type="button"
                onClick={() => triggerLiveSummary(transcript)}
                disabled={isSummarizing || !transcript.trim()}
                title="Summarize draft now"
                className="p-1 text-stone-500 hover:text-amber-700 hover:bg-stone-100 rounded transition-colors disabled:opacity-44 cursor-pointer"
              >
                {isSummarizing ? (
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
                {isSummarizing ? (
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
                <div className={`w-1.5 h-1.5 rounded-full ${isSummarizing ? 'bg-amber-400 animate-pulse' : 'bg-stone-300'}`} />
                {isSummarizing ? "Updating bullets..." : "Notes synchronized"}
              </span>
              <button
                type="button"
                onClick={() => {
                  navigator.clipboard.writeText(liveSummary);
                  if (onShowToast) {
                    onShowToast("Summarized live notes copied to clipboard!");
                  } else {
                    alert("Summarized live notes copied to clipboard!");
                  }
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
              <RefreshCw className="w-3.5 h-3.5 animate-spin" /> Customizing folders...
            </>
          ) : (
            <>
              <Send className="w-3.5 h-3.5" /> Run Consciousness Analysis
            </>
          )}
        </button>
      </div>
    </div>
  );
}
