import fs from "fs";
import path from "path";
import crypto from "crypto";

export type AgentLabel =
  | "audio_transcriber"
  | "proofreader"
  | "live_summarizer"
  | "intent_classifier"
  | "memory_answerer"
  | "system"
  | string;

export type StageLabel =
  | "stt"
  | "proofread"
  | "summary"
  | "plan"
  | "memory_recall"
  | "standalone_analyze"
  | string;

export type ModalityLabel = "audio" | "text" | "multimodal";

export interface ModalityTokenDetail {
  modality?: "TEXT" | "AUDIO" | "IMAGE" | string;
  tokenCount?: number;
  [key: string]: any;
}

export interface RawUsageMetadata {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  totalTokenCount?: number;
  thoughtsTokenCount?: number;
  cachedContentTokenCount?: number;
  promptTokensDetails?: ModalityTokenDetail[];
  candidatesTokensDetails?: ModalityTokenDetail[];
  trafficType?: string;
  [key: string]: any;
}

export interface TokenMetricRecord {
  id: string;
  timestamp: string; // ISO string
  timestampMs: number; // Epoch ms

  // Labels & Dimensions
  model: string;
  agent: AgentLabel;
  stage: StageLabel;
  modality: ModalityLabel;
  userId: string;
  sessionId: string;
  status: "success" | "error";
  errorCode?: string;

  // Authoritative Token Counts
  promptTokens: number;
  candidatesTokens: number;
  thoughtsTokens: number;
  cachedTokens: number;
  totalTokens: number;
  audioInputTokens: number;
  textInputTokens: number;

  // Latency & Economics
  durationMs: number;
  costEstimateUsd: number;
}

export interface TimeSeriesPoint {
  timestamp: number; // Bucket start timestamp in ms
  timeLabel: string; // HH:MM format
  promptTokens: number;
  candidatesTokens: number;
  thoughtsTokens: number;
  audioTokens: number;
  totalTokens: number;
  requestCount: number;
  avgDurationMs: number;
  costUsd: number;
}

export interface AggregateDimensionStats {
  tokens: number;
  percent: number;
  requests: number;
  costUsd: number;
}

export interface TokenAggregateStats {
  ok: boolean;
  totalTokens: number;
  totalPromptTokens: number;
  totalCandidatesTokens: number;
  totalThoughtsTokens: number;
  totalAudioTokens: number;
  totalCostUsd: number;
  requestCount: number;
  avgLatencyMs: number;
  byAgent: Record<string, AggregateDimensionStats>;
  byModel: Record<string, AggregateDimensionStats>;
  byModality: Record<string, AggregateDimensionStats>;
  byStage: Record<string, AggregateDimensionStats>;
}

export interface TimeSeriesQueryOptions {
  from?: number; // Epoch ms
  to?: number; // Epoch ms
  interval?: "1s" | "10s" | "1m" | "5m" | "1h";
  agent?: string;
  model?: string;
  sessionId?: string;
}

// Pricing table (USD per 1 Million Tokens)
// Defaults based on standard Gemini 2.0 / 3.7 Flash tiers
const PRICING_PER_MILLION = {
  textInput: 0.075,
  audioInput: 0.7,
  cachedInput: 0.01875,
  candidatesOutput: 0.3,
  thoughtsOutput: 0.3,
};

export function estimateCostUsd(record: {
  textInputTokens: number;
  audioInputTokens: number;
  cachedTokens: number;
  candidatesTokens: number;
  thoughtsTokens: number;
}): number {
  const textCost = (record.textInputTokens / 1_000_000) * PRICING_PER_MILLION.textInput;
  const audioCost = (record.audioInputTokens / 1_000_000) * PRICING_PER_MILLION.audioInput;
  const cachedCost = (record.cachedTokens / 1_000_000) * PRICING_PER_MILLION.cachedInput;
  const outCost = (record.candidatesTokens / 1_000_000) * PRICING_PER_MILLION.candidatesOutput;
  const thoughtCost = (record.thoughtsTokens / 1_000_000) * PRICING_PER_MILLION.thoughtsOutput;

  return Number((textCost + audioCost + cachedCost + outCost + thoughtCost).toFixed(8));
}

export function parseModalityTokens(usage?: RawUsageMetadata): {
  audioTokens: number;
  textTokens: number;
} {
  if (!usage?.promptTokensDetails || !Array.isArray(usage.promptTokensDetails)) {
    const total = usage?.promptTokenCount || 0;
    return { audioTokens: 0, textTokens: total };
  }

  let audio = 0;
  let text = 0;

  for (const detail of usage.promptTokensDetails) {
    if (detail.modality === "AUDIO") {
      audio += detail.tokenCount || 0;
    } else if (detail.modality === "TEXT") {
      text += detail.tokenCount || 0;
    } else {
      text += detail.tokenCount || 0;
    }
  }

  return { audioTokens: audio, textTokens: text };
}

// Global in-memory ring buffer (up to 10,000 recent records)
const MAX_MEMORY_RECORDS = 10000;
const memoryBuffer: TokenMetricRecord[] = [];

// SSE Event subscribers
type StreamListener = (record: TokenMetricRecord) => void;
const streamListeners = new Set<StreamListener>();

export function subscribeTokenStream(listener: StreamListener): () => void {
  streamListeners.add(listener);
  return () => {
    streamListeners.delete(listener);
  };
}

export function getTelemetryDiskPath(
  date: Date,
  root = path.join(process.cwd(), "data", "telemetry", "tokens")
): string {
  const yyyy = String(date.getUTCFullYear());
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(date.getUTCDate()).padStart(2, "0");
  const hh = String(date.getUTCHours()).padStart(2, "0");
  return path.join(root, yyyy, mm, dd, hh, "tokens.jsonl");
}

export function appendTokenRecordToDisk(
  record: TokenMetricRecord,
  root = path.join(process.cwd(), "data", "telemetry", "tokens")
): void {
  try {
    const filePath = getTelemetryDiskPath(new Date(record.timestampMs), root);
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.appendFileSync(filePath, JSON.stringify(record) + "\n", "utf8");
  } catch (err) {
    console.warn("[TokenTelemetry] Failed to persist token record to disk:", err);
  }
}

export function recordTokenUsage(params: {
  model?: string;
  agent?: AgentLabel;
  stage?: StageLabel;
  modality?: ModalityLabel;
  userId?: string;
  sessionId?: string;
  status?: "success" | "error";
  errorCode?: string;
  durationMs?: number;
  usage?: RawUsageMetadata;
  promptTokensFallback?: number;
  candidatesTokensFallback?: number;
  rootDiskDir?: string;
}): TokenMetricRecord {
  const now = Date.now();
  const usage = params.usage || {};
  const { audioTokens, textTokens } = parseModalityTokens(usage);

  const promptTokens = usage.promptTokenCount ?? params.promptTokensFallback ?? 0;
  const candidatesTokens = usage.candidatesTokenCount ?? params.candidatesTokensFallback ?? 0;
  const thoughtsTokens = usage.thoughtsTokenCount ?? 0;
  const cachedTokens = usage.cachedContentTokenCount ?? 0;
  const totalTokens = usage.totalTokenCount ?? (promptTokens + candidatesTokens + thoughtsTokens);

  const cost = estimateCostUsd({
    textInputTokens: textTokens,
    audioInputTokens: audioTokens,
    cachedTokens,
    candidatesTokens,
    thoughtsTokens,
  });

  const record: TokenMetricRecord = {
    id: `tok-${now}-${crypto.randomBytes(4).toString("hex")}`,
    timestamp: new Date(now).toISOString(),
    timestampMs: now,
    model: params.model || process.env.GEMINI_MODEL || "gemini-3.7-flash",
    agent: params.agent || "system",
    stage: params.stage || "standalone",
    modality: params.modality || (audioTokens > 0 ? "audio" : "text"),
    userId: params.userId || "default_user",
    sessionId: params.sessionId || "default_session",
    status: params.status || "success",
    errorCode: params.errorCode,
    promptTokens,
    candidatesTokens,
    thoughtsTokens,
    cachedTokens,
    totalTokens,
    audioInputTokens: audioTokens,
    textInputTokens: textTokens,
    durationMs: Math.max(0, params.durationMs || 0),
    costEstimateUsd: cost,
  };

  // 1. In-memory circular buffer
  memoryBuffer.push(record);
  if (memoryBuffer.length > MAX_MEMORY_RECORDS) {
    memoryBuffer.shift();
  }

  // 2. Persist to disk
  appendTokenRecordToDisk(record, params.rootDiskDir);

  // 3. Broadcast to active SSE listeners
  for (const listener of streamListeners) {
    try {
      listener(record);
    } catch {
      // Ignore listener error
    }
  }

  return record;
}

export function parseIntervalMs(interval: string): number {
  switch (interval) {
    case "1s":
      return 1000;
    case "10s":
      return 10000;
    case "1m":
      return 60000;
    case "5m":
      return 300000;
    case "1h":
      return 3600000;
    default:
      return 60000;
  }
}

export function formatTimeLabel(epochMs: number, interval: string): string {
  const d = new Date(epochMs);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  if (interval === "1s" || interval === "10s") {
    return `${hh}:${mm}:${ss}`;
  }
  return `${hh}:${mm}`;
}

export function queryTokenTimeSeries(
  options: TimeSeriesQueryOptions = {},
  recordsSource: TokenMetricRecord[] = memoryBuffer
): { ok: true; interval: string; points: TimeSeriesPoint[] } {
  const now = Date.now();
  const interval = options.interval || "1m";
  const intervalMs = parseIntervalMs(interval);
  const to = options.to || now;
  const from = options.from || to - 30 * intervalMs; // Default 30 intervals back

  // Filter records
  const filtered = recordsSource.filter((r) => {
    if (r.timestampMs < from || r.timestampMs > to) return false;
    if (options.agent && r.agent !== options.agent) return false;
    if (options.model && r.model !== options.model) return false;
    if (options.sessionId && r.sessionId !== options.sessionId) return false;
    return true;
  });

  // Group into time buckets
  const buckets = new Map<number, {
    promptTokens: number;
    candidatesTokens: number;
    thoughtsTokens: number;
    audioTokens: number;
    totalTokens: number;
    requestCount: number;
    durationSum: number;
    costSum: number;
  }>();

  // Pre-seed all bucket intervals in range so chart is continuous
  const startBucket = Math.floor(from / intervalMs) * intervalMs;
  for (let t = startBucket; t <= to; t += intervalMs) {
    buckets.set(t, {
      promptTokens: 0,
      candidatesTokens: 0,
      thoughtsTokens: 0,
      audioTokens: 0,
      totalTokens: 0,
      requestCount: 0,
      durationSum: 0,
      costSum: 0,
    });
  }

  for (const r of filtered) {
    const bucketTime = Math.floor(r.timestampMs / intervalMs) * intervalMs;
    const bucket = buckets.get(bucketTime);
    if (bucket) {
      bucket.promptTokens += r.promptTokens;
      bucket.candidatesTokens += r.candidatesTokens;
      bucket.thoughtsTokens += r.thoughtsTokens;
      bucket.audioTokens += r.audioInputTokens;
      bucket.totalTokens += r.totalTokens;
      bucket.requestCount += 1;
      bucket.durationSum += r.durationMs;
      bucket.costSum += r.costEstimateUsd;
    }
  }

  const points: TimeSeriesPoint[] = Array.from(buckets.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([ts, b]) => ({
      timestamp: ts,
      timeLabel: formatTimeLabel(ts, interval),
      promptTokens: b.promptTokens,
      candidatesTokens: b.candidatesTokens,
      thoughtsTokens: b.thoughtsTokens,
      audioTokens: b.audioTokens,
      totalTokens: b.totalTokens,
      requestCount: b.requestCount,
      avgDurationMs: b.requestCount > 0 ? Math.round(b.durationSum / b.requestCount) : 0,
      costUsd: Number(b.costSum.toFixed(6)),
    }));

  return { ok: true, interval, points };
}

export function queryTokenAggregate(
  options: { from?: number; to?: number; sessionId?: string } = {},
  recordsSource: TokenMetricRecord[] = memoryBuffer
): TokenAggregateStats {
  const now = Date.now();
  const to = options.to || now;
  const from = options.from || 0; // Default all history in buffer

  const filtered = recordsSource.filter((r) => {
    if (r.timestampMs < from || r.timestampMs > to) return false;
    if (options.sessionId && r.sessionId !== options.sessionId) return false;
    return true;
  });

  let totalTokens = 0;
  let totalPromptTokens = 0;
  let totalCandidatesTokens = 0;
  let totalThoughtsTokens = 0;
  let totalAudioTokens = 0;
  let totalCostUsd = 0;
  let totalDurationMs = 0;

  const agentMap = new Map<string, { tokens: number; requests: number; cost: number }>();
  const modelMap = new Map<string, { tokens: number; requests: number; cost: number }>();
  const modalityMap = new Map<string, { tokens: number; requests: number; cost: number }>();
  const stageMap = new Map<string, { tokens: number; requests: number; cost: number }>();

  const accumulate = (map: Map<string, { tokens: number; requests: number; cost: number }>, key: string, r: TokenMetricRecord) => {
    const curr = map.get(key) || { tokens: 0, requests: 0, cost: 0 };
    curr.tokens += r.totalTokens;
    curr.requests += 1;
    curr.cost += r.costEstimateUsd;
    map.set(key, curr);
  };

  for (const r of filtered) {
    totalTokens += r.totalTokens;
    totalPromptTokens += r.promptTokens;
    totalCandidatesTokens += r.candidatesTokens;
    totalThoughtsTokens += r.thoughtsTokens;
    totalAudioTokens += r.audioInputTokens;
    totalCostUsd += r.costEstimateUsd;
    totalDurationMs += r.durationMs;

    accumulate(agentMap, r.agent, r);
    accumulate(modelMap, r.model, r);
    accumulate(modalityMap, r.modality, r);
    accumulate(stageMap, r.stage, r);
  }

  const buildDimStats = (map: Map<string, { tokens: number; requests: number; cost: number }>) => {
    const res: Record<string, AggregateDimensionStats> = {};
    for (const [k, v] of map.entries()) {
      res[k] = {
        tokens: v.tokens,
        percent: totalTokens > 0 ? Number(((v.tokens / totalTokens) * 100).toFixed(1)) : 0,
        requests: v.requests,
        costUsd: Number(v.cost.toFixed(6)),
      };
    }
    return res;
  };

  return {
    ok: true,
    totalTokens,
    totalPromptTokens,
    totalCandidatesTokens,
    totalThoughtsTokens,
    totalAudioTokens,
    totalCostUsd: Number(totalCostUsd.toFixed(6)),
    requestCount: filtered.length,
    avgLatencyMs: filtered.length > 0 ? Math.round(totalDurationMs / filtered.length) : 0,
    byAgent: buildDimStats(agentMap),
    byModel: buildDimStats(modelMap),
    byModality: buildDimStats(modalityMap),
    byStage: buildDimStats(stageMap),
  };
}

export function clearMemoryBuffer(): void {
  memoryBuffer.length = 0;
}

export function getMemoryBufferSnapshot(): TokenMetricRecord[] {
  return [...memoryBuffer];
}

// Self-check suite
if (import.meta.url && import.meta.url === `file://${process.argv[1]}`) {
  console.log("Running token-telemetry self-check...");
  const assert = (cond: any, msg: string) => {
    if (!cond) throw new Error("Assertion failed: " + msg);
  };

  const testRoot = path.join(process.cwd(), "data", "test-telemetry-" + Date.now());
  try {
    clearMemoryBuffer();

    // 1. Test record creation with modality breakdown
    const rec1 = recordTokenUsage({
      model: "gemini-3.7-flash",
      agent: "audio_transcriber",
      stage: "stt",
      modality: "audio",
      durationMs: 350,
      usage: {
        promptTokenCount: 300,
        candidatesTokenCount: 25,
        thoughtsTokenCount: 0,
        totalTokenCount: 325,
        promptTokensDetails: [
          { modality: "AUDIO", tokenCount: 250 },
          { modality: "TEXT", tokenCount: 50 },
        ],
        candidatesTokensDetails: [{ modality: "TEXT", tokenCount: 25 }],
      },
      rootDiskDir: testRoot,
    });

    assert(rec1.promptTokens === 300, "promptTokens should match");
    assert(rec1.audioInputTokens === 250, "audio tokens should match 250");
    assert(rec1.textInputTokens === 50, "text tokens should match 50");
    assert(rec1.costEstimateUsd > 0, "costEstimateUsd should be positive");

    // 2. Test text reasoning agent with thoughts
    const rec2 = recordTokenUsage({
      model: "gemini-3.7-flash",
      agent: "intent_classifier",
      stage: "plan",
      modality: "text",
      durationMs: 650,
      usage: {
        promptTokenCount: 400,
        candidatesTokenCount: 80,
        thoughtsTokenCount: 150,
        totalTokenCount: 630,
        promptTokensDetails: [{ modality: "TEXT", tokenCount: 400 }],
        candidatesTokensDetails: [{ modality: "TEXT", tokenCount: 80 }],
      },
      rootDiskDir: testRoot,
    });

    assert(rec2.thoughtsTokens === 150, "thoughtsTokens should be 150");
    assert(rec2.totalTokens === 630, "totalTokens should be 630");

    // 3. Test Time-Series Query
    const tsRes = queryTokenTimeSeries({ interval: "1m" });
    assert(tsRes.ok === true, "time-series response should be ok");
    assert(tsRes.points.length > 0, "should have time points");
    const activePoint = tsRes.points.find((p) => p.requestCount > 0);
    assert(activePoint !== undefined, "should have active bucket");
    assert(activePoint!.totalTokens === 325 + 630, "active point tokens should sum to 955");
    assert(activePoint!.audioTokens === 250, "active point audio tokens should be 250");

    // 4. Test Aggregate Query
    const aggRes = queryTokenAggregate();
    assert(aggRes.totalTokens === 955, "aggregate totalTokens should match 955");
    assert(aggRes.totalAudioTokens === 250, "aggregate audioTokens should match 250");
    assert(aggRes.requestCount === 2, "aggregate requestCount should be 2");
    assert(aggRes.byAgent["audio_transcriber"] !== undefined, "byAgent should include audio_transcriber");
    assert(aggRes.byAgent["intent_classifier"] !== undefined, "byAgent should include intent_classifier");

    // 5. Test SSE Subscriber
    let streamReceived = false;
    const unsub = subscribeTokenStream((rec) => {
      if (rec.id.startsWith("tok-")) streamReceived = true;
    });
    recordTokenUsage({
      model: "gemini-3.7-flash",
      agent: "proofreader",
      stage: "proofread",
      usage: { promptTokenCount: 50, candidatesTokenCount: 10 },
      rootDiskDir: testRoot,
    });
    unsub();
    assert(Boolean(streamReceived), "SSE subscriber should receive record");

    console.log("token-telemetry self-check ✓");
  } finally {
    if (fs.existsSync(testRoot)) {
      fs.rmSync(testRoot, { recursive: true, force: true });
    }
  }
}
