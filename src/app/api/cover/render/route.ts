import { createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authorizeCurrentApiUser } from "@/lib/current-api-user";
import { getTokenFromHeaders } from "@/lib/auth";
import { getSupabaseClient } from "@/storage/database/supabase-client";
import { storageManager } from "@/storage/object";
import { COVER_COMPOSITION_VERSION, coverCompositionFont, renderCoverComposition } from "@/lib/cover-composition-server";
import { POST as persistImage } from "@/app/api/image-workbench/persist/route";
import { COVER_ORIGINAL_LAYOUT_VERSION, COVER_GENERATED_OVERLAY_LAYOUT_VERSION, COVER_TEXT_RENDERING_VERSION, coverCompositionValidationError, coverCompositionTextReceipt, coverSourcePlanBindingError, coverTextRendering, coverV2ValidationError } from "@/lib/cover-composition";

export const runtime = "nodejs";
const inputSchema = z.object({
  sourceAssetId: z.string().uuid(),
  plan: z.object({
    title: z.string().min(1).max(80).refine((value) => Boolean(value.trim()) && !/[\x00-\x08\x0b-\x1f]/u.test(value)),
    subtitle: z.string().max(120).refine((value) => !/[\x00-\x08\x0b-\x1f]/u.test(value)),
    aspectRatio: z.enum(["16:9", "9:16", "4:3", "3:4"]),
    layoutTemplateId: z.string().regex(/^gaoding-[a-z0-9-]{1,48}$/u),
    animationStyleId: z.enum(["pet-3d", "pixar-3d", "clay-soft", "storybook", "anime-soft", "cinematic-real", "photo-real"]),
    coverModeId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/u).optional(),
    materialSourceId: z.enum(["text", "template", "upload"]).optional(),
    subjectModeId: z.enum(["semantic", "product"]).optional(),
    planVersion: z.literal(2).optional(),
    textRendering: z.object({ mode: z.enum(["native", "overlay"]), version: z.literal(COVER_TEXT_RENDERING_VERSION) }).strict().optional(),
    originalLayout: z.object({ version: z.literal(COVER_ORIGINAL_LAYOUT_VERSION), sourceWidth: z.number().int().min(256), sourceHeight: z.number().int().min(256),
      structure: z.enum(["single", "relationship", "comparison", "list"]), focus: z.enum(["expression", "action", "object"]) }).strict().optional(),
    generatedOverlayLayout: z.object({ version: z.literal(COVER_GENERATED_OVERLAY_LAYOUT_VERSION), placement: z.literal("top"), canvasColor: z.literal("#F5F5F2") }).strict().optional(),
    outputSpec: z.object({
      aspectRatio: z.enum(["16:9", "9:16", "4:3", "3:4"]),
      width: z.number().int().positive(), height: z.number().int().positive(), format: z.literal("png"),
      fit: z.enum(["cover", "contain"]).optional(),
    }).strict().optional(),
    titleStyle: z.object({
      x: z.number().finite().optional(), y: z.number().finite().optional(), width: z.number().finite().optional(),
      scale: z.number().finite().optional(), color: z.string().regex(/^#[0-9a-f]{6}$/iu).optional(),
      colorMode: z.enum(["palette", "single"]).optional(),
    }).strict().optional(),
  }).strict().refine(plan => !coverV2ValidationError(plan) && (plan.planVersion !== 2 || !coverCompositionValidationError(plan)), "新版封面尺寸或标题样式无效"),
  authoring: z.object({ briefText: z.string().max(20000), prompt: z.string().max(50000) }).strict().optional(),
}).strict();

export async function GET(request?: Request) {
  const history = await getSupabaseClient().from("cover_generation_history").select("asset_id").limit(0);
  const native = request && new URL(request.url).searchParams.get("textMode") === "native";
  return NextResponse.json({ ready: Boolean(native || coverCompositionFont()) && !history.error, version: COVER_COMPOSITION_VERSION }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: NextRequest) {
  const token = getTokenFromHeaders(request.headers);
  const authorization = await authorizeCurrentApiUser(request);
  if (!authorization.ok) return authorization.response;
  const user = authorization.user;
  const maximumInputBytes = 262_144;
  if (Number(request.headers.get("content-length")) > maximumInputBytes) return NextResponse.json({ error: "封面文字参数过大" }, { status: 413 });
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    if (reader) for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > maximumInputBytes) {
        await reader.cancel();
        return NextResponse.json({ error: "封面文字参数过大" }, { status: 413 });
      }
      chunks.push(chunk.value);
    }
  } catch { return NextResponse.json({ error: "封面文字参数读取失败" }, { status: 400 }); }
  finally { reader?.releaseLock(); }
  let body: unknown;
  try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { body = null; }
  const parsed = inputSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "封面文字或版式参数无效" }, { status: 400 });
  const { sourceAssetId, plan } = parsed.data;
  if (coverTextRendering(plan).mode !== "native" && !coverCompositionFont()) return NextResponse.json({ error: "封面字体尚未就绪", code: "COVER_COMPOSITION_FONT_NOT_READY" }, { status: 503 });
  const db = getSupabaseClient();
  const file = await db.from("user_files").select("id,storage_key,storage_provider,file_size,content_type,meta")
    .eq("id", sourceAssetId).eq("user_id", user.userId).eq("file_category", "image").maybeSingle();
  if (file.error || !file.data || file.data.storage_provider !== "tencent_cos" || !String(file.data.content_type).startsWith("image/")) {
    return NextResponse.json({ error: "底图不存在或不属于当前账号" }, { status: 404 });
  }
  const bindingError = coverSourcePlanBindingError(file.data.meta, plan);
  if (bindingError) return NextResponse.json({ error: bindingError, code: "COVER_NATIVE_PLAN_IMMUTABLE" }, { status: 409 });
  const maximumBytes = 25 * 1024 * 1024;
  const expectedBytes = Number(file.data.file_size);
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes <= 0 || expectedBytes > maximumBytes) return NextResponse.json({ error: "底图大小不符合排版要求" }, { status: 413 });
  try {
    let authoring = parsed.data.authoring;
    // Public tasks intentionally redact the compiled prompt. A free edit must
    // inherit its private provenance from the earliest owned history for this
    // exact background, never invent a browser placeholder or expose it again.
    // Explicit nonempty authoring, originalLayout and native retain their path.
    if (!plan.originalLayout && coverTextRendering(plan).mode === "overlay" && !authoring?.prompt.trim()) {
      const previous = await db.from("cover_generation_history").select("user_id,background_asset_id,authoring_context")
        .eq("user_id", user.userId).eq("background_asset_id", sourceAssetId)
        .order("created_at", { ascending: true }).order("asset_id", { ascending: true }).limit(1).maybeSingle();
      const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
      const history = object(previous.data), context = object(history.authoring_context);
      const generatedSource = object(object(file.data.meta).coverGeneratedExport).schema === "cover_generated_export/1";
      const prompt = context.prompt;
      if (previous.error || previous.data && (history.user_id !== user.userId || history.background_asset_id !== sourceAssetId)
        || prompt !== undefined && (typeof prompt !== "string" || prompt.length > 50_000)
        || context.briefText !== undefined && (typeof context.briefText !== "string" || context.briefText.length > 20_000)
        || generatedSource && (typeof prompt !== "string" || !prompt.trim())) {
        return NextResponse.json({ error: "原底图的制作来源暂时无法核对，请稍后重试免费排版；不会重新生图", code: "COVER_AUTHORING_SOURCE_UNKNOWN" }, { status: 503 });
      }
      if (typeof prompt === "string" && prompt.trim()) authoring = { briefText: authoring?.briefText || String(context.briefText || ""), prompt };
    }
    const source = await storageManager.read(file.data.storage_key, "tencent_cos");
    if (source.length !== expectedBytes) return NextResponse.json({ error: "底图读取不完整，请稍后重试" }, { status: 502 });
    const rendered = await renderCoverComposition(source, plan);
    if (rendered.bytes.length > maximumBytes) return NextResponse.json({ error: "排版后的封面超过保存上限" }, { status: 413 });
    const fingerprint = createHash("sha256").update(JSON.stringify([COVER_COMPOSITION_VERSION, user.userId, sourceAssetId, plan, createHash("sha256").update(source).digest("hex")])).digest("hex");
    // Object storage adds a date directory; the render fingerprint remains stable across days.
    const traceId = `cover_render_${fingerprint}`;
    const previousAsset = await db.from("user_files").select("id,storage_key").eq("user_id", user.userId)
      .eq("storage_provider", "tencent_cos").eq("file_category", "image").eq("source", "image-workbench")
      .eq("meta->>clientTraceId", traceId).order("created_at", { ascending: true }).limit(1).maybeSingle();
    if (previousAsset.error) return NextResponse.json({ error: "原封面保存记录暂时无法确认，请稍后重试", code: "COVER_HISTORY_LOOKUP_PENDING" }, { status: 503 });
    const body = JSON.stringify({ ...(previousAsset.data ? { assetId: previousAsset.data.id, storageKey: previousAsset.data.storage_key }
      : { url: `data:image/png;base64,${rendered.bytes.toString("base64")}` }), intent: "user_asset_export", index: 1, clientTraceId: traceId });
    const persistedResponse = await persistImage(new NextRequest(new URL("/api/image-workbench/persist", request.url), {
      method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(body)) }, body,
    }));
    const persisted = await persistedResponse.json();
    if (!persistedResponse.ok || persisted.persisted !== true) return NextResponse.json({ error: "封面排版已完成，保存尚未确认，可重试保存文字", code: "COVER_COMPOSITION_PERSIST_PENDING" }, { status: 502 });
    const history = await db.rpc("record_cover_composition", { p_user_id: user.userId, p_asset_id: persisted.assetId,
      p_background_asset_id: sourceAssetId, p_history_record_id: persisted.historyRecordId,
      p_plan: authoring ? { ...plan, _authoring: authoring } : plan,
      p_output_width: rendered.width, p_output_height: rendered.height, p_source_width: rendered.sourceWidth, p_source_height: rendered.sourceHeight });
    const savedHistory = Array.isArray(history.data) ? history.data[0] : history.data;
    if (history.error || !savedHistory?.asset_id) return NextResponse.json({ error: "封面图片已保存，编辑历史尚未确认，可重试保存文字", code: "COVER_HISTORY_PERSIST_PENDING" }, { status: 502 });
    return NextResponse.json({ ...persisted, outputKind: "cover-composition", sourceAssetId,
      ...(coverTextRendering(plan).mode === "native" ? coverCompositionTextReceipt(plan) : { renderedText: rendered.renderedText }),
      ...(plan.planVersion === 2 ? { planVersion: 2, outputSpec: plan.outputSpec, ...(plan.titleStyle ? { titleStyle: plan.titleStyle } : {}) } : {}),
      ...(plan.originalLayout ? { originalLayout: plan.originalLayout } : {}),
      ...(plan.generatedOverlayLayout ? { generatedOverlayLayout: plan.generatedOverlayLayout, layoutGeometry: "layoutGeometry" in rendered ? rendered.layoutGeometry : undefined,
        textGeometry: "textGeometry" in rendered ? rendered.textGeometry : undefined } : {}),
      compositionProfile: rendered.compositionProfile,
      width: rendered.width, height: rendered.height, sourceWidth: rendered.sourceWidth, sourceHeight: rendered.sourceHeight,
      nativeUpscaleApplied: false, renderFingerprint: fingerprint, cloudStored: true, historyVisible: !savedHistory.hidden_at,
      taskNo: savedHistory.task_no, createdAt: savedHistory.created_at }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const code = error instanceof Error ? error.message : "";
    if (code === "COVER_BACKGROUND_INSUFFICIENT_PIXELS") return NextResponse.json({ error: "原图像素不足以导出所选尺寸，请更换图片或选择其他尺寸", code }, { status: 422 });
    if (code === "COVER_TITLE_OUT_OF_BOUNDS") return NextResponse.json({ error: "标题超出封面范围，请缩小标题或调整位置", code }, { status: 422 });
    if (code === "COVER_GENERATED_TEXT_DOES_NOT_FIT") return NextResponse.json({ error: "自动留白区放不下完整标题，请精简标题或副标题后再保存；底图未改动", code }, { status: 422 });
    if (code === "COVER_ORIGINAL_TEXT_DOES_NOT_FIT") return NextResponse.json({ error: "完整原图的安全文字区放不下当前标题，请精简标题或副标题后再保存；原图未改动", code }, { status: 422 });
    if (code === "COVER_ORIGINAL_SOURCE_MISMATCH") return NextResponse.json({ error: "原图尺寸与确认方案不一致，请重新确认排版；原图未改动", code }, { status: 409 });
    return NextResponse.json({ error: "封面排版暂未完成，可重试保存文字", code: "COVER_COMPOSITION_FAILED" }, { status: 502 });
  }
}
