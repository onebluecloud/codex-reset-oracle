import type { ForecastFeatures, ForecastVariants } from "./types";

/**
 * Self-learning calibration layer — pure functions, zero dependencies.
 *
 * Design rules (from the accuracy-design review):
 * - Sample-size gates count INDEPENDENT RESET EVENTS, never predlog rows: one
 *   reset turns ~24 hourly rows positive, so row counts wildly overstate the
 *   evidence.
 * - Shrinkage keeps the model output glued to the hand-tuned chance until the
 *   event count earns it real weight (K_EVENTS=10: 5 events -> 33% weight).
 * - The published forecast chance stays the hand-tuned blend; the calibrated
 *   value lives only in the shadow variants until it proves itself.
 * - Training reads pre-calibration inputs only (variants.blended / features) —
 *   never `calibrated` — so the loop cannot feed on its own output.
 */

export type OracleModel = {
  v: 1;
  kind: "platt" | "logistic";
  featNames: string[];
  mu: number[];
  sigma: number[];
  w: number[];
  b: number;
  nSamples: number;
  /** Independent fleet-wide reset events represented in the training data. */
  nEvents: number;
  nPos: number;
  trainedAt: string;
  trainBrier: number;
  baselineBrier: number;
};

/** Feature order for the (future) logistic path. Missing values read as 0. */
export const FEATURE_NAMES: readonly string[] = [
  "srcPts.github",
  "srcPts.x",
  "srcPts.openai-status",
  "srcPts.codex-reset-radar",
  "srcPts.hn",
  "srcPts.openai-forum",
  "agree",
  "kwTop",
  "radarP",
  "pPrior",
  "wPrior",
  "pMilestone",
  "wMilestone",
  "ageH",
  "cadenceConf",
  "signalChance"
];

/** Platt path trains on a single feature: logit of the hand-tuned blend. */
export const PLATT_FEATURE = "__logit_blended";

// Gates — all in units of independent reset events, not rows.
export const MIN_EVENTS_PLATT = 5;
export const MIN_EVENTS_LOGISTIC = 12;
export const MIN_NEG_ROWS = 200;
export const MIN_POS_ROWS = 24;
export const MIN_TRAIN_ROWS = 500;
/** The holdout must contain at least this many independent reset events. */
export const MIN_HOLDOUT_EVENTS = 1;
export const SHRINK_K_EVENTS = 10;
export const CHAMPION_MARGIN = 0.002;
const COEF_BOUND = 15;
/** Positive rows within this window belong to the same reset event. */
const EVENT_CLUSTER_HOURS = 48;

const clip = (value: number, lo: number, hi: number): number =>
  Number.isFinite(value) ? Math.min(hi, Math.max(lo, value)) : lo;

const logit = (p: number): number => Math.log(p / (1 - p));
const sigmoid = (z: number): number => 1 / (1 + Math.exp(-z));
const logitPct = (pct: number): number => logit(clip(pct / 100, 0.01, 0.99));

/** Minimal slice of a predlog row the trainer needs (type-only, no kv import). */
export type TrainRow = {
  at: string;
  chance: number;
  resolved: boolean;
  actualReset?: boolean;
  features?: ForecastFeatures;
  variants?: ForecastVariants;
};

export function featureValue(features: ForecastFeatures, name: string): number {
  let value: unknown;
  if (name.startsWith("srcPts.")) {
    value = features.srcPts[name.slice("srcPts.".length)];
  } else {
    value = (features as unknown as Record<string, unknown>)[name];
  }
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function featureVector(features: ForecastFeatures, featNames: readonly string[]): number[] {
  return featNames.map((name) => featureValue(features, name));
}

type Fit = { w: number[]; b: number; mu: number[]; sigma: number[] };

/**
 * Logistic regression via full-batch gradient descent with L2 (bias unpenalized),
 * on standardized columns. Returns null on any non-finite intermediate.
 */
export function fitLogistic(
  X: number[][],
  y: number[],
  opts: { lambda?: number; lr?: number; epochs?: number } = {}
): Fit | null {
  const { lambda = 1, lr = 0.5, epochs = 500 } = opts;
  const n = X.length;
  if (n === 0 || y.length !== n) return null;
  const d = X[0].length;
  if (d === 0 || X.some((row) => row.length !== d)) return null;

  const mu = new Array<number>(d).fill(0);
  const sigma = new Array<number>(d).fill(0);
  for (let j = 0; j < d; j += 1) {
    let sum = 0;
    for (let i = 0; i < n; i += 1) sum += X[i][j];
    mu[j] = sum / n;
    let sq = 0;
    for (let i = 0; i < n; i += 1) sq += (X[i][j] - mu[j]) ** 2;
    const sd = Math.sqrt(sq / Math.max(1, n - 1));
    sigma[j] = sd > 1e-9 ? sd : 1;
  }
  const Z = X.map((row) => row.map((value, j) => (value - mu[j]) / sigma[j]));

  const w = new Array<number>(d).fill(0);
  let b = 0;
  for (let epoch = 0; epoch < epochs; epoch += 1) {
    const gw = new Array<number>(d).fill(0);
    let gb = 0;
    for (let i = 0; i < n; i += 1) {
      let z = b;
      for (let j = 0; j < d; j += 1) z += w[j] * Z[i][j];
      const err = sigmoid(z) - y[i];
      for (let j = 0; j < d; j += 1) gw[j] += err * Z[i][j];
      gb += err;
    }
    for (let j = 0; j < d; j += 1) {
      w[j] -= (lr * (gw[j] / n + (lambda / n) * w[j]));
      if (!Number.isFinite(w[j])) return null;
    }
    b -= lr * (gb / n);
    if (!Number.isFinite(b)) return null;
  }
  return { w, b, mu, sigma };
}

function modelProbability(model: OracleModel, x: number[]): number {
  let z = model.b;
  for (let j = 0; j < model.w.length; j += 1) {
    const sigma = model.sigma[j] > 1e-9 ? model.sigma[j] : 1;
    z += model.w[j] * ((x[j] - model.mu[j]) / sigma);
  }
  return sigmoid(z);
}

function modelInput(model: OracleModel, features: ForecastFeatures | null, handChance: number): number[] | null {
  if (model.kind === "platt") return [logitPct(handChance)];
  if (!features || features.v !== 1) return null;
  return featureVector(features, model.featNames);
}

/**
 * Apply the trained calibration to the hand-tuned chance, shrunk toward the
 * hand-tuned value by independent-event count. Any irregularity falls back to
 * the hand-tuned chance unchanged — this function must never be able to make
 * the output worse than "no model at all" by more than its earned weight.
 */
export function applyModel(
  model: OracleModel | null,
  features: ForecastFeatures | null,
  handChance: number
): number {
  if (!model) return handChance;
  try {
    const x = modelInput(model, features, handChance);
    if (!x || x.length !== model.w.length) return handChance;
    const pModel = modelProbability(model, x);
    if (!Number.isFinite(pModel)) return handChance;
    const wShrink = clip(model.nEvents / (model.nEvents + SHRINK_K_EVENTS), 0, 1);
    const z = wShrink * logit(clip(pModel, 0.01, 0.99)) + (1 - wShrink) * logitPct(handChance);
    const out = Math.round(100 * sigmoid(z));
    return Number.isFinite(out) ? Math.max(1, Math.min(95, out)) : handChance;
  } catch {
    return handChance;
  }
}

export function isValidModel(value: unknown): value is OracleModel {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const m = value as Record<string, unknown>;
  if (m.v !== 1) return false;
  if (m.kind !== "platt" && m.kind !== "logistic") return false;
  if (!Array.isArray(m.featNames) || !m.featNames.every((n) => typeof n === "string")) return false;
  const arrays = [m.mu, m.sigma, m.w];
  if (!arrays.every((a) => Array.isArray(a) && a.every((v) => typeof v === "number" && Number.isFinite(v)))) {
    return false;
  }
  const d = (m.featNames as string[]).length;
  if ((m.w as number[]).length !== d || (m.mu as number[]).length !== d || (m.sigma as number[]).length !== d) {
    return false;
  }
  if (typeof m.b !== "number" || !Number.isFinite(m.b)) return false;
  for (const key of ["nSamples", "nEvents", "nPos"]) {
    if (typeof m[key] !== "number" || !Number.isFinite(m[key] as number)) return false;
  }
  return true;
}

/**
 * Count independent reset events among the positive resolved rows: positives
 * whose timestamps fall within EVENT_CLUSTER_HOURS of the previous positive
 * belong to the same event (one reset flips ~24 consecutive hourly rows).
 */
export function countResetEvents(rows: TrainRow[]): number {
  const times = rows
    .filter((row) => row.resolved && row.actualReset === true)
    .map((row) => Date.parse(row.at))
    .filter((ms) => Number.isFinite(ms))
    .sort((a, b) => a - b);
  let events = 0;
  let lastEventEnd = Number.NEGATIVE_INFINITY;
  for (const ms of times) {
    if (ms - lastEventEnd > EVENT_CLUSTER_HOURS * 3_600_000) events += 1;
    lastEventEnd = ms;
  }
  return events;
}

function brierOf(pairs: Array<{ p: number; y: number }>): number {
  if (pairs.length === 0) return Number.POSITIVE_INFINITY;
  let sum = 0;
  for (const { p, y } of pairs) sum += (p - y) ** 2;
  return sum / pairs.length;
}

/**
 * Train (or refuse to train) a calibration model from resolved rows.
 * Four exit gates, all of which must pass before a model is returned:
 *  1. evidence: >= MIN_EVENTS_PLATT independent reset events, enough pos/neg rows,
 *     and >= MIN_TRAIN_ROWS rows — below that there is no honest way to evaluate
 *     (in-sample comparison would let a 2-param Platt "beat" data it just fitted);
 *  2. holdout evidence: the time-ordered holdout (last 20%) must itself contain
 *     >= MIN_HOLDOUT_EVENTS reset events. Brier is only a proper score when the
 *     eval slice has positives — on an all-negative slice ANY monotone push
 *     toward 0 "wins", which is exactly the failure mode the gate exists to stop;
 *  3. sanity: every coefficient finite and bounded;
 *  4. champion: the shrunk model must beat the hand-tuned baseline Brier by a
 *     margin on that holdout.
 * Trains on the PRE-calibration blend (variants.blended, falling back to the
 * top-level chance for legacy rows) — never on `calibrated`.
 */
export function trainModel(rows: TrainRow[], now: Date): OracleModel | null {
  const usable = rows.filter(
    (row) =>
      row &&
      row.resolved &&
      typeof row.actualReset === "boolean" &&
      Number.isFinite(Date.parse(row.at)) &&
      Number.isFinite(row.variants?.blended ?? row.chance)
  );
  const nPos = usable.filter((row) => row.actualReset).length;
  const nNeg = usable.length - nPos;
  const nEvents = countResetEvents(usable);

  if (nEvents < MIN_EVENTS_PLATT || nPos < MIN_POS_ROWS || nNeg < MIN_NEG_ROWS) return null;
  if (usable.length < MIN_TRAIN_ROWS) return null;

  // Chronological order so the holdout is the most recent slice.
  const ordered = [...usable].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const blendedOf = (row: TrainRow): number => row.variants?.blended ?? row.chance;
  const X = ordered.map((row) => [logitPct(blendedOf(row))]);
  const y = ordered.map((row) => (row.actualReset ? 1 : 0));

  const split = Math.floor(ordered.length * 0.8);
  if (countResetEvents(ordered.slice(split)) < MIN_HOLDOUT_EVENTS) return null;

  const fit = fitLogistic(X.slice(0, split), y.slice(0, split), { lambda: 1, lr: 0.5, epochs: 500 });
  if (!fit) return null;
  if (fit.w.some((value) => Math.abs(value) > COEF_BOUND) || Math.abs(fit.b) > COEF_BOUND) return null;

  const candidate: OracleModel = {
    v: 1,
    kind: "platt",
    featNames: [PLATT_FEATURE],
    mu: fit.mu,
    sigma: fit.sigma,
    w: fit.w,
    b: fit.b,
    nSamples: usable.length,
    nEvents,
    nPos,
    trainedAt: now.toISOString(),
    trainBrier: 0,
    baselineBrier: 0
  };

  // Champion check on the holdout, using the SHRUNK output — the value that
  // would actually be published if this model were live.
  const evalStart = split;
  const evalPairs = [];
  const basePairs = [];
  for (let i = evalStart; i < ordered.length; i += 1) {
    const hand = blendedOf(ordered[i]);
    const calibrated = applyModel(candidate, null, hand);
    evalPairs.push({ p: clip(calibrated / 100, 0.01, 0.99), y: y[i] });
    basePairs.push({ p: clip(hand / 100, 0.01, 0.99), y: y[i] });
  }
  const trainBrier = brierOf(evalPairs);
  const baselineBrier = brierOf(basePairs);
  if (!Number.isFinite(trainBrier) || !Number.isFinite(baselineBrier)) return null;
  if (trainBrier > baselineBrier - CHAMPION_MARGIN) return null;

  candidate.trainBrier = trainBrier;
  candidate.baselineBrier = baselineBrier;
  return candidate;
}
