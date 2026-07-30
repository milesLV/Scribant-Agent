import express from "express";
import path from "path";
import { promises as fs } from "fs";
import { createServer as createViteServer } from "vite";
import { setLogLevel, LogLevel } from "@google/adk";
import "dotenv/config";
import { proofreadAndCorrect } from "./transcriber";
import { cleanJsonString, splitTiers, resolvePlanDates } from "./server-utils";
import { applyCorrections } from "./src/utils/transcript";
import { gcalCreateEvent, gtasksCreateTask, gcalDeleteEvent, gtasksDeleteTask } from "./workspace-tools";
import { KEYS, askAgent, intentClassifier, liveSummarizer, proofreader, groundedSearcher } from "./agents";

const app = express();
app.use(express.json());

// 3000 by default: the OAuth redirect URI registered in Google Cloud is per-port.
const PORT = Number(process.env.PORT) || 3000;

setLogLevel(LogLevel.WARN); // silence ADK's per-event INFO logging

// An agent plus the parsing its answer needs. The one-shot routes below and the /api/live pipeline
// are two callers of the same two functions, so neither can drift from the other.

// Obvious typos → auto-corrections, ambiguous mishearings → low-confidence flags.
const runProofread = (text: string) =>
  proofreadAndCorrect(text, async (p) => ({ text: (await askAgent(proofreader(p), p.contents)).text }));

// Transcript → calendar/task/search items, with chrono overriding the model's date arithmetic.
const runClassifier = async (text: string, liveSummary: string, refISO: string) =>
  resolvePlanDates(
    JSON.parse(cleanJsonString((await askAgent(
      intentClassifier(liveSummary),
      `Current Time context: ${refISO}\n\nStream of thoughts:\n"${text}"`,
    )).text || "{}")),
    refISO,
  );

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
    const { text, currentLocalTime, liveSummary } = req.body;
    if (!text || typeof text !== "string") {
      res.status(400).json({ error: "Text prompt is required and must be a string." });
      return;
    }

    const parsed = await runClassifier(text, liveSummary, currentLocalTime || new Date().toISOString());
    console.log(`[analyze] text=${text.length}ch → events=${parsed.calendarEvents?.length ?? 0} tasks=${parsed.tasks?.length ?? 0} queries=${parsed.searchQueries?.length ?? 0}`);
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
    res.json(await runProofread(text));
  } catch (error: any) {
    console.error("Transcribe-correct failed:", error);
    res.status(500).json({ error: error.message || "Failed to proofread transcript." });
  }
});

// One request per capture tick, never three: separate per-stage requests race each other and
// multiply 429s. Proofread runs FIRST, then summarize + classify in parallel over the corrected
// text. Stages stream back as newline-delimited JSON the moment each finishes, so the fast
// proofread lands without waiting on the slow classifier.
//
// Additive by design: /api/analyze, /api/transcribe-correct and /api/search keep their contracts
// (the evals and the "Analyze Thoughts" finalize button still use them).
app.post("/api/live", async (req, res) => {
  const { text, currentLocalTime, liveSummary, withPlan } = req.body;
  if (!text || typeof text !== "string") {
    res.status(400).json({ error: "Text is required and must be a string." });
    return;
  }

  res.setHeader("Content-Type", "application/x-ndjson");
  res.setHeader("Cache-Control", "no-cache");
  res.flushHeaders();
  const send = (obj: unknown) => { if (!res.writableEnded) res.write(JSON.stringify(obj) + "\n"); };
  // One stage failing must not sink the others — a 429 on the classifier shouldn't lose the proofread.
  const stage = async (name: string, run: () => Promise<object>) => {
    try { send({ stage: name, ...(await run()) }); }
    catch (e: any) { send({ stage: name, error: e?.message || `${name} failed` }); }
  };

  const refISO = currentLocalTime || new Date().toISOString();
  try {
    // Stage 1 gates the other two: they should reason over corrected text, not raw speech. The
    // corrections themselves still go to the client, which owns applying them to what's on screen.
    let corrected = text;
    await stage("proof", async () => {
      const { corrections, words } = await runProofread(text);
      corrected = applyCorrections(text, words, corrections).text;
      // Echoing `corrected` lets the client mark it as already-processed — otherwise applying the
      // correction edits the transcript and re-arms the debounce, costing a whole second cycle.
      return { text, corrected, corrections, words };
    });

    await Promise.all([
      stage("summary", async () => ({
        summary: (await askAgent(liveSummarizer, `Raw draft thoughts:\n"${corrected}"`)).text.trim(),
      })),
      // Skipped when the client says this tick added too little to be worth re-planning.
      withPlan === false ? Promise.resolve() : stage("plan", async () => ({
        text: corrected,
        plan: await runClassifier(corrected, liveSummary, refISO),
      })),
    ]);
    console.log(`[live] text=${text.length}ch plan=${withPlan === false ? "skipped" : "ran"}`);
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
    // Undo: delete exactly the resource a previous create returned the id for.
    if (action === "delete") {
      const del = { calendar: gcalDeleteEvent, task: gtasksDeleteTask }[kind as string];
      if (!del) {
        res.status(400).json({ error: `Unknown kind "${kind}" (expected "calendar" or "task").` });
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
    if (!item || typeof item !== "object" || typeof item.title !== "string" || !item.title) {
      res.status(400).json({ error: "item with a string title is required." });
      return;
    }
    if (kind === "calendar") {
      if (typeof item.start !== "string" || !item.start) {
        res.status(400).json({ error: "calendar item requires a start time." });
        return;
      }
      res.json({ id: await gcalCreateEvent(accessToken, item) });
    } else if (kind === "task") {
      res.json({ id: await gtasksCreateTask(accessToken, item) });
    } else {
      res.status(400).json({ error: `Unknown kind "${kind}" (expected "calendar" or "task").` });
    }
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
