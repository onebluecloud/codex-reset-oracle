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

function buildTrend(trend: number[] | undefined, chance: number): number[] {
  const points = Array.isArray(trend) ? trend.filter((value) => Number.isFinite(value)) : [];
  if (points.length === 0) points.push(chance);
  points[points.length - 1] = chance;
  while (points.length < 7) points.unshift(points[0]);
  return points;
}

function warmthFromChance(chance: number): number {
  const w = Math.min(1, Math.max(0, (chance - 18) / 60));
  return w * w * (3 - 2 * w);
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

// ── Ambient particle system ────────────────────────────────────────────────
function useParticles(canvasRef: React.RefObject<HTMLCanvasElement | null>) {
  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    const ctx = cv.getContext("2d");
    if (!ctx) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    let W = 0;
    let H = 0;

    const resize = () => {
      W = window.innerWidth;
      H = window.innerHeight;
      cv.width = W * dpr;
      cv.height = H * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    window.addEventListener("resize", resize);

    const N = 55;
    const dots = Array.from({ length: N }, () => ({
      x: Math.random() * 2000,
      y: Math.random() * 2000,
      r: 0.5 + Math.random() * 1.4,
      vx: (Math.random() - 0.5) * 0.12,
      vy: -0.06 - Math.random() * 0.1,
      a: 0.06 + Math.random() * 0.2
    }));

    const mouse = { x: -9999, y: -9999 };
    const onMove = (e: PointerEvent) => {
      mouse.x = e.clientX;
      mouse.y = e.clientY;
    };
    window.addEventListener("pointermove", onMove, { passive: true });

    let raf = 0;
    const frame = () => {
      ctx.clearRect(0, 0, W, H);
      const scrollY = window.scrollY || 0;

      for (const d of dots) {
        d.x += d.vx;
        d.y += d.vy;
        if (d.y < -10) {
          d.y = H + 10;
          d.x = Math.random() * W;
        }
        if (d.x < -10) d.x = W + 10;
        if (d.x > W + 10) d.x = -10;

        const dx = d.x - mouse.x;
        const dy = d.y - mouse.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < 150 && dist > 0) {
          const f = ((150 - dist) / 150) * 0.35;
          d.x += (dx / dist) * f;
          d.y += (dy / dist) * f;
        }

        const parallax = scrollY * (d.r / 4) * 0.015;
        ctx.beginPath();
        ctx.arc(d.x, d.y - parallax, d.r, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(174,182,255,${d.a})`;
        ctx.fill();
      }

      raf = window.requestAnimationFrame(frame);
    };
    raf = window.requestAnimationFrame(frame);

    return () => {
      window.cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
      window.removeEventListener("pointermove", onMove);
    };
  }, [canvasRef]);
}

// ── Main component ─────────────────────────────────────────────────────────
export function ForecastDashboard({
  initialSnapshot,
  initialHistory = [],
  initialTrend = []
}: ForecastDashboardProps) {
  const [snapshot, setSnapshot] = useState<Snapshot>(initialSnapshot);
  const [history, setHistory] = useState<HistoryEntry[]>(initialHistory);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [arrowHidden, setArrowHidden] = useState(false);

  const forecast = snapshot.forecast;
  const topSignals = forecast.topSignals;
  const chance = Math.min(100, Math.max(0, Math.round(forecast.chance)));

  const particlesRef = useRef<HTMLCanvasElement | null>(null);
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

  // Reveal refs
  const waveRevealRef = useRef<HTMLElement | null>(null);
  const signalsRevealRef = useRef<HTMLElement | null>(null);
  const trackRevealRef = useRef<HTMLElement | null>(null);
  const footerRevealRef = useRef<HTMLElement | null>(null);

  // Particles
  const reduce =
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  useParticles(reduce ? { current: null } : particlesRef);

  // Warmth sync for hero gradient
  useEffect(() => {
    const points = trendRef.current.slice();
    points[points.length - 1] = chance;
    trendRef.current = points;
    chanceRef.current = chance;

    const warmth = warmthFromChance(chance);
    const root = document.documentElement.style;
    root.setProperty("--fig-mid", `rgb(${mixRgb([208, 213, 255], [255, 216, 196], warmth)})`);
    root.setProperty("--fig-end", `rgb(${mixRgb([139, 150, 245], [240, 135, 158], warmth)})`);
  }, [chance]);

  // Scroll: hide arrow
  useEffect(() => {
    const handler = () => {
      if (!arrowHidden && window.scrollY > 80) setArrowHidden(true);
    };
    window.addEventListener("scroll", handler, { passive: true });
    return () => window.removeEventListener("scroll", handler);
  }, [arrowHidden]);

  // Scroll reveal (IntersectionObserver)
  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return;

    const targets = [
      waveRevealRef.current,
      signalsRevealRef.current,
      trackRevealRef.current,
      footerRevealRef.current
    ].filter(Boolean) as HTMLElement[];
    if (targets.length === 0) return;

    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            entry.target.classList.add("visible");
            io.unobserve(entry.target);
          }
        }
      },
      { threshold: 0.08 }
    );
    targets.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, []);

  // Cursor glow (global)
  useEffect(() => {
    if (reduce) return;
    const handler = (e: PointerEvent) => {
      document.documentElement.style.setProperty("--mx", `${e.clientX}px`);
      document.documentElement.style.setProperty("--my", `${e.clientY}px`);
    };
    window.addEventListener("pointermove", handler, { passive: true });
    return () => window.removeEventListener("pointermove", handler);
  }, [reduce]);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const response = await fetch("/api/snapshot", { cache: "no-store" });
      if (!response.ok) throw new Error("Snapshot refresh failed.");

      const nextSnapshot = (await response.json()) as Snapshot;
      setSnapshot(nextSnapshot);

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

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    let width = 1;
    let height = 1;

    const resize = () => {
      const rect = wrap.getBoundingClientRect();
      width = Math.max(1, rect.width);
      height = Math.max(1, rect.height);
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
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
    };
    const onLeave = () => {
      mouse.target = 0;
    };
    if (!reduce) {
      wrap.addEventListener("pointermove", onMove, { passive: true });
      wrap.addEventListener("pointerleave", onLeave, { passive: true });
    }

    const layers = [
      {
        amp: 16,
        freq: 0.011,
        speed: 0.28,
        off: 0,
        w: 1,
        cold: [94, 106, 210] as const,
        warm: [196, 116, 170] as const,
        a: 0.16,
        fill: 0.035,
        depth: 14
      },
      {
        amp: 26,
        freq: 0.007,
        speed: -0.42,
        off: 1.7,
        w: 1.6,
        cold: [120, 132, 250] as const,
        warm: [240, 140, 150] as const,
        a: 0.3,
        fill: 0.06,
        depth: 28
      },
      {
        amp: 38,
        freq: 0.005,
        speed: 0.56,
        off: 3.1,
        w: 2.8,
        cold: [174, 182, 255] as const,
        warm: [255, 178, 140] as const,
        a: 0.88,
        fill: 0.16,
        depth: 48
      }
    ];

    const clampIndex = (index: number, max: number) => Math.max(0, Math.min(max, index));

    const niceMax = (peak: number) => {
      const target = Math.max(peak, 1) * 1.2;
      for (const m of [40, 60, 80, 100]) if (m >= target) return m;
      return 100;
    };

    let phase = 0;
    let raf = 0;
    let lastDraw = -1;

    const render = () => {
      mouse.x += (mouse.tx - mouse.x) * 0.12;
      mouse.y += (mouse.ty - mouse.y) * 0.12;
      mouse.nx += (mouse.tnx - mouse.nx) * 0.12;
      mouse.active += (mouse.target - mouse.active) * 0.07;
      phase += 0.022 * mouse.active;

      const points = trendRef.current;
      let peak = 0;
      for (const value of points) peak = Math.max(peak, value);
      const yMax = niceMax(peak);
      const warmth = warmthFromChance(chanceRef.current);

      const plotL = 50;
      const plotT = height * 0.12;
      const plotB = height * 0.9;
      const plotW = Math.max(1, width - plotL);
      const levelAt = (v: number) => plotB - (v / yMax) * (plotB - plotT);
      const baseAt = (x: number) => {
        const n = points.length;
        if (n === 1) return levelAt(points[0]);
        const f = ((x - plotL) / plotW) * (n - 1);
        const i = Math.floor(f);
        const tt = f - i;
        const a = points[clampIndex(i, n - 1)];
        const b = points[clampIndex(i + 1, n - 1)];
        const v = a + (b - a) * (tt * tt * (3 - 2 * tt));
        return levelAt(v);
      };

      ctx!.clearRect(0, 0, width, height);

      // Y axis
      ctx!.font = "500 11px 'JetBrains Mono', ui-monospace, monospace";
      ctx!.textBaseline = "middle";
      ctx!.textAlign = "right";
      for (const v of [0, yMax / 2, yMax]) {
        const gy = levelAt(v);
        ctx!.strokeStyle = v === 0 ? "rgba(255,255,255,0.07)" : "rgba(255,255,255,0.03)";
        ctx!.lineWidth = 1;
        ctx!.beginPath();
        ctx!.moveTo(plotL, gy);
        ctx!.lineTo(width, gy);
        ctx!.stroke();
        ctx!.fillStyle = "rgba(255,255,255,0.28)";
        ctx!.fillText(`${v}%`, plotL - 10, gy);
      }

      const sigma = Math.max(100, plotW * 0.13);
      const globalAmp = 0.5 + (1 - mouse.y) * 0.65 * mouse.active;

      const yAt = (x: number, layer: (typeof layers)[number], parallax: number) => {
        const sx = x - parallax;
        const flow = Math.sin(sx * layer.freq + phase * layer.speed + layer.off) * layer.amp;
        const dx = x - mouse.x;
        const swell =
          -Math.exp(-(dx * dx) / (2 * sigma * sigma)) *
          (34 + layer.depth * 0.3) *
          mouse.active;
        const y = baseAt(sx) + flow * globalAmp + swell;
        return Math.max(6, Math.min(height - 2, y));
      };

      layers.forEach((layer, li) => {
        const parallax = mouse.nx * layer.depth * mouse.active;
        const col = mixRgb(layer.cold, layer.warm, warmth);
        const fillAlpha = layer.fill * (1 + warmth * 0.5);

        // Area fill
        ctx!.beginPath();
        for (let x = plotL; x <= width; x += 2) {
          const y = yAt(x, layer, parallax);
          if (x === plotL) ctx!.moveTo(x, y);
          else ctx!.lineTo(x, y);
        }
        ctx!.lineTo(width, plotB);
        ctx!.lineTo(plotL, plotB);
        ctx!.closePath();
        const gradient = ctx!.createLinearGradient(0, plotT, 0, plotB);
        gradient.addColorStop(0, `rgba(${col},${fillAlpha})`);
        gradient.addColorStop(1, `rgba(${col},0)`);
        ctx!.fillStyle = gradient;
        ctx!.fill();

        // Crest line
        ctx!.beginPath();
        for (let x = plotL; x <= width; x += 2) {
          const y = yAt(x, layer, parallax);
          if (x === plotL) ctx!.moveTo(x, y);
          else ctx!.lineTo(x, y);
        }
        ctx!.strokeStyle = `rgba(${col},${layer.a})`;
        ctx!.lineWidth = layer.w;
        if (li === layers.length - 1) {
          ctx!.shadowColor = `rgba(${mixRgb([130, 143, 255], [255, 150, 120], warmth)},0.55)`;
          ctx!.shadowBlur = 18 + warmth * 9;
        }
        ctx!.stroke();
        ctx!.shadowBlur = 0;
      });

      // "Now" marker
      const front = layers[layers.length - 1];
      const yNow = yAt(width, front, 0);
      const guideCol = mixRgb([174, 182, 255], [255, 180, 150], warmth);
      ctx!.strokeStyle = `rgba(${guideCol},0.18)`;
      ctx!.setLineDash([2, 5]);
      ctx!.beginPath();
      ctx!.moveTo(width - 1, yNow);
      ctx!.lineTo(width - 1, plotB);
      ctx!.stroke();
      ctx!.setLineDash([]);

      const dotSize = 4.5 + Math.sin(phase * 1.6) * 0.9 * mouse.active;
      ctx!.beginPath();
      ctx!.arc(width - 2, yNow, dotSize, 0, Math.PI * 2);
      ctx!.fillStyle = `rgb(${mixRgb([207, 212, 255], [255, 214, 184], warmth)})`;
      ctx!.shadowColor = `rgba(${guideCol},0.9)`;
      ctx!.shadowBlur = 20 + warmth * 8;
      ctx!.fill();
      ctx!.shadowBlur = 0;
    };

    const loop = (ts: number) => {
      const engaged = mouse.active > 0.002 || mouse.target > 0;
      if (engaged || lastDraw < 0 || ts - lastDraw > 400) {
        render();
        lastDraw = ts;
      }
      raf = window.requestAnimationFrame(loop);
    };

    if (reduce) {
      render();
    } else {
      raf = window.requestAnimationFrame(loop);
    }

    return () => {
      window.cancelAnimationFrame(raf);
      observer.disconnect();
      if (!reduce) {
        wrap.removeEventListener("pointermove", onMove);
        wrap.removeEventListener("pointerleave", onLeave);
      }
    };
  }, [reduce]);

  const okCollectors = useMemo(
    () => snapshot.collectors.filter((collector) => collector.ok).length,
    [snapshot.collectors]
  );

  return (
    <>
      {/* Fixed background layers */}
      <canvas ref={particlesRef} className="particles-canvas" aria-hidden="true" />
      <div className="atmosphere" aria-hidden="true" />
      <div className="cursor-glow" aria-hidden="true" />

      <div className="content">
        {/* Fixed nav */}
        <header className="masthead">
          <span className="wordmark">Codex Reset Oracle</span>
          <span className={`live live-${forecast.status}`}>
            <span className="live-dot" aria-hidden="true" />
            {STATUS_LABELS[forecast.status]} · Unofficial
          </span>
        </header>

        {/* ═══ Screen 1: Hero — pure impact, no charts ═══ */}
        <section className="screen-hero" aria-labelledby="forecast-title">
          <div className="hero-inner">
            <p className="hero-eyebrow">Reset Probability · Next 24 Hours</p>
            <div
              className="hero-readout"
              role="img"
              aria-label={`Codex reset chance ${chance}% in the next 24 hours`}
            >
              <span className="hero-figure">{chance}</span>
              <span className="hero-unit">%</span>
            </div>
            <h1 id="forecast-title" className="hero-headline">
              Codex Reset Chance
            </h1>
            <p className="hero-sub">{forecast.summary}</p>
            <div className="hero-window">
              <span className="hero-window-dot" aria-hidden="true" />
              {forecast.window}
            </div>
          </div>
          <div className={`scroll-arrow ${arrowHidden ? "hidden" : ""}`} aria-hidden="true">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M3 6l5 5 5-5" />
            </svg>
          </div>
        </section>

        {/* ═══ Screen 2: Wave — the data spectacle ═══ */}
        <section
          className="screen-wave reveal"
          ref={waveRevealRef}
          aria-label="Probability trend, last 30 hours"
        >
          <div className="wave-head">
            <div className="wave-head-left">
              <span className="wave-label">Trend</span>
              <span className="wave-title">Probability · Last 30h</span>
            </div>
            <span className="wave-hint">move cursor to disturb</span>
          </div>
          <div className="wave-wrap" ref={wrapRef}>
            <canvas ref={canvasRef} className="wave-canvas" />
          </div>
          <div className="wave-axis">
            <span>30h</span>
            <span>24h</span>
            <span>18h</span>
            <span>12h</span>
            <span>6h</span>
            <span>now</span>
          </div>
        </section>

        {/* ═══ Screen 3: Signals ═══ */}
        <section
          className="screen-signals reveal"
          ref={signalsRevealRef}
          aria-labelledby="signals-title"
        >
          <p className="section-label">Evidence</p>
          <h2 id="signals-title" className="section-title">
            Top Signals
          </h2>

          {topSignals.length === 0 ? (
            <p className="empty">
              No matching public signals right now. Refresh to re-check the sources.
            </p>
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
                      {signal.reason ? (
                        <span className="signal-detail">{signal.reason}</span>
                      ) : null}
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

        {/* Track record */}
        {history.length > 0 ? (
          <section
            className="track reveal"
            ref={trackRevealRef}
            aria-labelledby="track-title"
          >
            <p className="section-label">Track Record</p>
            <h2 id="track-title" className="section-title">
              Logged Events
            </h2>
            <ul className="track-list">
              {history.slice(0, 6).map((entry, index) => (
                <li
                  className={`track-row track-${entry.kind}`}
                  key={`${entry.kind}-${entry.at}-${index}`}
                >
                  <span className="track-tag">
                    {entry.kind === "prediction"
                      ? `Predicted ${entry.chance}%`
                      : "Actual reset"}
                  </span>
                  <span className="track-time" suppressHydrationWarning>
                    {formatGeneratedAt(entry.at)}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {/* Footer */}
        <footer className="ground reveal" ref={footerRevealRef}>
          <div className="sources" aria-label="Source pipeline status">
            {snapshot.collectors.length === 0 ? (
              <span className="sources-empty">
                Sources report after the first refresh.
              </span>
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
            <span className="updated" suppressHydrationWarning>
              Updated {formatGeneratedAt(forecast.generatedAt)} · {okCollectors}/
              {snapshot.collectors.length || 3} sources
            </span>
            <button
              type="button"
              className="refresh"
              onClick={refresh}
              disabled={loading}
            >
              {loading ? "Refreshing…" : "Refresh"}
            </button>
          </div>

          {error ? (
            <p className="refresh-error" role="status">
              {error}
            </p>
          ) : null}

          <p className="disclaimer">
            Unofficial project. Not affiliated with OpenAI. Forecasts are estimates from
            public signals, not official notices.
          </p>
        </footer>
      </div>
    </>
  );
}
