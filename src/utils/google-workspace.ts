import { CalendarEvent, TaskItem } from "../types";

// In-memory or localStorage cache for sandbox state so it persists across runs
const SANDBOX_STATE_KEY = "scribant_sandbox";

interface SandboxState {
  events: CalendarEvent[];
  tasks: TaskItem[];
}

const DEFAULT_SANDBOX_STATE: SandboxState = {
  events: [
    {
      id: "cal-weekly-planning-sync",
      title: "Weekly Planning Sync",
      description: "Brainstorming and alignment session with the engineering team.",
      start: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(), // Tomorrow
      end: new Date(Date.now() + 25 * 60 * 60 * 1000).toISOString(),
      status: "scheduled",
      eventId: "mock-evt-1"
    }
  ],
  tasks: [
    {
      id: "task-consolidate-q2-feedback",
      title: "Consolidate Q2 feedback document",
      notes: "Pull notes from the shared drive and compile bullet points.",
      status: "created",
      taskId: "mock-task-1"
    }
  ]
};

// Always hand out a COPY: sandboxAdd pushes into whatever this returns, so returning the shared
// default would mutate it — and then resetSandboxState() writes back the very items it should drop.
const freshDefaults = (): SandboxState => structuredClone(DEFAULT_SANDBOX_STATE);

function getSandboxState(): SandboxState {
  const data = localStorage.getItem(SANDBOX_STATE_KEY);
  if (!data) {
    const seeded = freshDefaults();
    localStorage.setItem(SANDBOX_STATE_KEY, JSON.stringify(seeded));
    return seeded;
  }
  try {
    return JSON.parse(data);
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

// Real mode executes server-side: the item + OAuth token go to /api/execute. Sandbox stays local.
async function executeOnServer(kind: "calendar" | "task", item: object, token: string): Promise<string> {
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
  if (!token) {
    return sandboxAdd("mock-evt", (s, id) => s.events.push({ ...event, status: "scheduled", eventId: id }));
  }
  const { title, description, start, end, allDay } = event;
  return executeOnServer("calendar", { title, description, start, end, allDay }, token);
}

// ==========================================
// GOOGLE TASKS SERVICE
// ==========================================

export async function createGoogleTask(token: string | null, task: Omit<TaskItem, "status">): Promise<string> {
  if (!token) {
    return sandboxAdd("mock-task", (s, id) => s.tasks.push({ ...task, status: "created", taskId: id }));
  }
  const { title, notes, dueDate } = task;
  return executeOnServer("task", { title, notes, dueDate }, token);
}

export function resetSandboxState() {
  localStorage.setItem(SANDBOX_STATE_KEY, JSON.stringify(freshDefaults()));
}
