import { NextRequest, NextResponse } from "next/server";
import { authorizeCurrentApiUser } from "@/lib/current-api-user";
import { getSupabaseClient } from "@/storage/database/supabase-client";
import { storageManager, type StorageProviderType } from "@/storage/object";
import { confirmedImageSourceExpiry, markImageProviderSourceExpired, readProviderImage } from "@/lib/image-provider-delivery";

const MAX_IMAGE_BYTES = 30 * 1024 * 1024;
const ASSET_UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu;

interface GalleryAssetReference {
  assetId: string;
  storageKey: string;
}

interface OwnedImageRow {
  id: string;
  storage_key: string;
  storage_provider: StorageProviderType;
  file_name: string;
  file_size: number;
  content_type: string;
}

function imageAssetFromGallery(content: unknown, index: number): GalleryAssetReference | null {
  if (typeof content !== "string") return null;
  try {
    const parsed = JSON.parse(content) as {
      type?: string;
      images?: Array<{ assetId?: unknown; storageKey?: unknown }>;
    };
    if (parsed.type !== "image_gallery" || !Array.isArray(parsed.images)) return null;
    const image = parsed.images[index];
    const assetId = String(image?.assetId || "").trim();
    const storageKey = String(image?.storageKey || "").trim();
    return assetId && storageKey ? { assetId, storageKey } : null;
  } catch {
    return null;
  }
}

function safeFileName(value: unknown, index: number): string {
  const cleaned = String(value || `image-${index + 1}.png`)
    .replace(/[\r\n]/g, " ")
    .replace(/[\\/:*?"<>|]/g, "-")
    .trim();
  return cleaned.slice(0, 160) || `image-${index + 1}.png`;
}

async function deliverOwnedImage(request: NextRequest, file: OwnedImageRow, index: number) {
  const contentType = String(file.content_type || "").split(";")[0].trim().toLowerCase();
  const declaredSize = Number(file.file_size) || 0;
  if (!contentType.startsWith("image/")) return NextResponse.json({ error: "永久资产不是图片" }, { status: 415 });
  if (declaredSize > MAX_IMAGE_BYTES) return NextResponse.json({ error: "图片超过在线读取上限" }, { status: 413 });

  try {
    // key/provider 只来自当前用户归属校验后的服务端记录，绝不读取历史里的远程临时 URL。
    const bytes = await storageManager.read(file.storage_key, file.storage_provider);
    if (bytes.byteLength > MAX_IMAGE_BYTES) {
      return NextResponse.json({ error: "图片超过在线读取上限" }, { status: 413 });
    }
    const download = request.nextUrl.searchParams.get("download") === "1";
    const fileName = safeFileName(file.file_name, index);
    const asciiFileName = fileName.replace(/[^\x20-\x7E]/g, "_").replace(/["\\]/g, "_");
    const encodedFileName = encodeURIComponent(fileName);
    return new NextResponse(bytes, {
      headers: {
        "Content-Type": contentType,
        "Content-Length": String(bytes.byteLength),
        "Cache-Control": "private, no-store",
        "Content-Security-Policy": "sandbox",
        "X-Content-Type-Options": "nosniff",
        ...(download ? { "Content-Disposition": `attachment; filename="${asciiFileName}"; filename*=UTF-8''${encodedFileName}` } : {}),
      },
    });
  } catch {
    return NextResponse.json({ error: "永久图片资产暂时无法读取" }, { status: 502 });
  }
}

export async function GET(request: NextRequest) {
  const authorization = await authorizeCurrentApiUser(request);
  if (!authorization.ok) return authorization.response;
  const user = authorization.user;
  const recordId = request.nextUrl.searchParams.get("recordId");
  if (recordId) {
    if (!/^[A-Za-z0-9_.:-]{1,256}$/u.test(recordId)) return NextResponse.json({ error: "媒体参数无效" }, { status: 400 });
    const lookup = await getSupabaseClient().from("image_generation_requests").select("response")
      .eq("record_id", recordId).eq("user_id", user.userId).eq("state", "completed").eq("delivery_state", "delivered").maybeSingle();
    if (lookup.error) return NextResponse.json({ error: "图片交付归属暂时无法确认" }, { status: 503 });
    const delivery = lookup.data?.response as Record<string, unknown> | undefined;
    if (!delivery || delivery.deliveryMode !== "provider_url") return NextResponse.json({ error: "图片记录不存在或无权访问" }, { status: 404 });
    if (delivery.sourceExpiredAt) return NextResponse.json({ error: "上游图片已确认失效" }, { status: 410 });
    try {
      const result = await readProviderImage(delivery, false, { recordId, userId: user.userId });
      if (!result) throw new Error("IMAGE_SOURCE_EMPTY");
      return new NextResponse(result.buffer, { headers: {
        "Content-Type": result.contentType, "Content-Length": String(result.buffer.length),
        "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "sandbox",
        ...(request.nextUrl.searchParams.get("download") === "1" ? { "Content-Disposition": 'attachment; filename="generated-image"' } : {}),
      } });
    } catch (error) {
      if (confirmedImageSourceExpiry(error)) {
        try { await markImageProviderSourceExpired(recordId, user.userId, String(delivery.providerUrl)); }
        catch { return NextResponse.json({ error: "图片源暂时无法确认，记录已保留" }, { status: 503 }); }
        return NextResponse.json({ error: "上游图片已确认失效，任务与账务凭据仍保留" }, { status: 410 });
      }
      return NextResponse.json({ error: "上游图片暂时无法读取，原记录已保留" }, { status: 502 });
    }
  }

  const assetId = String(request.nextUrl.searchParams.get("assetId") || "").trim();
  const id = request.nextUrl.searchParams.get("id") || "";
  const index = Number(request.nextUrl.searchParams.get("index"));
  const directAssetRequest = Boolean(assetId);
  if (directAssetRequest && !ASSET_UUID.test(assetId)) {
    return NextResponse.json({ error: "媒体参数无效" }, { status: 400 });
  }
  if (!directAssetRequest && (!/^[a-zA-Z0-9_.-]+$/.test(id) || !Number.isInteger(index) || index < 0 || index > 40)) {
    return NextResponse.json({ error: "媒体参数无效" }, { status: 400 });
  }

  const db = getSupabaseClient();
  if (directAssetRequest) {
    const lookup = await db
      .from("user_files")
      .select("id, storage_key, storage_provider, file_name, file_size, content_type")
      .eq("id", assetId)
      .eq("user_id", user.userId)
      .maybeSingle();
    if (lookup.error) return NextResponse.json({ error: "图片资产归属校验失败" }, { status: 500 });
    if (!lookup.data) return NextResponse.json({ error: "图片资产不存在或无权访问" }, { status: 404 });
    return deliverOwnedImage(request, lookup.data as OwnedImageRow, 0);
  }

  const history = await db
    .from("conversation_messages")
    .select("content")
    .eq("id", id)
    .eq("user_id", user.userId)
    .eq("role", "assistant")
    .maybeSingle();
  if (history.error || !history.data) {
    return NextResponse.json({ error: "图片记录不存在" }, { status: 404 });
  }

  const reference = imageAssetFromGallery(history.data.content, index);
  if (!reference) {
    return NextResponse.json({
      error: "图片历史缺少永久资产标识，暂不可预览或下载",
    }, { status: 410 });
  }

  const lookup = await db
    .from("user_files")
    .select("id, storage_key, storage_provider, file_name, file_size, content_type")
    .eq("id", reference.assetId)
    .eq("user_id", user.userId)
    .eq("storage_key", reference.storageKey)
    .maybeSingle();
  if (lookup.error) return NextResponse.json({ error: "图片资产归属校验失败" }, { status: 500 });
  if (!lookup.data) return NextResponse.json({ error: "图片资产不存在或无权访问" }, { status: 404 });
  return deliverOwnedImage(request, lookup.data as OwnedImageRow, index);
}
