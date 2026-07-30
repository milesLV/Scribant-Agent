// evals/run.ts — one-file eval runner for the Scribant agents.
// Grades LIVE agent output by PROPERTIES (never exact strings). No framework.
//
//   npm run eval                     # intent + transcriber against a live dev server
//   npm run eval -- --file intent-classification   # one dataset (see the .jsonl stems in data/)
//   npm run eval -- --tags datetime  # only cases carrying any listed tag
//   npm run eval -- --selfcheck      # grader unit tests, no network
//   npm run eval -- --save-baseline  # snapshot current metrics as the regression gate
//
// Live mode POSTs to a running server (npm run dev). Override with EVAL_BASE_URL.
// output-quality.jsonl uses the optional LLM judge (--judge); everything else is deterministic.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import assert from "node:assert/strict";
import "dotenv/config";
import { GoogleGenAI } from "@google/genai";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(HERE, "data");
const BASE = process.env.EVAL_BASE_URL || "http://localhost:3000";
const CONFIDENCE_THRESHOLD = 0.7;

// ---- tiny helpers ----------------------------------------------------------
const norm = (s: string) => (s || "").toLowerCase().replace(/\s+/g, " ").trim();
const contains = (hay: string, needleNorm: string) => norm(hay).includes(needleNorm);
const tok = (s: string) => (s || "").toLowerCase().replace(/[^\w\s]/g, "").split(/\s+/).filter(Boolean);
const sentences = (s: string) => (s || "").split(/(?<=[.!?])\s+/).map(x => x.trim()).filter(Boolean).length;

function loadJsonl(file: string): any[] {
  return readFileSync(path.join(DATA, file), "utf8")
    .split("\n").map(l => l.trim()).filter(Boolean).map(l => JSON.parse(l));
}
function locateSpan(sub: string, text: string): number | null {
  const i = norm(text).indexOf(norm(sub));
  return i < 0 ? null : i;
}
// Compare the produced start as WALL-CLOCK time (what the model wrote), matching the dataset's
// local expectations. ponytail: naive string parse, not Date() — dodges runner-TZ drift.
function parseWallClock(s: string): { date: string; hour: number } | null {
  if (!s) return null;
  const dm = String(s).match(/(\d{4}-\d{2}-\d{2})/);
  if (!dm) return null;
  const hm = String(s).match(/T(\d{2})/);
  return { date: dm[1], hour: hm ? Number(hm[1]) : 0 };
}

// Word-level edit distance / reference length = WER. Used for the correction pipeline (corrected vs gold).
function werWord(hyp: string, ref: string): number {
  const a = tok(hyp), b = tok(ref);
  if (!b.length) return 0;
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      d[i][j] = a[i - 1] === b[j - 1] ? d[i - 1][j - 1] : 1 + Math.min(d[i - 1][j], d[i][j - 1], d[i - 1][j - 1]);
  return d[a.length][b.length] / b.length;
}
// Apply {index,from,to} corrections back onto whitespace tokens (index-then-text fallback) to score WER.
function applyCorrections(text: string, corrections: any[]): string {
  const w = text.split(/\s+/);
  for (const c of corrections) {
    let i = c.index;
    if (!(w[i] !== undefined && norm(w[i]).includes(norm(c.from)))) i = w.findIndex(x => norm(x).includes(norm(c.from)));
    if (i >= 0 && w[i] !== undefined) w[i] = c.to;
  }
  return w.join(" ");
}

type Cat = "calendar" | "task" | "search" | "none";
const CATS: Cat[] = ["calendar", "task", "search"];
function emptyMatrix(): Record<string, Record<string, number>> {
  const m: Record<string, Record<string, number>> = {};
  for (const r of [...CATS, "none"]) { m[r] = {}; for (const c of [...CATS, "none"]) m[r][c] = 0; }
  return m;
}

// ---- intent grader ---------------------------------------------------------
function producedItems(out: any) {
  return [
    ...(out.calendarEvents || []).map((e: any) => ({ cat: "calendar" as Cat, hay: `${e.sourceText || ""} ${e.title || ""} ${e.description || ""}`, raw: e })),
    ...(out.tasks || []).map((t: any) => ({ cat: "task" as Cat, hay: `${t.sourceText || ""} ${t.title || ""} ${t.notes || ""}`, raw: t })),
    ...(out.searchQueries || []).map((s: any) => ({ cat: "search" as Cat, hay: `${s.sourceText || ""} ${s.query || ""}`, raw: s })),
  ];
}
function checkItemFields(item: any, raw: any, fails: string[]) {
  if (item.uncertain !== undefined && !!raw.uncertain !== !!item.uncertain)
    fails.push(`uncertain '${item.match}': want ${item.uncertain} got ${!!raw.uncertain}`);
  if (item.allDay !== undefined && !!raw.allDay !== !!item.allDay)
    fails.push(`allDay '${item.match}': want ${item.allDay} got ${!!raw.allDay}`);
  if (item.startDate || item.startHour !== undefined) {
    const wc = parseWallClock(raw.start);
    if (!wc) fails.push(`start unparseable '${item.match}': '${raw.start}'`);
    else {
      if (item.startDate && wc.date !== item.startDate) fails.push(`startDate '${item.match}': want ${item.startDate} got ${wc.date}`);
      if (item.startHour !== undefined && wc.hour !== item.startHour) fails.push(`startHour '${item.match}': want ${item.startHour} got ${wc.hour}`);
    }
  }
  if (item.dueDate) {
    const d = String(raw.dueDate || "").slice(0, 10);
    if (d !== item.dueDate) fails.push(`dueDate '${item.match}': want ${item.dueDate} got ${d || "(empty)"}`);
  }
  // Consent is the gate on auto-execution, so claiming it when the speaker never gave it is a fail.
  if (item.explicitCommand !== undefined && !!raw.explicitCommand !== !!item.explicitCommand)
    fails.push(`explicitCommand '${item.match}': want ${item.explicitCommand} got ${!!raw.explicitCommand}`);
}
function gradeIntent(c: any, out: any, mat: Record<string, Record<string, number>>) {
  const fails: string[] = [];
  const expected = [
    ...(c.expect.calendar || []).map((i: any) => ({ cat: "calendar" as Cat, item: i })),
    ...(c.expect.tasks || []).map((i: any) => ({ cat: "task" as Cat, item: i })),
    ...(c.expect.search || []).map((i: any) => ({ cat: "search" as Cat, item: i })),
  ];
  const prod = producedItems(out);
  const matched = new Set<any>();
  let correct = 0;
  for (const { cat: E, item } of expected) {
    const m = norm(item.match);
    // Prefer a match in the EXPECTED category; only fall back to other categories (→ confusion)
    // when there's no same-category hit. Without this, a shared keyword collides with whichever
    // category is checked first (e.g. "insurance" as both a task and a search).
    const hit = prod.find(p => p.cat === E && contains(p.hay, m)) || prod.find(p => contains(p.hay, m));
    if (!hit) { mat[E].none++; fails.push(`miss: expected ${E} '${item.match}'`); continue; }
    matched.add(hit);
    mat[E][hit.cat]++;
    if (hit.cat !== E) { fails.push(`confusion: '${item.match}' expected ${E} got ${hit.cat}`); continue; }
    correct++;
    checkItemFields(item, hit.raw, fails);
  }
  if (!c.allowExtra) {
    for (const p of prod) if (!matched.has(p)) {
      mat.none[p.cat]++;
      fails.push(`extra ${p.cat}: '${norm(p.hay).slice(0, 40)}'`);
    }
  }
  for (const p of prod) {
    const st = p.raw.sourceText;
    if (st && locateSpan(st, c.transcript) === null) fails.push(`sourceText not in transcript: '${st}'`);
  }
  return { kind: "intent", id: c.id, note: c.note, pass: fails.length === 0, fails, expectedCount: expected.length, correct };
}

// ---- transcriber grader ----------------------------------------------------
function gradeTranscriber(c: any, out: any) {
  const fails: string[] = [];
  // The router "notices" a wrong word two ways: it FLAGS the ambiguous ones (low-confidence words)
  // or AUTO-CORRECTS the obvious typos. Either counts as detection; clean words must get neither.
  const flagged = (out.words || []).filter((w: any) => w.confidence < CONFIDENCE_THRESHOLD);
  const corrections = out.corrections || [];
  const noticed = new Set<string>([...flagged.map((w: any) => tok(w.text)[0]), ...corrections.map((cc: any) => tok(cc.from)[0])]);
  let caughtHit = 0;
  for (const es of c.expectCaught || []) {
    const mtokens = tok(es.match);
    const fHits = flagged.filter((w: any) => mtokens.includes(tok(w.text)[0]));
    const cHits = corrections.filter((cc: any) => mtokens.includes(tok(cc.from)[0]));
    if (fHits.length === 0 && cHits.length === 0) { fails.push(`not detected: '${es.match}'`); continue; }
    caughtHit++;
    if (es.suggestionIncludes) {
      const alts = [...fHits.flatMap((h: any) => h.alternatives || []), ...cHits.map((cc: any) => cc.to)].join(" | ").toLowerCase();
      if (!alts.includes(es.suggestionIncludes.toLowerCase()))
        fails.push(`suggestion for '${es.match}' missing '${es.suggestionIncludes}' (got: ${alts || "none"})`);
    }
  }
  let cleanFalse = 0;
  for (const cw of c.expectClean || []) {
    if (noticed.has(tok(cw)[0])) { cleanFalse++; fails.push(`false positive on clean '${cw}'`); }
  }
  return {
    kind: "transcriber", id: c.id, note: c.note, pass: fails.length === 0, fails,
    caughtExpected: (c.expectCaught || []).length, caughtHit,
    cleanTotal: (c.expectClean || []).length, cleanFalse,
  };
}

// ---- correction router grader (POST /api/transcribe-correct -> {corrections, words}) ----
function gradeCorrection(c: any, out: any) {
  const fails: string[] = [];
  const corrections = out.corrections || [];
  const flagged = (out.words || []).filter((w: any) => w.confidence < CONFIDENCE_THRESHOLD);

  let correctHit = 0;
  for (const ec of c.expect.correct || []) {
    const hit = corrections.find((cc: any) => tok(cc.from)[0] === tok(ec.from)[0] && norm(cc.to).includes(norm(ec.to)));
    if (hit) correctHit++; else fails.push(`not corrected: '${ec.from}'->'${ec.to}'`);
  }
  const expFroms = new Set((c.expect.correct || []).map((e: any) => tok(e.from)[0]));
  let overCorrect = 0;
  for (const cc of corrections) if (!expFroms.has(tok(cc.from)[0])) { overCorrect++; fails.push(`over-correction: '${cc.from}'->'${cc.to}'`); }

  let flagHit = 0;
  for (const ef of c.expect.flag || []) {
    const mtokens = tok(ef.match);
    const hits = flagged.filter((w: any) => mtokens.includes(tok(w.text)[0]));
    if (hits.length === 0) { fails.push(`not flagged: '${ef.match}'`); continue; }
    flagHit++;
    if (ef.suggestionIncludes) {
      const alts = hits.flatMap((h: any) => h.alternatives || []).join(" | ").toLowerCase();
      if (!alts.includes(ef.suggestionIncludes.toLowerCase())) fails.push(`flag suggestion for '${ef.match}' missing '${ef.suggestionIncludes}'`);
    }
  }
  const expFlagTokens = new Set((c.expect.flag || []).flatMap((f: any) => tok(f.match)));
  let overFlag = 0;
  for (const w of flagged) if (!expFlagTokens.has(tok(w.text)[0])) { overFlag++; fails.push(`over-flag: '${w.text}'`); }

  const wer = c.gold ? werWord(applyCorrections(c.text, corrections), c.gold) : undefined;
  return {
    kind: "correction", id: c.id, note: c.note, pass: fails.length === 0, fails,
    correctExpected: (c.expect.correct || []).length, correctHit, overCorrect,
    flagExpected: (c.expect.flag || []).length, flagHit, overFlag,
    wer, hasGold: c.gold ? 1 : 0,
  };
}

// ---- live calls ------------------------------------------------------------
async function post(pathname: string, body: any): Promise<any> {
  const res = await fetch(BASE + pathname, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${pathname} -> ${res.status}: ${(await res.text()).slice(0, 120)}`);
  return res.json();
}

// ---- LLM judge (eval-only, gated behind --judge) ---------------------------
// Deterministic checks cover structure/facts (sentence counts, mentions, source count).
// The judge grades only the SUBJECTIVE `judge.quality` rubric. Kept in eval-land, not prod.
let _judgeClient: GoogleGenAI | null = null;
function judgeClient(): GoogleGenAI {
  if (_judgeClient) return _judgeClient;
  const key = ["GEMINI_API_KEY", "GEMINI_API_KEY1", "GEMINI_API_KEY2", "GEMINI_API_KEY3"]
    .map(n => process.env[n]).find(k => k && k.trim());
  if (!key) throw new Error("--judge needs a GEMINI_API_KEY in .env");
  _judgeClient = new GoogleGenAI({ apiKey: key.trim() });
  return _judgeClient;
}
async function judge(rubric: string, content: string): Promise<{ pass: boolean; reason: string }> {
  const r = await judgeClient().models.generateContent({
    model: "gemini-2.5-flash",
    contents: `You are grading an AI answer.\nRUBRIC: ${rubric}\n\nCONTENT:\n${content}\n\nReply ONLY JSON: {"pass": <boolean>, "reason": "<one short sentence>"}`,
    config: { responseMimeType: "application/json" },
  });
  try { return JSON.parse((r.text || "{}").replace(/```json?|```/g, "").trim()); }
  catch { return { pass: false, reason: "judge output unparseable" }; }
}

// ---- tool-output content grader (Layer 2: /api/search tiers, calendar/task item content) ----
function gradeToolOutput(c: any, out: any, judgeResult?: { pass: boolean; reason: string }) {
  const fails: string[] = [];
  const j = c.judge || {};
  if (c.query) {
    const condensed = out.condensed || "", inDepth = out.inDepth || "", all = `${condensed} ${inDepth}`;
    if (j.condensedSentences) { const n = sentences(condensed); if (n < j.condensedSentences[0] || n > j.condensedSentences[1]) fails.push(`condensed ${n} sentences, want ${j.condensedSentences.join("-")}`); }
    if (j.inDepthSentences) { const n = sentences(inDepth); if (n < j.inDepthSentences[0] || n > j.inDepthSentences[1]) fails.push(`in-depth ${n} sentences, want ${j.inDepthSentences.join("-")}`); }
    if (j.mustMention && !norm(all).includes(norm(j.mustMention))) fails.push(`missing mention '${j.mustMention}'`);
    if (j.sourcesMin !== undefined && (out.sources || []).length < j.sourcesMin) fails.push(`sources ${(out.sources || []).length} < ${j.sourcesMin}`);
  } else {
    const isCal = (c.tags || []).includes("calendar");
    const item = isCal ? (out.calendarEvents || [])[0] : (out.tasks || [])[0];
    if (!item) fails.push(`no ${isCal ? "calendar" : "task"} item produced`);
    else {
      const title = item.title || "";
      const detail = String(item.description ?? item.notes ?? "");
      for (const t of j.titleMentions || []) if (!norm(`${title} ${detail}`).includes(norm(t))) fails.push(`title missing '${t}'`);
      for (const d of j.detailMentions || []) if (!norm(detail).includes(norm(d))) fails.push(`detail missing '${d}'`);
      if (j.startDate || j.startHour !== undefined) checkItemFields({ match: c.id, startDate: j.startDate, startHour: j.startHour }, item, fails);
    }
  }
  if (j.quality && judgeResult && !judgeResult.pass) fails.push(`judge: ${judgeResult.reason}`);
  return { kind: "tooloutput", id: c.id, note: c.note, pass: fails.length === 0, fails, judged: (j.quality && judgeResult) ? 1 : 0 };
}

// ---- reporting -------------------------------------------------------------
function printMatrix(mat: Record<string, Record<string, number>>) {
  const cols = [...CATS, "none"];
  console.log("\nTool-selection confusion (rows = expected, cols = produced):");
  console.log("            " + cols.map(c => c.padStart(9)).join(""));
  for (const r of [...CATS, "none"]) console.log(r.padEnd(12) + cols.map(c => String(mat[r][c]).padStart(9)).join(""));
}

async function runLive(filter: { file?: string; tags?: string[] }) {
  const wantTag = (c: any) => !filter.tags || filter.tags.some(t => (c.tags || []).includes(t));
  const mat = emptyMatrix();
  const results: any[] = [];

  const useJudge = process.argv.includes("--judge");
  const analyze = (c: any) => post("/api/analyze", { text: c.transcript, currentLocalTime: c.now, liveSummary: "" });
  // One row per dataset: which file, its result `kind`, and how to run+grade a case. The per-suite
  // variance (endpoint, request shape, grader) lives in `run`; the loop is shared.
  const suites: { file: string; kind: string; run: (c: any) => Promise<any> }[] = [
    ...["intent-classification.jsonl", "explicit-consent.jsonl"].map(file => ({
      file, kind: "intent", run: async (c: any) => gradeIntent(c, await analyze(c), mat) })),
    { file: "misheard-word-detection.jsonl", kind: "transcriber", run: async c => gradeTranscriber(c, await post("/api/transcribe-correct", { text: c.text })) },
    { file: "correction-routing.jsonl", kind: "correction", run: async c => gradeCorrection(c, await post("/api/transcribe-correct", { text: c.text })) },
    { file: "output-quality.jsonl", kind: "tooloutput", run: async c => {
      const out = c.query ? await post("/api/search", { query: c.query }) : await analyze(c);
      const jr = (useJudge && c.judge?.quality) ? await judge(c.judge.quality, JSON.stringify(out)) : undefined;
      return gradeToolOutput(c, out, jr); } },
  ];

  for (const s of suites) {
    if (filter.file && filter.file !== s.file.replace(/\.jsonl$/, "")) continue;
    for (const c of loadJsonl(s.file).filter(wantTag)) {
      try {
        results.push(await s.run(c));
      } catch (e: any) {
        results.push({ kind: s.kind, id: c.id, note: c.note, pass: false, fails: [`ERROR ${e.message}`] });
      }
    }
  }

  for (const r of results) {
    console.log(`${r.pass ? "PASS" : "FAIL"}  ${String(r.id).padEnd(9)} ${r.note || ""}`);
    for (const f of r.fails) console.log(`        - ${f}`);
  }

  const intent = results.filter(r => r.kind === "intent");
  const tr = results.filter(r => r.kind === "transcriber");
  const cor = results.filter(r => r.kind === "correction");
  const to = results.filter(r => r.kind === "tooloutput");
  const sum = (a: any[], k: string) => a.reduce((n, x) => n + (x[k] || 0), 0);
  const werCases = cor.filter(r => r.hasGold);
  const metrics: any = {
    cases: results.length,
    passRate: results.length ? results.filter(r => r.pass).length / results.length : 1,
    toolSelectionRate: sum(intent, "expectedCount") ? sum(intent, "correct") / sum(intent, "expectedCount") : 1,
    catchRate: sum(tr, "caughtExpected") ? sum(tr, "caughtHit") / sum(tr, "caughtExpected") : 1,
    cleanFalseFlagRate: sum(tr, "cleanTotal") ? sum(tr, "cleanFalse") / sum(tr, "cleanTotal") : 0,
    correctionRecall: sum(cor, "correctExpected") ? sum(cor, "correctHit") / sum(cor, "correctExpected") : 1,
    overCorrections: sum(cor, "overCorrect"),
    avgWER: werCases.length ? sum(werCases, "wer") / werCases.length : 0,
    toolOutputPassRate: to.length ? to.filter(r => r.pass).length / to.length : 1,
  };
  console.log("\nMetrics:");
  for (const [k, v] of Object.entries(metrics)) console.log(`  ${k.padEnd(20)} ${typeof v === "number" ? (v as number).toFixed(3) : v}`);
  if (intent.length) printMatrix(mat);

  const baseFile = path.join(HERE, "baseline.json");
  if (process.argv.includes("--save-baseline")) {
    writeFileSync(baseFile, JSON.stringify(metrics, null, 2));
    console.log(`\nBaseline saved -> ${path.relative(process.cwd(), baseFile)}`);
  } else if (existsSync(baseFile)) {
    const base = JSON.parse(readFileSync(baseFile, "utf8"));
    let regressed = false;
    console.log("\nvs baseline:");
    for (const k of ["passRate", "toolSelectionRate", "catchRate"]) {
      const d = metrics[k] - (base[k] ?? 0);
      if (d < -0.001) regressed = true;
      console.log(`  ${k.padEnd(20)} ${d >= 0 ? "+" : ""}${d.toFixed(3)}`);
    }
    const dz = metrics.cleanFalseFlagRate - (base.cleanFalseFlagRate ?? 0);
    if (dz > 0.001) regressed = true;
    console.log(`  cleanFalseFlagRate   ${dz >= 0 ? "+" : ""}${dz.toFixed(3)} (lower is better)`);
    console.log(regressed ? "\n❌ regression vs baseline" : "\n✅ no regression");
    if (regressed) process.exitCode = 1;
  }
}

// ---- self-check (no network) — run: npm run eval -- --selfcheck -------------
function selfCheck() {
  const m1 = emptyMatrix();
  const good = gradeIntent(
    { id: "x", transcript: "Dinner with Sam tonight at 7.", expect: { calendar: [{ match: "Sam", startHour: 19, startDate: "2026-06-27" }], tasks: [], search: [] } },
    { calendarEvents: [{ title: "Dinner with Sam", sourceText: "Dinner with Sam tonight at 7", start: "2026-06-27T19:00:00", uncertain: false, allDay: false }], tasks: [], searchQueries: [] }, m1);
  assert.equal(good.pass, true, "clean intent should pass");
  assert.equal(m1.calendar.calendar, 1);

  const m2 = emptyMatrix();
  const confuse = gradeIntent(
    { id: "y", transcript: "Dinner with Sam tonight at 7.", expect: { calendar: [{ match: "Sam" }], tasks: [], search: [] } },
    { calendarEvents: [], tasks: [{ title: "Dinner with Sam", sourceText: "Dinner with Sam tonight at 7", uncertain: false }], searchQueries: [] }, m2);
  assert.equal(confuse.pass, false);
  assert.equal(m2.calendar.task, 1, "records calendar->task confusion");

  const m3 = emptyMatrix();
  const extra = gradeIntent(
    { id: "z", transcript: "Just thinking out loud.", expect: { calendar: [], tasks: [], search: [] } },
    { calendarEvents: [], tasks: [{ title: "think", sourceText: "thinking out loud", uncertain: true }], searchQueries: [] }, m3);
  assert.equal(extra.pass, false, "over-generation should fail");
  assert.equal(m3.none.task, 1);

  const m4 = emptyMatrix();
  const fabricated = gradeIntent(
    { id: "s", transcript: "Buy milk.", expect: { calendar: [], tasks: [{ match: "milk" }], search: [] } },
    { calendarEvents: [], tasks: [{ title: "Buy milk", sourceText: "purchase dairy products", uncertain: false }], searchQueries: [] }, m4);
  assert.ok(fabricated.fails.some(f => f.includes("sourceText not in transcript")), "catches fabricated sourceText");

  // explicitCommand: claiming consent the speaker never gave must fail the case
  const m5 = emptyMatrix();
  const ec = gradeIntent(
    { id: "e", transcript: "I need to sweep the floor.", expect: { calendar: [], tasks: [{ match: "sweep", explicitCommand: false }], search: [] } },
    { calendarEvents: [], tasks: [{ title: "Sweep the floor", sourceText: "I need to sweep the floor", uncertain: false, explicitCommand: true }], searchQueries: [] }, m5);
  assert.equal(ec.pass, false, "unconsented explicitCommand should fail");
  const m6 = emptyMatrix();
  const ec2 = gradeIntent(
    { id: "e2", transcript: "I need to sweep the floor, add that to my to do list.", expect: { calendar: [], tasks: [{ match: "sweep", explicitCommand: true }], search: [] } },
    { calendarEvents: [], tasks: [{ title: "Sweep the floor", sourceText: "add that to my to do list", uncertain: false, explicitCommand: true }], searchQueries: [] }, m6);
  assert.equal(ec2.pass, true, "consented explicitCommand should pass");

  const g = gradeTranscriber(
    { expectCaught: [{ match: "tomorow", suggestionIncludes: "tomorrow" }], expectClean: ["grandma"] },
    { words: [{ text: "grandma", confidence: 1 }, { text: "tomorow", confidence: 0.3, alternatives: ["tomorrow"] }] });
  assert.equal(g.pass, true, "flagged word should pass");

  // obvious typo arrives as a correction (not a flag) -> still counts as detected
  const gc = gradeTranscriber(
    { expectCaught: [{ match: "tomorow", suggestionIncludes: "tomorrow" }], expectClean: ["grandma"] },
    { words: [{ text: "grandma", confidence: 1 }, { text: "tomorow", confidence: 1 }], corrections: [{ index: 1, from: "tomorow", to: "tomorrow" }] });
  assert.equal(gc.pass, true, "auto-corrected word counts as detected");

  const gp = gradeTranscriber({ expectCaught: [], expectClean: ["Kubernetes"] }, { words: [{ text: "Kubernetes", confidence: 0.4 }] });
  assert.equal(gp.pass, false, "false positive on clean word should fail");
  assert.equal(gp.cleanFalse, 1);

  // correction router: typo corrected + ambiguous flagged + WER computed
  const cg = gradeCorrection(
    { id: "c", text: "I need to bye a knew phone.", gold: "I need to buy a new phone.",
      expect: { correct: [{ from: "bye", to: "buy" }, { from: "knew", to: "new" }], flag: [] } },
    { corrections: [{ index: 3, from: "bye", to: "buy" }, { index: 5, from: "knew", to: "new" }], words: [] });
  assert.equal(cg.pass, true, "clean correction case should pass");
  assert.equal(cg.wer, 0, "corrected text should match gold -> WER 0");

  // over-correction: touching a clean sentence must fail
  const oc = gradeCorrection(
    { id: "o", text: "Deploy the cluster tonight.", expect: { correct: [], flag: [] } },
    { corrections: [{ index: 1, from: "the", to: "a" }], words: [] });
  assert.equal(oc.pass, false, "over-correction should fail");
  assert.equal(oc.overCorrect, 1);

  // tool-output: good search tiers pass; missing mention + too few sources fail
  const ts = gradeToolOutput(
    { id: "os", query: "tallest?", tags: ["search"], judge: { condensedSentences: [1, 2], inDepthSentences: [4, 7], mustMention: "Elbrus", sourcesMin: 1 } },
    { condensed: "Mount Elbrus is the tallest.", inDepth: "Elbrus is 5642m. It is in Russia. It sits in the Caucasus. It tops the Alps. Many climb it.", sources: [{ uri: "x" }] });
  assert.equal(ts.pass, true, "good search output should pass");
  const tsBad = gradeToolOutput(
    { id: "ob", query: "tallest?", tags: ["search"], judge: { mustMention: "Elbrus", sourcesMin: 2 } },
    { condensed: "Some peak.", inDepth: "No name here.", sources: [] });
  assert.equal(tsBad.pass, false, "missing mention + too few sources should fail");

  // tool-output: calendar item content (title/detail)
  const tc = gradeToolOutput(
    { id: "oc", transcript: "Lunch with Sam.", tags: ["calendar"], judge: { titleMentions: ["Sam"], detailMentions: ["merger"] } },
    { calendarEvents: [{ title: "Lunch with Sam", description: "Discuss the merger", start: "2026-06-30T12:00:00" }], tasks: [], searchQueries: [] });
  assert.equal(tc.pass, true, "good calendar content should pass");

  console.log("eval graders self-check ✓");
}

// ---- entry -----------------------------------------------------------------
const argv = process.argv.slice(2);
const argVal = (name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
if (argv.includes("--selfcheck")) {
  selfCheck();
} else {
  const tags = argVal("--tags")?.split(",").map(s => s.trim()).filter(Boolean);
  runLive({ file: argVal("--file"), tags }).catch(e => { console.error(e); process.exitCode = 1; });
}
