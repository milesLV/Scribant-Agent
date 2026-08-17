// Google Cloud Speech-to-Text V2 provider with acoustic speaker diarization.
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

export interface CloudSttOptions {
  mimeType?: string;
  enableDiarization?: boolean;
  minSpeakers?: number;
  maxSpeakers?: number;
  languageCode?: string;
  projectId?: string;
  location?: string;
  model?: string;
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

// Groups word-level diarization tokens into structured dialogue turns
export function groupWordsIntoSpeakerTurns(
  words: DiarizedWord[],
  options?: { alwaysPrefixSpeaker?: boolean }
): { text: string; turns: SpeakerTurn[] } {
  if (!words || words.length === 0) {
    return { text: "", turns: [] };
  }

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

  return { text: fullText, turns };
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

  let projectId = process.env.GOOGLE_CLOUD_PROJECT || process.env.GCP_PROJECT;
  if (!projectId) {
    projectId = (await auth.getProjectId()) || undefined;
  }
  if (!projectId) {
    throw new Error("GCP Project ID not found. Set GOOGLE_CLOUD_PROJECT in your environment or .env file.");
  }

  return { token, projectId };
}

// Transcribe audio using Google Cloud Speech-to-Text V2 API with speaker diarization
export async function transcribeWithCloudStt(
  audioBase64: string,
  options: CloudSttOptions = {}
): Promise<CloudSttResult> {
  const { token, projectId } = await getGoogleAuthClient();
  const location = options.location || process.env.VERTEX_AI_LOCATION || process.env.GOOGLE_CLOUD_LOCATION || "us-central1";
  const languageCode = options.languageCode || "en-US";
  const minSpeakers = Math.max(1, options.minSpeakers ?? 1);
  const maxSpeakers = Math.max(minSpeakers, options.maxSpeakers ?? 5);
  const enableDiarization = options.enableDiarization !== false;

  // Clean base64 payload if it includes data URL prefix
  const cleanAudio = audioBase64.replace(/^data:audio\/[^;]+;base64,/, "");

  // Cloud STT V2 REST recognize endpoint
  // Using the default recognizer `_` in specified location
  const url = `https://speech.googleapis.com/v2/projects/${projectId}/locations/${location}/recognizers/_:recognize`;

  const requestBody: Record<string, any> = {
    config: {
      autoDecodingConfig: {},
      languageCodes: [languageCode],
      model: options.model || "chirp_2",
      features: enableDiarization
        ? {
            diarizationConfig: {
              minSpeakerCount: minSpeakers,
              maxSpeakerCount: maxSpeakers,
            },
          }
        : {},
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
    // If V2 default recognizer returns 404/400 (e.g. location/model unsupported), attempt V1 fallback
    if (response.status === 404 || response.status === 400) {
      console.warn(`[CloudSTT] V2 request failed (${response.status}), attempting V1 fallback:`, errorText);
      return transcribeWithCloudSttV1Fallback(cleanAudio, token, projectId, options);
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

  const { text, turns } = groupWordsIntoSpeakerTurns(words, { alwaysPrefixSpeaker: Boolean(options.enableDiarization) });
  const distinctSpeakers = new Set(words.map((w) => w.speaker).filter(Boolean));

  return {
    text,
    speakerTurns: turns,
    words,
    speakerCount: distinctSpeakers.size,
    provider: "google_cloud_stt",
  };
}

// Fallback to Cloud STT V1 API for environments or regions where V2 is not initialized
async function transcribeWithCloudSttV1Fallback(
  cleanAudio: string,
  token: string,
  projectId: string,
  options: CloudSttOptions
): Promise<CloudSttResult> {
  const languageCode = options.languageCode || "en-US";
  const minSpeakers = Math.max(1, options.minSpeakers ?? 1);
  const maxSpeakers = Math.max(minSpeakers, options.maxSpeakers ?? 5);
  const enableDiarization = options.enableDiarization !== false;

  const url = "https://speech.googleapis.com/v1/speech:recognize";
  const requestBody = {
    config: {
      languageCode,
      enableAutomaticPunctuation: true,
      enableWordTimeOffsets: true,
      diarizationConfig: enableDiarization
        ? {
            enableSpeakerDiarization: true,
            minSpeakerCount: minSpeakers,
            maxSpeakerCount: maxSpeakers,
          }
        : undefined,
    },
    audio: {
      content: cleanAudio,
    },
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

  const { text, turns } = groupWordsIntoSpeakerTurns(words, { alwaysPrefixSpeaker: Boolean(options.enableDiarization) });
  const distinctSpeakers = new Set(words.map((w) => w.speaker).filter(Boolean));

  return {
    text,
    speakerTurns: turns,
    words,
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

  console.log("cloud-stt self-check ✓");
})();
