import { createHash, randomUUID } from "node:crypto";

export const IMAGE_PROVIDER_PROTOCOLS = [
  "google_generate_content",
  "chat_completions",
  "images_generations",
  "images_generations_async",
  "images_edits",
  "cover_workflow",
] as const;

export type ImageProviderProtocol = (typeof IMAGE_PROVIDER_PROTOCOLS)[number];

export type ImageProviderRequestProjection = {
  userPromptSha256: string;
  effectivePromptSha256: string;
  modelIdSha256: string;
  aspectRatio: string;
  resolution: string;
  imageCount: 1;
  referenceCount: number;
};

export type ImageProviderDispatchReceipt = {
  schema: "image_provider_dispatch_receipt.v1";
  receiptId: string;
  receiptSha256: string;
  recordedAt: string;
  providerProtocol: ImageProviderProtocol;
  endpointOriginSha256: string;
  requestContentType: "application/json" | "multipart/form-data";
  actualPayloadSha256: string;
  actualPayloadBytes: number;
  idempotencyKeySha256?: string;
  requestProjection: ImageProviderRequestProjection;
};

export type ImageProviderSubmissionReceipt = {
  schema: "image_provider_submission_receipt.v1";
  receiptId: string;
  receiptSha256: string;
  dispatchReceiptSha256: string;
  recordedAt: string;
  providerProtocol: ImageProviderProtocol;
  transportState: "response_received" | "transport_error" | "response_body_error";
  responseStatus?: number;
  responseContentType?: string;
  responseBodySha256?: string;
  responseBodyBytes: number;
  providerAcknowledgementSha256?: string;
  providerAcknowledgementField?: "request_id" | "task_id" | "job_id" | "id";
};

export type PreparedImageProviderRequest = {
  request: Request;
  receipt: ImageProviderDispatchReceipt;
};

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const RECEIPT_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/u;
const RECORDED_AT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const RESPONSE_CONTENT_TYPE_PATTERN = /^[a-z0-9.+-]{1,64}\/[a-z0-9.+-]{1,64}$/u;

function sha256(value: string | Uint8Array) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalField(name: string, value: string | number | undefined) {
  return `${name}=${value === undefined ? "" : String(value)}`;
}

export function imageProviderDispatchReceiptHash(receipt: Omit<ImageProviderDispatchReceipt, "receiptSha256">) {
  return sha256([
    canonicalField("schema", receipt.schema),
    canonicalField("receiptId", receipt.receiptId),
    canonicalField("recordedAt", receipt.recordedAt),
    canonicalField("providerProtocol", receipt.providerProtocol),
    canonicalField("endpointOriginSha256", receipt.endpointOriginSha256),
    canonicalField("requestContentType", receipt.requestContentType),
    canonicalField("actualPayloadSha256", receipt.actualPayloadSha256),
    canonicalField("actualPayloadBytes", receipt.actualPayloadBytes),
    canonicalField("idempotencyKeySha256", receipt.idempotencyKeySha256),
    canonicalField("requestProjection.userPromptSha256", receipt.requestProjection.userPromptSha256),
    canonicalField("requestProjection.effectivePromptSha256", receipt.requestProjection.effectivePromptSha256),
    canonicalField("requestProjection.modelIdSha256", receipt.requestProjection.modelIdSha256),
    canonicalField("requestProjection.aspectRatio", receipt.requestProjection.aspectRatio),
    canonicalField("requestProjection.resolution", receipt.requestProjection.resolution),
    canonicalField("requestProjection.imageCount", receipt.requestProjection.imageCount),
    canonicalField("requestProjection.referenceCount", receipt.requestProjection.referenceCount),
  ].join("\n"));
}

export function imageProviderSubmissionReceiptHash(receipt: Omit<ImageProviderSubmissionReceipt, "receiptSha256">) {
  return sha256([
    canonicalField("schema", receipt.schema),
    canonicalField("receiptId", receipt.receiptId),
    canonicalField("dispatchReceiptSha256", receipt.dispatchReceiptSha256),
    canonicalField("recordedAt", receipt.recordedAt),
    canonicalField("providerProtocol", receipt.providerProtocol),
    canonicalField("transportState", receipt.transportState),
    canonicalField("responseStatus", receipt.responseStatus),
    canonicalField("responseContentType", receipt.responseContentType),
    canonicalField("responseBodySha256", receipt.responseBodySha256),
    canonicalField("responseBodyBytes", receipt.responseBodyBytes),
    canonicalField("providerAcknowledgementSha256", receipt.providerAcknowledgementSha256),
    canonicalField("providerAcknowledgementField", receipt.providerAcknowledgementField),
  ].join("\n"));
}

function hasExactKeys(value: object, allowed: readonly string[]) {
  const keys = Object.keys(value).sort();
  return keys.length === allowed.length && keys.every((key, index) => key === [...allowed].sort()[index]);
}

function safeOrigin(url: string) {
  const parsed = new URL(url);
  if (!/^https?:$/u.test(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error("IMAGE_PROVIDER_RECEIPT_ENDPOINT_INVALID");
  }
  return parsed.origin.toLowerCase();
}

function normalizeContentType(value: string | null) {
  return String(value || "").split(";", 1)[0].trim().toLowerCase().slice(0, 100);
}

function dispatchContentType(value: string | null): ImageProviderDispatchReceipt["requestContentType"] {
  const normalized = normalizeContentType(value);
  if (normalized === "application/json") return "application/json";
  if (normalized === "multipart/form-data") return "multipart/form-data";
  throw new Error("IMAGE_PROVIDER_RECEIPT_CONTENT_TYPE_UNSUPPORTED");
}

function validateProjection(value: ImageProviderRequestProjection) {
  if (!SHA256_PATTERN.test(value.userPromptSha256)
    || !SHA256_PATTERN.test(value.effectivePromptSha256)
    || !SHA256_PATTERN.test(value.modelIdSha256)
    || !/^\d{1,3}:\d{1,3}$/u.test(value.aspectRatio)
    || !["0.5K", "1K", "2K", "3K", "4K"].includes(value.resolution)
    || value.imageCount !== 1
    || !Number.isInteger(value.referenceCount)
    || value.referenceCount < 0
    || value.referenceCount > 9) {
    throw new Error("IMAGE_PROVIDER_RECEIPT_PROJECTION_INVALID");
  }
}

export async function prepareImageProviderRequest(input: {
  url: string;
  init: RequestInit;
  providerProtocol: ImageProviderProtocol;
  projection: ImageProviderRequestProjection;
  idempotencyKey?: string;
}): Promise<PreparedImageProviderRequest> {
  validateProjection(input.projection);
  const request = new Request(input.url, input.init);
  const wireBytes = new Uint8Array(await request.clone().arrayBuffer());
  if (wireBytes.byteLength < 1 || wireBytes.byteLength > 50 * 1024 * 1024) {
    throw new Error("IMAGE_PROVIDER_RECEIPT_PAYLOAD_SIZE_INVALID");
  }
  const base = {
    schema: "image_provider_dispatch_receipt.v1" as const,
    receiptId: randomUUID(),
    recordedAt: new Date().toISOString(),
    providerProtocol: input.providerProtocol,
    endpointOriginSha256: sha256(safeOrigin(input.url)),
    requestContentType: dispatchContentType(request.headers.get("content-type")),
    actualPayloadSha256: sha256(wireBytes),
    actualPayloadBytes: wireBytes.byteLength,
    ...(input.idempotencyKey ? { idempotencyKeySha256: sha256(input.idempotencyKey) } : {}),
    requestProjection: input.projection,
  };
  return { request, receipt: { ...base, receiptSha256: imageProviderDispatchReceiptHash(base) } };
}

function acknowledgementProjection(rawBytes: Uint8Array) {
  if (rawBytes.byteLength === 0 || rawBytes.byteLength > 8 * 1024 * 1024) return {};
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(rawBytes); } catch { return {}; }
  const candidates: unknown[] = [];
  try { candidates.push(JSON.parse(text)); } catch {
    for (const line of text.split(/\r?\n/u)) {
      const match = line.match(/^data:\s*(\{.*\})\s*$/u);
      if (!match) continue;
      try { candidates.push(JSON.parse(match[1])); } catch { /* Ignore malformed SSE frames. */ }
    }
  }
  const fields = ["request_id", "task_id", "job_id", "id"] as const;
  const visit = (value: unknown, depth = 0): { field: (typeof fields)[number]; value: string } | null => {
    if (!value || typeof value !== "object" || depth > 5) return null;
    if (Array.isArray(value)) {
      for (const child of value.slice(0, 20)) {
        const found = visit(child, depth + 1);
        if (found) return found;
      }
      return null;
    }
    const object = value as Record<string, unknown>;
    for (const field of fields) {
      const candidate = object[field];
      if ((typeof candidate === "string" || typeof candidate === "number") && String(candidate).length > 0) {
        return { field, value: String(candidate).slice(0, 512) };
      }
    }
    for (const child of Object.values(object).slice(0, 40)) {
      const found = visit(child, depth + 1);
      if (found) return found;
    }
    return null;
  };
  for (const candidate of candidates) {
    const found = visit(candidate);
    if (found) return {
      providerAcknowledgementSha256: sha256(found.value),
      providerAcknowledgementField: found.field,
    };
  }
  return {};
}

export function createImageProviderSubmissionReceipt(input: {
  dispatchReceipt: ImageProviderDispatchReceipt;
  transportState: ImageProviderSubmissionReceipt["transportState"];
  responseStatus?: number;
  responseContentType?: string | null;
  responseBody?: Uint8Array;
}): ImageProviderSubmissionReceipt {
  const rawBytes = input.responseBody || new Uint8Array();
  const status = input.responseStatus;
  if (status !== undefined && (!Number.isInteger(status) || status < 100 || status > 599)) {
    throw new Error("IMAGE_PROVIDER_RECEIPT_STATUS_INVALID");
  }
  const base = {
    schema: "image_provider_submission_receipt.v1" as const,
    receiptId: randomUUID(),
    dispatchReceiptSha256: input.dispatchReceipt.receiptSha256,
    recordedAt: new Date().toISOString(),
    providerProtocol: input.dispatchReceipt.providerProtocol,
    transportState: input.transportState,
    ...(status !== undefined ? { responseStatus: status } : {}),
    ...(input.responseContentType ? { responseContentType: normalizeContentType(input.responseContentType) } : {}),
    ...(rawBytes.byteLength > 0 ? { responseBodySha256: sha256(rawBytes) } : {}),
    responseBodyBytes: rawBytes.byteLength,
    ...acknowledgementProjection(rawBytes),
  };
  return { ...base, receiptSha256: imageProviderSubmissionReceiptHash(base) };
}

export function assertImageProviderDispatchReceipt(value: unknown): asserts value is ImageProviderDispatchReceipt {
  const receipt = value as Partial<ImageProviderDispatchReceipt> | null;
  if (!receipt || receipt.schema !== "image_provider_dispatch_receipt.v1"
    || !hasExactKeys(receipt, [
      "schema", "receiptId", "receiptSha256", "recordedAt", "providerProtocol", "endpointOriginSha256",
      "requestContentType", "actualPayloadSha256", "actualPayloadBytes", "requestProjection",
      ...(receipt.idempotencyKeySha256 === undefined ? [] : ["idempotencyKeySha256"]),
    ])
    || !RECEIPT_ID_PATTERN.test(String(receipt.receiptId || ""))
    || !SHA256_PATTERN.test(String(receipt.receiptSha256 || ""))
    || !RECORDED_AT_PATTERN.test(String(receipt.recordedAt || ""))
    || !SHA256_PATTERN.test(String(receipt.actualPayloadSha256 || ""))
    || !SHA256_PATTERN.test(String(receipt.endpointOriginSha256 || ""))
    || !["application/json", "multipart/form-data"].includes(String(receipt.requestContentType || ""))
    || (receipt.idempotencyKeySha256 !== undefined && !SHA256_PATTERN.test(String(receipt.idempotencyKeySha256)))
    || !IMAGE_PROVIDER_PROTOCOLS.includes(receipt.providerProtocol as ImageProviderProtocol)
    || !Number.isInteger(receipt.actualPayloadBytes) || Number(receipt.actualPayloadBytes) < 1
    || Number(receipt.actualPayloadBytes) > 50 * 1024 * 1024
    || !receipt.requestProjection) throw new Error("IMAGE_PROVIDER_DISPATCH_RECEIPT_INVALID");
  if (!hasExactKeys(receipt.requestProjection, [
    "userPromptSha256", "effectivePromptSha256", "modelIdSha256", "aspectRatio",
    "resolution", "imageCount", "referenceCount",
  ])) throw new Error("IMAGE_PROVIDER_DISPATCH_RECEIPT_INVALID");
  validateProjection(receipt.requestProjection);
  const { receiptSha256, ...core } = receipt as ImageProviderDispatchReceipt;
  if (receiptSha256 !== imageProviderDispatchReceiptHash(core)) {
    throw new Error("IMAGE_PROVIDER_DISPATCH_RECEIPT_HASH_INVALID");
  }
}

export function assertImageProviderSubmissionReceipt(value: unknown): asserts value is ImageProviderSubmissionReceipt {
  const receipt = value as Partial<ImageProviderSubmissionReceipt> | null;
  if (!receipt || receipt.schema !== "image_provider_submission_receipt.v1"
    || !hasExactKeys(receipt, [
      "schema", "receiptId", "receiptSha256", "dispatchReceiptSha256", "recordedAt", "providerProtocol",
      "transportState", "responseBodyBytes",
      ...(receipt.responseStatus === undefined ? [] : ["responseStatus"]),
      ...(receipt.responseContentType === undefined ? [] : ["responseContentType"]),
      ...(receipt.responseBodySha256 === undefined ? [] : ["responseBodySha256"]),
      ...(receipt.providerAcknowledgementSha256 === undefined ? [] : ["providerAcknowledgementSha256"]),
      ...(receipt.providerAcknowledgementField === undefined ? [] : ["providerAcknowledgementField"]),
    ])
    || !RECEIPT_ID_PATTERN.test(String(receipt.receiptId || ""))
    || !SHA256_PATTERN.test(String(receipt.receiptSha256 || ""))
    || !SHA256_PATTERN.test(String(receipt.dispatchReceiptSha256 || ""))
    || !RECORDED_AT_PATTERN.test(String(receipt.recordedAt || ""))
    || !IMAGE_PROVIDER_PROTOCOLS.includes(receipt.providerProtocol as ImageProviderProtocol)
    || !["response_received", "transport_error", "response_body_error"].includes(String(receipt.transportState || ""))
    || !Number.isInteger(receipt.responseBodyBytes) || Number(receipt.responseBodyBytes) < 0
    || Number(receipt.responseBodyBytes) > 40 * 1024 * 1024
    || (receipt.responseStatus !== undefined && (!Number.isInteger(receipt.responseStatus)
      || Number(receipt.responseStatus) < 100 || Number(receipt.responseStatus) > 599))
    || (receipt.responseContentType !== undefined && !RESPONSE_CONTENT_TYPE_PATTERN.test(receipt.responseContentType))
    || (receipt.responseBodySha256 !== undefined && !SHA256_PATTERN.test(receipt.responseBodySha256))
    || ((Number(receipt.responseBodyBytes) > 0) !== Boolean(receipt.responseBodySha256))
    || (receipt.providerAcknowledgementSha256 !== undefined && !SHA256_PATTERN.test(receipt.providerAcknowledgementSha256))
    || (receipt.providerAcknowledgementField !== undefined
      && !["request_id", "task_id", "job_id", "id"].includes(receipt.providerAcknowledgementField))
    || (Boolean(receipt.providerAcknowledgementSha256) !== Boolean(receipt.providerAcknowledgementField))
    || (receipt.transportState === "response_received" && receipt.responseStatus === undefined)
    || (receipt.transportState === "transport_error" && receipt.responseStatus !== undefined)) {
    throw new Error("IMAGE_PROVIDER_SUBMISSION_RECEIPT_INVALID");
  }
  const { receiptSha256, ...core } = receipt as ImageProviderSubmissionReceipt;
  if (receiptSha256 !== imageProviderSubmissionReceiptHash(core)) {
    throw new Error("IMAGE_PROVIDER_SUBMISSION_RECEIPT_HASH_INVALID");
  }
}

export function imageProviderEvidenceProjection(record: {
  providerDispatchReceipt?: ImageProviderDispatchReceipt;
  providerSubmissionReceipt?: ImageProviderSubmissionReceipt;
}) {
  const dispatch = record.providerDispatchReceipt;
  const submission = record.providerSubmissionReceipt;
  if (!dispatch) return { ready: false, dispatchRecorded: false, submissionRecorded: false };
  assertImageProviderDispatchReceipt(dispatch);
  if (submission) assertImageProviderSubmissionReceipt(submission);
  return {
    ready: Boolean(submission),
    dispatchRecorded: true,
    submissionRecorded: Boolean(submission),
    providerProtocol: dispatch.providerProtocol,
    dispatchReceiptId: dispatch.receiptId,
    dispatchReceiptSha256: dispatch.receiptSha256,
    actualPayloadSha256: dispatch.actualPayloadSha256,
    actualPayloadBytes: dispatch.actualPayloadBytes,
    requestContentType: dispatch.requestContentType,
    requestProjection: dispatch.requestProjection,
    ...(submission ? {
      submissionReceiptId: submission.receiptId,
      submissionReceiptSha256: submission.receiptSha256,
      transportState: submission.transportState,
      responseStatus: submission.responseStatus,
      responseBodySha256: submission.responseBodySha256,
      responseBodyBytes: submission.responseBodyBytes,
      providerAcknowledgementSha256: submission.providerAcknowledgementSha256,
      providerAcknowledgementField: submission.providerAcknowledgementField,
    } : {}),
  };
}
