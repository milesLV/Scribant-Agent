import express from "express";
import path from "path";
import { promises as fs } from "fs";
import { createServer as createViteServer } from "vite";
import { setLogLevel, LogLevel } from "@google/adk";
import { splitTiers } from "./server-utils";
import { captureMemoryEvent } from "./memory";
import { WORKSPACE_ACTIONS, gcalDeleteEvent, gtasksDeleteTask } from "./workspace-tools";
import { KEYS, askAgent, groundedSearcher } from "./agents";
import { runOrchestrator, type Stage } from "./orchestrator";

const app = express();
app.use(express.json());

// 3000 by default: the OAuth redirect URI registered in Google Cloud is per-port.
const PORT = Number(process.env.PORT) || 3000;

setLogLevel(LogLevel.WARN); // silence ADK's per-event INFO logging

// A disk failure must never 500 a response the user already spent tokens on — every capture site
// swallows its own error and just logs, tagged by caller for the console.
const safeCapture = (tag: string, sessionId: unknown, entry: { text: string; plan?: unknown }) => {
  try { captureMemoryEvent(sessionId, entry); }
  catch (e: any) { console.warn(`[${tag}] memory capture failed:`, e?.message || e); }
};

// Every route below is a caller of ONE orchestrator (orchestrator.ts) with a different stage set,
// so no two of them can drift apart the way four hand-wired agent calls did.

// Saves the user pasting their own client ID: serve the one already in credentials.json. client_id
// only — it is public by design in the implicit flow, and the secret never leaves the server.
app.get("/api/config", async (_req, res) => {
  try {
    const creds = JSON.parse(await fs.readFile(path.join(process.cwd(), "credentials.json"), "utf-8"));
    res.json({ googleClientId: (creds.installed ?? creds.web)?.client_id ?? null });
  } catch {
    res.json({ googleClientId: null });
  }
});

app.post("/api/analyze", async (req, res) => {
  try {
    const { text, currentLocalTime, liveSummary, sessionId } = req.body;
    if (!text || typeof text !== "string") {
      res.status(400).json({ error: "Text prompt is required and must be a string." });
      return;
    }

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

    res.json(parsed);
  } catch (error: any) {
    console.error("Analysis API failed:", error);
    res.status(500).json({ error: error.message || "Internal server error" });
  }
});

app.post("/api/transcribe-correct", async (req, res) => {
  try {
    const { text } = req.body;
    if (!text || typeof text !== "string") {
      res.status(400).json({ error: "Text is required and must be a string." });
      return;
    }
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
  const { text, currentLocalTime, liveSummary, withPlan, sessionId } = req.body;
  if (!text || typeof text !== "string") {
    res.status(400).json({ error: "Text is required and must be a string." });
    return;
  }

  res.setHeader("Content-Type", "application/x-ndjson");
  res.setHeader("Cache-Control", "no-cache");
  res.flushHeaders();
  const send = (obj: unknown) => { if (!res.writableEnded) res.write(JSON.stringify(obj) + "\n"); };

  try {
    // Skip the expensive classifier when the client says this tick added too little to re-plan.
    const stages = new Set<Stage>(withPlan === false ? ["proof", "summary"] : ["proof", "summary", "plan"]);
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
    if (sessionId) safeCapture("live", sessionId, { text, plan: latestPlan });
  } catch (error: any) {
    console.error("Live API failed:", error);
    send({ stage: "fatal", error: error?.message || "Live pipeline failed." });
  } finally {
    res.end();
  }
});

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
    const { query } = req.body;
    if (!query || typeof query !== "string") {
      res.status(400).json({ error: "Query is required and must be a string." });
      return;
    }

    res.json(await groundedSearch(query));
  } catch (error: any) {
    console.error("Search API failed:", error);
    res.status(500).json({ error: error.message || "Failed to execute grounded search." });
  }
});

// Execute ONE reviewed item. The review-then-act gate is the client UI: this is only called after
// a human approves an item, with their OAuth token forwarded per request. Sandbox mode never
// reaches here (the client simulates locally when signed out).
app.post("/api/execute", async (req, res) => {
  try {
    const { kind, item, accessToken, action, id } = req.body;
    if (!accessToken || typeof accessToken !== "string") {
      res.status(400).json({ error: "accessToken is required (sandbox mode executes client-side)." });
      return;
    }
    // Undo: delete exactly the resource a previous create returned the id for. Keyed by the action
    // being undone; Drive saves have no undo.
    if (action === "delete") {
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
    // The action's own schema is the request validation: an item shape the model could not have
    // proposed is one this endpoint will not execute either.
    const parsed = workspaceAction.parameters.safeParse(item);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      res.status(400).json({ error: `${kind} item is invalid: ${issue.path.join(".") || "item"} — ${issue.message}.` });
      return;
    }
    const result = await workspaceAction.run(accessToken, parsed.data);
    res.json({ id: result.eventId ?? result.taskId ?? result.folderId ?? result.fileId });
  } catch (error: any) {
    console.error("Execute API failed:", error);
    res.status(500).json({ error: error.message || "Failed to execute action." });
  }
});

// Startup: key check, then Vite middleware (dev) or static bundle (prod), then listen.
async function main() {
  // ADK reads the key when each agent is built — fail fast at startup if .env has none.
  if (!KEYS.length) {
    throw new Error("No GEMINI_API_KEY (or GOOGLE_API_KEY) found in .env. Please add one.");
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

  app.listen(PORT, "127.0.0.1", () => {
    console.log(`Server running on http://127.0.0.1:${PORT} (${KEYS.length} Gemini key${KEYS.length > 1 ? "s" : ""})`);
    console.log(`Also accessible at http://localhost:${PORT}`);
  });
}

main();
