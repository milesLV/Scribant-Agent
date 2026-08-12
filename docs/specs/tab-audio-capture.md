# Spec: Shared-Tab + Mic Audio Capture for Transcription

## Where this lands architecturally

Today's live-transcription path is **text-only end to end**: [AudioRecorder.tsx](../../src/components/AudioRecorder.tsx)
uses the browser's `webkitSpeechRecognition`, which listens to the default mic device and hands back
*text*, not audio. The server ([server.ts](../../server.ts), [orchestrator.ts](../../orchestrator.ts))
never sees a single audio byte — it proofreads/summarizes/plans whatever text the browser already
produced.

**Key constraint that shapes everything below:** Web Speech API cannot take an arbitrary `MediaStream`
as input — it only listens to the mic. So there is no way to hand it "shared-tab audio." Capturing tab
audio requires a genuinely different pipeline: raw audio capture → chunk → send to a server-side STT
model → text back. This is a second, parallel transcription path, not an extension of the existing one.

## Two audio sources, kept separate (not mixed)

- **Mic** → keep the existing Web Speech path as-is. Free, fast, zero quota cost, already tuned
  (proofreading, corrections, live summary all built around it).
- **Tab audio** → `navigator.mediaDevices.getDisplayMedia({ video: true, audio: true })`, user picks
  "Chrome Tab" + checks "Share tab audio". Immediately stop/discard the video track (only needed it to
  obtain the audio track) — never record or transmit video.

Don't feed both into one `AudioContext` mix down to a single stream. Keeping them as two independent
capture→transcribe pipelines means the *source* (mic vs tab) is a free, perfectly reliable speaker tag
("You" vs "Meeting") — actual diarization is hard; this sidesteps it entirely. Mixing would throw that
away for no benefit at MVP scope.

## Capture → transcribe pipeline (new, for tab audio)

1. **Chunking**: `MediaRecorder` on the tab-audio stream, `webm/opus`, `timeslice` ~8–10s (same cadence
   family as the existing 15s dictation flush in
   [`/api/transcript-segment`](../../server.ts) → `logUserTranscript`). Fixed-interval chunks for MVP;
   real VAD/silence-cut is a later phase.
2. **Upload**: new endpoint, e.g. `POST /api/transcribe-audio` — send each chunk as base64 in JSON
   (reuses `express.json()` already wired; no `multer` needed for chunk-sized payloads) with
   `{ source: "tab", sessionId, userId, startedAtISO, mimeType, data }`.
3. **STT**: pass the chunk to Gemini as an inline audio part via a small new agent in
   [agents.ts](../../agents.ts), reusing the existing key-rotation/backoff (`askAgent`/`KEYS`) rather
   than standing up Google Cloud Speech-to-Text — one fewer credential to manage, and it's the same
   model family already in use.
4. **Response**: `{ text, source: "tab", startedAtISO }` back to the client.
5. **Merge**: client buffers finalized chunks from both sources with client-side timestamps and
   interleaves them by time directly into the SAME transcript pane AudioRecorder already owns — tagged
   inline, e.g. `[You] ...` / `[Meeting] ...` — so everything downstream (proofread, `/api/live`,
   summary, plan) needs zero changes. (Decision: one merged pane, not a split UI — simplest, reuses all
   existing downstream logic untouched.)

## Client / UX changes

- Add a "Share Tab Audio" toggle next to the existing mic button in
  [AudioRecorder.tsx](../../src/components/AudioRecorder.tsx) (or a small sibling component if the
  state gets unwieldy).
- Feature-detect `getDisplayMedia`; hide/disable the button on browsers where tab-audio capture isn't
  supported (Safari/Firefox).
- After the picker resolves, check `stream.getAudioTracks().length === 0` — user picked "Window"/
  "Screen" (no audio in Chrome) or forgot the checkbox — show an inline retry prompt, same pattern as
  the existing `recognitionError` banner.
- Listen for `videoTrack.onended` (fires when the user clicks Chrome's native "Stop sharing" bar) to
  tear down the MediaRecorder and flip UI state back — this is the only reliable "they stopped" signal,
  there's no explicit stop event otherwise.
- Note for the UI copy: Chrome keeps capturing the *originally selected* tab even if the user clicks
  away to another tab — worth a one-line hint so it's not mistaken for a bug.

## Consent / privacy

Tab audio can include other meeting participants who never agreed to be transcribed by this app —
that's a materially different privacy posture than "user dictates to their own mic." Recommend:
- A one-time inline notice on first use ("you're about to transcribe everyone in this tab — make sure
  participants know"), not just a permission prompt.
- No raw audio persisted anywhere — transcribe-and-discard server-side, same as today's text-only
  archive in `data/memory/**/*.jsonl` (`logUserTranscript` in [server-utils.ts](../../server-utils.ts)).
  Never write audio bytes to disk.

## Cost / quota

This is the one that should gate scope. Gemini free-tier keys already exhaust after 1–2 eval runs on
**text-only** calls. A continuous 8–10s audio-chunk pipeline for the whole length of a meeting is a much
higher call volume than anything the app does today. Recommend:
- Ship this **off by default**, explicit opt-in per session.
- Make the chunk interval a named constant so it's a one-line dial, not a redeploy.
- Consider gating behind whichever `GEMINI_API_KEY*` slot is least contended, or a distinct "audio" key
  if quota separation matters.

## Phasing

1. **MVP**: tab-audio-only server round trip, fixed-interval chunking, two-source merge-by-timestamp
   into the single transcript pane, mic path untouched.
2. **Later**: swap fixed chunking for VAD/silence-cut boundaries (cheaper, cleaner sentence breaks).
3. **Stretch**: streaming instead of chunk-and-post (WebSocket → Gemini Live) if 8–10s latency proves
   too slow in practice — bigger lift, only worth it once MVP's latency is actually felt as a problem.
