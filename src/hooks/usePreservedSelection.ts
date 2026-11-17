import { useLayoutEffect, useRef, useCallback, type RefObject } from "react";
import { planSelectionRestore } from "../utils/selection";

/**
 * Keeps a controlled textarea's caret/selection stable when something other than the user
 * rewrites its value (speech appends, tab chunks, proofread splices). Watches the value, not
 * the writers, so every writer is covered. The textarea's onChange must call the returned
 * markLocalEdit() so the user's own typing is left alone.
 * ponytail: a DOM rescue for a data-model problem (one flat transcript string, no ownership).
 * Delete it, don't port it, once the transcript is tagged segments.
 */
export function usePreservedSelection(
  ref: RefObject<HTMLTextAreaElement | null>,
  value: string,
  opts?: { skip?: () => boolean }
): () => void {
  const prevRef = useRef(value);
  const localRef = useRef(false);
  const preRef = useRef<{ start: number; end: number } | null>(null);
  const skip = opts?.skip;

  const markLocalEdit = useCallback(() => { localRef.current = true; }, []);

  // RENDER PHASE capture — this is the whole trick, and it cannot move into the effect below.
  // Assigning a new `value` to a textarea collapses its caret to the end of the text, so by
  // the time a layout effect runs the user's real position is already destroyed; reading it
  // there returns the end and "restoring" it is a no-op that looks exactly like the bug.
  // During render the DOM still holds the PREVIOUS value, so the caret here is the true one.
  if (value !== prevRef.current) {
    const el = ref.current;
    preRef.current =
      el && !el.disabled && document.activeElement === el
        ? { start: el.selectionStart ?? 0, end: el.selectionEnd ?? 0 }
        : null;
  }

  useLayoutEffect(() => {
    const prev = prevRef.current;
    prevRef.current = value; // advance on EVERY path — a missed update poisons the next diff
    const wasLocal = localRef.current;
    localRef.current = false;
    const pre = preRef.current;
    preRef.current = null;

    // The decision itself lives in planSelectionRestore so it can be self-checked without a
    // DOM (see src/utils/selection.ts). Note it never focuses anything: a background speech
    // append must not steal focus from wherever the user actually is.
    const plan = planSelectionRestore({ prev, next: value, pre, local: wasLocal, skip: skip?.() ?? false });
    if (plan) ref.current?.setSelectionRange(plan.start, plan.end);
  }, [value, ref, skip]);

  return markLocalEdit;
}
