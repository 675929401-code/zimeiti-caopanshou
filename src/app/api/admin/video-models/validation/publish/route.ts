import { NextResponse } from "next/server";
import { getTokenFromHeaders } from "@/lib/auth";
import { authorizeAdminToken } from "@/lib/admin-auth";
import { getSupabaseAdminClient } from "@/storage/database/supabase-client";
import { VideoAdminValidationError } from "@/lib/video-admin-validation";
import { publishValidatedVideoModel } from "@/lib/video-model-publication";
import { assertPublishedModelPoolEntry } from "@/lib/server/platform-configuration-compatibility";
import { PlatformConfigurationError } from "@/lib/server/platform-configuration-admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  try {
    const authorization = await authorizeAdminToken(getTokenFromHeaders(request.headers));
    if (!authorization.ok) return NextResponse.json({ success: false, error: authorization.error, code: authorization.code, published: false }, { status: authorization.status });
    const body = await request.json();
    await assertPublishedModelPoolEntry("video_models", String(body.modelId || ""));
    const result = await publishValidatedVideoModel({ db: getSupabaseAdminClient(), authorization,
      modelId: body.modelId, taskId: body.taskId, confirmation: body.confirmation,
      proof: { validationKey: body.validationKey, configurationHash: body.configurationHash, healthEpoch: body.healthEpoch, clientRequestId: body.clientRequestId },
    });
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof PlatformConfigurationError) {
      return NextResponse.json({ success: false, error: error.message, code: error.code, published: false, outcome: "not_published" }, { status: 409, headers: { "Cache-Control": "no-store" } });
    }
    const known = error instanceof VideoAdminValidationError;
    const unknown = !known || error.status >= 500;
    return NextResponse.json({ success: false, error: known ? error.message : "发布结果暂不可确认，请保留原验证证明", code: known ? error.code : "VIDEO_PUBLICATION_UNAVAILABLE", published: unknown ? null : false, outcome: unknown ? "unknown" : "not_published" }, { status: known ? error.status : 503, headers: { "Cache-Control": "no-store" } });
  }
}
