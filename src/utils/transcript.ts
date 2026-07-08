// Provenance helpers shared by the UI and reconciliation. Pure + browser-safe (no node imports).

// Auto-apply the router's obvious corrections to `base`, returning the corrected text and the
// surviving FLAG words (confidence < 0.7) with offsets shifted to match. Corrected words drop out
// of the flag list. Edits use each word's char span; trailing/leading punctuation the tokenizer
// glued on ("tomorow." -> "tomorrow.") is preserved. Offset-safe via a running left-to-right shift.
interface Span { text: string; start: number; end: number; confidence: number; alternatives?: string[]; }
export function applyCorrections(
  base: string,
  words: Span[],
  corrections: { index: number; from: string; to: string }[],
  strangeThreshold = 0.7,
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
    const replacement = lead + c.to + trail;
    const start = w.start + shift, end = w.end + shift;
    text = text.slice(0, start) + replacement + text.slice(end);
    const delta = replacement.length - (w.end - w.start);
    deltas.push({ at: w.end, delta });
    shift += delta;
    corrected.add(c.index);
  }

  const flags = words
    .map((w, i) => ({ w, i }))
    .filter(({ w, i }) => !corrected.has(i) && w.confidence < strangeThreshold)
    .map(({ w }) => {
      const d = deltas.filter(e => e.at <= w.start).reduce((n, e) => n + e.delta, 0);
      return { ...w, start: w.start + d, end: w.end + d };
    });

  return { text, words: flags };
}

// Stable id so the same trigger phrase maps to the same item across re-analyses (lets reconciliation
// switch to a hash only if items ever clash.
export function itemId(prefix: string, ...keys: (string | undefined)[]): string {
  const key = keys.find(k => k && k.trim()) || "x";
  const slug = key.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return `${prefix}-${slug}`;
}

if (typeof process !== "undefined" && process.argv[1]?.endsWith("transcript.ts")) {
  const eq = (a: unknown, b: unknown, m: string) => {
    if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
  };
  eq(itemId("cal", undefined, "Paint Room!"), "cal-paint-room", "id slug + fallback");

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

  console.log("transcript self-check ✓");
}
