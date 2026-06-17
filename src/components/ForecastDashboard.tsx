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
  ok: "Live reset forecast · Unofficial",
  partial: "Partial data · Unofficial",
  stale: "Stale data · Unofficial",
  "no-data": "No data yet · Unofficial"
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

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

/** Lunar phase name from the illuminated fraction (waxing — fills toward reset). */
function phaseName(illum: number): string {
  if (illum < 0.06) return "New moon";
  if (illum < 0.45) return "Waxing crescent";
  if (illum < 0.56) return "First quarter";
  if (illum < 0.94) return "Waxing gibbous";
  return "Full moon";
}

// ── Moon timeline data ──────────────────────────────────────────────────────
// The reset cycle drawn as moon phases: real fleet-wide resets are full moons,
// the disc fills (illum) toward the next predicted full moon (= next reset).
type MoonData = {
  /** Sample the cycle illumination (0..1) at a time fraction across the band. */
  illumAt: (tf: number) => number;
  /** Reset time fractions (full moons) inside the band. */
  resetTfs: number[];
  /** "Now" position on the band. */
  nowTf: number;
  /** Predicted next reset (full moon) position. */
  nextTf: number;
  /** Days until the predicted next reset (null when unknown). */
  nextDays: number | null;
  /** Most-recent reset timestamp (ms) or null. */
  lastResetMs: number | null;
  /** Short date label for each real reset (aligned with resetTfs). */
  resetDates: string[];
  /** Short date label for the predicted next reset. */
  nextDate: string;
  /** Half-width (band time-fraction) of the ±1σ reset window. */
  nextWindowTf: number;
  /** ±1σ reset-window half-width in days (for the label). */
  nextWindowDays: number;
  /** Predicted reset is already in the past (no new reset recorded yet). */
  overdue: boolean;
};

function buildMoonData(
  events: AxisEvent[],
  cadenceHours: number | null,
  nowMs: number,
  sigHours: number | null = null
): MoonData {
  const resets = (events ?? [])
    .map((e) => Date.parse(e.at))
    .filter((ms) => Number.isFinite(ms))
    .sort((a, b) => a - b);
  const cadenceMs = (cadenceHours ?? 13 * 24) * 3_600_000;
  const lastResetMs = resets.length ? resets[resets.length - 1] : null;

  // Predicted next reset = last reset + cadence. Do NOT floor it to "now": an
  // overdue prediction must read as "overdue", not silently drift forward a day
  // every day (which pinned EST. RESET to "today · 0 days" forever).
  const predictedNext = lastResetMs ? lastResetMs + cadenceMs : nowMs + cadenceMs;
  const nextDays = Math.round((predictedNext - nowMs) / 86_400_000); // negative = overdue
  const overdue = predictedNext < nowMs;

  // Band domain: a couple of cycles of history through the predicted next reset.
  const tMin = resets.length ? Math.min(resets[0], nowMs - cadenceMs) : nowMs - cadenceMs * 2;
  // Domain must reach past whichever is later — the prediction OR now — so an
  // overdue "now" still sits on the curve (to the right of the predicted full moon).
  const tMax = Math.max(predictedNext, nowMs) + cadenceMs * 0.18;
  const span = Math.max(1, tMax - tMin);
  const toTf = (ms: number) => clamp01((ms - tMin) / span);
  // ±1σ reset-window: shows the prediction is a spread, not a fixed day.
  const nextWindowTf = clamp01(((sigHours ?? 0) * 3_600_000) / span);
  const nextWindowDays = Math.round((sigHours ?? 0) / 24);

  // anchor full moons = real resets + the predicted next one
  const fullMoons = [...resets, predictedNext].sort((a, b) => a - b);

  // Illumination at time t: progress from the previous full moon to the next.
  const illumAtMs = (ms: number): number => {
    let prev = -Infinity;
    let next = Infinity;
    for (const fm of fullMoons) {
      if (fm <= ms && fm > prev) prev = fm;
      if (fm >= ms && fm < next) next = fm;
    }
    if (prev === -Infinity) return clamp01((ms - tMin) / cadenceMs) * 0.5; // before any reset
    if (next === Infinity) return clamp01((ms - prev) / cadenceMs);
    if (next - prev < 1) return 1;
    return clamp01((ms - prev) / (next - prev));
  };

  return {
    illumAt: (tf: number) => illumAtMs(tMin + tf * span),
    resetTfs: resets.map(toTf),
    nowTf: toTf(nowMs),
    nextTf: toTf(predictedNext),
    nextDays,
    lastResetMs,
    resetDates: resets.map(formatShortDate),
    nextDate: formatShortDate(predictedNext),
    nextWindowTf,
    nextWindowDays,
    overdue
  };
}

// ── Reset-rhythm: a moon-orbit timeline on its own second-screen canvas ────────
// A node is a real, textured moon at phase f, optionally with a soft spread glow.
function orbitMoon(
  g: CanvasRenderingContext2D,
  img: HTMLImageElement,
  ready: boolean,
  cx: number,
  cy: number,
  R: number,
  f: number,
  opt: { ring?: boolean; dashed?: boolean; glow?: boolean; dim?: number } = {}
) {
  const { ring = false, dashed = false, glow = false, dim = 1 } = opt;
  if (glow) {
    g.save();
    const gl = g.createRadialGradient(cx, cy, R * 0.82, cx, cy, R * 2.2);
    const c = dashed ? "150,168,255" : "192,204,255";
    gl.addColorStop(0, `rgba(${c},0.3)`);
    gl.addColorStop(0.45, `rgba(${c},0.11)`);
    gl.addColorStop(1, `rgba(${c},0)`);
    g.fillStyle = gl;
    g.beginPath();
    g.arc(cx, cy, R * 2.2, 0, 6.2832);
    g.fill();
    g.restore();
  }
  g.save();
  g.globalAlpha = dim;
  g.beginPath();
  g.arc(cx, cy, R, 0, 6.2832);
  g.clip();
  if (ready) {
    const s = 2 * R * 1.08;
    g.filter = "brightness(1.5) contrast(1.05)";
    g.drawImage(img, cx - s / 2, cy - s / 2, s, s);
    g.filter = "none";
  } else {
    g.fillStyle = "#c7ccd9";
    g.fillRect(cx - R, cy - R, 2 * R, 2 * R);
  }
  // night side
  g.save();
  g.filter = `blur(${Math.max(1, R * 0.04)}px)`;
  g.fillStyle = "rgba(9,12,26,0.82)";
  if (f <= 0.5) {
    g.beginPath();
    g.rect(cx - R - 2, cy - R - 2, R + 2, 2 * R + 4);
    g.ellipse(cx, cy, R * (1 - 2 * f), R, 0, 0, 6.2832);
    g.fill();
  } else {
    g.save();
    g.beginPath();
    g.rect(cx - R - 2, cy - R - 2, R + 2, 2 * R + 4);
    g.clip();
    g.beginPath();
    g.rect(cx - 2 * R, cy - 2 * R, 4 * R, 4 * R);
    g.ellipse(cx, cy, R * (2 * f - 1), R, 0, 0, 6.2832);
    g.clip("evenodd");
    g.fillRect(cx - R, cy - R, 2 * R, 2 * R);
    g.restore();
  }
  g.filter = "none";
  g.restore();
  g.restore();
  // ring
  g.save();
  g.globalAlpha = dim;
  if (dashed) {
    g.setLineDash([5, 5]);
    g.strokeStyle = "rgba(162,178,255,0.9)";
    g.lineWidth = 2;
  } else if (ring) {
    g.strokeStyle = "rgba(216,224,255,0.85)";
    g.lineWidth = 2;
  } else {
    g.strokeStyle = "rgba(150,160,220,0.2)";
    g.lineWidth = 1;
  }
  g.beginPath();
  g.arc(cx, cy, R, 0, 6.2832);
  g.stroke();
  g.setLineDash([]);
  g.restore();
}

function drawResetTimeline(
  g: CanvasRenderingContext2D,
  W: number,
  H: number,
  data: MoonData,
  img: HTMLImageElement,
  ready: boolean
) {
  const pad = Math.max(56, W * 0.05);
  const left = pad;
  const right = W - pad;
  const width = right - left;
  const cy = H * 0.62;
  const amp = H * 0.2;
  const X = (tf: number) => left + tf * width;
  const Y = (tf: number) => cy - amp * Math.sin(tf * Math.PI);
  const nowX = X(data.nowTf);
  const estX = X(data.nextTf);

  // legend
  g.textAlign = "left";
  g.textBaseline = "middle";
  const ly = Math.max(22, H * 0.08);
  let lx = left;
  orbitMoon(g, img, ready, lx + 8, ly, 8, 1, { ring: true });
  g.font = "500 12px 'JetBrains Mono', monospace";
  g.fillStyle = "rgba(210,218,255,0.95)";
  g.fillText("Past reset", lx + 22, ly + 1);
  lx += 130;
  g.strokeStyle = "rgba(206,214,255,0.85)";
  g.lineWidth = 2;
  g.beginPath();
  g.moveTo(lx + 6, ly - 8);
  g.lineTo(lx + 6, ly + 8);
  g.stroke();
  g.fillStyle = "rgba(220,226,255,0.95)";
  g.fillText("Now", lx + 18, ly + 1);
  lx += 78;
  orbitMoon(g, img, ready, lx + 8, ly, 8, 1, { dashed: true });
  g.fillStyle = "rgba(160,176,255,0.95)";
  g.fillText("Predicted next", lx + 22, ly + 1);
  g.textBaseline = "alphabetic";

  // the orbit curve: solid up to now, dashed after, highlighted now→est
  const STEP = 0.004;
  g.lineWidth = 2;
  g.strokeStyle = "rgba(190,200,255,0.22)";
  g.beginPath();
  for (let tf = 0; tf <= data.nowTf + 1e-6; tf += STEP) {
    const x = X(tf);
    const y = Y(tf);
    if (tf === 0) g.moveTo(x, y);
    else g.lineTo(x, y);
  }
  g.stroke();
  g.setLineDash([4, 7]);
  g.strokeStyle = "rgba(150,160,220,0.18)";
  g.beginPath();
  let started = false;
  for (let tf = data.nowTf; tf <= 1 + 1e-6; tf += STEP) {
    const x = X(tf);
    const y = Y(tf);
    if (!started) {
      g.moveTo(x, y);
      started = true;
    } else g.lineTo(x, y);
  }
  g.stroke();
  g.setLineDash([]);
  g.strokeStyle = "rgba(170,184,255,0.5)";
  g.lineWidth = 2.5;
  g.beginPath();
  started = false;
  for (let tf = data.nowTf; tf <= data.nextTf + 1e-6; tf += STEP) {
    const x = X(tf);
    const y = Y(tf);
    if (!started) {
      g.moveTo(x, y);
      started = true;
    } else g.lineTo(x, y);
  }
  g.stroke();

  // faint intermediate phase nodes along the curve
  const keyTf = [...data.resetTfs, data.nextTf, data.nowTf];
  const n = 22;
  for (let i = 0; i < n; i += 1) {
    const tf = i / (n - 1);
    if (keyTf.some((k) => Math.abs(k - tf) < 0.022)) continue;
    orbitMoon(g, img, ready, X(tf), Y(tf), 13, data.illumAt(tf), { dim: tf > data.nowTf ? 0.5 : 0.72 });
  }

  // past resets — big real moons + ring + date
  g.textAlign = "center";
  for (let i = 0; i < data.resetTfs.length; i += 1) {
    const tf = data.resetTfs[i];
    const x = X(tf);
    const y = Y(tf);
    orbitMoon(g, img, ready, x, y, 30, 1, { ring: true, glow: true });
    g.font = "600 11px 'JetBrains Mono', monospace";
    g.fillStyle = "rgba(208,216,255,0.92)";
    g.textBaseline = "alphabetic";
    g.fillText("RESET", x, y - 42);
    g.font = "500 11px 'JetBrains Mono', monospace";
    g.fillStyle = "rgba(150,160,205,0.8)";
    g.textBaseline = "top";
    g.fillText(data.resetDates[i] ?? "", x, y + 38);
  }

  // ±1σ reset window — the prediction is a spread, not a fixed day
  if (data.nextWindowTf > 0) {
    const ey = Y(data.nextTf);
    const sigPx = Math.max(48, data.nextWindowTf * width);
    const wb = g.createRadialGradient(estX, ey, 0, estX, ey, sigPx);
    wb.addColorStop(0, "rgba(150,168,255,0.17)");
    wb.addColorStop(0.6, "rgba(150,168,255,0.06)");
    wb.addColorStop(1, "rgba(150,168,255,0)");
    g.fillStyle = wb;
    g.beginPath();
    g.ellipse(estX, ey, sigPx, 30, 0, 0, 6.2832);
    g.fill();
    g.setLineDash([2, 4]);
    g.strokeStyle = "rgba(150,168,255,0.3)";
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(estX - sigPx, ey);
    g.lineTo(estX + sigPx, ey);
    g.stroke();
    g.setLineDash([]);
    g.font = "500 10px 'JetBrains Mono', monospace";
    g.fillStyle = "rgba(150,168,255,0.78)";
    g.textAlign = "center";
    g.textBaseline = "top";
    g.fillText(`reset window ±${data.nextWindowDays}d`, estX, ey + 56);
  }

  // predicted next — big dashed moon + date
  {
    const y = Y(data.nextTf);
    orbitMoon(g, img, ready, estX, y, 30, 1, { dashed: true, glow: true });
    g.font = "600 11px 'JetBrains Mono', monospace";
    g.fillStyle = "rgba(168,182,255,0.98)";
    g.textAlign = "center";
    g.textBaseline = "alphabetic";
    g.fillText("EST. RESET", estX, y - 42);
    g.font = "500 11px 'JetBrains Mono', monospace";
    g.fillStyle = "rgba(150,162,225,0.85)";
    g.textBaseline = "top";
    g.fillText(data.nextDate, estX, y + 38);
  }

  // NOW marker on the curve + days-to-next
  {
    const y = Y(data.nowTf);
    g.strokeStyle = "rgba(210,218,255,0.8)";
    g.lineWidth = 2;
    g.setLineDash([2, 3]);
    g.beginPath();
    g.moveTo(nowX, y - 54);
    g.lineTo(nowX, y + 54);
    g.stroke();
    g.setLineDash([]);
    g.fillStyle = "#0b0d16";
    g.strokeStyle = "rgba(210,218,255,0.9)";
    g.lineWidth = 2;
    g.beginPath();
    g.arc(nowX, y, 6, 0, 6.2832);
    g.fill();
    g.stroke();
    g.font = "700 12px 'JetBrains Mono', monospace";
    g.fillStyle = "#eef0ff";
    g.textAlign = "center";
    g.textBaseline = "alphabetic";
    g.fillText("NOW", nowX, y - 62);
    if (data.nextDays !== null) {
      g.font = "700 13px 'JetBrains Mono', monospace";
      g.fillStyle = data.overdue ? "rgba(255,200,140,0.95)" : "rgba(198,208,255,0.96)";
      const daysLabel = data.overdue ? `OVERDUE ${Math.abs(data.nextDays)}D` : `${data.nextDays} DAYS`;
      g.fillText(daysLabel, (nowX + estX) / 2, Y((data.nowTf + data.nextTf) / 2) + 58);
    }
  }
}

export function ForecastDashboard({
  initialSnapshot,
  initialEvents = []
}: ForecastDashboardProps) {
  const [snapshot, setSnapshot] = useState<Snapshot>(initialSnapshot);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scrolled, setScrolled] = useState(false);

  const forecast = snapshot.forecast;
  const board = forecast.board ?? [];
  const chance = Math.min(100, Math.max(0, Math.round(forecast.chance)));
  const cadence = forecast.cadence;
  const illum = clamp01(chance / 100);

  const reduce =
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const nowRef = useRef<number>(0);
  if (nowRef.current === 0) nowRef.current = Date.parse(forecast.generatedAt) || Date.now();
  const moon = useMemo(
    () => buildMoonData(initialEvents, cadence?.medianGapHours ?? null, nowRef.current, cadence?.sigHatHours ?? null),
    [initialEvents, cadence]
  );

  // Soft "a reset may have just happened" flag — read straight off live signals,
  // NEVER written into reset history / cadence. Keeps the ground truth clean while
  // still letting the UI react the moment people report a fresh reset.
  const recentResetSignal = useMemo(() => {
    const now = nowRef.current;
    for (const s of forecast.topSignals ?? []) {
      const t = `${s.title} ${s.text}`.toLowerCase();
      const applied =
        /reset[^.]{0,40}(was |been |has been |appears to have been )?appl|just\s+(got\s+|been\s+)?reset|reset\s+(just\s+)?(happen|occurr|went through)/.test(t);
      const feature = /would like|please add|feature request|i'?d like|show (the |banked )?reset|add .*reset (count|state|status)/.test(t);
      const pub = Date.parse(s.publishedAt);
      const recent = Number.isFinite(pub) && now - pub < 48 * 3_600_000 && now - pub > -3_600_000;
      if (applied && !feature && recent && s.strength >= 0.7) {
        return { url: s.url };
      }
    }
    return null;
  }, [forecast.topSignals]);

  // Live values the rAF loop reads.
  const dataRef = useRef<{ moon: MoonData; illum: number; chance: number }>({ moon, illum, chance });
  useEffect(() => {
    dataRef.current = { moon, illum, chance };
  }, [moon, illum, chance]);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rhythmRef = useRef<HTMLCanvasElement | null>(null);
  const boardRef = useRef<HTMLElement | null>(null);
  const footerRef = useRef<HTMLElement | null>(null);

  // ── Lunar canvas: starfield + big moon (illum = chance) + phase timeline ────
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
    const g = ctx;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    let W = 0;
    let H = 0;

    let stars: Array<{ x: number; y: number; r: number; a: number; tw: number }> = [];
    // real lunar near-side texture (NASA/GSFC/ASU LRO mosaic) — canvas only does
    // the phase shading; all surface detail comes from the real photo
    const moonImg = new Image();
    moonImg.decoding = "async";
    let moonReady = false;
    moonImg.onload = () => {
      moonReady = true;
    };
    moonImg.src = "/moon.jpg";

    const seedStars = () => {
      stars = Array.from({ length: 150 }, () => ({
        x: Math.random() * W,
        y: Math.random() * H,
        r: Math.random() * 1.3 + 0.2,
        a: Math.random() * 0.5 + 0.15,
        tw: Math.random() * 6.28
      }));
    };

    const resize = () => {
      W = window.innerWidth;
      H = window.innerHeight;
      cv.width = Math.round(W * dpr);
      cv.height = Math.round(H * dpr);
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      seedStars();
    };
    resize();
    window.addEventListener("resize", resize);

    const onScroll = () => {
      if (!scrolled && window.scrollY > 80) setScrolled(true);
      // fade the sky out before the board scrolls in
      cv.style.opacity = String(clamp01(1 - (window.scrollY - window.innerHeight * 0.55) / (window.innerHeight * 0.6)));
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();

    const MX = () => W * 0.6;
    const MY = () => H * 0.4;
    const MR = () => Math.min(W, H) * 0.275;

    // draw a moon disc with illuminated fraction f (waxing = lit on the right)
    const drawMoon = (cx: number, cy: number, R: number, f: number, t: number) => {
      // two-layer cool halo
      const h1 = g.createRadialGradient(cx, cy, R * 0.84, cx, cy, R * (1.22 + f * 0.45));
      h1.addColorStop(0, `rgba(198,212,255,${0.04 + f * 0.15})`);
      h1.addColorStop(1, "rgba(198,212,255,0)");
      g.fillStyle = h1;
      g.beginPath();
      g.arc(cx, cy, R * (1.22 + f * 0.45), 0, 6.2832);
      g.fill();
      const h2 = g.createRadialGradient(cx, cy, R * 0.6, cx, cy, R * (1.9 + f));
      h2.addColorStop(0, `rgba(150,170,255,${0.02 + f * 0.05})`);
      h2.addColorStop(1, "rgba(150,170,255,0)");
      g.fillStyle = h2;
      g.beginPath();
      g.arc(cx, cy, R * (1.9 + f), 0, 6.2832);
      g.fill();

      g.save();
      g.beginPath();
      g.arc(cx, cy, R, 0, 6.2832);
      g.clip();

      if (moonReady) {
        // real moon, scaled up a touch so the corner credit text falls outside the disc;
        // brighten + a hair of contrast so the grey surface reads brightly on black
        const s = 2 * R * 1.08;
        g.filter = "brightness(1.5) contrast(1.05)";
        g.drawImage(moonImg, cx - s / 2, cy - s / 2, s, s);
        g.filter = "none";
        // faint cool unify with the site palette (stays natural)
        g.globalCompositeOperation = "soft-light";
        g.fillStyle = "rgba(204,220,255,0.4)";
        g.fillRect(cx - R, cy - R, 2 * R, 2 * R);
        g.globalCompositeOperation = "source-over";
      } else {
        g.fillStyle = "#c7ccd9";
        g.fillRect(cx - R, cy - R, 2 * R, 2 * R);
      }

      // night side — dim the real texture into a faint earthshine-lit dark side,
      // soft terminator via blur. waxing → lit on the right.
      g.save();
      g.filter = `blur(${Math.max(1, R * 0.018)}px)`;
      g.fillStyle = "rgba(9,12,26,0.8)";
      if (f <= 0.5) {
        // night = left half ∪ central ellipse (single non-zero fill, alpha not doubled)
        g.beginPath();
        g.rect(cx - R - 2, cy - R - 2, R + 2, 2 * R + 4);
        g.ellipse(cx, cy, R * (1 - 2 * f), R, 0, 0, 6.2832);
        g.fill();
      } else {
        // night = left half ∩ outside(lit ellipse) = thin left crescent
        g.save();
        g.beginPath();
        g.rect(cx - R - 2, cy - R - 2, R + 2, 2 * R + 4);
        g.clip();
        g.beginPath();
        g.rect(cx - 2 * R, cy - 2 * R, 4 * R, 4 * R);
        g.ellipse(cx, cy, R * (2 * f - 1), R, 0, 0, 6.2832);
        g.clip("evenodd");
        g.fillRect(cx - R, cy - R, 2 * R, 2 * R);
        g.restore();
      }
      g.filter = "none";
      g.restore();

      g.restore();
      // faint cool rim
      g.strokeStyle = "rgba(200,214,255,0.12)";
      g.lineWidth = Math.max(1, R * 0.005);
      g.beginPath();
      g.arc(cx, cy, R, 0, 6.2832);
      g.stroke();
      void t;
    };

    // the reset-rhythm timeline now lives on its own second-screen canvas
    // (see the module-level drawResetTimeline + the rhythm useEffect below)

    let t = 0;
    let raf = 0;
    const frame = () => {
      t += 0.016;
      g.clearRect(0, 0, W, H);
      for (const s of stars) {
        const a = s.a * (0.6 + 0.4 * Math.sin(t * 0.8 + s.tw));
        g.fillStyle = `rgba(200,206,255,${a})`;
        g.beginPath();
        g.arc(s.x, s.y, s.r, 0, 6.2832);
        g.fill();
      }
      drawMoon(MX(), MY(), MR(), dataRef.current.illum, t);
      raf = window.requestAnimationFrame(frame);
    };
    raf = window.requestAnimationFrame(frame);

    return () => {
      window.cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
      window.removeEventListener("scroll", onScroll);
    };
  }, [reduce, scrolled]);

  // ── Reset-rhythm canvas (its own second screen) ───────────────────────────
  useEffect(() => {
    if (reduce) return;
    const cv = rhythmRef.current;
    if (!cv) return;
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    const g = ctx;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const moonImg = new Image();
    moonImg.decoding = "async";
    let ready = false;
    const render = () => {
      const rect = cv.getBoundingClientRect();
      const W = Math.max(320, rect.width);
      const H = Math.max(160, rect.height);
      cv.width = Math.round(W * dpr);
      cv.height = Math.round(H * dpr);
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, W, H);
      for (let i = 0; i < 60; i += 1) {
        const sx = (i * 71.3) % W;
        const sy = (i * 47.7) % H;
        const a = 0.05 + ((i * 37) % 50) / 320;
        g.fillStyle = `rgba(200,206,255,${a})`;
        g.beginPath();
        g.arc(sx, sy, (((i * 13) % 10) / 10) * 0.7 + 0.2, 0, 6.2832);
        g.fill();
      }
      drawResetTimeline(g, W, H, moon, moonImg, ready);
    };
    moonImg.onload = () => {
      ready = true;
      render();
    };
    moonImg.src = "/moon.jpg";
    render();
    window.addEventListener("resize", render);
    return () => window.removeEventListener("resize", render);
  }, [reduce, moon]);

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
  const cadenceDays = cadence ? Math.round(cadence.medianGapHours / 24) : null;

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

        {/* ═══ Screen 1: lunar hero ═══ */}
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
              Codex resets on a cycle, like a moon. The disc fills as the next reset nears — a full
              disc means it&apos;s due.
            </p>
            <div
              className="phase-read"
              role="img"
              aria-label={`Reset probability ${chance} percent — ${phaseName(illum)}`}
            >
              <div className="phase-name">
                <span>Current phase</span>
                {phaseName(illum)}
              </div>
              <div className="phase-illum">
                <b>{chance}%</b> illuminated
              </div>
            </div>
            {recentResetSignal ? (
              <a
                className="reset-flash"
                href={recentResetSignal.url}
                target="_blank"
                rel="noopener noreferrer"
                role="status"
              >
                <span className="reset-flash-dot" aria-hidden="true" />
                <span>Signal: a reset may have just been applied — awaiting official confirmation</span>
              </a>
            ) : null}
            <div className="next-reset">
              <span className="ic" aria-hidden="true">
                🌕
              </span>
              <span>
                <span className="lab">Next full disc · est. reset</span>
                <span className="val">
                  {moon.overdue
                    ? `overdue ~${Math.abs(moon.nextDays ?? 0)}d`
                    : moon.nextDays !== null
                      ? `in ~${moon.nextDays} days`
                      : "estimating…"}
                </span>
                <span className="sm" suppressHydrationWarning>
                  {cadenceDays ? `~${cadenceDays}-day cycle` : "cycle forming"}
                  {moon.overdue
                    ? " · awaiting reset record"
                    : moon.lastResetMs
                      ? ` · last reset ${formatShortDate(moon.lastResetMs)}`
                      : ""}
                </span>
              </span>
            </div>
          </div>
        </section>

        {/* ═══ Screen 2: reset rhythm ═══ */}
        <section className="rhythm" id="rhythm" aria-labelledby="rhythm-title">
          <div className="rhythm-inner">
            <div className="rhythm-head">
              <div className="rhythm-title">
                Reset rhythm
                <b id="rhythm-title">Every full disc is a reset</b>
              </div>
              <div className="rhythm-legend">
                Codex resets every {cadenceDays ? `~${cadenceDays}` : "~13"} days
                <br />
                Past resets · now · predicted next
              </div>
            </div>
            <canvas ref={rhythmRef} className="rhythm-field" aria-hidden="true" />
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
          <p className="disclaimer" style={{ opacity: 0.65 }}>
            Moon imagery: NASA/GSFC/Arizona State University · Lunar Reconnaissance Orbiter.
          </p>
        </footer>
      </div>
    </>
  );
}
