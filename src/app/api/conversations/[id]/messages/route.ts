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

const ATTACHMENT_TABLE = "conversation_message_attachments";

function isMissingAttachmentTable(error: { code?: string; message?: string } | null | undefined): boolean {
  return Boolean(error && (
    error.code === "42P01"
    || error.code === "PGRST205"
    || /conversation_message_attachments/iu.test(error.message || "")
  ));
}

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

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const token = getTokenFromHeaders(request.headers);
    if (!token) return NextResponse.json({ error: "未授权访问", code: "UNAUTHORIZED" }, { status: 401 });
    const user = await verifyToken(token);
    if (!user?.userId) return NextResponse.json({ error: "未授权访问", code: "UNAUTHORIZED" }, { status: 401 });

    const { id: conversationId } = await params;
    if (!conversationId || conversationId.length > 200) {
      return NextResponse.json({ error: "会话标识无效", code: "CONVERSATION_ID_INVALID" }, { status: 400 });
    }
    let body: unknown = {};
    try { body = await request.json(); } catch { /* query parameter fallback */ }
    const bodyRecord = body && typeof body === "object" && !Array.isArray(body)
      ? body as Record<string, unknown>
      : {};
    const url = new URL(request.url);
    const messageId = typeof bodyRecord.messageId === "string"
      ? bodyRecord.messageId.trim()
      : typeof bodyRecord.message_id === "string"
        ? bodyRecord.message_id.trim()
        : (url.searchParams.get("messageId") || url.searchParams.get("message_id") || "").trim();
    if (!messageId || messageId.length > 200 || /[\u0000-\u001f]/u.test(messageId)) {
      return NextResponse.json({ error: "消息标识无效", code: "MESSAGE_ID_INVALID" }, { status: 400 });
    }

    const db = getSupabaseAdminClient();
    const ownership = await db
      .from("conversations")
      .select("id")
      .eq("id", conversationId)
      .eq("user_id", user.userId)
      .maybeSingle();
    if (ownership.error) throw ownership.error;
    if (!ownership.data) {
      return NextResponse.json({ error: "会话不存在或无权限", code: "CONVERSATION_NOT_FOUND" }, { status: 404 });
    }

    const attachmentDelete = await db
      .from(ATTACHMENT_TABLE)
      .delete()
      .eq("conversation_id", conversationId)
      .eq("message_id", messageId)
      .eq("user_id", user.userId);
    if (attachmentDelete.error && !isMissingAttachmentTable(attachmentDelete.error)) throw attachmentDelete.error;

    const deleted = await db
      .from("conversation_messages")
      .delete()
      .eq("id", messageId)
      .eq("conversation_id", conversationId)
      .eq("user_id", user.userId)
      .select("id")
      .maybeSingle();
    if (deleted.error) throw deleted.error;
    if (!deleted.data) {
      return NextResponse.json({ error: "消息不存在或无权限", code: "MESSAGE_NOT_FOUND" }, { status: 404 });
    }
    return NextResponse.json({ success: true, messageId });
  } catch (error: unknown) {
    console.error("[conversation-messages] DELETE error:", error);
    return NextResponse.json({ error: "消息删除失败", code: "MESSAGE_DELETE_FAILED", retryable: true }, { status: 500 });
  }
}
