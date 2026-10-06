export type PublicDramaFailureKind =
  | "validation"
  | "authentication"
  | "authorization"
  | "credits"
  | "model"
  | "rate-limit"
  | "timeout"
  | "project-save"
  | "service";

export interface PublicDramaFailure {
  readonly status: number;
  readonly code: string;
  readonly kind: PublicDramaFailureKind;
  readonly title: string;
  readonly message: string;
  readonly guidance: string;
  readonly retryable: boolean;
}

const INTERNAL_PROVIDER_DETAIL =
  /(?:request[\s_-]*id|new_api_error|llm\s*api|trace[\s_-]*id|provider|upstream|\{\s*["']?(?:error|message)["']?\s*:|\u8be5\u7528\u6237\u5df2\u88ab\u7981\u7528)/iu;

function normalizeStatus(status: number): number {
  return Number.isInteger(status) && status >= 400 && status <= 599 ? status : 500;
}

function readCode(payload: unknown): string {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return "";
  const candidate = (payload as Record<string, unknown>).code;
  return typeof candidate === "string" && /^[A-Z0-9_]{3,80}$/.test(candidate)
    ? candidate
    : "";
}

function readMessage(payload: unknown): string {
  if (typeof payload === "string") return payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return "";
  const value = payload as Record<string, unknown>;
  if (typeof value.error === "string") return value.error;
  if (typeof value.message === "string") return value.message;
  return "";
}

export function hasInternalProviderDetail(value: unknown): boolean {
  return typeof value === "string" && INTERNAL_PROVIDER_DETAIL.test(value);
}

export function describePublicDramaFailure(
  statusInput: number,
  codeInput = "DRAMA_SCRIPT_FAILED",
): PublicDramaFailure {
  const status = normalizeStatus(statusInput);
  const code = /^[A-Z0-9_]{3,80}$/.test(codeInput) ? codeInput : "DRAMA_SCRIPT_FAILED";

  if (code === "MIGRATION_NOT_READY") {
    return {
      status: 503,
      code,
      kind: "service",
      title: "影视工坊生成服务正在准备中",
      message: "为避免生成结果无法保存，本次没有提交生成，也不会产生费用。",
      guidance: "请稍后重试；已有项目和草稿不会受影响。",
      retryable: false,
    };
  }

  if (
    code === "LLM_DUPLICATE_SUBMISSION"
    || code === "LLM_IDEMPOTENCY_CONFLICT"
    || code === "LLM_IDEMPOTENCY_STORE_UNAVAILABLE"
    || code === "LLM_IDEMPOTENCY_KEY_INVALID"
  ) {
    return {
      status,
      code,
      kind: "service",
      title: "已阻止重复提交",
      message: "系统无法确认上一笔相同请求的结果，因此没有再次调用付费模型。",
      guidance: "请不要连续点击生成；如需继续，请先由管理员核对上一笔请求和扣费记录。",
      retryable: false,
    };
  }

  if (code === "INVALID_DRAMA_SCRIPT_REQUEST" || status === 400 || status === 422) {
    return {
      status,
      code: "INVALID_DRAMA_SCRIPT_REQUEST",
      kind: "validation",
      title: "创作信息需要补充",
      message: "当前主题、集数或需求描述不完整，尚未提交生成。",
      guidance: "请检查基础设置，并填写不少于 20 个字的详细需求后重试。",
      retryable: true,
    };
  }

  if (code === "UNAUTHORIZED" || status === 401) {
    return {
      status: 401,
      code: "UNAUTHORIZED",
      kind: "authentication",
      title: "登录状态已失效",
      message: "本次请求没有进入生成流程。",
      guidance: "请重新登录后再提交，当前页面中的创作内容不会被清空。",
      retryable: false,
    };
  }

  if (code === "PAYMENT_REQUIRED" || status === 402) {
    return {
      status: 402,
      code: "PAYMENT_REQUIRED",
      kind: "credits",
      title: "当前积分不足",
      message: "本次请求未完成生成。",
      guidance: "请补充积分或联系管理员确认计费配置后再重试。",
      retryable: false,
    };
  }

  if (
    code === "DRAMA_MODEL_ACCESS_DENIED"
    || code === "DRAMA_EMPTY_MODEL_RESULT"
    || code === "SHORT_DRAMA_TEXT_MODEL_UNAVAILABLE"
    || code === "MODEL_NOT_AVAILABLE"
  ) {
    return {
      status: 503,
      code,
      kind: "model",
      title: "文案模型暂不可用",
      message: "当前爽剧文案模型无法完成这次请求，未生成剧本。",
      guidance: "请联系管理员检查主站文案模型的账号状态、渠道权限与启用配置，确认后再重试。",
      retryable: true,
    };
  }

  if (code === "DRAMA_PROJECT_IMPORT_FAILED") {
    return {
      status,
      code,
      kind: "project-save",
      title: "项目保存未完成",
      message: "剧本服务已返回结果，但项目尚未可靠保存。",
      guidance: "请先不要重复生成，联系管理员核对本次任务与项目记录后再处理。",
      retryable: false,
    };
  }

  if (status === 403) {
    return {
      status,
      code: code === "DRAMA_SCRIPT_FAILED" ? "FORBIDDEN" : code,
      kind: "authorization",
      title: "当前账号没有创作权限",
      message: "本次请求没有进入生成流程。",
      guidance: "请确认主站会员状态与爽剧功能访问权限，或联系管理员处理。",
      retryable: false,
    };
  }

  if (status === 429) {
    return {
      status,
      code: "DRAMA_RATE_LIMITED",
      kind: "rate-limit",
      title: "请求较多，请稍后再试",
      message: "模型服务正在限流，本次没有得到可用结果。",
      guidance: "请稍等片刻后使用下方“重新尝试”，不要连续重复提交。",
      retryable: true,
    };
  }

  if (status === 408 || status === 504) {
    return {
      status,
      code: "DRAMA_REQUEST_TIMEOUT",
      kind: "timeout",
      title: "生成等待超时",
      message: "本次请求没有返回可确认的剧本结果。",
      guidance: "请稍后重新尝试；如果持续出现，请联系管理员检查文案模型响应时间。",
      retryable: true,
    };
  }

  return {
    status,
    code,
    kind: "service",
    title: "爽剧服务暂不可用",
    message: "本次没有生成可确认的剧本结果。",
    guidance: "请稍后重新尝试；如果持续出现，请联系管理员检查主站文案模型与项目服务。",
    retryable: true,
  };
}

export function classifyUpstreamDramaFailure(status: number, detail: unknown): PublicDramaFailure {
  const code = readCode(detail);
  if (
    code === "MIGRATION_NOT_READY"
    || code === "SHORT_DRAMA_TEXT_MODEL_UNAVAILABLE"
    || code === "MODEL_NOT_AVAILABLE"
    || code === "LLM_DUPLICATE_SUBMISSION"
    || code === "LLM_IDEMPOTENCY_CONFLICT"
    || code === "LLM_IDEMPOTENCY_STORE_UNAVAILABLE"
    || code === "LLM_IDEMPOTENCY_KEY_INVALID"
  ) {
    return describePublicDramaFailure(status, code);
  }
  if ((status === 401 || status === 403) && hasInternalProviderDetail(readMessage(detail))) {
    return describePublicDramaFailure(503, "DRAMA_MODEL_ACCESS_DENIED");
  }
  return describePublicDramaFailure(status, status === 401 ? "UNAUTHORIZED" : "DRAMA_SCRIPT_FAILED");
}

export function publicDramaFailureFromPayload(status: number, payload: unknown): PublicDramaFailure {
  return describePublicDramaFailure(status, readCode(payload) || "DRAMA_SCRIPT_FAILED");
}
