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

/**
 * Upper bound used when a caller names none. Two, because that is what a diarized session almost
 * always is — one other person in the room — and the cap is not free: it is the ceiling the
 * recognizer is allowed to cluster up to, so a loose one lets a noisy mic split one voice across
 * several phantom speakers. Raise it per-request for a genuine group.
 *
 * The lower bound is NOT configurable and is always 1; see buildV1Config.
 *
 * The browser has its own copy in useChunkedCapture.ts — this module imports node:assert and
 * cannot be pulled into the client bundle. Change both together.
 */
export const DEFAULT_MAX_SPEAKERS = 1;

export interface CloudSttOptions {
  mimeType?: string;
  enableDiarization?: boolean;
  minSpeakers?: number;
  maxSpeakers?: number;
  languageCode?: string;
  projectId?: string;
  location?: string;
  model?: string;
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

// Parses string offsets like "1.200s" or "2s" into milliseconds
export function parseOffsetMs(offset?: string | number): number | undefined {
  if (offset === undefined || offset === null) return undefined;
  if (typeof offset === "number") return Math.round(offset * 1000);
  const match = String(offset).match(/^([\d.]+)\s*s?$/);
  if (match) {
    return Math.round(parseFloat(match[1]) * 1000);
  }
  return undefined;
}

// Acoustic diarization flickers: inside one person's continuous speech it will occasionally hand
// one or two words to the other speaker and then hand them straight back, which surfaces as a
// spurious "Speaker 2: yeah" paragraph mid-sentence. A real floor exchange leaves a pause; a
// flicker does not. So a short run is rewritten to its neighbours' speaker only when ALL of:
//   - both neighbouring runs are the same speaker (there is something to hand it back to)
//   - the run is at most FLICKER_MAX_WORDS long
//   - it is butted up against the speech on both sides (gap <= FLICKER_MAX_GAP_MS)
// Timings are optional in DiarizedWord; with no timings there is no pause evidence, so nothing is
// smoothed rather than guessing. Both transports route through groupWordsIntoSpeakerTurns, so the
// streaming path (stt-stream.ts) gets this too.
// ponytail: fixed thresholds, picked from synthetic cases and not yet tuned on real room audio. If
// a real backchannel ("yeah", "right") ever gets absorbed, gate on word confidence rather than
// loosening the gap — the gap is the only thing separating a flicker from a short real turn.
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
    // The PREVIOUS run's speaker after any rewrite it already received, not the tag it arrived
    // with. Reading the original here is wrong on alternating flickers (1 1 2 1 2 1): once the
    // first `2` has been absorbed into `1`, the correct `1` that follows it looks like a lone `1`
    // between two `2`s and gets flipped — moving the flicker onto a good word instead of removing
    // it. Measured: 112121 came out as 111211.
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
  const end = a?.endMs ?? a?.startMs;
  const start = b?.startMs;
  if (end === undefined || start === undefined) return undefined;
  return Math.max(0, start - end);
}

// Groups word-level diarization tokens into structured dialogue turns
export function groupWordsIntoSpeakerTurns(
  words: DiarizedWord[],
  options?: { alwaysPrefixSpeaker?: boolean }
  // `words` comes back SMOOTHED. Callers must count distinct speakers off this and not off the
  // array they passed in: smoothing can collapse a two-tag chunk to one, and a caller re-deriving
  // the count from its own copy reports a speaker the turns no longer contain. That count feeds
  // the multi-speaker latch, so a flicker would otherwise corroborate exactly what corroboration
  // exists to reject.
): { text: string; turns: SpeakerTurn[]; words: DiarizedWord[] } {
  if (!words || words.length === 0) {
    return { text: "", turns: [], words: [] };
  }
  words = smoothSpeakerFlickers(words);

  const distinctSpeakers = new Set(words.map((w) => w.speaker).filter(Boolean));
  const isMultiSpeaker = distinctSpeakers.size > 1 || Boolean(options?.alwaysPrefixSpeaker);

  const turns: SpeakerTurn[] = [];
  let currentSpeaker = words[0].speaker || "Speaker 1";
  let currentWords: DiarizedWord[] = [];
  let turnStartMs = words[0].startMs;

  for (const w of words) {
    const speaker = w.speaker || "Speaker 1";
    if (speaker !== currentSpeaker && currentWords.length > 0) {
      const turnText = currentWords.map((cw) => cw.word).join(" ").trim();
      const lastWord = currentWords[currentWords.length - 1];
      turns.push({
        speaker: currentSpeaker,
        text: turnText,
        startMs: turnStartMs,
        endMs: lastWord?.endMs ?? lastWord?.startMs,
        words: currentWords,
      });
      currentSpeaker = speaker;
      currentWords = [w];
      turnStartMs = w.startMs;
    } else {
      currentWords.push(w);
    }
  }

  if (currentWords.length > 0) {
    const turnText = currentWords.map((cw) => cw.word).join(" ").trim();
    const lastWord = currentWords[currentWords.length - 1];
    turns.push({
      speaker: currentSpeaker,
      text: turnText,
      startMs: turnStartMs,
      endMs: lastWord?.endMs ?? lastWord?.startMs,
      words: currentWords,
    });
  }

  // Format full transcript text:
  // If multi-speaker or alwaysPrefixSpeaker, prefix turns with "Speaker N: <text>"
  // If single-speaker, return continuous flowing text
  let fullText = "";
  if (isMultiSpeaker) {
    fullText = turns
      .map((t) => `${t.speaker}: ${t.text}`)
      .join("\n\n");
  } else {
    fullText = turns.map((t) => t.text).join(" ").trim();
  }

  return { text: fullText, turns, words };
}

// Normalizes raw speaker label numbers ("1", "2") to friendly names ("Speaker 1", "Speaker 2")
export function formatSpeakerTag(rawLabel?: string | number): string {
  if (rawLabel === undefined || rawLabel === null || rawLabel === "") return "Speaker 1";
  const str = String(rawLabel).trim();
  if (/^\d+$/.test(str)) {
    return `Speaker ${str}`;
  }
  return str;
}

// Helper to obtain Google Cloud access token and project ID using google-auth-library
/**
 * The project speech.googleapis.com should bill and rate-limit against.
 *
 * Required, not optional. `gcloud auth application-default login` writes a credential file with no
 * `quota_project_id` in it, and every Speech API call made with a bare user credential and no quota
 * project is rejected outright: PERMISSION_DENIED, "requires a quota project, which is not set by
 * default". Being signed in is not enough — authentication and quota attribution are separate
 * things, and only the second one is missing.
 *
 * REST sends it as the `x-goog-user-project` header; the gRPC client takes it as `quotaProjectId`.
 * Both callers resolve it here so they cannot drift, which is exactly how the streaming path
 * shipped broken while the REST path worked.
 */
export async function resolveProjectId(): Promise<string> {
  const fromEnv = process.env.GOOGLE_CLOUD_PROJECT || process.env.GCP_PROJECT;
  if (fromEnv) return fromEnv;

  const { GoogleAuth } = await import("google-auth-library");
  const projectId = await new GoogleAuth({
    scopes: ["https://www.googleapis.com/auth/cloud-platform"],
  }).getProjectId();
  if (!projectId) {
    throw new Error("GCP Project ID not found. Set GOOGLE_CLOUD_PROJECT in your environment or .env file.");
  }
  return projectId;
}

async function getGoogleAuthClient(): Promise<{ token: string; projectId: string }> {
  const { GoogleAuth } = await import("google-auth-library");
  const auth = new GoogleAuth({
    scopes: ["https://www.googleapis.com/auth/cloud-platform"],
  });

  const client = await auth.getClient();
  const tokenResponse = await client.getAccessToken();
  const token = typeof tokenResponse === "string" ? tokenResponse : tokenResponse.token;
  if (!token) {
    throw new Error("Failed to obtain GCP access token. Ensure Application Default Credentials (ADC) are configured via `gcloud auth application-default login`.");
  }

  return { token, projectId: await resolveProjectId() };
}

// Transcribe audio using Google Cloud Speech-to-Text API with speaker diarization
export async function transcribeWithCloudStt(
  audioBase64: string,
  options: CloudSttOptions = {}
): Promise<CloudSttResult> {
  const { token, projectId } = await getGoogleAuthClient();
  const enableDiarization = options.enableDiarization !== false;

  // Clean base64 payload if it includes data URL prefix
  const cleanAudio = audioBase64.replace(/^data:audio\/[^;]+;base64,/, "");

  // When speaker diarization is requested, use Google Cloud STT V1 which natively
  // supports real-time synchronous speaker diarization with speakerTag tracking.
  if (enableDiarization) {
    return transcribeWithCloudSttV1(cleanAudio, token, projectId, options);
  }

  // When diarization is not requested, use Google Cloud STT V2 Chirp 2 in us-central1
  const languageCode = options.languageCode || "en-US";
  const url = `https://us-central1-speech.googleapis.com/v2/projects/${projectId}/locations/us-central1/recognizers/_:recognize`;

  const requestBody: Record<string, any> = {
    config: {
      autoDecodingConfig: {},
      languageCodes: [languageCode],
      model: options.model || "chirp_2",
    },
    content: cleanAudio,
  };

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      "x-goog-user-project": projectId,
    },
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) {
    const errorText = await response.text();
    // If V2 default recognizer returns 404/400, attempt V1 fallback
    if (response.status === 404 || response.status === 400) {
      console.warn(`[CloudSTT] V2 request failed (${response.status}), attempting V1 fallback:`, errorText);
      return transcribeWithCloudSttV1(cleanAudio, token, projectId, options);
    }
    throw new Error(`Google Cloud STT V2 API error (${response.status}): ${errorText}`);
  }

  const data = await response.json();
  const words: DiarizedWord[] = [];

  // Parse V2 results structure
  for (const result of data.results || []) {
    const alternative = result.alternatives?.[0];
    if (!alternative) continue;

    for (const w of alternative.words || []) {
      const rawSpeaker = w.speakerLabel || w.speakerTag;
      words.push({
        word: w.word,
        speaker: formatSpeakerTag(rawSpeaker),
        startMs: parseOffsetMs(w.startOffset),
        endMs: parseOffsetMs(w.endOffset),
        confidence: w.confidence,
      });
    }
  }

  // If no word-level entries were returned but transcript text exists, fall back to top transcript
  if (words.length === 0) {
    const rawTranscript = (data.results || [])
      .map((r: any) => r.alternatives?.[0]?.transcript)
      .filter(Boolean)
      .join(" ");
    const fallbackText = options.enableDiarization && rawTranscript ? `Speaker 1: ${rawTranscript.trim()}` : rawTranscript.trim();
    return {
      text: fallbackText,
      speakerTurns: rawTranscript ? [{ speaker: "Speaker 1", text: rawTranscript.trim(), words: [] }] : [],
      words: [],
      speakerCount: rawTranscript ? 1 : 0,
      provider: "google_cloud_stt",
    };
  }

  const { text, turns, words: diarized } = groupWordsIntoSpeakerTurns(words, { alwaysPrefixSpeaker: Boolean(options.enableDiarization) });
  const distinctSpeakers = new Set(diarized.map((w) => w.speaker).filter(Boolean));

  return {
    text,
    speakerTurns: turns,
    words: diarized,
    speakerCount: distinctSpeakers.size,
    provider: "google_cloud_stt",
  };
}

// The V1 `config` block, split out from the request so it can be asserted without a network call.
//
// ponytail: the speaker floor stays at 1 — do NOT "help" the clusterer by raising it.
//
// Measured against the live V1 API, minSpeakerCount is ADVISORY, not the hard k>=N constraint the
// name suggests, and every effect observed from raising it was harmful:
//   - Real speech ignores it. On Google's own two-speaker sample (commercial_mono.wav), min=1 and
//     min=2 gave byte-identical output on every 8s chunk, and a genuinely single-speaker span
//     stayed at 1 speaker for min=1, min=2 AND min=3. Raising it buys nothing on clean audio.
//   - It only bites when the clusterer is UNCERTAIN, and then it fabricates: on low-confidence
//     audio a floor of 2 split one continuous speaker at an arbitrary pause, which is what a
//     noisy shared-room mic looks like to the recognizer.
// Zero measured benefit, non-zero measured harm. The live capture path pins this at 1 and the
// Admin control sets the upper bound only. Raising the floor shipped once, in bce2bd7.
//
// Nothing else belongs here either: `model` (video/phone_call/latest_long) and `useEnhanced` were
// measured to give byte-identical diarization, so they are cost without effect.
// Channel count from the Opus ID header ("OpusHead", count at byte 9). Pinning WEBM_OPUS makes V1
// assume mono, but Chrome records a shared tab in stereo, so every tab chunk was rejected
// ("audio_channel_count `1` ... must match ... `2`") and fell back to Gemini with no speakers.
// Stereo + diarization then 500s unless per-channel recognition is on (measured live, 2026-09-14).
// ponytail: the LAST result's diarized words are one channel's — fine for a tab's identical mix; a
// true two-mic stereo source would need the channels merged by channelTag.
export function opusChannelCount(audio: Buffer): number | undefined {
  const at = audio.indexOf("OpusHead");
  return at < 0 ? undefined : audio[at + 9];
}

export function buildV1Config(options: CloudSttOptions) {
  const enableDiarization = options.enableDiarization !== false;
  const minSpeakerCount = Math.max(1, options.minSpeakers ?? 1);
  const maxSpeakerCount = Math.max(minSpeakerCount, options.maxSpeakers ?? DEFAULT_MAX_SPEAKERS);
  // V1 recognize auto-detects badly on container formats, so pin encoding (and the rate Opus
  // always uses) when the MIME type is one we recognise; anything else falls back to auto-detect.
  const mime = (options.mimeType || "").toLowerCase();
  let encoding: string | undefined;
  let sampleRateHertz: number | undefined;
  if (mime.includes("webm")) { encoding = "WEBM_OPUS"; sampleRateHertz = 48000; }
  else if (mime.includes("ogg") || mime.includes("opus")) { encoding = "OGG_OPUS"; sampleRateHertz = 48000; }
  else if (mime.includes("wav") || mime.includes("linear16")) { encoding = "LINEAR16"; }
  else if (mime.includes("mp3")) { encoding = "MP3"; }
  else if (mime.includes("flac")) { encoding = "FLAC"; }
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

// Transcribe using Google Cloud STT V1 API (native support for synchronous speaker diarization)
async function transcribeWithCloudSttV1(
  cleanAudio: string,
  token: string,
  projectId: string,
  options: CloudSttOptions
): Promise<CloudSttResult> {
  const url = "https://speech.googleapis.com/v1/speech:recognize";
  const requestBody = { config: buildV1Config({ ...options, audioChannelCount: opusChannelCount(Buffer.from(cleanAudio, "base64")) }), audio: { content: cleanAudio } };

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      "x-goog-user-project": projectId,
    },
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Google Cloud STT V1 API error (${response.status}): ${errorText}`);
  }

  const data = await response.json();
  const words: DiarizedWord[] = [];

  // In V1, the final result in results contains the complete diarized words list
  const lastResult = (data.results || []).slice(-1)[0];
  const lastAlternative = lastResult?.alternatives?.[0];

  if (lastAlternative?.words?.length) {
    for (const w of lastAlternative.words) {
      const rawSpeaker = w.speakerTag || w.speakerLabel;
      words.push({
        word: w.word,
        speaker: formatSpeakerTag(rawSpeaker),
        startMs: parseOffsetMs(w.startTime),
        endMs: parseOffsetMs(w.endTime),
        confidence: w.confidence,
      });
    }
  } else {
    // Collect words from all alternatives
    for (const result of data.results || []) {
      const alternative = result.alternatives?.[0];
      if (!alternative) continue;
      for (const w of alternative.words || []) {
        words.push({
          word: w.word,
          speaker: formatSpeakerTag(w.speakerTag || w.speakerLabel),
          startMs: parseOffsetMs(w.startTime),
          endMs: parseOffsetMs(w.endTime),
          confidence: w.confidence,
        });
      }
    }
  }

  if (words.length === 0) {
    const rawTranscript = (data.results || [])
      .map((r: any) => r.alternatives?.[0]?.transcript)
      .filter(Boolean)
      .join(" ");
    const fallbackText = options.enableDiarization && rawTranscript ? `Speaker 1: ${rawTranscript.trim()}` : rawTranscript.trim();
    return {
      text: fallbackText,
      speakerTurns: rawTranscript ? [{ speaker: "Speaker 1", text: rawTranscript.trim(), words: [] }] : [],
      words: [],
      speakerCount: rawTranscript ? 1 : 0,
      provider: "google_cloud_stt",
    };
  }

  const { text, turns, words: diarized } = groupWordsIntoSpeakerTurns(words, { alwaysPrefixSpeaker: Boolean(options.enableDiarization) });
  const distinctSpeakers = new Set(diarized.map((w) => w.speaker).filter(Boolean));

  return {
    text,
    speakerTurns: turns,
    words: diarized,
    speakerCount: distinctSpeakers.size,
    provider: "google_cloud_stt",
  };
}

// Checks Cloud STT readiness and returns current auth/project status
export async function checkCloudSttStatus(): Promise<{
  available: boolean;
  authenticated: boolean;
  projectId?: string;
  error?: string;
}> {
  try {
    const { token, projectId } = await getGoogleAuthClient();
    return {
      available: Boolean(token && projectId),
      authenticated: true,
      projectId,
    };
  } catch (err: any) {
    return {
      available: false,
      authenticated: false,
      error: err.message || "Failed to authenticate with Google Cloud ADC",
    };
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
