// 🔒 核心底层代码 — 锁定保护
//
// 本文件是会话详情/删除 API，代理 Coze API。
// 修改此文件需要用户明确同意，详见 AGENTS.md "🔒 锁定模块清单 #13 会话管理 API"。

import { NextResponse } from "next/server";
import { deleteConversation, retrieveConversation } from "@/lib/coze-api";
import { verifyToken, getTokenFromHeaders } from "@/lib/auth";
import { getSupabaseAdminClient } from "@/storage/database/supabase-client";

/**
 * 🔒 安全加固（20260914 审计#P0-2）：会话归属校验。
 * 本地 conversations.id 即 Coze 会话 ID；无本人归属记录一律 404，
 * 防止任意登录用户凭裸 conversation_id 读取/删除他人会话。
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

export async function GET(
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
    const result = await retrieveConversation(id);
    return NextResponse.json(result);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(
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
    const result = await deleteConversation(id);
    return NextResponse.json(result);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
