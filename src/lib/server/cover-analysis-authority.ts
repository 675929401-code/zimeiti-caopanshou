import { createHash } from "node:crypto";
import type { ChatRequest } from "@/lib/llm-proxy/types";
import type { CoverPrepareRow } from "./cover-prepare-repository";

/** Fixed platform profile, never selected by a client prompt or a display name. */
export const COVER_ANALYSIS_RUNTIME_FIELDS = Object.freeze({
  stream: false, response_format: "json_object", temperature: 0.4,
  max_reply_tokens: 6000, timeout: 180, agentName: "封面内容分析", model_overridden: true,
} as const);

export class CoverAnalysisAuthorityError extends Error {
  constructor(readonly code: string, message: string, readonly status = 403) { super(message); this.name = "CoverAnalysisAuthorityError"; }
}
const refuse = (code: string, message: string, status = 403): never => { throw new CoverAnalysisAuthorityError(code, message, status); };
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, canonical(item)]));
  return value;
}
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
type Messages = ChatRequest["messages"];
export type AuthorizedCoverAnalysisWorkflow = {
  operationId: string;
  prompt: string;
  messages: Messages;
};
const authorizations = new WeakMap<AuthorizedCoverAnalysisWorkflow, string>();
/** Runtime proof is process-local and can only be issued by the owner-bound authorizer. */
export function assertAuthorizedCoverAnalysisWorkflow(value: AuthorizedCoverAnalysisWorkflow): void {
  const expected = value && authorizations.get(value);
  if (!expected || expected !== digest(value)) refuse("COVER_ANALYSIS_AUTHORITY_REQUIRED", "封面分析缺少有效服务器授权");
}

/**
 * cover_operation_id is only a lookup hint. All authority comes from the
 * authenticated owner's persisted operation and a fresh server reconstruction.
 * Dependencies are injectable solely for zero-network contract verification.
 */
export async function authorizeCoverAnalysisWorkflow(input: {
  body: Record<string, unknown>;
  verifiedUserId: string | undefined;
  clientRequestId: string;
  loadOperation?: (userId: string, operationId: string) => Promise<CoverPrepareRow | null>;
  buildMessages?: (row: CoverPrepareRow) => Promise<Messages>;
}): Promise<AuthorizedCoverAnalysisWorkflow | null> {
  if (!Object.prototype.hasOwnProperty.call(input.body, "cover_operation_id")) return null;
  const operationId = input.body.cover_operation_id;
  if (!input.verifiedUserId) return refuse("COVER_ANALYSIS_UNAUTHORIZED", "请先登录", 401);
  if (typeof operationId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(operationId)) return refuse("COVER_ANALYSIS_OPERATION_INVALID", "封面任务标识无效", 422);
  const load = input.loadOperation || (async (userId, id) => (await import("./cover-prepare-repository")).loadCoverPreparation(userId, id));
  let row: CoverPrepareRow | null;
  try { row = await load(input.verifiedUserId, operationId); }
  catch { return refuse("COVER_ANALYSIS_AUTHORITY_UNAVAILABLE", "封面分析授权暂时无法确认，本次未调用模型", 503); }
  if (!row || row.id !== operationId || row.user_id !== input.verifiedUserId) return refuse("COVER_ANALYSIS_OPERATION_NOT_FOUND", "封面任务不存在或不属于当前账号", 404);
  if (row.preparation.recordKind === "confirmation") return refuse("COVER_CONFIRMATION_ANALYSIS_FORBIDDEN", "已确认方案不允许再次调用文案分析");
  if (row.state !== "analyzing" || row.consent?.analysis !== true) return refuse("COVER_ANALYSIS_OPERATION_NOT_AUTHORIZED", "封面任务尚未确认分析费用或当前状态不允许分析");
  if (!input.clientRequestId || row.analysis_request_id !== input.clientRequestId || input.body.client_request_id !== input.clientRequestId) return refuse("COVER_ANALYSIS_REQUEST_MISMATCH", "分析请求标识与原任务不一致");
  const selectedModel = object(object(row.preparation.quote).analysis).modelId;
  if (typeof selectedModel !== "string" || !/^pm_[A-Za-z0-9_-]+$/u.test(selectedModel) || input.body.modelId !== selectedModel) return refuse("COVER_ANALYSIS_MODEL_MISMATCH", "分析模型与已确认方案不一致");
  const expectedKeys = new Set(["cover_operation_id", "client_request_id", "modelId", "system_prompt", "messages", ...Object.keys(COVER_ANALYSIS_RUNTIME_FIELDS)]);
  if (Object.keys(input.body).some(key => !expectedKeys.has(key)) || Object.entries(COVER_ANALYSIS_RUNTIME_FIELDS).some(([key, value]) => input.body[key] !== value)) return refuse("COVER_ANALYSIS_PROFILE_MISMATCH", "封面分析参数与平台固定协议不一致");
  const build = input.buildMessages || (async operation => (await import("./cover-prepare-service")).coverAnalysisRequest(operation));
  let messages: Messages;
  try { messages = await build(row); }
  catch (error) {
    if (object(error).code === "COVER_PREPARATION_STALE") return refuse("COVER_PREPARATION_STALE", "制作方案版本已变化，本次未调用模型，请保留原任务并重新准备", 409);
    return refuse("COVER_ANALYSIS_MATERIAL_UNAVAILABLE", "封面材料暂时无法读取，本次未调用模型", 503);
  }
  const systems = messages.filter(message => message.role === "system");
  const prompt = systems.length === 1 && typeof systems[0].content === "string" ? systems[0].content : "";
  if (!prompt.trim()) return refuse("COVER_ANALYSIS_PROMPT_UNAVAILABLE", "封面分析协议尚未就绪", 503);
  if (typeof input.body.system_prompt !== "string" || input.body.system_prompt !== prompt || digest(input.body.messages) !== digest(messages)) return refuse("COVER_ANALYSIS_INPUT_MISMATCH", "封面分析提示或材料与服务器快照不一致");
  const references = messages.flatMap(message => Array.isArray(message.content) ? message.content : []).filter(part => object(part).type === "image_url");
  if (references.length !== row.materials.assets.length) return refuse("COVER_ANALYSIS_REFERENCE_MISMATCH", "图片输入数量与原任务不一致", 503);
  // The existing LLM attempt stores only the request SHA, never this body or
  // its image bytes. Keep its canonical payload identical to the parent bind.
  const authorized = { operationId, prompt, messages };
  authorizations.set(authorized, digest(authorized));
  return authorized;
}
