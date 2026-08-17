// Deterministic helpers pulled out of server.ts so they can be unit-tested without booting the
// HTTP server. No LLM, no network — run the self-check with: tsx server-utils.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as chrono from "chrono-node";

// Coerce a model's raw text into parseable JSON: strip code fences, keep the outermost {...},
// drop trailing commas. Returns "{}" for empty input. Text with NO object passes through unchanged
// so the upstream JSON.parse throws (a loud 500) rather than silently swallowing output as empty {}.
export function cleanJsonString(rawText: string): string {
  if (!rawText) return "{}";
  let text = rawText.trim();
  if (text.startsWith("```")) {
    text = text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  }
  const objStart = text.indexOf("{");
  const objEnd = text.lastIndexOf("}");
  if (objStart !== -1 && objEnd !== -1 && objEnd > objStart) {
    text = text.slice(objStart, objEnd + 1);
  }
  text = text.replace(/,\s*([}\]])/g, "$1");
  return text;
}

// Split a grounded search answer into a 1-2 sentence condensed tier and a fuller in-depth tier.
// Parses CONDENSED:/DETAILED: markers; falls back to first-sentence / whole-text if the model
// ignores the format (grounding can't be combined with a JSON responseSchema, so we parse text).
export function splitTiers(raw: string): { condensed: string; inDepth: string } {
  const text = (raw || "").trim();
  const cond = text.match(/CONDENSED:\s*([\s\S]*?)(?:\n\s*DETAILED:|$)/i);
  const det = text.match(/DETAILED:\s*([\s\S]*)$/i);
  const condensed = (cond?.[1]?.trim()) || text.split(/(?<=[.!?])\s+/)[0] || text;
  const inDepth = (det?.[1]?.trim()) || text;
  return { condensed, inDepth };
}

// sessionId arrives in an unauthenticated request body and becomes a path segment, so anything
// that isn't [A-Za-z0-9_-] is stripped — "../../etc" must not escape the memory-capture directory.
// Exported so memory.ts's captureMemoryEvent can guard sessionId the same way.
export const safeSeg = (s: unknown, fallback: string) =>
  (typeof s === "string" ? s : "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64) || fallback;

// Zero-padded UTC bucket path: {YYYY}/{MM}/{DD}/{HH}, computed server-side from the write instant
// (never a client-supplied timestamp, so it can't be steered into an arbitrary path). Used by
// memory.ts's captureMemoryEvent.
const pad = (n: number) => String(n).padStart(2, "0");
export function hourBucket(d: Date): string {
  return path.join(String(d.getUTCFullYear()), pad(d.getUTCMonth() + 1), pad(d.getUTCDate()), pad(d.getUTCHours()));
}



// Drop calendar events with a missing/blank/placeholder start (the client only filters on title).
function filterValidCalendarEvents(events: any): any[] {
  if (!Array.isArray(events)) return [];
  return events.filter(evt =>
    evt?.start && String(evt.start).trim() !== "" && !String(evt.start).includes("undefined")
  );
}

// Deterministically resolve the date/time in a natural-language phrase against a reference time.
// The model reliably understands WHICH day a phrase means but is unreliable at the calendar
// arithmetic (named weekdays especially: "by Friday" -> today, "this coming Friday" -> a Saturday).
// forwardDate:true pushes bare weekdays into the future. hour/minute are null unless the phrase
// stated a time, so callers keep the model's time-of-day otherwise. Returns null when no date found.
interface ResolvedDate {
  date: string;
  hour: number | null;
  minute: number | null;
  endDate?: string | null;
  endHour?: number | null;
  endMinute?: number | null;
}
function resolveDate(phrase: string, referenceISO: string): ResolvedDate | null {
  if (!phrase) return null;
  const ref = new Date(referenceISO);
  const parsed = chrono.parse(phrase, isNaN(ref.getTime()) ? new Date() : ref, { forwardDate: true })[0];
  const c = parsed?.start;
  if (!c) return null;
  const y = c.get("year"), mo = c.get("month"), d = c.get("day");
  if (y == null || mo == null || d == null) return null;
  const timed = c.isCertain("hour");

  let endDate: string | null = null;
  let endHour: number | null = null;
  let endMinute: number | null = null;
  if (parsed.end) {
    const ey = parsed.end.get("year") ?? y;
    const emo = parsed.end.get("month") ?? mo;
    const ed = parsed.end.get("day") ?? d;
    endDate = `${ey}-${pad(emo)}-${pad(ed)}`;
    if (parsed.end.isCertain("hour")) {
      endHour = parsed.end.get("hour");
      endMinute = parsed.end.get("minute") ?? 0;
    }
  }

  return {
    date: `${y}-${pad(mo)}-${pad(d)}`,
    hour: timed ? c.get("hour") : null,
    minute: timed ? (c.get("minute") ?? 0) : null,
    endDate,
    endHour,
    endMinute,
  };
}

// import.meta.url is empty in the esbuild CJS bundle, so self-checks stay dev-only (prod boot would crash on fileURLToPath(undefined)).
// Deterministic date pass over a raw classifier plan, in place. The model reliably picks WHICH day
// a phrase means but is unreliable at the arithmetic, so start/dueDate get re-resolved from the
// verbatim sourceText via chrono; the model's value survives when the phrase carries no date.
// Time-of-day comes from chrono only when the phrase stated one, else the model's, else 09:00.
export function resolvePlanDates(plan: any, refISO: string): any {
  for (const evt of plan?.calendarEvents || []) {
    const r = resolveDate(evt.sourceText || "", refISO);
    if (!r) continue;
    const timeOfDay = evt.allDay ? "00:00:00"
      : r.hour != null ? `${pad(r.hour)}:${pad(r.minute ?? 0)}:00`
      : (String(evt.start || "").match(/T(\d{2}:\d{2}:\d{2})/)?.[1] ?? "09:00:00");
    evt.start = `${r.date}T${timeOfDay}`;
    if (evt.allDay) {
      evt.end = `${r.endDate || r.date}T00:00:00`;
    } else if (r.endHour != null) {
      // Explicit end time resolved from sourceText via chrono (e.g. "from 8am to 5pm", "8:00 AM - 5:00 PM")
      const endDate = r.endDate || r.date;
      evt.end = `${endDate}T${pad(r.endHour)}:${pad(r.endMinute ?? 0)}:00`;
    } else if (evt.end && String(evt.end).match(/T(\d{2}:\d{2}:\d{2})/)) {
      // If the model supplied a distinct end time, respect it relative to the resolved date
      const modelEndTime = String(evt.end).match(/T(\d{2}:\d{2}:\d{2})/)?.[1];
      const modelStartTime = String(evt.start || "").match(/T(\d{2}:\d{2}:\d{2})/)?.[1];
      if (modelEndTime && modelStartTime && modelEndTime !== modelStartTime) {
        evt.end = `${r.date}T${modelEndTime}`;
      } else {
        const e = new Date(evt.start); e.setMinutes(e.getMinutes() + 30);
        evt.end = `${e.getFullYear()}-${pad(e.getMonth() + 1)}-${pad(e.getDate())}T${pad(e.getHours())}:${pad(e.getMinutes())}:00`;
      }
    } else {
      const e = new Date(evt.start); e.setMinutes(e.getMinutes() + 30); // fallback: +30min default when no end time is specified
      evt.end = `${e.getFullYear()}-${pad(e.getMonth() + 1)}-${pad(e.getDate())}T${pad(e.getHours())}:${pad(e.getMinutes())}:00`;
    }
  }
  for (const task of plan?.tasks || []) {
    if (!task.dueDate) continue; // model saw no deadline -> don't invent one from a stray date token
    const r = resolveDate(task.sourceText || "", refISO);
    if (r) task.dueDate = r.date;
  }
  // Drop calendar events with a missing/placeholder start time (the client only filters on title).
  if (plan?.calendarEvents) plan.calendarEvents = filterValidCalendarEvents(plan.calendarEvents);
  return plan;
}

// Token estimation: ~3.8 chars/token for English conversational text and JSON
export function estimateTokens(text: string): number {
  if (!text) return 0;
  const trimmed = text.trim();
  if (!trimmed) return 0;
  const words = trimmed.split(/\s+/).filter(Boolean).length;
  const byChars = Math.ceil(trimmed.length / 3.8);
  const byWords = Math.ceil(words * 1.3);
  return Math.max(1, Math.round((byChars + byWords) / 2));
}

export interface CompactionMetrics {
  rawTokens: number;
  compactedTokens: number;
  savedTokens: number;
  ratioPercent: number;
}

// Computes the compression ratio of rolling live notes vs raw speech
export function computeCompaction(rawText: string, summaryText: string): CompactionMetrics {
  const rawTokens = estimateTokens(rawText);
  const compactedTokens = estimateTokens(summaryText);
  const savedTokens = Math.max(0, rawTokens - compactedTokens);
  const ratioPercent = rawTokens > 0
    ? Math.max(0, Math.min(99.9, Number(((savedTokens / rawTokens) * 100).toFixed(1))))
    : 0;
  return { rawTokens, compactedTokens, savedTokens, ratioPercent };
}

if (import.meta.url && process.argv[1] === fileURLToPath(import.meta.url)) (async () => {
  // Token estimation & Compaction self-check
  assert.equal(estimateTokens(""), 0);
  assert.ok(estimateTokens("Hello world, this is a test prompt for token estimation.") >= 8);
  const comp = computeCompaction(
    "We spent the last twenty minutes talking about the upcoming product roadmap and discussing whether we should build a new dashboard. Alice said she would make mockups, and Bob said he would review the backend APIs.",
    "* Alice to make dashboard mockups\n* Bob to review backend APIs"
  );
  assert.ok(comp.rawTokens > comp.compactedTokens);
  assert.ok(comp.ratioPercent > 50);
  // cleanJsonString — happy / sad / edge
  assert.equal(cleanJsonString('```json\n{"a":1}\n```'), '{"a":1}');           // fenced
  assert.equal(cleanJsonString(""), "{}");                                      // empty -> {}
  assert.throws(() => JSON.parse(cleanJsonString("totally not json")));         // no object -> stays invalid, surfaces as a 500 (not silent {})
  assert.deepEqual(JSON.parse(cleanJsonString('{"a":1,}')), { a: 1 });          // trailing comma
  assert.deepEqual(JSON.parse(cleanJsonString('Here you go: {"a":1} thanks!')), { a: 1 }); // prose around

  // splitTiers — markers vs fallback
  const t1 = splitTiers("CONDENSED: A short answer.\nDETAILED: One. Two. Three. Four.");
  assert.equal(t1.condensed, "A short answer.");
  assert.ok(t1.inDepth.startsWith("One."));
  const t2 = splitTiers("No markers at all. A second sentence follows.");
  assert.equal(t2.condensed, "No markers at all.");
  assert.ok(t2.inDepth.includes("second sentence"));

  // filterValidCalendarEvents — keeps only real starts
  assert.equal(filterValidCalendarEvents([{ start: "2026-01-01T09:00" }, { start: "" }, { start: "x undefined y" }, {}]).length, 1);
  assert.deepEqual(filterValidCalendarEvents(undefined), []);
  assert.deepEqual(filterValidCalendarEvents(null), []);

  // resolveDate — deterministic date math from NL phrases (ref = Saturday 2026-06-27), no model needed
  const R = "2026-06-27T09:00:00";
  assert.equal(resolveDate("Don't forget the birthday is this coming Friday", R)?.date, "2026-07-03"); // was model's 07-04 (a Sat)
  assert.equal(resolveDate("submit the reimbursement form by Friday", R)?.date, "2026-07-03");         // was model's 06-27 (today)
  assert.equal(resolveDate("Lunch with Sam this coming Tuesday at 12:30", R)?.date, "2026-06-30");     // was model's 07-07
  const tmrw = resolveDate("Tomorrow at 3pm I'm calling grandmother", R);
  assert.equal(tmrw?.date, "2026-06-28"); assert.equal(tmrw?.hour, 15);                                // explicit time kept
  const three = resolveDate("dentist appointment in three days at 10 in the morning", R);
  assert.equal(three?.date, "2026-06-30"); assert.equal(three?.hour, 10);
  assert.equal(resolveDate("water my plants today", R)?.hour, null);                                   // no stated time -> null (keep model's)
  assert.equal(resolveDate("I want to organize my life better", R), null);                             // no date -> null (leave model alone)

  // resolvePlanDates — the whole pass, as /api/analyze and /api/live both run it
  const plan = resolvePlanDates({
    calendarEvents: [
      { title: "Dentist", sourceText: "dentist tomorrow at 3pm", start: "2026-01-01T09:00:00", allDay: false },
      { title: "Yosemite", sourceText: "driving to Yosemite tomorrow", start: "2026-01-01T00:00:00", allDay: true },
      { title: "Vague", sourceText: "someday we should meet", start: "2026-06-29T11:00:00", allDay: false },
      { title: "Placeholder", sourceText: "no date here", start: "" },
      { title: "Recording", sourceText: "Official recording session from 8:00 AM to 5:00 PM on Friday", start: "2026-01-01T08:00:00", allDay: false },
    ],
    tasks: [
      { title: "Passport", sourceText: "renew my passport by Friday", dueDate: "2026-01-01" },
      { title: "Open-ended", sourceText: "water the plants sometime", dueDate: "" },
    ],
  }, R);
  assert.equal(plan.calendarEvents[0].start, "2026-06-28T15:00:00");   // stated time honored
  assert.equal(plan.calendarEvents[0].end, "2026-06-28T15:30:00");     // +30min default
  assert.equal(plan.calendarEvents[1].start, "2026-06-28T00:00:00");   // all-day pinned to midnight
  assert.equal(plan.calendarEvents[1].end, "2026-06-28T00:00:00");
  assert.equal(plan.calendarEvents[2].start, "2026-06-29T11:00:00");   // no date in phrase -> model's value kept
  assert.equal(plan.calendarEvents[3].start, "2026-07-03T08:00:00");   // Friday 8am to 5pm start
  assert.equal(plan.calendarEvents[3].end, "2026-07-03T17:00:00");     // Friday 8am to 5pm end
  assert.equal(plan.calendarEvents.length, 4);                          // blank start dropped
  assert.equal(plan.tasks[0].dueDate, "2026-07-03");                    // "by Friday" re-resolved
  assert.equal(plan.tasks[1].dueDate, "");                              // no deadline -> not invented
  assert.deepEqual(resolvePlanDates({}, R), {});                        // empty plan is a no-op

  assert.equal(hourBucket(new Date(Date.UTC(2026, 0, 5, 9))), path.join("2026", "01", "05", "09"));
  assert.equal(hourBucket(new Date(Date.UTC(2026, 10, 30, 23))), path.join("2026", "11", "30", "23"));



  console.log("server-utils self-check ✓");
})();
