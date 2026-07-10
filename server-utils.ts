// Pure, deterministic helpers pulled out of server.ts so they can be unit-tested without
// booting the HTTP server. No LLM, no network — run the self-check with: tsx server-utils.ts
import assert from "node:assert/strict";
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

// Drop calendar events with a missing/blank/placeholder start (the client only filters on title).
export function filterValidCalendarEvents(events: any): any[] {
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
interface ResolvedDate { date: string; hour: number | null; minute: number | null; }
export function resolveDate(phrase: string, referenceISO: string): ResolvedDate | null {
  if (!phrase) return null;
  const ref = new Date(referenceISO);
  const c = chrono.parse(phrase, isNaN(ref.getTime()) ? new Date() : ref, { forwardDate: true })[0]?.start;
  if (!c) return null;
  const y = c.get("year"), mo = c.get("month"), d = c.get("day");
  if (y == null || mo == null || d == null) return null;
  const pad = (n: number) => String(n).padStart(2, "0");
  const timed = c.isCertain("hour");
  return { date: `${y}-${pad(mo)}-${pad(d)}`, hour: timed ? c.get("hour") : null, minute: timed ? (c.get("minute") ?? 0) : null };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) (async () => {
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

  console.log("server-utils self-check ✓");
})();
