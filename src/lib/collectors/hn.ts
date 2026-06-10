import { normalizeHnHit } from "../normalize";
import type { AuxCollectorStatus, AuxSignal } from "../types";

export type AuxCollectorResult = {
  status: AuxCollectorStatus;
  signals: AuxSignal[];
};

// Algolia's HN search API: free, no auth, stable for a decade+. Stories AND
// comments — recall is much better with comments included; the keyword gate
// plus the low per-source cap keep the noise contained.
const HN_SEARCH_BASE =
  "https://hn.algolia.com/api/v1/search_by_date?query=codex&tags=(story,comment)&hitsPerPage=50";
const FRESH_WINDOW_HOURS = 72;

function searchUrl(now: Date): string {
  const cutoff = Math.floor(now.getTime() / 1000) - FRESH_WINDOW_HOURS * 3600;
  return `${HN_SEARCH_BASE}&numericFilters=created_at_i>${cutoff}`;
}

export async function collectHnSignals(now: Date = new Date()): Promise<AuxCollectorResult> {
  try {
    const response = await fetch(searchUrl(now), { headers: { accept: "application/json" } });

    if (!response.ok) {
      return {
        status: { source: "hn", ok: false, message: `HN collector failed with HTTP ${response.status}.` },
        signals: []
      };
    }

    const payload: unknown = await response.json();
    const hits =
      payload && typeof payload === "object" && Array.isArray((payload as { hits?: unknown }).hits)
        ? ((payload as { hits: unknown[] }).hits)
        : null;
    if (!hits) {
      return {
        status: { source: "hn", ok: false, message: "HN collector returned an unexpected JSON shape." },
        signals: []
      };
    }

    const signals = hits
      .map((hit) => normalizeHnHit(hit))
      .filter((signal): signal is AuxSignal => Boolean(signal));

    return {
      status: {
        source: "hn",
        ok: true,
        message: `Fetched ${signals.length} HN signals.`,
        fetchedAt: new Date().toISOString()
      },
      signals
    };
  } catch (error) {
    return {
      status: { source: "hn", ok: false, message: `HN collector failed: ${errorMessage(error)}` },
      signals: []
    };
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error.";
}
