import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getTokenFromHeaders, verifyToken } from "@/lib/auth";
import { getSupabaseClient } from "@/storage/database/supabase-client";

export const TEXT_CHAT_CONTROLS_SCHEMA_VERSION = "20260825062000";
export const TEXT_CHAT_MEMORY_MAX_LENGTH = 2_000;

export const TextChatMemoryMutationSchema = z.object({
  id: z.string().uuid(),
  content: z.string().trim().min(1).max(TEXT_CHAT_MEMORY_MAX_LENGTH),
}).strict();

export const TextChatAuthorizationMutationSchema = z.object({
  paidToolAuthorizationEnabled: z.boolean(),
}).strict();

export class TextChatControlError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "TextChatControlError";
  }
}

export interface TextChatControlAuth {
  readonly userId: string;
  readonly db: ReturnType<typeof getSupabaseClient>;
}

export async function authorizeTextChatControlRequest(
  request: NextRequest,
): Promise<TextChatControlAuth> {
  const token = getTokenFromHeaders(request.headers);
  if (!token) {
    throw new TextChatControlError(401, "UNAUTHENTICATED", "请先登录当前漫剧工作台账号");
  }
  const payload = await verifyToken(token);
  if (!payload?.userId) {
    throw new TextChatControlError(401, "UNAUTHENTICATED", "登录已过期，请重新登录");
  }
  return { userId: payload.userId, db: getSupabaseClient() };
}

export async function parseTextChatJson<T extends z.ZodType>(
  request: NextRequest,
  schema: T,
): Promise<z.output<T>> {
  let input: unknown;
  try {
    input = await request.json();
  } catch {
    throw new TextChatControlError(400, "INVALID_JSON", "请求正文必须是有效 JSON");
  }
  return schema.parse(input);
}

export async function requireOwnedTextChatConversation(
  db: ReturnType<typeof getSupabaseClient>,
  userId: string,
  conversationId: string,
): Promise<{ id: string; title: string }> {
  if (!conversationId || conversationId.length > 200) {
    throw new TextChatControlError(400, "INVALID_CONVERSATION_ID", "会话 ID 不符合要求");
  }
  const { data, error } = await db
    .from("conversations")
    .select("id, title")
    .eq("id", conversationId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  if (!data) {
    throw new TextChatControlError(404, "CONVERSATION_NOT_FOUND", "会话不存在或无权限");
  }
  return { id: String(data.id), title: String(data.title || "新对话") };
}

export async function getTextChatPaidToolAuthorization(
  db: ReturnType<typeof getSupabaseClient>,
  userId: string,
  conversationId: string,
): Promise<boolean> {
  await requireOwnedTextChatConversation(db, userId, conversationId);
  const { data, error } = await db
    .from("text_chat_conversation_settings")
    .select("paid_tool_authorization_enabled")
    .eq("user_id", userId)
    .eq("conversation_id", conversationId)
    .maybeSingle();
  if (error) throw error;
  return data?.paid_tool_authorization_enabled === true;
}

function isMissingSchemaError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const record = error as Record<string, unknown>;
  const code = typeof record.code === "string" ? record.code : "";
  const message = typeof record.message === "string" ? record.message : "";
  return code === "PGRST205" || code === "42P01" || /schema cache|does not exist|could not find the table/iu.test(message);
}

export function textChatControlErrorResponse(error: unknown, routeTag: string): NextResponse {
  if (error instanceof TextChatControlError) {
    return NextResponse.json(
      { success: false, error: error.message, code: error.code },
      { status: error.status },
    );
  }
  if (error instanceof z.ZodError) {
    return NextResponse.json(
      {
        success: false,
        error: "请求参数不符合要求",
        code: "VALIDATION_ERROR",
        issues: error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      },
      { status: 400 },
    );
  }
  if (isMissingSchemaError(error)) {
    return NextResponse.json(
      {
        success: false,
        error: "Agent 控制服务正在准备中，请稍后重试",
        code: "MIGRATION_NOT_READY",
      },
      { status: 503 },
    );
  }
  console.error(`[text-chat-controls:${routeTag}] unavailable`, error instanceof Error ? error.name : typeof error);
  return NextResponse.json(
    { success: false, error: "Agent 控制服务暂时不可用", code: "TEXT_CHAT_CONTROL_UNAVAILABLE" },
    { status: 503 },
  );
}

export function getWeixinBindingAvailability(): {
  readonly enabled: false;
  readonly providerConfigured: boolean;
  readonly reason: string;
} {
  const providerConfigured = Boolean(
    process.env.YOUCAI_WEIXIN_BINDING_SERVICE_URL?.trim()
    && process.env.YOUCAI_WEIXIN_BINDING_SERVICE_TOKEN?.trim(),
  );
  return {
    enabled: false,
    providerConfigured,
    reason: providerConfigured
      ? "微信服务参数已配置，但当前版本未安装经验证的提供方适配器"
      : "当前部署未配置微信绑定服务；不会生成模拟二维码或伪造已绑定状态",
  };
}

export function weixinBindingDisabledResponse(): NextResponse {
  const availability = getWeixinBindingAvailability();
  return NextResponse.json(
    {
      success: false,
      error: availability.reason,
      code: "WEIXIN_BINDING_DISABLED",
      enabled: false,
    },
    { status: 503 },
  );
}
