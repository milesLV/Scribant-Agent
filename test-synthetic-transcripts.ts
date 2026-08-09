// A second integration pass, alongside test-memory-capture.ts: instead of short canned strings
// ("buy milk"), this runs a few longer, rambling, realistic "brain dump" transcripts through the
// FULL pipeline (proofread -> summarize -> classify via /api/live, then finalize via /api/analyze)
// to exercise transcript generation more thoroughly, and to confirm the reshaped actionItems
// capture format (memory.ts) — text and actionItems in the SAME record — lands correctly
// end-to-end for real model output, not just the hand-built fixtures in memory.ts's own
// self-check. Needs a running dev server and spends real Gemini calls (~4 per transcript: 1 live
// tick = proof+summary+plan, 1 finalize = plan). Not part of `npm run check` for that reason:
//
//   npm run dev                                  # terminal 1
//   npx tsx test-synthetic-transcripts.ts        # terminal 2 (override with EVAL_BASE_URL)
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { hourBucket } from "./server-utils";

const BASE = process.env.EVAL_BASE_URL || "http://localhost:3000";

// ONE file per session — text + actionItems both live in the memory capture record now.
const memoryFile = (sessionId: string) =>
  path.join(process.cwd(), "data", "memory", hourBucket(new Date()), `${sessionId}.jsonl`);

async function postLive(body: Record<string, unknown>): Promise<void> {
  const res = await fetch(BASE + "/api/live", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  if (!res.ok || !res.body) throw new Error(`/api/live -> ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const reader = res.body.getReader();
  for (;;) { const { done } = await reader.read(); if (done) break; }
}

// Three rambling, realistic brain-dumps: run-on sentences, filler ("um", "like"), missing
// punctuation and stray lowercase for the proofreader to clean up, plus at least one todo, one
// calendar event, and one research query each — the three categories that now nest under
// actionItems in the capture file.
const TRANSCRIPTS: { name: string; text: string }[] = [
  {
    name: "kitchen-remodel",
    text: `okay so the kitchen thing, um, where do I start. contractor Dave said he can swing by thursday at 2pm to walk through the space before he quotes anything, so I need to be home for that. things I still need to buy — grout for the backsplash tile, and I think two more boxes of the actual tile because I measured wrong the first time, and a new faucet because the old one drips. also gotta call the appliance place about the sink, they said they'd have one in stock but I never confirmed. one thing I want to look up later is what flooring actually holds up best in a kitchen when you've got a dog that sheds everywhere, because I keep going back and forth between tile and that vinyl plank stuff and I genuinely don't know which one is more durable. anyway thursday is the big one, gotta clear my afternoon for that.`,
  },
  {
    name: "camping-trip",
    text: `alright camping trip planning, we're leaving friday morning, like the whole day is basically shot to driving and setting up so may as well block off friday entirely. need to buy a new propane canister cause I used the last one in the spring, and I gotta pack the sleeping bags today or tomorrow so they're not a last minute scramble, also the tent has a busted zipper on the rain fly so I should either fix that or just tape over it honestly. quick thing to search later, what's actually the best bug spray for mosquitoes when it's humid out, because the stuff we used last year barely did anything and I got eaten alive. also should text everyone the packing list so nobody forgets a sleeping pad again like last time.`,
  },
  {
    name: "job-interview",
    text: `okay interview prep, the actual interview is tuesday at 10am so I've got a few days. I need to print like three copies of my resume just in case, and iron that blue button-down because it's been sitting in the closet wrinkled forever, and I really need to prep answers for the behavioral questions, like the whole tell me about a time you dealt with conflict thing, I always blank on those. one thing I keep meaning to look up is the average salary range for a senior product manager role in austin, because I have no idea what to say if they ask my expectations and I don't want to lowball myself. gotta get all this done before tuesday, no more procrastinating on the resume copies especially.`,
  },
];

function assertActionItems(record: any, label: string) {
  assert.ok(record.actionItems, `${label}: expected actionItems on the captured record`);
  const { todos, calendarEvents, searchQueries } = record.actionItems;
  assert.ok(Array.isArray(todos) && Array.isArray(calendarEvents) && Array.isArray(searchQueries),
    `${label}: actionItems.{todos,calendarEvents,searchQueries} must all be arrays`);
  assert.ok(!("tasks" in record) && !("plan" in record),
    `${label}: flat "tasks"/"plan" keys should not survive the reshape`);
}

async function runOne({ name, text }: { name: string; text: string }) {
  const sessionId = `test-synth-${name}-${Date.now()}`;

  // One live tick — proofread + summarize + classify — mirrors what a real dictation tick sends.
  await postLive({ text, currentLocalTime: new Date().toISOString(), liveSummary: "", withPlan: true, sessionId });
  const mFile = memoryFile(sessionId);
  assert.ok(fs.existsSync(mFile), `${name}: expected autosaved memory capture at ${mFile}`);
  const liveCapture = JSON.parse(fs.readFileSync(mFile, "utf8").trim());
  assert.equal(liveCapture.content.parts[0].text, text, `${name}: raw text should be in the same record as actionItems`);
  assertActionItems(liveCapture, `${name} (live tick)`);

  // Finalize — overwrites the same session file, should still be exactly 1 line.
  const res = await fetch(BASE + "/api/analyze", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, currentLocalTime: new Date().toISOString(), liveSummary: "", sessionId }),
  });
  if (!res.ok) throw new Error(`/api/analyze -> ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const finalCapture = JSON.parse(fs.readFileSync(mFile, "utf8").trim());
  assertActionItems(finalCapture, `${name} (finalize)`);
  assert.equal(fs.readFileSync(mFile, "utf8").trim().split("\n").length, 1, `${name}: memory file should stay 1 line`);

  const { todos, calendarEvents, searchQueries } = finalCapture.actionItems;
  console.log(`${name} ✓  todos=${todos.length} calendarEvents=${calendarEvents.length} searchQueries=${searchQueries.length}`);
  if (!todos.length) console.warn(`  ! ${name}: expected at least one todo, got none`);
  if (!calendarEvents.length) console.warn(`  ! ${name}: expected at least one calendar event, got none`);
  if (!searchQueries.length) console.warn(`  ! ${name}: expected at least one search query, got none`);

  return { sessionId, mFile };
}

async function main() {
  const written: { sessionId: string; mFile: string }[] = [];
  try {
    for (const t of TRANSCRIPTS) written.push(await runOne(t));
    console.log(`\nsynthetic transcript pipeline ✓ (${TRANSCRIPTS.length}/${TRANSCRIPTS.length} passed)`);
  } finally {
    // These are throwaway test-* sessions, not real dictation — clean up so they don't linger in
    // data/ the way an earlier probe file once did.
    for (const { mFile } of written) if (fs.existsSync(mFile)) fs.rmSync(mFile);
    console.log(`cleaned up ${written.length} test session file(s)`);
  }
}

main().catch(e => { console.error("synthetic transcript test ✗", e); process.exitCode = 1; });
