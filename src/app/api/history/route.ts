import { NextResponse } from "next/server";

import { readHistory } from "@/lib/kv";

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  try {
    return NextResponse.json({ history: await readHistory(50) });
  } catch {
    return NextResponse.json({ history: [] }, { status: 200 });
  }
}
