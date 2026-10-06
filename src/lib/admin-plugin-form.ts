import { pluginSecretFieldNames } from "@/lib/plugin-metadata";

export type AdminPluginType = "coze" | "third_party" | "page_embed" | "knowledge_base" | "workflow";
export interface AdminPluginRecord {
  id: string; name: string; type: AdminPluginType; subtype: string; role: string;
  description: string; icon?: string; is_active: boolean; sort_order: number;
  price_per_use: number; cost_price: number; price_unit: string;
  config: Record<string, unknown>;
}
export interface AdminPluginForm {
  name: string; type: AdminPluginType; subtype: string; role: string;
  description: string; isActive: boolean; sortOrder: string;
  price: string; cost: string; priceUnit: string;
  apiBaseUrl: string; embedUrl: string; workflowId: string; appId: string;
  secretValues: Record<string, string>; clearSecretFields: string[]; advancedConfig: string;
}
const commonConfigKeys = new Set(["api_base_url", "embed_url", "workflow_id", "app_id"]);

export function createAdminPluginForm(plugin?: AdminPluginRecord): AdminPluginForm {
  const config = plugin?.config || {};
  const secrets = pluginSecretFieldNames(config);
  const advanced = Object.fromEntries(Object.entries(config).filter(([key]) => !commonConfigKeys.has(key) && !secrets.includes(key)));
  return {
    name: plugin?.name || "", type: plugin?.type || "coze", subtype: plugin?.subtype || "workflow", role: plugin?.role || "",
    description: plugin?.description || "", isActive: plugin?.is_active ?? false, sortOrder: String(plugin?.sort_order ?? 0),
    price: String(plugin?.price_per_use ?? 0), cost: String(plugin?.cost_price ?? 0), priceUnit: plugin?.price_unit || "次",
    apiBaseUrl: String(config.api_base_url || ""), embedUrl: String(config.embed_url || ""),
    workflowId: String(config.workflow_id || ""), appId: String(config.app_id || ""),
    secretValues: Object.fromEntries([...new Set(["api_token", "api_key", ...secrets])].map((key) => [key, ""])),
    clearSecretFields: [], advancedConfig: JSON.stringify(advanced, null, 2),
  };
}

export function buildAdminPluginPayload(form: AdminPluginForm, original?: AdminPluginRecord): Record<string, unknown> {
  if (!form.name.trim()) throw new Error("请填写插件名称");
  for (const [value, label] of [[form.price, "售价"], [form.cost, "成本价"]]) {
    if (!value.trim() || !Number.isFinite(Number(value)) || Number(value) < 0) throw new Error(label + "须为大于或等于 0 的金额");
  }
  if (!form.sortOrder.trim() || !Number.isSafeInteger(Number(form.sortOrder)) || Number(form.sortOrder) < 0) throw new Error("排序须为非负整数");
  let config: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(form.advancedConfig);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("INVALID_CONFIG");
    config = { ...parsed };
  } catch { throw new Error("高级配置须为 JSON 对象"); }
  for (const [key, value] of [["api_base_url", form.apiBaseUrl], ["embed_url", form.embedUrl], ["workflow_id", form.workflowId], ["app_id", form.appId]]) {
    if (value.trim() || Object.hasOwn(original?.config || {}, key)) config[key] = value.trim();
  }
  const requiredUrl = form.type === "page_embed" ? form.embedUrl : ["coze", "third_party"].includes(form.type) ? form.apiBaseUrl : "";
  if (["coze", "third_party", "page_embed"].includes(form.type)) {
    try { const url = new URL(requiredUrl); if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) throw new Error("INVALID_URL"); }
    catch { throw new Error(form.type === "page_embed" ? "请填写有效的页面地址" : "请填写有效的 API 地址"); }
  }
  const originalSecrets = pluginSecretFieldNames(original?.config);
  if (form.clearSecretFields.some((key) => !originalSecrets.includes(key))) throw new Error("只能清除原插件已配置的凭据");
  for (const [key, value] of Object.entries(form.secretValues)) {
    if (form.clearSecretFields.includes(key)) continue;
    // A blank control does not overwrite or expose a stored credential.
    if (value.trim()) config[key] = value.trim();
  }
  return {
    ...(original ? { id: original.id } : {}),
    name: form.name.trim(), type: form.type, subtype: form.subtype.trim(), description: form.description.trim(),
    price_per_use: Number(form.price), cost_price: Number(form.cost), price_unit: form.priceUnit.trim() || "次", sort_order: Number(form.sortOrder), config,
    ...(!original || form.role !== original.role ? { role: form.role } : {}),
    ...(!original || form.isActive !== original.is_active ? { is_active: form.isActive } : {}),
    ...(form.clearSecretFields.length ? { clear_secret_fields: form.clearSecretFields } : {}),
  };
}
