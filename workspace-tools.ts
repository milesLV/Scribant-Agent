// Server-side Google Workspace executors (Calendar, Tasks, Drive), called by /api/execute after a
// human approves an item. Real mode calls the Google REST APIs with a per-request OAuth token
// forwarded from the client (tokens live in the browser; there is no server-side OAuth). Signed out,
// the browser runs its own localStorage sandbox and never reaches here.
import { z } from "zod";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

// Lean shapes — just what the APIs need (client types carry UI status fields we don't want here).
interface EventInput { title: string; description?: string; start: string; end?: string; allDay?: boolean; timeZone?: string; }
interface TaskInput { title: string; notes?: string; dueDate?: string; }

async function googleFetch(method: "GET" | "POST" | "PATCH", url: string, token: string, body?: unknown): Promise<any> {
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const data = await res.json().catch(() => ({}));
  // Keep the status and Google's reason code — "Not Found" alone can't distinguish a missing record
  // from an API that is disabled or not provisioned for the account.
  if (!res.ok) {
    const e = data.error || {}, u = new URL(url), reason = e.errors?.[0]?.reason || e.status;
    throw new Error(`${e.message || "Google API error"} (HTTP ${res.status}${reason ? `, ${reason}` : ""}) @ ${method} ${u.host}${u.pathname}`);
  }
  return data;
}
const googlePost = (url: string, token: string, body: unknown) => googleFetch("POST", url, token, body);
const googleGet = (url: string, token: string) => googleFetch("GET", url, token);
// PATCH, not PUT: Google treats PUT as a full replace, so any field we omit would be wiped. The
// planner only ever re-states the fields it knows about, so a merge-update is the correct verb.
const googlePatch = (url: string, token: string, body: unknown) => googleFetch("PATCH", url, token, body);

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
  const timeZone = event.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
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

const gcalEventUrl = (eventId: string) =>
  `https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(eventId)}`;

// Edit an event already on the calendar rather than booking a second one. The live planner keeps
// refining the same appointment as the speaker adds a time, a place or a duration.
export async function gcalUpdateEvent(token: string, eventId: string, event: EventInput): Promise<string> {
  const { start, end } = toGcalDates(event);
  const data = await googlePatch(gcalEventUrl(eventId), token,
    { summary: event.title, description: event.description, start, end });
  return data.id;
}

// Tasks has no "@default" alias on the tasklist path the way Calendar has "primary" — the id has to
// be looked up, and an account that has never opened Tasks owns no list at all. Both cases surface
// as a bare 404 "Not Found". The first list is the account's default one.
async function resolveTaskListId(token: string): Promise<string> {
  const lists = await googleGet("https://www.googleapis.com/tasks/v1/users/@me/lists?maxResults=100", token);
  return lists.items?.[0]?.id
    ?? (await googlePost("https://www.googleapis.com/tasks/v1/users/@me/lists", token, { title: "My Tasks" })).id;
}

const tasksUrl = (listId: string, taskId?: string) =>
  `https://www.googleapis.com/tasks/v1/lists/${encodeURIComponent(listId)}/tasks${taskId ? `/${encodeURIComponent(taskId)}` : ""}`;

// Google Tasks keeps only the date portion of `due`.
export async function gtasksCreateTask(token: string, task: TaskInput): Promise<string> {
  const data = await googlePost(
    tasksUrl(await resolveTaskListId(token)),
    token,
    { title: task.title, notes: task.notes, ...(task.dueDate ? { due: new Date(task.dueDate).toISOString() } : {}) },
  );
  return data.id;
}

export async function gtasksUpdateTask(token: string, taskId: string, task: TaskInput): Promise<string> {
  const data = await googlePatch(tasksUrl(await resolveTaskListId(token), taskId), token,
    { title: task.title, notes: task.notes, ...(task.dueDate ? { due: new Date(task.dueDate).toISOString() } : {}) });
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
export const gtasksDeleteTask = async (token: string, taskId: string) =>
  googleDelete(tasksUrl(await resolveTaskListId(token), taskId), token);

// Reuse the session folder if it already exists — every save from the same session names the same
// folder, and Drive is happy to create a hundred folders with identical names. With the drive.file
// scope the search only sees files this app created, which is exactly the set we could reuse.
export async function gdriveCreateFolder(token: string, folderName: string): Promise<string> {
  const q = `name='${folderName.replace(/'/g, "\\'")}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  const found = await googleGet(
    `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id)`,
    token,
  ).catch(() => null); // a failed lookup just means we create a new one
  if (found?.files?.length) return found.files[0].id;

  const data = await googlePost("https://www.googleapis.com/drive/v3/files", token, {
    name: folderName,
    mimeType: "application/vnd.google-apps.folder",
  });
  return data.id;
}

// Drive uploads are two calls: create the metadata, then PATCH the bytes to the media endpoint.
// The second one can't go through googlePost — its body is raw markdown, not JSON.
export async function gdriveUploadDoc(token: string, fileName: string, content: string, folderId?: string): Promise<string> {
  const meta = await googlePost("https://www.googleapis.com/drive/v3/files", token, {
    name: fileName,
    mimeType: "text/markdown",
    ...(folderId ? { parents: [folderId] } : {}),
  });
  const res = await fetch(`https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(meta.id)}?uploadType=media`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "text/markdown" },
    body: content,
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error?.message || `Google API error ${res.status}`);
  }
  return meta.id;
}

export async function gdocsCreateDocument(token: string, title: string, content?: string): Promise<string> {
  const doc = await googlePost("https://docs.googleapis.com/v1/documents", token, { title });
  if (content && doc.documentId) {
    await googlePost(`https://docs.googleapis.com/v1/documents/${encodeURIComponent(doc.documentId)}:batchUpdate`, token, {
      requests: [{ insertText: { location: { index: 1 }, text: content } }],
    });
  }
  return doc.documentId;
}

export async function gsheetsCreateSpreadsheet(token: string, title: string): Promise<string> {
  const sheet = await googlePost("https://sheets.googleapis.com/v1/spreadsheets", token, {
    properties: { title },
  });
  return sheet.spreadsheetId;
}

interface WorkspaceAction {
  description: string;
  parameters: z.ZodObject<any>;
  run: (token: string, args: any) => Promise<Record<string, unknown>>;
}

// ONE definition per capability: schema, description and handler in one place, keyed by the name an
// agent would call. /api/execute looks the action up here after a human approves an item, so the
// Zod schema doubles as the endpoint's request validation.
export const WORKSPACE_ACTIONS: Record<string, WorkspaceAction> = {
  create_calendar_event: {
    description: "Schedule an event on the user's Google Calendar. Use for things that happen at a specific time or occupy whole days.",
    parameters: z.object({
      title: z.string().min(1).describe("Event summary/title"),
      description: z.string().optional().describe("Event description/context; empty string if none"),
      start: z.string().min(1).describe("Start as ISO-8601 local datetime, e.g. 2026-07-10T15:00:00"),
      end: z.string().optional().describe("End as ISO-8601 local datetime; 30 minutes after start if no duration implied"),
      allDay: z.boolean().optional().describe("True if it spans whole day(s) with no specific clock time"),
      timeZone: z.string().optional().describe("IANA time zone identifier, e.g. America/Los_Angeles"),
    }),
    run: async (token, event) => ({ eventId: await gcalCreateEvent(token, event) }),
  },
  create_task: {
    description: "Add a todo item to the user's Google Tasks list. Use for actions to complete, optionally with a deadline.",
    parameters: z.object({
      title: z.string().min(1).describe("Compact title of the task"),
      notes: z.string().optional().describe("Descriptions, sub-items, or context; empty string if none"),
      dueDate: z.string().optional().describe("Deadline as ISO date YYYY-MM-DD, or empty string if open-ended"),
    }),
    run: async (token, task) => ({ taskId: await gtasksCreateTask(token, task) }),
  },
  update_calendar_event: {
    description: "Update an event already on the user's Google Calendar, in place. Use when details of an event you previously created have changed — never create a second event for the same appointment.",
    parameters: z.object({
      id: z.string().min(1).describe("The eventId returned when this event was created"),
      title: z.string().min(1).describe("Event summary/title"),
      description: z.string().optional().describe("Event description/context; empty string if none"),
      start: z.string().min(1).describe("Start as ISO-8601 local datetime, e.g. 2026-07-10T15:00:00"),
      end: z.string().optional().describe("End as ISO-8601 local datetime; 30 minutes after start if no duration implied"),
      allDay: z.boolean().optional().describe("True if it spans whole day(s) with no specific clock time"),
      timeZone: z.string().optional().describe("IANA time zone identifier, e.g. America/Los_Angeles"),
    }),
    run: async (token, { id, ...event }) => ({ eventId: await gcalUpdateEvent(token, id, event) }),
  },
  update_task: {
    description: "Update a todo already in the user's Google Tasks list, in place. Use when a task you previously created gains a deadline or better wording.",
    parameters: z.object({
      id: z.string().min(1).describe("The taskId returned when this task was created"),
      title: z.string().min(1).describe("Compact title of the task"),
      notes: z.string().optional().describe("Descriptions, sub-items, or context; empty string if none"),
      dueDate: z.string().optional().describe("Deadline as ISO date YYYY-MM-DD, or empty string if open-ended"),
    }),
    run: async (token, { id, ...task }) => ({ taskId: await gtasksUpdateTask(token, id, task) }),
  },
  create_drive_folder: {
    description: "Create (or reuse) an organized folder in Google Drive for this session's documents.",
    parameters: z.object({ folderName: z.string().min(1).describe("Descriptive 2-4 word folder name") }),
    run: async (token, { folderName }) => ({ folderId: await gdriveCreateFolder(token, folderName) }),
  },
  create_drive_doc: {
    description: "Upload a Markdown summary report to a Google Drive folder.",
    parameters: z.object({
      fileName: z.string().min(1).describe("File name including the .md extension"),
      content: z.string().describe("The Markdown body of the document"),
      folderId: z.string().optional().describe("Folder to upload into; omit for the Drive root"),
    }),
    run: async (token, { fileName, content, folderId }) => ({ fileId: await gdriveUploadDoc(token, fileName, content, folderId) }),
  },
  create_google_doc: {
    description: "Create a native Google Document in Google Docs.",
    parameters: z.object({
      title: z.string().min(1).describe("Document title"),
      content: z.string().optional().describe("Initial body text of the document"),
    }),
    run: async (token, { title, content }) => ({ fileId: await gdocsCreateDocument(token, title, content) }),
  },
  create_google_sheet: {
    description: "Create a native Google Spreadsheet in Google Sheets.",
    parameters: z.object({
      title: z.string().min(1).describe("Spreadsheet title"),
    }),
    run: async (token, { title }) => ({ fileId: await gsheetsCreateSpreadsheet(token, title) }),
  },
};

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
  const timedTz = toGcalDates({ title: "t", start: "2026-07-10T15:00:00", end: "2026-07-10T15:30:00", timeZone: "America/Los_Angeles" });
  assert.equal(timedTz.start.timeZone, "America/Los_Angeles");
  assert.equal(timedTz.end.timeZone, "America/Los_Angeles");

  // real mode posts the right shape (fetch stubbed)
  const realFetch = globalThis.fetch;
  let captured: any = null;
  // Tasks writes are two hops: resolve the tasklist id, then post into it.
  globalThis.fetch = (async (url: any, init: any) => {
    if (String(url).includes("users/@me/lists"))
      return new Response(JSON.stringify({ items: [{ id: "list-abc" }] }), { status: 200 });
    captured = { url: String(url), body: JSON.parse(init.body) };
    return new Response(JSON.stringify({ id: "real-123" }), { status: 200 });
  }) as any;
  try {
    const id = await gtasksCreateTask("tok", { title: "Buy milk", notes: "", dueDate: "2026-07-11" });
    assert.equal(id, "real-123");
    assert.ok(captured.url.includes("tasks/v1/lists/list-abc/tasks"));
    assert.equal(captured.body.title, "Buy milk");
    assert.ok(captured.body.due.startsWith("2026-07-11"));
    // no lists yet (fresh account) -> create one and use it
    let createdList = false;
    globalThis.fetch = (async (url: any, init: any) => {
      if (String(url).includes("users/@me/lists")) {
        if (init.method === "POST") { createdList = true; return new Response(JSON.stringify({ id: "list-new" }), { status: 200 }); }
        return new Response(JSON.stringify({ items: [] }), { status: 200 });
      }
      captured = { url: String(url) };
      return new Response(JSON.stringify({ id: "t2" }), { status: 200 });
    }) as any;
    assert.equal(await gtasksCreateTask("fresh-tok", { title: "First" }), "t2");
    assert.ok(createdList);
    assert.ok(captured.url.includes("tasks/v1/lists/list-new/tasks"));

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
    const withList = (rest: (url: string, init: any) => Response) => (async (url: any, init: any) =>
      String(url).includes("users/@me/lists")
        ? new Response(JSON.stringify({ items: [{ id: "list-abc" }] }), { status: 200 })
        : rest(String(url), init)) as any;
    globalThis.fetch = withList((url, init) => { delUrl = `${init.method} ${url}`; return new Response("{}", { status: 404 }); });
    await gtasksDeleteTask("tok", "gone"); // must not throw
    assert.ok(delUrl.includes("tasks/v1/lists/list-abc/tasks/gone"));
    globalThis.fetch = withList(() =>
      new Response(JSON.stringify({ error: { message: "Insufficient Permission" } }), { status: 403 }));
    await assert.rejects(gtasksDeleteTask("tok", "x"), /Insufficient Permission/);

    // Drive folder: an existing folder is reused, and no POST is sent for it.
    let calls: string[] = [];
    globalThis.fetch = (async (url: any, init: any) => {
      calls.push(`${init?.method || "GET"} ${url}`);
      return new Response(JSON.stringify({ files: [{ id: "existing-fld" }] }), { status: 200 });
    }) as any;
    assert.equal(await gdriveCreateFolder("tok", "Project Beta Alignment"), "existing-fld");
    assert.equal(calls.length, 1, "reusing a folder must not POST a new one");

    // No match -> create. The search 404ing must not block the create either.
    calls = [];
    globalThis.fetch = (async (url: any, init: any) => {
      calls.push(`${init?.method || "GET"} ${url}`);
      return String(url).includes("uploadType")
        ? new Response("{}", { status: 200 })
        : new Response(JSON.stringify(init?.method === "POST" ? { id: "new-id" } : { files: [] }), { status: 200 });
    }) as any;
    assert.equal(await gdriveCreateFolder("tok", "Home Gardening Brainstorm"), "new-id");
    assert.ok(calls[1].startsWith("POST "));

    // Drive doc: metadata POST first, then the media PATCH carrying the markdown.
    calls = [];
    let uploaded = "";
    globalThis.fetch = (async (url: any, init: any) => {
      calls.push(`${init.method} ${url}`);
      if (String(url).includes("uploadType=media")) {
        uploaded = init.body;
        return new Response("{}", { status: 200 });
      }
      return new Response(JSON.stringify({ id: "doc-1" }), { status: 200 });
    }) as any;
    assert.equal(await gdriveUploadDoc("tok", "Notes.md", "# Hi", "fld-1"), "doc-1");
    assert.ok(calls[0].startsWith("POST https://www.googleapis.com/drive/v3/files"));
    assert.ok(calls[1].startsWith("PATCH ") && calls[1].includes("uploadType=media"));
    assert.equal(uploaded, "# Hi");

    // Update = PATCH the existing resource by id, NOT a second POST. This is the whole point of the
    // action: the live planner refines one appointment across many ticks.
    let patched = "";
    let patchBody: any = null;
    globalThis.fetch = (async (url: any, init: any) => {
      patched = `${init.method} ${url}`;
      patchBody = JSON.parse(init.body);
      return new Response(JSON.stringify({ id: "evt 1" }), { status: 200 });
    }) as any;
    assert.equal(await gcalUpdateEvent("tok", "evt 1", { title: "Dentist", start: "2026-08-22T09:00:00" }), "evt 1");
    assert.ok(patched.startsWith("PATCH "), `update must PATCH, got ${patched}`);
    assert.ok(patched.includes("events/evt%201"), "event id must be URL-encoded");
    assert.equal(patchBody.summary, "Dentist");

    globalThis.fetch = withList((url, init) => {
      patched = `${init.method} ${url}`;
      return new Response(JSON.stringify({ id: "t9" }), { status: 200 });
    });
    assert.equal(await gtasksUpdateTask("tok", "t9", { title: "Sweep", dueDate: "2026-08-22" }), "t9");
    assert.ok(patched.startsWith("PATCH ") && patched.includes("lists/list-abc/tasks/t9"), patched);

    // A failed upload must not report success just because the metadata call worked.
    globalThis.fetch = (async (url: any) =>
      String(url).includes("uploadType=media")
        ? new Response(JSON.stringify({ error: { message: "Storage quota exceeded" } }), { status: 403 })
        : new Response(JSON.stringify({ id: "doc-2" }), { status: 200 })) as any;
    await assert.rejects(gdriveUploadDoc("tok", "n.md", "x"), /Storage quota exceeded/);
  } finally {
    globalThis.fetch = realFetch;
  }

  // The registry: every capability /api/execute can dispatch to.
  assert.deepEqual(
    Object.keys(WORKSPACE_ACTIONS),
    ["create_calendar_event", "create_task", "update_calendar_event", "update_task",
     "create_drive_folder", "create_drive_doc", "create_google_doc", "create_google_sheet"],
  );

  // The schemas are what /api/execute validates with, so the rejections matter as much as the shapes.
  assert.throws(() => WORKSPACE_ACTIONS.create_calendar_event.parameters.parse({ start: "2026-01-01T09:00:00" })); // no title
  assert.throws(() => WORKSPACE_ACTIONS.create_calendar_event.parameters.parse({ title: "x" }));                   // no start
  assert.throws(() => WORKSPACE_ACTIONS.create_task.parameters.parse({ notes: "x" }));                             // no title
  assert.throws(() => WORKSPACE_ACTIONS.create_drive_doc.parameters.parse({ fileName: "x.md" }));                  // no content
  // An update without the created id would silently become a no-op instead of an error.
  assert.throws(() => WORKSPACE_ACTIONS.update_calendar_event.parameters.parse({ title: "x", start: "2026-01-01T09:00:00" }));
  assert.throws(() => WORKSPACE_ACTIONS.update_task.parameters.parse({ title: "x" }));
  assert.deepEqual(
    WORKSPACE_ACTIONS.create_task.parameters.parse({ title: "Buy milk", notes: "", dueDate: "2026-07-11" }),
    { title: "Buy milk", notes: "", dueDate: "2026-07-11" },
  );

  console.log("workspace-tools self-check ✓");
})();
