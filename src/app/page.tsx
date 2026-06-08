import { ForecastDashboard } from "@/components/ForecastDashboard";
import type { HistoryEntry } from "@/lib/kv";
import { readHistory, readLatestSnapshot } from "@/lib/kv";
import { refreshAndStore } from "@/lib/snapshot";
import type { Snapshot } from "@/lib/types";

export const dynamic = "force-dynamic";

const EMPTY_SNAPSHOT: Snapshot = {
  forecast: {
    status: "no-data",
    chance: 0,
    window: "No fresh data",
    summary: "Refresh to collect public Codex reset signals.",
    topSignals: [],
    generatedAt: ""
  },
  signals: [],
  collectors: []
};

export default async function HomePage() {
  let snapshot: Snapshot = EMPTY_SNAPSHOT;
  let history: HistoryEntry[] = [];

  try {
    // Read the last stored snapshot so the page shows a number immediately;
    // if nothing is stored yet, collect once and store it.
    snapshot = (await readLatestSnapshot()) ?? (await refreshAndStore());
    history = await readHistory(50);
  } catch {
    // KV unavailable — render the empty state; the client Refresh button still works.
  }

  return <ForecastDashboard initialSnapshot={snapshot} initialHistory={history} />;
}
