import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI, Type } from "@google/genai";
import dotenv from "dotenv";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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
    await client.models.generateContent({
      model: "gemini-2.0-flash",
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

  console.log(`\n🟢  Key pool ready: ${geminiClients.length}/${candidates.length} key(s) available. Starting with key index 0.\n`);
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
    geminiClientIndex = (geminiClientIndex + 1) % geminiClients.length;
    console.log(`🔄  Rotated to Gemini key index ${geminiClientIndex}`);
  }
}

// Ordered list of model fallbacks. Ollama models are prefixed with "ollama:".
const MODEL_FALLBACKS = [
  "gemini-2.5-flash",
  "gemini-2.5-pro",
  "gemini-2.0-flash",
  "ollama:gemma4",
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
  const modelsToTry = [
    params.model,
    ...MODEL_FALLBACKS.filter(m => m !== params.model)
  ];

  let lastError: any = null;

  for (const model of modelsToTry) {
    try {
      if (model.startsWith("ollama:")) {
        const ollamaModel = model.replace("ollama:", "");
        return await callOllama(ollamaModel, params);
      } else {
        // Always pick from the rotating key pool for Gemini models
        const client = getGeminiClient();
        const response = await client.models.generateContent({
          ...params,
          model,
        });
        return response;
      }
    } catch (err: any) {
      lastError = err;
      const status = err?.status ?? err?.httpStatusCode ?? err?.code;
      const message = err?.message ?? "";

      const isRetryable =
        status === 203 ||
        status === 429 ||
        status === 503 ||
        message.includes("203") ||
        message.includes("429") ||
        message.includes("RESOURCE_EXHAUSTED") ||
        message.includes("Quota exceeded") ||
        message.includes("overloaded") ||
        message.includes("unavailable") ||
        message.includes("rate limit") ||
        message.includes("fetch failed") ||
        message.includes("ECONNREFUSED");

      if (isRetryable) {
        console.warn(
          `Model "${model}" returned error ${status || message}. Rotating API key and falling back to next model...`
        );
        // Rotate API key before trying the next model
        if (!model.startsWith("ollama:")) rotateGeminiKey();
        continue;
      }

      // Non-retryable error — throw immediately
      throw err;
    }
  }

  // All models exhausted
  throw lastError || new Error("All fallback models failed.");
}

function cleanJsonString(rawText: string): string {
  if (!rawText) return "{}";
  let text = rawText.trim();

  // Strip markdown code fences (```json ... ``` or ``` ... ```)
  if (text.startsWith("```")) {
    text = text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  }

  // Extract just the JSON object — from first '{' to last '}'
  const objStart = text.indexOf("{");
  const objEnd = text.lastIndexOf("}");
  if (objStart !== -1 && objEnd !== -1 && objEnd > objStart) {
    text = text.slice(objStart, objEnd + 1);
  }

  // Remove trailing commas before ] or } (common LLM mistake)
  text = text.replace(/,\s*([}\]])/g, "$1");

  return text;
}

// 1. Analyze Stream of Consciousness endpoint
app.post("/api/analyze", async (req, res) => {
  try {
    const { text, currentLocalTime, liveSummary } = req.body;
    if (!text || typeof text !== "string") {
      res.status(400).json({ error: "Text prompt is required and must be a string." });
      return;
    }

    const ai = getGeminiClient();
    const systemInstruction = `You are a high-fidelity intent parsing engine for a "Stream of Consciousness" thought transcription app.
The user is speaking or writing their thoughts in an unfiltered "brain dump" format.
Analyze the provided stream of thoughts and categorize segments into different structured action buckets.

Here is the context of what has been spoken/transcribed:
- Full raw transcript: "${text}"
- Current Local Time: ${currentLocalTime || "June 4, 2026"}
- AI Live Notes Summary: "${liveSummary || ""}"

You MUST output strictly a JSON object with the following keys and criteria:

1. "ideasSummary": (string) A formatted markdown bullet list summarizing the most important, overall points from the provided "AI Live Notes Summary". If the AI Live Notes Summary is empty or not provided, summarize the overall points from the raw transcript. Separate items with single newlines.
2. "calendarEvents": (array of objects) ONLY include events that have some sort of date/time context and action associated with them (e.g. YES to "Tomorrow I want to make burritos" or "Next Monday I want to call my grandmother"). DO NOT include general self-improvement intentions or vague statements (e.g. NO to "I want to do better at coding tomorrow" or "I need to go to the gym next week"). If there is uncertainty about whether the commitment is set or if the date/time is vague (e.g. "I need to go to the gym next week" or "Tomorrow I will work on that thing"), include the event but set "uncertain": true. Otherwise set "uncertain": false. Each object must have:
   - "title": (string) Event summary/title
   - "description": (string) Event description/context
   - "start": (string) Start time as ISO-8601 string (use the current local time to translate relative terms like "tomorrow", "next week", etc.)
   - "end": (string) End time as ISO-8601 string
   - "uncertain": (boolean) Set to true if the commitment, date, or time details are vague or uncertain, else false.
3. "tasks": (array of objects) ONLY include semi-well-defined tasks or actions (e.g. YES to "I need to prepare for my interview with Google" or "When I get home I want to create a budget to follow"). DO NOT include general mood statements (e.g. NO to "I want my life together" or "I should probably work on my project"). If the task details are vague or uncertain, include the task but set "uncertain": true. Otherwise set "uncertain": false. Each object must have:
   - "title": (string) Compact title of the task
   - "notes": (string) Any descriptions, sub-items, or context
   - "uncertain": (boolean) Set to true if the task itself or its details are vague or uncertain, else false.
4. "searchQueries": (array of objects) ONLY include searchable, well-defined questions or queries (e.g. YES to "I wonder what the most efficient gas mileage for my Toyota Sienna is" or "Where is the best place to eat?"). DO NOT include personal, unsearchable thoughts (e.g. NO to "I wonder what I will eat when I get home" or "What do I have in my fridge?"). Each object must have:
   - "query": (string) The search query text
5. "organizedFolderName": (string) A clean, professional, descriptive 2-4 word folder name to organize these files under in Google Drive (e.g. "Project Beta Alignment", "Home Gardening Brainstorm").

CRITICAL: If there are no items matching a category's strict criteria, you MUST return an empty array [] for that field. Do not generate empty or placeholder objects. Return ONLY the valid JSON object.`;

    const response = await generateWithFallback(ai, {
      model: MODEL_FALLBACKS[0],
      contents: `Current Time context: ${currentLocalTime || "2026-06-04"}\n\nStream of thoughts:\n"${text}"`,
      config: {
        systemInstruction,
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            ideasSummary: {
              type: Type.STRING,
              description: "A beautifully organized list of summarized ideas and insights, in markdown bullet points."
            },
            calendarEvents: {
              type: Type.ARRAY,
              description: "List of calendar events that should be scheduled.",
              items: {
                type: Type.OBJECT,
                properties: {
                  title: { type: Type.STRING, description: "Event summary/title" },
                  description: { type: Type.STRING, description: "Event description/context" },
                  start: { type: Type.STRING, description: "Start time as ISO-8601 string" },
                  end: { type: Type.STRING, description: "End time as ISO-8601 string" },
                  uncertain: { type: Type.BOOLEAN, description: "Whether there is uncertainty about the event commitment or details" }
                },
                required: ["title", "description", "start", "end", "uncertain"]
              }
            },
            tasks: {
              type: Type.ARRAY,
              description: "Actionable todo checklist items found in the text.",
              items: {
                type: Type.OBJECT,
                properties: {
                  title: { type: Type.STRING, description: "Compact title of the task" },
                  notes: { type: Type.STRING, description: "Any descriptions, sub-items, or context" },
                  uncertain: { type: Type.BOOLEAN, description: "Whether the task itself or its details are vague or uncertain" }
                },
                required: ["title", "notes", "uncertain"]
              }
            },
            searchQueries: {
              type: Type.ARRAY,
              description: "Questions or topics they explicitly mentioned searching or finding info on.",
              items: {
                type: Type.OBJECT,
                properties: {
                  query: { type: Type.STRING }
                },
                required: ["query"]
              }
            },
            organizedFolderName: {
              type: Type.STRING,
              description: "Descriptive name for a drive folder."
            }
          },
          required: ["ideasSummary", "calendarEvents", "tasks", "searchQueries", "organizedFolderName"]
        }
      }
    });

    const cleanedText = cleanJsonString(response.text || "{}");
    const parsed = JSON.parse(cleanedText);

    console.log(`[analyze] text=${text.length}ch → events=${parsed.calendarEvents?.length ?? 0} tasks=${parsed.tasks?.length ?? 0} queries=${parsed.searchQueries?.length ?? 0}`);
    // Drop calendar events with a missing/placeholder start time (the client only filters on title).
    if (parsed.calendarEvents) {
      parsed.calendarEvents = parsed.calendarEvents.filter((evt: any) =>
        evt?.start && evt.start.trim() !== "" && !evt.start.includes("undefined")
      );
    }

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
    const systemInstruction = `You are a real-time summarizing assistant for a "Stream of Consciousness" thought parsing app.
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
      contents: `Search the web and provide a comprehensive, objective answer to this research query from the stream of consciousness: "${query}"`,
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

    res.json({
      query,
      answer: response.text || "No summary answer generated.",
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
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "127.0.0.1", () => {
    console.log(`Server running on http://127.0.0.1:${PORT}`);
    console.log(`Also accessible at http://localhost:${PORT}`);
  });
}

setupVite();
