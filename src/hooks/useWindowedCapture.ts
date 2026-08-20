import { useCallback, useRef } from "react";
import { toUtterances, type Utterance, type UtteranceSource } from "../utils/paragraphs";
import {
  AudioWindow, STEP_MS, TARGET_SAMPLE_RATE, downmixToMono, resample, toBase64,
} from "../utils/audio-window";

// The record -> decode -> window -> transcribe loop, shared by BOTH capture paths.
//
// The mic and the shared tab used to carry a copy of this each, which is how they ended up with
// different chunk durations (8000 vs 9000) and opposite diarization defaults. One implementation
// means they cannot drift again.
//
// Why a window instead of a chunk: Cloud STT's sync recognize clusters speakers within one request,
// so an 8-second clip gives it too little per speaker to tell two voices apart, and the tags it
// returns are numbered per request and mean nothing across requests. See utils/audio-window.ts.

export interface WindowedChunk {
  utterances: Utterance[];
  startedAt: number;
}

interface Options {
  source: UtteranceSource & ("stt" | "tab");
  sourceTag: "mic" | "tab";
  onChunk: (chunk: WindowedChunk) => void;
  onDegraded?: (provider: string) => void;
}

// Picks the best webm/opus variant this browser actually supports; Chrome always supports the
// first, but this stays defensive rather than hard-coding it.
function pickMimeType(): string {
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"];
  return candidates.find(t => MediaRecorder.isTypeSupported(t)) || "";
}

export interface SttSettings { enableDiarization: boolean; minSpeakers: number; maxSpeakers: number }

/** Diarization settings, read fresh each step so a change in Admin takes effect without a restart. */
export function readSttConfig(): SttSettings {
  // ONE default for every caller. The mic path used to default this to true and the tab path to
  // false, so the same session diarized or didn't depending on which capture started it.
  const fallback = { enableDiarization: false, minSpeakers: 2, maxSpeakers: 5 };
  try {
    const saved = localStorage.getItem("scribant_stt_config");
    if (!saved) return fallback;
    const parsed = JSON.parse(saved);
    return {
      enableDiarization: Boolean(parsed.enableDiarization),
      minSpeakers: Number(parsed.minSpeakers) || fallback.minSpeakers,
      maxSpeakers: Number(parsed.maxSpeakers) || fallback.maxSpeakers,
    };
  } catch {
    return fallback;
  }
}

export function useWindowedCapture({ source, sourceTag, onChunk, onDegraded }: Options) {
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const stoppingRef = useRef(false);
  const windowRef = useRef<AudioWindow | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  // Absolute session time the server has committed through. Sent back so a retried or slow window
  // can never re-commit text the append-only transcript already holds.
  const committedRef = useRef(0);
  const sessionIdRef = useRef("");

  const send = useCallback(async (startedAt: number, blob: Blob, cfg: SttSettings) => {
    const win = windowRef.current;

    // Only the diarized path sends a window. Without diarization there is no registry to commit
    // through, so the server would transcribe and return the WHOLE window every step — appending
    // ~22 seconds of already-written text to an append-only transcript, over and over. That path
    // stays exactly what it was: one standalone chunk, transcribed once.
    const body = cfg.enableDiarization && win
      ? (() => {
          const snap = win.snapshot();
          return snap.audio ? {
            audio: snap.audio,
            mimeType: "audio/wav",
            encoding: "LINEAR16" as const,
            sampleRateHertz: snap.sampleRate,
            windowStartMs: snap.windowStartMs,
            commitFromMs: committedRef.current,
          } : null;
        })()
      : { audio: toBase64(new Uint8Array(await blob.arrayBuffer())), mimeType: blob.type || "audio/webm" };
    if (!body) return;

    try {
      const res = await fetch("/api/transcribe-audio", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...body,
          source: sourceTag,
          enableDiarization: cfg.enableDiarization,
          minSpeakers: cfg.minSpeakers,
          maxSpeakers: cfg.maxSpeakers,
          sessionId: sessionIdRef.current,
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (typeof data.committedThroughMs === "number") committedRef.current = data.committedThroughMs;
      if (cfg.enableDiarization && data.provider !== "google_cloud_stt") onDegraded?.(data.provider);

      const utterances = toUtterances(data, source);
      if (utterances.length) onChunk({ utterances, startedAt });
    } catch (err) {
      // One lost window shouldn't end the capture — the next one overlaps it heavily and will
      // recover most of the same audio anyway.
      console.warn(`[${sourceTag}-window] transcription failed:`, err);
    }
  }, [onChunk, onDegraded, source, sourceTag]);

  // Decode one recorded blob straight into the ring. Opus fragments can't be concatenated (only the
  // first carries a container header) which is why each step still records a standalone blob — but
  // once it is PCM that constraint is gone and the window can span as many steps as it likes.
  const ingest = useCallback(async (blob: Blob) => {
    if (blob.size === 0 || !windowRef.current) return;
    const ctx = audioCtxRef.current ?? (audioCtxRef.current = new AudioContext());
    const decoded = await ctx.decodeAudioData(await blob.arrayBuffer());
    const channels = Array.from({ length: decoded.numberOfChannels }, (_, i) => decoded.getChannelData(i));
    windowRef.current.push(resample(downmixToMono(channels), decoded.sampleRate, TARGET_SAMPLE_RATE));
  }, []);

  const recordNext = useCallback(() => {
    const stream = streamRef.current;
    if (!stream || stoppingRef.current) return;
    const startedAt = Date.now();
    const rec = new MediaRecorder(stream, { mimeType: pickMimeType() });
    const parts: Blob[] = [];
    rec.ondataavailable = e => { if (e.data.size > 0) parts.push(e.data); };
    rec.onstop = () => {
      const blob = new Blob(parts, { type: rec.mimeType });
      // Read once per step, so a mid-session toggle in Admin can't have the ring filled under one
      // setting and the request built under the other.
      const cfg = readSttConfig();
      (cfg.enableDiarization ? ingest(blob) : Promise.resolve())
        .then(() => send(startedAt, blob, cfg))
        .catch(err => console.warn(`[${sourceTag}-window] step failed:`, err));
      recordNext(); // chain straight into the next step — no gap beyond one stop/start tick
    };
    recorderRef.current = rec;
    rec.start();
    setTimeout(() => { if (rec.state === "recording") rec.stop(); }, STEP_MS);
  }, [ingest, send, sourceTag]);

  const start = useCallback((stream: MediaStream, sessionId: string) => {
    streamRef.current = stream;
    stoppingRef.current = false;
    windowRef.current = new AudioWindow();
    committedRef.current = 0;
    sessionIdRef.current = sessionId;
    recordNext();
  }, [recordNext]);

  const stop = useCallback(() => {
    stoppingRef.current = true;
    if (recorderRef.current?.state === "recording") recorderRef.current.stop();
    streamRef.current?.getTracks().forEach(t => t.stop());
    streamRef.current = null;
    windowRef.current = null;
    audioCtxRef.current?.close().catch(() => {});
    audioCtxRef.current = null;
  }, []);

  return { start, stop, isActive: () => Boolean(streamRef.current) };
}
