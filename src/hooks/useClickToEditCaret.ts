import { useLayoutEffect, useRef, useCallback, type RefObject } from "react";

/**
 * Click-to-edit hand-off: when the read-only div becomes a textarea, put the caret AND the scroll
 * position where the user clicked. Scroll is derived from the caret in the textarea's own layout,
 * not copied from the div — the div also renders interim text and correction chips, so its
 * scrollHeight differs and a scrollTop copy would drift.
 * ponytail: two forced layouts per click; fine for a discrete gesture. The real fix is one element
 * instead of a div/textarea pair, blocked on the div's chips.
 */
export function useClickToEditCaret(
  ref: RefObject<HTMLTextAreaElement | null>,
  active: boolean,
  caretOffsetFromPoint: (x: number, y: number, container: Node) => number | null
) {
  // offset: char offset (null if the browser couldn't map the point); clickY: px from the top.
  const pendingRef = useRef<{ offset: number | null; clickY: number } | null>(null);

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
