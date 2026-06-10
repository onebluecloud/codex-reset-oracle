import { NextResponse } from "next/server";

import { readPredlog } from "@/lib/kv";

export const dynamic = "force-dynamic";

/** Real probability history (hourly predlog points) for the axis curve. */
export async function GET(): Promise<NextResponse> {
  try {
    return NextResponse.json({ points: await readPredlog(120) });
  } catch {
    return NextResponse.json({ points: [] }, { status: 200 });
  }
}
