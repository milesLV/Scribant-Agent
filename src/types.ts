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

export interface SearchQueryItem {
  id: string;
  sourceText?: string;
  query: string;
  answer?: string;
  sources?: { uri: string; title: string }[];
  status: 'pending' | 'completed' | 'failed' | 'skipped';
  error?: string;
}

export interface DriveDocItem {
  name: string;
  content: string;
  mimeType: string;
  type: 'summary' | 'ideas' | 'report';
  status: 'pending' | 'created' | 'failed';
  fileId?: string;
  folderId?: string;
}

export interface AnalysisResult {
  summary: string;
  rawText: string;
  calendarEvents: CalendarEvent[];
  tasks: TaskItem[];
  searchQueries: SearchQueryItem[];
  driveDocs: DriveDocItem[];
  organizedFolder?: string;
}

export interface StreamRun {
  id: string;
  timestamp: string;
  rawText: string;
  status: 'processing' | 'completed' | 'failed';
  analysis?: AnalysisResult;
}
