import "server-only";

import { NextResponse } from "next/server";
import { getSupabaseAdminClient } from "@/storage/database/supabase-client";

/**
 * 1.3 最小读层：带货运行开关的只读读取。
 *
 * 优先级：platform_settings（后台配置）> 环境变量（兜底）> 代码内默认（不在此复制数值）。
 * 不建表、不写迁移；只读 platform_settings 里登记过的键。
 * 只接受整数/开关两种形态，环境变量原值从不回传；形态不对的值记为无效并跳过。
 * 本读层不加缓存，因此不需要在 platform-settings-runtime-cache.ts 里登记失效。
 * 第一批只做读取与管理员查看，worker 仍按启动时的环境变量运行（周期重读不在第一批）。
 */
export type RuntimeFlagType = "integer" | "switch";
export type RuntimeFlagSource = "platform_settings" | "env" | "code-default";

export interface RuntimeFlagDefinition {
  key: string;
  settingKey: string;
  envName: string;
  type: RuntimeFlagType;
  label: string;
  codeReference: string;
}

/** 只登记代码里现有的非密钥运行参数（env 名逐字取自 codeReference 所指文件）。 */
export const COMMERCE_RUNTIME_FLAGS: readonly RuntimeFlagDefinition[] = [
  { key: "commerce.provider_concurrency", settingKey: "commerce_runtime.provider_concurrency", envName: "COMMERCE_PROVIDER_CONCURRENCY", type: "integer", label: "带货供应商并发上限", codeReference: "src/commerce/server/ordinary-worker.ts:54" },
  { key: "commerce.ordinary_lease_ms", settingKey: "commerce_runtime.ordinary_lease_ms", envName: "COMMERCE_ORDINARY_LEASE_MS", type: "integer", label: "普通任务租约（毫秒）", codeReference: "src/commerce/server/ordinary-worker.ts:53" },
  { key: "commerce.rolling_lease_ms", settingKey: "commerce_runtime.rolling_lease_ms", envName: "COMMERCE_ROLLING_LEASE_MS", type: "integer", label: "滚动视频租约（毫秒）", codeReference: "src/commerce/server/rolling-video-worker.ts:17" },
  { key: "commerce.job_execution_lease_ms", settingKey: "commerce_runtime.job_execution_lease_ms", envName: "COMMERCE_JOB_EXECUTION_LEASE_MS", type: "integer", label: "任务执行租约（毫秒）", codeReference: "src/commerce/server/jobs.ts:56" },
  { key: "commerce.undispatched_recovery_ms", settingKey: "commerce_runtime.undispatched_recovery_ms", envName: "COMMERCE_UNDISPATCHED_RECOVERY_MS", type: "integer", label: "未下发任务恢复间隔（毫秒）", codeReference: "src/commerce/server/jobs.ts:257" },
  { key: "commerce.ordinary_worker", settingKey: "commerce_runtime.ordinary_worker", envName: "COMMERCE_ORDINARY_WORKER", type: "switch", label: "普通任务 worker 开关", codeReference: "src/commerce/server/ordinary-worker.ts:197" },
  { key: "commerce.rolling_worker", settingKey: "commerce_runtime.rolling_worker", envName: "COMMERCE_ROLLING_WORKER", type: "switch", label: "滚动视频 worker 开关", codeReference: "src/commerce/server/rolling-video-worker.ts:132" },
];

export interface RuntimeFlagSettingRow {
  setting_key: string;
  setting_value: unknown;
  updated_at?: string | null;
}

export interface RuntimeFlagReading {
  key: string;
  settingKey: string;
  envName: string;
  type: RuntimeFlagType;
  label: string;
  codeReference: string;
  value: number | boolean | null;
  source: RuntimeFlagSource;
  updated_at: string | null;
  invalidSources: RuntimeFlagSource[];
}

export interface RuntimeFlagReadDependencies {
  readSettings: (settingKeys: string[]) => Promise<RuntimeFlagSettingRow[]>;
  env: Readonly<Record<string, string | undefined>>;
}

function parseFlagValue(type: RuntimeFlagType, raw: unknown): number | boolean | undefined {
  if (raw === null || raw === undefined) return undefined;
  if (type === "integer") {
    const text = typeof raw === "number" ? String(raw) : typeof raw === "string" ? raw.trim() : "";
    return /^\d{1,9}$/u.test(text) ? Number(text) : undefined;
  }
  if (typeof raw === "boolean") return raw;
  const text = typeof raw === "number" ? String(raw) : typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (text === "1" || text === "true") return true;
  if (text === "0" || text === "false") return false;
  return undefined;
}

export async function readRuntimeFlags(
  dependencies: RuntimeFlagReadDependencies,
  definitions: readonly RuntimeFlagDefinition[] = COMMERCE_RUNTIME_FLAGS,
): Promise<{ settingsAvailable: boolean; flags: RuntimeFlagReading[] }> {
  let rows: RuntimeFlagSettingRow[] = [];
  let settingsAvailable = true;
  try {
    rows = await dependencies.readSettings(definitions.map((definition) => definition.settingKey));
  } catch {
    settingsAvailable = false;
  }
  const bySettingKey = new Map(rows.filter((row) => row && typeof row.setting_key === "string").map((row) => [row.setting_key, row]));
  const flags = definitions.map((definition): RuntimeFlagReading => {
    const invalidSources: RuntimeFlagSource[] = [];
    const base = { key: definition.key, settingKey: definition.settingKey, envName: definition.envName, type: definition.type, label: definition.label, codeReference: definition.codeReference };
    const row = bySettingKey.get(definition.settingKey);
    if (row) {
      const parsed = parseFlagValue(definition.type, row.setting_value);
      if (parsed !== undefined) return { ...base, value: parsed, source: "platform_settings", updated_at: row.updated_at ?? null, invalidSources };
      invalidSources.push("platform_settings");
    }
    const rawEnv = dependencies.env[definition.envName];
    if (rawEnv !== undefined && rawEnv !== "") {
      const parsed = parseFlagValue(definition.type, rawEnv);
      if (parsed !== undefined) return { ...base, value: parsed, source: "env", updated_at: null, invalidSources };
      invalidSources.push("env");
    }
    return { ...base, value: null, source: "code-default", updated_at: null, invalidSources };
  });
  return { settingsAvailable, flags };
}

export async function readRuntimeFlagSettingsFromPlatformSettings(settingKeys: string[]): Promise<RuntimeFlagSettingRow[]> {
  if (!settingKeys.length) return [];
  const { data, error } = await getSupabaseAdminClient()
    .from("platform_settings")
    .select("setting_key,setting_value,updated_at")
    .in("setting_key", settingKeys);
  if (error) throw new Error("PLATFORM_SETTINGS_UNAVAILABLE");
  return (data || []) as RuntimeFlagSettingRow[];
}

type AuthorizationOutcome = { actor: unknown } | { response: Response };

/** 管理员专用只读接口。依赖注入只为本机夹具测试，生产用路由文件里的默认实现。 */
export function createRuntimeFlagsReadHandler(dependencies: RuntimeFlagReadDependencies & { authorize: (request: Request) => Promise<AuthorizationOutcome> }) {
  return async function readRuntimeFlagsRoute(request: Request): Promise<Response> {
    const authorization = await dependencies.authorize(request);
    if ("response" in authorization) return authorization.response;
    const result = await readRuntimeFlags(dependencies);
    return NextResponse.json({
      ok: true,
      precedence: ["platform_settings", "env", "code-default"],
      settingsAvailable: result.settingsAvailable,
      flags: result.flags,
    }, { headers: { "Cache-Control": "no-store" } });
  };
}
