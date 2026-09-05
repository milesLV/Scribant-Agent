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
  timeZone?: string; // IANA time zone identifier (e.g. America/Los_Angeles)
  status: 'pending' | 'scheduled' | 'failed';
  eventId?: string;
  // Fingerprint of the field values last written to Google. Drift means the remote copy is stale.
  synced?: string;
  error?: string;
  uncertain?: boolean;
  explicitCommand?: boolean; // speaker directly instructed this action -> eligible for auto-execute
  speaker?: string; // speaker or participant associated with this event (in multi-speaker context)
}

export interface TaskItem {
  sourceText?: string;
  title: string;
  notes: string;
  dueDate?: string; // ISO date (YYYY-MM-DD) deadline, if the action is time-bounded
  status: 'pending' | 'created' | 'failed';
  taskId?: string;
  // Fingerprint of the field values last written to Google. Drift means the remote copy is stale.
  synced?: string;
  error?: string;
  uncertain?: boolean;
  explicitCommand?: boolean;
  assignee?: string; // speaker who committed to or was assigned this task
  requestedBy?: string; // speaker who requested or assigned this task
}

// A single speaker's spoken turn in multi-speaker dialogue
export interface SpeakerTurn {
  speaker: string;
  text: string;
  timestamp?: number;
}

// A markdown report saved to Drive (session summary / live notes) — just enough for a sandbox save
// to be observable in localStorage.
export interface DriveDocItem {
  name: string;
  fileId?: string;
  folderId?: string;
}

export interface SearchQueryItem {
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

export interface AdkEventPart {
  text?: string;
  thought?: boolean;
  functionCall?: { name: string; args: Record<string, any>; id?: string };
  functionResponse?: { name: string; response: Record<string, any>; id?: string };
  executableCode?: { code: string; language: string };
  codeExecutionResult?: { outcome: string; output: string };
  [key: string]: any;
}

export interface AdkEventActions {
  stateDelta?: Record<string, any>;
  artifactDelta?: Record<string, number>;
  transferToAgent?: string;
  escalate?: boolean;
  requestedAuthConfigs?: Record<string, any>;
  requestedToolConfirmations?: Record<string, any>;
  skipSummarization?: boolean;
  [key: string]: any;
}

export interface AdkEvent {
  id: string;
  invocationId?: string;
  author?: string;
  timestamp: number;
  content?: {
    role: string;
    parts: AdkEventPart[];
  };
  actions?: AdkEventActions;
  errorCode?: string | number;
  errorMessage?: string;
  groundingMetadata?: any;
  customMetadata?: Record<string, any>;
  branch?: string;
  longRunningToolIds?: string[];
  [key: string]: any;
}

export type MemoryEventType = "memory:insert" | "memory:retrieve" | "memory:sync";
export type MemoryEventStatus = "success" | "error" | "pending";

export interface RetrievedMemoryItem {
  text: string;
  author: string;
  timestamp: string;
}

export interface CompactionMetrics {
  rawTokens: number;
  compactedTokens: number;
  savedTokens: number;
  ratioPercent: number;
}

export interface ArchiveTokenMetrics {
  totalArchiveTokens: number;
  sessionCount: number;
  fileCount: number;
  averageSessionTokens: number;
}

export interface MemoryEfficiencyReport {
  archiveTokens: number;
  injectedMemoryTokens: number;
  simulatedLegacyTokens: number;
  actualMemoryBankTokens: number;
  savedTokens: number;
  savingsPercent: number;
  efficiencyMultiplier: string;
}

export interface TokenStatsResponse {
  ok: boolean;
  compaction: CompactionMetrics;
  archive: ArchiveTokenMetrics;
  efficiency: MemoryEfficiencyReport;
}

export interface TokenMetricRecord {
  id: string;
  timestamp: string;
  timestampMs: number;
  model: string;
  agent: string;
  stage: string;
  modality: "audio" | "text" | "multimodal";
  userId: string;
  sessionId: string;
  status: "success" | "error";
  errorCode?: string;
  promptTokens: number;
  candidatesTokens: number;
  thoughtsTokens: number;
  cachedTokens: number;
  totalTokens: number;
  audioInputTokens: number;
  textInputTokens: number;
  durationMs: number;
  costEstimateUsd: number;

  // Invocation Metadata & Telemetry Tags
  diarizationEnabled?: boolean;
  provider?: "gemini" | "google_cloud_stt" | string;
  source?: "mic" | "tab" | "upload" | "pipeline" | string;
  metadata?: Record<string, any>;
}

export interface TimeSeriesPoint {
  timestamp: number;
  timeLabel: string;
  promptTokens: number;
  candidatesTokens: number;
  thoughtsTokens: number;
  audioTokens: number;
  totalTokens: number;
  requestCount: number;
  avgDurationMs: number;
  costUsd: number;
}

export interface AggregateDimensionStats {
  tokens: number;
  percent: number;
  requests: number;
  costUsd: number;
}

export interface TokenAggregateStats {
  ok: boolean;
  totalTokens: number;
  totalPromptTokens: number;
  totalCandidatesTokens: number;
  totalThoughtsTokens: number;
  totalAudioTokens: number;
  totalCostUsd: number;
  requestCount: number;
  avgLatencyMs: number;
  byAgent: Record<string, AggregateDimensionStats>;
  byModel: Record<string, AggregateDimensionStats>;
  byModality: Record<string, AggregateDimensionStats>;
  byStage: Record<string, AggregateDimensionStats>;
  byDiarization?: Record<string, AggregateDimensionStats>;
  byProvider?: Record<string, AggregateDimensionStats>;
}

export type MemoryEvent = AdkEvent;

export type TimeRangePreset = "10m" | "30m" | "1h" | "4h" | "24h" | "7d" | "custom";

export interface TimeRangeConfig {
  preset: TimeRangePreset;
  label: string;
  durationMs: number;
  defaultInterval: "1s" | "10s" | "30s" | "1m" | "5m" | "15m" | "30m" | "1h" | "4h" | "1d";
  supportedIntervals: ("1s" | "10s" | "30s" | "1m" | "5m" | "15m" | "30m" | "1h" | "4h" | "1d")[];
}

export interface SttConfig {
  enableDiarization: boolean;
  // Upper bound only. There is deliberately no minSpeakers: a floor above 1 is measurably harmful
  // (it makes the recognizer fabricate a speaker on low-confidence audio) and measurably useless
  // on clean audio, so every request pins the lower bound at 1. See cloud-stt.ts buildV1Config.
  maxSpeakers: number;
  provider: "gemini" | "google_cloud_stt";
}

export interface SttStatus {
  available: boolean;
  authenticated: boolean;
  projectId?: string;
  defaultMinSpeakers: number;
  defaultMaxSpeakers: number;
  supportedModels: string[];
  error?: string;
}



