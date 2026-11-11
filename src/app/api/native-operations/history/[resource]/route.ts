import { NextRequest, NextResponse } from "next/server";
import { withAuth } from "@/lib/api-middleware";
import { NativeHistoryResourceSchema } from "@/lib/native-history-contract";
import { assertNativeAccess } from "@/lib/server/native-operations-service";
import { readNativeHistory } from "@/lib/server/native-history-service";
import { PublishingError, publishingFailure } from "@/lib/server/publishing-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store, max-age=0", "X-Content-Type-Options": "nosniff" };
export async function GET(request: NextRequest, context: { params: Promise<{ resource: string }> }) {
  if (!request.cookies.get("auth_token")?.value || request.headers.has("authorization")) return NextResponse.json({ code: "SESSION_EXPIRED", data: null, message: "请先登录主站" }, { status: 401, headers });
  try {
    const response = await withAuth(request, async (user, db) => {
      if (request.headers.get("x-native-actor-id") !== user.id) throw new PublishingError("NATIVE_ACTOR_CHANGED", "主站登录会员已变化，请重新打开工作台", 409);
      await assertNativeAccess(user);
      const resource = NativeHistoryResourceSchema.safeParse((await context.params).resource);
      if (!resource.success) throw new PublishingError("NATIVE_INPUT_INVALID", "记录分类无效", 400);
      return NextResponse.json({ code: 0, data: await readNativeHistory(user, db, resource.data, request), message: "" }, { headers });
    });
    if ([401, 403, 503].includes(response.status)) {
      const body = await response.clone().json().catch(() => null);
      if (body && typeof body === "object" && !("data" in body)) return NextResponse.json({ code: body.code ?? "NATIVE_HISTORY_UNAVAILABLE", data: null, message: body.error ?? "主站记录暂不可确认" }, { status: response.status, headers });
    }
    return response;
  } catch (error) {
    const failure = publishingFailure(error);
    return NextResponse.json({ code: failure.body.code, data: null, message: failure.body.error }, { status: failure.status, headers });
  }
}
