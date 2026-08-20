import assert from "node:assert/strict";

// Per-session multi-speaker latch.
//
// This is deliberately all that remains of a much larger registry. The previous version
// (bce2bd7) tried to give speaker labels session-global identity by re-diarizing an overlapping
// rolling window and mapping window-local tags onto global ones by majority vote over the shared
// region. Measured against the live Cloud STT V1 API on real two-speaker audio, that scheme:
//   - swapped the permutation on 5 words of evidence (window 0-12s -> 8-20s),
//   - MERGED two speakers into one when a window collapsed to a single tag (8-20s -> 16-28s),
//   - minted a phantom third speaker for a tag with no anchor at all (24-36s).
// V1 diarization is deterministic, so a window that moves is a window that re-decides; anchoring
// faithfully propagated every re-decision into the transcript. Deleting it is the fix.
//
// ponytail: chunk-local labels, no cross-chunk identity. "Speaker 1" in one chunk and the next are
// formally unrelated, which is the honest state of per-request acoustic diarization.
// Upgrade path: streamingRecognize — one long-lived stream owns its own clustering and revises its
// own labels against full history, so identity comes free and none of the above is needed.

/** Chunks holding 2+ speakers needed before the session is treated as multi-speaker. */
export const CORROBORATION = 2;

/**
 * Sessions retained before the oldest is evicted. A capture session is keyed by page load and
 * nothing ever tells the server one ended, so without a bound this map grows for the process
 * lifetime. Map preserves insertion order, which is all the LRU this needs.
 *
 * ponytail: evicting the oldest can un-latch a session that has been idle through 500 others.
 * It re-latches after two more multi-speaker chunks. Upgrade path: have the client signal
 * capture-stopped, or stamp entries and evict by age.
 */
export const MAX_SESSIONS = 500;

interface SessionState {
  multiTagChunks: number;
}

const sessions = new Map<string, SessionState>();

/**
 * Record one chunk's diarization result and report whether the session is latched multi-speaker.
 *
 * Corroboration is the point. Chunk-level diarization is measurably wrong a good fraction of the
 * time — on Google's own two-speaker sample, individual 8s chunks disagreed with each other — so a
 * single 2-tag chunk is not evidence that two people are in the room. Two are. Once latched it
 * stays latched: a later chunk in which only one person happens to speak is not evidence the other
 * left, and unlatching would drop that speaker's label and fold their words into the open
 * paragraph (see the `speakerKey` note in src/utils/paragraphs.ts).
 */
export function noteChunk(sessionId: string | undefined, distinctSpeakersInChunk: number): boolean {
  // No session key: judge this chunk alone. One chunk can never corroborate itself, so a caller
  // that omits sessionId never latches — it falls back to the per-chunk count downstream.
  if (!sessionId) return false;
  const state = sessions.get(sessionId) ?? { multiTagChunks: 0 };
  if (distinctSpeakersInChunk > 1) state.multiTagChunks++;
  // Re-insert so this session counts as most-recently-used, then trim the oldest.
  sessions.delete(sessionId);
  sessions.set(sessionId, state);
  while (sessions.size > MAX_SESSIONS) sessions.delete(sessions.keys().next().value as string);
  return state.multiTagChunks >= CORROBORATION;
}

/** True once `noteChunk` has seen enough corroboration for this session. */
export function isMultiSpeaker(sessionId?: string): boolean {
  return (sessions.get(sessionId ?? "")?.multiTagChunks ?? 0) >= CORROBORATION;
}

/** Drop one session's state, or every session when called with no argument. */
export function resetRegistry(sessionId?: string): void {
  if (sessionId === undefined) sessions.clear();
  else sessions.delete(sessionId);
}

// ponytail: self-check pins the corroboration rule and the one-way latch.
// Run: tsx speaker-registry.ts
if (import.meta.url && process.argv[1]?.endsWith("speaker-registry.ts")) {
  resetRegistry();

  // One 2-speaker chunk is NOT enough — this is the guard against a single bad chunk labelling
  // the whole session, which is how the shipped regression became permanent.
  assert.equal(noteChunk("s1", 2), false, "one multi-speaker chunk does not latch");
  assert.equal(isMultiSpeaker("s1"), false);
  // The second one is.
  assert.equal(noteChunk("s1", 2), true, "two multi-speaker chunks latch");
  assert.equal(isMultiSpeaker("s1"), true);

  // Latched is one-way: a later solo chunk must not unlatch it.
  assert.equal(noteChunk("s1", 1), true, "a solo chunk does not unlatch");
  assert.equal(noteChunk("s1", 0), true, "an empty chunk does not unlatch");

  // Corroboration need not be consecutive — solo chunks in between are just silence from one side.
  resetRegistry();
  assert.equal(noteChunk("gap", 2), false);
  assert.equal(noteChunk("gap", 1), false, "still only one sighting");
  assert.equal(noteChunk("gap", 1), false);
  assert.equal(noteChunk("gap", 3), true, "second sighting latches, however far apart");

  // A genuinely solo session never latches, however long it runs. This is the reported bug:
  // one person must never be labelled, let alone alternate between two labels.
  resetRegistry();
  for (let i = 0; i < 50; i++) assert.equal(noteChunk("solo", 1), false);
  assert.equal(isMultiSpeaker("solo"), false, "solo session never latches");

  // Sessions are independent.
  resetRegistry();
  noteChunk("a", 2); noteChunk("a", 2);
  assert.equal(isMultiSpeaker("a"), true);
  assert.equal(isMultiSpeaker("b"), false, "one session's speakers don't leak into another");

  // Without a session key there is nothing to corroborate against.
  assert.equal(noteChunk(undefined, 5), false, "no sessionId never latches");
  assert.equal(isMultiSpeaker(undefined), false);

  // Reset clears.
  resetRegistry("a");
  assert.equal(isMultiSpeaker("a"), false, "reset opens a fresh session");

  // The map is bounded: a long-lived server must not accumulate one entry per page load forever.
  resetRegistry();
  noteChunk("keep-me", 2); noteChunk("keep-me", 2);
  assert.equal(isMultiSpeaker("keep-me"), true);
  for (let i = 0; i < MAX_SESSIONS; i++) noteChunk(`filler-${i}`, 1);
  assert.equal(isMultiSpeaker("keep-me"), false, "the oldest session is evicted once the cap is passed");
  resetRegistry();

  console.log("speaker-registry self-check ✓");
}
