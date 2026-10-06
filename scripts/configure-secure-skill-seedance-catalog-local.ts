import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { createClient } from "@supabase/supabase-js";

import {
  forceNewVideoModelPending,
  isActivationGatedVideoConfig,
  prepareVideoModelBindingUpdate,
} from "../src/lib/model-activation-gate";

type JsonRecord = Record<string, unknown>;

const APPLY = process.argv.includes("--apply");
const RUNTIME_CONFIG = "F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json";
const ENDPOINT = "https://token.secure-skill.com";
const GROUP_37_SECRET_REF = "secret://secure-skill-seedance-official-token";
const GROUP_42_SECRET_REF = "secret://secure-skill-seedance-video";
const EXISTING_GROUP_42_ID = "secure-skill-seedance-2-5-g42";

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as JsonRecord)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function tokenProtocolConfig(input: {
  modelName: string;
  maxDuration: number;
  noReferenceCost: number;
  referenceVideoCost: number;
  noReferencePrice: number;
  referenceVideoPrice: number;
}): JsonRecord {
  return {
    submit_path: "/api/v3/contents/generations/tasks",
    poll_path: "/api/v3/contents/generations/tasks/{id}",
    provider_group_id: 37,
    connection_group: "Seedance 官方 Token 版 · 分组37",
    provider_channel: "secure-skill:seedance-official-token:37",
    provider_billing_unit: "token",
    billing_unit: "per_use",
    public_billing_pending: true,
    public_billing_pending_reason: "等待本站按 usage.total_tokens 精确结算后再启用生成",
    duration_options: Array.from({ length: input.maxDuration - 3 }, (_, index) => index + 4),
    min_duration: 4,
    min_submit_duration: 4,
    max_duration: input.maxDuration,
    duration_step: 1,
    resolution_options: ["720p"],
    default_resolution: "720p",
    aspect_ratios: ["16:9", "9:16", "1:1", "21:9", "4:3", "3:4"],
    workflow_input_mode: "multi_image_audio",
    supports_prompt: true,
    required_reference_images: 0,
    max_reference_images: 10,
    supports_audio_input: true,
    required_reference_audios: 0,
    max_reference_audios: 10,
    supports_source_video: true,
    supports_source_video_input: true,
    requires_source_video: false,
    generate_audio: false,
    supports_remote_cancel: false,
    persist_result_immediately: true,
    result_url_path: "content.video_url",
    usage_total_tokens_path: "usage.total_tokens",
    usage_completion_tokens_path: "usage.completion_tokens",
    token_cost_prices_per_million: {
      "720p:no_reference_video": input.noReferenceCost,
      "720p:reference_video": input.referenceVideoCost,
    },
    token_sale_prices_per_million: {
      "720p:no_reference_video": input.noReferencePrice,
      "720p:reference_video": input.referenceVideoPrice,
    },
    supplier_pricing_note: `模型 ${input.modelName}；720p 按最终 Token 用量结算；参考视频与无参考视频使用不同费率`,
    documentation_url: "https://token.secure-skill.com/docs#doubao-seedance",
    price_source_url: "https://token.secure-skill.com/api/v1/pricing/channels",
    price_verified_at: "2026-09-08T00:00:00.000Z",
    price_verification: "provider-live-catalog",
    workspace_surfaces: ["ai-video", "storyboard"],
  };
}

function row(input: {
  id: string;
  name: string;
  modelName: string;
  maxDuration: number;
  sortOrder: number;
  noReferenceCost: number;
  referenceVideoCost: number;
  noReferencePrice: number;
  referenceVideoPrice: number;
}): JsonRecord {
  const config = tokenProtocolConfig(input);
  return forceNewVideoModelPending({
    id: input.id,
    name: input.name,
    model_name: input.modelName,
    provider: "secure_skill_doubao_seedance",
    protocol_type: "secure_skill_doubao_seedance",
    api_endpoint: ENDPOINT,
    api_key: GROUP_37_SECRET_REF,
    price_per_use: input.noReferencePrice,
    cost_price: input.noReferenceCost,
    currency: "CNY",
    duration_seconds: 6,
    max_duration: input.maxDuration,
    supports_image_input: true,
    requires_image: false,
    is_active: false,
    is_hidden: false,
    sort_order: input.sortOrder,
    admin_notes: [
      "渠道：Secure Skill 中转 · Seedance 官方 Token 版 · 分组37；不是火山官方直连。",
      `成本：无参考视频 ¥${input.noReferenceCost}/百万Token，含参考视频 ¥${input.referenceVideoCost}/百万Token。`,
      `本站显式售价：无参考视频 ¥${input.noReferencePrice}/百万Token，含参考视频 ¥${input.referenceVideoPrice}/百万Token；来自该渠道已核对的运营价表，不按百分比自动推导。`,
      "数据库仅保存 secret:// 引用；本机密钥由 Windows DPAPI 保存。",
      "上游 1080p 后台价格尚未配置，本站只开放 720p。",
      "当前已完成密钥和协议接入；精确 Token 结算与真实生成验收完成前保持生成未启用。",
    ].join("\n"),
    api_protocol_config: config,
  });
}

const MODELS = [
  row({
    id: "secure-skill-doubao-seedance-2-0-g37",
    name: "Seedance 2.0 · 官方Token · 4–15秒 · 720P · 渠道A · 分组37",
    modelName: "doubao-seedance-2-0-260128",
    maxDuration: 15,
    sortOrder: 1370,
    noReferenceCost: 31.74,
    referenceVideoCost: 19.32,
    noReferencePrice: 34.914,
    referenceVideoPrice: 21.252,
  }),
  row({
    id: "secure-skill-doubao-seedance-2-0-fast-g37",
    name: "Seedance 2.0 Fast · 官方Token · 4–15秒 · 720P · 渠道A · 分组37",
    modelName: "doubao-seedance-2-0-fast-260128",
    maxDuration: 15,
    sortOrder: 1371,
    noReferenceCost: 25.53,
    referenceVideoCost: 15.18,
    noReferencePrice: 28.083,
    referenceVideoPrice: 16.698,
  }),
  row({
    id: "secure-skill-doubao-seedance-2-5-g37",
    name: "Seedance 2.5 · 官方Token · 4–30秒 · 720P · 渠道A · 分组37",
    modelName: "doubao-seedance-2-5-260628",
    maxDuration: 30,
    sortOrder: 1372,
    noReferenceCost: 49.7,
    referenceVideoCost: 29.82,
    noReferencePrice: 54.67,
    referenceVideoPrice: 32.802,
  }),
];

const TARGET_IDS = new Set([EXISTING_GROUP_42_ID, ...MODELS.map((model) => String(model.id))]);

async function main() {
  const runtime = JSON.parse((await readFile(RUNTIME_CONFIG, "utf8")).replace(/^\uFEFF/u, "")) as JsonRecord;
  assert.equal(runtime.localOnly, true, "Seedance catalog writes are allowed only against the isolated local runtime");
  const runtimeUrl = new URL(String(runtime.supabaseUrl || ""));
  assert.equal(runtimeUrl.hostname, "127.0.0.1", "Seedance catalog writes must stay on localhost");
  const serviceRoleKey = String(runtime.serviceRoleKey || "");
  assert.ok(serviceRoleKey, "local runtime service-role key is missing");

  const db = createClient(runtimeUrl.toString().replace(/\/$/u, ""), serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const beforeResult = await db.from("video_models").select("*").order("id");
  if (beforeResult.error) throw beforeResult.error;
  const before = (beforeResult.data || []) as JsonRecord[];
  const existingGroup42 = before.find((model) => model.id === EXISTING_GROUP_42_ID);
  assert.ok(existingGroup42, "existing Seedance 2.5 group 42 record is missing");
  const unaffectedBefore = before.filter((model) => !TARGET_IDS.has(String(model.id)));

  const safeTargets = before.filter((model) => TARGET_IDS.has(String(model.id))).map(({ api_key, ...model }) => ({
    ...model,
    credential_configured: Boolean(String(api_key || "").trim()),
  }));
  const stamp = new Date().toISOString().replace(/[:.]/gu, "");
  const backupDir = path.join("backups", `secure-skill-seedance-${stamp}`);
  await mkdir(backupDir, { recursive: true });
  await writeFile(path.join(backupDir, "targets.before.sanitized.json"), `${JSON.stringify(safeTargets, null, 2)}\n`);
  await writeFile(path.join(backupDir, "manifest.json"), `${JSON.stringify({
    schema: "secure_skill_seedance_catalog_backup.v1",
    created_at: new Date().toISOString(),
    runtime_local_only: true,
    target_ids: [...TARGET_IDS],
    credentials_in_backup: false,
    provider_key_creation_groups: [37, 42],
    paid_generation_calls: 0,
    apply_requested: APPLY,
  }, null, 2)}\n`);

  const group42Patch = prepareVideoModelBindingUpdate(existingGroup42 as never, {
    api_key: GROUP_42_SECRET_REF,
    is_active: false,
    is_hidden: false,
    admin_notes: [
      "渠道：Secure Skill 中转 · Seedance 视频 · 分组42；不是火山官方直连。",
      "成本 ¥0.45/输出秒，本站显式售价 ¥0.495/输出秒；来自该渠道已核对的运营价表，不按百分比自动推导。",
      "数据库仅保存 secret:// 引用；本机密钥由 Windows DPAPI 保存。",
      "已完成分组42专用密钥配置；真实生成验收完成前保持生成未启用。",
    ].join("\n"),
  });

  if (!APPLY) {
    console.log(JSON.stringify({
      mode: "dry-run",
      backupDir,
      group42: { id: EXISTING_GROUP_42_ID, secretRef: GROUP_42_SECRET_REF },
      group37: MODELS.map(({ api_key: _secret, ...model }) => model),
      paidGenerationCalls: 0,
    }, null, 2));
    return;
  }

  const group42Update = await db.from("video_models").update(group42Patch).eq("id", EXISTING_GROUP_42_ID);
  if (group42Update.error) throw group42Update.error;
  const upsert = await db.from("video_models").upsert(MODELS, { onConflict: "id" });
  if (upsert.error) throw upsert.error;

  const afterResult = await db.from("video_models").select("*").order("id");
  if (afterResult.error) throw afterResult.error;
  const after = (afterResult.data || []) as JsonRecord[];
  const targetAfter = after.filter((model) => TARGET_IDS.has(String(model.id)));
  const unaffectedAfter = after.filter((model) => !TARGET_IDS.has(String(model.id)));
  assert.equal(targetAfter.length, 4, "all four Seedance channel records must exist exactly once");
  assert.equal(stable(unaffectedAfter), stable(unaffectedBefore), "a non-target video model changed");
  for (const model of targetAfter) {
    assert.equal(model.is_active, false, `${model.id} must remain inactive before paid canary acceptance`);
    assert.equal(model.is_hidden, false, `${model.id} must remain visible to administrators`);
    assert.equal(isActivationGatedVideoConfig(model.api_protocol_config), true, `${model.id} must retain the activation gate`);
    assert.match(String(model.api_key || ""), /^secret:\/\/secure-skill-seedance/u, `${model.id} must use a Seedance secret reference`);
  }

  console.log(JSON.stringify({
    mode: "applied",
    backupDir,
    database: "local-only",
    configured: targetAfter.map((model) => ({
      id: model.id,
      model_name: model.model_name,
      protocol_type: model.protocol_type,
      provider_group_id: (model.api_protocol_config as JsonRecord)?.provider_group_id,
      active: model.is_active,
      hidden: model.is_hidden,
      credential_reference_configured: Boolean(model.api_key),
    })).sort((left, right) => String(left.id).localeCompare(String(right.id))),
    nonTargetModelsUnchanged: true,
    paidGenerationCalls: 0,
  }, null, 2));
}

void main().catch((error) => {
  const candidate = error && typeof error === "object" ? error as JsonRecord : {};
  console.error(JSON.stringify({
    name: String(candidate.name || "Error"),
    message: String(candidate.message || error || "Seedance catalog configuration failed"),
    code: String(candidate.code || ""),
    paidGenerationCalls: 0,
  }));
  process.exitCode = 1;
});
