// Provenance helpers shared by the UI. Pure + browser-safe (no node imports).

// Below this, a transcribed word is flagged as a likely mishearing rather than trusted outright.
// The one place this is defined — AudioRecorder and the eval grader import it rather than each
// carrying their own copy, so retuning it can't silently drift out of sync between them.
export const CONFIDENCE_THRESHOLD = 0.7;

// Auto-apply the router's obvious corrections to `base`, returning the corrected text and the
// surviving FLAG words (confidence < CONFIDENCE_THRESHOLD) with offsets shifted to match. Corrected
// words drop out of the flag list. Edits use each word's char span; trailing/leading punctuation the
// tokenizer glued on ("tomorow." -> "tomorrow.") is preserved. Offset-safe via a running left-to-right shift.
interface Span { text: string; start: number; end: number; confidence: number; alternatives?: string[]; }
export function applyCorrections(
  base: string,
  words: Span[],
  corrections: { index: number; from: string; to: string }[],
  confidenceThreshold = CONFIDENCE_THRESHOLD,
): { text: string; words: Span[] } {
  const looseEq = (a: string, b: string) => a.replace(/\W/g, "").toLowerCase() === b.replace(/\W/g, "").toLowerCase();
  const edits = corrections
    .map(c => ({ c, w: words[c.index] }))
    .filter(e => e.w && looseEq(e.w.text, e.c.from))   // guard stale index / word mismatch
    .sort((a, b) => a.w.start - b.w.start);

  let text = base;
  let shift = 0;
  const deltas: { at: number; delta: number }[] = [];
  const corrected = new Set<number>();
  for (const { c, w } of edits) {
    const lead = w.text.match(/^[^0-9A-Za-z]+/)?.[0] ?? "";
    const trail = w.text.match(/[^0-9A-Za-z]+$/)?.[0] ?? "";
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
    const delta = replacement.length - (to - from);
    deltas.push({ at: w.end, delta });
    shift += delta;
    corrected.add(c.index);
  }

  const flags = words
    .map((w, i) => ({ w, i }))
    .filter(({ w, i }) => !corrected.has(i) && w.confidence < confidenceThreshold)
    .map(({ w }) => {
      const d = deltas.filter(e => e.at <= w.start).reduce((n, e) => n + e.delta, 0);
      return { ...w, start: w.start + d, end: w.end + d };
    });

  return { text, words: flags };
}

/**
 * Every transcript producer (mic speech, tab audio, and the extra Cloud-STT paths on the
 * diarization branches) appends with `prev.trim()`. The trailing half is harmless — a space is
 * re-added immediately — but the LEADING half silently deletes whitespace the producer doesn't
 * own: put a blank line at the top of your notes and the next recognized phrase eats it,
 * shifting every offset in the document out from under an active cursor.
 *
 * Rather than patch each producer (they live in the most-rewritten block of AudioRecorder, and
 * there are three of them on some branches), restore the head after the fact. The rule is
 * append-only: a producer derives new text from old, so whatever the old text STARTED with is
 * not its to remove.
 */
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

  // applyCorrections: two edits, trailing period preserved, no leftover flags
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
  eq(r1.words, [], "no flags remain");

  // applyCorrections: a flag AFTER a length-changing correction gets its offset shifted
  const w2 = [
    { text: "bye", start: 0, end: 3, confidence: 1 },
    { text: "pier", start: 4, end: 8, confidence: 0.4, alternatives: ["peer"] },
  ];
  const r2 = applyCorrections("bye pier", w2, [{ index: 0, from: "bye", to: "goodbye" }]);
  eq(r2.text, "goodbye pier", "correction lengthened text");
  eq(r2.words, [{ text: "pier", start: 8, end: 12, confidence: 0.4, alternatives: ["peer"] }], "flag offset shifted +4");

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

  // a flag AFTER a deletion shifts LEFT by the removed length
  const b6 = "the stork store pier";
  const w6 = del(b6); w6[3].confidence = 0.4;
  const r6 = applyCorrections(b6, w6, [{ index: 1, from: "stork", to: "" }]);
  eq(r6.text, "the store pier", "deletion mid-string");
  eq(r6.words, [{ text: "pier", start: 10, end: 14, confidence: 0.4 }], "flag offset shifted -6");
  eq(r6.text.slice(10, 14), "pier", "shifted flag span still lands on the word");

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
