import { acquireDailyTrainLock, kvEnabled, readResolvedRowsForTraining, writeModel } from "./kv";
import { trainModel } from "./model";

export type TrainOutcome = { trained: boolean; reason: string };

/**
 * Daily self-learning pass: fit a calibration model from resolved predictions
 * and persist it ONLY when it clears every gate in trainModel (enough
 * independent reset events, bounded coefficients, beats the hand-tuned baseline
 * Brier). Until then this is a cheap no-op — and even a written model only
 * feeds the shadow `calibrated` variant, never the published chance.
 *
 * Never throws; the cron path must not fail because training did.
 */
export async function maybeTrainModel(now: Date = new Date()): Promise<TrainOutcome> {
  try {
    if (!kvEnabled()) return { trained: false, reason: "kv-disabled" };

    const dateKey = now.toISOString().slice(0, 10);
    const won = await acquireDailyTrainLock(dateKey);
    if (!won) return { trained: false, reason: "already-ran-today" };

    const rows = await readResolvedRowsForTraining();
    const model = trainModel(rows, now);
    if (!model) return { trained: false, reason: `gates-not-met (resolved=${rows.length})` };

    await writeModel(model);
    return {
      trained: true,
      reason: `platt fitted: events=${model.nEvents} brier=${model.trainBrier.toFixed(4)} baseline=${model.baselineBrier.toFixed(4)}`
    };
  } catch {
    return { trained: false, reason: "error" };
  }
}
