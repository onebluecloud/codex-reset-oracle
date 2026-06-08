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
