import { NextRequest, NextResponse } from "next/server";
import {
  authorizeTextChatControlRequest,
  getTextChatPaidToolAuthorization,
  parseTextChatJson,
  requireOwnedTextChatConversation,
  TextChatAuthorizationMutationSchema,
  textChatControlErrorResponse,
} from "@/lib/text-chat-controls";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{ id: string }>;
}

async function readConversationId(context: RouteContext): Promise<string> {
  return decodeURIComponent((await context.params).id || "");
}

export async function GET(request: NextRequest, context: RouteContext) {
  try {
    const { db, userId } = await authorizeTextChatControlRequest(request);
    const conversationId = await readConversationId(context);
    const conversation = await requireOwnedTextChatConversation(db, userId, conversationId);
    const paidToolAuthorizationEnabled = await getTextChatPaidToolAuthorization(db, userId, conversationId);
    return NextResponse.json({
      success: true,
      conversation: { ...conversation, paidToolAuthorizationEnabled },
    });
  } catch (error) {
    return textChatControlErrorResponse(error, "conversation:get");
  }
}

export async function PATCH(request: NextRequest, context: RouteContext) {
  try {
    const { db, userId } = await authorizeTextChatControlRequest(request);
    const conversationId = await readConversationId(context);
    const conversation = await requireOwnedTextChatConversation(db, userId, conversationId);
    const input = await parseTextChatJson(request, TextChatAuthorizationMutationSchema);
    const now = new Date().toISOString();
    const { data, error } = await db
      .from("text_chat_conversation_settings")
      .upsert({
        user_id: userId,
        conversation_id: conversationId,
        paid_tool_authorization_enabled: input.paidToolAuthorizationEnabled,
        updated_at: now,
      }, { onConflict: "user_id,conversation_id" })
      .select("paid_tool_authorization_enabled, updated_at")
      .single();
    if (error) throw error;
    return NextResponse.json({
      success: true,
      conversation: {
        ...conversation,
        paidToolAuthorizationEnabled: data.paid_tool_authorization_enabled === true,
        updatedAt: data.updated_at,
      },
    });
  } catch (error) {
    return textChatControlErrorResponse(error, "conversation:update");
  }
}
