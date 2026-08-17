import { useLayoutEffect, useRef, useCallback, type RefObject } from "react";
import { planSelectionRestore } from "../utils/selection";

/**
 * Keeps the caret/selection of a CONTROLLED textarea stable when its value is rewritten by
 * something other than the user — speech appends, tab-audio chunks, proofread splices.
 *
 * Deliberately hooks the STATE, not any one writer: the transcript has three writers today
 * (and a fourth on the diarization branches), and `rec.onresult` is the most-rewritten block
 * in AudioRecorder. Watching the value covers every writer, present and future, without
 * putting a line of code in any of them.
 *
 * Returns markLocalEdit(), which the textarea's onChange must call so the user's own typing
 * is left alone.
 *
 * ponytail: this is a DOM-layer rescue for a data-model problem — `transcript` is one flat
 * string with no ownership, so concurrent writers can't be reconciled, only survived. Note the
 * app already holds the opposite policy for one writer (AudioRecorder's proofread effect bails
 * on editingRef rather than writing through). The real fix is the tagged-segment model the
 * diarization work is building; when that lands, this hook should be deleted, not ported.
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

  const markLocalEdit = useCallback(() => {
    localRef.current = true;
  }, []);

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
