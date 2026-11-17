import { CalendarEvent, TaskItem, DriveDocItem } from "../types";
// Type-only: erased at build, so the server-only module (zod, REST calls) never enters the client
// bundle — only the shape of its action-name keys does.
import type { WORKSPACE_ACTIONS } from "../../workspace-tools";

// Signed-out sandbox state, persisted in localStorage.
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

// The client asks for exactly what an agent would call, so /api/execute needs no vocabulary of its
// own — this is the registry's own key set, not a hand-copied list that could drift.
type ExecKind = keyof typeof WORKSPACE_ACTIONS;

async function postExecute(body: object, failure: string): Promise<string> {
  const res = await fetch("/api/execute", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${failure} (HTTP ${res.status}).`);
  return data.id;
}

// Real mode executes server-side with the OAuth token. Sandbox mutates local state and still fires
// the server's sandbox call (fire-and-forget) so it shows up in telemetry.
async function dispatch(token: string | null, body: { kind: ExecKind } & Record<string, unknown>, sandbox: () => string, failure = "Execution failed"): Promise<string> {
  if (token) return postExecute({ ...body, accessToken: token }, failure);
  const id = sandbox();
  postExecute({ ...body, accessToken: "sandbox" }, failure).catch(() => {});
  return id;
}

const editSandbox = (edit: (state: SandboxState) => void) => { const s = getSandboxState(); edit(s); saveSandboxState(s); };
const zoneOf = (event: { timeZone?: string }) => event.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

export function createCalendarEvent(token: string | null, event: Omit<CalendarEvent, "status">): Promise<string> {
  const { title, description, start, end, allDay } = event, timeZone = zoneOf(event);
  return dispatch(token, { kind: "create_calendar_event", item: { title, description, start, end, allDay, timeZone } },
    () => sandboxAdd("mock-evt", (s, id) => s.events.push({ ...event, timeZone, status: "scheduled", eventId: id })));
}

// Edit in place: the live planner keeps refining one appointment, and re-creating would leave the old one.
export function updateCalendarEvent(token: string | null, eventId: string, event: Omit<CalendarEvent, "status">): Promise<string> {
  const { title, description, start, end, allDay } = event, timeZone = zoneOf(event);
  return dispatch(token, { kind: "update_calendar_event", item: { id: eventId, title, description, start, end, allDay, timeZone } }, () => {
    editSandbox(s => { s.events = s.events.map(e => (e.eventId === eventId ? { ...e, ...event, timeZone } : e)); });
    return eventId;
  });
}

export function createGoogleTask(token: string | null, task: Omit<TaskItem, "status">): Promise<string> {
  const { title, notes, dueDate } = task;
  return dispatch(token, { kind: "create_task", item: { title, notes, dueDate } },
    () => sandboxAdd("mock-task", (s, id) => s.tasks.push({ ...task, status: "created", taskId: id })));
}

export function updateGoogleTask(token: string | null, taskId: string, task: Omit<TaskItem, "status">): Promise<string> {
  const { title, notes, dueDate } = task;
  return dispatch(token, { kind: "update_task", item: { id: taskId, title, notes, dueDate } }, () => {
    editSandbox(s => { s.tasks = s.tasks.map(t => (t.taskId === taskId ? { ...t, ...task } : t)); });
    return taskId;
  });
}

// Reuse the folder when this session already has one, so repeated saves land in one place.
export async function createDriveFolder(token: string | null, folderName: string): Promise<string> {
  const existing = !token && getSandboxState().folders.find(f => f.name.toLowerCase() === folderName.toLowerCase());
  if (existing) return existing.id;
  return dispatch(token, { kind: "create_drive_folder", item: { folderName } },
    () => sandboxAdd("mock-fld", (s, id) => s.folders.push({ id, name: folderName })));
}

export function uploadDriveFile(token: string | null, fileName: string, content: string, folderId?: string): Promise<string> {
  return dispatch(token, { kind: "create_drive_doc", item: { fileName, content, folderId } },
    () => sandboxAdd("mock-doc", (s, id) => s.docs.push({ name: fileName, fileId: id, folderId })));
}

// Undo a create by the exact id the create returned.
export async function deleteCreatedItem(token: string | null, kind: "create_calendar_event" | "create_task", id: string): Promise<void> {
  await dispatch(token, { kind, action: "delete", id }, () => {
    editSandbox(s => {
      if (kind === "create_calendar_event") s.events = s.events.filter(e => e.eventId !== id);
      else s.tasks = s.tasks.filter(t => t.taskId !== id);
    });
    return id;
  }, "Undo failed");
}

export function resetSandboxState() {
  localStorage.setItem(SANDBOX_STATE_KEY, JSON.stringify(freshDefaults()));
}
