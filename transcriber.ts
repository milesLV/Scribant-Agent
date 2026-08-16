// The proofread pass, in two halves the orchestrator drives around its proofreader sub-agent:
// buildProofreadPrompt indexes the transcript for the model, parseProofread turns the reply into
// auto-corrections plus flagged mishearings (Word[] with a per-word confidence score).
import assert from "node:assert/strict";
import { fileURLToPath } from "url";
import { Word } from "./src/types";
import { cleanJsonString } from "./server-utils";
import { applyCorrections } from "./src/utils/transcript";

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
This is raw speech-to-text: no punctuation, no capitalization, ever, from the recognizer, even where a sentence clearly ended. Restoring that is MANDATORY on every call, on top of anything else below — a transcript with correctly-spelled words but no capitals or periods is NOT clean text, and "return empty arrays if it reads fine" does NOT apply to this part. Put each fix in "corrections":
- Capitalize the first word of every sentence, and every standalone "i".
- End every sentence that has clearly finished with a period or question mark, attached to its LAST word ("...went home" -> "corrections" entry rewriting "home" to "home."). Leave the final clause unpunctuated if the transcript cuts off mid-thought — don't guess where an unfinished sentence will end.
- Add a comma only at an unambiguous clause break (an introductory phrase, a list, a conjunction joining two full clauses) — when in doubt, leave it out.
Worked example — the input "call grandma tomorrow then buy milk i also need eggs" is two run-on sentences with no structure at all; the correct output has THREE corrections: {"index":0,"from":"call","to":"Call"} (nothing precedes it, but confirm it's capitalized), {"index":2,"from":"tomorrow","to":"tomorrow."} (sentence ends here), {"index":4,"from":"then","to":"Then"} (new sentence starts here) — and likewise "i" -> "I" later on. Apply this same reasoning across the ENTIRE transcript, not just this example.
Route each suspect word to EXACTLY ONE of three actions:
1. CORRECT — an OBVIOUS error with a single unambiguous fix: a clear misspelling/typo ("tomorow"->"tomorrow") or a clear grammatical slip ("she dont"->"she doesn't"). Put these in "corrections".
2. FLAG — a real, correctly-spelled word that is likely MISHEARD or wrong in context, where the intended word is a judgement call ("peer" vs "pier", "bored" vs "board"). Put these in "flagged" with low confidence + suggestions. Do NOT auto-correct these.
3. DELETE — a STRAY word (or WHOLE STRAY CLAUSE) the speech recogniser invented next to the thing it garbled, so the transcript reads correctly only once it is removed: a false start ("I went to the stork store" -> drop "stork"), a phonetic near-duplicate ("I am reeling reading a book" -> drop "reeling"), a partial word ("the caf- cafe" -> drop "caf-"), a restart across a repeated filler ("I saw a log a dog" -> drop "log": the speaker misheard-then-corrected with a different word right after, the article repeats around the seam), an accidental stutter ("I need to to go" -> drop one "to"), OR a WHOLE-CLAUSE restart: the speaker says an entire phrase, then immediately re-says nearly the same phrase again with one word changed — this is the SAME pattern as the single-word cases above, just longer. Put an entry for EVERY word of the first (wrong) attempt: "And yeah, I was a very nice time it was a very nice time" -> "deletions" gets SIX entries (indices for "I", "was", "a", "very", "nice", "time" — the first occurrence only), leaving "And yeah, it was a very nice time."; do NOT put half the clause in "deletions" and treat the rest as clean — either the whole first attempt goes, or none of it does.
   DELETE IS DESTRUCTIVE — only use it when the neighbouring word is clearly the intended one and the stray word contributes NOTHING. When in doubt, FLAG instead.
   NEVER delete a deliberate repetition or a word that carries meaning: "it was very very cold" (emphasis), "I had had enough" (grammar), "New York, New York" (a real name), "it is what it is" — all of these must be left completely alone.
   NEVER modify, delete, or alter speaker turn labels like "Speaker 1:", "Speaker 2:", "[Meeting]", "You:", or names followed by a colon. Leave all speaker prefixes and numbers completely untouched.
If the speaker already corrected themselves in-line ("write, actually written-down"), leave both words alone.
Return ONLY JSON:
{ "corrections": [ { "index": <int>, "from": "<as transcribed>", "to": "<corrected>" } ],
  "flagged":     [ { "index": <int>, "word": "<as transcribed>", "confidence": <0..1 how likely CORRECT>, "suggestions": ["<intended>", ...] } ],
  "deletions":   [ { "index": <int>, "word": "<as transcribed>" } ] }
Return empty "flagged"/"deletions" if there's nothing suspect — but "corrections" still needs every capitalization and end-of-sentence fix from above; that's never empty unless the transcript already has them. Never rewrite a correctly-spelled, already-punctuated word for any other reason.
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
  const deleteIdx: number[] = [];
  // Both the model proposing a delete AND the model proposing a blank-`to` correction end up here —
  // in practice it does both interchangeably despite the schema, and a real deletion shouldn't slip
  // through just because it arrived in the "wrong" array. Either way, it's only a CANDIDATE: the guard
  // below still has to agree the span looks like an artifact, not just take the model's word for it.
  const proposeDelete = (i: number) => {
    if (i >= 0 && tokens[i] && !deleteIdx.includes(i) && !corrections.some(c => c.index === i)) deleteIdx.push(i);
  };

  for (const c of parsed.corrections || []) {
    // Same index-then-text-match fallback as the flag path (guards model index drift).
    let i = c.index;
    if (!(tokens[i] && looseEq(tokens[i].text, c.from))) i = tokens.findIndex(t => looseEq(t.text, c.from));
    if (i < 0 || !tokens[i]) continue;
    if (c.to) corrections.push({ index: i, from: tokens[i].text, to: String(c.to) });
    else proposeDelete(i);
  }
  for (const d of parsed.deletions || []) {
    let i = d.index;
    if (!(tokens[i] && looseEq(tokens[i].text, d.word))) i = tokens.findIndex(t => looseEq(t.text, d.word));
    proposeDelete(i);   // already being rewritten by a real correction -> proposeDelete no-ops (see guard above)
  }
  deleteIdx.sort((a, b) => a - b);

  // Group into maximal runs of consecutive indices — a whole-clause restart ("I was a very nice time
  // it was a very nice time" -> drop the first six words) needs checking as ONE span, since the
  // per-word neighbour check below can't see a match that's several tokens away.
  const runs: number[][] = [];
  for (const i of deleteIdx) {
    const last = runs[runs.length - 1];
    if (last && last[last.length - 1] === i - 1) last.push(i);
    else runs.push([i]);
  }

  for (const run of runs) {
    if (run.length >= 2) {
      const span = run.map(i => tokens[i].text);
      const next = tokens.slice(run[run.length - 1] + 1, run[run.length - 1] + 1 + run.length).map(t => t.text);
      if (isPhraseRestart(span, next)) {
        for (const i of run) corrections.push({ index: i, from: tokens[i].text, to: "" });
        continue;
      }
    }
    // Not a confirmed phrase restart (or just one word) — fall back to the single-word artifact guard
    // per token, same as a lone deletion proposal.
    for (const i of run) {
      const word = tokens[i].text;
      const before = tokens[i - 1]?.text;
      const after = tokens[i + 1]?.text;
      // A short filler ("a", "an", "the"...) doesn't block the artifact check, but which side it's on
      // matters: "a log a dog" needs "log" compared against "dog" one hop further out, AND the filler
      // leading into "log" deleted too — the one leading into "dog" is real and must survive, or the
      // result reads "a a dog" instead of "a dog".
      let extra = -1;
      let match = isDisfluency(word, [before, after].filter(Boolean) as string[]);
      if (!match && isFiller(after) && isDisfluency(word, [tokens[i + 2]?.text].filter(Boolean) as string[])) {
        match = true;
        if (isFiller(before)) extra = i - 1;
      } else if (!match && isFiller(before) && isDisfluency(word, [tokens[i - 2]?.text].filter(Boolean) as string[])) {
        match = true;
        if (isFiller(after)) extra = i + 1;
      }
      if (!match) continue;
      corrections.push({ index: i, from: word, to: "" });
      if (extra >= 0 && !corrections.some(c => c.index === extra)) {
        corrections.push({ index: extra, from: tokens[extra].text, to: "" });
      }
    }
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

// A whole-clause restart: the model proposes deleting several ADJACENT words at once (a full failed
// attempt), immediately followed by a same-length span that's nearly identical. Most words matching
// EXACTLY is much stronger evidence than any single word's own edge-similarity, so unlike the
// single-word guard below, the substituted word itself isn't required to look like the others — the
// surrounding repetition is the signal. Requires at least one real difference: an exact-duplicate
// span is a deliberate repeat ("no no no"), not a restart, and stays the prompt's call to leave alone.
function isPhraseRestart(span: string[], next: string[]): boolean {
  if (span.length < 2 || span.length !== next.length) return false;
  let mismatches = 0;
  for (let k = 0; k < span.length; k++) if (!looseEq(span[k], next[k])) mismatches++;
  return mismatches > 0 && mismatches <= Math.max(1, Math.floor(span.length / 3));
}

// Deleting a word is destructive and irreversible from the user's side, so a RULE — not the model —
// decides what may be deleted at all: a token only qualifies as a transcription artifact when a
// neighbour looks like the word it garbled ("stork store", "reeling reading", "to to").
//
// This bounds the blast radius to "adjacent to something similar"; it is deliberately NOT sufficient
// on its own. An intentional repeat ("very very cold") passes this guard by design — rejecting THAT
// is the prompt's job. Guard limits the damage, prompt handles the intent; both are load-bearing.
// ASR garbles either edge of a word and leaves the other intact — "stork"/"store" keep their front
// ("sto"), "log"/"dog" keep their back ("og"). A prefix-only check misses the second kind entirely,
// so this shares if EITHER edge lines up for >=2 chars.
const sharesEdge = (a: string, b: string): boolean => {
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  return p >= 2;
};
const reverse = (s: string): string => [...s].reverse().join("");

// A short filler word doesn't break adjacency when checking whether a token is a self-correction
// artifact (see the neighbour-widening above in parseProofread).
const isFiller = (w?: string): boolean => !!w && /^(a|an|the|um|uh)$/i.test(w.replace(/\W/g, ""));

export function isDisfluency(word: string, neighbours: string[]): boolean {
  const a = word.replace(/\W/g, "").toLowerCase();
  if (!a) return false;
  return neighbours.some(raw => {
    const b = raw.replace(/\W/g, "").toLowerCase();
    if (!b) return false;
    if (a === b) return true;                                     // exact accidental repeat
    if (!sharesEdge(a, b) && !sharesEdge(reverse(a), reverse(b))) return false;  // must share a real edge
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

    // The model gets told to restore grammar (raw speech has none) — pin the instruction so a future
    // edit can't silently drop it.
    assert.match(PROOFREAD_CORRECT_INSTRUCTION, /[Cc]apitalize/);
    assert.match(PROOFREAD_CORRECT_INSTRUCTION, /period or question mark/);

    // Capitalization and terminal punctuation are just token rewrites — same "corrections" path as a
    // typo fix, no separate mechanism needed. Pin the contract: two sentences in, both fixed.
    const grammar = proofread("today i went home he said hi", {
      corrections: [
        { index: 0, from: "today", to: "Today" },
        { index: 1, from: "i", to: "I" },
        { index: 3, from: "home", to: "home." },
        { index: 4, from: "he", to: "He" },
      ],
    });
    const grammarApplied = applyCorrections("today i went home he said hi", buildProofreadPrompt("today i went home he said hi").words, grammar.corrections);
    assert.equal(grammarApplied.text, "Today I went home. He said hi", "capitalization + sentence-final punctuation applied");

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
    assert.equal(isDisfluency("log", ["dog"]), true, "back-anchored near-duplicate (front garbled, not just front-anchored ones)");
    assert.equal(isDisfluency("cat", ["dog"]), false, "no shared edge -> still refused");

    // "a log a dog": the repeated filler "a" sits between the misheard word and its correction, so
    // the correction is 2 tokens away, not an immediate neighbour — the widened window must still find
    // it, AND the "a" leading into the WRONG word ("log") must go too, not the one leading into "dog".
    const filler = proofread("Today in the park I saw a log a dog", { corrections: [], flagged: [], deletions: [{ index: 7, word: "log" }] });
    assert.deepEqual(
      [...filler.corrections].sort((x, y) => x.index - y.index),
      [{ index: 6, from: "a", to: "" }, { index: 7, from: "log", to: "" }],
      "both the wrong word and its own leading filler are deleted, not the one before the correction",
    );
    const fillerText = "Today in the park I saw a log a dog";
    const applied = applyCorrections(fillerText, buildProofreadPrompt(fillerText).words, filler.corrections);
    assert.equal(applied.text, "Today in the park I saw a dog", "the correction replaces \"a log\", not just \"log\"");

    // --- whole-clause restart: a full failed attempt immediately re-said with one word changed ---
    assert.equal(isPhraseRestart(["I", "was", "a", "very", "nice", "time"], ["it", "was", "a", "very", "nice", "time"]), true, "one substitution in six words");
    assert.equal(isPhraseRestart(["a", "b"], ["a", "b"]), false, "identical span is a deliberate repeat, not a restart");
    assert.equal(isPhraseRestart(["the", "cat"], ["a", "dog"]), false, "two unrelated words, both differ -> refused");
    assert.equal(isPhraseRestart(["a"], ["b"]), false, "single word isn't a clause");

    const clauseText = "And yeah, I was a very nice time it was a very nice time";
    const clauseTokens = buildProofreadPrompt(clauseText).tokens;
    const clause = proofread(clauseText, {
      corrections: [], flagged: [],
      deletions: [2, 3, 4, 5, 6, 7].map(index => ({ index, word: clauseTokens[index].text })),
    });
    assert.deepEqual(
      [...clause.corrections].sort((x, y) => x.index - y.index).map(c => c.index),
      [2, 3, 4, 5, 6, 7],
      "the whole first attempt is deleted as one unit, not word-by-word against immediate neighbours",
    );
    const clauseApplied = applyCorrections(clauseText, buildProofreadPrompt(clauseText).words, clause.corrections);
    assert.equal(clauseApplied.text, "And yeah, it was a very nice time", "the corrected retelling survives, the failed attempt doesn't");

    // Observed live: the model sometimes sends the SAME six-word restart as blank-`to` "corrections"
    // instead of "deletions" — must resolve identically, not silently vanish via the truthiness guard.
    const clauseViaCorrections = proofread(clauseText, {
      corrections: [2, 3, 4, 5, 6, 7].map(index => ({ index, from: clauseTokens[index].text, to: "" })),
      flagged: [],
    });
    assert.deepEqual(
      [...clauseViaCorrections.corrections].sort((x, y) => x.index - y.index).map(c => c.index),
      [2, 3, 4, 5, 6, 7],
      "phrase restart still recognized when expressed as blank-`to` corrections instead of deletions",
    );

    // deletions fold into corrections as an empty `to`
    const deleted = proofread("I went to the stork store", { corrections: [], flagged: [], deletions: [{ index: 4, word: "stork" }] });
    assert.deepEqual(deleted.corrections, [{ index: 4, from: "stork", to: "" }]);

    // the guard overrides the model: deleting an unrelated word is refused
    const refused = proofread("I went to the elephant store", { corrections: [], flagged: [], deletions: [{ index: 4, word: "elephant" }] });
    assert.deepEqual(refused.corrections, [], "guard refuses to delete a real word");

    // a blank `to` on a CORRECTION is a delete proposal too (the model uses both forms interchangeably
    // in practice) — same guard as the "deletions" array, so it's accepted here (matches its neighbour)...
    const blankMatch = proofread("I went to the stork store", { corrections: [{ index: 4, from: "stork", to: "" }], flagged: [] });
    assert.deepEqual(blankMatch.corrections, [{ index: 4, from: "stork", to: "" }], "blank-`to` correction treated as a delete proposal, guard approves it");

    // ...but still refused when the guard doesn't agree, exactly like a "deletions" entry would be.
    const blankRefused = proofread("I went to the elephant store", { corrections: [{ index: 4, from: "elephant", to: "" }], flagged: [] });
    assert.deepEqual(blankRefused.corrections, [], "blank-`to` correction for an unrelated word is still refused");

    // same token both corrected and deleted -> the correction wins, one edit only
    const clash = proofread("I went to the stork store", {
      corrections: [{ index: 4, from: "stork", to: "stock" }], flagged: [],
      deletions: [{ index: 4, word: "stork" }],
    });
    assert.deepEqual(clash.corrections, [{ index: 4, from: "stork", to: "stock" }], "no double edit on one token");

    console.log("transcriber self-check ✓");
  })();
}
