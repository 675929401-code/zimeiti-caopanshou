import { NextRequest, NextResponse } from "next/server";
import { getTokenFromHeaders, verifyToken } from "@/lib/auth";
import { storageManager } from "@/storage/object";
import type { StorageProviderType } from "@/storage/object";
import { parseSingleByteRange } from "@/storage/object/byte-range";
import { getSupabaseClient } from "@/storage/database/supabase-client";
import { verifyExtractOwnedAssetSignature } from "@/lib/extract-download-signature";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_PROXY_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_LOCAL_BUFFER_BYTES = 250 * 1024 * 1024;

interface OwnedFileRow {
  id: string;
  storage_key: string;
  storage_provider: StorageProviderType;
  file_name: string;
  file_size: number;
  content_type: string;
}

function safeFileName(value: unknown): string {
  const normalized = String(value || "asset")
    .replace(/[\r\n]/g, " ")
    .replace(/[\\/:*?"<>|]/g, "-")
    .trim();
  return normalized.slice(0, 160) || "asset";
}

function contentDisposition(fileName: string, download: boolean): string {
  const ascii = fileName.replace(/[^\x20-\x7E]/g, "_").replace(/["\\]/g, "_") || "asset";
  const encoded = encodeURIComponent(fileName).replace(/['()]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${download ? "attachment" : "inline"}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

function safePreviewContentType(value: string, download: boolean): string {
  const normalized = value.split(";")[0]?.trim().toLowerCase() || "application/octet-stream";
  if (download) return normalized;
  if (normalized.startsWith("image/") || normalized.startsWith("video/") || normalized.startsWith("audio/")) return normalized;
  if (["application/pdf", "text/plain"].includes(normalized)) return normalized;
  return "application/octet-stream";
}

function responseHeaders(file: OwnedFileRow, download: boolean, upstream?: Response): Headers {
  const headers = new Headers({
    "Cache-Control": "private, no-store",
    "Content-Disposition": contentDisposition(safeFileName(file.file_name), download),
    "Content-Security-Policy": "sandbox",
    "X-Content-Type-Options": "nosniff",
    "Content-Type": safePreviewContentType(upstream?.headers.get("content-type") || file.content_type, download),
  });
  const contentLength = upstream?.headers.get("content-length");
  const contentRange = upstream?.headers.get("content-range");
  const acceptRanges = upstream?.headers.get("accept-ranges");
  if (contentLength && /^\d+$/.test(contentLength)) headers.set("Content-Length", contentLength);
  if (contentRange && /^bytes \d+-\d+\/\d+$/i.test(contentRange)) headers.set("Content-Range", contentRange);
  if (acceptRanges === "bytes" || contentRange) headers.set("Accept-Ranges", "bytes");
  return headers;
}

export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const token = getTokenFromHeaders(request.headers);
  const { id } = await context.params;
  if (!/^[A-Za-z0-9_-]{1,160}$/.test(id)) {
    return NextResponse.json({ error: "文件编号无效" }, { status: 400 });
  }
  const user = token ? await verifyToken(token).catch(() => null) : null;
  const signedTicket = verifyExtractOwnedAssetSignature(
    id,
    request.nextUrl.searchParams.get("expires"),
    request.nextUrl.searchParams.get("sig"),
  );
  if (!user && !signedTicket) return NextResponse.json({ error: "请先登录" }, { status: 401 });

  const db = getSupabaseClient();
  let lookupQuery = db
    .from("user_files")
    .select("id,storage_key,storage_provider,file_name,file_size,content_type")
    .eq("id", id);
  if (user) lookupQuery = lookupQuery.eq("user_id", user.userId);
  const lookup = await lookupQuery.maybeSingle();
  if (lookup.error) return NextResponse.json({ error: "文件归属校验失败" }, { status: 500 });
  if (!lookup.data) return NextResponse.json({ error: "文件不存在或无权访问" }, { status: 404 });

  const file = lookup.data as OwnedFileRow;
  const declaredSize = Number(file.file_size) || 0;
  if (declaredSize > MAX_PROXY_BYTES) {
    return NextResponse.json({ error: "文件超过在线读取上限" }, { status: 413 });
  }

  const download = request.nextUrl.searchParams.get("download") === "1";
  try {
    // storage_key 只来自已按 id + user_id 验权的服务端记录，客户端从未参与。
    const signedUrl = await storageManager.getSignedUrl(
      file.storage_key,
      { expireTime: 120 },
      file.storage_provider,
    );

    if (/^https?:\/\//i.test(signedUrl)) {
      const range = request.headers.get("range");
      const upstreamHeaders = new Headers();
      if (range && /^bytes=(?:\d+-\d*|-\d+)$/i.test(range)) upstreamHeaders.set("Range", range);
      const upstream = await fetch(signedUrl, {
        headers: upstreamHeaders,
        cache: "no-store",
        redirect: "follow",
      });
      if (!upstream.ok || !upstream.body) {
        return NextResponse.json({ error: "存储文件暂时不可读取" }, { status: upstream.status === 404 ? 404 : 502 });
      }
      const upstreamLength = Number(upstream.headers.get("content-length"));
      if (Number.isFinite(upstreamLength) && upstreamLength > MAX_PROXY_BYTES) {
        await upstream.body.cancel().catch(() => undefined);
        return NextResponse.json({ error: "文件超过在线读取上限" }, { status: 413 });
      }
      return new NextResponse(upstream.body, {
        status: upstream.status,
        headers: responseHeaders(file, download, upstream),
      });
    }

    // 本地存储返回同源相对路径。已先调用 getSignedUrl 完成 provider/key 校验，
    // 再由服务端读取，避免自请求死锁，也不会把内部路径发送给浏览器。
    if (declaredSize > MAX_LOCAL_BUFFER_BYTES) {
      return NextResponse.json({ error: "本地文件过大，暂不支持在线读取" }, { status: 413 });
    }
    const bytes = await storageManager.read(file.storage_key, file.storage_provider);
    const headers = responseHeaders(file, download);
    headers.set("Accept-Ranges", "bytes");

    const range = parseSingleByteRange(request.headers.get("range"), bytes.byteLength);
    if (range.kind === "unsatisfiable") {
      headers.set("Content-Range", "bytes */" + bytes.byteLength);
      headers.delete("Content-Length");
      return new NextResponse(null, { status: 416, headers });
    }
    if (range.kind === "satisfiable") {
      const chunk = bytes.subarray(range.start, range.end + 1);
      headers.set("Content-Length", String(chunk.byteLength));
      headers.set(
        "Content-Range",
        "bytes " + range.start + "-" + range.end + "/" + bytes.byteLength,
      );
      return new NextResponse(chunk, { status: 206, headers });
    }

    headers.set("Content-Length", String(bytes.byteLength));
    return new NextResponse(bytes, {
      status: 200,
      headers,
    });
  } catch {
    return NextResponse.json({ error: "存储文件暂时不可读取" }, { status: 502 });
  }
}
