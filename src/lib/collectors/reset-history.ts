import type { ResetRecord } from "../kv";

const RESET_RADAR_CURRENT_URL = "https://codex-reset-radar.pages.dev/current.json";

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/**
 * Whether a recent_windows entry's scope is a *fleet-wide official* reset
 * ("所有付费计划" / "所有计划") rather than a Codex-only or single-tier
 * compensation. We only feed fleet-wide resets to the cadence prior so the
 * "OpenAI officially reset everyone's quota" framing stays honest.
 */
export function isFleetWideScope(scope: unknown): boolean {
  return typeof scope === "string" && scope.includes("所有");
}

function extractRecentWindows(payload: unknown): unknown[] {
  const record = asRecord(payload);
  if (!record) return [];
  return Array.isArray(record.recent_windows) ? record.recent_windows : [];
}

/**
 * Parse Codex Reset Radar's `recent_windows` into fleet-wide reset records.
 * Pure (no I/O) so it can be unit-tested against a fixture payload.
 */
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
 * Fetch the history of fleet-wide official Codex resets from Codex Reset Radar's
 * recent_windows — these opened_at timestamps feed the age-since-last-reset prior
 * in scoring, so no manual mark-reset is required. Returns [] on any failure: the
 * prior simply stays inactive and the forecast falls back to signal-only.
 */
export async function collectResetHistory(): Promise<ResetRecord[]> {
  try {
    const response = await fetch(RESET_RADAR_CURRENT_URL, {
      headers: { accept: "application/json" }
    });
    if (!response.ok) return [];
    return parseResetHistory(await response.json());
  } catch {
    return [];
  }
}
