import { LLM_MODEL_VALIDATION_MAX_AGE_MS, LlmModelValidationError } from "../llm-model-validation-gate";
import type { getSupabaseAdminClient } from "../../storage/database/supabase-client";

// Frozen, redacted receipt for the three local settled calls. It proves business
// execution and present binding equivalence, not a production instruction test.
export const REVIEWED_TEXT_HISTORY = Object.freeze({
  source: "reviewed_local_business_history",
  modelId: "97f7feee-08f8-4174-a918-770758ddf7d6",
  agentId: "agent-1793171231055-r9qzu6",
  configurationHash: "8021c56dcd535c180a78b8060ba17a33eee5f75f53be6dc987a1b2cc559cdbac",
  evidenceSha256: "f0a35e0fcc50921c5f1953371c00b96585141216a7f0787549fa01c8e19f27f8",
  checkedAt: "2026-11-02T18:18:19.863Z",
  settledCount: 3,
} as const);

const REVIEWED_DIRECTOR_CHANNEL = Object.freeze({
  revision: 2,
  previousModelId: "705eab71-df2d-4e4d-ab1d-ab2de6cc8ddd",
  previousModel: "deepseek-v4-flash",
  agentProxy: "https://api.deepseek.com",
  modelEndpoint: "https://api.deepseek.com/",
});

// Filter in the database and return only the ID. The native publish transaction repeats the private-field checks under lock.
export async function hasReviewedDirectorChannel(
  db: Pick<ReturnType<typeof getSupabaseAdminClient>, "from">, modelEndpoint: unknown,
): Promise<boolean> {
  const previous = REVIEWED_DIRECTOR_CHANNEL;
  if (modelEndpoint !== previous.modelEndpoint) return false;
  let query = db.from("agents").select("id").eq("id", REVIEWED_TEXT_HISTORY.agentId).eq("config_revision", previous.revision)
    .eq("source", "llm").eq("model_id", previous.previousModelId).eq("model", previous.previousModel)
    .eq("user_access", "view_only").eq("is_active", false).is("deleted_at", null).eq("proxy_url", previous.agentProxy)
    .or("enable_knowledge_base.is.null,enable_knowledge_base.is.false");
  for (const name of ["bot_id", "knowledge_base_id", "coze_coding_api_token", "coze_coding_api_url", "coze_coding_project_id"]) {
    query = query.or(`${name}.is.null,${name}.eq.""`);
  }
  const { data, error } = await query.maybeSingle();
  if (error) throw new LlmModelValidationError("REVIEWED_DIRECTOR_CHANNEL_READ_FAILED", "暂时无法核对原导演卡的正式通道", 503);
  return data?.id === REVIEWED_TEXT_HISTORY.agentId;
}

export const REVIEWED_HISTORY_REQUEST_KEY = "reviewed-text-history:deepseek-flash:2026-11-03";
const AUDIT_ACTION = "accept_reviewed_text_history";
const AUDIT_REASON = "THREE_LOCAL_SETTLED_TEXT_REQUESTS";
const AUDIT_PATH = "/api/admin/models/activate";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export type ReviewedHistoryProof = {
  source: typeof REVIEWED_TEXT_HISTORY.source;
  auditId: string;
  auditCreatedAt: string;
  checkedAt: string;
};

function exactObject(value: unknown, expected: Record<string, unknown>): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return Object.keys(row).length === Object.keys(expected).length
    && Object.entries(expected).every(([key, field]) => Object.hasOwn(row, key) && row[key] === field);
}

export function assertReviewedHistoryRequest(body: unknown, now = Date.now()) {
  const { modelId, evidenceSha256 } = REVIEWED_TEXT_HISTORY;
  const request = body as Record<string, unknown> | null;
  if (!exactObject(body, { id: modelId, model_type: "text", reviewedHistory: request?.reviewedHistory })
    || !exactObject(request?.reviewedHistory, { evidenceSha256, requestKey: REVIEWED_HISTORY_REQUEST_KEY })) {
    throw new LlmModelValidationError("REVIEWED_HISTORY_REQUEST_INVALID", "此受审恢复仅接受已冻结的模型和证据摘要", 400);
  }
  if (!withinHistoryWindow(now)) {
    throw new LlmModelValidationError("REVIEWED_HISTORY_EXPIRED", "已审业务记录已超出可用于本次恢复的七天窗口");
  }
}

function withinHistoryWindow(now: number) {
  const age = now - Date.parse(REVIEWED_TEXT_HISTORY.checkedAt);
  return age >= -60_000 && age <= LLM_MODEL_VALIDATION_MAX_AGE_MS;
}

export async function readReviewedTextHistory(
  db: Pick<ReturnType<typeof getSupabaseAdminClient>, "from">,
  modelId: string,
  configurationHash: string,
  agentId: string,
  now = Date.now(),
): Promise<ReviewedHistoryProof | null> {
  const target = REVIEWED_TEXT_HISTORY;
  if (modelId !== target.modelId || configurationHash !== target.configurationHash
    || agentId !== target.agentId || !withinHistoryWindow(now)) return null;

  const { data, error } = await db.from("admin_governance_audit")
    .select("id,actor_id,actor_level,permission_key,action,result,reason_code,resource,request_key,request_path,request_method,created_at,metadata")
    .eq("request_key", REVIEWED_HISTORY_REQUEST_KEY).maybeSingle();
  if (error) throw new LlmModelValidationError("REVIEWED_HISTORY_READ_FAILED", "暂时无法读取受审历史业务记录", 503);
  if (!data) return null;
  const adoptedAt = Date.parse(String(data.created_at ?? ""));
  if (!UUID.test(String(data.id)) || !UUID.test(String(data.actor_id)) || data.actor_level !== "super_admin"
    || data.permission_key !== "models.manage" || data.action !== AUDIT_ACTION || data.result !== "success"
    || data.reason_code !== AUDIT_REASON || data.resource !== target.modelId || data.request_key !== REVIEWED_HISTORY_REQUEST_KEY
    || data.request_path !== AUDIT_PATH || data.request_method !== "POST" || !exactObject(data.metadata, target)
    || !Number.isFinite(adoptedAt) || adoptedAt < Date.parse(target.checkedAt) || adoptedAt > now + 60_000) {
    throw new LlmModelValidationError("REVIEWED_HISTORY_AUDIT_MISMATCH", "受审历史业务记录与冻结的采纳回执不一致", 409);
  }
  return { source: target.source, auditId: data.id, auditCreatedAt: data.created_at, checkedAt: target.checkedAt };
}
