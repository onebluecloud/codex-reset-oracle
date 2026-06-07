import type { CollectorStatus, Signal } from "../types";

type CollectorResult = {
  status: CollectorStatus;
  signals: Signal[];
};

type ResetRadarPayload = {
  checked_at?: unknown;
  generated_at?: unknown;
  message?: unknown;
  prediction?: unknown;
};

type ResetRadarPrediction = {
  level: string;
  probability24h: number;
  probability48h: number;
  expectedWindow?: string;
  reasoningSummary?: string;
};

const RESET_RADAR_CURRENT_URL = "https://codex-reset-radar.pages.dev/current.json";
const RESET_RADAR_PAGE_URL = "https://codex-reset-radar.pages.dev/en/";
const MAX_FETCH_ATTEMPTS = 3;

export async function collectResetRadarSignals(): Promise<CollectorResult> {
  try {
    const response = await fetchResetRadarCurrent();

    if (!response.ok) {
      return {
        status: {
          source: "codex-reset-radar",
          ok: false,
          message: `Codex Reset Radar collector failed with HTTP ${response.status}.`
        },
        signals: []
      };
    }

    const payload: unknown = await response.json();
    const normalized = normalizeResetRadarPayload(payload);

    if (!normalized) {
      return {
        status: {
          source: "codex-reset-radar",
          ok: false,
          message: "Codex Reset Radar collector returned an unexpected JSON shape."
        },
        signals: []
      };
    }

    const fetchedAt = new Date().toISOString();

    return {
      status: {
        source: "codex-reset-radar",
        ok: true,
        message: "Fetched Codex Reset Radar prediction.",
        fetchedAt
      },
      signals: [normalized]
    };
  } catch {
    return {
      status: {
        source: "codex-reset-radar",
        ok: false,
        message: "Codex Reset Radar request failed."
      },
      signals: []
    };
  }
}

async function fetchResetRadarCurrent(): Promise<Response> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_FETCH_ATTEMPTS; attempt += 1) {
    try {
      return await fetch(RESET_RADAR_CURRENT_URL, {
        headers: { accept: "application/json" }
      });
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError;
}

function normalizeResetRadarPayload(value: unknown): Signal | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;

  const payload = value as ResetRadarPayload;
  const prediction = asPrediction(payload.prediction);
  if (!prediction) return null;

  const checkedAt = stringOrUndefined(payload.checked_at) ?? stringOrUndefined(payload.generated_at);
  const publishedAt = dateIsoOrEpoch(checkedAt);
  const probability24h = clampUnit(prediction.probability24h);
  const reasonParts = [
    `Codex Reset Radar: 24h ${formatPercent(probability24h)} reset chance.`,
    prediction.expectedWindow ? `Expected window: ${prediction.expectedWindow}.` : "",
    prediction.reasoningSummary ?? ""
  ].filter(Boolean);
  const textParts = [
    stringOrUndefined(payload.message),
    prediction.expectedWindow,
    prediction.reasoningSummary,
    `24h ${formatPercent(probability24h)}.`
  ].filter(Boolean);

  return {
    id: `codex-reset-radar:${checkedAt ?? "current"}`,
    source: "codex-reset-radar",
    sourceLabel: "Codex Reset Radar",
    sourceWeight: 1,
    strength: probability24h,
    title: `Codex Reset Radar: ${prediction.level} probability`,
    text: textParts.join(" "),
    url: RESET_RADAR_PAGE_URL,
    publishedAt,
    matchedKeywords: ["codex", "reset"],
    reason: reasonParts.join(" ")
  };
}

function asPrediction(value: unknown): ResetRadarPrediction | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;

  const prediction = value as Record<string, unknown>;
  const probability24h = numberOrNull(prediction.probability_24h);
  const probability48h = numberOrNull(prediction.probability_48h);

  if (probability24h === null || probability48h === null) return null;

  return {
    level: stringOrUndefined(prediction.level) ?? "unknown",
    probability24h,
    probability48h,
    expectedWindow: stringOrUndefined(prediction.expected_window),
    reasoningSummary: stringOrUndefined(prediction.reasoning_summary)
  };
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function clampUnit(value: number): number {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function dateIsoOrEpoch(value: string | undefined): string {
  if (!value) return new Date(0).toISOString();

  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : new Date(0).toISOString();
}

function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}
