import { NextRequest, NextResponse } from "next/server";
import { authorizeCurrentApiUser } from "@/lib/current-api-user";
import { getSupabaseAdminClient } from "@/storage/database/supabase-client";
import {
  getSegmenterHistoryStats,
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
  error: "分段历史服务暂时不可用",
  code: "SEGMENTER_HISTORY_STORAGE_UNAVAILABLE",
}, { status: 503 }));
const invalidPayload = (result: { code: string; message: string }) => privateNoStore(NextResponse.json({
  error: result.message,
  code: result.code,
  ...(result.code === "SEMANTIC_FALLBACK_NOT_SUCCESS_HISTORY" ? { retrySafe: true } : {}),
}, { status: result.code.endsWith("TOO_LARGE") ? 413 : result.code === "SEMANTIC_FALLBACK_NOT_SUCCESS_HISTORY" ? 409 : 400 }));
const allowedModes = new Set(["分段8秒", "分段10秒", "分段12秒", "分段15秒", "分段16秒", "分段20秒", "分段25秒"]);

/* GET /api/segmenter/history — 获取当前用户的分段历史 */
export async function GET(req: NextRequest) {
  const authorization = await authorizeCurrentApiUser(req);
  if (!authorization.ok) return privateNoStore(authorization.response);
  const auth = authorization.user;
  const userId = auth.userId as string;
  const supabase = getSupabaseAdminClient();
  const { data, error } = await supabase
    .from("segmenter_history")
    .select("id, title, mode, char_count, segment_count, created_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(100);

  if (error) {
    console.error("[segmenter-history] list failed", error.message);
    return storageUnavailable();
  }
  return privateNoStore(NextResponse.json({ history: data }));
}

/* POST /api/segmenter/history — 保存一条记录 */
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
  const resultText = validateRequiredHistoryText(payload.result_text, "分段结果", TEXT_HISTORY_LIMITS.resultTextChars);
  if (!resultText.ok) return invalidPayload(resultText);
  const rules = validateHistoryRules(payload.rules);
  if (!rules.ok) return invalidPayload(rules);
  const mode = typeof payload.mode === "string" ? payload.mode : "";
  if (!allowedModes.has(mode)) return invalidPayload({ code: "HISTORY_MODE_INVALID", message: "分段模式不正确" });
  const stats = getSegmenterHistoryStats(originalText.value, resultText.value);
  if (!stats.ok) return invalidPayload(stats);

  const supabase = getSupabaseAdminClient();
  const { data, error } = await supabase
    .from("segmenter_history")
    .insert({
      user_id: auth.userId as string,
      title: title.value,
      original_text: originalText.value,
      result_text: resultText.value,
      mode,
      rules: rules.value,
      char_count: stats.value.charCount,
      segment_count: stats.value.segmentCount,
    })
    .select("id, title, mode, char_count, segment_count, created_at")
    .single();

  if (error) {
    console.error("[segmenter-history] create failed", error.message);
    return storageUnavailable();
  }
  return privateNoStore(NextResponse.json({ record: data }));
}

/* DELETE /api/segmenter/history?id=xxx — 删除当前用户的记录 */
export async function DELETE(req: NextRequest) {
  const authorization = await authorizeCurrentApiUser(req);
  if (!authorization.ok) return privateNoStore(authorization.response);
  const auth = authorization.user;

  const id = req.nextUrl.searchParams.get("id");
  if (!id) return privateNoStore(NextResponse.json({ error: "缺少 id", code: "HISTORY_ID_REQUIRED" }, { status: 400 }));

  const supabase = getSupabaseAdminClient();
  // 只能删除自己的记录
  const { error } = await supabase.from("segmenter_history").delete().eq("id", id).eq("user_id", auth.userId as string);
  if (error) {
    console.error("[segmenter-history] delete failed", error.message);
    return storageUnavailable();
  }
  return privateNoStore(NextResponse.json({ success: true }));
}
