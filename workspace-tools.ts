// Server-side Google Workspace executors + their ADK FunctionTool wrappers.
// Real mode calls the Google REST APIs with a per-request OAuth token forwarded from the client
// (tokens live in the browser; there is no server-side OAuth). With no token the tools DRY-RUN:
// mint a mock id and echo what would have happened — the browser's localStorage sandbox is a
// separate, client-only simulation and stays untouched.
import { z } from "zod";
import { FunctionTool } from "@google/adk";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

// Lean shapes — just what the APIs need (client types carry UI status fields we don't want here).
export interface EventInput { title: string; description?: string; start: string; end?: string; allDay?: boolean; }
export interface TaskInput { title: string; notes?: string; dueDate?: string; }

async function googlePost(url: string, token: string, body: unknown): Promise<any> {
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error?.message || `Google API error ${res.status}`);
  return data;
}

// All-day events use {date} (end exclusive per Google); timed events use {dateTime, timeZone}.
// Exported for the self-check — the end-date bump is the branchy bit worth pinning.
export function toGcalDates(event: EventInput): { start: any; end: any } {
  if (event.allDay) {
    const dateOnly = (iso: string) => new Date(iso).toISOString().slice(0, 10);
    const sd = dateOnly(event.start);
    let ed = event.end ? dateOnly(event.end) : sd;
    if (ed <= sd) {
      const next = new Date(sd);
      next.setUTCDate(next.getUTCDate() + 1);
      ed = next.toISOString().slice(0, 10);
    }
    return { start: { date: sd }, end: { date: ed } };
  }
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  return { start: { dateTime: event.start, timeZone }, end: { dateTime: event.end, timeZone } };
}

export async function gcalCreateEvent(token: string, event: EventInput): Promise<string> {
  const { start, end } = toGcalDates(event);
  const data = await googlePost(
    "https://www.googleapis.com/calendar/v3/calendars/primary/events",
    token,
    { summary: event.title, description: event.description, start, end },
  );
  return data.id;
}

// Google Tasks keeps only the date portion of `due`.
export async function gtasksCreateTask(token: string, task: TaskInput): Promise<string> {
  const data = await googlePost(
    "https://www.googleapis.com/tasks/v1/lists/@default/tasks",
    token,
    { title: task.title, notes: task.notes, ...(task.dueDate ? { due: new Date(task.dueDate).toISOString() } : {}) },
  );
  return data.id;
}

const mockId = (prefix: string) => `${prefix}-${crypto.randomUUID().slice(0, 8)}`;

type SearchFn = (query: string) => Promise<{ condensed: string; inDepth: string; sources: { uri: string; title: string }[] }>;

// The three tools the orchestrator agent can call. token === null ⇒ dry-run (mock ids, no network
// except search, which is read-only and always real).
export function buildWorkspaceTools(opts: { token: string | null; search: SearchFn }) {
  const { token, search } = opts;
  return [
    new FunctionTool({
      name: "create_calendar_event",
      description: "Schedule an event on the user's Google Calendar. Use for things that happen at a specific time or occupy whole days.",
      parameters: z.object({
        title: z.string().describe("Event summary/title"),
        description: z.string().describe("Event description/context; empty string if none"),
        start: z.string().describe("Start as ISO-8601 local datetime, e.g. 2026-07-10T15:00:00"),
        end: z.string().describe("End as ISO-8601 local datetime; 30 minutes after start if no duration implied"),
        allDay: z.boolean().describe("True if it spans whole day(s) with no specific clock time"),
      }),
      execute: async (event) =>
        token
          ? { eventId: await gcalCreateEvent(token, event), simulated: false }
          : { eventId: mockId("mock-evt"), simulated: true },
    }),
    new FunctionTool({
      name: "create_task",
      description: "Add a todo item to the user's Google Tasks list. Use for actions to complete, optionally with a deadline.",
      parameters: z.object({
        title: z.string().describe("Compact title of the task"),
        notes: z.string().describe("Descriptions, sub-items, or context; empty string if none"),
        dueDate: z.string().describe("Deadline as ISO date YYYY-MM-DD, or empty string if open-ended"),
      }),
      execute: async (task) =>
        token
          ? { taskId: await gtasksCreateTask(token, task), simulated: false }
          : { taskId: mockId("mock-task"), simulated: true },
    }),
    new FunctionTool({
      name: "web_search",
      description: "Run a grounded Google web search and return a sourced answer. Use for well-defined, searchable questions the user raised.",
      parameters: z.object({ query: z.string().describe("The search query text") }),
      execute: async ({ query }) => search(query),
    }),
  ];
}

// ponytail: self-check pins the date-shape logic and the dry-run seam. Run: tsx workspace-tools.ts
if (process.argv[1] === fileURLToPath(import.meta.url)) (async () => {
  // all-day: end is exclusive, same-day span bumps one day
  assert.deepEqual(
    toGcalDates({ title: "t", start: "2026-07-10T00:00:00Z", allDay: true }),
    { start: { date: "2026-07-10" }, end: { date: "2026-07-11" } },
  );
  // all-day multi-day span keeps the stated end
  assert.deepEqual(
    toGcalDates({ title: "t", start: "2026-07-10T00:00:00Z", end: "2026-07-12T00:00:00Z", allDay: true }).end,
    { date: "2026-07-12" },
  );
  // timed events carry dateTime + a timeZone
  const timed = toGcalDates({ title: "t", start: "2026-07-10T15:00:00", end: "2026-07-10T15:30:00" });
  assert.equal(timed.start.dateTime, "2026-07-10T15:00:00");
  assert.ok(timed.start.timeZone);

  // real mode posts the right shape (fetch stubbed)
  const realFetch = globalThis.fetch;
  let captured: any = null;
  globalThis.fetch = (async (url: any, init: any) => {
    captured = { url: String(url), body: JSON.parse(init.body) };
    return new Response(JSON.stringify({ id: "real-123" }), { status: 200 });
  }) as any;
  try {
    const id = await gtasksCreateTask("tok", { title: "Buy milk", notes: "", dueDate: "2026-07-11" });
    assert.equal(id, "real-123");
    assert.ok(captured.url.includes("tasks/v1/lists/@default/tasks"));
    assert.equal(captured.body.title, "Buy milk");
    assert.ok(captured.body.due.startsWith("2026-07-11"));
    // error surface: non-ok -> throws Google's message
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: { message: "Invalid Credentials" } }), { status: 401 })) as any;
    await assert.rejects(gcalCreateEvent("bad", { title: "x", start: "2026-07-10T15:00:00" }), /Invalid Credentials/);
  } finally {
    globalThis.fetch = realFetch;
  }

  // dry-run: no token -> mock ids, fetch never touched
  globalThis.fetch = (async () => { throw new Error("dry-run must not call fetch"); }) as any;
  try {
    const [cal, task, searchTool] = buildWorkspaceTools({ token: null, search: async q => ({ condensed: `c:${q}`, inDepth: "", sources: [] }) });
    const calRes: any = await cal.runAsync({ args: { title: "t", description: "", start: "2026-07-10T15:00:00", end: "2026-07-10T15:30:00", allDay: false } } as any);
    assert.ok(calRes.simulated && calRes.eventId.startsWith("mock-evt-"));
    const taskRes: any = await task.runAsync({ args: { title: "t", notes: "", dueDate: "" } } as any);
    assert.ok(taskRes.simulated && taskRes.taskId.startsWith("mock-task-"));
    const searchRes: any = await searchTool.runAsync({ args: { query: "q1" } } as any);
    assert.equal(searchRes.condensed, "c:q1");
  } finally {
    globalThis.fetch = realFetch;
  }

  console.log("workspace-tools self-check ✓");
})();
