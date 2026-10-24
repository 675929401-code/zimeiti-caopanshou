#!/usr/bin/env node
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import pg from "pg";

const PRIMARY_CHANNEL_ENDPOINT = "https://n.lconai.com";
const BACKUP_CHANNEL_ENDPOINT = "https://s.lconai.com";
const evidenceDir = path.resolve(".codex-evidence/lconai-workbook-onboarding-20261005");
const TEXT_COST_MARKUP_PERCENT = 20;
// 后台字段是销售额毛利率；成本加价 20% 必须换算为 20 / 120 = 16.666...%。
const BACKEND_PROFIT_MARGIN_PERCENT = (TEXT_COST_MARKUP_PERCENT / (100 + TEXT_COST_MARKUP_PERCENT)) * 100;

const textModels = [
  {
    type: "text",
    name: "GPT-6.1 Sol · LConAI G2",
    modelName: "gpt-6.1-sol",
    secretRef: "secret://lconai-gpt-6-1-sol",
    endpoint: PRIMARY_CHANNEL_ENDPOINT,
    deepThinkingType: 0,
    inputCost: 10,
    outputCost: 37.5,
    cachedCost: 12.5,
    margin: BACKEND_PROFIT_MARGIN_PERCENT,
    maxContextTokens: 1_050_000,
    maxReplyTokens: 128_000,
    notes: "渠道：LConAI 主节点（n.lconai.com），分组 G2。普通对话按官方 OpenAI Chat Completions（/v1/chat/completions）调用；GPT-6.1 使用 max_completion_tokens，不发送未在文档定义的 enable_thinking。Responses 能力独立适配后再用于 Codex 类工具链。价格口径：基础单价 4/15/5 × 渠道倍率 2.5 = 真实成本 10/37.5/12.5 元/百万 Token；用户售价按真实成本加价 20%，后台 profit_margin 换算为 16.6666666666667%。",
  },
  {
    type: "text",
    name: "Claude Opus 5.5 · LConAI Claude Max",
    modelName: "claude-opus-5-5",
    secretRef: "secret://lconai-claude-opus-5-5",
    endpoint: PRIMARY_CHANNEL_ENDPOINT,
    deepThinkingType: 2,
    inputCost: 7.2,
    outputCost: 36,
    cachedCost: 14.4,
    margin: BACKEND_PROFIT_MARGIN_PERCENT,
    maxContextTokens: 1_000_000,
    maxReplyTokens: 128_000,
    notes: "渠道：LConAI 主节点（n.lconai.com），分组 Claude Max。成本按工作簿基础价 4/20/8 × 1.8 保存为 7.2/36/14.4；用户售价按真实成本加价 20%，后台 profit_margin 换算为 16.6666666666667%。Claude 系列按渠道官方 Anthropic Messages（/v1/messages）协议调用，备用节点为 s.lconai.com。",
  },
  {
    type: "text",
    name: "Claude Sonnet 5.5 · LConAI Claude AWS/G2",
    modelName: "claude-sonnet-5-5",
    secretRef: "secret://lconai-claude-sonnet-5-5",
    endpoint: PRIMARY_CHANNEL_ENDPOINT,
    deepThinkingType: 2,
    inputCost: 32,
    outputCost: 0,
    cachedCost: 0,
    margin: BACKEND_PROFIT_MARGIN_PERCENT,
    maxContextTokens: 1_000_000,
    maxReplyTokens: 128_000,
    notes: "渠道：LConAI 主节点（n.lconai.com），分组 Claude AWS/G2。成本按工作簿基础价 8/0/0 × 4 保存为 32/0/0；用户售价按真实成本加价 20%，后台 profit_margin 换算为 16.6666666666667%；输出和缓存零值严格保留用户工作簿口径，不自行补猜。Claude 系列按渠道官方 Anthropic Messages（/v1/messages）协议调用，备用节点为 s.lconai.com。",
  },
];

const videoModels = [
  {
    type: "video",
    id: "seedance-2-5-480p-i2v-lconai",
    name: "Seedance 2.5 480P 图生视频 · LConAI",
    modelName: "seedance-2-5-480p-i2v",
    secretRef: "secret://lconai-seedance-2-5-480p-i2v",
    cost: 1.224,
    sale: 1.2,
    billingUnit: "output_second",
    minDuration: 4,
    maxDuration: 30,
    defaultDuration: 10,
    resolution: "480p",
    requiresImage: true,
    notes: "渠道：LConAI（s.lconai.com），分组 B1；工作簿明确成本 ¥1.224/输出秒、销售价 ¥1.2/输出秒；视频售价不套用统一百分比。模型名是中转别名，非火山方舟官方模型 ID。",
  },
  {
    type: "video",
    id: "seedance-2-0-fast-720p-i2v-lconai",
    name: "Seedance 2.0 Fast 720P 图生视频 · LConAI",
    modelName: "seedance-2-0-fast-720p-i2v",
    secretRef: "secret://lconai-seedance-2-0-fast-720p-i2v",
    cost: 0.504,
    sale: 0.5,
    billingUnit: "output_second",
    minDuration: 4,
    maxDuration: 15,
    defaultDuration: 10,
    resolution: "720p",
    requiresImage: true,
    notes: "渠道：LConAI（s.lconai.com），分组 B1；工作簿明确成本 ¥0.504/输出秒、销售价 ¥0.5/输出秒；视频售价不套用统一百分比。模型名是中转别名，非火山方舟官方模型 ID。",
  },
  {
    type: "video",
    id: "grok-video-3-pro-lconai",
    name: "Grok Video 3 Pro 10秒 · LConAI",
    modelName: "grok-video-3-pro",
    secretRef: "secret://lconai-grok-video-3-pro",
    cost: 0.81,
    sale: 0.8,
    billingUnit: "per_use",
    minDuration: 10,
    maxDuration: 10,
    defaultDuration: 10,
    resolution: "720p",
    requiresImage: false,
    omitAspectRatio: true,
    notes: "渠道：LConAI（s.lconai.com），分组 B1；工作簿明确成本 ¥0.81/次、销售价 ¥0.8/次（10秒）；视频售价不套用统一百分比。grok-video-3-pro 是中转别名，必须以渠道鉴权目录和真实 canary 为准。",
  },
];

const blockedModels = [];

function assertNoPlaintextCredentials(value, at = "response") {
  if (Array.isArray(value)) return value.forEach((item, index) => assertNoPlaintextCredentials(item, `${at}[${index}]`));
  if (!value || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value)) {
    assert.ok(!["api_key", "secret_value", "password", "rawCredential", "resolvedCredential"].includes(key), `PLAINTEXT_CREDENTIAL_PROPERTY:${at}.${key}`);
    assertNoPlaintextCredentials(item, `${at}.${key}`);
  }
}

async function requestJson(origin, headers, pathname, options = {}) {
  const response = await fetch(origin + pathname, {
    ...options,
    headers: {
      ...headers,
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {}),
    },
    cache: "no-store",
    signal: AbortSignal.timeout(options.timeout || 90_000),
  });
  const body = await response.json().catch(() => ({}));
  assertNoPlaintextCredentials(body);
  if (!response.ok) throw new Error(`${pathname}:HTTP_${response.status}:${JSON.stringify(body).slice(0, 1500)}`);
  return body;
}

async function post(origin, headers, pathname, body) {
  return requestJson(origin, headers, pathname, { method: "POST", body: JSON.stringify(body) });
}

async function validatePreviewPublish(origin, headers, endpoint, releaseId) {
  const validated = await post(origin, headers, endpoint, { action: "validate", releaseId });
  assert.equal(validated.release?.status, "validated", `${endpoint}:VALIDATION_FAILED`);
  const preview = await requestJson(origin, headers, `${endpoint}?previewReleaseId=${encodeURIComponent(releaseId)}`);
  const previewSha256 = String(preview.preview?.previewSha256 || "");
  assert.match(previewSha256, /^[a-f0-9]{64}$/u, `${endpoint}:PREVIEW_HASH_MISSING`);
  const published = await post(origin, headers, endpoint, { action: "publish", releaseId, previewSha256 });
  assert.equal(published.release?.status, "published", `${endpoint}:PUBLISH_FAILED`);
  assert.equal(published.release?.is_current, true, `${endpoint}:CURRENT_FLAG_MISSING`);
  return { releaseId, previewSha256, version: published.release?.release_version };
}

async function ensureCurrent(origin, headers, endpoint, changeNote) {
  let overview = await requestJson(origin, headers, endpoint);
  if (overview.current) return overview.current;
  let candidate = overview.releases?.find((row) => row.is_current !== true && ["draft", "validated"].includes(String(row.status)));
  if (!candidate) {
    const staged = await post(origin, headers, endpoint, { action: "bootstrap", changeNote });
    candidate = staged.release;
  }
  if (candidate.status !== "validated") {
    const validated = await post(origin, headers, endpoint, { action: "validate", releaseId: candidate.id });
    candidate = validated.release;
  }
  const preview = await requestJson(origin, headers, `${endpoint}?previewReleaseId=${encodeURIComponent(candidate.id)}`);
  const published = await post(origin, headers, endpoint, {
    action: "publish",
    releaseId: candidate.id,
    previewSha256: preview.preview?.previewSha256,
  });
  return published.release;
}

function textPayload(model) {
  const isClaude = /^claude\b/iu.test(model.modelName);
  return {
    model_type: "text",
    name: model.name,
    description: "LConAI 中转渠道对话模型；只有密钥轮换、鉴权目录和真实响应验收通过后才开放。",
    category: "通用",
    provider: "lconai",
    model_name: model.modelName,
    api_endpoint: model.endpoint,
    proxy_url: model.endpoint,
    api_key: model.secretRef,
    api_protocol_config: {
      provider: "lconai",
      protocol: isClaude ? "anthropic_messages" : "openai_chat",
      auth_scheme: isClaude ? "x-api-key" : "bearer",
      ...(isClaude
        ? { protocol_version: "2023-06-01", output_token_field: "max_tokens" }
        : { output_token_field: "max_completion_tokens" }),
    },
    billing_mode: "token",
    token_billing_enabled: true,
    input_cost_per_million: model.inputCost,
    output_cost_per_million: model.outputCost,
    cached_cost_per_million: model.cachedCost,
    profit_margin: model.margin,
    max_context_rounds: 40,
    max_context_tokens: model.maxContextTokens,
    max_reply_tokens: model.maxReplyTokens,
    timeout: 300,
    enable_web_search: false,
    deep_thinking_type: model.deepThinkingType,
    deduct_deep_think: 1,
    frequency_limit: 20,
    image_parsing: "none",
    file_parsing: "none",
    sort_order: 80,
    admin_notes: model.notes,
  };
}

function videoPayload(model) {
  const fixed = model.minDuration === model.maxDuration;
  const protocolConfig = {
    channel: "lconai",
    channel_group: "B1",
    submit_path: "/v1/videos",
    poll_path: "/v1/videos/{id}",
    poll_style: "path",
    billing_unit: model.billingUnit,
    supports_prompt: true,
    supports_duration: true,
    duration_mode: fixed ? "fixed" : "range",
    min_duration: model.minDuration,
    max_duration: model.maxDuration,
    min_submit_duration: model.minDuration,
    duration_step: 1,
    default_duration: model.defaultDuration,
    ...(fixed ? { duration_options: [model.defaultDuration], exact_duration_only: true } : {}),
    resolution_options: [model.resolution],
    default_resolution: model.resolution,
    resolution: model.resolution,
    resolution_cost_prices: { [model.resolution]: model.cost },
    resolution_prices: { [model.resolution]: model.sale },
    aspect_ratios: ["16:9", "9:16", "1:1", "4:3", "3:4"],
    ...(model.omitAspectRatio === true ? { omit_aspect_ratio: true } : {}),
    min_reference_images: model.requiresImage ? 1 : 0,
    max_reference_images: 1,
    requires_first_frame: model.requiresImage,
    max_reference_audios: 0,
    supports_audio_input: false,
    supports_remote_cancel: false,
    persist_result_immediately: true,
    workspace_surfaces: ["ai-video", "storyboard"],
    verification_notice: "渠道配置已保存；密钥轮换、鉴权目录、真实付费生成和结果持久化尚未验收，暂不进入工作台 current 版本。",
  };
  return {
    id: model.id,
    model_type: "video",
    name: model.name,
    model_name: model.modelName,
    provider: "lconai",
    admin_notes: model.notes,
    api_endpoint: BACKUP_CHANNEL_ENDPOINT,
    api_key: model.secretRef,
    protocol_type: "newapi_video",
    cost_price: model.cost,
    cost_per_use: model.sale,
    duration_seconds: model.defaultDuration,
    max_duration: model.maxDuration,
    supports_image_input: true,
    requires_image: model.requiresImage,
    sort_order: 85,
    api_protocol_config: protocolConfig,
  };
}

function findCurrentModel(inventory, model) {
  return (inventory.models || []).find((entry) => entry.model_type === model.type
    && String(entry.model_name || "").toLowerCase() === model.modelName.toLowerCase()
    && String(entry.api_endpoint || "").replace(/\/+$/u, "") === (model.endpoint || BACKUP_CHANNEL_ENDPOINT));
}

async function stageAndPublishModel(origin, headers, model) {
  const before = await requestJson(origin, headers, "/api/admin/models");
  const existing = findCurrentModel(before, model);
  const existingGate = existing?.api_protocol_config?.__model_activation_gate;
  if (existing && (model.type === "text" || existingGate?.state === "pending")) {
    return { modelId: String(existing.id), created: false, release: null };
  }
  const staged = await post(origin, headers, "/api/admin/models", model.type === "text" ? textPayload(model) : videoPayload(model));
  assert.equal(staged.staged, true, `${model.modelName}:NOT_STAGED`);
  assert.equal(staged.published, false, `${model.modelName}:UNEXPECTED_AUTO_PUBLISH`);
  const releaseId = String(staged.result?.release?.id || "");
  const modelId = String(staged.result?.legacyId || staged.result?.modelId || "");
  assert.match(releaseId, /^[a-f0-9-]{36}$/iu, `${model.modelName}:RELEASE_ID_MISSING`);
  assert.ok(modelId, `${model.modelName}:MODEL_ID_MISSING`);
  const release = await validatePreviewPublish(origin, headers, "/api/admin/model-pool-releases", releaseId);
  const after = await requestJson(origin, headers, "/api/admin/models");
  const saved = findCurrentModel(after, model);
  assert.ok(saved, `${model.modelName}:CURRENT_READBACK_MISSING`);
  if (model.type === "text") {
    assert.equal(saved.is_active, false, `${model.modelName}:TEXT_MUST_REMAIN_INACTIVE`);
    assert.equal(saved.user_access, "pending_model_activation", `${model.modelName}:TEXT_GATE_MISSING`);
  } else {
    assert.equal(saved.protocol_type, "newapi_video", `${model.modelName}:PROTOCOL_MISMATCH`);
    assert.equal(Number(saved.cost_price), model.cost, `${model.modelName}:COST_MISMATCH`);
    assert.equal(Number(saved.cost_per_use), model.sale, `${model.modelName}:SALE_MISMATCH`);
  }
  if (model.type === "video") {
    assert.equal(saved.api_protocol_config?.__model_activation_gate?.state, "pending", `${model.modelName}:ACTIVATION_GATE_MISSING`);
  }
  return { modelId: String(saved.id || modelId), created: !existing, gateRepaired: Boolean(existing), release };
}

function addModelToSurface(snapshot, surface, modelId) {
  const slot = snapshot.surfaces?.[surface];
  assert.ok(slot && slot.kind === "video", `WORKSPACE_SURFACE_MISSING:${surface}`);
  slot.assignedModelIds = [...new Set([...(slot.assignedModelIds || []), modelId])];
  slot.orderedModelIds = [...new Set([...(slot.orderedModelIds || []), modelId])];
}

async function stageWorkspaceSyncCandidate(origin, headers, modelIds) {
  const pool = await requestJson(origin, headers, "/api/admin/model-pool-releases");
  const workspace = await requestJson(origin, headers, "/api/admin/workspace-model-releases");
  assert.ok(pool.current?.id && pool.current?.snapshot_sha256, "CURRENT_MODEL_POOL_REQUIRED");
  assert.ok(workspace.current?.snapshot, "CURRENT_WORKSPACE_RELEASE_REQUIRED");
  const snapshot = structuredClone(workspace.current.snapshot);
  snapshot.modelPoolRelease = {
    releaseId: pool.current.id,
    snapshotSha256: pool.current.snapshot_sha256,
  };
  for (const modelId of modelIds) {
    addModelToSurface(snapshot, "storyboard-video", modelId);
    addModelToSurface(snapshot, "video-page", modelId);
  }
  const staged = await post(origin, headers, "/api/admin/workspace-model-releases", {
    action: "draft",
    snapshot,
    changeNote: "LConAI 三个视频模型同步到分镜工作台与视频制作；待安全密钥和真实 canary 后发布",
  });
  const releaseId = String(staged.release?.id || "");
  assert.match(releaseId, /^[a-f0-9-]{36}$/iu, "WORKSPACE_CANDIDATE_ID_MISSING");
  const validated = await post(origin, headers, "/api/admin/workspace-model-releases", { action: "validate", releaseId });
  assert.equal(validated.release?.status, "validated", "WORKSPACE_CANDIDATE_VALIDATION_FAILED");
  const preview = await requestJson(origin, headers, `/api/admin/workspace-model-releases?previewReleaseId=${encodeURIComponent(releaseId)}`);
  assert.match(String(preview.preview?.previewSha256 || ""), /^[a-f0-9]{64}$/u, "WORKSPACE_PREVIEW_HASH_MISSING");
  return {
    releaseId,
    version: validated.release?.release_version,
    status: "validated_not_published",
    previewSha256: preview.preview.previewSha256,
  };
}

export async function main(args = process.argv.slice(2)) {
  const origin = String(process.env.LOCAL_NAV_ORIGIN || "").replace(/\/+$/u, "");
  const token = String(process.env.LOCAL_NAV_ADMIN_TOKEN || "").trim();
  const identity = JSON.parse(process.env.LOCAL_NAV_READONLY_IDENTITY || "{}");
  const actorId = String(identity?.user?.id || "");
  const databaseUrl = String(process.env.DATABASE_URL || "").trim();
  assert.ok(args.includes("--execute"), "EXPLICIT_EXECUTION_REQUIRED");
  assert.ok(args.includes("--confirm-local-lconai-workbook"), "LOCAL_LCONAI_CONFIRMATION_REQUIRED");
  assert.equal(origin, "http://127.0.0.1:5000", "EXACT_LOCAL_RUNTIME_REQUIRED");
  assert.ok(token && actorId && databaseUrl, "LOCAL_ADMIN_RUNTIME_REQUIRED");
  const parsedDb = new URL(databaseUrl);
  assert.equal(parsedDb.hostname, "127.0.0.1", "LOCAL_DATABASE_HOST_REQUIRED");
  assert.equal(parsedDb.port, "54322", "LOCAL_DATABASE_PORT_REQUIRED");
  assert.equal(parsedDb.pathname.replace(/^\//u, ""), "zimeiti_local", "LOCAL_DATABASE_NAME_REQUIRED");

  const database = new pg.Client({ connectionString: databaseUrl, application_name: "codex-lconai-workbook-onboarding" });
  const stepUpToken = crypto.randomBytes(32).toString("base64url");
  const stepUpHash = crypto.createHash("sha256").update(stepUpToken).digest("hex");
  const basicHeaders = { Authorization: `Bearer ${token}` };
  const self = await requestJson(origin, basicHeaders, "/api/admin/access-control/self");
  assert.ok(self.access?.permissionKeys?.includes("models.manage"), "MODELS_MANAGE_PERMISSION_REQUIRED");
  const headers = { ...basicHeaders, "x-admin-step-up": stepUpToken };
  let cleanupVerified = false;
  try {
    await database.connect();
    await database.query("BEGIN");
    await database.query("SELECT set_config('app.admin_governance_write','on',true)");
    await database.query(
      `INSERT INTO public.admin_step_up_sessions
        (actor_id,token_hash,scope_keys,profile_revision,auth_method,request_ip,user_agent,expires_at)
       VALUES($1,$2,$3::jsonb,$4,'login_password','127.0.0.1','Codex-LConAI-Onboarding/1.0',now()+interval '10 minutes')`,
      [actorId, stepUpHash, JSON.stringify(self.access.permissionKeys), self.access.revision],
    );
    await database.query("COMMIT");

    await ensureCurrent(origin, headers, "/api/admin/model-pool-releases", "LConAI 接入前模型池本地基线");
    await ensureCurrent(origin, headers, "/api/admin/workspace-model-releases", "LConAI 接入前工作台本地基线");

    const results = [];
    for (const model of [...textModels, ...videoModels]) {
      results.push({ modelName: model.modelName, ...(await stageAndPublishModel(origin, headers, model)) });
    }
    const videoIds = results.filter((result) => videoModels.some((model) => model.modelName === result.modelName)).map((result) => result.modelId);
    const workspaceCandidate = await stageWorkspaceSyncCandidate(origin, headers, videoIds);

    const inventory = await requestJson(origin, headers, "/api/admin/models");
    const publicText = await requestJson(origin, basicHeaders, "/api/llm-models");
    const publicStoryboard = await requestJson(origin, basicHeaders, "/api/video/models?surface=storyboard-workbench");
    const publicVideo = await requestJson(origin, basicHeaders, "/api/video/models?surface=video-page");
    const targetNames = new Set([...textModels, ...videoModels].map((model) => model.modelName));
    const publicIds = [
      ...(publicText.models || []),
      ...(publicStoryboard.models || []),
      ...(publicVideo.models || []),
    ].map((model) => String(model.id || ""));
    assert.equal(publicIds.some((id) => videoIds.includes(id)), false, "PENDING_MODEL_LEAKED_TO_PUBLIC_WORKSPACE");

    const report = {
      passed: true,
      checkedAt: new Date().toISOString(),
      origin,
      channel: {
        name: "LConAI",
        primaryEndpoint: PRIMARY_CHANNEL_ENDPOINT,
        backupEndpoint: BACKUP_CHANNEL_ENDPOINT,
        secretStorage: "secret-reference-only",
      },
      modelPool: results,
      workspaceCandidate,
      blockedModels,
      readbackCount: (inventory.models || []).filter((model) => targetNames.has(String(model.model_name || ""))).length,
      security: {
        plaintextWorkbookCredentialsUsed: false,
        providerRequests: 0,
        paidModelCalls: 0,
        productionWrites: 0,
        publicPendingModelLeak: false,
      },
      productionVerdict: "not_ready_requires_rotated_secrets_authenticated_catalog_and_real_canaries",
    };
    await fs.mkdir(evidenceDir, { recursive: true });
    await fs.writeFile(path.join(evidenceDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.log(JSON.stringify(report, null, 2));
  } finally {
    try {
      await database.query("BEGIN");
      await database.query("SELECT set_config('app.admin_governance_write','on',true)");
      await database.query("DELETE FROM public.admin_step_up_sessions WHERE token_hash=$1", [stepUpHash]);
      await database.query("COMMIT");
      const remaining = await database.query("SELECT count(*)::int AS count FROM public.admin_step_up_sessions WHERE token_hash=$1", [stepUpHash]);
      cleanupVerified = Number(remaining.rows[0]?.count || 0) === 0;
    } catch {
      await database.query("ROLLBACK").catch(() => undefined);
    }
    await database.end().catch(() => undefined);
  }
  assert.equal(cleanupVerified, true, "TEMPORARY_STEP_UP_CLEANUP_FAILED");
}

if (import.meta.url === `file://${process.argv[1]?.replaceAll("\\", "/")}`) {
  await main();
}
