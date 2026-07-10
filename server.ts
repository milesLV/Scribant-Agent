import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import { LlmAgent, Runner, InMemorySessionService, GOOGLE_SEARCH, setLogLevel, LogLevel } from "@google/adk";
import { z } from "zod";
import dotenv from "dotenv";
import { proofreadAndCorrect } from "./transcriber";
import { SKILLS, skillSchemaProperties } from "./skills";
import { cleanJsonString, splitTiers, filterValidCalendarEvents, resolveDate } from "./server-utils";
import { buildWorkspaceTools, gcalCreateEvent, gtasksCreateTask } from "./workspace-tools";

dotenv.config();

const app = express();
app.use(express.json());

const PORT = 3000;

// One model, one key (GEMINI_API_KEY, read by ADK from env). ponytail: single-key by design;
// re-add rotation as a custom BaseLlm if quota hurts.
const MODEL = "gemini-2.5-flash";
setLogLevel(LogLevel.WARN); // silence ADK's per-event INFO logging

// Stateless agent call: ephemeral session per request, drain events, keep the last text and any
// grounding metadata. ADK reports model failures as error EVENTS (errorCode/errorMessage), not
// throws — they must be surfaced here or a 429 looks like an empty answer. Transient errors
// retry up to 3× with backoff.
const sessionService = new InMemorySessionService();
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function askAgent(agent: LlmAgent, text: string): Promise<{ text: string; grounding?: any }> {
  const runner = new Runner({ appName: "scribant", agent, sessionService });
  for (let attempt = 1; ; attempt++) {
    let out = "";
    let grounding: any;
    let errEvent: any = null;
    for await (const ev of runner.runEphemeral({
      userId: "local",
      newMessage: { role: "user", parts: [{ text }] },
    })) {
      if (ev.errorCode) errEvent = ev;
      const t = ev.content?.parts?.map((p: any) => p.text).filter(Boolean).join("") ?? "";
      if (t) out = t;
      if (ev.groundingMetadata) grounding = ev.groundingMetadata;
    }
    if (!errEvent) return { text: out, grounding };
    const msg = String(errEvent.errorMessage || "");
    const isTransient = ["429", "503"].includes(String(errEvent.errorCode))
      || ["RESOURCE_EXHAUSTED", "overloaded", "high demand"].some(s => msg.includes(s));
    if (!isTransient || attempt >= 3) {
      throw new Error(`Model error ${errEvent.errorCode}: ${msg.slice(0, 200)}`);
    }
    // Gemini 429s carry a retryDelay ("retryDelay":"22s"); honor it, else back off 15s/attempt.
    const delayS = Number(msg.match(/retryDelay[^0-9]*(\d+)/)?.[1]) || 15 * attempt;
    console.warn(`[askAgent] 429 on ${agent.name}, retrying in ${delayS}s (attempt ${attempt}/3)`);
    await sleep(delayS * 1000);
  }
}

// Prompt criteria + schema are generated once from the skill registry (skills.ts). Order is fixed:
// ideasSummary (1), each skill (2..), organizedFolderName (last) — the calendar criteria's
// "(see #3)" reference relies on tasks landing at index 3.
const analyzeCriteriaText = [
  { key: "ideasSummary", body: `(string) A formatted markdown bullet list summarizing the most important, overall points from the provided "AI Live Notes Summary". If the AI Live Notes Summary is empty or not provided, summarize the overall points from the raw transcript. Separate items with single newlines.` },
  ...SKILLS.map(s => ({ key: s.name, body: s.description })),
  { key: "organizedFolderName", body: `(string) A clean, professional, descriptive 2-4 word folder name to organize these files under in Google Drive (e.g. "Project Beta Alignment", "Home Gardening Brainstorm").` },
].map((e, i) => `${i + 1}. "${e.key}": ${e.body}`).join("\n");

const analyzeOutputSchema = z.object({
  ideasSummary: z.string().describe("A beautifully organized list of summarized ideas and insights, in markdown bullet points."),
  ...skillSchemaProperties(),
  organizedFolderName: z.string().describe("Descriptive name for a drive folder."),
});

// Intent classifier — turn the transcript into calendar/task/search items
app.post("/api/analyze", async (req, res) => {
  try {
    const { text, currentLocalTime, liveSummary } = req.body;
    if (!text || typeof text !== "string") {
      res.status(400).json({ error: "Text prompt is required and must be a string." });
      return;
    }

    // Transcript + time arrive in the user message; the instruction carries only the criteria
    // and the live-summary context (referenced by the ideasSummary criteria).
    const instruction = `You are a high-fidelity intent parsing engine for an app that transcribes a person's unfiltered spoken thoughts and turns them into structured actions.
The user is speaking or writing their thoughts in an unfiltered "brain dump" format.
Analyze the provided stream of thoughts and categorize segments into different structured action buckets.

AI Live Notes Summary: "${liveSummary || ""}"

You MUST output strictly a JSON object with the following keys and criteria:

${analyzeCriteriaText}

CRITICAL: If there are no items matching a category's strict criteria, you MUST return an empty array [] for that field. Do not generate empty or placeholder objects. Return ONLY the valid JSON object.`;

    // Per-request agent: the instruction embeds the request's live summary.
    const agent = new LlmAgent({
      name: "intent_classifier",
      model: MODEL,
      instruction,
      outputSchema: analyzeOutputSchema,
      disallowTransferToParent: true,
      disallowTransferToPeers: true,
    });

    const response = await askAgent(
      agent,
      `Current Time context: ${currentLocalTime || new Date().toISOString()}\n\nStream of thoughts:\n"${text}"`
    );

    const cleanedText = cleanJsonString(response.text || "{}");
    const parsed = JSON.parse(cleanedText);

    console.log(`[analyze] text=${text.length}ch → events=${parsed.calendarEvents?.length ?? 0} tasks=${parsed.tasks?.length ?? 0} queries=${parsed.searchQueries?.length ?? 0}`);
    // Deterministic date resolution: re-resolve start/dueDate from the verbatim sourceText with chrono,
    // overriding the model's calendar arithmetic (its weak spot) but keeping its value when the phrase
    // carries no date. Time-of-day comes from chrono only when the phrase stated one, else the model's.
    const refISO = currentLocalTime || new Date().toISOString();
    const pad = (n: number) => String(n).padStart(2, "0");
    for (const evt of parsed.calendarEvents || []) {
      const r = resolveDate(evt.sourceText || "", refISO);
      if (!r) continue;
      const timeOfDay = evt.allDay ? "00:00:00"
        : r.hour != null ? `${pad(r.hour)}:${pad(r.minute ?? 0)}:00`
        : (String(evt.start || "").match(/T(\d{2}:\d{2}:\d{2})/)?.[1] ?? "09:00:00");
      evt.start = `${r.date}T${timeOfDay}`;
      if (evt.allDay) {
        evt.end = `${r.date}T00:00:00`;
      } else {
        const e = new Date(evt.start); e.setMinutes(e.getMinutes() + 30); // ponytail: +30min default; end duration isn't tracked
        evt.end = `${e.getFullYear()}-${pad(e.getMonth() + 1)}-${pad(e.getDate())}T${pad(e.getHours())}:${pad(e.getMinutes())}:00`;
      }
    }
    for (const task of parsed.tasks || []) {
      if (!task.dueDate) continue; // model saw no deadline -> don't invent one from a stray date token
      const r = resolveDate(task.sourceText || "", refISO);
      if (r) task.dueDate = r.date;
    }

    // Drop calendar events with a missing/placeholder start time (the client only filters on title).
    if (parsed.calendarEvents) parsed.calendarEvents = filterValidCalendarEvents(parsed.calendarEvents);

    res.json(parsed);
  } catch (error: any) {
    console.error("Analysis API failed:", error);
    res.status(500).json({ error: error.message || "Internal server error" });
  }
});

// Live summarizer — rolling bullet summary while the user is still speaking
const liveSummarizer = new LlmAgent({
  name: "live_summarizer",
  model: MODEL,
  instruction: `You are a real-time summarizing assistant for an app that captures a person's unfiltered spoken thoughts.
The user is speaking or typing their thoughts live.
Analyze the provided chunk of raw text and extract an elegant, high-level summary using beautiful Markdown bullet points.
Be extremely concise. Skip any introductory remarks, system summaries, or conversational filler. Output only clean, helpful bullet points. Highlight key terms or entities in bold format (e.g., **Key Term**).`,
});

app.post("/api/summarize-live", async (req, res) => {
  try {
    const { text } = req.body;
    if (!text || typeof text !== "string") {
      res.status(400).json({ error: "Text is required and must be a string." });
      return;
    }

    const response = await askAgent(liveSummarizer, `Raw draft thoughts:\n"${text}"`);
    res.json({ summary: response.text.trim() });
  } catch (error: any) {
    console.error("Live summarize API failed:", error);
    res.status(500).json({ error: error.message || "Failed to generate quick summary." });
  }
});

// Proofreader — obvious typos → auto-corrections, ambiguous mishearings → low-confidence flags.
// transcriber.ts owns the prompt and parsing; it gets the model via an injected per-call agent.
app.post("/api/transcribe-correct", async (req, res) => {
  try {
    const { text } = req.body;
    if (!text || typeof text !== "string") {
      res.status(400).json({ error: "Text is required and must be a string." });
      return;
    }
    const result = await proofreadAndCorrect(text, async (p) => {
      const agent = new LlmAgent({
        name: "proofreader",
        model: p.model || MODEL,
        instruction: p.config?.systemInstruction ?? "",
        generateContentConfig: p.config?.responseMimeType
          ? { responseMimeType: p.config.responseMimeType }
          : undefined,
      });
      return { text: (await askAgent(agent, p.contents)).text };
    });
    res.json(result);
  } catch (error: any) {
    console.error("Transcribe-correct failed:", error);
    res.status(500).json({ error: error.message || "Failed to proofread transcript." });
  }
});

// Grounded search. Grounding can't be combined with a JSON outputSchema, so the answer stays
// marker-formatted text (CONDENSED:/DETAILED:) parsed by splitTiers.
const groundedSearcher = new LlmAgent({
  name: "grounded_searcher",
  model: MODEL,
  instruction: "You are a research assistant. Use Google Search to ground your answer, then respond in exactly the format the user requests.",
  tools: [GOOGLE_SEARCH],
});

// Shared by the /api/search route and the orchestrator's web_search tool.
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
    const { kind, item, accessToken } = req.body;
    if (!accessToken || typeof accessToken !== "string") {
      res.status(400).json({ error: "accessToken is required (sandbox mode executes client-side)." });
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

// Orchestrator: brain-dump in → tool calls out. Without an accessToken the write tools DRY-RUN
// (mock ids) — passing a real token is the caller's explicit consent to execute, so the browser's
// review-then-act UI never routes through here.
app.post("/api/agent", async (req, res) => {
  try {
    const { text, currentLocalTime, accessToken } = req.body;
    if (!text || typeof text !== "string") {
      res.status(400).json({ error: "Text is required and must be a string." });
      return;
    }

    const criteria = SKILLS.map(s => `- ${s.name}: ${s.description}`).join("\n");
    const agent = new LlmAgent({
      name: "orchestrator",
      model: MODEL,
      instruction: `You are an action-taking assistant for an app that captures a person's unfiltered spoken thoughts.
Read the brain-dump transcript and act on it with your tools:
- create_calendar_event for things that happen at a time / occupy days
- create_task for actions to complete (use dueDate for deadlines)
- web_search for well-defined searchable questions the user raised
Use the same judgement criteria as the app's intent classifier:
${criteria}
Current Local Time for resolving relative dates: ${currentLocalTime || new Date().toISOString()}.
IMPORTANT: only call a write tool for CLEAR, non-uncertain items. If a thought is vague ("we should grab lunch sometime"), do NOT act on it — mention it under "Skipped (too vague)" instead.
After acting, reply with a short markdown summary of what you did and what you skipped.`,
      tools: buildWorkspaceTools({ token: accessToken || null, search: groundedSearch }),
    });

    // Drains events directly (not askAgent): the caller needs the tool-call log, and there must be
    // NO retry here — re-running the agent re-executes write tools (duplicate events/tasks).
    const runner = new Runner({ appName: "scribant", agent, sessionService });
    const actions: { tool: string; args: any; result?: any }[] = [];
    let summary = "";
    for await (const ev of runner.runEphemeral({
      userId: "local",
      newMessage: { role: "user", parts: [{ text: `Brain-dump transcript:\n"${text}"` }] },
    })) {
      if (ev.errorCode) throw new Error(`Model error ${ev.errorCode}: ${String(ev.errorMessage || "").slice(0, 200)}`);
      for (const p of ev.content?.parts ?? []) {
        if (p.functionCall) actions.push({ tool: p.functionCall.name || "?", args: p.functionCall.args });
        if (p.functionResponse) {
          const open = actions.find(a => a.tool === p.functionResponse!.name && a.result === undefined);
          if (open) open.result = p.functionResponse.response;
        }
        if (p.text) summary = p.text;
      }
    }

    console.log(`[agent] text=${text.length}ch → ${actions.length} action(s)${accessToken ? "" : " (dry-run)"}`);
    res.json({ summary, actions, simulated: !accessToken });
  } catch (error: any) {
    console.error("Agent API failed:", error);
    res.status(500).json({ error: error.message || "Agent run failed." });
  }
});

// Startup: key check, then Vite middleware (dev) or static bundle (prod), then listen.
async function main() {
  // ADK reads the key from env at call time — fail fast at startup if none is set.
  if (!process.env.GEMINI_API_KEY && !process.env.GOOGLE_API_KEY) {
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
    console.log(`Server running on http://127.0.0.1:${PORT}`);
    console.log(`Also accessible at http://localhost:${PORT}`);
  });
}

main();
