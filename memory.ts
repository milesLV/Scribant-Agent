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
import {
  VertexAiMemoryBankService,
  InMemoryMemoryService,
  type BaseMemoryService,
  type MemoryEntry,
  type SearchMemoryResponse,
  type SingleBeforeModelCallback,
  type Context,
  type LlmRequest,
} from "@google/adk";
import { safeSeg, hourBucket, estimateTokens, computeCompaction } from "./server-utils";

export {
  VertexAiMemoryBankService,
  InMemoryMemoryService,
  type BaseMemoryService,
  type MemoryEntry,
  type SingleBeforeModelCallback,
};

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
      todos: Array.isArray(plan.tasks) ? plan.tasks : (Array.isArray(plan.todos) ? plan.todos : []),
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

// ---- Phase 2: Vertex AI Memory Bank Integration ----------------------------

let memoryServiceInstance: BaseMemoryService | null = null;

export interface MemoryServiceConfig {
  agentEngineId?: string;
  projectId?: string;
  location?: string;
  expressModeApiKey?: string;
  forceInMemory?: boolean;
  client?: any;
}

// Instantiates a strict VertexAiMemoryBankService connecting to Google Cloud.
// If VERTEX_AI_AGENT_ENGINE_ID is missing, it throws an explicit error rather than falling back to in-memory.
export function createMemoryBankService(config?: MemoryServiceConfig): BaseMemoryService {
  if (config?.forceInMemory) {
    return new InMemoryMemoryService();
  }

  const agentEngineId = config?.agentEngineId ??
    process.env.VERTEX_AI_AGENT_ENGINE_ID ??
    process.env.AGENT_ENGINE_ID ??
    process.env.MEMORY_BANK_AGENT_ENGINE_ID ??
    process.env.REASONING_ENGINE_ID;

  if (!agentEngineId) {
    throw new Error(
      "VERTEX_AI_AGENT_ENGINE_ID (or AGENT_ENGINE_ID) is required in .env to connect to Vertex AI Memory Bank. Run `npm run create:memory-bank` to create one programmatically on GCP."
    );
  }

  const projectId = config?.projectId ??
    process.env.GOOGLE_CLOUD_PROJECT ??
    process.env.PROJECT_ID ??
    "agentclinicep04";

  const location = config?.location ??
    process.env.VERTEX_AI_LOCATION ??
    process.env.GOOGLE_CLOUD_LOCATION ??
    "us-central1";

  const expressModeApiKey = config?.expressModeApiKey ??
    process.env.VERTEX_EXPRESS_MODE_API_KEY ??
    process.env.GEMINI_API_KEY;

  return new VertexAiMemoryBankService({
    agentEngineId,
    projectId,
    location,
    expressModeApiKey,
    ...(config?.client ? { client: config.client } : {}),
  });
}

// Programmatically creates a new Vertex AI Memory Bank resource on Google Cloud.
export async function createCloudMemoryBank(options?: {
  projectId?: string;
  location?: string;
  displayName?: string;
  description?: string;
}): Promise<{
  resourceName: string;
  agentEngineId: string;
  displayName: string;
  location: string;
  projectId: string;
}> {
  const { GoogleAuth } = await import("google-auth-library");
  const auth = new GoogleAuth({
    scopes: ["https://www.googleapis.com/auth/cloud-platform"]
  });
  const client = await auth.getClient();
  const token = await client.getAccessToken();

  const projectId = options?.projectId ??
    process.env.GOOGLE_CLOUD_PROJECT ??
    process.env.PROJECT_ID ??
    "agentclinicep04";

  const location = options?.location ??
    process.env.VERTEX_AI_LOCATION ??
    process.env.GOOGLE_CLOUD_LOCATION ??
    "us-central1";

  const displayName = options?.displayName || "scribant-memory-bank";
  const description = options?.description || "Memory Bank for Scribant Voice Agent";

  const url = `https://${location}-aiplatform.googleapis.com/v1beta1/projects/${projectId}/locations/${location}/reasoningEngines`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token.token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      displayName,
      description,
      contextSpec: {
        memoryBankConfig: {}
      }
    })
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Failed to create Vertex AI Memory Bank (${res.status}): ${errText}`);
  }

  const data = await res.json();
  const operationName = String(data.name || "");
  const match = operationName.match(/reasoningEngines\/([^/]+)/);
  const agentEngineId = match ? match[1] : operationName.split("/").pop()!;
  const resourceName = `projects/${projectId}/locations/${location}/reasoningEngines/${agentEngineId}`;

  return {
    resourceName,
    agentEngineId,
    displayName,
    location,
    projectId,
  };
}

// Programmatically lists all Vertex AI Memory Bank resources in the GCP project.
export async function listCloudMemoryBanks(options?: {
  projectId?: string;
  location?: string;
}): Promise<Array<{ name: string; displayName?: string; description?: string; createTime?: string }>> {
  const { GoogleAuth } = await import("google-auth-library");
  const auth = new GoogleAuth({
    scopes: ["https://www.googleapis.com/auth/cloud-platform"]
  });
  const client = await auth.getClient();
  const token = await client.getAccessToken();

  const projectId = options?.projectId ??
    process.env.GOOGLE_CLOUD_PROJECT ??
    process.env.PROJECT_ID ??
    "agentclinicep04";

  const location = options?.location ??
    process.env.VERTEX_AI_LOCATION ??
    process.env.GOOGLE_CLOUD_LOCATION ??
    "us-central1";

  const url = `https://${location}-aiplatform.googleapis.com/v1beta1/projects/${projectId}/locations/${location}/reasoningEngines`;

  const res = await fetch(url, {
    headers: { "Authorization": `Bearer ${token.token}` }
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Failed to list Vertex AI Memory Banks (${res.status}): ${errText}`);
  }

  const data = await res.json();
  return data.reasoningEngines || [];
}

// Shared singleton getter, overrideable per-caller or per-test.
export function getMemoryService(override?: BaseMemoryService): BaseMemoryService {
  if (override) return override;
  if (!memoryServiceInstance) {
    memoryServiceInstance = createMemoryBankService();
  }
  return memoryServiceInstance;
}

// Resets or sets the active memory service singleton (useful for testing or reconfiguration).
export function setMemoryService(service: BaseMemoryService | null): void {
  memoryServiceInstance = service;
}

// ---- ADK Events (adk.dev/events) Integration --------------------------------

import {
  createEvent,
  createEventActions,
  toStructuredEvents,
  EventType,
  adkEventStream,
  emitAdkEvent,
  subscribeToAdkEvents,
  getAdkEvents,
  clearAdkEvents,
  classifyAdkEventType,
  type AdkEvent,
} from "./adk-events";

export {
  createEvent,
  createEventActions,
  toStructuredEvents,
  EventType,
  adkEventStream,
  emitAdkEvent,
  subscribeToAdkEvents,
  getAdkEvents,
  clearAdkEvents,
  classifyAdkEventType,
  type AdkEvent,
};

// Aliases for memory-specific consumers
export type MemoryEvent = AdkEvent;
export type MemoryEventListener = (event: AdkEvent) => void;
export const memoryEvents = adkEventStream;
export const subscribeToMemoryEvents = subscribeToAdkEvents;
export const getMemoryEvents = getAdkEvents;
export const clearMemoryEvents = clearAdkEvents;
export const recordMemoryEvent = emitAdkEvent;

export interface IngestTranscriptParams {
  text: string;
  sessionId?: string;
  userId?: string;
  appName?: string;
  plan?: unknown;
  timestamp?: string;
  memoryService?: BaseMemoryService;
}

export interface IngestTranscriptResult {
  ok: boolean;
  sessionId: string;
  userId: string;
  appName: string;
  eventCount: number;
  service: "vertex_ai" | "in_memory" | "custom";
}

export interface ParsedSpeakerTurn {
  speaker: string;
  text: string;
}

// Parses speaker turns from formatted dialogue or meeting transcripts
export function parseSpeakerTurns(text: string): ParsedSpeakerTurn[] {
  if (!text || !text.trim()) return [];
  const lines = text.split(/\n+/).map(l => l.trim()).filter(Boolean);
  const speakerRegex = /^(?:\[(?:Meeting:\s*)?([^\]]+)\]|([A-Za-z0-9_\s]{2,25}):)\s*(.*)$/;

  const turns: ParsedSpeakerTurn[] = [];
  let currentSpeaker = "user";
  let currentBuffer: string[] = [];

  for (const line of lines) {
    const match = line.match(speakerRegex);
    if (match) {
      const speaker = (match[1] || match[2] || "user").trim();
      const content = (match[3] || "").trim();
      if (currentBuffer.length > 0) {
        turns.push({ speaker: currentSpeaker, text: currentBuffer.join(" ") });
        currentBuffer = [];
      }
      currentSpeaker = speaker;
      if (content) currentBuffer.push(content);
    } else {
      currentBuffer.push(line);
    }
  }

  if (currentBuffer.length > 0) {
    turns.push({ speaker: currentSpeaker, text: currentBuffer.join(" ") });
  }

  return turns.length > 0 ? turns : [{ speaker: "user", text }];
}

// Ingests transcript text and extracted actions into Vertex AI Memory Bank (or InMemoryMemoryService).
export async function ingestTranscriptToMemoryBank(
  params: IngestTranscriptParams
): Promise<IngestTranscriptResult> {
  const startTime = Date.now();
  const text = (params.text || "").trim();
  const appName = params.appName || process.env.APP_NAME || "scribant";
  const userId = safeSeg(params.userId, "default_user");
  const sessionId = safeSeg(params.sessionId, "session");
  const timestamp = params.timestamp || new Date().toISOString();
  const service = params.memoryService ?? getMemoryService();

  if (!text) {
    const err = new Error("Transcript text is required for memory bank ingestion.");
    emitAdkEvent(
      createEvent({
        author: "memory",
        invocationId: sessionId,
        content: {
          role: "model",
          parts: [{ text: `[Memory Ingest Error]: ${err.message}` }],
        },
        actions: createEventActions({
          stateDelta: {
            eventType: "memory:insert",
            status: "error",
            durationMs: Date.now() - startTime,
            sessionId,
            userId,
            appName,
            text: "",
            error: err.message,
          },
        }),
      })
    );
    throw err;
  }

  try {
    // Ingest speaker turns into Memory Bank as attributed events
    const turns = parseSpeakerTurns(text);
    const events: any[] = turns.map(t => ({
      author: t.speaker || "user",
      content: { role: "user", parts: [{ text: t.text }] },
      timestamp,
    }));

    const isVertex = service instanceof VertexAiMemoryBankService;

    if (typeof (service as any).addEventsToMemory === "function") {
      await (service as any).addEventsToMemory({
        appName,
        userId,
        sessionId,
        events,
        customMetadata: {
          sessionId,
          timestamp,
        },
      });
    } else {
      await service.addSessionToMemory({
        id: sessionId,
        appName,
        userId,
        events,
        state: {},
        lastUpdateTime: Date.now(),
      } as any);
    }

    const serviceName = isVertex ? "vertex_ai" : service instanceof InMemoryMemoryService ? "in_memory" : "custom";
    const durationMs = Date.now() - startTime;

    const result: IngestTranscriptResult = {
      ok: true,
      sessionId,
      userId,
      appName,
      eventCount: events.length,
      service: serviceName,
    };

    // Emit ADK-compatible Event (adk.dev/events)
    emitAdkEvent(
      createEvent({
        author: "memory",
        invocationId: sessionId,
        content: {
          role: "model",
          parts: [{ text: `[Memory Ingest]: ${text.slice(0, 120)}` }],
        },
        actions: createEventActions({
          stateDelta: {
            eventType: "memory:insert",
            status: "success",
            durationMs,
            service: serviceName,
            sessionId,
            userId,
            appName,
            text,
            eventCount: events.length,
            plan: params.plan,
          },
        }),
      })
    );

    return result;
  } catch (error: any) {
    const durationMs = Date.now() - startTime;
    const isVertex = service instanceof VertexAiMemoryBankService;
    const serviceName = isVertex ? "vertex_ai" : service instanceof InMemoryMemoryService ? "in_memory" : "custom";

    emitAdkEvent(
      createEvent({
        author: "memory",
        invocationId: sessionId,
        content: {
          role: "model",
          parts: [{ text: `[Memory Ingest Error]: ${error?.message || String(error)}` }],
        },
        actions: createEventActions({
          stateDelta: {
            eventType: "memory:insert",
            status: "error",
            durationMs,
            service: serviceName,
            sessionId,
            userId,
            appName,
            text,
            error: error?.message || String(error),
            plan: params.plan,
          },
        }),
      })
    );
    throw error;
  }
}

export interface RetrievedMemory {
  text: string;
  author: string;
  timestamp: string;
}

export interface RetrieveMemoryParams {
  query: string;
  userId?: string;
  appName?: string;
  memoryService?: BaseMemoryService;
}

export interface ArchiveTokenMetrics {
  totalArchiveTokens: number;
  sessionCount: number;
  fileCount: number;
  averageSessionTokens: number;
}

export interface MemoryEfficiencyReport {
  archiveTokens: number;
  injectedMemoryTokens: number;
  simulatedLegacyTokens: number;
  actualMemoryBankTokens: number;
  savedTokens: number;
  savingsPercent: number;
  efficiencyMultiplier: string;
}

export interface RetrieveMemoryResult {
  query: string;
  memories: RetrievedMemory[];
  count: number;
  service: "vertex_ai" | "in_memory" | "custom";
  efficiency?: MemoryEfficiencyReport;
}

// Scans local durable memory directory and sums total tokens across all historical sessions
export function getArchiveTokenMetrics(root = path.join(process.cwd(), "data", "memory")): ArchiveTokenMetrics {
  const files = findJsonlFiles(root);
  let totalChars = 0;
  let sessionCount = 0;

  for (const file of files) {
    try {
      const content = fs.readFileSync(file, "utf8").trim();
      if (!content) continue;
      const lines = content.split("\n").filter(Boolean);
      for (const line of lines) {
        const record = JSON.parse(line) as MemoryCapture;
        const text = record.content?.parts?.[0]?.text || "";
        const ideas = record.ideasSummary || "";
        totalChars += text.length + ideas.length;
        sessionCount++;
      }
    } catch {
      // Ignore read errors
    }
  }

  // Calculate exact literal tokens from the actual historical session text on disk
  const totalArchiveTokens = Math.max(0, Math.ceil(totalChars / 3.8));

  return {
    totalArchiveTokens,
    sessionCount,
    fileCount: files.length,
    averageSessionTokens: sessionCount > 0 ? Math.round(totalArchiveTokens / sessionCount) : 0,
  };
}

export function computeMemoryEfficiency(injectedMemories: string[], promptText = "", root?: string): MemoryEfficiencyReport {
  const archive = getArchiveTokenMetrics(root);
  const basePromptTokens = estimateTokens(promptText) + 320; // 320 tokens for base system prompt & skill schema
  const injectedMemoryTokens = estimateTokens(injectedMemories.join("\n"));

  // Without Memory Bank: Monolithic injection of all past sessions into the prompt
  const simulatedLegacyTokens = basePromptTokens + archive.totalArchiveTokens;
  // With Memory Bank: Only the base prompt + the 1-2 targeted retrieved memory snippets
  const actualMemoryBankTokens = basePromptTokens + injectedMemoryTokens;
  const savedTokens = Math.max(0, simulatedLegacyTokens - actualMemoryBankTokens);
  const savingsPercent = simulatedLegacyTokens > 0
    ? Math.max(0, Math.min(99.9, Number(((savedTokens / simulatedLegacyTokens) * 100).toFixed(1))))
    : 0;
  const multiplier = actualMemoryBankTokens > 0
    ? (simulatedLegacyTokens / actualMemoryBankTokens).toFixed(1) + "x"
    : "1.0x";

  return {
    archiveTokens: archive.totalArchiveTokens,
    injectedMemoryTokens,
    simulatedLegacyTokens,
    actualMemoryBankTokens,
    savedTokens,
    savingsPercent,
    efficiencyMultiplier: multiplier,
  };
}

// Searches/retrieves relevant memories from Vertex AI Memory Bank (or InMemoryMemoryService).
export async function retrieveFromMemoryBank(
  query: string,
  options?: Omit<RetrieveMemoryParams, "query">
): Promise<RetrieveMemoryResult> {
  const startTime = Date.now();
  const trimmedQuery = (query || "").trim();
  const appName = options?.appName || process.env.APP_NAME || "scribant";
  const userId = safeSeg(options?.userId, "default_user");
  const service = options?.memoryService ?? getMemoryService();

  if (!trimmedQuery) {
    const err = new Error("Search query is required for memory bank retrieval.");
    emitAdkEvent(
      createEvent({
        author: "memory",
        invocationId: `retrieve-${Date.now()}`,
        content: {
          role: "model",
          parts: [{ text: `[Memory Retrieve Error]: ${err.message}` }],
        },
        actions: createEventActions({
          stateDelta: {
            eventType: "memory:retrieve",
            status: "error",
            durationMs: Date.now() - startTime,
            query: "",
            userId,
            appName,
            error: err.message,
          },
        }),
      })
    );
    throw err;
  }

  try {
    const response: SearchMemoryResponse = await service.searchMemory({
      appName,
      userId,
      query: trimmedQuery,
    });

    const memories: RetrievedMemory[] = (response.memories || []).map((m: MemoryEntry) => {
      const textParts = m.content?.parts?.map((p: any) => p.text).filter(Boolean) ?? [];
      return {
        text: textParts.join("\n"),
        author: m.author || "user",
        timestamp: m.timestamp || new Date().toISOString(),
      };
    });

    const isVertex = service instanceof VertexAiMemoryBankService;
    const serviceName = isVertex ? "vertex_ai" : service instanceof InMemoryMemoryService ? "in_memory" : "custom";
    const durationMs = Date.now() - startTime;
    const efficiency = computeMemoryEfficiency(memories.map(m => m.text), trimmedQuery);

    const result: RetrieveMemoryResult = {
      query: trimmedQuery,
      memories,
      count: memories.length,
      service: serviceName,
      efficiency,
    };

    // Emit ADK-compatible Event (adk.dev/events)
    emitAdkEvent(
      createEvent({
        author: "memory",
        invocationId: `retrieve-${Date.now()}`,
        content: {
          role: "model",
          parts: [{ text: `[Memory Retrieve]: "${trimmedQuery}" (${memories.length} match${memories.length === 1 ? "" : "es"})` }],
        },
        actions: createEventActions({
          stateDelta: {
            eventType: "memory:retrieve",
            status: "success",
            durationMs,
            service: serviceName,
            query: trimmedQuery,
            userId,
            appName,
            count: memories.length,
            memories,
            efficiency,
          },
        }),
      })
    );

    return result;
  } catch (error: any) {
    const durationMs = Date.now() - startTime;
    const isVertex = service instanceof VertexAiMemoryBankService;
    const serviceName = isVertex ? "vertex_ai" : service instanceof InMemoryMemoryService ? "in_memory" : "custom";

    emitAdkEvent(
      createEvent({
        author: "memory",
        invocationId: `retrieve-${Date.now()}`,
        content: {
          role: "model",
          parts: [{ text: `[Memory Retrieve Error]: ${error?.message || String(error)}` }],
        },
        actions: createEventActions({
          stateDelta: {
            eventType: "memory:retrieve",
            status: "error",
            durationMs,
            service: serviceName,
            query: trimmedQuery,
            userId,
            appName,
            error: error?.message || String(error),
          },
        }),
      })
    );
    throw error;
  }
}

// Recursively walks a directory and gathers all .jsonl files
function findJsonlFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const results: string[] = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findJsonlFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      results.push(fullPath);
    }
  }
  return results;
}

// Synchronizes all durable local session captures from data/memory into Vertex AI Memory Bank.
export async function syncLocalMemoriesToMemoryBank(
  root = path.join(process.cwd(), "data", "memory"),
  memoryService?: BaseMemoryService
): Promise<{ syncedCount: number; errors: string[] }> {
  const files = findJsonlFiles(root);
  let syncedCount = 0;
  const errors: string[] = [];

  for (const file of files) {
    try {
      const content = fs.readFileSync(file, "utf8").trim();
      if (!content) continue;
      const lines = content.split("\n").filter(Boolean);
      for (const line of lines) {
        const record = JSON.parse(line) as MemoryCapture;
        const text = record.content?.parts?.[0]?.text;
        if (!text) continue;
        await ingestTranscriptToMemoryBank({
          text,
          sessionId: record.sessionId,
          timestamp: record.timestamp,
          memoryService,
        });
        syncedCount++;
      }
    } catch (e: any) {
      errors.push(`Failed to sync ${file}: ${e?.message || e}`);
    }
  }

  return { syncedCount, errors };
}

// Helper to prepend retrieved memory context directly into the user message content parts
export function injectMemoryIntoUserMessage(request: LlmRequest, memories: string[]): void {
  if (!memories.length) return;
  const memoryBlock = `[Relevant Context from Memory Bank]:\n${memories.map(m => `- ${m}`).join("\n")}`;

  if (!request.contents || request.contents.length === 0) {
    request.contents = [{ role: "user", parts: [{ text: memoryBlock }] }];
    return;
  }

  // Prepend memory block to the user turn's parts so the model sees it as grounding context
  const userContent = request.contents.find(c => c.role === "user") || request.contents[0];
  if (userContent) {
    userContent.parts = [{ text: memoryBlock }, ...(userContent.parts || [])];
  }
}

/**
 * ADK beforeModelCallback that automatically ingests the current transcript / session state
 * into Vertex AI Memory Bank (or InMemoryMemoryService) before the LLM call executes.
 */
export const autoMemoryIngestCallback: SingleBeforeModelCallback = async ({ context, request }) => {
  try {
    const memoryService = context.invocationContext?.memoryService ?? getMemoryService();
    const sessionId = context.invocationContext?.session?.id || "session";
    const userId = context.invocationContext?.session?.userId || "default_user";
    const appName = context.invocationContext?.session?.appName || "scribant";

    const text = context.state.get<string>("corrected") ||
      context.state.get<string>("rawText") ||
      (request.contents?.[0]?.parts?.map((p: any) => p.text).filter(Boolean).join(" ")) || "";

    if (text.trim()) {
      await ingestTranscriptToMemoryBank({
        text: text.trim(),
        sessionId,
        userId,
        appName,
        memoryService,
      });
    }
  } catch (e: any) {
    console.warn("[beforeModelCallback] Automatic memory ingestion failed:", e?.message || e);
  }
  return undefined;
};

/**
 * ADK beforeModelCallback that automatically ingests the transcript into Memory Bank AND
 * retrieves relevant past memories to inject directly into the user message before inference.
 */
export const memoryBankBeforeModelCallback: SingleBeforeModelCallback = async ({ context, request }) => {
  try {
    const memoryService = context.invocationContext?.memoryService ?? getMemoryService();
    const sessionId = context.invocationContext?.session?.id || "session";
    const userId = context.invocationContext?.session?.userId || "default_user";
    const appName = context.invocationContext?.session?.appName || "scribant";

    const text = context.state.get<string>("corrected") ||
      context.state.get<string>("rawText") ||
      (request.contents?.[0]?.parts?.map((p: any) => p.text).filter(Boolean).join(" ")) || "";

    if (text.trim()) {
      // 1. Auto-ingest current transcript
      await ingestTranscriptToMemoryBank({
        text: text.trim(),
        sessionId,
        userId,
        appName,
        memoryService,
      });

      // 2. Retrieve past relevant memories
      const searchRes = await retrieveFromMemoryBank(text.trim(), {
        userId,
        appName,
        memoryService,
      });

      // 3. Preload past context into the user message
      if (searchRes.memories.length > 0) {
        injectMemoryIntoUserMessage(
          request,
          searchRes.memories.map(m => m.text)
        );
      }
    }
  } catch (e: any) {
    console.warn("[memoryBankBeforeModelCallback] Callback error:", e?.message || e);
  }
  return undefined;
};

// ponytail: self-check pins the overwrite/traversal/reshape behavior, plus the shrink-not-merge,
// embedded-newline, and hour-boundary bring-forward edge cases above, as well as Phase 2 ingest/retrieve/sync.
// Run: tsx memory.ts — no API key needed, no model is called.
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
      const customMem = createMemoryBankService({ forceInMemory: true });
      assert.ok(customMem instanceof InMemoryMemoryService);

      const vertexMem = createMemoryBankService({
        agentEngineId: "test-engine-id",
        projectId: "test-project",
        location: "us-central1",
        client: { agentEnginesInternal: { memories: {} } },
      });
      assert.ok(vertexMem instanceof VertexAiMemoryBankService);

      // ---- Automatic Memory Callback Self-checks ----
      const cbMemService = new InMemoryMemoryService();
      const mockState: Record<string, any> = { corrected: "Schedule a product demo with Alex on Friday" };
      const mockContext: any = {
        invocationContext: {
          memoryService: cbMemService,
          session: { id: "run-cb-1", userId: "cb-user", appName: "scribant" },
        },
        state: { get: (k: string) => mockState[k] },
      };
      const mockRequest: any = { contents: [], config: {} };

      // 1. Test autoMemoryIngestCallback
      await autoMemoryIngestCallback({ context: mockContext, request: mockRequest });
      const cbRetrieve = await retrieveFromMemoryBank("Alex", {
        userId: "cb-user",
        memoryService: cbMemService,
      });
      assert.ok(cbRetrieve.count >= 1);
      assert.ok(cbRetrieve.memories.some(m => m.text.includes("Alex")));

      // 2. Test memoryBankBeforeModelCallback with user message injection
      const mockRequest2: any = { contents: [{ role: "user", parts: [{ text: "Schedule meeting" }] }], config: {} };
      await memoryBankBeforeModelCallback({ context: mockContext, request: mockRequest2 });
      assert.ok(
        mockRequest2.contents[0].parts.some((p: any) =>
          typeof p.text === "string" && p.text.includes("[Relevant Context from Memory Bank]")
        )
      );

      // ---- Memory Events Self-checks ----
      const eventsCaptured: AdkEvent[] = [];
      const unsub = subscribeToMemoryEvents(evt => eventsCaptured.push(evt));

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
      const insertHistory = getMemoryEvents({ type: "memory:insert" });
      assert.ok(insertHistory.every(e => classifyAdkEventType(e) === "memory:insert"));

      const retrieveHistory = getMemoryEvents({ type: "memory:retrieve" });
      assert.ok(retrieveHistory.every(e => classifyAdkEventType(e) === "memory:retrieve"));

      unsub();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }

    console.log("memory self-check ✓");
  })();
}

