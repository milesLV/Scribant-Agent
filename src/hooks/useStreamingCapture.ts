import { useCallback, useRef } from "react";
import { toUtterances, type UtteranceSource } from "../utils/paragraphs";
import { readSttConfig, pickMimeType, type CapturedChunk } from "./useChunkedCapture";

// Live diarized capture over ONE long-lived Cloud STT recognition (server: stt-stream.ts), so a
// speaker label means one person for the whole stream — unlike the chunked path, where each 8s
// request clusters from scratch.
// ponytail: WebM/Opus straight from MediaRecorder; streamingRecognize accepts it at 48kHz (verified
// live), so raw PCM would only add an AudioWorklet + resampler for nothing.

/** Flush interval: live enough, and each frame is a whole Opus cluster. */
const FLUSH_MS = 250;

interface Options {
  source: UtteranceSource & ("stt" | "tab");
  sourceTag: "mic" | "tab";
  onChunk: (chunk: CapturedChunk) => void;
  /** Non-final preview text. Replaces the previous preview; never appended to the transcript. */
  onInterim?: (text: string) => void;
  onError?: (message: string) => void;
}

export function useStreamingCapture({ source, sourceTag, onChunk, onInterim, onError }: Options) {
  // Set once at stream open from the STT config; see the `alwaysLabel` note on the final handler.
  const alwaysLabelRef = useRef(false);
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
      // Abandoning a broken stream to fall back — nothing will drain, so close now.
      sock?.close();
      socketRef.current = null;
    } else {
      // The socket stays open until the server has drained the recognition (that is what brings
      // the last utterance back); onclose cleans up.
      streamRef.current?.getTracks().forEach(t => t.stop());
    }
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
      // recognizer cannot be reconfigured mid-stream anyway. Held for the life of the stream so
      // every final labels on the same rule the stream opened with.
      const cfg = readSttConfig();
      alwaysLabelRef.current = cfg.maxSpeakers > 1;
      sock.send(JSON.stringify({
        type: "start", sessionId, source: sourceTag,
        maxSpeakers: cfg.maxSpeakers,
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
          {
            text: "", turns: msg.turns ?? [], speakerCount: msg.speakers,
            multiSpeaker: msg.speakers > 1,
            // Detection can only label once the second person has actually spoken, which leaves the
            // whole opening stretch unlabelled and uncorrectable. If the user said to expect more
            // than one, label from the first word.
            alwaysLabel: alwaysLabelRef.current,
          },
          source,
        );
        if (utterances.length) {
          onInterim?.("");
          onChunk({ utterances, startedAt: Date.now() });
        }
        return;
      }

      if (msg.type === "segment_due") {
        // Cut the container and the recognition together. rec.stop() is async and the tail blob fires
        // before onstop, so reopen from onstop (as in stop() above). Reopening immediately sent the
        // headerless tail into the NEW recognition first, and it decoded nothing (measured live).
        const rec = recorderRef.current;
        const reopen = () => {
          if (sock.readyState === WebSocket.OPEN) sock.send(JSON.stringify({ type: "segment" }));
          startRecorder();
        };
        if (rec?.state === "recording") { rec.onstop = reopen; rec.stop(); } else reopen();
        return;
      }

      if (msg.type === "error") onError?.(String(msg.message ?? "Cloud STT stream failed"));
    };

    sock.onerror = () => onError?.("Lost the connection to the transcription stream.");
    sock.onclose = () => { if (socketRef.current === sock) socketRef.current = null; };
  }, [onChunk, onError, onInterim, source, sourceTag, startRecorder]);

  return { start, stop };
}
