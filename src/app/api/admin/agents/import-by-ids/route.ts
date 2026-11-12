import { NextRequest, NextResponse } from "next/server";
import { getTokenFromHeaders } from "@/lib/auth";
import { verifyAdminToken } from "@/lib/admin-auth";
import { getBotInfo, clearCozeConfigCache } from "@/lib/coze-api";
import { getSupabaseClient } from "@/storage/database/supabase-client";
import { scheduleAutoAvatarForCreatedAgents } from "@/lib/auto-avatar/schedule";

/**
 * POST /api/admin/agents/import-by-ids
 * Batch import agents by providing an array of Bot IDs
 * System auto-fetches name/description/icon from Coze API for each ID
 * Body: { bot_ids: string[], category?: string }
 * Returns: { imported: number, skipped: number, failed: number, details: [...] }
 */
export async function POST(request: NextRequest) {
  const token = getTokenFromHeaders(request.headers);
  if (!token) return NextResponse.json({ error: "未授权" }, { status: 401 });
  const payload = await verifyAdminToken(token);
  if (!payload || payload.role !== "admin") return NextResponse.json({ error: "需要管理员权限" }, { status: 403 });

  try {
    const body = await request.json();
    const botIds: string[] = body.bot_ids;
    const category = body.category || "其他";
    const customNames: Record<string, string> = body.names || {};

    if (!Array.isArray(botIds) || botIds.length === 0) {
      return NextResponse.json({ error: "请提供至少一个 Bot ID" }, { status: 400 });
    }

    // Clear cache to use latest config
    clearCozeConfigCache();

    const client = getSupabaseClient();

    // Get max sort_order
    const { data: maxSort } = await client
      .from("agents")
      .select("sort_order")
      .order("sort_order", { ascending: false })
      .limit(1);

    let nextSort = (maxSort?.[0]?.sort_order || 0) + 10;

    const imported: Array<{ bot_id: string; name: string }> = [];
    const skipped: Array<{ bot_id: string; reason: string }> = [];
    const failed: Array<{ bot_id: string; reason: string }> = [];
    const createdAgents: Array<{ agentId: string; name: string; description: string; avatar: string | null }> = [];

    for (const botId of botIds) {
      const trimmedId = botId.trim();
      if (!trimmedId) continue;

      // Check if already imported
      const { data: existing } = await client
        .from("agents")
        .select("id")
        .eq("bot_id", trimmedId)
        .eq("source", "coze")
        .maybeSingle();

      if (existing) {
        skipped.push({ bot_id: trimmedId, reason: "已存在" });
        continue;
      }

      // Try to fetch bot info from Coze
      // Use custom name if provided, otherwise try API fetch
      let name = customNames[trimmedId] || `智能体 ${trimmedId.substring(0, 8)}`;
      let description = "";
      let iconUrl = "";

      // Only try API fetch if no custom name provided
      if (!customNames[trimmedId]) {
        try {
          const result = await getBotInfo(trimmedId);
          const botData = result.data || result;
          name = botData.bot_name || botData.name || name;
          description = botData.description || "";
          iconUrl = botData.icon_url || botData.avatar_url || "";
        } catch {
          // Failed to fetch info, use placeholder name
          console.warn(`Failed to fetch bot info for ${trimmedId}, using placeholder name`);
        }
      }

      // Insert agent
      const { data: created, error } = await client.from("agents").insert({
        name,
        description,
        source: "coze",
        bot_id: trimmedId,
        avatar: iconUrl,
        category,
        sort_order: nextSort,
        cost_per_message: 0,
        is_active: true,
      }).select("id,name,description,avatar").single();

      if (!error && created) {
        imported.push({ bot_id: trimmedId, name });
        createdAgents.push({
          agentId: String(created.id),
          name: String(created.name || name),
          description: String(created.description || description || ""),
          avatar: created.avatar as string | null,
        });
        nextSort += 10;
      } else {
        failed.push({ bot_id: trimmedId, reason: error?.message || "插入失败" });
      }
    }

    scheduleAutoAvatarForCreatedAgents(createdAgents, String(payload.userId || ""));

    return NextResponse.json({
      success: true,
      imported: imported.length,
      skipped: skipped.length,
      failed: failed.length,
      details: { imported, skipped, failed },
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "批量导入失败";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
