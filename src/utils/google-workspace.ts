import { CalendarEvent, TaskItem, DriveDocItem } from "../types";

// In-memory or localStorage cache for sandbox state so it persists across runs
const SANDBOX_STATE_KEY = "scribant_sandbox";

interface SandboxState {
  events: CalendarEvent[];
  tasks: TaskItem[];
  docs: DriveDocItem[];
  folders: { id: string; name: string }[];
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
  ],
  docs: [
    {
      name: "Q2 Marketing Brainstorm.md",
      content: "# Q2 Marketing Brainstorm\n- Launch focus landing pages.\n- Experiment with interactive web applets.",
      mimeType: "text/markdown",
      type: "ideas",
      status: "created",
      fileId: "mock-doc-1",
      folderId: "mock-fld-1"
    }
  ],
  folders: [
    { id: "mock-fld-1", name: "Marketing Brainstorms" }
  ]
};

function getSandboxState(): SandboxState {
  const data = localStorage.getItem(SANDBOX_STATE_KEY);
  if (!data) {
    localStorage.setItem(SANDBOX_STATE_KEY, JSON.stringify(DEFAULT_SANDBOX_STATE));
    return DEFAULT_SANDBOX_STATE;
  }
  try {
    return JSON.parse(data);
  } catch {
    return DEFAULT_SANDBOX_STATE;
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
// GOOGLE DRIVE SERVICE
// ==========================================

export async function createDriveFolder(token: string | null, folderName: string): Promise<string> {
  if (!token) {
    const existing = getSandboxState().folders.find(f => f.name.toLowerCase() === folderName.toLowerCase());
    if (existing) return existing.id;
    return sandboxAdd("mock-fld", (s, id) => s.folders.push({ id, name: folderName }));
  }

  // Real Integration Mode
  try {
    const searchUrl = `https://www.googleapis.com/drive/v3/files?q=name='${encodeURIComponent(folderName)}'+and+mimeType='application/vnd.google-apps.folder'+and+trashed=false&fields=files(id)`;
    const searchRes = await fetch(searchUrl, {
      headers: {
        "Authorization": `Bearer ${token}`
      }
    });
    if (searchRes.ok) {
      const searchData = await searchRes.json();
      if (searchData.files && searchData.files.length > 0) {
        return searchData.files[0].id;
      }
    }
  } catch (searchErr) {
    console.error("Failed to query existing Drive folders:", searchErr);
  }

  const res = await fetch("https://www.googleapis.com/drive/v3/files", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      name: folderName,
      mimeType: "application/vnd.google-apps.folder"
    })
  });

  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.error?.message || "Failed to create Google Drive folder");
  }

  const folder = await res.json();
  return folder.id;
}

export async function uploadDriveFile(
  token: string | null,
  fileName: string,
  content: string,
  folderId?: string
): Promise<string> {
  if (!token) {
    return sandboxAdd("mock-doc", (s, id) =>
      s.docs.push({ name: fileName, content, mimeType: "text/markdown", type: "summary", status: "created", fileId: id, folderId }));
  }

  // Real Integration Mode: Step 1 Create Metadata
  const createRes = await fetch("https://www.googleapis.com/drive/v3/files", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      name: fileName,
      mimeType: "text/markdown",
      parents: folderId ? [folderId] : undefined
    })
  });

  if (!createRes.ok) {
    const err = await createRes.json();
    throw new Error(err.error?.message || "Failed to initiate Drive file metadata creation");
  }

  const metadata = await createRes.json();
  const fileId = metadata.id;

  // Step 2 Upload Content via Media Endpoint
  const uploadRes = await fetch(`https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media`, {
    method: "PATCH",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "text/markdown"
    },
    body: content
  });

  if (!uploadRes.ok) {
    const err = await uploadRes.json();
    throw new Error(err.error?.message || "Failed to upload file content directly to Google Drive");
  }

  return fileId;
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
  localStorage.setItem(SANDBOX_STATE_KEY, JSON.stringify(DEFAULT_SANDBOX_STATE));
}
