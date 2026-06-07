export type SignalSource = "x" | "openai-status" | "github" | "codex-reset-radar";

export type ForecastStatus = "ok" | "partial" | "stale" | "no-data";

export type CollectorStatus = {
  source: SignalSource;
  ok: boolean;
  message: string;
  fetchedAt?: string;
  stale?: boolean;
};

export type Signal = {
  id: string;
  source: SignalSource;
  sourceLabel: string;
  sourceWeight: number;
  author?: string;
  title: string;
  text: string;
  url: string;
  publishedAt: string;
  matchedKeywords: string[];
  strength: number;
  reason: string;
};

export type Forecast = {
  status: ForecastStatus;
  chance: number;
  window: string;
  summary: string;
  topSignals: Signal[];
  generatedAt: string;
};

export type Snapshot = {
  forecast: Forecast;
  signals: Signal[];
  collectors: CollectorStatus[];
};
