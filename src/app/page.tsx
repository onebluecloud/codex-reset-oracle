import { ForecastDashboard } from "@/components/ForecastDashboard";
import type { HistoryEntry, PredlogPoint } from "@/lib/kv";
import {
  readArchivedResetDetails,
  readHistory,
  readLatestSnapshot,
  readPredlog
} from "@/lib/kv";
import { refreshAndStore } from "@/lib/snapshot";
import type { AxisEvent, ResetDetail, Snapshot } from "@/lib/types";

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

/** A short English caption for an archived fleet-wide reset on the time axis. */
function eventLabel(detail: ResetDetail): string {
  if (detail.kind === "incident") return "Incident reset";
  if (detail.kind === "milestone") {
    const m = detail.title.match(/(\d+)\s*万/);
    return m ? `Milestone ${Number(m[1]) / 100}M` : "Milestone reset";
  }
  if (detail.kind === "celebration") return "Celebration reset";
  return "Fleet-wide reset";
}

export default async function HomePage() {
  let snapshot: Snapshot = EMPTY_SNAPSHOT;
  let history: HistoryEntry[] = [];
  let trend: PredlogPoint[] = [];
  let events: AxisEvent[] = [];

  try {
    // Read the last stored snapshot so the page shows a number immediately;
    // if nothing is stored yet, collect once and store it.
    snapshot = (await readLatestSnapshot()) ?? (await refreshAndStore());
    history = await readHistory(50);
    // Real probability history (each point a logged hourly forecast) draws the
    // axis curve; archived fleet-wide resets become the event markers on it.
    trend = await readPredlog(120);
    const details = await readArchivedResetDetails();
    events = details.map((detail) => ({ at: detail.at, label: eventLabel(detail), kind: detail.kind }));
  } catch {
    // KV unavailable — render the empty state; the client Refresh button still works.
  }

  return (
    <ForecastDashboard
      initialSnapshot={snapshot}
      initialHistory={history}
      initialTrend={trend}
      initialEvents={events}
    />
  );
}
