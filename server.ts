import express from "express";
import path from "path";
import { promises as fs } from "fs";
import { createServer as createViteServer } from "vite";
import { WebSocketServer } from "ws";
import { setLogLevel, LogLevel } from "@google/adk";
import { splitTiers, safeSeg, estimateTokens, computeCompaction, stripSpeakerLabels } from "./server-utils";
import {
  captureMemoryEvent,
  getMemoryService,
  ingestTranscriptToMemoryBank,
  retrieveFromMemoryBank,
  syncLocalMemoriesToMemoryBank,
  VertexAiMemoryBankService,
  getMemoryEvents,
  clearMemoryEvents,
  subscribeToMemoryEvents,
  memoryEvents,
  getArchiveTokenMetrics,
  computeMemoryEfficiency,
} from "./memory";
import { WORKSPACE_ACTIONS, gcalDeleteEvent, gtasksDeleteTask } from "./workspace-tools";
import { MODEL, askAgent, askAgentParts, groundedSearcher, audioTranscriber, memoryAnswerer } from "./agents";
import { runOrchestrator, type Stage } from "./orchestrator";
import { transcribeWithCloudStt, checkCloudSttStatus } from "./cloud-stt";
import { noteChunk } from "./speaker-registry";
import { openSttStream, SEGMENT_MS, type SttStream } from "./stt-stream";
import { emitAdkEvent, createEvent, createEventActions } from "./adk-events";
import {
  registerOpenApiRoutes,
  validatePayload,
  ConfigResponseSchema,
  AnalyzeRequestSchema,
  TranscribeCorrectRequestSchema,
  LivePipelineRequestSchema,
  MemoryIngestRequestSchema,
  MemoryRetrieveQuerySchema,
  SearchRequestSchema,
  TranscribeAudioRequestSchema,
  SttStreamControlSchema,
  ExecuteRequestSchema,
  TokenStatsQuerySchema,
  TokenTelemetryTimeSeriesQuerySchema,
  TokenTelemetryAggregateQuerySchema,
  EventsQuerySchema,
  EventsClearRequestSchema,
} from "./openapi";
import {
  queryTokenTimeSeries,
  queryTokenAggregate,
  subscribeTokenStream,
  getMemoryBufferSnapshot,
  recordTokenUsage,
} from "./token-telemetry";

const app = express();
// 15mb covers a base64-encoded ~8-10s audio chunk (see /api/transcribe-audio) with headroom; every
// other route here sends plain text, well under that.
app.use(express.json({ limit: "15mb" }));

// OpenAPI specification (/api/openapi.json) and interactive API reference (/docs)
registerOpenApiRoutes(app);

// 3000 by default: the OAuth redirect URI registered in Google Cloud is per-port.
const PORT = Number(process.env.PORT) || 3000;

setLogLevel(LogLevel.WARN); // silence ADK's per-event INFO logging

// A disk failure must never 500 a response the user already spent tokens on — every capture site
// swallows its own error and just logs, tagged by caller for the console.
const safeCapture = (tag: string, sessionId: unknown, entry: { text: string; plan?: unknown }) => {
  try { captureMemoryEvent(sessionId, entry); }
  catch (e: any) { console.warn(`[${tag}] memory capture failed:`, e?.message || e); }
};

// Non-blocking Vertex AI Memory Bank ingestion helper
const safeIngest = (tag: string, sessionId: unknown, entry: { text: string }) => {
  ingestTranscriptToMemoryBank({
    text: entry.text,
    sessionId: safeSeg(sessionId, "session"),
  }).catch(e => console.warn(`[${tag}] memory bank ingest failed:`, e?.message || e));
};

// Every route below is a caller of ONE orchestrator (orchestrator.ts) with a different stage set,
// so no two of them can drift apart the way four hand-wired agent calls did.

// Saves the user pasting their own client ID: serve the one already in credentials.json.
// Also serves active GCP/Vertex AI environment configuration read from .env.
app.get("/api/config", async (_req, res) => {
  let googleClientId: string | null = null;
  try {
    const creds = JSON.parse(await fs.readFile(path.join(process.cwd(), "credentials.json"), "utf-8"));
    googleClientId = (creds.installed ?? creds.web)?.client_id ?? null;
  } catch {
    googleClientId = null;
  }

  const projectId = process.env.GOOGLE_CLOUD_PROJECT ?? process.env.PROJECT_ID ?? null;
  const location = process.env.VERTEX_AI_LOCATION ?? process.env.GOOGLE_CLOUD_LOCATION ?? "us-central1";
  const agentEngineId =
    process.env.VERTEX_AI_AGENT_ENGINE_ID ??
    process.env.AGENT_ENGINE_ID ??
    process.env.MEMORY_BANK_AGENT_ENGINE_ID ??
    process.env.REASONING_ENGINE_ID ??
    process.env.VERTEX_MEMORY_BANK_ID ??
    null;
  const model = process.env.GEMINI_MODEL ?? process.env.MODEL ?? MODEL ?? "gemini-3.7-flash";

  res.json({
    googleClientId,
    projectId,
    location,
    agentEngineId,
    model,
  });
});

app.post("/api/analyze", async (req, res) => {
  try {
    const v = validatePayload(AnalyzeRequestSchema, req.body);
    if (!v.success) {
      res.status(400).json({ error: "Text prompt is required and must be a string." });
      return;
    }
    const { text, currentLocalTime, liveSummary, sessionId } = v.data;

    // Durably save the raw transcript BEFORE calling the model, so the user's words survive even if
    // the plan call below fails — `plan` is omitted for now, filled in once it resolves below. A
    // disk failure must not 500 an analysis the user already spent tokens on.
    safeCapture("analyze", sessionId, { text });

    const { plan } = await runOrchestrator({
      stages: new Set<Stage>(["plan"]),
      text,
      refISO: currentLocalTime || new Date().toISOString(),
      liveSummary,
    });
    const parsed = plan ?? {};
    console.log(`[analyze] text=${text.length}ch → events=${parsed.calendarEvents?.length ?? 0} tasks=${parsed.tasks?.length ?? 0} queries=${parsed.searchQueries?.length ?? 0}`);

    // Phase 1 memory capture: overwrite the same session record with the resolved plan attached, for
    // Phase 2 to eventually sync into Memory Bank. Same "never fail the response over a side write"
    // treatment as the pre-model save above.
    safeCapture("analyze", sessionId, { text, plan: parsed });
    safeIngest("analyze", sessionId, { text });

    res.json(parsed);
  } catch (error: any) {
    console.error("Analysis API failed:", error);
    res.status(500).json({ error: error.message || "Internal server error" });
  }
});



app.post("/api/transcribe-correct", async (req, res) => {
  try {
    const v = validatePayload(TranscribeCorrectRequestSchema, req.body);
    if (!v.success) {
      res.status(400).json({ error: "Text is required and must be a string." });
      return;
    }
    const { text } = v.data;
    const { proof } = await runOrchestrator({
      stages: new Set<Stage>(["proof"]),
      text,
      refISO: new Date().toISOString(),
    });
    res.json({ corrections: proof?.corrections ?? [], words: proof?.words ?? [] });
  } catch (error: any) {
    console.error("Transcribe-correct failed:", error);
    res.status(500).json({ error: error.message || "Failed to proofread transcript." });
  }
});

// One request per capture tick, never three: separate per-stage requests race each other and
// multiply 429s. The orchestrator runs proofread FIRST, then summarize + classify in parallel over
// the corrected text; this route forwards each stage as newline-delimited JSON the moment it lands,
// so the fast proofread doesn't wait on the slow classifier.
//
// Additive by design: /api/analyze, /api/transcribe-correct and /api/search keep their contracts
// (the evals and the "Analyze Thoughts" finalize button still use them).
app.post("/api/live", async (req, res) => {
  const v = validatePayload(LivePipelineRequestSchema, req.body);
  if (!v.success) {
    res.status(400).json({ error: "Text is required and must be a string." });
    return;
  }
  const { text, currentLocalTime, liveSummary, withPlan, withProof, sessionId } = v.data;

  res.setHeader("Content-Type", "application/x-ndjson");
  res.setHeader("Cache-Control", "no-cache");
  res.flushHeaders();
  const send = (obj: unknown) => { if (!res.writableEnded) res.write(JSON.stringify(obj) + "\n"); };

  try {
    // For low-latency streaming, summary + plan run in parallel; proofreading runs only if requested.
    const stages = new Set<Stage>();
    if (withProof) stages.add("proof");
    stages.add("summary");
    if (withPlan !== false) stages.add("plan");
    let latestPlan: unknown;
    await runOrchestrator({
      stages,
      text,
      refISO: currentLocalTime || new Date().toISOString(),
      liveSummary,
      // One stage failing must not sink the others — the orchestrator reports each stage
      // independently, error included, so a 429 on the classifier still ships the proofread.
      onStage: (stage, payload) => {
        if (stage === "plan" && payload && !payload.error) latestPlan = payload.plan;
        send({ stage, ...payload });
      },
    });
    console.log(`[live] text=${text.length}ch plan=${withPlan === false ? "skipped" : "ran"}`);

    // Auto-save: overwrite the session's memory record (text + the latest plan, on ticks that re-ran
    // the classifier) with the current snapshot on every live tick — one file per session, not a
    // growing log of near-duplicate lines. The client already debounces these to a couple of
    // seconds apart (LIVE_QUIET_MS/LIVE_MAX_WAIT_MS in App.tsx), so this doubles as the auto-save
    // cadence without a second timer. `sessionId` is only set once a recording is underway, so
    // evals and other callers that don't send one simply don't autosave.
    if (sessionId) {
      safeCapture("live", sessionId, { text, plan: latestPlan });
      safeIngest("live", sessionId, { text });
    }
  } catch (error: any) {
    console.error("Live API failed:", error);
    send({ stage: "fatal", error: error?.message || "Live pipeline failed." });
  } finally {
    res.end();
  }
});

// Memory Bank: Ingest a transcript or session explicitly into Vertex AI Memory Bank
app.post("/api/memory/ingest", async (req, res) => {
  try {
    const v = validatePayload(MemoryIngestRequestSchema, req.body);
    if (!v.success) {
      res.status(400).json({ error: "text is required and must be a string." });
      return;
    }
    const { text, sessionId, userId, plan, timestamp } = v.data;
    const result = await ingestTranscriptToMemoryBank({
      text,
      sessionId: safeSeg(sessionId, "session"),
      userId: safeSeg(userId, "default_user"),
      plan,
      timestamp,
    });
    res.json({ ok: true, ...result });
  } catch (error: any) {
    console.error("Memory bank ingest failed:", error);
    res.status(500).json({ error: error.message || "Failed to ingest into memory bank." });
  }
});

// Memory Bank: Retrieve memories/facts matching a query from Vertex AI Memory Bank
const handleMemoryRetrieve = async (req: express.Request, res: express.Response) => {
  try {
    const rawQuery = String((req.method === "POST" ? req.body.query : req.query.query) || "").trim();
    const rawUserId = String((req.method === "POST" ? req.body.userId : req.query.userId) || "").trim();
    const v = validatePayload(MemoryRetrieveQuerySchema, { query: rawQuery, userId: rawUserId || undefined });
    if (!v.success) {
      res.status(400).json({ error: "query is required." });
      return;
    }
    const { query, userId } = v.data;
    const result = await retrieveFromMemoryBank(query, {
      userId: userId ? safeSeg(userId, "default_user") : undefined,
    });

    let answer: string | null = null;
    if (result.memories.length > 0) {
      try {
        const memoryContext = result.memories.map((m, i) => `[Memory ${i + 1} (${m.timestamp})]: ${m.text}`).join("\n\n");
        const prompt = `User Question: "${query}"\n\nPast Recorded Memories from Vertex AI Memory Bank:\n${memoryContext}\n\nAnswer the user's question directly based on these past memories in 1-2 clear sentences.`;
        const ans = await askAgent(memoryAnswerer, prompt);
        answer = ans.text.trim() || null;
        if (answer) {
          emitAdkEvent(
            createEvent({
              author: "memory",
              invocationId: `answer-${Date.now()}`,
              content: {
                role: "model",
                parts: [{ text: `[Memory Answer]: ${answer}` }],
              },
              actions: createEventActions({
                stateDelta: {
                  eventType: "memory:retrieve",
                  query,
                  answer,
                  status: "success",
                },
              }),
            })
          );
        }
      } catch (e: any) {
        console.warn("[memory] Failed to synthesize direct answer:", e?.message || e);
      }
    }

    res.json({ ok: true, answer, ...result });
  } catch (error: any) {
    console.error("Memory bank retrieval failed:", error);
    res.status(500).json({ error: error.message || "Failed to retrieve from memory bank." });
  }
};
app.post("/api/memory/retrieve", handleMemoryRetrieve);
app.post("/api/memory/search", handleMemoryRetrieve);
app.get("/api/memory/retrieve", handleMemoryRetrieve);
app.get("/api/memory/search", handleMemoryRetrieve);

// Memory Bank: Synchronize all local session files to Vertex AI Memory Bank
app.post("/api/memory/sync", async (_req, res) => {
  try {
    const result = await syncLocalMemoriesToMemoryBank();
    res.json({ ok: true, ...result });
  } catch (error: any) {
    console.error("Memory bank sync failed:", error);
    res.status(500).json({ error: error.message || "Failed to sync local memory to memory bank." });
  }
});

// Token Telemetry & Context Compaction metrics API
app.get("/api/tokens/stats", (req, res) => {
  try {
    const rawText = String(req.query.text || "").trim();
    const summaryText = String(req.query.summary || "").trim();
    const compaction = computeCompaction(rawText, summaryText);
    const archive = getArchiveTokenMetrics();
    const efficiency = computeMemoryEfficiency([], rawText);
    res.json({
      ok: true,
      compaction,
      archive,
      efficiency,
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message || "Failed to fetch token stats" });
  }
});

// Real-time Token Telemetry Time-Series endpoint (minute, second, or hourly buckets)
app.get("/api/tokens/telemetry/timeseries", (req, res) => {
  try {
    const validation = validatePayload(TokenTelemetryTimeSeriesQuerySchema, req.query);
    if (!validation.success) {
      res.status(400).json({ error: validation.error });
      return;
    }
    const query = validation.data;
    const diarizationFilter = query.diarizationEnabled !== undefined ? query.diarizationEnabled : query.diarization;
    const result = queryTokenTimeSeries({
      from: query.from,
      to: query.to,
      interval: query.interval,
      agent: query.agent,
      model: query.model,
      sessionId: query.sessionId,
      diarizationEnabled: diarizationFilter,
      provider: query.provider,
      source: query.source,
      modality: query.modality,
      stage: query.stage,
    });
    res.json(result);
  } catch (error: any) {
    console.error("Token telemetry time-series query failed:", error);
    res.status(500).json({ error: error.message || "Failed to query token time-series" });
  }
});

// Aggregated Token Telemetry endpoint (by model, sub-agent, modality, and pipeline stage)
app.get("/api/tokens/telemetry/aggregate", (req, res) => {
  try {
    const validation = validatePayload(TokenTelemetryAggregateQuerySchema, req.query);
    if (!validation.success) {
      res.status(400).json({ error: validation.error });
      return;
    }
    const query = validation.data;
    const diarizationFilter = query.diarizationEnabled !== undefined ? query.diarizationEnabled : query.diarization;
    const result = queryTokenAggregate({
      from: query.from,
      to: query.to,
      sessionId: query.sessionId,
      diarizationEnabled: diarizationFilter,
      provider: query.provider,
      source: query.source,
    });
    res.json(result);
  } catch (error: any) {
    console.error("Token telemetry aggregate query failed:", error);
    res.status(500).json({ error: error.message || "Failed to query token aggregate" });
  }
});

// Real-Time Token Telemetry Server-Sent Events (SSE) Stream
app.get("/api/tokens/telemetry/stream", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  // Send initial snapshot of recent records
  const recent = getMemoryBufferSnapshot().slice(-20);
  for (const rec of recent) {
    res.write(`data: ${JSON.stringify(rec)}\n\n`);
  }

  // Subscribe to live token events
  const unsubscribe = subscribeTokenStream((rec) => {
    try {
      res.write(`data: ${JSON.stringify(rec)}\n\n`);
    } catch {
      // Ignore write errors on disconnected clients
    }
  });

  req.on("close", () => {
    unsubscribe();
  });
});

// Memory Bank Archive & Efficiency summary API
app.get("/api/memory/stats", (_req, res) => {
  try {
    const archive = getArchiveTokenMetrics();
    const efficiency = computeMemoryEfficiency([], "");
    res.json({ ok: true, archive, efficiency });
  } catch (error: any) {
    res.status(500).json({ error: error.message || "Failed to fetch memory stats" });
  }
});

// Memory & ADK Events: Query events with multi-dimensional filtering (in-memory or disk)
const handleGetEvents = (req: any, res: any) => {
  try {
    const type = req.query.type as string | undefined;
    const author = req.query.author as string | undefined;
    const status = req.query.status as string | undefined;
    const search = (req.query.search || req.query.q) as string | undefined;
    const sessionId = (req.query.sessionId || req.query.session) as string | undefined;
    const fromDisk = req.query.fromDisk === "true" || req.query.source === "disk";
    const limit = req.query.limit ? Number(req.query.limit) : undefined;
    const events = getMemoryEvents({ type, author, status, search, sessionId, fromDisk, limit });
    res.json({ ok: true, count: events.length, events });
  } catch (error: any) {
    console.error("Failed to fetch memory/adk events:", error);
    res.status(500).json({ error: error.message || "Failed to fetch events." });
  }
};
app.get("/api/memory/events", handleGetEvents);
app.get("/api/adk/events", handleGetEvents);

// Memory & ADK Events: Clear recorded events history (optionally on disk)
const handleClearEvents = (req: any, res: any) => {
  try {
    const clearDisk = req.body?.clearDisk === true || req.query.clearDisk === "true";
    clearMemoryEvents({ clearDisk });
    res.json({ ok: true, clearedDisk: clearDisk });
  } catch (error: any) {
    console.error("Failed to clear memory events:", error);
    res.status(500).json({ error: error.message || "Failed to clear memory events." });
  }
};
app.post("/api/memory/events/clear", handleClearEvents);
app.post("/api/adk/events/clear", handleClearEvents);

// Memory & ADK Events: Real-time Server-Sent Events (SSE) stream
const handleEventStream = (req: any, res: any) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  // Send initial history
  const initialEvents = getMemoryEvents({ limit: 100 });
  res.write(`data: ${JSON.stringify({ type: "init", events: initialEvents })}\n\n`);

  // Subscribe to real-time events
  const unsubscribe = subscribeToMemoryEvents((event) => {
    if (!res.writableEnded) {
      res.write(`data: ${JSON.stringify({ type: "event", event })}\n\n`);
    }
  });

  // Keep-alive heartbeat ping every 15s
  const pingInterval = setInterval(() => {
    if (!res.writableEnded) {
      res.write(": ping\n\n");
    }
  }, 15000);

  req.on("close", () => {
    clearInterval(pingInterval);
    unsubscribe();
  });
};
app.get("/api/memory/events/stream", handleEventStream);
app.get("/api/adk/events/stream", handleEventStream);

// Grounded search: agent answer + the sources it grounded on, split into the two UI tiers.
async function groundedSearch(query: string) {
  const response = await askAgent(groundedSearcher, `Search the web and answer this research query: "${query}".
Respond in EXACTLY this format, nothing else:
CONDENSED: <a direct 1-2 sentence answer>
DETAILED: <a thorough 4-7 sentence explanation with the key facts and context>`);

  const chunks = response.grounding?.groundingChunks;
  const sources = chunks
    ? chunks
        .filter((c: any) => c.web?.uri)
        .map((c: any) => ({ uri: c.web.uri, title: c.web.title || c.web.uri }))
    : [];

  const { condensed, inDepth } = splitTiers(response.text || "");
  return { query, condensed, inDepth, sources };
}

app.post("/api/search", async (req, res) => {
  try {
    const v = validatePayload(SearchRequestSchema, req.body);
    if (!v.success) {
      res.status(400).json({ error: "Query is required and must be a string." });
      return;
    }
    const { query } = v.data;

    res.json(await groundedSearch(query));
  } catch (error: any) {
    console.error("Search API failed:", error);
    res.status(500).json({ error: error.message || "Failed to execute grounded search." });
  }
});

// One chunk of captured audio (mic or shared-tab) → verbatim/diarized text.
// If enableDiarization is true, calls Google Cloud STT (V1 — see cloud-stt.ts) with diarization.
// Speaker labels are CHUNK-LOCAL: "Speaker 1" here and in the next chunk are not tied together.
// Automatically falls back to Gemini audioTranscriber if Cloud STT fails or is unconfigured.
app.post("/api/transcribe-audio", async (req, res) => {
  try {
    const v = validatePayload(TranscribeAudioRequestSchema, req.body);
    if (!v.success) {
      res.status(400).json({ error: "audio (base64) is required and must be a string." });
      return;
    }
    const {
      audio, mimeType, source, enableDiarization, minSpeakers, maxSpeakers, sessionId,
    } = v.data;
    const cleanAudio = audio.replace(/^data:audio\/[^;]+;base64,/, "");

    // Check if Cloud STT diarization is requested
    if (enableDiarization) {
      try {
        console.log(`[CloudSTT] Transcribing chunk (${source || "mic"}, ${mimeType || "audio/webm"}) with diarization (speakers: ${minSpeakers ?? 1}-${maxSpeakers ?? 5})...`);
        const cloudResult = await transcribeWithCloudStt(cleanAudio, {
          mimeType: typeof mimeType === "string" && mimeType ? mimeType : "audio/webm",
          enableDiarization: true,
          minSpeakers: minSpeakers ?? 1,
          maxSpeakers: maxSpeakers ?? 5,
        });

        // Labels stay exactly as this chunk produced them — nothing is remapped. The only session
        // state kept is the latch: has this session actually seen two people, corroborated across
        // chunks? The client needs that to decide whether to show labels at all, because a chunk
        // in which only one of two people speaks comes back with a single tag.
        const chunkSpeakers = new Set(cloudResult.speakerTurns.map(t => t.speaker)).size;
        const multiSpeaker = noteChunk(sessionId, chunkSpeakers);

        console.log(`[CloudSTT] ✓ ${cloudResult.words.length} words, ${cloudResult.speakerTurns.length} turn(s), ${chunkSpeakers} speaker(s) this chunk${multiSpeaker ? " (session latched multi-speaker)" : ""}`);

        // Emit ADK Telemetry Event
        emitAdkEvent(
          createEvent({
            author: "google_cloud_stt",
            invocationId: `stt-${Date.now()}`,
            content: {
              role: "model",
              parts: [{ text: cloudResult.text }],
            },
            actions: createEventActions({
              stateDelta: {
                eventType: "stt:transcribe",
                provider: "google_cloud_stt",
                speakerCount: chunkSpeakers,
                wordCount: cloudResult.words.length,
                turnCount: cloudResult.speakerTurns.length,
                diarizationEnabled: true,
                source: source === "tab" ? "tab" : "mic",
              },
            }),
          })
        );

        // Record Token Telemetry Record
        recordTokenUsage({
          model: "google_stt_v1", // diarization is always V1 — chirp_2 is the non-diarizing V2 path
          agent: "google_cloud_stt",
          stage: "stt",
          modality: "audio",
          diarizationEnabled: true,
          provider: "google_cloud_stt",
          source: source === "tab" ? "tab" : "mic",
          metadata: {
            speakerCount: chunkSpeakers,
            wordCount: cloudResult.words.length,
            turnCount: cloudResult.speakerTurns.length,
            minSpeakers: minSpeakers ?? 1,
            maxSpeakers: maxSpeakers ?? 5,
          },
          promptTokensFallback: Math.ceil(cloudResult.words.length * 1.6),
          candidatesTokensFallback: Math.ceil(cloudResult.words.length * 1.3),
        });

        res.json({
          // Whenever diarization is on this ALWAYS carries "Speaker N: " prefixes, even for a
          // one-voice chunk (groupWordsIntoSpeakerTurns is called with alwaysPrefixSpeaker). The
          // client builds its transcript from `turns`, which are unprefixed, and only falls back
          // to this when there are none — so the prefixes here never reach the transcript.
          text: cloudResult.text,
          source: source === "tab" ? "tab" : "mic",
          provider: "google_cloud_stt",
          speakerCount: chunkSpeakers,
          multiSpeaker,
          // Projected onto the declared response shape: SpeakerTurn also carries every word-level
          // diarization token, which is a large payload the client has no use for.
          turns: cloudResult.speakerTurns.map(({ speaker, text, startMs, endMs }) => ({ speaker, text, startMs, endMs })),
        });
        return;
      } catch (sttErr: any) {
        console.warn("[transcribe-audio] Cloud STT diarization failed, falling back to Gemini audioTranscriber:", sttErr.message);
      }
    }

    // Default / fallback to Gemini multimodal audio transcriber
    console.log(`[STT] Transcribing audio chunk (${source || "mic"}) via Gemini multimodal audio transcriber...`);
    const { text } = await askAgentParts(
      audioTranscriber,
      [{ inlineData: { mimeType: typeof mimeType === "string" && mimeType ? mimeType : "audio/webm", data: cleanAudio } }],
      {
        diarizationEnabled: Boolean(enableDiarization),
        source: source === "tab" ? "tab" : "mic",
        metadata: {
          requestedDiarization: Boolean(enableDiarization),
          minSpeakers,
          maxSpeakers,
        },
      }
    );

    console.log(`[STT] ✓ Gemini transcription complete (${text.trim().length} chars)`);

    // Gemini emits no turns, deliberately. Its "Speaker N:" prefixes come from prompt
    // instruction, not acoustics: they carry no timestamps, are not stable between chunks, and
    // were observed alternating labels for a single speaker. Passing them through as real turns
    // is worse than having none, because the client cannot tell them from Cloud STT's. Report
    // `degraded` instead so the UI can say diarization dropped out.
    res.json({
      // Dropping `turns` is not enough on its own: the transcriber prompt asks for "Speaker 1:"
      // prefixes, so the LABELS ALSO LIVE IN THE TEXT and would land in the transcript verbatim —
      // the same alternating labels, just as a string instead of a structure. Strip them on the
      // degraded path only, where diarization was asked for and did not happen.
      text: enableDiarization ? stripSpeakerLabels(text) : text.trim(),
      source: source === "tab" ? "tab" : "mic",
      provider: "gemini",
      ...(enableDiarization ? { degraded: true } : {}),
    });
  } catch (error: any) {
    console.error("Audio transcription failed:", error);
    res.status(500).json({ error: error.message || "Failed to transcribe audio." });
  }
});

// Endpoint to check Google Cloud STT V2 readiness and credentials
app.get("/api/stt/status", async (_req, res) => {
  try {
    const status = await checkCloudSttStatus();
    res.json({
      available: status.available,
      authenticated: status.authenticated,
      projectId: status.projectId,
      // 1, not 2. A floor above 1 is what made the recognizer split one voice in two, and it is
      // pinned at 1 on every request — advertising 2 here contradicted both the transport and
      // this endpoint's own published schema (openapi.ts describes it as "(1)").
      defaultMinSpeakers: 1,
      defaultMaxSpeakers: 5,
      // chirp_2 is the V2 non-diarizing path only; diarization always runs V1, whose model field
      // is left at the default. See transcribeWithCloudStt.
      supportedModels: ["chirp_2", "latest_long", "default"],
      error: status.error,
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message || "Failed to query STT status." });
  }
});

// Execute ONE reviewed item. Supports both authenticated Google Workspace calls and sandbox mode.
app.post("/api/execute", async (req, res) => {
  try {
    const { kind, item, accessToken, action, id } = req.body;
    const isSandbox = !accessToken || accessToken === "sandbox";

    // 1. Emit tool_call Event
    emitAdkEvent(
      createEvent({
        author: "workspace_tools",
        invocationId: `tool-${Date.now()}`,
        content: {
          role: "model",
          parts: [
            {
              functionCall: {
                name: action === "delete" ? `delete_${kind}` : kind,
                args: action === "delete" ? { id, kind } : item || {},
                id: `call-${Date.now()}`,
              },
            },
          ],
        },
        actions: createEventActions({
          stateDelta: {
            eventType: "tool_call",
            toolName: kind,
            action: action || "execute",
            args: item,
            mode: isSandbox ? "sandbox" : "google_api",
          },
        }),
      })
    );

    // Undo: delete exactly the resource a previous create returned the id for.
    if (action === "delete") {
      if (!isSandbox) {
        const del = { create_calendar_event: gcalDeleteEvent, create_task: gtasksDeleteTask }[kind as string];
        if (!del) {
          res.status(400).json({ error: `Unknown kind "${kind}" (expected "create_calendar_event" or "create_task").` });
          return;
        }
        if (!id || typeof id !== "string") {
          res.status(400).json({ error: "delete requires the created resource id." });
          return;
        }
        await del(accessToken, id);
      }

      emitAdkEvent(
        createEvent({
          author: "workspace_tools",
          invocationId: `tool-${Date.now()}`,
          content: {
            role: "model",
            parts: [
              {
                functionResponse: {
                  name: `delete_${kind}`,
                  response: { ok: true, id, status: "deleted", mode: isSandbox ? "sandbox" : "google_api" },
                  id: `call-${Date.now()}`,
                },
              },
            ],
          },
          actions: createEventActions({
            stateDelta: {
              eventType: "tool_result",
              toolName: `delete_${kind}`,
              status: "success",
            },
          }),
        })
      );

      res.json({ ok: true });
      return;
    }

    if (!item || typeof item !== "object") {
      res.status(400).json({ error: "item is required." });
      return;
    }

    // `kind` IS the registry action name — the client sends what the agent would call.
    const workspaceAction = WORKSPACE_ACTIONS[kind as string];
    if (!workspaceAction) {
      res.status(400).json({ error: `Unknown kind "${kind}" (expected ${Object.keys(WORKSPACE_ACTIONS).map(k => `"${k}"`).join(", ")}).` });
      return;
    }

    // The action's own schema is the request validation
    const parsed = workspaceAction.parameters.safeParse(item);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      res.status(400).json({ error: `${kind} item is invalid: ${issue.path.join(".") || "item"} — ${issue.message}.` });
      return;
    }

    let resultId: string;
    if (isSandbox) {
      resultId = `mock-${kind}-${Date.now()}`;
    } else {
      const result: any = await workspaceAction.run(accessToken, parsed.data);
      resultId = String(result.eventId ?? result.taskId ?? result.folderId ?? result.fileId ?? `id-${Date.now()}`);
    }

    // Emit tool_result Event
    emitAdkEvent(
      createEvent({
        author: "workspace_tools",
        invocationId: `tool-${Date.now()}`,
        content: {
          role: "model",
          parts: [
            {
              functionResponse: {
                name: kind,
                response: { id: resultId, ...parsed.data, status: "created", mode: isSandbox ? "sandbox" : "google_api" },
                id: `call-${Date.now()}`,
              },
            },
          ],
        },
        actions: createEventActions({
          stateDelta: {
            eventType: "tool_result",
            toolName: kind,
            status: "success",
            resultId,
            item: parsed.data,
            mode: isSandbox ? "sandbox" : "google_api",
          },
        }),
      })
    );

    res.json({ id: resultId });
  } catch (error: any) {
    console.error("Execute API failed:", error);
    emitAdkEvent(
      createEvent({
        author: "workspace_tools",
        invocationId: `tool-${Date.now()}`,
        content: {
          role: "model",
          parts: [{ text: `Tool execution failed: ${error.message || String(error)}` }],
        },
        actions: createEventActions({
          stateDelta: {
            eventType: "tool_result",
            status: "error",
            error: error.message || String(error),
          },
        }),
      })
    );
    res.status(500).json({ error: error.message || "Failed to execute action." });
  }
});

// Startup: key check, then Vite middleware (dev) or static bundle (prod), then listen.
async function main() {
  if (process.env.GOOGLE_GENAI_USE_ENTERPRISE && !process.env.GOOGLE_GENAI_USE_VERTEXAI) {
    process.env.GOOGLE_GENAI_USE_VERTEXAI = process.env.GOOGLE_GENAI_USE_ENTERPRISE;
  }
  // ADK reads the key (or the Vertex AI project/location) when each agent is built — fail fast at
  // startup if .env has neither. Vertex mode auths via ADC/service account, not an API key, so an
  // empty KEYS list is only fatal when GOOGLE_GENAI_USE_VERTEXAI / GOOGLE_GENAI_USE_ENTERPRISE isn't set.
  const usingVertex = /^(1|true)$/i.test(process.env.GOOGLE_GENAI_USE_VERTEXAI || process.env.GOOGLE_GENAI_USE_ENTERPRISE || "");
  if (usingVertex && (!process.env.GOOGLE_CLOUD_PROJECT || !process.env.GOOGLE_CLOUD_LOCATION)) {
    throw new Error("GOOGLE_GENAI_USE_VERTEXAI is set but GOOGLE_CLOUD_PROJECT/GOOGLE_CLOUD_LOCATION is missing in .env.");
  }

  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true, host: "127.0.0.1" },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (_req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  // Automatically sync local disk sessions to Vertex AI Memory Bank on startup
  syncLocalMemoriesToMemoryBank().then(({ syncedCount }) => {
    if (syncedCount > 0) {
      console.log(`[memory] Synced ${syncedCount} session(s) from disk into Vertex AI Memory Bank.`);
    }
  }).catch(e => console.warn("[memory] Startup memory sync failed:", e?.message || e));

  const server = app.listen(PORT, "127.0.0.1", () => {
    const memService = getMemoryService();
    const isVertexMem = memService instanceof VertexAiMemoryBankService;
    const memDesc = isVertexMem
      ? `Vertex AI Memory Bank (${process.env.VERTEX_AI_AGENT_ENGINE_ID || process.env.AGENT_ENGINE_ID || "active"})`
      : "Custom Memory Bank";
    const authDesc = `Vertex AI: ${process.env.GOOGLE_CLOUD_PROJECT}/${process.env.GOOGLE_CLOUD_LOCATION} | Model: ${MODEL}`;
    console.log(`Server running on http://127.0.0.1:${PORT} (${authDesc} | ${memDesc})`);
    console.log(`Also accessible at http://localhost:${PORT}`);
  });

  registerSttStream(server);
}

/**
 * Live diarized transcription over one long-lived Cloud STT recognition (see stt-stream.ts).
 *
 * A WebSocket rather than the SSE endpoint next door because this one needs the CLIENT to talk:
 * SSE is server->client only, and the audio flows the other way.
 *
 * The socket carries two kinds of frame. Text frames are JSON control messages validated against
 * SttStreamControlSchema; binary frames are raw audio appended to the open recognition. Audio
 * arriving before `start`, or after an error, is dropped rather than buffered — a recognition that
 * failed to open will not succeed later in the same segment, and buffering audio for a stream that
 * does not exist is how a leak starts.
 */
function registerSttStream(server: import("http").Server) {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    // Only OUR path. Vite's HMR runs its own upgrade listener on the same server in dev, so a
    // socket.destroy() here for anything unrecognised would kill hot reload.
    if (!req.url?.startsWith("/api/stt/stream")) return;
    wss.handleUpgrade(req, socket, head, ws => wss.emit("connection", ws, req));
  });

  wss.on("connection", ws => {
    let stream: SttStream | null = null;
    let cfg: { sessionId?: string; source?: "mic" | "tab"; maxSpeakers?: number; mimeType?: string } = {};
    let segments = 0;
    let segmentTimer: ReturnType<typeof setTimeout> | null = null;
    let stopping = false;
    const send = (msg: unknown) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg)); };

    const closeStream = () => {
      if (segmentTimer) { clearTimeout(segmentTimer); segmentTimer = null; }
      stream?.end();
      stream = null;
    };

    const openSegment = async () => {
      closeStream();
      segments++;
      try {
        stream = await openSttStream({ maxSpeakers: cfg.maxSpeakers, mimeType: cfg.mimeType }, {
          onInterim: text => send({ type: "interim", text }),
          onFinal: ({ turns, speakers }) => send({
            type: "final",
            turns: turns.map(({ speaker, text, startMs, endMs }) => ({ speaker, text, startMs, endMs })),
            speakers,
          }),
          onError: message => { closeStream(); send({ type: "error", message }); },
          onEnd: () => { if (stopping) ws.close(); },
        });
        // Ask the client to cut before Google closes the recognition out from under us. It has to
        // restart its recorder in the same move, so it cannot be done server-side alone.
        segmentTimer = setTimeout(() => send({ type: "segment_due" }), SEGMENT_MS);
      } catch (err: any) {
        send({ type: "error", message: err?.message || "Failed to open Cloud STT stream" });
      }
    };

    ws.on("message", async (data: Buffer, isBinary: boolean) => {
      if (isBinary) { stream?.write(data); return; }

      let parsed: unknown;
      try { parsed = JSON.parse(data.toString()); } catch { return; }
      const v = validatePayload(SttStreamControlSchema, parsed);
      if (!v.success) { send({ type: "error", message: v.error }); return; }

      switch (v.data.type) {
        case "start":
          cfg = { sessionId: v.data.sessionId, source: v.data.source, maxSpeakers: v.data.maxSpeakers, mimeType: v.data.mimeType };
          console.log(`[stt-stream] open (${cfg.source || "mic"}, max ${cfg.maxSpeakers ?? 5} speakers)`);
          await openSegment();
          break;
        case "segment":
          // A new recognition is a new clustering space, so speaker numbering restarts here.
          console.log(`[stt-stream] segment ${segments + 1} (${cfg.source || "mic"})`);
          await openSegment();
          break;
        case "stop":
          // Close on the recognition's `end`, not here: results for audio already sent are still
          // in flight, and closing now would throw away the last thing the user said. The timer is
          // the backstop for a stream that never drains.
          stopping = true;
          closeStream();
          setTimeout(() => ws.close(), 5000);
          break;
      }
    });

    ws.on("close", () => {
      closeStream();
      if (segments) {
        emitAdkEvent(createEvent({
          author: "google_cloud_stt",
          invocationId: `stt-stream-${Date.now()}`,
          content: { role: "model", parts: [{ text: `streaming recognition closed after ${segments} segment(s)` }] },
          actions: createEventActions({
            stateDelta: {
              eventType: "stt:stream_close",
              provider: "google_cloud_stt",
              transport: "streaming",
              segments,
              diarizationEnabled: true,
              source: cfg.source === "tab" ? "tab" : "mic",
            },
          }),
        }));
      }
    });
    ws.on("error", () => closeStream());
  });
}

main();
