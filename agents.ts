// The four agents behind the API — one factory each, plus the runner that calls them.
//
// Factories, not singletons: an agent instance captures its model config and callbacks at
// construction, so a cached agent would pin one request's memory service and session state across
// every later request. Building a fresh one per call keeps each request independent.
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

// `tsx agents.ts` etc. run without --env-file; existing env vars win.
try { process.loadEnvFile(); } catch {}
import { LlmAgent, Gemini, Runner, InMemorySessionService, GOOGLE_SEARCH } from "@google/adk";
import type { ReadonlyContext } from "@google/adk";
import { z } from "zod";
import { SKILLS, skillSchemaProperties } from "./skills";
import { PROOFREAD_CORRECT_INSTRUCTION, buildProofreadPrompt } from "./transcriber";
import { getMemoryService, memoryBankBeforeModelCallback } from "./memory";
import { emitAdkEvent } from "./adk-events";
import { recordTokenUsage } from "./token-telemetry";

export const MODEL = process.env.GEMINI_MODEL || process.env.MODEL || "gemini-3.8-flash";

process.env.GOOGLE_GENAI_USE_VERTEXAI ||= process.env.GOOGLE_GENAI_USE_ENTERPRISE || "true";
// Vertex AI auth is ADC; stray API keys only make the GenAI SDK log precedence warnings.
delete process.env.GEMINI_API_KEY;
delete process.env.GOOGLE_GENAI_API_KEY;
delete process.env.GOOGLE_API_KEY;

// Sub-agents read from state, not the user message: downstream of the proofreader they must see the
// CORRECTED text. The orchestrator seeds `corrected` itself when there is no proof stage.
const corrected = (ctx: ReadonlyContext) => ctx.state.get<string>("corrected") ?? "";

// The classifier sees only the last ~40 words, so its cost stays flat however long the session;
// older context reaches it through liveSummary.
const recentWindow = (ctx: ReadonlyContext): string => {
  const text = corrected(ctx), words = text.trim().split(/\s+/);
  return words.length <= 40 ? text : "..." + words.slice(-40).join(" ");
};

export function createGeminiModel(): Gemini {
  return new Gemini({ model: MODEL });
}

type AgentFactory = () => LlmAgent;

// ---- the agents ------------------------------------------------------------

// Rolling bullet summary while the user is still speaking.
export const liveSummarizer: AgentFactory = () => new LlmAgent({
  name: "live_summarizer",
  model: createGeminiModel(),
  instruction: (ctx) => `You are a real-time summarizing assistant for an app that captures a person's unfiltered spoken thoughts.
The user is speaking or typing their thoughts live.
Analyze the provided chunk of raw text and extract a high-level summary as a Markdown outline.
Be extremely concise. Skip any introductory remarks, system summaries, or conversational filler. Output only the outline.

FORMAT — follow exactly:
- Indentation carries meaning. A top-level "-" is a point that stands on its own; indent a line by two spaces to make it a fact that SUPPORTS the point directly above it. Never go deeper than those two levels, and only indent when the relationship is real — a list of unrelated points stays flat.
- Use "-" for unordered points. Use "1." "2." "3." ONLY when the items are a genuine sequence, a ranking, or steps in an order the speaker gave. Never number a list just for looking tidy.
- Bold is rare. Most bullets have NO bold at all. Bold at most one short fragment in a bullet, and only when missing it would change what the reader does: a committed date, a specific number or amount, the person who owns an action, an explicit decision. Never bold a word for being the topic of the bullet. Never bold a whole clause or sentence.
- Use *italics* only for content the speaker was unsure about ("*maybe* Thursday") or for a phrase quoted back from them. Never underline.
- Write each bullet as the content itself, not as a labelled entry. Never open a bullet with a topic label followed by a colon (no "**Budget**: we need to cut costs" — just "Need to cut costs, mostly on contractors"). A colon is fine mid-sentence when the sentence genuinely needs one.
- No headings, no bold section titles, no trailing summary line.

EXAMPLE of the right shape and the right amount of bold (7 lines, one bold span):
- Contractor spend has to come down before the next quarter
  - Two contracts renew in September
  - *Possibly* a third, Alice was not sure
- Rollout order agreed
  1. Freeze the schema
  2. Migrate the staging rows
  3. Cut over **Friday**

Raw draft thoughts:
"${corrected(ctx)}"`,
  outputKey: "summary",
  // The transcript arrives via state, so peer/user turns in the session add nothing but tokens —
  // and inside a ParallelAgent they would leak the classifier's JSON into this prompt.
  includeContents: "none",
});

// Obvious typos → auto-corrections, ambiguous mishearings → low-confidence flags. transcriber.ts
// owns the instruction, the indexed-token prompt and the parsing of the reply.
export const proofreader: AgentFactory = () => new LlmAgent({
  name: "proofreader",
  model: createGeminiModel(),
  instruction: (ctx) =>
    `${PROOFREAD_CORRECT_INSTRUCTION}\n\n${buildProofreadPrompt(ctx.state.get<string>("rawText") ?? "").contents}`,
  generateContentConfig: { responseMimeType: "application/json" },
  outputKey: "proofRaw",
  includeContents: "none",
});

// Grounded search. Grounding can't be combined with a JSON outputSchema, so the answer stays
// marker-formatted text (CONDENSED:/DETAILED:) parsed by splitTiers.
export const groundedSearcher: AgentFactory = () => new LlmAgent({
  name: "grounded_searcher",
  model: createGeminiModel(),
  instruction: "You are a research assistant. Use Google Search to ground your answer, then respond in exactly the format the user requests.",
  tools: [GOOGLE_SEARCH],
});

// Verbatim STT for one audio chunk; the clip arrives as an inlineData part via askAgent.
export const audioTranscriber: AgentFactory = () => new LlmAgent({
  name: "audio_transcriber",
  model: createGeminiModel(),
  instruction: `Transcribe the spoken audio verbatim. If multiple distinct speakers are talking, separate their turns and prefix each turn with a clear speaker label (e.g., 'Speaker 1: ...', 'Speaker 2: ...'). If speakers introduce themselves or address each other by name (e.g., 'Hi Alice', 'Thanks Bob'), use their actual names as the speaker label. If only one person is speaking, transcribe verbatim without speaker labels. No markdown formatting, timestamps, or commentary — return only the transcribed speech in English. If the clip has no discernible speech (silence, noise, music only), return an empty string.`,
  includeContents: "none",
});

// Answers user questions synthesized from retrieved past session memories
export const memoryAnswerer: AgentFactory = () => new LlmAgent({
  name: "memory_answerer",
  model: createGeminiModel(),
  instruction: "You are a helpful personal memory assistant. Based strictly on the user's past session memories provided in the prompt, answer their question directly, clearly, and concisely (1-2 sentences). If the memories do not contain the answer, say so politely.",
  includeContents: "default",
});

// Prompt criteria + schema are generated once from the skill registry (skills.ts). Order is fixed:
// ideasSummary (1), each skill (2..) — the calendar criteria's "(see #3)" reference relies on
// tasks landing at index 3.
const analyzeCriteriaText = [
  { key: "ideasSummary", body: `(string) The 3-5 things the speaker would say if asked "so what was that about?". The Bullet Point Summary above records WHAT WAS SAID; this records WHAT IT MEANT. It is NOT a shorter copy of that summary — never repeat one of its bullets, and never just pick its top few lines.
Work from the Bullet Point Summary; if it is empty or not provided, work from the raw transcript instead. Separate items with single newlines.
- At most 5 lines. Every line is a top-level "-" — no indentation, no sub-points, no "1." numbering, ever.
- Consolidate. If several summary bullets are facets of one idea, they become ONE line here.
- Leave out supporting detail, examples and asides — those stay in the summary. Do NOT restate individual calendar events, to-dos or search queries; those already have their own panels.
- Stay close to the summary's own wording — do not swap in synonyms or re-phrase for variety. This is recomputed every few seconds as the speaker talks, and a line that rewords itself on every pass is unreadable.
- Bold at most ONE short fragment in the WHOLE list — not one per line. Every line here is already important, so marking them all marks nothing. Spend that one mark on the single hardest commitment in the session (a date, a number, an owner) and leave the other lines plain. Never bold a word for being the topic. Use *italics* only for something the speaker was unsure about. Never open a line with a topic label followed by a colon.
EXAMPLE — for this Bullet Point Summary:
- Contractor spend has to come down before next quarter
  - Two contracts renew in September
  - *Possibly* a third, Alice was not sure
- Rollout order agreed
  1. Freeze the schema
  2. Migrate staging rows
  3. Cut over **Friday**
- Need to book the dentist
you output exactly this (3 lines, the dentist dropped because it is a to-do, the migration steps collapsed into one line):
- Contractor spend is the binding constraint this quarter
- The migration is going ahead, cutting over **Friday**
- Alice owns the September renewals` },
  ...SKILLS.map(s => ({ key: s.name, body: s.description })),
].map((e, i) => `${i + 1}. "${e.key}": ${e.body}`).join("\n");

const analyzeOutputSchema = z.object({
  ideasSummary: z.string().describe("3-5 flat, standalone takeaways — the distilled meaning of the session, not a shorter copy of the summary."),
  ...skillSchemaProperties(),
});

// Turn the transcript into calendar/task/search items. Transcript, reference time and the live
// summary all come from session state, so the same agent serves /api/live and /api/analyze.
export const intentClassifier: AgentFactory = () => new LlmAgent({
  name: "intent_classifier",
  model: createGeminiModel(),
  instruction: (ctx) => `You are a high-fidelity intent parsing engine for an app that transcribes a person's unfiltered spoken thoughts and turns them into structured actions.
The user is speaking or writing their thoughts in an unfiltered "brain dump" format or recording a meeting/conversation with multiple speakers.
Analyze the provided stream of thoughts/dialogue and categorize segments into different structured action buckets.
Be proactive and vigilant in identifying all actionable tasks, to-dos, follow-ups, and commitments mentioned in casual conversation or stream-of-consciousness dialogue (e.g. "I'll do X", "I need to Y", "We should follow up with Z", "Make sure to W", "Don't forget to...").
If speaker labels are present in the transcript (e.g., 'You:', 'Alice:', 'Speaker 1:'), attribute extracted tasks with the responsible speaker in 'assignee' (the person who volunteered or was assigned) and 'requestedBy' (the person who requested it). Attribute calendar events with 'speaker'.

Bullet Point Summary: "${ctx.state.get<string>("liveSummary") ?? ""}"

You MUST output strictly a JSON object with the following keys and criteria:

${analyzeCriteriaText}

CRITICAL: If there are no items matching a category's strict criteria, you MUST return an empty array [] for that field. Do not generate empty or placeholder objects. Return ONLY the valid JSON object.

Current Time context: ${ctx.state.get<string>("refISO") ?? ""}

Stream of thoughts (Active Recent Window):
"${recentWindow(ctx)}"`,
  outputSchema: analyzeOutputSchema,
  outputKey: "planRaw",
  includeContents: "none",
  disallowTransferToParent: true,
  disallowTransferToPeers: true,
  beforeModelCallback: memoryBankBeforeModelCallback,
});

// ---- the runner ------------------------------------------------------------

// Seconds to back off before retrying a quota/overload failure (15s, then 30s, or the model's own
// retryDelay), or null when out of retries. One ADC project, so there is nothing to fail over to.
export const nextAttempt = (attempt: number, statedDelayS: number | null): number | null =>
  attempt >= 3 ? null : statedDelayS ?? 15 * attempt;

export const sessionService = new InMemorySessionService();
export const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export function classifyError(errEvent: { errorCode?: unknown; errorMessage?: unknown }) {
  const msg = String(errEvent.errorMessage || "");
  const isQuota = String(errEvent.errorCode) === "429" || msg.includes("RESOURCE_EXHAUSTED");
  const isOverload = String(errEvent.errorCode) === "503"
    || ["overloaded", "high demand"].some(s => msg.includes(s));
  // Gemini 429s carry a retryDelay ("retryDelay":"22s"); honor it over our own backoff.
  const stated = Number(msg.match(/retryDelay[^0-9]*(\d+)/)?.[1]) || null;
  // ADC failures arrive as UNKNOWN_ERROR with the real cause buried in the message.
  const isAuth = /default credentials|invalid_grant|reauth|UNAUTHENTICATED|PERMISSION_DENIED/i.test(msg);
  return { msg, isQuota, isOverload, isAuth, stated };
}

// Stateless agent call: ephemeral session per request, drain events, keep the last text and any
// grounding metadata. ADK reports model failures as error EVENTS, not throws — surface them here or
// a 429 looks like an empty answer. `input` is text, or raw parts (e.g. inlineData audio).
export async function askAgent(
  make: AgentFactory,
  input: string | any[],
  options?: { diarizationEnabled?: boolean; source?: string; metadata?: Record<string, any>; sessionId?: string; userId?: string; stage?: string }
): Promise<{ text: string; grounding?: any }> {
  const parts = typeof input === "string" ? [{ text: input }] : input;
  for (let attempt = 1; ; attempt++) {
    const agent = make();
    const runner = new Runner({ appName: "scribant", agent, sessionService, memoryService: getMemoryService() });
    let out = "";
    let grounding: any;
    let errEvent: any = null;
    const startTime = Date.now();
    for await (const ev of runner.runEphemeral({
      userId: options?.userId || "local",
      newMessage: { role: "user", parts },
    })) {
      emitAdkEvent(ev);
      if (ev.errorCode && String(ev.errorCode).toUpperCase() !== "STOP") errEvent = ev;
      const t = ev.content?.parts?.map((p: any) => p.text).filter(Boolean).join("") ?? "";
      if (t) out = t;
      if (ev.groundingMetadata) grounding = ev.groundingMetadata;
      if (ev.usageMetadata) {
        const audio = agent.name === "audio_transcriber";
        recordTokenUsage({
          model: MODEL, agent: agent.name, provider: "gemini", usage: ev.usageMetadata, durationMs: Date.now() - startTime,
          stage: options?.stage || (audio ? "stt" : "standalone_analyze"), modality: audio ? "audio" : "text",
          diarizationEnabled: options?.diarizationEnabled, source: options?.source, sessionId: options?.sessionId,
          userId: options?.userId, metadata: options?.metadata,
        });
      }
    }
    if (!errEvent) return { text: out, grounding };

    const { msg, isQuota, isOverload, stated } = classifyError(errEvent);
    const sleepS = (isQuota || isOverload) ? nextAttempt(attempt, stated) : null;
    if (sleepS == null) throw new Error(`Model error ${errEvent.errorCode}: ${msg.slice(0, 200)}`);

    console.warn(`[askAgent] ${errEvent.errorCode} on ${agent.name}, waiting ${sleepS}s (attempt ${attempt})`);
    await sleep(sleepS * 1000);
  }
}

// Self-check: retry policy + agents read their input from state. The `import.meta.url &&` guard keeps
// every module's self-check dead in the CJS bundle, where import.meta.url is empty.
if (import.meta.url && process.argv[1] === fileURLToPath(import.meta.url)) (async () => {
  // Sleep and ramp, 3 runs total, then out of road -> throw.
  assert.equal(nextAttempt(1, null), 15);
  assert.equal(nextAttempt(2, null), 30);
  assert.equal(nextAttempt(3, null), null);

  // The model's own retryDelay wins over our ramp.
  assert.equal(nextAttempt(1, 22), 22);

  assert.ok(liveSummarizer().canonicalModel instanceof Gemini);
  assert.equal(intentClassifier().canonicalBeforeModelCallbacks.length, 1);

  // Sub-agents read their input from state, not from the user message — an instruction that ignored
  // state would silently summarize/classify an empty transcript inside the orchestrator.
  const stateCtx = (state: Record<string, string>) =>
    ({ state: { get: (k: string) => state[k] } }) as any;
  const instructionOf = async (a: LlmAgent, state: Record<string, string>) =>
    String(typeof a.instruction === "function" ? await a.instruction(stateCtx(state)) : a.instruction);
  assert.match(await instructionOf(liveSummarizer(), { corrected: "buy milk" }), /buy milk/);
  const classifierPrompt = await instructionOf(intentClassifier(), { corrected: "buy milk", refISO: "2026-06-27T09:00:00", liveSummary: "notes so far" });
  assert.match(classifierPrompt, /buy milk/);
  assert.match(classifierPrompt, /2026-06-27T09:00:00/);
  assert.match(classifierPrompt, /notes so far/);
  assert.match(await instructionOf(proofreader(), { rawText: "buy milk" }), /0:buy 1:milk/);

  console.log("agents self-check ✓");
})();

