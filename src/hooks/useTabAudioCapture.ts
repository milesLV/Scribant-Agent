import { useCallback, useRef, useState } from "react";
import { type Utterance } from "../utils/paragraphs";
import { useLiveCapture } from "./useLiveCapture";

export interface TabAudioChunk {
  // Diarized turns when Cloud STT produced them, otherwise a single undivided utterance. Handed up
  // as structure rather than a joined string so the caller decides paragraph breaks with the real
  // speaker labels instead of sniffing "Speaker " out of the text.
  utterances: Utterance[];
  startedAt: number; // client Date.now() when this step started recording
}

interface Options {
  onChunk: (chunk: TabAudioChunk) => void;
  onError: (message: string) => void;
  /** Shared with the mic path so both capture sources reconcile against ONE speaker registry. */
  sessionId: string;
}

// Captures a shared Chrome tab's audio and transcribes it server-side. The transport itself lives
// in useLiveCapture, shared with the mic path; what's left here is only the getDisplayMedia
// acquisition, which has no mic equivalent.
//
// Note that the tab and the mic are two independent recognitions, so a speaker label from one is
// unrelated to a label from the other. Merging them would need the two MediaStreams mixed into one
// before capture — a real option for the "room mic plus video call" setup, but it would also
// collapse the mic/tab source tagging the transcript relies on.
export function useTabAudioCapture({ onChunk, onError, sessionId }: Options) {
  const [isSharing, setIsSharing] = useState(false);
  const stopRef = useRef<(() => void) | null>(null);

  const capture = useLiveCapture({
    source: "tab",
    sourceTag: "tab",
    onChunk,
    onNotice: onError,
  });

  const stop = useCallback(() => {
    capture.stop();
    setIsSharing(false);
  }, [capture]);
  stopRef.current = stop;

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
      stream.getAudioTracks()[0].addEventListener("ended", () => stopRef.current?.());

      setIsSharing(true);
      capture.start(stream, sessionId);
    } catch (err: any) {
      if (err?.name !== "NotAllowedError") { // user just cancelled the picker — not an error
        onError(`Couldn't start tab sharing: ${err?.message || err}`);
      }
    }
  }, [capture, onError, sessionId]);

  return { isSharing, start, stop };
}
