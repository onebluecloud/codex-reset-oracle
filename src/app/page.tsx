import { ForecastDashboard } from "@/components/ForecastDashboard";
import type { Snapshot } from "@/lib/types";

const initialSnapshot: Snapshot = {
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

export default function HomePage() {
  return <ForecastDashboard initialSnapshot={initialSnapshot} />;
}
