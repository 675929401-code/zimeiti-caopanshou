import { SignJWT } from "jose";
import { getJwtSecretKey } from "@/lib/auth";

type JsonObject = Record<string, unknown>;

const DEFAULT_PRODUCTION_BASE = "https://zyuani8.com";
const CACHE_TTL_MS = 60_000;

type CacheEntry<T> = {
  value: T;
  expiresAt: number;
};

const cache = new Map<string, CacheEntry<unknown>>();

function productionBaseUrl() {
  const base =
    process.env.PRODUCTION_SITE_URL ||
    process.env.COZE_PROJECT_DOMAIN_DEFAULT ||
    DEFAULT_PRODUCTION_BASE;
  return base.replace(/\/+$/, "");
}

function isProductionProxyEnabled() {
  return process.env.PRODUCTION_DATA_PROXY === "1";
}

function detectTextProtocol(model: JsonObject) {
  const modelName = String(model.model_name || "");
  const endpoint = String(model.api_endpoint || model.proxy_url || "");
  if (/claude/i.test(modelName) && /s\.lconai\.com/i.test(endpoint)) {
    return "openai_chat";
  }
  if (/claude/i.test(modelName) && /n\.lconai\.com|anthropic\.com|claude/i.test(endpoint)) {
    return "anthropic_messages";
  }
  return String(model.protocol_type || "openai_chat");
}

function normalizeProductionAdminModel(model: JsonObject): JsonObject {
  if (model.model_type !== "text") return model;
  return {
    ...model,
    protocol_type: detectTextProtocol(model),
  };
}

async function createAdminToken() {
  return new SignJWT({
    userId: "local-production-sync",
    username: "local-production-sync",
    role: "admin",
    displayName: "Local Production Sync",
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("10m")
    .sign(getJwtSecretKey());
}

async function fetchJson<T>(path: string, options: RequestInit = {}, cacheKey?: string): Promise<T | null> {
  if (!isProductionProxyEnabled()) return null;

  if (cacheKey) {
    const cached = cache.get(cacheKey) as CacheEntry<T> | undefined;
    if (cached && cached.expiresAt > Date.now()) return cached.value;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(`${productionBaseUrl()}${path}`, {
      ...options,
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        ...(options.headers || {}),
      },
    });
    if (!response.ok) return null;
    const data = (await response.json()) as T;
    if (cacheKey) {
      cache.set(cacheKey, { value: data, expiresAt: Date.now() + CACHE_TTL_MS });
    }
    return data;
  } catch (error) {
    console.warn(`[production-data] ${path} failed:`, error);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchPublicJson<T>(path: string, options: RequestInit = {}, cacheKey?: string): Promise<T | null> {
  if (cacheKey) {
    const cached = cache.get(cacheKey) as CacheEntry<T> | undefined;
    if (cached && cached.expiresAt > Date.now()) return cached.value;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(`${productionBaseUrl()}${path}`, {
      ...options,
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        ...(options.headers || {}),
      },
    });
    if (!response.ok) return null;
    const data = (await response.json()) as T;
    if (cacheKey) {
      cache.set(cacheKey, { value: data, expiresAt: Date.now() + CACHE_TTL_MS });
    }
    return data;
  } catch (error) {
    console.warn(`[production-data-public] ${path} failed:`, error);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function adminHeaders() {
  const token = await createAdminToken();
  return { Authorization: `Bearer ${token}` };
}

export async function fetchProductionAdminModels(): Promise<JsonObject[]> {
  const data = await fetchJson<{ models?: JsonObject[] }>(
    "/api/admin/models",
    { headers: await adminHeaders() },
    "admin-models",
  );
  return Array.isArray(data?.models) ? data.models.map(normalizeProductionAdminModel) : [];
}

export async function fetchProductionAdminAgents(): Promise<JsonObject[]> {
  const data = await fetchJson<{ agents?: JsonObject[] }>(
    "/api/admin/agents",
    { headers: await adminHeaders() },
    "admin-agents",
  );
  return Array.isArray(data?.agents) ? data.agents : [];
}

export async function fetchProductionPublicAgents(authHeader?: string | null): Promise<JsonObject[]> {
  const data = await fetchPublicJson<{ bots?: JsonObject[]; agents?: JsonObject[] }>(
    "/api/bots",
    authHeader ? { headers: { Authorization: authHeader } } : {},
    `public-agents:${authHeader ? "auth" : "anon"}`,
  );
  return Array.isArray(data?.bots) ? data.bots : Array.isArray(data?.agents) ? data.agents : [];
}

export async function fetchProductionPublicModels(
  kind: "llm" | "cover" | "video",
  authHeader?: string | null,
): Promise<JsonObject[]> {
  const path =
    kind === "llm" ? "/api/llm-models" :
    kind === "cover" ? "/api/cover-models" :
    "/api/video/models";
  const data = await fetchJson<{ models?: JsonObject[] }>(
    path,
    authHeader ? { headers: { Authorization: authHeader } } : {},
    `${kind}-models:${authHeader ? "auth" : "anon"}`,
  );
  return Array.isArray(data?.models) ? data.models : [];
}

export async function getProductionVideoModelById(id: string): Promise<JsonObject | null> {
  const models = await fetchProductionAdminModels();
  return models.find((model) => model.model_type === "video" && model.id === id) || null;
}

export async function getProductionCoverModelById(id: string): Promise<JsonObject | null> {
  const models = await fetchProductionAdminModels();
  const model = models.find((item) => item.model_type === "drawing" && item.id === id);
  if (!model) return null;
  return {
    ...model,
    selling_price: Number(model.selling_price ?? model.cost_per_use) || 0,
    cost_price: Number(model.cost_price) || 0,
  };
}

export async function getProductionLlmModelById(id: string): Promise<JsonObject | null> {
  const models = await fetchProductionAdminModels();
  return models.find((model) => model.model_type === "text" && model.id === id) || null;
}

export async function getProductionLlmModelByName(modelName: string): Promise<JsonObject | null> {
  const models = await fetchProductionAdminModels();
  const isRetiredYunwu = (model: JsonObject) => {
    let host = "";
    try {
      host = new URL(String(model.api_endpoint || model.proxy_url || "")).host;
    } catch {}
    return /yunwu\.ai/i.test(host) || String(model.provider || "").toLowerCase() === "yunwu";
  };
  const matches = models
    .filter((model) =>
      model.model_type === "text" &&
      model.model_name === modelName &&
      model.is_active !== false &&
      !isRetiredYunwu(model)
    )
    .sort((a, b) => Number(a.sort_order || 0) - Number(b.sort_order || 0));
  return matches[0] || null;
}

export async function getProductionAgentById(id: string): Promise<JsonObject | null> {
  const adminAgents = await fetchProductionAdminAgents();
  const agents = adminAgents.length > 0 ? adminAgents : await fetchProductionPublicAgents();
  return agents.find((agent) => agent.id === id && agent.deleted_at == null) || null;
}
