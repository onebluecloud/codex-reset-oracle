import { NextResponse } from "next/server";

import { refreshAndStore } from "@/lib/snapshot";
import { maybeTrainModel } from "@/lib/train";

export const dynamic = "force-dynamic";
// Apify runs the X scraper synchronously, which can take tens of seconds.
// Vercel's default function timeout is 10s; lift it to the Hobby ceiling.
export const maxDuration = 60;

export async function GET(): Promise<NextResponse> {
  try {
    const snapshot = await refreshAndStore();
    // Daily self-learning pass — a date lock makes all but the first call of
    // the day a single cheap no-op; gates inside keep it inert until enough
    // independent reset events have accrued. Never throws.
    const training = await maybeTrainModel();
    return NextResponse.json({
      ok: true,
      chance: snapshot.forecast.chance,
      status: snapshot.forecast.status,
      trained: training.trained
    });
  } catch {
    return NextResponse.json({ ok: false }, { status: 200 });
  }
}
