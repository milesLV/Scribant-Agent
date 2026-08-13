// The Master Orchestrator: one SequentialAgent that owns the whole read-only pipeline, replacing the
// hand-coordinated agent calls the routes used to make.
//
//   SequentialAgent "orchestrator"
//   ├── proofreader         (LlmAgent)       -> proofRaw
//   ├── correction_applier  (deterministic)  -> corrected, proof      => "proof" stage
//   ├── ParallelAgent
//   │   ├── live_summarizer   (LlmAgent)     -> summary               => "summary" stage
//   │   └── intent_classifier (LlmAgent)     -> planRaw
//   └── plan_resolver       (deterministic)  -> plan                  => "plan" stage
//
// Sub-agents pass data through session state (outputKey in, instruction providers out) rather than
// through the user message, which is what lets the deterministic steps sit between them.
//
// Zero side effects: the tree plans, it never writes to Google. Execution stays behind the human
// approval gate in /api/execute.
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { BaseAgent, SequentialAgent, ParallelAgent, Runner } from "@google/adk";
import type { Event, InvocationContext } from "@google/adk";
import { createEvent, createEventActions } from "@google/adk";
import {
  KEYS, keyCursor, nextAttempt, classifyError, sleep, sessionService,
  proofreader, liveSummarizer, intentClassifier,
} from "./agents";
import { buildProofreadPrompt, parseProofread } from "./transcriber";
import { applyCorrections } from "./src/utils/transcript";
import { cleanJsonString, resolvePlanDates } from "./server-utils";
import { getMemoryService } from "./memory";

export type Stage = "proof" | "summary" | "plan";

// Which stage a sub-agent belongs to — used to attribute an error event and to know what has
// already been delivered when a retry rebuilds the tree.
const STAGE_OF: Record<string, Stage> = {
  proofreader: "proof",
  correction_applier: "proof",
  live_summarizer: "summary",
  intent_classifier: "plan",
  plan_resolver: "plan",
};

// A deterministic sub-agent: no model, just a pure function over session state. The state write is
// done directly as well as through the event's stateDelta — the direct write is what the NEXT
// sub-agent reads, the delta is what the session service persists.
class Step extends BaseAgent {
  constructor(name: string, private readonly step: (state: Record<string, any>) => Record<string, unknown>) {
    super({ name });
  }
  protected async *runAsyncImpl(context: InvocationContext): AsyncGenerator<Event, void, void> {
    const stateDelta = this.step(context.session.state);
    // No delta means the LlmAgent upstream produced nothing (it errored). Staying silent is what
    // keeps a failed stage FAILED — emitting an empty result here would mark it done and the
    // client would get a blank plan instead of a retry.
    if (!Object.keys(stateDelta).length) return;
    Object.assign(context.session.state, stateDelta);
    yield createEvent({ author: this.name, actions: createEventActions({ stateDelta }) });
  }
  protected async *runLiveImpl(): AsyncGenerator<Event, void, void> {
    throw new Error(`${this.name} has no live mode`);
  }
}

// ---- the deterministic steps ------------------------------------------------

const correctionApplier = () => new Step("correction_applier", (s) => {
  if (s.proofRaw == null) return {}; // proofreader errored — let the stage retry rather than fake a clean pass
  const text = String(s.rawText ?? "");
  // Re-tokenizing costs one regex scan, which is cheaper than a sub-agent whose only job was to
  // carry the token list across in session state (the proofreader's prompt builds it the same way).
  const { corrections, words } = parseProofread(String(s.proofRaw), buildProofreadPrompt(text));
  // Echoing `corrected` lets the client mark it as already-processed — otherwise applying the
  // correction edits the transcript and re-arms the debounce, costing a whole extra cycle.
  const corrected = applyCorrections(text, words, corrections).text;
  return { corrected, proof: { text, corrected, corrections, words } };
});

const planResolver = () => new Step("plan_resolver", (s) => {
  const raw = s.planRaw;
  if (raw == null) return {}; // classifier errored — same reasoning as correction_applier
  const parsed = typeof raw === "string" ? JSON.parse(cleanJsonString(raw || "{}")) : raw;
  // chrono over the model's own date arithmetic — the model picks the right DAY, not the right date.
  return { plan: resolvePlanDates(parsed, String(s.refISO ?? "")) };
});

// ---- the tree ---------------------------------------------------------------

// Built per request from a stage set: /api/live wants all three (minus `plan` on a small tick),
// /api/analyze only `plan`, /api/transcribe-correct only `proof`. A retry rebuilds it with the
// stages that haven't landed yet, which is how a failed stage avoids re-billing the ones that did.
export function buildOrchestrator(apiKey: string, stages: Set<Stage>): SequentialAgent {
  const subAgents: BaseAgent[] = [];
  if (stages.has("proof")) subAgents.push(proofreader(apiKey), correctionApplier());

  const wide: BaseAgent[] = [];
  if (stages.has("summary")) wide.push(liveSummarizer(apiKey));
  if (stages.has("plan")) wide.push(intentClassifier(apiKey));
  // Both stages read the same corrected text and write different keys, so there is nothing to
  // serialize between them — running them in parallel keeps the plan off the summary's latency.
  if (wide.length > 1) subAgents.push(new ParallelAgent({ name: "drafting", subAgents: wide }));
  else if (wide.length === 1) subAgents.push(wide[0]);

  if (stages.has("plan")) subAgents.push(planResolver());
  return new SequentialAgent({ name: "orchestrator", subAgents });
}

// ---- the runner -------------------------------------------------------------

// Only what the non-streaming callers read: /api/transcribe-correct takes `proof`, /api/analyze
// takes `plan`. /api/live ignores the return entirely and works off onStage.
export interface OrchestratorResult {
  proof?: { text: string; corrected: string; corrections: any[]; words: any[] };
  plan?: any;
}

// Runs the orchestrator and reports each stage the moment it lands (that streaming is what /api/live
// is built on). Retry policy is askAgent's: rotate onto another key first, then back off. A stage
// that runs out of road reports its own error and the REST of the pipeline continues — a 429 on the
// classifier must not cost the user their proofread.
export async function runOrchestrator(opts: {
  stages: Set<Stage>;
  text: string;
  refISO: string;
  liveSummary?: string;
  onStage?: (stage: Stage, payload: any) => void;
}): Promise<OrchestratorResult> {
  const { stages, text, refISO, liveSummary = "", onStage } = opts;
  // Seeded once, then carried across retries: whatever a completed stage produced is handed back in
  // so the rebuilt tree doesn't recompute it. Callers without a proof stage get `corrected` up front,
  // so every downstream agent reads exactly one key.
  const state: Record<string, any> = { rawText: text, refISO, liveSummary };
  if (!stages.has("proof")) state.corrected = text;

  const done = new Set<Stage>();
  const attempts: Record<string, number> = { proof: 0, summary: 0, plan: 0 };
  const emit = (stage: Stage, payload: any) => { done.add(stage); onStage?.(stage, payload); };

  // Terminates on its own: every iteration either delivers a stage or spends one of that stage's
  // bounded retry attempts, and a run that reports nothing at all marks the rest done below.
  for (;;) {
    const remaining = new Set([...stages].filter(s => !done.has(s)));
    if (!remaining.size) break;

    const runner = new Runner({
      appName: "scribant",
      agent: buildOrchestrator(keyCursor.current(), remaining),
      sessionService,
      memoryService: getMemoryService(),
    });

    // Drain the whole run even after an error: a failing sub-agent's PARALLEL sibling may still be
    // in flight, and abandoning the generator there would throw away a summary that succeeded — and
    // then re-bill it on the retry. Downstream steps stay silent when their input never arrived.
    const failures = new Map<Stage, any>();
    for await (const ev of runner.runEphemeral({
      userId: "local",
      newMessage: { role: "user", parts: [{ text }] },
      stateDelta: { ...state },
    })) {
      if (ev.errorCode) {
        const { msg } = classifyError(ev);
        // Errors are authored by the sub-agent that raised them and STAGE_OF covers the whole tree,
        // so an unknown author is not a stage to retry — it ends the run rather than spinning.
        if (!STAGE_OF[ev.author ?? ""]) throw new Error(`Model error ${ev.errorCode}: ${msg.slice(0, 200)}`);
        failures.set(STAGE_OF[ev.author ?? ""], ev);
        continue;
      }
      // Deterministic steps announce their stage via stateDelta; the summarizer via its outputKey.
      const delta: Record<string, any> = ev.actions?.stateDelta ?? {};
      Object.assign(state, delta);
      if (delta.proof) emit("proof", delta.proof);
      if (delta.plan) emit("plan", { text: state.corrected ?? text, plan: delta.plan });
      if (typeof delta.summary === "string") emit("summary", { summary: delta.summary.trim() });
    }

    if (!failures.size) {
      // A stage can finish without a state delta reaching us (a model returning nothing useful);
      // treat the run as complete either way rather than looping on it forever.
      for (const s of remaining) done.add(s);
      break;
    }

    let sleepS = 0;
    for (const [stage, ev] of failures) {
      if (done.has(stage)) continue; // it errored but still delivered — nothing to retry
      const { msg, isQuota, isOverload, stated } = classifyError(ev);
      const plan = (isQuota || isOverload)
        ? nextAttempt(++attempts[stage], KEYS.length, stated, isQuota)
        : null;

      if (!plan) {
        // Out of road for this stage. Report it, make sure the rest can still run, keep going.
        const message = `Model error ${ev.errorCode}: ${msg.slice(0, 200)}`;
        console.error(`[orchestrator] ${stage} stage failed — ${message}`);
        onStage?.(stage, { error: message });
        done.add(stage);
        if (stage === "proof") state.corrected = state.corrected ?? text; // degrade to raw text
        continue;
      }

      if (isQuota) keyCursor.rotate();
      sleepS = Math.max(sleepS, plan.sleepS);
      console.warn(
        `[orchestrator] ${ev.errorCode} on ${ev.author}` +
        `${isQuota ? ` — switching to key ${keyCursor.index() + 1}/${KEYS.length}` : ""}` +
        `${plan.sleepS ? `, waiting ${plan.sleepS}s` : ""} (stage ${stage}, attempt ${attempts[stage]})`
      );
    }
    if (sleepS) await sleep(sleepS * 1000);
  }

  return { proof: state.proof, plan: state.plan };
}

// ponytail: self-check pins the tree shape per stage set and the deterministic steps' data flow.
// The steps' logic itself is already pinned by the pure functions they call (transcriber,
// server-utils, transcript). Run: tsx orchestrator.ts — no API key needed, no model is called.
// import.meta.url is empty in the esbuild CJS bundle, so self-checks stay dev-only.
if (import.meta.url && process.argv[1] === fileURLToPath(import.meta.url)) (async () => {
  const shape = (stages: Stage[]) =>
    buildOrchestrator("k", new Set(stages)).subAgents.map(a =>
      a instanceof ParallelAgent ? a.subAgents.map(s => s.name) : a.name);

  // Live pipeline: proofread, then summary and plan side by side, then the date pass.
  assert.deepEqual(shape(["proof", "summary", "plan"]), [
    "proofreader", "correction_applier",
    ["live_summarizer", "intent_classifier"],
    "plan_resolver",
  ]);
  // A small tick skips the expensive classifier; one agent must NOT be wrapped in a ParallelAgent.
  assert.deepEqual(shape(["proof", "summary"]), ["proofreader", "correction_applier", "live_summarizer"]);
  // Finalize (/api/analyze) and proofread-only (/api/transcribe-correct).
  assert.deepEqual(shape(["plan"]), ["intent_classifier", "plan_resolver"]);
  assert.deepEqual(shape(["proof"]), ["proofreader", "correction_applier"]);
  // What a resume after a summary failure rebuilds: the proof stage must not run twice.
  assert.deepEqual(shape(["summary"]), ["live_summarizer"]);

  // The deterministic steps, driven through a fake InvocationContext.
  const drive = async (agent: BaseAgent, state: Record<string, any>) => {
    const ctx = { session: { state } } as any;
    for await (const ev of (agent as any).runAsyncImpl(ctx)) {
      assert.equal(ev.author, agent.name);
      Object.assign(state, ev.actions.stateDelta); // what the session service would commit
    }
    return state;
  };

  // Proofread round trip: the model's correction lands in the corrected text the next agents read.
  // The applier re-derives the tokens from rawText, so the indices the model returned still line up.
  const s2 = await drive(correctionApplier(), {
    rawText: "buy milk tomorow",
    proofRaw: JSON.stringify({ corrections: [{ index: 2, from: "tomorow", to: "tomorrow" }], flagged: [], deletions: [] }),
  });
  assert.equal(s2.corrected, "buy milk tomorrow");
  assert.equal(s2.proof.text, "buy milk tomorow");        // the raw text still goes to the client
  assert.equal(s2.proof.corrections.length, 1);

  // Date resolution runs over the model's plan, fenced JSON and all.
  const s3 = await drive(planResolver(), {
    refISO: "2026-06-27T09:00:00",
    planRaw: '```json\n{"calendarEvents":[{"title":"Dentist","sourceText":"dentist tomorrow at 3pm","start":"2026-01-01T09:00:00","allDay":false}],"tasks":[]}\n```',
  });
  assert.equal(s3.plan.calendarEvents[0].start, "2026-06-28T15:00:00");

  // An outputSchema agent may hand back a parsed object rather than text — both must work.
  const s4 = await drive(planResolver(), { refISO: "2026-06-27T09:00:00", planRaw: { tasks: [], calendarEvents: [] } });
  assert.deepEqual(s4.plan.tasks, []);

  // When the LlmAgent above them errored, the deterministic steps MUST stay silent. Emitting an
  // empty result instead would mark the stage delivered: the client would get a blank plan, the
  // retry would never fire, and a parallel sibling would be re-billed on every attempt.
  const events = async (agent: BaseAgent, state: Record<string, any>) => {
    const out: any[] = [];
    for await (const ev of (agent as any).runAsyncImpl({ session: { state } } as any)) out.push(ev);
    return out;
  };
  assert.deepEqual(await events(planResolver(), { refISO: "2026-06-27T09:00:00" }), []); // no planRaw
  assert.deepEqual(await events(correctionApplier(), { rawText: "hi" }), []);            // no proofRaw
  // ...but a model that legitimately returned "nothing to fix" still delivers its stage.
  assert.equal((await events(correctionApplier(), { rawText: "hi", proofRaw: "{}" })).length, 1);

  console.log("orchestrator self-check ✓");
})();
