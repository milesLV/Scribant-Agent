// Google Cloud STT V1 streamingRecognize — ONE long-lived recognition per capture.
//
// This is the fix the chunked path (cloud-stt.ts) structurally cannot deliver. There, every 8s
// chunk is an independent request with its own clustering space, so "Speaker 1" in one chunk and
// "Speaker 1" in the next are unrelated by construction; no amount of cross-request reconciliation
// recovers the link, and attempting it measurably made things worse. Here the recognizer holds one
// clustering space for the whole stream, so a tag means the same person until the stream ends.
//
// Auth is ADC, same as cloud-stt.ts. streamingRecognize is gRPC-only — there is no REST equivalent,
// which is why @google-cloud/speech is a dependency here and cloud-stt.ts hand-rolls fetch.
import assert from "node:assert/strict";
import { fileURLToPath } from "url";
import { DEFAULT_MAX_SPEAKERS, formatSpeakerTag, resolveProjectId, groupWordsIntoSpeakerTurns, parseOffsetMs, smoothSpeakerFlickers, type DiarizedWord, type SpeakerTurn } from "./cloud-stt";

/**
 * Google closes a V1 streaming recognition at 305s. The client cuts a fresh segment before that,
 * with margin for a slow open.
 *
 * The server times this and ASKS the client to cut (`segment_due`), rather than both sides holding
 * a copy of the interval. The client has to be the one that acts, though, and that is load-bearing:
 * the audio is a continuous WebM stream whose EBML header only exists in the first blob, so a new
 * gRPC stream started mid-container receives headerless clusters and cannot decode. Cutting the
 * recorder and the recognition together is what keeps the two boundaries at the same byte, and the
 * 65s of margin below the limit is what makes the round-trip safe.
 */
export const SEGMENT_MS = 240_000;

/** Chrome's opus rate, and the only one MediaRecorder emits. The API rejects opus without it. */
export const STREAM_SAMPLE_RATE = 48_000;

/**
 * MediaRecorder's container -> the encoding the API expects.
 *
 * pickMimeType() in the capture hook falls back to `audio/ogg;codecs=opus` where WebM is missing,
 * so hardcoding WEBM_OPUS would hand the recognizer a container it was not told about. The codec
 * is opus either way; only the wrapper differs.
 */
export function encodingForMimeType(mimeType?: string): "WEBM_OPUS" | "OGG_OPUS" {
  return /ogg/i.test(mimeType ?? "") ? "OGG_OPUS" : "WEBM_OPUS";
}

export interface StreamConfig {
  maxSpeakers?: number;
  languageCode?: string;
  mimeType?: string;
}

/** Built here rather than inline so the self-check can assert the speaker floor without a network call. */
export function buildStreamingConfig(cfg: StreamConfig = {}) {
  // minSpeakerCount is pinned at 1 for the same measured reason as the chunked path: the floor is
  // advisory, it changes nothing on clean audio, and on low-confidence audio it pushes the
  // recognizer into splitting one voice in two. See cloud-stt.ts buildV1Config.
  const maxSpeakerCount = Math.max(1, Math.min(8, cfg.maxSpeakers ?? DEFAULT_MAX_SPEAKERS));
  return {
    config: {
      encoding: encodingForMimeType(cfg.mimeType),
      sampleRateHertz: STREAM_SAMPLE_RATE,
      languageCode: cfg.languageCode || "en-US",
      enableAutomaticPunctuation: true,
      enableWordTimeOffsets: true,
      diarizationConfig: { enableSpeakerDiarization: true, minSpeakerCount: 1, maxSpeakerCount },
    },
    interimResults: true,
  };
}

/** One `alternatives[0].words` entry, as the API returns it. */
interface RawWord {
  word?: string | null;
  speakerTag?: number | null;
  startTime?: { seconds?: number | string | null; nanos?: number | null } | null;
  endTime?: { seconds?: number | string | null; nanos?: number | null } | null;
}

function durationMs(d: RawWord["startTime"]): number | undefined {
  if (!d) return undefined;
  return Number(d.seconds ?? 0) * 1000 + Math.round(Number(d.nanos ?? 0) / 1e6);
}

export function toDiarizedWords(raw: RawWord[]): DiarizedWord[] {
  return raw.map(w => ({
    word: w.word ?? "",
    speaker: formatSpeakerTag(w.speakerTag ?? undefined),
    startMs: durationMs(w.startTime),
    endMs: durationMs(w.endTime),
  }));
}

/**
 * The tail of a final result that has not been sent to the client yet.
 *
 * MEASURED, and the single most important fact about this API: every `isFinal` result carries the
 * CUMULATIVE word list since the stream opened — not just the newest utterance. Across the 35s
 * two-speaker reference call the count ran 17 -> 29 -> 36 -> 48 -> 65 -> 67 -> 74 -> 78 -> 79.
 * Appending each final's words wholesale would repeat the entire transcript nine times over.
 *
 * The recognizer also REVISES tags it already emitted (one of those nine finals rewrote 15 words
 * from Speaker 2 to Speaker 1). Those revisions are deliberately ignored, for two reasons. The
 * transcript is append-only — the proofreader holds character offsets into committed text — and
 * on the reference call the revision was not an improvement: it moved one utterance onto the right
 * speaker and eight words of the next onto the wrong one. Paying the append-only invariant for a
 * wash is a bad trade.
 *
 * ponytail: first label wins, no revision. Revisit only with a measurement showing revisions are
 * reliably better, and then only by holding words back until stable — never by rewriting committed
 * text.
 */
export function uncommittedTail(cumulative: DiarizedWord[], committed: number): DiarizedWord[] {
  // Never observed to shrink, but a shrink would otherwise slice from the end and re-emit words.
  if (committed >= cumulative.length) return [];
  return cumulative.slice(Math.max(0, committed));
}

export interface StreamTurnsResult {
  turns: SpeakerTurn[];
  committed: number;
  speakers: number;
}

/** A final result -> the turns to append, plus the new commit cursor. Pure; the self-check drives it. */
export function turnsFromFinal(cumulative: DiarizedWord[], committed: number): StreamTurnsResult {
  // Smoothed over the whole cumulative list before the tail is cut, for two reasons: a tail can
  // begin part-way through a flicker and lose the left-hand neighbour the rule needs, and the
  // speaker count below has to agree with the tags the turns actually carry. Smoothing never
  // changes the length, so `committed` stays a valid index into it.
  const smoothed = smoothSpeakerFlickers(cumulative);
  const tail = uncommittedTail(smoothed, committed);
  const { turns } = groupWordsIntoSpeakerTurns(tail, { alwaysPrefixSpeaker: true });
  return {
    turns,
    committed: Math.max(committed, smoothed.length),
    // Distinct speakers over this whole RECOGNITION so far, not just the tail. One recognition is
    // one clustering space, so this is a real count rather than the chunked path's latch — but it
    // resets at a segment cut (openSegment in server.ts), because that opens a new recognition.
    speakers: new Set(smoothed.map(w => w.speaker).filter(Boolean)).size,
  };
}

/* --- the gRPC stream itself --------------------------------------------------------------- */

export interface SttStreamEvents {
  onInterim: (text: string) => void;
  onFinal: (result: StreamTurnsResult) => void;
  onError: (message: string) => void;
  /** The recognition has drained — every final it will ever send has been sent. */
  onEnd?: () => void;
}

export interface SttStream {
  write: (audio: Buffer) => void;
  /**
   * Stops sending audio. Results already in flight still arrive, and `onEnd` fires once they have
   * — a caller that closes its socket on `end()` instead of on `onEnd` drops the last utterance.
   */
  end: () => void;
}

/**
 * Opens one recognition. `committed` is per-stream: a restart is a NEW clustering space, so the
 * cursor resets with it and the speaker numbering starts over.
 *
 * ponytail: a segment boundary may permute who "Speaker 1" is, because there is no acoustic
 * anchor across two independent recognitions. That is a ~4 minute exposure rather than the
 * chunked path's 8 seconds, and closing it needs voice embeddings, not more plumbing.
 */
export async function openSttStream(cfg: StreamConfig, events: SttStreamEvents): Promise<SttStream> {
  const { SpeechClient } = await import("@google-cloud/speech");
  const projectId = await resolveProjectId();

  // The gRPC client needs a QUOTA project, and being logged in does not supply one:
  // `gcloud auth application-default login` writes a credential file with no `quota_project_id`,
  // and Speech rejects every call made with a bare user credential and no quota project
  // (PERMISSION_DENIED, "requires a quota project, which is not set by default"). The REST path in
  // cloud-stt.ts never hit this because it sets the `x-goog-user-project` header by hand on every
  // fetch — which is why chunked transcription worked while streaming died on open.
  //
  // This env var is the ONLY knob that works, verified against the live API. Neither a
  // `quotaProjectId` client option nor a hand-built GoogleAuth with `quota_project_id` in
  // clientOptions has any effect: google-auth-library reads the quota project from the ADC file's
  // snake_case `quota_project_id` or from here (see #prepareAndCacheClient in googleauth.js), and
  // from nowhere else.
  //
  // `??=` so an operator who set it deliberately, or ran
  // `gcloud auth application-default set-quota-project`, still wins.
  process.env.GOOGLE_CLOUD_QUOTA_PROJECT ??= projectId;

  const client = new SpeechClient({ projectId });
  let committed = 0;
  let closed = false;

  const stream = client
    .streamingRecognize(buildStreamingConfig(cfg) as any)
    .on("error", (err: any) => {
      if (closed) return; // an end() mid-flight surfaces as CANCELLED; not worth reporting
      events.onError(err?.message || String(err));
    })
    .on("end", () => events.onEnd?.())
    .on("data", (data: any) => {
      for (const r of data?.results ?? []) {
        const alt = r?.alternatives?.[0];
        if (!alt) continue;
        if (!r.isFinal) {
          if (alt.transcript) events.onInterim(String(alt.transcript));
          continue;
        }
        const cum = toDiarizedWords(alt.words ?? []);
        // STT_STREAM_DEBUG=1 prints the recognizer's OWN cumulative tag string per final. It is the
        // only way to tell "our commit logic mislabelled this" from "the recognizer said so" — the
        // question that decides whether a diarization complaint is even actionable here.
        if (process.env.STT_STREAM_DEBUG) {
          console.log("[stt-debug] " + cum.map(w => w.speaker.replace(/\D/g, "")).join("") + " | " + cum.map(w => w.word).join(" "));
        }
        const result = turnsFromFinal(cum, committed);
        committed = result.committed;
        if (result.turns.length) events.onFinal(result);
      }
    });

  return {
    write: (audio: Buffer) => { if (!closed) stream.write(audio as any); },
    // `closed` only silences the error channel (a cancelled stream reports CANCELLED); the data
    // and end events still fire, which is what lets the last final through.
    end: () => { closed = true; try { stream.end(); } catch { events.onEnd?.(); } },
  };
}

/* --- self-check -------------------------------------------------------------------------- */
// Run: tsx stt-stream.ts   (no network, no quota)
if (import.meta.url && process.argv[1] === fileURLToPath(import.meta.url)) (async () => {
  // 1. Config: the floor stays at 1 whatever the caller asks for, and the ceiling is bounded.
  const c = buildStreamingConfig({}).config;
  assert.equal(c.diarizationConfig.minSpeakerCount, 1);
  assert.equal(c.diarizationConfig.maxSpeakerCount, DEFAULT_MAX_SPEAKERS);
  // 3, not 2 — an override has to differ from the default to prove anything.
  assert.equal(buildStreamingConfig({ maxSpeakers: 3 }).config.diarizationConfig.maxSpeakerCount, 3);
  assert.equal(buildStreamingConfig({ maxSpeakers: 99 }).config.diarizationConfig.maxSpeakerCount, 8);
  assert.equal(buildStreamingConfig({ maxSpeakers: 0 }).config.diarizationConfig.maxSpeakerCount, 1);
  assert.equal(c.sampleRateHertz, 48000, "opus requires an explicit rate — the API rejects 0");
  assert.equal(c.encoding, "WEBM_OPUS");
  assert.equal(buildStreamingConfig({ mimeType: "audio/ogg;codecs=opus" }).config.encoding, "OGG_OPUS");
  assert.equal(buildStreamingConfig({ mimeType: "audio/webm;codecs=opus" }).config.encoding, "WEBM_OPUS");
  assert.equal(encodingForMimeType(undefined), "WEBM_OPUS", "an absent mime type keeps the common case");
  assert.equal(buildStreamingConfig({}).interimResults, true);

  // 2. Word mapping, including the untagged case.
  const words = toDiarizedWords([
    { word: "hi", speakerTag: 1, startTime: { seconds: 0, nanos: 0 }, endTime: { seconds: 0, nanos: 500_000_000 } },
    { word: "there", speakerTag: 2, startTime: { seconds: "1", nanos: 200_000_000 } },
    { word: "untagged" },
  ]);
  assert.deepEqual(words.map(w => w.speaker), ["Speaker 1", "Speaker 2", "Speaker 1"]);
  assert.equal(words[0].endMs, 500);
  assert.equal(words[1].startMs, 1200);

  // 3. THE regression this module exists to prevent: finals are cumulative, so committing one
  //    wholesale repeats everything said so far. Replays the real 35s reference call's growth.
  const say = (n: number, tag: number, from = 0): DiarizedWord[] =>
    Array.from({ length: n }, (_, i) => ({ word: `w${from + i}`, speaker: `Speaker ${tag}` }));
  const first = say(17, 1);
  const second = [...first, ...say(12, 2, 17)];
  let cursor = 0;
  const r1 = turnsFromFinal(first, cursor); cursor = r1.committed;
  const r2 = turnsFromFinal(second, cursor); cursor = r2.committed;
  assert.equal(cursor, 29);
  assert.equal(r1.turns.map(t => t.text).join(" ").split(" ").length, 17);
  assert.equal(r2.turns.map(t => t.text).join(" ").split(" ").length, 12, "only the 12 NEW words are emitted");
  assert.equal(r2.turns[0].speaker, "Speaker 2");
  assert.deepEqual(turnsFromFinal(second, cursor).turns, [], "re-delivering the same final emits nothing");

  // 4. A revision of already-committed tags does not re-emit those words.
  const revised = [...say(17, 1), ...say(12, 1, 17), ...say(5, 2, 29)];
  const r3 = turnsFromFinal(revised, cursor);
  assert.equal(r3.turns.map(t => t.text).join(" ").split(" ").length, 5, "committed words stay committed");
  assert.equal(r3.committed, 34);

  // 5. Speaker count is stream-wide, not tail-wide: a stretch where only one person talks must not
  //    read as a one-speaker session, which is what un-labelled the transcript on the chunked path.
  assert.equal(r3.speakers, 2, "counted over the whole stream, though the tail held one voice");
  assert.equal(turnsFromFinal(say(3, 1), 0).speakers, 1);

  // 6. Defensive: a shrinking cursor must not slice from the end and re-emit.
  assert.deepEqual(uncommittedTail(say(3, 1), 99), []);
  assert.equal(uncommittedTail(say(3, 1), -5).length, 3);

  assert.ok(SEGMENT_MS < 305_000, "a segment must close before Google's 305s streaming limit");

  console.log("stt-stream self-check ✓");
})();
