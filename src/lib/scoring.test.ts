import { describe, expect, it } from "vitest";

import type { ResetRecord } from "./kv";
import { __test, scoreForecast } from "./scoring";
import type { Signal } from "./types";

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

  it("ignores non-finite reset timestamps without throwing", () => {
    const s = radarSignals();
    const resets: ResetRecord[] = [
      { kind: "reset", at: "not-a-date" },
      { kind: "reset", at: "still-bad" }
    ];
    expect(() => scoreForecast(s, NOW, resets)).not.toThrow();
    expect(scoreForecast(s, NOW, resets).chance).toBe(scoreForecast(s, NOW, []).chance);
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
