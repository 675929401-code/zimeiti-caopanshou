import { NextResponse } from "next/server";
import { getTokenFromHeaders } from "@/lib/auth";
import { authorizeAdminToken } from "@/lib/admin-auth";
import { getSupabaseAdminClient } from "@/storage/database/supabase-client";
import { ImageAdminValidationError, loadImageAdminValidationContext, readImageValidationAttempt, toImageAdminValidationDto } from "@/lib/image-admin-validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

/** Staged target: src/app/api/admin/cover-models/validation/route.ts. No mutation/provider probe. */
export async function GET(request: Request) {
  try {
    const authorization = await authorizeAdminToken(getTokenFromHeaders(request.headers));
    if (!authorization.ok) return NextResponse.json({ error: authorization.error, code: authorization.code, taskSubmitted: false }, { status: authorization.status, headers: { "Cache-Control": "no-store" } });
    const db = getSupabaseAdminClient(), params = new URL(request.url).searchParams;
    const context = await loadImageAdminValidationContext(db, params.get("modelId"), authorization, params.get("retestReason") || "");
    const attempt = await readImageValidationAttempt(db, context);
    return NextResponse.json({ success: true, ...toImageAdminValidationDto(context), ...attempt }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const known = error instanceof ImageAdminValidationError;
    return NextResponse.json({ error: known ? error.message : "生图验证预检暂不可用", code: known ? error.code : "IMAGE_VALIDATION_PREFLIGHT_UNAVAILABLE", taskSubmitted: false }, { status: known ? error.status : 503, headers: { "Cache-Control": "no-store" } });
  }
}
