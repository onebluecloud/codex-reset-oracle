"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { HistoryEntry, PredlogPoint } from "@/lib/kv";
import type {
  AxisEvent,
  BoardDirection,
  CollectorStatus,
  ForecastStatus,
  SignalSource,
  Snapshot
} from "@/lib/types";

type ForecastDashboardProps = {
  initialSnapshot: Snapshot;
  initialHistory?: HistoryEntry[];
  initialTrend?: PredlogPoint[];
  initialEvents?: AxisEvent[];
};

const STATUS_LABELS: Record<ForecastStatus, string> = {
  ok: "Live event forecast",
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

const DIRECTION_LABELS: Record<BoardDirection, string> = {
  rising: "▲ Rising",
  falling: "▼ Falling",
  stable: "■ Stable"
};

function formatGeneratedAt(value: string): string {
  if (!value) return "not refreshed yet";
  return new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(
    new Date(value)
  );
}

function formatShortDate(ms: number): string {
  return new Intl.DateTimeFormat("en", { month: "short", day: "numeric" }).format(new Date(ms));
}

function collectorLabel(collector: CollectorStatus): string {
  return SOURCE_LABELS[collector.source];
}

// ── Axis data prep ──────────────────────────────────────────────────────────
// Real predlog points become the curve; archived resets become event markers.
// All projected onto a [tMin, now] domain — honest about however much history
// actually exists (short at first, lengthening as the log accrues).

type AxisPoint = { tf: number; v: number };
type AxisMarker = { tf: number; v: number; label: string };
type AxisTick = { tf: number; text: string };
type AxisData = {
  curve: AxisPoint[];
  markers: AxisMarker[];
  ticks: AxisTick[];
  spanDays: number;
};

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** Interpolate the curve value (0..1) at a time fraction. */
function valueAt(curve: AxisPoint[], tf: number): number {
  if (curve.length === 0) return 0;
  if (tf <= curve[0].tf) return curve[0].v;
  if (tf >= curve[curve.length - 1].tf) return curve[curve.length - 1].v;
  for (let i = 1; i < curve.length; i += 1) {
    if (tf <= curve[i].tf) {
      const a = curve[i - 1];
      const b = curve[i];
      const f = (tf - a.tf) / Math.max(1e-6, b.tf - a.tf);
      return a.v + (b.v - a.v) * f;
    }
  }
  return curve[curve.length - 1].v;
}

function buildAxisData(
  trend: PredlogPoint[],
  events: AxisEvent[],
  nowMs: number,
  currentChance: number
): AxisData {
  const pts = (trend ?? [])
    .map((p) => ({ ms: Date.parse(p.at), chance: p.chance }))
    .filter((p) => Number.isFinite(p.ms) && Number.isFinite(p.chance))
    .sort((a, b) => a.ms - b.ms);
  const evs = (events ?? [])
    .map((e) => ({ ms: Date.parse(e.at), label: e.label }))
    .filter((e) => Number.isFinite(e.ms))
    .sort((a, b) => a.ms - b.ms);

  // The domain follows the probability TREND (the predlog), not the much longer
  // reset history — so the curve fills the axis and shows real movement instead
  // of being squashed into a flat line at the right edge. Reset markers surface
  // only once the trend window grows long enough to contain them (the full reset
  // cadence already lives in the hero cards). A 12h floor keeps a sparse log
  // readable; end = now.
  const dataMin = pts.length ? pts[0].ms : nowMs - 36 * 3_600_000;
  const tMin = Math.min(dataMin, nowMs - 12 * 3_600_000);
  const span = Math.max(1, nowMs - tMin);
  const tf = (ms: number) => clamp01((ms - tMin) / span);

  const curve: AxisPoint[] = pts.map((p) => ({ tf: tf(p.ms), v: clamp01(p.chance / 100) }));
  // Pin the right edge to the live chance so the curve meets the "current"
  // callout exactly (the predlog's last hourly point can lag the live value).
  curve.push({ tf: 1, v: clamp01(currentChance / 100) });
  if (curve.length < 2) curve.unshift({ tf: 0, v: clamp01(currentChance / 100) });
  const markers: AxisMarker[] = evs
    .filter((e) => e.ms >= tMin && e.ms <= nowMs)
    .map((e) => ({ tf: tf(e.ms), v: curve.length ? valueAt(curve, tf(e.ms)) : 0.5, label: e.label }));

  // Time ticks: ~5 across the span, formatted by date.
  const ticks: AxisTick[] = [];
  const TICK_N = 5;
  for (let i = 0; i <= TICK_N; i += 1) {
    const f = i / TICK_N;
    const ms = tMin + f * span;
    ticks.push({ tf: f, text: i === TICK_N ? "NOW" : formatShortDate(ms).toUpperCase() });
  }

  return { curve, markers, ticks, spanDays: span / 86_400_000 };
}

type MouseState = { x: number; y: number };

export function ForecastDashboard({
  initialSnapshot,
  initialTrend = [],
  initialEvents = []
}: ForecastDashboardProps) {
  const [snapshot, setSnapshot] = useState<Snapshot>(initialSnapshot);
  const [trend, setTrend] = useState<PredlogPoint[]>(initialTrend);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scrolled, setScrolled] = useState(false);

  const forecast = snapshot.forecast;
  const board = forecast.board ?? [];
  const chance = Math.min(100, Math.max(0, Math.round(forecast.chance)));
  const cadence = forecast.cadence;

  const reduce =
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // Axis data, recomputed when the trend/events change. nowMs is captured once
  // on mount to keep SSR/CSR stable (no Date.now in render).
  const nowRef = useRef<number>(0);
  if (nowRef.current === 0) nowRef.current = Date.parse(forecast.generatedAt) || Date.now();
  const axisData = useMemo(
    () => buildAxisData(trend, initialEvents, nowRef.current, chance),
    [trend, initialEvents, chance]
  );

  // Live data the rAF loop reads (updated without re-subscribing the loop).
  const dataRef = useRef<{ axis: AxisData; chance: number }>({ axis: axisData, chance });
  useEffect(() => {
    dataRef.current = { axis: axisData, chance };
  }, [axisData, chance]);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const mouseRef = useRef<MouseState>({ x: -9999, y: -9999 });
  const boardRef = useRef<HTMLElement | null>(null);
  const footerRef = useRef<HTMLElement | null>(null);

  // ── Particle field: cloud (screen 1) morphs into the axis (screen 2) ──────
  useEffect(() => {
    if (reduce) return;
    const cv = canvasRef.current;
    if (!cv) return;
    let ctx: CanvasRenderingContext2D | null = null;
    try {
      ctx = cv.getContext("2d");
    } catch {
      ctx = null;
    }
    if (!ctx) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    let W = 0;
    let H = 0;
    const N = 1300;
    const P: Array<{
      ang: number;
      rad: number;
      speed: number;
      phase: number;
      size: number;
      tilt: number;
      ax: number;
      ay: number;
      role: string;
      glow: number;
      txX: number; // hero target — a point on the CODEX glyph cloud
      txY: number;
    }> = [];
    for (let k = 0; k < N; k += 1) {
      P.push({
        ang: Math.random() * 6.2832,
        rad: 0.16 + Math.random() * 0.62,
        speed: (0.2 + Math.random() * 0.8) * (Math.random() < 0.5 ? 1 : -1),
        phase: Math.random() * 6.2832,
        size: 0.7 + Math.random() * 1.7,
        tilt: 0.45 + Math.random() * 0.55,
        ax: 0,
        ay: 0,
        role: "haze",
        glow: 0.2,
        txX: 0,
        txY: 0
      });
    }

    // Sample the word CODEX into a point cloud — the hero particles settle into
    // these glyph points (then morph into the axis on scroll).
    const TEXT_CX = () => W * 0.61;
    const TEXT_CY = () => H * 0.36;
    const sampleCodex = () => {
      const off = document.createElement("canvas");
      off.width = W;
      off.height = H;
      const octx = off.getContext("2d");
      if (!octx) return;
      const fontPx = Math.min(W * 0.068, 100);
      octx.fillStyle = "#fff";
      octx.font = `900 ${fontPx}px Inter, system-ui, sans-serif`;
      octx.textAlign = "center";
      octx.textBaseline = "middle";
      octx.fillText("CODEX", TEXT_CX(), TEXT_CY());
      let data: Uint8ClampedArray;
      try {
        data = octx.getImageData(0, 0, W, H).data;
      } catch {
        return;
      }
      const pts: Array<{ x: number; y: number }> = [];
      const step = 6;
      for (let y = 0; y < H; y += step) {
        for (let x = 0; x < W; x += step) {
          if (data[(y * W + x) * 4 + 3] > 110) pts.push({ x, y });
        }
      }
      if (pts.length === 0) return;
      // Shuffle so particles fill the whole word evenly even when N differs.
      for (let k = N - 1; k > 0; k -= 1) {
        const j = Math.floor(Math.random() * (k + 1));
        [P[k], P[j]] = [P[j], P[k]];
      }
      for (let k = 0; k < N; k += 1) {
        const tp = pts[k % pts.length];
        P[k].txX = tp.x;
        P[k].txY = tp.y;
      }
    };

    const plot = { l: 0, r: 0, t: 0, b: 0, w: 0, h: 0 };
    const px = (tf: number) => plot.l + tf * plot.w;
    const py = (v: number) => plot.b - v * plot.h;

    const recompute = () => {
      plot.l = W * 0.1;
      plot.r = W * 0.9; // leave room on the right for the "current" price tag
      plot.t = H * 0.3;
      plot.b = H * 0.84;
      plot.w = plot.r - plot.l;
      plot.h = plot.b - plot.t;

      const { axis } = dataRef.current;
      const curve = axis.curve;
      let i = 0;
      const set = (count: number, fn: (p: (typeof P)[number], k: number, c: number) => void) => {
        for (let k = 0; k < count && i < N; k += 1, i += 1) fn(P[i], k, count);
      };

      // curve spine — sample the real curve (or a flat line at current chance)
      set(300, (p, k, c) => {
        const tf = k / (c - 1);
        const v = curve.length >= 2 ? valueAt(curve, tf) : dataRef.current.chance / 100;
        p.role = "curve";
        p.ax = px(tf);
        p.ay = py(v);
        p.glow = 1;
      });
      set(150, (p, k, c) => {
        p.role = "x";
        p.ax = plot.l + (k / (c - 1)) * plot.w;
        p.ay = plot.b;
        p.glow = 0.7;
      });
      set(110, (p, k, c) => {
        p.role = "y";
        p.ax = plot.l;
        p.ay = plot.b - (k / (c - 1)) * plot.h;
        p.glow = 0.7;
      });
      set(140, (p) => {
        const gx = Math.floor(Math.random() * 9) / 8;
        const gy = Math.floor(Math.random() * 5) / 4;
        p.role = "grid";
        p.ax = px(gx);
        p.ay = py(gy);
        p.glow = 0.22;
      });
      // node clusters at the real event markers
      const markers = axis.markers.length ? axis.markers : [{ tf: 1, v: dataRef.current.chance / 100, label: "" }];
      set(80, (p, k) => {
        const nd = markers[k % markers.length];
        const a = Math.random() * 6.28;
        const rr = Math.random() * 8;
        p.role = "node";
        p.ax = px(nd.tf) + Math.cos(a) * rr;
        p.ay = py(nd.v) + Math.sin(a) * rr;
        p.glow = 1;
      });
      set(N - i, (p) => {
        const tf = Math.random();
        const v = curve.length >= 2 ? valueAt(curve, tf) : dataRef.current.chance / 100;
        p.role = "haze";
        p.ax = px(tf);
        p.ay = py(Math.random() * v);
        p.glow = 0.12;
      });
    };

    const resize = () => {
      W = window.innerWidth;
      H = window.innerHeight;
      cv.width = Math.round(W * dpr);
      cv.height = Math.round(H * dpr);
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
      recompute();
      sampleCodex();
    };
    resize();
    window.addEventListener("resize", resize);

    let prog = 0;
    let progT = 0;
    const onScroll = () => {
      const vh = window.innerHeight;
      const start = vh * 0.5;
      const spanPx = vh * 0.9;
      progT = clamp01((window.scrollY - start) / spanPx);
      if (window.scrollY > 80) setScrolled(true);
      // Fade the field out before the Forecast Board scrolls in, so the axis
      // never bleeds over the footer (whose width is capped). axis-screen ends
      // at ~3.1vh; fade across 2.3–3.0vh.
      cv.style.opacity = String(clamp01(1 - (window.scrollY - vh * 2.3) / (vh * 0.7)));
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();

    const mouse = mouseRef.current;
    const onMove = (e: PointerEvent) => {
      mouse.x = e.clientX;
      mouse.y = e.clientY;
      document.documentElement.style.setProperty("--mx", `${e.clientX}px`);
      document.documentElement.style.setProperty("--my", `${e.clientY}px`);
    };
    window.addEventListener("pointermove", onMove, { passive: true });

    const ease = (p: number) => {
      p = clamp01(p);
      return p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
    };
    const roundRect = (c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) => {
      c.beginPath();
      c.moveTo(x + r, y);
      c.arcTo(x + w, y, x + w, y + h, r);
      c.arcTo(x + w, y + h, x, y + h, r);
      c.arcTo(x, y + h, x, y, r);
      c.arcTo(x, y, x + w, y, r);
      c.closePath();
    };

    let t = 0;
    let raf = 0;

    const drawAxis = (la: number) => {
      const { axis, chance: cur } = dataRef.current;
      const curve = axis.curve;
      const hasCurve = curve.length >= 2;

      // grid
      ctx!.strokeStyle = `rgba(124,137,240,${0.07 * la})`;
      ctx!.lineWidth = 1;
      for (const v of [0.25, 0.5, 0.75, 1]) {
        ctx!.beginPath();
        ctx!.moveTo(plot.l, py(v));
        ctx!.lineTo(plot.r, py(v));
        ctx!.stroke();
      }
      for (let g = 1; g <= 8; g += 1) {
        const x = plot.l + (g / 8) * plot.w;
        ctx!.beginPath();
        ctx!.moveTo(x, plot.t);
        ctx!.lineTo(x, plot.b);
        ctx!.stroke();
      }

      // glowing axes
      ctx!.save();
      ctx!.shadowColor = `rgba(124,137,240,${0.95 * la})`;
      ctx!.shadowBlur = 26;
      ctx!.strokeStyle = `rgba(192,200,255,${0.96 * la})`;
      ctx!.lineWidth = 2.6;
      ctx!.beginPath();
      ctx!.moveTo(plot.l, plot.t - 8);
      ctx!.lineTo(plot.l, plot.b);
      ctx!.lineTo(plot.r + 8, plot.b);
      ctx!.stroke();
      ctx!.restore();

      if (hasCurve) {
        // area fill
        const grd = ctx!.createLinearGradient(0, plot.t, 0, plot.b);
        grd.addColorStop(0, `rgba(124,137,240,${0.22 * la})`);
        grd.addColorStop(1, "rgba(124,137,240,0)");
        ctx!.beginPath();
        ctx!.moveTo(plot.l, plot.b);
        for (let s = 0; s <= 80; s += 1) {
          const tf = s / 80;
          ctx!.lineTo(px(tf), py(valueAt(curve, tf)));
        }
        ctx!.lineTo(px(1), plot.b);
        ctx!.closePath();
        ctx!.fillStyle = grd;
        ctx!.fill();

        // glowing curve
        ctx!.save();
        ctx!.shadowColor = `rgba(139,150,255,${la})`;
        ctx!.shadowBlur = 30;
        const cg = ctx!.createLinearGradient(plot.l, 0, plot.r, 0);
        cg.addColorStop(0, `rgba(150,162,240,${0.75 * la})`);
        cg.addColorStop(1, `rgba(214,221,255,${la})`);
        ctx!.strokeStyle = cg;
        ctx!.lineWidth = 3.4;
        ctx!.lineJoin = "round";
        ctx!.beginPath();
        for (let s = 0; s <= 160; s += 1) {
          const tf = s / 160;
          const x = px(tf);
          const y = py(valueAt(curve, tf));
          s ? ctx!.lineTo(x, y) : ctx!.moveTo(x, y);
        }
        ctx!.stroke();
        ctx!.restore();
      }

      // y ticks + x labels
      ctx!.font = "500 12px 'JetBrains Mono', monospace";
      ctx!.fillStyle = `rgba(150,156,176,${0.7 * la})`;
      ctx!.textAlign = "right";
      ctx!.textBaseline = "middle";
      for (const v of [0, 0.25, 0.5, 0.75, 1]) ctx!.fillText(`${v * 100}%`, plot.l - 14, py(v));
      ctx!.textAlign = "center";
      ctx!.textBaseline = "top";
      for (const tick of axis.ticks) ctx!.fillText(tick.text, px(tick.tf), plot.b + 14);

      // event annotation chips
      ctx!.textBaseline = "middle";
      for (const nd of axis.markers) {
        const x = px(nd.tf);
        const y = py(nd.v);
        ctx!.strokeStyle = `rgba(124,137,240,${0.4 * la})`;
        ctx!.lineWidth = 1;
        ctx!.setLineDash([2, 4]);
        ctx!.beginPath();
        ctx!.moveTo(x, y);
        ctx!.lineTo(x, y - 34);
        ctx!.stroke();
        ctx!.setLineDash([]);
        ctx!.font = "500 11px 'JetBrains Mono', monospace";
        const tw = ctx!.measureText(nd.label).width + 18;
        ctx!.fillStyle = `rgba(16,18,30,${0.85 * la})`;
        roundRect(ctx!, x - tw / 2, y - 56, tw, 22, 6);
        ctx!.fill();
        ctx!.strokeStyle = `rgba(255,255,255,${0.08 * la})`;
        ctx!.stroke();
        ctx!.fillStyle = `rgba(200,206,235,${la})`;
        ctx!.textAlign = "center";
        ctx!.fillText(nd.label, x, y - 45);
      }

      // ── Current readout: a living pulse on the curve end + a price tag
      //    pinned in the right gutter, so the number never sits under the dot. ──
      const cxp = px(1);
      const cyp = py(hasCurve ? valueAt(curve, 1) : cur / 100);

      // expanding pulse rings (the forecast is "live")
      for (let ri = 0; ri < 2; ri += 1) {
        const pr = (t * 0.55 + ri * 0.5) % 1;
        ctx!.strokeStyle = `rgba(139,150,255,${(1 - pr) * 0.5 * la})`;
        ctx!.lineWidth = 1.5;
        ctx!.beginPath();
        ctx!.arc(cxp, cyp, 5 + pr * 26, 0, 6.2832);
        ctx!.stroke();
      }
      // glowing node
      ctx!.save();
      ctx!.shadowColor = `rgba(160,170,255,${la})`;
      ctx!.shadowBlur = 18;
      ctx!.fillStyle = `rgba(236,239,255,${la})`;
      ctx!.beginPath();
      ctx!.arc(cxp, cyp, 5, 0, 6.2832);
      ctx!.fill();
      ctx!.restore();

      // horizontal guide to the tag in the right gutter
      const tagW = 96;
      const tagH = 52;
      const tagX = Math.min(W - tagW - 12, cxp + 24);
      const tagY = Math.max(plot.t, Math.min(plot.b - tagH, cyp - tagH / 2));
      ctx!.strokeStyle = `rgba(139,150,255,${0.4 * la})`;
      ctx!.lineWidth = 1;
      ctx!.setLineDash([2, 5]);
      ctx!.beginPath();
      ctx!.moveTo(cxp + 7, cyp);
      ctx!.lineTo(tagX, cyp);
      ctx!.stroke();
      ctx!.setLineDash([]);

      // tag card with a pointer notch toward the curve
      ctx!.save();
      ctx!.shadowColor = `rgba(108,120,240,${0.55 * la})`;
      ctx!.shadowBlur = 22;
      ctx!.fillStyle = `rgba(12,14,26,${0.95 * la})`;
      roundRect(ctx!, tagX, tagY, tagW, tagH, 12);
      ctx!.fill();
      ctx!.restore();
      ctx!.strokeStyle = `rgba(139,150,255,${0.6 * la})`;
      ctx!.lineWidth = 1.25;
      roundRect(ctx!, tagX, tagY, tagW, tagH, 12);
      ctx!.stroke();
      ctx!.fillStyle = `rgba(12,14,26,${0.95 * la})`;
      ctx!.beginPath();
      ctx!.moveTo(tagX + 1, cyp - 6);
      ctx!.lineTo(tagX - 7, cyp);
      ctx!.lineTo(tagX + 1, cyp + 6);
      ctx!.closePath();
      ctx!.fill();

      // big number + label + accent underline
      ctx!.fillStyle = `rgba(236,239,255,${la})`;
      ctx!.font = "800 27px Inter, sans-serif";
      ctx!.textAlign = "center";
      ctx!.textBaseline = "middle";
      ctx!.fillText(`${cur}%`, tagX + tagW / 2, tagY + tagH * 0.4);
      ctx!.font = "600 8px 'JetBrains Mono', monospace";
      ctx!.fillStyle = `rgba(176,184,255,${0.9 * la})`;
      ctx!.fillText("CURRENT", tagX + tagW / 2, tagY + tagH * 0.72);
      ctx!.strokeStyle = `rgba(139,150,255,${0.75 * la})`;
      ctx!.lineWidth = 2;
      ctx!.beginPath();
      ctx!.moveTo(tagX + tagW * 0.32, tagY + tagH - 9);
      ctx!.lineTo(tagX + tagW * 0.68, tagY + tagH - 9);
      ctx!.stroke();
    };

    const frame = () => {
      t += 0.016;
      prog += (progT - prog) * 0.08;
      const e = ease(prog);

      ctx!.clearRect(0, 0, W, H);
      ctx!.globalCompositeOperation = "lighter";

      // Soft halo behind the CODEX word, fading as the cloud morphs to the axis.
      if (e < 0.6) {
        const coreA = 1 - e / 0.6;
        const cr = Math.min(W, H) * 0.27 * (1 + Math.sin(t * 1.1) * 0.05);
        const g = ctx!.createRadialGradient(TEXT_CX(), TEXT_CY(), 0, TEXT_CX(), TEXT_CY(), cr);
        g.addColorStop(0, `rgba(120,132,250,${0.13 * coreA})`);
        g.addColorStop(1, "rgba(108,120,240,0)");
        ctx!.fillStyle = g;
        ctx!.beginPath();
        ctx!.arc(TEXT_CX(), TEXT_CY(), cr, 0, 6.2832);
        ctx!.fill();
      }

      for (const p of P) {
        // hero: rest on the CODEX glyph with a soft shimmer; morph to axis by e
        const hx = p.txX + Math.sin(t * 0.9 + p.phase) * 1.6;
        const hy = p.txY + Math.cos(t * 0.8 + p.phase) * 1.6;
        let x = hx + (p.ax - hx) * e;
        let y = hy + (p.ay - hy) * e;
        const dx = x - mouse.x;
        const dy = y - mouse.y;
        const d2 = dx * dx + dy * dy;
        if (d2 < 9000) {
          const f = (1 - d2 / 9000) * 12 * (1 - e * 0.7);
          const d = Math.sqrt(d2) || 1;
          x += (dx / d) * f;
          y += (dy / d) * f;
        }
        const tw = 0.65 + Math.sin(t * 1.7 + p.phase) * 0.35;
        const settle = p.role === "x" || p.role === "y" || p.role === "grid" ? 1 - e * 0.55 : 1;
        const al = (0.12 + p.glow * 0.55) * tw * settle * (p.role === "haze" ? 1 - e * 0.4 : 1);
        const bright = p.role === "curve" || p.role === "node";
        ctx!.beginPath();
        ctx!.arc(x, y, p.size * (bright ? 1.3 : 1), 0, 6.2832);
        ctx!.fillStyle = bright ? `rgba(198,208,255,${al})` : `rgba(150,162,240,${al})`;
        ctx!.fill();
      }

      ctx!.globalCompositeOperation = "source-over";
      if (e > 0.35) drawAxis((e - 0.35) / 0.65);

      raf = window.requestAnimationFrame(frame);
    };
    raf = window.requestAnimationFrame(frame);

    return () => {
      window.cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("pointermove", onMove);
    };
  }, [reduce]);

  // Scroll reveal for the board / footer.
  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return;
    const targets = [boardRef.current, footerRef.current].filter(Boolean) as HTMLElement[];
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
      { threshold: 0.06 }
    );
    targets.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/snapshot", { cache: "no-store" });
      if (!response.ok) throw new Error("Snapshot refresh failed.");
      const next = (await response.json()) as Snapshot;
      setSnapshot(next);
      try {
        const trendResponse = await fetch("/api/trend", { cache: "no-store" });
        if (trendResponse.ok) {
          const payload = (await trendResponse.json()) as { points?: PredlogPoint[] };
          if (Array.isArray(payload.points)) setTrend(payload.points);
        }
      } catch {
        // Trend refresh is best-effort.
      }
    } catch {
      setError("Could not refresh. Try again shortly.");
    } finally {
      setLoading(false);
    }
  }, []);

  const okCollectors = useMemo(
    () => snapshot.collectors.filter((collector) => collector.ok).length,
    [snapshot.collectors]
  );

  // Hero supporting figures (all real).
  const weekDelta = useMemo(() => {
    const pts = (trend ?? []).filter((p) => Number.isFinite(p.chance));
    if (pts.length < 2) return null;
    return pts[pts.length - 1].chance - pts[0].chance;
  }, [trend]);
  const cadenceDays = cadence ? Math.round(cadence.medianGapHours / 24) : null;
  const lastResetMs = useMemo(() => {
    const evs = (initialEvents ?? [])
      .map((e) => Date.parse(e.at))
      .filter((ms) => Number.isFinite(ms));
    return evs.length ? Math.max(...evs) : null;
  }, [initialEvents]);
  const qualityPct = Math.min(100, board.length ? 35 : 12); // calibrating: grows with resolved data

  return (
    <>
      <canvas ref={canvasRef} className="field" aria-hidden="true" />
      <div className="wash" aria-hidden="true" />

      <div className="content">
        <nav className="nav">
          <span className={`nav-brand nav-brand-${forecast.status}`}>
            <span className="nav-brand-dot" aria-hidden="true" />
            Codex Reset Oracle
          </span>
          <span className="nav-links">
            <a href="#board">Forecast</a>
            <a href="#method">Methodology</a>
            <a href="#about">About</a>
          </span>
        </nav>

        {/* ═══ Screen 1: professional hero ═══ */}
        <section className="hero" aria-labelledby="hero-title">
          <div className="hero-left">
            <span className="hero-tag">
              <span className="hero-tag-dot" aria-hidden="true" />
              {STATUS_LABELS[forecast.status]}
            </span>
            <h1 id="hero-title" className="hero-title">
              WILL IT
              <br />
              RESET?
            </h1>
            <p className="hero-sub">
              We turn real-world signals into a live probability for the one question that matters:
              when does OpenAI reset Codex limits.
            </p>
            <div
              className="hero-readout"
              role="img"
              aria-label={`Current reset probability ${chance} percent`}
            >
              <span className="hero-figure">
                {chance}
                <span className="pct">%</span>
              </span>
              <span className="hero-readout-label">
                Current
                <br />
                probability
              </span>
            </div>
            {weekDelta !== null ? (
              <div className="hero-trend">
                <span className="pill">
                  {weekDelta >= 0 ? "↗" : "↘"} {weekDelta >= 0 ? "+" : ""}
                  {weekDelta}% recent
                </span>
                <span style={{ color: "var(--muted)" }}>{forecast.window}</span>
              </div>
            ) : null}
            <div className="hero-meta" suppressHydrationWarning>
              <span>Updated {formatGeneratedAt(forecast.generatedAt)}</span>
              <span className="sep">·</span>
              <span>{okCollectors} sources tracked</span>
              {cadenceDays ? (
                <>
                  <span className="sep">·</span>
                  <span>~{cadenceDays}-day cadence</span>
                </>
              ) : null}
            </div>
            {cadenceDays ? (
              <div className="hero-card-deadline">
                <span className="ic" aria-hidden="true">
                  ◷
                </span>
                <span>
                  <span className="lab">Typical cadence</span>
                  <span className="val">~{cadenceDays} days between resets</span>
                  <span className="sm" suppressHydrationWarning>
                    {lastResetMs ? `Last fleet-wide reset · ${formatShortDate(lastResetMs)}` : "Awaiting reset history"}
                  </span>
                </span>
              </div>
            ) : null}
          </div>

          <div className="hero-cards" aria-hidden="true">
            <div className="card">
              <div className="card-head">
                <span>Forecast quality</span>
                <span className="q">i</span>
              </div>
              <div className="card-quality">
                <div>
                  <div className="card-big">Calibrating</div>
                  <div className="card-sub">Accruing a track record across resets</div>
                </div>
                <svg className="quality-ring" viewBox="0 0 56 56">
                  <circle cx="28" cy="28" r="22" fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth="3" />
                  <circle
                    cx="28"
                    cy="28"
                    r="22"
                    fill="none"
                    stroke="#8b96ff"
                    strokeWidth="3"
                    strokeDasharray={`${(qualityPct / 100) * 138} 200`}
                    strokeLinecap="round"
                    transform="rotate(-90 28 28)"
                  />
                </svg>
              </div>
            </div>
            <div className="card">
              <div className="card-head">
                <span>Reset cadence</span>
                <span className="q">i</span>
              </div>
              <div className="card-big">
                {cadenceDays ? `~${cadenceDays}d` : "—"}
              </div>
              <div className="card-sub">
                {cadence
                  ? `Median gap across ${cadence.nResets} fleet-wide resets`
                  : "Cadence appears after enough resets are logged"}
              </div>
            </div>
          </div>

          <div className={`scroll-cue ${scrolled ? "hidden" : ""}`} aria-hidden="true">
            <span>Scroll · signals become structure</span>
            <svg viewBox="0 0 14 14">
              <path d="M3 5l4 4 4-4" />
            </svg>
          </div>
        </section>

        {/* ═══ Screen 2: the axis forms here (canvas draws it) ═══ */}
        <section className="axis-screen" aria-label="Probability history">
          <div className="axis-title">
            <div>
              <span className="axis-kicker">Probability field</span>
              <h1 className="axis-h">Signals, resolved into one coordinate.</h1>
            </div>
            <p className="axis-note">
              The drifting cloud settles onto a single axis — time against probability. Where there
              was chaos, a line of judgement.
            </p>
          </div>
        </section>

        {/* ═══ Screen 3: forecast board ═══ */}
        <section className="board" id="board" ref={boardRef} aria-labelledby="board-title">
          <div className="board-inner">
            <div className="board-head">
              <div className="board-title">
                Forecast Board
                <b id="board-title">Codex reset — every angle</b>
              </div>
              <div className="board-legend">
                One event, read {board.length || "several"} ways
                <br />
                Updated every 30 min · 24h horizon
              </div>
            </div>

            {board.length === 0 ? (
              <p className="board-empty">
                Awaiting fresh public signals to build the board. Refresh to re-check the sources.
              </p>
            ) : (
              <ul className="board-rows">
                {board.map((row) => (
                  <li key={row.id} className={`row ${row.lead ? "lead" : ""}`}>
                    <span className="row-index">{row.id}</span>
                    <span className="row-event">
                      <span className="row-q">{row.question}</span>
                      <span className="row-signal">{row.lastSignal}</span>
                    </span>
                    <span className="row-bar">
                      <span className="bar-track">
                        <span className="bar-fill" style={{ width: `${row.probability}%` }} />
                        <span className="bar-node" style={{ left: `${row.probability}%` }} />
                      </span>
                      <span className="bar-scale">
                        <i>0</i>
                        <i>50</i>
                        <i>100</i>
                      </span>
                    </span>
                    <span className="row-prob" role="img" aria-label={`${row.probability} percent`}>
                      {row.probability}
                      <span className="pct">%</span>
                    </span>
                    <span className="row-status">
                      <span className={`status-word ${row.status}`}>{row.statusLabel}</span>
                      <span className="row-meta">
                        <span className={`row-dir ${row.direction}`}>
                          {DIRECTION_LABELS[row.direction]}
                        </span>
                        <span>
                          {row.deadline} · {row.confidence}
                        </span>
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>

        {/* ═══ Footer ═══ */}
        <footer className="footer" ref={footerRef}>
          <div className="footer-sources" aria-label="Source pipeline status">
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

          <div className="footer-actions">
            <span className="footer-updated" suppressHydrationWarning>
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
            Unofficial. Not affiliated with OpenAI. Every figure is an estimate from public signals,
            not an official notice.
          </p>
        </footer>
      </div>
    </>
  );
}
