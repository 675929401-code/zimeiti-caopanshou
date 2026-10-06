import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const DEFAULT_RUNTIME_PATH = "F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json";
const ORIGIN = "http://127.0.0.1:5000";
const LOCAL_WORKBENCH_HEADER = { "x-local-workbench": "ai-creation-studio-local" };
const TERMINAL = new Set(["completed", "failed", "cancelled", "expired"]);
const INJECTED_ADMIN_TOKEN = String(process.env.LOCAL_NAV_ADMIN_TOKEN || "").trim();

type JsonRecord = Record<string, unknown>;
type Runtime = JsonRecord & { supabaseUrl?: string; restUrl?: string; serviceRoleKey?: string; localOnly?: boolean; host?: string };
type ModelSpec = {
  protocol: "autodl_comfyui_workflow" | "dashscope_video_retalk" | "volcengine_digital_human" | "dashscope_wan_s2v";
  internalId?: string;
  reqKey?: string;
  mode: "video" | "photo";
  resolution: string;
};

const SPECS: ModelSpec[] = [
  { protocol: "autodl_comfyui_workflow", internalId: "minimax-h3-autodl-hosted-image-audio", mode: "photo", resolution: "480p" },
  { protocol: "dashscope_video_retalk", mode: "video", resolution: "720p" },
  { protocol: "volcengine_digital_human", reqKey: "realman_change_lips", mode: "video", resolution: "720p" },
  { protocol: "dashscope_wan_s2v", mode: "photo", resolution: "480p" },
  { protocol: "volcengine_digital_human", reqKey: "jimeng_realman_avatar_picture_omni_v15", mode: "photo", resolution: "1080p" },
];

function asObject(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

function cleanText(value: unknown, max = 400): string {
  return String(value || "")
    .replace(/https?:\/\/\S+/giu, "[url]")
    .replace(/\bBearer\s+\S+/giu, "Bearer [redacted]")
    .replace(/\b(?:sk-|ak-)[A-Za-z0-9_.-]+/gu, "[redacted]")
    .slice(0, max);
}

async function responseJson(response: Response): Promise<JsonRecord> {
  const text = await response.text();
  if (!text) return {};
  try { return JSON.parse(text) as JsonRecord; } catch { return { error: cleanText(text) }; }
}

function urlFor(base: string, pathname: string, query: Record<string, string> = {}) {
  const url = new URL(pathname, base);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  return url;
}

async function restGet(runtime: Runtime, table: string, query: Record<string, string>) {
  const key = String(runtime.serviceRoleKey || "");
  assert.ok(key, "LOCAL_SERVICE_ROLE_KEY_MISSING");
  const response = await fetch(urlFor(String(runtime.supabaseUrl || runtime.restUrl), `/rest/v1/${table}`, query), {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(20_000),
  });
  assert.ok(response.ok, `LOCAL_REST_READ_FAILED:${table}:${response.status}`);
  return await response.json() as JsonRecord[];
}

async function api(token: string, pathname: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  const response = await fetch(new URL(pathname, ORIGIN), { ...init, headers, signal: init.signal || AbortSignal.timeout(180_000) });
  return { response, body: await responseJson(response) };
}

async function readVideoHead(token: string, rawUrl: string) {
  const target = new URL(rawUrl, ORIGIN);
  assert.equal(target.origin, ORIGIN, "VIDEO_ACCESS_URL_MUST_BE_LOCAL_TICKET");
  const response = await fetch(target, {
    headers: { Authorization: `Bearer ${token}`, Range: "bytes=0-65535" },
    signal: AbortSignal.timeout(60_000),
  });
  assert.ok(response.ok, `VIDEO_ACCESS_FAILED:${response.status}`);
  const reader = response.body?.getReader();
  const first = reader ? await reader.read() : { value: new Uint8Array(), done: true };
  await reader?.cancel();
  const bytes = first.value || new Uint8Array();
  const prefix = Buffer.from(bytes.slice(0, 32));
  assert.ok(bytes.byteLength > 0, "VIDEO_ACCESS_EMPTY");
  assert.ok(String(response.headers.get("content-type") || "").toLowerCase().startsWith("video/"), "VIDEO_ACCESS_NOT_VIDEO");
  return {
    status: response.status,
    contentType: response.headers.get("content-type"),
    contentLength: Number(response.headers.get("content-length")) || null,
    firstChunkBytes: bytes.byteLength,
    mp4HeaderDetected: prefix.includes(Buffer.from("ftyp")),
    contentDisposition: cleanText(response.headers.get("content-disposition"), 200) || null,
  };
}

async function loadHistory(token: string) {
  const { response, body } = await api(token, "/api/video/history?surface=digital-human&limit=200&offset=0", { cache: "no-store" });
  assert.ok(response.ok, `HISTORY_READ_FAILED:${response.status}`);
  return Array.isArray(body.tasks) ? body.tasks as JsonRecord[] : [];
}

async function inspectTask(runtime: Runtime, userId: string, taskId: string) {
  const select = [
    "id", "user_id", "model_id", "task_id_external", "client_request_id", "request_fingerprint",
    "status", "billing_price_yuan", "billing_cost_price_yuan", "billing_unit", "billing_quantity",
    "billing_state", "billing_operation_id", "billing_idempotency_key", "billing_exempt", "explicitly_free",
    "provider_result_url", "video_url", "storage_url", "price_charged", "duration_seconds", "resolution", "completed_at",
  ].join(",");
  const rows = await restGet(runtime, "video_tasks", { select, id: `eq.${taskId}`, user_id: `eq.${userId}`, limit: "1" });
  assert.equal(rows.length, 1, "VIDEO_TASK_PERSISTENCE_MISSING");
  const row = rows[0];
  const storageUrl = String(row.storage_url || "");
  const stable = storageUrl.startsWith("object://tencent_cos/");
  let ownedAsset: JsonRecord | null = null;
  if (stable) {
    const storageKey = decodeURIComponent(storageUrl.slice("object://tencent_cos/".length));
    const assets = await restGet(runtime, "user_files", {
      select: "id,user_id,storage_provider,file_category,file_size,content_type,source,created_at",
      user_id: `eq.${userId}`,
      storage_provider: "eq.tencent_cos",
      storage_key: `eq.${storageKey}`,
      limit: "1",
    });
    ownedAsset = assets[0] || null;
  }
  const billingKey = String(row.billing_idempotency_key || "");
  const operations = billingKey ? await restGet(runtime, "wallet_operations", {
    select: "id,operation_kind,status,amount,delta,created_at",
    user_id: `eq.${userId}`,
    idempotency_key: `eq.${billingKey}`,
  }) : [];
  const ledger = billingKey ? await restGet(runtime, "wallet_ledger_entries", {
    select: "id,wallet,delta,balance_before,balance_after,created_at",
    user_id: `eq.${userId}`,
    idempotency_key: `eq.${billingKey}`,
  }) : [];
  return {
    id: row.id,
    modelId: row.model_id,
    providerTaskBound: Boolean(row.task_id_external),
    clientRequestId: row.client_request_id,
    requestFingerprintPresent: /^[0-9a-f]{64}$/u.test(String(row.request_fingerprint || "")),
    status: row.status,
    billing: {
      priceSnapshotYuan: Number(row.billing_price_yuan),
      costSnapshotYuan: Number(row.billing_cost_price_yuan),
      unit: row.billing_unit,
      quantity: Number(row.billing_quantity),
      state: row.billing_state,
      exempt: row.billing_exempt === true,
      explicitlyFree: row.explicitly_free === true,
      chargedYuan: Number(row.price_charged),
      operationCount: operations.length,
      ledgerEntryCount: ledger.length,
    },
    result: {
      providerReceiptRetained: Boolean(row.provider_result_url),
      stableObjectRetained: stable,
      completedAt: row.completed_at || null,
      ownedAsset: ownedAsset ? {
        id: ownedAsset.id,
        ownerMatches: ownedAsset.user_id === userId,
        provider: ownedAsset.storage_provider,
        category: ownedAsset.file_category,
        bytes: Number(ownedAsset.file_size),
        contentType: ownedAsset.content_type,
        source: ownedAsset.source,
        createdAt: ownedAsset.created_at,
      } : null,
    },
  };
}

async function verifyExistingTask(input: { runtime: Runtime; token: string; userId: string; taskId: string }) {
  assert.match(input.taskId, /^vt_[a-f0-9]{40}$/u, "EXISTING_TASK_ID_INVALID");
  const task = await inspectTask(input.runtime, input.userId, input.taskId);
  assert.equal(task.status, "completed", "EXISTING_TASK_NOT_COMPLETED");
  assert.equal(task.billing.exempt, true, "ADMIN_EXEMPTION_NOT_RECORDED");
  assert.equal(task.billing.state, "not_required", "ADMIN_BILLING_STATE_INVALID");
  assert.equal(task.billing.chargedYuan, 0, "ADMIN_WALLET_WAS_CHARGED");
  assert.equal(task.billing.operationCount, 0, "ADMIN_WALLET_OPERATION_CREATED");
  assert.equal(task.billing.ledgerEntryCount, 0, "ADMIN_WALLET_LEDGER_CREATED");
  assert.equal(task.result.stableObjectRetained, true, "STABLE_OBJECT_RECEIPT_MISSING");
  assert.ok(task.result.ownedAsset, "OWNED_DELIVERY_ASSET_MISSING");
  const history = await loadHistory(input.token);
  const historyRow = history.find((row) => String(row.id || "") === input.taskId);
  assert.ok(historyRow, "HISTORY_RECORD_MISSING");
  const publicModelId = String(historyRow.publicModelId || historyRow.modelId || "");
  assert.ok(publicModelId, "HISTORY_PUBLIC_MODEL_ID_MISSING");
  assert.equal(String(historyRow.modelId || ""), publicModelId, "HISTORY_MODEL_BINDING_MISMATCH");
  const catalogResult = await api(input.token, "/api/video/models?surface=digital-human", { cache: "no-store" });
  assert.ok(catalogResult.response.ok && Array.isArray(catalogResult.body.models), "PUBLIC_DIGITAL_MODEL_CATALOG_UNAVAILABLE");
  assert.ok((catalogResult.body.models as JsonRecord[]).some((model) => String(model.id || "") === publicModelId), "HISTORY_MODEL_NOT_CURRENTLY_SELECTABLE");
  const playbackUrl = String(historyRow.videoUrl || "");
  assert.ok(playbackUrl, "HISTORY_PLAYBACK_TICKET_MISSING");
  const playback = await readVideoHead(input.token, playbackUrl);
  const downloadTicket = await api(input.token, `/api/video/access-ticket?${new URLSearchParams({ taskId: input.taskId, scope: "download", name: "digital-human-acceptance.mp4" })}`, { cache: "no-store" });
  assert.ok(downloadTicket.response.ok, `DOWNLOAD_TICKET_FAILED:${downloadTicket.response.status}`);
  assert.ok(downloadTicket.body.url, "DOWNLOAD_TICKET_URL_MISSING");
  const download = await readVideoHead(input.token, String(downloadTicket.body.url));
  return {
    task,
    history: {
      present: true,
      status: historyRow.status,
      modelName: historyRow.modelName,
      publicModelId,
      currentCatalogBinding: true,
    },
    playback,
    download,
    providerPostRequests: 0,
  };
}

async function runOne(input: {
  runtime: Runtime;
  token: string;
  userId: string;
  rawModel: JsonRecord;
  publicModelId: string;
  spec: ModelSpec;
  personAssetId: string;
  audioAssetId: string;
  evidenceDir: string;
}) {
  const publicModelId = input.publicModelId;
  const requestId = `digital-${randomUUID()}`;
  const startedAt = new Date().toISOString();
  const modelLabel = String(input.rawModel.name || input.rawModel.id);
  const progressPath = path.join(input.evidenceDir, `${input.spec.protocol}-${input.spec.reqKey || "default"}-${requestId}.json`);
  const trace: JsonRecord[] = [];
  console.log(JSON.stringify({ event: "submit", model: modelLabel, requestId, at: startedAt }));
  let submission: { response: Response; body: JsonRecord };
  try {
    submission = await api(input.token, "/api/digital-human/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": requestId },
      body: JSON.stringify({
        mode: input.spec.mode,
        modelId: publicModelId,
        resolution: input.spec.resolution,
        personAssetId: input.personAssetId,
        audioAssetId: input.audioAssetId,
        clientRequestId: requestId,
        durationChoice: "",
      }),
    });
  } catch (error) {
    const uncertain = { model: modelLabel, requestId, state: "submission_unknown", error: "SUBMISSION_RESPONSE_UNAVAILABLE", replayed: false };
    await writeFile(progressPath, JSON.stringify(uncertain, null, 2));
    throw new Error(`SUBMISSION_RESPONSE_UNAVAILABLE:${requestId}:${error instanceof Error ? error.name : "unknown"}`);
  }
  const submittedTaskId = String(submission.body.task_id || submission.body.taskId || "");
  const businessTaskId = String(submission.body.business_task_id || submittedTaskId);
  trace.push({
    at: new Date().toISOString(),
    phase: "submit",
    httpStatus: submission.response.status,
    taskSubmitted: submission.body.task_submitted ?? null,
    status: submission.body.status || null,
    errorCode: submission.body.error_code || null,
    error: cleanText(submission.body.error || submission.body.message),
    taskId: submittedTaskId || null,
  });
  if (!submittedTaskId) {
    if (submission.body.task_submitted === false) {
      const rejected = { model: modelLabel, requestId, state: "rejected_before_submission", trace, replayed: false };
      await writeFile(progressPath, JSON.stringify(rejected, null, 2));
      return rejected;
    }
    const uncertain = { model: modelLabel, requestId, state: "submission_unknown", trace, replayed: false };
    await writeFile(progressPath, JSON.stringify(uncertain, null, 2));
    return uncertain;
  }

  let terminal: JsonRecord = {};
  const deadline = Date.now() + 25 * 60_000;
  let lastProgressPrint = 0;
  while (Date.now() < deadline) {
    const { response, body } = await api(input.token, `/api/video/status?${new URLSearchParams({ taskId: submittedTaskId, modelId: publicModelId })}`, { cache: "no-store", signal: AbortSignal.timeout(45_000) });
    const state = String(body.status || "unknown");
    const checkpoint = {
      at: new Date().toISOString(),
      phase: "poll",
      httpStatus: response.status,
      status: state,
      processingStage: body.processingStage || null,
      progress: body.progress ?? null,
      errorCode: body.errorCode || null,
      error: cleanText(body.errorMessage || body.message || body.error),
      hasVideoUrl: Boolean(body.videoUrl || body.video_url),
      priceCharged: Number(body.priceCharged) || 0,
    };
    trace.push(checkpoint);
    await writeFile(progressPath, JSON.stringify({ model: modelLabel, requestId, taskId: submittedTaskId, state, trace, replayed: false }, null, 2));
    if (Date.now() - lastProgressPrint >= 30_000 || TERMINAL.has(state)) {
      console.log(JSON.stringify({ event: "poll", model: modelLabel, requestId, taskId: submittedTaskId, status: state, stage: checkpoint.processingStage, at: checkpoint.at }));
      lastProgressPrint = Date.now();
    }
    if (TERMINAL.has(state)) { terminal = body; break; }
    await new Promise((resolve) => setTimeout(resolve, 8_000));
  }
  const status = String(terminal.status || "timeout");
  if (status !== "completed") {
    const failed = {
      model: modelLabel,
      protocol: input.spec.protocol,
      reqKey: input.spec.reqKey || null,
      requestId,
      taskId: submittedTaskId,
      businessTaskId,
      state: status,
      errorCode: terminal.errorCode || "PROVIDER_ACCEPTANCE_TIMEOUT",
      error: cleanText(terminal.errorMessage || terminal.error),
      trace,
      replayed: false,
    };
    await writeFile(progressPath, JSON.stringify(failed, null, 2));
    return failed;
  }

  const history = await loadHistory(input.token);
  const historyRow = history.find((row) => String(row.clientRequestId || "") === requestId)
    || history.find((row) => String(row.id || "") === businessTaskId);
  assert.ok(historyRow, "HISTORY_RECORD_MISSING");
  const task = await inspectTask(input.runtime, input.userId, String(historyRow.id || businessTaskId));
  assert.equal(task.status, "completed", "TASK_NOT_COMPLETED");
  assert.equal(task.billing.exempt, true, "ADMIN_EXEMPTION_NOT_RECORDED");
  assert.equal(task.billing.state, "not_required", "ADMIN_BILLING_STATE_INVALID");
  assert.equal(task.billing.chargedYuan, 0, "ADMIN_WALLET_WAS_CHARGED");
  assert.equal(task.billing.operationCount, 0, "ADMIN_WALLET_OPERATION_CREATED");
  assert.equal(task.billing.ledgerEntryCount, 0, "ADMIN_WALLET_LEDGER_CREATED");
  assert.equal(task.result.stableObjectRetained, true, "STABLE_OBJECT_RECEIPT_MISSING");
  assert.ok(task.result.ownedAsset, "OWNED_DELIVERY_ASSET_MISSING");

  const playbackUrl = String(historyRow.videoUrl || "");
  assert.ok(playbackUrl, "HISTORY_PLAYBACK_TICKET_MISSING");
  const playback = await readVideoHead(input.token, playbackUrl);
  const downloadTicket = await api(input.token, `/api/video/access-ticket?${new URLSearchParams({ taskId: String(historyRow.id || businessTaskId), scope: "download", name: "digital-human-acceptance.mp4" })}`, { cache: "no-store" });
  assert.ok(downloadTicket.response.ok, `DOWNLOAD_TICKET_FAILED:${downloadTicket.response.status}`);
  assert.ok(downloadTicket.body.url, "DOWNLOAD_TICKET_URL_MISSING");
  const download = await readVideoHead(input.token, String(downloadTicket.body.url));
  const passed = {
    model: modelLabel,
    protocol: input.spec.protocol,
    reqKey: input.spec.reqKey || null,
    publicModelId,
    requestId,
    taskId: submittedTaskId,
    businessTaskId: String(historyRow.id || businessTaskId),
    state: "completed",
    startedAt,
    completedAt: task.result.completedAt,
    task,
    history: {
      present: true,
      modelName: historyRow.modelName,
      durationSeconds: Number(historyRow.durationSeconds),
      status: historyRow.status,
      priceCharged: Number(historyRow.priceCharged),
    },
    playback,
    download,
    trace,
    replayed: false,
  };
  await writeFile(progressPath, JSON.stringify(passed, null, 2));
  return passed;
}

async function main() {
  const execute = process.argv.includes("--execute");
  const confirmed = process.argv.includes("--confirm-paid-provider-calls");
  const verifyExistingTaskId = process.argv.find((value) => value.startsWith("--verify-existing-task="))?.slice("--verify-existing-task=".length) || "";
  const expectedBuildId = process.argv.find((value) => value.startsWith("--build="))?.slice("--build=".length) || "";
  const onlySpec = process.argv.find((value) => value.startsWith("--only="))?.slice("--only=".length) || "";
  const runtimePath = process.argv.find((value) => value.startsWith("--runtime="))?.slice("--runtime=".length) || DEFAULT_RUNTIME_PATH;
  if (!execute) {
    console.log(JSON.stringify({ mode: "plan", providerCalls: 0, databaseWrites: 0, command: "--execute --confirm-paid-provider-calls" }, null, 2));
    return;
  }
  assert.equal(confirmed, true, "PAID_PROVIDER_CONFIRMATION_REQUIRED");
  const runtime = JSON.parse((await readFile(runtimePath, "utf8")).replace(/^\uFEFF/u, "")) as Runtime;
  assert.equal(runtime.localOnly, true, "LOCAL_RUNTIME_REQUIRED");
  assert.equal(runtime.host, "127.0.0.1", "LOCAL_RUNTIME_HOST_REQUIRED");
  assert.equal(new URL(String(runtime.supabaseUrl || runtime.restUrl)).origin, "http://127.0.0.1:54321", "LOCAL_REST_ORIGIN_REQUIRED");

  const injectedToken = INJECTED_ADMIN_TOKEN;
  const sessionResponse = injectedToken
    ? await fetch(`${ORIGIN}/api/auth/me`, {
      headers: { Authorization: `Bearer ${injectedToken}` },
      signal: AbortSignal.timeout(20_000),
    })
    : await fetch(`${ORIGIN}/api/auth/dev-session`, { headers: LOCAL_WORKBENCH_HEADER, signal: AbortSignal.timeout(20_000) });
  const session = await responseJson(sessionResponse);
  const token = injectedToken || String(session.token || "");
  const user = asObject(session.user);
  assert.ok(sessionResponse.ok && token, "LOCAL_ADMIN_SESSION_REQUIRED");
  assert.equal(user.role, "admin", "LOCAL_ADMIN_ROLE_REQUIRED");
  const userId = String(user.id || user.userId || "");
  assert.ok(userId, "LOCAL_ADMIN_ID_REQUIRED");
  const versionResult = await api(token, "/api/version", { cache: "no-store" });
  assert.ok(versionResult.response.ok && versionResult.body.buildId, "LOCAL_BUILD_ID_UNAVAILABLE");
  const buildId = String(versionResult.body.buildId);
  if (expectedBuildId) assert.equal(buildId, expectedBuildId, "LOCAL_BUILD_CHANGED");

  const schemaKey = String(runtime.serviceRoleKey || "");
  const schemaResponse = await fetch(`${String(runtime.supabaseUrl || runtime.restUrl)}/rest/v1/`, { headers: { apikey: schemaKey, Authorization: `Bearer ${schemaKey}`, Accept: "application/openapi+json" }, signal: AbortSignal.timeout(20_000) });
  assert.ok(schemaResponse.ok, "LOCAL_SCHEMA_UNAVAILABLE");
  const schema = await schemaResponse.json() as JsonRecord;
  const paths = asObject(schema.paths);
  for (const rpc of ["reserve_queued_digital_video_task", "claim_digital_video_dispatch", "update_digital_video_dispatch", "finalize_video_generation_task_atomic"]) {
    assert.ok(paths[`/rpc/${rpc}`], `LOCAL_RPC_MISSING:${rpc}`);
  }

  if (verifyExistingTaskId) {
    const evidenceDir = path.resolve("artifacts", `digital-human-existing-${verifyExistingTaskId}-${new Date().toISOString().replace(/[:.]/gu, "-")}`);
    await mkdir(evidenceDir, { recursive: true });
    const result = await verifyExistingTask({ runtime, token, userId, taskId: verifyExistingTaskId });
    const evidence = path.join(evidenceDir, "summary.json");
    await writeFile(evidence, JSON.stringify({ observedAt: new Date().toISOString(), buildId, localRuntimeOnly: true, taskId: verifyExistingTaskId, ...result, credentialsPrinted: false, requestReplayCount: 0 }, null, 2));
    console.log(JSON.stringify({ ok: true, buildId, taskId: verifyExistingTaskId, evidence, providerPostRequests: 0, credentialsPrinted: false, requestReplayCount: 0 }, null, 2));
    return;
  }

  const selectedSpecs = onlySpec
    ? SPECS.filter((spec) => `${spec.protocol}:${spec.reqKey || "default"}` === onlySpec)
    : SPECS;
  assert.ok(selectedSpecs.length > 0, `UNKNOWN_MODEL_SPEC:${onlySpec}`);

  const rawModels = await restGet(runtime, "video_models", {
    select: "id,name,model_name,protocol_type,api_protocol_config,is_active,is_hidden,price_per_use,cost_price",
    protocol_type: "in.(autodl_comfyui_workflow,dashscope_video_retalk,dashscope_wan_s2v,volcengine_digital_human)",
    order: "sort_order",
  });
  const modelsResponse = await fetch(`${ORIGIN}/api/video/models?surface=digital-human`, { cache: "no-store", signal: AbortSignal.timeout(20_000) });
  const publicModels = await responseJson(modelsResponse);
  assert.ok(modelsResponse.ok && Array.isArray(publicModels.models), "PUBLIC_DIGITAL_MODEL_CATALOG_UNAVAILABLE");
  const selectedModels = selectedSpecs.map((spec) => {
    const model = rawModels.find((row) => {
      if (row.protocol_type !== spec.protocol) return false;
      if (spec.internalId) return String(row.id || "") === spec.internalId;
      if (!spec.reqKey) return true;
      return String(asObject(row.api_protocol_config).req_key || "") === spec.reqKey;
    });
    assert.ok(model, `MODEL_CONFIG_MISSING:${spec.protocol}:${spec.reqKey || "default"}`);
    assert.equal(model.is_active, true, `MODEL_INACTIVE:${String(model.name)}`);
    assert.equal(model.is_hidden, false, `MODEL_HIDDEN:${String(model.name)}`);
    const publicModel = (publicModels.models as JsonRecord[]).find((entry) => String(entry.displayName || "") === String(model.name || ""));
    assert.ok(publicModel?.id, `MODEL_NOT_PUBLICLY_SELECTABLE:${String(model.name)}`);
    return { spec, model, publicModelId: String(publicModel.id) };
  });

  const assets = await restGet(runtime, "user_files", {
    select: "id,user_id,file_category,file_size,content_type,source,meta,created_at",
    user_id: `eq.${userId}`,
    source: "in.(digital-human-input,voice-generation)",
    order: "created_at.desc",
    limit: "100",
  });
  const audio = assets.find((row) => row.file_category === "audio" && row.source === "digital-human-input" && Number(asObject(row.meta).duration) >= 3.5 && Number(asObject(row.meta).duration) <= 5);
  const video = assets.find((row) => row.file_category === "video" && Number(asObject(row.meta).duration) >= Number(asObject(audio?.meta).duration) && Number(asObject(row.meta).duration) <= 6);
  const image = assets.find((row) => row.file_category === "image");
  assert.ok(audio && video && image, "OWNED_MINIMAL_DIGITAL_HUMAN_ASSETS_REQUIRED");

  const balanceBeforeResponse = await api(token, "/api/cash/balance", { cache: "no-store" });
  assert.ok(balanceBeforeResponse.response.ok, "BALANCE_READ_BEFORE_FAILED");
  const balanceBefore = Number(balanceBeforeResponse.body.balance);
  const runId = `digital-human-provider-${new Date().toISOString().replace(/[:.]/gu, "-")}`;
  const evidenceDir = path.resolve("artifacts", runId);
  await mkdir(evidenceDir, { recursive: true });
  const results: JsonRecord[] = [];
  for (const { spec, model, publicModelId } of selectedModels) {
    const result = await runOne({
      runtime,
      token,
      userId,
      rawModel: model,
      publicModelId,
      spec,
      personAssetId: String(spec.mode === "video" ? video.id : image.id),
      audioAssetId: String(audio.id),
      evidenceDir,
    });
    results.push(result);
    if (result.state === "submission_unknown") break;
  }
  const balanceAfterResponse = await api(token, "/api/cash/balance", { cache: "no-store" });
  assert.ok(balanceAfterResponse.response.ok, "BALANCE_READ_AFTER_FAILED");
  const balanceAfter = Number(balanceAfterResponse.body.balance);
  const report = {
    runId,
    observedAt: new Date().toISOString(),
    buildId,
    localRuntimeOnly: true,
    localRestOrigin: "http://127.0.0.1:54321",
    siteOrigin: ORIGIN,
    adminBillingExempt: true,
    balanceBefore,
    balanceAfter,
    balanceUnchanged: balanceBefore === balanceAfter,
    requestedModelCount: selectedSpecs.length,
    attemptedModelCount: results.length,
    completedModelCount: results.filter((result) => result.state === "completed").length,
    unknownSubmissionCount: results.filter((result) => result.state === "submission_unknown").length,
    results,
    credentialsPrinted: false,
    requestReplayCount: 0,
  };
  await writeFile(path.join(evidenceDir, "summary.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({
    runId,
    evidence: path.join(evidenceDir, "summary.json"),
    balanceUnchanged: report.balanceUnchanged,
    completed: report.completedModelCount,
    attempted: report.attemptedModelCount,
    states: results.map((result) => ({ model: result.model, state: result.state, errorCode: result.errorCode || null })),
    credentialsPrinted: false,
    requestReplayCount: 0,
  }, null, 2));
  assert.equal(report.unknownSubmissionCount, 0, "SUBMISSION_UNKNOWN_REQUIRES_MANUAL_RECONCILIATION");
  assert.equal(report.completedModelCount, selectedSpecs.length, "DIGITAL_HUMAN_PROVIDER_ACCEPTANCE_INCOMPLETE");
  assert.equal(report.balanceUnchanged, true, "ADMIN_BALANCE_CHANGED");
}

main().catch((error) => {
  const message = error instanceof Error ? cleanText(error.message, 500) : "UNKNOWN";
  console.error(JSON.stringify({ ok: false, error: message, credentialsPrinted: false, requestReplayCount: 0 }));
  process.exitCode = 1;
});
