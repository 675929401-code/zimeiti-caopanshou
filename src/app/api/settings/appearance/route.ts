import { NextResponse } from "next/server";

import { readPublicPlatformAppearance } from "@/lib/server/platform-appearance";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const NO_STORE_HEADERS = {
  "Cache-Control": "no-store, max-age=0, must-revalidate",
  Pragma: "no-cache",
  Expires: "0",
} as const;

/**
 * Minimal public theme bootstrap. It intentionally does not depend on brand
 * revision tables, asset storage, authentication, or any internal setting.
 */
export async function GET() {
  const appearance = await readPublicPlatformAppearance();
  return NextResponse.json(appearance, { headers: NO_STORE_HEADERS });
}
