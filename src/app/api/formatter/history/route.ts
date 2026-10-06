import { NextRequest, NextResponse } from "next/server";
import { authorizeCurrentApiUser } from "@/lib/current-api-user";
import { getSupabaseAdminClient } from "@/storage/database/supabase-client";
import {
  getFormatterHistoryStats,
  TEXT_HISTORY_LIMITS,
  validateHistoryRules,
  validateHistoryTitle,
  validateRequiredHistoryText,
} from "@/lib/text-history-validation";

export const dynamic = "force-dynamic";
const privateNoStore = <T extends Response>(response: T): T => {
  response.headers.set("Cache-Control", "private, no-store");
  return response;
};
const storageUnavailable = () => privateNoStore(NextResponse.json({
  error: "排版历史服务暂时不可用",
  code: "FORMATTER_HISTORY_STORAGE_UNAVAILABLE",
}, { status: 503 }));
const invalidPayload = (result: { code: string; message: string }) => privateNoStore(NextResponse.json({
  error: result.message,
  code: result.code,
}, { status: result.code.endsWith("TOO_LARGE") ? 413 : 400 }));

/* GET /api/formatter/history — 获取当前用户的历史记录 */
export async function GET(req: NextRequest) {
  const authorization = await authorizeCurrentApiUser(req);
  if (!authorization.ok) return privateNoStore(authorization.response);
  const auth = authorization.user;
  const userId = auth.userId as string;
  const supabase = getSupabaseAdminClient();
  const { data, error } = await supabase
    .from("formatter_history")
    .select("id, title, char_count, line_count, created_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(100);

  if (error) {
    console.error("[formatter-history] list failed", error.message);
    return storageUnavailable();
  }
  return privateNoStore(NextResponse.json({ records: data, history: data }));
}

/* POST /api/formatter/history — 保存一条记录 */
export async function POST(req: NextRequest) {
  const authorization = await authorizeCurrentApiUser(req);
  if (!authorization.ok) return privateNoStore(authorization.response);
  const auth = authorization.user;

  let body: unknown;
  try { body = await req.json(); } catch {
    return privateNoStore(NextResponse.json({ error: "无效请求体", code: "INVALID_JSON_BODY" }, { status: 400 }));
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return privateNoStore(NextResponse.json({ error: "无效请求体", code: "INVALID_JSON_BODY" }, { status: 400 }));
  }
  const payload = body as Record<string, unknown>;
  const title = validateHistoryTitle(payload.title);
  if (!title.ok) return invalidPayload(title);
  const originalText = validateRequiredHistoryText(payload.original_text, "原文", TEXT_HISTORY_LIMITS.originalTextChars);
  if (!originalText.ok) return invalidPayload(originalText);
  const resultText = validateRequiredHistoryText(payload.result_text, "排版结果", TEXT_HISTORY_LIMITS.resultTextChars);
  if (!resultText.ok) return invalidPayload(resultText);
  const rules = validateHistoryRules(payload.rules);
  if (!rules.ok) return invalidPayload(rules);
  const stats = getFormatterHistoryStats(resultText.value);

  const supabase = getSupabaseAdminClient();
  const { data, error } = await supabase
    .from("formatter_history")
    .insert({
      user_id: auth.userId as string,
      title: title.value,
      original_text: originalText.value,
      result_text: resultText.value,
      rules: rules.value,
      char_count: stats.charCount,
      line_count: stats.lineCount,
    })
    .select("id, title, rules, char_count, line_count, created_at")
    .single();

  if (error) {
    console.error("[formatter-history] create failed", error.message);
    return storageUnavailable();
  }
  return privateNoStore(NextResponse.json({ record: data }));
}

/* DELETE /api/formatter/history?id=xxx — 删除当前用户的记录 */
export async function DELETE(req: NextRequest) {
  const authorization = await authorizeCurrentApiUser(req);
  if (!authorization.ok) return privateNoStore(authorization.response);
  const auth = authorization.user;

  const id = req.nextUrl.searchParams.get("id");
  if (!id) return privateNoStore(NextResponse.json({ error: "缺少 id", code: "HISTORY_ID_REQUIRED" }, { status: 400 }));

  const supabase = getSupabaseAdminClient();
  // 只能删除自己的记录
  const { error } = await supabase.from("formatter_history").delete().eq("id", id).eq("user_id", auth.userId as string);
  if (error) {
    console.error("[formatter-history] delete failed", error.message);
    return storageUnavailable();
  }
  return privateNoStore(NextResponse.json({ success: true }));
}
