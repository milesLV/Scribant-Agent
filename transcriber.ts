// Transcriber agent — turns speech into Word[] with a per-word confidence score.
// Two providers, one output shape (the seam); everything downstream sees the same Word[]:
//   A) markStrangeWords — augments browser Web Speech text via an LLM context pass. Default, no extra infra.
//   B) transcribeAudio  — Google Cloud Speech-to-Text, real acoustic word confidence. Swap-in.
import assert from "node:assert/strict";
import { fileURLToPath } from "url";
import { Word } from "./src/types";

export const STRANGE_THRESHOLD = 0.7;

// Split text into words with char offsets. \S+ run over the string; match.index is the offset.
export function tokenize(text: string): { text: string; start: number; end: number }[] {
  const out: { text: string; start: number; end: number }[] = [];
  const re = /\S+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) out.push({ text: m[0], start: m.index, end: m.index + m[0].length });
  return out;
}

// ---- Provider A: LLM "strange word" pass ------------------------------------
// Every word starts confident (1.0); the model only returns the suspicious ones, which we overlay.
// `generate` is the server's generateWithFallback gateway, injected to dodge a circular import
// (and so the Transcriber inherits the same key-rotation + local-LLM fallback as the other agents).
type Generate = (params: { model: string; contents: string; config?: any }) => Promise<{ text?: string }>;

const PROOFREAD_INSTRUCTION = `You are a transcription proofreader. You receive a speech-to-text transcript with each word indexed from 0. A speech recognizer sometimes hears the wrong word — it then looks out of place given its neighbors.
Return ONLY JSON: { "strange": [ { "index": <0-based word index>, "word": "<word as transcribed>", "confidence": <0..1, how likely it is CORRECT>, "suggestions": ["<more likely intended word>", ...] } ] }
Include a word only if it seems misheard or out of place. Lower confidence = more suspicious. Return an empty array if everything reads fine. Do not rewrite the transcript.`;

export async function markStrangeWords(
  text: string,
  generate: Generate,
  model = "gemini-2.5-flash"
): Promise<Word[]> {
  const tokens = tokenize(text);
  const words: Word[] = tokens.map(t => ({ ...t, confidence: 1 }));
  if (tokens.length === 0) return words;

  const res = await generate({
    model,
    contents: `Indexed transcript:\n${tokens.map((t, i) => `${i}:${t.text}`).join(" ")}`,
    config: { systemInstruction: PROOFREAD_INSTRUCTION, responseMimeType: "application/json" },
  });

  let strange: { index: number; word: string; confidence?: number; suggestions?: string[] }[] = [];
  try { strange = JSON.parse(stripFences(res.text || "{}")).strange || []; } catch { /* all stay confident */ }

  for (const s of strange) {
    // Trust the index when its word matches; otherwise fall back to first text match.
    // ponytail: index-with-text-fallback matching; fine for brain-dump length. Revisit only if the model miscounts often.
    let i = s.index;
    if (!(words[i] && looseEq(words[i].text, s.word))) i = words.findIndex(w => looseEq(w.text, s.word));
    if (i >= 0 && words[i]) {
      words[i].confidence = clamp(s.confidence ?? 0.5);
      if (s.suggestions?.length) words[i].alternatives = s.suggestions;
    }
  }
  return words;
}

// ---- Provider B: Google Cloud Speech-to-Text --------------------------------
// Real acoustic confidence. Needs a GCP API key with Speech-to-Text enabled, server-side
// (the user's OAuth scopes for Calendar/Tasks/Drive do NOT cover STT). audio = base64 LINEAR16/FLAC.
export async function transcribeAudio(
  audioBase64: string,
  apiKey: string,
  languageCode = "en-US"
): Promise<{ text: string; words: Word[] }> {
  const res = await fetch(`https://speech.googleapis.com/v1/speech:recognize?key=${apiKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      config: { languageCode, enableWordConfidence: true, maxAlternatives: 1 },
      audio: { content: audioBase64 },
    }),
  });
  if (!res.ok) throw new Error(`Cloud STT ${res.status}: ${(await res.text()).slice(0, 120)}`);
  const data = await res.json();

  // Flatten result words, rebuilding the text + char offsets as we go so sourceSpans line up.
  const words: Word[] = [];
  let text = "";
  for (const r of data.results ?? []) {
    for (const w of r.alternatives?.[0]?.words ?? []) {
      const start = text.length ? text.length + 1 : 0;
      text = text ? `${text} ${w.word}` : w.word;
      words.push({ text: w.word, start, end: start + w.word.length, confidence: w.confidence ?? 1 });
    }
  }
  return { text, words };
}

// ---- helpers ----
// ponytail: tiny local fence-strip; shares intent with server's cleanJsonString, not worth a shared util for one line.
function stripFences(s: string): string {
  const t = s.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  return a >= 0 && b > a ? t.slice(a, b + 1) : t;
}
function looseEq(a: string, b: string): boolean {
  return a.replace(/\W/g, "").toLowerCase() === b.replace(/\W/g, "").toLowerCase();
}
function clamp(n: number): number {
  return Math.max(0, Math.min(1, n));
}

// ponytail self-check: `npx tsx transcriber.ts`
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  (async () => {
    const toks = tokenize("call grandma tomorow");
    assert.equal(toks.length, 3);
    assert.deepEqual(toks[2], { text: "tomorow", start: 13, end: 20 });

    const fakeGen: Generate = async () => ({
      text: JSON.stringify({ strange: [{ index: 2, word: "tomorow", confidence: 0.4, suggestions: ["tomorrow"] }] }),
    });
    const words = await markStrangeWords("call grandma tomorow", fakeGen);
    assert.equal(words[0].confidence, 1);
    assert.equal(words[2].confidence, 0.4);
    assert.deepEqual(words[2].alternatives, ["tomorrow"]);

    // index miss → falls back to text match
    const badIndex: Generate = async () => ({
      text: JSON.stringify({ strange: [{ index: 9, word: "tomorow", confidence: 0.3 }] }),
    });
    assert.equal((await markStrangeWords("call grandma tomorow", badIndex))[2].confidence, 0.3);

    console.log("transcriber self-check ✓");
  })();
}
