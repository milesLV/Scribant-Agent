// The four agents behind the API — one factory each, plus the runner that calls them.
//
// Factories, not singletons: Gemini captures the API key when the INSTANCE is constructed, so
// rotating onto a fresh key means building a fresh agent. Any agent cached across requests would
// pin the first key forever and silently defeat the rotation in askAgent.
import "dotenv/config";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { LlmAgent, Gemini, Runner, InMemorySessionService, GOOGLE_SEARCH } from "@google/adk";
import { z } from "zod";
import { SKILLS, skillSchemaProperties } from "./skills";

const MODEL = "gemini-2.5-flash";

// Every Gemini key in .env, primary first. Free-tier keys exhaust after a run or two, so askAgent
// rotates through them on 429 before it resorts to waiting.
export const KEYS: string[] = [
  process.env.GEMINI_API_KEY,
  process.env.GEMINI_API_KEY1,
  process.env.GEMINI_API_KEY2,
  process.env.GEMINI_API_KEY3,
  process.env.GOOGLE_API_KEY,
].filter((k): k is string => !!k?.trim());

type AgentFactory = (apiKey: string) => LlmAgent;

// ---- the agents ------------------------------------------------------------

// Rolling bullet summary while the user is still speaking.
export const liveSummarizer: AgentFactory = (apiKey) => new LlmAgent({
  name: "live_summarizer",
  model: new Gemini({ model: MODEL, apiKey }),
  instruction: `You are a real-time summarizing assistant for an app that captures a person's unfiltered spoken thoughts.
The user is speaking or typing their thoughts live.
Analyze the provided chunk of raw text and extract an elegant, high-level summary using beautiful Markdown bullet points.
Be extremely concise. Skip any introductory remarks, system summaries, or conversational filler. Output only clean, helpful bullet points. Highlight key terms or entities in bold format (e.g., **Key Term**).`,
});

// Grounded search. Grounding can't be combined with a JSON outputSchema, so the answer stays
// marker-formatted text (CONDENSED:/DETAILED:) parsed by splitTiers.
export const groundedSearcher: AgentFactory = (apiKey) => new LlmAgent({
  name: "grounded_searcher",
  model: new Gemini({ model: MODEL, apiKey }),
  instruction: "You are a research assistant. Use Google Search to ground your answer, then respond in exactly the format the user requests.",
  tools: [GOOGLE_SEARCH],
});

// Obvious typos → auto-corrections, ambiguous mishearings → low-confidence flags. transcriber.ts
// owns the prompt and parsing and hands us the model params per call.
export const proofreader = (p: { model?: string; config?: any }): AgentFactory => (apiKey) => new LlmAgent({
  name: "proofreader",
  model: new Gemini({ model: p.model || MODEL, apiKey }),
  instruction: p.config?.systemInstruction ?? "",
  generateContentConfig: p.config?.responseMimeType
    ? { responseMimeType: p.config.responseMimeType }
    : undefined,
});

// Prompt criteria + schema are generated once from the skill registry (skills.ts). Order is fixed:
// ideasSummary (1), each skill (2..), organizedFolderName (last) — the calendar criteria's
// "(see #3)" reference relies on tasks landing at index 3.
const analyzeCriteriaText = [
  { key: "ideasSummary", body: `(string) A formatted markdown bullet list summarizing the most important, overall points from the provided "AI Live Notes Summary". If the AI Live Notes Summary is empty or not provided, summarize the overall points from the raw transcript. Separate items with single newlines.` },
  ...SKILLS.map(s => ({ key: s.name, body: s.description })),
  { key: "organizedFolderName", body: `(string) A clean, professional, descriptive 2-4 word name for this session as a whole, used to label it in the archive (e.g. "Project Beta Alignment", "Home Gardening Brainstorm").` },
].map((e, i) => `${i + 1}. "${e.key}": ${e.body}`).join("\n");

const analyzeOutputSchema = z.object({
  ideasSummary: z.string().describe("A beautifully organized list of summarized ideas and insights, in markdown bullet points."),
  ...skillSchemaProperties(),
  organizedFolderName: z.string().describe("Descriptive 2-4 word label for this session."),
});

// Turn the transcript into calendar/task/search items. Curried on liveSummary because the
// instruction embeds the request's live summary.
export const intentClassifier = (liveSummary: string): AgentFactory => (apiKey) => new LlmAgent({
  name: "intent_classifier",
  model: new Gemini({ model: MODEL, apiKey }),
  // Transcript + time arrive in the user message; the instruction carries only the criteria
  // and the live-summary context (referenced by the ideasSummary criteria).
  instruction: `You are a high-fidelity intent parsing engine for an app that transcribes a person's unfiltered spoken thoughts and turns them into structured actions.
The user is speaking or writing their thoughts in an unfiltered "brain dump" format.
Analyze the provided stream of thoughts and categorize segments into different structured action buckets.

AI Live Notes Summary: "${liveSummary || ""}"

You MUST output strictly a JSON object with the following keys and criteria:

${analyzeCriteriaText}

CRITICAL: If there are no items matching a category's strict criteria, you MUST return an empty array [] for that field. Do not generate empty or placeholder objects. Return ONLY the valid JSON object.`,
  outputSchema: analyzeOutputSchema,
  disallowTransferToParent: true,
  disallowTransferToPeers: true,
});

// ---- the runner ------------------------------------------------------------

// Retry policy for a transient model failure. A quota error is KEY-specific, so swap to every other
// key first — a fresh key beats a 15s sleep. Once they're all limited, back off. An overload (503)
// is not key-specific: no key helps, so it goes straight to backoff rather than hammering a struggling
// backend with instant retries. Returns null when there's no road left and the caller should throw.
// Pure so the branching is checkable without burning a request.
function nextAttempt(
  attempt: number,
  keyCount: number,
  statedDelayS: number | null,
  isQuota: boolean,
): { sleepS: number } | null {
  const freeSwaps = isQuota ? keyCount - 1 : 0; // one instant swap per OTHER key
  if (attempt >= freeSwaps + 3) return null;    // then two backoff retries, then give up
  if (attempt <= freeSwaps) return { sleepS: 0 };
  return { sleepS: statedDelayS ?? 15 * (attempt - freeSwaps) };
}

const sessionService = new InMemorySessionService();
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
let keyIdx = 0; // sticky: after a rotation, later requests start on the key that last worked

// Stateless agent call: ephemeral session per request, drain events, keep the last text and any
// grounding metadata. ADK reports model failures as error EVENTS (errorCode/errorMessage), not
// throws — they must be surfaced here or a 429 looks like an empty answer.
export async function askAgent(make: AgentFactory, text: string): Promise<{ text: string; grounding?: any }> {
  for (let attempt = 1; ; attempt++) {
    const agent = make(KEYS[keyIdx]);
    const runner = new Runner({ appName: "scribant", agent, sessionService });
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
    // Quota is per-key (another key may still have headroom); overload is the model's own problem.
    const isQuota = String(errEvent.errorCode) === "429" || msg.includes("RESOURCE_EXHAUSTED");
    const isOverload = String(errEvent.errorCode) === "503"
      || ["overloaded", "high demand"].some(s => msg.includes(s));
    // Gemini 429s carry a retryDelay ("retryDelay":"22s"); honor it over our own backoff.
    const stated = Number(msg.match(/retryDelay[^0-9]*(\d+)/)?.[1]) || null;
    const plan = (isQuota || isOverload) ? nextAttempt(attempt, KEYS.length, stated, isQuota) : null;
    if (!plan) throw new Error(`Model error ${errEvent.errorCode}: ${msg.slice(0, 200)}`);

    if (isQuota) keyIdx = (keyIdx + 1) % KEYS.length; // no point swapping keys for an overload
    console.warn(
      `[askAgent] ${errEvent.errorCode} on ${agent.name}` +
      `${isQuota ? ` — switching to key ${keyIdx + 1}/${KEYS.length}` : ""}` +
      `${plan.sleepS ? `, waiting ${plan.sleepS}s` : ""} (attempt ${attempt})`
    );
    if (plan.sleepS) await sleep(plan.sleepS * 1000);
  }
}

// ponytail: self-check pins the retry policy (the only branching here). Run: tsx agents.ts
// import.meta.url is empty in the esbuild CJS bundle, so self-checks stay dev-only (prod boot would crash on fileURLToPath(undefined)).
if (import.meta.url && process.argv[1] === fileURLToPath(import.meta.url)) {
  // Quota, 4 keys: swap to the other three instantly, then back off from 15s.
  assert.deepEqual(nextAttempt(1, 4, null, true), { sleepS: 0 });
  assert.deepEqual(nextAttempt(3, 4, null, true), { sleepS: 0 });
  assert.deepEqual(nextAttempt(4, 4, null, true), { sleepS: 15 });
  assert.deepEqual(nextAttempt(5, 4, null, true), { sleepS: 30 });
  assert.equal(nextAttempt(6, 4, null, true), null);          // out of road -> throw

  // Quota, 1 key: no one to swap to, so sleep and ramp — 3 runs total.
  assert.deepEqual(nextAttempt(1, 1, null, true), { sleepS: 15 });
  assert.deepEqual(nextAttempt(2, 1, null, true), { sleepS: 30 });
  assert.equal(nextAttempt(3, 1, null, true), null);

  // Overload (503): a fresh key cannot help, so never spend the instant retries on it — back off
  // immediately, however many keys are configured.
  assert.deepEqual(nextAttempt(1, 4, null, false), { sleepS: 15 });
  assert.deepEqual(nextAttempt(2, 4, null, false), { sleepS: 30 });
  assert.equal(nextAttempt(3, 4, null, false), null);

  // Gemini's own retryDelay wins over our ramp, but never delays a free key swap.
  assert.deepEqual(nextAttempt(4, 4, 22, true), { sleepS: 22 });
  assert.deepEqual(nextAttempt(1, 4, 22, true), { sleepS: 0 });

  // The rotated key must actually reach the model. Reaching into Gemini's private apiKey is the
  // point: a `model: "gemini-..."` string would re-read env per call and silently undo rotation.
  const keyOf = (a: LlmAgent) => (a.canonicalModel as any).apiKey;
  assert.ok(liveSummarizer("k-test").canonicalModel instanceof Gemini);
  assert.equal(keyOf(liveSummarizer("k-test")), "k-test");
  assert.equal(keyOf(intentClassifier("")("k-2")), "k-2");
  assert.equal(keyOf(proofreader({ model: "gemini-2.5-flash" })("k-3")), "k-3");

  console.log("agents self-check ✓");
}
