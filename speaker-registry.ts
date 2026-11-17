import assert from "node:assert/strict";

// Per-session multi-speaker latch: all that remains of a registry (bce2bd7) that tried to give
// labels session-global identity by re-diarizing overlapping windows. Against live Cloud STT V1 it
// swapped speakers, merged two into one, and minted phantom ones, so it was deleted.
// ponytail: chunk-local labels, no cross-chunk identity. Upgrade path: streamingRecognize, whose one
// long-lived stream owns its own clustering (stt-stream.ts).

/** Chunks holding 2+ speakers needed before the session is treated as multi-speaker. */
export const CORROBORATION = 2;

// Nothing tells the server a session ended, so cap the map (Map order is the LRU).
// ponytail: eviction can un-latch a session idle through 500 others; it re-latches in two chunks.
export const MAX_SESSIONS = 500;

// sessionId -> chunks seen holding 2+ speakers.
const sessions = new Map<string, number>();

// Record one chunk's diarization; true once the session is latched multi-speaker. One 2-tag chunk
// isn't evidence (single chunks often disagree), two are. The latch is one-way: a chunk where only
// one person speaks doesn't mean the other left.
export function noteChunk(sessionId: string | undefined, distinctSpeakersInChunk: number): boolean {
  // No session key: never latches; the caller falls back to the per-chunk count.
  if (!sessionId) return false;
  const count = (sessions.get(sessionId) ?? 0) + (distinctSpeakersInChunk > 1 ? 1 : 0);
  // Re-insert so this session counts as most-recently-used, then trim the oldest.
  sessions.delete(sessionId);
  sessions.set(sessionId, count);
  while (sessions.size > MAX_SESSIONS) sessions.delete(sessions.keys().next().value as string);
  return count >= CORROBORATION;
}

// Self-check: the corroboration rule and the one-way latch. Run: tsx speaker-registry.ts
if (import.meta.url && process.argv[1]?.endsWith("speaker-registry.ts")) {
  // noteChunk(id, 0) never adds a sighting, so it reads the latch without changing it.
  const latched = (id: string) => noteChunk(id, 0);

  // One 2-speaker chunk is NOT enough — this is the guard against a single bad chunk labelling
  // the whole session, which is how the shipped regression became permanent.
  assert.equal(noteChunk("s1", 2), false, "one multi-speaker chunk does not latch");
  // The second one is.
  assert.equal(noteChunk("s1", 2), true, "two multi-speaker chunks latch");

  // Latched is one-way: a later solo chunk must not unlatch it.
  assert.equal(noteChunk("s1", 1), true, "a solo chunk does not unlatch");
  assert.equal(noteChunk("s1", 0), true, "an empty chunk does not unlatch");

  // Corroboration need not be consecutive — solo chunks in between are just silence from one side.
  assert.equal(noteChunk("gap", 2), false);
  assert.equal(noteChunk("gap", 1), false, "still only one sighting");
  assert.equal(noteChunk("gap", 1), false);
  assert.equal(noteChunk("gap", 3), true, "second sighting latches, however far apart");

  // A genuinely solo session never latches, however long it runs. This is the reported bug:
  // one person must never be labelled, let alone alternate between two labels.
  for (let i = 0; i < 50; i++) assert.equal(noteChunk("solo", 1), false);

  // Sessions are independent.
  noteChunk("a", 2); noteChunk("a", 2);
  assert.equal(latched("a"), true);
  assert.equal(latched("b"), false, "one session's speakers don't leak into another");

  // Without a session key there is nothing to corroborate against.
  assert.equal(noteChunk(undefined, 5), false, "no sessionId never latches");

  // The map is bounded: a long-lived server must not accumulate one entry per page load forever.
  noteChunk("keep-me", 2); noteChunk("keep-me", 2);
  for (let i = 0; i <= MAX_SESSIONS; i++) noteChunk(`filler-${i}`, 1);
  assert.equal(latched("keep-me"), false, "the oldest session is evicted once the cap is passed");

  console.log("speaker-registry self-check ✓");
}
