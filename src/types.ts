export interface CalendarEvent {
  title: string;
  description: string;
  start: string; // ISO string
  end: string; // ISO string
  status: 'pending' | 'scheduled' | 'failed' | 'skipped';
  eventId?: string;
  error?: string;
  uncertain?: boolean;
}

export interface TaskItem {
  title: string;
  notes: string;
  status: 'pending' | 'created' | 'failed' | 'skipped';
  taskId?: string;
  error?: string;
  uncertain?: boolean;
}

export interface SearchQueryItem {
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
