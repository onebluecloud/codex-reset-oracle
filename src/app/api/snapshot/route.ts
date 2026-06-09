import { NextResponse } from "next/server";

import { refreshAndStore } from "@/lib/snapshot";
import type { Snapshot } from "@/lib/types";

export const dynamic = "force-dynamic";
// Apify runs the X scraper synchronously, which can take tens of seconds.
// Vercel's default function timeout is 10s; lift it to the Hobby ceiling.
export const maxDuration = 60;

export async function GET(): Promise<NextResponse<Snapshot>> {
  try {
    return NextResponse.json(await refreshAndStore());
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
