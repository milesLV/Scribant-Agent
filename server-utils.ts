// Deterministic server helpers — no LLM, no network. Self-check: tsx server-utils.ts
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as chrono from "chrono-node";

// Coerce a model's raw text into parseable JSON: keep the outermost {...} (which also drops code
// fences and prose), drop trailing commas. "{}" for empty input. Text with NO object passes through
// so JSON.parse throws (a loud 500) rather than silently swallowing output as {}.
export function cleanJsonString(rawText: string): string {
  if (!rawText) return "{}";
  let text = rawText.trim();
  const objStart = text.indexOf("{"), objEnd = text.lastIndexOf("}");
  if (objStart !== -1 && objEnd > objStart) text = text.slice(objStart, objEnd + 1);
  return text.replace(/,\s*([}\]])/g, "$1");
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

// Request-supplied ids become path segments: strip anything outside [A-Za-z0-9_-] so "../../etc"
// cannot escape the memory-capture directory.
export const safeSeg = (s: unknown, fallback: string) =>
  (typeof s === "string" ? s : "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64) || fallback;

// Zero-padded UTC {YYYY}/{MM}/{DD}/{HH} from the server's write instant (never a client timestamp,
// so it can't be steered into an arbitrary path).
const pad = (n: number) => String(n).padStart(2, "0");
export function hourBucket(d: Date): string {
  return path.join(String(d.getUTCFullYear()), pad(d.getUTCMonth() + 1), pad(d.getUTCDate()), pad(d.getUTCHours()));
}

// Resolve the date/time in a phrase against a reference time. forwardDate pushes bare weekdays into
// the future; hour/minute are null unless the phrase stated a time. null when no day is pinned.
// meridiemKnown is false for "at 2:00" (chrono guessed AM, see pickHour).
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
function resolveDate(phrase: string, referenceISO: string) {
  if (!phrase) return null;
  const ref = new Date(referenceISO);
  const now = isNaN(ref.getTime()) ? new Date() : ref;

  // chrono reads "the month" as "a month from now"; "end of the week/month" means its last (work)day.
  const end = phrase.match(/\bend of (?:the |this |next )?(week|month)\b/i);
  if (end) {
    const next = /\bnext\b/i.test(end[0]);
    const d = new Date(now);
    if (end[1].toLowerCase() === "month") d.setMonth(d.getMonth() + (next ? 2 : 1), 0);
    else d.setDate(d.getDate() + ((5 - d.getDay() + 7) % 7) + (next ? 7 : 0)); // Friday
    return { date: ymd(d), hour: null, minute: null, endDate: null, endHour: null, endMinute: null, meridiemKnown: false };
  }

  const parsed = chrono.parse(phrase, now, { forwardDate: true })[0];
  const c = parsed?.start;
  if (!c) return null;
  // A bare unit ("next month") pins no day; chrono just echoes today's day-of-month. Keep the model's.
  if (!c.isCertain("day") && !c.isCertain("weekday")) return null;
  const y = c.get("year"), mo = c.get("month"), d = c.get("day");
  if (y == null || mo == null || d == null) return null;
  const timed = c.isCertain("hour");

  const e = parsed.end, endTimed = !!e?.isCertain("hour");
  return {
    date: `${y}-${pad(mo)}-${pad(d)}`,
    hour: timed ? c.get("hour") : null,
    minute: timed ? (c.get("minute") ?? 0) : null,
    endDate: e ? `${e.get("year") ?? y}-${pad(e.get("month") ?? mo)}-${pad(e.get("day") ?? d)}` : null,
    endHour: endTimed ? e!.get("hour") : null,
    endMinute: endTimed ? (e!.get("minute") ?? 0) : null,
    meridiemKnown: c.isCertain("meridiem"),
  };
}

// "at 2:00" carries no AM/PM and chrono defaults to AM. Prefer the model's reading when it names the
// same clock hour; otherwise assume 1–6 means afternoon.
// ponytail: fixed 1–6 → PM heuristic; per-user waking hours if early-morning events show up.
function pickHour(hour: number, meridiemKnown: boolean | undefined, modelTime: string | undefined): number {
  if (meridiemKnown || hour === 0 || hour > 12) return hour;
  const modelHour = modelTime ? Number(modelTime.slice(0, 2)) : NaN;
  if (modelHour % 12 === hour % 12) return modelHour;
  return hour <= 6 ? hour + 12 : hour;
}

// Deterministic date pass over a raw classifier plan, in place. The model reliably picks WHICH day
// a phrase means but is unreliable at the arithmetic, so start/dueDate get re-resolved from the
// verbatim sourceText via chrono; the model's value survives when the phrase carries no date.
// Time-of-day comes from chrono only when the phrase stated one, else the model's, else 09:00.
export function resolvePlanDates(plan: any, refISO: string): any {
  for (const evt of plan?.calendarEvents || []) {
    const r = resolveDate(evt.sourceText || "", refISO);
    if (!r) continue;
    const modelStart = String(evt.start || "").match(/T(\d{2}:\d{2}:\d{2})/)?.[1];
    const startHour = r.hour != null ? pickHour(r.hour, r.meridiemKnown, modelStart) : null;
    const timeOfDay = evt.allDay ? "00:00:00"
      : startHour != null ? `${pad(startHour)}:${pad(r.minute ?? 0)}:00`
      : (modelStart ?? "09:00:00");
    evt.start = `${r.date}T${timeOfDay}`;
    if (evt.allDay) {
      evt.end = `${r.endDate || r.date}T00:00:00`;
    } else if (r.endHour != null) {
      // Explicit end time resolved from sourceText via chrono (e.g. "from 8am to 5pm", "8:00 AM - 5:00 PM")
      const endDate = r.endDate || r.date;
      // "from 2 to 3": an unmarked end follows the start into the afternoon.
      let endHour = r.endHour;
      if (!r.meridiemKnown && startHour != null && startHour >= 12 && endHour < 12) endHour += 12;
      evt.end = `${endDate}T${pad(endHour)}:${pad(r.endMinute ?? 0)}:00`;
    } else {
      // The model's own end time, moved onto the resolved date — else start + 30 min.
      const modelEnd = String(evt.end || "").match(/T(\d{2}:\d{2}:\d{2})/)?.[1];
      const e = new Date(evt.start); e.setMinutes(e.getMinutes() + 30);
      evt.end = modelEnd && modelEnd !== timeOfDay ? `${r.date}T${modelEnd}` : `${ymd(e)}T${pad(e.getHours())}:${pad(e.getMinutes())}:00`;
    }
  }
  for (const task of plan?.tasks || []) {
    if (!task.dueDate) continue; // model saw no deadline -> don't invent one from a stray date token
    const r = resolveDate(task.sourceText || "", refISO);
    if (r) task.dueDate = r.date;
  }
  // Drop events with a missing/placeholder start (the client only filters on title).
  if (plan?.calendarEvents) plan.calendarEvents = (Array.isArray(plan.calendarEvents) ? plan.calendarEvents : [])
    .filter((e: any) => e?.start && String(e.start).trim() && !String(e.start).includes("undefined"));
  return plan;
}

// Token estimate: mean of ~3.8 chars/token and ~1.3 tokens/word.
export function estimateTokens(text: string): number {
  const trimmed = text?.trim();
  if (!trimmed) return 0;
  const byChars = Math.ceil(trimmed.length / 3.8);
  const byWords = Math.ceil(trimmed.split(/\s+/).length * 1.3);
  return Math.max(1, Math.round((byChars + byWords) / 2));
}

// Compression of the rolling live notes vs the raw speech.
export function computeCompaction(rawText: string, summaryText: string) {
  const rawTokens = estimateTokens(rawText);
  const compactedTokens = estimateTokens(summaryText);
  const savedTokens = Math.max(0, rawTokens - compactedTokens);
  const ratioPercent = rawTokens > 0 ? Math.min(99.9, Number(((savedTokens / rawTokens) * 100).toFixed(1))) : 0;
  return { rawTokens, compactedTokens, savedTokens, ratioPercent };
}

// Degraded path only (Cloud STT failed, Gemini transcribed): Gemini's "Speaker N:" labels are
// prompt-derived, unstable between chunks, and seen alternating for one voice — strip them.
// ponytail: numbered labels only; a looser regex would eat "Note:" / "Tomorrow:" openers.
export function stripSpeakerLabels(text: string): string {
  return text.replace(/^[ \t]*Speaker\s*\d+\s*:[ \t]*/gim, "").trim();
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

  // AM/PM-less times and "end of" phrases (ref = Monday 2026-11-16) — all were wrong before
  const N = "2026-11-16T18:00:00";
  const at = (sourceText: string, start = "") =>
    resolvePlanDates({ calendarEvents: [{ title: "x", sourceText, start, allDay: false }] }, N).calendarEvents[0];
  assert.equal(at("reschedule to next Tuesday at 2:00").start, "2026-11-24T14:00:00");            // was 02:00
  assert.equal(at("dinner Saturday at 8", "2026-11-21T20:00:00").start, "2026-11-21T20:00:00");   // model's PM wins
  assert.equal(at("call Saturday at 8").start, "2026-11-21T08:00:00");                            // 7–12 stay AM
  assert.equal(at("lunch tomorrow at 12:30").start, "2026-11-17T12:30:00");
  assert.equal(at("Tuesday at 6am").start, "2026-11-17T06:00:00");                                // stated AM honored
  assert.equal(at("Thursday from 2 to 3").end, "2026-11-19T15:00:00");                            // end follows start to PM
  const due = (sourceText: string) =>
    resolvePlanDates({ tasks: [{ title: "x", sourceText, dueDate: "2026-01-01" }] }, N).tasks[0].dueDate;
  assert.equal(due("It expires at the end of the month"), "2026-11-30");                          // was 12-16
  assert.equal(due("finish by end of next month"), "2026-12-31");
  assert.equal(due("wrap up by the end of the week"), "2026-11-20");                              // Friday, was Mon 11-23
  assert.equal(due("sometime next month"), "2026-01-01");                                         // no day pinned -> model's kept

  assert.equal(hourBucket(new Date(Date.UTC(2026, 0, 5, 9))), path.join("2026", "01", "05", "09"));
  assert.equal(hourBucket(new Date(Date.UTC(2026, 10, 30, 23))), path.join("2026", "11", "30", "23"));

  // Degraded-path label strip: numbered labels go, real sentence openers stay.
  assert.equal(stripSpeakerLabels("Speaker 1: hi\nSpeaker 2: bye"), "hi\nbye");
  assert.equal(stripSpeakerLabels("speaker 12:  spaced out"), "spaced out");
  assert.equal(stripSpeakerLabels("Note: buy milk\nTomorrow: ship it"), "Note: buy milk\nTomorrow: ship it");
  assert.equal(stripSpeakerLabels("Alice: named labels survive"), "Alice: named labels survive");
  assert.equal(stripSpeakerLabels("ask Speaker 1: mid-line stays"), "ask Speaker 1: mid-line stays");

  console.log("server-utils self-check ✓");
})();
