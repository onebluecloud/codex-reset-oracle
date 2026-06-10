import { describe, expect, it } from "vitest";

import {
  applyModel,
  countResetEvents,
  featureVector,
  fitLogistic,
  isValidModel,
  MIN_EVENTS_PLATT,
  PLATT_FEATURE,
  trainModel,
  type OracleModel,
  type TrainRow
} from "./model";
import type { ForecastFeatures } from "./types";

const NOW = new Date("2026-06-10T00:00:00.000Z");

function plattModel(overrides: Partial<OracleModel> = {}): OracleModel {
  return {
    v: 1,
    kind: "platt",
    featNames: [PLATT_FEATURE],
    mu: [0],
    sigma: [1],
    w: [1],
    b: 0,
    nSamples: 1000,
    nEvents: 8,
    nPos: 100,
    trainedAt: NOW.toISOString(),
    trainBrier: 0.05,
    baselineBrier: 0.06,
    ...overrides
  };
}

function features(overrides: Partial<ForecastFeatures> = {}): ForecastFeatures {
  return {
    v: 1,
    srcPts: { github: 8, "codex-reset-radar": 35 },
    agree: 0,
    kwTop: 0.45,
    radarP: 0.35,
    pPrior: 0.1,
    wPrior: 0.13,
    pMilestone: null,
    wMilestone: 0,
    ageH: 120,
    nResets: 5,
    cadenceConf: 0.45,
    signalChance: 14,
    ...overrides
  };
}

/**
 * Synthetic resolved rows: `events` resets, each contributing ~24 positive
 * hourly rows, padded with negatives. Predictions are mildly informative
 * (higher chance near resets) with a systematic bias the trainer can learn.
 */
function syntheticRows(events: number, negPerEvent: number = 120): TrainRow[] {
  const rows: TrainRow[] = [];
  let cursor = Date.parse("2026-01-01T00:00:00.000Z");
  const hour = 3_600_000;
  for (let event = 0; event < events; event += 1) {
    for (let i = 0; i < negPerEvent; i += 1) {
      const chance = 8 + ((event * 31 + i * 7) % 10); // 8-17, systematically too high
      rows.push({
        at: new Date(cursor).toISOString(),
        chance,
        resolved: true,
        actualReset: false,
        variants: { signalOnly: chance, priorOnly: null, blended: chance, calibrated: chance }
      });
      cursor += hour;
    }
    for (let i = 0; i < 24; i += 1) {
      const chance = 25 + ((event * 17 + i * 5) % 20); // 25-44 ahead of a reset
      rows.push({
        at: new Date(cursor).toISOString(),
        chance,
        resolved: true,
        actualReset: true,
        variants: { signalOnly: chance, priorOnly: null, blended: chance, calibrated: chance }
      });
      cursor += hour;
    }
    cursor += 80 * hour; // spacing so events cluster independently
  }
  return rows;
}

describe("fitLogistic", () => {
  it("learns a separable synthetic boundary", () => {
    const X: number[][] = [];
    const y: number[] = [];
    for (let i = 0; i < 200; i += 1) {
      const value = (i % 20) - 10;
      X.push([value]);
      y.push(value > 0 ? 1 : 0);
    }
    const fit = fitLogistic(X, y);
    expect(fit).not.toBeNull();
    expect(fit!.w[0]).toBeGreaterThan(0); // higher feature → higher probability
  });

  it("returns null for empty or ragged input", () => {
    expect(fitLogistic([], [])).toBeNull();
    expect(fitLogistic([[1], [1, 2]], [0, 1])).toBeNull();
  });
});

describe("applyModel", () => {
  it("is the identity without a model", () => {
    expect(applyModel(null, features(), 14)).toBe(14);
  });

  it("barely moves the output when very few events back the model", () => {
    // Strong miscalibration claim, but only 1 event → shrinkage ≈ 1/11.
    const model = plattModel({ nEvents: 1, w: [3], b: 2 });
    const out = applyModel(model, features(), 14);
    expect(Math.abs(out - 14)).toBeLessThanOrEqual(6);
  });

  it("moves further with more events behind the same coefficients", () => {
    const few = applyModel(plattModel({ nEvents: 1, w: [3], b: 2 }), features(), 14);
    const many = applyModel(plattModel({ nEvents: 40, w: [3], b: 2 }), features(), 14);
    expect(Math.abs(many - 14)).toBeGreaterThan(Math.abs(few - 14));
  });

  it("falls back to the hand-tuned chance on a malformed model", () => {
    const broken = plattModel({ w: [Number.NaN] });
    expect(applyModel(broken, features(), 14)).toBe(14);
  });

  it("stays within [1, 95]", () => {
    const aggressive = plattModel({ nEvents: 1000, w: [10], b: 10 });
    const out = applyModel(aggressive, features(), 90);
    expect(out).toBeGreaterThanOrEqual(1);
    expect(out).toBeLessThanOrEqual(95);
  });
});

describe("countResetEvents", () => {
  it("clusters positive rows within 48h into one event", () => {
    const rows: TrainRow[] = [];
    const base = Date.parse("2026-06-01T00:00:00.000Z");
    // 24 hourly positives (one event), then a second burst 10 days later.
    for (let i = 0; i < 24; i += 1) {
      rows.push({
        at: new Date(base + i * 3_600_000).toISOString(),
        chance: 30,
        resolved: true,
        actualReset: true
      });
    }
    rows.push({
      at: new Date(base + 240 * 3_600_000).toISOString(),
      chance: 30,
      resolved: true,
      actualReset: true
    });

    expect(countResetEvents(rows)).toBe(2);
  });

  it("counts zero events with no positives", () => {
    expect(countResetEvents([{ at: NOW.toISOString(), chance: 10, resolved: true, actualReset: false }])).toBe(0);
  });
});

describe("trainModel", () => {
  it("refuses to train below the independent-event gate", () => {
    expect(trainModel(syntheticRows(MIN_EVENTS_PLATT - 1), NOW)).toBeNull();
  });

  it("refuses to train below the minimum row count even with enough events", () => {
    // 5 independent events but only 420 rows (< MIN_TRAIN_ROWS): without a real
    // holdout there is no honest evaluation — in-sample comparison would let a
    // 2-param Platt "beat" the data it just fitted.
    const rows = syntheticRows(5, 60);
    expect(rows.length).toBeLessThan(500);
    expect(trainModel(rows, NOW)).toBeNull();
  });

  it("refuses to train when the holdout contains no reset events", () => {
    // All events in the front 80%, a long quiet tail in the holdout: Brier on
    // an all-negative slice rewards ANY monotone push toward 0, so the champion
    // gate must refuse rather than certify a probability-crusher.
    const rows = syntheticRows(6);
    const lastMs = Date.parse(rows[rows.length - 1].at);
    for (let i = 1; i <= 300; i += 1) {
      rows.push({
        at: new Date(lastMs + i * 3_600_000).toISOString(),
        chance: 10,
        resolved: true,
        actualReset: false,
        variants: { signalOnly: 10, priorOnly: null, blended: 10, calibrated: 10 }
      });
    }
    expect(trainModel(rows, NOW)).toBeNull();
  });

  it("trains a Platt model once enough events accrue, and beats the baseline", () => {
    const model = trainModel(syntheticRows(8), NOW);
    expect(model).not.toBeNull();
    expect(model!.kind).toBe("platt");
    expect(model!.nEvents).toBeGreaterThanOrEqual(MIN_EVENTS_PLATT);
    expect(model!.trainBrier).toBeLessThan(model!.baselineBrier);
    expect(isValidModel(model)).toBe(true);
  });

  it("trains on the pre-calibration blend, never on the calibrated shadow", () => {
    // Poison the calibrated variant: if the trainer read it, coefficients and
    // Brier would shift. They must not.
    const clean = syntheticRows(8);
    const poisoned = clean.map((row) => ({
      ...row,
      variants: row.variants ? { ...row.variants, calibrated: 99 } : undefined
    }));

    const a = trainModel(clean, NOW);
    const b = trainModel(poisoned, NOW);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(b!.w).toEqual(a!.w);
    expect(b!.b).toBe(a!.b);
    expect(b!.trainBrier).toBe(a!.trainBrier);
  });

  it("returns null when predictions are already well calibrated (no edge to learn)", () => {
    // Truthful probabilities: chance ~= actual frequency. Platt cannot beat the
    // baseline by the champion margin, so no model should be written.
    const rows: TrainRow[] = [];
    let cursor = Date.parse("2026-01-01T00:00:00.000Z");
    const hour = 3_600_000;
    for (let event = 0; event < 8; event += 1) {
      for (let i = 0; i < 230; i += 1) {
        rows.push({
          at: new Date(cursor).toISOString(),
          chance: 9,
          resolved: true,
          actualReset: (event * 230 + i) % 11 === 0, // ~9% scattered positives...
          variants: undefined
        });
        cursor += hour;
      }
      cursor += 80 * hour;
    }
    // Scattered positives never cluster into >=5 events of 24 rows — adjust by
    // checking that EITHER the event gate or the champion gate refuses.
    expect(trainModel(rows, NOW)).toBeNull();
  });
});

describe("isValidModel", () => {
  it("rejects garbage, accepts a well-formed model", () => {
    expect(isValidModel(null)).toBe(false);
    expect(isValidModel({})).toBe(false);
    expect(isValidModel(plattModel({ w: [Number.POSITIVE_INFINITY] }))).toBe(false);
    expect(isValidModel(plattModel({ w: [1, 2] }))).toBe(false); // length mismatch
    expect(isValidModel(plattModel())).toBe(true);
  });
});

describe("featureVector", () => {
  it("reads srcPts.* and top-level features, defaulting missing/null to 0", () => {
    const vector = featureVector(features({ pMilestone: null, ageH: null }), [
      "srcPts.github",
      "srcPts.hn",
      "pMilestone",
      "ageH",
      "signalChance"
    ]);
    expect(vector).toEqual([8, 0, 0, 0, 14]);
  });
});
