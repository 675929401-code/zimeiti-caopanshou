import { NextRequest, NextResponse } from "next/server";
import {
  authorizeTextChatControlRequest,
  parseTextChatJson,
  TextChatControlError,
  TextChatMemoryMutationSchema,
  textChatControlErrorResponse,
} from "@/lib/text-chat-controls";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MEMORY_COLUMNS = "id, content, created_at, updated_at";

function toMemory(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    content: String(row.content || ""),
    createdAt: typeof row.created_at === "string" ? row.created_at : undefined,
    updatedAt: typeof row.updated_at === "string" ? row.updated_at : undefined,
  };
}

export async function GET(request: NextRequest) {
  try {
    const { db, userId } = await authorizeTextChatControlRequest(request);
    const { data, error } = await db
      .from("text_chat_memories")
      .select(MEMORY_COLUMNS)
      .eq("user_id", userId)
      .order("updated_at", { ascending: false })
      .limit(100);
    if (error) throw error;
    return NextResponse.json({ success: true, memories: (data || []).map(toMemory) });
  } catch (error) {
    return textChatControlErrorResponse(error, "memories:get");
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const { db, userId } = await authorizeTextChatControlRequest(request);
    const input = await parseTextChatJson(request, TextChatMemoryMutationSchema);
    const { data, error } = await db
      .from("text_chat_memories")
      .update({ content: input.content, updated_at: new Date().toISOString() })
      .eq("id", input.id)
      .eq("user_id", userId)
      .select(MEMORY_COLUMNS)
      .maybeSingle();
    if (error) throw error;
    if (!data) throw new TextChatControlError(404, "MEMORY_NOT_FOUND", "记忆不存在或无权限");
    return NextResponse.json({ success: true, memory: toMemory(data) });
  } catch (error) {
    return textChatControlErrorResponse(error, "memories:update");
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const { db, userId } = await authorizeTextChatControlRequest(request);
    const deleteAll = request.nextUrl.searchParams.get("all") === "true";
    const id = request.nextUrl.searchParams.get("id") || "";
    if (!deleteAll && !id) {
      throw new TextChatControlError(400, "MEMORY_ID_REQUIRED", "请提供要删除的记忆 ID");
    }

    let query = db.from("text_chat_memories").delete().eq("user_id", userId);
    if (!deleteAll) query = query.eq("id", id);
    const { data, error } = await query.select("id");
    if (error) throw error;
    if (!deleteAll && (!data || data.length === 0)) {
      throw new TextChatControlError(404, "MEMORY_NOT_FOUND", "记忆不存在或无权限");
    }
    return NextResponse.json({ success: true, deletedCount: data?.length || 0 });
  } catch (error) {
    return textChatControlErrorResponse(error, "memories:delete");
  }
}
