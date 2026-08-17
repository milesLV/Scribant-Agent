import { useLayoutEffect, useRef, useCallback, type RefObject } from "react";

/** What a click on the read-only view told us about where to resume editing. */
interface PendingClick {
  /** Character offset into the transcript, or null if the browser couldn't map the point. */
  offset: number | null;
  /** The click's Y offset from the container's top edge, so the clicked line lands back under it. */
  clickY: number;
}

/**
 * Click-to-edit hand-off for the transcript panel: the read-only div is swapped for a
 * textarea, and this lands both the caret AND the scroll position where the user clicked.
 *
 * Scroll position is derived from the caret rather than copied from the div. The two elements
 * are deliberately kept on the same type scale and line height so the text doesn't reflow on
 * click, but they still don't render the same CONTENT — the div carries interim text and inline
 * correction chips the textarea has no equivalent for, so its scrollHeight differs and a raw
 * scrollTop copy would drift. Measuring the caret in the textarea's own layout is immune to
 * that, and anchoring on the click's Y offset puts the clicked line back under the pointer.
 *
 * ponytail: two forced layouts per click (prefix height, then full height) is the floor for
 * this technique, and it only runs on a discrete user gesture — not worth a mirror-div rewrite.
 * The deeper fix is rendering ONE element instead of a div and a textarea that must be
 * reconciled on every mode switch; that's blocked on the div's chips/coloring.
 */
export function useClickToEditCaret(
  ref: RefObject<HTMLTextAreaElement | null>,
  active: boolean,
  // Injected rather than imported: it lives next to the JSX whose DOM shape it depends on, and
  // that file is being rewritten on several branches — keep this hook out of the blast radius.
  caretOffsetFromPoint: (x: number, y: number, container: Node) => number | null
) {
  const pendingRef = useRef<PendingClick | null>(null);

  /** Call from the read-only div's onClick, BEFORE flipping into edit mode. */
  const captureClick = useCallback(
    (e: { clientX: number; clientY: number; currentTarget: HTMLElement }, hasText: boolean) => {
      const rect = e.currentTarget.getBoundingClientRect();
      pendingRef.current = {
        clickY: e.clientY - rect.top,
        offset: hasText ? caretOffsetFromPoint(e.clientX, e.clientY, e.currentTarget) : 0,
      };
    },
    [caretOffsetFromPoint]
  );

  /** True while a click-to-edit placement is pending, so other selection logic stands down. */
  const isPending = useCallback(() => pendingRef.current !== null, []);

  useLayoutEffect(() => {
    if (!active) return;
    // Consume the click unconditionally — leaving it set on a bail would strand isPending() at
    // true forever, permanently disabling caret preservation.
    const pending = pendingRef.current;
    pendingRef.current = null;

    const el = ref.current;
    if (!el || el.disabled || !pending) return;

    // Replaces `autoFocus`, which focused a freshly-mounted textarea and reset scrollTop to 0.
    el.focus({ preventScroll: true });
    if (pending.offset === null) return; // unsupported browser — leave the default alone

    const at = Math.min(pending.offset, el.value.length);

    // Measure where the caret falls in the TEXTAREA's own layout by rendering only the text
    // up to it and reading the resulting scrollHeight. Exact under soft wrapping. Safe on a
    // controlled input: the value ends where it started, so React's value tracker stays in
    // sync and no onChange is swallowed. Must happen before setSelectionRange, since
    // assigning .value resets the caret.
    const full = el.value;
    el.value = full.slice(0, at);
    const caretBottom = el.scrollHeight;
    el.value = full;

    el.setSelectionRange(at, at);
    const max = Math.max(0, el.scrollHeight - el.clientHeight);
    el.scrollTop = Math.max(0, Math.min(caretBottom - pending.clickY, max));
  }, [active, ref]);

  return { captureClick, isPending };
}
