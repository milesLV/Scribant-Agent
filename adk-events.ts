/**
 * ADK Events Hub & Disk Logger (adk.dev/events)
 *
 * Implements an ADK-native event emitter, disk logger, and stream tap for all
 * agent runs, tool calls, model thoughts, content generation, and memory bank operations.
 *
 * Persists all events to disk as JSON Lines under ./data/events/{YYYY}/{MM}/{DD}/{HH}/events.jsonl
 * to enable accurate historical querying and filtering across server restarts.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createEvent,
  createEventActions,
  toStructuredEvents,
  EventType,
  type Event as AdkEvent,
} from "@google/adk";
import { hourBucket } from "./server-utils";

export { createEvent, createEventActions, toStructuredEvents, EventType, type AdkEvent };

export type AdkEventListener = (event: AdkEvent) => void;

/**
 * Classifies an ADK Event into a canonical event type string for filtering.
 */
export function classifyAdkEventType(event: AdkEvent): string {
  const anyEvt = event as any;

  // 1. Direct type property if present
  if (typeof anyEvt.type === "string" && anyEvt.type && anyEvt.type !== "event") {
    return anyEvt.type;
  }

  // 2. Explicit event type in state delta or metadata
  const delta = event.actions?.stateDelta || anyEvt.actions?.state_delta || anyEvt.stateDelta || {};
  const stateEventType =
    delta.eventType ||
    delta.event_type ||
    anyEvt.eventType ||
    event.customMetadata?.eventType ||
    anyEvt.customMetadata?.event_type;

  if (typeof stateEventType === "string" && stateEventType) {
    return stateEventType;
  }

  // 3. Check memory author
  if (event.author === "memory" || anyEvt.author === "memory_service") {
    const hasQuery = delta.query || anyEvt.query;
    const isRetrieveText = event.content?.parts?.some((p) => typeof p.text === "string" && p.text.includes("[Memory Retrieve]"));
    if (hasQuery || isRetrieveText) {
      return "memory:retrieve";
    }
    return "memory:insert";
  }

  // 4. Error code
  if (event.errorCode || anyEvt.error) {
    return "error";
  }

  // 5. ADK Structured Events inspection
  const structured = toStructuredEvents(event);
  if (structured.some((s) => s.type === EventType.TOOL_CALL)) {
    return "tool_call";
  }
  if (structured.some((s) => s.type === EventType.TOOL_RESULT)) {
    return "tool_result";
  }
  if (structured.some((s) => s.type === EventType.THOUGHT)) {
    return "thought";
  }
  if (structured.some((s) => s.type === EventType.CALL_CODE || s.type === EventType.CODE_RESULT)) {
    return "code_exec";
  }
  if (structured.some((s) => s.type === EventType.ERROR)) {
    return "error";
  }
  if (structured.some((s) => s.type === EventType.CONTENT)) {
    return "content";
  }
  if (structured.some((s) => s.type === EventType.FINISHED)) {
    return "finished";
  }

  // 6. Fallback to author or generic agent
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

/**
 * Appends an ADK Event to disk under ./data/events/{YYYY}/{MM}/{DD}/{HH}/events.jsonl.
 */
export function logAdkEventToDisk(
  event: AdkEvent,
  root = path.join(process.cwd(), "data", "events"),
  now = new Date(event.timestamp || Date.now())
): string {
  try {
    const bucketDir = path.join(root, hourBucket(now));
    if (!fs.existsSync(bucketDir)) {
      fs.mkdirSync(bucketDir, { recursive: true });
    }
    const filePath = path.join(bucketDir, "events.jsonl");
    const jsonLine = JSON.stringify(event) + "\n";
    fs.appendFileSync(filePath, jsonLine, "utf8");
    return filePath;
  } catch (err) {
    console.warn("[adk-events] Failed to log event to disk:", err);
    return "";
  }
}

/**
 * Reads and accurately filters historical ADK Events from disk.
 */
export function readAdkEventsFromDisk(
  options?: AdkEventFilterOptions,
  root = path.join(process.cwd(), "data", "events")
): AdkEvent[] {
  if (!fs.existsSync(root)) return [];

  const files = findJsonlFiles(root);
  // Sort files newest first by path name (which has YYYY/MM/DD/HH hierarchy)
  files.sort((a, b) => b.localeCompare(a));

  const eventMap = new Map<string, AdkEvent>();

  for (const file of files) {
    try {
      const content = fs.readFileSync(file, "utf8");
      const lines = content.split("\n");
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const event: AdkEvent = JSON.parse(trimmed);
          if (event && event.id) {
            // Newest event versions keep priority
            if (!eventMap.has(event.id)) {
              eventMap.set(event.id, event);
            }
          }
        } catch {
          // Ignore malformed line
        }
      }
    } catch (e) {
      console.warn(`[adk-events] Failed to read event file ${file}:`, e);
    }
  }

  let events = Array.from(eventMap.values());
  // Sort by timestamp descending
  events.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

  // Apply filters
  if (options) {
    if (options.type && options.type !== "all") {
      const targetType = options.type;
      events = events.filter((e) => classifyAdkEventType(e) === targetType);
    }

    if (options.author && options.author !== "all") {
      const targetAuthor = options.author;
      events = events.filter((e) => e.author === targetAuthor);
    }

    if (options.status && options.status !== "all") {
      const targetStatus = options.status;
      events = events.filter((e) => {
        const deltaStatus = e.actions?.stateDelta?.status;
        if (targetStatus === "error") {
          return e.errorCode || deltaStatus === "error";
        }
        if (targetStatus === "success") {
          return !e.errorCode && deltaStatus !== "error";
        }
        return true;
      });
    }

    if (options.sessionId) {
      const targetSession = options.sessionId;
      events = events.filter(
        (e) =>
          e.invocationId === targetSession ||
          e.actions?.stateDelta?.sessionId === targetSession
      );
    }

    if (typeof options.since === "number") {
      events = events.filter((e) => e.timestamp >= options.since!);
    }

    if (typeof options.until === "number") {
      events = events.filter((e) => e.timestamp <= options.until!);
    }

    if (options.search && options.search.trim()) {
      const q = options.search.toLowerCase().trim();
      events = events.filter((e) => {
        const raw = JSON.stringify(e).toLowerCase();
        return raw.includes(q);
      });
    }

    if (options.limit && options.limit > 0) {
      events = events.slice(0, options.limit);
    }
  }

  return events;
}

/**
 * Central event stream that buffers, logs to disk, and broadcasts all ADK events in real time.
 */
export class AdkEventStream {
  private listeners: Set<AdkEventListener> = new Set();
  private history: AdkEvent[] = [];
  private maxHistory: number = 300;
  private diskRoot: string;

  constructor(diskRoot = path.join(process.cwd(), "data", "events")) {
    this.diskRoot = diskRoot;
    this.initFromDisk();
  }

  /**
   * Initializes in-memory history snapshot from disk.
   */
  private initFromDisk(): void {
    try {
      const loaded = readAdkEventsFromDisk({ limit: this.maxHistory }, this.diskRoot);
      this.history = loaded;
    } catch {
      this.history = [];
    }
  }

  /**
   * Emits an ADK Event to all subscribers, appends it to in-memory history,
   * and persists it to disk.
   */
  emit(event: AdkEvent): AdkEvent {
    // 1. In-memory buffer
    this.history.unshift(event);
    if (this.history.length > this.maxHistory) {
      this.history.length = this.maxHistory;
    }

    // 2. Persist to disk
    logAdkEventToDisk(event, this.diskRoot);

    // 3. Notify real-time subscribers
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        console.warn("[adk-events] Listener error:", err);
      }
    }
    return event;
  }

  /**
   * Subscribes to real-time ADK events. Returns an unsubscribe function.
   */
  subscribe(listener: AdkEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Updates the latest event matching a predicate (e.g. adding synthesized answers).
   * Also appends the updated event to disk.
   */
  updateLatest(
    predicate: (event: AdkEvent) => boolean,
    updater: (event: AdkEvent) => void
  ): AdkEvent | null {
    const target = this.history.find(predicate);
    if (target) {
      updater(target);
      logAdkEventToDisk(target, this.diskRoot);
      for (const listener of this.listeners) {
        try {
          listener(target);
        } catch (err) {
          console.warn("[adk-events] Listener error on update:", err);
        }
      }
      return target;
    }
    return null;
  }

  /**
   * Returns event history with optional type/author/status/limit filters.
   * If `fromDisk: true`, performs an accurate query across all disk files.
   */
  getEvents(options?: AdkEventFilterOptions): AdkEvent[] {
    if (options?.fromDisk) {
      return readAdkEventsFromDisk(options, this.diskRoot);
    }

    let result = this.history;

    if (options?.type && options.type !== "all") {
      const targetType = options.type;
      result = result.filter((e) => classifyAdkEventType(e) === targetType);
    }

    if (options?.author && options.author !== "all") {
      const targetAuthor = options.author;
      result = result.filter((e) => e.author === targetAuthor);
    }

    if (options?.status && options.status !== "all") {
      const targetStatus = options.status;
      result = result.filter((e) => {
        const deltaStatus = e.actions?.stateDelta?.status;
        if (targetStatus === "error") {
          return e.errorCode || deltaStatus === "error";
        }
        if (targetStatus === "success") {
          return !e.errorCode && deltaStatus !== "error";
        }
        return true;
      });
    }

    if (options?.sessionId) {
      const targetSession = options.sessionId;
      result = result.filter(
        (e) =>
          e.invocationId === targetSession ||
          e.actions?.stateDelta?.sessionId === targetSession
      );
    }

    if (options?.search && options.search.trim()) {
      const q = options.search.toLowerCase().trim();
      result = result.filter((e) => {
        const raw = JSON.stringify(e).toLowerCase();
        return raw.includes(q);
      });
    }

    if (options?.limit && options.limit > 0) {
      result = result.slice(0, options.limit);
    }

    return [...result];
  }

  /**
   * Clears the in-memory history and optionally disk files.
   */
  clear(options?: { clearDisk?: boolean }): void {
    this.history = [];
    if (options?.clearDisk && fs.existsSync(this.diskRoot)) {
      try {
        fs.rmSync(this.diskRoot, { recursive: true, force: true });
      } catch (err) {
        console.warn("[adk-events] Failed to clear disk event directory:", err);
      }
    }
  }
}

export const adkEventStream = new AdkEventStream();

export function emitAdkEvent(event: AdkEvent): AdkEvent {
  return adkEventStream.emit(event);
}

export function subscribeToAdkEvents(listener: AdkEventListener): () => void {
  return adkEventStream.subscribe(listener);
}

export function getAdkEvents(options?: AdkEventFilterOptions): AdkEvent[] {
  return adkEventStream.getEvents(options);
}

export function clearAdkEvents(options?: { clearDisk?: boolean }): void {
  adkEventStream.clear(options);
}

// Self-check for disk logging, loading, and accurate filtering
if (import.meta.url && process.argv[1] === fileURLToPath(import.meta.url)) {
  (async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "adk-events-test-"));
    try {
      const stream = new AdkEventStream(tmpRoot);

      // 1. Emit memory insert event
      const insertEvt = createEvent({
        id: "test-insert-1",
        author: "memory",
        invocationId: "session-123",
        timestamp: Date.now() - 5000,
        content: { role: "model", parts: [{ text: "Recorded preference for dark mode" }] },
        actions: createEventActions({
          stateDelta: {
            eventType: "memory:insert",
            status: "success",
            sessionId: "session-123",
            userId: "user-abc",
            text: "User prefers dark mode",
          },
        }),
      });
      stream.emit(insertEvt);

      // 2. Emit memory retrieve event
      const retrieveEvt = createEvent({
        id: "test-retrieve-1",
        author: "memory",
        invocationId: "session-124",
        timestamp: Date.now() - 2000,
        content: { role: "model", parts: [{ text: "Retrieved preference: dark mode" }] },
        actions: createEventActions({
          stateDelta: {
            eventType: "memory:retrieve",
            status: "success",
            query: "dark mode",
            count: 1,
          },
        }),
      });
      stream.emit(retrieveEvt);

      // 3. Emit thought event
      const thoughtEvt = createEvent({
        id: "test-thought-1",
        author: "intent_classifier",
        timestamp: Date.now() - 1000,
        content: { role: "model", parts: [{ text: "Thinking about dark mode context", thought: true }] },
      });
      stream.emit(thoughtEvt);

      // Verify files written to disk
      const files = findJsonlFiles(tmpRoot);
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
