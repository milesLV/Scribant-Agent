// Session-scoped speaker identity for the rolling diarization window.
//
// Cloud STT's `speech:recognize` is stateless: it clusters speakers WITHIN one request and numbers
// the resulting tags by order of appearance. "Speaker 1" in one window therefore has no defined
// relationship to "Speaker 1" in the next, and nothing in the response says who is who.
//
// The rolling window (see src/utils/audio-window.ts) re-sends overlapping audio each step, which is
// what makes identity recoverable: the overlap region has already been committed under global
// labels, so matching this window's tags against it by TIME yields the local -> global permutation.
// No voiceprints, no model call, no extra round trip.
import assert from "node:assert/strict";
import { fileURLToPath } from "url";

/** A turn as Cloud STT returned it: window-local label, window-relative timing. */
export interface WindowTurn {
  speaker: string;
  text: string;
  startMs?: number;
  endMs?: number;
}

/** A turn after reconciliation: session-global label, absolute session timing. */
export interface CommittedTurn {
  speaker: string;
  text: string;
  startMs: number;
  endMs: number;
}

export interface SessionRegistry {
  /** Committed turns, most recent last. Bounded — only the tail is ever needed. */
  turns: CommittedTurn[];
  /** Absolute session time everything before which is already committed. */
  committedThroughMs: number;
  /** Latched once the session has genuinely seen 2+ speakers. Never unlatches. */
  multiSpeaker: boolean;
  /** Global label -> inferred display name. */
  names: Record<string, string>;
  /** `${global}|${name}` -> times proposed. A name is only committed on the second sighting. */
  nameVotes: Record<string, number>;
  /** How far the self-introduction pass has read. */
  namedThrough: number;
  /** How far the direct-address pass has read. Trails by one: the reply names the person. */
  addressThrough: number;
  /** Highest global speaker number handed out so far. */
  speakerSeq: number;
  touchedAt: number;
}

/** Turns kept for overlap matching and naming. Well past the widest window; the rest is dead weight. */
export const MAX_KEPT_TURNS = 200;

export const emptyRegistry = (): SessionRegistry => ({
  turns: [],
  committedThroughMs: 0,
  multiSpeaker: false,
  names: {},
  nameVotes: {},
  namedThrough: 0,
  addressThrough: 0,
  speakerSeq: 0,
  touchedAt: Date.now(),
});

/* --- name inference ---------------------------------------------------------------------------
 * ponytail: regex vocative match, not semantics. Misses indirect mentions and will happily name a
 * third party who isn't in the room. Upgrade path: fold the tag->name mapping into
 * intent_classifier's existing speaker-attribution prompt (agents.ts) rather than adding an agent —
 * it already reads speaker labels and emits assignee/requestedBy names.
 */

// Capitalised tokens that are almost never a participant's name. Without this, "This is Monday" and
// "Thanks, God" both name a speaker. Sentence-initial position is the main false-positive source,
// so weekdays, months and the common openers are all excluded.
const NOT_A_NAME = new Set([
  "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
  "january", "february", "march", "april", "may", "june", "july", "august",
  "september", "october", "november", "december",
  "the", "this", "that", "there", "then", "today", "tomorrow", "yesterday", "tonight",
  "i", "it", "we", "you", "he", "she", "they", "and", "but", "so", "well", "ok", "okay",
  "yes", "no", "yeah", "right", "sure", "google", "zoom", "meet", "god", "note",
]);

// "I'm Sam", "this is Manuela", "my name is Sam" — names the speaker of THIS turn.
const SELF_INTRO = /\b(?:i'?m|i am|this is|my name is)\s+([A-Z][a-z]{1,19})\b/i;
// "Sam here" — same, but only at the very start of a turn, where it reads as an introduction.
const SELF_HERE = /^\s*([A-Z][a-z]{1,19})\s+here\b/i;
// "Thanks, Manuela", "Hi Sam", "Manuela, what do you think?" — names whoever speaks NEXT.
const ADDRESS_AFTER = /\b(?:thanks|thank you|hi|hey|hello|sorry|welcome|over to|go ahead)[,\s]+([A-Z][a-z]{1,19})\b/i;
const ADDRESS_BEFORE = /\b([A-Z][a-z]{1,19}),\s+(?:what|how|why|when|where|do|did|does|can|could|would|will|are|is|any|your|you)\b/i;

const cleanName = (raw?: string): string | undefined => {
  const n = (raw ?? "").trim();
  if (!n || NOT_A_NAME.has(n.toLowerCase())) return undefined;
  // ADDRESS_AFTER is case-insensitive so "hi sam" still matches; require the NAME itself to be
  // capitalised, which is the only signal separating a name from an ordinary following word.
  return /^[A-Z][a-z]{1,19}$/.test(n) ? n : undefined;
};

/**
 * Vote a name onto a global speaker. Committed only on the SECOND independent sighting — a single
 * capitalised token after "hi" is far too thin to relabel a speaker for the rest of a session.
 * Injective: a name already bound to another speaker is refused rather than duplicated.
 */
function proposeName(reg: SessionRegistry, speaker: string, raw?: string): void {
  const name = cleanName(raw);
  if (!name || reg.names[speaker]) return;
  if (Object.entries(reg.names).some(([g, n]) => n === name && g !== speaker)) return;
  const key = `${speaker}|${name}`;
  reg.nameVotes[key] = (reg.nameVotes[key] ?? 0) + 1;
  if (reg.nameVotes[key] >= 2) reg.names[speaker] = name;
}

/** Scan turns committed since the last pass for introductions and direct address. */
export function inferNames(reg: SessionRegistry): void {
  // Two cursors, both strictly monotonic. A single shared cursor would have to rescan the last turn
  // (address needs a successor that has not arrived yet), and rescanning it would vote its
  // self-introduction twice — committing a name from one sighting and defeating the guard below.
  for (let i = reg.namedThrough; i < reg.turns.length; i++) {
    const turn = reg.turns[i];
    proposeName(reg, turn.speaker, SELF_INTRO.exec(turn.text)?.[1] ?? SELF_HERE.exec(turn.text)?.[1]);
  }
  reg.namedThrough = reg.turns.length;

  // Direct address points FORWARD: the person greeted is the one who replies. Only useful when the
  // next turn is somebody else — "Thanks, Sam" followed by Sam's own turn names nobody.
  for (let i = reg.addressThrough; i + 1 < reg.turns.length; i++) {
    const turn = reg.turns[i];
    const next = reg.turns[i + 1];
    if (next.speaker !== turn.speaker) {
      proposeName(reg, next.speaker, ADDRESS_AFTER.exec(turn.text)?.[1] ?? ADDRESS_BEFORE.exec(turn.text)?.[1]);
    }
  }
  reg.addressThrough = Math.max(0, reg.turns.length - 1);
}

/* --- overlap anchoring ----------------------------------------------------------------------- */

const overlapMs = (a: { startMs: number; endMs: number }, b: { startMs: number; endMs: number }) =>
  Math.max(0, Math.min(a.endMs, b.endMs) - Math.max(a.startMs, b.startMs));

/**
 * Map this window's local tags onto session-global speakers by time-overlap against already
 * committed turns.
 *
 * Greedy by descending score, and strictly INJECTIVE: two local tags may never resolve to the same
 * global speaker. That constraint is the whole point — collapsing two tags back onto one label
 * would reintroduce exactly the "both people came out as Sam" bug this file exists to fix. A tag
 * that loses the contest, or that overlaps nothing, gets a fresh global label instead.
 */
export function mapLocalTags(reg: SessionRegistry, absTurns: CommittedTurn[]): Record<string, string> {
  const localTags = [...new Set(absTurns.map(t => t.speaker))];
  const scores: { local: string; global: string; score: number }[] = [];

  for (const local of localTags) {
    const mine = absTurns.filter(t => t.speaker === local);
    const perGlobal: Record<string, number> = {};
    for (const committed of reg.turns) {
      for (const t of mine) perGlobal[committed.speaker] = (perGlobal[committed.speaker] ?? 0) + overlapMs(t, committed);
    }
    for (const [global, score] of Object.entries(perGlobal)) if (score > 0) scores.push({ local, global, score });
  }

  scores.sort((a, b) => b.score - a.score);
  const mapping: Record<string, string> = {};
  const takenGlobals = new Set<string>();
  for (const { local, global, score } of scores) {
    if (score <= 0 || mapping[local] || takenGlobals.has(global)) continue;
    mapping[local] = global;
    takenGlobals.add(global);
  }

  // Anything still unmapped is a voice this session hasn't committed before. Reuse a known global
  // that is free this window before minting a new one, so a speaker who simply went quiet for a
  // while doesn't come back as "Speaker 3".
  const knownFree = reg.turns.map(t => t.speaker).filter((g, i, a) => a.indexOf(g) === i && !takenGlobals.has(g));
  for (const local of localTags) {
    if (mapping[local]) continue;
    const reuse = knownFree.shift();
    if (reuse) {
      mapping[local] = reuse;
      takenGlobals.add(reuse);
    } else {
      reg.speakerSeq += 1;
      mapping[local] = `Speaker ${reg.speakerSeq}`;
      takenGlobals.add(mapping[local]);
    }
  }
  return mapping;
}

/* --- the entry point ------------------------------------------------------------------------- */

export interface ReconcileResult {
  /** Newly committed turns only, global labels, absolute timing. */
  turns: CommittedTurn[];
  committedThroughMs: number;
  multiSpeaker: boolean;
  speakerCount: number;
  names: Record<string, string>;
}

/**
 * Fold one diarized window into the session.
 *
 * `commitFromMs` is what the CLIENT believes it has already appended; the registry's own
 * `committedThroughMs` is what the server committed. The later of the two wins, so a retried or
 * out-of-order window can never re-emit text the transcript already holds — the transcript is
 * append-only and has no way to take a duplicate back.
 */
export function reconcileWindow(
  reg: SessionRegistry,
  windowTurns: WindowTurn[],
  opts: { windowStartMs?: number; commitFromMs?: number; emitLagMs?: number } = {},
): ReconcileResult {
  const windowStartMs = opts.windowStartMs ?? 0;
  const emitLagMs = opts.emitLagMs ?? 0;
  reg.touchedAt = Date.now();

  const abs: CommittedTurn[] = windowTurns
    .filter(t => t.text?.trim())
    .map(t => ({
      speaker: t.speaker || "Speaker 1",
      text: t.text.trim(),
      startMs: windowStartMs + (t.startMs ?? 0),
      endMs: windowStartMs + (t.endMs ?? t.startMs ?? 0),
    }))
    .sort((a, b) => a.startMs - b.startMs);

  const mapping = mapLocalTags(reg, abs);
  const floor = Math.max(reg.committedThroughMs, opts.commitFromMs ?? 0);
  // Hold back a turn still running at the window edge. It will be seen whole next window, and
  // committing its first half now is precisely how a turn split by a chunk boundary used to get
  // re-clustered and misattributed.
  const edge = abs.length ? Math.max(...abs.map(t => t.endMs)) - emitLagMs : floor;

  const fresh = abs
    .filter(t => t.startMs >= floor && t.endMs <= edge)
    .map(t => ({ ...t, speaker: mapping[t.speaker] ?? t.speaker }));

  reg.turns.push(...fresh);
  if (reg.turns.length > MAX_KEPT_TURNS) {
    // Dropping from the front renumbers everything; the naming cursors index into this array, so
    // they have to slide by the same amount or the pass re-reads turns it already voted on.
    const dropped = reg.turns.length - MAX_KEPT_TURNS;
    reg.turns.splice(0, dropped);
    reg.namedThrough = Math.max(0, reg.namedThrough - dropped);
    reg.addressThrough = Math.max(0, reg.addressThrough - dropped);
  }
  if (fresh.length) reg.committedThroughMs = Math.max(floor, ...fresh.map(t => t.endMs));

  // Latch on distinct speakers seen ACROSS the session, not within one window — a window holding
  // one voice must not drop the labels once two people are known to be in the room.
  const distinct = new Set(reg.turns.map(t => t.speaker));
  if (distinct.size > 1) reg.multiSpeaker = true;

  inferNames(reg);

  return {
    turns: fresh.map(t => ({ ...t, speaker: reg.names[t.speaker] ?? t.speaker })),
    committedThroughMs: reg.committedThroughMs,
    multiSpeaker: reg.multiSpeaker,
    speakerCount: Math.max(distinct.size, reg.multiSpeaker ? 2 : distinct.size),
    names: { ...reg.names },
  };
}

/* --- session store --------------------------------------------------------------------------- */

const SESSIONS = new Map<string, SessionRegistry>();
const SESSION_TTL_MS = 6 * 60 * 60 * 1000;

/** Fetch (or open) a session's registry, pruning ones nobody has touched in a long while. */
export function getRegistry(sessionId?: string): SessionRegistry {
  const key = sessionId?.trim() || "default";
  if (SESSIONS.size > 64) {
    const cutoff = Date.now() - SESSION_TTL_MS;
    for (const [k, v] of SESSIONS) if (v.touchedAt < cutoff) SESSIONS.delete(k);
  }
  let reg = SESSIONS.get(key);
  if (!reg) SESSIONS.set(key, (reg = emptyRegistry()));
  return reg;
}

export const resetRegistry = (sessionId?: string) => SESSIONS.delete(sessionId?.trim() || "default");

/* --- self-check ------------------------------------------------------------------------------ */
if (import.meta.url && process.argv[1] === fileURLToPath(import.meta.url)) (async () => {
  const turn = (speaker: string, text: string, startMs: number, endMs: number): WindowTurn =>
    ({ speaker, text, startMs, endMs });

  // 1. First window: local tags become globals, latch flips on two speakers.
  const reg = emptyRegistry();
  const w1 = reconcileWindow(reg, [
    turn("Speaker 1", "Hi everyone", 0, 3000),
    turn("Speaker 2", "Good morning", 4000, 7000),
  ], { windowStartMs: 0 });
  assert.equal(w1.turns.length, 2);
  assert.equal(w1.multiSpeaker, true, "two speakers latches multiSpeaker");
  assert.equal(w1.committedThroughMs, 7000);
  const [sam, manuela] = [w1.turns[0].speaker, w1.turns[1].speaker];
  assert.notEqual(sam, manuela, "two speakers keep distinct globals");

  // 2. The bug: next window re-diarizes the overlap and flips the tag order. Overlap anchoring
  //    must undo the flip, NOT carry the flipped labels forward.
  const w2 = reconcileWindow(reg, [
    turn("Speaker 2", "Hi everyone", 0, 3000),      // same audio, opposite tag
    turn("Speaker 1", "Good morning", 4000, 7000),
    turn("Speaker 1", "Let us begin", 8000, 11000),
  ], { windowStartMs: 0, commitFromMs: 7000 });
  assert.equal(w2.turns.length, 1, "only the new tail is committed");
  assert.equal(w2.turns[0].text, "Let us begin");
  assert.equal(w2.turns[0].speaker, manuela, "flipped tags are mapped back to the right speaker");

  // 3. A window holding ONE voice keeps its label once the session is latched — this is the
  //    regression that folded Manuela's solo chunk into Sam's paragraph.
  const w3 = reconcileWindow(reg, [turn("Speaker 1", "Still me talking", 12000, 15000)],
    { windowStartMs: 0, commitFromMs: 11000 });
  assert.equal(w3.multiSpeaker, true, "latch survives a single-speaker window");
  assert.equal(w3.turns.length, 1);

  // 4. Injectivity: two local tags may never collapse onto one global.
  const inj = emptyRegistry();
  reconcileWindow(inj, [turn("Speaker 1", "a", 0, 1000), turn("Speaker 2", "b", 1000, 2000)], {});
  const m = mapLocalTags(inj, [
    { speaker: "A", text: "x", startMs: 0, endMs: 2000 },
    { speaker: "B", text: "y", startMs: 0, endMs: 2000 },
  ]);
  assert.equal(new Set(Object.values(m)).size, 2, "distinct local tags stay distinct");

  // 5. A turn still running at the window edge is held back, then committed whole.
  const lag = emptyRegistry();
  const held = reconcileWindow(lag, [
    turn("Speaker 1", "committed", 0, 3000),
    turn("Speaker 2", "half a sen", 3000, 8000),
  ], { windowStartMs: 0, emitLagMs: 1500 });
  assert.equal(held.turns.length, 1, "trailing turn inside the lag window is held back");
  // Next window: the speaker finished and someone else started, so the held turn is no longer at
  // the edge and commits whole — with the full text, never the truncated half.
  const whole = reconcileWindow(lag, [
    turn("Speaker 1", "committed", 0, 3000),
    turn("Speaker 2", "half a sentence finished", 3000, 8000),
    turn("Speaker 1", "and my reply", 8000, 12000),
  ], { windowStartMs: 0, emitLagMs: 1500 });
  assert.equal(whole.turns[0].text, "half a sentence finished", "held turn arrives whole next window");

  // 6. Names: two sightings commit, one does not.
  const nm = emptyRegistry();
  reconcileWindow(nm, [turn("Speaker 1", "Hi, I'm Sam", 0, 2000), turn("Speaker 2", "Hello", 2000, 4000)], {});
  assert.equal(nm.names["Speaker 1"], undefined, "one sighting is not enough");
  reconcileWindow(nm, [turn("Speaker 1", "As I'm Sam I will start", 5000, 8000), turn("Speaker 2", "Sure", 8000, 9000)],
    { commitFromMs: 4000 });
  assert.equal(nm.names["Speaker 1"], "Sam", "second sighting commits the name");

  // 7. Direct address names the NEXT speaker, not the one talking.
  const ad = emptyRegistry();
  reconcileWindow(ad, [
    turn("Speaker 1", "Thanks, Manuela", 0, 2000),
    turn("Speaker 2", "Happy to help", 2000, 4000),
    turn("Speaker 1", "Over to Manuela", 4000, 6000),
    turn("Speaker 2", "Right", 6000, 8000),
  ], {});
  assert.equal(ad.names["Speaker 2"], "Manuela", "the person addressed is the one who replies");
  assert.equal(ad.names["Speaker 1"], undefined, "the speaker doing the addressing is not named");

  // 8. Stoplist and capitalisation guards.
  assert.equal(cleanName("Monday"), undefined, "weekday is not a name");
  assert.equal(cleanName("the"), undefined, "common word is not a name");
  assert.equal(cleanName("sam"), undefined, "lowercase token is not a name");
  assert.equal(cleanName("Sam"), "Sam");
  const st = emptyRegistry();
  reconcileWindow(st, [turn("Speaker 1", "This is Monday", 0, 2000), turn("Speaker 2", "Yes", 2000, 3000)], {});
  reconcileWindow(st, [turn("Speaker 1", "This is Monday again", 4000, 6000), turn("Speaker 2", "Yes", 6000, 7000)],
    { commitFromMs: 3000 });
  assert.equal(st.names["Speaker 1"], undefined, "stoplisted token never becomes a name");

  // 9. Solo session never latches, so solo dictation keeps flowing unlabelled.
  const solo = emptyRegistry();
  const s1 = reconcileWindow(solo, [turn("Speaker 1", "just me", 0, 3000)], {});
  const s2 = reconcileWindow(solo, [turn("Speaker 1", "still just me", 4000, 7000)], { commitFromMs: 3000 });
  assert.equal(s1.multiSpeaker, false);
  assert.equal(s2.multiSpeaker, false, "solo session never latches");

  // 10. Store: same id returns the same registry, reset clears it.
  assert.equal(getRegistry("abc"), getRegistry("abc"));
  getRegistry("abc").multiSpeaker = true;
  resetRegistry("abc");
  assert.equal(getRegistry("abc").multiSpeaker, false, "reset opens a fresh registry");

  // 11. End to end, the reported bug: Sam speaks, pauses, then Manuela speaks a second later —
  //     and the window boundary falls between them, so Manuela's window holds only her voice.
  //     Before the latch, that window came back unlabelled and `speakerKey` folded it straight into
  //     Sam's open paragraph. Assert the whole server -> wire -> client path, not just this file.
  const { toUtterances, joinUtterances } = await import("./src/utils/paragraphs");
  const meeting = emptyRegistry();

  // Deliberately adversarial: `speakerCount` here reports only what THIS window held, the way
  // Cloud STT itself reports it. That leaves `multiSpeaker` as the sole carrier of the session
  // fact, so this check fails if the latch is removed — which is the point of having it.
  const wire = (r: ReconcileResult) => ({
    text: r.turns.map(t => (r.multiSpeaker ? `${t.speaker}: ${t.text}` : t.text)).join("\n\n"),
    speakerCount: new Set(r.turns.map(t => t.speaker)).size,
    multiSpeaker: r.multiSpeaker,
    turns: r.turns.map(({ speaker, text }) => ({ speaker, text })),
  });

  // Window 1 catches both voices, so the session latches.
  const first = reconcileWindow(meeting, [
    turn("Speaker 1", "I think we should ship on Friday", 0, 4000),
    turn("Speaker 2", "That works for me", 5000, 8000),
  ], { windowStartMs: 0 });

  // Window 2 happens to hold only Manuela — the exact case that used to lose her label.
  const second = reconcileWindow(meeting, [
    turn("Speaker 1", "That works for me", 5000, 8000),   // overlap, tag reused for the other voice
    turn("Speaker 1", "But I need the designs first", 9000, 13000),
  ], { windowStartMs: 0, commitFromMs: 8000 });

  const utterances = [...toUtterances(wire(first), "stt"), ...toUtterances(wire(second), "stt")];
  const rendered = joinUtterances(utterances);
  assert.equal(utterances.length, 3, "three turns survive the wire");
  assert.equal(utterances[1].speaker, utterances[2].speaker,
    "the solo window is attributed to the SAME person who spoke last, not relabelled");
  assert.notEqual(utterances[0].speaker, utterances[1].speaker, "the two voices stay distinct");
  assert.ok(rendered.includes("\n\n"), "a paragraph break separates the speakers");
  assert.ok(!/I think we should ship on Friday.*But I need the designs first/s.test(rendered.split("\n\n")[0]),
    "Manuela's words never end up inside Sam's paragraph");

  console.log("speaker-registry self-check ✓");
})();
