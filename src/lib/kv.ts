import { Redis } from "@upstash/redis";

import { isValidModel } from "./model";
import type { OracleModel } from "./model";
import type { Forecast, ForecastFeatures, ForecastVariants, ResetDetail, Snapshot } from "./types";

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

// ── Radar reset archive ──────────────────────────────────────────────────────
// Radar's recent_windows only keeps the last 10 entries, so without an archive
// the fleet-wide gap history can never grow past ~5 points — and the cadence
// prior (the one component with backtested skill) stays data-starved forever.
// Append-only, deduped by a 6h window, capped far above any realistic horizon.

const RESET_ARCHIVE_KEY = "oracle:reset-archive";
const RESET_ARCHIVE_LIMIT = 400;
const ARCHIVE_DEDUPE_MS = 6 * 3_600_000;

/**
 * Pure selection step: which radar details are genuinely new versus the archive
 * (no existing entry within 6h). Returned sorted ascending so appends keep the
 * archive chronological.
 */
export function selectNewArchiveEntries(existing: ResetDetail[], details: ResetDetail[]): ResetDetail[] {
  const knownTimes = existing
    .map((entry) => Date.parse(entry?.at ?? ""))
    .filter((ms) => Number.isFinite(ms));

  const fresh: ResetDetail[] = [];
  const candidates = [...details]
    .filter((detail) => Number.isFinite(Date.parse(detail?.at ?? "")))
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));

  for (const detail of candidates) {
    const ms = Date.parse(detail.at);
    const duplicate =
      knownTimes.some((known) => Math.abs(known - ms) < ARCHIVE_DEDUPE_MS) ||
      fresh.some((kept) => Math.abs(Date.parse(kept.at) - ms) < ARCHIVE_DEDUPE_MS);
    if (!duplicate) fresh.push(detail);
  }
  return fresh;
}

/** Append newly-seen fleet-wide resets to the archive. Returns how many were added. */
export async function archiveRadarResets(details: ResetDetail[]): Promise<number> {
  const client = redis();
  if (!client || details.length === 0) return 0;

  const existing = (await client.lrange<ResetDetail>(RESET_ARCHIVE_KEY, 0, RESET_ARCHIVE_LIMIT - 1)) ?? [];
  const fresh = selectNewArchiveEntries(existing, details);
  if (fresh.length === 0) return 0;

  await client.rpush(RESET_ARCHIVE_KEY, ...fresh);
  // Keep the NEWEST entries on overflow (appends land at the tail).
  await client.ltrim(RESET_ARCHIVE_KEY, -RESET_ARCHIVE_LIMIT, -1);
  return fresh.length;
}

/** Archived fleet-wide resets as ResetRecords — merged into the cadence prior. */
export async function readArchivedResets(): Promise<ResetRecord[]> {
  const client = redis();
  if (!client) return [];
  const rows = (await client.lrange<ResetDetail>(RESET_ARCHIVE_KEY, 0, RESET_ARCHIVE_LIMIT - 1)) ?? [];
  return rows
    .filter((row) => row && Number.isFinite(Date.parse(row.at)))
    .map((row) => ({ kind: "reset" as const, at: row.at }));
}

/** Archived fleet-wide resets with full detail (title/kind) — feeds the axis event markers. */
export async function readArchivedResetDetails(): Promise<ResetDetail[]> {
  const client = redis();
  if (!client) return [];
  const rows = (await client.lrange<ResetDetail>(RESET_ARCHIVE_KEY, 0, RESET_ARCHIVE_LIMIT - 1)) ?? [];
  return rows.filter(
    (row): row is ResetDetail => Boolean(row) && typeof row.at === "string" && Number.isFinite(Date.parse(row.at))
  );
}

const PREDLOG_KEY = "oracle:predlog";
// 720 hourly entries ≈ 30 days. The ring buffer is NOT the training window —
// resolved rows are archived separately (oracle:resolved-archive) so the
// trainer is not starved by rotation.
const PREDLOG_LIMIT = 720;

/**
 * Unbiased log of EVERY forecast (deduped to one per hour), separate from the >=80%
 * alert. This is the ground-truth substrate a later calibration pass resolves:
 * "predicted X% at time T — did a reset actually happen within 24h?".
 */
export async function recordPredictionSnapshot(
  forecast: Forecast,
  extras?: { features?: ForecastFeatures; variants?: ForecastVariants }
): Promise<void> {
  const client = redis();
  if (!client) return;

  const hourKey = `oracle:predlog-hour:${new Date().toISOString().slice(0, 13)}`;
  const fresh = await client.set(hourKey, "1", { nx: true, ex: 3600 });
  if (fresh === null) return; // already logged this hour

  const record: PredlogEntry = {
    at: forecast.generatedAt || new Date().toISOString(),
    chance: forecast.chance,
    signalChance: forecast.signalChance ?? forecast.chance,
    priorChance: forecast.priorChance ?? null,
    horizonH: 24,
    resolved: false
  };
  if (extras?.features) record.features = extras.features;
  if (extras?.variants) record.variants = extras.variants;
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
  /** Decomposed scoring inputs (v-tagged) — training material for the model. */
  features?: ForecastFeatures;
  /** Shadow-model probabilities recorded at prediction time. */
  variants?: ForecastVariants;
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

// Resolved rows are append-archived so they outlive the predlog ring buffer:
// 500-720 hourly entries is only ~20-30 days ≈ 2-3 reset events, far too few to
// train on. The archive holds a year of resolved samples.
const RESOLVED_ARCHIVE_KEY = "oracle:resolved-archive";
const RESOLVED_ARCHIVE_LIMIT = 8760;
const RESOLVE_PROBE_COUNT = 100;

/**
 * Resolve due predictions against actual fleet-wide reset timestamps and persist
 * the updated predlog (newest-first order preserved). Returns how many were newly
 * resolved. No-op without KV.
 *
 * Cheap-probe first: entries become due at index ~24-48 (one per hour, newest
 * first), so a 100-entry slice always sees them. Only when something is actually
 * due do we pay for the full read + rewrite.
 */
export async function resolveDuePredlog(resetAtIso: string[], now: Date = new Date()): Promise<number> {
  const client = redis();
  if (!client) return 0;

  const probe = (await client.lrange<PredlogEntry>(PREDLOG_KEY, 0, RESOLVE_PROBE_COUNT - 1)) ?? [];
  if (probe.length === 0) return 0;
  if (resolvePredlogEntries(probe, resetAtIso, now).resolvedCount === 0) return 0;

  const rows =
    probe.length < RESOLVE_PROBE_COUNT
      ? probe
      : ((await client.lrange<PredlogEntry>(PREDLOG_KEY, 0, PREDLOG_LIMIT - 1)) ?? []);

  const { updated, resolvedCount } = resolvePredlogEntries(rows, resetAtIso, now);
  if (resolvedCount > 0) {
    // One atomic MULTI/EXEC: the rewrite (del+rpush) and the archive append
    // either all land or none do. A bare del→rpush pair would silently wipe
    // the whole predlog if the rpush request failed after the del succeeded.
    const newlyResolved = updated.filter((row, index) => row.resolved && !rows[index]?.resolved);
    const tx = client.multi();
    tx.del(PREDLOG_KEY);
    // rows are newest-first; rpush in the same order keeps index 0 = newest.
    tx.rpush(PREDLOG_KEY, ...updated);
    if (newlyResolved.length > 0) {
      // Archive the newly-resolved rows (training material that must outlive
      // the ring buffer).
      tx.rpush(RESOLVED_ARCHIVE_KEY, ...newlyResolved);
      tx.ltrim(RESOLVED_ARCHIVE_KEY, -RESOLVED_ARCHIVE_LIMIT, -1);
    }
    await tx.exec();
  }
  return resolvedCount;
}

/**
 * All resolved rows available for training: the archive plus any resolved rows
 * still in the predlog that predate the archive's existence, deduped by `at`.
 */
export async function readResolvedRowsForTraining(): Promise<PredlogEntry[]> {
  const client = redis();
  if (!client) return [];

  const [archived, current] = await Promise.all([
    client.lrange<PredlogEntry>(RESOLVED_ARCHIVE_KEY, 0, RESOLVED_ARCHIVE_LIMIT - 1),
    client.lrange<PredlogEntry>(PREDLOG_KEY, 0, PREDLOG_LIMIT - 1)
  ]);

  const seen = new Set<string>();
  const rows: PredlogEntry[] = [];
  for (const row of [...(archived ?? []), ...(current ?? [])]) {
    if (!row || !row.resolved || typeof row.actualReset !== "boolean") continue;
    if (typeof row.at !== "string" || seen.has(row.at)) continue;
    seen.add(row.at);
    rows.push(row);
  }
  return rows;
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

export type VariantName = keyof ForecastVariants;
export type VariantMetric = { n: number; brier: number | null; logLoss: number | null };
export type VariantMetrics = Record<VariantName, VariantMetric> & { pairedN: number };

const VARIANT_NAMES: VariantName[] = ["signalOnly", "priorOnly", "blended", "calibrated"];

/**
 * Per-variant Brier / log-loss over resolved rows (pure). Each variant's n can
 * differ (legacy rows lack variants; priorOnly can be null) — `pairedN` counts
 * rows where ALL four variants are present, the only subset on which
 * cross-variant comparison is statistically valid.
 */
export function variantMetrics(rows: PredlogEntry[]): VariantMetrics {
  const acc: Record<VariantName, { n: number; brier: number; logLoss: number }> = {
    signalOnly: { n: 0, brier: 0, logLoss: 0 },
    priorOnly: { n: 0, brier: 0, logLoss: 0 },
    blended: { n: 0, brier: 0, logLoss: 0 },
    calibrated: { n: 0, brier: 0, logLoss: 0 }
  };
  let pairedN = 0;

  for (const row of rows) {
    if (!row || !row.resolved || typeof row.actualReset !== "boolean" || !row.variants) continue;
    const y = row.actualReset ? 1 : 0;
    let complete = true;
    for (const name of VARIANT_NAMES) {
      const value = row.variants[name];
      if (typeof value !== "number" || !Number.isFinite(value)) {
        complete = false;
        continue;
      }
      const p = Math.min(0.99, Math.max(0.01, value / 100));
      acc[name].n += 1;
      acc[name].brier += (p - y) ** 2;
      acc[name].logLoss += -(y * Math.log(p) + (1 - y) * Math.log(1 - p));
    }
    if (complete) pairedN += 1;
  }

  const result = {} as VariantMetrics;
  for (const name of VARIANT_NAMES) {
    const { n, brier, logLoss } = acc[name];
    result[name] = {
      n,
      brier: n > 0 ? brier / n : null,
      logLoss: n > 0 ? logLoss / n : null
    };
  }
  result.pairedN = pairedN;
  return result;
}

/** Reliability diagram from the persisted predlog: "we said X% — reset rate was Y%". */
export async function readCalibration(): Promise<{
  buckets: CalibrationBucket[];
  resolved: number;
  variants: VariantMetrics;
}> {
  const client = redis();
  if (!client) return { buckets: [], resolved: 0, variants: variantMetrics([]) };
  const [rows, archived] = await Promise.all([
    client.lrange<PredlogEntry>(PREDLOG_KEY, 0, PREDLOG_LIMIT - 1),
    client.lrange<PredlogEntry>(RESOLVED_ARCHIVE_KEY, 0, RESOLVED_ARCHIVE_LIMIT - 1)
  ]);

  // Buckets keep their original semantics (current predlog window); variant
  // metrics read the full resolved archive so they keep growing past rotation.
  const seen = new Set<string>();
  const resolvedRows: PredlogEntry[] = [];
  for (const row of [...(archived ?? []), ...(rows ?? [])]) {
    if (!row || !row.resolved || typeof row.at !== "string" || seen.has(row.at)) continue;
    seen.add(row.at);
    resolvedRows.push(row);
  }

  return { ...bucketCalibration(rows ?? []), variants: variantMetrics(resolvedRows) };
}

// ── Trained calibration model ────────────────────────────────────────────────

const MODEL_KEY = "oracle:model";

/** The persisted calibration model, or null when absent/invalid (=> hand-tuned). */
export async function readModel(): Promise<OracleModel | null> {
  const client = redis();
  if (!client) return null;
  try {
    const value = await client.get<unknown>(MODEL_KEY);
    return isValidModel(value) ? value : null;
  } catch {
    return null;
  }
}

export async function writeModel(model: OracleModel): Promise<void> {
  const client = redis();
  if (!client) return;
  await client.set(MODEL_KEY, model);
}

/**
 * One-shot daily lock for the training pass. Returns true when this caller won
 * today's slot. 26h TTL so a skipped cron day can't leave a stale permanent lock.
 */
export async function acquireDailyTrainLock(dateKey: string): Promise<boolean> {
  const client = redis();
  if (!client) return false;
  const result = await client.set(`oracle:model-train:${dateKey}`, "1", { nx: true, ex: 93_600 });
  return result !== null;
}
