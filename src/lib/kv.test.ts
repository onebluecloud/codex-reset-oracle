import { describe, expect, it } from "vitest";

import { bucketCalibration, resolvePredlogEntries, type PredlogEntry } from "./kv";

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
