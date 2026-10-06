import { NextRequest, NextResponse } from "next/server";
import { getTokenFromHeaders, verifyToken } from "@/lib/auth";
import { SafeFetchError, safeFetchStream } from "@/lib/safe-fetch";
import { verifyExtractDownloadSignature } from "@/lib/extract-download-signature";

// 视频下载代理 - 解决前端直接访问抖音CDN的CORS/403问题
// GET /api/extract/download?url=xxx&filename=xxx

const ALLOWED_HOSTS = [
  "douyinvod.com",
  "douyinpic.com",
  "douyin.com",
  "bytedance.com",
  "tiktokcdn.com",
  "tiktokv.com",
  "muscdn.com",
  "ibytedtos.com",
  "byteimg.com",
  "bytednsdoc.com",
  "bdydns.com",
  "snssdk.com",
  "douyin.wtf",
  "ppt6.top",
] as const;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 4;

function isAllowedHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/\.$/, "");
  return ALLOWED_HOSTS.some((host) => normalized === host || normalized.endsWith(`.${host}`));
}

async function validateDownloadUrl(input: string | URL): Promise<URL> {
  let parsed: URL;
  try {
    parsed = input instanceof URL ? new URL(input.toString()) : new URL(input);
  } catch {
    throw new SafeFetchError("无效的URL", "INVALID_URL", 400);
  }
  if (!isAllowedHost(parsed.hostname)) {
    throw new SafeFetchError(`不允许的域名: ${parsed.hostname}`, "HOST_FORBIDDEN", 403);
  }
  // Domain rules apply before every hop. The streaming helper then validates
  // protocol/port/all DNS answers and pins the actual connection when enabled.
  return parsed;
}

async function fetchDownloadStream(input: string, rangeHeader: string | null, signal?: AbortSignal): Promise<Response> {
  let current = await validateDownloadUrl(input);

  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
    const headers: Record<string, string> = {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      Referer: "https://www.douyin.com/",
      Accept: "*/*",
      "Accept-Encoding": "identity",
    };
    if (rangeHeader) headers.Range = rangeHeader;

    const { response } = await safeFetchStream(current, {
      headers,
      timeoutMs: 60_000,
      signal,
    });

    if (!REDIRECT_STATUSES.has(response.status)) return response;

    await response.body?.cancel();
    if (redirectCount >= MAX_REDIRECTS) {
      throw new SafeFetchError("下载地址重定向次数过多", "TOO_MANY_REDIRECTS", 502);
    }
    const location = response.headers.get("location");
    if (!location) {
      throw new SafeFetchError("下载地址重定向缺少目标", "INVALID_REDIRECT", 502);
    }
    current = await validateDownloadUrl(new URL(location, current));
  }

  throw new SafeFetchError("下载地址不可用", "FETCH_FAILED", 502);
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const videoUrl = searchParams.get("url");
    const filename = searchParams.get("filename") || "video.mp4";
    const mode = searchParams.get("mode") || "download";

    if (!videoUrl) {
      return NextResponse.json({ error: "缺少视频URL" }, { status: 400 });
    }
    const token = getTokenFromHeaders(request.headers);
    const authenticated = Boolean(token && await verifyToken(token));
    const signedInternalRequest = verifyExtractDownloadSignature(
      videoUrl,
      searchParams.get("expires"),
      searchParams.get("sig"),
    );
    if (!authenticated && !signedInternalRequest) {
      return NextResponse.json({ error: "未授权或下载凭证已过期" }, { status: 401 });
    }
    if (mode !== "download" && mode !== "play") {
      return NextResponse.json({ error: "无效的下载模式" }, { status: 400 });
    }

    // Range 头直接随第一次请求转发，避免旧实现先下载整段、再重复请求分片。
    const response = await fetchDownloadStream(videoUrl, request.headers.get("range"), request.signal);
    if (!response.ok) {
      await response.body?.cancel();
      return NextResponse.json(
        { error: `下载失败: HTTP ${response.status}` },
        { status: response.status >= 400 && response.status < 600 ? response.status : 502 },
      );
    }

    const contentType = response.headers.get("content-type") || "application/octet-stream";
    const normalizedContentType = contentType.split(";", 1)[0].trim().toLowerCase();
    if (
      normalizedContentType !== "application/octet-stream"
      && !normalizedContentType.startsWith("video/")
      && !normalizedContentType.startsWith("image/")
      && !normalizedContentType.startsWith("audio/")
    ) {
      await response.body?.cancel();
      return NextResponse.json({ error: "远程内容不是可播放媒体" }, { status: 415 });
    }

    const headers = new Headers({
      "Content-Type": contentType,
      "Cache-Control": "private, max-age=3600",
      "Content-Disposition": mode === "play"
        ? "inline"
        : `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
      "X-Content-Type-Options": "nosniff",
    });

    for (const name of ["content-length", "content-range", "accept-ranges", "etag", "last-modified"]) {
      const value = response.headers.get(name);
      if (value) headers.set(name, value);
    }

    return new NextResponse(response.body, {
      status: response.status,
      headers,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "下载代理内部错误";
    const status = error instanceof SafeFetchError ? error.status : 500;
    console.error("[Extract Download Proxy] Error:", message);
    return NextResponse.json({ error: message }, { status });
  }
}
