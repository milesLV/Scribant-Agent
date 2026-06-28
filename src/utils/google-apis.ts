import { CalendarEvent, TaskItem, DriveDocItem } from "../types";

// In-memory or localStorage cache for sandbox state so it persists across runs
const SANDBOX_STATE_KEY = "stream_consciousness_sandbox";

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

// ==========================================
// GOOGLE DRIVE SERVICE
// ==========================================

export async function createDriveFolder(token: string | null, folderName: string): Promise<string> {
  if (!token) {
    // Sandbox Mode
    const state = getSandboxState();
    const existing = state.folders.find(f => f.name.toLowerCase() === folderName.toLowerCase());
    if (existing) return existing.id;
    
    const newId = `mock-fld-${Math.random().toString(36).substr(2, 9)}`;
    state.folders.push({ id: newId, name: folderName });
    saveSandboxState(state);
    return newId;
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
    // Sandbox Mode
    const state = getSandboxState();
    const newId = `mock-doc-${Math.random().toString(36).substr(2, 9)}`;
    state.docs.push({
      name: fileName,
      content,
      mimeType: "text/markdown",
      type: "summary",
      status: "created",
      fileId: newId,
      folderId
    });
    saveSandboxState(state);
    return newId;
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

export async function createCalendarEvent(token: string | null, event: Omit<CalendarEvent, "status">): Promise<string> {
  if (!token) {
    // Sandbox Mode
    const state = getSandboxState();
    const newId = `mock-evt-${Math.random().toString(36).substr(2, 9)}`;
    state.events.push({
      ...event,
      status: "scheduled",
      eventId: newId
    });
    saveSandboxState(state);
    return newId;
  }

  // Real Integration Mode
  const res = await fetch("https://www.googleapis.com/calendar/v3/calendars/primary/events", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      summary: event.title,
      description: event.description,
      start: {
        dateTime: event.start,
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
      },
      end: {
        dateTime: event.end,
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
      }
    })
  });

  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.error?.message || "Failed to schedule event on calendar");
  }

  const result = await res.json();
  return result.id;
}

// ==========================================
// GOOGLE TASKS SERVICE
// ==========================================

export async function createGoogleTask(token: string | null, task: Omit<TaskItem, "status">): Promise<string> {
  if (!token) {
    // Sandbox Mode
    const state = getSandboxState();
    const newId = `mock-task-${Math.random().toString(36).substr(2, 9)}`;
    state.tasks.push({
      ...task,
      status: "created",
      taskId: newId
    });
    saveSandboxState(state);
    return newId;
  }

  // Real Integration Mode: Fetch tasklists to find @default primary or list
  const res = await fetch("https://www.googleapis.com/tasks/v1/lists/@default/tasks", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      title: task.title,
      notes: task.notes
    })
  });

  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.error?.message || "Failed to create task in Google Tasks List");
  }

  const result = await res.json();
  return result.id;
}

export function resetSandboxState() {
  localStorage.setItem(SANDBOX_STATE_KEY, JSON.stringify(DEFAULT_SANDBOX_STATE));
}
