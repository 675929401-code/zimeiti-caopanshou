// 🔒 核心底层代码 — 锁定保护
//
// 本文件是消息列表查询 API，代理 Coze API。
// 修改此文件需要用户明确同意，详见 AGENTS.md "🔒 锁定模块清单 #13 会话管理 API"。
//
// 锁定范围：整个文件
// 锁定原因：消息查询涉及 Coze API 调用和对话历史展示

import { NextResponse } from "next/server";
import { listMessages } from "@/lib/coze-api";
import { verifyToken, getTokenFromHeaders } from "@/lib/auth";
import { getSupabaseAdminClient } from "@/storage/database/supabase-client";

/**
 * 🔒 安全加固（20260914 审计#P0-2）：会话归属校验，防越权读取他人消息。
 */
async function assertConversationOwner(conversationId: string, userId: string): Promise<boolean> {
  const db = getSupabaseAdminClient();
  const { data, error } = await db
    .from("conversations")
    .select("id")
    .eq("id", conversationId)
    .eq("user_id", userId)
    .limit(1);
  if (error) return false;
  return Array.isArray(data) && data.length > 0;
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    // 🔒 安全修复：添加认证检查
    const token = getTokenFromHeaders(request.headers);
    if (!token) {
      return NextResponse.json({ error: "未授权访问" }, { status: 401 });
    }
    const user = await verifyToken(token);
    if (!user?.userId) {
      return NextResponse.json({ error: "未授权访问" }, { status: 401 });
    }

    const { id } = await params;
    if (!(await assertConversationOwner(id, user.userId))) {
      return NextResponse.json({ error: "会话不存在" }, { status: 404 });
    }
    const body = await request.json();
    const chatId = body.chat_id as string | undefined;
    const limit = parseInt(body.limit || "50");
    const order = (body.order || "asc") as "asc" | "desc";

    // listMessages now only takes conversationId, pass extra params via body
    const result = await listMessages(id);
    
    // If the Coze API supports pagination, filter client-side for now
    // The API returns all messages for the conversation
    let messages = result?.data || [];
    
    // Filter by chat_id if provided
    if (chatId) {
      messages = messages.filter((m: { chat_id?: string }) => m.chat_id === chatId);
    }
    
    // Sort
    if (order === "desc") {
      messages = messages.reverse();
    }
    
    // Limit
    if (limit && messages.length > limit) {
      messages = messages.slice(-limit);
    }

    return NextResponse.json({ ...result, data: messages });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
