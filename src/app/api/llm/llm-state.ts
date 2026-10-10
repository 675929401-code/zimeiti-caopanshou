/**
 * LLM Route — Module-level shared state & helpers
 *
 * 从 route.ts 提取的模块级状态：常量、缓存、辅助函数。
 * 分离原因：route.ts 应只包含请求处理逻辑，不应管理全局缓存和定时器。
 */

import { getSupabaseClient } from "@/storage/database/supabase-client";
import { ensureServerRuntimeEnvLoaded } from "@/lib/server-runtime-env";

// ── 环境常量 ──
ensureServerRuntimeEnvLoaded();

export const LLM_API_BASE = process.env.LLM_API_BASE_URL || "https://yunwu.ai";
export const LLM_API_KEY = process.env.LLM_API_KEY || "";
export const LLM_DEFAULT_MODEL = process.env.LLM_DEFAULT_MODEL || "deepseek-v4-flash";

// ── 智能体配置缓存（60秒TTL；管理端写入后按 agentId 即时失效） ──
export const agentConfigCache = new Map<string, { data: Record<string, unknown>; expiry: number }>();
export const AGENT_CONFIG_TTL = process.env.SHARED_CONFIGURATION_ENABLED === "1" ? 0 : 60 * 1000; // 1分钟

/**
 * 让指定智能体的下一次 LLM 请求重新读取服务端配置。
 * 只接受稳定 agentId，不返回也不记录缓存内容，避免系统提示词外泄。
 */
export function invalidateAgentConfigCache(agentId: string): boolean {
  return agentConfigCache.delete(agentId);
}

// ── llm_models 配置缓存（60秒TTL，按查询键区分） ──
export const llmModelCache = new Map<string, { data: Record<string, unknown> | null; expiry: number }>();
export const LLM_MODEL_CACHE_TTL = process.env.SHARED_CONFIGURATION_ENABLED === "1" ? 0 : 60 * 1000; // 1分钟

// ── 内存频率限制器（替代 platform_settings 表存储，零DB开销） ──
export const frequencyLimitStore = new Map<string, { count: number; windowStart: number }>();

// ── 全局系统前缀缓存（5分钟TTL；管理端写入后即时失效） ──
let globalSystemPrefixCache = { value: "", expiry: 0 };
const GLOBAL_PREFIX_CACHE_TTL = 5 * 60 * 1000; // 5分钟

/**
 * 让下一次 LLM 请求重新读取全局系统前缀。
 * 不返回或记录缓存内容，避免系统提示词外泄。
 */
export function invalidateGlobalSystemPrefixCache(): void {
  globalSystemPrefixCache = { value: "", expiry: 0 };
}

// 种子初始化已禁用：不再自动将模型加入黑名单或冷却期

export async function getGlobalSystemPrefix(client: ReturnType<typeof getSupabaseClient>): Promise<string> {
  if (globalSystemPrefixCache.expiry > Date.now()) {
    return globalSystemPrefixCache.value;
  }
  try {
    const { data } = await client
      .from("platform_settings")
      .select("setting_value")
      .eq("setting_key", "global_system_prefix")
      .single();
    const value = (data?.setting_value as string) || "";
    globalSystemPrefixCache = { value, expiry: Date.now() + GLOBAL_PREFIX_CACHE_TTL };
    return value;
  } catch {
    globalSystemPrefixCache = { value: "", expiry: Date.now() + GLOBAL_PREFIX_CACHE_TTL };
    return "";
  }
}

// 每小时清理一次过期条目，防止内存泄漏
if (typeof setInterval !== "undefined") {
  setInterval(() => {
    const now = Date.now();
    for (const [key, val] of frequencyLimitStore) {
      if (now - val.windowStart > 3600000) frequencyLimitStore.delete(key);
    }
  }, 3600000);
}
