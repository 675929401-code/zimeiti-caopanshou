import { authorizationHeader, proxyJson } from "@/lib/platform-bridge";

export async function GET(request: Request) {
  const source = new URL(request.url);
  return proxyJson(`/api/video/status?${source.searchParams.toString()}`, {
    headers: authorizationHeader(request),
  });
}

