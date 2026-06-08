import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ForecastDashboard } from "./ForecastDashboard";
import type { Snapshot } from "@/lib/types";

const sampleSnapshot: Snapshot = {
  forecast: {
    status: "ok",
    chance: 72,
    window: "Possible within 18-36 hours",
    summary: "Public signals are clustering around reset timing.",
    generatedAt: "2026-06-07T12:00:00.000Z",
    topSignals: [
      {
        id: "x-tibo-reset",
        source: "x",
        sourceLabel: "X/Twitter",
        sourceWeight: 1,
        author: "Tibo",
        title: "Reset and capacity mention",
        text: "Codex reset capacity note.",
        url: "https://example.com/x-tibo-reset",
        publishedAt: "2026-06-07T10:00:00.000Z",
        matchedKeywords: ["reset", "capacity"],
        strength: 0.8,
        reason: "Tibo mentioned reset and capacity."
      }
    ]
  },
  signals: [],
  collectors: [
    {
      source: "x",
      ok: true,
      message: "Fetched latest X/Twitter signals.",
      fetchedAt: "2026-06-07T12:00:00.000Z"
    }
  ]
};

const rawCollectorSnapshot: Snapshot = {
  forecast: {
    status: "no-data",
    chance: 0,
    window: "No fresh data",
    summary: "No complete source set is available yet.",
    generatedAt: "2026-06-07T12:00:00.000Z",
    topSignals: []
  },
  signals: [],
  collectors: [
    {
      source: "x",
      ok: false,
      message: "APIFY_TOKEN is missing."
    },
    {
      source: "openai-status",
      ok: false,
      message: "Bearer secret upstream failure"
    },
    {
      source: "github",
      ok: false,
      message: "GitHub collector failed with HTTP 403."
    },
    {
      source: "codex-reset-radar",
      ok: false,
      message: "Radar upstream failure with secret token."
    }
  ]
};

const staleCollectorSnapshot: Snapshot = {
  ...sampleSnapshot,
  collectors: [
    {
      source: "x",
      ok: true,
      stale: true,
      message: "Bearer secret upstream failure"
    }
  ]
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ForecastDashboard", () => {
  it("renders the current forecast and top signal reason", () => {
    render(<ForecastDashboard initialSnapshot={sampleSnapshot} />);

    expect(screen.getByText("Codex Reset Chance")).toBeInTheDocument();
    expect(screen.getByText("72")).toBeInTheDocument();
    expect(screen.getByText("Possible within 18-36 hours")).toBeInTheDocument();
    expect(screen.getByText("Tibo mentioned reset and capacity.")).toBeInTheDocument();
  });

  it("renders safe source labels without raw collector messages", () => {
    render(<ForecastDashboard initialSnapshot={rawCollectorSnapshot} />);

    // The quiet footer surfaces only friendly source names — never raw upstream text.
    expect(screen.getByText("X/Twitter")).toBeInTheDocument();
    expect(screen.getByText("OpenAI Status")).toBeInTheDocument();
    expect(screen.getByText("GitHub")).toBeInTheDocument();
    expect(screen.getByText("Reset Radar")).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent(/APIFY_TOKEN|Bearer|HTTP 403|secret|upstream failure/i);
  });

  it("never renders raw stale-collector messages", () => {
    render(<ForecastDashboard initialSnapshot={staleCollectorSnapshot} />);

    // "X/Twitter" appears both as a signal source and as a footer chip — either is fine;
    // the contract is that the raw upstream message never reaches the DOM.
    expect(screen.getAllByText("X/Twitter").length).toBeGreaterThan(0);
    expect(document.body).not.toHaveTextContent(/Bearer|secret|upstream failure/i);
  });

  it("shows a safe refresh error without rendering the thrown error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("Bearer secret upstream failure HTTP 403 APIFY_TOKEN"))
    );

    render(<ForecastDashboard initialSnapshot={sampleSnapshot} />);
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));

    expect(await screen.findByText("Could not refresh. Try again shortly.")).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent(/APIFY_TOKEN|Bearer|HTTP 403|secret|upstream failure/i);
  });
});
