import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdminClient } from "@/storage/database/supabase-client";
import { authorizeAdminCapability } from "@/lib/server/admin-governance-authority";
import {
  VIDEO_CHANNEL_RECOVERY_CONFIRMATION,
  VIDEO_CHANNEL_RECOVERY_COOLDOWN_MS,
  evaluateVideoChannelCircuit,
  sanitizeVideoChannelError,
} from "@/lib/video-channel-health-circuit";

interface ModelRow {
  id: string;
  name: string;
  model_name: string | null;
  api_endpoint: string | null;
  is_active: boolean | null;
}

interface HealthRow {
  channel_id: string;
  total_requests: number;
  success_count: number;
  fail_count: number;
  timeout_count: number;
  avg_response_ms: number;
  last_success_at: string | null;
  last_fail_at: string | null;
  last_error: string | null;
  consecutive_failures: number;
  is_healthy: boolean;
  updated_at: string | null;
}

function channelDto(model: ModelRow | undefined, health: HealthRow | undefined) {
  const circuit = evaluateVideoChannelCircuit(health);
  const sanitizedError = sanitizeVideoChannelError(health?.last_error);
  // Connection display must not expose URL userinfo or query credentials.
  let endpoint = "";
  try {
    const url = new URL(model?.api_endpoint || "");
    endpoint = url.origin + url.pathname;
  } catch { /* Invalid configuration remains visible through its model identifier. */ }
  return {
    channelId: model?.id || health?.channel_id,
    modelName: model?.name || health?.channel_id || "",
    modelIdentifier: model?.model_name || "",
    endpoint,
    isActive: model?.is_active === true,
    totalRequests: health?.total_requests ?? 0,
    successCount: health?.success_count ?? 0,
    failCount: health?.fail_count ?? 0,
    timeoutCount: health?.timeout_count ?? 0,
    successRate: health && health.total_requests > 0 ? Math.round(health.success_count / health.total_requests * 100) : 0,
    avgResponseMs: health?.avg_response_ms ?? 0,
    lastSuccessAt: health?.last_success_at ?? null,
    lastFailAt: health?.last_fail_at ?? null,
    lastError: sanitizedError.summary,
    lastErrorCode: sanitizedError.code,
    consecutiveFailures: health?.consecutive_failures ?? 0,
    // Funding-required channels remain operational. The sanitized funding
    // diagnostic is still visible to administrators, but it is not a circuit.
    isHealthy: !circuit.blocksProduction,
    updatedAt: health?.updated_at ?? null,
    healthRecorded: Boolean(health),
    validationPreparationRequired: !health && model?.is_active === true,
    validationPrepared: circuit.state === "unverified" && circuit.canaryEligible,
    circuitState: circuit.state,
    productionBlocked: circuit.blocksProduction,
    recoveryEligibleAt: circuit.recoveryEligibleAt,
    recoveryCanaryEligible: circuit.canaryEligible,
    recoveryKey: circuit.recoveryKey,
    operatorRetestKey: circuit.operatorRetestKey || null,
    operatorRetestRequiresReason: Boolean(circuit.operatorRetestKey),
  };
}

const recoveryPolicy = {
  defaultFailClosed: true,
  cooldownHours: VIDEO_CHANNEL_RECOVERY_COOLDOWN_MS / (60 * 60 * 1000),
  readOnlyProbeCanUnblock: false,
  requiresAdmin: true,
  requiresUniqueIdempotencyKey: true,
  requiresTerminalSuccess: true,
  confirmation: VIDEO_CHANNEL_RECOVERY_CONFIRMATION,
  endpoint: "/api/video/generate",
  preparationEndpoint: "/api/video/channel-health",
  preparationAction: "prepare_validation",
  operatorRetestRequiresCurrentAdmin: true,
  operatorRetestRequiresReason: true,
};

// The current database role authorizes reads and preparation; a stale JWT
// administrator claim cannot create or inspect a recovery epoch.
export async function GET(request: NextRequest) {
  const authorization = await authorizeAdminCapability(request, "models.manage", {
    requireStepUp: true,
    operation: "model_channel_health_view",
  });
  if (!authorization.ok) return authorization.response;
  try {
    const db = getSupabaseAdminClient();
    const [healthResult, modelResult] = await Promise.all([
      db.from("video_channel_health").select("*").order("channel_id"),
      db.from("video_models").select("id, name, model_name, api_endpoint, is_active"),
    ]);
    if (healthResult.error || modelResult.error) {
      return NextResponse.json({ error: "暂时无法读取通道状态", code: "CHANNEL_HEALTH_LOOKUP_FAILED" }, { status: 503 });
    }
    const models = modelResult.data as ModelRow[] || [];
    const modelMap = new Map(models.map((model) => [model.id, model]));
    const healthMap = new Map((healthResult.data as HealthRow[] || []).map((health) => [health.channel_id, health]));
    const ids = new Set([...healthMap.keys(), ...models.filter((model) => model.is_active === true).map((model) => model.id)]);
    const channels = [...ids].map((id) => channelDto(modelMap.get(id), healthMap.get(id)));
    return NextResponse.json({ channels, recoveryPolicy });
  } catch {
    return NextResponse.json({ error: "暂时无法读取通道状态", code: "CHANNEL_HEALTH_LOOKUP_FAILED" }, { status: 503 });
  }
}

// Preparation creates no provider request and asserts no provider outcome.
// The channel_id primary key is the compare-and-set: concurrent or repeated
// preparation cannot replace history or rotate an already issued recovery key.
export async function POST(request: NextRequest) {
  const authorization = await authorizeAdminCapability(request, "models.manage", {
    requireStepUp: true,
    operation: "model_channel_validation_prepare",
  });
  if (!authorization.ok) return authorization.response;
  let input: { action?: unknown; channelId?: unknown };
  try {
    const parsed: unknown = await request.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("INVALID_REQUEST");
    input = parsed;
  } catch {
    return NextResponse.json({ error: "请求参数无效", code: "INVALID_REQUEST" }, { status: 400 });
  }
  if (input.action !== "prepare_validation" || typeof input.channelId !== "string" || !/^[A-Za-z0-9_-]{1,160}$/u.test(input.channelId)) {
    return NextResponse.json({ error: "请选择需要首次验证的通道", code: "INVALID_REQUEST" }, { status: 400 });
  }
  try {
    const db = getSupabaseAdminClient();
    const { data: model, error: modelError } = await db.from("video_models")
      .select("id, name, model_name, api_endpoint, is_active").eq("id", input.channelId).maybeSingle();
    if (modelError) return NextResponse.json({ error: "暂时无法读取模型配置", code: "MODEL_LOOKUP_FAILED" }, { status: 503 });
    if (!model) return NextResponse.json({ error: "模型不存在", code: "MODEL_NOT_FOUND" }, { status: 404 });
    if (model.is_active !== true) return NextResponse.json({ error: "此模型尚未进入可验证配置", code: "MODEL_NOT_ACTIVE" }, { status: 409 });
    const { data: existing, error: healthError } = await db.from("video_channel_health")
      .select("channel_id").eq("channel_id", input.channelId).maybeSingle();
    if (healthError) return NextResponse.json({ error: "暂时无法读取通道状态", code: "CHANNEL_HEALTH_LOOKUP_FAILED" }, { status: 503 });
    if (existing) return NextResponse.json({ error: "此通道已有验证或运行记录，请刷新后使用现有状态", code: "CHANNEL_HEALTH_ALREADY_EXISTS" }, { status: 409 });
    const prepared: HealthRow = {
      channel_id: model.id,
      total_requests: 0, success_count: 0, fail_count: 0, timeout_count: 0,
      avg_response_ms: 0, consecutive_failures: 0,
      is_healthy: false,
      last_success_at: null, last_fail_at: null, last_error: null,
      updated_at: new Date().toISOString(),
    };
    const { data: inserted, error: insertError } = await db.from("video_channel_health").insert(prepared).select("*").single();
    if (insertError?.code === "23505") {
      return NextResponse.json({ error: "此通道已由另一请求准备，请刷新后使用现有状态", code: "CHANNEL_HEALTH_ALREADY_EXISTS" }, { status: 409 });
    }
    if (insertError || !inserted) return NextResponse.json({ error: "验证准备结果尚未确认，请刷新通道状态后继续", code: "CHANNEL_PREPARATION_UNKNOWN" }, { status: 503 });
    return NextResponse.json({
      success: true, generationSubmitted: false, generationVerified: false,
      channel: channelDto(model as ModelRow, inserted as HealthRow), recoveryPolicy,
    }, { status: 201 });
  } catch {
    return NextResponse.json({ error: "验证准备结果尚未确认，请刷新通道状态后继续", code: "CHANNEL_PREPARATION_UNKNOWN" }, { status: 503 });
  }
}
