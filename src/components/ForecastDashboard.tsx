"use client";

import { useCallback, useState } from "react";

import type { HistoryEntry } from "@/lib/kv";
import type { CollectorStatus, ForecastStatus, SignalSource, Snapshot } from "@/lib/types";

type ForecastDashboardProps = {
  initialSnapshot: Snapshot;
  initialHistory?: HistoryEntry[];
};

const STATUS_LABELS: Record<ForecastStatus, string> = {
  ok: "Live forecast",
  partial: "Partial data",
  stale: "Stale data",
  "no-data": "No data yet"
};

const SOURCE_LABELS: Record<SignalSource, string> = {
  x: "X/Twitter",
  "openai-status": "OpenAI Status",
  github: "GitHub",
  "codex-reset-radar": "Codex Reset Radar"
};

function formatGeneratedAt(value: string): string {
  if (!value) {
    return "Not refreshed yet";
  }

  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(value));
}

function collectorLabel(collector: CollectorStatus): string {
  return SOURCE_LABELS[collector.source];
}

function collectorStatusMessage(collector: CollectorStatus): string {
  if (collector.stale) {
    return `${collectorLabel(collector)} source data may be stale.`;
  }

  if (collector.ok) {
    return "Source responded successfully.";
  }

  if (collector.source === "x") {
    return "X/Twitter source needs setup or is unavailable.";
  }

  if (collector.source === "openai-status") {
    return "OpenAI Status source is unavailable.";
  }

  if (collector.source === "codex-reset-radar") {
    return "Codex Reset Radar source is unavailable.";
  }

  return "GitHub source is unavailable.";
}

export function ForecastDashboard({ initialSnapshot, initialHistory = [] }: ForecastDashboardProps) {
  const [snapshot, setSnapshot] = useState<Snapshot>(initialSnapshot);
  const [history, setHistory] = useState<HistoryEntry[]>(initialHistory);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const response = await fetch("/api/snapshot", { cache: "no-store" });

      if (!response.ok) {
        throw new Error("Snapshot refresh failed.");
      }

      const nextSnapshot = (await response.json()) as Snapshot;
      setSnapshot(nextSnapshot);

      try {
        const historyResponse = await fetch("/api/history", { cache: "no-store" });
        if (historyResponse.ok) {
          const payload = (await historyResponse.json()) as { history?: HistoryEntry[] };
          if (Array.isArray(payload.history)) {
            setHistory(payload.history);
          }
        }
      } catch {
        // History refresh is best-effort; ignore failures.
      }
    } catch {
      setError("Could not refresh snapshot. Try again shortly.");
    } finally {
      setLoading(false);
    }
  }, []);

  const forecast = snapshot.forecast;
  const topSignals = forecast.topSignals;

  const gaugeRadius = 92;
  const gaugeCircumference = 2 * Math.PI * gaugeRadius;
  const clampedChance = Math.min(100, Math.max(0, forecast.chance));
  const gaugeOffset = gaugeCircumference * (1 - clampedChance / 100);

  return (
    <main className="dashboard-shell">
      <section className="forecast-panel panel" aria-labelledby="forecast-title">
        <div className="forecast-header">
          <span className={`status-pill status-${forecast.status}`}>
            {STATUS_LABELS[forecast.status]}
          </span>
          <span className="updated-at">Updated {formatGeneratedAt(forecast.generatedAt)}</span>
        </div>

        <div className="forecast-body">
          <div className="forecast-lede">
            <p className="section-label">Unofficial public signal monitor</p>
            <h1 id="forecast-title">Codex Reset Chance</h1>
            <p className="forecast-summary">{forecast.summary}</p>
            <div className="forecast-window">
              <span className="window-tick" aria-hidden="true" />
              {forecast.window}
            </div>
          </div>

          <div className="gauge" role="img" aria-label={`Reset chance ${forecast.chance}% — ${forecast.window}`}>
            <svg className="gauge-svg" viewBox="0 0 220 220">
              <defs>
                <linearGradient id="gaugeGradient" x1="0%" y1="0%" x2="100%" y2="100%">
                  <stop offset="0%" stopColor="#5e6ad2" />
                  <stop offset="100%" stopColor="#9aa6ff" />
                </linearGradient>
              </defs>
              <circle className="gauge-track" cx="110" cy="110" r="92" />
              <circle
                className="gauge-fill"
                cx="110"
                cy="110"
                r="92"
                strokeDasharray={gaugeCircumference}
                strokeDashoffset={gaugeOffset}
              />
            </svg>
            <div className="gauge-center">
              <span className="gauge-value">
                {forecast.chance}
                <span className="gauge-pct">%</span>
              </span>
              <span className="gauge-sub">next 24h</span>
            </div>
          </div>
        </div>

        <div className="forecast-actions">
          <button type="button" onClick={refresh} disabled={loading}>
            {loading ? "Refreshing..." : "Refresh"}
          </button>
          {error ? (
            <p className="refresh-error" role="status">
              {error}
            </p>
          ) : null}
        </div>
      </section>

      <section className="panel" aria-labelledby="signals-title">
        <div className="panel-heading">
          <p className="section-label">Evidence</p>
          <h2 id="signals-title">Top Signals</h2>
        </div>

        {topSignals.length === 0 ? (
          <p className="empty-state">No matching public signals yet. Refresh to check the latest sources.</p>
        ) : (
          <div className="signal-list">
            {topSignals.map((signal) => (
              <a
                className="signal-card"
                href={signal.url}
                key={signal.id}
                rel="noreferrer"
                target="_blank"
                aria-label={`Open ${signal.sourceLabel} signal: ${signal.title}`}
              >
                <span className="signal-source">{signal.sourceLabel}</span>
                <h3>{signal.title}</h3>
                <p className="signal-reason">{signal.reason}</p>
                {signal.matchedKeywords.length > 0 ? (
                  <div className="keyword-row" aria-label="Matched keywords">
                    {signal.matchedKeywords.map((keyword) => (
                      <span className="keyword" key={`${signal.id}-${keyword}`}>
                        {keyword}
                      </span>
                    ))}
                  </div>
                ) : null}
              </a>
            ))}
          </div>
        )}
      </section>

      <section className="panel" aria-labelledby="collectors-title">
        <div className="panel-heading">
          <p className="section-label">Pipeline</p>
          <h2 id="collectors-title">Collectors</h2>
        </div>

        {snapshot.collectors.length === 0 ? (
          <p className="empty-state">Collector results appear after first refresh.</p>
        ) : (
          <ul className="collector-list">
            {snapshot.collectors.map((collector) => (
              <li className="collector-row" key={collector.source}>
                <span
                  className={`collector-dot ${collector.ok ? "is-ok" : "is-fail"}`}
                  aria-hidden="true"
                />
                <div>
                  <p className="collector-source">{collectorLabel(collector)}</p>
                  <p className="collector-message">{collectorStatusMessage(collector)}</p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="panel history-panel" aria-labelledby="history-title">
        <div className="panel-heading">
          <p className="section-label">Track record</p>
          <h2 id="history-title">Prediction history</h2>
        </div>

        {history.length === 0 ? (
          <p className="empty-state">
            No high-chance predictions recorded yet. A record is logged when the reset chance crosses 80%, and again
            when an actual reset is confirmed.
          </p>
        ) : (
          <ul className="history-list">
            {history.map((entry, index) => (
              <li className={`history-row history-${entry.kind}`} key={`${entry.kind}-${entry.at}-${index}`}>
                <span className={`history-tag history-tag-${entry.kind}`}>
                  {entry.kind === "prediction" ? `Predicted ${entry.chance}%` : "Actual reset"}
                </span>
                <span className="history-time">{formatGeneratedAt(entry.at)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <p className="disclaimer">
        Unofficial project. Not affiliated with OpenAI, X, or Apify. Forecasts are estimates from
        public signals, not official notices.
      </p>
    </main>
  );
}
