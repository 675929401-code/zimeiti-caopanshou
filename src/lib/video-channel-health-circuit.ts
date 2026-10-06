import { createHash } from "node:crypto";

export const VIDEO_CHANNEL_RECOVERY_COOLDOWN_MS = 24 * 60 * 60 * 1000;
export const VIDEO_CHANNEL_RECOVERY_CONFIRMATION = "AUTHORIZE_ONE_REAL_VIDEO_CANARY";

export type VideoChannelCircuitState =
  | "healthy"
  | "funding_required"
  | "open"
  | "canary_ready"
  | "unverified";

export interface VideoChannelHealthRecord {
  channel_id?: unknown;
  total_requests?: unknown;
  success_count?: unknown;
  fail_count?: unknown;
  timeout_count?: unknown;
  is_healthy?: unknown;
  consecutive_failures?: unknown;
  last_success_at?: unknown;
  last_fail_at?: unknown;
  last_error?: unknown;
  updated_at?: unknown;
}

export interface VideoChannelCircuitDecision {
  state: VideoChannelCircuitState;
  blocksProduction: boolean;
  canaryEligible: boolean;
  consecutiveFailures: number;
  lastSuccessAt: string | null;
  lastFailAt: string | null;
  healthUpdatedAt: string | null;
  recoveryEligibleAt: string | null;
  recoveryKey: string | null;
  operatorRetestKey?: string | null;
}

function normalizedTimestamp(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function recoveryEpoch(record: VideoChannelHealthRecord): string {
  return [
    String(record.channel_id || ""),
    String(record.updated_at || record.last_fail_at || ""),
    String(Number(record.consecutive_failures) || 0),
  ].join(":");
}

export function buildVideoChannelRecoveryKey(record: VideoChannelHealthRecord): string | null {
  if (!record.channel_id || !record.updated_at && !record.last_fail_at) return null;
  const digest = createHash("sha256").update(recoveryEpoch(record)).digest("hex").slice(0, 32);
  return `vhc_${digest}`;
}

export function evaluateVideoChannelCircuit(
  record: VideoChannelHealthRecord | null | undefined,
  nowMs = Date.now(),
): VideoChannelCircuitDecision {
  if (!record) {
    return {
      state: "unverified",
      blocksProduction: false,
      canaryEligible: false,
      consecutiveFailures: 0,
      lastSuccessAt: null,
      lastFailAt: null,
      healthUpdatedAt: null,
      recoveryEligibleAt: null,
      recoveryKey: null,
    };
  }

  const consecutiveFailures = Math.max(0, Number(record.consecutive_failures) || 0);
  const lastSuccessAt = normalizedTimestamp(record.last_success_at);
  const lastFailAt = normalizedTimestamp(record.last_fail_at);
  const healthUpdatedAt = normalizedTimestamp(record.updated_at);
  // This row records preparation, not an invented provider outcome. Missing
  // counters/timestamps cannot qualify a legacy or partial record for bootstrap.
  const preparedValidation = record.is_healthy === false
    && record.consecutive_failures === 0
    && [record.total_requests, record.success_count, record.fail_count, record.timeout_count].every((count) => count === 0)
    && record.last_success_at === null
    && record.last_fail_at === null
    && (record.last_error === null || record.last_error === "")
    && healthUpdatedAt !== null;
  if (preparedValidation) {
    const recoveryKey = buildVideoChannelRecoveryKey(record);
    return {
      state: "unverified",
      blocksProduction: false,
      canaryEligible: recoveryKey !== null,
      consecutiveFailures,
      lastSuccessAt,
      lastFailAt,
      healthUpdatedAt,
      recoveryEligibleAt: healthUpdatedAt,
      recoveryKey,
    };
  }
  // Quota, balance and arrears are account funding conditions, not evidence
  // that the endpoint, protocol, credential binding or model has broken.
  // Keep normal submission available so a later recharge takes effect without
  // an administrator manually reopening the channel. The provider response is
  // still returned to the current request and no automatic retry is added.
  if (sanitizeVideoChannelError(record.last_error).code === "UPSTREAM_QUOTA_OR_BALANCE") {
    return {
      state: "funding_required",
      blocksProduction: false,
      canaryEligible: false,
      consecutiveFailures,
      lastSuccessAt,
      lastFailAt,
      healthUpdatedAt,
      recoveryEligibleAt: null,
      recoveryKey: null,
      operatorRetestKey: null,
    };
  }
  // Nullable or malformed legacy values are not positive health evidence.
  // Only an explicit true may open ordinary production traffic.
  if (record.is_healthy === true) {
    return {
      state: "healthy",
      blocksProduction: false,
      canaryEligible: false,
      consecutiveFailures,
      lastSuccessAt,
      lastFailAt,
      healthUpdatedAt,
      recoveryEligibleAt: null,
      recoveryKey: null,
    };
  }

  const sanitizedFailure = sanitizeVideoChannelError(record.last_error);
  const hasFailureEvidence = consecutiveFailures > 0
    || Boolean(lastFailAt && sanitizedFailure.code !== "NONE");
  if (!hasFailureEvidence) {
    return {
      state: "unverified",
      blocksProduction: false,
      canaryEligible: false,
      consecutiveFailures,
      lastSuccessAt,
      lastFailAt,
      healthUpdatedAt,
      recoveryEligibleAt: null,
      recoveryKey: null,
      operatorRetestKey: null,
    };
  }

  const cooldownAnchor = lastFailAt || healthUpdatedAt;
  const cooldownAnchorMs = cooldownAnchor ? Date.parse(cooldownAnchor) : Number.NaN;
  const recoveryEligibleAt = Number.isFinite(cooldownAnchorMs)
    ? new Date(cooldownAnchorMs + VIDEO_CHANNEL_RECOVERY_COOLDOWN_MS).toISOString()
    : null;
  const canaryEligible = recoveryEligibleAt !== null && nowMs >= Date.parse(recoveryEligibleAt);

  return {
    state: canaryEligible ? "canary_ready" : "open",
    // Expiry only permits one explicit, idempotent admin canary. It never
    // re-enables normal production traffic by itself.
    blocksProduction: true,
    canaryEligible,
    consecutiveFailures,
    lastSuccessAt,
    lastFailAt,
    healthUpdatedAt,
    recoveryEligibleAt,
    recoveryKey: canaryEligible ? buildVideoChannelRecoveryKey(record) : null,
    // Explicit post-repair retesting shares the same epoch key as timed
    // recovery, so it cannot create a second canary when the cooldown expires.
    operatorRetestKey: lastFailAt && consecutiveFailures > 0 && healthUpdatedAt
      ? buildVideoChannelRecoveryKey(record) : null,
  };
}

export type SanitizedVideoChannelErrorCode =
  | "VIDEO_INPUT_INVALID"
  | "UPSTREAM_AUTH"
  | "UPSTREAM_MODEL_OR_CHANNEL_UNAVAILABLE"
  | "UPSTREAM_QUOTA_OR_BALANCE"
  | "UPSTREAM_TIMEOUT"
  | "UPSTREAM_SERVER_ERROR"
  | "UPSTREAM_OTHER"
  | "NONE";

export function sanitizeVideoChannelError(value: unknown): {
  code: SanitizedVideoChannelErrorCode;
  summary: string;
} {
  const message = String(value || "");
  if (!message) return { code: "NONE", summary: "暂无最近错误记录" };
  // Suppliers can return Access denied/403 for account arrears. Preserve the
  // explicit billing cause before interpreting the generic HTTP status.
  if (/arrearage|quota|balance|余额|insufficient|credit|payment[\s_-]*required|\b402\b|欠费|(?:额度|配额).*(?:不足|耗尽|不可用)/iu.test(message)) {
    return { code: "UPSTREAM_QUOTA_OR_BALANCE", summary: "上游额度或余额不足（敏感详情已隐藏）" };
  }
  const media = "(?:source[\\s_-]*video|reference[\\s_-]*(?:image|video|audio)|image|video|audio|media|图片|视频|音频|素材|参考图)";
  const read = "(?:download|fetch|retrieve|下载|读取|拉取)";
  const mediaRead = new RegExp(read + "[\\s\\S]{0,100}" + media + "|" + media + "[\\s\\S]{0,100}" + read, "iu");
  if (/\b403\b/u.test(message) && mediaRead.test(message)
    && !/invalid[\s_-]*(?:api.?key|token)|authentication[\s_-]*(?:failed|required)/iu.test(message)) {
    return { code: "VIDEO_INPUT_INVALID", summary: "上游无法读取输入素材（HTTP 403），请检查素材访问权限或更换素材" };
  }
  if (/unauthor|forbidden|\b40[13]\b|invalid[\s_-]*(?:api[\s_-]*key|token)|api[\s_-]*key.*(?:invalid|expired)|密钥|token|渠道认证配置异常/iu.test(message)) {
    return { code: "UPSTREAM_AUTH", summary: "上游鉴权拒绝（凭据或权限不可用，敏感详情已隐藏）" };
  }
  if (/not\s*found|no available channel|model.*unavailable|模型.*不存在/iu.test(message)) {
    return { code: "UPSTREAM_MODEL_OR_CHANNEL_UNAVAILABLE", summary: "上游模型或渠道不可用（敏感详情已隐藏）" };
  }
  if (/timeout|timed out|超时/iu.test(message)) {
    return { code: "UPSTREAM_TIMEOUT", summary: "上游请求超时（敏感详情已隐藏）" };
  }
  if (/\b50[0234]\b|internal server|server error|服务.*错误/iu.test(message)) {
    return { code: "UPSTREAM_SERVER_ERROR", summary: "上游服务错误（敏感详情已隐藏）" };
  }
  return { code: "UPSTREAM_OTHER", summary: "上游返回未分类错误（敏感详情已隐藏）" };
}

export function authorizeVideoChannelRecoveryCanary(input: {
  decision: VideoChannelCircuitDecision;
  userRole: "admin" | "student";
  requested: boolean;
  recoveryKey: unknown;
  confirmation: unknown;
  clientRequestId: unknown;
  operatorRetest?: boolean;
  operatorRetestReason?: unknown;
}): { ok: true } | { ok: false; code: string; message: string; status: number } {
  if (!input.requested) {
    return { ok: false, code: "CHANNEL_HEALTH_BLOCKED", message: "渠道健康熔断仍在生效", status: 503 };
  }
  if (input.userRole !== "admin") {
    return { ok: false, code: "CHANNEL_RECOVERY_ADMIN_REQUIRED", message: "仅管理员可执行渠道恢复 canary", status: 403 };
  }
  let expectedKey = input.decision.recoveryKey;
  if (input.operatorRetest === true) {
    const reason = typeof input.operatorRetestReason === "string" ? input.operatorRetestReason.trim() : "";
    if (!reason || reason.length > 500) {
      return { ok: false, code: "CHANNEL_RETEST_REASON_REQUIRED", message: "请填写本次修复后复测的原因（1–500字）", status: 409 };
    }
    if (!input.decision.blocksProduction || !input.decision.operatorRetestKey) {
      return { ok: false, code: "CHANNEL_RETEST_NOT_READY", message: "此通道没有可复测的失败纪元", status: 409 };
    }
    expectedKey = input.decision.operatorRetestKey;
  } else if (!input.decision.canaryEligible || !expectedKey) {
    return { ok: false, code: "CHANNEL_RECOVERY_NOT_READY", message: "渠道尚未准备验证，或恢复冷却期尚未结束", status: 409 };
  }
  if (input.confirmation !== VIDEO_CHANNEL_RECOVERY_CONFIRMATION) {
    return { ok: false, code: "CHANNEL_RECOVERY_CONFIRMATION_REQUIRED", message: "缺少真实付费 canary 的显式确认", status: 409 };
  }
  const recoveryKey = String(input.recoveryKey || "");
  const clientRequestId = String(input.clientRequestId || "");
  if (recoveryKey !== expectedKey || clientRequestId !== recoveryKey) {
    return { ok: false, code: "CHANNEL_RECOVERY_KEY_INVALID", message: "恢复 canary 必须使用当前健康纪元的唯一幂等键", status: 409 };
  }
  return { ok: true };
}
