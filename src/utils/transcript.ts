// Provenance helpers shared by the UI and reconciliation. Pure + browser-safe (no node imports).

// Find where an item's trigger phrase sits in the transcript, so it can be underlined / jumped to.
// Case-insensitive; returns null if the phrase isn't present (e.g. the model paraphrased).
export function locateSpan(transcript: string, sourceText?: string): { start: number; end: number } | null {
  if (!sourceText) return null;
  const needle = sourceText.trim();
  const i = transcript.toLowerCase().indexOf(needle.toLowerCase());
  return i < 0 ? null : { start: i, end: i + needle.length };
}

// Stable id so the same trigger phrase maps to the same item across re-analyses (lets reconciliation
// keep/update instead of duplicating). ponytail: phrase-derived slug; collisions possible at scale,
// switch to a hash only if items ever clash.
export function itemId(prefix: string, ...keys: (string | undefined)[]): string {
  const key = keys.find(k => k && k.trim()) || "x";
  const slug = key.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return `${prefix}-${slug}`;
}

// ponytail self-check: `npx tsx src/utils/transcript.ts`
if (typeof process !== "undefined" && process.argv[1]?.endsWith("transcript.ts")) {
  const eq = (a: unknown, b: unknown, m: string) => {
    if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
  };
  eq(locateSpan("call grandma tomorrow", "grandma"), { start: 5, end: 12 }, "locate hit");
  eq(locateSpan("Grandma waved", "grandma"), { start: 0, end: 7 }, "locate case-insensitive");
  eq(locateSpan("hello world", "absent"), null, "locate miss");
  eq(itemId("cal", undefined, "Paint Room!"), "cal-paint-room", "id slug + fallback");
  console.log("transcript self-check ✓");
}
