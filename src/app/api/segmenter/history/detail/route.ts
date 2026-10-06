import { NextRequest, NextResponse } from "next/server";
import { authorizeCurrentApiUser } from "@/lib/current-api-user";
import { getSupabaseAdminClient } from "@/storage/database/supabase-client";

export const dynamic = "force-dynamic";
const privateNoStore = <T extends Response>(response: T): T => {
  response.headers.set("Cache-Control", "private, no-store");
  return response;
};
const storageUnavailable = () => privateNoStore(NextResponse.json({
  error: "分段历史服务暂时不可用",
  code: "SEGMENTER_HISTORY_STORAGE_UNAVAILABLE",
}, { status: 503 }));

/* GET /api/segmenter/history/detail?id=xxx — 获取当前用户的记录详情 */
export async function GET(req: NextRequest) {
  const authorization = await authorizeCurrentApiUser(req);
  if (!authorization.ok) return privateNoStore(authorization.response);
  const auth = authorization.user;

  const id = req.nextUrl.searchParams.get("id");
  if (!id) {
    return privateNoStore(NextResponse.json({ error: "缺少 id", code: "HISTORY_ID_REQUIRED" }, { status: 400 }));
  }

  const supabase = getSupabaseAdminClient();
  const { data, error } = await supabase
    .from("segmenter_history")
    .select("id, title, original_text, result_text, mode, rules, char_count, segment_count, created_at")
    .eq("id", id)
    .eq("user_id", auth.userId as string)
    .maybeSingle();

  if (error) {
    console.error("[segmenter-history] detail failed", error.message);
    return storageUnavailable();
  }
  if (!data) {
    return privateNoStore(NextResponse.json({ error: "记录不存在", code: "HISTORY_NOT_FOUND" }, { status: 404 }));
  }

  return privateNoStore(NextResponse.json({ record: data }));
}
