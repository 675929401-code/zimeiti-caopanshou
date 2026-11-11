import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";
import { NativeAgentRuntimeConfigSchema, NativeAgentRuntimeSaveSchema, NATIVE_AGENT_RUNTIME_ROLES,
  type NativeAgentRuntimeAdminState, type NativeAgentRuntimeConfig, type NativeAgentRuntimeConfigSnapshot,
  type NativeAgentRuntimeModelChoice, type NativeAgentRuntimeReadiness } from "@/lib/native-agent-runtime-contract";
import { stableConfigurationJson } from "@/lib/platform-configuration-contract";
import { publicModelDisplayName, toPublicModelId } from "@/lib/public-model-dto";
import { isPublishedTextModelEligible, isTextModelEligible } from "@/lib/text-model-eligibility";
import { inspectTextModelPricing } from "@/lib/text-model-pricing";
import { resolveLlmProviderBinding } from "@/lib/llm-provider-contract";

type Row = Record<string, unknown>;
const CONFIG_FIELDS = "revision,config,config_hash,updated_at";
// Credentials are deliberately absent. The execution adapter owns secret resolution.
const MODEL_FIELDS = "id,name,model_name,description,category,is_active,is_hidden,user_access,sort_order,provider,api_protocol_config,api_endpoint,proxy_url,token_billing_enabled,input_cost_per_million,output_cost_per_million,cached_cost_per_million,profit_margin,token_rounding_unit";
const inactiveRoles = ["background", "think"] as const;
export class NativeAgentRuntimeConfigError extends Error {
  constructor(readonly code: string, message: string, readonly status = 503) { super(message); this.name = "NativeAgentRuntimeConfigError"; }
}
export function nativeAgentRuntimeConfigHash(config: NativeAgentRuntimeConfig): string {
  return createHash("sha256").update(stableConfigurationJson(config)).digest("hex");
}
function record(value: unknown): Row { return value && typeof value === "object" && !Array.isArray(value) ? value as Row : {}; }
function schemaMissing(error: unknown): boolean {
  const item = record(error);
  return ["42P01", "42703", "42883", "PGRST202", "PGRST204", "PGRST205"].includes(String(item.code));
}
function storeError(error: unknown, operation: "read" | "save"): never {
  if (schemaMissing(error)) throw new NativeAgentRuntimeConfigError("NATIVE_AGENT_RUNTIME_SCHEMA_REQUIRED", "原生智能体运行配置存储尚未安装，请先完成经授权的数据库迁移");
  const message = String(record(error).message ?? "");
  if (/NATIVE_AGENT_(?:RUNTIME_)?(?:CONFIG_)?(?:REVISION_)?CONFLICT|revision_conflict|expected_revision/iu.test(message))
    throw new NativeAgentRuntimeConfigError("NATIVE_AGENT_RUNTIME_REVISION_CONFLICT", "配置已被其他管理员修改，请重新读取后合并您的改动", 409);
  throw new NativeAgentRuntimeConfigError(operation === "read" ? "NATIVE_AGENT_RUNTIME_READ_FAILED" : "NATIVE_AGENT_RUNTIME_SAVE_UNCONFIRMED",
    operation === "read" ? "暂时无法读取原生智能体运行配置" : "保存结果未获确认，请重新读取当前版本后再操作");
}

/** All resource-pool rows remain visible to administrators, including rejected rows. */
export function nativeAgentRuntimeModelChoices(rows: Row[]): NativeAgentRuntimeModelChoice[] {
  return rows.map(row => {
    const reasons: string[] = [];
    if (!isTextModelEligible(row)) reasons.push("该资源不是文本对话模型");
    if (!isPublishedTextModelEligible(row)) reasons.push("模型尚未发布、已隐藏或等待激活");
    const pricing = inspectTextModelPricing(row);
    if (!pricing.priceReady) reasons.push(pricing.message);
    try { if (resolveLlmProviderBinding(row).protocol !== "anthropic_messages") reasons.push("首批原 Agent 仅支持 Anthropic Messages 原协议"); }
    catch { reasons.push("模型渠道或协议绑定不完整"); }
    try {
      const endpoint = new URL(String(row.api_endpoint || row.proxy_url || ""));
      if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw Error();
    } catch { reasons.push("模型服务地址未配置或不符合安全协议"); }
    const modelName = typeof row.model_name === "string" ? row.model_name.trim() : "";
    if (!modelName) reasons.push("模型运行名称未配置");
    return { id: toPublicModelId("chat", String(row.id)), displayName: publicModelDisplayName(row), modelName, available: reasons.length === 0, reasons };
  });
}
export function nativeAgentRuntimeReadiness(config: NativeAgentRuntimeConfig, choices: NativeAgentRuntimeModelChoice[], configured = true): NativeAgentRuntimeReadiness {
  const result = (ready: boolean, code: string, message: string): NativeAgentRuntimeReadiness => ({ ready, code, message, inactiveRoles: [...inactiveRoles] });
  if (!configured) return result(false, "NATIVE_AGENT_RUNTIME_NOT_CONFIGURED", "尚未保存应用运行配置；会员提交保持关闭");
  if (!config.enabled) return result(false, "NATIVE_AGENT_RUNTIME_DISABLED", "已保存禁用候选；不会启动 Agent 或调用模型");
  for (const id of config.allowedModelIds) {
    const choice = choices.find(item => item.id === id);
    if (!choice?.available) return result(false, "NATIVE_AGENT_RUNTIME_MODEL_UNAVAILABLE", choice ? `${choice.displayName}：${choice.reasons.join("；")}` : "允许列表中的模型已不在当前资源池");
  }
  for (const role of NATIVE_AGENT_RUNTIME_ROLES) {
    const id = config.modelIds[role];
    if (!id || !config.allowedModelIds.includes(id) || !choices.find(item => item.id === id)?.available)
      return result(false, "NATIVE_AGENT_RUNTIME_ROLE_UNAVAILABLE", "角色模型未配置、未加入允许列表或当前不可用");
  }
  return result(true, "NATIVE_AGENT_RUNTIME_CONFIG_READY", "默认模型与预算配置就绪；后台和深度思考角色仅保存，当前执行链暂未启用。供应商、依赖和任务准入由执行时继续核验");
}
function parseStoredConfig(raw: unknown): { revision: number; config: NativeAgentRuntimeConfig; configHash: string; updatedAt: string | null } {
  const value = record(raw), parsed = NativeAgentRuntimeConfigSchema.safeParse(value.config), revision = Number(value.revision);
  if (!parsed.success || !Number.isSafeInteger(revision) || revision < 1 || !/^[a-f0-9]{64}$/u.test(String(value.config_hash))
    || nativeAgentRuntimeConfigHash(parsed.data) !== value.config_hash)
    throw new NativeAgentRuntimeConfigError("NATIVE_AGENT_RUNTIME_CONFIG_INVALID", "已保存的运行配置格式或完整性校验失败，请管理员核对存储");
  return { revision, config: parsed.data, configHash: String(value.config_hash), updatedAt: typeof value.updated_at === "string" ? value.updated_at : null };
}

export async function readNativeAgentRuntimeConfig(db: SupabaseClient): Promise<NativeAgentRuntimeAdminState> {
  const [stored, models] = await Promise.all([
    db.from("pub_native_agent_runtime_config").select(CONFIG_FIELDS).eq("singleton", true).maybeSingle(),
    db.from("llm_models").select(MODEL_FIELDS).order("sort_order", { ascending: true }),
  ]);
  if (stored.error) storeError(stored.error, "read");
  if (models.error) throw new NativeAgentRuntimeConfigError("NATIVE_AGENT_RUNTIME_MODEL_POOL_UNAVAILABLE", "暂时无法读取主站模型资源池");
  const choices = nativeAgentRuntimeModelChoices(models.data ?? []);
  const current = stored.data ? parseStoredConfig(stored.data) : { revision: 0, configHash: null, updatedAt: null, config: NativeAgentRuntimeConfigSchema.parse({}) };
  return { ...current, configured: Boolean(stored.data), choices, readiness: nativeAgentRuntimeReadiness(current.config, choices, Boolean(stored.data)) };
}

/** Request-time resolution never borrows the first model from a global selector. */
export async function resolveNativeAgentRuntimeSnapshot(db: SupabaseClient): Promise<NativeAgentRuntimeConfigSnapshot> {
  const state = await readNativeAgentRuntimeConfig(db);
  if (!state.readiness.ready || !state.configHash) throw new NativeAgentRuntimeConfigError(state.readiness.code, state.readiness.message, 503);
  const config = state.config;
  const roles = Object.fromEntries(NATIVE_AGENT_RUNTIME_ROLES.map(role => {
    const choice = state.choices.find(item => item.id === config.modelIds[role])!;
    return [role, { modelId: choice.id, modelName: choice.modelName }];
  })) as NativeAgentRuntimeConfigSnapshot["roles"];
  return { revision: state.revision, configHash: state.configHash, roles, maxCallsPerTurn: config.maxCallsPerTurn,
    maxOutputTokens: config.maxOutputTokens, maxInputBytes: config.maxInputBytes, maxCreditsPerTurn: config.maxCreditsPerTurn };
}

export async function saveNativeAgentRuntimeConfig(db: SupabaseClient, actorId: string, raw: unknown): Promise<NativeAgentRuntimeAdminState> {
  const parsed = NativeAgentRuntimeSaveSchema.safeParse(raw);
  if (!parsed.success) throw new NativeAgentRuntimeConfigError("NATIVE_AGENT_RUNTIME_INPUT_INVALID", "运行配置或预算格式无效，请检查模型允许列表和数值范围", 422);
  const { config, expectedRevision } = parsed.data, before = await readNativeAgentRuntimeConfig(db);
  if (before.revision !== expectedRevision) throw new NativeAgentRuntimeConfigError("NATIVE_AGENT_RUNTIME_REVISION_CONFLICT", "配置已被其他管理员修改，请重新读取后合并您的改动", 409);
  const readiness = nativeAgentRuntimeReadiness(config, before.choices);
  if (config.enabled && !readiness.ready) throw new NativeAgentRuntimeConfigError(readiness.code, readiness.message, 422);
  const configHash = nativeAgentRuntimeConfigHash(config);
  const saved = await db.rpc("mutate_native_agent_runtime_config", { p_actor: actorId, p_expected_revision: expectedRevision, p_config: config, p_config_hash: configHash });
  if (saved.error) storeError(saved.error, "save");
  const returned = parseStoredConfig(Array.isArray(saved.data) ? saved.data[0] : saved.data);
  if (returned.revision !== expectedRevision + 1 || returned.configHash !== configHash)
    throw new NativeAgentRuntimeConfigError("NATIVE_AGENT_RUNTIME_SAVE_UNCONFIRMED", "保存返回版本未能对应本次请求，请重新读取后再操作");
  const readback = await readNativeAgentRuntimeConfig(db);
  if (readback.revision !== returned.revision || readback.configHash !== configHash)
    throw new NativeAgentRuntimeConfigError("NATIVE_AGENT_RUNTIME_READBACK_CONFLICT", "保存后配置发生变化，当前保存结果待核对；请重新读取并合并改动", 409);
  return readback;
}
