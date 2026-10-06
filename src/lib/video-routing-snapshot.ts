import { createHash } from "node:crypto";

import type { VideoModelConfig, VideoSubmissionReceiptEvidence } from "@/lib/video-adapter";
import type { VideoProviderRequestReceipt } from "@/lib/video-provider-request-audit";

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };

export type VideoRoutingSnapshot = {
  schemaVersion: 1;
  modelId: string;
  displayName: string;
  provider: string;
  apiEndpoint: string;
  protocolType: string;
  modelName: string;
  apiProtocolConfig: JsonObject;
  durationSeconds: number;
  supportsImageInput: boolean;
  credentialRef: string;
  configVersion: string;
};

type RpcClient = {
  rpc: (name: string, params: Record<string, unknown>) => PromiseLike<{
    data?: unknown;
    error?: unknown;
  }>;
};

const DIRECT_SECRET_KEYS = new Set([
  "key", "apikey", "xapikey", "authorization", "proxyauthorization", "auth", "token",
  "accesstoken", "refreshtoken", "secret", "clientsecret", "secretkey", "accesskey",
  "accesskeyid", "password", "cookie", "setcookie", "credential", "credentials",
  "signature", "signingkey", "privatekey",
]);
const SAFE_MODEL_ID = /^[A-Za-z0-9._:-]{1,160}$/u;
const SAFE_CREDENTIAL_REFERENCE = /^(?:secret:\/\/[a-z0-9][a-z0-9._-]{0,127}|env:\/\/[A-Z][A-Z0-9_]{1,127}|video-model:\/\/[A-Za-z0-9._:-]{1,160}\/api-key)$/u;
const SAFE_SHA256 = /^[0-9a-f]{64}$/u;
const MAX_CONFIG_BYTES = 32 * 1024;
const MAX_RECEIPT_BYTES = 8 * 1024;

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function requiredText(value: unknown, code: string, maximum = 2048) {
  const result = String(value || "").trim();
  if (!result || result.length > maximum || /[\r\n\u0000]/u.test(result)) throw new Error(code);
  return result;
}

function isDirectSecretKey(value: string) {
  const normalized = value.toLowerCase().replace(/[^a-z0-9]/gu, "");
  return DIRECT_SECRET_KEYS.has(normalized)
    || normalized.endsWith("apikey")
    || normalized.endsWith("secretkey")
    || normalized.endsWith("privatekey")
    || normalized.endsWith("password")
    || normalized.endsWith("token");
}

function normalizeEndpoint(value: unknown) {
  const endpoint = requiredText(value, "VIDEO_ROUTING_ENDPOINT_INVALID");
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new Error("VIDEO_ROUTING_ENDPOINT_INVALID");
  }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error("VIDEO_ROUTING_ENDPOINT_INVALID");
  }
  for (const key of parsed.searchParams.keys()) {
    if (isDirectSecretKey(key)) throw new Error("VIDEO_ROUTING_ENDPOINT_CONTAINS_SECRET");
  }
  parsed.hash = "";
  return parsed.toString();
}

function toSafeJson(value: unknown, depth = 0): JsonValue | undefined {
  if (depth > 12) throw new Error("VIDEO_ROUTING_CONFIG_TOO_DEEP");
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (Array.isArray(value)) {
    return value.map((item) => toSafeJson(item, depth + 1)).filter((item): item is JsonValue => item !== undefined);
  }
  if (!value || typeof value !== "object") return undefined;
  const result: JsonObject = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right))) {
    if (isDirectSecretKey(key)) continue;
    const normalized = toSafeJson(item, depth + 1);
    if (normalized !== undefined) result[key] = normalized;
  }
  return result;
}

function stableJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
}

function sha256(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function modelCredentialReference(modelId: string, configured: unknown) {
  const value = String(configured || "").trim();
  if (/^(?:secret:\/\/|env:\/\/)/u.test(value)) {
    if (!SAFE_CREDENTIAL_REFERENCE.test(value)) throw new Error("VIDEO_ROUTING_CREDENTIAL_REFERENCE_INVALID");
    return value;
  }
  return `video-model://${modelId}/api-key`;
}

function snapshotWithoutVersion(snapshot: Omit<VideoRoutingSnapshot, "configVersion">): JsonObject {
  return snapshot as unknown as JsonObject;
}

/**
 * Captures only provider routing data. The resolved API secret is intentionally
 * absent; legacy inline credentials are represented by a model-row reference.
 */
export function buildVideoRoutingSnapshot(model: Record<string, unknown>): VideoRoutingSnapshot {
  const modelId = requiredText(model.id, "VIDEO_ROUTING_MODEL_ID_INVALID", 160);
  if (!SAFE_MODEL_ID.test(modelId)) throw new Error("VIDEO_ROUTING_MODEL_ID_INVALID");
  const apiProtocolConfig = (toSafeJson(model.api_protocol_config) || {}) as JsonObject;
  if (Buffer.byteLength(stableJson(apiProtocolConfig), "utf8") > MAX_CONFIG_BYTES) {
    throw new Error("VIDEO_ROUTING_CONFIG_TOO_LARGE");
  }
  const base: Omit<VideoRoutingSnapshot, "configVersion"> = {
    schemaVersion: 1,
    modelId,
    displayName: requiredText(model.name || model.model_name || modelId, "VIDEO_ROUTING_DISPLAY_NAME_INVALID", 240),
    provider: requiredText(model.provider, "VIDEO_ROUTING_PROVIDER_INVALID", 160),
    apiEndpoint: normalizeEndpoint(model.api_endpoint),
    protocolType: requiredText(model.protocol_type || "openai_compatible", "VIDEO_ROUTING_PROTOCOL_INVALID", 160),
    modelName: requiredText(model.model_name || modelId, "VIDEO_ROUTING_MODEL_NAME_INVALID", 240),
    apiProtocolConfig,
    durationSeconds: Math.max(1, Number(model.duration_seconds) || 5),
    supportsImageInput: model.supports_image_input === true,
    credentialRef: modelCredentialReference(modelId, model.api_key),
  };
  return { ...base, configVersion: sha256(stableJson(snapshotWithoutVersion(base))) };
}

export function parseVideoRoutingSnapshot(value: unknown, expectedModelId?: string): VideoRoutingSnapshot {
  const object = asObject(value);
  if (Number(object.schemaVersion) !== 1) throw new Error("VIDEO_ROUTING_SNAPSHOT_VERSION_UNSUPPORTED");
  const base: Omit<VideoRoutingSnapshot, "configVersion"> = {
    schemaVersion: 1,
    modelId: requiredText(object.modelId, "VIDEO_ROUTING_MODEL_ID_INVALID", 160),
    displayName: requiredText(object.displayName, "VIDEO_ROUTING_DISPLAY_NAME_INVALID", 240),
    provider: requiredText(object.provider, "VIDEO_ROUTING_PROVIDER_INVALID", 160),
    apiEndpoint: normalizeEndpoint(object.apiEndpoint),
    protocolType: requiredText(object.protocolType, "VIDEO_ROUTING_PROTOCOL_INVALID", 160),
    modelName: requiredText(object.modelName, "VIDEO_ROUTING_MODEL_NAME_INVALID", 240),
    apiProtocolConfig: (toSafeJson(object.apiProtocolConfig) || {}) as JsonObject,
    durationSeconds: Math.max(1, Number(object.durationSeconds) || 5),
    supportsImageInput: object.supportsImageInput === true,
    credentialRef: requiredText(object.credentialRef, "VIDEO_ROUTING_CREDENTIAL_REFERENCE_INVALID", 240),
  };
  if (!SAFE_MODEL_ID.test(base.modelId) || (expectedModelId && base.modelId !== expectedModelId)) {
    throw new Error("VIDEO_ROUTING_MODEL_ID_MISMATCH");
  }
  if (!SAFE_CREDENTIAL_REFERENCE.test(base.credentialRef)) throw new Error("VIDEO_ROUTING_CREDENTIAL_REFERENCE_INVALID");
  if (Buffer.byteLength(stableJson(base.apiProtocolConfig), "utf8") > MAX_CONFIG_BYTES) {
    throw new Error("VIDEO_ROUTING_CONFIG_TOO_LARGE");
  }
  const expectedVersion = sha256(stableJson(snapshotWithoutVersion(base)));
  const storedVersion = requiredText(object.configVersion, "VIDEO_ROUTING_CONFIG_VERSION_INVALID", 64).toLowerCase();
  if (!SAFE_SHA256.test(storedVersion) || storedVersion !== expectedVersion) {
    throw new Error("VIDEO_ROUTING_CONFIG_VERSION_MISMATCH");
  }
  return { ...base, configVersion: storedVersion };
}

export function videoModelConfigFromRoutingSnapshot(
  snapshot: VideoRoutingSnapshot,
  providerApiKey: string,
): VideoModelConfig {
  return {
    id: snapshot.modelId,
    name: snapshot.displayName,
    provider: snapshot.provider,
    api_endpoint: snapshot.apiEndpoint,
    api_key: requiredText(providerApiKey, "VIDEO_ROUTING_CREDENTIAL_UNAVAILABLE", 16_384),
    protocol_type: snapshot.protocolType,
    price_per_use: 0,
    duration_seconds: snapshot.durationSeconds,
    supports_image_input: snapshot.supportsImageInput,
    model_name: snapshot.modelName,
    api_protocol_config: snapshot.apiProtocolConfig,
  };
}

export async function resolveVideoRoutingCredential(input: {
  snapshot: VideoRoutingSnapshot;
  resolveSecret: (reference: unknown) => string;
  lookupModelCredential: (modelId: string) => Promise<unknown>;
}) {
  const reference = input.snapshot.credentialRef;
  if (reference.startsWith("video-model://")) {
    const match = reference.match(/^video-model:\/\/([A-Za-z0-9._:-]{1,160})\/api-key$/u);
    if (!match || match[1] !== input.snapshot.modelId) throw new Error("VIDEO_ROUTING_CREDENTIAL_REFERENCE_INVALID");
    return input.resolveSecret(await input.lookupModelCredential(match[1]));
  }
  return input.resolveSecret(reference);
}

function normalizeDispatchReceipt(snapshot: VideoRoutingSnapshot, receipt: VideoProviderRequestReceipt): JsonObject {
  const endpointHost = requiredText(receipt.endpointHost, "VIDEO_PROVIDER_DISPATCH_RECEIPT_INVALID", 255).toLowerCase();
  if (endpointHost !== new URL(snapshot.apiEndpoint).host.toLowerCase()) {
    throw new Error("VIDEO_PROVIDER_DISPATCH_ROUTE_MISMATCH");
  }
  const safeId = (value: unknown): string | null => {
    if (value === null || value === undefined || value === "") return null;
    const normalized = requiredText(value, "VIDEO_PROVIDER_DISPATCH_RECEIPT_INVALID", 160);
    if (normalized.includes("://")) throw new Error("VIDEO_PROVIDER_DISPATCH_RECEIPT_INVALID");
    return normalized;
  };
  return {
    schemaVersion: 1,
    endpointHost,
    submittedModel: safeId(receipt.submittedModel),
    submittedWorkflow: safeId(receipt.submittedWorkflow),
    routingConfigVersion: snapshot.configVersion,
  };
}

function normalizeSubmissionReceipt(value: VideoSubmissionReceiptEvidence | Record<string, unknown> | undefined): JsonObject {
  const normalized = (toSafeJson(value || { schemaVersion: 1, receiptState: "adapter_exception" }) || {}) as JsonObject;
  normalized.schemaVersion = 1;
  const serialized = stableJson(normalized);
  if (Buffer.byteLength(serialized, "utf8") > MAX_RECEIPT_BYTES) throw new Error("VIDEO_PROVIDER_SUBMISSION_RECEIPT_TOO_LARGE");
  return normalized;
}

function rpcFailure(error: unknown, fallback: string) {
  const object = asObject(error);
  const detail = `${String(object.message || "")} ${String(object.details || "")} ${String(object.hint || "")}`.trim();
  return new Error(detail ? `${fallback}:${detail.slice(0, 320)}` : fallback);
}

/** Must complete before the audited provider fetch is allowed to start. */
export async function persistVideoProviderDispatchReceipt(input: {
  db: RpcClient;
  taskIdInternal: string;
  userId: string;
  requestFingerprint: string;
  snapshot: VideoRoutingSnapshot;
  receipt: VideoProviderRequestReceipt;
}) {
  const { data, error } = await input.db.rpc("record_video_provider_dispatch_receipt_atomic", {
    p_task_id: input.taskIdInternal,
    p_user_id: input.userId,
    p_request_fingerprint: input.requestFingerprint,
    p_receipt: normalizeDispatchReceipt(input.snapshot, input.receipt),
  });
  if (error) throw rpcFailure(error, "VIDEO_PROVIDER_DISPATCH_RECEIPT_PERSIST_FAILED");
  return asObject(data);
}

export async function persistVideoProviderSubmissionReceipt(input: {
  db: RpcClient;
  taskIdInternal: string;
  userId: string;
  requestFingerprint: string;
  outcome: "unknown" | "acknowledged";
  providerTaskId?: string;
  receipt?: VideoSubmissionReceiptEvidence | Record<string, unknown>;
}) {
  const { data, error } = await input.db.rpc("record_video_provider_submission_receipt_atomic", {
    p_task_id: input.taskIdInternal,
    p_user_id: input.userId,
    p_request_fingerprint: input.requestFingerprint,
    p_outcome: input.outcome,
    p_provider_task_id: input.providerTaskId || null,
    p_receipt: normalizeSubmissionReceipt(input.receipt),
  });
  if (error) throw rpcFailure(error, "VIDEO_PROVIDER_SUBMISSION_RECEIPT_PERSIST_FAILED");
  return asObject(data);
}
