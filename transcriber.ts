// Transcriber agent — turns Web Speech text into Word[] with a per-word confidence score via
// proofreadAndCorrect: an LLM pass that auto-corrects obvious typos and flags ambiguous mishearings.
import assert from "node:assert/strict";
import { fileURLToPath } from "url";
import { Word } from "./src/types";
import { cleanJsonString } from "./server-utils";

// Split text into words with char offsets. \S+ run over the string; match.index is the offset.
function tokenize(text: string): { text: string; start: number; end: number }[] {
  const out: { text: string; start: number; end: number }[] = [];
  const re = /\S+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) out.push({ text: m[0], start: m.index, end: m.index + m[0].length });
  return out;
}

// `generate` is the server's generateWithFallback gateway, injected to dodge a circular import
// (and so the Transcriber inherits the same key-rotation + local-LLM fallback as the other agents).
type Generate = (params: { model: string; contents: string; config?: any }) => Promise<{ text?: string }>;

// ---- Provider A: obvious correction vs ambiguous flag (the proofread router) ------
// One LLM pass that ROUTES each suspect word to one of two actions instead of flagging everything:
//   corrections — obvious typo/grammar with a single unambiguous fix, safe to auto-apply.
//   strange     — real word likely misheard/wrong-in-context, where the fix is a judgement call -> flag.
// Self-corrected phrases ("write, actually written-down") are left alone. Same Word[] seam as above.
interface Correction { index: number; from: string; to: string; }

const PROOFREAD_CORRECT_INSTRUCTION = `You are a transcription proofreader for spoken brain-dumps. Each word is indexed from 0.
Route each suspect word to EXACTLY ONE of two actions:
1. CORRECT — an OBVIOUS error with a single unambiguous fix: a clear misspelling/typo ("tomorow"->"tomorrow") or a clear grammatical slip ("she dont"->"she doesn't"). Put these in "corrections".
2. FLAG — a real, correctly-spelled word that is likely MISHEARD or wrong in context, where the intended word is a judgement call ("peer" vs "pier", "bored" vs "board"). Put these in "strange" with low confidence + suggestions. Do NOT auto-correct these.
If the speaker already corrected themselves in-line ("write, actually written-down"), leave both words alone.
Return ONLY JSON:
{ "corrections": [ { "index": <int>, "from": "<as transcribed>", "to": "<corrected>" } ],
  "strange":     [ { "index": <int>, "word": "<as transcribed>", "confidence": <0..1 how likely CORRECT>, "suggestions": ["<intended>", ...] } ] }
Return empty arrays if the transcript reads fine. Never rewrite clean text.
For a multi-word PHRASE fix ("frozen cons" -> "pros and cons"), put the WHOLE intended phrase as one string ("to" for a correction, or one "suggestions" entry for a flag) — never split it word-by-word.`;

export async function proofreadAndCorrect(
  text: string,
  generate: Generate,
  model = "gemini-2.5-flash"
): Promise<{ corrections: Correction[]; words: Word[] }> {
  const tokens = tokenize(text);
  const words: Word[] = tokens.map(t => ({ ...t, confidence: 1 }));
  if (tokens.length === 0) return { corrections: [], words };

  const res = await generate({
    model,
    contents: `Indexed transcript:\n${tokens.map((t, i) => `${i}:${t.text}`).join(" ")}`,
    config: { systemInstruction: PROOFREAD_CORRECT_INSTRUCTION, responseMimeType: "application/json" },
  });

  let parsed: any = {};
  try { parsed = JSON.parse(cleanJsonString(res.text || "")); } catch { /* leave everything clean */ }

  const corrections: Correction[] = [];
  for (const c of parsed.corrections || []) {
    // Same index-then-text-match fallback as the flag path (guards model index drift).
    let i = c.index;
    if (!(tokens[i] && looseEq(tokens[i].text, c.from))) i = tokens.findIndex(t => looseEq(t.text, c.from));
    if (i >= 0 && tokens[i] && c.to) corrections.push({ index: i, from: tokens[i].text, to: String(c.to) });
  }

  for (const s of parsed.strange || []) {
    let i = s.index;
    if (!(words[i] && looseEq(words[i].text, s.word))) i = words.findIndex(w => looseEq(w.text, s.word));
    if (i >= 0 && words[i]) {
      words[i].confidence = clamp(s.confidence ?? 0.5);
      if (s.suggestions?.length) words[i].alternatives = s.suggestions;
    }
  }
  return { corrections, words };
}

// ---- helpers ----
function looseEq(a: string, b: string): boolean {
  return a.replace(/\W/g, "").toLowerCase() === b.replace(/\W/g, "").toLowerCase();
}
function clamp(n: number): number {
  return Math.max(0, Math.min(1, n));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  (async () => {
    const toks = tokenize("call grandma tomorow");
    assert.equal(toks.length, 3);
    assert.deepEqual(toks[2], { text: "tomorow", start: 13, end: 20 });

    // router: obvious typo -> correction (not a flag); ambiguous stays a flag; clean words untouched.
    const routerGen: Generate = async () => ({
      text: JSON.stringify({
        corrections: [{ index: 2, from: "tomorow", to: "tomorrow" }],
        strange: [{ index: 1, word: "peer", confidence: 0.4, suggestions: ["pier"] }],
      }),
    });
    const routed = await proofreadAndCorrect("meet peer tomorow", routerGen);
    assert.deepEqual(routed.corrections, [{ index: 2, from: "tomorow", to: "tomorrow" }]);
    assert.equal(routed.words[1].confidence, 0.4);          // ambiguous -> flagged
    assert.deepEqual(routed.words[1].alternatives, ["pier"]);
    assert.equal(routed.words[2].confidence, 1);            // auto-corrected word not double-flagged
    assert.equal(routed.words[0].confidence, 1);            // clean word untouched

    // index drift -> both loops fall back to matching by word text
    const driftGen: Generate = async () => ({
      text: JSON.stringify({ corrections: [{ index: 9, from: "tomorow", to: "tomorrow" }], strange: [{ index: 9, word: "peer", confidence: 0.3 }] }),
    });
    const drifted = await proofreadAndCorrect("meet peer tomorow", driftGen);
    assert.deepEqual(drifted.corrections, [{ index: 2, from: "tomorow", to: "tomorrow" }]);
    assert.equal(drifted.words[1].confidence, 0.3);

    console.log("transcriber self-check ✓");
  })();
}
