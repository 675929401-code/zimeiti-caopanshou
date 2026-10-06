import { NextRequest, NextResponse } from "next/server";
import { verifyAdminToken } from "@/lib/admin-auth";
import { listBots } from "@/lib/coze-api";
import { getSupabaseClient } from "@/storage/database/supabase-client";

/**
 * GET /api/admin/agents/import
 * Fetch all bots from Coze platform for batch import preview
 * Returns: { bots: [{ bot_id, name, description, icon_url, ... }] }
 */
export async function GET(request: NextRequest) {
  // Auth check
  const token = request.headers.get("authorization")?.replace("Bearer ", "");
  if (!token) {
    return NextResponse.json({ error: "未授权" }, { status: 401 });
  }
  const payload = await verifyAdminToken(token);
  if (!payload || payload.role !== "admin") {
    return NextResponse.json({ error: "需要管理员权限" }, { status: 403 });
  }

  try {
    // Fetch all bots from Coze (paginate if needed)
    const allBots: Array<{
      bot_id: string;
      bot_name: string;
      description: string;
      icon_url: string;
      publish_status: string;
    }> = [];

    let pageNum = 1;
    let hasMore = true;

    while (hasMore) {
      const result = await listBots(pageNum, 50);
      // Coze API may return data as array or { items: [...] }
      const bots = Array.isArray(result.data)
        ? result.data
        : result.data?.items || [];
      allBots.push(...bots);

      // Check if there are more pages
      hasMore = bots.length >= 50;
      pageNum++;
    }

    // Check which bots are already imported
    const client = getSupabaseClient();
    const { data: existingAgents } = await client
      .from("agents")
      .select("bot_id")
      .eq("source", "coze");

    const existingBotIds = new Set(
      (existingAgents || []).map((a: { bot_id: string | null }) => a.bot_id)
    );

    // Mark each bot as already imported or not
    const botsWithStatus = allBots.map((bot) => ({
      ...bot,
      already_imported: existingBotIds.has(bot.bot_id),
    }));

    return NextResponse.json({ bots: botsWithStatus });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "获取智能体列表失败";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/**
 * POST /api/admin/agents/import
 * Batch import selected Coze bots as agents
 * Body: { bots: [{ bot_id, name, description, icon_url, category }] }
 */
export async function POST(request: NextRequest) {
  // Auth check
  const token = request.headers.get("authorization")?.replace("Bearer ", "");
  if (!token) {
    return NextResponse.json({ error: "未授权" }, { status: 401 });
  }
  const payload = await verifyAdminToken(token);
  if (!payload || payload.role !== "admin") {
    return NextResponse.json({ error: "需要管理员权限" }, { status: 403 });
  }

  try {
    const body = await request.json();
    const bots: Array<{
      bot_id: string;
      name: string;
      description?: string;
      icon_url?: string;
      category?: string;
    }> = body.bots;

    if (!Array.isArray(bots) || bots.length === 0) {
      return NextResponse.json({ error: "请选择要导入的智能体" }, { status: 400 });
    }

    const client = getSupabaseClient();
    const imported: string[] = [];
    const skipped: string[] = [];

    // Get max sort_order
    const { data: maxSort } = await client
      .from("agents")
      .select("sort_order")
      .order("sort_order", { ascending: false })
      .limit(1);

    let nextSort = (maxSort?.[0]?.sort_order || 0) + 10;

    for (const bot of bots) {
      // Check if already imported
      const { data: existing } = await client
        .from("agents")
        .select("id")
        .eq("bot_id", bot.bot_id)
        .eq("source", "coze")
        .maybeSingle();

      if (existing) {
        skipped.push(bot.bot_id);
        continue;
      }

      // Insert new agent
      const { error } = await client.from("agents").insert({
        name: bot.name,
        description: bot.description || "",
        source: "coze",
        bot_id: bot.bot_id,
        avatar: bot.icon_url || "",
        category: bot.category || "其他",
        sort_order: nextSort,
        cost_per_message: 0,
        is_active: true,
      });

      if (!error) {
        imported.push(bot.bot_id);
        nextSort += 10;
      } else {
        console.error(`Failed to import bot ${bot.bot_id}:`, error);
        skipped.push(bot.bot_id);
      }
    }

    return NextResponse.json({
      success: true,
      imported: imported.length,
      skipped: skipped.length,
      imported_ids: imported,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "批量导入失败";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
