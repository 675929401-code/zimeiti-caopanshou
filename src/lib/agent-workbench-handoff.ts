import {
  buildStructuredAgentOutputReadyDetail,
  parseStructuredAgentOutput,
  type StructuredAgentOutputReadyDetail,
} from "@/lib/structured-agent-output";
import { createUserScopedWorkbenchStorage, readBrowserWorkbenchIdentity } from "@/lib/workbench-user-storage";
import { parseStoryboardCanvasImport } from "@/lib/storyboard-canvas-bridge";
import { STORYBOARD_DIRECTOR_PRODUCTION_CONTRACT_VERSION, type StoryboardDirectorInput, type StoryboardDirectorMode, type StoryboardVerifiedAssetBinding } from "@/lib/storyboard-director-protocol";
import { parseStoryboardDirectorIntake } from "@/lib/storyboard-director-intake";
import { collectStoryboardDirectorReferenceBindings } from "@/lib/storyboard-director-reference-verification";
import { STORYBOARD_PERFORMANCE_CONTRACT_VERSION, storyboardPerformanceActivationTime } from "./storyboard-director-performance";

export const AGENT_WORKBENCH_HANDOFF_SCHEMA_VERSION = "agent_workbench_handoff.v1";
export const AGENT_WORKBENCH_HANDOFF_TTL_MS = 2 * 60 * 1_000;

export type AgentWorkbenchHandoffTarget = "storyboard-workbench" | "canvas" | "film-studio";

export interface AgentWorkbenchHandoffEnvelope {
  schema_version: typeof AGENT_WORKBENCH_HANDOFF_SCHEMA_VERSION;
  artifact_type: "agent_workbench_handoff";
  handoff_id: string;
  source_route: "/tools/text/text-chat" | "/";
  target: AgentWorkbenchHandoffTarget;
  created_at: string;
  expires_at: string;
  payload: StructuredAgentOutputReadyDetail;
}

export interface AgentWorkbenchHandoffStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export type AgentWorkbenchHandoffReadResult =
  | { ok: true; handoff: AgentWorkbenchHandoffEnvelope }
  | {
      ok: false;
      code: "MISSING" | "INVALID" | "EXPIRED" | "TARGET_MISMATCH" | "ID_MISMATCH" | "STORAGE_UNAVAILABLE";
      error: string;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function browserSessionStorage(
  storage?: AgentWorkbenchHandoffStorage,
  target?: AgentWorkbenchHandoffTarget,
): AgentWorkbenchHandoffStorage | null {
  if (typeof window !== "undefined" && target) {
    try {
      const legacyKey = agentWorkbenchHandoffStorageKey(target);
      const legacyRaw = window.sessionStorage.getItem(legacyKey);
      window.sessionStorage.removeItem(legacyKey);
      clearLegacyReceipt(window.sessionStorage, target, legacyRaw);
    } catch {
      // Legacy unscoped bytes are ignored when browser storage is unavailable.
    }
  }
  if (storage) return storage;
  if (typeof window === "undefined") return null;
  try {
    const identity = readBrowserWorkbenchIdentity();
    return identity ? createUserScopedWorkbenchStorage(window.sessionStorage, identity.userId) : null;
  } catch {
    return null;
  }
}

function safeToken(value: string): string {
  return value.replace(/[^A-Za-z0-9._:-]/gu, "-").slice(0, 220);
}

export function agentWorkbenchHandoffStorageKey(target: AgentWorkbenchHandoffTarget, handoffId?: string): string {
  if (handoffId !== undefined && !isValidHandoffId(handoffId)) throw new Error("INVALID_AGENT_HANDOFF_ID");
  return `agent_workbench_handoff_v1:${target}${handoffId ? `:${handoffId}` : ""}`;
}

function isValidHandoffId(value: string): boolean {
  return /^[A-Za-z0-9._:-]{1,220}$/u.test(value);
}

function createHandoffId(): string {
  // A click owns its delivery, even when the message and destination are equal.
  // Project deduplication remains based on the unchanged payload commit key.
  return crypto.randomUUID();
}

function legacyAgentWorkbenchHandoffReceiptKey(
  target: AgentWorkbenchHandoffTarget,
  handoffId: string,
): string {
  return `agent_workbench_handoff_receipt_v1:${target}:${safeToken(handoffId)}`;
}

/** Resolve the card attached to this exact reply, never a later or model-echoed input. */
export function readStoryboardIntakeSnapshotForMessage(
  messages: ReadonlyArray<{ id: string; role: string; content: string }> | undefined,
  messageId: string,
  configuredDirectorMode?: unknown,
) {
  const assistantIndex = messages?.findIndex(item => item.id === messageId) ?? -1;
  if (!messages || assistantIndex < 0) return undefined;
  const directorMode: StoryboardDirectorMode | undefined = configuredDirectorMode === "narrative" ? "cinematic"
    : configuredDirectorMode === "high_energy" || configuredDirectorMode === "cinematic" || configuredDirectorMode === "lyrical"
      ? configuredDirectorMode : undefined;
  for (let index = assistantIndex - 1; index >= 0; index -= 1) {
    if (messages[index].role !== "user") continue;
    const intake = parseStoryboardDirectorIntake(messages[index].content, { directorMode });
    if (!intake || intake.missingFields.some(field => field.startsWith("duplicate:") || field.startsWith("invalid:")
      || ["segmented_script", "animation_style", "aspect_ratio", "target_duration_seconds"].includes(field))) return undefined;
    return intake;
  }
  return undefined;
}

export function readStoryboardIntakeForMessage(
  messages: ReadonlyArray<{ id: string; role: string; content: string }> | undefined,
  messageId: string,
  configuredDirectorMode?: unknown,
): StoryboardDirectorInput | undefined {
  return readStoryboardIntakeSnapshotForMessage(messages, messageId, configuredDirectorMode)?.input;
}

/** Bind a new contract to the original card submission time, not today's view of old replies. */
export function resolveStoryboardHandoffContract(
  messages: ReadonlyArray<{ id: string; role: string; timestamp?: number }> | undefined,
  messageId: string,
  outputStyle: unknown,
): { requiredVersion?: typeof STORYBOARD_DIRECTOR_PRODUCTION_CONTRACT_VERSION; allowLegacyUnverified?: boolean; requirePerformancePlan?: boolean; error?: string } {
  if (!isRecord(outputStyle)) return {};
  const productionConfigured = outputStyle.production_contract_version !== undefined;
  const performanceConfigured = outputStyle.performance_contract !== undefined;
  if (!productionConfigured && !performanceConfigured) return {};
  if (productionConfigured && outputStyle.production_contract_version !== STORYBOARD_DIRECTOR_PRODUCTION_CONTRACT_VERSION) {
    return { error: "当前导演合同版本无法识别，请刷新智能体配置后重试。" };
  }
  if (performanceConfigured && outputStyle.performance_contract !== STORYBOARD_PERFORMANCE_CONTRACT_VERSION) {
    return { error: "当前动作与表情合同无法识别，请刷新智能体配置后重试。" };
  }
  const activatedAt = typeof outputStyle.production_contract_activated_at === "string"
    ? Date.parse(outputStyle.production_contract_activated_at) : NaN;
  const assistantIndex = messages?.findIndex(item => item.id === messageId) ?? -1;
  let submittedAt: number | undefined;
  for (let index = assistantIndex - 1; messages && index >= 0; index -= 1) {
    if (messages[index].role !== "user") continue;
    submittedAt = messages[index].timestamp;
    break;
  }
  if ((productionConfigured && !Number.isFinite(activatedAt)) || typeof submittedAt !== "number" || !Number.isFinite(submittedAt) || submittedAt <= 0) {
    return { error: "无法核对原接收卡与导演合同的生效时间，请重新提交接收卡。" };
  }
  const performanceActivatedAt = storyboardPerformanceActivationTime(outputStyle.performance_contract_activated_at);
  if (performanceConfigured && performanceActivatedAt === undefined) return { error: "无法核对动作与表情合同生效时间，请刷新配置后重新提交接收卡。" };
  return { ...(productionConfigured ? submittedAt >= activatedAt ? { requiredVersion: STORYBOARD_DIRECTOR_PRODUCTION_CONTRACT_VERSION } : { allowLegacyUnverified: true } : {}),
    ...(performanceConfigured ? { requirePerformancePlan: submittedAt >= performanceActivatedAt! } : {}) };
}

/** This gate permits manual draft conversion; it does not establish LLM completion. */
export function buildHomepageStoryboardDraftDetail(message: {
  id: string;
  role: "user" | "assistant";
  content: string;
  isStreaming?: boolean;
  streamStatus?: string;
  error?: string;
}, expectedInput?: StoryboardDirectorInput, requiredContractVersion?: typeof STORYBOARD_DIRECTOR_PRODUCTION_CONTRACT_VERSION,
options: { previewAssetVerification?: boolean; referenceProjectId?: string; verifiedAssetBindings?: StoryboardVerifiedAssetBinding[]; allowLegacyUnverified?: boolean; requirePerformancePlan?: boolean } = {},
): StructuredAgentOutputReadyDetail | null {
  if (message.role !== "assistant" || message.isStreaming || message.error || !message.id.trim()) return null;
  const explicitFailure = /(?:最终结果|结果|终态).{0,12}(?:暂未确认|不明)|避免重复发送|禁止重复提交|RECONCILIATION_REQUIRED|RESULT_UNKNOWN|\[已终止\]|\[已停止接收[^\]]*\]|输出中断|网络中断|连接中断|^发送失败：/iu;
  if (explicitFailure.test(message.content)
    || /(?:error|failed|aborted|unknown|stopped|已停止|已终止|失败|中断)/iu.test(message.streamStatus || "")) return null;
  const result = parseStructuredAgentOutput(message.content, true, { expectedInput, requirePerformancePlan: options.requirePerformancePlan });
  if (result.status !== "valid" || result.kind !== "storyboard_director" || result.source !== "stable_json") return null;
  const detail = buildStructuredAgentOutputReadyDetail(message.id, result);
  if (detail && expectedInput) detail.expected_input = expectedInput;
  if (detail && requiredContractVersion) detail.required_contract_version = requiredContractVersion;
  if (detail && options.requirePerformancePlan) detail.require_performance_plan = true;
  if (detail && detail.phase !== "planned" && options.referenceProjectId) detail.reference_project_id = options.referenceProjectId;
  if (detail && detail.phase !== "planned" && options.verifiedAssetBindings) detail.verified_asset_bindings = options.verifiedAssetBindings;
  if (detail && options.allowLegacyUnverified && isRecord(detail.machine_payload) && !detail.machine_payload.production_contract_version) detail.legacy_input_compatibility = true;
  return detail && parseStoryboardCanvasImport(detail, { assetVerification: options.previewAssetVerification ? "preview" : "required" }) ? detail : null;
}

/** Resolve real adopted images under the current account before revealing or sending reference boards. */
export async function verifyStoryboardHandoffReferenceAssets(
  detail: StructuredAgentOutputReadyDetail,
  options: { userId: string; token: string; fetcher?: typeof fetch; assertCurrent?: () => void },
): Promise<StructuredAgentOutputReadyDetail> {
  const preview = parseStoryboardCanvasImport(detail, { assetVerification: "preview" });
  if (!preview) throw new Error("分镜包或原接收卡未通过校验，未执行交接。");
  if (preview.phase === "planned" || preview.phase === "draft") {
    const plan = { ...detail };
    delete plan.reference_project_id;
    delete plan.verified_asset_bindings;
    return plan;
  }
  if (!preview.pendingAssetVerification) return detail;
  const assertCurrent = options.assertCurrent || (() => {
    const identity = readBrowserWorkbenchIdentity();
    if (identity?.userId !== options.userId || identity.token !== options.token) throw new Error("账号已变化，已停止核验与交接。");
  });
  assertCurrent();
  const projectId = detail.reference_project_id;
  if (!projectId || !/^[A-Za-z0-9:_-]{8,160}$/u.test(projectId) || !detail.expected_input) {
    throw new Error("请先在三视图项目完成生成并采用，再复制续写卡生成正式分镜。");
  }
  const fetcher = options.fetcher || fetch;
  const headers = { Authorization: `Bearer ${options.token}` };
  const response = await fetcher(`/api/storyboard/projects?id=${encodeURIComponent(projectId)}`, { headers, cache: "no-store", signal: AbortSignal.timeout(20_000) });
  const result: unknown = await response.json();
  assertCurrent();
  if (!response.ok || !isRecord(result) || !isRecord(result.project) || result.project.id !== projectId
    || !isRecord(result.project.document) || result.project.document.id !== projectId) throw new Error("原三视图项目不存在、尚未保存或不属于当前账号。");
  const bindings = collectStoryboardDirectorReferenceBindings(result.project.document, detail.expected_input);
  await Promise.all(bindings.map(async binding => {
    const owned = await fetcher(`/api/storyboard/visual-assets?recordId=${encodeURIComponent(binding.historyRecordId)}`, { headers, cache: "no-store", signal: AbortSignal.timeout(20_000) });
    const payload: unknown = await owned.json();
    assertCurrent();
    if (!owned.ok || !isRecord(payload) || !isRecord(payload.reference) || payload.reference.recordId !== binding.historyRecordId
      || typeof payload.reference.previewUrl !== "string" || !payload.reference.previewUrl.trim()) {
      throw new Error("人物或宠物三视图原图尚未完成、不可读取或不属于当前账号。");
    }
  }));
  assertCurrent();
  const verified = { ...detail, verified_asset_bindings: bindings };
  if (!parseStoryboardCanvasImport(verified)) throw new Error("正式分镜引用与已采用三视图不一致，请使用原项目续写卡重新生成。");
  return verified;
}

export function createAgentWorkbenchHandoff(
  detail: StructuredAgentOutputReadyDetail,
  target: AgentWorkbenchHandoffTarget,
  nowMs = Date.now(),
  sourceRoute: AgentWorkbenchHandoffEnvelope["source_route"] = "/tools/text/text-chat",
): AgentWorkbenchHandoffEnvelope | null {
  if (!detail.commit_key.trim() || !detail.message_id.trim()) return null;
  if (sourceRoute !== "/" && sourceRoute !== "/tools/text/text-chat") return null;
  if (!parseStoryboardCanvasImport(detail)) return null;
  const createdAt = new Date(nowMs);
  const expiresAt = new Date(nowMs + AGENT_WORKBENCH_HANDOFF_TTL_MS);
  return {
    schema_version: AGENT_WORKBENCH_HANDOFF_SCHEMA_VERSION,
    artifact_type: "agent_workbench_handoff",
    handoff_id: createHandoffId(),
    source_route: sourceRoute,
    target,
    created_at: createdAt.toISOString(),
    expires_at: expiresAt.toISOString(),
    payload: detail,
  };
}

export function saveAgentWorkbenchHandoff(
  detail: StructuredAgentOutputReadyDetail,
  target: AgentWorkbenchHandoffTarget,
  storage?: AgentWorkbenchHandoffStorage,
  sourceRoute: AgentWorkbenchHandoffEnvelope["source_route"] = "/tools/text/text-chat",
): AgentWorkbenchHandoffEnvelope | null {
  const targetStorage = browserSessionStorage(storage, target);
  const envelope = createAgentWorkbenchHandoff(detail, target, Date.now(), sourceRoute);
  if (!targetStorage || !envelope) return null;
  try {
    // Canvas and film-studio keep their existing same-tab, single-use contract.
    // Storyboard is ID-addressed and consumed only after durable project save.
    const key = agentWorkbenchHandoffStorageKey(target, target === "storyboard-workbench" ? envelope.handoff_id : undefined);
    clearLegacyReceipt(targetStorage, target, targetStorage.getItem(key));
    targetStorage.setItem(key, JSON.stringify(envelope));
    return envelope;
  } catch {
    return null;
  }
}

export function parseAgentWorkbenchHandoff(
  raw: string | null,
  expectedTarget: AgentWorkbenchHandoffTarget,
  options: { nowMs?: number; handoffId?: string } = {},
): AgentWorkbenchHandoffReadResult {
  if (!raw) return { ok: false, code: "MISSING", error: "未找到 Agent 交接内容，请返回创作 Agent 重新点击交接。" };
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { ok: false, code: "INVALID", error: "Agent 交接内容已损坏，未执行导入。" };
  }
  if (!isRecord(value)
    || value.schema_version !== AGENT_WORKBENCH_HANDOFF_SCHEMA_VERSION
    || value.artifact_type !== "agent_workbench_handoff"
    || typeof value.handoff_id !== "string"
    || !isValidHandoffId(value.handoff_id)
    || (value.source_route !== "/" && value.source_route !== "/tools/text/text-chat")
    || typeof value.target !== "string"
    || typeof value.created_at !== "string"
    || typeof value.expires_at !== "string"
    || !isRecord(value.payload)) {
    return { ok: false, code: "INVALID", error: "Agent 交接协议不完整，未执行导入。" };
  }
  if (value.target !== expectedTarget) {
    return { ok: false, code: "TARGET_MISMATCH", error: "Agent 交接目标与当前工作台不一致，未执行导入。" };
  }
  if (options.handoffId !== undefined && value.handoff_id !== options.handoffId) {
    return { ok: false, code: "ID_MISMATCH", error: "Agent 交接编号与当前窗口不一致，未执行导入。" };
  }
  const nowMs = options.nowMs ?? Date.now();
  const createdAt = Date.parse(value.created_at);
  const expiresAt = Date.parse(value.expires_at);
  if (!Number.isFinite(createdAt) || !Number.isFinite(expiresAt)
    || createdAt > nowMs || expiresAt <= nowMs
    || expiresAt - createdAt <= 0 || expiresAt - createdAt > AGENT_WORKBENCH_HANDOFF_TTL_MS) {
    return { ok: false, code: "EXPIRED", error: "Agent 交接已过期，请返回创作 Agent 重新确认。" };
  }
  const envelope = value as unknown as AgentWorkbenchHandoffEnvelope;
  if (!parseStoryboardCanvasImport(envelope.payload)) {
    return { ok: false, code: "INVALID", error: "Agent 交接中的分镜机器包未通过校验，未执行导入。" };
  }
  return { ok: true, handoff: envelope };
}

function clearLegacyReceipt(
  storage: AgentWorkbenchHandoffStorage,
  target: AgentWorkbenchHandoffTarget,
  raw: string | null,
): void {
  if (!raw) return;
  try {
    const value: unknown = JSON.parse(raw);
    if (isRecord(value) && typeof value.handoff_id === "string") {
      storage.removeItem(legacyAgentWorkbenchHandoffReceiptKey(target, value.handoff_id));
    }
  } catch {
    // The payload key is still deleted even when legacy bytes are malformed.
  }
}

export function readAgentWorkbenchHandoff(
  target: AgentWorkbenchHandoffTarget,
  storage?: AgentWorkbenchHandoffStorage,
  nowMs = Date.now(),
  handoffId?: string,
): AgentWorkbenchHandoffReadResult {
  const targetStorage = browserSessionStorage(storage, target);
  if (!targetStorage) {
    return { ok: false, code: "STORAGE_UNAVAILABLE", error: "浏览器会话存储不可用，未执行 Agent 交接。" };
  }
  try {
    if (handoffId !== undefined && !isValidHandoffId(handoffId)) {
      return { ok: false, code: "INVALID", error: "Agent 交接编号无效，未执行导入。" };
    }
    const key = agentWorkbenchHandoffStorageKey(target, target === "storyboard-workbench" ? handoffId : undefined);
    const raw = targetStorage.getItem(key);
    const parsed = parseAgentWorkbenchHandoff(raw, target, { nowMs, handoffId });
    if (target !== "storyboard-workbench" || (!parsed.ok && parsed.code !== "ID_MISMATCH")) {
      targetStorage.removeItem(key);
      clearLegacyReceipt(targetStorage, target, raw);
    }
    // No-ID reads only inspect the old single slot; they never choose a new ID
    // or fall back to another pending message. Refresh/retry retains valid data.
    return parsed;
  } catch {
    return { ok: false, code: "STORAGE_UNAVAILABLE", error: "浏览器会话存储读取失败，未执行 Agent 交接。" };
  }
}

/**
 * 新窗口交接：新标签页不共享 sessionStorage，所以把交接封包写入 localStorage
 * （仍按用户作用域隔离、仍带 TTL），分镜工作台成功保存后确认消费。
 */
export function saveAgentWorkbenchHandoffForNewWindow(
  detail: StructuredAgentOutputReadyDetail,
  target: AgentWorkbenchHandoffTarget,
  sourceRoute: AgentWorkbenchHandoffEnvelope["source_route"] = "/tools/text/text-chat",
): AgentWorkbenchHandoffEnvelope | null {
  if (typeof window === "undefined") return null;
  try {
    const identity = readBrowserWorkbenchIdentity();
    if (!identity) return null;
    const storage = createUserScopedWorkbenchStorage(window.localStorage, identity.userId);
    return saveAgentWorkbenchHandoff(detail, target, storage, sourceRoute);
  } catch {
    return null;
  }
}

/** 读取时先看当前标签页，再回退到跨标签页存储（新窗口交接）。 */
export function readAgentWorkbenchHandoffAcrossTabs(
  target: AgentWorkbenchHandoffTarget,
  userId: string,
  nowMs = Date.now(),
  handoffId?: string,
): AgentWorkbenchHandoffReadResult {
  if (typeof window === "undefined") {
    return { ok: false, code: "STORAGE_UNAVAILABLE", error: "浏览器环境不可用，未执行 Agent 交接。" };
  }
  const identity = readBrowserWorkbenchIdentity();
  if (!identity || identity.userId !== userId) {
    return { ok: false, code: "STORAGE_UNAVAILABLE", error: "账号已变化，请使用接收交接时的账号重新打开。" };
  }
  const fromSession = readAgentWorkbenchHandoff(target, createUserScopedWorkbenchStorage(window.sessionStorage, userId), nowMs, handoffId);
  if (fromSession.ok) return fromSession;
  const fromLocal = readAgentWorkbenchHandoff(target, createUserScopedWorkbenchStorage(window.localStorage, userId), nowMs, handoffId);
  if (fromLocal.ok) return fromLocal;
  return fromLocal.code === "MISSING" ? fromSession : fromLocal;
}

/** Call only after the destination project has been saved or restored. */
export function acknowledgeAgentWorkbenchHandoff(
  target: AgentWorkbenchHandoffTarget,
  handoffId: string,
  storage?: AgentWorkbenchHandoffStorage,
): boolean {
  const targetStorage = browserSessionStorage(storage, target);
  if (!targetStorage || !isValidHandoffId(handoffId)) return false;
  try {
    // A legacy slot can be acknowledged only if it still owns this exact ID.
    // Never remove a newer handoff that arrived between reading and saving.
    for (const key of [agentWorkbenchHandoffStorageKey(target, handoffId), agentWorkbenchHandoffStorageKey(target)]) {
      const raw = targetStorage.getItem(key);
      if (!raw) continue;
      let value: unknown;
      try { value = JSON.parse(raw); } catch { continue; }
      if (isRecord(value) && value.handoff_id === handoffId && value.target === target) {
        targetStorage.removeItem(key);
        clearLegacyReceipt(targetStorage, target, raw);
      }
    }
    return true;
  } catch { return false; }
}

export function acknowledgeAgentWorkbenchHandoffAcrossTabs(
  target: AgentWorkbenchHandoffTarget,
  userId: string,
  handoffId: string,
): boolean {
  if (typeof window === "undefined") return false;
  try {
    if (readBrowserWorkbenchIdentity()?.userId !== userId) return false;
    const fromSession = acknowledgeAgentWorkbenchHandoff(target, handoffId, createUserScopedWorkbenchStorage(window.sessionStorage, userId));
    const fromLocal = acknowledgeAgentWorkbenchHandoff(target, handoffId, createUserScopedWorkbenchStorage(window.localStorage, userId));
    return fromSession && fromLocal;
  } catch { return false; }
}
