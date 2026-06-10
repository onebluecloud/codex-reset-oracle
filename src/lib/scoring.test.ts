import { describe, expect, it } from "vitest";

import type { ResetRecord } from "./kv";
import { __test, scoreForecast, scoreForecastDetailed } from "./scoring";
import type { AuxSignal, Signal } from "./types";

const NOW = new Date("2026-06-07T12:00:00.000Z");

function signal(overrides: Partial<Signal>): Signal {
  return {
    id: "signal-1",
    source: "x",
    sourceLabel: "X",
    sourceWeight: 1,
    strength: 1,
    title: "Codex reset signal",
    text: "Codex reset signal",
    url: "https://example.com/signal-1",
    publishedAt: new Date("2026-06-07T10:00:00.000Z").toISOString(),
    matchedKeywords: ["codex", "reset"],
    reason: "High-signal source mentioned Codex reset.",
    ...overrides
  };
}

describe("scoreForecast", () => {
  it("returns no-data when there are no signals", () => {
    const forecast = scoreForecast([], NOW);

    expect(forecast.status).toBe("no-data");
    expect(forecast.chance).toBe(0);
    expect(forecast.window).toBe("No fresh data");
    expect(forecast.topSignals).toHaveLength(0);
    expect(forecast.summary).toMatch(/no fresh data/i);
  });

  it("scores strong recent official and team signals across x and openai-status", () => {
    const forecast = scoreForecast(
      [
        signal({
          id: "official-status",
          source: "openai-status",
          title: "OpenAI status notes Codex quota reset recovery",
          url: "https://status.openai.com/incidents/example",
          publishedAt: new Date("2026-06-07T11:00:00.000Z").toISOString()
        }),
        signal({
          id: "team-x",
          source: "x",
          title: "OpenAI team says Codex limits reset capacity is recovering",
          url: "https://x.com/OpenAIDevs/status/example",
          publishedAt: new Date("2026-06-07T09:00:00.000Z").toISOString()
        })
      ],
      NOW
    );

    expect(forecast.chance).toBeGreaterThanOrEqual(70);
    expect(forecast.topSignals).toHaveLength(2);
    expect(forecast.summary).toMatch(/strong/i);
  });

  it("keeps stale weak signals below a clear reset window", () => {
    const forecast = scoreForecast(
      [
        signal({
          id: "stale-weak",
          source: "github",
          sourceWeight: 0.35,
          strength: 0.2,
          title: "Old queue mention",
          url: "https://github.com/example/repo/issues/1",
          publishedAt: new Date("2026-06-03T08:00:00.000Z").toISOString()
        })
      ],
      NOW
    );

    expect(forecast.chance).toBeLessThan(30);
    expect(forecast.window).toBe("No clear reset window");
  });

  it("keeps repeated GitHub issues from creating a likely reset forecast by themselves", () => {
    const githubSignals = Array.from({ length: 20 }, (_, index) =>
      signal({
        id: `github-${index}`,
        source: "github",
        sourceWeight: 0.45,
        strength: 1,
        title: `GitHub quota reset issue ${index}`,
        url: `https://github.com/openai/codex/issues/${index}`,
        publishedAt: new Date("2026-06-07T11:00:00.000Z").toISOString()
      })
    );

    const forecast = scoreForecast(githubSignals, NOW);

    expect(forecast.chance).toBeLessThan(55);
    expect(forecast.window).not.toBe("Likely within 24h");
  });

  it("uses Codex Reset Radar probability as an aggregate forecast signal", () => {
    const forecast = scoreForecast(
      [
        signal({
          id: "radar-current",
          source: "codex-reset-radar",
          sourceLabel: "Codex Reset Radar",
          sourceWeight: 1,
          strength: 0.35,
          title: "Codex Reset Radar: medium probability",
          url: "https://codex-reset-radar.pages.dev/en/",
          publishedAt: new Date("2026-06-07T11:00:00.000Z").toISOString()
        })
      ],
      NOW
    );

    expect(forecast.chance).toBe(35);
    expect(forecast.window).toBe("Watch for more signals");
  });

  it("does not treat GitHub issues as independent confirmation of a Radar forecast", () => {
    const githubSignals = Array.from({ length: 20 }, (_, index) =>
      signal({
        id: `github-noise-${index}`,
        source: "github",
        sourceWeight: 0.45,
        strength: 1,
        title: `GitHub quota reset issue ${index}`,
        url: `https://github.com/openai/codex/issues/${index}`,
        publishedAt: new Date("2026-06-07T11:00:00.000Z").toISOString()
      })
    );
    const forecast = scoreForecast(
      [
        signal({
          id: "radar-current",
          source: "codex-reset-radar",
          sourceLabel: "Codex Reset Radar",
          sourceWeight: 1,
          strength: 0.35,
          title: "Codex Reset Radar: medium probability",
          url: "https://codex-reset-radar.pages.dev/en/",
          publishedAt: new Date("2026-06-07T11:00:00.000Z").toISOString()
        }),
        signal({
          id: "stale-status",
          source: "openai-status",
          sourceWeight: 0.9,
          strength: 0.5,
          title: "Stale OpenAI Status Codex limit mention",
          url: "https://status.openai.com",
          publishedAt: new Date("2026-06-04T12:00:00.000Z").toISOString()
        }),
        ...githubSignals
      ],
      NOW
    );

    expect(forecast.chance).toBeLessThan(55);
    expect(forecast.window).toBe("Watch for more signals");
    expect(forecast.topSignals[0]?.source).toBe("codex-reset-radar");
  });

  it("does not count stale sources toward cross-source agreement", () => {
    const forecast = scoreForecast(
      [
        signal({
          id: "fresh-x",
          source: "x",
          sourceWeight: 1,
          strength: 1,
          title: "Fresh X Codex reset signal",
          url: "https://x.com/OpenAIDevs/status/fresh",
          publishedAt: new Date("2026-06-07T11:00:00.000Z").toISOString()
        }),
        signal({
          id: "stale-status",
          source: "openai-status",
          sourceWeight: 1,
          strength: 1,
          title: "Stale status Codex recovery signal",
          url: "https://status.openai.com/incidents/stale",
          publishedAt: new Date("2026-06-03T11:00:00.000Z").toISOString()
        }),
        signal({
          id: "stale-github",
          source: "github",
          sourceWeight: 1,
          strength: 1,
          title: "Stale GitHub quota signal",
          url: "https://github.com/openai/codex/issues/1",
          publishedAt: new Date("2026-06-03T11:00:00.000Z").toISOString()
        })
      ],
      NOW
    );

    expect(forecast.chance).toBeLessThan(55);
    expect(forecast.window).toBe("Watch for more signals");
  });

  it("keeps bad numeric signal values from producing NaN chance", () => {
    expect(() =>
      scoreForecast(
        [
          signal({
            id: "nan-weight",
            sourceWeight: Number.NaN,
            strength: 1
          }),
          signal({
            id: "infinite-strength",
            sourceWeight: 1,
            strength: Number.POSITIVE_INFINITY
          }),
          signal({
            id: "negative-values",
            sourceWeight: -0.2,
            strength: -1
          }),
          signal({
            id: "too-large-values",
            sourceWeight: 2,
            strength: 3
          })
        ],
        NOW
      )
    ).not.toThrow();

    const forecast = scoreForecast(
      [
        signal({
          id: "nan-weight",
          sourceWeight: Number.NaN,
          strength: 1
        }),
        signal({
          id: "infinite-strength",
          sourceWeight: 1,
          strength: Number.POSITIVE_INFINITY
        }),
        signal({
          id: "negative-values",
          sourceWeight: -0.2,
          strength: -1
        }),
        signal({
          id: "too-large-values",
          sourceWeight: 2,
          strength: 3
        })
      ],
      NOW
    );

    expect(Number.isFinite(forecast.chance)).toBe(true);
    expect(forecast.chance).toBeGreaterThanOrEqual(1);
    expect(forecast.chance).toBeLessThanOrEqual(95);
  });
});

describe("aux community sources in scoring", () => {
  function hnSignal(index: number): AuxSignal {
    return {
      ...signal({ id: `hn-${index}` }),
      source: "hn",
      sourceLabel: "Hacker News",
      sourceWeight: 0.4,
      url: `https://news.ycombinator.com/item?id=${index}`,
      publishedAt: new Date("2026-06-07T11:00:00.000Z").toISOString()
    };
  }

  it("caps a flood of HN signals at the low per-source budget", () => {
    const flood = Array.from({ length: 30 }, (_, index) => hnSignal(index));
    const forecast = scoreForecast(flood, NOW);
    // 30 strong HN items capped at 10 points — community noise nudges only.
    expect(forecast.chance).toBeLessThanOrEqual(10);
  });

  it("keeps aux sources out of topSignals and the agreement bonus", () => {
    const forecast = scoreForecast(
      [hnSignal(1), signal({ id: "main-x", source: "x" })],
      NOW
    );
    // topSignals is typed Signal[] (main sources only) — the aux item must be gone.
    expect(forecast.topSignals.map((item) => item.id)).toEqual(["main-x"]);
    // One main + one aux source → no 2-source agreement bonus from aux.
    const mainOnly = scoreForecast([signal({ id: "main-x", source: "x" })], NOW);
    expect(forecast.chance - mainOnly.chance).toBeLessThanOrEqual(10);
  });
});

describe("scoreForecastDetailed", () => {
  it("returns null features/variants on no-data", () => {
    const { forecast, features, variants } = scoreForecastDetailed([], NOW);
    expect(forecast.status).toBe("no-data");
    expect(features).toBeNull();
    expect(variants).toBeNull();
  });

  it("keeps blended identical to the published chance and calibrated identical without a model", () => {
    const { forecast, features, variants } = scoreForecastDetailed(
      [signal({ id: "main-x", source: "x" })],
      NOW
    );
    expect(variants?.blended).toBe(forecast.chance);
    expect(variants?.calibrated).toBe(forecast.chance); // no model → identity
    expect(variants?.signalOnly).toBe(forecast.chance); // no prior active here
    expect(features?.v).toBe(1);
    expect(features?.srcPts.x).toBeGreaterThan(0);
    expect(features?.signalChance).toBe(forecast.chance);
  });

  it("records prior decomposition when the cadence prior is active", () => {
    const lastReset = new Date(NOW.getTime() - 200 * 3_600_000);
    const resets: ResetRecord[] = Array.from({ length: 6 }, (_, i) => ({
      kind: "reset",
      at: new Date(lastReset.getTime() - i * 168 * 3_600_000).toISOString()
    }));
    const { forecast, features, variants } = scoreForecastDetailed(
      [signal({ id: "main-x", source: "x", strength: 0.3 })],
      NOW,
      resets
    );
    expect(features?.pPrior).not.toBeNull();
    expect(features?.wPrior).toBeGreaterThan(0);
    expect(features?.ageH).toBeCloseTo(200, 0);
    expect(variants?.priorOnly).not.toBeNull();
    expect(variants?.blended).toBe(forecast.chance);
  });
});

describe("cadence prior (time-since-last-reset)", () => {
  function radarSignals(): Signal[] {
    return [
      signal({
        id: "radar",
        source: "codex-reset-radar",
        sourceWeight: 1,
        strength: 0.4,
        publishedAt: new Date("2026-06-07T11:00:00.000Z").toISOString()
      })
    ];
  }

  function regularResets(count: number, lastAt: Date, gapHours = 168): ResetRecord[] {
    const resets: ResetRecord[] = [];
    for (let i = 0; i < count; i += 1) {
      resets.push({
        kind: "reset",
        at: new Date(lastAt.getTime() - i * gapHours * 3_600_000).toISOString()
      });
    }
    return resets;
  }

  it("omitting resets equals passing [] — never-worse fallback", () => {
    const s = radarSignals();
    const a = scoreForecast(s, NOW);
    const b = scoreForecast(s, NOW, []);
    expect(a.chance).toBe(b.chance);
    expect(a.window).toBe(b.window);
    expect(a.summary).toBe(b.summary);
  });

  it("too few resets keep the prior inactive (identical to signal-only)", () => {
    const s = radarSignals();
    const signalOnly = scoreForecast(s, NOW, []).chance;
    const resets = regularResets(3, new Date("2026-06-05T12:00:00.000Z")); // 2 gaps < 4
    expect(scoreForecast(s, NOW, resets).chance).toBe(signalOnly);
  });

  it("a validated cadence that is overdue pushes the chance up", () => {
    const s = radarSignals();
    const signalOnly = scoreForecast(s, NOW, []).chance;
    const lastReset = new Date(NOW.getTime() - 200 * 3_600_000); // overdue vs ~168h cadence
    const forecast = scoreForecast(s, NOW, regularResets(6, lastReset));
    expect(forecast.chance).toBeGreaterThan(signalOnly);
    expect(forecast.cadence?.confidence ?? 0).toBeGreaterThan(0);
    expect(forecast.priorChance).toBeDefined();
  });

  it("a validated cadence that just reset pulls the chance down", () => {
    const s = radarSignals();
    const signalOnly = scoreForecast(s, NOW, []).chance;
    const lastReset = new Date(NOW.getTime() - 12 * 3_600_000); // far too soon vs ~168h
    const forecast = scoreForecast(s, NOW, regularResets(6, lastReset));
    expect(forecast.chance).toBeLessThanOrEqual(signalOnly);
  });

  it("irregular gaps (high variation) keep the prior inactive", () => {
    const s = radarSignals();
    const signalOnly = scoreForecast(s, NOW, []).chance;
    const at = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();
    const resets: ResetRecord[] = [
      { kind: "reset", at: at(10) },
      { kind: "reset", at: at(60) },
      { kind: "reset", at: at(70) },
      { kind: "reset", at: at(400) },
      { kind: "reset", at: at(420) }
    ];
    expect(scoreForecast(s, NOW, resets).chance).toBe(signalOnly);
  });

  it("a moderately irregular cadence earns a low (non-zero) weight", () => {
    const s = radarSignals();
    const at = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();
    // gaps ≈ [80, 160, 320, 160] h → median 160, CV ≈ 0.63: inside (GOOD, CUTOFF),
    // so the prior activates but its confidence is throttled by the regularity factor.
    const resets: ResetRecord[] = [
      { kind: "reset", at: at(80) },
      { kind: "reset", at: at(240) },
      { kind: "reset", at: at(560) },
      { kind: "reset", at: at(720) },
      { kind: "reset", at: at(800) }
    ];
    const forecast = scoreForecast(s, NOW, resets);
    expect(forecast.cadence?.confidence ?? 0).toBeGreaterThan(0);
    expect(forecast.cadence!.confidence).toBeLessThan(0.5);
    expect(forecast.priorChance).toBeDefined();
  });

  it("ignores non-finite reset timestamps without throwing", () => {
    const s = radarSignals();
    const resets: ResetRecord[] = [
      { kind: "reset", at: "not-a-date" },
      { kind: "reset", at: "still-bad" }
    ];
    expect(() => scoreForecast(s, NOW, resets)).not.toThrow();
    expect(scoreForecast(s, NOW, resets).chance).toBe(scoreForecast(s, NOW, []).chance);
  });

  it("a near user-count milestone lifts the chance (one-way catalyst)", () => {
    const s = radarSignals();
    const signalOnly = scoreForecast(s, NOW, []).chance;
    const day = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();
    // 3M/4M/5M ~13 days apart; last crossing 12 days ago → progress ~0.9, near next.
    const milestones = [
      { at: day(38), countM: 3 },
      { at: day(25), countM: 4 },
      { at: day(12), countM: 5 }
    ];
    expect(scoreForecast(s, NOW, [], milestones).chance).toBeGreaterThan(signalOnly);
  });

  it("a far milestone leaves the chance unchanged (no double-dampening)", () => {
    const s = radarSignals();
    const signalOnly = scoreForecast(s, NOW, []).chance;
    const day = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();
    // Last crossing only 2 days ago vs ~13-day cadence → progress ~0.15, far off.
    const milestones = [
      { at: day(28), countM: 3 },
      { at: day(15), countM: 4 },
      { at: day(2), countM: 5 }
    ];
    expect(scoreForecast(s, NOW, [], milestones).chance).toBe(signalOnly);
  });

  describe("numeric helpers", () => {
    it("median handles odd and even lengths", () => {
      expect(__test.median([3, 1, 2])).toBe(2);
      expect(__test.median([4, 1, 2, 3])).toBe(2.5);
    });

    it("regularized lower gamma matches the exponential CDF at k=1", () => {
      expect(__test.lowerRegularizedGammaP(1, 1)).toBeCloseTo(1 - Math.exp(-1), 4);
      expect(__test.lowerRegularizedGammaP(1, 2)).toBeCloseTo(1 - Math.exp(-2), 4);
    });

    it("regularized lower gamma is monotonic in x and within [0,1]", () => {
      const a = __test.lowerRegularizedGammaP(4, 2);
      const b = __test.lowerRegularizedGammaP(4, 8);
      expect(a).toBeGreaterThanOrEqual(0);
      expect(b).toBeLessThanOrEqual(1);
      expect(b).toBeGreaterThan(a);
    });
  });
});
