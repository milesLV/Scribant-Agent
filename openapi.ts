import { readFileSync } from "node:fs";
import { z } from "zod";
import type { Express, Request, Response } from "express";

// --- ZOD SCHEMAS FOR REQUESTS & RESPONSES ---

export const ErrorResponseSchema = z.object({
  error: z.string().describe("Error message describing why the request failed."),
});

// Both optional fields stay: callers read .error/.data without narrowing (no strictNullChecks).
export type ValidationResult<T> = { success: true; data: T; error?: string } | { success: false; error: string; data?: T };

export function validatePayload<T>(schema: z.ZodType<T>, data: unknown): ValidationResult<T> {
  const parsed = schema.safeParse(data);
  if (parsed.success) {
    return { success: true, data: parsed.data };
  }
  const issue = parsed.error.issues[0];
  const pathStr = issue?.path?.join(".") || "input";
  return { success: false, error: `${pathStr}: ${issue?.message || "Invalid payload"}` };
}

export const ConfigResponseSchema = z.object({
  googleClientId: z.string().nullable().describe("Public Google OAuth Client ID if credentials.json exists, otherwise null."),
  projectId: z.string().nullable().optional().describe("Configured Google Cloud Project ID."),
  location: z.string().nullable().optional().describe("Configured Vertex AI / GCP region."),
  agentEngineId: z.string().nullable().optional().describe("Configured Vertex AI Agent Engine Reasoning Engine ID for Memory Bank."),
  model: z.string().nullable().optional().describe("Configured Gemini model name."),
});

export const AnalyzeRequestSchema = z.object({
  text: z.string().min(1).describe("The raw voice transcript or user prompt to analyze."),
  currentLocalTime: z.string().optional().describe("ISO timestamp representing the user's current local time."),
  liveSummary: z.string().optional().describe("Existing live summary context if available."),
  sessionId: z.string().optional().describe("Unique session identifier for durable memory capture."),
});

export const CalendarEventSchema = z.object({
  title: z.string().describe("Event title or summary."),
  start: z.string().describe("ISO start timestamp or date string."),
  end: z.string().optional().describe("ISO end timestamp or date string."),
  allDay: z.boolean().optional().describe("True if event is an all-day event."),
  timeZone: z.string().optional().describe("IANA time zone identifier (e.g. 'America/Los_Angeles')."),
  description: z.string().optional().describe("Optional description or notes for the event."),
  confidence: z.number().optional().describe("Model confidence score (0 to 1)."),
  rationale: z.string().optional().describe("Model rationale for extracting this event."),
});

export const TaskItemSchema = z.object({
  title: z.string().describe("Task title."),
  dueDate: z.string().optional().describe("ISO due date string."),
  notes: z.string().optional().describe("Optional task notes or details."),
  confidence: z.number().optional().describe("Model confidence score (0 to 1)."),
  rationale: z.string().optional().describe("Model rationale for extracting this task."),
});

export const SearchQueryItemSchema = z.object({
  query: z.string().describe("Search query string."),
  reason: z.string().optional().describe("Reason why this search query was generated."),
  urgency: z.string().optional().describe("Urgency level (e.g. high, medium, low)."),
});

export const PlanOutputSchema = z.object({
  calendarEvents: z.array(CalendarEventSchema).optional().describe("Extracted calendar events."),
  tasks: z.array(TaskItemSchema).optional().describe("Extracted tasks."),
  searchQueries: z.array(SearchQueryItemSchema).optional().describe("Generated search queries."),
});

export const TranscribeCorrectRequestSchema = z.object({
  text: z.string().min(1).describe("The raw transcript text to proofread and correct."),
});

export const TranscribeCorrectResponseSchema = z.object({
  corrections: z.array(z.object({ original: z.string(), corrected: z.string(), reason: z.string().optional() }))
    .describe("Proofreading corrections: original misheard segment, its correction, and why."),
  words: z.array(z.object({ word: z.string(), start: z.number(), end: z.number() }))
    .describe("Word-level alignments; start/end in seconds."),
});

export const LivePipelineRequestSchema = z.object({
  text: z.string().min(1).describe("Incremental transcript text."),
  currentLocalTime: z.string().optional().describe("ISO local time string."),
  liveSummary: z.string().optional().describe("Current live summary string."),
  withPlan: z.boolean().optional().describe("Set false to skip expensive planning stage on fast ticks."),
  withProof: z.boolean().optional().describe("Set true to include proofreading stage (defaults to false for low latency)."),
  sessionId: z.string().optional().describe("Session identifier for Memory Bank auto-save."),
});

export const MemoryIngestRequestSchema = z.object({
  text: z.string().min(1).describe("Transcript or text content to ingest into Memory Bank."),
  sessionId: z.string().optional().describe("Session ID tag."),
  userId: z.string().optional().describe("User ID tag."),
  plan: z.record(z.string(), z.unknown()).optional().describe("Associated plan or metadata object."),
  timestamp: z.string().optional().describe("ISO timestamp for the memory."),
});

export const MemoryRetrieveQuerySchema = z.object({
  query: z.string().min(1).describe("Search query to match against Memory Bank."),
  userId: z.string().optional().describe("User ID to scope the memory retrieval."),
});

export const MemoryRetrieveResponseSchema = z.object({
  ok: z.literal(true),
  answer: z.string().nullable().describe("AI-synthesized direct answer based on retrieved memories."),
  memories: z.array(z.object({ text: z.string(), timestamp: z.string() })).describe("Matching memory snippets and when each was recorded."),
});

export const MemorySyncResponseSchema = z.object({
  ok: z.literal(true),
  syncedCount: z.number().describe("Number of local session files synced into Memory Bank."),
});

export const TokenStatsQuerySchema = z.object({
  text: z.string().optional().describe("Raw text input to estimate token usage and compaction."),
  summary: z.string().optional().describe("Summary text input."),
});

export const TokenStatsResponseSchema = z.object({
  ok: z.literal(true),
  compaction: z.record(z.string(), z.unknown()).describe("Compaction ratio metrics."),
  archive: z.record(z.string(), z.unknown()).describe("Archive token metrics."),
  efficiency: z.record(z.string(), z.unknown()).describe("Memory efficiency metrics."),
});

export const TokenTimeSeriesPointSchema = z.object({
  timestamp: z.number().describe("Bucket start timestamp in epoch ms"),
  timeLabel: z.string().describe("Formatted time label (HH:MM or HH:MM:SS)"),
  promptTokens: z.number().describe("Total input prompt tokens in bucket"),
  candidatesTokens: z.number().describe("Total output candidate tokens in bucket"),
  thoughtsTokens: z.number().describe("Total reasoning/thinking tokens in bucket"),
  audioTokens: z.number().describe("Total audio modality input tokens in bucket"),
  totalTokens: z.number().describe("Sum of prompt, candidate, and thinking tokens"),
  requestCount: z.number().describe("Number of model requests in bucket"),
  avgDurationMs: z.number().describe("Average request latency in ms"),
  costUsd: z.number().describe("Estimated cost in USD"),
});

export const TokenTelemetryTimeSeriesResponseSchema = z.object({
  ok: z.literal(true),
  interval: z.string(),
  points: z.array(TokenTimeSeriesPointSchema),
});

// Query strings carry booleans as "true"/"false".
const boolQuery = z.preprocess(v => (v === "true" ? true : v === "false" ? false : v), z.boolean().optional())
  .describe("Filter by whether diarization was enabled");

export const TokenTelemetryAggregateQuerySchema = z.object({
  from: z.coerce.number().optional().describe("Start epoch timestamp in ms"),
  to: z.coerce.number().optional().describe("End epoch timestamp in ms"),
  sessionId: z.string().optional().describe("Filter by session ID"),
  diarization: boolQuery,
  diarizationEnabled: boolQuery,
  provider: z.string().optional().describe("Filter by provider (gemini, google_cloud_stt)"),
  source: z.string().optional().describe("Filter by audio/pipeline source (mic, tab, pipeline)"),
});

export const TokenTelemetryTimeSeriesQuerySchema = TokenTelemetryAggregateQuerySchema.extend({
  interval: z.enum(["1s", "10s", "30s", "1m", "5m", "15m", "30m", "1h", "4h", "1d", "24h"]).optional().default("1m"),
  agent: z.string().optional().describe("Filter by agent label"),
  model: z.string().optional().describe("Filter by model name"),
  modality: z.string().optional().describe("Filter by modality (audio, text)"),
  stage: z.string().optional().describe("Filter by pipeline stage"),
});

export const AggregateDimensionStatsSchema = z.object({
  tokens: z.number().describe("Total tokens consumed in dimension"),
  percent: z.number().describe("Percentage of overall tokens"),
  requests: z.number().describe("Request count"),
  costUsd: z.number().describe("Cost in USD"),
});

export const TokenTelemetryAggregateResponseSchema = z.object({
  ok: z.literal(true),
  totalTokens: z.number().describe("Grand total tokens across all models and agents"),
  totalPromptTokens: z.number().describe("Total prompt input tokens"),
  totalCandidatesTokens: z.number().describe("Total candidate output tokens"),
  totalThoughtsTokens: z.number().describe("Total thinking/reasoning tokens"),
  totalAudioTokens: z.number().describe("Total audio modality input tokens"),
  totalCostUsd: z.number().describe("Total estimated cost in USD"),
  requestCount: z.number().describe("Total model invocations"),
  avgLatencyMs: z.number().describe("Average latency across invocations"),
  byAgent: z.record(z.string(), AggregateDimensionStatsSchema),
  byModel: z.record(z.string(), AggregateDimensionStatsSchema),
  byModality: z.record(z.string(), AggregateDimensionStatsSchema),
  byStage: z.record(z.string(), AggregateDimensionStatsSchema),
  byDiarization: z.record(z.string(), AggregateDimensionStatsSchema).optional(),
  byProvider: z.record(z.string(), AggregateDimensionStatsSchema).optional(),
});

export const EventsQuerySchema = z.object({
  type: z.string().optional().describe("Filter events by type (e.g. tool_call, tool_result)."),
  author: z.string().optional().describe("Filter events by author (e.g. workspace_tools, grounded_searcher)."),
  status: z.string().optional().describe("Filter events by status (e.g. success, error)."),
  search: z.string().optional().describe("Search query matching event content."),
  sessionId: z.string().optional().describe("Filter events by session ID."),
  fromDisk: z.string().optional().describe("Set 'true' to load historical events from disk logs."),
  limit: z.coerce.number().optional().describe("Maximum number of events to return."),
});

export const EventsClearRequestSchema = z.object({
  clearDisk: z.boolean().optional().describe("Set true to also clear events persisted on disk."),
});

export const SearchRequestSchema = z.object({
  query: z.string().min(1).describe("Research or web search query."),
});

export const SearchResponseSchema = z.object({
  query: z.string().describe("Original query."),
  condensed: z.string().describe("1-2 sentence direct answer."),
  inDepth: z.string().describe("Detailed 4-7 sentence explanation."),
  sources: z.array(z.object({ uri: z.string(), title: z.string() })).describe("Grounded web search sources (URL and page title)."),
});

export const TranscribeAudioRequestSchema = z.object({
  audio: z.string().describe("Base64-encoded audio for ONE self-contained chunk."),
  mimeType: z.string().optional().describe("Audio MIME type (default: audio/webm)."),
  source: z.enum(["mic", "tab"]).optional().describe("Audio capture source."),
  enableDiarization: z.boolean().optional().describe("Whether to use Google Cloud STT speaker diarization."),
  minSpeakers: z.number().min(1).max(8).optional().describe("Minimum expected speakers (default: 1 — let the recognizer decide; see cloud-stt.ts)."),
  maxSpeakers: z.number().min(1).max(8).optional().describe("Maximum expected speakers (default: 1)."),
  sessionId: z.string().optional().describe("Session key for the multi-speaker latch. Without it each chunk decides labelling alone."),
});

export const TranscribeAudioResponseSchema = z.object({
  text: z.string().describe("Verbatim or diarized transcribed text."),
  source: z.enum(["mic", "tab"]).describe("Audio capture source tag."),
  // Required: a silent fall back to Gemini flattens diarization, and the client can only surface
  // that degradation if it is always told which engine answered.
  provider: z.enum(["gemini", "google_cloud_stt"]).describe("STT engine that produced this result."),
  speakerCount: z.number().optional().describe("Distinct speakers in THIS chunk (labels are chunk-local — see speaker-registry.ts)."),
  turns: z.array(z.object({ speaker: z.string(), text: z.string(), startMs: z.number().optional(), endMs: z.number().optional() }))
    .optional()
    .describe("Diarized turns for this chunk (chunk-local labels like \"Speaker 1\", chunk-relative ms). Absent when diarization was off or degraded."),
  multiSpeaker: z.boolean().optional().describe("Latched: true once the session has seen 2+ speakers in 2+ chunks. Keeps labels on solo chunks."),
  degraded: z.boolean().optional().describe("True when diarization was requested but could not be produced (Cloud STT failed, Gemini answered)."),
});

/* --- /api/stt/stream (WebSocket) ---------------------------------------------------------------
 * Not a REST path, so it has no OpenAPI entry — but its messages are payloads crossing a trust
 * boundary, so they are defined here with the rest and validated with validatePayload, same as
 * every other endpoint. The client opens the socket, sends ONE start message, then raw binary
 * audio frames; `segment` cuts a fresh recognition before Google's 305s streaming limit.
 * Server replies (not validated): `interim {text}` preview, never appended; `final {turns, speakers}`
 * append-only committed turns; `segment_due` near the 305s limit (client cuts and sends `segment`);
 * `error {message}`.
 */
export const SttStreamStartSchema = z.object({
  type: z.literal("start"),
  sessionId: z.string().optional().describe("Capture session key, for telemetry correlation."),
  source: z.enum(["mic", "tab"]).optional().describe("Audio capture source."),
  maxSpeakers: z.number().min(1).max(8).optional().describe("Upper bound on speakers (default: 1). The lower bound is always 1."),
  mimeType: z.string().optional().describe("MediaRecorder container, e.g. 'audio/webm;codecs=opus'. Selects WEBM_OPUS vs OGG_OPUS."),
});

export const SttStreamControlSchema = z.discriminatedUnion("type", [
  SttStreamStartSchema,
  z.object({ type: z.literal("segment") }).describe("Close the current recognition and open a new one. Speaker numbering restarts."),
  z.object({ type: z.literal("stop") }).describe("Close the recognition and the socket."),
]);

export const SttStatusResponseSchema = z.object({
  available: z.boolean().describe("Whether Google Cloud STT V2 is available."),
  authenticated: z.boolean().describe("Whether Google Cloud ADC authentication is active."),
  projectId: z.string().optional().describe("GCP Project ID in use."),
  defaultMinSpeakers: z.number().describe("Default minimum speaker count (1)."),
  defaultMaxSpeakers: z.number().describe("Default maximum speaker count (1)."),
  supportedModels: z.array(z.string()).describe("Supported STT models."),
  error: z.string().optional().describe("Authentication or configuration error message."),
});

export const ExecuteRequestSchema = z.object({
  kind: z.string().describe("Tool action name (e.g. 'create_calendar_event', 'create_task', 'gdrive_upload_doc')."),
  item: z.record(z.string(), z.unknown()).optional().describe("Parameter payload matching the action's schema."),
  accessToken: z.string().optional().describe("Google OAuth access token. Omit or set 'sandbox' for mock execution."),
  action: z.enum(["execute", "delete"]).optional().describe("Action type ('execute' to create, 'delete' to undo)."),
  id: z.string().optional().describe("Resource ID required when action is 'delete'."),
});

// --- OPENAPI 3.0.3 SPEC, generated from the schemas above so it can't drift from what the server validates ---

const toSchema = (s: z.ZodType) => z.toJSONSchema(s, { target: "openapi-3.0", io: "input" }) as any;
const json = (s: z.ZodType) => ({ content: { "application/json": { schema: toSchema(s) } } });
const queryParams = (s: z.ZodType) => {
  const { properties = {}, required = [] } = toSchema(s);
  return Object.entries<any>(properties).map(([name, schema]) =>
    ({ name, in: "query", required: required.includes(name), description: schema.description, schema }));
};

type Route = { tag: string; summary: string; body?: z.ZodType; query?: z.ZodType; res?: z.ZodType; stream?: string };
const CORE = "Core & Pipeline", MEMORY = "Memory & Context", ADK = "ADK & Telemetry", TOOLS = "Integrations & Tools";
const SSE = "text/event-stream";
const ROUTES: Record<string, Route> = {
  "get /api/config": { tag: TOOLS, summary: "Get client & environment configuration", res: ConfigResponseSchema },
  "post /api/analyze": { tag: CORE, summary: "Analyze transcript & extract action plan", body: AnalyzeRequestSchema, res: PlanOutputSchema },
  "post /api/transcribe-correct": { tag: CORE, summary: "Proofread & correct transcript", body: TranscribeCorrectRequestSchema, res: TranscribeCorrectResponseSchema },
  "post /api/live": { tag: CORE, summary: "Real-time pipeline (NDJSON stream, one line per stage)", body: LivePipelineRequestSchema, stream: "application/x-ndjson" },
  "post /api/transcribe-audio": { tag: CORE, summary: "Transcribe a base64 audio chunk", body: TranscribeAudioRequestSchema, res: TranscribeAudioResponseSchema },
  "get /api/stt/status": { tag: CORE, summary: "Cloud STT & diarization readiness", res: SttStatusResponseSchema },
  "post /api/memory/ingest": { tag: MEMORY, summary: "Ingest a transcript into Memory Bank", body: MemoryIngestRequestSchema },
  "get /api/memory/retrieve": { tag: MEMORY, summary: "Retrieve memories & synthesize an answer", query: MemoryRetrieveQuerySchema, res: MemoryRetrieveResponseSchema },
  "post /api/memory/retrieve": { tag: MEMORY, summary: "Retrieve memories & synthesize an answer", body: MemoryRetrieveQuerySchema, res: MemoryRetrieveResponseSchema },
  "get /api/memory/search": { tag: MEMORY, summary: "Alias of GET /api/memory/retrieve", query: MemoryRetrieveQuerySchema, res: MemoryRetrieveResponseSchema },
  "post /api/memory/search": { tag: MEMORY, summary: "Alias of POST /api/memory/retrieve", body: MemoryRetrieveQuerySchema, res: MemoryRetrieveResponseSchema },
  "post /api/memory/sync": { tag: MEMORY, summary: "Sync local session files into Memory Bank", res: MemorySyncResponseSchema },
  "get /api/memory/stats": { tag: MEMORY, summary: "Memory archive statistics" },
  "get /api/tokens/stats": { tag: ADK, summary: "Token usage & context compaction metrics", query: TokenStatsQuerySchema, res: TokenStatsResponseSchema },
  "get /api/tokens/telemetry/timeseries": { tag: ADK, summary: "Token telemetry time series", query: TokenTelemetryTimeSeriesQuerySchema, res: TokenTelemetryTimeSeriesResponseSchema },
  "get /api/tokens/telemetry/aggregate": { tag: ADK, summary: "Aggregated token telemetry", query: TokenTelemetryAggregateQuerySchema, res: TokenTelemetryAggregateResponseSchema },
  "get /api/tokens/telemetry/stream": { tag: ADK, summary: "Live token telemetry (SSE)", stream: SSE },
  "get /api/memory/events": { tag: ADK, summary: "Query ADK & memory event history", query: EventsQuerySchema },
  "get /api/adk/events": { tag: ADK, summary: "Alias of /api/memory/events", query: EventsQuerySchema },
  "post /api/memory/events/clear": { tag: ADK, summary: "Clear event history", body: EventsClearRequestSchema },
  "post /api/adk/events/clear": { tag: ADK, summary: "Alias of /api/memory/events/clear", body: EventsClearRequestSchema },
  "get /api/memory/events/stream": { tag: ADK, summary: "Live event stream (SSE)", stream: SSE },
  "get /api/adk/events/stream": { tag: ADK, summary: "Alias of /api/memory/events/stream", stream: SSE },
  "post /api/search": { tag: TOOLS, summary: "Grounded web search", body: SearchRequestSchema, res: SearchResponseSchema },
  "post /api/execute": { tag: TOOLS, summary: "Execute or undo a reviewed Workspace action", body: ExecuteRequestSchema },
};

export function getOpenApiSpec() {
  const paths: Record<string, any> = {};
  for (const [key, r] of Object.entries(ROUTES)) {
    const [method, path] = key.split(" ");
    const ok = r.res ? { description: "OK", ...json(r.res) }
      : r.stream ? { description: "Stream", content: { [r.stream]: {} } } : { description: "OK" };
    (paths[path] ??= {})[method] = {
      tags: [r.tag],
      summary: r.summary,
      ...(r.query && { parameters: queryParams(r.query) }),
      ...(r.body && { requestBody: { required: true, ...json(r.body) } }),
      responses: {
        "200": ok,
        ...((r.body || r.query) && { "400": { description: "Invalid request", ...json(ErrorResponseSchema) } }),
        "5XX": { description: "Server error, or a model stage that failed after retries (502)", ...json(ErrorResponseSchema) },
      },
    };
  }
  return {
    openapi: "3.0.3",
    info: {
      title: "Scribant Agent API",
      version: "1.0.0",
      description: "Transcription, plan extraction, memory, and Google Workspace automation.",
    },
    servers: [{ url: "http://127.0.0.1:3000", description: "Local development" }],
    tags: [CORE, MEMORY, ADK, TOOLS].map(name => ({ name, description: name })),
    paths,
  };
}

export function registerOpenApiRoutes(app: Express) {
  const spec = getOpenApiSpec(); // static: the schemas never change at runtime
  app.get("/api/openapi.json", (_req: Request, res: Response) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.json(spec);
  });

  app.get("/docs", (_req: Request, res: Response) => {
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Scribant Agent API Documentation</title>
  <style>
    body { margin: 0; padding: 0; background-color: #0d1117; color: #f0f6fc; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
  </style>
</head>
<body>
  <script
    id="api-reference"
    data-url="/api/openapi.json"
    data-configuration='{"theme": "purple", "darkMode": true, "showSidebar": true}'
    src="https://cdn.jsdelivr.net/npm/@scalar/api-reference"></script>
</body>
</html>`);
  });
}

// Self-check: every /api route server.ts registers is documented, and nothing documented is missing.
if (import.meta.url === `file://${process.argv[1]}`) {
  const served = [...readFileSync(new URL("./server.ts", import.meta.url), "utf8")
    .matchAll(/app\.(get|post)\("(\/api\/[^"]+)"/g)].map(m => `${m[1]} ${m[2]}`).sort();
  const documented = Object.keys(ROUTES).sort();
  if (JSON.stringify(served) !== JSON.stringify(documented))
    throw new Error(`[openapi] routes and spec differ:\n served ${served}\n documented ${documented}`);
  getOpenApiSpec(); // every schema converts
  console.log("openapi self-check ✓");
}
