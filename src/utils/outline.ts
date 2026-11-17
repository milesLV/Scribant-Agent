// Parses the markdown subset the Bullet Point Summary is allowed to emit: two levels of bullets,
// ordered or unordered, with **bold** and *italic* inline. Deliberately not a markdown library —
// the accepted grammar is four constructs, and the text arrives mid-stream, so the parser's real
// job is being unfazed by a half-written line rather than being complete.

export type Inline = { text: string; bold?: boolean; italic?: boolean };
export type OutlineItem = { parts: Inline[]; ordered: boolean; children: OutlineItem[] };

// A marker is the bullet or number that opens a line. Which one was used decides whether the list
// renders as <ul> or <ol>, so it is read per line rather than assumed for the whole block.
const MARKER = /^([-*•+]|\d+[.)])\s+/;

// Bold before italic: `**x**` also matches the italic alternative, so the longer one has to win.
// Underscore is accepted for italic on input (models emit it) even though we never ask for it.
const INLINE = /(\*\*[^*]+\*\*|\*[^*]+\*|_[^_]+_)/g;

export function parseInline(text: string): Inline[] {
  const parts: Inline[] = [];
  for (const chunk of text.split(INLINE)) {
    if (!chunk) continue;
    if (chunk.startsWith("**") && chunk.endsWith("**") && chunk.length > 4) {
      parts.push({ text: chunk.slice(2, -2), bold: true });
    } else if (/^(\*[^*]+\*|_[^_]+_)$/.test(chunk)) {
      parts.push({ text: chunk.slice(1, -1), italic: true });
    } else {
      // Leftover markers belong to an emphasis span the model hasn't finished writing. Drop them
      // rather than showing raw asterisks for the second or two before the closing pair lands.
      const plain = chunk.replace(/[*_]/g, "");
      if (plain) parts.push({ text: plain });
    }
  }
  return parts;
}

export function parseOutline(text: string): OutlineItem[] {
  const roots: OutlineItem[] = [];

  for (const raw of text.split("\n")) {
    if (!raw.trim()) continue;

    // Tabs count as two columns so a tab-indented sub-point nests like a space-indented one.
    const indent = (raw.match(/^[ \t]*/)?.[0] ?? "").replace(/\t/g, "  ").length;
    const marker = raw.trim().match(MARKER);
    const body = raw.trim().replace(MARKER, "").trim();
    if (!body) continue;

    const item: OutlineItem = {
      parts: parseInline(body),
      ordered: /\d/.test(marker?.[1] ?? ""),
      children: [],
    };

    // Two levels, hard. A third indent folds into the second rather than disappearing, and an
    // indented line with nothing above it becomes a root — losing content to stray whitespace
    // would be worse than losing one level of structure.
    const parent = indent >= 2 ? roots[roots.length - 1] : undefined;
    (parent ? parent.children : roots).push(item);
  }

  return roots;
}

// Self-check. Run: tsx src/utils/outline.ts
if (typeof process !== "undefined" && process.argv[1]?.endsWith("outline.ts")) {
  // Hand-rolled rather than node:assert: this module ships to the browser, so importing a node
  // builtin here would put a top-level await in the client bundle. Same shape as selection.ts.
  const eq = (got: unknown, want: unknown, label = "") => {
    const g = JSON.stringify(got), w = JSON.stringify(want);
    if (g !== w) throw new Error(`${label}: got ${g}, want ${w}`);
  };
  const texts = (items: OutlineItem[]): string[] => items.map(i => i.parts.map(p => p.text).join(""));

  // Flat input renders exactly as it always did — the regression that matters most, since every
  // summary written before this parser existed is flat.
  const flat = parseOutline("- one\n- two\n- three");
  eq(texts(flat), ["one", "two", "three"]);
  eq(flat.every(i => i.children.length === 0 && !i.ordered), true);

  // One level of nesting, attached to the point above it.
  const nested = parseOutline("- claim\n  - because A\n  - because B\n- next claim");
  eq(texts(nested), ["claim", "next claim"]);
  eq(texts(nested[0].children), ["because A", "because B"]);

  // A numbered sub-list under a bulleted parent: ordered is read per line, not per block.
  const mixed = parseOutline("- rollout order\n  1. freeze\n  2. migrate");
  eq(mixed[0].ordered, false);
  eq(mixed[0].children.map(c => c.ordered), [true, true]);
  eq(texts(mixed[0].children), ["freeze", "migrate"]);

  // Emphasis, including both marks in one line and an unclosed span mid-stream.
  eq(parseInline("cut over **Friday**"), [{ text: "cut over " }, { text: "Friday", bold: true }]);
  eq(parseInline("*maybe* ship **Q4** soon"),
    [{ text: "maybe", italic: true }, { text: " ship " }, { text: "Q4", bold: true }, { text: " soon" }]);
  eq(parseInline("_hedged_"), [{ text: "hedged", italic: true }]);
  eq(parseInline("half written **Fri"), [{ text: "half written Fri" }], "unclosed bold shows no asterisks");

  // Depth 3 clamps to depth 2 instead of vanishing.
  const deep = parseOutline("- a\n  - b\n      - c");
  eq(texts(deep[0].children), ["b", "c"]);

  // An indented first line has no parent to attach to, so it is promoted rather than dropped.
  eq(texts(parseOutline("  - orphan\n- root")), ["orphan", "root"]);

  // Marker-less and blank lines: content still survives, empty lines are skipped.
  eq(texts(parseOutline("no marker here\n\n- and a bullet")), ["no marker here", "and a bullet"]);

  console.log("outline self-check ✓");
}
