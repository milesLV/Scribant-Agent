// The proofread pass, in two halves the orchestrator drives around its proofreader sub-agent:
// buildProofreadPrompt indexes the transcript for the model, parseProofread turns the reply into
// auto-corrections plus flagged mishearings (Word[] with a per-word confidence score).
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

// ---- Provider A: obvious correction vs ambiguous flag (the proofread router) ------
// One LLM pass that ROUTES each suspect word to one of two actions instead of flagging everything:
//   corrections — obvious typo/grammar with a single unambiguous fix, safe to auto-apply.
//   flagged     — real word likely misheard/wrong-in-context, where the fix is a judgement call -> flag.
// Self-corrected phrases ("write, actually written-down") are left alone. Same Word[] seam as above.
interface Correction { index: number; from: string; to: string; }

export const PROOFREAD_CORRECT_INSTRUCTION = `You are a transcription proofreader for spoken brain-dumps. Each word is indexed from 0.
Route each suspect word to EXACTLY ONE of three actions:
1. CORRECT — an OBVIOUS error with a single unambiguous fix: a clear misspelling/typo ("tomorow"->"tomorrow") or a clear grammatical slip ("she dont"->"she doesn't"). Put these in "corrections".
2. FLAG — a real, correctly-spelled word that is likely MISHEARD or wrong in context, where the intended word is a judgement call ("peer" vs "pier", "bored" vs "board"). Put these in "flagged" with low confidence + suggestions. Do NOT auto-correct these.
3. DELETE — a STRAY word the speech recogniser invented next to the word it garbled, so the sentence reads correctly only once it is removed: a false start ("I went to the stork store" -> drop "stork"), a phonetic near-duplicate ("I am reeling reading a book" -> drop "reeling"), a partial word ("the caf- cafe" -> drop "caf-"), or an accidental stutter ("I need to to go" -> drop one "to"). Put these in "deletions".
   DELETE IS DESTRUCTIVE — only use it when the neighbouring word is clearly the intended one and the stray word contributes NOTHING. When in doubt, FLAG instead.
   NEVER delete a deliberate repetition or a word that carries meaning: "it was very very cold" (emphasis), "I had had enough" (grammar), "New York, New York" (a real name), "it is what it is" — all of these must be left completely alone.
If the speaker already corrected themselves in-line ("write, actually written-down"), leave both words alone.
Return ONLY JSON:
{ "corrections": [ { "index": <int>, "from": "<as transcribed>", "to": "<corrected>" } ],
  "flagged":     [ { "index": <int>, "word": "<as transcribed>", "confidence": <0..1 how likely CORRECT>, "suggestions": ["<intended>", ...] } ],
  "deletions":   [ { "index": <int>, "word": "<as transcribed>" } ] }
Return empty arrays if the transcript reads fine. Never rewrite clean text.
For a multi-word PHRASE fix ("frozen cons" -> "pros and cons"), put the WHOLE intended phrase as one string ("to" for a correction, or one "suggestions" entry for a flag) — never split it word-by-word.`;

// The two halves of the proofread pass, split so the caller can own the model call in between:
// the orchestrator's proofreader sub-agent is an ADK LlmAgent, so ADK makes the request and this
// module only builds the prompt and reads the answer.
type ProofPrompt = { tokens: { text: string; start: number; end: number }[]; words: Word[]; contents: string };

export function buildProofreadPrompt(text: string): ProofPrompt {
  const tokens = tokenize(text);
  return {
    tokens,
    words: tokens.map(t => ({ ...t, confidence: 1 })),
    contents: `Indexed transcript:\n${tokens.map((t, i) => `${i}:${t.text}`).join(" ")}`,
  };
}

export function parseProofread(rawText: string, prompt: ProofPrompt): { corrections: Correction[]; words: Word[] } {
  const { tokens, words } = prompt;
  if (tokens.length === 0) return { corrections: [], words };

  let parsed: any = {};
  try { parsed = JSON.parse(cleanJsonString(rawText || "")); } catch { /* leave everything clean */ }

  const corrections: Correction[] = [];
  for (const c of parsed.corrections || []) {
    // Same index-then-text-match fallback as the flag path (guards model index drift).
    let i = c.index;
    if (!(tokens[i] && looseEq(tokens[i].text, c.from))) i = tokens.findIndex(t => looseEq(t.text, c.from));
    if (i >= 0 && tokens[i] && c.to) corrections.push({ index: i, from: tokens[i].text, to: String(c.to) });
  }

  // Deletions fold into `corrections` as an empty `to`, so every downstream consumer keeps iterating
  // ONE array. The model proposing a delete is not enough — isDisfluency has to agree the token looks
  // like an artifact of a neighbour. Note the `c.to` truthiness guard above stays intact: a malformed
  // correction with a blank `to` is still dropped rather than being read as "delete this".
  for (const d of parsed.deletions || []) {
    let i = d.index;
    if (!(tokens[i] && looseEq(tokens[i].text, d.word))) i = tokens.findIndex(t => looseEq(t.text, d.word));
    if (i < 0 || !tokens[i]) continue;
    if (corrections.some(c => c.index === i)) continue;   // already being rewritten; two edits would corrupt offsets
    const neighbours = [tokens[i - 1]?.text, tokens[i + 1]?.text].filter(Boolean) as string[];
    if (!isDisfluency(tokens[i].text, neighbours)) continue;
    corrections.push({ index: i, from: tokens[i].text, to: "" });
  }

  for (const s of parsed.flagged || []) {
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

// Levenshtein, char-level. Small inputs (single words), so the plain O(n*m) table is fine.
function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++)
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] : 1 + Math.min(prev[j], cur[j - 1], prev[j - 1]);
    prev = cur;
  }
  return prev[b.length];
}

// Deleting a word is destructive and irreversible from the user's side, so a RULE — not the model —
// decides what may be deleted at all: a token only qualifies as a transcription artifact when a
// neighbour looks like the word it garbled ("stork store", "reeling reading", "to to").
//
// This bounds the blast radius to "adjacent to something similar"; it is deliberately NOT sufficient
// on its own. An intentional repeat ("very very cold") passes this guard by design — rejecting THAT
// is the prompt's job. Guard limits the damage, prompt handles the intent; both are load-bearing.
export function isDisfluency(word: string, neighbours: string[]): boolean {
  const a = word.replace(/\W/g, "").toLowerCase();
  if (!a) return false;
  return neighbours.some(raw => {
    const b = raw.replace(/\W/g, "").toLowerCase();
    if (!b) return false;
    if (a === b) return true;                                     // exact accidental repeat
    let p = 0;
    while (p < a.length && p < b.length && a[p] === b[p]) p++;
    if (p < 2) return false;                                      // must share a real prefix
    return editDistance(a, b) <= Math.floor(Math.min(a.length, b.length) / 2);
  });
}
function clamp(n: number): number {
  return Math.max(0, Math.min(1, n));
}

// import.meta.url is empty in the esbuild CJS bundle, so self-checks stay dev-only (prod boot would crash on fileURLToPath(undefined)).
if (import.meta.url && process.argv[1] === fileURLToPath(import.meta.url)) {
  (async () => {
    const toks = tokenize("call grandma tomorow");
    assert.equal(toks.length, 3);
    assert.deepEqual(toks[2], { text: "tomorow", start: 13, end: 20 });

    // The model's reply, run back through the parse half — the orchestrator's proofreader sub-agent
    // makes the request in between, so a stub for it would only be testing ADK.
    const proofread = (text: string, reply: object) => parseProofread(JSON.stringify(reply), buildProofreadPrompt(text));

    // The indexed prompt the model is given.
    assert.match(buildProofreadPrompt("meet peer tomorow").contents, /0:meet 1:peer 2:tomorow/);

    // router: obvious typo -> correction (not a flag); ambiguous stays a flag; clean words untouched.
    const routed = proofread("meet peer tomorow", {
      corrections: [{ index: 2, from: "tomorow", to: "tomorrow" }],
      flagged: [{ index: 1, word: "peer", confidence: 0.4, suggestions: ["pier"] }],
    });
    assert.deepEqual(routed.corrections, [{ index: 2, from: "tomorow", to: "tomorrow" }]);
    assert.equal(routed.words[1].confidence, 0.4);          // ambiguous -> flagged
    assert.deepEqual(routed.words[1].alternatives, ["pier"]);
    assert.equal(routed.words[2].confidence, 1);            // auto-corrected word not double-flagged
    assert.equal(routed.words[0].confidence, 1);            // clean word untouched

    // index drift -> both loops fall back to matching by word text
    const drifted = proofread("meet peer tomorow", {
      corrections: [{ index: 9, from: "tomorow", to: "tomorrow" }],
      flagged: [{ index: 9, word: "peer", confidence: 0.3 }],
    });
    assert.deepEqual(drifted.corrections, [{ index: 2, from: "tomorow", to: "tomorrow" }]);
    assert.equal(drifted.words[1].confidence, 0.3);

    // --- disfluency guard: what the model is ALLOWED to delete, independent of what it asks for ---
    assert.equal(isDisfluency("stork", ["the", "store"]), true, "false start vs its target");
    assert.equal(isDisfluency("reeling", ["am", "reading"]), true, "phonetic near-duplicate");
    assert.equal(isDisfluency("caf-", ["the", "cafe"]), true, "partial word");
    assert.equal(isDisfluency("to", ["to", "go"]), true, "exact stutter");
    assert.equal(isDisfluency("elephant", ["the", "store"]), false, "unrelated word is not an artifact");
    assert.equal(isDisfluency("very", ["was", "very"]), true, "intentional repeat PASSES the guard by design");

    // deletions fold into corrections as an empty `to`
    const deleted = proofread("I went to the stork store", { corrections: [], flagged: [], deletions: [{ index: 4, word: "stork" }] });
    assert.deepEqual(deleted.corrections, [{ index: 4, from: "stork", to: "" }]);

    // the guard overrides the model: deleting an unrelated word is refused
    const refused = proofread("I went to the elephant store", { corrections: [], flagged: [], deletions: [{ index: 4, word: "elephant" }] });
    assert.deepEqual(refused.corrections, [], "guard refuses to delete a real word");

    // a blank `to` on a CORRECTION is still malformed input, not a delete
    const blank = proofread("I went to the stork store", { corrections: [{ index: 4, from: "stork", to: "" }], flagged: [] });
    assert.deepEqual(blank.corrections, [], "blank `to` on a correction is dropped, not treated as delete");

    // same token both corrected and deleted -> the correction wins, one edit only
    const clash = proofread("I went to the stork store", {
      corrections: [{ index: 4, from: "stork", to: "stock" }], flagged: [],
      deletions: [{ index: 4, word: "stork" }],
    });
    assert.deepEqual(clash.corrections, [{ index: 4, from: "stork", to: "stock" }], "no double edit on one token");

    console.log("transcriber self-check ✓");
  })();
}
