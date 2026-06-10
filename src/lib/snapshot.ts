import { collectApifySignals } from "./collectors/apify";
import { collectGithubSignals } from "./collectors/github";
import { collectHnSignals } from "./collectors/hn";
import { collectForumSignals } from "./collectors/openai-forum";
import { collectOpenAIStatusSignals } from "./collectors/openai-status";
import { collectResetRadarSignals } from "./collectors/reset-radar";
import { collectResetHistory } from "./collectors/reset-history";
import type { RadarHistory } from "./collectors/reset-history";
import {
  archiveRadarResets,
  maybeRecordPrediction,
  readArchivedResets,
  readModel,
  readResets,
  recordPredictionSnapshot,
  resolveDuePredlog,
  storeLatestSnapshot
} from "./kv";
import type { ResetRecord } from "./kv";
import type { OracleModel } from "./model";
import { REFRESH_MINUTES_DEFAULT } from "./defaults";
import { scoreForecastDetailed } from "./scoring";
import type {
  AnySource,
  AuxCollectorStatus,
  AuxSignal,
  CollectorStatus,
  ForecastFeatures,
  ForecastVariants,
  Milestone,
  Signal,
  SignalSource,
  Snapshot
} from "./types";

type CollectorResult = {
  status: CollectorStatus;
  signals: Signal[];
};

type AuxResult = {
  status: AuxCollectorStatus;
  signals: AuxSignal[];
};

function dedupeSignals<T extends AuxSignal>(signals: T[]): T[] {
  const seenIds = new Set<string>();
  const deduped: T[] = [];

  for (const signal of signals) {
    if (seenIds.has(signal.id)) continue;
    seenIds.add(signal.id);
    deduped.push(signal);
  }

  return deduped;
}

/** Canonical URL key for cross-source echo detection. */
function urlKey(url: string): string {
  return url
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .split(/[?#]/)[0]
    .replace(/\/+$/, "");
}

/**
 * Merge logged (KV), radar-derived, and archived reset records, dropping
 * near-duplicates (within 6h) so the same reset counted by multiple sources
 * can't distort cadence.
 */
function mergeResets(...sources: ResetRecord[][]): ResetRecord[] {
  const sorted = sources
    .flat()
    .map((reset) => ({ reset, ms: Date.parse(reset.at) }))
    .filter((entry) => Number.isFinite(entry.ms))
    .sort((x, y) => x.ms - y.ms);

  const merged: ResetRecord[] = [];
  let lastMs = Number.NEGATIVE_INFINITY;
  for (const { reset, ms } of sorted) {
    if (ms - lastMs < 6 * 3_600_000) continue;
    merged.push(reset);
    lastMs = ms;
  }
  return merged;
}

export type DetailedSnapshot = {
  snapshot: Snapshot;
  features: ForecastFeatures | null;
  variants: ForecastVariants | null;
};

export function buildSnapshotDetailed(
  results: CollectorResult[],
  now = new Date(),
  resets: ResetRecord[] = [],
  milestones: Milestone[] = [],
  auxResults: AuxResult[] = [],
  model: OracleModel | null = null
): DetailedSnapshot {
  const collectors = results.map((result) => result.status);
  const signals = dedupeSignals(results.flatMap((result) => result.signals));

  // Aux signals feed scoring only. Cross-source echo dedupe: an HN/forum item
  // that links to (or duplicates) a main signal's URL is the same event seen
  // twice — keep the main one, drop the echo so confidence isn't inflated.
  const mainUrlKeys = new Set(signals.map((signal) => urlKey(signal.url)));
  const auxSignals = dedupeSignals(auxResults.flatMap((result) => result.signals)).filter(
    (signal) => !mainUrlKeys.has(urlKey(signal.url))
  );

  const { forecast, features, variants } = scoreForecastDetailed(
    [...signals, ...auxSignals],
    now,
    resets,
    milestones,
    model
  );

  // Only MAIN collectors can downgrade the forecast to partial — an aux source
  // being blocked or down must never degrade the headline status.
  const hasFailedCollector = collectors.some((collector) => !collector.ok);

  const snapshot: Snapshot = {
    collectors,
    signals,
    forecast:
      forecast.status === "ok" && hasFailedCollector
        ? {
            ...forecast,
            status: "partial"
          }
        : forecast
  };
  if (auxResults.length > 0) {
    snapshot.auxCollectors = auxResults.map((result) => result.status);
  }

  return { snapshot, features, variants };
}

export function buildSnapshot(
  results: CollectorResult[],
  now = new Date(),
  resets: ResetRecord[] = [],
  milestones: Milestone[] = [],
  auxResults: AuxResult[] = []
): Snapshot {
  return buildSnapshotDetailed(results, now, resets, milestones, auxResults).snapshot;
}

export function refreshMinutes(): number {
  const minutes = Number(process.env.SNAPSHOT_REFRESH_MINUTES);
  return Number.isFinite(minutes) && minutes > 0 ? minutes : REFRESH_MINUTES_DEFAULT;
}

async function collectWithFallback(
  source: SignalSource,
  message: string,
  collect: () => Promise<CollectorResult>
): Promise<CollectorResult> {
  try {
    return await collect();
  } catch {
    return {
      status: {
        source,
        ok: false,
        message
      },
      signals: []
    };
  }
}

async function collectAuxWithFallback(
  source: AnySource,
  message: string,
  collect: () => Promise<AuxResult>
): Promise<AuxResult> {
  try {
    return await collect();
  } catch {
    return {
      status: {
        source,
        ok: false,
        message
      },
      signals: []
    };
  }
}

type CollectOutcome = DetailedSnapshot & {
  radar: RadarHistory;
  /** The merged reset set (logged + radar + archived) the cadence prior used. */
  mergedResets: ResetRecord[];
};

async function collectSnapshotInternal(): Promise<CollectOutcome> {
  const tasks: Array<Promise<CollectorResult>> = [
    collectWithFallback("openai-status", "OpenAI Status collector failed.", collectOpenAIStatusSignals),
    collectWithFallback("github", "GitHub collector failed.", collectGithubSignals),
    collectWithFallback("codex-reset-radar", "Codex Reset Radar collector failed.", collectResetRadarSignals)
  ];

  // X/Twitter via Apify is opt-in: only join the snapshot when a token is
  // configured. Without it the source is simply absent (not a failed
  // collector), so the forecast never downgrades to "partial" in dev.
  if (process.env.APIFY_TOKEN) {
    tasks.push(
      collectWithFallback("x", "Apify collector failed.", () =>
        collectApifySignals({
          token: process.env.APIFY_TOKEN,
          actorId: process.env.APIFY_ACTOR_ID
        })
      )
    );
  }

  // Aux community sources: scoring-only, failure-tolerant, never partial.
  const auxTasks: Array<Promise<AuxResult>> = [
    collectAuxWithFallback("openai-forum", "OpenAI forum collector failed.", collectForumSignals),
    collectAuxWithFallback("hn", "HN collector failed.", () => collectHnSignals())
  ];

  const [results, auxResults] = await Promise.all([Promise.all(tasks), Promise.all(auxTasks)]);

  let resets: ResetRecord[] = [];
  let milestones: Milestone[] = [];
  let radar: RadarHistory = { resets: [], milestones: [], details: [], ok: false };
  let model: OracleModel | null = null;
  try {
    // Logged resets (manual mark-reset, KV) + fleet-wide official resets and
    // user-count milestones from Codex Reset Radar's recent_windows + the KV
    // archive (which outlives radar's rolling 10-entry window) — so the
    // time-based priors keep their full gap history without manual marking.
    const [logged, radarHistory, archived, storedModel] = await Promise.all([
      readResets(),
      collectResetHistory(),
      readArchivedResets(),
      readModel()
    ]);
    radar = {
      resets: radarHistory.resets ?? [],
      milestones: radarHistory.milestones ?? [],
      details: radarHistory.details ?? [],
      ok: radarHistory.ok === true
    };
    resets = mergeResets(logged, radar.resets, archived);
    milestones = radar.milestones;
    model = storedModel;
  } catch {
    resets = [];
    milestones = [];
  }

  return {
    ...buildSnapshotDetailed(results, new Date(), resets, milestones, auxResults, model),
    radar,
    mergedResets: resets
  };
}

export async function collectSnapshot(): Promise<Snapshot> {
  return (await collectSnapshotInternal()).snapshot;
}

export async function refreshAndStore(): Promise<Snapshot> {
  const { snapshot, features, variants, radar, mergedResets } = await collectSnapshotInternal();
  try {
    await storeLatestSnapshot(snapshot);
    await maybeRecordPrediction(snapshot.forecast);
    await recordPredictionSnapshot(snapshot.forecast, {
      features: features ?? undefined,
      variants: variants ?? undefined
    });
    // Archive newly-seen fleet-wide resets so gap history outlives radar's
    // rolling window, then resolve any predictions whose 24h horizon elapsed.
    // BOTH steps require a healthy radar fetch: a failed fetch returns an empty
    // history that is indistinguishable from "no resets", and resolving against
    // it would permanently mislabel every due prediction as a non-reset (poison
    // for the calibration curve AND the training archive). Skipping a round is
    // free — due rows just resolve on the next healthy cron.
    if (radar.ok) {
      await archiveRadarResets(radar.details);
      // Resolution ground truth = the SAME merged reset set the cadence prior
      // uses (manual mark-reset + radar + archive), so a reset that radar
      // missed or rotated out can never read as "didn't happen" in the labels.
      await resolveDuePredlog(mergedResets.map((reset) => reset.at));
    }
  } catch (error) {
    // KV unavailable — still return the freshly collected snapshot.
    console.error("refreshAndStore: KV persistence step failed", error);
  }
  return snapshot;
}
