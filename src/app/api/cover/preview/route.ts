import { NextRequest } from "next/server";
import { z } from "zod";
import { authorizeCurrentApiUser } from "@/lib/current-api-user";
import { coverCompositionValidationError, coverSourcePlanBindingError, type CoverCompositionPlan } from "@/lib/cover-composition";
import { projectCoverCompositionPlan } from "@/lib/cover-durable-attempt";
import { renderCoverComposition } from "@/lib/cover-composition-server";
import { getSupabaseClient } from "@/storage/database/supabase-client";
import { storageManager } from "@/storage/object";
import { readCoverRequestJson, CoverRequestBodyError } from "@/lib/server/cover-request-body";

export const runtime = "nodejs";
const input = z.object({ sourceAssetId: z.string().uuid(), plan: z.custom<CoverCompositionPlan>(value => Boolean(value)
  && typeof value === "object" && !Array.isArray(value) && !coverCompositionValidationError(value as CoverCompositionPlan)) }).strict();
const json = (error: string, status: number) => Response.json({ error }, { status, headers: { "Cache-Control": "private, no-store" } });

/** Same glyph renderer as the exported PNG. No generation, wallet, upload,
 * history insertion or mutation occurs in this preview endpoint. */
export async function POST(request: NextRequest) {
  const auth = await authorizeCurrentApiUser(request);
  if (!auth.ok) return auth.response;
  let value: z.infer<typeof input>;
  try { value = input.parse(await readCoverRequestJson(request, 50_000)); }
  catch (error) { return json(error instanceof CoverRequestBodyError ? error.message : "请填写有效标题、位置和封面尺寸", error instanceof CoverRequestBodyError ? error.status : 422); }
  try {
    const result = await getSupabaseClient().from("user_files")
      .select("id,user_id,storage_key,storage_provider,file_category,file_size,content_type,meta")
      .eq("id", value.sourceAssetId).eq("user_id", auth.user.userId).eq("file_category", "image").eq("storage_provider", "tencent_cos").maybeSingle();
    if (result.error) return json("图片归属暂时无法确认", 503);
    if (!result.data) return json("图片不存在或不属于当前账号", 404);
    const bindingError = coverSourcePlanBindingError(result.data.meta, value.plan);
    if (bindingError) return json(bindingError, 409);
    if (Number(result.data.file_size) > 25 * 1024 * 1024 || !/^image\/(?:png|jpeg|webp)$/u.test(String(result.data.content_type))) return json("图片格式或大小不适合封面排版", 422);
    const bytes = await storageManager.readBounded(result.data.storage_key, 25 * 1024 * 1024, 20_000, "tencent_cos");
    if (bytes.length !== Number(result.data.file_size)) return json("图片读取不完整，请稍后重试", 502);
    const rendered = await renderCoverComposition(bytes, projectCoverCompositionPlan(value.plan));
    return new Response(new Uint8Array(rendered.bytes), { headers: {
      "Content-Type": "image/png", "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff",
      "X-Cover-Width": String(rendered.width), "X-Cover-Height": String(rendered.height),
    } });
  } catch (error) {
    const code = error instanceof Error ? error.message : "";
    return json(code === "COVER_BACKGROUND_INSUFFICIENT_PIXELS" ? "原图像素不足，请更换图片或选择其他尺寸"
      : code === "COVER_ORIGINAL_TEXT_DOES_NOT_FIT" ? "安全文字区放不下当前标题，请精简标题或副标题；原图未改动"
      : code === "COVER_ORIGINAL_SOURCE_MISMATCH" ? "原图尺寸与确认方案不一致，请重新确认排版"
      : code === "COVER_TITLE_OUT_OF_BOUNDS" ? "标题超出画面，请缩小字号或调整位置" : "封面预览暂时无法更新，请稍后重试", 422);
  }
}
