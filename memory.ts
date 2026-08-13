// Phase 1 of the memory engine: THE durable local record for a session — raw transcript text plus
// extracted action items, one file per session, nothing smarter yet. No LLM extraction beyond what
// the intent classifier already produces, no querying. Phase 2 wires this up to Vertex AI Memory
// Bank, which does the fact/preference extraction itself once these records are synced to it (see
// the plan for details). Single-user app, so there's no per-user scoping here. Paired with a
// separate raw-text-only `data/transcripts/` archive (server-utils.ts's logUserTranscript): that
// one is written every 15s straight off the live transcript, independent of this session-level,
// plan-triggered capture, so it survives even if the analyze/plan pipeline never fires.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { safeSeg, hourBucket } from "./server-utils";

// The three item categories the intent classifier extracts (skills.ts), grouped under one
// "actionItems" parent for storage. The live classifier's own output/schema stays FLAT
// ({calendarEvents, tasks, searchQueries} at the top level) — that shape is wired through
// resolvePlanDates, the client UI's per-skill buckets, and the evals, so reshaping it would ripple
// far beyond persistence. This nesting only exists in what gets written to disk.
export interface ActionItems {
  todos: unknown[];         // renamed from the classifier's "tasks" — matches how the UI/user think of them
  calendarEvents: unknown[];
  searchQueries: unknown[];
}

// One finalized session's captured content, close to ADK's MemoryEntry/Event shape so Phase 2 can
// forward it to Memory Bank with minimal translation.
export interface MemoryCapture {
  timestamp: string;
  sessionId: string;
  content: { role: "user"; parts: [{ text: string }] };
  ideasSummary?: string;
  actionItems?: ActionItems;
}

// Reshape the classifier's flat plan ({ideasSummary, calendarEvents, tasks, searchQueries}) into
// the nested {ideasSummary, actionItems: {todos, calendarEvents, searchQueries}} that gets
// persisted. Tolerant of a missing/malformed plan (autosave ticks that skipped the classifier pass
// `plan: undefined`) and of arrays being absent — each category always comes out as an array,
// never undefined, so callers never null-check three different fields.
function toActionItems(plan: any): { ideasSummary?: string; actionItems: ActionItems } | undefined {
  if (!plan || typeof plan !== "object") return undefined;
  return {
    ...(typeof plan.ideasSummary === "string" ? { ideasSummary: plan.ideasSummary } : {}),
    actionItems: {
      todos: Array.isArray(plan.tasks) ? plan.tasks : [],
      calendarEvents: Array.isArray(plan.calendarEvents) ? plan.calendarEvents : [],
      searchQueries: Array.isArray(plan.searchQueries) ? plan.searchQueries : [],
    },
  };
}

// The hour bucket is computed from the WRITE instant, not pinned to a session's first write, so a
// session whose ticks straddle an hour boundary would otherwise land in two different hour
// directories — reintroducing "more than one file per session" via a different trigger than the
// append-vs-overwrite bug captureMemoryEvent was built to fix. Bounded backward walk (not a
// recursive tree scan, which would get slower as the archive grows over months of real usage):
// check the CURRENT hour bucket first, then step back an hour at a time up to `lookbackHours`,
// stopping at the first match. A live-dictation session realistically spans minutes, so one hop
// back covers the normal case; the generous cap is just headroom for an unusually long session.
function findStaleSessionFile(root: string, filename: string, now: Date, keep: string, lookbackHours = 48): string | null {
  for (let hoursBack = 0; hoursBack <= lookbackHours; hoursBack++) {
    const candidate = path.join(root, hourBucket(new Date(now.getTime() - hoursBack * 3_600_000)), filename);
    if (candidate !== keep && fs.existsSync(candidate)) return candidate;
  }
  return null;
}

// Write the latest snapshot of one session's captured content to
// ./data/memory/{YYYY}/{MM}/{DD}/{HH}/{sessionId}.jsonl. `root` exists so the self-check can write
// to a temp dir instead of the repo; `now` likewise exists so the self-check can pin the write
// instant instead of depending on the real clock (see findStaleSessionFile above).
// ponytail: sync overwrite — one file per session, replaced on every live tick and again at
// finalize, so it always holds just the latest text/plan instead of growing a near-duplicate line
// per tick. Move to fs.promises if it ever blocks a request.
export function captureMemoryEvent(
  sessionId: unknown,
  entry: { text: string; plan?: unknown },
  root = path.join(process.cwd(), "data", "memory"),
  now = new Date(),
): string {
  const dir = path.join(root, hourBucket(now));
  fs.mkdirSync(dir, { recursive: true });
  const filename = `${safeSeg(sessionId, "session")}.jsonl`;
  const file = path.join(dir, filename);
  const record: MemoryCapture = {
    timestamp: now.toISOString(),
    sessionId: safeSeg(sessionId, "session"),
    content: { role: "user", parts: [{ text: entry.text }] },
    ...(toActionItems(entry.plan) ?? {}),
  };
  fs.writeFileSync(file, JSON.stringify(record) + "\n", "utf8");

  // Bring the session forward: if an earlier tick left this session's file in an older hour
  // bucket, remove it now that the new bucket holds the up-to-date record — never two files for
  // one session, even across an hour boundary. Done AFTER the new write succeeds, so a failure
  // here never loses data that hasn't been captured somewhere yet.
  const stale = findStaleSessionFile(root, filename, now, file);
  if (stale) {
    fs.rmSync(stale);
    try { fs.rmdirSync(path.dirname(stale)); } catch { /* not empty (other sessions still in that hour) — fine, leave it */ }
  }

  return file;
}

// ponytail: self-check pins the overwrite/traversal/reshape behavior, plus the shrink-not-merge,
// embedded-newline, and hour-boundary bring-forward edge cases above. hourBucket's own date math is
// pinned by server-utils.ts's self-check (single source of truth).
// Run: tsx memory.ts — no API key needed, no model is called.
if (import.meta.url && process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "scribant-memory-"));
  try {
    const escaped = captureMemoryEvent("../../etc", { text: "hi" }, root);
    assert.ok(escaped.startsWith(root + path.sep), `traversal escaped the root: ${escaped}`);
    assert.equal(path.basename(escaped), "etc.jsonl"); // ".." stripped, not the segment itself

    // The classifier's flat plan shape in -> nested actionItems out. "tasks" becomes "todos";
    // calendarEvents/searchQueries keep their names but move under actionItems.
    const flatPlan = {
      ideasSummary: "* buy milk\n* call mom",
      calendarEvents: [{ title: "Dentist" }],
      tasks: [{ title: "Buy milk" }],
      searchQueries: [{ query: "lactose free milk brands" }],
    };
    const file = captureMemoryEvent("run-99", { text: "lunch tomorrow at noon", plan: flatPlan }, root);
    const nested = JSON.parse(fs.readFileSync(file, "utf8").trim()) as MemoryCapture;
    assert.equal(nested.ideasSummary, flatPlan.ideasSummary);
    assert.deepEqual(nested.actionItems, {
      todos: [{ title: "Buy milk" }],
      calendarEvents: [{ title: "Dentist" }],
      searchQueries: [{ query: "lactose free milk brands" }],
    });
    assert.ok(!("plan" in nested), "flat plan should not survive alongside the reshaped fields");

    // A tick with no plan (autosave before the classifier ran) omits actionItems entirely rather
    // than writing three empty arrays every tick.
    const noPlanFile = captureMemoryEvent("run-100", { text: "just talking" }, root);
    assert.ok(!("actionItems" in JSON.parse(fs.readFileSync(noPlanFile, "utf8"))));

    // A plan missing an array (e.g. the model omitted a key) reshapes to [] rather than undefined.
    const partialFile = captureMemoryEvent("run-101", { text: "x", plan: { tasks: [{ title: "t" }] } }, root);
    assert.deepEqual(JSON.parse(fs.readFileSync(partialFile, "utf8")).actionItems, {
      todos: [{ title: "t" }], calendarEvents: [], searchQueries: [],
    });

    captureMemoryEvent("run-99", { text: "and call mom" }, root); // overwrites, never appends
    const lines = fs.readFileSync(file, "utf8").trim().split("\n");
    assert.equal(lines.length, 1, "second capture should replace the first, not grow the file");
    const only = JSON.parse(lines[0]) as MemoryCapture;
    assert.equal(only.content.parts[0].text, "and call mom");
    assert.ok(!("actionItems" in only)); // plan omitted on the second call -> not carried over from the first
    assert.ok(!isNaN(Date.parse(only.timestamp)));

    // Both captures landed in the same hour bucket, so they share a directory (bucketed by
    // capture time, not by call — the second call didn't get its own hour folder).
    assert.equal(path.dirname(file), path.dirname(captureMemoryEvent("run-99", { text: "x" }, root)));

    // A LATER capture with FEWER items must fully replace the earlier actionItems, not merge with
    // them — overwrite semantics apply to the whole record, not a field-by-field union.
    const growFile = captureMemoryEvent("run-shrink", { text: "x", plan: { tasks: [{ title: "a" }, { title: "b" }] } }, root);
    captureMemoryEvent("run-shrink", { text: "x", plan: { tasks: [{ title: "a" }] } }, root);
    assert.deepEqual(JSON.parse(fs.readFileSync(growFile, "utf8")).actionItems.todos, [{ title: "a" }],
      "shrinking plan should fully replace, not merge with, the previous actionItems");

    // Multi-line, quote-containing, unicode text must not break the one-record-per-line JSONL
    // contract — JSON.stringify escapes newlines/quotes within the string value, so the file stays
    // exactly one physical line no matter what the transcript itself contains.
    const trickyText = 'Line one.\nLine "two" has quotes.\n\nEmoji: 🎉 and ünïcödé.';
    const trickyFile = captureMemoryEvent("run-tricky", { text: trickyText }, root);
    const rawLines = fs.readFileSync(trickyFile, "utf8").split("\n").filter(Boolean);
    assert.equal(rawLines.length, 1, "embedded newlines in the transcript must not create extra physical lines");
    assert.equal(JSON.parse(rawLines[0]).content.parts[0].text, trickyText);

    // Hour-boundary crossing: a session's first tick lands in the 8 o'clock bucket, the next tick
    // (same session) two hours later lands in the 10 o'clock bucket — the file must be brought
    // forward, not left behind as an orphaned duplicate.
    const hour8 = new Date(Date.UTC(2026, 0, 5, 8, 59, 58));
    const hour10 = new Date(Date.UTC(2026, 0, 5, 10, 0, 2));
    const fileAt8 = captureMemoryEvent("run-boundary", { text: "first tick, hour 8" }, root, hour8);
    assert.ok(fs.existsSync(fileAt8));
    const fileAt10 = captureMemoryEvent("run-boundary", { text: "second tick, hour 10" }, root, hour10);
    assert.notEqual(fileAt8, fileAt10, "the file should move to the new hour bucket, not sit at a fixed path");
    assert.ok(!fs.existsSync(fileAt8), "the stale hour-8 file should be removed once hour-10 has the up-to-date record");
    assert.ok(fs.existsSync(fileAt10));
    assert.equal(JSON.parse(fs.readFileSync(fileAt10, "utf8")).content.parts[0].text, "second tick, hour 10");
    // The now-empty hour-8 directory (only ever held this one session) is cleaned up too.
    assert.ok(!fs.existsSync(path.dirname(fileAt8)), "an hour bucket left empty by the move should be removed");

    // A third tick nine hours later still finds and removes the (now hour-10) stale copy — proves
    // the backward walk isn't hardcoded to a single hop.
    const hour19 = new Date(Date.UTC(2026, 0, 5, 19, 0, 0));
    const fileAt19 = captureMemoryEvent("run-boundary", { text: "third tick, hour 19" }, root, hour19);
    assert.ok(!fs.existsSync(fileAt10), "a multi-hour gap should still find and remove the stale file");
    assert.ok(fs.existsSync(fileAt19));

    // Different sessions in different hour buckets never interfere with each other's bring-forward
    // logic — only a matching sessionId filename triggers a move.
    const otherSessionFile = captureMemoryEvent("run-other", { text: "unrelated session" }, root, hour8);
    captureMemoryEvent("run-boundary", { text: "fourth tick, hour 19 again" }, root, hour19);
    assert.ok(fs.existsSync(otherSessionFile), "an unrelated session's file must survive another session's bring-forward");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }

  console.log("memory self-check ✓");
}
