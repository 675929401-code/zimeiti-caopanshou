import { NextRequest, NextResponse } from "next/server";
import { authorizeCurrentApiUser } from "@/lib/current-api-user";
import { getSupabaseAdminClient } from "@/storage/database/supabase-client";

export const dynamic = "force-dynamic";
const privateNoStore = <T extends Response>(response: T): T => {
  response.headers.set("Cache-Control", "private, no-store");
  return response;
};

export async function GET(req: NextRequest) {
  const authorization = await authorizeCurrentApiUser(req);
  if (!authorization.ok) return privateNoStore(authorization.response);

  const id = req.nextUrl.searchParams.get("id")?.trim();
  if (!id) {
    return privateNoStore(NextResponse.json({
      error: "缺少 id",
      code: "HISTORY_ID_REQUIRED",
    }, { status: 400 }));
  }

  const { data, error } = await getSupabaseAdminClient()
    .from("formatter_history")
    .select("id, title, original_text, result_text, rules, char_count, line_count, created_at")
    .eq("id", id)
    .eq("user_id", authorization.user.userId as string)
    .maybeSingle();

  if (error) {
    console.error("[formatter-history] detail failed", error.message);
    return privateNoStore(NextResponse.json({
      error: "排版历史服务暂时不可用",
      code: "FORMATTER_HISTORY_STORAGE_UNAVAILABLE",
    }, { status: 503 }));
  }
  if (!data) {
    return privateNoStore(NextResponse.json({
      error: "记录不存在",
      code: "HISTORY_NOT_FOUND",
    }, { status: 404 }));
  }
  return privateNoStore(NextResponse.json({ record: data }));
}

