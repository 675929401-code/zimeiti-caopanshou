export const MAX_AGENT_AVATAR_BATCH = 20;

export class AgentAvatarGenerationPolicyError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: 400 | 409 | 412 | 413 | 503 = 400,
  ) {
    super(message);
    this.name = "AgentAvatarGenerationPolicyError";
  }
}

export type AgentAvatarGenerationRequest = {
  mode: "single" | "batch";
  agentIds: string[];
  singleAgent: { name: string; description: string } | null;
  singleAgentId: string | null;
  style: string;
  customPrompt: string;
  idempotencyKey: string;
  confirmedAgentCount: number;
};

const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u;
const SAFE_REQUEST_KEY = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{15,127}$/u;

function text(value: unknown, maxLength: number): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (normalized.length > maxLength) {
    throw new AgentAvatarGenerationPolicyError("头像生成参数过长", "AVATAR_GENERATION_INPUT_TOO_LARGE", 413);
  }
  return normalized;
}

/** Normalize the paid side-effect boundary before any model/provider call. */
export function parseAgentAvatarGenerationRequest(
  body: Record<string, unknown>,
  headerIdempotencyKey: string | null,
): AgentAvatarGenerationRequest {
  const rawSingle = body.singleAgent;
  const hasSingle = typeof rawSingle === "object" && rawSingle !== null;
  const rawIds = body.agentIds;
  const hasBatch = Array.isArray(rawIds);
  if (hasSingle === hasBatch) {
    throw new AgentAvatarGenerationPolicyError(
      "必须且只能选择单个智能体或显式 agentIds 范围",
      "AVATAR_GENERATION_SCOPE_REQUIRED",
    );
  }

  const idempotencyKey = text(headerIdempotencyKey || body.idempotencyKey, 128);
  if (!SAFE_REQUEST_KEY.test(idempotencyKey)) {
    throw new AgentAvatarGenerationPolicyError(
      "头像生成必须携带 16-128 位幂等键",
      "AVATAR_GENERATION_IDEMPOTENCY_KEY_REQUIRED",
    );
  }
  if (body.confirmPaidGeneration !== true) {
    throw new AgentAvatarGenerationPolicyError(
      "请明确确认本次头像生成可能产生模型费用",
      "PAID_AVATAR_GENERATION_CONFIRMATION_REQUIRED",
      412,
    );
  }

  const style = text(body.style, 80) || "主站3D卡通";
  const customPrompt = text(body.customPrompt, 1_000);
  const confirmedAgentCount = Number(body.confirmedAgentCount);

  if (hasSingle) {
    const record = rawSingle as Record<string, unknown>;
    const name = text(record.name, 120);
    const description = text(record.description, 2_000);
    const singleAgentId = text(body.agentId, 128) || null;
    if (!name) {
      throw new AgentAvatarGenerationPolicyError("智能体名称不能为空", "AVATAR_GENERATION_NAME_REQUIRED");
    }
    if (singleAgentId && !SAFE_ID.test(singleAgentId)) {
      throw new AgentAvatarGenerationPolicyError("智能体 ID 无效", "AVATAR_GENERATION_AGENT_ID_INVALID");
    }
    if (confirmedAgentCount !== 1) {
      throw new AgentAvatarGenerationPolicyError(
        "费用确认数量必须与单次生成范围一致",
        "AVATAR_GENERATION_CONFIRMATION_SCOPE_MISMATCH",
        412,
      );
    }
    return {
      mode: "single",
      agentIds: [],
      singleAgent: { name, description },
      singleAgentId,
      style,
      customPrompt,
      idempotencyKey,
      confirmedAgentCount,
    };
  }

  const agentIds = [...new Set((rawIds as unknown[]).map((value) => text(value, 128)))];
  if (agentIds.length === 0 || agentIds.some((id) => !SAFE_ID.test(id))) {
    throw new AgentAvatarGenerationPolicyError(
      "批量头像生成必须提供有效的 agentIds",
      "AVATAR_GENERATION_AGENT_IDS_REQUIRED",
    );
  }
  if (agentIds.length > MAX_AGENT_AVATAR_BATCH) {
    throw new AgentAvatarGenerationPolicyError(
      `单批最多生成 ${MAX_AGENT_AVATAR_BATCH} 个头像`,
      "AVATAR_GENERATION_BATCH_LIMIT_EXCEEDED",
      413,
    );
  }
  if (confirmedAgentCount !== agentIds.length) {
    throw new AgentAvatarGenerationPolicyError(
      "费用确认数量必须与 agentIds 范围一致",
      "AVATAR_GENERATION_CONFIRMATION_SCOPE_MISMATCH",
      412,
    );
  }
  return {
    mode: "batch",
    agentIds,
    singleAgent: null,
    singleAgentId: null,
    style,
    customPrompt,
    idempotencyKey,
    confirmedAgentCount,
  };
}
