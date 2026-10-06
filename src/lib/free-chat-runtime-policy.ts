export const FREE_CHAT_DEFAULT_MODEL_KEY = "gpt-5.6-terra";

// Type 2 uses the selected model's own reasoning stream. Free chat keeps this
// server-owned so a stale browser or crafted request cannot turn it off.
export const FREE_CHAT_DEEP_THINKING_TYPE = 2 as const;

type ModelIdentity = {
  model_name?: unknown;
};

function normalizeModelKey(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

export function selectFreeChatDefaultModel<T extends ModelIdentity>(rows: readonly T[]): T | null {
  return rows.find((row) => normalizeModelKey(row.model_name) === FREE_CHAT_DEFAULT_MODEL_KEY) ?? null;
}

export function shouldAutoEnableWebSearch(text: string): boolean {
  const normalized = String(text || "")
    .normalize("NFKC")
    .replace(/[\s，。！？、,.!?：:；;"'“”‘’（）()【】\[\]]+/gu, "")
    .toLowerCase();

  if (!normalized) return false;

  return [
    /(?:请|麻烦|帮我|给我|去)?(?:联网|上网|网上|互联网)(?:帮我|给我|去)?(?:查|查找|搜索|搜|找|检索|看看)/u,
    /(?:请|麻烦|帮我|给我)?(?:查|查找|搜索|搜|找|检索)(?:一下|下)?(?:网络|网上|网页|互联网)/u,
    /(?:请|麻烦|帮我|给我)?(?:用|打开)(?:浏览器|联网|网络)(?:帮我|给我|去)?(?:查|查找|搜索|搜|找|检索)/u,
    /\b(?:web|online|internet)(?:search|lookup|find)/iu,
  ].some((pattern) => pattern.test(normalized));
}

export function requiresAuditableWebPresearch(modelName: string): boolean {
  return /^gpt-5\.6(?:[-.]|$)/iu.test(String(modelName || "").trim());
}

export type WebSearchTransport = "native" | "presearch" | "unavailable";

type WebSearchEnvironment = {
  apiKey?: unknown;
  baseUrl?: unknown;
};

export function hasAuditableWebSearchConfig(environment: WebSearchEnvironment): boolean {
  const apiKey = typeof environment.apiKey === "string" ? environment.apiKey.trim() : "";
  const baseUrl = typeof environment.baseUrl === "string" ? environment.baseUrl.trim() : "";
  if (!apiKey || !baseUrl) return false;
  try {
    const parsed = new URL(baseUrl);
    return parsed.protocol === "https:" && !parsed.username && !parsed.password;
  } catch {
    return false;
  }
}

export function resolveWebSearchTransport(
  modelName: string,
  environment: WebSearchEnvironment,
): WebSearchTransport {
  const normalizedModel = String(modelName || "").trim();
  const nativeCapable = /^(?:glm-|gpt-4o|gpt-4-turbo|gpt-5)/iu.test(normalizedModel);
  const presearchConfigured = hasAuditableWebSearchConfig(environment);

  // GPT-5.6 can use its hosted web_search tool. Prefer the auditable platform
  // search when configured; otherwise keep web access functional through the
  // model's native tool instead of constructing an invalid SDK URL.
  if (requiresAuditableWebPresearch(normalizedModel) && presearchConfigured) return "presearch";
  if (nativeCapable) return "native";
  if (presearchConfigured) return "presearch";
  return "unavailable";
}
