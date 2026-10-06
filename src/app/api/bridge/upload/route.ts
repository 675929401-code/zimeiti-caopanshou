import { authorizationHeader } from "@/lib/platform-bridge";

export async function POST(request: Request) {
  const authorization = authorizationHeader(request);
  if (!authorization.Authorization) return Response.json({ error: "请先登录" }, { status: 401 });

  // 历史版本把普通文件上传伪装成一次付费图生图。该兼容入口永久 fail-closed，
  // 调用方必须显式改用统一对象存储上传接口；任何 AI 高清化都应是独立付费动作。
  return Response.json({
    error: "普通素材上传接口已迁移，请使用统一对象存储上传",
    code: "CANVAS_UPLOAD_BRIDGE_RETIRED",
    uploadEndpoint: "/api/storage/upload",
    billed: false,
  }, { status: 410 });
}
