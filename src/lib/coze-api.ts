// 🔒 核心底层代码 — 锁定保护
//
// 本文件是 Coze API 服务端封装，配置缓存 + streamChat。
// 修改此文件需要用户明确同意，详见 AGENTS.md "🔒 锁定模块清单 #8 Coze 对话链路"。
//
// 锁定范围：整个文件
// 锁定原因：Coze API 调用稳定性 + 配置缓存一致性 + SSE 流式输出

// Server-side Coze API helper
// All requests go through server routes to protect the API token
// Configuration is read from platform_settings (database) first, fallback to env vars

import { getSupabaseClient } from "@/storage/database/supabase-client";

export interface CozeConfig {
  apiBase: string;
  apiToken: string;
  workspaceId: string;
}

let cachedConfig: CozeConfig | null = null;
let configCacheTime = 0;
const CONFIG_CACHE_TTL = 5 * 60_000;

export async function getCozeConfig(): Promise<CozeConfig> {
  // Use cached config if fresh
  if (cachedConfig && Date.now() - configCacheTime < CONFIG_CACHE_TTL) {
    return cachedConfig;
  }

  // Read from database first, fallback to env vars
  let apiBase = process.env.COZE_API_BASE_URL || "https://api.coze.cn";
  let apiToken = process.env.COZE_WORKLOAD_API_TOKEN || "";
  let workspaceId = process.env.COZE_PROJECT_SPACE_ID || "";

  try {
    const client = getSupabaseClient();
    const { data } = await client
      .from("platform_settings")
      .select("setting_key, setting_value")
      .in("setting_key", ["coze_api_base_url", "coze_api_token", "coze_workspace_id"]);

    if (data && data.length > 0) {
      for (const row of data) {
        if (row.setting_key === "coze_api_base_url" && row.setting_value) {
          apiBase = row.setting_value;
        }
        if (row.setting_key === "coze_api_token" && row.setting_value) {
          apiToken = row.setting_value;
        }
        if (row.setting_key === "coze_workspace_id" && row.setting_value) {
          workspaceId = row.setting_value;
        }
      }
    }
  } catch {
    // Database not available, use env vars
  }

  cachedConfig = { apiBase, apiToken, workspaceId };
  configCacheTime = Date.now();
  return cachedConfig;
}

/** Clear config cache (call after admin saves Coze settings) */
export function clearCozeConfigCache() {
  cachedConfig = null;
  configCacheTime = 0;
}

function getHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
}

export async function listBots(pageNum = 1, pageSize = 50) {
  const config = await getCozeConfig();
  const params = new URLSearchParams({
    page_num: String(pageNum),
    page_size: String(pageSize),
  });
  // Only add workspace_id if it's configured
  if (config.workspaceId) {
    params.set("workspace_id", config.workspaceId);
  }

  const response = await fetch(`${config.apiBase}/v1/bots?${params}`, {
    headers: getHeaders(config.apiToken),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to list bots: ${response.status} ${errorText}`);
  }

  return response.json();
}

export async function getBotInfo(botId: string) {
  const config = await getCozeConfig();
  // Try without is_published first to support bots from code.coze.cn (扣子编程)
  const response = await fetch(`${config.apiBase}/v1/bots/${botId}`, {
    headers: getHeaders(config.apiToken),
  });

  if (!response.ok) {
    // If first attempt fails, try with is_published=true as fallback
    const response2 = await fetch(`${config.apiBase}/v1/bots/${botId}?is_published=true`, {
      headers: getHeaders(config.apiToken),
    });
    if (!response2.ok) {
      const errorText = await response2.text();
      throw new Error(`Failed to get bot info: ${response2.status} ${errorText}`);
    }
    return response2.json();
  }

  return response.json();
}

export async function createConversation(botId?: string, name?: string) {
  const config = await getCozeConfig();
  const body: Record<string, string> = {};
  if (botId) body.bot_id = botId;
  if (name) body.name = name;

  const response = await fetch(`${config.apiBase}/v1/conversation/create`, {
    method: "POST",
    headers: getHeaders(config.apiToken),
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to create conversation: ${response.status} ${errorText}`);
  }

  return response.json();
}

export async function listConversations(botId: string, pageNum = 1, pageSize = 50, sortOrder: "asc" | "desc" = "desc") {
  const config = await getCozeConfig();
  const params = new URLSearchParams({
    bot_id: botId,
    page_num: String(pageNum),
    page_size: String(pageSize),
    sort_order: sortOrder,
  });

  const response = await fetch(`${config.apiBase}/v1/conversations?${params}`, {
    headers: getHeaders(config.apiToken),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to list conversations: ${response.status} ${errorText}`);
  }

  return response.json();
}

export async function retrieveConversation(conversationId: string) {
  const config = await getCozeConfig();
  const response = await fetch(`${config.apiBase}/v1/conversation/retrieve`, {
    method: "POST",
    headers: getHeaders(config.apiToken),
    body: JSON.stringify({ conversation_id: conversationId }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to retrieve conversation: ${response.status} ${errorText}`);
  }

  return response.json();
}

export async function deleteConversation(conversationId: string) {
  const config = await getCozeConfig();
  const response = await fetch(`${config.apiBase}/v1/conversation/delete`, {
    method: "POST",
    headers: getHeaders(config.apiToken),
    body: JSON.stringify({ conversation_id: conversationId }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to delete conversation: ${response.status} ${errorText}`);
  }

  return response.json();
}

export async function listMessages(conversationId: string) {
  const config = await getCozeConfig();
  const response = await fetch(`${config.apiBase}/v1/conversation/message/list`, {
    method: "POST",
    headers: getHeaders(config.apiToken),
    body: JSON.stringify({ conversation_id: conversationId }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to list messages: ${response.status} ${errorText}`);
  }

  return response.json();
}

export async function streamChat(botId: string, userId: string, message: string, conversationId?: string, preloadedConfig?: CozeConfig, images?: string[]) {
  const config = preloadedConfig || await getCozeConfig();

  // Build additional_messages: text + images
  const additionalMessages: Array<{ role: string; content: string; content_type: string }> = [
    {
      role: "user",
      content: message,
      content_type: "text",
    },
  ];

  // Add image messages if present (resolve storage keys to signed URLs)
  if (images && images.length > 0) {
    try {
      const { getSignedUrl } = await import("@/lib/storage");
      const signedUrls = await Promise.all(images.map((key) => getSignedUrl(key, 3600)));
      for (const signedUrl of signedUrls) {
        additionalMessages.push({
          role: "user",
          content: signedUrl,
          content_type: "image",
        });
      }
    } catch (err) {
      // Never fall back to a text-only provider request after an attachment
      // signing failure. The caller has already authenticated ownership; a
      // signing error must fail closed so the user can retry without silently
      // dropping their image context.
      console.error("[Coze] Failed to resolve image URLs:", err);
      throw new Error("COZE_IMAGE_SIGNING_FAILED");
    }
  }

  const body: Record<string, unknown> = {
    bot_id: botId,
    user_id: userId,
    stream: true,
    auto_save_history: true,
    additional_messages: additionalMessages,
  };

  if (conversationId) {
    body.conversation_id = conversationId;
  }

  return fetch(`${config.apiBase}/v3/chat`, {
    method: "POST",
    headers: getHeaders(config.apiToken),
    body: JSON.stringify(body),
  });
}

/** Test Coze API connection - returns connection status with bot count and sample bots */
export async function testCozeConnection(): Promise<{ connected: boolean; botCount?: number; sampleBots?: Array<{ bot_id: string; bot_name: string }>; error?: string }> {
  try {
    const config = await getCozeConfig();
    if (!config.apiToken) {
      return { connected: false, error: "未配置 API Token — 只需填1项即可连接" };
    }
    // workspace_id is optional — without it, Coze API returns bots from all workspaces the token has access to
    const result = await listBots(1, 50);
    // Coze API may return data as array or { items: [...] }
    const bots: Array<{ bot_id: string; bot_name: string }> = Array.isArray(result?.data)
      ? result.data
      : result?.data?.items || [];
    const botCount = bots.length;
    const sampleBots = bots.slice(0, 5).map((b) => ({
      bot_id: b.bot_id,
      bot_name: b.bot_name,
    }));
    return { connected: true, botCount, sampleBots };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "连接失败";
    // Parse common error messages
    if (msg.includes("401") || msg.includes("Unauthorized")) {
      return { connected: false, error: "API Token 无效或已过期，请重新生成" };
    }
    if (msg.includes("403") || msg.includes("Forbidden")) {
      return { connected: false, error: "Token 权限不足，请确保勾选了 Bot:Read 权限" };
    }
    if (msg.includes("404")) {
      return { connected: false, error: "工作空间 ID 不存在，请检查或留空自动搜索" };
    }
    return { connected: false, error: msg };
  }
}
