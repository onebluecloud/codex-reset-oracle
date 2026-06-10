import { NextResponse } from "next/server";

import { readCalibration } from "@/lib/kv";

export const dynamic = "force-dynamic";

/**
 * Reliability diagram: resolved predictions bucketed by predicted chance, with the
 * actual fleet-wide reset rate in each bucket — "we said X%, it reset Y% of the time".
 * Empty until enough predictions have aged past their 24h horizon.
 */
export async function GET(): Promise<NextResponse> {
  try {
    return NextResponse.json(await readCalibration());
  } catch {
    return NextResponse.json({ buckets: [], resolved: 0, variants: null }, { status: 200 });
  }
}
