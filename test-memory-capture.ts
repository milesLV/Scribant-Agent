// Integration test for the memory-engine baseline: Phase 0 (single-user), Phase 1 (local capture),
// and the live-loop auto-save on top of it. Unlike the ponytail self-checks in
// server-utils.ts/memory.ts (pure functions, no network), this exercises the real routes
// end-to-end — so it needs a running dev server and spends a few real Gemini calls. Not part of
// `npm run check` for that reason; run it by hand after the ponytail self-checks pass:
//
//   npm run dev                              # terminal 1
//   npx tsx test-memory-capture.ts           # terminal 2 (override with EVAL_BASE_URL)
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { hourBucket } from "./server-utils";

const BASE = process.env.EVAL_BASE_URL || "http://localhost:3000";

// ONE file per session now — logUserTranscript/data/transcripts was dropped once memoryFile's
// record already carried the full text, making a second file pure duplication.
const memoryFile = (sessionId: string) =>
  path.join(process.cwd(), "data", "memory", hourBucket(new Date()), `${sessionId}.jsonl`);
const legacyTranscriptFile = (sessionId: string) =>
  path.join(process.cwd(), "data", "transcripts", hourBucket(new Date()), `${sessionId}.jsonl`);
const lastLine = (file: string) => JSON.parse(fs.readFileSync(file, "utf8").trim().split("\n").pop()!);
const lineCount = (file: string) => fs.readFileSync(file, "utf8").trim().split("\n").length;

// Drains an NDJSON /api/live response so its server-side handler (and the autosave that runs after
// it) has actually finished before the test inspects the filesystem.
async function postLive(body: Record<string, unknown>): Promise<void> {
  const res = await fetch(BASE + "/api/live", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  if (!res.ok || !res.body) throw new Error(`/api/live -> ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const reader = res.body.getReader();
  for (;;) { const { done } = await reader.read(); if (done) break; }
}

// Phase 0 + Phase 1: a lone finalize with no prior live ticks. Also the Phase 0 regression check —
// deliberately no `userId` in the body, the route must not require it.
async function testFinalizeOnly() {
  const sessionId = `test-finalize-${Date.now()}`;
  const text = "Remind me to call the dentist tomorrow at 3pm.";

  const res = await fetch(BASE + "/api/analyze", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, currentLocalTime: new Date().toISOString(), liveSummary: "", sessionId }),
  });
  if (!res.ok) throw new Error(`/api/analyze -> ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const plan = await res.json();
  assert.ok(plan && typeof plan === "object", "response should be a plan object");

  const mFile = memoryFile(sessionId);
  assert.ok(fs.existsSync(mFile), `expected memory capture at ${mFile}`);
  assert.ok(!fs.existsSync(legacyTranscriptFile(sessionId)), "a separate transcripts file should no longer be written");

  const memoryLine = lastLine(mFile);
  assert.equal(memoryLine.sessionId, sessionId);
  assert.equal(memoryLine.content.parts[0].text, text);
  // Stored plan is reshaped: tasks/calendarEvents/searchQueries nest under actionItems.
  assert.deepEqual(memoryLine.actionItems, {
    todos: plan.tasks ?? [], calendarEvents: plan.calendarEvents ?? [], searchQueries: plan.searchQueries ?? [],
  });
  assert.equal(memoryLine.ideasSummary, plan.ideasSummary);
  assert.ok(!isNaN(Date.parse(memoryLine.timestamp)));

  console.log("finalize-only capture ✓");
  console.log(`  memory: ${mFile}`);
}

// The live loop: two ticks under the SAME sessionId (as App.tsx now mints once per recording, not
// per finalize) followed by finalize — proving auto-save keeps overwriting ONE session file with
// the latest snapshot rather than appending a new near-duplicate line per tick.
async function testLiveAutosave() {
  const sessionId = `test-live-${Date.now()}`;
  const first = "buy milk";
  const grown = "buy milk and eggs tomorrow morning";

  await postLive({ text: first, currentLocalTime: new Date().toISOString(), liveSummary: "", withPlan: false, sessionId });
  const mFile = memoryFile(sessionId);
  assert.ok(fs.existsSync(mFile), `expected autosave memory capture at ${mFile}`);
  assert.equal(lastLine(mFile).content.parts[0].text, first);
  assert.equal(lineCount(mFile), 1);
  // withPlan:false skipped the classifier, so this tick has no plan to attach yet.
  assert.ok(!("actionItems" in lastLine(mFile)));

  await postLive({ text: grown, currentLocalTime: new Date().toISOString(), liveSummary: "", withPlan: true, sessionId });
  assert.equal(lineCount(mFile), 1, "second tick should OVERWRITE, not append to, the first autosave");
  const midMemory = lastLine(mFile);
  assert.equal(midMemory.content.parts[0].text, grown);
  assert.ok(midMemory.actionItems, "withPlan:true tick should have attached actionItems");

  // Finalize reuses the same sessionId and overwrites the same single-entry file.
  const res = await fetch(BASE + "/api/analyze", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: grown, currentLocalTime: new Date().toISOString(), liveSummary: "", sessionId }),
  });
  if (!res.ok) throw new Error(`/api/analyze -> ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const plan = await res.json();
  assert.equal(lineCount(mFile), 1, "finalize should overwrite the SAME session file, not grow it");
  assert.deepEqual(lastLine(mFile).actionItems, {
    todos: plan.tasks ?? [], calendarEvents: plan.calendarEvents ?? [], searchQueries: plan.searchQueries ?? [],
  });
  assert.ok(!fs.existsSync(legacyTranscriptFile(sessionId)), "a separate transcripts file should no longer be written");

  console.log("live-loop autosave (2 ticks + finalize, one session file, always 1 line) ✓");
  console.log(`  memory: ${mFile} (${lineCount(mFile)} line)`);
}

// Phase 2: Memory Bank API endpoints (/api/memory/ingest, /api/memory/retrieve, /api/memory/sync)
async function testMemoryBankEndpoints() {
  const sessionId = `test-bank-${Date.now()}`;
  const text = "Planning a team offsite in Lake Tahoe with vegetarian catering options.";

  // 1. Ingest via POST /api/memory/ingest
  const ingestRes = await fetch(BASE + "/api/memory/ingest", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      text,
      sessionId,
      userId: "test-user",
      plan: {
        ideasSummary: "Team offsite in Tahoe",
        tasks: [{ title: "Reserve cabin in Tahoe" }],
      },
    }),
  });
  if (!ingestRes.ok) throw new Error(`/api/memory/ingest -> ${ingestRes.status}: ${(await ingestRes.text()).slice(0, 200)}`);
  const ingestData = await ingestRes.json();
  assert.equal(ingestData.ok, true);
  assert.equal(ingestData.sessionId, sessionId);
  assert.equal(ingestData.userId, "test-user");

  // 2. Retrieve via POST /api/memory/retrieve
  const retrieveRes = await fetch(BASE + "/api/memory/retrieve", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: "Tahoe", userId: "test-user" }),
  });
  if (!retrieveRes.ok) throw new Error(`/api/memory/retrieve -> ${retrieveRes.status}: ${(await retrieveRes.text()).slice(0, 200)}`);
  const retrieveData = await retrieveRes.json();
  assert.equal(retrieveData.ok, true);
  assert.ok(retrieveData.count >= 1);
  assert.ok(retrieveData.memories.some((m: any) => m.text.includes("Tahoe")));

  // 3. Retrieve via GET /api/memory/retrieve
  const getRes = await fetch(`${BASE}/api/memory/retrieve?query=Tahoe&userId=test-user`);
  if (!getRes.ok) throw new Error(`GET /api/memory/retrieve -> ${getRes.status}`);
  const getData = await getRes.json();
  assert.equal(getData.ok, true);
  assert.ok(getData.count >= 1);

  // 4. Sync via POST /api/memory/sync
  const syncRes = await fetch(BASE + "/api/memory/sync", { method: "POST" });
  if (!syncRes.ok) throw new Error(`/api/memory/sync -> ${syncRes.status}`);
  const syncData = await syncRes.json();
  assert.equal(syncData.ok, true);
  assert.ok(typeof syncData.syncedCount === "number");

  console.log("memory bank ingest, retrieve, and sync endpoints ✓");
}

// Phase 3: Memory Events API endpoints (/api/memory/events, /api/memory/events/clear)
async function testMemoryEventsEndpoints() {
  // 1. Fetch all memory events
  const eventsRes = await fetch(BASE + "/api/memory/events");
  if (!eventsRes.ok) throw new Error(`/api/memory/events -> ${eventsRes.status}`);
  const eventsData = await eventsRes.json();
  assert.equal(eventsData.ok, true);
  assert.ok(Array.isArray(eventsData.events));
  assert.ok(eventsData.count >= 1);

  // 2. Fetch filtered by type=memory:insert
  const insertRes = await fetch(BASE + "/api/memory/events?type=memory:insert");
  if (!insertRes.ok) throw new Error(`/api/memory/events?type=memory:insert -> ${insertRes.status}`);
  const insertData = await insertRes.json();
  assert.equal(insertData.ok, true);
  assert.ok(insertData.events.every((e: any) => e.actions?.stateDelta?.eventType === "memory:insert"));

  // 3. Fetch filtered by type=memory:retrieve
  const retrieveRes = await fetch(BASE + "/api/memory/events?type=memory:retrieve");
  if (!retrieveRes.ok) throw new Error(`/api/memory/events?type=memory:retrieve -> ${retrieveRes.status}`);
  const retrieveData = await retrieveRes.json();
  assert.equal(retrieveData.ok, true);
  assert.ok(retrieveData.events.every((e: any) => e.actions?.stateDelta?.eventType === "memory:retrieve"));

  // 4. Clear events via POST /api/memory/events/clear
  const clearRes = await fetch(BASE + "/api/memory/events/clear", { method: "POST" });
  if (!clearRes.ok) throw new Error(`/api/memory/events/clear -> ${clearRes.status}`);
  const clearData = await clearRes.json();
  assert.equal(clearData.ok, true);

  const afterClearRes = await fetch(BASE + "/api/memory/events");
  const afterClearData = await afterClearRes.json();
  assert.equal(afterClearData.count, 0);

  console.log("memory events endpoints (get, filter, clear) ✓");
}

async function main() {
  await testFinalizeOnly();
  await testLiveAutosave();
  await testMemoryBankEndpoints();
  await testMemoryEventsEndpoints();
}

main().catch(e => { console.error("memory-capture integration test ✗", e); process.exitCode = 1; });


