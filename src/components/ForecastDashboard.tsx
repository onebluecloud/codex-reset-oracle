"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { HistoryEntry } from "@/lib/kv";
import type { CollectorStatus, ForecastStatus, SignalSource, Snapshot } from "@/lib/types";

type ForecastDashboardProps = {
  initialSnapshot: Snapshot;
  initialHistory?: HistoryEntry[];
  initialTrend?: number[];
};

const STATUS_LABELS: Record<ForecastStatus, string> = {
  ok: "Live",
  partial: "Partial data",
  stale: "Stale data",
  "no-data": "No data yet"
};

const SOURCE_LABELS: Record<SignalSource, string> = {
  x: "X/Twitter",
  "openai-status": "OpenAI Status",
  github: "GitHub",
  "codex-reset-radar": "Reset Radar"
};

function formatGeneratedAt(value: string): string {
  if (!value) return "not refreshed yet";
  return new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(
    new Date(value)
  );
}

function formatRelative(value: string): string {
  const then = Date.parse(value);
  if (!Number.isFinite(then)) return "";
  const diff = Date.now() - then;
  const mins = Math.round(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

function collectorLabel(collector: CollectorStatus): string {
  return SOURCE_LABELS[collector.source];
}

/**
 * Build the wave baseline from real probability history. The right edge ("now")
 * is always pinned to the live chance so the wave and the giant readout agree.
 * Sparse history is left-padded with the earliest real value — a calm, honest
 * "not much movement yet" rather than a fabricated spike.
 */
function buildTrend(trend: number[] | undefined, chance: number): number[] {
  const points = Array.isArray(trend) ? trend.filter((value) => Number.isFinite(value)) : [];
  if (points.length === 0) points.push(chance);
  points[points.length - 1] = chance;
  while (points.length < 7) points.unshift(points[0]);
  return points;
}

/**
 * 0 below ~18% (calm indigo), ramping to 1 by ~78% (warm/alert).
 * The wave and the giant readout heat up as a reset looks more imminent.
 */
function warmthFromChance(chance: number): number {
  const w = Math.min(1, Math.max(0, (chance - 18) / 60));
  return w * w * (3 - 2 * w); // smoothstep
}

function mixRgb(cold: readonly number[], warm: readonly number[], t: number): string {
  const r = Math.round(cold[0] + (warm[0] - cold[0]) * t);
  const g = Math.round(cold[1] + (warm[1] - cold[1]) * t);
  const b = Math.round(cold[2] + (warm[2] - cold[2]) * t);
  return `${r},${g},${b}`;
}

type MouseState = {
  x: number;
  y: number;
  tx: number;
  ty: number;
  nx: number;
  tnx: number;
  active: number;
  target: number;
};

export function ForecastDashboard({
  initialSnapshot,
  initialHistory = [],
  initialTrend = []
}: ForecastDashboardProps) {
  const [snapshot, setSnapshot] = useState<Snapshot>(initialSnapshot);
  const [history, setHistory] = useState<HistoryEntry[]>(initialHistory);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const forecast = snapshot.forecast;
  const topSignals = forecast.topSignals;
  const chance = Math.min(100, Math.max(0, Math.round(forecast.chance)));

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const trendRef = useRef<number[]>(buildTrend(initialTrend, chance));
  const chanceRef = useRef<number>(chance);
  const mouseRef = useRef<MouseState>({
    x: -9999,
    y: 0.5,
    tx: -9999,
    ty: 0.5,
    nx: 0,
    tnx: 0,
    active: 0,
    target: 0
  });

  // Keep the wave's "now" edge in sync with the latest live chance, and warm the
  // hero readout's gradient as the chance climbs (set here, not in the RAF loop,
  // so it also applies under prefers-reduced-motion).
  useEffect(() => {
    const points = trendRef.current.slice();
    points[points.length - 1] = chance;
    trendRef.current = points;
    chanceRef.current = chance;

    const warmth = warmthFromChance(chance);
    const root = document.documentElement.style;
    root.setProperty("--fig-1", `rgb(${mixRgb([207, 212, 255], [255, 216, 196], warmth)})`);
    root.setProperty("--fig-2", `rgb(${mixRgb([139, 150, 245], [240, 135, 158], warmth)})`);
  }, [chance]);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const response = await fetch("/api/snapshot", { cache: "no-store" });
      if (!response.ok) throw new Error("Snapshot refresh failed.");

      const nextSnapshot = (await response.json()) as Snapshot;
      setSnapshot(nextSnapshot);

      // Append the fresh reading as a new "now" point on the wave.
      const nextChance = Math.min(100, Math.max(0, Math.round(nextSnapshot.forecast.chance)));
      trendRef.current = [...trendRef.current, nextChance].slice(-40);

      try {
        const historyResponse = await fetch("/api/history", { cache: "no-store" });
        if (historyResponse.ok) {
          const payload = (await historyResponse.json()) as { history?: HistoryEntry[] };
          if (Array.isArray(payload.history)) setHistory(payload.history);
        }
      } catch {
        // History refresh is best-effort.
      }
    } catch {
      setError("Could not refresh. Try again shortly.");
    } finally {
      setLoading(false);
    }
  }, []);

  // ── Interactive probability wave ──────────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;

    let ctx: CanvasRenderingContext2D | null = null;
    try {
      ctx = canvas.getContext("2d");
    } catch {
      ctx = null;
    }
    if (!ctx) return;
    if (typeof ResizeObserver === "undefined") return;

    const reduce =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    let width = 1;
    let height = 1;

    const resize = () => {
      const rect = wrap.getBoundingClientRect();
      width = Math.max(1, rect.width);
      height = Math.max(1, rect.height);
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(wrap);

    const mouse = mouseRef.current;
    const onMove = (event: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      mouse.tx = event.clientX - rect.left;
      mouse.ty = (event.clientY - rect.top) / height;
      mouse.tnx = (event.clientX - rect.left) / width - 0.5;
      mouse.target = 1;
      // Soft ambient glow that trails the cursor across the page.
      document.documentElement.style.setProperty("--mx", `${event.clientX}px`);
      document.documentElement.style.setProperty("--my", `${event.clientY}px`);
    };
    const onLeave = () => {
      mouse.target = 0;
    };
    window.addEventListener("pointermove", onMove, { passive: true });
    window.addEventListener("pointerleave", onLeave, { passive: true });

    // Three depth-stepped layers: faint back washes, one crisp data wave in front.
    // Each carries a cold (calm) and warm (imminent) colour, blended by warmth.
    const layers = [
      { amp: 13, freq: 0.0120, speed: 0.30, off: 0.0, w: 1, cold: [94, 106, 210], warm: [196, 116, 170], a: 0.2, fill: 0.05, depth: 11 },
      { amp: 20, freq: 0.0082, speed: -0.46, off: 1.7, w: 1.5, cold: [120, 132, 250], warm: [240, 140, 150], a: 0.34, fill: 0.07, depth: 25 },
      { amp: 30, freq: 0.0058, speed: 0.62, off: 3.1, w: 2.6, cold: [174, 182, 255], warm: [255, 178, 140], a: 0.95, fill: 0.2, depth: 44 }
    ];

    const clampIndex = (index: number, max: number) => Math.max(0, Math.min(max, index));

    const levelAt = (v: number, maxY: number) => height * 0.64 - (v / maxY) * (height * 0.46);
    const baseAt = (x: number, points: number[], maxY: number) => {
      const n = points.length;
      if (n === 1) return levelAt(points[0], maxY);
      const f = (x / width) * (n - 1);
      const i = Math.floor(f);
      const t = f - i;
      const a = points[clampIndex(i, n - 1)];
      const b = points[clampIndex(i + 1, n - 1)];
      const v = a + (b - a) * (t * t * (3 - 2 * t)); // smoothstep
      return levelAt(v, maxY);
    };

    let t = 0;
    let raf = 0;

    const render = () => {
      if (!reduce) t += 0.0125;

      mouse.x += (mouse.tx - mouse.x) * 0.09;
      mouse.y += (mouse.ty - mouse.y) * 0.09;
      mouse.nx += (mouse.tnx - mouse.nx) * 0.09;
      mouse.active += (mouse.target - mouse.active) * 0.06;

      const points = trendRef.current;
      let peak = 0;
      for (const value of points) peak = Math.max(peak, value);
      const maxY = Math.max(40, peak) * 1.25;
      const warmth = warmthFromChance(chanceRef.current);

      ctx.clearRect(0, 0, width, height);

      // Quiet reference grid — contrast-led separation, Apple restraint.
      ctx.lineWidth = 1;
      for (let g = 1; g <= 3; g += 1) {
        const gy = (height / 4) * g;
        ctx.strokeStyle = "rgba(255,255,255,0.028)";
        ctx.beginPath();
        ctx.moveTo(0, gy);
        ctx.lineTo(width, gy);
        ctx.stroke();
      }

      const breathe = reduce ? 1 : 0.9 + Math.sin(t * 0.6) * 0.1;
      const sigma = Math.max(90, width * 0.11);
      const globalAmp = breathe * (0.94 + (1 - mouse.y) * 0.7 * mouse.active);

      const yAt = (x: number, layer: (typeof layers)[number], parallax: number) => {
        const sx = x - parallax;
        const flow = Math.sin(sx * layer.freq + t * layer.speed + layer.off) * layer.amp;
        const dx = x - mouse.x;
        const swell = -Math.exp(-(dx * dx) / (2 * sigma * sigma)) * (34 + layer.depth * 0.28) * mouse.active;
        return baseAt(sx, points, maxY) + flow * globalAmp + swell;
      };

      layers.forEach((layer, li) => {
        const parallax = mouse.nx * layer.depth * mouse.active; // pseudo-3D depth
        const col = mixRgb(layer.cold, layer.warm, warmth);
        const fill = layer.fill * (1 + warmth * 0.5);

        // Area fill.
        ctx.beginPath();
        for (let x = 0; x <= width; x += 2) {
          const y = yAt(x, layer, parallax);
          if (x === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.lineTo(width, height);
        ctx.lineTo(0, height);
        ctx.closePath();
        const gradient = ctx.createLinearGradient(0, 0, 0, height);
        gradient.addColorStop(0, `rgba(${col},${fill})`);
        gradient.addColorStop(1, `rgba(${col},0)`);
        ctx.fillStyle = gradient;
        ctx.fill();

        // Stroke the crest.
        ctx.beginPath();
        for (let x = 0; x <= width; x += 2) {
          const y = yAt(x, layer, parallax);
          if (x === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.strokeStyle = `rgba(${col},${layer.a})`;
        ctx.lineWidth = layer.w;
        if (li === layers.length - 1) {
          ctx.shadowColor = `rgba(${mixRgb([130, 143, 255], [255, 150, 120], warmth)},0.6)`;
          ctx.shadowBlur = 15 + warmth * 9;
        }
        ctx.stroke();
        ctx.shadowBlur = 0;
      });

      // "Now" marker on the front wave.
      const front = layers[layers.length - 1];
      const yNow = yAt(width, front, 0);
      const guideCol = mixRgb([174, 182, 255], [255, 180, 150], warmth);
      ctx.strokeStyle = `rgba(${guideCol},0.22)`;
      ctx.setLineDash([2, 5]);
      ctx.beginPath();
      ctx.moveTo(width - 1, yNow);
      ctx.lineTo(width - 1, height);
      ctx.stroke();
      ctx.setLineDash([]);

      const pulse = reduce ? 4.4 : 4.2 + Math.sin(t * 1.6) * 0.8;
      ctx.beginPath();
      ctx.arc(width - 2, yNow, pulse, 0, Math.PI * 2);
      ctx.fillStyle = `rgb(${mixRgb([207, 212, 255], [255, 214, 184], warmth)})`;
      ctx.shadowColor = `rgba(${guideCol},0.9)`;
      ctx.shadowBlur = 16 + warmth * 8;
      ctx.fill();
      ctx.shadowBlur = 0;

      if (!reduce) raf = window.requestAnimationFrame(render);
    };

    render();

    return () => {
      window.cancelAnimationFrame(raf);
      observer.disconnect();
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerleave", onLeave);
    };
  }, []);

  const okCollectors = useMemo(
    () => snapshot.collectors.filter((collector) => collector.ok).length,
    [snapshot.collectors]
  );

  return (
    <main className="stage">
      <div className="cursor-glow" aria-hidden="true" />

      <header className="masthead">
        <span className="wordmark">Codex Reset Oracle</span>
        <span className={`live live-${forecast.status}`}>
          <span className="live-dot" aria-hidden="true" />
          {STATUS_LABELS[forecast.status]} · Unofficial
        </span>
      </header>

      <section className="hero" aria-labelledby="forecast-title">
        <p className="eyebrow">Reset chance · next 24h</p>
        <div
          className="readout"
          role="img"
          aria-label={`Codex reset chance ${chance}% in the next 24 hours`}
        >
          <span className="figure">{chance}</span>
          <span className="unit">%</span>
        </div>
        <h1 id="forecast-title" className="headline">
          Codex Reset Chance
        </h1>
        <p className="lede">{forecast.summary}</p>
        <div className="window-pill">
          <span className="window-tick" aria-hidden="true" />
          {forecast.window}
        </div>
      </section>

      <section className="waveband" aria-label="Probability trend, last 30 hours">
        <div className="waveband-head">
          <span>Probability · last 30h</span>
          <span className="waveband-hint">move cursor to disturb</span>
        </div>
        <div className="wave-wrap" ref={wrapRef}>
          <canvas ref={canvasRef} className="wave-canvas" />
        </div>
        <div className="wave-axis">
          <span>30h ago</span>
          <span>24h</span>
          <span>18h</span>
          <span>12h</span>
          <span>6h</span>
          <span>now</span>
        </div>
      </section>

      <section className="signals" aria-labelledby="signals-title">
        <div className="row-head">
          <span className="row-kicker">Evidence</span>
          <h2 id="signals-title">Top signals</h2>
        </div>

        {topSignals.length === 0 ? (
          <p className="empty">No matching public signals right now. Refresh to re-check the sources.</p>
        ) : (
          <ul className="signal-list">
            {topSignals.map((signal) => (
              <li key={signal.id}>
                <a
                  className="signal-row"
                  href={signal.url}
                  rel="noreferrer"
                  target="_blank"
                  aria-label={`Open ${signal.sourceLabel} signal: ${signal.title}`}
                >
                  <span className="signal-source">{signal.sourceLabel}</span>
                  <span className="signal-body">
                    <span className="signal-title">{signal.title}</span>
                    {signal.reason ? <span className="signal-detail">{signal.reason}</span> : null}
                  </span>
                  <span className="signal-when" suppressHydrationWarning>
                    {formatRelative(signal.publishedAt)}
                  </span>
                </a>
              </li>
            ))}
          </ul>
        )}
      </section>

      {history.length > 0 ? (
        <section className="track" aria-labelledby="track-title">
          <div className="row-head">
            <span className="row-kicker">Track record</span>
            <h2 id="track-title">Logged events</h2>
          </div>
          <ul className="track-list">
            {history.slice(0, 6).map((entry, index) => (
              <li className={`track-row track-${entry.kind}`} key={`${entry.kind}-${entry.at}-${index}`}>
                <span className="track-tag">
                  {entry.kind === "prediction" ? `Predicted ${entry.chance}%` : "Actual reset"}
                </span>
                <span className="track-time">{formatGeneratedAt(entry.at)}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <footer className="ground">
        <div className="sources" aria-label="Source pipeline status">
          {snapshot.collectors.length === 0 ? (
            <span className="sources-empty">Sources report after the first refresh.</span>
          ) : (
            snapshot.collectors.map((collector) => (
              <span className="source-chip" key={collector.source}>
                <span
                  className={`source-dot ${collector.ok ? "is-ok" : "is-fail"}`}
                  aria-hidden="true"
                />
                {collectorLabel(collector)}
              </span>
            ))
          )}
        </div>

        <div className="ground-actions">
          <span className="updated">
            Updated {formatGeneratedAt(forecast.generatedAt)} · {okCollectors}/
            {snapshot.collectors.length || 3} sources
          </span>
          <button type="button" className="refresh" onClick={refresh} disabled={loading}>
            {loading ? "Refreshing…" : "Refresh"}
          </button>
        </div>

        {error ? (
          <p className="refresh-error" role="status">
            {error}
          </p>
        ) : null}

        <p className="disclaimer">
          Unofficial project. Not affiliated with OpenAI. Forecasts are estimates from public
          signals, not official notices.
        </p>
      </footer>
    </main>
  );
}
