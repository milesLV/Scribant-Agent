// Transcriber output: one word with a confidence score. confidence < 0.7 = "strange".
export interface Word {
  text: string;
  start: number;            // char offset into the transcript text
  end: number;
  confidence: number;       // 0..1
  alternatives?: string[];  // likely intended words, best first (for strange words)
}

export interface CalendarEvent {
  id: string;
  sourceText?: string; // verbatim transcript phrase that triggered this item
  title: string;
  description: string;
  start: string; // ISO string
  end: string; // ISO string
  allDay?: boolean; // spans whole day(s) with no clock time (trip, birthday, OOO)
  status: 'pending' | 'scheduled' | 'failed' | 'skipped';
  eventId?: string;
  error?: string;
  uncertain?: boolean;
}

export interface TaskItem {
  id: string;
  sourceText?: string;
  title: string;
  notes: string;
  dueDate?: string; // ISO date (YYYY-MM-DD) deadline, if the action is time-bounded
  status: 'pending' | 'created' | 'failed' | 'skipped';
  taskId?: string;
  error?: string;
  uncertain?: boolean;
}

interface SearchQueryItem {
  id: string;
  sourceText?: string;
  query: string;
  condensed?: string; // 1-2 sentence direct answer (shown collapsed)
  answer?: string;    // fuller in-depth answer (shown expanded)
  sources?: { uri: string; title: string }[];
  status: 'pending' | 'completed' | 'failed' | 'skipped';
  error?: string;
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
  organizedFolder?: string; // grouping label for the session (shown in the archive list)
}

export interface StreamRun {
  id: string;
  timestamp: string;
  rawText: string;
  status: 'processing' | 'completed' | 'failed';
  analysis?: AnalysisResult;
}
