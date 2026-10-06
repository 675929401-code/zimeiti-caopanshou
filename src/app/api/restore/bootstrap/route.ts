import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * The legacy browser-downloadable disaster-recovery script is permanently
 * retired. Recovery operations require local operator access and must never
 * expose server addresses, credentials, private-key discovery or environment
 * download logic through the public application.
 */
function disabledResponse() {
  return NextResponse.json(
    { error: "该旧恢复入口已停用", code: "LEGACY_RESTORE_DISABLED" },
    {
      status: 404,
      headers: {
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    },
  );
}

export async function GET() {
  return disabledResponse();
}

export async function POST() {
  return disabledResponse();
}
