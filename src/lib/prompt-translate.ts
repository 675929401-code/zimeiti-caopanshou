/**
 * 视频提示词中文自动翻译模块
 * 
 * 设计原则：
 * - 英文 prompt 直通，零延迟
 * - 中文 prompt 自动翻译为英文再发给上游视频模型
 * - 翻译使用已配置的 LLM API（同 chat 功能共用）
 * - 翻译失败时回退到原始 prompt（不阻塞提交）
 * - 翻译结果缓存（相同 prompt 不重复翻译）
 */

import { getSupabaseAdminClient } from "@/storage/database/supabase-client";

// ── 中文检测 ──

/** 检测字符串是否包含中文字符（CJK 统一汉字区间） */
export function containsChinese(text: string): boolean {
  // CJK Unified Ideographs: \u4e00-\u9fff
  // CJK Unified Ideographs Extension A-H, Compatibility etc.
  return /[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/.test(text);
}

// ── 翻译缓存（内存，LRU 风格，最多 200 条） ──

const translateCache = new Map<string, string>();
const MAX_CACHE_SIZE = 200;

function getCachedTranslation(prompt: string): string | null {
  return translateCache.get(prompt) ?? null;
}

function setCachedTranslation(prompt: string, translated: string): void {
  if (translateCache.size >= MAX_CACHE_SIZE) {
    // 删除最早的一条
    const firstKey = translateCache.keys().next().value;
    if (firstKey) translateCache.delete(firstKey);
  }
  translateCache.set(prompt, translated);
}

// ── LLM 配置读取 ──

interface LLMConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

let cachedConfig: LLMConfig | null = null;
let configCacheTime = 0;
const CONFIG_CACHE_TTL = 5 * 60 * 1000; // 5 分钟

async function getLLMConfig(): Promise<LLMConfig> {
  if (cachedConfig && Date.now() - configCacheTime < CONFIG_CACHE_TTL) {
    return cachedConfig;
  }

  // 优先从数据库读取（管理后台可动态修改）
  try {
    const db = getSupabaseAdminClient();
    const { data } = await db
      .from("platform_settings")
      .select("key, value")
      .in("key", ["llm_api_base_url", "llm_api_key", "llm_default_model"]);

    const settings = new Map(data?.map((s: { key: string; value: string }) => [s.key, s.value]));

    const baseUrl = (settings.get("llm_api_base_url") || process.env.LLM_API_BASE_URL || "") as string;
    const apiKey = (settings.get("llm_api_key") || process.env.LLM_API_KEY || "") as string;
    const model = (settings.get("llm_default_model") || process.env.LLM_DEFAULT_MODEL || "deepseek-v4-flash") as string;

    if (baseUrl && apiKey) {
      cachedConfig = { baseUrl, apiKey, model } as LLMConfig;
      configCacheTime = Date.now();
      return cachedConfig;
    }
  } catch {
    // 数据库读取失败，回退到环境变量
  }

  // 回退到环境变量
  cachedConfig = {
    baseUrl: process.env.LLM_API_BASE_URL || "",
    apiKey: process.env.LLM_API_KEY || "",
    model: process.env.LLM_DEFAULT_MODEL || "deepseek-v4-flash",
  };
  configCacheTime = Date.now();
  return cachedConfig;
}

// ── 翻译核心 ──

const TRANSLATE_SYSTEM_PROMPT = `You are a prompt translator for AI video generation models. Your ONLY job is to translate the user's prompt from Chinese to English.

Rules:
1. Translate naturally and accurately, preserving all visual details, actions, and atmosphere
2. Keep technical terms in their commonly used English form (e.g., drone shot, timelapse, bokeh)
3. Do NOT add any extra descriptions, interpretations, or creative embellishments
4. Do NOT wrap the output in quotes or add any prefix/suffix
5. Output ONLY the translated English text, nothing else
6. If the input is already in English, return it as-is`;

/**
 * 翻译中文提示词为英文
 * 
 * @param prompt 原始提示词
 * @returns 翻译结果 { translated: 英文提示词, wasTranslated: 是否发生了翻译 }
 */
export async function translatePromptIfNeeded(
  prompt: string
): Promise<{ translated: string; wasTranslated: boolean }> {
  // 英文直通，零延迟
  if (!containsChinese(prompt)) {
    return { translated: prompt, wasTranslated: false };
  }

  // 查缓存
  const cached = getCachedTranslation(prompt);
  if (cached) {
    console.log(`[提示词翻译] 命中缓存: "${prompt.slice(0, 40)}..." → "${cached.slice(0, 40)}..."`);
    return { translated: cached, wasTranslated: true };
  }

  // 调用 LLM 翻译
  const startMs = Date.now();
  try {
    const config = await getLLMConfig();
    if (!config.baseUrl || !config.apiKey) {
      console.warn(`[提示词翻译] LLM API 未配置，跳过翻译，使用原始中文提示词`);
      return { translated: prompt, wasTranslated: false };
    }

    const url = `${config.baseUrl.replace(/\/+$/, "")}/v1/chat/completions`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        messages: [
          { role: "system", content: TRANSLATE_SYSTEM_PROMPT },
          { role: "user", content: prompt },
        ],
        temperature: 0.3, // 低温度，保证翻译稳定
        max_tokens: 2000,
      }),
      signal: AbortSignal.timeout(15_000), // 15秒超时，不阻塞太久
    });

    if (!response.ok) {
      console.warn(`[提示词翻译] LLM 返回 ${response.status}，跳过翻译`);
      return { translated: prompt, wasTranslated: false };
    }

    const data = await response.json();
    const translated = data.choices?.[0]?.message?.content?.trim();

    if (!translated) {
      console.warn(`[提示词翻译] LLM 返回空内容，跳过翻译`);
      return { translated: prompt, wasTranslated: false };
    }

    const ms = Date.now() - startMs;
    console.log(`[提示词翻译] 翻译完成 ${ms}ms: "${prompt.slice(0, 40)}..." → "${translated.slice(0, 40)}..."`);

    // 缓存
    setCachedTranslation(prompt, translated);

    return { translated, wasTranslated: true };
  } catch (err) {
    const ms = Date.now() - startMs;
    console.warn(`[提示词翻译] 翻译异常 ${ms}ms: ${err instanceof Error ? err.message : err}，使用原始中文提示词`);
    return { translated: prompt, wasTranslated: false };
  }
}
