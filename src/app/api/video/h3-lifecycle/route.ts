import { NextRequest, NextResponse } from "next/server";

import { authorizeCurrentApiUser } from "@/lib/current-api-user";
import { isAutodlH3LifecycleEnabled } from "@/lib/autodl-h3-lifecycle";
import { getAutodlH3LifecycleViewForUser } from "@/lib/autodl-h3-lifecycle-view";

const H3_PUBLIC_TASK_ID_PATTERN = /^h3q_[a-f0-9]+$/u;

export async function GET(request: NextRequest) {
  const authorization = await authorizeCurrentApiUser(request);
  if (!authorization.ok) return authorization.response;
  const payload = authorization.user;

  const taskId = new URL(request.url).searchParams.get("taskId")?.trim() || "";
  if (!H3_PUBLIC_TASK_ID_PATTERN.test(taskId)) {
    return NextResponse.json({
      error: "仅支持自租 H3 生命周期任务编号",
      code: "H3_LIFECYCLE_TASK_ID_INVALID",
    }, { status: 400 });
  }
  if (!isAutodlH3LifecycleEnabled()) {
    return NextResponse.json({
      error: "自租 H3 自动唤醒尚未启用",
      code: "H3_LIFECYCLE_DISABLED",
    }, { status: 503 });
  }

  try {
    const lifecycle = await getAutodlH3LifecycleViewForUser({
      publicTaskId: taskId,
      userId: payload.userId,
    });
    if (!lifecycle) {
      return NextResponse.json({
        error: "未找到当前用户的 H3 任务",
        code: "H3_LIFECYCLE_JOB_NOT_FOUND",
      }, { status: 404 });
    }
    return NextResponse.json({ lifecycle }, {
      headers: { "Cache-Control": "no-store, max-age=0" },
    });
  } catch {
    return NextResponse.json({
      error: "H3 实时生命周期状态暂时不可用",
      code: "H3_LIFECYCLE_VIEW_UNAVAILABLE",
    }, { status: 503 });
  }
}
