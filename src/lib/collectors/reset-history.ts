import type { ResetRecord } from "../kv";
import type { Milestone } from "../types";

const RESET_RADAR_CURRENT_URL = "https://codex-reset-radar.pages.dev/current.json";

export type RadarHistory = { resets: ResetRecord[]; milestones: Milestone[] };

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/**
 * Whether a recent_windows entry's scope is a *fleet-wide official* reset
 * ("所有付费计划" / "所有计划") rather than a Codex-only or single-tier
 * compensation. Only fleet-wide resets feed the age-since-last-reset prior.
 */
export function isFleetWideScope(scope: unknown): boolean {
  return typeof scope === "string" && scope.includes("所有");
}

function extractRecentWindows(payload: unknown): unknown[] {
  const record = asRecord(payload);
  if (!record) return [];
  return Array.isArray(record.recent_windows) ? record.recent_windows : [];
}

/** Parse fleet-wide official reset timestamps from radar recent_windows. */
export function parseResetHistory(payload: unknown): ResetRecord[] {
  const resets: ResetRecord[] = [];
  for (const entry of extractRecentWindows(payload)) {
    const record = asRecord(entry);
    if (!record) continue;
    if (!isFleetWideScope(record.scope)) continue;
    const openedAt = typeof record.opened_at === "string" ? record.opened_at : null;
    if (!openedAt) continue;
    const ms = Date.parse(openedAt);
    if (!Number.isFinite(ms)) continue;
    resets.push({ kind: "reset", at: new Date(ms).toISOString() });
  }
  return resets;
}

/**
 * Parse user-count milestones (e.g. "500 万用户") from radar recent_windows.
 * Sam Altman pledged a reset at every additional million WAU up to 10M, so the
 * milestone cadence is an official, near-certain reset driver — the forecast
 * extrapolates the next milestone's ETA from these anchors. One anchor per level
 * (earliest crossing wins), returned sorted ascending by user count.
 */
export function parseMilestones(payload: unknown): Milestone[] {
  const byLevel = new Map<number, Milestone>();
  for (const entry of extractRecentWindows(payload)) {
    const record = asRecord(entry);
    if (!record) continue;
    const title = typeof record.title === "string" ? record.title : "";
    const summary = typeof record.summary === "string" ? record.summary : "";
    const match = `${title} ${summary}`.match(/(\d+)\s*万\s*(?:活跃|周活)?用户/);
    if (!match) continue;
    const countM = Number.parseInt(match[1], 10) / 100; // "500万" -> 5 (million)
    if (!Number.isFinite(countM) || countM <= 0) continue;
    const openedAt = typeof record.opened_at === "string" ? record.opened_at : null;
    if (!openedAt) continue;
    const ms = Date.parse(openedAt);
    if (!Number.isFinite(ms)) continue;
    const at = new Date(ms).toISOString();
    const existing = byLevel.get(countM);
    if (!existing || ms < Date.parse(existing.at)) byLevel.set(countM, { at, countM });
  }
  return [...byLevel.values()].sort((a, b) => a.countM - b.countM);
}

/**
 * Fetch fleet-wide reset history + user-count milestones from Codex Reset Radar.
 * Both feed scoring's time-based priors, so no manual mark-reset is required.
 * Returns empty arrays on any failure — the priors simply stay inactive.
 */
export async function collectResetHistory(): Promise<RadarHistory> {
  try {
    const response = await fetch(RESET_RADAR_CURRENT_URL, {
      headers: { accept: "application/json" }
    });
    if (!response.ok) return { resets: [], milestones: [] };
    const payload: unknown = await response.json();
    return { resets: parseResetHistory(payload), milestones: parseMilestones(payload) };
  } catch {
    return { resets: [], milestones: [] };
  }
}
