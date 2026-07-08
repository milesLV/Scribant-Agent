import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI, Type } from "@google/genai";
import dotenv from "dotenv";
import { proofreadAndCorrect } from "./transcriber";
import { SKILLS, skillSchemaProperties } from "./skills";
import { cleanJsonString, splitTiers, filterValidCalendarEvents, nextIndex, runWithFallback, resolveDate } from "./server-utils";

dotenv.config();

const app = express();
app.use(express.json());

const PORT = 3000;

// ---------------------------------------------------------------------------
// Multi-API-key pool: validate all GEMINI_API_KEY* keys on startup, then
// rotate through working ones on 429 errors.
// ---------------------------------------------------------------------------
const GEMINI_KEY_ENV_NAMES = [
  "GEMINI_API_KEY",
  "GEMINI_API_KEY1",
  "GEMINI_API_KEY2",
  "GEMINI_API_KEY3",
];

const geminiClients: GoogleGenAI[] = [];
let geminiClientIndex = 0;
let keysValidated = false;

/** Probe a single key with a tiny generateContent call. Returns true if live. */
async function probeGeminiKey(client: GoogleGenAI, envName: string): Promise<boolean> {
  try {
    // Probe the model we actually serve from (MODEL_FALLBACKS[0]), not a retired/limit:0 one — probing
    // a free-tier limit:0 model (e.g. gemini-2.0-flash) makes every key look "quota exhausted".
    await client.models.generateContent({
      model: MODEL_FALLBACKS[0],
      contents: "ping",
      config: { maxOutputTokens: 1 },
    });
    console.log(`✅  ${envName} — key is live`);
    return true;
  } catch (err: any) {
    const status = err?.status ?? err?.httpStatusCode ?? err?.code;
    const msg = err?.message ?? "";
    // 429 means the key is real but quota is exhausted — still keep it in pool
    // so it can be retried after rotation. Other errors (401, 403) = bad key.
    if (status === 429 || msg.includes("RESOURCE_EXHAUSTED") || msg.includes("429")) {
      console.warn(`⚠️  ${envName} — key valid but quota exhausted (will still use in rotation)`);
      return true;
    }
    console.error(`❌  ${envName} — key rejected (status ${status}): ${msg.slice(0, 80)}`);
    return false;
  }
}

/** Run at server startup: build the validated client pool in parallel. */
async function validateAndInitGeminiClients() {
  if (keysValidated) return;
  keysValidated = true;

  const candidates: { envName: string; client: GoogleGenAI }[] = [];
  for (const envName of GEMINI_KEY_ENV_NAMES) {
    const key = process.env[envName];
    if (key && key.trim()) {
      candidates.push({
        envName,
        client: new GoogleGenAI({
          apiKey: key.trim(),
          httpOptions: { headers: { "User-Agent": "aistudio-build" } },
        }),
      });
    }
  }

  if (candidates.length === 0) {
    throw new Error("No GEMINI_API_KEY* values found in .env. Please add at least one.");
  }

  console.log(`\n🔑  Validating ${candidates.length} Gemini API key(s)...`);
  const results = await Promise.all(
    candidates.map(({ envName, client }) => probeGeminiKey(client, envName))
  );

  for (let i = 0; i < candidates.length; i++) {
    if (results[i]) geminiClients.push(candidates[i].client);
  }

  if (geminiClients.length === 0) {
    throw new Error("All Gemini API keys failed validation. Check your .env keys.");
  }

  console.log(`Key pool ready: ${geminiClients.length}/${candidates.length} key(s) available. Starting with key index 0.\n`);
}

function getGeminiClient(): GoogleGenAI {
  if (geminiClients.length === 0) {
    throw new Error("Gemini clients not yet initialized. Server startup may still be in progress.");
  }
  return geminiClients[geminiClientIndex % geminiClients.length];
}

/** Rotate to the next API key (called on 429). */
function rotateGeminiKey() {
  if (geminiClients.length > 1) {
    geminiClientIndex = nextIndex(geminiClientIndex, geminiClients.length);
    console.log(`🔄  Rotated to Gemini key index ${geminiClientIndex}`);
  }
}

// Gemini models tried in order, then a LOCAL Ollama model as the last-resort fallback — the safety
// net when every Gemini key is quota-exhausted. It's last, so if Ollama isn't running the ECONNREFUSED
// just ends the chain (throwing the prior Gemini error). Defaults to gemma4; override with OLLAMA_MODEL.
const MODEL_FALLBACKS = [
  "gemini-2.5-flash",
  "gemini-2.5-pro",
  `ollama:${process.env.OLLAMA_MODEL || "gemma4"}`,
];

/**
 * Calls local Ollama API
 */
async function callOllama(
  model: string,
  params: { contents: string; config?: any }
): Promise<any> {
  const isJson = params.config?.responseMimeType === "application/json";
  let prompt = params.contents;
  if (params.config?.systemInstruction) {
    prompt = params.config.systemInstruction + "\n\n" + prompt;
  }
  
  const body: any = {
    model: model,
    prompt: prompt,
    stream: false,
  };
  
  if (isJson) {
    body.format = "json";
  }

  const res = await fetch("http://localhost:11434/api/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  
  if (!res.ok) {
    const errorText = await res.text();
    const err: any = new Error(`Ollama error ${res.status}: ${errorText}`);
    err.status = res.status;
    throw err;
  }
  
  const data = await res.json();
  return {
    text: data.response
  };
}

/**
 * Wraps ai.models.generateContent with automatic model fallback.
 * On a 203 (or any HTTP error status ≥ 200 that isn't 200), it retries
 * with the next model in MODEL_FALLBACKS.
 */
async function generateWithFallback(
  _ai: GoogleGenAI,
  params: { model: string; contents: string; config?: any }
): Promise<any> {
  const models = [params.model, ...MODEL_FALLBACKS.filter(m => m !== params.model)];
  const isOllama = (m: string) => m.startsWith("ollama:");
  // Orchestration (retry/rotate/fallback classification) lives in server-utils.runWithFallback,
  // unit-tested there; this closure just supplies the real Gemini/Ollama callers + key rotation.
  return runWithFallback(models, params, {
    callModel: (model, p) =>
      isOllama(model)
        ? callOllama(model.replace("ollama:", ""), p)
        : getGeminiClient().models.generateContent({ ...p, model }),
    rotate: rotateGeminiKey,
    isOllama,
    onRetry: (model, err) =>
      console.warn(`Model "${model}" returned error ${err?.status ?? err?.message}. Rotating API key and falling back to next model...`),
  });
}

// cleanJsonString / splitTiers / filterValidCalendarEvents / nextIndex now live in ./server-utils
// (pure + unit-tested there). Everything below is the HTTP + LLM-gateway layer.

// 1. Intent Classifier endpoint — turn the transcript into calendar/task/search items
app.post("/api/analyze", async (req, res) => {
  try {
    const { text, currentLocalTime, liveSummary } = req.body;
    if (!text || typeof text !== "string") {
      res.status(400).json({ error: "Text prompt is required and must be a string." });
      return;
    }

    const ai = getGeminiClient();
    // Prompt criteria + schema are generated from the skill registry (skills.ts). Order is fixed:
    // ideasSummary (1), each skill (2..), organizedFolderName (last) — the calendar criteria's
    // "(see #3)" reference relies on tasks landing at index 3.
    const criteriaEntries = [
      { key: "ideasSummary", body: `(string) A formatted markdown bullet list summarizing the most important, overall points from the provided "AI Live Notes Summary". If the AI Live Notes Summary is empty or not provided, summarize the overall points from the raw transcript. Separate items with single newlines.` },
      ...SKILLS.map(s => ({ key: s.name, body: s.description })),
      { key: "organizedFolderName", body: `(string) A clean, professional, descriptive 2-4 word folder name to organize these files under in Google Drive (e.g. "Project Beta Alignment", "Home Gardening Brainstorm").` },
    ];
    const criteriaText = criteriaEntries.map((e, i) => `${i + 1}. "${e.key}": ${e.body}`).join("\n");

    const systemInstruction = `You are a high-fidelity intent parsing engine for an app that transcribes a person's unfiltered spoken thoughts and turns them into structured actions.
The user is speaking or writing their thoughts in an unfiltered "brain dump" format.
Analyze the provided stream of thoughts and categorize segments into different structured action buckets.

Here is the context of what has been spoken/transcribed:
- Full raw transcript: "${text}"
- Current Local Time: ${currentLocalTime || new Date().toISOString()}
- AI Live Notes Summary: "${liveSummary || ""}"

You MUST output strictly a JSON object with the following keys and criteria:

${criteriaText}

CRITICAL: If there are no items matching a category's strict criteria, you MUST return an empty array [] for that field. Do not generate empty or placeholder objects. Return ONLY the valid JSON object.`;

    const responseSchema = {
      type: Type.OBJECT,
      properties: {
        ideasSummary: {
          type: Type.STRING,
          description: "A beautifully organized list of summarized ideas and insights, in markdown bullet points."
        },
        ...skillSchemaProperties(),
        organizedFolderName: {
          type: Type.STRING,
          description: "Descriptive name for a drive folder."
        }
      },
      required: ["ideasSummary", ...SKILLS.map(s => s.name), "organizedFolderName"]
    };

    const response = await generateWithFallback(ai, {
      model: MODEL_FALLBACKS[0],
      contents: `Current Time context: ${currentLocalTime || new Date().toISOString()}\n\nStream of thoughts:\n"${text}"`,
      config: {
        systemInstruction,
        responseMimeType: "application/json",
        responseSchema,
      }
    });

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

// 1.5. Live Summarize Stream endpoint
app.post("/api/summarize-live", async (req, res) => {
  try {
    const { text } = req.body;
    if (!text || typeof text !== "string") {
      res.status(400).json({ error: "Text is required and must be a string." });
      return;
    }

    const ai = getGeminiClient();
    const systemInstruction = `You are a real-time summarizing assistant for an app that captures a person's unfiltered spoken thoughts.
The user is speaking or typing their thoughts live.
Analyze the provided chunk of raw text and extract an elegant, high-level summary using beautiful Markdown bullet points.
Be extremely concise. Skip any introductory remarks, system summaries, or conversational filler. Output only clean, helpful bullet points. Highlight key terms or entities in bold format (e.g., **Key Term**).`;

    const response = await generateWithFallback(ai, {
      model: MODEL_FALLBACKS[0],
      contents: `Raw draft thoughts:\n"${text}"`,
      config: {
        systemInstruction,
      }
    });

    res.json({ summary: response.text?.trim() || "" });
  } catch (error: any) {
    console.error("Live summarize API failed:", error);
    res.status(500).json({ error: error.message || "Failed to generate quick summary." });
  }
});

// Transcriber, mode A: route obvious typos → auto-corrections, ambiguous mishearings → flags.
app.post("/api/transcribe-correct", async (req, res) => {
  try {
    const { text } = req.body;
    if (!text || typeof text !== "string") {
      res.status(400).json({ error: "Text is required and must be a string." });
      return;
    }
    const result = await proofreadAndCorrect(text, (p) => generateWithFallback(getGeminiClient(), p));
    res.json(result);
  } catch (error: any) {
    console.error("Transcribe-correct failed:", error);
    res.status(500).json({ error: error.message || "Failed to proofread transcript." });
  }
});

// 2. Google Search Grounding API
app.post("/api/search", async (req, res) => {
  try {
    const { query } = req.body;
    if (!query || typeof query !== "string") {
      res.status(400).json({ error: "Query is required and must be a string." });
      return;
    }

    const ai = getGeminiClient();
    const response = await generateWithFallback(ai, {
      model: MODEL_FALLBACKS[0],
      contents: `Search the web and answer this research query: "${query}".
Respond in EXACTLY this format, nothing else:
CONDENSED: <a direct 1-2 sentence answer>
DETAILED: <a thorough 4-7 sentence explanation with the key facts and context>`,
      config: {
        tools: [{ googleSearch: {} }],
      },
    });

    // Extract grounding URLs and sources
    const chunks = response.candidates?.[0]?.groundingMetadata?.groundingChunks;
    const sources = chunks
      ? chunks
          .filter((c: any) => c.web?.uri)
          .map((c: any) => ({
            uri: c.web.uri,
            title: c.web.title || c.web.uri,
          }))
      : [];

    const { condensed, inDepth } = splitTiers(response.text || "");
    res.json({
      query,
      condensed,
      inDepth,
      answer: inDepth || "No summary answer generated.", // back-compat: existing client reads `answer`
      sources,
    });
  } catch (error: any) {
    console.error("Search API failed:", error);
    res.status(500).json({ error: error.message || "Failed to execute grounded search." });
  }
});

// Configure Vite or Serve static bundle
async function setupVite() {
  // Validate all API keys first — pool must be ready before serving requests
  await validateAndInitGeminiClients();

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

setupVite();
