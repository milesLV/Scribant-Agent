import { useCallback, useRef } from "react";
import { toUtterances, type Utterance, type UtteranceSource } from "../utils/paragraphs";

// The record -> upload -> transcribe loop, shared by the mic and the shared tab so their chunk
// length and diarization defaults cannot drift apart again.
// ponytail: one standalone chunk per request, no overlap. A rolling 30s window (bce2bd7) made Cloud
// STT re-decide committed audio and relabel it step to step; the upgrade is streamingRecognize
// (useStreamingCapture), not a bigger window.

/** One recorded chunk. ~8s: long enough for Cloud STT to cluster, short enough to feel live. */
export const CHUNK_MS = 8000;

export interface CapturedChunk {
  utterances: Utterance[];
  startedAt: number; // client Date.now() when this chunk started recording
}

interface Options {
  source: UtteranceSource & ("stt" | "tab");
  sourceTag: "mic" | "tab";
  onChunk: (chunk: CapturedChunk) => void;
  /** Called when diarization was asked for but the request fell back to a non-diarizing engine. */
  onDegraded?: (provider: string) => void;
}

export function pickMimeType(): string {
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"];
  return candidates.find(t => MediaRecorder.isTypeSupported(t)) || "";
}

export interface SttSettings { enableDiarization: boolean; maxSpeakers: number }

// Browser copy of cloud-stt.ts DEFAULT_MAX_SPEAKERS (that module imports node:assert). Change both.
export const DEFAULT_MAX_SPEAKERS = 1;

// Read fresh per chunk so an Admin change applies without a restart. One default for mic and tab.
// Deliberately ignores a persisted `minSpeakers`: a floor of 2 splits one voice into two on noisy
// audio, and the reverted diarization toggle left `minSpeakers: 2` in some browsers' localStorage.
export function readSttConfig(): SttSettings {
  const fallback = { enableDiarization: false, maxSpeakers: DEFAULT_MAX_SPEAKERS };
  try {
    const saved = localStorage.getItem("scribant_stt_config");
    if (!saved) return fallback;
    const parsed = JSON.parse(saved);
    return {
      enableDiarization: Boolean(parsed.enableDiarization),
      maxSpeakers: Number(parsed.maxSpeakers) || fallback.maxSpeakers,
    };
  } catch {
    return fallback;
  }
}

// The server wants raw base64, without FileReader's "data:audio/webm;base64," prefix.
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

export function useChunkedCapture({ source, sourceTag, onChunk, onDegraded }: Options) {
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  // Flipped by stop() so the chunk loop (which re-arms itself in onstop) knows not to record another.
  const stoppingRef = useRef(false);
  const sessionIdRef = useRef("");

  const send = useCallback(async (startedAt: number, blob: Blob, cfg: SttSettings) => {
    if (blob.size === 0) return;
    try {
      const res = await fetch("/api/transcribe-audio", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          audio: await blobToBase64(blob),
          mimeType: blob.type || "audio/webm",
          source: sourceTag,
          enableDiarization: cfg.enableDiarization,
          // Always 1 — see readSttConfig. maxSpeakers is a cap and is safe to pass through.
          minSpeakers: 1,
          maxSpeakers: cfg.maxSpeakers,
          // Only carries the multi-speaker latch; labels themselves stay chunk-local.
          sessionId: sessionIdRef.current,
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (cfg.enableDiarization && data.degraded) onDegraded?.(data.provider);

      // Same rule as the streaming path: if the user said to expect more than one speaker, label
      // from the first word instead of waiting for the latch to catch a second voice.
      const utterances = toUtterances({ ...data, alwaysLabel: cfg.maxSpeakers > 1 }, source);
      if (utterances.length) onChunk({ utterances, startedAt });
    } catch (err) {
      // One lost chunk (network blip, transient 429) shouldn't end the capture — just skip it and
      // keep recording; the next chunk tries again on its own.
      console.warn(`[${sourceTag}-capture] chunk transcription failed:`, err);
    }
  }, [onChunk, onDegraded, source, sourceTag]);

  // Records ONE self-contained chunk — a fresh MediaRecorder per chunk rather than `timeslice` on a
  // single long-lived one, so every upload is a fully valid standalone webm file. A mid-stream
  // timeslice blob has no container header and most STT backends can't decode it alone.
  const recordNext = useCallback(() => {
    const stream = streamRef.current;
    if (!stream || stoppingRef.current) return;
    const startedAt = Date.now();
    const rec = new MediaRecorder(stream, { mimeType: pickMimeType() });
    const parts: Blob[] = [];
    rec.ondataavailable = e => { if (e.data.size > 0) parts.push(e.data); };
    rec.onstop = () => {
      // Read once per chunk, so a mid-session toggle in Admin can't have the audio recorded under
      // one setting and the request built under the other.
      send(startedAt, new Blob(parts, { type: rec.mimeType }), readSttConfig());
      recordNext(); // chain straight into the next chunk — no gap beyond one stop/start tick
    };
    recorderRef.current = rec;
    rec.start();
    setTimeout(() => { if (rec.state === "recording") rec.stop(); }, CHUNK_MS);
  }, [send]);

  const start = useCallback((stream: MediaStream, sessionId: string) => {
    streamRef.current = stream;
    stoppingRef.current = false;
    sessionIdRef.current = sessionId;
    recordNext();
  }, [recordNext]);

  const stop = useCallback(() => {
    stoppingRef.current = true;
    if (recorderRef.current?.state === "recording") recorderRef.current.stop();
    streamRef.current?.getTracks().forEach(t => t.stop());
    streamRef.current = null;
  }, []);

  return { start, stop };
}
