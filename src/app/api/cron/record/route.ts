import { NextResponse } from "next/server";

import { refreshAndStore } from "@/lib/snapshot";

export const dynamic = "force-dynamic";

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
