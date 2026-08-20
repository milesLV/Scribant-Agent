import { useCallback, useRef } from "react";
import { toUtterances, type Utterance, type UtteranceSource } from "../utils/paragraphs";
import { readSttConfig } from "./useChunkedCapture";

// Live diarized capture over ONE long-lived Cloud STT recognition (server: stt-stream.ts).
//
// The chunked hook next door uploads an independent 8s request at a time, which is why its speaker
// labels are chunk-local: each request clusters voices from scratch and "Speaker 1" in consecutive
// chunks is not the same person. Here the whole capture is one recognition, so a label means one
// person for as long as the stream lives.
//
// ponytail: audio goes up as WebM/Opus straight from MediaRecorder, the same encoder the chunked
// path already uses. Raw PCM would let us pick the sample rate, but it needs an AudioWorklet and a
// resampler — that was audio-window.ts, and it was deleted for good reason. WEBM_OPUS at 48kHz is
// accepted by streamingRecognize (verified against the live API), so there is nothing to gain.

/** How often recorded audio is flushed to the socket. Small enough to feel live, large enough that
 *  each frame is a whole Opus cluster rather than a fragment. */
const FLUSH_MS = 250;

export interface StreamedChunk {
  utterances: Utterance[];
  startedAt: number;
}

interface Options {
  source: UtteranceSource & ("stt" | "tab");
  sourceTag: "mic" | "tab";
  onChunk: (chunk: StreamedChunk) => void;
  /** Non-final preview text. Replaces the previous preview; never appended to the transcript. */
  onInterim?: (text: string) => void;
  onError?: (message: string) => void;
}

function pickMimeType(): string {
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"];
  return candidates.find(t => MediaRecorder.isTypeSupported(t)) || "";
}

export function useStreamingCapture({ source, sourceTag, onChunk, onInterim, onError }: Options) {
  const socketRef = useRef<WebSocket | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const stoppingRef = useRef(false);

  // Starts a NEW recorder, which starts a new WebM container. Every segment must begin with one:
  // the EBML header only exists in a recorder's first blob, and a fresh recognition that receives
  // headerless clusters cannot decode them.
  const startRecorder = useCallback(() => {
    const mediaStream = streamRef.current;
    if (!mediaStream || stoppingRef.current) return;
    const rec = new MediaRecorder(mediaStream, { mimeType: pickMimeType() });
    rec.ondataavailable = e => {
      const sock = socketRef.current;
      if (e.data.size > 0 && sock?.readyState === WebSocket.OPEN) sock.send(e.data);
    };
    recorderRef.current = rec;
    rec.start(FLUSH_MS);
  }, []);

  /**
   * `keepStream` leaves the microphone/tab tracks live so a caller can hand the same MediaStream
   * to another capture path. Used by the fallback in useLiveCapture: re-acquiring would re-prompt
   * for permission, and for a shared tab the user would have to pick the tab again.
   */
  const stop = useCallback((opts?: { keepStream?: boolean }) => {
    stoppingRef.current = true;
    const rec = recorderRef.current;
    const sock = socketRef.current;
    recorderRef.current = null;

    const say = (msg: unknown) => { if (sock?.readyState === WebSocket.OPEN) sock.send(JSON.stringify(msg)); };
    if (rec?.state === "recording") {
      // ondataavailable fires with the tail of the recording BEFORE onstop, so `stop` reaches the
      // server behind the last audio rather than in front of it. Sending it immediately instead
      // would cut the recognition off mid-sentence and lose whatever was still being said.
      rec.onstop = () => say({ type: "stop" });
      rec.stop();
    } else {
      say({ type: "stop" });
    }
    if (opts?.keepStream) {
      // Abandoning a broken stream to fall back — nothing is going to drain, so close now.
      sock?.close();
      socketRef.current = null;
    }
    // Otherwise the socket stays open: the server closes it once the recognition has drained, and
    // that is what lets the last utterance come back. onclose does the cleanup.
    if (!opts?.keepStream) streamRef.current?.getTracks().forEach(t => t.stop());
    streamRef.current = null;
  }, []);

  const start = useCallback((mediaStream: MediaStream, sessionId: string) => {
    streamRef.current = mediaStream;
    stoppingRef.current = false;

    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const sock = new WebSocket(`${proto}//${location.host}/api/stt/stream`);
    sock.binaryType = "arraybuffer";
    socketRef.current = sock;

    sock.onopen = () => {
      // maxSpeakers is read here rather than per-frame: one recognition, one config, and the
      // recognizer cannot be reconfigured mid-stream anyway.
      sock.send(JSON.stringify({
        type: "start", sessionId, source: sourceTag,
        maxSpeakers: readSttConfig().maxSpeakers,
        // The recognizer has to be told which container it is about to receive; pickMimeType may
        // hand back ogg where webm is unavailable.
        mimeType: pickMimeType(),
      }));
      startRecorder();
    };

    sock.onmessage = (ev) => {
      let msg: any;
      try { msg = JSON.parse(String(ev.data)); } catch { return; }

      if (msg.type === "interim") { onInterim?.(String(msg.text ?? "")); return; }

      if (msg.type === "final") {
        // Reuses the chunked path's label rules rather than a second copy. `speakers` is a real
        // stream-wide count, not the corroborated latch the chunked path needs — one recognition
        // is one clustering space, so a count of 2 is a fact rather than an inference.
        const utterances = toUtterances(
          { text: "", turns: msg.turns ?? [], speakerCount: msg.speakers, multiSpeaker: msg.speakers > 1 },
          source,
        );
        if (utterances.length) {
          onInterim?.("");
          onChunk({ utterances, startedAt: Date.now() });
        }
        return;
      }

      if (msg.type === "segment_due") {
        // Cut the container and the recognition together. Ordering matters: stop the recorder
        // first so its last cluster reaches the OLD stream, then ask the server to reopen, then
        // start a fresh recorder whose first blob carries the header the new stream needs.
        if (recorderRef.current?.state === "recording") recorderRef.current.stop();
        if (sock.readyState === WebSocket.OPEN) sock.send(JSON.stringify({ type: "segment" }));
        startRecorder();
        return;
      }

      if (msg.type === "error") onError?.(String(msg.message ?? "Cloud STT stream failed"));
    };

    sock.onerror = () => onError?.("Lost the connection to the transcription stream.");
    sock.onclose = () => { if (socketRef.current === sock) socketRef.current = null; };
  }, [onChunk, onError, onInterim, source, sourceTag, startRecorder]);

  return { start, stop, isActive: () => Boolean(streamRef.current) };
}
