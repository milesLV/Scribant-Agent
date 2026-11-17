// ADK event hub: in-memory history + real-time subscribers + append-only disk log at
// data/events/{YYYY}/{MM}/{DD}/{HH}/events.jsonl, so history survives restarts.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createEvent, createEventActions, toStructuredEvents, EventType, type Event as AdkEvent } from "@google/adk";
import { hourBucket } from "./server-utils";

export { createEvent, createEventActions, type AdkEvent };

type AdkEventListener = (event: AdkEvent) => void;

// First match wins, in this order.
const STRUCTURED_TYPES: [string, EventType[]][] = [
  ["tool_call", [EventType.TOOL_CALL]],
  ["tool_result", [EventType.TOOL_RESULT]],
  ["thought", [EventType.THOUGHT]],
  ["code_exec", [EventType.CALL_CODE, EventType.CODE_RESULT]],
  ["error", [EventType.ERROR]],
  ["content", [EventType.CONTENT]],
  ["finished", [EventType.FINISHED]],
];

// Canonical type string for filtering: explicit stateDelta.eventType, then memory ops, then the
// ADK structured-event kind, then the author.
export function classifyAdkEventType(event: AdkEvent): string {
  const delta = event.actions?.stateDelta || {};
  if (typeof delta.eventType === "string" && delta.eventType) return delta.eventType;
  if (event.author === "memory") {
    const retrieve = delta.query || event.content?.parts?.some((p) => p.text?.includes("[Memory Retrieve]"));
    return retrieve ? "memory:retrieve" : "memory:insert";
  }
  const kinds = new Set(toStructuredEvents(event).map((s) => s.type));
  if (event.errorCode) kinds.add(EventType.ERROR);
  for (const [name, types] of STRUCTURED_TYPES) {
    if (types.some((t) => kinds.has(t))) return name;
  }
  return event.author || "agent";
}

export interface AdkEventFilterOptions {
  type?: string;
  author?: string;
  status?: string;
  search?: string;
  sessionId?: string;
  since?: number;
  until?: number;
  limit?: number;
  fromDisk?: boolean;
}

const DEFAULT_ROOT = path.join(process.cwd(), "data", "events");

// Newest-first events in, filtered events out. Shared by the disk and in-memory paths.
function filterEvents(events: AdkEvent[], o: AdkEventFilterOptions = {}): AdkEvent[] {
  const isError = (e: AdkEvent) => Boolean(e.errorCode) || e.actions?.stateDelta?.status === "error";
  const q = o.search?.trim().toLowerCase();
  const out = events.filter((e) =>
    (!o.type || o.type === "all" || classifyAdkEventType(e) === o.type) &&
    (!o.author || o.author === "all" || e.author === o.author) &&
    (o.status !== "error" || isError(e)) &&
    (o.status !== "success" || !isError(e)) &&
    (!o.sessionId || e.invocationId === o.sessionId || e.actions?.stateDelta?.sessionId === o.sessionId) &&
    (o.since === undefined || e.timestamp >= o.since) &&
    (o.until === undefined || e.timestamp <= o.until) &&
    (!q || JSON.stringify(e).toLowerCase().includes(q))
  );
  return o.limit && o.limit > 0 ? out.slice(0, o.limit) : out;
}

function logAdkEventToDisk(event: AdkEvent, root: string): void {
  try {
    const dir = path.join(root, hourBucket(new Date(event.timestamp || Date.now())));
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, "events.jsonl"), JSON.stringify(event) + "\n", "utf8");
  } catch (err) {
    console.warn("[adk-events] Failed to log event to disk:", err);
  }
}

const jsonlFiles = (root: string): string[] =>
  fs.existsSync(root)
    ? (fs.readdirSync(root, { recursive: true }) as string[]).filter((f) => f.endsWith(".jsonl")).map((f) => path.join(root, f))
    : [];

export function readAdkEventsFromDisk(options?: AdkEventFilterOptions, root = DEFAULT_ROOT): AdkEvent[] {
  // Newest bucket first (the path is YYYY/MM/DD/HH), so the first copy of an id wins.
  const byId = new Map<string, AdkEvent>();
  for (const file of jsonlFiles(root).sort().reverse()) {
    try {
      for (const line of fs.readFileSync(file, "utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          const event: AdkEvent = JSON.parse(line);
          if (event?.id && !byId.has(event.id)) byId.set(event.id, event);
        } catch { /* malformed line */ }
      }
    } catch (e) {
      console.warn(`[adk-events] Failed to read event file ${file}:`, e);
    }
  }
  const events = [...byId.values()].sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
  return filterEvents(events, options);
}

const MAX_HISTORY = 300;

export class AdkEventStream {
  private listeners = new Set<AdkEventListener>();
  private history: AdkEvent[];

  constructor(private diskRoot = DEFAULT_ROOT) {
    try { this.history = readAdkEventsFromDisk({ limit: MAX_HISTORY }, diskRoot); } catch { this.history = []; }
  }

  emit(event: AdkEvent): AdkEvent {
    this.history.unshift(event);
    this.history.length = Math.min(this.history.length, MAX_HISTORY);
    logAdkEventToDisk(event, this.diskRoot);
    for (const listener of this.listeners) {
      try { listener(event); } catch (err) { console.warn("[adk-events] Listener error:", err); }
    }
    return event;
  }

  subscribe(listener: AdkEventListener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  // In-memory (last MAX_HISTORY) unless fromDisk, which scans every file.
  getEvents(options?: AdkEventFilterOptions): AdkEvent[] {
    return options?.fromDisk ? readAdkEventsFromDisk(options, this.diskRoot) : filterEvents(this.history, options);
  }

  clear(options?: { clearDisk?: boolean }): void {
    this.history = [];
    if (!options?.clearDisk) return;
    try { fs.rmSync(this.diskRoot, { recursive: true, force: true }); } catch (err) {
      console.warn("[adk-events] Failed to clear disk event directory:", err);
    }
  }
}

const adkEventStream = new AdkEventStream();

export const emitAdkEvent = (event: AdkEvent) => adkEventStream.emit(event);
export const subscribeToAdkEvents = (listener: AdkEventListener) => adkEventStream.subscribe(listener);
export const getAdkEvents = (options?: AdkEventFilterOptions) => adkEventStream.getEvents(options);
export const clearAdkEvents = (options?: { clearDisk?: boolean }) => adkEventStream.clear(options);

// Self-check for disk logging, loading, and accurate filtering
if (import.meta.url && process.argv[1] === fileURLToPath(import.meta.url)) {
  (async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "adk-events-test-"));
    try {
      const stream = new AdkEventStream(tmpRoot);

      // A memory insert, a memory retrieve, and a model thought.
      stream.emit(createEvent({
        id: "test-insert-1", author: "memory", invocationId: "session-123", timestamp: Date.now() - 5000,
        content: { role: "model", parts: [{ text: "Recorded preference for dark mode" }] },
        actions: createEventActions({ stateDelta: { eventType: "memory:insert", status: "success", sessionId: "session-123", text: "User prefers dark mode" } }),
      }));
      stream.emit(createEvent({
        id: "test-retrieve-1", author: "memory", invocationId: "session-124", timestamp: Date.now() - 2000,
        content: { role: "model", parts: [{ text: "Retrieved preference: dark mode" }] },
        actions: createEventActions({ stateDelta: { eventType: "memory:retrieve", status: "success", query: "dark mode" } }),
      }));
      stream.emit(createEvent({
        id: "test-thought-1", author: "intent_classifier", timestamp: Date.now() - 1000,
        content: { role: "model", parts: [{ text: "Thinking about dark mode context", thought: true }] },
      }));

      // Verify files written to disk
      const files = jsonlFiles(tmpRoot);
      assert.ok(files.length >= 1, "Events JSONL files should exist on disk");

      // Verify read from disk with filtering by type
      const diskInserts = readAdkEventsFromDisk({ type: "memory:insert" }, tmpRoot);
      assert.equal(diskInserts.length, 1);
      assert.equal(diskInserts[0].id, "test-insert-1");
      assert.equal(classifyAdkEventType(diskInserts[0]), "memory:insert");

      const diskRetrieves = readAdkEventsFromDisk({ type: "memory:retrieve" }, tmpRoot);
      assert.equal(diskRetrieves.length, 1);
      assert.equal(diskRetrieves[0].id, "test-retrieve-1");

      const diskThoughts = readAdkEventsFromDisk({ type: "thought" }, tmpRoot);
      assert.equal(diskThoughts.length, 1);
      assert.equal(diskThoughts[0].id, "test-thought-1");

      // Verify filtering by search query
      const searchResults = readAdkEventsFromDisk({ search: "dark mode" }, tmpRoot);
      assert.equal(searchResults.length, 3);

      // Verify filtering by author
      const classifierResults = readAdkEventsFromDisk({ author: "intent_classifier" }, tmpRoot);
      assert.equal(classifierResults.length, 1);
      assert.equal(classifierResults[0].author, "intent_classifier");

      // Verify in-memory and disk clearing
      stream.clear({ clearDisk: true });
      assert.equal(stream.getEvents().length, 0);
      assert.equal(readAdkEventsFromDisk(undefined, tmpRoot).length, 0);

      console.log("adk-events self-check ✓");
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  })();
}
