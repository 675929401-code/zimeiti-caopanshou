import { proxyJson } from "@/lib/platform-bridge";

export async function GET() {
  return proxyJson("/api/video/models");
}

