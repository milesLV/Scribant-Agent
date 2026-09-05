import { CalendarEvent, TaskItem, DriveDocItem } from "../types";
// Type-only: erased at build, so the server-only module (zod, REST calls) never enters the client
// bundle — only the shape of its action-name keys does.
import type { WORKSPACE_ACTIONS } from "../../workspace-tools";

// In-memory or localStorage cache for sandbox state so it persists across runs
const SANDBOX_STATE_KEY = "scribant_sandbox";

interface SandboxState {
  events: CalendarEvent[];
  tasks: TaskItem[];
  docs: DriveDocItem[];
  folders: { id: string; name: string }[];
}

// Starts empty: nothing renders sandbox state, so seeded demo items were only ever visible to
// whoever opened localStorage.
const freshDefaults = (): SandboxState => ({ events: [], tasks: [], docs: [], folders: [] });

function getSandboxState(): SandboxState {
  const data = localStorage.getItem(SANDBOX_STATE_KEY);
  if (!data) return freshDefaults();
  try {
    // Sandbox state saved before Drive existed has no docs/folders — fill them in rather than
    // letting the Drive paths read undefined.
    return { docs: [], folders: [], ...JSON.parse(data) };
  } catch {
    return freshDefaults();
  }
}

function saveSandboxState(state: SandboxState) {
  localStorage.setItem(SANDBOX_STATE_KEY, JSON.stringify(state));
}

// Sandbox create: mint a mock id, let the caller shape+push its item, persist, return the id.
function sandboxAdd(prefix: string, push: (state: SandboxState, id: string) => void): string {
  const state = getSandboxState();
  const id = `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
  push(state, id);
  saveSandboxState(state);
  return id;
}

// ==========================================
// GOOGLE CALENDAR SERVICE
// ==========================================

// The client asks for exactly what an agent would call, so /api/execute needs no vocabulary of its
// own to translate — this is the registry's own key set, not a hand-copied list that could drift.
type ExecKind = keyof typeof WORKSPACE_ACTIONS;

// Real mode executes server-side: the item + OAuth token go to /api/execute. Sandbox stays local.
async function executeOnServer(kind: ExecKind, item: object, token: string): Promise<string> {
  const res = await fetch("/api/execute", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind, item, accessToken: token })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Execution failed (HTTP ${res.status}).`);
  return data.id;
}

export async function createCalendarEvent(token: string | null, event: Omit<CalendarEvent, "status">): Promise<string> {
  const browserTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const timeZone = event.timeZone || browserTimeZone;
  if (!token) {
    const id = sandboxAdd("mock-evt", (s, id) => s.events.push({ ...event, timeZone, status: "scheduled", eventId: id }));
    executeOnServer("create_calendar_event", { title: event.title, description: event.description, start: event.start, end: event.end, allDay: event.allDay, timeZone }, "sandbox").catch(() => {});
    return id;
  }
  const { title, description, start, end, allDay } = event;
  return executeOnServer("create_calendar_event", { title, description, start, end, allDay, timeZone }, token);
}

// Edit the event already on the calendar. The live planner keeps refining one appointment as the
// speaker adds a time or a place, and re-creating it would leave the earlier version behind.
export async function updateCalendarEvent(token: string | null, eventId: string, event: Omit<CalendarEvent, "status">): Promise<string> {
  const timeZone = event.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const { title, description, start, end, allDay } = event;
  if (!token) {
    const state = getSandboxState();
    state.events = state.events.map(e => (e.eventId === eventId ? { ...e, ...event, timeZone } : e));
    saveSandboxState(state);
    executeOnServer("update_calendar_event", { id: eventId, title, description, start, end, allDay, timeZone }, "sandbox").catch(() => {});
    return eventId;
  }
  return executeOnServer("update_calendar_event", { id: eventId, title, description, start, end, allDay, timeZone }, token);
}

// ==========================================
// GOOGLE TASKS SERVICE
// ==========================================

export async function createGoogleTask(token: string | null, task: Omit<TaskItem, "status">): Promise<string> {
  if (!token) {
    const id = sandboxAdd("mock-task", (s, id) => s.tasks.push({ ...task, status: "created", taskId: id }));
    executeOnServer("create_task", { title: task.title, notes: task.notes, dueDate: task.dueDate }, "sandbox").catch(() => {});
    return id;
  }
  const { title, notes, dueDate } = task;
  return executeOnServer("create_task", { title, notes, dueDate }, token);
}

export async function updateGoogleTask(token: string | null, taskId: string, task: Omit<TaskItem, "status">): Promise<string> {
  const { title, notes, dueDate } = task;
  if (!token) {
    const state = getSandboxState();
    state.tasks = state.tasks.map(t => (t.taskId === taskId ? { ...t, ...task } : t));
    saveSandboxState(state);
    executeOnServer("update_task", { id: taskId, title, notes, dueDate }, "sandbox").catch(() => {});
    return taskId;
  }
  return executeOnServer("update_task", { id: taskId, title, notes, dueDate }, token);
}

// ==========================================
// GOOGLE DRIVE SERVICE
// ==========================================

// Reuse the folder when this session already has one, so repeated saves land in one place.
export async function createDriveFolder(token: string | null, folderName: string): Promise<string> {
  if (!token) {
    const existing = getSandboxState().folders.find(f => f.name.toLowerCase() === folderName.toLowerCase());
    if (existing) return existing.id;
    const id = sandboxAdd("mock-fld", (s, id) => s.folders.push({ id, name: folderName }));
    executeOnServer("create_drive_folder", { folderName }, "sandbox").catch(() => {});
    return id;
  }
  return executeOnServer("create_drive_folder", { folderName }, token);
}

export async function uploadDriveFile(
  token: string | null,
  fileName: string,
  content: string,
  folderId?: string
): Promise<string> {
  if (!token) {
    const id = sandboxAdd("mock-doc", (s, id) => s.docs.push({ name: fileName, fileId: id, folderId }));
    executeOnServer("create_drive_doc", { fileName, content, folderId }, "sandbox").catch(() => {});
    return id;
  }
  return executeOnServer("create_drive_doc", { fileName, content, folderId }, token);
}

// Undo a create: real mode deletes via /api/execute by the exact id the create returned; sandbox
// drops the matching entry from local state.
export async function deleteCreatedItem(
  token: string | null,
  kind: "create_calendar_event" | "create_task",
  id: string,
): Promise<void> {
  if (!token) {
    const [list, idKey] = kind === "create_calendar_event" ? ["events", "eventId"] as const : ["tasks", "taskId"] as const;
    const state = getSandboxState();
    state[list] = (state[list] as any[]).filter(x => x[idKey] !== id);
    saveSandboxState(state);
    fetch("/api/execute", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind, action: "delete", id, accessToken: "sandbox" }),
    }).catch(() => {});
    return;
  }
  const res = await fetch("/api/execute", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind, action: "delete", id, accessToken: token })
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Undo failed (HTTP ${res.status}).`);
  }
}

export function resetSandboxState() {
  localStorage.setItem(SANDBOX_STATE_KEY, JSON.stringify(freshDefaults()));
}
