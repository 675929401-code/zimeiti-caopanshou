import { createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authorizeCurrentApiUser } from "@/lib/current-api-user";
import { getTokenFromHeaders } from "@/lib/auth";
import { getSupabaseClient } from "@/storage/database/supabase-client";
import { storageManager } from "@/storage/object";
import { COVER_COMPOSITION_VERSION, coverCompositionFont, renderCoverComposition } from "@/lib/cover-composition-server";
import { POST as persistImage } from "@/app/api/image-workbench/persist/route";

export const runtime = "nodejs";
const inputSchema = z.object({
  sourceAssetId: z.string().uuid(),
  plan: z.object({
    title: z.string().min(1).max(80).refine((value) => Boolean(value.trim()) && !/[\x00-\x08\x0b-\x1f]/u.test(value)),
    subtitle: z.string().max(120).refine((value) => !/[\x00-\x08\x0b-\x1f]/u.test(value)),
    aspectRatio: z.enum(["16:9", "9:16", "4:3", "3:4"]),
    layoutTemplateId: z.string().regex(/^gaoding-[a-z0-9-]{1,48}$/u),
    animationStyleId: z.enum(["pet-3d", "pixar-3d", "clay-soft", "storybook", "anime-soft", "cinematic-real", "photo-real"]),
    coverModeId: z.enum(["cartoon", "funny-cartoon"]).optional(),
    materialSourceId: z.enum(["text", "template", "upload"]).optional(),
    subjectModeId: z.enum(["semantic", "product"]).optional(),
  }).strict(),
  authoring: z.object({ briefText: z.string().max(20000), prompt: z.string().max(50000) }).strict().optional(),
}).strict();

export async function GET() {
  const history = await getSupabaseClient().from("cover_generation_history").select("asset_id").limit(0);
  return NextResponse.json({ ready: Boolean(coverCompositionFont()) && !history.error, version: COVER_COMPOSITION_VERSION }, { headers: { "Cache-Control": "no-store" } });
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
  if (!coverCompositionFont()) return NextResponse.json({ error: "封面字体尚未就绪", code: "COVER_COMPOSITION_FONT_NOT_READY" }, { status: 503 });
  const { sourceAssetId, plan } = parsed.data;
  const db = getSupabaseClient();
  const file = await db.from("user_files").select("id,storage_key,storage_provider,file_size,content_type")
    .eq("id", sourceAssetId).eq("user_id", user.userId).eq("file_category", "image").maybeSingle();
  if (file.error || !file.data || file.data.storage_provider !== "tencent_cos" || !String(file.data.content_type).startsWith("image/")) {
    return NextResponse.json({ error: "底图不存在或不属于当前账号" }, { status: 404 });
  }
  const maximumBytes = 25 * 1024 * 1024;
  const expectedBytes = Number(file.data.file_size);
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes <= 0 || expectedBytes > maximumBytes) return NextResponse.json({ error: "底图大小不符合排版要求" }, { status: 413 });
  try {
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
      : { url: `data:image/png;base64,${rendered.bytes.toString("base64")}` }), index: 1, clientTraceId: traceId });
    const persistedResponse = await persistImage(new NextRequest(new URL("/api/image-workbench/persist", request.url), {
      method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(body)) }, body,
    }));
    const persisted = await persistedResponse.json();
    if (!persistedResponse.ok || persisted.persisted !== true) return NextResponse.json({ error: "封面排版已完成，保存尚未确认，可重试保存文字", code: "COVER_COMPOSITION_PERSIST_PENDING" }, { status: 502 });
    const history = await db.rpc("record_cover_composition", { p_user_id: user.userId, p_asset_id: persisted.assetId,
      p_background_asset_id: sourceAssetId, p_history_record_id: persisted.historyRecordId,
      p_plan: parsed.data.authoring ? { ...plan, _authoring: parsed.data.authoring } : plan,
      p_output_width: rendered.width, p_output_height: rendered.height, p_source_width: rendered.sourceWidth, p_source_height: rendered.sourceHeight });
    const savedHistory = Array.isArray(history.data) ? history.data[0] : history.data;
    if (history.error || !savedHistory?.asset_id) return NextResponse.json({ error: "封面图片已保存，编辑历史尚未确认，可重试保存文字", code: "COVER_HISTORY_PERSIST_PENDING" }, { status: 502 });
    return NextResponse.json({ ...persisted, outputKind: "cover-composition", sourceAssetId, renderedText: rendered.renderedText,
      compositionProfile: rendered.compositionProfile,
      width: rendered.width, height: rendered.height, sourceWidth: rendered.sourceWidth, sourceHeight: rendered.sourceHeight,
      nativeUpscaleApplied: false, renderFingerprint: fingerprint, cloudStored: true, historyVisible: !savedHistory.hidden_at,
      taskNo: savedHistory.task_no, createdAt: savedHistory.created_at }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "封面排版暂未完成，可重试保存文字", code: "COVER_COMPOSITION_FAILED" }, { status: 502 });
  }
}
