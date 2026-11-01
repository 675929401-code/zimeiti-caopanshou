import { createHash, randomUUID } from "node:crypto";
import { resolveProviderSecret } from "@/lib/provider-secret";

export const MODEL_ACTIVATION_GATE_SCHEMA = "media_model_activation_gate.v1";
export const MODEL_ACCEPTANCE_EVIDENCE_SCHEMA = "media_model_acceptance_evidence.v1";
export const MODEL_ACTIVATION_GATE_KEY = "__model_activation_gate";
export const PENDING_IMAGE_MODEL_ID_PREFIX = "pending-cover-model-";
export const PENDING_TEXT_USER_ACCESS = "pending_model_activation";

type JsonRecord = Record<string, unknown>;

export type MediaModelKind = "image" | "text" | "video";

export type VideoActivationBinding = {
  id: string;
  model_name: unknown;
  provider: unknown;
  protocol_type: unknown;
  api_endpoint: unknown;
  api_key: unknown;
  api_protocol_config: unknown;
  is_active?: unknown;
  is_hidden?: unknown;
};

export type AcceptanceCheckInput = {
  evidenceRef: string;
  checkedAt?: string;
};

export type VideoAcceptanceChecksInput = {
  secretResolution: AcceptanceCheckInput;
  endpointConnectivity: AcceptanceCheckInput;
  protocolFixture: AcceptanceCheckInput;
  canary: AcceptanceCheckInput;
  resultPersistence: AcceptanceCheckInput;
};

type PersistedCheck = {
  status: "passed";
  evidence_ref: string;
  checked_at: string;
};

export type VideoModelAcceptanceEvidence = {
  schema: typeof MODEL_ACCEPTANCE_EVIDENCE_SCHEMA;
  evidence_id: string;
  issued_at: string;
  issued_by: string;
  issuer: "server";
  model_type: "video";
  model_id: string;
  binding_sha256: string;
  fingerprint_version?: 2;
  checks: {
    secret_resolution: PersistedCheck;
    endpoint_connectivity: PersistedCheck;
    protocol_fixture: PersistedCheck;
    canary: PersistedCheck;
    result_persistence: PersistedCheck;
  };
};

export class ModelActivationGateError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 409) {
    super(message);
    this.name = "ModelActivationGateError";
    this.code = code;
    this.status = status;
  }
}

function assertServerOnly(): void {
  if (typeof window !== "undefined") {
    throw new ModelActivationGateError(
      "MODEL_ACTIVATION_GATE_SERVER_ONLY",
      "模型激活门只能在服务端运行",
      500,
    );
  }
}

function record(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : {};
}

function safeEvidenceRef(value: unknown, label: string): string {
  const normalized = String(value || "").trim();
  if (!/^[A-Za-z0-9._:-]{8,200}$/u.test(normalized)) {
    throw new ModelActivationGateError(
      "MODEL_ACCEPTANCE_EVIDENCE_REF_INVALID",
      `${label} 必须是 8-200 位、不含路径或密钥的证据编号`,
      400,
    );
  }
  return normalized;
}

function safeTimestamp(value: unknown, label: string, fallback: string): string {
  const normalized = String(value || fallback).trim();
  const parsed = Date.parse(normalized);
  if (!normalized || !Number.isFinite(parsed) || parsed > Date.now() + 5 * 60_000) {
    throw new ModelActivationGateError(
      "MODEL_ACCEPTANCE_TIMESTAMP_INVALID",
      `${label} 必须是有效且不晚于当前时间的时间戳`,
      400,
    );
  }
  return new Date(parsed).toISOString();
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as JsonRecord)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalize(entry)]),
  );
}

export function stripClientActivationGate(value: unknown): JsonRecord {
  const source = record(value);
  return Object.fromEntries(
    Object.entries(source).filter(([key]) => key !== MODEL_ACTIVATION_GATE_KEY),
  );
}

function readGate(value: unknown): JsonRecord | null {
  const candidate = record(value)[MODEL_ACTIVATION_GATE_KEY];
  const gate = record(candidate);
  return gate.schema === MODEL_ACTIVATION_GATE_SCHEMA ? gate : null;
}

export function isActivationGatedVideoConfig(value: unknown): boolean {
  return readGate(value) !== null;
}

export function makePendingVideoProtocolConfig(
  requestedConfig: unknown,
  options: { createdAt?: string; binding?: VideoActivationBinding } = {},
): JsonRecord {
  assertServerOnly();
  const createdAt = safeTimestamp(options.createdAt, "createdAt", new Date().toISOString());
  return {
    ...stripClientActivationGate(requestedConfig),
    [MODEL_ACTIVATION_GATE_KEY]: {
      schema: MODEL_ACTIVATION_GATE_SCHEMA,
      state: "pending",
      created_at: createdAt,
      fingerprint_version: 2,
      ...(options.binding ? { binding_sha256: videoActivationBindingSha256V2(options.binding) } : {}),
    },
  };
}

export function forceNewVideoModelPending<T extends JsonRecord>(recordValue: T): T & {
  is_active: true;
  is_hidden: false;
  api_protocol_config: JsonRecord;
} {
  return {
    ...recordValue,
    is_active: true,
    is_hidden: false,
    api_protocol_config: makePendingVideoProtocolConfig(recordValue.api_protocol_config, { binding: recordValue as unknown as VideoActivationBinding }),
  };
}

export function newPendingImageModelId(now = Date.now(), entropy: string = randomUUID()): string {
  assertServerOnly();
  const suffix = entropy.toLowerCase().replace(/[^a-z0-9]/gu, "").slice(0, 12);
  if (!Number.isSafeInteger(now) || now <= 0 || suffix.length < 8) {
    throw new ModelActivationGateError(
      "PENDING_IMAGE_MODEL_ID_INVALID",
      "无法生成隔离生图模型编号",
      500,
    );
  }
  return `${PENDING_IMAGE_MODEL_ID_PREFIX}${now}-${suffix}`;
}

export function isActivationGatedImageId(modelId: unknown): boolean {
  return String(modelId || "").startsWith(PENDING_IMAGE_MODEL_ID_PREFIX);
}

export function isActivationGatedTextUserAccess(value: unknown): boolean {
  return String(value || "") === PENDING_TEXT_USER_ACCESS;
}

export function preservePersistedVideoActivationGate(
  persistedConfig: unknown,
  requestedConfig: unknown,
): JsonRecord {
  const next = stripClientActivationGate(requestedConfig);
  const gate = readGate(persistedConfig);
  return gate ? { ...next, [MODEL_ACTIVATION_GATE_KEY]: gate } : next;
}

function stripWorkspaceSurfaceMetadata(value: unknown): JsonRecord {
  const { workspace_surfaces: _workspaceSurfaces, ...providerConfig } = stripClientActivationGate(value);
  return providerConfig;
}

/**
 * Workspace placement is an administrative display decision, not part of the
 * provider request contract. Preserve a current acceptance proof only when
 * workspace_surfaces is the sole protocol-config difference.
 */
export function preserveVideoAcceptanceForWorkspaceSurfaceUpdate(
  acceptedBinding: VideoActivationBinding,
  requestedConfig: unknown,
): JsonRecord {
  assertServerOnly();
  const next = stripClientActivationGate(requestedConfig);
  const gate = readGate(acceptedBinding.api_protocol_config);
  if (!gate) return next;

  const currentProviderConfig = canonicalize(stripWorkspaceSurfaceMetadata(acceptedBinding.api_protocol_config));
  const nextProviderConfig = canonicalize(stripWorkspaceSurfaceMetadata(next));
  if (JSON.stringify(currentProviderConfig) !== JSON.stringify(nextProviderConfig)) {
    throw new ModelActivationGateError(
      "MODEL_ACCEPTANCE_ADMIN_METADATA_ONLY",
      "只有工作台展示范围变更可以续接既有模型验收证据",
      409,
    );
  }

  const readiness = inspectVideoModelActivationReadiness(acceptedBinding);
  if (!readiness.ready) return { ...next, [MODEL_ACTIVATION_GATE_KEY]: gate };

  const evidence = record(gate.evidence);
  const nextBinding = { ...acceptedBinding, api_protocol_config: next };
  const bindingSha256 = evidence.fingerprint_version === 2
    ? videoActivationBindingSha256V2(nextBinding)
    : videoActivationBindingSha256(nextBinding);
  const publication = record(gate.publication);
  return {
    ...next,
    [MODEL_ACTIVATION_GATE_KEY]: {
      ...gate,
      binding_sha256: bindingSha256,
      evidence: { ...evidence, binding_sha256: bindingSha256 },
      ...(Object.keys(publication).length > 0
        ? { publication: { ...publication, bindingSha256 } }
        : {}),
    },
  };
}

export function videoActivationBindingSha256(binding: VideoActivationBinding): string {
  assertServerOnly();
  const safeBinding = {
    id: String(binding.id || "").trim(),
    model_type: "video",
    model_name: String(binding.model_name || "").trim(),
    provider: String(binding.provider || "").trim(),
    protocol_type: String(binding.protocol_type || "").trim(),
    api_endpoint: String(binding.api_endpoint || "").trim(),
    api_key_reference: String(binding.api_key || "").trim(),
    api_protocol_config: stripClientActivationGate(binding.api_protocol_config),
  };
  return createHash("sha256").update(JSON.stringify(canonicalize(safeBinding))).digest("hex");
}

/** v1 stays readable for unchanged historical gates; all newly issued gates use v2. */
export function videoActivationBindingSha256V2(binding: VideoActivationBinding): string {
  assertServerOnly();
  let resolvedKeyHash = "unresolved";
  try {
    const key = resolveProviderSecret(binding.api_key).trim();
    if (key) resolvedKeyHash = createHash("sha256").update(key).digest("hex");
  } catch { /* A missing credential can be saved as pending, never accepted. */ }
  return createHash("sha256").update(JSON.stringify({ version: 2, binding: videoActivationBindingSha256(binding), resolvedKeyHash })).digest("hex");
}

function videoBindingCredentialReady(binding: VideoActivationBinding): boolean {
  try { return resolveProviderSecret(binding.api_key).trim().length > 0; } catch { return false; }
}

/** Apply this patch in the same model UPDATE. A stale health row cannot bypass pending. */
export function prepareVideoModelBindingUpdate(current: VideoActivationBinding, requested: JsonRecord): JsonRecord {
  assertServerOnly();
  const patch = { ...requested };
  if (patch.api_protocol_config !== undefined) patch.api_protocol_config = preservePersistedVideoActivationGate(current.api_protocol_config, patch.api_protocol_config);
  const next = { ...current, ...patch } as VideoActivationBinding;
  const gate = readGate(current.api_protocol_config);
  const previousHash = gate?.fingerprint_version === 2 && typeof gate.binding_sha256 === "string"
    ? gate.binding_sha256 : videoActivationBindingSha256V2(current);
  const changed = previousHash !== videoActivationBindingSha256V2(next);
  if (changed) patch.api_protocol_config = makePendingVideoProtocolConfig(next.api_protocol_config, { binding: next });
  // Evidence remains available for internal diagnostics, but must never
  // rewrite or veto administrator-controlled active/visible flags.
  return patch;
}

function passedCheck(input: AcceptanceCheckInput, label: string, issuedAt: string): PersistedCheck {
  return {
    status: "passed",
    evidence_ref: safeEvidenceRef(input.evidenceRef, label),
    checked_at: safeTimestamp(input.checkedAt, `${label}.checkedAt`, issuedAt),
  };
}

export function issueVideoModelAcceptanceEvidence(
  binding: VideoActivationBinding,
  checks: VideoAcceptanceChecksInput,
  options: { evidenceId?: string; issuedAt?: string; issuedBy: string },
): VideoModelAcceptanceEvidence {
  assertServerOnly();
  if (!videoBindingCredentialReady(binding)) throw new ModelActivationGateError("MODEL_ACCEPTANCE_CREDENTIAL_UNAVAILABLE", "当前模型凭据未就绪，不能签发发布证据", 503);
  if (!isActivationGatedVideoConfig(binding.api_protocol_config)) {
    throw new ModelActivationGateError(
      "MODEL_NOT_ACTIVATION_GATED",
      "只允许为新接入且仍受激活门保护的视频模型签发证据",
      400,
    );
  }
  const issuedAt = safeTimestamp(options.issuedAt, "issuedAt", new Date().toISOString());
  const issuedBy = safeEvidenceRef(options.issuedBy, "issuedBy");
  return {
    schema: MODEL_ACCEPTANCE_EVIDENCE_SCHEMA,
    evidence_id: safeEvidenceRef(options.evidenceId || `acceptance:${randomUUID()}`, "evidenceId"),
    issued_at: issuedAt,
    issued_by: issuedBy,
    issuer: "server",
    model_type: "video",
    model_id: String(binding.id || "").trim(),
    binding_sha256: videoActivationBindingSha256V2(binding),
    fingerprint_version: 2,
    checks: {
      secret_resolution: passedCheck(checks.secretResolution, "secretResolution", issuedAt),
      endpoint_connectivity: passedCheck(checks.endpointConnectivity, "endpointConnectivity", issuedAt),
      protocol_fixture: passedCheck(checks.protocolFixture, "protocolFixture", issuedAt),
      canary: passedCheck(checks.canary, "canary", issuedAt),
      result_persistence: passedCheck(checks.resultPersistence, "resultPersistence", issuedAt),
    },
  };
}

export function persistVideoModelAcceptanceEvidence(
  persistedConfig: unknown,
  evidence: VideoModelAcceptanceEvidence,
): JsonRecord {
  assertServerOnly();
  const gate = readGate(persistedConfig);
  if (!gate) {
    throw new ModelActivationGateError(
      "MODEL_NOT_ACTIVATION_GATED",
      "旧模型不写入新接入激活证据，避免追溯改变现有行为",
      400,
    );
  }
  return {
    ...stripClientActivationGate(persistedConfig),
    [MODEL_ACTIVATION_GATE_KEY]: {
      ...gate,
      state: "evidence_ready",
      fingerprint_version: evidence.fingerprint_version,
      binding_sha256: evidence.binding_sha256,
      evidence,
    },
  };
}

function validatePersistedCheck(
  value: unknown,
  label: string,
): string | null {
  const check = record(value);
  const status = String(check.status || "");
  if (status !== "passed") {
    return `${label} 未通过`;
  }
  try {
    safeEvidenceRef(check.evidence_ref, `${label}.evidence_ref`);
    safeTimestamp(check.checked_at, `${label}.checked_at`, "");
  } catch (error) {
    return error instanceof Error ? error.message : `${label} 证据无效`;
  }
  return null;
}

export function inspectVideoModelActivationReadiness(binding: VideoActivationBinding): {
  gated: boolean;
  ready: boolean;
  reason: string;
  evidenceId?: string;
} {
  assertServerOnly();
  const gate = readGate(binding.api_protocol_config);
  if (!gate) return { gated: false, ready: true, reason: "legacy_model_not_retroactively_gated" };
  if (gate.state !== "evidence_ready") {
    return { gated: true, ready: false, reason: "acceptance_evidence_not_persisted" };
  }
  const evidence = record(gate.evidence);
  if (evidence.schema !== MODEL_ACCEPTANCE_EVIDENCE_SCHEMA
    || evidence.issuer !== "server"
    || evidence.model_type !== "video"
    || String(evidence.model_id || "") !== String(binding.id || "")) {
    return { gated: true, ready: false, reason: "acceptance_evidence_identity_invalid" };
  }
  try {
    safeEvidenceRef(evidence.evidence_id, "evidence_id");
    safeEvidenceRef(evidence.issued_by, "issued_by");
    safeTimestamp(evidence.issued_at, "issued_at", "");
  } catch {
    return { gated: true, ready: false, reason: "acceptance_evidence_metadata_invalid" };
  }
  const fingerprint = evidence.fingerprint_version === 2 ? videoActivationBindingSha256V2(binding) : videoActivationBindingSha256(binding);
  if (evidence.fingerprint_version === 2 && !videoBindingCredentialReady(binding)) return { gated: true, ready: false, reason: "acceptance_credential_unavailable" };
  if (String(evidence.binding_sha256 || "") !== fingerprint) {
    return { gated: true, ready: false, reason: "acceptance_evidence_binding_stale" };
  }
  const checks = record(evidence.checks);
  const failures = [
    validatePersistedCheck(checks.secret_resolution, "secret_resolution"),
    validatePersistedCheck(checks.endpoint_connectivity, "endpoint_connectivity"),
    validatePersistedCheck(checks.protocol_fixture, "protocol_fixture"),
    validatePersistedCheck(checks.canary, "canary"),
    validatePersistedCheck(checks.result_persistence, "result_persistence"),
  ].filter(Boolean);
  if (failures.length > 0) {
    return { gated: true, ready: false, reason: failures[0]! };
  }
  return {
    gated: true,
    ready: true,
    reason: "acceptance_evidence_complete",
    evidenceId: String(evidence.evidence_id),
  };
}

/**
 * Resolve the single server-side admission decision used by both the public
 * catalog and the paid submit route.  A model may stay visible while this
 * resolver keeps generation blocked until its current binding has a complete
 * acceptance receipt.  The optional verification notice is deliberately
 * reduced to a stable internal reason; provider or admin diagnostics never
 * need to cross the public API boundary.
 */
export function resolveVideoModelGenerationReadiness(
  binding: VideoActivationBinding,
  options: { verificationNotice?: unknown } = {},
): {
  gated: boolean;
  ready: boolean;
  generationReady: boolean;
  reason: string;
  acceptanceIssue: string;
  evidenceId?: string;
} {
  const activation = inspectVideoModelActivationReadiness(binding);
  let acceptanceIssue = "";
  let reason = activation.reason;
  if (activation.gated && (!activation.ready || !activation.evidenceId)) {
    acceptanceIssue = "该模型尚未完成协议、真实生成和结果交付验收，暂不可提交";
  } else {
    const notice = String(options.verificationNotice || "").replace(/\s+/gu, " ").trim();
    if (/尚未验收|未完成真实验收|暂不进入.*工作台|真实付费生成.*未|结果持久化.*未/u.test(notice)) {
      acceptanceIssue = "该模型尚未完成协议、真实生成和结果交付验收，暂不可提交";
      reason = "acceptance_verification_notice_incomplete";
    }
  }
  return {
    ...activation,
    generationReady: !acceptanceIssue,
    acceptanceIssue,
    reason,
  };
}

export function assertVideoModelActivationReady(binding: VideoActivationBinding): string {
  const readiness = inspectVideoModelActivationReadiness(binding);
  if (!readiness.gated) {
    throw new ModelActivationGateError(
      "LEGACY_MODEL_NOT_IN_NEW_ACTIVATION_CHANNEL",
      "既有模型不受新接入激活通道追溯控制，请使用原管理流程",
    );
  }
  if (!readiness.ready || !readiness.evidenceId) {
    throw new ModelActivationGateError(
      "MODEL_ACCEPTANCE_EVIDENCE_INCOMPLETE",
      `模型验收证据未齐全：${readiness.reason}`,
    );
  }
  return readiness.evidenceId;
}

export function assertOrdinaryAdminUpdateDoesNotActivate(
  kind: MediaModelKind,
  modelId: unknown,
  persistedVideoConfig: unknown,
  requestedFields: JsonRecord,
): void {
  // Evidence remains diagnostic; it cannot veto an explicit administrator
  // activation or silently change visibility.
  void kind;
  void modelId;
  void persistedVideoConfig;
  void requestedFields;
}

export function assertVisibleGatedVideoBindingStillAccepted(binding: VideoActivationBinding): void {
  if (!isActivationGatedVideoConfig(binding.api_protocol_config)) return;
  const remainsPublished = binding.is_active === true;
  if (!remainsPublished) return;
  const readiness = inspectVideoModelActivationReadiness(binding);
  if (!readiness.ready) {
    throw new ModelActivationGateError(
      "ACTIVE_MODEL_BINDING_CHANGE_REQUIRES_REVALIDATION",
      `已发布模型的协议绑定变更会使验收证据失效：${readiness.reason}；请先停用生成，再重新验收`,
    );
  }
}

export function imageActivationStorageUnavailable(): never {
  throw new ModelActivationGateError(
    "IMAGE_ACCEPTANCE_EVIDENCE_STORE_UNAVAILABLE",
    "当前 cover_models 表没有可安全持久化通用验收证据的字段；新生图模型保持停用和隐藏，禁止伪造激活",
  );
}

export function textActivationStorageUnavailable(): never {
  throw new ModelActivationGateError(
    "TEXT_ACCEPTANCE_EVIDENCE_STORE_UNAVAILABLE",
    "当前 llm_models 表没有可安全持久化通用验收证据的字段；新文案模型保持停用和隐藏，禁止伪造激活",
  );
}
