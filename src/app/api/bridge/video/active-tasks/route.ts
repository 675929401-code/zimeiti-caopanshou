import { authorizationHeader, proxyJson } from "@/lib/platform-bridge";

export async function GET(request: Request) {
  return proxyJson("/api/video/active-tasks", { headers: authorizationHeader(request) });
}

