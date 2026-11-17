import fs from "fs";
import path from "path";
import crypto from "crypto";

export type ModalityLabel = "audio" | "text" | "multimodal";

// Gemini usageMetadata as ADK hands it over.
export interface RawUsageMetadata {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  totalTokenCount?: number;
  thoughtsTokenCount?: number;
  cachedContentTokenCount?: number;
  promptTokensDetails?: { modality?: string; tokenCount?: number }[];
  [key: string]: any;
}

export interface TokenMetricRecord {
  id: string;
  timestamp: string;
  timestampMs: number;
  model: string;
  agent: string;
  stage: string;
  modality: ModalityLabel;
  userId: string;
  sessionId: string;
  status: "success" | "error";
  errorCode?: string;
  promptTokens: number;
  candidatesTokens: number;
  thoughtsTokens: number;
  cachedTokens: number;
  totalTokens: number;
  audioInputTokens: number;
  textInputTokens: number;
  durationMs: number;
  costEstimateUsd: number;
  diarizationEnabled?: boolean;
  provider?: string;
  source?: string;
  metadata?: Record<string, any>;
}

export interface TimeSeriesPoint {
  timestamp: number; // bucket start, epoch ms
  timeLabel: string;
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

interface RecordFilter {
  from?: number;
  to?: number;
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

// USD per 1M tokens: [text in, audio in, cached in, output (thoughts bill at the output rate)].
// ponytail: hand-copied price sheet; matched by substring of the model name, first hit wins.
const PRICING: Record<string, [number, number, number, number]> = {
  "gemini-3.7-flash": [0.75, 0.75, 0.1875, 3.75],
  "gemini-3.6-flash": [1.5, 1.5, 0.375, 7.5],
  "gemini-3.5-flash": [1.5, 1.5, 0.375, 9.0],
  "gemini-3.1-flash-lite": [0.25, 0.5, 0.0625, 1.5],
  "gemini-2.5-flash": [0.3, 0.7, 0.075, 2.5],
};

function estimateCostUsd(r: Pick<TokenMetricRecord, "textInputTokens" | "audioInputTokens" | "cachedTokens" | "candidatesTokens" | "thoughtsTokens">, model: string): number {
  const name = model.toLowerCase();
  const [text, audio, cached, out] = Object.entries(PRICING).find(([k]) => name.includes(k))?.[1] ?? PRICING["gemini-3.7-flash"];
  const usd = r.textInputTokens * text + r.audioInputTokens * audio + r.cachedTokens * cached + (r.candidatesTokens + r.thoughtsTokens) * out;
  return Number((usd / 1_000_000).toFixed(8));
}

const MAX_MEMORY_RECORDS = 10000;
const memoryBuffer: TokenMetricRecord[] = [];

type StreamListener = (record: TokenMetricRecord) => void;
const streamListeners = new Set<StreamListener>();

export function subscribeTokenStream(listener: StreamListener): () => void {
  streamListeners.add(listener);
  return () => { streamListeners.delete(listener); };
}

const DISK_ROOT = path.join(process.cwd(), "data", "telemetry", "tokens");

// data/telemetry/tokens/YYYY/MM/DD/HH/tokens.jsonl, UTC.
const diskPath = (date: Date, root = DISK_ROOT) =>
  path.join(root, ...date.toISOString().slice(0, 13).split(/[-T]/), "tokens.jsonl");

export function recordTokenUsage(params: {
  model?: string;
  agent?: string;
  stage?: string;
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
  provider?: string;
  source?: string;
  metadata?: Record<string, any>;
  rootDiskDir?: string;
}): TokenMetricRecord {
  const now = Date.now();
  const usage = params.usage || {};
  const details = usage.promptTokensDetails;
  const audioTokens = Array.isArray(details) ? details.reduce((n, d) => n + (d.modality === "AUDIO" ? d.tokenCount || 0 : 0), 0) : 0;
  const textTokens = Array.isArray(details) ? details.reduce((n, d) => n + (d.modality !== "AUDIO" ? d.tokenCount || 0 : 0), 0) : usage.promptTokenCount || 0;

  const promptTokens = usage.promptTokenCount ?? params.promptTokensFallback ?? 0;
  const candidatesTokens = usage.candidatesTokenCount ?? params.candidatesTokensFallback ?? 0;
  const thoughtsTokens = usage.thoughtsTokenCount ?? 0;
  const cachedTokens = usage.cachedContentTokenCount ?? 0;
  const model = params.model || process.env.GEMINI_MODEL || "gemini-3.7-flash";
  const counts = { textInputTokens: textTokens, audioInputTokens: audioTokens, cachedTokens, candidatesTokens, thoughtsTokens };

  const record: TokenMetricRecord = {
    id: `tok-${now}-${crypto.randomBytes(4).toString("hex")}`,
    timestamp: new Date(now).toISOString(),
    timestampMs: now,
    model,
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
    totalTokens: usage.totalTokenCount ?? promptTokens + candidatesTokens + thoughtsTokens,
    ...counts,
    durationMs: Math.max(0, params.durationMs || 0),
    costEstimateUsd: estimateCostUsd(counts, model),
    diarizationEnabled: params.diarizationEnabled,
    provider: params.provider || (params.agent === "google_cloud_stt" ? "google_cloud_stt" : "gemini"),
    source: params.source,
    metadata: params.metadata,
  };

  memoryBuffer.push(record);
  if (memoryBuffer.length > MAX_MEMORY_RECORDS) memoryBuffer.shift();

  try {
    const file = diskPath(new Date(now), params.rootDiskDir);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(record) + "\n", "utf8");
  } catch (err) {
    console.warn("[TokenTelemetry] Failed to persist token record to disk:", err);
  }

  for (const listener of streamListeners) {
    try { listener(record); } catch { /* one bad subscriber must not break recording */ }
  }
  return record;
}

// Hour partitions overlapping [from, to]. Unparseable lines are skipped.
export function readDiskRecordsInRange(from: number, to: number, root = DISK_ROOT): TokenMetricRecord[] {
  const HOUR = 3_600_000;
  const out: TokenMetricRecord[] = [];
  for (let t = Math.floor(from / HOUR) * HOUR; t <= to; t += HOUR) {
    const file = diskPath(new Date(t), root);
    if (!fs.existsSync(file)) continue;
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      try {
        const rec = line.trim() && (JSON.parse(line) as TokenMetricRecord);
        if (rec && rec.timestampMs >= from && rec.timestampMs <= to) out.push(rec);
      } catch { /* torn write */ }
    }
  }
  return out;
}

// Disk + in-memory records in range, deduped by id (recent records are in both), then filtered.
function selectRecords(o: RecordFilter, from: number, to: number, source: TokenMetricRecord[]): TokenMetricRecord[] {
  const seen = new Set<string>();
  return [...readDiskRecordsInRange(from, to, o.rootDiskDir), ...source].filter(r => {
    if (r.id) { if (seen.has(r.id)) return false; seen.add(r.id); }
    return r.timestampMs >= from && r.timestampMs <= to
      && (!o.agent || r.agent === o.agent)
      && (!o.model || r.model === o.model)
      && (!o.sessionId || r.sessionId === o.sessionId)
      && (o.diarizationEnabled === undefined || Boolean(r.diarizationEnabled) === o.diarizationEnabled)
      && (!o.provider || (r.provider || "gemini") === o.provider)
      && (!o.source || r.source === o.source)
      && (!o.modality || r.modality === o.modality)
      && (!o.stage || r.stage === o.stage);
  });
}

const INTERVAL_MS: Record<string, number> = {
  "1s": 1e3, "10s": 1e4, "30s": 3e4, "1m": 6e4, "5m": 3e5, "15m": 9e5, "30m": 18e5,
  "1h": 36e5, "4h": 144e5, "1d": 864e5, "24h": 864e5, "7d": 6048e5,
};

function formatTimeLabel(epochMs: number, interval: string): string {
  const d = new Date(epochMs);
  const p = (n: number) => String(n).padStart(2, "0");
  const date = `${p(d.getMonth() + 1)}/${p(d.getDate())}`;
  const time = `${p(d.getHours())}:${p(d.getMinutes())}`;
  if (/s$/.test(interval)) return `${time}:${p(d.getSeconds())}`;
  if (/d$|24h/.test(interval)) return date;
  if (/^(4h|1h|30m)$/.test(interval)) return `${date} ${time}`;
  return time;
}

export function queryTokenTimeSeries(
  options: RecordFilter & { interval?: string } = {},
  recordsSource: TokenMetricRecord[] = memoryBuffer
): { ok: true; interval: string; points: TimeSeriesPoint[] } {
  const interval = options.interval || "1m";
  const intervalMs = INTERVAL_MS[interval] ?? 6e4;
  const to = options.to || Date.now();
  const from = options.from || to - 30 * intervalMs;

  // Pre-seed every bucket in range so the chart has no gaps.
  const buckets = new Map<number, TimeSeriesPoint & { durationSum: number }>();
  for (let t = Math.floor(from / intervalMs) * intervalMs; t <= to; t += intervalMs) {
    buckets.set(t, { timestamp: t, timeLabel: formatTimeLabel(t, interval), promptTokens: 0, candidatesTokens: 0, thoughtsTokens: 0, audioTokens: 0, totalTokens: 0, requestCount: 0, avgDurationMs: 0, costUsd: 0, durationSum: 0 });
  }
  for (const r of selectRecords(options, from, to, recordsSource)) {
    const b = buckets.get(Math.floor(r.timestampMs / intervalMs) * intervalMs);
    if (!b) continue;
    b.promptTokens += r.promptTokens;
    b.candidatesTokens += r.candidatesTokens;
    b.thoughtsTokens += r.thoughtsTokens;
    b.audioTokens += r.audioInputTokens;
    b.totalTokens += r.totalTokens;
    b.requestCount++;
    b.durationSum += r.durationMs;
    b.costUsd += r.costEstimateUsd;
  }
  const points = [...buckets.values()].map(({ durationSum, ...b }) => ({
    ...b,
    avgDurationMs: b.requestCount ? Math.round(durationSum / b.requestCount) : 0,
    costUsd: Number(b.costUsd.toFixed(6)),
  }));
  return { ok: true, interval, points };
}

export function queryTokenAggregate(
  options: Pick<RecordFilter, "from" | "to" | "sessionId" | "diarizationEnabled" | "provider" | "source" | "rootDiskDir"> = {},
  recordsSource: TokenMetricRecord[] = memoryBuffer
): TokenAggregateStats {
  const to = options.to || Date.now();
  const records = selectRecords(options, options.from || 0, to, recordsSource);
  const sum = (f: (r: TokenMetricRecord) => number) => records.reduce((n, r) => n + f(r), 0);
  const totalTokens = sum(r => r.totalTokens);

  const by = (key: (r: TokenMetricRecord) => string) => {
    const acc: Record<string, AggregateDimensionStats> = {};
    for (const r of records) {
      const a = (acc[key(r)] ??= { tokens: 0, percent: 0, requests: 0, costUsd: 0 });
      a.tokens += r.totalTokens;
      a.requests++;
      a.costUsd += r.costEstimateUsd;
    }
    for (const a of Object.values(acc)) {
      a.percent = totalTokens > 0 ? Number(((a.tokens / totalTokens) * 100).toFixed(1)) : 0;
      a.costUsd = Number(a.costUsd.toFixed(6));
    }
    return acc;
  };

  return {
    ok: true,
    totalTokens,
    totalPromptTokens: sum(r => r.promptTokens),
    totalCandidatesTokens: sum(r => r.candidatesTokens),
    totalThoughtsTokens: sum(r => r.thoughtsTokens),
    totalAudioTokens: sum(r => r.audioInputTokens),
    totalCostUsd: Number(sum(r => r.costEstimateUsd).toFixed(6)),
    requestCount: records.length,
    avgLatencyMs: records.length ? Math.round(sum(r => r.durationMs) / records.length) : 0,
    byAgent: by(r => r.agent),
    byModel: by(r => r.model),
    byModality: by(r => r.modality),
    byStage: by(r => r.stage),
    byDiarization: by(r => (r.diarizationEnabled ? "diarized" : "non_diarized")),
    byProvider: by(r => r.provider || (r.agent === "google_cloud_stt" ? "google_cloud_stt" : "gemini")),
  };
}

export function getMemoryBufferSnapshot(): TokenMetricRecord[] {
  return [...memoryBuffer];
}

// Self-check suite
if (import.meta.url === `file://${process.argv[1]}`) {
  console.log("Running token-telemetry self-check...");
  const assert = (cond: any, msg: string) => {
    if (!cond) throw new Error("Assertion failed: " + msg);
  };

  const testRoot = path.join(process.cwd(), "data", "test-telemetry-" + Date.now());
  try {

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
    fs.rmSync(testRoot, { recursive: true, force: true });
  }
}
