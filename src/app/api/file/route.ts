import { NextRequest, NextResponse } from "next/server";
import { getSignedUrl } from "@/lib/storage";
import { withAuth } from "@/lib/api-middleware";
import { authorizeMemberContentAccess } from "@/lib/server/member-content-authority";

export async function GET(request: NextRequest) {
  return withAuth(request, async (user, supabase) => {
    try {
      const key = request.nextUrl.searchParams.get("key");
      if (!key) {
        return NextResponse.json({ error: "缺少 key 参数" }, { status: 400 });
      }
      if (key.includes("..") || key.startsWith("/") || key.startsWith("\\")) {
        return NextResponse.json({ error: "无效的文件 key" }, { status: 400 });
      }

      const { data: fileMeta, error: metaError } = await supabase
        .from("user_files")
        .select("user_id")
        .eq("storage_key", key)
        .maybeSingle<{ user_id: string }>();

      if (metaError) {
        console.error("[File] Metadata query error:", metaError.message);
        return NextResponse.json({ error: "文件归属校验失败" }, { status: 500 });
      }
      if (!fileMeta) {
        return NextResponse.json({ error: "无权访问该文件" }, { status: 403 });
      }
      const contentAccess = await authorizeMemberContentAccess(
        request,
        { userId: user.id, role: user.role === "admin" ? "admin" : "student" },
        fileMeta.user_id,
        { requireStepUp: true, operation: "member_file_download" },
      );
      if (!contentAccess.ok) return contentAccess.response;

      const url = await getSignedUrl(key, contentAccess.delegated ? 600 : 3600);
      return NextResponse.json({ url });
    } catch (error) {
      console.error("[File] Error:", error);
      return NextResponse.json(
        { error: "获取文件地址失败" },
        { status: 500 },
      );
    }
  });
}
