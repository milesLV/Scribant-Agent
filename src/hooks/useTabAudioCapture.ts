import { useCallback, useRef, useState } from "react";

// How long each recorded chunk is before it's uploaded for transcription. Web Speech API (used for
// the mic — see AudioRecorder.tsx) can't take an arbitrary MediaStream, so shared-tab audio needs
// its own record → upload → transcribe loop instead of reusing the recognizer.
const CHUNK_MS = 9000;

export interface TabAudioChunk {
  text: string;
  startedAt: number; // client Date.now() when this chunk started recording
}

interface Options {
  onChunk: (chunk: TabAudioChunk) => void;
  onError: (message: string) => void;
}

// Picks the best webm/opus variant this browser actually supports; Chrome always supports the
// first, but this stays defensive rather than hard-coding it.
function pickMimeType(): string {
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"];
  return candidates.find(t => MediaRecorder.isTypeSupported(t)) || "";
}

// FileReader's data: URL, with the "data:audio/webm;base64," prefix stripped — the server wants raw
// base64 to hand straight to Gemini as an inlineData part.
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

// Captures a shared Chrome tab's audio and periodically transcribes it server-side. Kept entirely
// separate from AudioRecorder's mic pipeline — different capture mechanism, different transcription
// backend — and only hands finished text back up via onChunk, tagged with when it started so the
// caller can order it against the mic transcript.
export function useTabAudioCapture({ onChunk, onError }: Options) {
  const [isSharing, setIsSharing] = useState(false);
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  // Flipped by stop() so the chunk loop (which re-arms itself in onstop) knows not to record another.
  const stoppingRef = useRef(false);

  const uploadChunk = useCallback(async (blob: Blob, startedAt: number) => {
    if (blob.size === 0) return;
    try {
      const base64 = await blobToBase64(blob);
      let enableDiarization = false;
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
          source: "tab",
          enableDiarization,
          minSpeakers,
          maxSpeakers,
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const text = String(data.text || "").trim();
      if (text) onChunk({ text, startedAt });
    } catch (err: any) {
      // One lost chunk (network blip, transient 429) shouldn't end the capture — just skip it and
      // keep recording; the next chunk tries again on its own.
      console.warn("[tab-audio] chunk transcription failed:", err);
    }
  }, [onChunk]);

  // Records ONE self-contained chunk — a fresh MediaRecorder per chunk rather than `timeslice` on a
  // single long-lived one, so every upload is a fully valid standalone webm file. A mid-stream
  // timeslice blob has no container header and most STT backends (Gemini included) can't decode it
  // alone.
  const recordNextChunk = useCallback(() => {
    const stream = streamRef.current;
    if (!stream || stoppingRef.current) return;
    const startedAt = Date.now();
    const rec = new MediaRecorder(stream, { mimeType: pickMimeType() });
    const parts: Blob[] = [];
    rec.ondataavailable = (e) => { if (e.data.size > 0) parts.push(e.data); };
    rec.onstop = () => {
      uploadChunk(new Blob(parts, { type: rec.mimeType }), startedAt);
      recordNextChunk(); // chain straight into the next chunk — no gap beyond one stop/start tick
    };
    recorderRef.current = rec;
    rec.start();
    setTimeout(() => { if (rec.state === "recording") rec.stop(); }, CHUNK_MS);
  }, [uploadChunk]);

  const stop = useCallback(() => {
    stoppingRef.current = true;
    if (recorderRef.current?.state === "recording") recorderRef.current.stop();
    streamRef.current?.getTracks().forEach(t => t.stop());
    streamRef.current = null;
    setIsSharing(false);
  }, []);

  const start = useCallback(async () => {
    if (typeof navigator.mediaDevices?.getDisplayMedia !== "function") {
      onError("Tab audio sharing isn't supported in this browser — try Chrome on desktop.");
      return;
    }
    try {
      // video:true is required by getDisplayMedia even though only the audio track is wanted —
      // Chrome rejects an audio-only request outright. The video track is stopped and dropped
      // immediately below; it's never recorded, encoded, or sent anywhere.
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      if (stream.getAudioTracks().length === 0) {
        stream.getTracks().forEach(t => t.stop());
        onError('No audio track came through — when sharing, pick "Chrome Tab" (not Window/Screen) and check "Share tab audio".');
        return;
      }
      stream.getVideoTracks().forEach(t => { t.stop(); stream.removeTrack(t); });
      // The only reliable "user clicked Chrome's native Stop Sharing bar" signal — fires on the
      // still-live audio track when the browser tears the whole capture down from outside our code.
      stream.getAudioTracks()[0].addEventListener("ended", () => stop());

      streamRef.current = stream;
      stoppingRef.current = false;
      setIsSharing(true);
      recordNextChunk();
    } catch (err: any) {
      if (err?.name !== "NotAllowedError") { // user just cancelled the picker — not an error
        onError(`Couldn't start tab sharing: ${err?.message || err}`);
      }
    }
  }, [onError, recordNextChunk, stop]);

  return { isSharing, start, stop };
}
