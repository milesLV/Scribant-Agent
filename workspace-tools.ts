// Server-side Google Workspace executors, called by /api/execute after a human approves an item.
// Real mode calls the Google REST APIs with a per-request OAuth token forwarded from the client
// (tokens live in the browser; there is no server-side OAuth). Signed out, the browser runs its own
// localStorage sandbox and never reaches here.
//
// ponytail: plain functions, no ADK FunctionTool wrappers — nothing calls tools autonomously since
// /api/agent was deleted. If an autonomous mode ever comes back, wrapping these is ~10 lines each.
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

// Undo path. 404/410 = already gone, which is the outcome the caller wanted — treat as success.
async function googleDelete(url: string, token: string): Promise<void> {
  const res = await fetch(url, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } });
  if (res.ok || res.status === 404 || res.status === 410) return;
  const data = await res.json().catch(() => ({}));
  throw new Error(data.error?.message || `Google API error ${res.status}`);
}

export const gcalDeleteEvent = (token: string, eventId: string) =>
  googleDelete(`https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(eventId)}`, token);
export const gtasksDeleteTask = (token: string, taskId: string) =>
  googleDelete(`https://www.googleapis.com/tasks/v1/lists/@default/tasks/${encodeURIComponent(taskId)}`, token);

// ponytail: self-check pins the date-shape logic and the error surface. Run: tsx workspace-tools.ts
// import.meta.url is empty in the esbuild CJS bundle, so self-checks stay dev-only (prod boot would crash on fileURLToPath(undefined)).
if (import.meta.url && process.argv[1] === fileURLToPath(import.meta.url)) (async () => {
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

    // delete: 204 succeeds, 404 is "already gone" (also success), other errors still throw
    let delUrl = "";
    globalThis.fetch = (async (url: any, init: any) => {
      delUrl = `${init.method} ${url}`;
      return new Response(null, { status: 204 });
    }) as any;
    await gcalDeleteEvent("tok", "evt 1");
    assert.ok(delUrl.startsWith("DELETE "));
    assert.ok(delUrl.includes("events/evt%201"), "event id must be URL-encoded");
    globalThis.fetch = (async () => new Response("{}", { status: 404 })) as any;
    await gtasksDeleteTask("tok", "gone"); // must not throw
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: { message: "Insufficient Permission" } }), { status: 403 })) as any;
    await assert.rejects(gtasksDeleteTask("tok", "x"), /Insufficient Permission/);
  } finally {
    globalThis.fetch = realFetch;
  }

  console.log("workspace-tools self-check ✓");
})();
