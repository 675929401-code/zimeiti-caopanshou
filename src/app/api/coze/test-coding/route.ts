import { NextRequest, NextResponse } from "next/server";
import { parseOfficialCozeCodingEndpoint } from "@/lib/coze-coding-endpoint-policy.mjs";
import { authorizeAdminCapability } from "@/lib/server/admin-governance-authority";

export async function POST(request: NextRequest) {
  const modelAccess = await authorizeAdminCapability(request, "models.manage", {
    requireStepUp: true,
    operation: "coze_coding_connection_test",
  });
  if (!modelAccess.ok) return modelAccess.response;

  const agentAccess = await authorizeAdminCapability(request, "agents.manage", {
    requireStepUp: true,
    operation: "coze_coding_connection_test",
  });
  if (!agentAccess.ok) return agentAccess.response;

  try {
    const { url, token, projectId } = await request.json();

    if (!url || !token) {
      return NextResponse.json(
        { success: false, error: "缺少 API 地址或 Token" },
        { status: 400 }
      );
    }

    const endpoint = parseOfficialCozeCodingEndpoint(url);
    if (!endpoint) {
      return NextResponse.json({
        success: false,
        error: "API 地址必须是 Coze 官方 HTTPS 域名，且不能包含账号、密码或非默认端口",
      });
    }

    // 尝试发送一个测试请求
    const testBody: Record<string, string> = {
      action: "run",
      stream: "false",
    };
    if (projectId) {
      testBody.project_id = projectId;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    try {
      const res = await fetch(endpoint.toString(), {
        method: "POST",
        redirect: "error",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(testBody),
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (res.status === 401 || res.status === 403) {
        return NextResponse.json({
          success: false,
          error: `认证失败(${res.status})：Token 无效或已过期`,
        });
      }

      if (res.status === 404) {
        return NextResponse.json({
          success: false,
          error: "API 地址不存在(404)，请检查 URL 是否正确",
        });
      }

      // 200-299 或 400(参数错误但说明连通) 都算连接成功
      if (res.ok || res.status === 400) {
        return NextResponse.json({
          success: true,
          message: "连接成功，API 可正常访问",
        });
      }

      // 其他状态码
      const text = await res.text().catch(() => "");
      return NextResponse.json({
        success: false,
        error: `服务器返回 ${res.status}${text ? `: ${text.slice(0, 100)}` : ""}`,
      });
    } catch (fetchErr: unknown) {
      clearTimeout(timeout);
      const errMsg =
        fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
      if (errMsg.includes("abort")) {
        return NextResponse.json({
          success: false,
          error: "连接超时(10秒)，请检查 URL 是否正确",
        });
      }
      return NextResponse.json({
        success: false,
        error: `网络错误：${errMsg}`,
      });
    }
  } catch {
    return NextResponse.json(
      { success: false, error: "请求格式错误" },
      { status: 400 }
    );
  }
}
