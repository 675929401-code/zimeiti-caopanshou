import { normalizeDisplayText } from "@/lib/display-normalization";
import { normalizePluginPrice } from "@/lib/extract-pricing";

const SECRET_MASK = "********";
const SECRET_KEYS = new Set([
  "apitoken", "apikey", "apisecret", "secretkey", "token", "secret", "password",
  "clientsecretkey", "clientsecret", "accesstoken", "refreshtoken", "authtoken", "authorization",
]);
const EXTRACTION_ROLES: Record<string, { label: string; price: number }> = {
  extract_workflow: { label: "文案提取插件", price: 0.02 },
  extract_video: { label: "旧视频提取兼容配置", price: 0.02 },
  extract_text_third_party: { label: "第三方文案提取插件", price: 0.01 },
  extract_batch_third_party: { label: "批量文案提取插件", price: 0.01 },
  coze_multifunction_extract: { label: "三合一提取插件", price: 0.02 },
};

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isSecretKey(key: string): boolean {
  return SECRET_KEYS.has(key.replace(/[-_]/g, "").toLowerCase());
}

export function pluginSecretFieldNames(config: unknown): string[] {
  return isObject(config) ? Object.keys(config).filter(isSecretKey) : [];
}

/** Explicit clearing is limited to existing top-level credential fields. */
export function clearPluginConfigSecrets(config: Record<string, unknown>, original: unknown, fields: unknown): Record<string, unknown> {
  if (fields === undefined) return config;
  const previous = isObject(original) ? original : {};
  if (!Array.isArray(fields) || fields.length > 64 || fields.some((key) => typeof key !== "string" || !isSecretKey(key) || !Object.hasOwn(previous, key))) {
    throw new Error("只能显式清除已配置的凭据字段");
  }
  const cleared = { ...config };
  for (const key of fields as string[]) delete cleared[key];
  return cleared;
}

/** A missing price is separate from a configured free price. */
export function isValidPluginPrice(value: unknown): boolean {
  if (typeof value !== "number" && typeof value !== "string") return false;
  if (typeof value === "string" && !value.trim()) return false;
  const amount = Number(value);
  return Number.isFinite(amount) && amount >= 0;
}

interface PluginMetadataFields {
  name?: unknown; description?: unknown; price_unit?: unknown; role?: unknown;
  price_per_use?: unknown; cost_price?: unknown; config?: unknown;
}

type NormalizedPluginMetadata<T> = Omit<T, "name" | "description" | "price_unit" | "price_per_use" | "cost_price" | "config" | "metadata_warnings"> & {
  name: string;
  description?: string;
  price_unit: string;
  price_per_use: number;
  cost_price?: number;
  config?: Record<string, unknown>;
  metadata_warnings: string[];
};

/** Normalize human-facing metadata only; role/provider/URLs and secrets remain opaque. */
export function normalizePluginMetadata<T extends PluginMetadataFields>(plugin: T): NormalizedPluginMetadata<T> {
  const role = typeof plugin.role === "string" ? plugin.role : "";
  const roleDefaults = EXTRACTION_ROLES[role];
  return {
    ...plugin,
    name: normalizeDisplayText(plugin.name, roleDefaults?.label || "未命名插件"),
    ...(plugin.description !== undefined ? { description: normalizeDisplayText(plugin.description) } : {}),
    price_unit: normalizeDisplayText(plugin.price_unit, "次"),
    price_per_use: normalizePluginPrice(plugin.price_per_use, roleDefaults?.price ?? 0),
    ...(plugin.cost_price !== undefined ? { cost_price: normalizePluginPrice(plugin.cost_price, 0) } : {}),
    ...(plugin.config !== undefined ? {
      config: isObject(plugin.config) ? {
        ...plugin.config,
        ...(typeof plugin.config.site_name === "string"
          ? { site_name: normalizeDisplayText(plugin.config.site_name) } : {}),
      } : {},
    } : {}),
    metadata_warnings: isValidPluginPrice(plugin.price_per_use) ? [] : ["PRICE_NOT_CONFIGURED"],
  } as NormalizedPluginMetadata<T>;
}

/** All admin responses use the same full mask, including short and PPT6 credentials. */
export function maskPluginConfig(config: unknown): Record<string, unknown> {
  if (!isObject(config)) return {};
  return Object.fromEntries(Object.entries(config).map(([key, value]) => {
    if (isSecretKey(key)) return [key, value ? SECRET_MASK : ""];
    if (isObject(value)) return [key, maskPluginConfig(value)];
    if (Array.isArray(value)) return [key, value.map((entry) => isObject(entry) ? maskPluginConfig(entry) : entry)];
    return [key, value];
  }));
}

/** Masked/empty/omitted credential fields mean unchanged, never a replacement credential. */
export function mergePluginConfigSecrets(incoming: unknown, original: unknown): Record<string, unknown> {
  const previous = isObject(original) ? original : {};
  const result = { ...(isObject(incoming) ? incoming : {}) };
  for (const key of new Set([...Object.keys(previous), ...Object.keys(result)])) {
    const value = result[key];
    if (isSecretKey(key)) {
      if (value === undefined || value === null || (typeof value === "string" && (!value.trim() || value.includes("****")))) {
        if (previous[key] !== undefined) result[key] = previous[key];
        else delete result[key];
      }
    } else if (Array.isArray(value)) {
      const previousItems = Array.isArray(previous[key]) ? previous[key] : [];
      result[key] = value.map((entry, index) => isObject(entry)
        ? mergePluginConfigSecrets(entry, previousItems[index]) : entry);
    } else if (isObject(value) || isObject(previous[key])) {
      result[key] = mergePluginConfigSecrets(value, previous[key]);
    }
  }
  return result;
}

export function sanitizePluginForAdmin<T extends Parameters<typeof normalizePluginMetadata>[0]>(plugin: T) {
  const normalized = normalizePluginMetadata(plugin);
  return { ...normalized, config: maskPluginConfig(normalized.config) };
}

/** Validate before any plugin state change. Prices cannot silently become zero. */
export function validatePluginMetadataInput(body: Record<string, unknown>, creating = false): string | null {
  if (creating || body.name !== undefined) {
    if (typeof body.name !== "string" || !body.name.trim()) return "插件名称为必填项";
  }
  if (creating || body.type !== undefined) {
    if (typeof body.type !== "string" || !["coze", "third_party", "page_embed", "knowledge_base", "workflow"].includes(body.type)) {
      return "无效的插件类型";
    }
  }
  for (const key of ["name", "description", "price_unit"]) {
    if (body[key] === undefined) continue;
    if (typeof body[key] !== "string") return "插件名称、描述和计价单位必须为文本";
    if (/[\uFFFD]|\?{3,}/u.test(body[key] as string)) return "插件文本含不可恢复的乱码，请重新输入后保存";
  }
  for (const key of ["role", "subtype"]) {
    if (body[key] !== undefined && (typeof body[key] !== "string" || !/^[a-z0-9_-]*$/i.test(body[key] as string))) {
      return "插件角色和子类型必须为有效标识符";
    }
  }
  for (const [key, label] of [["price_per_use", "售价"], ["cost_price", "成本价"]]) {
    if (body[key] !== undefined && !isValidPluginPrice(body[key])) return `${label}必须为大于或等于 0 的有效金额`;
  }
  if (body.config !== undefined && !isObject(body.config)) return "配置必须为 JSON 对象";
  if (body.is_active !== undefined && typeof body.is_active !== "boolean") return "启用状态必须为布尔值";
  return null;
}
