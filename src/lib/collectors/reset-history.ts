import type { ResetRecord } from "../kv";
import type { Milestone, ResetDetail } from "../types";

const RESET_RADAR_CURRENT_URL = "https://codex-reset-radar.pages.dev/current.json";

export type RadarHistory = {
  resets: ResetRecord[];
  milestones: Milestone[];
  details: ResetDetail[];
  /**
   * Whether the radar fetch+parse genuinely succeeded. A failed fetch returns
   * empty arrays, which is indistinguishable from "no resets" — consumers that
   * use this data as ground truth (prediction resolution) MUST skip their pass
   * when ok is false, or every due prediction gets mislabeled "no reset" and
   * poisons the training archive permanently.
   */
  ok: boolean;
};

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

/**
 * recent_windows entries, or null when the field is missing/not an array — a
 * silent upstream schema change must read as "failed", never as "no resets".
 */
function extractRecentWindows(payload: unknown): unknown[] | null {
  const record = asRecord(payload);
  if (!record) return null;
  return Array.isArray(record.recent_windows) ? record.recent_windows : null;
}

/** Parse fleet-wide official reset timestamps from radar recent_windows. */
export function parseResetHistory(payload: unknown): ResetRecord[] {
  return parseResetDetails(payload).map((detail) => ({ kind: "reset", at: detail.at }));
}

/**
 * Classify what drove a reset from its announcement text. The gap history mixes
 * incident-compensation resets with milestone/celebration ones; the archive
 * keeps the label so the cadence prior can be split per driver once enough
 * samples accrue.
 */
export function classifyResetDriver(text: string): ResetDetail["kind"] {
  const lower = text.toLowerCase();
  if (/事故|补偿|降级|故障|宕机|incident|outage|degrad|compensat/.test(lower)) return "incident";
  if (/万\s*(?:活跃|周活)?用户|里程碑|milestone|million|\bwau\b/.test(lower)) return "milestone";
  if (/庆祝|感谢|celebrat|thank|anniversar/.test(lower)) return "celebration";
  return "other";
}

/** Parse fleet-wide official resets with title + driver classification. */
export function parseResetDetails(payload: unknown): ResetDetail[] {
  const details: ResetDetail[] = [];
  for (const entry of extractRecentWindows(payload) ?? []) {
    const record = asRecord(entry);
    if (!record) continue;
    if (!isFleetWideScope(record.scope)) continue;
    const openedAt = typeof record.opened_at === "string" ? record.opened_at : null;
    if (!openedAt) continue;
    const ms = Date.parse(openedAt);
    if (!Number.isFinite(ms)) continue;
    const title = typeof record.title === "string" ? record.title : "";
    const summary = typeof record.summary === "string" ? record.summary : "";
    details.push({
      at: new Date(ms).toISOString(),
      title,
      scope: typeof record.scope === "string" ? record.scope : "",
      kind: classifyResetDriver(`${title} ${summary}`)
    });
  }
  return details;
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
  for (const entry of extractRecentWindows(payload) ?? []) {
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
const FAILED_HISTORY: RadarHistory = { resets: [], milestones: [], details: [], ok: false };

export async function collectResetHistory(): Promise<RadarHistory> {
  try {
    const response = await fetch(RESET_RADAR_CURRENT_URL, {
      headers: { accept: "application/json" }
    });
    if (!response.ok) return FAILED_HISTORY;
    const payload: unknown = await response.json();
    // A missing/reshaped recent_windows is an upstream schema change, not an
    // empty history — treat it as a failure so resolution skips this round.
    if (extractRecentWindows(payload) === null) return FAILED_HISTORY;
    const details = parseResetDetails(payload);
    return {
      resets: details.map((detail) => ({ kind: "reset", at: detail.at })),
      milestones: parseMilestones(payload),
      details,
      ok: true
    };
  } catch {
    return FAILED_HISTORY;
  }
}
