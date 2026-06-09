import { Redis } from "@upstash/redis";

import type { Forecast, Snapshot } from "./types";

export type PredictionRecord = {
  kind: "prediction";
  chance: number;
  window: string;
  at: string;
};

export type ResetRecord = {
  kind: "reset";
  at: string;
};

export type HistoryEntry = PredictionRecord | ResetRecord;

const LATEST_KEY = "oracle:latest";
const HISTORY_KEY = "oracle:history";
const HIGH_FLAG_KEY = "oracle:high-active";
const HIGH_CHANCE_THRESHOLD = 80;
const HIGH_FLAG_TTL_SECONDS = 6 * 60 * 60;
const HISTORY_LIMIT = 100;

let cachedClient: Redis | null = null;

function redis(): Redis | null {
  if (cachedClient) return cachedClient;

  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;

  cachedClient = new Redis({ url, token });
  return cachedClient;
}

export function kvEnabled(): boolean {
  return redis() !== null;
}

export async function storeLatestSnapshot(snapshot: Snapshot): Promise<void> {
  const client = redis();
  if (!client) return;
  await client.set(LATEST_KEY, snapshot);
}

export async function readLatestSnapshot(): Promise<Snapshot | null> {
  const client = redis();
  if (!client) return null;
  return (await client.get<Snapshot>(LATEST_KEY)) ?? null;
}

/**
 * Append a "high reset chance" prediction record, but only when we first enter a
 * high-chance window — a short-lived flag prevents the same spike from being logged
 * repeatedly on every refresh. Returns true if a new record was written.
 */
export async function maybeRecordPrediction(forecast: Forecast): Promise<boolean> {
  const client = redis();
  if (!client) return false;

  if (forecast.chance < HIGH_CHANCE_THRESHOLD) {
    await client.del(HIGH_FLAG_KEY);
    return false;
  }

  const alreadyActive = await client.get(HIGH_FLAG_KEY);
  if (alreadyActive) return false;

  const record: PredictionRecord = {
    kind: "prediction",
    chance: forecast.chance,
    window: forecast.window,
    at: forecast.generatedAt || new Date().toISOString()
  };

  await client.lpush(HISTORY_KEY, record);
  await client.ltrim(HISTORY_KEY, 0, HISTORY_LIMIT - 1);
  await client.set(HIGH_FLAG_KEY, "1", { ex: HIGH_FLAG_TTL_SECONDS });
  return true;
}

/** Record an actual observed reset (manually marked, based on Tibo's X). */
export async function recordReset(at: string = new Date().toISOString()): Promise<ResetRecord> {
  const client = redis();
  if (!client) throw new Error("KV is not configured.");

  // Debounce double-marks: ignore a reset logged within 6h of the most recent one,
  // which would otherwise create a physically-impossible tiny gap and distort cadence.
  const recentResets = await readResets(10);
  if (recentResets.length > 0) {
    const lastMs = Date.parse(recentResets[0].at);
    const nowMs = Date.parse(at);
    if (
      Number.isFinite(lastMs) &&
      Number.isFinite(nowMs) &&
      Math.abs(nowMs - lastMs) < 6 * 3_600_000
    ) {
      return recentResets[0];
    }
  }

  const record: ResetRecord = { kind: "reset", at };
  await client.lpush(HISTORY_KEY, record);
  await client.ltrim(HISTORY_KEY, 0, HISTORY_LIMIT - 1);
  return record;
}

export async function readHistory(limit: number = 50): Promise<HistoryEntry[]> {
  const client = redis();
  if (!client) return [];
  return (await client.lrange<HistoryEntry>(HISTORY_KEY, 0, Math.max(0, limit - 1))) ?? [];
}

/** All logged actual resets, most-recent first — feeds the cadence prior in scoring. */
export async function readResets(limit: number = 100): Promise<ResetRecord[]> {
  const history = await readHistory(limit);
  return history.filter((entry): entry is ResetRecord => entry.kind === "reset");
}

const PREDLOG_KEY = "oracle:predlog";
const PREDLOG_LIMIT = 500;

/**
 * Unbiased log of EVERY forecast (deduped to one per hour), separate from the >=80%
 * alert. This is the ground-truth substrate a later calibration pass resolves:
 * "predicted X% at time T — did a reset actually happen within 24h?".
 */
export async function recordPredictionSnapshot(forecast: Forecast): Promise<void> {
  const client = redis();
  if (!client) return;

  const hourKey = `oracle:predlog-hour:${new Date().toISOString().slice(0, 13)}`;
  const fresh = await client.set(hourKey, "1", { nx: true, ex: 3600 });
  if (fresh === null) return; // already logged this hour

  const record = {
    at: forecast.generatedAt || new Date().toISOString(),
    chance: forecast.chance,
    signalChance: forecast.signalChance ?? forecast.chance,
    priorChance: forecast.priorChance ?? null,
    horizonH: 24,
    resolved: false as const
  };
  await client.lpush(PREDLOG_KEY, record);
  await client.ltrim(PREDLOG_KEY, 0, PREDLOG_LIMIT - 1);
}

export type PredlogPoint = { at: string; chance: number };

/**
 * Chronological (oldest-first) probability points for the homepage trend wave.
 * The predlog is deduped to one entry per hour, so `limit` ≈ hours of history;
 * the default 40 comfortably covers the "last 30h" axis with headroom.
 */
export async function readPredlog(limit: number = 40): Promise<PredlogPoint[]> {
  const client = redis();
  if (!client) return [];

  const rows =
    (await client.lrange<{ at?: string; chance?: number }>(PREDLOG_KEY, 0, Math.max(0, limit - 1))) ?? [];

  // Stored newest-first via lpush — reverse to chronological for the time axis.
  return rows
    .map((row) => ({
      at: typeof row?.at === "string" ? row.at : "",
      chance: typeof row?.chance === "number" && Number.isFinite(row.chance) ? row.chance : 0
    }))
    .reverse();
}

export type PredlogEntry = {
  at: string;
  chance: number;
  signalChance: number;
  priorChance: number | null;
  horizonH: number;
  resolved: boolean;
  actualReset?: boolean;
};

/**
 * Pure resolution step: for each unresolved entry whose horizon has fully
 * elapsed, mark whether a fleet-wide reset actually fell inside [at, at+horizon].
 * Entries not yet due, already resolved, or with a bad timestamp pass through.
 */
export function resolvePredlogEntries(
  rows: PredlogEntry[],
  resetAtIso: string[],
  now: Date
): { updated: PredlogEntry[]; resolvedCount: number } {
  const resetTimes = resetAtIso.map((value) => Date.parse(value)).filter((value) => Number.isFinite(value));
  const nowMs = now.getTime();
  let resolvedCount = 0;

  const updated = rows.map((row) => {
    if (!row || row.resolved) return row;
    const at = Date.parse(row.at);
    const horizonMs = (row.horizonH ?? 24) * 3_600_000;
    if (!Number.isFinite(at) || at + horizonMs > nowMs) return row;
    const actualReset = resetTimes.some((time) => time >= at && time <= at + horizonMs);
    resolvedCount += 1;
    return { ...row, resolved: true, actualReset };
  });

  return { updated, resolvedCount };
}

/**
 * Resolve due predictions against actual fleet-wide reset timestamps and persist
 * the updated predlog (newest-first order preserved). Returns how many were newly
 * resolved. No-op without KV.
 */
export async function resolveDuePredlog(resetAtIso: string[], now: Date = new Date()): Promise<number> {
  const client = redis();
  if (!client) return 0;

  const rows = (await client.lrange<PredlogEntry>(PREDLOG_KEY, 0, PREDLOG_LIMIT - 1)) ?? [];
  if (rows.length === 0) return 0;

  const { updated, resolvedCount } = resolvePredlogEntries(rows, resetAtIso, now);
  if (resolvedCount > 0) {
    await client.del(PREDLOG_KEY);
    // rows are newest-first; rpush in the same order keeps index 0 = newest.
    await client.rpush(PREDLOG_KEY, ...updated);
  }
  return resolvedCount;
}

export type CalibrationBucket = { lo: number; hi: number; n: number; resets: number; rate: number | null };

/** Bucket resolved predictions into a reliability diagram (pure). */
export function bucketCalibration(rows: PredlogEntry[]): { buckets: CalibrationBucket[]; resolved: number } {
  const resolved = rows.filter(
    (row): row is PredlogEntry & { actualReset: boolean } =>
      Boolean(row) && row.resolved && typeof row.actualReset === "boolean"
  );

  const edges = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
  const buckets: CalibrationBucket[] = [];
  for (let i = 0; i < edges.length - 1; i += 1) {
    const lo = edges[i];
    const hi = edges[i + 1];
    const last = i === edges.length - 2;
    const inBucket = resolved.filter((row) => row.chance >= lo && (last ? row.chance <= hi : row.chance < hi));
    const resets = inBucket.filter((row) => row.actualReset).length;
    buckets.push({ lo, hi, n: inBucket.length, resets, rate: inBucket.length ? resets / inBucket.length : null });
  }
  return { buckets, resolved: resolved.length };
}

/** Reliability diagram from the persisted predlog: "we said X% — reset rate was Y%". */
export async function readCalibration(): Promise<{ buckets: CalibrationBucket[]; resolved: number }> {
  const client = redis();
  if (!client) return { buckets: [], resolved: 0 };
  const rows = (await client.lrange<PredlogEntry>(PREDLOG_KEY, 0, PREDLOG_LIMIT - 1)) ?? [];
  return bucketCalibration(rows);
}
