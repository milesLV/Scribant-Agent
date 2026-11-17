// Merging a freshly classified plan over the one it replaces.
//
// The live pipeline re-derives the whole plan every tick, so items the user already acted on come
// back as new rows. Dropped in verbatim they'd lose their Google id, status and search answer — and
// with autonomy on, a missed match is a second real calendar event. Rows match by identity, never
// by position: the classifier reorders, merges and drops rows between ticks.

export type PlanList = "calendarEvents" | "tasks" | "searchQueries";

const normalize = (s?: string) =>
  (s || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();

// Filler the classifier drops or adds freely between ticks ("call plumber" one tick, "call THE
// plumber" the next). Stripping it first is what keeps short titles matching: on a two-word title a
// single spurious article is otherwise a third of the words.
const FILLER = new Set("a an the my our your this that some it to of for and on at in with about".split(" "));

const contentWords = (s: string): string[] => {
  const all = s.split(" ").filter(Boolean);
  const kept = all.filter(w => !FILLER.has(w));
  return kept.length ? kept : all; // an all-filler title still has to compare as something
};

// The same phrase after re-transcription and proofreading: exact, containment for long strings, or a
// 65% overlap of content words — the classifier rarely reproduces its own wording verbatim tick to
// tick. The threshold sits above what genuinely different items score: two titles that share one
// content word out of two ("call plumber" / "call dentist") come to 0.33, nowhere near it.
export function isSameishText(a?: string, b?: string): boolean {
  const n1 = normalize(a), n2 = normalize(b);
  if (!n1 || !n2) return false;
  if (n1 === n2) return true;
  if (n1.length > 15 && n2.length > 15 && (n1.includes(n2) || n2.includes(n1))) return true;
  const w1 = new Set(contentWords(n1)), w2 = new Set(contentWords(n2));
  const shared = [...w1].filter(w => w2.has(w)).length;
  const union = new Set([...w1, ...w2]).size;
  return union > 0 && shared / union >= 0.65;
}

// Do two rows describe the same real-world item? sourceText (the verbatim transcript phrase that
// triggered the item) is the strongest signal; the title/query is the fallback.
// ponytail: events match on title alone, so a start that moves — even to another day — is a
// reschedule of the same row, and two genuinely distinct same-titled events in ONE session
// ("Standup" Monday and "Standup" Tuesday) collapse. Within a single brain dump that is far rarer
// than the same event being refined tick by tick. If recurring events start merging, add a
// start-date tiebreak that only applies when BOTH sides already had a start before this tick.
export function isSameItem(list: PlanList, a: any, b: any): boolean {
  if (!a || !b) return false;
  if (a.sourceText && b.sourceText && isSameishText(a.sourceText, b.sourceText)) return true;
  return list === "searchQueries" ? isSameishText(a.query, b.query) : isSameishText(a.title, b.title);
}

// Settled = written, researched, failed or undone. Only settled rows survive a re-plan, and the
// auto gate only fires on "pending", so carried rows never re-fire.
const isSettled = (item: any) => !!item?.status && item.status !== "pending";

// Rows that exist in Google take refined details (a time added mid-sentence is the same
// appointment) but keep status/ids, so App sees the fingerprint drift and PATCHes. Everything else
// settled wins wholesale: a failure must not retry every tick, and an answer has nothing to sync.
const REFINABLE = new Set(["scheduled", "created"]);

// Incoming plan over previous plan. Incoming order is kept, so the list doesn't reshuffle per tick.
// ponytail: O(n²) identity scans — fine at brain-dump sizes (tens of rows); bucket by normalized
// title first if plans ever reach hundreds.
export function mergeList<T>(list: PlanList, incoming: T[], prev: T[]): T[] {
  const carried = new Set<T>();
  const merged: any[] = [];

  for (const raw of incoming) {
    // An absent field (a due date not mentioned this tick) must not erase the one already known.
    const item = Object.fromEntries(Object.entries(raw as any).filter(([, v]) => v !== undefined));
    const match: any = prev.find(p => !carried.has(p) && isSettled(p) && isSameItem(list, p, item));
    if (match) carried.add(match);
    const row = !match ? { ...item, status: "pending" }
      : REFINABLE.has(match.status) ? { ...match, ...item, status: match.status }
      : { ...item, ...match };
    if (!merged.some(m => isSameItem(list, m, row))) merged.push(row);
  }

  // A long transcript makes the classifier drop earlier items out of its plan entirely. A settled row
  // must not vanish (taking its Undo handle with it) just because this tick stopped mentioning it.
  for (const p of prev) {
    if (isSettled(p) && !carried.has(p) && !merged.some(m => isSameItem(list, m, p))) merged.push(p);
  }

  return merged as T[];
}

// ponytail: self-check pins re-plan merging. Run: tsx src/utils/plan-merge.ts
// No node imports — this module ships to the browser, so the check uses a plain throw like autonomy.ts.
if (typeof process !== "undefined" && process.argv[1]?.endsWith("plan-merge.ts")) {
  const eq = (got: unknown, want: unknown, msg: string) => {
    const g = JSON.stringify(got), w = JSON.stringify(want);
    if (g !== w) throw new Error(`${msg}: want ${w}, got ${g}`);
  };

  // ── identity: one dentist appointment described across three live ticks is ONE item ───────────
  // The old rule ANDed title similarity with `existing.start === evt.start`, so each tick that added
  // a detail pushed a new entry — and with autonomy on, each entry became a real calendar event.
  const t1 = { title: "Dentist Appointment", start: "", sourceText: "I have a dentist appointment" };
  const t2 = { title: "Dentist Appointment", start: "2026-08-22T09:00:00", sourceText: "I have a dentist appointment at 9am Saturday" };
  const t3 = { title: "Dentist Appointment in San Francisco", start: "2026-08-22T09:00:00", sourceText: "I have a dentist appointment at 9am Saturday in San Francisco" };
  eq(isSameItem("calendarEvents", t1, t2), true, "gaining a start time split the event");
  eq(isSameItem("calendarEvents", t2, t3), true, "gaining a location split the event");
  eq(isSameItem("calendarEvents", t1, t3), true, "first mention and fully-specified event must be one item");
  eq(isSameItem("calendarEvents", t2, { title: "Team Standup", start: t2.start, sourceText: "standup at 9" }), false,
     "unrelated events sharing a start merged");
  eq(isSameItem("tasks", { title: "Sweep the floor" }, { title: "Mop the floor" }), false, "distinct chores merged");
  eq(isSameItem("tasks", { title: "Sweep the floor" }, { title: "Sweep the kitchen floor" }), true, "refined chore split");
  eq(isSameItem("searchQueries", { query: "best sushi in SF" }, { query: "best ramen in SF" }), false, "distinct queries merged");
  eq(isSameItem("searchQueries", { query: "who designed the Concorde" }, { query: "who designed the Concorde jet" }), true,
     "refined query split");
  eq(isSameItem("calendarEvents", { title: "Coffee with Bob", sourceText: "grab coffee w/ bob" },
                                  { title: "Catch-up", sourceText: "grab coffee w/ bob" }), true, "verbatim sourceText ignored");
  eq(isSameItem("calendarEvents", { title: "A", sourceText: "" }, { title: "B", sourceText: "" }), false, "empty sourceText matched");

  // ── calendar: an approved event survives a re-plan and takes the refined details ──────────────
  const scheduled = { sourceText: "lunch with Dana on Friday", title: "Lunch with Dana",
                      start: "2026-08-21T12:00:00.000Z", end: "2026-08-21T13:00:00.000Z",
                      status: "scheduled", eventId: "evt-1", synced: "fp" };
  const replanned = { sourceText: "lunch with dana on friday", title: "Lunch with Dana (Friday)",
                      start: "2026-08-21T12:30:00.000Z", end: "2026-08-21T13:30:00.000Z" };
  const cal = mergeList("calendarEvents", [replanned], [scheduled]);
  eq(cal.length, 1, "re-plan duplicated an approved event");
  eq((cal[0] as any).status, "scheduled", "approved event reverted to pending");
  eq((cal[0] as any).eventId, "evt-1", "lost the id Undo deletes by");
  eq((cal[0] as any).synced, "fp", "lost the fingerprint that detects a refinement to PATCH");
  eq([(cal[0] as any).title, (cal[0] as any).start], [replanned.title, replanned.start], "refinement didn't reach the booked row");

  // "actually it's Monday" is a reschedule, not a second standup
  const moved = mergeList("calendarEvents",
    [{ title: "Standup", start: "2026-08-25T09:00:00.000Z" }],
    [{ title: "Standup", start: "2026-08-21T09:00:00.000Z", status: "scheduled", eventId: "evt-2" }] as any);
  eq(moved.map((e: any) => [e.start, e.status, e.eventId]), [["2026-08-25T09:00:00.000Z", "scheduled", "evt-2"]],
     "reschedule to another day split the event");

  // ── tasks: a logged to-do keeps its id and takes the new wording; an untouched one is replaced ─
  const tasks = mergeList("tasks",
    [{ title: "Call the plumber", notes: "re: the leak", dueDate: undefined }, { title: "Buy milk", notes: "" }],
    [{ title: "Call plumber", notes: "", dueDate: "2026-08-21", status: "created", taskId: "task-1" },
     { title: "Buy milk", notes: "old", status: "pending" }] as any);
  eq(tasks.length, 2, "task list changed size");
  eq((tasks[0] as any).taskId, "task-1", "logged to-do lost its Google id");
  eq([(tasks[0] as any).title, (tasks[0] as any).notes], ["Call the plumber", "re: the leak"], "created row didn't take the refinement");
  eq((tasks[0] as any).dueDate, "2026-08-21", "a due date absent this tick erased the known one");
  eq((tasks[1] as any).notes, "", "pending row should take the incoming version");
  // near-miss guard: distinct short titles that share a verb must NOT merge
  eq(mergeList("tasks", [{ title: "Call dentist" }], [{ title: "Call plumber", status: "created", taskId: "t" }] as any).length,
     2, "merged two different short tasks");
  eq(mergeList("tasks", [{ title: "Water the plants" }], [{ title: "Call plumber", status: "pending" }] as any)
      .map((t: any) => t.title), ["Water the plants"], "a stale PENDING row must not be carried");

  // ── searches: a completed answer is never re-fetched, even after the query is reworded ────────
  const done = { query: "who designed the Concorde", status: "completed",
                 answer: "A joint Sud Aviation / BAC team.", condensed: "Sud Aviation and BAC.",
                 sources: [{ uri: "https://example.com", title: "Concorde" }] };
  const search = mergeList("searchQueries", [{ query: "Who designed the Concorde?" }] as any[], [done] as any[]);
  eq(search.length, 1, "reworded query re-queued an answered search");
  eq((search[0] as any).answer, done.answer, "completed search lost its answer");
  eq((search[0] as any).sources, done.sources, "completed search lost its sources");

  // ── a settled row the classifier stopped emitting is carried, a pending one is not ────────────
  const dropped = mergeList("searchQueries", [{ query: "what time is the ferry" }] as any[], [done] as any[]);
  eq(dropped.length, 2, "dropped a completed search the new plan omitted");
  eq((dropped[1] as any).status, "completed", "carried row lost its status");

  // ── failures keep their error on screen and stay failed (re-arming would retry every tick) ────
  const failed = mergeList("tasks", [{ title: "Renew passport" }],
    [{ title: "Renew passport", status: "failed", error: "403" }] as any);
  eq([(failed[0] as any).status, (failed[0] as any).error], ["failed", "403"], "failed row lost its error");

  // ── an undone row stays undone across re-plans, or auto mode would re-create it next tick ─────
  eq(mergeList("calendarEvents", [{ title: "Dentist" }], [{ title: "Dentist", status: "undone" }] as any)
      .map((e: any) => e.status), ["undone"], "re-plan re-armed an undone event");

  // ── unrelated items are never merged, and an empty previous plan is a plain pass-through ──────
  eq(mergeList("tasks", [{ title: "Renew passport" }], [{ title: "Book flights", status: "created" }] as any).length,
     2, "merged two unrelated tasks");
  eq(mergeList("tasks", [{ title: "Renew passport" }], []).map((t: any) => t.status), ["pending"],
     "first plan of a session must come through pending");

  // ── one settled row can only be claimed once, so a repeated item can't clone its id ───────────
  const twice = mergeList("tasks", [{ title: "Send invoice" }, { title: "Send invoice" }],
    [{ title: "Send invoice", status: "created", taskId: "task-9" }] as any);
  eq(twice.length, 1, "duplicate incoming rows should collapse");
  eq((twice[0] as any).taskId, "task-9", "the surviving row should be the created one");

  console.log("plan-merge self-check ✓");
}
