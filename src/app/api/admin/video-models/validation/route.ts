import { NextResponse } from "next/server";
import { getTokenFromHeaders } from "@/lib/auth";
import { authorizeAdminToken } from "@/lib/admin-auth";
import { getSupabaseAdminClient } from "@/storage/database/supabase-client";
import { loadVideoAdminValidationContext, toVideoAdminValidationDto, VideoAdminValidationError } from "@/lib/video-admin-validation";
import { authorizeVideoPublicationProof, readVideoValidationAttempt } from "@/lib/video-model-publication";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

/** Read the configured application database, including hidden/new models; no fallback, mutation, or provider probe. */
export async function GET(request: Request) {
  try {
    const db = getSupabaseAdminClient();
    const authorization = await authorizeAdminToken(getTokenFromHeaders(request.headers));
    if (!authorization.ok) return NextResponse.json({ error: authorization.error, code: authorization.code, task_submitted: false }, { status: authorization.status, headers: { "Cache-Control": "no-store" } });
    const params = new URL(request.url).searchParams;
    const modelId = params.get("modelId");
    const context = await loadVideoAdminValidationContext(db, modelId, authorization.user.id);
    const restoring = params.has("validationKey") || params.has("configurationHash") || params.has("healthEpoch");
    const proof = restoring
      ? { validationKey: params.get("validationKey") || "", configurationHash: params.get("configurationHash") || "", healthEpoch: params.get("healthEpoch") || "", clientRequestId: params.get("validationKey") || "" }
      : { validationKey: context.validationKey, configurationHash: context.configurationHash, healthEpoch: context.healthEpoch, clientRequestId: context.validationKey };
    if (restoring) authorizeVideoPublicationProof(context, proof, authorization);
    const attempt = await readVideoValidationAttempt(db, context, proof);
    return NextResponse.json({ success: true, ...toVideoAdminValidationDto(context), ...proof, ...attempt }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const known = error instanceof VideoAdminValidationError;
    return NextResponse.json({ error: known ? error.message : "模型验证预检暂不可用", code: known ? error.code : "VIDEO_VALIDATION_PREFLIGHT_UNAVAILABLE", task_submitted: false }, { status: known ? error.status : 503, headers: { "Cache-Control": "no-store" } });
  }
}
