// Transcriber output: one word with a confidence score. confidence < 0.7 = flagged as misheard.
export interface Word {
  text: string;
  start: number;            // char offset into the transcript text
  end: number;
  confidence: number;       // 0..1
  alternatives?: string[];  // likely intended words, best first (for flagged words)
}

// How much the agent may do on its own: never / only on explicit spoken consent / whenever confident.
export type AutonomyMode = "manual" | "consent" | "auto";

export interface CalendarEvent {
  sourceText?: string; // verbatim transcript phrase that triggered this item
  title: string;
  description: string;
  start: string; // ISO string
  end: string; // ISO string
  allDay?: boolean; // spans whole day(s) with no clock time (trip, birthday, OOO)
  status: 'pending' | 'scheduled' | 'failed';
  eventId?: string;
  error?: string;
  uncertain?: boolean;
  explicitCommand?: boolean; // speaker directly instructed this action -> eligible for auto-execute
}

export interface TaskItem {
  sourceText?: string;
  title: string;
  notes: string;
  dueDate?: string; // ISO date (YYYY-MM-DD) deadline, if the action is time-bounded
  status: 'pending' | 'created' | 'failed';
  taskId?: string;
  error?: string;
  uncertain?: boolean;
  explicitCommand?: boolean;
}

// A markdown report saved to Drive (session summary / live notes) — just enough for a sandbox save
// to be observable in localStorage.
export interface DriveDocItem {
  name: string;
  fileId?: string;
  folderId?: string;
}

interface SearchQueryItem {
  sourceText?: string;
  query: string;
  condensed?: string; // 1-2 sentence direct answer (shown collapsed)
  answer?: string;    // fuller in-depth answer (shown expanded)
  sources?: { uri: string; title: string }[];
  status: 'pending' | 'completed' | 'failed';
  error?: string;
  explicitCommand?: boolean;
}

// The /api/live proofread stage: the exact text that was scored, plus what to do about it. The
// client (not the server) applies these, so it stays the owner of what's on screen.
export interface ProofResult {
  text: string;
  corrections: { index: number; from: string; to: string }[];
  words: Word[];
}

export interface AnalysisResult {
  summary: string;
  rawText: string;
  calendarEvents: CalendarEvent[];
  tasks: TaskItem[];
  searchQueries: SearchQueryItem[];
}

export interface StreamRun {
  id: string;
  timestamp: string;
  rawText: string;
  status: 'processing' | 'completed' | 'failed';
  analysis?: AnalysisResult;
}
