import type { ResetRecord } from "./kv";
import { applyModel } from "./model";
import type { OracleModel } from "./model";
import type {
  AnySource,
  AuxSignal,
  Cadence,
  Forecast,
  ForecastFeatures,
  ForecastVariants,
  Milestone,
  Signal
} from "./types";

type ScoredSignal = {
  signal: AuxSignal;
  ageHours: number;
  sanitizedScore: number;
};

const DEFAULT_SOURCE_POINT_CAP = 35;
const SOURCE_POINT_CAPS: Partial<Record<AnySource, number>> = {
  github: 8,
  "codex-reset-radar": 75,
  // Aux community sources: low caps — noisy venues nudge, never drive.
  hn: 10,
  "openai-forum": 12
};
const DEFAULT_SOURCE_POINT_SCALE = 35;
const SOURCE_POINT_SCALES: Partial<Record<AnySource, number>> = {
  "codex-reset-radar": 100
};
// Aux sources are deliberately excluded: brigading/cross-posting must not be
// able to trigger the cross-source agreement bonus.
const AGREEMENT_ELIGIBLE_SOURCES = new Set<AnySource>(["x", "openai-status", "codex-reset-radar"]);

const MAIN_SOURCES = new Set<AnySource>(["x", "openai-status", "github", "codex-reset-radar"]);

/** Aux signals feed the score but never the UI-facing topSignals list. */
function isMainSignal(signal: AuxSignal): signal is Signal {
  return MAIN_SOURCES.has(signal.source);
}

function sanitizeUnit(value: number): number {
  if (!Number.isFinite(value) || value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function hoursOld(signal: AuxSignal, now: Date): number {
  const age = (now.getTime() - new Date(signal.publishedAt).getTime()) / 3_600_000;
  return Number.isFinite(age) ? Math.max(0, age) : Number.POSITIVE_INFINITY;
}

function recencyMultiplier(ageHours: number): number {
  const age = ageHours;
  if (age <= 6) return 1;
  if (age <= 24) return 0.65;
  if (age <= 72) return 0.25;
  return 0.1;
}

function scoreSignal(signal: AuxSignal, now: Date): ScoredSignal {
  const ageHours = hoursOld(signal, now);
  const sourceWeight = sanitizeUnit(signal.sourceWeight);
  const strength = sanitizeUnit(signal.strength);

  return {
    signal,
    ageHours,
    sanitizedScore: sourceWeight * strength * recencyMultiplier(ageHours)
  };
}

function sourcePointCap(source: AnySource): number {
  return SOURCE_POINT_CAPS[source] ?? DEFAULT_SOURCE_POINT_CAP;
}

function sourcePointScale(source: AnySource): number {
  return SOURCE_POINT_SCALES[source] ?? DEFAULT_SOURCE_POINT_SCALE;
}

function signalPointValue(item: ScoredSignal): number {
  return item.sanitizedScore * sourcePointScale(item.signal.source);
}

/** Per-source signal points, capped per source. */
function cappedPointsBySource(items: ScoredSignal[]): Map<AnySource, number> {
  const pointsBySource = new Map<AnySource, number>();
  for (const item of items) {
    const source = item.signal.source;
    pointsBySource.set(source, (pointsBySource.get(source) ?? 0) + signalPointValue(item));
  }
  const capped = new Map<AnySource, number>();
  for (const [source, points] of pointsBySource) {
    capped.set(source, Math.min(points, sourcePointCap(source)));
  }
  return capped;
}

function cappedSignalPoints(items: ScoredSignal[]): number {
  let total = 0;
  for (const points of cappedPointsBySource(items).values()) total += points;
  return total;
}

function agreementBonus(items: ScoredSignal[]): number {
  const eligibleItems = items.filter(
    (item) =>
      item.ageHours <= 24 &&
      item.sanitizedScore > 0 &&
      AGREEMENT_ELIGIBLE_SOURCES.has(item.signal.source)
  );
  const sources = new Set(eligibleItems.map((item) => item.signal.source));
  if (sources.size >= 3) return 18;
  if (sources.size === 2) return 10;
  return 0;
}

// ── Periodic prior (time-since-last-reset) ────────────────────────────────
// The cadence prior's weight scales with how clock-like the logged resets are:
// full (tempered) weight for a low-variation cadence, a low weight for a ragged
// event-driven one (its age term only nudges), and zero below MIN_GAPS_FOR_PRIOR
// or above the CV cutoff — so sparse or chaotic timestamps can never swing it.
const MU0_HOURS = 168; // weekly prior mean gap — a hand-set belief, dominated by data once gaps accrue
const SIGMA0_FRAC = 0.5;
const DELTA_HOURS = 24; // forecast horizon (matches the UI's "next 24h")
const W_PRIOR_MAX = 0.3; // tempered: the prior nudges, never dominates the live signal
const M_FULL = 8; // clean gaps needed for the prior to reach full (tempered) weight
const GAP_FLOOR_HOURS = 6; // drop physically-impossible gaps (e.g. a double mark-reset)
const MIN_GAPS_FOR_PRIOR = 4; // need >= 4 clean gaps (>= 5 resets) before any weight
const REGULARITY_CV_GOOD = 0.4; // at/below this CV the cadence is a clean "clock" → full weight
const REGULARITY_CV_CUTOFF = 1.0; // at/above this CV the cadence is too chaotic → prior inactive
const MU_LOW = 0.5 * MU0_HOURS;
const MU_HIGH = 2 * MU0_HOURS;

// ── Milestone proximity (one-way catalyst) ───────────────────────────────────
// Sam Altman pledged a reset at every +1M WAU up to 10M, so the next milestone is
// a near-certain reset driver. We extrapolate its ETA from logged crossings and
// lift the chance as it nears — ONLY upward, so it never double-counts the age
// prior's "still early" dampening with its own.
const W_MILESTONE_MAX = 0.3;
const MILESTONE_CENTER = 0.75; // progress-to-next-milestone at which it is ~50% likely
const MILESTONE_SLOPE = 0.2;
const MIN_MILESTONES = 2; // need >= 2 crossings to estimate a growth rate

function clip(value: number, lo: number, hi: number): number {
  if (!Number.isFinite(value)) return lo;
  return Math.min(hi, Math.max(lo, value));
}

function logit(p: number): number {
  return Math.log(p / (1 - p));
}

function sigmoid(z: number): number {
  return 1 / (1 + Math.exp(-z));
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function sampleStd(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance =
    values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

// Lanczos approximation of ln Γ(z).
function lnGamma(z: number): number {
  const c = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6,
    1.5056327351493116e-7
  ];
  if (z < 0.5) {
    return Math.log(Math.PI / Math.sin(Math.PI * z)) - lnGamma(1 - z);
  }
  let zz = z - 1;
  let x = c[0];
  for (let i = 1; i < c.length; i += 1) x += c[i] / (zz + i);
  const t = zz + c.length - 1.5;
  return 0.5 * Math.log(2 * Math.PI) + (zz + 0.5) * Math.log(t) - t + Math.log(x);
}

// Regularized lower incomplete gamma P(k, x) = γ(k, x)/Γ(k) — Numerical Recipes.
function lowerRegularizedGammaP(k: number, x: number): number {
  if (!Number.isFinite(k) || !Number.isFinite(x) || k <= 0 || x <= 0) return 0;
  if (x < k + 1) {
    // Series expansion.
    let ap = k;
    let del = 1 / k;
    let sum = del;
    for (let i = 0; i < 300; i += 1) {
      ap += 1;
      del *= x / ap;
      sum += del;
      if (Math.abs(del) < Math.abs(sum) * 1e-13) break;
    }
    return sum * Math.exp(-x + k * Math.log(x) - lnGamma(k));
  }
  // Continued fraction for Q(k, x), then P = 1 - Q.
  const tiny = 1e-300;
  let b = x + 1 - k;
  let cf = 1 / tiny;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i < 300; i += 1) {
    const an = -i * (i - k);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < tiny) d = tiny;
    cf = b + an / cf;
    if (Math.abs(cf) < tiny) cf = tiny;
    d = 1 / d;
    const del = d * cf;
    h *= del;
    if (Math.abs(del - 1) < 1e-13) break;
  }
  const q = Math.exp(-x + k * Math.log(x) - lnGamma(k)) * h;
  return 1 - q;
}

type PriorResult = {
  pPrior: number;
  wPrior: number;
  cadence: Cadence | null;
  /** Hours since the last known fleet-wide reset (null when no resets known). */
  ageHours: number | null;
};

function periodicPrior(resets: ResetRecord[], now: Date): PriorResult {
  const times = resets
    .map((reset) => Date.parse(reset.at))
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => a - b);
  const n = times.length;
  if (n === 0) return { pPrior: 0, wPrior: 0, cadence: null, ageHours: null };

  const ageHours = Math.max(0, (now.getTime() - times[n - 1]) / 3_600_000);
  if (n < 2) return { pPrior: 0, wPrior: 0, cadence: null, ageHours };

  const gaps: number[] = [];
  for (let i = 1; i < n; i += 1) gaps.push((times[i] - times[i - 1]) / 3_600_000);
  const cleanGaps = gaps.filter((gap) => gap >= GAP_FLOOR_HOURS);
  const m = cleanGaps.length;
  if (m < MIN_GAPS_FOR_PRIOR) return { pPrior: 0, wPrior: 0, cadence: null, ageHours };

  const medianGap = median(cleanGaps);
  const std = sampleStd(cleanGaps);
  const cv = medianGap > 0 ? std / medianGap : Number.POSITIVE_INFINITY;

  const cadence: Cadence = {
    medianGapHours: medianGap,
    muHatHours: medianGap,
    sigHatHours: std,
    nResets: n,
    confidence: 0,
    computedAt: now.toISOString()
  };

  // Regularity → soft weight. A near-perfect cadence (CV ≤ GOOD) earns full
  // tempered weight; a ragged, event-driven one earns a low weight so its age
  // term only nudges; at/above CUTOFF the cadence is too chaotic to trust at all.
  if (!Number.isFinite(cv) || cv >= REGULARITY_CV_CUTOFF) {
    return { pPrior: 0, wPrior: 0, cadence, ageHours };
  }
  const regularityFactor = clip(
    (REGULARITY_CV_CUTOFF - cv) / (REGULARITY_CV_CUTOFF - REGULARITY_CV_GOOD),
    0,
    1
  );

  // Bound the cadence so a single missed log can't run the prior off a cliff.
  const muHat = clip(medianGap, MU_LOW, MU_HIGH);
  // Floor the spread to ~10% of the cadence so a "perfect" history can't collapse the
  // Gamma into an overconfident spike (and keeps the CDF numerically well-behaved).
  const sigHat = Math.max(std, SIGMA0_FRAC * 0.2 * muHat, 1);
  const shape = (muHat * muHat) / (sigHat * sigHat);
  const scale = (sigHat * sigHat) / muHat;
  if (!Number.isFinite(shape) || !Number.isFinite(scale) || shape <= 0 || scale <= 0) {
    return { pPrior: 0, wPrior: 0, cadence, ageHours };
  }

  // P(reset within next 24h | survived ageHours since the last reset).
  const fNow = lowerRegularizedGammaP(shape, ageHours / scale);
  const fNext = lowerRegularizedGammaP(shape, (ageHours + DELTA_HOURS) / scale);
  const survive = 1 - fNow;
  const pPrior = clip(survive > 1e-9 ? (fNext - fNow) / survive : 1, 1e-3, 1 - 1e-3);
  const confidence = Math.min(1, m / M_FULL) * regularityFactor;

  cadence.muHatHours = muHat;
  cadence.sigHatHours = sigHat;
  cadence.confidence = confidence;

  return { pPrior, wPrior: W_PRIOR_MAX * confidence, cadence, ageHours };
}

type MilestoneResult = { pMilestone: number; wMilestone: number };

// Extrapolate the next +1M milestone's ETA from logged crossings; return a
// proximity probability that rises as the forecast nears (and passes) that ETA.
function milestonePrior(milestones: Milestone[], now: Date): MilestoneResult {
  const points = milestones
    .map((m) => ({ ms: Date.parse(m.at), countM: m.countM }))
    .filter((p) => Number.isFinite(p.ms) && Number.isFinite(p.countM) && p.countM > 0)
    .sort((a, b) => a.ms - b.ms);
  if (points.length < MIN_MILESTONES) return { pMilestone: 0, wMilestone: 0 };

  const first = points[0];
  const last = points[points.length - 1];
  const spanDays = (last.ms - first.ms) / 86_400_000;
  const countGain = last.countM - first.countM;
  if (spanDays <= 0 || countGain <= 0) return { pMilestone: 0, wMilestone: 0 };

  const daysPerMilestone = spanDays / countGain;
  const daysSinceLast = (now.getTime() - last.ms) / 86_400_000;
  const progress = clip(daysSinceLast / daysPerMilestone, 0, 5);
  const pMilestone = clip(sigmoid((progress - MILESTONE_CENTER) / MILESTONE_SLOPE), 1e-3, 1 - 1e-3);
  return { pMilestone, wMilestone: W_MILESTONE_MAX };
}

function predictionWindow(chance: number): string {
  if (chance >= 75) return "Likely within 24h";
  if (chance >= 55) return "Possible within 24h";
  if (chance >= 35) return "Watch for more signals";
  return "No clear reset window";
}

function summary(status: Forecast["status"], chance: number, cadence: Cadence | null): string {
  if (status === "no-data") return "No fresh data is available, so no reset forecast is shown.";
  const note =
    cadence && cadence.confidence > 0
      ? ` Cadence prior active (~${Math.round(cadence.muHatHours)}h cycle, ${Math.round(
          cadence.confidence * 100
        )}% confidence).`
      : "";
  if (chance >= 75) return "Strong recent signals are clustering across trusted sources." + note;
  if (chance >= 55) return "Several useful signals exist, but confidence is still moderate." + note;
  if (chance >= 35) return "There are weak signals, but they do not agree strongly yet." + note;
  return "Current signals do not point to an imminent reset." + note;
}

export type ScoredForecast = {
  forecast: Forecast;
  features: ForecastFeatures | null;
  variants: ForecastVariants | null;
};

/**
 * Full scoring pipeline with decomposed outputs. The published forecast.chance
 * stays the hand-tuned blend; the model only produces the shadow `calibrated`
 * variant. `features` and `variants.blended` are computed BEFORE the model is
 * applied — the trainer must never see post-calibration values (no self-feeding).
 */
export function scoreForecastDetailed(
  signals: AuxSignal[],
  now: Date = new Date(),
  resets: ResetRecord[] = [],
  milestones: Milestone[] = [],
  model: OracleModel | null = null
): ScoredForecast {
  if (signals.length === 0) {
    // No live signals → honest no-data. A prior must never fabricate a chance.
    return {
      forecast: {
        status: "no-data",
        chance: 0,
        window: "No fresh data",
        summary: summary("no-data", 0, null),
        topSignals: [],
        generatedAt: now.toISOString()
      },
      features: null,
      variants: null
    };
  }

  const ranked = signals
    .map((signal) => scoreSignal(signal, now))
    .sort((a, b) => signalPointValue(b) - signalPointValue(a));

  const pointsBySource = cappedPointsBySource(ranked);
  let cappedTotal = 0;
  for (const points of pointsBySource.values()) cappedTotal += points;
  const agree = agreementBonus(ranked);
  const raw = cappedTotal + agree;
  const signalChance = Math.max(1, Math.min(95, Math.round(raw)));

  const { pPrior, wPrior, cadence, ageHours } = periodicPrior(resets, now);
  const pSignalClamped = clip(Math.min(raw, 95) / 100, 1e-3, 1 - 1e-3);

  let chance = signalChance;
  let priorChance: number | undefined;

  if (wPrior > 0) {
    // Blend the live signal with the age-conditioned periodic prior in logit space.
    const z = wPrior * logit(pPrior) + logit(pSignalClamped);
    chance = Math.max(1, Math.min(95, Math.round(100 * sigmoid(z))));
    priorChance = Math.max(1, Math.min(99, Math.round(100 * pPrior)));
  }
  // else: short-circuit — chance stays = signalChance (never-worse).

  // Milestone proximity is a ONE-WAY catalyst: blend onto the live signal and take
  // the max, so it lifts the chance as the next +1M milestone nears but never
  // double-counts "still early" with the age prior (which already handles dampening).
  const { pMilestone, wMilestone } = milestonePrior(milestones, now);
  if (wMilestone > 0) {
    const lifted = Math.max(
      1,
      Math.min(95, Math.round(100 * sigmoid(wMilestone * logit(pMilestone) + logit(pSignalClamped))))
    );
    if (lifted > chance) {
      chance = lifted;
      priorChance = Math.max(priorChance ?? 0, Math.max(1, Math.min(99, Math.round(100 * pMilestone))));
    }
  }

  // ── Decomposed features (pre-calibration, persisted for future training) ──
  const srcPts: Partial<Record<string, number>> = {};
  for (const [source, points] of pointsBySource) {
    srcPts[source] = Math.round(points * 100) / 100;
  }
  const radarStrengths = ranked
    .filter((item) => item.signal.source === "codex-reset-radar")
    .map((item) => sanitizeUnit(item.signal.strength));
  const nonRadarScores = ranked
    .filter((item) => item.signal.source !== "codex-reset-radar")
    .map((item) => item.sanitizedScore);

  const features: ForecastFeatures = {
    v: 1,
    srcPts,
    agree,
    kwTop: nonRadarScores.length > 0 ? Math.round(Math.max(...nonRadarScores) * 1000) / 1000 : 0,
    radarP: radarStrengths.length > 0 ? Math.round(Math.max(...radarStrengths) * 1000) / 1000 : null,
    pPrior: wPrior > 0 ? Math.round(pPrior * 1000) / 1000 : null,
    wPrior: Math.round(wPrior * 1000) / 1000,
    pMilestone: wMilestone > 0 ? Math.round(pMilestone * 1000) / 1000 : null,
    wMilestone: Math.round(wMilestone * 1000) / 1000,
    ageH: ageHours !== null ? Math.round(ageHours * 10) / 10 : null,
    nResets: cadence?.nResets ?? 0,
    cadenceConf: Math.round((cadence?.confidence ?? 0) * 1000) / 1000,
    signalChance
  };

  // ── Shadow variants — `calibrated` never touches the published chance ──
  const variants: ForecastVariants = {
    signalOnly: signalChance,
    priorOnly: wPrior > 0 ? Math.max(1, Math.min(99, Math.round(100 * pPrior))) : null,
    blended: chance,
    calibrated: applyModel(model, features, chance)
  };

  const forecast: Forecast = {
    status: "ok",
    chance,
    window: predictionWindow(chance),
    summary: summary("ok", chance, cadence),
    // Aux (scoring-only) sources never surface in the UI-facing list.
    topSignals: ranked.map((item) => item.signal).filter(isMainSignal).slice(0, 5),
    generatedAt: now.toISOString()
  };

  if (priorChance !== undefined) {
    forecast.priorChance = priorChance;
    forecast.signalChance = signalChance;
  }
  if (cadence) forecast.cadence = cadence;

  return { forecast, features, variants };
}

export function scoreForecast(
  signals: AuxSignal[],
  now: Date = new Date(),
  resets: ResetRecord[] = [],
  milestones: Milestone[] = []
): Forecast {
  return scoreForecastDetailed(signals, now, resets, milestones).forecast;
}

// Exported for unit-testing the numeric core.
export const __test = { median, sampleStd, lowerRegularizedGammaP, periodicPrior };
