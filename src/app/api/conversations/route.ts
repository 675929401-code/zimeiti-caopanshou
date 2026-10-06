// 🔒 核心底层代码 — 锁定保护
//
// 本文件是会话管理 API，代理 Coze API 创建/列表/删除会话。
// 修改此文件需要用户明确同意，详见 AGENTS.md "🔒 锁定模块清单 #13 会话管理 API"。
//
// 锁定范围：整个文件
// 锁定原因：会话管理涉及对话持久化和 Coze API 调用，修改可能导致对话丢失

import { NextRequest, NextResponse } from "next/server";
import { createConversation, listConversations } from "@/lib/coze-api";
import { authorizeAdminCapability } from "@/lib/server/admin-governance-authority";

const privateNoStore = <T extends Response>(response: T): T => {
  response.headers.set("Cache-Control", "private, no-store");
  return response;
};

export async function GET(request: NextRequest) {
  try {
    const authorization = await authorizeAdminCapability(request, "agents.view", {
      operation: "raw_conversations_read",
      requireStepUp: false,
    });
    if (!authorization.ok) return privateNoStore(authorization.response);

    const { searchParams } = new URL(request.url);
    const botId = searchParams.get("bot_id");
    if (!botId) {
      return privateNoStore(NextResponse.json({ error: "bot_id is required" }, { status: 400 }));
    }
    const pageNum = parseInt(searchParams.get("page_num") || "1");
    const pageSize = parseInt(searchParams.get("page_size") || "50");

    const result = await listConversations(botId, pageNum, pageSize);
    return privateNoStore(NextResponse.json(result));
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    const status = message.includes("valid int64") ? 400 : 500;
    return privateNoStore(NextResponse.json({ error: message }, { status }));
  }
}

export async function POST(request: NextRequest) {
  try {
    const authorization = await authorizeAdminCapability(request, "agents.manage", {
      operation: "raw_conversation_create",
      requireStepUp: true,
    });
    if (!authorization.ok) return privateNoStore(authorization.response);

    const body = await request.json();
    const { botId, name } = body;

    const result = await createConversation(botId, name);
    return privateNoStore(NextResponse.json(result));
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return privateNoStore(NextResponse.json({ error: message }, { status: 500 }));
  }
}
