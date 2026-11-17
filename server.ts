import express from "express";
import path from "path";
import { promises as fs } from "fs";
import { createServer as createViteServer } from "vite";
import { WebSocketServer } from "ws";
import { setLogLevel, LogLevel } from "@google/adk";
import { splitTiers, safeSeg, computeCompaction, stripSpeakerLabels } from "./server-utils";
import {
  captureMemoryEvent,
  ingestTranscriptToMemoryBank,
  retrieveFromMemoryBank,
  syncLocalMemoriesToMemoryBank,
  getArchiveTokenMetrics,
  computeMemoryEfficiency,
  emitMemoryEvent,
} from "./memory";
import { WORKSPACE_ACTIONS, gcalDeleteEvent, gtasksDeleteTask } from "./workspace-tools";
import { MODEL, askAgent, groundedSearcher, audioTranscriber, memoryAnswerer } from "./agents";
import { runOrchestrator, type Stage } from "./orchestrator";
import { transcribeWithCloudStt, checkCloudSttStatus, DEFAULT_MAX_SPEAKERS } from "./cloud-stt";
import { noteChunk } from "./speaker-registry";
import { openSttStream, SEGMENT_MS, type SttStream } from "./stt-stream";
import { emitAdkEvent, createEvent, createEventActions, getAdkEvents, clearAdkEvents, subscribeToAdkEvents } from "./adk-events";
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

// One telemetry event for the ADK stream (AdminMonitoring renders these).
const emit = (author: string, invocationPrefix: string, parts: any[], stateDelta: Record<string, unknown>) =>
  emitAdkEvent(createEvent({
    author,
    invocationId: `${invocationPrefix}-${Date.now()}`,
    content: { role: "model", parts },
    actions: createEventActions({ stateDelta }),
  }));

// Validate against an openapi.ts schema; on failure send the 400 and return null.
function parseOr400<T>(schema: Parameters<typeof validatePayload<T>>[0], data: unknown, res: express.Response): { data: T } | null {
  const v = validatePayload(schema, data);
  if (v.success) return { data: v.data };
  res.status(400).json({ error: v.error });
  return null;
}

// A disk failure must never 500 a response the user already spent tokens on — every capture site
// swallows its own error and just logs, tagged by caller for the console.
const safeCapture = (tag: string, sessionId: unknown, entry: { text: string; plan?: unknown }) => {
  try { captureMemoryEvent(sessionId, entry); }
  catch (e: any) { console.warn(`[${tag}] memory capture failed:`, e?.message || e); }
};

// Fire-and-forget Memory Bank ingest.
const safeIngest = (tag: string, sessionId: unknown, text: string) =>
  ingestTranscriptToMemoryBank({ text, sessionId: safeSeg(sessionId, "session") })
    .catch(e => console.warn(`[${tag}] memory bank ingest failed:`, e?.message || e));

// The OAuth client ID from credentials.json (saves the user pasting it) plus the GCP config.
app.get("/api/config", async (_req, res) => {
  let googleClientId: string | null = null;
  try {
    const creds = JSON.parse(await fs.readFile(path.join(process.cwd(), "credentials.json"), "utf-8"));
    googleClientId = (creds.installed ?? creds.web)?.client_id ?? null;
  } catch {}

  const projectId = process.env.GOOGLE_CLOUD_PROJECT ?? process.env.PROJECT_ID ?? null;
  const location = process.env.VERTEX_AI_LOCATION ?? process.env.GOOGLE_CLOUD_LOCATION ?? "us-central1";
  const agentEngineId =
    process.env.VERTEX_AI_AGENT_ENGINE_ID ??
    process.env.AGENT_ENGINE_ID ??
    process.env.VERTEX_MEMORY_BANK_ID ??
    null;

  const v = validatePayload(ConfigResponseSchema, { googleClientId, projectId, location, agentEngineId, model: MODEL });
  if (!v.success) {
    res.status(500).json({ error: `Invalid config: ${v.error}` });
    return;
  }
  res.json(v.data);
});

app.post("/api/analyze", async (req, res) => {
  try {
    const v = parseOr400(AnalyzeRequestSchema, req.body, res);
    if (!v) return;
    const { text, currentLocalTime, liveSummary, sessionId } = v.data;

    // Save the raw words before the model call so they survive a plan failure; the plan is added below.
    safeCapture("analyze", sessionId, { text });

    const { plan, errors } = await runOrchestrator({
      stages: new Set<Stage>(["plan"]),
      text,
      refISO: currentLocalTime || new Date().toISOString(),
      liveSummary,
    });
    if (errors.plan) {
      res.status(502).json({ error: errors.plan });
      return;
    }
    const parsed = plan ?? {};
    console.log(`[analyze] text=${text.length}ch → events=${parsed.calendarEvents?.length ?? 0} tasks=${parsed.tasks?.length ?? 0} queries=${parsed.searchQueries?.length ?? 0}`);

    safeCapture("analyze", sessionId, { text, plan: parsed });
    safeIngest("analyze", sessionId, text);

    res.json(parsed);
  } catch (error: any) {
    console.error("Analysis API failed:", error);
    res.status(500).json({ error: error.message || "Internal server error" });
  }
});

app.post("/api/transcribe-correct", async (req, res) => {
  try {
    const v = parseOr400(TranscribeCorrectRequestSchema, req.body, res);
    if (!v) return;
    const { text } = v.data;
    const { proof, errors } = await runOrchestrator({
      stages: new Set<Stage>(["proof"]),
      text,
      refISO: new Date().toISOString(),
    });
    if (errors.proof) {
      res.status(502).json({ error: errors.proof });
      return;
    }
    res.json({ corrections: proof?.corrections ?? [], words: proof?.words ?? [] });
  } catch (error: any) {
    console.error("Transcribe-correct failed:", error);
    res.status(500).json({ error: error.message || "Failed to proofread transcript." });
  }
});

// One request per capture tick (per-stage requests race and multiply 429s). Each stage is streamed
// as an NDJSON line the moment it lands. Proofread runs only with withProof (evals); the app
// proofreads once on stop via /api/transcribe-correct.
app.post("/api/live", async (req, res) => {
  const v = parseOr400(LivePipelineRequestSchema, req.body, res);
  if (!v) return;
  const { text, currentLocalTime, liveSummary, withPlan, withProof, sessionId } = v.data;

  res.setHeader("Content-Type", "application/x-ndjson");
  res.setHeader("Cache-Control", "no-cache");
  res.flushHeaders();
  const send = (obj: unknown) => { if (!res.writableEnded) res.write(JSON.stringify(obj) + "\n"); };

  try {
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
      // Stages report independently, errors included, so one failing doesn't sink the others.
      onStage: (stage, payload) => {
        if (stage === "plan" && payload && !payload.error) latestPlan = payload.plan;
        send({ stage, ...payload });
      },
    });
    console.log(`[live] text=${text.length}ch plan=${withPlan === false ? "skipped" : "ran"}`);

    // Auto-save: overwrite the session's one memory record each (client-debounced) tick. Callers
    // without a sessionId (evals) don't autosave.
    if (sessionId) {
      safeCapture("live", sessionId, { text, plan: latestPlan });
      safeIngest("live", sessionId, text);
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
    const v = parseOr400(MemoryIngestRequestSchema, req.body, res);
    if (!v) return;
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
    const v = parseOr400(MemoryRetrieveQuerySchema, { query: rawQuery, userId: rawUserId || undefined }, res);
    if (!v) return;
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
        if (answer) emitMemoryEvent(`answer-${Date.now()}`, `[Memory Answer]: ${answer}`, { eventType: "memory:retrieve", query, answer, status: "success" });
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
    const v = parseOr400(TokenStatsQuerySchema, req.query, res);
    if (!v) return;
    const rawText = (v.data.text || "").trim();
    const summaryText = (v.data.summary || "").trim();
    const compaction = computeCompaction(rawText, summaryText);
    const archive = getArchiveTokenMetrics();
    const efficiency = computeMemoryEfficiency([], rawText);
    res.json({ ok: true, compaction, archive, efficiency });
  } catch (error: any) {
    res.status(500).json({ error: error.message || "Failed to fetch token stats" });
  }
});

// Token telemetry: time-series buckets and aggregates (by model, sub-agent, modality, stage).
// `diarization` is a legacy alias for `diarizationEnabled`.
const telemetryRoute = (schema: any, run: (q: any) => unknown, what: string) => (req: express.Request, res: express.Response) => {
  try {
    const v = parseOr400<any>(schema, req.query, res);
    if (!v) return;
    const { diarization, diarizationEnabled, ...query } = v.data;
    res.json(run({ ...query, diarizationEnabled: diarizationEnabled ?? diarization }));
  } catch (error: any) {
    console.error(`Token telemetry ${what} query failed:`, error);
    res.status(500).json({ error: error.message || `Failed to query token ${what}` });
  }
};
app.get("/api/tokens/telemetry/timeseries", telemetryRoute(TokenTelemetryTimeSeriesQuerySchema, queryTokenTimeSeries, "time-series"));
app.get("/api/tokens/telemetry/aggregate", telemetryRoute(TokenTelemetryAggregateQuerySchema, queryTokenAggregate, "aggregate"));

// Open an SSE response; the returned writer drops messages once the client has gone.
function openSse(res: express.Response) {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();
  return (data: unknown) => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(data)}\n\n`); };
}

app.get("/api/tokens/telemetry/stream", (req, res) => {
  const send = openSse(res);
  getMemoryBufferSnapshot().slice(-20).forEach(send);
  req.on("close", subscribeTokenStream(send));
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
    const v = parseOr400(EventsQuerySchema, req.query, res);
    if (!v) return;
    const { type, author, status, limit } = v.data;
    // `q`, `session` and `source=disk` are legacy aliases, not in the schema.
    const search = v.data.search || (req.query.q as string | undefined);
    const sessionId = v.data.sessionId || (req.query.session as string | undefined);
    const fromDisk = v.data.fromDisk === "true" || req.query.source === "disk";
    const events = getAdkEvents({ type, author, status, search, sessionId, fromDisk, limit });
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
    const v = parseOr400(EventsClearRequestSchema, req.body ?? {}, res);
    if (!v) return;
    const clearDisk = v.data.clearDisk === true || req.query.clearDisk === "true";
    clearAdkEvents({ clearDisk });
    res.json({ ok: true, clearedDisk: clearDisk });
  } catch (error: any) {
    console.error("Failed to clear memory events:", error);
    res.status(500).json({ error: error.message || "Failed to clear memory events." });
  }
};
app.post("/api/memory/events/clear", handleClearEvents);
app.post("/api/adk/events/clear", handleClearEvents);

// Memory & ADK Events: Real-time Server-Sent Events (SSE) stream
const handleEventStream = (req: express.Request, res: express.Response) => {
  const send = openSse(res);
  send({ type: "init", events: getAdkEvents({ limit: 100 }) });
  const unsubscribe = subscribeToAdkEvents(event => send({ type: "event", event }));
  const ping = setInterval(() => { if (!res.writableEnded) res.write(": ping\n\n"); }, 15000); // keep proxies from closing it
  req.on("close", () => { clearInterval(ping); unsubscribe(); });
};
app.get("/api/memory/events/stream", handleEventStream);
app.get("/api/adk/events/stream", handleEventStream);

// Grounded search: agent answer + the sources it grounded on, split into the two UI tiers.
app.post("/api/search", async (req, res) => {
  try {
    const v = parseOr400(SearchRequestSchema, req.body, res);
    if (!v) return;
    const { query } = v.data;
    const response = await askAgent(groundedSearcher, `Search the web and answer this research query: "${query}".
Respond in EXACTLY this format, nothing else:
CONDENSED: <a direct 1-2 sentence answer>
DETAILED: <a thorough 4-7 sentence explanation with the key facts and context>`);
    const sources = (response.grounding?.groundingChunks ?? [])
      .filter((c: any) => c.web?.uri)
      .map((c: any) => ({ uri: c.web.uri, title: c.web.title || c.web.uri }));
    const { condensed, inDepth } = splitTiers(response.text || "");
    res.json({ query, condensed, inDepth, sources });
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
    const v = parseOr400(TranscribeAudioRequestSchema, req.body, res);
    if (!v) return;
    const {
      audio, mimeType, source, enableDiarization, minSpeakers, maxSpeakers, sessionId,
    } = v.data;
    const src = source ?? "mic";
    const cleanAudio = audio.replace(/^data:audio\/[^;]+;base64,/, "").trim();
    if (cleanAudio.length < 50) {
      res.json({ text: "", source: src, provider: "none", speakerCount: 0, turns: [] });
      return;
    }

    // Gemini and STT reject container/codec parameters like ";codecs=opus" with 400 Invalid
    // Argument, so reduce to the canonical type ("audio/webm", "audio/ogg", "audio/wav").
    const rawMime = typeof mimeType === "string" && mimeType ? mimeType : "audio/webm";
    const cleanMime = rawMime.split(";")[0].trim().toLowerCase() || "audio/webm";

    if (enableDiarization) {
      try {
        console.log(`[CloudSTT] Transcribing chunk (${src}, ${cleanMime}) with diarization (speakers: ${minSpeakers ?? 1}-${maxSpeakers ?? DEFAULT_MAX_SPEAKERS})...`);
        const cloudResult = await transcribeWithCloudStt(cleanAudio, {
          mimeType: cleanMime,
          enableDiarization: true,
          minSpeakers: minSpeakers ?? 1,
          maxSpeakers: maxSpeakers ?? DEFAULT_MAX_SPEAKERS,
        });

        // Labels are chunk-local and never remapped. The session only keeps a latch: has it seen two
        // speakers, corroborated across chunks? The client uses that to decide whether to show labels.
        const chunkSpeakers = new Set(cloudResult.speakerTurns.map(t => t.speaker)).size;
        const multiSpeaker = noteChunk(sessionId, chunkSpeakers);
        const counts = { speakerCount: chunkSpeakers, wordCount: cloudResult.words.length, turnCount: cloudResult.speakerTurns.length };

        console.log(`[CloudSTT] ✓ ${cloudResult.words.length} words, ${cloudResult.speakerTurns.length} turn(s), ${chunkSpeakers} speaker(s) this chunk${multiSpeaker ? " (session latched multi-speaker)" : ""}`);

        emit("google_cloud_stt", "stt", [{ text: cloudResult.text }], {
          eventType: "stt:transcribe",
          provider: "google_cloud_stt",
          ...counts,
          diarizationEnabled: true,
          source: src,
        });
        recordTokenUsage({
          model: "google_stt_v1", // diarization is always V1 — chirp_2 is the non-diarizing V2 path
          agent: "google_cloud_stt",
          stage: "stt",
          modality: "audio",
          diarizationEnabled: true,
          provider: "google_cloud_stt",
          source: src,
          metadata: { ...counts, minSpeakers: minSpeakers ?? 1, maxSpeakers: maxSpeakers ?? DEFAULT_MAX_SPEAKERS },
          promptTokensFallback: Math.ceil(cloudResult.words.length * 1.6),
          candidatesTokensFallback: Math.ceil(cloudResult.words.length * 1.3),
        });

        res.json({
          // Always "Speaker N:"-prefixed; the client builds from the unprefixed `turns` instead.
          text: cloudResult.text,
          source: src,
          provider: "google_cloud_stt",
          speakerCount: chunkSpeakers,
          multiSpeaker,
          // Drop the per-word tokens SpeakerTurn carries; the client never uses them.
          turns: cloudResult.speakerTurns.map(({ speaker, text, startMs, endMs }) => ({ speaker, text, startMs, endMs })),
        });
        return;
      } catch (sttErr: any) {
        console.warn("[transcribe-audio] Cloud STT diarization failed, falling back to Gemini audioTranscriber:", sttErr.message);
      }
    }

    console.log(`[STT] Transcribing audio chunk (${src}) via Gemini multimodal audio transcriber...`);
    const { text } = await askAgent(audioTranscriber, [{ inlineData: { mimeType: cleanMime, data: cleanAudio } }], {
      diarizationEnabled: Boolean(enableDiarization),
      source: src,
      metadata: { requestedDiarization: Boolean(enableDiarization), minSpeakers, maxSpeakers },
    });

    console.log(`[STT] ✓ Gemini transcription complete (${text.trim().length} chars)`);

    // No turns from Gemini: its "Speaker N:" labels come from the prompt, not acoustics, and flip
    // for a single voice. Strip them from the text too and flag `degraded` so the UI can say so.
    res.json({
      text: enableDiarization ? stripSpeakerLabels(text) : text.trim(),
      source: src,
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
      defaultMinSpeakers: 1, // a floor of 2 made the recognizer split one voice in two
      defaultMaxSpeakers: DEFAULT_MAX_SPEAKERS,
      // chirp_2 is V2 (no diarization) only; diarized requests run V1 on its default model.
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
    const v = parseOr400(ExecuteRequestSchema, req.body, res);
    if (!v) return;
    const { kind, item, accessToken, action, id } = v.data;
    const isSandbox = !accessToken || accessToken === "sandbox";

    const mode = isSandbox ? "sandbox" : "google_api";
    const tool = (parts: any[], stateDelta: Record<string, unknown>) => emit("workspace_tools", "tool", parts, stateDelta);
    const callId = `call-${Date.now()}`;

    tool(
      [{ functionCall: { name: action === "delete" ? `delete_${kind}` : kind, args: action === "delete" ? { id, kind } : item || {}, id: callId } }],
      { eventType: "tool_call", toolName: kind, action: action || "execute", args: item, mode },
    );

    // Undo: delete exactly the resource a previous create returned the id for.
    if (action === "delete") {
      if (!isSandbox) {
        const del = { create_calendar_event: gcalDeleteEvent, create_task: gtasksDeleteTask }[kind as string];
        if (!del) {
          res.status(400).json({ error: `Unknown kind "${kind}" (expected "create_calendar_event" or "create_task").` });
          return;
        }
        if (!id) {
          res.status(400).json({ error: "delete requires the created resource id." });
          return;
        }
        await del(accessToken, id);
      }

      tool(
        [{ functionResponse: { name: `delete_${kind}`, response: { ok: true, id, status: "deleted", mode }, id: callId } }],
        { eventType: "tool_result", toolName: `delete_${kind}`, status: "success" },
      );

      res.json({ ok: true });
      return;
    }

    if (!item) {
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

    tool(
      [{ functionResponse: { name: kind, response: { id: resultId, ...parsed.data, status: "created", mode }, id: callId } }],
      { eventType: "tool_result", toolName: kind, status: "success", resultId, item: parsed.data, mode },
    );

    res.json({ id: resultId });
  } catch (error: any) {
    console.error("Execute API failed:", error);
    const message = error.message || String(error);
    emit("workspace_tools", "tool", [{ text: `Tool execution failed: ${message}` }], { eventType: "tool_result", status: "error", error: message });
    res.status(500).json({ error: error.message || "Failed to execute action." });
  }
});

// Startup: key check, then Vite middleware (dev) or static bundle (prod), then listen.
async function main() {
  // agents.ts forces Vertex mode at import; fail fast if it has nowhere to point.
  if (!process.env.GOOGLE_CLOUD_PROJECT || !process.env.GOOGLE_CLOUD_LOCATION) {
    throw new Error("GOOGLE_CLOUD_PROJECT/GOOGLE_CLOUD_LOCATION is missing in .env.");
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
    app.get("*", (_req, res) => res.sendFile(path.join(distPath, "index.html")));
  }

  // Automatically sync local disk sessions to Vertex AI Memory Bank on startup
  syncLocalMemoriesToMemoryBank().then(({ syncedCount }) => {
    if (syncedCount > 0) {
      console.log(`[memory] Synced ${syncedCount} session(s) from disk into Vertex AI Memory Bank.`);
    }
  }).catch(e => console.warn("[memory] Startup memory sync failed:", e?.message || e));

  const server = app.listen(PORT, "127.0.0.1", () => {
    const engine = process.env.VERTEX_AI_AGENT_ENGINE_ID || process.env.AGENT_ENGINE_ID;
    console.log(`Server running on http://127.0.0.1:${PORT} (Vertex AI: ${process.env.GOOGLE_CLOUD_PROJECT}/${process.env.GOOGLE_CLOUD_LOCATION} | Model: ${MODEL} | Memory Bank: ${engine})`);
    console.log(`Also accessible at http://localhost:${PORT}`);
  });

  registerSttStream(server);
}

// Live diarized transcription over one long-lived Cloud STT recognition (stt-stream.ts). WebSocket,
// not SSE, because audio flows client→server. Text frames: JSON control (SttStreamControlSchema).
// Binary frames: audio for the open recognition; dropped (never buffered) when none is open.
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
          console.log(`[stt-stream] open (${cfg.source || "mic"}, max ${cfg.maxSpeakers ?? DEFAULT_MAX_SPEAKERS} speakers)`);
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
        emit("google_cloud_stt", "stt-stream", [{ text: `streaming recognition closed after ${segments} segment(s)` }], {
          eventType: "stt:stream_close",
          provider: "google_cloud_stt",
          transport: "streaming",
          segments,
          diarizationEnabled: true,
          source: cfg.source ?? "mic",
        });
      }
    });
    ws.on("error", () => closeStream());
  });
}

main();
