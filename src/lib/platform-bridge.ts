import { NextResponse } from "next/server";

const DEFAULT_PLATFORM_URL = "http://127.0.0.1:5000";

export function getPlatformUrl(path: string): string {
  const base = (process.env.SOURCE_PLATFORM_URL || DEFAULT_PLATFORM_URL).replace(/\/$/, "");
  return `${base}${path.startsWith("/") ? path : `/${path}`}`;
}

export async function proxyJson(
  path: string,
  init: RequestInit = {},
): Promise<NextResponse> {
  try {
    const response = await fetch(getPlatformUrl(path), {
      ...init,
      cache: "no-store",
      headers: {
        Accept: "application/json",
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...init.headers,
      },
    });
    const text = await response.text();
    return new NextResponse(text, {
      status: response.status,
      headers: { "Content-Type": response.headers.get("content-type") || "application/json" },
    });
  } catch {
    return NextResponse.json(
      { error: "主平台连接失败，请确认 5000 端口服务正在运行" },
      { status: 502 },
    );
  }
}

export function authorizationHeader(request: Request): Record<string, string> {
  const authorization = request.headers.get("authorization");
  return authorization ? { Authorization: authorization } : {};
}

