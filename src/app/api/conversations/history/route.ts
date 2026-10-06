import { NextRequest, NextResponse } from "next/server";
import { authorizeCurrentApiUser } from "@/lib/current-api-user";
import { getSupabaseClient } from "@/storage/database/supabase-client";

const privateNoStore = <T extends Response>(response: T): T => {
  response.headers.set("Cache-Control", "private, no-store");
  return response;
};
import {
  ConversationNotFoundError,
  ensureConversationOwnership,
  type ConversationOwnershipStore,
} from "@/lib/conversation-ownership";

const ATTACHMENT_TABLE = "conversation_message_attachments";
const MAX_ATTACHMENT_ASSETS = 20;
const SAFE_ASSET_ID = /^[A-Za-z0-9_-]{1,160}$/;
const UUID_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

interface ConversationMessageRow extends Record<string, unknown> {
  id: string;
  role: string;
  content: string;
}

function isMissingAttachmentTable(error: { code?: string; message?: string } | null | undefined): boolean {
  if (!error) return false;
  return error.code === "42P01"
    || error.code === "PGRST205"
    || /conversation_message_attachments/iu.test(error.message || "");
}

function isLegacyAttachmentMessageIdType(error: { code?: string; message?: string } | null | undefined): boolean {
  if (!error) return false;
  return error.code === "22P02" && /uuid/iu.test(error.message || "");
}

function ownedAssetContentPath(assetId: string): string {
  return `/api/storage/files/${encodeURIComponent(assetId)}/content`;
}

function storedUserText(value: string): string {
  if (!value.startsWith("[")) return value;
  try {
    const parts = JSON.parse(value) as unknown;
    if (!Array.isArray(parts)) return value;
    const textPart = parts.find((part) => (
      part && typeof part === "object"
      && (part as Record<string, unknown>).type === "text"
      && typeof (part as Record<string, unknown>).text === "string"
    )) as Record<string, unknown> | undefined;
    return typeof textPart?.text === "string" ? textPart.text : value;
  } catch {
    return value;
  }
}

async function hydrateOwnedImageAttachments(
  supabase: ReturnType<typeof getSupabaseClient>,
  userId: string,
  conversationId: string,
  messages: ConversationMessageRow[],
): Promise<ConversationMessageRow[]> {
  const normalizedMessages = messages.map((message) => message.role === "user"
    ? { ...message, content: storedUserText(message.content) }
    : message);
  const messageIds = normalizedMessages.map((message) => message.id).filter(Boolean);
  if (messageIds.length === 0) return normalizedMessages;

  const attachmentRows: Array<{ message_id: string; asset_id: string; created_at: string }> = [];
  for (let index = 0; index < messageIds.length; index += 100) {
    const messageIdChunk = messageIds.slice(index, index + 100);
    const readChunk = (ids: string[]) => supabase
        .from(ATTACHMENT_TABLE)
        .select("message_id, asset_id, created_at")
        .eq("user_id", userId)
        .eq("conversation_id", conversationId)
        .in("message_id", ids)
        .order("created_at", { ascending: true });
    let result = await readChunk(messageIdChunk);
    if (isLegacyAttachmentMessageIdType(result.error)) {
      const uuidMessageIds = messageIdChunk.filter((id) => UUID_ID.test(id));
      if (uuidMessageIds.length === 0) continue;
      result = await readChunk(uuidMessageIds);
    }
    if (result.error) {
      if (isMissingAttachmentTable(result.error)) {
        console.warn("[conversation-history] attachment migration is not ready");
        return normalizedMessages;
      }
      throw result.error;
    }
    attachmentRows.push(...((result.data || []) as typeof attachmentRows));
  }

  const referencedAssetIds = [...new Set(attachmentRows.map((row) => row.asset_id))];
  if (referencedAssetIds.length === 0) return normalizedMessages;
  const ownedFiles = await supabase
    .from("user_files")
    .select("id, file_category")
    .eq("user_id", userId)
    .eq("file_category", "image")
    .in("id", referencedAssetIds);
  if (ownedFiles.error) throw ownedFiles.error;
  const ownedAssetIds = new Set((ownedFiles.data || []).map((file: { id: string }) => String(file.id)));
  const assetsByMessage = new Map<string, string[]>();
  for (const row of attachmentRows) {
    if (!ownedAssetIds.has(row.asset_id)) continue;
    const current = assetsByMessage.get(row.message_id) || [];
    if (!current.includes(row.asset_id)) current.push(row.asset_id);
    assetsByMessage.set(row.message_id, current);
  }

  return normalizedMessages.map((message) => {
    const assetIds = assetsByMessage.get(message.id) || [];
    if (assetIds.length === 0) return message;
    return {
      ...message,
      attachment_asset_ids: assetIds,
      images: assetIds.map(ownedAssetContentPath),
    };
  });
}

async function saveOwnedImageAttachments(
  supabase: ReturnType<typeof getSupabaseClient>,
  userId: string,
  value: unknown,
): Promise<NextResponse> {
  if (!value || typeof value !== "object") {
    return NextResponse.json({ error: "附件历史数据无效" }, { status: 400 });
  }
  const record = value as Record<string, unknown>;
  const conversationId = typeof record.conversationId === "string" ? record.conversationId.trim() : "";
  const messageContent = typeof record.messageContent === "string" ? record.messageContent : "";
  const assetIds = Array.isArray(record.assetIds)
    ? [...new Set(record.assetIds.filter((item): item is string => typeof item === "string").map((item) => item.trim()))]
    : [];
  if (!conversationId || conversationId.length > 200 || !messageContent || messageContent.length > 500_000) {
    return NextResponse.json({ error: "会话或消息内容无效" }, { status: 400 });
  }
  if (assetIds.length === 0 || assetIds.length > MAX_ATTACHMENT_ASSETS || assetIds.some((id) => !SAFE_ASSET_ID.test(id))) {
    return NextResponse.json({ error: "图片资产编号无效" }, { status: 400 });
  }

  const ownedConversation = await supabase
    .from("conversations")
    .select("id")
    .eq("id", conversationId)
    .eq("user_id", userId)
    .maybeSingle();
  if (ownedConversation.error) throw ownedConversation.error;
  if (!ownedConversation.data) {
    return NextResponse.json({ error: "会话不存在或无权限", code: "CONVERSATION_NOT_FOUND" }, { status: 404 });
  }

  const ownedFiles = await supabase
    .from("user_files")
    .select("id, file_category")
    .eq("user_id", userId)
    .eq("file_category", "image")
    .in("id", assetIds);
  if (ownedFiles.error) throw ownedFiles.error;
  const confirmedAssetIds = new Set((ownedFiles.data || []).map((file: { id: string }) => String(file.id)));
  if (confirmedAssetIds.size !== assetIds.length || assetIds.some((id) => !confirmedAssetIds.has(id))) {
    return NextResponse.json({ error: "图片资产不存在或不属于当前用户", code: "ATTACHMENT_OWNERSHIP_FAILED" }, { status: 403 });
  }

  const recentMessages = await supabase
    .from("conversation_messages")
    .select("id, content, created_at")
    .eq("conversation_id", conversationId)
    .eq("user_id", userId)
    .eq("role", "user")
    .order("created_at", { ascending: false })
    .limit(20);
  if (recentMessages.error) throw recentMessages.error;
  const message = (recentMessages.data || []).find((item: { content?: string }) => (
    typeof item.content === "string" && storedUserText(item.content) === messageContent
  ));
  if (!message?.id) {
    return NextResponse.json(
      { error: "消息尚未写入历史，请重试", code: "ATTACHMENT_MESSAGE_NOT_READY" },
      { status: 409 },
    );
  }

  const saveResult = await supabase.from(ATTACHMENT_TABLE).upsert(
    assetIds.map((assetId) => ({
      user_id: userId,
      conversation_id: conversationId,
      message_id: message.id,
      asset_id: assetId,
    })),
    { onConflict: "message_id,asset_id", ignoreDuplicates: true },
  );
  if (saveResult.error) {
    if (isMissingAttachmentTable(saveResult.error)) {
      return NextResponse.json(
        { error: "附件历史迁移尚未部署", code: "ATTACHMENT_MIGRATION_NOT_READY" },
        { status: 503 },
      );
    }
    if (isLegacyAttachmentMessageIdType(saveResult.error)) {
      return NextResponse.json(
        { error: "附件历史结构正在升级，请稍后重试", code: "ATTACHMENT_MIGRATION_NOT_READY" },
        { status: 503 },
      );
    }
    throw saveResult.error;
  }

  return NextResponse.json({
    success: true,
    messageId: message.id,
    assetIds,
    images: assetIds.map(ownedAssetContentPath),
  });
}

export async function GET(request: NextRequest) {
  try {
    const authorization = await authorizeCurrentApiUser(request);
    if (!authorization.ok) return privateNoStore(authorization.response);
    const userId = authorization.user.id;

    const singleConvId = request.nextUrl.searchParams.get("id");

    try {
      const supabase = getSupabaseClient();
      if (singleConvId) {
        const { data: conv, error: convError } = await supabase
          .from("conversations")
          .select("id, user_id, agent_id, title, source, created_at, updated_at")
          .eq("id", singleConvId)
          .eq("user_id", userId)
          .maybeSingle();

        if (convError) throw convError;
        if (!conv) {
          return privateNoStore(NextResponse.json(
            { error: "会话不存在或无权限", code: "CONVERSATION_NOT_FOUND" },
            { status: 404 },
          ));
        }

        const { data: messages, error: messagesError } = await supabase
          .from("conversation_messages")
          .select("id, role, content, reasoning_content, agent_id, created_at")
          .eq("conversation_id", singleConvId)
          .eq("user_id", userId)
          .order("created_at", { ascending: true });
        if (messagesError) throw messagesError;

        const hydratedMessages = await hydrateOwnedImageAttachments(
          supabase,
          userId,
          singleConvId,
          (messages || []) as ConversationMessageRow[],
        );

        return privateNoStore(NextResponse.json({ conversation: { ...conv, messages: hydratedMessages } }));
      }

      const { data: conversations, error: convError } = await supabase
        .from("conversations")
        .select("id, user_id, agent_id, title, source, created_at, updated_at")
        .eq("user_id", userId)
        .order("updated_at", { ascending: false })
        .limit(200);

      if (convError) throw convError;
      if (!conversations?.length) return privateNoStore(NextResponse.json({ conversations: [] }));

      const convIds = conversations.map((conversation: { id: string }) => conversation.id);
      const lastMessages: Array<{ conversation_id: string; content: string; role: string; created_at: string }> = [];
      const chunkSize = 40;
      for (let index = 0; index < convIds.length; index += chunkSize) {
        const chunk = convIds.slice(index, index + chunkSize);
        const { data, error } = await supabase
          .from("conversation_messages")
          .select("conversation_id, content, role, created_at")
          .in("conversation_id", chunk)
          .eq("user_id", userId)
          .eq("role", "assistant")
          .order("created_at", { ascending: false });

        if (error) {
          console.warn("[conversation-history] last message chunk failed:", error.message);
          continue;
        }
        lastMessages.push(...(data || []));
      }

      const lastMsgMap = new Map<string, { content: string; role: string }>();
      for (const message of lastMessages) {
        if (!lastMsgMap.has(message.conversation_id)) {
          lastMsgMap.set(message.conversation_id, { content: message.content || "", role: message.role });
        }
      }

      return privateNoStore(NextResponse.json({
        conversations: conversations.map((conversation: Record<string, unknown>) => {
          const lastMessage = lastMsgMap.get(conversation.id as string);
          return {
            id: conversation.id,
            user_id: conversation.user_id,
            agent_id: conversation.agent_id,
            title: conversation.title,
            source: conversation.source,
            created_at: conversation.created_at,
            updated_at: conversation.updated_at,
            last_message: lastMessage?.content ? lastMessage.content.slice(0, 100) : "",
            last_message_role: lastMessage?.role || "",
            messages: [],
          };
        }).filter((conversation: { last_message: string }) => conversation.last_message.trim()),
      }));
    } catch (dbError) {
      console.error("[conversation-history] Supabase data source unavailable:", dbError);
      return privateNoStore(NextResponse.json({ error: "Realtime conversation data unavailable" }, { status: 503 }));
    }
  } catch (error) {
    console.error("[conversation-history] Error:", error);
    return privateNoStore(NextResponse.json({ error: "服务器错误" }, { status: 500 }));
  }
}

export async function POST(request: NextRequest) {
  try {
    const authorization = await authorizeCurrentApiUser(request);
    if (!authorization.ok) return authorization.response;
    const userId = authorization.user.id;

    const supabase = getSupabaseClient();
    const body = await request.json();

    if (body?.attachmentHistory !== undefined) {
      return await saveOwnedImageAttachments(supabase, userId, body.attachmentHistory);
    }

    const convsToSave = Array.isArray(body.conversations)
      ? body.conversations
      : body.conversation
        ? [body.conversation]
        : null;

    if (!convsToSave) {
      return NextResponse.json({ error: "缺少会话数据" }, { status: 400 });
    }

    const saveResults = await Promise.allSettled(
      convsToSave.map(async (conversation: { id: string; agentId: string; title: string; source: string }) => {
        if (!conversation?.id) return;
        const ownershipStore: ConversationOwnershipStore = {
          async getOwner(conversationId: string) {
            const { data, error } = await supabase
              .from("conversations")
              .select("user_id")
              .eq("id", conversationId)
              .maybeSingle();
            if (error) throw error;
            return data?.user_id ? String(data.user_id) : null;
          },
          async create(conversationId: string, ownerId: string) {
            const { error } = await supabase.from("conversations").insert({
              id: conversationId,
              user_id: ownerId,
              agent_id: conversation.agentId || "unknown",
              title: conversation.title || "",
              source: conversation.source || "llm",
            });
            if (!error) return "created";
            if (error.code === "23505") return "conflict";
            throw error;
          },
        };
        await ensureConversationOwnership(ownershipStore, conversation.id, userId);
        await supabase
          .from("conversations")
          .update({
            agent_id: conversation.agentId || "unknown",
            title: conversation.title || "",
            source: conversation.source || "llm",
          })
          .eq("id", conversation.id)
          .eq("user_id", userId);
      })
    );
    const failedSave = saveResults.find((result) => result.status === "rejected");
    if (failedSave?.status === "rejected") {
      if (failedSave.reason instanceof ConversationNotFoundError) {
        return NextResponse.json({ error: "会话不存在或无权限" }, { status: 404 });
      }
      throw failedSave.reason;
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("[conversation-history] POST error:", error);
    return NextResponse.json({ error: "服务器错误" }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const authorization = await authorizeCurrentApiUser(request);
    if (!authorization.ok) return authorization.response;
    const userId = authorization.user.id;

    const id = request.nextUrl.searchParams.get("id");
    if (!id) {
      return NextResponse.json({ error: "缺少会话ID" }, { status: 400 });
    }

    const supabase = getSupabaseClient();
    const { data: ownedConversation, error: ownershipError } = await supabase
      .from("conversations")
      .select("id")
      .eq("id", id)
      .eq("user_id", userId)
      .maybeSingle();

    if (ownershipError) {
      console.error("[conversation-history] Ownership check error:", ownershipError);
      return NextResponse.json({ error: "删除失败" }, { status: 500 });
    }

    if (!ownedConversation) {
      return NextResponse.json({ error: "会话不存在或无权限" }, { status: 404 });
    }

    await supabase.from("conversation_messages").delete().eq("conversation_id", id).eq("user_id", userId);
    const { error } = await supabase.from("conversations").delete().eq("id", id).eq("user_id", userId);

    if (error) {
      console.error("[conversation-history] Delete error:", error);
      return NextResponse.json({ error: "删除失败" }, { status: 500 });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("[conversation-history] Delete error:", error);
    return NextResponse.json({ error: "服务器错误" }, { status: 500 });
  }
}
