/**
 * Remap a caret/selection offset across an EXTERNAL rewrite of a text value — speech
 * appends, tab-audio appends, proofread splices — so the user's cursor keeps pointing at
 * the same character it pointed at before.
 *
 * Diffs by common prefix/suffix, which is sufficient because every writer in this app
 * performs exactly one contiguous edit (an append at the end, or a splice in the head).
 */
export function remapOffset(prev: string, next: string, offset: number): number {
  if (prev === next) return offset;

  const maxCommon = Math.min(prev.length, next.length);
  let p = 0;
  while (p < maxCommon && prev.charCodeAt(p) === next.charCodeAt(p)) p++;
  let s = 0;
  while (
    s < maxCommon - p &&
    prev.charCodeAt(prev.length - 1 - s) === next.charCodeAt(next.length - 1 - s)
  ) s++;

  const prevEnd = prev.length - s; // exclusive end of the changed region in prev
  const nextEnd = next.length - s; // ...and in next
  const delta = next.length - prev.length;

  // Change landed entirely AFTER the caret — including the plain append case, where the
  // caret sits at prev.length and stays anchored while new speech lands behind it.
  if (offset <= p) return offset;
  // Change landed entirely BEFORE the caret — shift by the length delta so the caret
  // stays on the same word.
  if (offset >= prevEnd) return offset + delta;
  // Caret was inside the rewritten span — clamp to the end of the replacement.
  return Math.max(p, Math.min(offset, nextEnd));
}

/** Where to put the selection after one change to the textarea's value; null = leave it alone. */
export type SelectionPlan = { start: number; end: number } | null;

/**
 * usePreservedSelection's decision as a pure, DOM-free function. `pre` is the selection captured
 * before the new value reached the DOM (null = nothing to preserve). `local` wins over everything:
 * the browser already placed a keystroke's caret correctly, and a remap would fight it.
 */
export function planSelectionRestore(input: {
  prev: string;
  next: string;
  pre: { start: number; end: number } | null;
  local: boolean;
  skip: boolean;
}): SelectionPlan {
  if (input.prev === input.next || input.local || input.skip || !input.pre) return null;
  const start = remapOffset(input.prev, input.next, input.pre.start);
  // A collapsed caret is the overwhelmingly common case — don't scan the string twice for it.
  const end = input.pre.start === input.pre.end ? start : remapOffset(input.prev, input.next, input.pre.end);
  return { start, end };
}

// ponytail: self-check pins the offset math and the full restore decision table, DOM-free.
// The DOM half of this feature (caret-from-click, scroll restore) is deliberately left
// uncovered — it needs a browser harness to say anything. Run: tsx src/utils/selection.ts
if (typeof process !== "undefined" && process.argv[1]?.endsWith("selection.ts")) {
  const eq = (got: unknown, want: unknown, label: string) => {
    const g = JSON.stringify(got), w = JSON.stringify(want);
    if (g !== w) throw new Error(`${label}: got ${g}, want ${w}`);
  };

  // --- append at the end (rec.onresult, tab-audio chunks, uploadMicChunk) -------------
  // Every caret position is at or before the change point, so nothing moves.
  eq(remapOffset("hello", "hello world", 0), 0, "append: caret at start stays");
  eq(remapOffset("hello", "hello world", 3), 3, "append: caret mid-text stays");
  eq(remapOffset("hello", "hello world", 5), 5, "append: caret at old end stays anchored");

  // --- head splice (proofResult effect / correctWord) ---------------------------------
  // A misheard word in the head is replaced; a caret in the tail rides along by the
  // length delta so it stays on the same character it was on.
  {
    const prev = "a stork b tail", next = "a hawk b tail"; // stork -> hawk, delta -1
    eq(remapOffset(prev, next, 9), 8, "head shrank: tail caret shifts by delta");
    eq(prev.slice(0, 9), "a stork b", "caret was just after 'b'...");
    eq(next.slice(0, 8), "a hawk b", "...and still is after the remap");
  }
  {
    const prev = "a hawk b tail", next = "a stork b tail"; // hawk -> stork, delta +1
    eq(remapOffset(prev, next, 8), 9, "head grew: tail caret shifts by delta");
    eq(next.slice(0, 9), "a stork b", "caret still sits just after 'b'");
  }

  // --- caret inside the rewritten span -------------------------------------------------
  eq(remapOffset("a stork b", "a hawk b", 4), 4, "inside span: clamped into the replacement");
  eq(remapOffset("a stork b", "a hawk b", 2), 2, "at the start of the span: kept in place");

  // Prefix/suffix diffing is an approximation: when the old and new words share leading
  // or trailing characters the detected span is narrower than the "real" word edit. That
  // only ever perturbs a caret sitting INSIDE the edited word, never one in the tail,
  // which is the case that matters here.
  eq(remapOffset("the stork store", "the store", 10), 8, "overlapping words: caret clamped, not lost");

  // --- degenerate cases ----------------------------------------------------------------
  eq(remapOffset("same", "same", 2), 2, "no change is a no-op");
  eq(remapOffset("", "hello", 0), 0, "empty -> text keeps caret at 0");
  eq(remapOffset("hello", "", 3), 0, "cleared text clamps caret to 0");

  // --- planSelectionRestore: the hook's full decision table, DOM-free ------------------
  const base = {
    prev: "hello", next: "hello world", pre: { start: 2, end: 2 } as { start: number; end: number } | null,
    local: false, skip: false,
  };
  const plan = (over: Partial<typeof base>) => planSelectionRestore({ ...base, ...over });

  eq(plan({}), { start: 2, end: 2 }, "external append with a captured caret: restores");
  eq(plan({ prev: "same", next: "same" }), null, "no value change: no-op");
  eq(plan({ local: true }), null, "own keystroke: hands off");
  eq(plan({ skip: true }), null, "click-to-edit pending: stands down");
  eq(plan({ pre: null }), null, "unfocused/disabled: never touch");

  // A selection RANGE (not just a caret) is remapped at both ends — the one case where the
  // collapsed-caret shortcut must NOT kick in.
  eq(plan({ prev: "a hawk b tail", next: "a stork b tail", pre: { start: 8, end: 12 } }),
    { start: 9, end: 13 }, "range: both ends shift by delta");

  // The scenario this whole feature exists for: caret parked mid-text, speech appends.
  eq(plan({ prev: "note one", next: "note one and then some more speech", pre: { start: 4, end: 4 } }),
    { start: 4, end: 4 }, "speech append never moves a mid-text caret");

  // Regression: the caret MUST come from `pre` (captured pre-mutation), never from the live
  // element. Reading it post-mutation yields the collapsed end position, which is what made
  // the cursor jump to the end even with this hook installed.
  eq(plan({ prev: "hello world ", next: "hello world coffee beans ", pre: { start: 3, end: 3 } }),
    { start: 3, end: 3 }, "real speech append shape holds a caret at 3");

  console.log("selection self-check ✓");
}
