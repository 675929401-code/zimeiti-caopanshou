import { NextRequest, NextResponse } from "next/server";
import { getTokenFromHeaders } from "@/lib/auth";
import { verifyAdminToken } from "@/lib/admin-auth";
import { getBotInfo, clearCozeConfigCache } from "@/lib/coze-api";
import { persistAvatar } from "@/lib/storage";

/**
 * POST /api/admin/agents/fetch-info
 * Given a bot_id, fetch bot details from Coze API
 * Auto-stores icon to object storage
 * Body: { bot_id: string }
 * Returns: { bot_id, name, description, icon_url }
 */
export async function POST(request: NextRequest) {
  const token = getTokenFromHeaders(request.headers);
  if (!token) return NextResponse.json({ error: "未授权" }, { status: 401 });
  const payload = await verifyAdminToken(token);
  if (!payload || payload.role !== "admin") return NextResponse.json({ error: "需要管理员权限" }, { status: 403 });

  try {
    const body = await request.json();
    const botId = body.bot_id;
    if (!botId) {
      return NextResponse.json({ error: "请提供 Bot ID" }, { status: 400 });
    }

    // Clear cache to use latest config
    clearCozeConfigCache();

    const result = await getBotInfo(botId);

    // Coze API returns bot info in result.data
    const botData = result.data || result;

    let iconUrl = botData.icon_url || botData.avatar_url || "";

    // Auto-store external icon URL to our local storage
    if (iconUrl && (iconUrl.startsWith("http://") || iconUrl.startsWith("https://"))) {
      try {
        const stored = await persistAvatar(iconUrl, `bot-${botId}`);
        console.log(`[fetch-info] Stored icon for bot ${botId}: ${iconUrl} -> ${stored}`);
        iconUrl = stored;
      } catch (err) {
        console.error(`[fetch-info] Failed to store icon for bot ${botId}:`, err);
        // Keep original URL as fallback
      }
    }

    return NextResponse.json({
      bot_id: botData.bot_id || botId,
      name: botData.bot_name || botData.name || "",
      description: botData.description || "",
      icon_url: iconUrl,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "获取智能体信息失败";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
