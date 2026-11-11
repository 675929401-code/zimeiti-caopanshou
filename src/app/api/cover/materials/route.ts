import { createHash } from "node:crypto";
import sharp from "sharp";
import { NextRequest, NextResponse } from "next/server";
import { authorizeCurrentApiUser } from "@/lib/current-api-user";
import { safeUploadFileName, UploadValidationError, validateUploadBuffer } from "@/lib/file-upload-security";
import { getSupabaseClient } from "@/storage/database/supabase-client";
import { storageManager } from "@/storage/object";

export const runtime = "nodejs";
const MAX_BYTES = 5 * 1024 * 1024;
const ROLES = new Set(["background_canvas", "identity_subject", "style_reference"]);
const json = (body: Record<string, unknown>, status = 200) => NextResponse.json(body, { status, headers: { "Cache-Control": "private, no-store" } });

export async function POST(request: NextRequest) {
  const authorization = await authorizeCurrentApiUser(request);
  if (!authorization.ok) return authorization.response;
  const length = Number(request.headers.get("content-length"));
  if (!Number.isSafeInteger(length) || length <= 0) return json({ error: "缺少有效的请求大小" }, 411);
  if (length > MAX_BYTES + 1024 * 1024) return json({ error: "图片不能超过5MB" }, 413);
  try {
    const form = await request.formData();
    const file = form.get("file");
    const role = String(form.get("role") || "background_canvas");
    if (!ROLES.has(role)) return json({ error: "请选择有效的图片用途" }, 400);
    if (!(file instanceof File) || !file.size) return json({ error: "请添加图片" }, 400);
    if (file.size > MAX_BYTES) return json({ error: "图片不能超过5MB" }, 413);
    const bytes = Buffer.from(await file.arrayBuffer());
    const validated = validateUploadBuffer(bytes, file.type || "application/octet-stream");
    if (!["image/png", "image/jpeg", "image/webp"].includes(validated.contentType)) return json({ error: "图片只支持PNG、JPEG或WebP" }, 415);
    const metadata = await sharp(bytes, { failOn: "error", limitInputPixels: 40_000_000 }).metadata().catch(() => null);
    if (!metadata) return json({ error: "图片无法解码，请更换图片" }, 415);
    const swapped = [5, 6, 7, 8].includes(Number(metadata.orientation) || 1);
    const width = Number(swapped ? metadata.height : metadata.width) || 0;
    const height = Number(swapped ? metadata.width : metadata.height) || 0;
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0
      || width * height > 40_000_000 || Number(metadata.pages || 1) > 1) return json({ error: "请添加可读取的静态图片" }, 415);
    // Metadata alone does not prove pixel data is decodable. Validate fully,
    // then retain the original bytes (including packaging and identity detail).
    try { await sharp(bytes, { failOn: "error", limitInputPixels: 40_000_000 }).toBuffer(); }
    catch { return json({ error: "图片无法完整解码，请更换图片" }, 415); }
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const stored = await storageManager.upload(bytes, safeUploadFileName(validated.extension), validated.contentType, {
      providerType: "tencent_cos", strictProvider: true, requireOwnershipRecord: true,
      category: "image", userId: authorization.user.userId, source: "cover-material", prefix: "cover-materials/",
      publicRead: false, meta: { coverMaterialRole: role, coverMaterialSha256: sha256, coverMaterialRevision: "1" },
    });
    if (stored.provider !== "tencent_cos") throw new Error("COVER_MATERIAL_PROVIDER_MISMATCH");
    const owned = await getSupabaseClient().from("user_files").select("id")
      .eq("user_id", authorization.user.userId).eq("storage_key", stored.key)
      .eq("storage_provider", "tencent_cos").eq("file_category", "image").maybeSingle();
    if (owned.error || !owned.data?.id) throw new Error("COVER_MATERIAL_OWNERSHIP_PENDING");
    return json({ success: true, assetId: owned.data.id, assetRevision: 1, sha256,
      previewUrl: `/api/storage/files/${encodeURIComponent(owned.data.id)}/content`,
      key: stored.key, provider: stored.provider, contentType: validated.contentType, size: bytes.length, width, height, role });
  } catch (error) {
    if (error instanceof UploadValidationError) return json({ error: "图片内容或格式无效", code: error.code }, 415);
    return json({ error: "图片暂时无法保存，请稍后重试", code: "COVER_MATERIAL_SAVE_UNAVAILABLE" }, 503);
  }
}
