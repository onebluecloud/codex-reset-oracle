import { NextResponse } from "next/server";

import { collectSnapshot } from "@/lib/snapshot";
import type { Snapshot } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse<Snapshot>> {
  try {
    return NextResponse.json(await collectSnapshot());
  } catch {
    return NextResponse.json(
      {
        forecast: {
          status: "no-data",
          chance: 0,
          window: "No fresh data",
          summary: "Snapshot generation failed unexpectedly.",
          topSignals: [],
          generatedAt: new Date().toISOString()
        },
        signals: [],
        collectors: []
      },
      { status: 200 }
    );
  }
}
