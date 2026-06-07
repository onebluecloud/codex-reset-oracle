import type { Forecast, Signal } from "./types";

type ScoredSignal = {
  signal: Signal;
  ageHours: number;
  sanitizedScore: number;
};

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

function agreementBonus(items: ScoredSignal[]): number {
  const eligibleItems = items.filter((item) => item.ageHours <= 24 && item.sanitizedScore > 0);
  const sources = new Set(eligibleItems.map((item) => item.signal.source));
  if (sources.size >= 3) return 18;
  if (sources.size === 2) return 10;
  return 0;
}

function predictionWindow(chance: number): string {
  if (chance >= 75) return "Likely within 6-18 hours";
  if (chance >= 55) return "Possible within 18-36 hours";
  if (chance >= 35) return "Watch for more signals";
  return "No clear reset window";
}

function summary(status: Forecast["status"], chance: number): string {
  if (status === "no-data") return "No fresh data is available, so no reset forecast is shown.";
  if (chance >= 75) return "Strong recent signals are clustering across trusted sources.";
  if (chance >= 55) return "Several useful signals exist, but confidence is still moderate.";
  if (chance >= 35) return "There are weak signals, but they do not agree strongly yet.";
  return "Current signals do not point to an imminent reset.";
}

export function scoreForecast(signals: Signal[], now = new Date()): Forecast {
  if (signals.length === 0) {
    return {
      status: "no-data",
      chance: 0,
      window: "No fresh data",
      summary: summary("no-data", 0),
      topSignals: [],
      generatedAt: now.toISOString()
    };
  }

  const ranked = signals
    .map((signal) => scoreSignal(signal, now))
    .sort((a, b) => b.sanitizedScore - a.sanitizedScore);

  const raw = ranked.reduce((total, item) => total + item.sanitizedScore * 35, 0) + agreementBonus(ranked);
  const chance = Math.max(1, Math.min(95, Math.round(raw)));

  return {
    status: "ok",
    chance,
    window: predictionWindow(chance),
    summary: summary("ok", chance),
    topSignals: ranked.slice(0, 5).map((item) => item.signal),
    generatedAt: now.toISOString()
  };
}
