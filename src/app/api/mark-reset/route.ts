import { NextResponse } from "next/server";

import { recordReset } from "@/lib/kv";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<NextResponse> {
  const secret = process.env.MARK_SECRET;
  const key = new URL(request.url).searchParams.get("key");

  if (!secret || key !== secret) {
    return NextResponse.json({ ok: false, error: "Unauthorized." }, { status: 401 });
  }

  try {
    const record = await recordReset();
    return NextResponse.json({ ok: true, record });
  } catch {
    return NextResponse.json({ ok: false, error: "Could not record reset." }, { status: 500 });
  }
}
