export type SignalSource = "x" | "openai-status" | "github" | "codex-reset-radar";

/**
 * Auxiliary scoring-only sources. They are deliberately NOT part of SignalSource:
 * the UI keeps an exhaustive Record<SignalSource, string> label map, so widening
 * that union would break the components layer. Aux signals feed the forecast
 * score but never appear in Snapshot.signals / Forecast.topSignals / collectors.
 */
export type AuxSource = "hn" | "openai-forum";

export type AnySource = SignalSource | AuxSource;

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

/** A Signal whose source may be an auxiliary (scoring-only) source. */
export type AuxSignal = Omit<Signal, "source"> & { source: AnySource };

export type AuxCollectorStatus = Omit<CollectorStatus, "source"> & { source: AnySource };

/**
 * A fleet-wide official reset parsed from radar recent_windows, with enough
 * context to classify its driver. Archived append-only in KV so gap history
 * outlives radar's rolling 10-entry window.
 */
export type ResetDetail = {
  at: string;
  title: string;
  scope: string;
  kind: "incident" | "milestone" | "celebration" | "other";
};

/** A fleet-wide reset projected onto the forecast axis as an event marker. */
export type AxisEvent = {
  at: string;
  label: string;
  kind: ResetDetail["kind"];
};

export type Cadence = {
  medianGapHours: number;
  muHatHours: number;
  sigHatHours: number;
  nResets: number;
  confidence: number;
  computedAt: string;
};

export type Milestone = {
  /** ISO timestamp the milestone reset was crossed. */
  at: string;
  /** User count in millions (e.g. 5 for "500 万用户"). */
  countM: number;
};

export type BoardStatus = "likely" | "watch" | "tossup" | "unlikely" | "shifting";
export type BoardDirection = "rising" | "falling" | "stable";

/**
 * One row of the Forecast Board — the same Codex-reset event read from a
 * different angle (a time window or a single driver). Every probability is a
 * real decomposition of the scoring pipeline, never a fabricated extra event.
 */
export type BoardRow = {
  id: string;
  question: string;
  probability: number;
  status: BoardStatus;
  statusLabel: string;
  direction: BoardDirection;
  /** Short window/age caption, e.g. "24H WINDOW" or "5D SINCE LAST". */
  deadline: string;
  /** Confidence caption, e.g. "±9%", "conf 45%", "estimate". */
  confidence: string;
  lastSignal: string;
  /** True for the oversized primary (24h) row. */
  lead?: boolean;
};

export type Forecast = {
  status: ForecastStatus;
  chance: number;
  window: string;
  summary: string;
  topSignals: Signal[];
  generatedAt: string;
  /** Present only when a validated cadence prior is blended in. */
  priorChance?: number;
  signalChance?: number;
  cadence?: Cadence;
  /** The Forecast Board rows — the headline event read several ways. */
  board?: BoardRow[];
};

/**
 * The decomposed inputs behind one forecast, persisted per predlog entry so a
 * future trained model has historical features to learn from. Versioned: the
 * trainer filters on v so schema changes can't poison old samples.
 */
export type ForecastFeatures = {
  v: 1;
  /** Per-source capped signal points (keys are AnySource values). */
  srcPts: Partial<Record<string, number>>;
  /** Cross-source agreement bonus actually applied (0 | 10 | 18). */
  agree: number;
  /** Max sanitized score (weight x strength x recency) among non-radar signals. */
  kwTop: number;
  /** Radar's own probability estimate (its signal strength), if present. */
  radarP: number | null;
  pPrior: number | null;
  wPrior: number;
  pMilestone: number | null;
  wMilestone: number;
  /** Hours since the last known fleet-wide reset (null when unknown). */
  ageH: number | null;
  nResets: number;
  cadenceConf: number;
  signalChance: number;
};

/**
 * Shadow-model probabilities recorded alongside every prediction. The published
 * chance stays the hand-tuned blend; `calibrated` is a shadow until the
 * reliability data proves it wins across enough real resets.
 */
export type ForecastVariants = {
  signalOnly: number;
  priorOnly: number | null;
  blended: number;
  calibrated: number;
};

export type Snapshot = {
  forecast: Forecast;
  signals: Signal[];
  collectors: CollectorStatus[];
  /** Auxiliary scoring-only collector statuses — absent unless aux sources ran. */
  auxCollectors?: AuxCollectorStatus[];
};
