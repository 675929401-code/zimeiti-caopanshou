import { NextRequest, NextResponse } from "next/server";
import { authorizeCurrentApiUser } from "@/lib/current-api-user";
import { requestVideoTaskCancellation } from "@/lib/video-cancellation-runtime";

// POST /api/video/cancel
// Local cancellation is allowed only before provider dispatch. Once a request
// has left the platform, the exact upstream task must confirm cancellation.
export async function POST(request: NextRequest) {
  try {
    const authorization = await authorizeCurrentApiUser(request);
    if (!authorization.ok) return authorization.response;
    const body = await request.json();
    const result = await requestVideoTaskCancellation({
      userId: authorization.user.userId,
      taskId: body?.taskId,
      clientRequestId: body?.clientRequestId,
    });
    return NextResponse.json(result.body, { status: result.statusCode });
  } catch (error) {
    console.error("[视频取消] 错误:", error);
    return NextResponse.json({ error: "取消任务失败" }, { status: 500 });
  }
}
