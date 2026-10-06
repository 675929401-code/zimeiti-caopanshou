import { readFile } from "node:fs/promises";

const DEFAULT_RUNTIME_PATH = "F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json";

const DIGITAL_HUMAN_PROTOCOLS = [
  "dashscope_wan_s2v",
  "dashscope_video_retalk",
  "volcengine_digital_human",
] as const;

type UnknownRecord = Record<string, unknown>;

function object(value: unknown): UnknownRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownRecord
    : {};
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String).filter(Boolean) : [];
}

function safeConfig(raw: unknown) {
  const config = object(raw);
  const resolutions = object(config.resolution_prices);
  return {
    workspaceSurfaces: stringList(config.workspace_surfaces),
    reqKey: String(config.req_key || "") || null,
    inputMode: String(config.workflow_input_mode || "") || null,
    billingUnit: String(config.billing_unit || "per_use"),
    minDuration: Number(config.min_duration) || null,
    maxDuration: Number(config.max_duration) || null,
    durationStep: Number(config.duration_step) || null,
    defaultResolution: String(config.default_resolution || "") || null,
    resolutionOptions: stringList(config.resolution_options),
    publicResolutionPrices: Object.fromEntries(
      Object.entries(resolutions).map(([key, value]) => [key, Number(value)]),
    ),
    requiresSourceVideo: config.requires_source_video === true,
    supportsAudioInput: config.supports_audio_input === true,
    activationState: String(config.activation_state || "") || null,
    bindingVersion: String(config.binding_version || "") || null,
  };
}

async function main() {
  const runtimePath = process.argv.find((value) => value.startsWith("--runtime="))?.slice("--runtime=".length)
    || DEFAULT_RUNTIME_PATH;
  const runtime = JSON.parse((await readFile(runtimePath, "utf8")).replace(/^\uFEFF/u, "")) as UnknownRecord;
  if (runtime.localOnly !== true || String(runtime.host || "") !== "127.0.0.1") {
    throw new Error("LOCAL_RUNTIME_REQUIRED");
  }
  process.env.COZE_SUPABASE_URL = String(runtime.supabaseUrl || runtime.restUrl || "");
  process.env.COZE_SUPABASE_SERVICE_ROLE_KEY = String(runtime.serviceRoleKey || "");
  process.env.COZE_SUPABASE_ANON_KEY = String(runtime.anonKey || "");
  const [databaseModule, secretModule, healthModule, activationModule, dtoModule] = await Promise.all([
    import("../src/storage/database/supabase-client"),
    import("../src/lib/provider-secret"),
    import("../src/lib/video-channel-health-circuit"),
    import("../src/lib/model-activation-gate"),
    import("../src/lib/public-model-dto"),
  ]);
  const { getSupabaseClient } = databaseModule;
  const { resolveProviderSecret } = secretModule;
  const { evaluateVideoChannelCircuit, sanitizeVideoChannelError } = healthModule;
  const { inspectVideoModelActivationReadiness } = activationModule;
  const { toPublicModelId } = dtoModule;
  const db = getSupabaseClient();
  const [modelsResult, healthResult, adminsResult, taskSchemaResult, walletResult, ledgerResult] = await Promise.all([
    db.from("video_models").select("id,name,model_name,provider,protocol_type,api_endpoint,api_key,is_active,is_hidden,sort_order,price_per_use,cost_price,duration_seconds,max_duration,requires_image,supports_image_input,total_requests,success_count,last_success_at,api_protocol_config").in("protocol_type", [...DIGITAL_HUMAN_PROTOCOLS]).order("sort_order"),
    db.from("video_channel_health").select("channel_id,is_healthy,total_requests,success_count,fail_count,timeout_count,consecutive_failures,last_success_at,last_fail_at,last_error,updated_at"),
    db.from("users").select("id,role,status,is_active").eq("role", "admin").limit(20),
    db.from("video_tasks").select("id,client_request_id,request_fingerprint,billing_state,billing_price_yuan,billing_cost_price_yuan,provider_result_url,submission_error_code").limit(0),
    db.from("wallet_operations").select("id").limit(0),
    db.from("wallet_ledger_entries").select("id").limit(0),
  ]);
  if (modelsResult.error) throw new Error(`MODEL_READ_FAILED:${modelsResult.error.code || "unknown"}`);
  const healthById = new Map<string, UnknownRecord>((healthResult.data || []).map((row: UnknownRecord) => [String(row.channel_id || ""), row]));
  const models = (modelsResult.data || []).map((row: UnknownRecord) => {
    const config = safeConfig(row.api_protocol_config);
    const health = healthById.get(String(row.id || ""));
    const circuit = evaluateVideoChannelCircuit(health as Parameters<typeof evaluateVideoChannelCircuit>[0]);
    const activation = inspectVideoModelActivationReadiness({
      id: String(row.id || ""),
      model_name: row.model_name,
      provider: row.provider,
      protocol_type: row.protocol_type,
      api_endpoint: row.api_endpoint,
      api_key: row.api_key,
      api_protocol_config: row.api_protocol_config,
    });
    let endpointHost: string | null = null;
    try { endpointHost = new URL(String(row.api_endpoint || "")).host; } catch { /* redacted invalid endpoint */ }
    return {
      internalId: String(row.id || ""),
      publicId: toPublicModelId("video", String(row.id || "")),
      name: String(row.name || ""),
      modelName: String(row.model_name || ""),
      provider: String(row.provider || ""),
      protocol: String(row.protocol_type || ""),
      endpointHost,
      secretReady: (() => {
        try { return Boolean(resolveProviderSecret(row.api_key)); } catch { return false; }
      })(),
      active: row.is_active === true,
      hidden: row.is_hidden === true,
      publicPrice: Number(row.price_per_use),
      providerCost: Number(row.cost_price),
      configuredDurationSeconds: Number(row.duration_seconds),
      configuredMaxDurationSeconds: Number(row.max_duration),
      requiresImage: row.requires_image === true,
      supportsImage: row.supports_image_input === true,
      sortOrder: Number(row.sort_order),
      historicalRequestCount: Number(row.total_requests),
      historicalSuccessCount: Number(row.success_count),
      modelLastSuccessAt: row.last_success_at || null,
      config,
      activationReady: activation.ready,
      activationReason: activation.reason,
      health: health ? {
        isHealthy: health.is_healthy === true,
        state: circuit.state,
        totalRequests: Number(health.total_requests),
        successCount: Number(health.success_count),
        failCount: Number(health.fail_count),
        timeoutCount: Number(health.timeout_count),
        consecutiveFailures: Number(health.consecutive_failures),
        lastSuccessAt: health.last_success_at || null,
        lastFailAt: health.last_fail_at || null,
        updatedAt: health.updated_at || null,
        lastErrorCode: sanitizeVideoChannelError(health.last_error).code,
      } : null,
      publiclySelectable: row.is_active === true
        && row.is_hidden !== true
        && activation.ready
        && health?.is_healthy === true
        && circuit.state === "healthy",
    };
  });

  const adminIds = (adminsResult.data || []).map((row: UnknownRecord) => String(row.id || "")).filter(Boolean);
  const assetsResult = adminIds.length
    ? await db.from("user_files")
      .select("id,user_id,file_category,file_size,content_type,source,meta,created_at")
      .in("user_id", adminIds)
      .in("source", ["digital-human-input", "voice-generation"])
      .order("created_at", { ascending: false })
      .limit(100)
    : { data: [], error: null };
  const assets = (assetsResult.data || []).map((row: UnknownRecord) => {
    const meta = object(row.meta);
    return {
      id: String(row.id || ""),
      ownerId: String(row.user_id || ""),
      category: String(row.file_category || ""),
      contentType: String(row.content_type || ""),
      source: String(row.source || ""),
      bytes: Number(row.file_size),
      durationSeconds: Number(meta.duration) || null,
      width: Number(meta.width) || null,
      height: Number(meta.height) || null,
      createdAt: row.created_at || null,
    };
  });
  const targetTaskId = process.argv.find((value) => value.startsWith("--task-id="))?.slice("--task-id=".length) || "";
  let targetTask: UnknownRecord | null = null;
  let targetDispatch: UnknownRecord | null = null;
  if (/^vt_[a-f0-9]{40}$/u.test(targetTaskId)) {
    const [task, dispatch] = await Promise.all([
      db.from("video_tasks").select("id,status,billing_state,error_message,submission_error_code,task_id_external,provider_result_url,storage_url,price_charged,completed_at").eq("id", targetTaskId).maybeSingle(),
      db.from("digital_video_dispatch_jobs").select("task_id,state,error_code,error_message,next_run_at,updated_at").eq("task_id", targetTaskId).maybeSingle(),
    ]);
    targetTask = task.data ? {
      id: task.data.id,
      status: task.data.status,
      billingState: task.data.billing_state,
      errorCode: task.data.submission_error_code,
      error: String(task.data.error_message || "").replace(/https?:\/\/\S+/giu, "[url]").slice(0, 400),
      providerTaskBound: Boolean(task.data.task_id_external),
      providerResultRetained: Boolean(task.data.provider_result_url),
      providerResultHost: (() => { try { return new URL(String(task.data.provider_result_url || "")).host; } catch { return null; } })(),
      stableStorageRetained: String(task.data.storage_url || "").startsWith("object://tencent_cos/"),
      priceCharged: Number(task.data.price_charged),
      completedAt: task.data.completed_at,
    } : null;
    targetDispatch = dispatch.data ? {
      taskId: dispatch.data.task_id,
      state: dispatch.data.state,
      errorCode: dispatch.data.error_code,
      error: String(dispatch.data.error_message || "").replace(/https?:\/\/\S+/giu, "[url]").slice(0, 400),
      nextRunAt: dispatch.data.next_run_at,
      updatedAt: dispatch.data.updated_at,
    } : null;
  }

  console.log(JSON.stringify({
    readOnly: true,
    observedAt: new Date().toISOString(),
    schema: {
      videoTerminalReady: !taskSchemaResult.error,
      videoTerminalErrorCode: taskSchemaResult.error?.code || null,
      walletOperationsReady: !walletResult.error,
      walletOperationsErrorCode: walletResult.error?.code || null,
      walletLedgerReady: !ledgerResult.error,
      walletLedgerErrorCode: ledgerResult.error?.code || null,
    },
    adminAccounts: (adminsResult.data || []).map((row: UnknownRecord) => ({
      id: String(row.id || ""),
      role: row.role,
      status: row.status,
      active: row.is_active,
    })),
    modelCount: models.length,
    publiclySelectableCount: models.filter((model: { publiclySelectable: boolean }) => model.publiclySelectable).length,
    models,
    ownedCandidateAssetCount: assets.length,
    ownedCandidateAssets: assets,
    targetTask,
    targetDispatch,
    errors: {
      health: healthResult.error?.code || null,
      admins: adminsResult.error?.code || null,
      assets: assetsResult.error?.code || null,
    },
    credentialsPrinted: false,
    databaseWrites: 0,
    paidProviderCalls: 0,
  }, null, 2));
}

main().catch((error) => {
  const code = error instanceof Error ? error.message.split(":", 1)[0] : "UNKNOWN";
  console.error(JSON.stringify({ ok: false, code, credentialsPrinted: false }));
  process.exitCode = 1;
});
