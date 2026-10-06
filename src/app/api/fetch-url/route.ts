import { NextRequest, NextResponse } from "next/server";
import { getTokenFromHeaders, verifyToken } from "@/lib/auth";
import { SafeFetchError, safeFetch } from "@/lib/safe-fetch";

function decodeBasicEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/gi, "'");
}

function extractReadableText(html: string): { title: string; content: string } {
  const title = decodeBasicEntities(html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "")
    .replace(/\s+/g, " ")
    .trim();
  const content = decodeBasicEntities(html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|template)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
  return { title, content };
}

export async function POST(request: NextRequest) {
  try {
    // 认证检查 - 防止SSRF攻击：未认证用户可利用此接口让服务器发起任意请求
    const token = getTokenFromHeaders(request.headers);
    if (!token) return NextResponse.json({ error: "未授权" }, { status: 401 });
    const payload = await verifyToken(token);
    if (!payload) return NextResponse.json({ error: "登录已过期" }, { status: 401 });

    const body = await request.json() as { url?: unknown };
    if (typeof body.url !== "string" || body.url.length > 2_048) {
      return NextResponse.json({ error: "URL 无效" }, { status: 400 });
    }

    const response = await safeFetch(body.url, {
      maxBytes: 2 * 1024 * 1024,
      timeoutMs: 8_000,
      maxRedirects: 3,
      allowedContentTypes: ["text/html", "text/plain", "application/json"],
      headers: { Accept: "text/html,text/plain,application/json;q=0.9" },
    });
    const rawContent = response.buffer.toString("utf8");
    const readable = response.contentType === "text/html"
      ? extractReadableText(rawContent)
      : { title: "", content: rawContent };

    return NextResponse.json({
      title: readable.title,
      content: readable.content,
      url: response.url,
    });
  } catch (err) {
    if (err instanceof SafeFetchError) {
      return NextResponse.json({ error: "无法安全获取该地址", code: err.code }, { status: err.status });
    }
    console.error("[fetch-url] request failed");
    return NextResponse.json({ error: "获取网页失败" }, { status: 500 });
  }
}
