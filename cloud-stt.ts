// Google Cloud Speech-to-Text provider with acoustic speaker diarization.
// Recognition prefers V2; DIARIZATION always routes to V1 — V2's sync Recognize rejects
// diarizationConfig outright (HTTP 400, every model and location).
// Uses Google Cloud Application Default Credentials (ADC) to call speech.googleapis.com.
import assert from "node:assert/strict";
import { fileURLToPath } from "url";

export interface DiarizedWord {
  word: string;
  speaker: string;
  startMs?: number;
  endMs?: number;
  confidence?: number;
}

export interface SpeakerTurn {
  speaker: string;
  text: string;
  startMs?: number;
  endMs?: number;
  words: DiarizedWord[];
}

// Upper bound when a caller names none. Kept at 1: a loose cap lets a noisy mic split one voice into
// phantom speakers; raise it per-request for a real group. The floor is always 1 (see buildV1Config).
// useChunkedCapture.ts keeps a copy (this module imports node:assert) — change both together.
export const DEFAULT_MAX_SPEAKERS = 1;

export interface CloudSttOptions {
  mimeType?: string;
  enableDiarization?: boolean;
  minSpeakers?: number;
  maxSpeakers?: number;
  languageCode?: string;
  /** Channels in the audio. Required once encoding is pinned — see opusChannelCount. */
  audioChannelCount?: number;
}

export interface CloudSttResult {
  text: string;
  speakerTurns: SpeakerTurn[];
  words: DiarizedWord[];
  speakerCount: number;
  provider: "google_cloud_stt";
}

// "1.200s" | "2s" | 1.5 → ms
export function parseOffsetMs(offset?: string | number): number | undefined {
  if (typeof offset === "number") return Math.round(offset * 1000);
  const match = offset?.match(/^([\d.]+)\s*s?$/);
  return match ? Math.round(parseFloat(match[1]) * 1000) : undefined;
}

// Diarization flickers: mid-sentence it hands 1-2 words to the other speaker and straight back. A
// real floor exchange leaves a pause; a flicker does not. So a run is rewritten to its neighbours'
// speaker only when both neighbours match, it is <= FLICKER_MAX_WORDS, and both gaps are
// <= FLICKER_MAX_GAP_MS. No timings = no pause evidence = left alone.
// ponytail: thresholds picked from synthetic cases, untuned on room audio. If a real backchannel
// ("yeah") gets absorbed, gate on word confidence rather than loosening the gap.
const FLICKER_MAX_WORDS = 2;
const FLICKER_MAX_GAP_MS = 200;

export function smoothSpeakerFlickers(words: DiarizedWord[]): DiarizedWord[] {
  if (!words || words.length < 3) return words;

  // Contiguous same-speaker runs as [from, to) index pairs.
  const runs: { speaker: string; from: number; to: number }[] = [];
  for (let i = 0; i < words.length; i++) {
    const speaker = words[i].speaker || "Speaker 1";
    const last = runs[runs.length - 1];
    if (last && last.speaker === speaker) last.to = i + 1;
    else runs.push({ speaker, from: i, to: i + 1 });
  }

  let out: DiarizedWord[] | null = null;
  for (let r = 1; r < runs.length - 1; r++) {
    const run = runs[r];
    // The previous run's speaker AFTER its rewrite: reading the original tag cascades alternating
    // flickers (112121 came out 111211).
    const prevSpeaker = runs[r - 1].speaker;
    const next = runs[r + 1];
    if (prevSpeaker !== next.speaker) continue;
    if (run.to - run.from > FLICKER_MAX_WORDS) continue;

    const gapBefore = gapMs(words[run.from - 1], words[run.from]);
    const gapAfter = gapMs(words[run.to - 1], words[run.to]);
    if (gapBefore === undefined || gapAfter === undefined) continue;
    if (gapBefore > FLICKER_MAX_GAP_MS || gapAfter > FLICKER_MAX_GAP_MS) continue;

    out ??= words.slice();
    for (let i = run.from; i < run.to; i++) out[i] = { ...out[i], speaker: prevSpeaker };
    run.speaker = prevSpeaker; // so the next iteration reads the rewrite, not the original tag
  }

  return out ?? words;
}

// Silence between the end of `a` and the start of `b`, or undefined if either offset is missing.
function gapMs(a: DiarizedWord, b: DiarizedWord): number | undefined {
  const end = a?.endMs ?? a?.startMs, start = b?.startMs;
  return end === undefined || start === undefined ? undefined : Math.max(0, start - end);
}

// Word-level tags → turns. The returned `words` are SMOOTHED: count speakers from them, not the
// input, or speakerCount reports a flicker the turns no longer contain.
export function groupWordsIntoSpeakerTurns(
  words: DiarizedWord[],
  options?: { alwaysPrefixSpeaker?: boolean }
): { text: string; turns: SpeakerTurn[]; words: DiarizedWord[] } {
  if (!words?.length) return { text: "", turns: [], words: [] };
  words = smoothSpeakerFlickers(words);

  const turns: SpeakerTurn[] = [];
  for (const w of words) {
    const speaker = w.speaker || "Speaker 1";
    const last = turns[turns.length - 1];
    if (last?.speaker === speaker) last.words.push(w);
    else turns.push({ speaker, text: "", startMs: w.startMs, words: [w] });
  }
  for (const t of turns) {
    const end = t.words[t.words.length - 1];
    t.text = t.words.map((w) => w.word).join(" ").trim();
    t.endMs = end.endMs ?? end.startMs;
  }

  const multi = turns.length > 1 && new Set(turns.map((t) => t.speaker)).size > 1;
  const text = multi || options?.alwaysPrefixSpeaker
    ? turns.map((t) => `${t.speaker}: ${t.text}`).join("\n\n")
    : turns.map((t) => t.text).join(" ").trim();
  return { text, turns, words };
}

// "1" | 2 → "Speaker N"; names pass through; empty → "Speaker 1".
export function formatSpeakerTag(rawLabel?: string | number): string {
  const str = String(rawLabel ?? "").trim();
  return !str ? "Speaker 1" : /^\d+$/.test(str) ? `Speaker ${str}` : str;
}

const googleAuth = async () =>
  new (await import("google-auth-library")).GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] });

// The project Speech bills against — REQUIRED: ADC user credentials carry no quota_project_id, and
// Speech rejects them without one (PERMISSION_DENIED "requires a quota project"). REST sends it as
// x-goog-user-project, gRPC as quotaProjectId; both resolve it here so they cannot drift.
export async function resolveProjectId(): Promise<string> {
  const fromEnv = process.env.GOOGLE_CLOUD_PROJECT || process.env.GCP_PROJECT;
  if (fromEnv) return fromEnv;
  const projectId = await (await googleAuth()).getProjectId();
  if (!projectId) throw new Error("GCP Project ID not found. Set GOOGLE_CLOUD_PROJECT in your environment or .env file.");
  return projectId;
}

async function getGoogleAuthClient(): Promise<{ token: string; projectId: string }> {
  const res = await (await (await googleAuth()).getClient()).getAccessToken();
  const token = typeof res === "string" ? res : res.token;
  if (!token) throw new Error("Failed to obtain GCP access token. Ensure Application Default Credentials (ADC) are configured via `gcloud auth application-default login`.");
  return { token, projectId: await resolveProjectId() };
}

const speechPost = (url: string, body: unknown, token: string, projectId: string) =>
  fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, "x-goog-user-project": projectId },
    body: JSON.stringify(body),
  });

// Shared V1/V2 response parsing. V1 diarization puts the complete diarized word list in the LAST
// result; otherwise words are spread across results.
function toResult(data: any, options: CloudSttOptions, lastHasAll: boolean): CloudSttResult {
  const results: any[] = data.results || [];
  const last = results.at(-1)?.alternatives?.[0];
  const alts = lastHasAll && last?.words?.length ? [last] : results.map((r) => r.alternatives?.[0]).filter(Boolean);
  const words: DiarizedWord[] = alts.flatMap((a) => (a.words || []).map((w: any) => ({
    word: w.word,
    speaker: formatSpeakerTag(w.speakerTag || w.speakerLabel),
    startMs: parseOffsetMs(w.startTime ?? w.startOffset),
    endMs: parseOffsetMs(w.endTime ?? w.endOffset),
    confidence: w.confidence,
  })));
  const prefix = Boolean(options.enableDiarization);

  if (!words.length) {
    const raw = results.map((r) => r.alternatives?.[0]?.transcript).filter(Boolean).join(" ").trim();
    return {
      text: prefix && raw ? `Speaker 1: ${raw}` : raw,
      speakerTurns: raw ? [{ speaker: "Speaker 1", text: raw, words: [] }] : [],
      words: [],
      speakerCount: raw ? 1 : 0,
      provider: "google_cloud_stt",
    };
  }
  const { text, turns, words: diarized } = groupWordsIntoSpeakerTurns(words, { alwaysPrefixSpeaker: prefix });
  return { text, speakerTurns: turns, words: diarized, speakerCount: new Set(diarized.map((w) => w.speaker)).size, provider: "google_cloud_stt" };
}

// Diarization routes to V1 (V2 sync rejects diarizationConfig); plain recognition uses V2 chirp_2,
// falling back to V1 on a 400/404 from the default recognizer.
export async function transcribeWithCloudStt(audioBase64: string, options: CloudSttOptions = {}): Promise<CloudSttResult> {
  const { token, projectId } = await getGoogleAuthClient();
  const cleanAudio = audioBase64.replace(/^data:audio\/[^;]+;base64,/, "");
  if (options.enableDiarization !== false) return transcribeWithCloudSttV1(cleanAudio, token, projectId, options);

  const response = await speechPost(
    `https://us-central1-speech.googleapis.com/v2/projects/${projectId}/locations/us-central1/recognizers/_:recognize`,
    { config: { autoDecodingConfig: {}, languageCodes: [options.languageCode || "en-US"], model: "chirp_2" }, content: cleanAudio },
    token, projectId,
  );
  if (!response.ok) {
    const errorText = await response.text();
    if (response.status === 404 || response.status === 400) {
      console.warn(`[CloudSTT] V2 request failed (${response.status}), attempting V1 fallback:`, errorText);
      return transcribeWithCloudSttV1(cleanAudio, token, projectId, options);
    }
    throw new Error(`Google Cloud STT V2 API error (${response.status}): ${errorText}`);
  }
  return toResult(await response.json(), options, false);
}

// ponytail: the speaker floor stays at 1 — do NOT "help" the clusterer by raising it. Measured on the
// live V1 API, minSpeakerCount is advisory: on clean two-speaker audio min=1/2/3 gave byte-identical
// output, and on uncertain (noisy-room) audio a floor of 2 split one speaker at an arbitrary pause.
// No benefit, measured harm (shipped once, in bce2bd7). `model` and `useEnhanced` were likewise
// byte-identical for diarization, so they stay out too.
//
// Channel count comes from the Opus ID header ("OpusHead", count at byte 9): pinning WEBM_OPUS makes
// V1 assume mono, but Chrome records a shared tab in stereo, and stereo + diarization 500s without
// per-channel recognition (measured 2026-09-14).
// ponytail: the last result's diarized words are one channel's — fine for a tab's identical mix; a
// true two-mic source would need channels merged by channelTag.
export function opusChannelCount(audio: Buffer): number | undefined {
  const at = audio.indexOf("OpusHead");
  return at < 0 ? undefined : audio[at + 9];
}

// V1 recognize auto-detects badly on container formats, so pin encoding (and the rate Opus always
// uses) when the MIME type is one we recognise; anything else falls back to auto-detect.
const ENCODINGS: [RegExp, string, number?][] = [
  [/webm/, "WEBM_OPUS", 48000], [/ogg|opus/, "OGG_OPUS", 48000], [/wav|linear16/, "LINEAR16"], [/mp3/, "MP3"], [/flac/, "FLAC"],
];

export function buildV1Config(options: CloudSttOptions) {
  const enableDiarization = options.enableDiarization !== false;
  const minSpeakerCount = Math.max(1, options.minSpeakers ?? 1);
  const maxSpeakerCount = Math.max(minSpeakerCount, options.maxSpeakers ?? DEFAULT_MAX_SPEAKERS);
  const [, encoding, sampleRateHertz] = ENCODINGS.find(([re]) => re.test((options.mimeType || "").toLowerCase())) ?? [];
  return {
    languageCode: options.languageCode || "en-US",
    enableAutomaticPunctuation: true,
    enableWordTimeOffsets: true,
    ...(encoding ? { encoding, sampleRateHertz } : {}),
    ...((options.audioChannelCount ?? 1) > 1 ? { audioChannelCount: options.audioChannelCount, ...(enableDiarization ? { enableSeparateRecognitionPerChannel: true } : {}) } : {}),
    diarizationConfig: enableDiarization
      ? { enableSpeakerDiarization: true, minSpeakerCount, maxSpeakerCount }
      : undefined,
  };
}

async function transcribeWithCloudSttV1(cleanAudio: string, token: string, projectId: string, options: CloudSttOptions): Promise<CloudSttResult> {
  const config = buildV1Config({ ...options, audioChannelCount: opusChannelCount(Buffer.from(cleanAudio, "base64")) });
  const response = await speechPost("https://speech.googleapis.com/v1/speech:recognize", { config, audio: { content: cleanAudio } }, token, projectId);
  if (!response.ok) throw new Error(`Google Cloud STT V1 API error (${response.status}): ${await response.text()}`);
  return toResult(await response.json(), options, true);
}

export async function checkCloudSttStatus(): Promise<{ available: boolean; authenticated: boolean; projectId?: string; error?: string }> {
  try {
    const { projectId } = await getGoogleAuthClient();
    return { available: true, authenticated: true, projectId };
  } catch (err: any) {
    return { available: false, authenticated: false, error: err.message || "Failed to authenticate with Google Cloud ADC" };
  }
}

// Self-check suite
if (import.meta.url && process.argv[1] === fileURLToPath(import.meta.url)) (async () => {
  // 1. Offset parser tests
  assert.equal(parseOffsetMs("0s"), 0);
  assert.equal(parseOffsetMs("1.200s"), 1200);
  assert.equal(parseOffsetMs("2.5s"), 2500);
  assert.equal(parseOffsetMs(1.5), 1500);
  assert.equal(parseOffsetMs(undefined), undefined);

  // 2. Speaker tag normalization
  assert.equal(formatSpeakerTag("1"), "Speaker 1");
  assert.equal(formatSpeakerTag("2"), "Speaker 2");
  assert.equal(formatSpeakerTag(3), "Speaker 3");
  assert.equal(formatSpeakerTag("Alice"), "Alice");
  assert.equal(formatSpeakerTag(""), "Speaker 1");

  // 3. Multi-speaker turn grouping
  const sampleWords: DiarizedWord[] = [
    { word: "Hi", speaker: "Speaker 1", startMs: 0, endMs: 300 },
    { word: "everyone", speaker: "Speaker 1", startMs: 350, endMs: 800 },
    { word: "Good", speaker: "Speaker 2", startMs: 1200, endMs: 1500 },
    { word: "morning", speaker: "Speaker 2", startMs: 1550, endMs: 1900 },
    { word: "Let's", speaker: "Speaker 1", startMs: 2200, endMs: 2500 },
    { word: "begin", speaker: "Speaker 1", startMs: 2550, endMs: 2900 },
  ];

  const grouped = groupWordsIntoSpeakerTurns(sampleWords);
  assert.equal(grouped.turns.length, 3);
  assert.equal(grouped.turns[0].speaker, "Speaker 1");
  assert.equal(grouped.turns[0].text, "Hi everyone");
  assert.equal(grouped.turns[1].speaker, "Speaker 2");
  assert.equal(grouped.turns[1].text, "Good morning");
  assert.equal(grouped.turns[2].speaker, "Speaker 1");
  assert.equal(grouped.turns[2].text, "Let's begin");
  assert.equal(grouped.text, "Speaker 1: Hi everyone\n\nSpeaker 2: Good morning\n\nSpeaker 1: Let's begin");

  // 4. Single-speaker turn grouping (no redundant speaker prefix)
  const singleSpeakerWords: DiarizedWord[] = [
    { word: "Schedule", speaker: "Speaker 1", startMs: 0, endMs: 400 },
    { word: "a", speaker: "Speaker 1", startMs: 450, endMs: 500 },
    { word: "dentist", speaker: "Speaker 1", startMs: 550, endMs: 900 },
    { word: "appointment", speaker: "Speaker 1", startMs: 950, endMs: 1400 },
  ];

  const singleGrouped = groupWordsIntoSpeakerTurns(singleSpeakerWords);
  assert.equal(singleGrouped.turns.length, 1);
  assert.equal(singleGrouped.text, "Schedule a dentist appointment");

  // 5. Diarization config: the floor must stay at 1. A floor of 2 forces the recognizer to
  // manufacture a second speaker out of solo audio — the bug bce2bd7 shipped and this reverts.
  const autoCfg = buildV1Config({ enableDiarization: true });
  assert.equal(autoCfg.diarizationConfig?.minSpeakerCount, 1, "diarization must auto-detect, never floor at 2");
  assert.equal(autoCfg.diarizationConfig?.maxSpeakerCount, DEFAULT_MAX_SPEAKERS);
  // An explicit caller override is still honoured, and max is never allowed below min.
  const forced = buildV1Config({ enableDiarization: true, minSpeakers: 3, maxSpeakers: 2 });
  assert.equal(forced.diarizationConfig?.minSpeakerCount, 3);
  assert.equal(forced.diarizationConfig?.maxSpeakerCount, 3, "max is raised to meet min");
  // Diarization off means no diarizationConfig at all.
  assert.equal(buildV1Config({ enableDiarization: false }).diarizationConfig, undefined);
  // These were measured as no-ops for diarization; keep them out of the request.
  assert.ok(!("model" in autoCfg) && !("useEnhanced" in autoCfg), "no model/useEnhanced cargo cult");
  // Channel count: read from the Opus header, passed through only when known.
  const head = (ch: number) => Buffer.concat([Buffer.alloc(229), Buffer.from("OpusHead"), Buffer.from([1, ch, 0x38, 0x01])]);
  assert.equal(opusChannelCount(head(2)), 2, "stereo tab audio");
  assert.equal(opusChannelCount(head(1)), 1, "mono mic audio");
  assert.equal(opusChannelCount(Buffer.from("RIFF....WAVE")), undefined, "non-Opus audio has no header");
  const stereoCfg = buildV1Config({ mimeType: "audio/webm", audioChannelCount: 2 });
  assert.equal(stereoCfg.audioChannelCount, 2);
  assert.equal(stereoCfg.enableSeparateRecognitionPerChannel, true, "stereo + diarization 500s without per-channel");
  assert.ok(!("audioChannelCount" in buildV1Config({ mimeType: "audio/webm", audioChannelCount: 1 })), "mono stays unspecified, as it always worked");
  assert.ok(!("audioChannelCount" in autoCfg), "unknown channel count stays unspecified");

  // 6. Flicker smoothing: a 1-word hand-off with no pause on either side is absorbed...
  const flicker: DiarizedWord[] = [
    { word: "so", speaker: "Speaker 1", startMs: 0, endMs: 300 },
    { word: "then", speaker: "Speaker 1", startMs: 350, endMs: 600 },
    { word: "we", speaker: "Speaker 2", startMs: 650, endMs: 800 },
    { word: "ship", speaker: "Speaker 1", startMs: 850, endMs: 1200 },
    { word: "it", speaker: "Speaker 1", startMs: 1250, endMs: 1400 },
  ];
  const smoothed = groupWordsIntoSpeakerTurns(flicker);
  assert.equal(smoothed.turns.length, 1, "one-word flicker should be absorbed");
  assert.equal(smoothed.text, "so then we ship it");

  // ...but a genuine short turn with real pauses around it survives, as does case 3 above.
  const realTurn = flicker.map((w, i) =>
    i === 2 ? { ...w, startMs: 1400, endMs: 1600 } : i > 2 ? { ...w, startMs: w.startMs! + 1600, endMs: w.endMs! + 1600 } : w
  );
  assert.equal(groupWordsIntoSpeakerTurns(realTurn).turns.length, 3, "paused interjection is a real turn");

  // A long run is never absorbed however tight the timing.
  const longRun = [
    ...flicker.slice(0, 2),
    { word: "no", speaker: "Speaker 2", startMs: 650, endMs: 750 },
    { word: "wait", speaker: "Speaker 2", startMs: 760, endMs: 900 },
    { word: "hold", speaker: "Speaker 2", startMs: 910, endMs: 1050 },
    { word: "on", speaker: "Speaker 1", startMs: 1060, endMs: 1200 },
  ];
  assert.equal(groupWordsIntoSpeakerTurns(longRun).turns.length, 3, "3-word run is not a flicker");

  // Words without timings carry no pause evidence, so nothing is smoothed.
  const untimed = flicker.map(({ word, speaker }) => ({ word, speaker }));
  assert.deepEqual(smoothSpeakerFlickers(untimed), untimed);

  // 7. Alternating flickers must not CASCADE. Reading the previous run's original tag instead of
  // its rewritten one turned 1-1-2-1-2-1 into 1-1-1-2-1-1: the third word's correct Speaker 1 was
  // flipped to Speaker 2, moving the flicker onto a good word rather than removing it.
  const tag = (n: number, t: number) => ({ word: `w${t}`, speaker: `Speaker ${n}`, startMs: t, endMs: t + 100 });
  const alternating = [tag(1, 0), tag(1, 150), tag(2, 300), tag(1, 450), tag(2, 600), tag(1, 750)];
  assert.deepEqual(
    smoothSpeakerFlickers(alternating).map(w => w.speaker),
    Array(6).fill("Speaker 1"),
    "alternating flickers all collapse to the surrounding speaker, none are moved"
  );

  // 8. The returned word list is the SMOOTHED one, and it is what a caller must count speakers
  // from. Counting the input array instead reports a speaker the turns no longer contain, and that
  // count feeds the multi-speaker latch.
  const collapsed = groupWordsIntoSpeakerTurns(flicker, { alwaysPrefixSpeaker: true });
  assert.equal(new Set(flicker.map(w => w.speaker)).size, 2, "the INPUT genuinely carries two tags");
  assert.equal(collapsed.turns.length, 1, "...which smoothing collapses to one turn...");
  assert.equal(new Set(collapsed.words.map(w => w.speaker)).size, 1,
    "...so the returned words must carry one tag, or speakerCount contradicts the turns");

  console.log("cloud-stt self-check ✓");
})();
