import { NextRequest, NextResponse } from "next/server";
import { authorizeAdminCapability } from "@/lib/server/admin-governance-authority";
import {
  readUnifiedMessagingStatus,
  UnifiedMessagingStatusError,
  type UnifiedMessagingDatabaseClient,
} from "@/lib/unified-messaging-control-plane";
import { getSupabaseAdminClient } from "@/storage/database/supabase-client";

const PRIVATE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0",
  Vary: "Authorization, Cookie",
};

// GET only: this endpoint reports the new control plane and its explicit
// integration gaps. It does not enqueue, retry, migrate, or mutate messages.
export async function GET(request: NextRequest) {
  const authorization = await authorizeAdminCapability(request, "announcements.manage", {
    operation: "unified_messaging_status_read",
  });
  if (!authorization.ok) {
    for (const [key, value] of Object.entries(PRIVATE_HEADERS)) authorization.response.headers.set(key, value);
    return authorization.response;
  }
  try {
    const status = await readUnifiedMessagingStatus(
      getSupabaseAdminClient() as unknown as UnifiedMessagingDatabaseClient,
    );
    return NextResponse.json(
      { success: true, ...status },
      { headers: PRIVATE_HEADERS },
    );
  } catch (error) {
    if (error instanceof UnifiedMessagingStatusError) {
      return NextResponse.json(
        { success: false, error: error.message, code: error.code },
        { status: 503, headers: PRIVATE_HEADERS },
      );
    }
    console.error("[UnifiedMessagingStatus] read failed");
    return NextResponse.json(
      {
        success: false,
        error: "统一消息控制平面状态暂不可用",
        code: "UNIFIED_MESSAGING_STATUS_UNAVAILABLE",
      },
      { status: 503, headers: PRIVATE_HEADERS },
    );
  }
}
