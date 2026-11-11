import { NextResponse } from "next/server";
import { readPublicCoverStyles } from "@/lib/server/cover-style-store";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET() {
  try { return NextResponse.json(await readPublicCoverStyles(), { headers: { "Cache-Control": "no-store, max-age=0" } }); }
  catch { return NextResponse.json({ error: "封面风格暂不可读取", code: "COVER_STYLE_READ_UNAVAILABLE" }, { status: 503, headers: { "Cache-Control": "no-store" } }); }
}
