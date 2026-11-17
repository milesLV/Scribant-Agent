// Phase 1: one durable local file per session (transcript + action items). Phase 2: sync to Vertex AI
// Memory Bank, which does its own fact extraction. Single-user app, so no per-user scoping.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  VertexAiMemoryBankService,
  InMemoryMemoryService,
  type BaseMemoryService,
  type MemoryEntry,
  type SearchMemoryResponse,
  type SingleBeforeModelCallback,
  type LlmRequest,
} from "@google/adk";
import { safeSeg, hourBucket, estimateTokens } from "./server-utils";
import { createEvent, createEventActions, emitAdkEvent, subscribeToAdkEvents, getAdkEvents, classifyAdkEventType, type AdkEvent } from "./adk-events";

// Close to ADK's MemoryEntry shape so it forwards to Memory Bank with little translation.
// actionItems is storage-only: the flat plan nested under one key, with "tasks" renamed "todos".
interface MemoryCapture {
  timestamp: string;
  sessionId: string;
  content: { role: "user"; parts: [{ text: string }] };
  ideasSummary?: string;
  actionItems?: { todos: unknown[]; calendarEvents: unknown[]; searchQueries: unknown[] };
}

// Every category always comes out an array; a missing plan (ticks that skipped the classifier) → undefined.
function toActionItems(plan: any): Pick<MemoryCapture, "ideasSummary" | "actionItems"> | undefined {
  if (!plan || typeof plan !== "object") return undefined;
  const arr = (v: unknown) => (Array.isArray(v) ? v : []);
  return {
    ...(typeof plan.ideasSummary === "string" ? { ideasSummary: plan.ideasSummary } : {}),
    actionItems: { todos: arr(plan.tasks ?? plan.todos), calendarEvents: arr(plan.calendarEvents), searchQueries: arr(plan.searchQueries) },
  };
}

// A session spanning an hour boundary would leave its file in the previous hour bucket. Walk back
// hour by hour (bounded, not a tree scan) to find it.
function findStaleSessionFile(root: string, filename: string, now: Date, keep: string, lookbackHours = 48): string | null {
  for (let hoursBack = 0; hoursBack <= lookbackHours; hoursBack++) {
    const candidate = path.join(root, hourBucket(new Date(now.getTime() - hoursBack * 3_600_000)), filename);
    if (candidate !== keep && fs.existsSync(candidate)) return candidate;
  }
  return null;
}

// Overwrite ./data/memory/{YYYY}/{MM}/{DD}/{HH}/{sessionId}.jsonl with the session's latest snapshot.
// `root` and `now` are injectable for the self-check.
// ponytail: sync overwrite, one file per session; move to fs.promises if it ever blocks a request.
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

  // Remove the older-hour copy only after the new write succeeded, so nothing is ever lost.
  const stale = findStaleSessionFile(root, filename, now, file);
  if (stale) {
    fs.rmSync(stale);
    try { fs.rmdirSync(path.dirname(stale)); } catch { /* other sessions still in that hour */ }
  }
  return file;
}

// ---- Phase 2: Vertex AI Memory Bank Integration ----------------------------

const envProject = () => process.env.GOOGLE_CLOUD_PROJECT ?? process.env.PROJECT_ID;
const envLocation = () => process.env.VERTEX_AI_LOCATION ?? process.env.GOOGLE_CLOUD_LOCATION ?? "us-central1";

// Throws when unconfigured rather than silently falling back to in-memory.
export function createMemoryBankService(config?: { agentEngineId?: string; projectId?: string; location?: string; client?: any }): BaseMemoryService {
  const agentEngineId = config?.agentEngineId ?? process.env.VERTEX_AI_AGENT_ENGINE_ID ?? process.env.AGENT_ENGINE_ID;
  if (!agentEngineId) {
    throw new Error(
      "VERTEX_AI_AGENT_ENGINE_ID (or AGENT_ENGINE_ID) is required in .env to connect to Vertex AI Memory Bank. Run `npm run create:memory-bank` to create one programmatically on GCP."
    );
  }
  const projectId = config?.projectId ?? envProject();
  if (!projectId) throw new Error("GOOGLE_CLOUD_PROJECT (or PROJECT_ID) is required in .env to connect to Vertex AI Memory Bank.");
  const location = config?.location ?? envLocation();
  return new VertexAiMemoryBankService({ agentEngineId, projectId, location, ...(config?.client && { client: config.client }) });
}

// Shared by create/list: ADC token, resolved project/location, and the reasoningEngines collection URL.
async function reasoningEngines(options: { projectId?: string; location?: string } | undefined, verb: string) {
  const { GoogleAuth } = await import("google-auth-library");
  const auth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] });
  const token = (await (await auth.getClient()).getAccessToken()).token;
  const projectId = options?.projectId ?? envProject() ?? (await auth.getProjectId().catch(() => null)) ?? undefined;
  if (!projectId) throw new Error(`GOOGLE_CLOUD_PROJECT is required to ${verb} a Vertex AI Memory Bank.`);
  const location = options?.location ?? envLocation();
  const url = `https://${location}-aiplatform.googleapis.com/v1beta1/projects/${projectId}/locations/${location}/reasoningEngines`;
  return { token, projectId, location, url };
}

export async function createCloudMemoryBank(options?: {
  projectId?: string;
  location?: string;
  displayName?: string;
  description?: string;
}): Promise<{ resourceName: string; agentEngineId: string; displayName: string; location: string; projectId: string }> {
  const { token, projectId, location, url } = await reasoningEngines(options, "create");
  const displayName = options?.displayName || "scribant-memory-bank";
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      displayName,
      description: options?.description || "Memory Bank for Scribant Voice Agent",
      contextSpec: { memoryBankConfig: {} },
    }),
  });
  if (!res.ok) throw new Error(`Failed to create Vertex AI Memory Bank (${res.status}): ${await res.text()}`);

  const operationName = String((await res.json()).name || "");
  const agentEngineId = operationName.match(/reasoningEngines\/([^/]+)/)?.[1] ?? operationName.split("/").pop()!;
  const resourceName = `projects/${projectId}/locations/${location}/reasoningEngines/${agentEngineId}`;
  return { resourceName, agentEngineId, displayName, location, projectId };
}

export async function listCloudMemoryBanks(options?: {
  projectId?: string;
  location?: string;
}): Promise<Array<{ name: string; displayName?: string; description?: string; createTime?: string }>> {
  const { token, url } = await reasoningEngines(options, "list");
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Failed to list Vertex AI Memory Banks (${res.status}): ${await res.text()}`);
  return (await res.json()).reasoningEngines || [];
}

// Shared singleton; `override` lets a caller or test inject its own.
let memoryServiceInstance: BaseMemoryService | null = null;
export function getMemoryService(override?: BaseMemoryService): BaseMemoryService {
  if (override) return override;
  return (memoryServiceInstance ??= createMemoryBankService());
}

interface IngestTranscriptParams {
  text: string;
  sessionId?: string;
  userId?: string;
  appName?: string;
  plan?: unknown;
  timestamp?: string;
  memoryService?: BaseMemoryService;
}

// Speaker turns from "Name: ..." or "[Meeting: x]" lines; untagged lines join the current turn.
export function parseSpeakerTurns(text: string): { speaker: string; text: string }[] {
  if (!text || !text.trim()) return [];
  const turns: { speaker: string; text: string }[] = [];
  let speaker = "user";
  let buffer: string[] = [];
  const flush = () => { if (buffer.length) turns.push({ speaker, text: buffer.join(" ") }); buffer = []; };
  for (const line of text.split(/\n+/).map(l => l.trim()).filter(Boolean)) {
    const m = line.match(/^(?:\[(?:Meeting:\s*)?([^\]]+)\]|([A-Za-z0-9_\s]{2,25}):)\s*(.*)$/);
    if (!m) { buffer.push(line); continue; }
    flush();
    speaker = (m[1] || m[2] || "user").trim();
    if (m[3]?.trim()) buffer.push(m[3].trim());
  }
  flush();
  return turns.length > 0 ? turns : [{ speaker: "user", text }];
}

type ServiceName = "vertex_ai" | "in_memory" | "custom";
const serviceName = (svc: BaseMemoryService): ServiceName =>
  svc instanceof VertexAiMemoryBankService ? "vertex_ai" : svc instanceof InMemoryMemoryService ? "in_memory" : "custom";
const errMsg = (e: any) => e?.message || String(e);

// One memory:insert / memory:retrieve telemetry event (AdminMonitoring reads these stateDelta fields).
export function emitMemoryEvent(invocationId: string, summary: string, stateDelta: Record<string, unknown>) {
  emitAdkEvent(createEvent({
    author: "memory",
    invocationId,
    content: { role: "model", parts: [{ text: summary }] },
    actions: createEventActions({ stateDelta }),
  }));
}

// Ingests transcript text into Vertex AI Memory Bank (or InMemoryMemoryService), one event per speaker turn.
export async function ingestTranscriptToMemoryBank(params: IngestTranscriptParams) {
  const startTime = Date.now();
  const text = (params.text || "").trim();
  const appName = params.appName || process.env.APP_NAME || "scribant";
  const userId = safeSeg(params.userId, "default_user");
  const sessionId = safeSeg(params.sessionId, "session");
  const timestamp = params.timestamp || new Date().toISOString();
  const service = params.memoryService ?? getMemoryService();
  const base = { eventType: "memory:insert", sessionId, userId, appName, text };
  const fail = (e: any, extra = {}) => {
    emitMemoryEvent(sessionId, `[Memory Ingest Error]: ${errMsg(e)}`, { ...base, status: "error", durationMs: Date.now() - startTime, error: errMsg(e), ...extra });
    return e;
  };

  if (!text) throw fail(new Error("Transcript text is required for memory bank ingestion."));

  const svc = serviceName(service);
  try {
    const events: any[] = parseSpeakerTurns(text).map(t => ({
      author: t.speaker || "user",
      content: { role: "user", parts: [{ text: t.text }] },
      timestamp,
    }));
    if (typeof (service as any).addEventsToMemory === "function") {
      await (service as any).addEventsToMemory({ appName, userId, sessionId, events, customMetadata: { sessionId, timestamp } });
    } else {
      await service.addSessionToMemory({ id: sessionId, appName, userId, events, state: {}, lastUpdateTime: Date.now() } as any);
    }
    emitMemoryEvent(sessionId, `[Memory Ingest]: ${text.slice(0, 120)}`, {
      ...base, status: "success", durationMs: Date.now() - startTime, service: svc, eventCount: events.length, plan: params.plan,
    });
    return { ok: true, sessionId, userId, appName, eventCount: events.length, service: svc };
  } catch (error: any) {
    throw fail(error, { service: svc, plan: params.plan });
  }
}

// Every capture record under `root` (one per line across all .jsonl files); unreadable files are skipped.
function* readCaptures(root: string, onError?: (file: string, e: any) => void): Generator<MemoryCapture> {
  for (const file of findJsonlFiles(root)) {
    let records: MemoryCapture[];
    try {
      records = fs.readFileSync(file, "utf8").split("\n").filter(l => l.trim()).map(l => JSON.parse(l));
    } catch (e) { onError?.(file, e); continue; }
    yield* records;
  }
}

// Sums tokens across every locally captured session.
export function getArchiveTokenMetrics(root = path.join(process.cwd(), "data", "memory")) {
  let totalChars = 0;
  let sessionCount = 0;
  for (const record of readCaptures(root)) {
    totalChars += (record.content?.parts?.[0]?.text || "").length + (record.ideasSummary || "").length;
    sessionCount++;
  }
  const totalArchiveTokens = Math.ceil(totalChars / 3.8);
  return {
    totalArchiveTokens,
    sessionCount,
    fileCount: findJsonlFiles(root).length,
    averageSessionTokens: sessionCount > 0 ? Math.round(totalArchiveTokens / sessionCount) : 0,
  };
}

export function computeMemoryEfficiency(injectedMemories: string[], promptText = "", root?: string) {
  const archiveTokens = getArchiveTokenMetrics(root).totalArchiveTokens;
  const basePromptTokens = estimateTokens(promptText) + 320; // base system prompt & skill schema
  const injectedMemoryTokens = estimateTokens(injectedMemories.join("\n"));
  // Without Memory Bank every past session goes into the prompt; with it, only the retrieved snippets.
  const simulatedLegacyTokens = basePromptTokens + archiveTokens;
  const actualMemoryBankTokens = basePromptTokens + injectedMemoryTokens;
  const savedTokens = Math.max(0, simulatedLegacyTokens - actualMemoryBankTokens);
  return {
    archiveTokens, injectedMemoryTokens, simulatedLegacyTokens, actualMemoryBankTokens, savedTokens,
    savingsPercent: Math.min(99.9, Number(((savedTokens / simulatedLegacyTokens) * 100).toFixed(1))),
    efficiencyMultiplier: (simulatedLegacyTokens / actualMemoryBankTokens).toFixed(1) + "x",
  };
}

// Searches Vertex AI Memory Bank (or InMemoryMemoryService) for memories relevant to `query`.
export async function retrieveFromMemoryBank(
  query: string,
  options?: { userId?: string; appName?: string; memoryService?: BaseMemoryService },
) {
  const startTime = Date.now();
  const trimmedQuery = (query || "").trim();
  const appName = options?.appName || process.env.APP_NAME || "scribant";
  const userId = safeSeg(options?.userId, "default_user");
  const service = options?.memoryService ?? getMemoryService();
  const base = { eventType: "memory:retrieve", query: trimmedQuery, userId, appName };
  const fail = (e: any, extra = {}) => {
    emitMemoryEvent(`retrieve-${Date.now()}`, `[Memory Retrieve Error]: ${errMsg(e)}`, { ...base, status: "error", durationMs: Date.now() - startTime, error: errMsg(e), ...extra });
    return e;
  };

  if (!trimmedQuery) throw fail(new Error("Search query is required for memory bank retrieval."));

  const svc = serviceName(service);
  try {
    const response: SearchMemoryResponse = await service.searchMemory({ appName, userId, query: trimmedQuery });
    const memories = (response.memories || []).map((m: MemoryEntry) => ({
      text: (m.content?.parts?.map((p: any) => p.text).filter(Boolean) ?? []).join("\n"),
      author: m.author || "user",
      timestamp: m.timestamp || new Date().toISOString(),
    }));
    const efficiency = computeMemoryEfficiency(memories.map(m => m.text), trimmedQuery);
    const n = memories.length;
    emitMemoryEvent(`retrieve-${Date.now()}`, `[Memory Retrieve]: "${trimmedQuery}" (${n} match${n === 1 ? "" : "es"})`, {
      ...base, status: "success", durationMs: Date.now() - startTime, service: svc, count: n, memories, efficiency,
    });
    return { query: trimmedQuery, memories, count: n, service: svc, efficiency };
  } catch (error: any) {
    throw fail(error, { service: svc });
  }
}

function findJsonlFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter(f => f.endsWith(".jsonl"))
    .map(f => path.join(dir, f));
}

// Pushes every local session capture in data/memory into Memory Bank.
export async function syncLocalMemoriesToMemoryBank(
  root = path.join(process.cwd(), "data", "memory"),
  memoryService?: BaseMemoryService
): Promise<{ syncedCount: number; errors: string[] }> {
  let syncedCount = 0;
  const errors: string[] = [];
  for (const record of readCaptures(root, (file, e) => errors.push(`Failed to sync ${file}: ${errMsg(e)}`))) {
    const text = record.content?.parts?.[0]?.text;
    if (!text) continue;
    try {
      await ingestTranscriptToMemoryBank({ text, sessionId: record.sessionId, timestamp: record.timestamp, memoryService });
      syncedCount++;
    } catch (e) {
      errors.push(`Failed to sync ${record.sessionId}: ${errMsg(e)}`);
    }
  }
  return { syncedCount, errors };
}

// Prepend retrieved memories to the user turn so the model reads them as grounding context.
function injectMemoryIntoUserMessage(request: LlmRequest, memories: string[]): void {
  if (!memories.length) return;
  const block = { text: `[Relevant Context from Memory Bank]:\n${memories.map(m => `- ${m}`).join("\n")}` };
  const user = request.contents?.find(c => c.role === "user") ?? request.contents?.[0];
  if (user) user.parts = [block, ...(user.parts || [])];
  else request.contents = [{ role: "user", parts: [block] }];
}

// The recall query when `text` asks about the past ("what did we decide…"), else null.
// ponytail: regex heuristic; swap for a classifier stage if recall misfires in practice.
export function extractMemoryRecallQuery(text: string): string | null {
  const trimmed = typeof text === "string" ? text.trim() : "";
  if (!trimmed) return null;
  const stripFiller = (q: string, filler: string) => q.trim()
    .replace(new RegExp(`^[\\s,:-]*(\\b(${filler})\\b[\\s,:-]*)+`, "i"), "")
    .replace(/^[\s,:-]+/, "").replace(/[.!?]+$/, "").trim();

  // Short direct questions (manual query inputs, search prompts).
  if (trimmed.length < 90 && (trimmed.endsWith("?") || /^(what|who|where|when|why|how|which|remember|recall|search|find|show me|tell me|did we|do we|have we)/i.test(trimmed))) {
    return stripFiller(trimmed, "by the way|hey|also|please|can you|could you");
  }

  const recallPatterns: RegExp[] = [
    // Questions about past meetings/sessions/conversations
    /(?:(?:what|who|where|when|how|which|why)\s+(?:did|was|were|happened|is|are|we|have we|had we|do we)\b[^.!?\n]+(?:\?|$))/i,
    // "Remember / Recall / Did we talk about..."
    /(?:(?:do you\s+)?(?:remember|recall|remind me|look up|check memory|search memory)\s+(?:about|regarding|if|what|who|when|where|how|whether)?\s*[:,-]?\s*[^.!?\n]+(?:\?|$))/i,
    // References to past sessions, last time, previous notes
    /(?:(?:in (?:the|our) (?:last|previous|earlier|past)\s+(?:meeting|call|session|sync|notes|discussion)|last time we (?:talked|discussed|met|spoke)|earlier we (?:decided|agreed|said))\s*[,:-]?\s*[^.!?\n]+(?:\?|$)?)/i,
    // Decisions or status inquiries
    /(?:(?:what(?:'s|\s+is|\s+was)\s+(?:the\s+)?(?:status|update|decision|plan|agreement|to-do|action item)\s+(?:of|on|for|regarding)\b[^.!?\n]+(?:\?|$)?))/i,
    // Questions that contain past/historical references
    /(?:[^.!?\n]*\b(?:last week|last time|yesterday|earlier|previously|before|already decided|agreed upon)\b[^.!?\n]*\?)/i,
  ];
  for (const sentence of trimmed.split(/(?<=[.!?\n])\s+/)) {
    for (const pattern of recallPatterns) {
      const match = sentence.trim().match(pattern);
      const q = match && stripFiller(match[0], "hey|by the way|also|so|well|uh|um|please|can you|could you|tell me|let me know");
      if (q && q.length >= 4) return q;
    }
  }
  return null;
}

// beforeModelCallback: ingest the transcript every call; search memory only when it asks about the past.
export const memoryBankBeforeModelCallback: SingleBeforeModelCallback = async ({ context, request }) => {
  try {
    const memoryService = context.invocationContext?.memoryService ?? getMemoryService();
    const session = context.invocationContext?.session;
    const ids = { sessionId: session?.id || "session", userId: session?.userId || "default_user", appName: session?.appName || "scribant" };
    const text = (context.state.get<string>("corrected") ||
      context.state.get<string>("rawText") ||
      request.contents?.[0]?.parts?.map((p: any) => p.text).filter(Boolean).join(" ") || "").trim();
    if (!text) return undefined;

    const recallQuery = extractMemoryRecallQuery(text);
    const [, found] = await Promise.all([
      ingestTranscriptToMemoryBank({ text, ...ids, memoryService }),
      recallQuery ? retrieveFromMemoryBank(recallQuery, { userId: ids.userId, appName: ids.appName, memoryService }) : null,
    ]);
    if (found) injectMemoryIntoUserMessage(request, found.memories.map(m => m.text));
  } catch (e: any) {
    console.warn("[memoryBankBeforeModelCallback] Callback error:", e?.message || e);
  }
  return undefined;
};

if (import.meta.url && process.argv[1] === fileURLToPath(import.meta.url)) {
  (async () => {
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

      // ---- Phase 2 Memory Bank Ingest & Retrieve Self-checks ----
      const testMemService = new InMemoryMemoryService();
      
      // Ingest test transcript
      const ingestRes = await ingestTranscriptToMemoryBank({
        text: "I am planning a trip to Kyoto next spring and prefer green tea over coffee.",
        sessionId: "run-kyoto",
        userId: "traveler",
        memoryService: testMemService,
      });
      assert.equal(ingestRes.ok, true);
      assert.equal(ingestRes.sessionId, "run-kyoto");
      assert.equal(ingestRes.userId, "traveler");
      assert.equal(ingestRes.eventCount, 1);

      // Retrieve by query
      const retrieveRes = await retrieveFromMemoryBank("Kyoto", {
        userId: "traveler",
        memoryService: testMemService,
      });
      assert.equal(retrieveRes.query, "Kyoto");
      assert.ok(retrieveRes.count >= 1);
      assert.ok(retrieveRes.memories.some(m => m.text.includes("Kyoto")));

      // Retrieve by secondary query (e.g. "tea")
      const teaRes = await retrieveFromMemoryBank("tea", {
        userId: "traveler",
        memoryService: testMemService,
      });
      assert.ok(teaRes.count >= 1);
      assert.ok(teaRes.memories.some(m => m.text.includes("green tea")));

      // Retrieve non-matching query returns empty list
      const nonMatchingRes = await retrieveFromMemoryBank("astronaut", {
        userId: "traveler",
        memoryService: testMemService,
      });
      assert.equal(nonMatchingRes.count, 0);
      assert.deepEqual(nonMatchingRes.memories, []);

      // Speaker turns parsing self-check
      const parsedTurns = parseSpeakerTurns("Alice: I will prepare the roadmap presentation.\nBob: I will review it tomorrow.\nYou: Sounds like a solid plan.");
      assert.equal(parsedTurns.length, 3);
      assert.equal(parsedTurns[0].speaker, "Alice");
      assert.equal(parsedTurns[0].text, "I will prepare the roadmap presentation.");
      assert.equal(parsedTurns[1].speaker, "Bob");
      assert.equal(parsedTurns[1].text, "I will review it tomorrow.");
      assert.equal(parsedTurns[2].speaker, "You");
      assert.equal(parsedTurns[2].text, "Sounds like a solid plan.");

      // Multi-speaker memory ingestion self-check
      const multiSpeakerMemService = new InMemoryMemoryService();
      const multiIngestRes = await ingestTranscriptToMemoryBank({
        text: "Alice: We chose TypeScript for the new backend.\nBob: I prefer Postgres for our primary database.",
        sessionId: "run-multi-speaker",
        userId: "team-user",
        memoryService: multiSpeakerMemService,
      });
      assert.equal(multiIngestRes.ok, true);
      assert.equal(multiIngestRes.eventCount, 2);

      // Verify retrievable by speaker-attributed topic
      const tsSearch = await retrieveFromMemoryBank("TypeScript", {
        userId: "team-user",
        memoryService: multiSpeakerMemService,
      });
      assert.ok(tsSearch.count >= 1);
      assert.ok(tsSearch.memories.some(m => m.text.includes("TypeScript") && m.author === "Alice"));

      // Sync local files to memory service
      const syncMemService = new InMemoryMemoryService();
      const syncRes = await syncLocalMemoriesToMemoryBank(root, syncMemService);
      assert.ok(syncRes.syncedCount >= 1);
      assert.equal(syncRes.errors.length, 0);

      // Verify synced memories are retrievable
      const syncedSearch = await retrieveFromMemoryBank("talking", {
        userId: "default_user",
        memoryService: syncMemService,
      });
      assert.ok(syncedSearch.count >= 1);
      assert.ok(syncedSearch.memories.some(m => m.text.includes("talking")));

      // Service creation with explicit config
      const vertexMem = createMemoryBankService({
        agentEngineId: "test-engine-id",
        projectId: "test-project",
        location: "us-central1",
        client: { agentEnginesInternal: { memories: {} } },
      });
      assert.ok(vertexMem instanceof VertexAiMemoryBankService);

      // ---- Automatic Memory Callback Self-checks ----
      const cbMemService = new InMemoryMemoryService();
      // 1. Seed a memory for the recall checks below
      await ingestTranscriptToMemoryBank({ text: "Schedule a product demo with Alex on Friday", sessionId: "run-cb-1", userId: "cb-user", memoryService: cbMemService });
      const cbRetrieve = await retrieveFromMemoryBank("Alex", {
        userId: "cb-user",
        memoryService: cbMemService,
      });
      assert.ok(cbRetrieve.count >= 1);
      assert.ok(cbRetrieve.memories.some(m => m.text.includes("Alex")));

      // 2. Test extractMemoryRecallQuery
      assert.equal(extractMemoryRecallQuery("Schedule a product demo with Alex on Friday"), null);
      assert.equal(extractMemoryRecallQuery("What did we decide about Alex in our last meeting?"), "What did we decide about Alex in our last meeting");
      assert.equal(extractMemoryRecallQuery("By the way, remember what we said about the database migration?"), "remember what we said about the database migration");

      // 3. Test memoryBankBeforeModelCallback with user message injection on recall intent
      const mockRecallState: Record<string, any> = { corrected: "What did we decide about Alex in our last meeting?" };
      const mockRecallContext: any = {
        invocationContext: {
          memoryService: cbMemService,
          session: { id: "run-cb-2", userId: "cb-user", appName: "scribant" },
        },
        state: { get: (k: string) => mockRecallState[k] },
      };
      const mockRequest2: any = { contents: [{ role: "user", parts: [{ text: "Meeting recap" }] }], config: {} };
      await memoryBankBeforeModelCallback({ context: mockRecallContext, request: mockRequest2 });
      assert.ok(
        mockRequest2.contents[0].parts.some((p: any) =>
          typeof p.text === "string" && p.text.includes("[Relevant Context from Memory Bank]")
        )
      );

      // ---- Memory Events Self-checks ----
      const eventsCaptured: AdkEvent[] = [];
      const unsub = subscribeToAdkEvents(evt => eventsCaptured.push(evt));

      // Test insert event
      const evtIngest = await ingestTranscriptToMemoryBank({
        text: "Testing memory insert event emission",
        sessionId: "run-evt-1",
        userId: "event-tester",
        memoryService: cbMemService,
      });
      assert.ok(evtIngest.ok);
      assert.ok(
        eventsCaptured.some(
          e =>
            classifyAdkEventType(e) === "memory:insert" &&
            e.actions?.stateDelta?.sessionId === "run-evt-1" &&
            e.actions?.stateDelta?.status === "success"
        )
      );

      // Test retrieve event
      const evtRetrieve = await retrieveFromMemoryBank("Testing memory insert", {
        userId: "event-tester",
        memoryService: cbMemService,
      });
      assert.ok(evtRetrieve.count >= 1);
      assert.ok(
        eventsCaptured.some(
          e =>
            classifyAdkEventType(e) === "memory:retrieve" &&
            e.actions?.stateDelta?.query === "Testing memory insert" &&
            e.actions?.stateDelta?.status === "success"
        )
      );

      // Test error event emission on empty queries
      try {
        await retrieveFromMemoryBank("", { memoryService: cbMemService });
      } catch {
        // Expected error
      }
      assert.ok(
        eventsCaptured.some(
          e =>
            classifyAdkEventType(e) === "memory:retrieve" &&
            e.actions?.stateDelta?.status === "error"
        )
      );

      // Test event history filtering
      const insertHistory = getAdkEvents({ type: "memory:insert" });
      assert.ok(insertHistory.every(e => classifyAdkEventType(e) === "memory:insert"));

      const retrieveHistory = getAdkEvents({ type: "memory:retrieve" });
      assert.ok(retrieveHistory.every(e => classifyAdkEventType(e) === "memory:retrieve"));

      unsub();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }

    console.log("memory self-check ✓");
  })();
}

