import { z } from "zod";
import type { Express, Request, Response } from "express";

// --- ZOD SCHEMAS FOR REQUESTS & RESPONSES ---

export const ErrorResponseSchema = z.object({
  error: z.string().describe("Error message describing why the request failed."),
});

export type ValidationResult<T> =
  | { success: true; data: T; error?: string }
  | { success: false; error: string; data?: T };

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
  corrections: z.array(
    z.object({
      original: z.string().describe("Original misheard text segment."),
      corrected: z.string().describe("Corrected text segment."),
      reason: z.string().optional().describe("Reason for correction."),
    })
  ).describe("List of proofreading corrections."),
  words: z.array(
    z.object({
      word: z.string().describe("Word token."),
      start: z.number().describe("Start timestamp in seconds."),
      end: z.number().describe("End timestamp in seconds."),
    })
  ).describe("Word-level timestamp alignments."),
});

export const LivePipelineRequestSchema = z.object({
  text: z.string().min(1).describe("Incremental transcript text."),
  currentLocalTime: z.string().optional().describe("ISO local time string."),
  liveSummary: z.string().optional().describe("Current live summary string."),
  withPlan: z.boolean().optional().describe("Set false to skip expensive planning stage on fast ticks."),
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
  memories: z.array(
    z.object({
      text: z.string().describe("Retrieved memory snippet."),
      timestamp: z.string().describe("Timestamp when memory was recorded."),
    })
  ).describe("Matching memory records."),
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

export const TokenTelemetryTimeSeriesQuerySchema = z.object({
  from: z.coerce.number().optional().describe("Start epoch timestamp in ms"),
  to: z.coerce.number().optional().describe("End epoch timestamp in ms"),
  interval: z
    .enum(["1s", "10s", "30s", "1m", "5m", "15m", "30m", "1h", "4h", "1d", "24h"])
    .optional()
    .default("1m"),
  agent: z.string().optional().describe("Filter by agent label"),
  model: z.string().optional().describe("Filter by model name"),
  sessionId: z.string().optional().describe("Filter by session ID"),
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

export const TokenTelemetryAggregateQuerySchema = z.object({
  from: z.coerce.number().optional().describe("Start epoch timestamp in ms"),
  to: z.coerce.number().optional().describe("End epoch timestamp in ms"),
  sessionId: z.string().optional().describe("Filter by session ID"),
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
  sources: z.array(
    z.object({
      uri: z.string().describe("Source web URL."),
      title: z.string().describe("Source page title."),
    })
  ).describe("Grounded web search sources."),
});

export const TranscribeAudioRequestSchema = z.object({
  audio: z.string().describe("Base64-encoded audio chunk data (e.g., 8-10s Opus)."),
  mimeType: z.string().optional().describe("Audio MIME type (default: audio/webm)."),
  source: z.enum(["mic", "tab"]).optional().describe("Audio capture source."),
});

export const TranscribeAudioResponseSchema = z.object({
  text: z.string().describe("Verbatim transcribed text."),
  source: z.enum(["mic", "tab"]).describe("Audio capture source tag."),
});

export const ExecuteRequestSchema = z.object({
  kind: z.string().describe("Tool action name (e.g. 'create_calendar_event', 'create_task', 'gdrive_upload_doc')."),
  item: z.record(z.string(), z.unknown()).optional().describe("Parameter payload matching the action's schema."),
  accessToken: z.string().optional().describe("Google OAuth access token. Omit or set 'sandbox' for mock execution."),
  action: z.enum(["execute", "delete"]).optional().describe("Action type ('execute' to create, 'delete' to undo)."),
  id: z.string().optional().describe("Resource ID required when action is 'delete'."),
});

// --- OPENAPI 3.0.3 SPECIFICATION GENERATOR ---

export function getOpenApiSpec() {
  return {
    openapi: "3.0.3",
    info: {
      title: "Scribant Agent API",
      version: "1.0.0",
      description:
        "OpenAPI specification for Scribant Agent — an intelligent AI transcription, plan extraction, memory, and workspace automation service.",
      contact: {
        name: "Scribant Engineering",
      },
    },
    servers: [
      {
        url: "http://127.0.0.1:3000",
        description: "Local Development Server",
      },
    ],
    tags: [
      { name: "Core & Pipeline", description: "Transcription, analysis, proofreading, and live streaming pipeline endpoints." },
      { name: "Memory & Context", description: "Vertex AI Memory Bank ingestion, query retrieval, and local memory sync." },
      { name: "ADK & Telemetry", description: "ADK event logs, event streaming (SSE), token metrics, and telemetry stats." },
      { name: "Integrations & Tools", description: "Google Workspace tool execution, grounded web search, and client config." },
    ],
    paths: {
      "/api/config": {
        get: {
          tags: ["Integrations & Tools"],
          summary: "Get OAuth Client Configuration",
          description: "Serves the public Google OAuth Client ID if credentials.json exists locally.",
          responses: {
            "200": {
              description: "Configuration object",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      googleClientId: { type: "string", nullable: true, example: "123456789-abc.apps.googleusercontent.com" },
                    },
                  },
                },
              },
            },
          },
        },
      },
      "/api/analyze": {
        post: {
          tags: ["Core & Pipeline"],
          summary: "Analyze Transcript & Extract Action Plan",
          description: "Processes raw transcript text and extracts structured calendar events, tasks, and web search queries.",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["text"],
                  properties: {
                    text: { type: "string", example: "Schedule a meeting with Sarah tomorrow at 3pm to review the quarterly budget." },
                    currentLocalTime: { type: "string", format: "date-time", example: "2026-08-15T18:30:00Z" },
                    liveSummary: { type: "string", example: "Discussing quarterly budget meeting with Sarah." },
                    sessionId: { type: "string", example: "session-1723749000" },
                  },
                },
              },
            },
          },
          responses: {
            "200": {
              description: "Extracted action plan",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      calendarEvents: {
                        type: "array",
                        items: {
                          type: "object",
                          properties: {
                            title: { type: "string", example: "Meeting with Sarah" },
                            start: { type: "string", example: "2026-08-16T15:00:00Z" },
                            end: { type: "string", example: "2026-08-16T16:00:00Z" },
                            allDay: { type: "boolean", example: false },
                            description: { type: "string", example: "Review quarterly budget" },
                          },
                        },
                      },
                      tasks: {
                        type: "array",
                        items: {
                          type: "object",
                          properties: {
                            title: { type: "string", example: "Prepare quarterly budget slides" },
                            dueDate: { type: "string", example: "2026-08-16T12:00:00Z" },
                          },
                        },
                      },
                      searchQueries: {
                        type: "array",
                        items: {
                          type: "object",
                          properties: {
                            query: { type: "string", example: "Quarterly budget review best practices" },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
            "400": { description: "Invalid request payload", content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } } },
            "500": { description: "Internal server error", content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } } },
          },
        },
      },
      "/api/transcribe-correct": {
        post: {
          tags: ["Core & Pipeline"],
          summary: "Proofread & Correct Transcript",
          description: "Analyzes phonetic transcription errors and returns proofreading corrections and word alignments.",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["text"],
                  properties: {
                    text: { type: "string", example: "Let us schedule a zoom meet in with the engineering lead." },
                  },
                },
              },
            },
          },
          responses: {
            "200": {
              description: "Proofreading result",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      corrections: {
                        type: "array",
                        items: {
                          type: "object",
                          properties: {
                            original: { type: "string", example: "meet in" },
                            corrected: { type: "string", example: "meeting" },
                          },
                        },
                      },
                      words: {
                        type: "array",
                        items: {
                          type: "object",
                          properties: {
                            word: { type: "string", example: "meeting" },
                            start: { type: "number", example: 1.2 },
                            end: { type: "number", example: 1.6 },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
            "400": { description: "Invalid request payload", content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } } },
            "500": { description: "Internal server error", content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } } },
          },
        },
      },
      "/api/live": {
        post: {
          tags: ["Core & Pipeline"],
          summary: "Real-Time Pipeline (NDJSON Stream)",
          description: "Streams proofread, summary, and classification updates incrementally using newline-delimited JSON (application/x-ndjson).",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["text"],
                  properties: {
                    text: { type: "string", example: "Incremental text chunk recorded..." },
                    currentLocalTime: { type: "string", format: "date-time" },
                    liveSummary: { type: "string" },
                    withPlan: { type: "boolean", default: true },
                    sessionId: { type: "string" },
                  },
                },
              },
            },
          },
          responses: {
            "200": {
              description: "NDJSON stream of stage events",
              content: {
                "application/x-ndjson": {
                  schema: {
                    type: "string",
                    description: "Newline-delimited JSON stream yielding stage payloads: { stage: 'proof'|'summary'|'plan', ... }",
                  },
                },
              },
            },
            "400": { description: "Invalid request payload", content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } } },
          },
        },
      },
      "/api/transcribe-audio": {
        post: {
          tags: ["Core & Pipeline"],
          summary: "Transcribe Base64 Audio Chunk",
          description: "Accepts a short base64-encoded audio chunk (8-10s) and returns verbatim transcription text using Gemini.",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["audio"],
                  properties: {
                    audio: { type: "string", description: "Base64 encoded audio string", example: "GkXfo59ChoEBQveBAULygQ..." },
                    mimeType: { type: "string", example: "audio/webm" },
                    source: { type: "string", enum: ["mic", "tab"], example: "mic" },
                  },
                },
              },
            },
          },
          responses: {
            "200": {
              description: "Transcribed text",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      text: { type: "string", example: "I will finish the deployment proposal by Friday." },
                      source: { type: "string", enum: ["mic", "tab"], example: "mic" },
                    },
                  },
                },
              },
            },
            "400": { description: "Invalid request payload", content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } } },
            "500": { description: "Internal server error", content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } } },
          },
        },
      },
      "/api/memory/ingest": {
        post: {
          tags: ["Memory & Context"],
          summary: "Ingest Session/Transcript to Memory Bank",
          description: "Ingests transcript text and plan metadata into Vertex AI Memory Bank for persistent context retrieval.",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["text"],
                  properties: {
                    text: { type: "string", example: "Luis prefers feature branches and atomic commits." },
                    sessionId: { type: "string", example: "session-101" },
                    userId: { type: "string", example: "user-luis" },
                    plan: { type: "object" },
                    timestamp: { type: "string", format: "date-time" },
                  },
                },
              },
            },
          },
          responses: {
            "200": {
              description: "Ingestion confirmation",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      ok: { type: "boolean", example: true },
                      memoryId: { type: "string", example: "mem-98765" },
                    },
                  },
                },
              },
            },
            "400": { description: "Invalid request payload", content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } } },
            "500": { description: "Internal server error", content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } } },
          },
        },
      },
      "/api/memory/retrieve": {
        get: {
          tags: ["Memory & Context"],
          summary: "Retrieve Memories & Synthesize Answer (GET)",
          description: "Queries Vertex AI Memory Bank and returns matching memories along with a direct synthesized answer.",
          parameters: [
            { name: "query", in: "query", required: true, schema: { type: "string" }, description: "Search query" },
            { name: "userId", in: "query", required: false, schema: { type: "string" }, description: "Optional user ID" },
          ],
          responses: {
            "200": { description: "Retrieved memories and synthesized answer", content: { "application/json": { schema: { $ref: "#/components/schemas/MemoryRetrieveResponse" } } } },
            "400": { description: "Query required", content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } } },
            "500": { description: "Retrieval error", content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } } },
          },
        },
        post: {
          tags: ["Memory & Context"],
          summary: "Retrieve Memories & Synthesize Answer (POST)",
          description: "Queries Vertex AI Memory Bank and returns matching memories along with a direct synthesized answer.",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["query"],
                  properties: {
                    query: { type: "string", example: "What workflow preferences does Luis have?" },
                    userId: { type: "string", example: "user-luis" },
                  },
                },
              },
            },
          },
          responses: {
            "200": { description: "Retrieved memories and synthesized answer", content: { "application/json": { schema: { $ref: "#/components/schemas/MemoryRetrieveResponse" } } } },
            "400": { description: "Query required", content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } } },
            "500": { description: "Retrieval error", content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } } },
          },
        },
      },
      "/api/memory/search": {
        get: {
          tags: ["Memory & Context"],
          summary: "Search Memory Bank (Alias to /retrieve)",
          parameters: [
            { name: "query", in: "query", required: true, schema: { type: "string" } },
            { name: "userId", in: "query", required: false, schema: { type: "string" } },
          ],
          responses: {
            "200": { description: "Retrieved memories and synthesized answer", content: { "application/json": { schema: { $ref: "#/components/schemas/MemoryRetrieveResponse" } } } },
          },
        },
        post: {
          tags: ["Memory & Context"],
          summary: "Search Memory Bank (Alias to /retrieve)",
          requestBody: {
            required: true,
            content: { "application/json": { schema: { type: "object", required: ["query"], properties: { query: { type: "string" }, userId: { type: "string" } } } } },
          },
          responses: {
            "200": { description: "Retrieved memories and synthesized answer", content: { "application/json": { schema: { $ref: "#/components/schemas/MemoryRetrieveResponse" } } } },
          },
        },
      },
      "/api/memory/sync": {
        post: {
          tags: ["Memory & Context"],
          summary: "Synchronize Local Session Files to Memory Bank",
          description: "Scans local session JSON logs on disk and syncs un-indexed records into Vertex AI Memory Bank.",
          responses: {
            "200": {
              description: "Sync operation results",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      ok: { type: "boolean", example: true },
                      syncedCount: { type: "number", example: 5 },
                    },
                  },
                },
              },
            },
            "500": { description: "Sync error", content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } } },
          },
        },
      },
      "/api/tokens/stats": {
        get: {
          tags: ["ADK & Telemetry"],
          summary: "Get Token Usage & Context Compaction Metrics",
          description: "Computes compaction ratios, context savings, and token efficiency metrics for input text.",
          parameters: [
            { name: "text", in: "query", schema: { type: "string" }, description: "Raw transcript text" },
            { name: "summary", in: "query", schema: { type: "string" }, description: "Summary text" },
          ],
          responses: {
            "200": {
              description: "Token metrics",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      ok: { type: "boolean", example: true },
                      compaction: { type: "object" },
                      archive: { type: "object" },
                      efficiency: { type: "object" },
                    },
                  },
                },
              },
            },
          },
        },
      },
      "/api/tokens/telemetry/timeseries": {
        get: {
          tags: ["ADK & Telemetry"],
          summary: "Query Token Telemetry Time-Series",
          description: "Returns aggregated time-series buckets (prompt, candidate, thinking, audio tokens, cost, latency) across all models and agents.",
          parameters: [
            { name: "from", in: "query", schema: { type: "number" }, description: "Start timestamp in ms" },
            { name: "to", in: "query", schema: { type: "number" }, description: "End timestamp in ms" },
            { name: "interval", in: "query", schema: { type: "string", enum: ["1s", "10s", "1m", "5m", "1h"], default: "1m" }, description: "Bucket interval" },
            { name: "agent", in: "query", schema: { type: "string" }, description: "Filter by agent label" },
            { name: "model", in: "query", schema: { type: "string" }, description: "Filter by model name" },
            { name: "sessionId", in: "query", schema: { type: "string" }, description: "Filter by session ID" },
          ],
          responses: {
            "200": {
              description: "Time-series points array",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      ok: { type: "boolean", example: true },
                      interval: { type: "string", example: "1m" },
                      points: {
                        type: "array",
                        items: {
                          type: "object",
                          properties: {
                            timestamp: { type: "number" },
                            timeLabel: { type: "string" },
                            promptTokens: { type: "number" },
                            candidatesTokens: { type: "number" },
                            thoughtsTokens: { type: "number" },
                            audioTokens: { type: "number" },
                            totalTokens: { type: "number" },
                            requestCount: { type: "number" },
                            avgDurationMs: { type: "number" },
                            costUsd: { type: "number" },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
      "/api/tokens/telemetry/aggregate": {
        get: {
          tags: ["ADK & Telemetry"],
          summary: "Get Aggregated Token Telemetry Statistics",
          description: "Returns summary token usage, total cost, and breakdowns by sub-agent, model, modality, and pipeline stage.",
          parameters: [
            { name: "from", in: "query", schema: { type: "number" }, description: "Start timestamp in ms" },
            { name: "to", in: "query", schema: { type: "number" }, description: "End timestamp in ms" },
            { name: "sessionId", in: "query", schema: { type: "string" }, description: "Filter by session ID" },
          ],
          responses: {
            "200": {
              description: "Aggregate summary and breakdowns",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      ok: { type: "boolean", example: true },
                      totalTokens: { type: "number" },
                      totalPromptTokens: { type: "number" },
                      totalCandidatesTokens: { type: "number" },
                      totalThoughtsTokens: { type: "number" },
                      totalAudioTokens: { type: "number" },
                      totalCostUsd: { type: "number" },
                      requestCount: { type: "number" },
                      avgLatencyMs: { type: "number" },
                      byAgent: { type: "object" },
                      byModel: { type: "object" },
                      byModality: { type: "object" },
                      byStage: { type: "object" },
                    },
                  },
                },
              },
            },
          },
        },
      },
      "/api/tokens/telemetry/stream": {
        get: {
          tags: ["ADK & Telemetry"],
          summary: "Stream Real-Time Token Telemetry (SSE)",
          description: "Server-Sent Events stream emitting live TokenMetricRecord objects as model invocations complete.",
          responses: {
            "200": {
              description: "text/event-stream real-time events",
              content: {
                "text/event-stream": {
                  schema: { type: "string" },
                },
              },
            },
          },
        },
      },
      "/api/memory/stats": {
        get: {
          tags: ["Memory & Context"],
          summary: "Get Memory Archive Statistics",
          description: "Returns memory efficiency, token usage, and archive storage statistics.",
          responses: {
            "200": {
              description: "Memory stats",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      ok: { type: "boolean", example: true },
                      archive: { type: "object" },
                      efficiency: { type: "object" },
                    },
                  },
                },
              },
            },
          },
        },
      },
      "/api/memory/events": {
        get: {
          tags: ["ADK & Telemetry"],
          summary: "Query Memory & ADK Events History",
          description: "Query recorded execution events with multi-dimensional filtering.",
          parameters: [
            { name: "type", in: "query", schema: { type: "string" }, description: "Event type filter" },
            { name: "author", in: "query", schema: { type: "string" }, description: "Author filter" },
            { name: "status", in: "query", schema: { type: "string" }, description: "Status filter" },
            { name: "search", in: "query", schema: { type: "string" }, description: "Search query string" },
            { name: "sessionId", in: "query", schema: { type: "string" }, description: "Session ID filter" },
            { name: "fromDisk", in: "query", schema: { type: "string" }, description: "Load from disk ('true'/'false')" },
            { name: "limit", in: "query", schema: { type: "integer" }, description: "Max event count" },
          ],
          responses: {
            "200": {
              description: "Event query results",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      ok: { type: "boolean", example: true },
                      count: { type: "integer", example: 12 },
                      events: { type: "array", items: { type: "object" } },
                    },
                  },
                },
              },
            },
          },
        },
      },
      "/api/adk/events": {
        get: {
          tags: ["ADK & Telemetry"],
          summary: "Query ADK Events History (Alias to /api/memory/events)",
          parameters: [
            { name: "type", in: "query", schema: { type: "string" } },
            { name: "author", in: "query", schema: { type: "string" } },
            { name: "status", in: "query", schema: { type: "string" } },
            { name: "search", in: "query", schema: { type: "string" } },
            { name: "sessionId", in: "query", schema: { type: "string" } },
            { name: "fromDisk", in: "query", schema: { type: "string" } },
            { name: "limit", in: "query", schema: { type: "integer" } },
          ],
          responses: {
            "200": { description: "Event query results", content: { "application/json": { schema: { type: "object", properties: { ok: { type: "boolean" }, count: { type: "integer" }, events: { type: "array", items: { type: "object" } } } } } } },
          },
        },
      },
      "/api/memory/events/clear": {
        post: {
          tags: ["ADK & Telemetry"],
          summary: "Clear Event History",
          description: "Clears in-memory recorded event history and optionally deletes persisted disk logs.",
          requestBody: {
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    clearDisk: { type: "boolean", example: true },
                  },
                },
              },
            },
          },
          responses: {
            "200": {
              description: "Clear operation result",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      ok: { type: "boolean", example: true },
                      clearedDisk: { type: "boolean", example: true },
                    },
                  },
                },
              },
            },
          },
        },
      },
      "/api/adk/events/clear": {
        post: {
          tags: ["ADK & Telemetry"],
          summary: "Clear Event History (Alias)",
          responses: { "200": { description: "Clear operation result" } },
        },
      },
      "/api/memory/events/stream": {
        get: {
          tags: ["ADK & Telemetry"],
          summary: "Real-time Event Stream (SSE)",
          description: "Establishes a Server-Sent Events (SSE) connection streaming live ADK & Memory events and heartbeats.",
          responses: {
            "200": {
              description: "Event stream",
              content: {
                "text/event-stream": {
                  schema: {
                    type: "string",
                    description: "Server-Sent Event stream emitting initial 'init' payload and real-time 'event' messages.",
                  },
                },
              },
            },
          },
        },
      },
      "/api/adk/events/stream": {
        get: {
          tags: ["ADK & Telemetry"],
          summary: "Real-time Event Stream (SSE) (Alias)",
          responses: { "200": { description: "Event stream" } },
        },
      },
      "/api/search": {
        post: {
          tags: ["Integrations & Tools"],
          summary: "Grounded Web Search",
          description: "Executes a web search agent and returns condensed and detailed answer tiers with grounding sources.",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["query"],
                  properties: {
                    query: { type: "string", example: "What are the latest updates in TypeScript 5.8?" },
                  },
                },
              },
            },
          },
          responses: {
            "200": {
              description: "Grounded search response",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      query: { type: "string", example: "What are the latest updates in TypeScript 5.8?" },
                      condensed: { type: "string", example: "TypeScript 5.8 introduces optimized return type checks and performance gains." },
                      inDepth: { type: "string", example: "TypeScript 5.8 includes granular type checking improvements..." },
                      sources: {
                        type: "array",
                        items: {
                          type: "object",
                          properties: {
                            uri: { type: "string", example: "https://devblogs.microsoft.com/typescript/announcing-typescript-5-8/" },
                            title: { type: "string", example: "Announcing TypeScript 5.8" },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
            "400": { description: "Query required", content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } } },
            "500": { description: "Search error", content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } } },
          },
        },
      },
      "/api/execute": {
        post: {
          tags: ["Integrations & Tools"],
          summary: "Execute Reviewed Tool Action",
          description: "Executes an approved Google Workspace action (Calendar, Tasks, Drive) or reverts/deletes a created resource.",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["kind"],
                  properties: {
                    kind: { type: "string", example: "create_calendar_event" },
                    item: {
                      type: "object",
                      example: { title: "Team Sync", start: "2026-08-20T10:00:00Z", end: "2026-08-20T11:00:00Z" },
                    },
                    accessToken: { type: "string", description: "Google OAuth access token or 'sandbox'", example: "sandbox" },
                    action: { type: "string", enum: ["execute", "delete"], example: "execute" },
                    id: { type: "string", description: "Target resource ID when action is 'delete'" },
                  },
                },
              },
            },
          },
          responses: {
            "200": {
              description: "Execution result",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      id: { type: "string", example: "mock-create_calendar_event-1723749000" },
                      ok: { type: "boolean", example: true },
                    },
                  },
                },
              },
            },
            "400": { description: "Invalid action or parameters", content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } } },
            "500": { description: "Execution error", content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } } },
          },
        },
      },
    },
    components: {
      schemas: {
        ErrorResponse: {
          type: "object",
          required: ["error"],
          properties: {
            error: { type: "string", example: "Text prompt is required and must be a string." },
          },
        },
        MemoryRetrieveResponse: {
          type: "object",
          properties: {
            ok: { type: "boolean", example: true },
            answer: { type: "string", nullable: true, example: "Luis prefers feature branches." },
            memories: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  text: { type: "string" },
                  timestamp: { type: "string" },
                },
              },
            },
          },
        },
      },
    },
  };
}

// --- EXPRESS ROUTES REGISTRATION ---

export function registerOpenApiRoutes(app: Express) {
  // 1. Raw OpenAPI 3.0 Spec JSON
  app.get("/api/openapi.json", (_req: Request, res: Response) => {
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.json(getOpenApiSpec());
  });

  // 2. Interactive Documentation UI (Scalar UI primary, optional Swagger UI query switch)
  app.get("/docs", (req: Request, res: Response) => {
    const uiMode = req.query.ui === "swagger" ? "swagger" : "scalar";

    if (uiMode === "swagger") {
      res.setHeader("Content-Type", "text/html");
      res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Scribant Agent API Reference — Swagger UI</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui.css" />
  <style>
    body { margin: 0; padding: 0; background: #0f172a; }
    .swagger-ui { filter: invert(88%) hue-rotate(180deg); }
  </style>
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
  <script>
    window.onload = () => {
      SwaggerUIBundle({
        url: '/api/openapi.json',
        dom_id: '#swagger-ui',
        deepLinking: true,
        presets: [SwaggerUIBundle.presets.apis],
      });
    };
  </script>
</body>
</html>`);
      return;
    }

    // Default: Scalar UI (Modern, clean API reference)
    res.setHeader("Content-Type", "text/html");
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

// Self-check runner when executed directly via CLI
if (import.meta.url === `file://${process.argv[1]}`) {
  const spec = getOpenApiSpec();
  if (!spec.openapi || !spec.info?.title || Object.keys(spec.paths).length === 0) {
    throw new Error("[openapi] Invalid spec generated");
  }
  console.log("openapi self-check ✓");
}
