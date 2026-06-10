import { describe, expect, it } from "vitest";

import {
  bucketCalibration,
  resolvePredlogEntries,
  selectNewArchiveEntries,
  variantMetrics,
  type PredlogEntry
} from "./kv";
import type { ForecastFeatures, ForecastVariants, ResetDetail } from "./types";

function entry(overrides: Partial<PredlogEntry>): PredlogEntry {
  return {
    at: "2026-06-01T00:00:00.000Z",
    chance: 30,
    signalChance: 30,
    priorChance: null,
    horizonH: 24,
    resolved: false,
    ...overrides
  };
}

describe("resolvePredlogEntries", () => {
  const NOW = new Date("2026-06-10T00:00:00.000Z");

  it("marks a due prediction as reset when a reset falls inside its horizon", () => {
    const rows = [entry({ at: "2026-06-05T00:00:00.000Z" })];
    const { updated, resolvedCount } = resolvePredlogEntries(rows, ["2026-06-05T12:00:00.000Z"], NOW);
    expect(resolvedCount).toBe(1);
    expect(updated[0].resolved).toBe(true);
    expect(updated[0].actualReset).toBe(true);
  });

  it("marks a due prediction as no-reset when no reset falls inside its horizon", () => {
    const rows = [entry({ at: "2026-06-05T00:00:00.000Z" })];
    const { updated } = resolvePredlogEntries(rows, ["2026-06-08T00:00:00.000Z"], NOW);
    expect(updated[0].resolved).toBe(true);
    expect(updated[0].actualReset).toBe(false);
  });

  it("leaves not-yet-due predictions untouched", () => {
    // +24h horizon ends 2026-06-10T18:00 which is after NOW.
    const rows = [entry({ at: "2026-06-09T18:00:00.000Z" })];
    const { updated, resolvedCount } = resolvePredlogEntries(rows, [], NOW);
    expect(resolvedCount).toBe(0);
    expect(updated[0].resolved).toBe(false);
  });

  it("leaves already-resolved entries untouched", () => {
    const rows = [entry({ at: "2026-06-01T00:00:00.000Z", resolved: true, actualReset: false })];
    const { resolvedCount } = resolvePredlogEntries(rows, ["2026-06-01T12:00:00.000Z"], NOW);
    expect(resolvedCount).toBe(0);
  });

  it("ignores reset timestamps outside the prediction's horizon", () => {
    const rows = [entry({ at: "2026-06-05T00:00:00.000Z" })];
    // Reset 2 days later — outside the 24h window.
    const { updated } = resolvePredlogEntries(rows, ["2026-06-07T00:00:00.000Z"], NOW);
    expect(updated[0].actualReset).toBe(false);
  });

  it("carries features and variants through resolution untouched", () => {
    const features: ForecastFeatures = {
      v: 1,
      srcPts: { github: 8 },
      agree: 0,
      kwTop: 0.45,
      radarP: 0.35,
      pPrior: 0.1,
      wPrior: 0.13,
      pMilestone: null,
      wMilestone: 0,
      ageH: 120.5,
      nResets: 5,
      cadenceConf: 0.45,
      signalChance: 14
    };
    const variants: ForecastVariants = { signalOnly: 14, priorOnly: 10, blended: 11, calibrated: 11 };
    const rows = [entry({ at: "2026-06-05T00:00:00.000Z", features, variants })];

    const { updated } = resolvePredlogEntries(rows, ["2026-06-05T12:00:00.000Z"], NOW);

    expect(updated[0].resolved).toBe(true);
    expect(updated[0].features).toEqual(features);
    expect(updated[0].variants).toEqual(variants);
  });
});

describe("bucketCalibration", () => {
  it("buckets resolved predictions and computes the per-bucket reset rate", () => {
    const rows = [
      entry({ chance: 12, resolved: true, actualReset: false }),
      entry({ chance: 15, resolved: true, actualReset: false }),
      entry({ chance: 72, resolved: true, actualReset: true }),
      entry({ chance: 78, resolved: true, actualReset: false }),
      entry({ chance: 50, resolved: false }) // unresolved → excluded
    ];
    const { buckets, resolved } = bucketCalibration(rows);
    expect(resolved).toBe(4);

    const b10 = buckets.find((bucket) => bucket.lo === 10)!;
    expect(b10.n).toBe(2);
    expect(b10.resets).toBe(0);
    expect(b10.rate).toBe(0);

    const b70 = buckets.find((bucket) => bucket.lo === 70)!;
    expect(b70.n).toBe(2);
    expect(b70.resets).toBe(1);
    expect(b70.rate).toBe(0.5);
  });

  it("reports rate=null for empty buckets and resolved=0 with no resolved rows", () => {
    const { buckets, resolved } = bucketCalibration([entry({ resolved: false })]);
    expect(resolved).toBe(0);
    expect(buckets.every((bucket) => bucket.n === 0 && bucket.rate === null)).toBe(true);
  });
});

describe("variantMetrics", () => {
  const variants = (overrides: Partial<ForecastVariants>): ForecastVariants => ({
    signalOnly: 20,
    priorOnly: 10,
    blended: 15,
    calibrated: 15,
    ...overrides
  });

  it("computes per-variant Brier/log-loss and a paired count", () => {
    const rows = [
      entry({ resolved: true, actualReset: false, variants: variants({ blended: 10 }) }),
      entry({ resolved: true, actualReset: true, variants: variants({ blended: 80, priorOnly: null }) }),
      entry({ resolved: true, actualReset: false }), // legacy row without variants → excluded
      entry({ resolved: false, variants: variants({}) }) // unresolved → excluded
    ];

    const metrics = variantMetrics(rows);

    expect(metrics.blended.n).toBe(2);
    // Brier = ((0.10-0)^2 + (0.80-1)^2) / 2 = (0.01 + 0.04) / 2.
    expect(metrics.blended.brier).toBeCloseTo(0.025, 6);
    expect(metrics.priorOnly.n).toBe(1); // null in the second row → skipped there
    // Only the first row has all four variants present.
    expect(metrics.pairedN).toBe(1);
  });

  it("returns null metrics with no resolved variant rows", () => {
    const metrics = variantMetrics([entry({ resolved: true, actualReset: false })]);
    expect(metrics.blended.n).toBe(0);
    expect(metrics.blended.brier).toBeNull();
    expect(metrics.pairedN).toBe(0);
  });
});

describe("selectNewArchiveEntries", () => {
  const detail = (at: string, overrides: Partial<ResetDetail> = {}): ResetDetail => ({
    at,
    title: "重置",
    scope: "所有付费计划",
    kind: "other",
    ...overrides
  });

  it("keeps only details not within 6h of an archived entry, sorted ascending", () => {
    const existing = [detail("2026-06-04T00:25:00.000Z")];
    const incoming = [
      detail("2026-06-04T03:00:00.000Z"), // within 6h of existing → dup
      detail("2026-05-31T05:59:00.000Z"), // new
      detail("2026-04-17T00:58:00.000Z") // new (and should sort first)
    ];

    const fresh = selectNewArchiveEntries(existing, incoming);

    expect(fresh.map((entry) => entry.at)).toEqual([
      "2026-04-17T00:58:00.000Z",
      "2026-05-31T05:59:00.000Z"
    ]);
  });

  it("dedupes within the incoming batch itself and drops bad timestamps", () => {
    const incoming = [
      detail("2026-06-04T00:25:00.000Z"),
      detail("2026-06-04T02:00:00.000Z"), // within 6h of the previous incoming
      detail("not-a-date")
    ];

    const fresh = selectNewArchiveEntries([], incoming);

    expect(fresh).toHaveLength(1);
    expect(fresh[0].at).toBe("2026-06-04T00:25:00.000Z");
  });
});
