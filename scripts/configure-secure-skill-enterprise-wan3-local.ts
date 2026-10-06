import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { createClient } from "@supabase/supabase-js";

import { forceNewVideoModelPending, isActivationGatedVideoConfig } from "../src/lib/model-activation-gate";

type JsonRecord = Record<string, unknown>;

const APPLY = process.argv.includes("--apply");
const RUNTIME_CONFIG = "F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json";
const ENDPOINT = "https://token.secure-skill.com";
const ENTERPRISE_SECRET_REF = "secret://secure-skill-video-enterprise";
const PRICE_SOURCE = "https://token.secure-skill.com/api/v1/pricing/channels";
const DOCS_SOURCE = "https://token.secure-skill.com/docs";
const VERIFIED_AT = "2026-09-08T00:00:00.000Z";

const ENTERPRISE_IDS = new Set([
  "secure-skill-seedance-2-5-enterprise-g16",
  "secure-skill-video-2-0-fast-g16",
  "secure-skill-video-2-0-pro-g16",
]);
const WAN_IDS = new Set([
  "secure-skill-wan3-video-ch40",
  "secure-skill-wan3-video-prime-ch40",
]);
const TARGET_IDS = new Set([...ENTERPRISE_IDS, ...WAN_IDS]);

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as JsonRecord)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function enterpriseConfig(input: { maxDuration: number; cost: number; sale: number }): JsonRecord {
  return {
    submit_path: "/v1/videos",
    poll_path: "/v1/videos/{id}",
    provider_group_id: 16,
    connection_group: "video-企业版 · 分组16",
    provider_channel: "secure-skill:video-enterprise:16",
    billing_unit: "output_second",
    duration_options: Array.from({ length: input.maxDuration - 4 }, (_, index) => index + 5),
    min_duration: 5,
    min_submit_duration: 5,
    max_duration: input.maxDuration,
    duration_step: 1,
    resolution_options: ["720p"],
    default_resolution: "720p",
    resolution_cost_prices: { "720p": input.cost },
    resolution_prices: { "720p": input.sale },
    aspect_ratios: ["16:9", "9:16"],
    workflow_input_mode: "multi_image_audio",
    supports_prompt: true,
    required_reference_images: 0,
    max_reference_images: 9,
    supports_audio_input: true,
    required_reference_audios: 0,
    max_reference_audios: 3,
    supports_source_video: false,
    supports_source_video_input: false,
    requires_source_video: false,
    supports_remote_cancel: false,
    persist_result_immediately: true,
    result_url_path: "video_url",
    documentation_url: DOCS_SOURCE,
    price_source_url: PRICE_SOURCE,
    price_verified_at: VERIFIED_AT,
    price_verification: "provider-live-catalog",
    supplier_pricing_note: `720p ¥${input.cost}/输出秒；本站售价 ¥${input.sale}/输出秒`,
    workspace_surfaces: ["video-page", "storyboard-workbench"],
  };
}

function enterpriseRow(input: {
  id: string;
  name: string;
  modelName: string;
  cost: number;
  sale: number;
  minDuration: number;
  maxDuration: number;
  sortOrder: number;
}): JsonRecord {
  const config = enterpriseConfig({ maxDuration: input.maxDuration, cost: input.cost, sale: input.sale });
  config.min_duration = input.minDuration;
  config.min_submit_duration = input.minDuration;
  config.duration_options = Array.from({ length: input.maxDuration - input.minDuration + 1 }, (_, index) => index + input.minDuration);
  return forceNewVideoModelPending({
    id: input.id,
    name: input.name,
    model_name: input.modelName,
    provider: "secure_skill_enterprise_video",
    protocol_type: "secure_skill_enterprise_video",
    api_endpoint: ENDPOINT,
    api_key: ENTERPRISE_SECRET_REF,
    price_per_use: input.sale,
    cost_price: input.cost,
    currency: "CNY",
    duration_seconds: Math.max(input.minDuration, 8),
    max_duration: input.maxDuration,
    supports_image_input: true,
    requires_image: false,
    is_active: false,
    is_hidden: true,
    sort_order: input.sortOrder,
    admin_notes: [
      "渠道：Secure Skill 中转 · video-企业版 · 分组16；不是火山官方直连。",
      `成本 ¥${input.cost}/输出秒；本站显式售价 ¥${input.sale}/输出秒，来自该渠道已核对的运营价表，不按百分比自动推导。`,
      "固定 720p；支持纯文生、最多9张参考图片和最多3条参考音频；不支持参考视频。",
      "数据库仅保存 secret:// 引用；本机密钥由 Windows DPAPI 保存。",
      "当前已完成专用密钥、目录权限和协议适配；真实生成验收完成前保持隐藏且不可用。",
    ].join("\n"),
    api_protocol_config: config,
  } as never) as unknown as JsonRecord;
}

const ENTERPRISE_ROWS = [
  enterpriseRow({
    id: "secure-skill-seedance-2-5-enterprise-g16",
    name: "Seedance 2.5 · 企业渠道 · 5–30秒 · 720P · 分组16",
    modelName: "seedance-2.5",
    cost: 1.2,
    sale: 1.32,
    minDuration: 5,
    maxDuration: 30,
    sortOrder: 4160,
  }),
  enterpriseRow({
    id: "secure-skill-video-2-0-fast-g16",
    name: "Video 2.0 Fast · 企业渠道 · 5–15秒 · 720P · 分组16",
    modelName: "video-2.0-fast",
    cost: 0.55,
    sale: 0.605,
    minDuration: 5,
    maxDuration: 15,
    sortOrder: 4161,
  }),
  enterpriseRow({
    id: "secure-skill-video-2-0-pro-g16",
    name: "Video 2.0 Pro · 企业渠道 · 5–15秒 · 720P · 分组16",
    modelName: "video-2.0-pro",
    cost: 0.68,
    sale: 0.748,
    minDuration: 5,
    maxDuration: 15,
    sortOrder: 4162,
  }),
];

function updateWan(row: JsonRecord): JsonRecord {
  const prime = row.id === "secure-skill-wan3-video-prime-ch40";
  const costs = prime ? { "480p": 0.25, "720p": 0.3, "1080p": 0.4 } : { "480p": 0.19, "720p": 0.19, "1080p": 0.35 };
  const sales = prime ? { "480p": 0.275, "720p": 0.33, "1080p": 0.44 } : { "480p": 0.209, "720p": 0.209, "1080p": 0.385 };
  const existingConfig = row.api_protocol_config && typeof row.api_protocol_config === "object"
    ? row.api_protocol_config as JsonRecord
    : {};
  return {
    ...row,
    cost_price: costs["480p"],
    price_per_use: sales["480p"],
    admin_notes: [
      "渠道：Secure Skill 中转 · wan3视频 · 分组40；不是阿里官方直连。",
      prime
        ? "成本：480p ¥0.25/秒、720p ¥0.30/秒、1080p ¥0.40/秒；本站显式售价为 ¥0.275、¥0.33、¥0.44/秒，来自该渠道已核对的运营价表。"
        : "成本：480p/720p ¥0.19/秒、1080p ¥0.35/秒；本站显式售价为 ¥0.209、¥0.209、¥0.385/秒，来自该渠道已核对的运营价表。",
      "数据库仅保存分组40专用 secret:// 引用；当前既有真实验收与启用状态保持不变。",
    ].join("\n"),
    api_protocol_config: {
      ...existingConfig,
      provider_group_id: 40,
      connection_group: "wan3视频 · 分组40",
      provider_channel: "secure-skill:wan3:40",
      billing_unit: "output_second",
      resolution_options: ["480p", "720p", "1080p"],
      default_resolution: "480p",
      resolution_cost_prices: costs,
      resolution_prices: sales,
      documentation_url: DOCS_SOURCE,
      price_source_url: PRICE_SOURCE,
      price_verified_at: VERIFIED_AT,
      price_verification: "provider-live-catalog",
      supplier_pricing_note: prime
        ? "480p ¥0.25/s; 720p ¥0.30/s; 1080p ¥0.40/s"
        : "480p/720p ¥0.19/s; 1080p ¥0.35/s",
    },
  };
}

async function main() {
  const runtime = JSON.parse((await readFile(RUNTIME_CONFIG, "utf8")).replace(/^\uFEFF/u, "")) as JsonRecord;
  assert.equal(runtime.localOnly, true, "catalog writes are allowed only against the isolated local runtime");
  const runtimeUrl = new URL(String(runtime.supabaseUrl || ""));
  assert.equal(runtimeUrl.hostname, "127.0.0.1", "catalog writes must stay on localhost");
  const serviceRoleKey = String(runtime.serviceRoleKey || "");
  assert.ok(serviceRoleKey, "local runtime service-role key is missing");
  const db = createClient(runtimeUrl.toString().replace(/\/$/u, ""), serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const beforeResult = await db.from("video_models").select("*").order("id");
  if (beforeResult.error) throw beforeResult.error;
  const before = (beforeResult.data || []) as JsonRecord[];
  const unaffectedBefore = before.filter((row) => !TARGET_IDS.has(String(row.id)));
  const safeBefore = before.filter((row) => TARGET_IDS.has(String(row.id))).map(({ api_key, ...row }) => ({
    ...row,
    credential_configured: Boolean(String(api_key || "").trim()),
  }));
  const existingWan = before.filter((row) => WAN_IDS.has(String(row.id)));
  assert.equal(existingWan.length, 2, "both existing Wan3 group 40 rows are required");

  const stamp = new Date().toISOString().replace(/[:.]/gu, "");
  const backupDir = path.join("backups", `secure-skill-enterprise-wan3-${stamp}`);
  await mkdir(backupDir, { recursive: true });
  await writeFile(path.join(backupDir, "targets.before.sanitized.json"), `${JSON.stringify(safeBefore, null, 2)}\n`);
  await writeFile(path.join(backupDir, "manifest.json"), `${JSON.stringify({
    schema: "secure_skill_enterprise_wan3_catalog_backup.v1",
    created_at: new Date().toISOString(),
    runtime_local_only: true,
    target_ids: [...TARGET_IDS],
    credentials_in_backup: false,
    paid_generation_calls: 0,
    apply_requested: APPLY,
  }, null, 2)}\n`);

  const desired = [...ENTERPRISE_ROWS, ...existingWan.map(updateWan)];
  if (!APPLY) {
    console.log(JSON.stringify({
      mode: "dry-run",
      backupDir,
      targetIds: desired.map((row) => row.id),
      enterpriseRows: ENTERPRISE_ROWS.map((row) => ({ id: row.id, model_name: row.model_name, cost: row.cost_price, sale: row.price_per_use })),
      wanRows: existingWan.map(updateWan).map((row) => ({ id: row.id, group: (row.api_protocol_config as JsonRecord)?.provider_group_id, cost: row.cost_price, sale: row.price_per_use })),
      paidGenerationCalls: 0,
    }, null, 2));
    return;
  }

  const upsert = await db.from("video_models").upsert(desired, { onConflict: "id" });
  if (upsert.error) throw upsert.error;
  const afterResult = await db.from("video_models").select("*").order("id");
  if (afterResult.error) throw afterResult.error;
  const after = (afterResult.data || []) as JsonRecord[];
  const targets = after.filter((row) => TARGET_IDS.has(String(row.id)));
  const unaffectedAfter = after.filter((row) => !TARGET_IDS.has(String(row.id)));
  assert.equal(targets.length, 5, "all five requested channel records must exist exactly once");
  assert.equal(stable(unaffectedAfter), stable(unaffectedBefore), "a non-target model changed");
  for (const row of targets.filter((item) => ENTERPRISE_IDS.has(String(item.id)))) {
    assert.equal(row.is_active, false, `${row.id} must remain inactive before real canary acceptance`);
    assert.equal(row.is_hidden, true, `${row.id} must remain hidden before real canary acceptance`);
    assert.equal(isActivationGatedVideoConfig(row.api_protocol_config), true, `${row.id} must retain the activation gate`);
    assert.equal(row.api_key, ENTERPRISE_SECRET_REF, `${row.id} must use only the protected enterprise secret reference`);
  }
  for (const row of targets.filter((item) => WAN_IDS.has(String(item.id)))) {
    assert.equal((row.api_protocol_config as JsonRecord)?.provider_group_id, 40, `${row.id} group id mismatch`);
    assert.match(String(row.api_key || ""), /^secret:\/\/secure-skill-wan3-video/u, `${row.id} must retain its protected secret reference`);
  }

  console.log(JSON.stringify({
    mode: "applied",
    backupDir,
    database: "local-only",
    configured: targets.map((row) => ({
      id: row.id,
      model_name: row.model_name,
      group_id: (row.api_protocol_config as JsonRecord)?.provider_group_id,
      active: row.is_active,
      hidden: row.is_hidden,
      credential_reference_configured: String(row.api_key || "").startsWith("secret://"),
      cost: row.cost_price,
      sale: row.price_per_use,
    })).sort((left, right) => String(left.id).localeCompare(String(right.id))),
    nonTargetModelsUnchanged: true,
    paidGenerationCalls: 0,
  }, null, 2));
}

void main().catch((error) => {
  const candidate = error && typeof error === "object" ? error as JsonRecord : {};
  console.error(JSON.stringify({
    name: String(candidate.name || "Error"),
    message: String(candidate.message || error || "Secure Skill enterprise/Wan3 configuration failed"),
    code: String(candidate.code || ""),
    paidGenerationCalls: 0,
  }));
  process.exitCode = 1;
});
