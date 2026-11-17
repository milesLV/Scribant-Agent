// Provenance helpers shared by the UI. Pure + browser-safe (no node imports).

// Below this a proofread word counts as flagged (a likely mishearing). Used by the eval grader.
export const CONFIDENCE_THRESHOLD = 0.7;

// Apply the proofreader's corrections to `base` by each word's char span, left to right with a
// running shift. Punctuation the tokenizer glued on ("tomorow." -> "tomorrow.") is preserved.
interface Span { text: string; start: number; end: number; confidence?: number; alternatives?: string[]; }
export function applyCorrections(
  base: string,
  words: Span[],
  corrections: { index: number; from: string; to: string }[],
): { text: string } {
  const looseEq = (a: string, b: string) => a.replace(/\W/g, "").toLowerCase() === b.replace(/\W/g, "").toLowerCase();
  const edits = corrections
    .map(c => ({ c, w: words[c.index] }))
    .filter(e => e.w && looseEq(e.w.text, e.c.from))   // guard stale index / word mismatch
    .sort((a, b) => a.w.start - b.w.start);

  let text = base;
  let shift = 0;
  for (const { c, w } of edits) {
    // Keep the token's own punctuation only when the fix doesn't bring its own: "2:00," -> "2:00."
    // swaps the comma for a period, it doesn't stack them into "2:00.,".
    const lead = /^[^0-9A-Za-z]/.test(c.to) ? "" : w.text.match(/^[^0-9A-Za-z]+/)?.[0] ?? "";
    const trail = /[^0-9A-Za-z]$/.test(c.to) ? "" : w.text.match(/[^0-9A-Za-z]+$/)?.[0] ?? "";
    // Removal range in ORIGINAL coordinates; `shift` maps it onto the text edited so far.
    let from = w.start, to = w.end, replacement = lead + c.to + trail;
    if (c.to === "") {
      // A deletion drops the word AND one adjacent space, else "the stork store" leaves "the  store".
      // Punctuation-bearing tokens are never deleted: removing "stork." from "I saw the stork." would
      // take the period with it and leave "I saw the".
      if (lead || trail) continue;
      if (base[from - 1] === " ") from -= 1;
      else if (base[to] === " ") to += 1;
      replacement = "";
    }
    text = text.slice(0, from + shift) + replacement + text.slice(to + shift);
    shift += replacement.length - (to - from);
  }
  return { text };
}

// Producers append via `prev.trim()`, which also eats LEADING whitespace they don't own (a blank
// line at the top of the notes), shifting every offset under the cursor. Restore the head after the
// fact: append-only means whatever the old text started with is not the producer's to remove.
export function preserveHead(prev: string, next: string): string {
  const lead = prev.slice(0, prev.length - prev.trimStart().length);
  return lead && !next.startsWith(lead) ? lead + next : next;
}

// ponytail: self-check pins the correction-splicing offsets and the append-only head rule.
// Run: tsx src/utils/transcript.ts
if (typeof process !== "undefined" && process.argv[1]?.endsWith("transcript.ts")) {
  const eq = (a: unknown, b: unknown, m: string) => {
    if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
  };

  // applyCorrections: two edits, trailing period preserved
  const w1 = [
    { text: "I", start: 0, end: 1, confidence: 1 },
    { text: "need", start: 2, end: 6, confidence: 1 },
    { text: "to", start: 7, end: 9, confidence: 1 },
    { text: "bye", start: 10, end: 13, confidence: 1 },
    { text: "milk", start: 14, end: 18, confidence: 1 },
    { text: "tomorow.", start: 19, end: 27, confidence: 1 },
  ];
  const r1 = applyCorrections("I need to bye milk tomorow.", w1, [
    { index: 3, from: "bye", to: "buy" },
    { index: 5, from: "tomorow.", to: "tomorrow" },
  ]);
  eq(r1.text, "I need to buy milk tomorrow.", "corrections applied, period kept");

  // --- deletions (to: "") drop a disfluency token and exactly one adjacent space ---
  const del = (base: string) => {
    const w: Span[] = [];
    const re = /\S+/g; let m: RegExpExecArray | null;
    while ((m = re.exec(base))) w.push({ text: m[0], start: m.index, end: m.index + m[0].length, confidence: 1 });
    return w;
  };

  // mid-sentence: the LEADING space goes with the word, so no double space is left behind
  const b3 = "I went to the stork store.";
  eq(applyCorrections(b3, del(b3), [{ index: 4, from: "stork", to: "" }]).text,
    "I went to the store.", "deletes token + leading space");

  // first token has no leading space -> the TRAILING one is consumed instead
  const b4 = "stork store";
  eq(applyCorrections(b4, del(b4), [{ index: 0, from: "stork", to: "" }]).text,
    "store", "deletes leading token + trailing space");

  // punctuation-bearing token is never deleted (would strip the period too)
  const b5 = "I saw the stork.";
  eq(applyCorrections(b5, del(b5), [{ index: 3, from: "stork.", to: "" }]).text,
    b5, "refuses to delete a token carrying punctuation");

  // the running shift: an edit AFTER a deletion still lands on its word
  const b6 = "the stork store pier";
  eq(applyCorrections(b6, del(b6), [{ index: 1, from: "stork", to: "" }, { index: 3, from: "pier", to: "peer" }]).text,
    "the store peer", "second edit lands after the first shrank the text");

  // a fix that carries its own punctuation replaces the token's, never stacks on it
  const b7 = "at 2:00, also this month,";
  eq(applyCorrections(b7, del(b7), [
    { index: 1, from: "2:00,", to: "2:00." }, { index: 2, from: "also", to: "Also" }, { index: 4, from: "month,", to: "month." },
  ]).text, "at 2:00. Also this month.", "punctuation swapped, not doubled");

  // --- preserveHead: producers may extend the tail, never eat the head -------------------
  // The real shape: a producer runs prev.trim() then appends. Only the leading loss is undone.
  const produce = (prev: string, phrase: string) => {
    const cleaned = prev.trim();
    return cleaned ? cleaned + " " + phrase + " " : phrase + " ";
  };
  eq(preserveHead("\n\nmy notes ", produce("\n\nmy notes ", "and more")),
    "\n\nmy notes and more ", "leading blank line survives a speech append");
  eq(preserveHead("  indented ", produce("  indented ", "text")),
    "  indented text ", "leading spaces survive");
  eq(preserveHead("plain ", produce("plain ", "more")), "plain more ", "no leading space: untouched");
  eq(preserveHead("", produce("", "first words")), "first words ", "empty transcript: untouched");
  // Trailing whitespace is still the producer's to normalize — only the head is protected.
  eq(preserveHead("tail   ", "tail more "), "tail more ", "trailing trim is left alone");
  // Idempotent: re-running on already-correct output must not double the head.
  eq(preserveHead("\n\nx ", "\n\nx y "), "\n\nx y ", "already preserved: no double prefix");

  console.log("transcript self-check ✓");
}
