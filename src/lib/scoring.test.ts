import { describe, expect, it } from "vitest";

import { scoreForecast } from "./scoring";
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
