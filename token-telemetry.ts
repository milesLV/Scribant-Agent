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

  // Invocation Metadata & Telemetry Tags
  diarizationEnabled?: boolean;
  provider?: "gemini" | "google_cloud_stt" | string;
  source?: "mic" | "tab" | "upload" | "pipeline" | string;
  metadata?: Record<string, any>;
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
  byDiarization: Record<string, AggregateDimensionStats>;
  byProvider: Record<string, AggregateDimensionStats>;
}

export interface TimeSeriesQueryOptions {
  from?: number; // Epoch ms
  to?: number; // Epoch ms
  interval?: "1s" | "10s" | "30s" | "1m" | "5m" | "15m" | "30m" | "1h" | "4h" | "1d" | "24h" | "7d" | string;
  agent?: string;
  model?: string;
  sessionId?: string;
  diarizationEnabled?: boolean;
  provider?: string;
  source?: string;
  modality?: string;
  stage?: string;
  rootDiskDir?: string;
}

// Official Google Gemini API Pricing Table (USD per 1 Million Tokens)
// Based on Google AI Developer (ai.google.dev) official pricing schedules
export interface ModelPricingTier {
  textInput: number; // USD per 1M tokens
  audioInput: number; // USD per 1M tokens (32 tokens/sec encoding)
  cachedInput: number; // USD per 1M tokens (context caching)
  candidatesOutput: number; // USD per 1M tokens
  thoughtsOutput: number; // USD per 1M tokens (billed at candidate output rate)
}

export const MODEL_PRICING_REGISTRY: Record<string, ModelPricingTier> = {
  // Gemini 3.7 Flash (Active intro tier)
  "gemini-3.7-flash": {
    textInput: 0.75,
    audioInput: 0.75,
    cachedInput: 0.1875,
    candidatesOutput: 3.75,
    thoughtsOutput: 3.75,
  },
  // Gemini 3.6 Flash / 3.5 Flash (Standard tier)
  "gemini-3.6-flash": {
    textInput: 1.5,
    audioInput: 1.5,
    cachedInput: 0.375,
    candidatesOutput: 7.5,
    thoughtsOutput: 7.5,
  },
  "gemini-3.5-flash": {
    textInput: 1.5,
    audioInput: 1.5,
    cachedInput: 0.375,
    candidatesOutput: 9.0,
    thoughtsOutput: 9.0,
  },
  // Gemini 3.1 Flash-Lite
  "gemini-3.1-flash-lite": {
    textInput: 0.25,
    audioInput: 0.5,
    cachedInput: 0.0625,
    candidatesOutput: 1.5,
    thoughtsOutput: 1.5,
  },
  // Gemini 2.5 Flash
  "gemini-2.5-flash": {
    textInput: 0.3,
    audioInput: 0.7,
    cachedInput: 0.075,
    candidatesOutput: 2.5,
    thoughtsOutput: 2.5,
  },
};

export const DEFAULT_PRICING_TIER: ModelPricingTier = MODEL_PRICING_REGISTRY["gemini-3.7-flash"];

export function getPricingTierForModel(modelName?: string): ModelPricingTier {
  if (!modelName) return DEFAULT_PRICING_TIER;
  const normalized = modelName.toLowerCase().trim();
  for (const [key, tier] of Object.entries(MODEL_PRICING_REGISTRY)) {
    if (normalized.includes(key)) return tier;
  }
  return DEFAULT_PRICING_TIER;
}

export function estimateCostUsd(
  record: {
    textInputTokens: number;
    audioInputTokens: number;
    cachedTokens: number;
    candidatesTokens: number;
    thoughtsTokens: number;
  },
  modelName?: string
): number {
  const tier = getPricingTierForModel(modelName);
  const textCost = (record.textInputTokens / 1_000_000) * tier.textInput;
  const audioCost = (record.audioInputTokens / 1_000_000) * tier.audioInput;
  const cachedCost = (record.cachedTokens / 1_000_000) * tier.cachedInput;
  const outCost = (record.candidatesTokens / 1_000_000) * tier.candidatesOutput;
  const thoughtCost = (record.thoughtsTokens / 1_000_000) * tier.thoughtsOutput;

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
  diarizationEnabled?: boolean;
  provider?: "gemini" | "google_cloud_stt" | string;
  source?: "mic" | "tab" | "upload" | "pipeline" | string;
  metadata?: Record<string, any>;
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

  const modelName = params.model || process.env.GEMINI_MODEL || "gemini-3.7-flash";
  const cost = estimateCostUsd(
    {
      textInputTokens: textTokens,
      audioInputTokens: audioTokens,
      cachedTokens,
      candidatesTokens,
      thoughtsTokens,
    },
    modelName
  );

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
    diarizationEnabled: params.diarizationEnabled,
    provider: params.provider || (params.agent === "google_cloud_stt" ? "google_cloud_stt" : "gemini"),
    source: params.source,
    metadata: params.metadata,
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

export function readDiskRecordsInRange(
  from: number,
  to: number,
  root = path.join(process.cwd(), "data", "telemetry", "tokens")
): TokenMetricRecord[] {
  if (!fs.existsSync(root)) return [];
  const records: TokenMetricRecord[] = [];
  const seenIds = new Set<string>();

  // Iterate hour by hour from 'from' to 'to'
  const ONE_HOUR = 3600000;
  const startHour = Math.floor(from / ONE_HOUR) * ONE_HOUR;
  const endHour = Math.floor(to / ONE_HOUR) * ONE_HOUR;

  for (let t = startHour; t <= endHour; t += ONE_HOUR) {
    const filePath = getTelemetryDiskPath(new Date(t), root);
    if (fs.existsSync(filePath)) {
      try {
        const content = fs.readFileSync(filePath, "utf8");
        const lines = content.split("\n");
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const rec = JSON.parse(line) as TokenMetricRecord;
            if (rec.id && !seenIds.has(rec.id) && rec.timestampMs >= from && rec.timestampMs <= to) {
              seenIds.add(rec.id);
              records.push(rec);
            }
          } catch {}
        }
      } catch (err) {
        console.warn("[TokenTelemetry] Failed to read disk partition:", filePath, err);
      }
    }
  }

  return records;
}

export function getCombinedRecords(
  from: number,
  to: number,
  recordsSource: TokenMetricRecord[] = memoryBuffer,
  rootDiskDir?: string
): TokenMetricRecord[] {
  const diskRecords = readDiskRecordsInRange(from, to, rootDiskDir);
  const seenIds = new Set<string>();
  const combined: TokenMetricRecord[] = [];

  // Add disk records first
  for (const r of diskRecords) {
    if (r.id && !seenIds.has(r.id)) {
      seenIds.add(r.id);
      combined.push(r);
    }
  }

  // Add in-memory records
  for (const r of recordsSource) {
    if (r.timestampMs >= from && r.timestampMs <= to && (!r.id || !seenIds.has(r.id))) {
      if (r.id) seenIds.add(r.id);
      combined.push(r);
    }
  }

  return combined;
}

export function parseIntervalMs(interval: string): number {
  switch (interval) {
    case "1s":
      return 1000;
    case "10s":
      return 10000;
    case "30s":
      return 30000;
    case "1m":
      return 60000;
    case "5m":
      return 300000;
    case "15m":
      return 900000;
    case "30m":
      return 1800000;
    case "1h":
      return 3600000;
    case "4h":
      return 14400000;
    case "1d":
    case "24h":
      return 86400000;
    case "7d":
      return 604800000;
    default:
      return 60000;
  }
}

export function formatTimeLabel(epochMs: number, interval: string): string {
  const d = new Date(epochMs);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const min = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");

  if (interval === "1s" || interval === "10s" || interval === "30s") {
    return `${hh}:${min}:${ss}`;
  }
  if (interval === "1d" || interval === "24h" || interval === "7d") {
    return `${mm}/${dd}`;
  }
  if (interval === "4h" || interval === "1h" || interval === "30m") {
    return `${mm}/${dd} ${hh}:${min}`;
  }
  return `${hh}:${min}`;
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

  // Get combined records from disk and memory
  const allRecords = getCombinedRecords(from, to, recordsSource, options.rootDiskDir);

  // Filter records
  const filtered = allRecords.filter((r) => {
    if (r.timestampMs < from || r.timestampMs > to) return false;
    if (options.agent && r.agent !== options.agent) return false;
    if (options.model && r.model !== options.model) return false;
    if (options.sessionId && r.sessionId !== options.sessionId) return false;
    if (options.diarizationEnabled !== undefined && Boolean(r.diarizationEnabled) !== options.diarizationEnabled) return false;
    if (options.provider && (r.provider || "gemini") !== options.provider) return false;
    if (options.source && r.source !== options.source) return false;
    if (options.modality && r.modality !== options.modality) return false;
    if (options.stage && r.stage !== options.stage) return false;
    return true;
  });

  // Group into time buckets
  const buckets = new Map<
    number,
    {
      promptTokens: number;
      candidatesTokens: number;
      thoughtsTokens: number;
      audioTokens: number;
      totalTokens: number;
      requestCount: number;
      durationSum: number;
      costSum: number;
    }
  >();

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
  options: {
    from?: number;
    to?: number;
    sessionId?: string;
    diarizationEnabled?: boolean;
    provider?: string;
    source?: string;
    rootDiskDir?: string;
  } = {},
  recordsSource: TokenMetricRecord[] = memoryBuffer
): TokenAggregateStats {
  const now = Date.now();
  const to = options.to || now;
  const from = options.from || 0; // Default all history in buffer

  const allRecords = getCombinedRecords(from, to, recordsSource, options.rootDiskDir);

  const filtered = allRecords.filter((r) => {
    if (r.timestampMs < from || r.timestampMs > to) return false;
    if (options.sessionId && r.sessionId !== options.sessionId) return false;
    if (options.diarizationEnabled !== undefined && Boolean(r.diarizationEnabled) !== options.diarizationEnabled) return false;
    if (options.provider && (r.provider || "gemini") !== options.provider) return false;
    if (options.source && r.source !== options.source) return false;
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
  const diarizationMap = new Map<string, { tokens: number; requests: number; cost: number }>();
  const providerMap = new Map<string, { tokens: number; requests: number; cost: number }>();

  const accumulate = (
    map: Map<string, { tokens: number; requests: number; cost: number }>,
    key: string,
    r: TokenMetricRecord
  ) => {
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
    accumulate(diarizationMap, r.diarizationEnabled ? "diarized" : "non_diarized", r);
    accumulate(providerMap, r.provider || (r.agent === "google_cloud_stt" ? "google_cloud_stt" : "gemini"), r);
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
    byDiarization: buildDimStats(diarizationMap),
    byProvider: buildDimStats(providerMap),
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

    // 1. Test record creation with modality breakdown and diarization metadata
    const rec1 = recordTokenUsage({
      model: "gemini-3.7-flash",
      agent: "audio_transcriber",
      stage: "stt",
      modality: "audio",
      durationMs: 350,
      diarizationEnabled: true,
      provider: "google_cloud_stt",
      source: "mic",
      metadata: { speakerCount: 3, wordCount: 45 },
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
    assert(rec1.diarizationEnabled === true, "diarizationEnabled should be true");
    assert(rec1.provider === "google_cloud_stt", "provider should be google_cloud_stt");
    assert(rec1.metadata?.speakerCount === 3, "metadata speakerCount should be 3");

    // 2. Test text reasoning agent with thoughts (non-diarized)
    const rec2 = recordTokenUsage({
      model: "gemini-3.7-flash",
      agent: "intent_classifier",
      stage: "plan",
      modality: "text",
      durationMs: 650,
      diarizationEnabled: false,
      provider: "gemini",
      source: "pipeline",
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
    assert(rec2.diarizationEnabled === false, "diarizationEnabled should be false");

    // 3. Test Time-Series Query with and without diarization filter
    const tsRes = queryTokenTimeSeries({ interval: "1m", rootDiskDir: testRoot });
    assert(tsRes.ok === true, "time-series response should be ok");
    assert(tsRes.points.length > 0, "should have time points");
    const activePoint = tsRes.points.find((p) => p.requestCount > 0);
    assert(activePoint !== undefined, "should have active bucket");
    assert(activePoint!.totalTokens === 325 + 630, "active point tokens should sum to 955");
    assert(activePoint!.audioTokens === 250, "active point audio tokens should be 250");

    const tsDiarizedOnly = queryTokenTimeSeries({ interval: "1m", diarizationEnabled: true, rootDiskDir: testRoot });
    const diarizedPoint = tsDiarizedOnly.points.find((p) => p.requestCount > 0);
    assert(diarizedPoint?.totalTokens === 325, "diarized-only filter should only include 325 tokens");

    // 4. Test Aggregate Query with byDiarization and byProvider
    const aggRes = queryTokenAggregate({ rootDiskDir: testRoot });
    assert(aggRes.totalTokens === 955, "aggregate totalTokens should match 955");
    assert(aggRes.totalAudioTokens === 250, "aggregate audioTokens should match 250");
    assert(aggRes.requestCount === 2, "aggregate requestCount should be 2");
    assert(aggRes.byAgent["audio_transcriber"] !== undefined, "byAgent should include audio_transcriber");
    assert(aggRes.byAgent["intent_classifier"] !== undefined, "byAgent should include intent_classifier");
    assert(aggRes.byDiarization["diarized"]?.tokens === 325, "byDiarization diarized should be 325 tokens");
    assert(aggRes.byDiarization["non_diarized"]?.tokens === 630, "byDiarization non_diarized should be 630 tokens");
    assert(aggRes.byProvider["google_cloud_stt"]?.requests === 1, "byProvider google_cloud_stt should have 1 request");
    assert(aggRes.byProvider["gemini"]?.requests === 1, "byProvider gemini should have 1 request");

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

    // 6. Test Disk Range History Retrieval
    const diskRecords = readDiskRecordsInRange(Date.now() - 3600000, Date.now() + 1000, testRoot);
    assert(diskRecords.length === 3, "should have read 3 records from disk partition");

    console.log("token-telemetry self-check ✓");
  } finally {
    if (fs.existsSync(testRoot)) {
      fs.rmSync(testRoot, { recursive: true, force: true });
    }
  }
}
