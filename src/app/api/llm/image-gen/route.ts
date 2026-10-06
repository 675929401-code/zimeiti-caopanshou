/**
 * Legacy Agent direct-image endpoint.
 *
 * The current Agent contract is text orchestration. Image generation must be
 * confirmed and billed in the dedicated image workbench, where model, size,
 * quantity, estimated price and a stable idempotency key are available before
 * an upstream request is submitted. This legacy route therefore fails closed
 * and performs no provider request, database write or wallet operation.
 */
import { verifyToken } from "@/lib/auth";

export const dynamic = "force-dynamic";

const JSON_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store, max-age=0",
};

export async function POST(request: Request) {
  const authHeader = request.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return Response.json(
      { error: "请先登录", code: "UNAUTHORIZED" },
      { status: 401, headers: JSON_HEADERS },
    );
  }

  const tokenPayload = await verifyToken(authHeader.slice(7)).catch(() => null);
  if (!tokenPayload?.userId) {
    return Response.json(
      { error: "请先登录", code: "UNAUTHORIZED" },
      { status: 401, headers: JSON_HEADERS },
    );
  }

  return Response.json(
    {
      error:
        "创作 Agent 已改为文本编排。请进入 AI 生图工作台确认模型、参数与预计费用后生成。",
      code: "AGENT_IMAGE_GENERATION_MOVED",
      targetHref: "/tools/image/image-chat",
      generated: false,
      billed: false,
      retryable: false,
    },
    { status: 409, headers: JSON_HEADERS },
  );
}
