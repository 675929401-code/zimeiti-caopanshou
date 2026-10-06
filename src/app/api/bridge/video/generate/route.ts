import { authorizationHeader, proxyJson } from "@/lib/platform-bridge";

export async function POST(request: Request) {
  const body = await request.text();
  return proxyJson("/api/video/generate", {
    method: "POST",
    headers: authorizationHeader(request),
    body,
  });
}

