import { useLayoutEffect, useRef, useState } from "react";

const GRACE_MS = 5000;
const THRESHOLD_PX = 4;

/**
 * Keeps a scrollable container pinned to its bottom as `contentKey` (e.g. a text length) grows.
 * Scrolling up pauses that; after GRACE_MS without scrolling it snaps back to the bottom.
 * Returns a callback ref, not a RefObject: a `[ref.current]` dep is read during render, before
 * the ref attaches, so it would always be one render stale.
 */
// ponytail: the grace timer is a proxy for "done reading" — sit still for 5s and the view snaps
// away. The honest fix is a visible "new content ↓" button; revisit with that indicator.
export function useStickToBottom<T extends HTMLElement>(contentKey: unknown): (node: T | null) => void {
  const [node, setNode] = useState<T | null>(null);
  // A pending timer IS the "user scrolled away" state; no separate boolean.
  const graceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearGrace = () => { clearTimeout(graceTimerRef.current ?? undefined); graceTimerRef.current = null; };

  useLayoutEffect(() => {
    if (!node) return;
    // Our own scrolls land at distance 0 (scrollTop clamps), which re-pins — no special case.
    const handleScroll = () => {
      clearGrace();
      if (node.scrollHeight - node.scrollTop - node.clientHeight <= THRESHOLD_PX) return;
      graceTimerRef.current = setTimeout(() => {
        graceTimerRef.current = null;
        node.scrollTop = node.scrollHeight;
      }, GRACE_MS);
    };
    node.addEventListener("scroll", handleScroll, { passive: true });
    return () => {
      node.removeEventListener("scroll", handleScroll);
      clearGrace();
    };
  }, [node]);

  // Layout effect so it lands before paint — otherwise each update paints once at the stale offset.
  useLayoutEffect(() => {
    if (node && graceTimerRef.current === null) node.scrollTop = node.scrollHeight;
  }, [contentKey, node]);

  return setNode;
}
