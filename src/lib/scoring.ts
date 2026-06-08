import type { ResetRecord } from "./kv";
import type { Cadence, Forecast, Signal } from "./types";

type ScoredSignal = {
  signal: Signal;
  ageHours: number;
  sanitizedScore: number;
};

const DEFAULT_SOURCE_POINT_CAP = 35;
const SOURCE_POINT_CAPS: Partial<Record<Signal["source"], number>> = {
  github: 8,
  "codex-reset-radar": 75
};
const DEFAULT_SOURCE_POINT_SCALE = 35;
const SOURCE_POINT_SCALES: Partial<Record<Signal["source"], number>> = {
  "codex-reset-radar": 100
};
const AGREEMENT_ELIGIBLE_SOURCES = new Set<Signal["source"]>([
  "x",
  "openai-status",
  "codex-reset-radar"
]);

function sanitizeUnit(value: number): number {
  if (!Number.isFinite(value) || value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function hoursOld(signal: Signal, now: Date): number {
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

function scoreSignal(signal: Signal, now: Date): ScoredSignal {
  const ageHours = hoursOld(signal, now);
  const sourceWeight = sanitizeUnit(signal.sourceWeight);
  const strength = sanitizeUnit(signal.strength);

  return {
    signal,
    ageHours,
    sanitizedScore: sourceWeight * strength * recencyMultiplier(ageHours)
  };
}

function sourcePointCap(source: Signal["source"]): number {
  return SOURCE_POINT_CAPS[source] ?? DEFAULT_SOURCE_POINT_CAP;
}

function sourcePointScale(source: Signal["source"]): number {
  return SOURCE_POINT_SCALES[source] ?? DEFAULT_SOURCE_POINT_SCALE;
}

function signalPointValue(item: ScoredSignal): number {
  return item.sanitizedScore * sourcePointScale(item.signal.source);
}

function cappedSignalPoints(items: ScoredSignal[]): number {
  const pointsBySource = new Map<Signal["source"], number>();

  for (const item of items) {
    const source = item.signal.source;
    pointsBySource.set(source, (pointsBySource.get(source) ?? 0) + signalPointValue(item));
  }

  return Array.from(pointsBySource.entries()).reduce(
    (total, [source, points]) => total + Math.min(points, sourcePointCap(source)),
    0
  );
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
// Adversarially reviewed design: the cadence prior contributes weight ONLY when
// the logged resets reveal a *validated* regular cadence (enough clean gaps AND
// low variation). Otherwise wPrior == 0 and the output is byte-for-byte today's
// signal-only forecast — so a few noisy reset timestamps can never make it worse.
const MU0_HOURS = 168; // weekly prior mean gap — a hand-set belief, dominated by data once gaps accrue
const SIGMA0_FRAC = 0.5;
const DELTA_HOURS = 24; // forecast horizon (matches the UI's "next 24h")
const W_PRIOR_MAX = 0.3; // tempered: the prior nudges, never dominates the live signal
const M_FULL = 8; // clean gaps needed for the prior to reach full (tempered) weight
const GAP_FLOOR_HOURS = 6; // drop physically-impossible gaps (e.g. a double mark-reset)
const MIN_GAPS_FOR_PRIOR = 4; // need >= 4 clean gaps (>= 5 resets) before any weight
const REGULARITY_CV_MAX = 0.4; // only a measured low-variation cadence counts as a "clock"
const MU_LOW = 0.5 * MU0_HOURS;
const MU_HIGH = 2 * MU0_HOURS;

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

type PriorResult = { pPrior: number; wPrior: number; cadence: Cadence | null };

function periodicPrior(resets: ResetRecord[], now: Date): PriorResult {
  const times = resets
    .map((reset) => Date.parse(reset.at))
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => a - b);
  const n = times.length;
  if (n < 2) return { pPrior: 0, wPrior: 0, cadence: null };

  const ageHours = Math.max(0, (now.getTime() - times[n - 1]) / 3_600_000);

  const gaps: number[] = [];
  for (let i = 1; i < n; i += 1) gaps.push((times[i] - times[i - 1]) / 3_600_000);
  const cleanGaps = gaps.filter((gap) => gap >= GAP_FLOOR_HOURS);
  const m = cleanGaps.length;
  if (m < MIN_GAPS_FOR_PRIOR) return { pPrior: 0, wPrior: 0, cadence: null };

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

  // Regularity gate: a handful of points is not a clock. Require a *measured*
  // low-variation cadence before letting the age term move the number at all.
  if (!Number.isFinite(cv) || cv >= REGULARITY_CV_MAX) {
    return { pPrior: 0, wPrior: 0, cadence };
  }

  // Bound the cadence so a single missed log can't run the prior off a cliff.
  const muHat = clip(medianGap, MU_LOW, MU_HIGH);
  // Floor the spread to ~10% of the cadence so a "perfect" history can't collapse the
  // Gamma into an overconfident spike (and keeps the CDF numerically well-behaved).
  const sigHat = Math.max(std, SIGMA0_FRAC * 0.2 * muHat, 1);
  const shape = (muHat * muHat) / (sigHat * sigHat);
  const scale = (sigHat * sigHat) / muHat;
  if (!Number.isFinite(shape) || !Number.isFinite(scale) || shape <= 0 || scale <= 0) {
    return { pPrior: 0, wPrior: 0, cadence };
  }

  // P(reset within next 24h | survived ageHours since the last reset).
  const fNow = lowerRegularizedGammaP(shape, ageHours / scale);
  const fNext = lowerRegularizedGammaP(shape, (ageHours + DELTA_HOURS) / scale);
  const survive = 1 - fNow;
  const pPrior = clip(survive > 1e-9 ? (fNext - fNow) / survive : 1, 1e-3, 1 - 1e-3);
  const confidence = Math.min(1, m / M_FULL);

  cadence.muHatHours = muHat;
  cadence.sigHatHours = sigHat;
  cadence.confidence = confidence;

  return { pPrior, wPrior: W_PRIOR_MAX * confidence, cadence };
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

export function scoreForecast(
  signals: Signal[],
  now: Date = new Date(),
  resets: ResetRecord[] = []
): Forecast {
  if (signals.length === 0) {
    // No live signals → honest no-data. A prior must never fabricate a chance.
    return {
      status: "no-data",
      chance: 0,
      window: "No fresh data",
      summary: summary("no-data", 0, null),
      topSignals: [],
      generatedAt: now.toISOString()
    };
  }

  const ranked = signals
    .map((signal) => scoreSignal(signal, now))
    .sort((a, b) => signalPointValue(b) - signalPointValue(a));

  const raw = cappedSignalPoints(ranked) + agreementBonus(ranked);
  const signalChance = Math.max(1, Math.min(95, Math.round(raw)));

  const { pPrior, wPrior, cadence } = periodicPrior(resets, now);

  let chance = signalChance;
  let priorChance: number | undefined;

  if (wPrior > 0) {
    // Blend the live signal with the age-conditioned periodic prior in logit space.
    // (Clamp raw to the same 95 ceiling the signal-only path uses so an overflowing
    // raw score can't saturate the logit.)
    const pSignal = clip(Math.min(raw, 95) / 100, 1e-3, 1 - 1e-3);
    const z = wPrior * logit(pPrior) + logit(pSignal);
    chance = Math.max(1, Math.min(95, Math.round(100 * sigmoid(z))));
    priorChance = Math.max(1, Math.min(99, Math.round(100 * pPrior)));
  }
  // else: short-circuit — chance stays = signalChance = today's exact output (never-worse).

  const forecast: Forecast = {
    status: "ok",
    chance,
    window: predictionWindow(chance),
    summary: summary("ok", chance, cadence),
    topSignals: ranked.slice(0, 5).map((item) => item.signal),
    generatedAt: now.toISOString()
  };

  if (priorChance !== undefined) {
    forecast.priorChance = priorChance;
    forecast.signalChance = signalChance;
  }
  if (cadence) forecast.cadence = cadence;

  return forecast;
}

// Exported for unit-testing the numeric core.
export const __test = { median, sampleStd, lowerRegularizedGammaP, periodicPrior };
