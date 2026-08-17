import { useCallback, useLayoutEffect, useRef, useState } from "react";

/**
 * Keeps a scrollable container pinned to its bottom as `contentKey` changes (e.g. streaming
 * transcript or summary text), without fighting a user who has scrolled up to read.
 *
 * - While the container is at (or returns to) the bottom, new content auto-scrolls into view.
 * - Once the user scrolls away from the bottom, auto-scroll pauses.
 * - After `graceMs` of no further scroll interaction, auto-scroll resumes and the view
 *   snaps back to the bottom regardless of where the user left it.
 *
 * Returns a callback ref to spread onto the container. It's a callback ref rather than a
 * RefObject on purpose: refs attach during commit but dep arrays are read during render, so a
 * `[ref.current]` dep is always one render stale — it would leave the listener uninstalled
 * until some unrelated re-render happened to occur, and attached to a detached node after the
 * container unmounts.
 *
 * `contentKey` should be a primitive that changes when content grows (a length is ideal —
 * cheaper to compare than a concatenated string, and growth is all this hook reacts to).
 */
// ponytail: the grace timer is a proxy for "the user is done reading" and it is an imperfect
// one — sit still reading for 5s and the view snaps away. The honest fix is a visible "new
// content ↓" affordance so the paused state is discoverable and resuming is a click. Timer
// kept for now because a 5s auto-resume is the specified behavior; revisit with the indicator.
export function useStickToBottom<T extends HTMLElement>(
  contentKey: unknown,
  graceMs = 5000,
  thresholdPx = 4
): (node: T | null) => void {
  const [node, setNode] = useState<T | null>(null);
  const setRef = useCallback((n: T | null) => setNode(n), []);

  // A pending grace timer IS the "user has scrolled away" state — unpinning always starts one,
  // and both ways of re-pinning clear it. Keeping a separate boolean would be the same bit twice.
  const graceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearGrace = useCallback(() => {
    if (graceTimerRef.current !== null) {
      clearTimeout(graceTimerRef.current);
      graceTimerRef.current = null;
    }
  }, []);

  useLayoutEffect(() => {
    if (!node) return;

    // Self-triggered scrolls need no special-casing: scrollTop clamps, so this lands at
    // distance-from-bottom 0, which is exactly the branch below that keeps us pinned.
    const toBottom = () => { node.scrollTop = node.scrollHeight; };

    const handleScroll = () => {
      if (node.scrollHeight - node.scrollTop - node.clientHeight <= thresholdPx) {
        clearGrace(); // back at the bottom — pinned again
        return;
      }
      clearGrace();
      graceTimerRef.current = setTimeout(() => {
        graceTimerRef.current = null;
        toBottom();
      }, graceMs);
    };

    node.addEventListener("scroll", handleScroll, { passive: true });
    return () => {
      node.removeEventListener("scroll", handleScroll);
      clearGrace();
    };
  }, [node, graceMs, thresholdPx, clearGrace]);

  // Follow new content, but only while pinned. useLayoutEffect, not useEffect: this must run
  // before paint, or every update paints once at the stale offset and again after scrolling.
  useLayoutEffect(() => {
    if (node && graceTimerRef.current === null) node.scrollTop = node.scrollHeight;
  }, [contentKey, node]);

  return setRef;
}
