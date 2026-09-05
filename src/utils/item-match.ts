// Identity for planner items: does an incoming item refer to the SAME real-world thing as one
// already in the live draft? Lives here rather than inline in App.tsx because with autonomy on, a
// missed match is not a cosmetic duplicate row — it is a second event written to the user's real
// Google Calendar. Same argument as autonomy.ts: the predicate that gates a real write gets pinned.
//
// The live pipeline re-plans the WHOLE transcript every couple of seconds, so the same utterance is
// re-offered on every tick, growing as the speaker adds detail. Identity therefore has to survive
// fields changing — the title is the only part that stays put while a time, a place or a duration
// gets filled in.

/** Strip punctuation, casing and extra spaces so "Dentist appointment!" == "dentist appointment". */
export const normalizeText = (s: string) => (s || "").toLowerCase().replace(/[^a-z0-9\s]/gi, "").replace(/\s+/g, " ").trim();

/** Equal, one contains the other, or Jaccard word overlap clears `threshold`. */
export function isTextMatch(t1: string, t2: string, threshold = 0.55): boolean {
  const n1 = normalizeText(t1);
  const n2 = normalizeText(t2);
  if (!n1 || !n2) return false;
  if (n1 === n2) return true;
  if (n1.includes(n2) || n2.includes(n1)) return true;
  const words1 = new Set(n1.split(" "));
  const words2 = new Set(n2.split(" "));
  const intersection = [...words1].filter(w => words2.has(w)).length;
  const union = new Set([...words1, ...words2]).size;
  return union > 0 && (intersection / union) >= threshold;
}

/** The classifier copies the triggering phrase verbatim, so an exact repeat is the same item. */
const sameSource = (a?: string, b?: string) => !!a && !!b && a === b;

// Only the fields identity reads. Callers pass whole draft items (status, eventId, start, …);
// TypeScript allows the extras because they arrive as variables, not fresh object literals.
type Titled = { title?: string; sourceText?: string };
type Queried = { query?: string; sourceText?: string };

// ponytail: title similarity means two genuinely distinct same-titled events in ONE session collapse
// into one ("Standup" Monday and "Standup" Tuesday). Within a single brain dump that is far rarer
// than the same event being refined tick by tick, which is what this has to get right. If recurring
// events start merging, add a start-date tiebreak — but only when BOTH sides already have a start,
// never the old `existing.start === evt.start` conjunction, which failed exactly when a time arrived.
export const isSameEvent = (a: Titled, b: Titled) =>
  isTextMatch(a.title || "", b.title || "", 0.5) || sameSource(a.sourceText, b.sourceText);

export const isSameTask = (a: Titled, b: Titled) =>
  isTextMatch(a.title || "", b.title || "", 0.55) || sameSource(a.sourceText, b.sourceText);

export const isSameQuery = (a: Queried, b: Queried) =>
  isTextMatch(a.query || "", b.query || "", 0.7) || sameSource(a.sourceText, b.sourceText);

// ponytail: self-check pins the merge identity that stops duplicate Google Calendar writes.
// Run: tsx src/utils/item-match.ts
// No node imports — this module ships to the browser, so the check uses a plain throw like autonomy.ts.
if (typeof process !== "undefined" && process.argv[1]?.endsWith("item-match.ts")) {
  const eq = (got: boolean, want: boolean, msg: string) => {
    if (got !== want) throw new Error(`${msg}: want ${want}, got ${got}`);
  };

  // THE REGRESSION THIS FILE EXISTS FOR. One dentist appointment, described across three live ticks:
  // first the bare mention, then the time, then the place. Every tick must land on the SAME item.
  // The old rule ANDed title similarity with `existing.start === evt.start`, so ticks 2 and 3 each
  // pushed a new entry — and with autonomy on, each entry became a real calendar event.
  const t1 = { title: "Dentist Appointment", start: "", sourceText: "I have a dentist appointment" };
  const t2 = { title: "Dentist Appointment", start: "2026-08-22T09:00:00", sourceText: "I have a dentist appointment at 9am Saturday" };
  const t3 = { title: "Dentist Appointment in San Francisco", start: "2026-08-22T09:00:00", sourceText: "I have a dentist appointment at 9am Saturday in San Francisco" };
  eq(isSameEvent(t1, t2), true, "gaining a start time split the event");
  eq(isSameEvent(t2, t3), true, "gaining a location split the event");
  eq(isSameEvent(t1, t3), true, "first mention and fully-specified event must be one item");

  // A start that MOVES is still the same event — that is a reschedule, not a second appointment.
  const moved = { ...t2, start: "2026-08-23T14:00:00" };
  eq(isSameEvent(t2, moved), true, "rescheduling split the event");

  // ...but unrelated events must stay apart, even sharing a start.
  const standup = { title: "Team Standup", start: "2026-08-22T09:00:00", sourceText: "standup at 9" };
  eq(isSameEvent(t2, standup), false, "unrelated events sharing a start merged");

  // Two tasks from one sentence keep their own rows — titles differ enough to stay apart.
  eq(isSameTask({ title: "Sweep the floor" }, { title: "Mop the floor" }), false, "distinct chores merged");
  eq(isSameTask({ title: "Sweep the floor" }, { title: "Sweep the kitchen floor" }), true, "refined chore split");

  // Queries need a higher bar: "best sushi in SF" and "best ramen in SF" are different searches.
  eq(isSameQuery({ query: "best sushi in SF" }, { query: "best ramen in SF" }), false, "distinct queries merged");
  eq(isSameQuery({ query: "who designed the Concorde" }, { query: "who designed the Concorde jet" }), true,
    "refined query split");

  // sourceText is a fallback for a title the model rewrote wholesale — verbatim repeat only.
  eq(isSameEvent({ title: "Coffee with Bob", sourceText: "grab coffee w/ bob" },
                 { title: "Catch-up", sourceText: "grab coffee w/ bob" }), true, "verbatim sourceText ignored");
  eq(isSameEvent({ title: "A", sourceText: "" }, { title: "B", sourceText: "" }), false, "empty sourceText matched");

  console.log("item-match self-check ✓");
}
