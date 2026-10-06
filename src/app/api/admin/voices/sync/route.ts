import { NextResponse } from "next/server";
import { withAdminAuth } from "@/lib/api-middleware";

/**
 * Legacy endpoint retained only as a fail-closed compatibility response.
 *
 * The previous implementation rewrote a generated source catalog at runtime.
 * Immutable releases must never mutate their own source tree. The
 * supported synchronization endpoint writes the catalog into the persistent
 * voice database instead.
 */
export async function POST(request: Request) {
  return withAdminAuth(request, async () => NextResponse.json({
    success: false,
    code: "LEGACY_SOURCE_MUTATION_DISABLED",
    message: "该旧同步入口已停用，请使用 /api/admin/voice-studio/voices/sync。",
    replacement: "/api/admin/voice-studio/voices/sync",
  }, { status: 410 }));
}

export async function GET(request: Request) {
  return POST(request);
}
