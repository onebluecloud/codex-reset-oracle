import { collectApifySignals } from "./collectors/apify";
import { collectGithubSignals } from "./collectors/github";
import { collectOpenAIStatusSignals } from "./collectors/openai-status";
import { collectResetRadarSignals } from "./collectors/reset-radar";
import { REFRESH_MINUTES_DEFAULT } from "./defaults";
import { scoreForecast } from "./scoring";
import type { CollectorStatus, Signal, SignalSource, Snapshot } from "./types";

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

export function buildSnapshot(results: CollectorResult[], now = new Date()): Snapshot {
  const collectors = results.map((result) => result.status);
  const signals = dedupeSignals(results.flatMap((result) => result.signals));
  const forecast = scoreForecast(signals, now);
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
  const results = await Promise.all([
    collectWithFallback("x", "X collector failed.", () =>
      collectApifySignals({
        token: process.env.APIFY_TOKEN,
        actorId: process.env.APIFY_ACTOR_ID
      })
    ),
    collectWithFallback("openai-status", "OpenAI Status collector failed.", collectOpenAIStatusSignals),
    collectWithFallback("github", "GitHub collector failed.", collectGithubSignals),
    collectWithFallback("codex-reset-radar", "Codex Reset Radar collector failed.", collectResetRadarSignals)
  ]);

  return buildSnapshot(results);
}
