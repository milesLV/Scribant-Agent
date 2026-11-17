// Google Cloud STT V1 streamingRecognize: ONE long-lived recognition per capture, so a speaker tag
// means the same person for the whole stream (the chunked path in cloud-stt.ts can't, since every
// chunk is its own clustering space). Auth is ADC. gRPC-only, hence @google-cloud/speech here while
// cloud-stt.ts uses plain fetch.
import assert from "node:assert/strict";
import { fileURLToPath } from "url";
import { DEFAULT_MAX_SPEAKERS, formatSpeakerTag, resolveProjectId, groupWordsIntoSpeakerTurns, smoothSpeakerFlickers, type DiarizedWord, type SpeakerTurn } from "./cloud-stt";

// Google closes a V1 stream at 305s. The server times this and asks the client to cut
// (`segment_due`); the client must act because WebM's header exists only in the first blob, so the
// recorder and the recognition have to restart together. 65s of margin covers the round-trip.
export const SEGMENT_MS = 240_000;

/** Chrome's opus rate, and the only one MediaRecorder emits. The API rejects opus without it. */
export const STREAM_SAMPLE_RATE = 48_000;

// MediaRecorder container -> API encoding. The capture hook falls back to ogg where WebM is missing.
export function encodingForMimeType(mimeType?: string): "WEBM_OPUS" | "OGG_OPUS" {
  return /ogg/i.test(mimeType ?? "") ? "OGG_OPUS" : "WEBM_OPUS";
}

export interface StreamConfig {
  maxSpeakers?: number;
  languageCode?: string;
  mimeType?: string;
}

/** Separate so the self-check can assert the speaker floor offline. */
export function buildStreamingConfig(cfg: StreamConfig = {}) {
  // minSpeakerCount pinned at 1: a higher floor splits one voice in two on noisy audio (see buildV1Config).
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

export interface StreamTurnsResult {
  turns: SpeakerTurn[];
  committed: number;
  speakers: number;
}

/**
 * A final result -> the turns to append, plus the new commit cursor. Pure; the self-check drives it.
 * MEASURED: every `isFinal` carries the CUMULATIVE word list since the stream opened (17 -> 29 -> 36
 * -> ... -> 79 words on a 35s call), so only the part past `committed` is new.
 * The recognizer also revises tags it already emitted. Ignored: the transcript is append-only
 * (proofread offsets) and on the reference call the revision fixed one utterance and broke the next.
 * ponytail: first label wins. Revisit only with a measurement, by holding words back, never rewriting.
 */
export function turnsFromFinal(cumulative: DiarizedWord[], committed: number): StreamTurnsResult {
  // Smooth the whole list before cutting: a tail can start mid-flicker, and the count below must
  // match the turns' tags. Smoothing keeps the length, so `committed` stays a valid index.
  const smoothed = smoothSpeakerFlickers(cumulative);
  // Never observed to shrink, but a shrink would otherwise slice from the end and re-emit words.
  const tail = committed >= smoothed.length ? [] : smoothed.slice(committed);
  const { turns } = groupWordsIntoSpeakerTurns(tail, { alwaysPrefixSpeaker: true });
  return {
    turns,
    committed: Math.max(committed, smoothed.length),
    // Over the whole recognition so far; resets at a segment cut, which opens a new one.
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
  /** Stop sending audio. In-flight results still arrive; close the socket on `onEnd`, not here. */
  end: () => void;
}

/**
 * Opens one recognition; `committed` and speaker numbering are per stream.
 * ponytail: a segment cut may permute who "Speaker 1" is (no acoustic anchor across recognitions),
 * a ~4 min exposure versus the chunked path's 8s. Closing it needs voice embeddings.
 */
export async function openSttStream(cfg: StreamConfig, events: SttStreamEvents): Promise<SttStream> {
  const { SpeechClient } = await import("@google-cloud/speech");
  const projectId = await resolveProjectId();

  // gRPC needs a QUOTA project, which `gcloud auth application-default login` doesn't set
  // (PERMISSION_DENIED otherwise). Verified against the live API: this env var is the only knob
  // google-auth-library honours; a client `quotaProjectId` option does nothing. `??=` keeps an
  // operator's own setting.
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
        // STT_STREAM_DEBUG=1: the recognizer's own tags per final, to tell its mistakes from ours.
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
    // `closed` only mutes the CANCELLED error; data and end still fire, letting the last final through.
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
  assert.deepEqual(turnsFromFinal(say(3, 1), 99).turns, []);

  assert.ok(SEGMENT_MS < 305_000, "a segment must close before Google's 305s streaming limit");

  console.log("stt-stream self-check ✓");
})();
