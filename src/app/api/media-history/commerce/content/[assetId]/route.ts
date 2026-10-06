import { createReadStream } from "node:fs";
import { promises as fs } from "node:fs";
import { Readable } from "node:stream";
import { NextRequest, NextResponse } from "next/server";

import { authorizeCurrentApiUser } from "@/lib/current-api-user";
import { parseSingleByteRange } from "@/lib/http-byte-range";
import {
  findCommerceMediaHistoryAsset,
  verifyCommerceMediaHistoryTicket,
  type MediaHistoryCommerceAsset,
} from "@/lib/media-history-commerce";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function contentDisposition(filename: string): string {
  return `attachment; filename*=UTF-8''${encodeURIComponent(filename || "media")}`;
}

function responseHeaders(asset: MediaHistoryCommerceAsset, download: boolean): Headers {
  const headers = new Headers({
    "Content-Type": asset.type,
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, no-store",
    "Content-Security-Policy": "default-src 'none'; sandbox",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Vary": "Authorization",
  });
  if (download) headers.set("Content-Disposition", contentDisposition(asset.name));
  return headers;
}

async function authorizedAsset(
  request: NextRequest,
  assetId: string,
  scope: "playback" | "download",
): Promise<MediaHistoryCommerceAsset | Response> {
  const ticket = request.nextUrl.searchParams.get("media_ticket");
  if (ticket) {
    const identity = await verifyCommerceMediaHistoryTicket(ticket, { assetId, scope });
    if (!identity) return NextResponse.json({ error: "媒体访问凭据无效或已过期" }, { status: 401 });
    const asset = findCommerceMediaHistoryAsset(identity.userId, identity.role, assetId, identity.owner);
    return asset || NextResponse.json({ error: "媒体资产不存在或无权访问" }, { status: 404 });
  }

  const authorization = await authorizeCurrentApiUser(request);
  if (!authorization.ok) return authorization.response;
  const asset = findCommerceMediaHistoryAsset(
    authorization.user.userId,
    authorization.user.role,
    assetId,
  );
  if (!asset) return NextResponse.json({ error: "媒体资产不存在或无权访问" }, { status: 404 });
  if (asset.type.startsWith("video/")) {
    return NextResponse.json({ error: "视频预览或下载需要短期访问凭据" }, { status: 401 });
  }
  return asset;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ assetId: string }> },
) {
  const { assetId } = await params;
  const download = request.nextUrl.searchParams.get("download") === "1";
  const scope = download ? "download" : "playback";
  const resolved = await authorizedAsset(request, assetId, scope);
  if (resolved instanceof Response) return resolved;
  const asset = resolved;

  let fileSize: number;
  try {
    const stat = await fs.stat(asset.filePath);
    if (!stat.isFile() || stat.size !== asset.size) throw new Error("ASSET_SIZE_MISMATCH");
    fileSize = stat.size;
  } catch {
    return NextResponse.json({ error: "媒体资产暂时不可用" }, { status: 404 });
  }

  const range = parseSingleByteRange(request.headers.get("range"), fileSize);
  const headers = responseHeaders(asset, download);
  if (range === "invalid") {
    headers.set("Content-Range", `bytes */${fileSize}`);
    return new NextResponse(null, { status: 416, headers });
  }

  const stream = Readable.toWeb(createReadStream(asset.filePath, range || undefined)) as ReadableStream<Uint8Array>;
  const contentLength = range ? range.end - range.start + 1 : fileSize;
  headers.set("Content-Length", String(contentLength));
  if (range) headers.set("Content-Range", `bytes ${range.start}-${range.end}/${fileSize}`);
  return new NextResponse(stream, { status: range ? 206 : 200, headers });
}
