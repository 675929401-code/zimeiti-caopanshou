import { NextResponse } from "next/server";
import { authorizeAdminToken } from "@/lib/admin-auth";
import { getTokenFromHeaders } from "@/lib/auth";
import { getSupabaseAdminClient } from "@/storage/database/supabase-client";
import { ImageAdminValidationError, type ImageValidationProof } from "@/lib/image-admin-validation";
import { publishValidatedImageModel } from "@/lib/image-model-publication";
import { assertPublishedModelPoolEntry } from "@/lib/server/platform-configuration-compatibility";
import { PlatformConfigurationError } from "@/lib/server/platform-configuration-admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Staged target: /api/admin/cover-models/validation/publish. Never generates. */
export async function POST(request: Request) {
  try {
    const authorization = await authorizeAdminToken(getTokenFromHeaders(request.headers));
    if (!authorization.ok) return NextResponse.json({ error: authorization.error, code: authorization.code }, { status: authorization.status });
    const body = await request.json() as { modelId?: string; imageRecordId?: string; proof?: ImageValidationProof; confirmation?: unknown };
    await assertPublishedModelPoolEntry("cover_models", String(body.modelId || ""));
    const result = await publishValidatedImageModel({ db: getSupabaseAdminClient(), authorization,
      modelId: String(body.modelId || ""), imageRecordId: String(body.imageRecordId || ""),
      proof: body.proof as ImageValidationProof, confirmation: body.confirmation });
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof PlatformConfigurationError) {
      return NextResponse.json({ error: error.message, code: error.code, published: false }, { status: 409, headers: { "Cache-Control": "no-store" } });
    }
    const known = error instanceof ImageAdminValidationError;
    return NextResponse.json({ error: known ? error.message : "生图模型发布暂未确认，请保留原证明查询", code: known ? error.code : "IMAGE_PUBLICATION_UNKNOWN" },
      { status: known ? error.status : 503, headers: { "Cache-Control": "no-store" } });
  }
}
