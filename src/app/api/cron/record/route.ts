import { NextResponse } from "next/server";

import { refreshAndStore } from "@/lib/snapshot";

export const dynamic = "force-dynamic";
// Apify runs the X scraper synchronously, which can take tens of seconds.
// Vercel's default function timeout is 10s; lift it to the Hobby ceiling.
export const maxDuration = 60;

export async function GET(): Promise<NextResponse> {
  try {
    const snapshot = await refreshAndStore();
    return NextResponse.json({
      ok: true,
      chance: snapshot.forecast.chance,
      status: snapshot.forecast.status
    });
  } catch {
    return NextResponse.json({ ok: false }, { status: 200 });
  }
}
