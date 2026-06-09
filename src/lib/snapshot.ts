import { collectApifySignals } from "./collectors/apify";
import { collectGithubSignals } from "./collectors/github";
import { collectOpenAIStatusSignals } from "./collectors/openai-status";
import { collectResetRadarSignals } from "./collectors/reset-radar";
import { collectResetHistory } from "./collectors/reset-history";
import {
  maybeRecordPrediction,
  readResets,
  recordPredictionSnapshot,
  resolveDuePredlog,
  storeLatestSnapshot
} from "./kv";
import type { ResetRecord } from "./kv";
import { REFRESH_MINUTES_DEFAULT } from "./defaults";
import { scoreForecast } from "./scoring";
import type { CollectorStatus, Milestone, Signal, SignalSource, Snapshot } from "./types";

type CollectorResult = {
  status: CollectorStatus;
  signals: Signal[];
};

function dedupeSignals(signals: Signal[]): Signal[] {
  const seenIds = new Set<string>();
  const deduped: Signal[] = [];

  for (const signal of signals) {
    if (seenIds.has(signal.id)) continue;
    seenIds.add(signal.id);
    deduped.push(signal);
  }

  return deduped;
}

/**
 * Merge logged (KV) and radar-derived reset records, dropping near-duplicates
 * (within 6h) so the same reset counted by both sources can't distort cadence.
 */
function mergeResets(a: ResetRecord[], b: ResetRecord[]): ResetRecord[] {
  const sorted = [...a, ...b]
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

export function buildSnapshot(
  results: CollectorResult[],
  now = new Date(),
  resets: ResetRecord[] = [],
  milestones: Milestone[] = []
): Snapshot {
  const collectors = results.map((result) => result.status);
  const signals = dedupeSignals(results.flatMap((result) => result.signals));
  const forecast = scoreForecast(signals, now, resets, milestones);
  const hasFailedCollector = collectors.some((collector) => !collector.ok);

  return {
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

export async function collectSnapshot(): Promise<Snapshot> {
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

  const results = await Promise.all(tasks);

  let resets: ResetRecord[] = [];
  let milestones: Milestone[] = [];
  try {
    // Logged resets (manual mark-reset, KV) + fleet-wide official resets and
    // user-count milestones from Codex Reset Radar's recent_windows — so the
    // time-based priors have data without anyone hand-marking each reset.
    const [logged, radar] = await Promise.all([readResets(), collectResetHistory()]);
    resets = mergeResets(logged, radar.resets);
    milestones = radar.milestones;
  } catch {
    resets = [];
    milestones = [];
  }

  return buildSnapshot(results, new Date(), resets, milestones);
}

export async function refreshAndStore(): Promise<Snapshot> {
  const snapshot = await collectSnapshot();
  try {
    await storeLatestSnapshot(snapshot);
    await maybeRecordPrediction(snapshot.forecast);
    await recordPredictionSnapshot(snapshot.forecast);
    // Resolve any predictions whose 24h horizon has elapsed against the actual
    // fleet-wide resets — this is the ground truth the calibration curve reads.
    const { resets } = await collectResetHistory();
    await resolveDuePredlog(resets.map((reset) => reset.at));
  } catch {
    // KV unavailable — still return the freshly collected snapshot.
  }
  return snapshot;
}
