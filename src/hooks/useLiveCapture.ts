import { useCallback, useRef } from "react";
import { type UtteranceSource } from "../utils/paragraphs";
import { readSttConfig, useChunkedCapture, type CapturedChunk } from "./useChunkedCapture";
import { useStreamingCapture } from "./useStreamingCapture";

// Picks the capture transport and owns the fallback between them, so the mic and the shared tab
// cannot end up with different answers to "what happens when the stream dies".
//
//   diarization ON  -> one long-lived Cloud STT recognition (useStreamingCapture). Speaker labels
//                      hold for the whole recognition, which is the entire point of it.
//   diarization OFF -> independent 8s requests (useChunkedCapture), which is also the only path
//                      with a Gemini fallback for callers without Cloud credentials.
//
// A streaming failure falls back to chunked ON THE SAME MediaStream. Without that, a session with
// diarization enabled and no working Cloud STT produces no transcript at all — the mic's Web Speech
// finals are suppressed in diarization mode, so nothing else is writing.

interface Options {
  source: UtteranceSource & ("stt" | "tab");
  sourceTag: "mic" | "tab";
  onChunk: (chunk: CapturedChunk) => void;
  /** Non-final preview. Only the streaming path produces it. */
  onInterim?: (text: string) => void;
  /** User-facing degradation notice — quality dropped, capture continues. */
  onNotice?: (message: string) => void;
}

export function useLiveCapture({ source, sourceTag, onChunk, onInterim, onNotice }: Options) {
  const mediaRef = useRef<MediaStream | null>(null);
  const sessionRef = useRef("");
  const modeRef = useRef<"idle" | "streaming" | "chunked">("idle");

  const chunked = useChunkedCapture({
    source,
    sourceTag,
    onChunk,
    onDegraded: p => onNotice?.(`Diarization unavailable — transcribed with ${p} instead, speakers may be merged.`),
  });

  // Declared before the streaming hook because the fallback it receives has to be able to stop it.
  const streamingRef = useRef<{ stop: (o?: { keepStream?: boolean }) => void } | null>(null);

  const fallbackToChunked = useCallback((why: string) => {
    if (modeRef.current !== "streaming") return; // already fell back, or never started
    modeRef.current = "chunked";
    const media = mediaRef.current;
    streamingRef.current?.stop({ keepStream: true });
    onNotice?.(`Live diarization dropped out (${why}). Still transcribing, but speaker labels will only hold within each ~8s chunk.`);
    if (media) chunked.start(media, sessionRef.current);
  }, [chunked, onNotice]);

  const streaming = useStreamingCapture({
    source,
    sourceTag,
    onChunk,
    onInterim,
    onError: fallbackToChunked,
  });
  streamingRef.current = streaming;

  const start = useCallback((media: MediaStream, sessionId: string) => {
    mediaRef.current = media;
    sessionRef.current = sessionId;
    if (readSttConfig().enableDiarization) {
      modeRef.current = "streaming";
      streaming.start(media, sessionId);
    } else {
      modeRef.current = "chunked";
      chunked.start(media, sessionId);
    }
  }, [chunked, streaming]);

  const stop = useCallback(() => {
    if (modeRef.current === "streaming") streaming.stop();
    else if (modeRef.current === "chunked") chunked.stop();
    modeRef.current = "idle";
    mediaRef.current = null;
  }, [chunked, streaming]);

  return {
    start,
    stop,
    isActive: () => modeRef.current !== "idle",
    /** Which transport is live. Callers use it to decide who owns the interim preview. */
    mode: () => modeRef.current,
  };
}
