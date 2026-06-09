import { afterEach, describe, expect, it, vi } from "vitest";

import { collectApifySignals } from "./collectors/apify";
import { collectGithubSignals } from "./collectors/github";
import { collectOpenAIStatusSignals } from "./collectors/openai-status";
import { collectResetRadarSignals } from "./collectors/reset-radar";
import { collectResetHistory } from "./collectors/reset-history";
import { REFRESH_MINUTES_DEFAULT } from "./defaults";
import { buildSnapshot, collectSnapshot, refreshMinutes } from "./snapshot";
import type { CollectorStatus, Signal } from "./types";

vi.mock("./collectors/apify", () => ({
  collectApifySignals: vi.fn()
}));

vi.mock("./collectors/openai-status", () => ({
  collectOpenAIStatusSignals: vi.fn()
}));

vi.mock("./collectors/github", () => ({
  collectGithubSignals: vi.fn()
}));

vi.mock("./collectors/reset-radar", () => ({
  collectResetRadarSignals: vi.fn()
}));

vi.mock("./collectors/reset-history", () => ({
  collectResetHistory: vi.fn(() => Promise.resolve([]))
}));

const NOW = new Date("2026-06-07T12:00:00.000Z");
const SECRET_PATTERN = /token|secret|Bearer|APIFY_TOKEN/i;

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  vi.doUnmock("@/lib/snapshot");
});

function collectorStatus(overrides: Partial<CollectorStatus>): CollectorStatus {
  return {
    source: "x",
    ok: true,
    message: "Fetched signals.",
    fetchedAt: NOW.toISOString(),
    ...overrides
  };
}

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

describe("buildSnapshot", () => {
  it("marks an otherwise ok forecast partial when a collector fails", () => {
    const keptSignal = signal({ id: "kept-signal" });

    const snapshot = buildSnapshot(
      [
        {
          status: collectorStatus({ source: "x", ok: false, message: "Apify collector failed." }),
          signals: []
        },
        {
          status: collectorStatus({ source: "openai-status" }),
          signals: [keptSignal]
        }
      ],
      NOW
    );

    expect(snapshot.forecast.status).toBe("partial");
    expect(snapshot.signals).toEqual([keptSignal]);
    expect(snapshot.forecast.topSignals).toEqual([keptSignal]);
    expect(snapshot.collectors).toHaveLength(2);
  });

  it("deduplicates signals by id and preserves the first occurrence", () => {
    const firstSignal = signal({ id: "same-id", title: "First signal" });
    const duplicateSignal = signal({ id: "same-id", title: "Duplicate signal", source: "github" });

    const snapshot = buildSnapshot(
      [
        {
          status: collectorStatus({ source: "x" }),
          signals: [firstSignal]
        },
        {
          status: collectorStatus({ source: "github" }),
          signals: [duplicateSignal]
        }
      ],
      NOW
    );

    expect(snapshot.signals).toEqual([firstSignal]);
    expect(snapshot.forecast.topSignals).toEqual([firstSignal]);
  });

  it("keeps no-data when every collector fails without signals", () => {
    const snapshot = buildSnapshot(
      [
        {
          status: collectorStatus({ source: "x", ok: false, message: "APIFY_TOKEN is missing." }),
          signals: []
        },
        {
          status: collectorStatus({ source: "github", ok: false, message: "GitHub collector failed." }),
          signals: []
        }
      ],
      NOW
    );

    expect(snapshot.forecast.status).toBe("no-data");
    expect(snapshot.forecast.chance).toBe(0);
    expect(snapshot.signals).toEqual([]);
  });
});

describe("refreshMinutes", () => {
  it("returns a positive finite env value", () => {
    vi.stubEnv("SNAPSHOT_REFRESH_MINUTES", "12.5");

    expect(refreshMinutes()).toBe(12.5);
  });

  it.each(["", "0", "-5", "not-a-number", "Infinity"])(
    "returns the default for invalid value %s",
    (value) => {
      vi.stubEnv("SNAPSHOT_REFRESH_MINUTES", value);

      expect(refreshMinutes()).toBe(REFRESH_MINUTES_DEFAULT);
    }
  );
});

describe("collectSnapshot", () => {
  it("keeps healthy collector signals when one collector throws", async () => {
    const healthySignal = signal({ id: "healthy-status-signal", source: "openai-status" });
    vi.mocked(collectGithubSignals).mockRejectedValue(new Error("Bearer token APIFY_TOKEN=secret"));
    vi.mocked(collectOpenAIStatusSignals).mockResolvedValue({
      status: collectorStatus({ source: "openai-status" }),
      signals: [healthySignal]
    });
    vi.mocked(collectResetRadarSignals).mockResolvedValue({
      status: collectorStatus({ source: "codex-reset-radar" }),
      signals: []
    });

    const snapshot = await collectSnapshot();

    expect(snapshot.forecast.status).toBe("partial");
    expect(snapshot.signals).toEqual([healthySignal]);
    expect(snapshot.collectors).toContainEqual({
      source: "github",
      ok: false,
      message: "GitHub collector failed."
    });
    expect(snapshot.collectors.map((collector) => collector.message).join(" ")).not.toMatch(SECRET_PATTERN);
  });

  it("includes Codex Reset Radar as a no-API fallback source", async () => {
    const radarSignal = signal({
      id: "radar-current",
      source: "codex-reset-radar",
      sourceLabel: "Codex Reset Radar"
    });
    vi.mocked(collectOpenAIStatusSignals).mockResolvedValue({
      status: collectorStatus({ source: "openai-status" }),
      signals: []
    });
    vi.mocked(collectGithubSignals).mockResolvedValue({
      status: collectorStatus({ source: "github" }),
      signals: []
    });
    vi.mocked(collectResetRadarSignals).mockResolvedValue({
      status: collectorStatus({ source: "codex-reset-radar" }),
      signals: [radarSignal]
    });

    const snapshot = await collectSnapshot();

    expect(collectResetRadarSignals).toHaveBeenCalledTimes(1);
    expect(snapshot.signals).toEqual([radarSignal]);
    expect(snapshot.collectors.map((collector) => collector.source)).toContain("codex-reset-radar");
  });

  it("adds the X/Apify source only when APIFY_TOKEN is configured", async () => {
    vi.mocked(collectOpenAIStatusSignals).mockResolvedValue({
      status: collectorStatus({ source: "openai-status" }),
      signals: []
    });
    vi.mocked(collectGithubSignals).mockResolvedValue({
      status: collectorStatus({ source: "github" }),
      signals: []
    });
    vi.mocked(collectResetRadarSignals).mockResolvedValue({
      status: collectorStatus({ source: "codex-reset-radar" }),
      signals: []
    });

    // No token → X is absent and the Apify collector is never invoked.
    vi.stubEnv("APIFY_TOKEN", "");
    const withoutToken = await collectSnapshot();
    expect(collectApifySignals).not.toHaveBeenCalled();
    expect(withoutToken.collectors.map((collector) => collector.source)).not.toContain("x");

    // Token present → X joins as a real source feeding the forecast.
    vi.stubEnv("APIFY_TOKEN", "secret-token");
    const xSignal = signal({ id: "x-signal", source: "x", sourceLabel: "X/Twitter" });
    vi.mocked(collectApifySignals).mockResolvedValue({
      status: collectorStatus({ source: "x" }),
      signals: [xSignal]
    });

    const withToken = await collectSnapshot();
    expect(collectApifySignals).toHaveBeenCalledTimes(1);
    expect(collectApifySignals).toHaveBeenCalledWith(expect.objectContaining({ token: "secret-token" }));
    expect(withToken.collectors.map((collector) => collector.source)).toContain("x");
    expect(withToken.signals).toContainEqual(xSignal);
    expect(withToken.collectors.map((collector) => collector.message).join(" ")).not.toMatch(SECRET_PATTERN);
  });

  it("feeds radar reset history into the cadence prior", async () => {
    vi.mocked(collectOpenAIStatusSignals).mockResolvedValue({
      status: collectorStatus({ source: "openai-status" }),
      signals: []
    });
    vi.mocked(collectGithubSignals).mockResolvedValue({
      status: collectorStatus({ source: "github" }),
      signals: []
    });
    vi.mocked(collectResetRadarSignals).mockResolvedValue({
      status: collectorStatus({ source: "codex-reset-radar" }),
      signals: [signal({ id: "radar-current", source: "codex-reset-radar", strength: 0.4 })]
    });
    // A clean, overdue weekly cadence supplied entirely by radar history — no
    // manual mark-reset — should activate the prior end-to-end.
    const nowMs = Date.now();
    const resets = Array.from({ length: 6 }, (_, i) => ({
      kind: "reset" as const,
      at: new Date(nowMs - (200 + i * 168) * 3_600_000).toISOString()
    }));
    vi.mocked(collectResetHistory).mockResolvedValue(resets);

    const snapshot = await collectSnapshot();

    expect(collectResetHistory).toHaveBeenCalledTimes(1);
    expect(snapshot.forecast.cadence?.confidence ?? 0).toBeGreaterThan(0);
    expect(snapshot.forecast.priorChance).toBeDefined();
  });
});

describe("snapshot route", () => {
  it("returns sanitized no-data JSON when snapshot collection rejects", async () => {
    vi.resetModules();
    vi.doMock("@/lib/snapshot", () => ({
      collectSnapshot: vi.fn().mockRejectedValue(new Error("Bearer token APIFY_TOKEN=secret"))
    }));
    const { GET } = await import("../app/api/snapshot/route");

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      forecast: {
        status: "no-data",
        chance: 0,
        window: "No fresh data",
        topSignals: []
      },
      signals: [],
      collectors: []
    });
    expect(body.forecast.summary).not.toMatch(SECRET_PATTERN);
  });
});
