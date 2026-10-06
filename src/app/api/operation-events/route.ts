import { NextResponse } from "next/server";
import { getTokenFromHeaders, verifyToken } from "@/lib/auth";
import {
  browserOperationFlightEventSchema,
  recordBrowserOperationFlightEvent,
} from "@/lib/operation-flight-recorder";

export const runtime = "nodejs";

const MAX_REQUEST_BYTES = 4 * 1024;
const RATE_WINDOW_MS = 60_000;
const MAX_EVENTS_PER_WINDOW = 120;
const rateBuckets = new Map<string, { count: number; resetAt: number }>();

function consumeRateLimit(userId: string): boolean {
  const now = Date.now();
  for (const [key, bucket] of rateBuckets) if (bucket.resetAt <= now) rateBuckets.delete(key);
  const bucket = rateBuckets.get(userId) || { count: 0, resetAt: now + RATE_WINDOW_MS };
  if (bucket.resetAt <= now) {
    bucket.count = 0;
    bucket.resetAt = now + RATE_WINDOW_MS;
  }
  rateBuckets.set(userId, bucket);
  if (bucket.count >= MAX_EVENTS_PER_WINDOW) return false;
  bucket.count += 1;
  return true;
}

export async function POST(request: Request) {
  const token = getTokenFromHeaders(request.headers);
  if (!token) return NextResponse.json({ error: "未授权" }, { status: 401 });
  const actor = await verifyToken(token).catch(() => null);
  if (!actor?.userId) return NextResponse.json({ error: "未授权" }, { status: 401 });
  if (!consumeRateLimit(actor.userId)) return NextResponse.json({ error: "上报过于频繁" }, { status: 429 });

  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") return NextResponse.json({ error: "仅接受 JSON" }, { status: 415 });
  const declaredBytes = Number(request.headers.get("content-length") || 0);
  if (Number.isFinite(declaredBytes) && declaredBytes > MAX_REQUEST_BYTES) {
    return NextResponse.json({ error: "请求体过大" }, { status: 413 });
  }

  try {
    const raw = await request.text();
    if (new TextEncoder().encode(raw).byteLength > MAX_REQUEST_BYTES) {
      return NextResponse.json({ error: "请求体过大" }, { status: 413 });
    }
    let input: unknown;
    try {
      input = JSON.parse(raw) as unknown;
    } catch {
      return NextResponse.json({ error: "运行事件格式无效" }, { status: 400 });
    }
    const parsed = browserOperationFlightEventSchema.safeParse(input);
    if (!parsed.success) return NextResponse.json({ error: "运行事件格式无效" }, { status: 400 });
    const result = await recordBrowserOperationFlightEvent(parsed.data, actor);
    return NextResponse.json({ accepted: true, ...result }, { status: result.duplicate ? 200 : 201 });
  } catch (error) {
    const code = error instanceof Error ? error.message.split(":", 1)[0] : "OPERATION_FLIGHT_FAILED";
    if (code === "OPERATION_ROUTE_INVALID") {
      return NextResponse.json({ error: "运行事件路径无效", code }, { status: 400 });
    }
    console.error("[operation-events] rejected", { code });
    return NextResponse.json({ error: "运行事件上报失败", code }, { status: 500 });
  }
}
