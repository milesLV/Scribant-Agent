import { useState, useEffect, useRef } from "react";
import {
  Activity,
  ArrowDownToLine,
  ArrowUpFromLine,
  AlertCircle,
  Trash2,
  Search,
  ChevronDown,
  ChevronRight,
  RefreshCw,
  Zap,
  Terminal,
  Wrench,
  ShieldCheck,
  Server,
  Copy,
  Check,
  Users,
  Radio,
  Sliders,
  CheckCircle2,
  Sparkles,
  AlertTriangle,
} from "lucide-react";
import { AdkEvent, SttConfig, SttStatus } from "../types";
import TokenVisualizer from "./TokenVisualizer";
import { classifyEvent, EventFilterCategory, StatusFilterType } from "./DebugPanel";

// Bounds of the expected-speakers control. Every value in range is a single digit, which is what
// lets the range text box assume "one keystroke == one bound" below.
const SPEAKER_MAX = 8;
const SPEAKER_TICKS = [1, 2, 3, 4, 5, 6, 7, 8];
const clampSpeaker = (n: number) => Math.min(SPEAKER_MAX, Math.max(1, n));
// A native range thumb's CENTRE travels from thumbW/2 to width-thumbW/2, not 0%..100%. Ticks and
// labels placed at a raw percentage would therefore drift away from the thumb at both ends, worst
// at the extremes. Pulling each position inward by (0.5 - pct) * thumbWidth puts a tick exactly
// under the thumb it belongs to, which is the whole point of drawing them.
const speakerOffset = (n: number) => {
  const pct = ((n - 1) / (SPEAKER_MAX - 1)) * 100;
  return `calc(${pct}% + ${(0.5 - pct / 100) * 16}px)`;
};
// Shared class list for the overlaid thumbs: the input itself is transparent and click-through so
// the lower one can't swallow clicks meant for the upper; only the thumbs take pointer events.
const RANGE_THUMB =
  "absolute inset-x-0 top-0 w-full h-5 appearance-none bg-transparent pointer-events-none disabled:opacity-40 " +
  "[&::-webkit-slider-thumb]:pointer-events-auto [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:w-4 " +
  "[&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-indigo-600 " +
  "[&::-webkit-slider-thumb]:shadow-sm [&::-webkit-slider-thumb]:cursor-pointer " +
  "[&::-moz-range-thumb]:pointer-events-auto [&::-moz-range-thumb]:h-4 [&::-moz-range-thumb]:w-4 [&::-moz-range-thumb]:rounded-full " +
  "[&::-moz-range-thumb]:bg-white [&::-moz-range-thumb]:border-2 [&::-moz-range-thumb]:border-indigo-600 [&::-moz-range-thumb]:cursor-pointer " +
  "[&::-moz-range-track]:bg-transparent";

interface AdminMonitoringProps {
  onEventsCountChange?: (count: number) => void;
  rawTranscript?: string;
  liveSummary?: string;
}

export default function AdminMonitoring({
  onEventsCountChange,
  rawTranscript = "",
  liveSummary = "",
}: AdminMonitoringProps) {
  const [events, setEvents] = useState<AdkEvent[]>([]);
  const [activeSubTab, setActiveSubTab] = useState<"tokens" | "telemetry" | "infra">("tokens");
  const [eventTypeFilter, setEventTypeFilter] = useState<EventFilterCategory>("all");
  const [authorFilter, setAuthorFilter] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<StatusFilterType>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [expandedEventId, setExpandedEventId] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [isLiveConnected, setIsLiveConnected] = useState(false);
  const [isTestingAction, setIsTestingAction] = useState<"insert" | "retrieve" | "tool_call" | null>(null);
  const [serverConfig, setServerConfig] = useState<any>(null);


  // STT Diarization Configuration & Status State
  const [sttConfig, setSttConfig] = useState<SttConfig>(() => {
    try {
      const saved = localStorage.getItem("scribant_stt_config");
      if (saved) {
        const parsed = JSON.parse(saved);
        return {
          enableDiarization: Boolean(parsed.enableDiarization),
          // A pre-existing config may carry minSpeakers and speakerRangeMode from when this was a
          // two-bound control. Both are ignored: the lower bound is now always 1. An old EXACT-count
          // config stored its number in minSpeakers with maxSpeakers equal to it, so falling back to
          // minSpeakers keeps that number meaning "up to N" rather than silently resetting to 5.
          maxSpeakers: clampSpeaker(Number(parsed.maxSpeakers || parsed.minSpeakers || 5)),
          provider: parsed.enableDiarization ? "google_cloud_stt" : "gemini",
        };
      }
    } catch {}
    return {
      enableDiarization: false,
      maxSpeakers: 5,
      provider: "gemini",
    };
  });

  // Text shown in the editable speaker box. Kept as a separate string from the numeric config so a
  // half-typed value ("2-") can exist on screen without being a valid config state. Null means "not
  // being edited" — the box renders straight from sttConfig instead.
  const [speakerDraft, setSpeakerDraft] = useState<string | null>(null);

  // Digits-only editing. One bound, one digit — SPEAKER_MAX is 8, so a single keystroke is always
  // a complete value and there is no half-typed state to guard.
  const handleSpeakerInput = (raw: string) => {
    const digits = raw.replace(/\D/g, "").slice(0, 1);
    setSpeakerDraft(digits);
    if (digits) setSttConfig((prev) => ({ ...prev, maxSpeakers: clampSpeaker(Number(digits)) }));
  };

  // Blur/Enter just clears the draft so the box re-renders from the clamped config; an empty box
  // falls back to whatever the config already holds rather than committing a 0.
  const commitSpeakerInput = () => setSpeakerDraft(null);


  const [sttStatus, setSttStatus] = useState<SttStatus | null>(null);
  const [isTestingStt, setIsTestingStt] = useState(false);
  const [sttTestResult, setSttTestResult] = useState<any>(null);

  // Save STT Config to LocalStorage whenever modified
  useEffect(() => {
    localStorage.setItem("scribant_stt_config", JSON.stringify(sttConfig));
  }, [sttConfig]);

  // Query Cloud STT Readiness Status
  useEffect(() => {
    fetch("/api/stt/status")
      .then((res) => res.json())
      .then((data) => setSttStatus(data))
      .catch(() => {});
  }, []);

  const eventSourceRef = useRef<EventSource | null>(null);

  // Notify parent of total event count
  useEffect(() => {
    onEventsCountChange?.(events.length);
  }, [events.length, onEventsCountChange]);

  // Fetch server config info
  useEffect(() => {
    fetch("/api/config")
      .then((res) => res.json())
      .then((data) => setServerConfig(data))
      .catch(() => {});
  }, []);

  // Connect to SSE stream
  useEffect(() => {
    let es: EventSource | null = null;

    const connectSSE = () => {
      try {
        es = new EventSource("/api/memory/events/stream");
        eventSourceRef.current = es;

        es.onopen = () => {
          setIsLiveConnected(true);
        };

        es.onmessage = (messageEvent) => {
          try {
            const payload = JSON.parse(messageEvent.data);
            if (payload.type === "init" && Array.isArray(payload.events)) {
              setEvents(payload.events);
            } else if (payload.type === "event" && payload.event) {
              setEvents((prev) => {
                const existingIndex = prev.findIndex((e) => e.id === payload.event.id);
                if (existingIndex >= 0) {
                  const next = [...prev];
                  next[existingIndex] = payload.event;
                  return next;
                }
                return [payload.event, ...prev];
              });
            }
          } catch (err) {
            console.warn("[AdminMonitoring] Failed to parse SSE message:", err);
          }
        };

        es.onerror = () => {
          setIsLiveConnected(false);
          es?.close();
          setTimeout(connectSSE, 3000);
        };
      } catch (err) {
        console.warn("[AdminMonitoring] SSE connection error:", err);
        setIsLiveConnected(false);
      }
    };

    connectSSE();

    return () => {
      es?.close();
    };
  }, []);

  const handleClearEvents = async () => {
    try {
      await fetch("/api/memory/events/clear", { method: "POST" });
      setEvents([]);
    } catch (e) {
      console.warn("Failed to clear memory events:", e);
    }
  };

  const handleTriggerTestInsert = async () => {
    setIsTestingAction("insert");
    try {
      await fetch("/api/memory/ingest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: `[ADK Event Test @ ${new Date().toLocaleTimeString()}]: User prefers meeting summaries delivered in markdown bullet points.`,
          sessionId: `adk-session-${Date.now()}`,
          userId: "default_user",
          plan: {
            ideasSummary: "User preference recorded via ADK event",
            calendarEvents: [],
            tasks: [],
            searches: [],
          },
        }),
      });
    } catch (e) {
      console.error("Test insert failed:", e);
    } finally {
      setTimeout(() => setIsTestingAction(null), 500);
    }
  };

  const handleTriggerTestRetrieve = async () => {
    setIsTestingAction("retrieve");
    try {
      await fetch("/api/memory/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: "What formatting or meeting preferences does the user have?",
          userId: "default_user",
        }),
      });
    } catch (e) {
      console.error("Test retrieve failed:", e);
    } finally {
      setTimeout(() => setIsTestingAction(null), 500);
    }
  };

  const handleCopyJson = (event: AdkEvent) => {
    navigator.clipboard.writeText(JSON.stringify(event, null, 2));
    setCopiedId(event.id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  // Filter logic
  const filteredEvents = events.filter((ev) => {
    const classified = classifyEvent(ev);

    if (eventTypeFilter !== "all" && classified.category !== eventTypeFilter) {
      return false;
    }
    if (authorFilter !== "all" && ev.author !== authorFilter) {
      return false;
    }
    if (statusFilter !== "all" && classified.status !== statusFilter) {
      return false;
    }
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      const rawText = JSON.stringify(ev).toLowerCase();
      return rawText.includes(q) || classified.summaryText.toLowerCase().includes(q);
    }

    return true;
  });

  const totalCount = events.length;
  const handleTestStt = async () => {
    setIsTestingStt(true);
    setSttTestResult(null);
    try {
      // 44-byte standard silent WAV base64
      const dummyWavBase64 = "UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=";
      const res = await fetch("/api/transcribe-audio", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          audio: dummyWavBase64,
          mimeType: "audio/wav",
          source: "mic",
          enableDiarization: sttConfig.enableDiarization,
          minSpeakers: 1, // pinned; a floor above 1 makes the recognizer invent a speaker
          maxSpeakers: sttConfig.maxSpeakers,
        }),
      });
      const data = await res.json();
      setSttTestResult({
        status: res.ok ? "success" : "error",
        provider: data.provider || (sttConfig.enableDiarization ? "google_cloud_stt" : "gemini"),
        speakerCount: data.speakerCount ?? 0,
        text: data.text || "(Clean silent test chunk processed successfully)",
        turns: data.turns || [],
        error: data.error,
      });
    } catch (err: any) {
      setSttTestResult({
        status: "error",
        error: err.message || "Failed to reach transcription endpoint.",
      });
    } finally {
      setIsTestingStt(false);
    }
  };

  const insertCount = events.filter((e) => classifyEvent(e).category === "memory:insert").length;
  const retrieveCount = events.filter((e) => classifyEvent(e).category === "memory:retrieve").length;
  const toolCount = events.filter((e) => classifyEvent(e).category === "tool_call").length;
  const sttCount = events.filter((e) => classifyEvent(e).category === "stt:transcribe" || e.author === "google_cloud_stt").length;
  const errorCount = events.filter((e) => classifyEvent(e).status === "error").length;

  const authors = Array.from(new Set(events.map((e) => e.author).filter(Boolean))) as string[];

  return (
    <div className="w-full bg-white border border-stone-200/90 rounded-2xl shadow-xs overflow-hidden flex flex-col font-sans transition-all">
      {/* Top Header & Navigation Banner */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 p-5 bg-stone-50/70 border-b border-stone-200/90">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-indigo-500/10 border border-indigo-500/20 rounded-xl text-indigo-600">
            <Activity className="w-5 h-5" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-bold text-stone-900 font-sans tracking-tight">
                Administration &amp; Monitoring
              </h2>
              {/* SSE Live Status Indicator */}
              <div className="flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-white border border-stone-200/80 shadow-2xs">
                <span
                  className={`w-2 h-2 rounded-full ${
                    isLiveConnected
                      ? "bg-emerald-500 animate-pulse ring-2 ring-emerald-500/20"
                      : "bg-amber-500"
                  }`}
                />
                <span className="text-[10px] font-mono text-stone-700 font-bold">
                  {isLiveConnected ? "LIVE SSE" : "CONNECTING..."}
                </span>
              </div>
            </div>
            <p className="text-xs text-stone-500 font-sans mt-0.5">
              Real-time ADK telemetry, Vertex AI Memory Bank analytics, and token optimization engine
            </p>
          </div>
        </div>

        {/* Action Controls & Sub-Tab Switcher */}
        <div className="flex flex-wrap items-center gap-2 self-stretch sm:self-auto justify-between sm:justify-end">
          {/* Sub-Tab Switcher */}
          <div className="flex items-center bg-stone-100 p-1 rounded-xl border border-stone-200/80">
            <button
              type="button"
              onClick={() => setActiveSubTab("tokens")}
              className={`px-3 py-1.5 rounded-lg text-xs font-sans font-bold transition-all cursor-pointer flex items-center gap-1.5 ${
                activeSubTab === "tokens"
                  ? "bg-white text-stone-900 shadow-2xs border border-stone-200"
                  : "text-stone-600 hover:text-stone-900 hover:bg-stone-200/60"
              }`}
            >
              <Zap className={`w-3 h-3 ${activeSubTab === "tokens" ? "text-amber-600" : "text-stone-400"}`} />
              <span>Token Engine</span>
            </button>

            <button
              type="button"
              onClick={() => setActiveSubTab("telemetry")}
              className={`px-3 py-1.5 rounded-lg text-xs font-sans font-bold transition-all cursor-pointer flex items-center gap-1.5 ${
                activeSubTab === "telemetry"
                  ? "bg-white text-stone-900 shadow-2xs border border-stone-200"
                  : "text-stone-600 hover:text-stone-900 hover:bg-stone-200/60"
              }`}
            >
              <Terminal className={`w-3.5 h-3.5 ${activeSubTab === "telemetry" ? "text-indigo-600" : "text-stone-400"}`} />
              <span>ADK Telemetry</span>
              <span className="text-[10px] px-1.5 py-0.2 rounded-full bg-stone-200/80 text-stone-700 font-mono font-bold">
                {totalCount}
              </span>
            </button>

            <button
              type="button"
              onClick={() => setActiveSubTab("infra")}
              className={`px-3 py-1.5 rounded-lg text-xs font-sans font-bold transition-all cursor-pointer flex items-center gap-1.5 ${
                activeSubTab === "infra"
                  ? "bg-white text-stone-900 shadow-2xs border border-stone-200"
                  : "text-stone-600 hover:text-stone-900 hover:bg-stone-200/60"
              }`}
            >
              <Server className={`w-3.5 h-3.5 ${activeSubTab === "infra" ? "text-emerald-600" : "text-stone-400"}`} />
              <span>GCP &amp; STT Config</span>
            </button>
          </div>

          <button
            type="button"
            onClick={handleClearEvents}
            disabled={events.length === 0}
            title="Clear all recorded events"
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-stone-600 hover:text-red-600 hover:bg-red-50 border border-stone-200/80 rounded-xl transition-colors disabled:opacity-30 cursor-pointer font-sans"
          >
            <Trash2 className="w-3.5 h-3.5" />
            <span className="hidden md:inline">Clear Events</span>
          </button>
        </div>
      </div>

      {/* Main Tab Content */}
      <div className="bg-stone-50/30">
        {activeSubTab === "tokens" && (
          <TokenVisualizer
            events={events}
            rawTranscript={rawTranscript}
            liveSummary={liveSummary}
            serverConfig={serverConfig}
          />
        )}

        {activeSubTab === "infra" && (
          // max-w-4xl caps the reading width; mx-auto is what keeps that column centred in the
          // full-width tab content instead of pinned to the left edge.
          <div className="p-6 space-y-6 max-w-4xl mx-auto">
            {/* Speech-to-Text & Speaker Diarization Card */}
            <div className="bg-white border border-stone-200/90 rounded-2xl p-5 space-y-5 shadow-2xs">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-stone-100 pb-4">
                <div className="flex items-center gap-3">
                  <div className="p-2.5 bg-indigo-50 border border-indigo-100 rounded-xl text-indigo-600">
                    <Radio className="w-5 h-5" />
                  </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <h3 className="text-sm font-bold text-stone-900 font-sans tracking-wide uppercase">
                        Speech-to-Text &amp; Acoustic Speaker Diarization
                      </h3>
                    </div>
                    <p className="text-xs text-stone-500 mt-0.5">
                      Toggle between Google Cloud Speech-to-Text V2 (acoustic voice clustering) and the default Gemini pipeline.
                    </p>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <span
                    className={`px-3 py-1 text-xs font-mono font-bold rounded-lg border flex items-center gap-1.5 ${
                      sttConfig.enableDiarization
                        ? "bg-indigo-50 text-indigo-700 border-indigo-200"
                        : "bg-stone-100 text-stone-700 border-stone-200"
                    }`}
                  >
                    <Users className="w-3.5 h-3.5" />
                    <span>{sttConfig.enableDiarization ? "Cloud STT V2 Diarization" : "Gemini Multimodal STT"}</span>
                  </span>
                </div>
              </div>

              {/* Main Toggle Switch */}
              <div className="flex items-center justify-between p-4 bg-stone-50 border border-stone-200/80 rounded-xl">
                <div className="space-y-1 pr-4">
                  <span className="text-xs font-bold text-stone-900 block font-sans">
                    Enable Google Cloud STT V2 Speaker Diarization
                  </span>
                  <p className="text-xs text-stone-600 leading-relaxed">
                    Acoustically distinguishes between multiple speakers (up to the maximum below) and labels individual turns (<code className="text-stone-800 font-mono font-semibold">Speaker 1:</code>, <code className="text-stone-800 font-mono font-semibold">Speaker 2:</code>). Automatically falls back to Gemini when disabled or unauthenticated.
                  </p>
                </div>

                <button
                  type="button"
                  onClick={() =>
                    // Deliberately does NOT raise minSpeakers. A floor of 2 forces the recognizer
                    // to invent a second speaker out of one voice — see cloud-stt.ts buildV1Config.
                    setSttConfig((prev) => ({
                      ...prev,
                      enableDiarization: !prev.enableDiarization,
                      provider: !prev.enableDiarization ? "google_cloud_stt" : "gemini",
                    }))
                  }
                  className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${
                    sttConfig.enableDiarization ? "bg-indigo-600" : "bg-stone-300"
                  }`}
                  role="switch"
                  aria-checked={sttConfig.enableDiarization}
                >
                  <span
                    className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow-sm ring-0 transition duration-200 ease-in-out ${
                      sttConfig.enableDiarization ? "translate-x-5" : "translate-x-0"
                    }`}
                  />
                </button>
              </div>

              {/* Expected speakers — ONE control, ONE thumb. It sets the UPPER bound only; the
                  lower bound is pinned at 1 everywhere (see cloud-stt.ts buildV1Config), so there
                  is deliberately no way to raise it from the UI. */}
              <div className="p-4 bg-stone-50/70 border border-stone-200/80 rounded-xl space-y-2">
                <div className="flex items-center justify-between gap-3">
                  <label className="text-xs font-bold text-stone-800 flex items-center gap-1.5 font-sans">
                    <Users className="w-3.5 h-3.5 text-stone-500" />
                    <span>Expected Speakers</span>
                  </label>
                  <input
                    type="text"
                    inputMode="numeric"
                    aria-label="Maximum expected speakers"
                    value={speakerDraft ?? String(sttConfig.maxSpeakers)}
                    disabled={!sttConfig.enableDiarization}
                    onChange={(e) => handleSpeakerInput(e.target.value)}
                    onFocus={(e) => e.currentTarget.select()}
                    onBlur={commitSpeakerInput}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") e.currentTarget.blur();
                    }}
                    className="w-9 text-xs font-mono font-bold text-stone-900 bg-white px-2 py-0.5 rounded border border-stone-200 text-center focus:border-indigo-500 focus:outline-none disabled:opacity-40"
                  />
                </div>

                {/* One track: a tick per whole number, the span from 1 to the chosen maximum, and
                    a single thumb. Everything is placed with speakerOffset so a tick, its label and
                    the thumb share a centre. */}
                <div className="pt-1">
                  <div className="relative h-10">
                    <div className="absolute inset-x-0 top-[10px] -translate-y-1/2 h-1.5 rounded-full bg-stone-200" />
                    <div
                      className={`absolute top-[10px] -translate-y-1/2 h-1.5 rounded-full ${
                        sttConfig.enableDiarization ? "bg-indigo-600" : "bg-stone-300"
                      }`}
                      style={{
                        left: speakerOffset(1),
                        width: `calc(${speakerOffset(sttConfig.maxSpeakers)} - ${speakerOffset(1)})`,
                      }}
                    />
                    {/* One pass per whole number: the dot on the track and the number under it are
                        the same element, so they can never drift apart. */}
                    {SPEAKER_TICKS.map((n) => {
                      const inSpan = n <= sttConfig.maxSpeakers;
                      return (
                        <span
                          key={n}
                          className="absolute top-0 -translate-x-1/2 flex flex-col items-center pointer-events-none select-none"
                          style={{ left: speakerOffset(n) }}
                        >
                          <span
                            aria-hidden
                            className={`mt-[7px] w-1.5 h-1.5 rounded-full ${
                              !sttConfig.enableDiarization ? "bg-stone-300" : inSpan ? "bg-white/90" : "bg-stone-400/70"
                            }`}
                          />
                          <span
                            aria-hidden
                            className={`mt-[11px] text-[10px] font-mono tabular-nums ${
                              !sttConfig.enableDiarization
                                ? "text-stone-300"
                                : inSpan
                                  ? "text-indigo-700 font-bold"
                                  : "text-stone-400"
                            }`}
                          >
                            {n}
                          </span>
                        </span>
                      );
                    })}
                    <input
                      type="range"
                      aria-label="Maximum expected speakers"
                      min={1}
                      max={SPEAKER_MAX}
                      step={1}
                      value={sttConfig.maxSpeakers}
                      disabled={!sttConfig.enableDiarization}
                      onChange={(e) => {
                        setSpeakerDraft(null);
                        setSttConfig((prev) => ({ ...prev, maxSpeakers: Number(e.target.value) }));
                      }}
                      className={RANGE_THUMB}
                    />
                  </div>
                </div>

                <span className="text-[10px] text-stone-500 block">
                  Most people Cloud STT should expect. It still auto-detects below this — a solo
                  brain-dump stays one speaker at any setting.
                </span>
              </div>

              {/* Status & Test Playground */}
              <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 pt-2 border-t border-stone-100">
                <div className="flex items-center gap-2">
                  {sttStatus?.authenticated ? (
                    <div className="flex items-center gap-1.5 text-xs text-emerald-700 bg-emerald-50 px-2.5 py-1 rounded-lg border border-emerald-200 font-semibold font-sans">
                      <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />
                      <span>Cloud STT Ready (ADC Authenticated • {sttStatus.projectId || serverConfig?.projectId})</span>
                    </div>
                  ) : (
                    <div className="flex items-center gap-1.5 text-xs text-amber-700 bg-amber-50 px-2.5 py-1 rounded-lg border border-amber-200 font-semibold font-sans">
                      <AlertTriangle className="w-3.5 h-3.5 text-amber-600" />
                      <span>ADC Unconfigured (Falling back to Gemini Transcriber)</span>
                    </div>
                  )}
                </div>

                <button
                  type="button"
                  onClick={handleTestStt}
                  disabled={isTestingStt}
                  className="px-3 py-1.5 bg-stone-900 hover:bg-stone-800 text-white rounded-xl text-xs font-semibold font-sans transition-colors cursor-pointer flex items-center gap-1.5 disabled:opacity-50"
                >
                  {isTestingStt ? (
                    <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <Sparkles className="w-3.5 h-3.5 text-amber-400" />
                  )}
                  <span>Test Diarization Pipeline</span>
                </button>
              </div>

              {/* Test Result Display */}
              {sttTestResult && (
                <div
                  className={`p-3.5 rounded-xl border text-xs space-y-1.5 ${
                    sttTestResult.status === "success"
                      ? "bg-emerald-50/70 border-emerald-200 text-emerald-900"
                      : "bg-red-50/70 border-red-200 text-red-900"
                  }`}
                >
                  <div className="flex items-center justify-between font-mono font-bold">
                    <span>
                      Provider: <code className="bg-white/80 px-1 py-0.5 rounded">{sttTestResult.provider}</code>
                    </span>
                    <span>
                      Detected Speakers: {sttTestResult.speakerCount}
                    </span>
                  </div>
                  <p className="font-sans text-xs">
                    {sttTestResult.error ? `Error: ${sttTestResult.error}` : `Output: ${sttTestResult.text}`}
                  </p>
                </div>
              )}
            </div>

            {/* Connected Google Cloud Infrastructure */}
            <div className="bg-white border border-stone-200/90 rounded-2xl p-5 space-y-4 shadow-2xs">
              <div className="flex items-center gap-2.5 text-emerald-700">
                <ShieldCheck className="w-5 h-5 text-emerald-600" />
                <h3 className="text-sm font-bold font-sans tracking-wide uppercase">
                  Connected Google Cloud Infrastructure
                </h3>
              </div>
              <p className="text-xs text-stone-600 leading-relaxed">
                Scribant is linked to Vertex AI Agent Engine with Application Default Credentials (ADC) and Google Cloud IAM.
              </p>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-3 pt-2">
                <div className="p-3 bg-stone-50 border border-stone-200/80 rounded-xl space-y-1 font-mono text-xs">
                  <span className="text-[10px] text-stone-500 uppercase tracking-wider block">GCP Project</span>
                  <span className="text-stone-900 font-bold">{serverConfig?.projectId || "Not configured"}</span>
                </div>

                <div className="p-3 bg-stone-50 border border-stone-200/80 rounded-xl space-y-1 font-mono text-xs">
                  <span className="text-[10px] text-stone-500 uppercase tracking-wider block">Vertex AI Region</span>
                  <span className="text-stone-900 font-bold">{serverConfig?.location || "us-central1"}</span>
                </div>

                <div className="p-3 bg-stone-50 border border-stone-200/80 rounded-xl space-y-1 font-mono text-xs">
                  <span className="text-[10px] text-stone-500 uppercase tracking-wider block">Reasoning Engine ID</span>
                  <span className="text-emerald-700 font-bold">{serverConfig?.agentEngineId || "Not configured"}</span>
                </div>

                <div className="p-3 bg-stone-50 border border-stone-200/80 rounded-xl space-y-1 font-mono text-xs">
                  <span className="text-[10px] text-stone-500 uppercase tracking-wider block">Gemini Model</span>
                  <span className="text-amber-700 font-bold">{serverConfig?.model || "gemini-3.7-flash"}</span>
                </div>
              </div>
            </div>

            <div className="bg-white border border-stone-200/90 rounded-2xl p-5 space-y-3 shadow-2xs">
              <h4 className="text-xs font-bold text-stone-800 font-sans uppercase tracking-wider">
                Memory Service Architecture
              </h4>
              <p className="text-xs text-stone-600 leading-relaxed">
                ADK orchestrates sub-agents (<code className="text-stone-800 font-mono">proofreader</code>, <code className="text-stone-800 font-mono">intentClassifier</code>, <code className="text-stone-800 font-mono">liveSummarizer</code>, <code className="text-stone-800 font-mono">audioTranscriber</code>) with dynamic session memory. High-value memories are indexed in Vertex AI Agent Engine, avoiding context stuffing on repeated audio chunks.
              </p>
            </div>
          </div>
        )}

        {activeSubTab === "telemetry" && (
          <div className="flex flex-col space-y-4 p-5 font-sans">
            {/* Controls Bar: Filters & Quick Test Buttons */}
            <div className="p-4 bg-white border border-stone-200/90 rounded-2xl shadow-2xs space-y-3">
              {/* Top row: Event Type Filter Tabs & Quick Test Buttons */}
              <div className="flex flex-wrap items-center justify-between gap-3">
                {/* Event Type Filter Tabs */}
                <div className="flex flex-wrap items-center gap-1.5 bg-stone-100 p-1 rounded-xl border border-stone-200/80">
                  <button
                    type="button"
                    onClick={() => setEventTypeFilter("all")}
                    className={`px-2.5 py-1 rounded-lg text-xs font-semibold transition-all flex items-center gap-1.5 cursor-pointer ${
                      eventTypeFilter === "all"
                        ? "bg-white text-stone-900 shadow-2xs font-bold border border-stone-200"
                        : "text-stone-600 hover:text-stone-900"
                    }`}
                  >
                    <Activity className="w-3 h-3 text-stone-500" />
                    <span>All</span>
                    <span className="text-[10px] px-1.5 py-0.2 rounded-full bg-stone-200/80 text-stone-700 font-mono font-bold">
                      {totalCount}
                    </span>
                  </button>

                  <button
                    type="button"
                    onClick={() => setEventTypeFilter((prev) => (prev === "memory:insert" ? "all" : "memory:insert"))}
                    className={`px-2.5 py-1 rounded-lg text-xs font-semibold transition-all flex items-center gap-1.5 cursor-pointer ${
                      eventTypeFilter === "memory:insert"
                        ? "bg-emerald-50 text-emerald-800 shadow-2xs border border-emerald-300 font-bold"
                        : "text-stone-600 hover:text-emerald-700"
                    }`}
                  >
                    <ArrowDownToLine className="w-3 h-3 text-emerald-600" />
                    <span>memory:insert</span>
                    <span className="text-[10px] px-1.5 py-0.2 rounded-full bg-emerald-100 text-emerald-800 font-bold font-mono">
                      {insertCount}
                    </span>
                  </button>

                  <button
                    type="button"
                    onClick={() => setEventTypeFilter((prev) => (prev === "memory:retrieve" ? "all" : "memory:retrieve"))}
                    className={`px-2.5 py-1 rounded-lg text-xs font-semibold transition-all flex items-center gap-1.5 cursor-pointer ${
                      eventTypeFilter === "memory:retrieve"
                        ? "bg-sky-50 text-sky-800 shadow-2xs border border-sky-300 font-bold"
                        : "text-stone-600 hover:text-sky-700"
                    }`}
                  >
                    <ArrowUpFromLine className="w-3 h-3 text-sky-600" />
                    <span>memory:retrieve</span>
                    <span className="text-[10px] px-1.5 py-0.2 rounded-full bg-sky-100 text-sky-800 font-bold font-mono">
                      {retrieveCount}
                    </span>
                  </button>

                  <button
                    type="button"
                    onClick={() => setEventTypeFilter((prev) => (prev === "tool_call" ? "all" : "tool_call"))}
                    className={`px-2.5 py-1 rounded-lg text-xs font-semibold transition-all flex items-center gap-1.5 cursor-pointer ${
                      eventTypeFilter === "tool_call"
                        ? "bg-purple-50 text-purple-800 shadow-2xs border border-purple-300 font-bold"
                        : "text-stone-600 hover:text-purple-700"
                    }`}
                  >
                    <Wrench className="w-3 h-3 text-purple-600" />
                    <span>tools</span>
                    <span className="text-[10px] px-1.5 py-0.2 rounded-full bg-purple-100 text-purple-800 font-bold font-mono">
                      {toolCount}
                    </span>
                  </button>

                  <button
                    type="button"
                    onClick={() => setEventTypeFilter((prev) => (prev === "stt:transcribe" ? "all" : "stt:transcribe"))}
                    className={`px-2.5 py-1 rounded-lg text-xs font-semibold transition-all flex items-center gap-1.5 cursor-pointer ${
                      eventTypeFilter === "stt:transcribe"
                        ? "bg-indigo-50 text-indigo-800 shadow-2xs border border-indigo-300 font-bold"
                        : "text-stone-600 hover:text-indigo-700"
                    }`}
                  >
                    <Radio className="w-3 h-3 text-indigo-600" />
                    <span>stt:diarization</span>
                    <span className="text-[10px] px-1.5 py-0.2 rounded-full bg-indigo-100 text-indigo-800 font-bold font-mono">
                      {sttCount}
                    </span>
                  </button>

                  {errorCount > 0 && (
                    <button
                      type="button"
                      onClick={() => setEventTypeFilter((prev) => (prev === "error" ? "all" : "error"))}
                      className={`px-2.5 py-1 rounded-lg text-xs font-semibold transition-all flex items-center gap-1.5 cursor-pointer ${
                        eventTypeFilter === "error"
                          ? "bg-red-50 text-red-800 shadow-2xs border border-red-300 font-bold"
                          : "text-red-600 hover:text-red-800"
                      }`}
                    >
                      <AlertCircle className="w-3 h-3 text-red-600" />
                      <span>errors</span>
                      <span className="text-[10px] px-1.5 py-0.2 rounded-full bg-red-100 text-red-800 font-bold font-mono">
                        {errorCount}
                      </span>
                    </button>
                  )}
                </div>

                {/* Quick Simulation / Test Buttons */}
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={handleTriggerTestInsert}
                    disabled={isTestingAction !== null}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-xl bg-emerald-50 hover:bg-emerald-100 text-emerald-800 border border-emerald-200 transition-all disabled:opacity-50 cursor-pointer shadow-2xs"
                  >
                    {isTestingAction === "insert" ? (
                      <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <ArrowDownToLine className="w-3.5 h-3.5 text-emerald-600" />
                    )}
                    <span>Test Ingest</span>
                  </button>

                  <button
                    type="button"
                    onClick={handleTriggerTestRetrieve}
                    disabled={isTestingAction !== null}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-xl bg-sky-50 hover:bg-sky-100 text-sky-800 border border-sky-200 transition-all disabled:opacity-50 cursor-pointer shadow-2xs"
                  >
                    {isTestingAction === "retrieve" ? (
                      <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <ArrowUpFromLine className="w-3.5 h-3.5 text-sky-600" />
                    )}
                    <span>Test Search</span>
                  </button>
                </div>
              </div>

              {/* Bottom row: Search input, Author dropdown, Status filter */}
              <div className="flex flex-wrap items-center justify-between gap-3 pt-2 border-t border-stone-100 text-xs">
                <div className="flex flex-wrap items-center gap-2 flex-1 min-w-[200px]">
                  {/* Search Box */}
                  <div className="relative flex-1 max-w-xs">
                    <Search className="w-3.5 h-3.5 text-stone-400 absolute left-3 top-1/2 -translate-y-1/2" />
                    <input
                      type="text"
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      placeholder="Search telemetry events..."
                      className="w-full bg-stone-50 border border-stone-200 rounded-xl pl-8 pr-2.5 py-1.5 text-xs text-stone-800 placeholder-stone-400 font-sans outline-none focus:border-amber-500"
                    />
                    {searchQuery && (
                      <button
                        type="button"
                        onClick={() => setSearchQuery("")}
                        className="absolute right-2.5 top-1/2 -translate-y-1/2 text-stone-400 hover:text-stone-600"
                      >
                        ×
                      </button>
                    )}
                  </div>

                  {/* Author Filter Dropdown */}
                  {authors.length > 0 && (
                    <select
                      value={authorFilter}
                      onChange={(e) => setAuthorFilter(e.target.value)}
                      className="bg-stone-50 border border-stone-200 text-stone-700 rounded-xl px-2.5 py-1.5 text-xs font-sans outline-none cursor-pointer"
                    >
                      <option value="all">All Authors</option>
                      {authors.map((a) => (
                        <option key={a} value={a}>
                          Author: {a}
                        </option>
                      ))}
                    </select>
                  )}

                  {/* Status Filter */}
                  <div className="flex items-center bg-stone-100 border border-stone-200 rounded-xl p-0.5">
                    {(["all", "success", "error"] as StatusFilterType[]).map((st) => (
                      <button
                        key={st}
                        type="button"
                        onClick={() => setStatusFilter(st)}
                        className={`px-2.5 py-1 rounded-lg text-xs font-sans capitalize transition-colors cursor-pointer ${
                          statusFilter === st
                            ? "bg-white text-stone-900 font-bold shadow-2xs"
                            : "text-stone-600 hover:text-stone-900"
                        }`}
                      >
                        {st}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </div>

            {/* Event List (Expands vertically on the page without max-h scroll limits!) */}
            <div className="space-y-3">
              {filteredEvents.length === 0 ? (
                <div className="p-8 text-center bg-white border border-stone-200/90 rounded-2xl text-stone-500 space-y-2">
                  <Activity className="w-8 h-8 mx-auto opacity-30 text-stone-400 animate-pulse" />
                  <p className="text-xs font-semibold text-stone-700">No ADK telemetry events match current filters.</p>
                  <p className="text-xs text-stone-500">
                    Speak into the microphone or click "Test Ingest" / "Test Search" to generate live events.
                  </p>
                </div>
              ) : (
                filteredEvents.map((ev) => {
                  const classified = classifyEvent(ev);
                  const isExpanded = expandedEventId === ev.id;
                  const isCopied = copiedId === ev.id;
                  const timestampStr = new Date(ev.timestamp || Date.now()).toLocaleTimeString();

                  let badgeBg = "bg-stone-100 text-stone-800 border-stone-200";
                  let Icon = Activity;

                  if (classified.category === "memory:insert") {
                    badgeBg = "bg-emerald-50 text-emerald-800 border-emerald-200";
                    Icon = ArrowDownToLine;
                  } else if (classified.category === "memory:retrieve") {
                    badgeBg = "bg-sky-50 text-sky-800 border-sky-200";
                    Icon = ArrowUpFromLine;
                  } else if (classified.category === "tool_call") {
                    badgeBg = "bg-purple-50 text-purple-800 border-purple-200";
                    Icon = Wrench;
                  } else if (classified.category === "stt:transcribe" || ev.author === "google_cloud_stt") {
                    badgeBg = "bg-indigo-50 text-indigo-800 border-indigo-200";
                    Icon = Radio;
                  } else if (classified.status === "error") {
                    badgeBg = "bg-red-50 text-red-800 border-red-200";
                    Icon = AlertCircle;
                  }

                  return (
                    <div
                      key={ev.id}
                      className="bg-white border border-stone-200/90 rounded-2xl overflow-hidden shadow-2xs transition-all hover:border-stone-300"
                    >
                      <button
                        onClick={() => setExpandedEventId(isExpanded ? null : ev.id)}
                        className="w-full text-left p-4 flex items-center justify-between gap-3 hover:bg-stone-50/70 transition-colors cursor-pointer"
                      >
                        <div className="flex flex-wrap items-center gap-3">
                          <span className={`px-2.5 py-1 text-xs font-mono font-bold rounded-lg border flex items-center gap-1.5 ${badgeBg}`}>
                            <Icon className="w-3.5 h-3.5" />
                            <span>{classified.category}</span>
                          </span>

                          <span className="text-xs font-mono font-bold text-stone-800">
                            {ev.author || "system"}
                          </span>

                          <span className="text-xs text-stone-600 font-sans border-l border-stone-200 pl-3 line-clamp-1">
                            {classified.summaryText}
                          </span>
                        </div>

                        <div className="flex items-center gap-3 shrink-0">
                          <span className="text-[11px] font-mono text-stone-400">
                            {timestampStr}
                          </span>
                          {isExpanded ? (
                            <ChevronDown className="w-4 h-4 text-stone-600" />
                          ) : (
                            <ChevronRight className="w-4 h-4 text-stone-400" />
                          )}
                        </div>
                      </button>

                      {isExpanded && (
                        <div className="p-4 pt-0 border-t border-stone-100 bg-stone-50/40 space-y-3 text-xs">
                          <div className="flex items-center justify-between pt-3">
                            <span className="font-mono text-[11px] font-bold text-stone-600 uppercase tracking-wider">
                              Event Payload JSON
                            </span>
                            <button
                              onClick={() => handleCopyJson(ev)}
                              className="flex items-center gap-1 text-xs font-semibold text-stone-600 hover:text-stone-900 cursor-pointer"
                            >
                              {isCopied ? (
                                <>
                                  <Check className="w-3.5 h-3.5 text-emerald-600" />
                                  <span className="text-emerald-600">Copied!</span>
                                </>
                              ) : (
                                <>
                                  <Copy className="w-3.5 h-3.5" />
                                  <span>Copy JSON</span>
                                </>
                              )}
                            </button>
                          </div>
                          <pre className="p-3 bg-stone-900 text-stone-200 rounded-xl font-mono text-[11px] overflow-x-auto border border-stone-800 leading-normal">
                            {JSON.stringify(ev, null, 2)}
                          </pre>
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
