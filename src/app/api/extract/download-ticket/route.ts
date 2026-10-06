import { NextRequest, NextResponse } from "next/server";
import { getTokenFromHeaders, verifyToken } from "@/lib/auth";
import { createSignedExtractDownloadParams, createSignedExtractOwnedAssetParams } from "@/lib/extract-download-signature";
import { getSupabaseClient } from "@/storage/database/supabase-client";

export const runtime = "nodejs";

const TICKET_LIFETIME_MS = 5 * 60 * 1000;
const MAX_REMOTE_URL_LENGTH = 12_000;

export async function POST(request: NextRequest) {
  const token = getTokenFromHeaders(request.headers);
  const actor = token ? await verifyToken(token).catch(() => null) : null;
  if (!actor?.userId) {
    return NextResponse.json({ error: "请先登录后获取下载凭证" }, { status: 401 });
  }

  let body: { url?: unknown; filename?: unknown; mode?: unknown; asset_id?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "无效请求体" }, { status: 400 });
  }

  const sourceUrl = typeof body.url === "string" ? body.url.trim() : "";
  const assetId = typeof body.asset_id === "string" ? body.asset_id.trim() : "";
  const filename = typeof body.filename === "string" ? body.filename.trim().slice(0, 180) : "video.mp4";
  const mode = body.mode === "play" ? "play" : body.mode === "download" || body.mode == null ? "download" : "";
  if ((!assetId && !sourceUrl) || sourceUrl.length > MAX_REMOTE_URL_LENGTH || !mode) {
    return NextResponse.json({ error: "下载地址或模式无效" }, { status: 400 });
  }
  if (assetId) {
    if (!/^[A-Za-z0-9_-]{1,160}$/u.test(assetId)) {
      return NextResponse.json({ error: "文件编号无效" }, { status: 400 });
    }
    const lookup = await getSupabaseClient()
      .from("user_files")
      .select("id,file_category")
      .eq("id", assetId)
      .eq("user_id", actor.userId)
      .maybeSingle();
    if (lookup.error) return NextResponse.json({ error: "文件归属校验失败" }, { status: 503 });
    if (!lookup.data || !["video", "image"].includes(String(lookup.data.file_category))) {
      return NextResponse.json({ error: "文件不存在或无权访问" }, { status: 404 });
    }
    const signed = createSignedExtractOwnedAssetParams(assetId, TICKET_LIFETIME_MS);
    const query = new URLSearchParams({ expires: signed.expires, sig: signed.sig });
    if (mode === "download") query.set("download", "1");
    return NextResponse.json({
      download_url: `/api/storage/files/${encodeURIComponent(assetId)}/content?${query.toString()}`,
      expires_at: Number(signed.expires),
    }, { headers: { "Cache-Control": "no-store" } });
  }
  try {
    const parsed = new URL(sourceUrl);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
      throw new Error("invalid URL");
    }
  } catch {
    return NextResponse.json({ error: "下载地址格式无效" }, { status: 400 });
  }

  const signed = createSignedExtractDownloadParams(sourceUrl, TICKET_LIFETIME_MS);
  const query = new URLSearchParams({
    url: sourceUrl,
    filename: filename || "video.mp4",
    mode,
    expires: signed.expires,
    sig: signed.sig,
  });
  return NextResponse.json(
    {
      download_url: `/api/extract/download?${query.toString()}`,
      expires_at: Number(signed.expires),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
