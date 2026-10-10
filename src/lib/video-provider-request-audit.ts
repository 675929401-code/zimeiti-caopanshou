import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";

export type VideoProviderRequestProjection = {
  effectivePromptSha256: string | null;
  duration: number | null;
  resolution: string | null;
  aspectRatio: string | null;
  referenceImageCount: number;
  referenceAudioCount: number;
  generateAudioState: "provided_true" | "provided_false" | "omitted";
};

export type VideoProviderRequestReceipt = {
  schemaVersion: 2;
  endpointHost: string;
  endpointPath: string;
  attemptOrdinal: number;
  dispatchIdentitySha256: string;
  submittedModel: string | null;
  submittedWorkflow: string | null;
  requestContentType: "application/json" | "multipart/form-data";
  wireBodySha256: string;
  wireBodyBytes: number;
  requestProjection: VideoProviderRequestProjection;
};

type Audit = (receipt: VideoProviderRequestReceipt) => Promise<void>;
type AuditContext = { audit: Audit; nextAttemptOrdinal: number; dispatchQueue: Promise<void> };
const audits = new AsyncLocalStorage<AuditContext>();
const MAX_WIRE_BODY_BYTES = 128 * 1024 * 1024;
const PROMPT_KEYS = new Set(["prompt", "textprompt", "prompttext", "description"]);
const DURATION_KEYS = new Set(["duration", "durationseconds", "videoduration", "lengthseconds", "seconds"]);
const RESOLUTION_KEYS = new Set(["resolution", "resolutiontier", "outputtier", "size"]);
const ASPECT_KEYS = new Set(["aspect", "aspectratio", "ratio"]);
const IMAGE_KEYS = new Set([
  "image", "imageurl", "imageurls", "images", "firstframe", "firstframeimage", "firstframeurl",
  "lastframe", "lastframeimage", "lastframeurl", "tailimage", "referenceimage", "referenceimageurl",
  "referenceimageurls", "referenceimages", "extraimages", "imagereferences",
]);
const AUDIO_KEYS = new Set([
  "audio", "audiourl", "audiourls", "audios", "referenceaudio", "referenceaudiourl",
  "referenceaudiourls", "referenceaudios", "extraaudios", "audioreferences",
]);

function sha256(value: Uint8Array | string) {
  return createHash("sha256").update(value).digest("hex");
}

function normalizedKey(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]/gu, "");
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function walk(value: unknown, visit: (key: string, value: unknown) => boolean | void, depth = 0): boolean {
  if (depth > 12 || !value || typeof value !== "object") return false;
  if (Array.isArray(value)) {
    for (const child of value.slice(0, 128)) if (walk(child, visit, depth + 1)) return true;
    return false;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>).slice(0, 256)) {
    if (visit(key, child) === true) return true;
    if (walk(child, visit, depth + 1)) return true;
  }
  return false;
}

function findValue(value: unknown, keys: Set<string>): unknown {
  let found: unknown;
  walk(value, (key, child) => {
    if (!keys.has(normalizedKey(key))) return false;
    found = child;
    return true;
  });
  return found;
}

function findEffectivePrompt(value: unknown): string | null {
  const direct = findValue(value, PROMPT_KEYS);
  if (typeof direct === "string" && direct.length > 0) return direct;
  let messageContent: string | null = null;
  walk(value, (key, child) => {
    if (normalizedKey(key) !== "messages" || !Array.isArray(child)) return false;
    for (const message of child) {
      const content = asRecord(message)?.content;
      if (typeof content === "string" && content.length > 0) {
        messageContent = content;
        return true;
      }
      if (Array.isArray(content)) {
        const textParts = content
          .map(part => asRecord(part))
          .filter((part): part is Record<string, unknown> => Boolean(part))
          .filter(part => normalizedKey(String(part.type || "")) === "text")
          .map(part => typeof part.text === "string" ? part.text : "")
          .filter(Boolean);
        if (textParts.length > 0) {
          messageContent = textParts.join("\n");
          return true;
        }
      }
    }
    return false;
  });
  return messageContent;
}

function safeScalar(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const normalized = String(value).trim();
  return /^[A-Za-z0-9][A-Za-z0-9._xX:-]{0,63}$/u.test(normalized) ? normalized : null;
}

function safeDuration(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 86_400 ? parsed : null;
}

function countReferenceValue(value: unknown): number {
  if (typeof value === "string") return value.trim() ? 1 : 0;
  if (typeof Blob !== "undefined" && value instanceof Blob) return 1;
  if (Array.isArray(value)) return value.slice(0, 128).reduce((sum, child) => sum + countReferenceValue(child), 0);
  const record = asRecord(value);
  if (!record) return 0;
  return [record.url, record.uri, record.data, record.file].some(child => typeof child === "string" && child.length > 0) ? 1 : 0;
}

function referenceCount(value: unknown, kind: "image" | "audio") {
  const keys = kind === "image" ? IMAGE_KEYS : AUDIO_KEYS;
  const dynamic = kind === "image" ? /^refimage\d+$/u : /^refaudio\d+$/u;
  let count = 0;
  walk(value, (key, child) => {
    const normalized = normalizedKey(key);
    if (keys.has(normalized) || dynamic.test(normalized)) count += countReferenceValue(child);
    if (normalized === "media" && Array.isArray(child)) {
      for (const entry of child.slice(0, 128)) {
        const media = asRecord(entry);
        const type = normalizedKey(String(media?.type || ""));
        const hasReference = typeof media?.url === "string" && media.url.trim().length > 0;
        if (!hasReference) continue;
        if (kind === "image" && (type === "image" || type.includes("frame") || type.includes("image"))) count += 1;
        if (kind === "audio" && type.includes("audio")) count += 1;
      }
    }
    return false;
  });
  return Math.min(count, 128);
}

function generateAudioState(value: unknown): VideoProviderRequestProjection["generateAudioState"] {
  const generated = findValue(value, new Set(["generateaudio"]));
  return generated === true ? "provided_true" : generated === false ? "provided_false" : "omitted";
}

function projectionFromObject(value: unknown): VideoProviderRequestProjection {
  const prompt = findEffectivePrompt(value);
  return {
    effectivePromptSha256: prompt === null ? null : sha256(prompt),
    duration: safeDuration(findValue(value, DURATION_KEYS)),
    resolution: safeScalar(findValue(value, RESOLUTION_KEYS)),
    aspectRatio: safeScalar(findValue(value, ASPECT_KEYS)),
    referenceImageCount: referenceCount(value, "image"),
    referenceAudioCount: referenceCount(value, "audio"),
    generateAudioState: generateAudioState(value),
  };
}

function projectionFromFormData(form: FormData): VideoProviderRequestProjection {
  const object: Record<string, unknown> = {};
  for (const [key, value] of form.entries()) {
    const current = object[key];
    object[key] = current === undefined ? value : Array.isArray(current) ? [...current, value] : [current, value];
  }
  const projection = projectionFromObject(object);
  for (const [key, value] of form.entries()) {
    if (!(value instanceof Blob)) continue;
    const normalized = normalizedKey(key);
    if (value.type.toLowerCase().startsWith("image/") && !IMAGE_KEYS.has(normalized)) projection.referenceImageCount += 1;
    if (value.type.toLowerCase().startsWith("audio/") && !AUDIO_KEYS.has(normalized)) projection.referenceAudioCount += 1;
  }
  projection.referenceImageCount = Math.min(projection.referenceImageCount, 128);
  projection.referenceAudioCount = Math.min(projection.referenceAudioCount, 128);
  return projection;
}

function normalizedContentType(value: string | null) {
  return String(value || "").split(";", 1)[0].trim().toLowerCase();
}

function safeId(value: unknown) {
  return typeof value === "string" && /^[\p{L}\p{N}_.:/ -]{1,160}$/u.test(value) && !value.includes("://") ? value : null;
}

export function withVideoProviderRequestAudit<T>(audit: Audit | undefined, work: () => Promise<T>): Promise<T> {
  return audit ? audits.run({ audit, nextAttemptOrdinal: 1, dispatchQueue: Promise.resolve() }, work) : work();
}

/** @deprecated Routing-only parser retained for diagnostics; never used as wire evidence. */
export function videoProviderRequestReceipt(input: string | URL | Request, init?: RequestInit): {
  endpointHost: string;
  submittedModel: string | null;
  submittedWorkflow: string | null;
} | null {
  const method = String(init?.method || (input instanceof Request ? input.method : "GET")).toUpperCase();
  if (method !== "POST") return null;
  let url: URL;
  try { url = new URL(input instanceof Request ? input.url : input.toString()); } catch { return null; }
  let body: Record<string, unknown> = {};
  if (typeof init?.body === "string") {
    try { body = asRecord(JSON.parse(init.body)) || {}; } catch { /* Diagnostics stay empty. */ }
  }
  const model = body.model ?? body.model_name
    ?? (url.hostname === "visual.volcengineapi.com" && ["RealmanChangeLipsSubmitTask", "CVSubmitTask"].includes(url.searchParams.get("Action") || "")
      ? body.req_key : undefined);
  return {
    endpointHost: url.host.toLowerCase(),
    submittedModel: safeId(model),
    submittedWorkflow: safeId(url.pathname.match(/\/comfyui\/comfyui_workflow\/([a-zA-Z0-9_]+)\/?$/u)?.[1]),
  };
}

/**
 * Builds the exact Request that will be sent, hashes a clone of its serialized
 * body, and records only an allowlisted projection. Unsupported body encodings
 * fail before the durable barrier and before any provider network call.
 */
export async function prepareVideoProviderRequest(
  input: string | URL | Request,
  init?: RequestInit,
  attemptOrdinal = 1,
): Promise<{ request: Request; receipt: VideoProviderRequestReceipt } | null> {
  const method = String(init?.method || (input instanceof Request ? input.method : "GET")).toUpperCase();
  if (method !== "POST") return null;
  const request = new Request(input, init);
  const url = new URL(request.url);
  const contentType = normalizedContentType(request.headers.get("content-type"));
  if (contentType !== "application/json" && contentType !== "multipart/form-data") {
    throw new Error("VIDEO_PROVIDER_REQUEST_CONTENT_TYPE_UNSUPPORTED");
  }
  const wireBytes = new Uint8Array(await request.clone().arrayBuffer());
  if (wireBytes.byteLength < 1 || wireBytes.byteLength > MAX_WIRE_BODY_BYTES) {
    throw new Error("VIDEO_PROVIDER_REQUEST_BODY_SIZE_INVALID");
  }

  let decoded: unknown;
  if (contentType === "application/json") {
    try {
      decoded = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(wireBytes));
    } catch {
      throw new Error("VIDEO_PROVIDER_REQUEST_JSON_INVALID");
    }
  } else {
    try {
      decoded = await request.clone().formData();
    } catch {
      throw new Error("VIDEO_PROVIDER_REQUEST_MULTIPART_UNAVAILABLE");
    }
  }
  const projection = decoded instanceof FormData ? projectionFromFormData(decoded) : projectionFromObject(decoded);
  const decodedRecord = decoded instanceof FormData ? Object.fromEntries(decoded.entries()) : asRecord(decoded) || {};
  const model = decoded instanceof FormData
    ? decoded.get("model") || decoded.get("model_name")
    : decodedRecord.model ?? decodedRecord.model_name
      ?? (url.hostname === "visual.volcengineapi.com" && ["RealmanChangeLipsSubmitTask", "CVSubmitTask"].includes(url.searchParams.get("Action") || "")
        ? decodedRecord.req_key : undefined);
  const endpointHost = url.host.toLowerCase();
  const endpointPath = url.pathname || "/";
  const wireBodySha256 = sha256(wireBytes);
  const dispatchIdentitySha256 = sha256(
    `video-provider-dispatch-v2\n${endpointHost}\n${endpointPath}\n${attemptOrdinal}\n${wireBodySha256}`,
  );
  return {
    request,
    receipt: {
      schemaVersion: 2,
      endpointHost,
      endpointPath,
      attemptOrdinal,
      dispatchIdentitySha256,
      submittedModel: safeId(model),
      submittedWorkflow: safeId(url.pathname.match(/\/comfyui\/comfyui_workflow\/([a-zA-Z0-9_]+)\/?$/u)?.[1]),
      requestContentType: contentType,
      wireBodySha256,
      wireBodyBytes: wireBytes.byteLength,
      requestProjection: projection,
    },
  };
}

export async function videoProviderFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const context = audits.getStore();
  if (!context) return globalThis.fetch(input, init);
  // Enqueue at invocation time so concurrent multipart preparation cannot let
  // a later request persist ordinal 2 before ordinal 1. The queue covers body
  // preparation, the durable barrier, and starting fetch, but not waiting for
  // the provider response; distinct uploads can still be in flight together.
  const dispatchTurn = context.dispatchQueue.then(async () => {
    const attemptOrdinal = context.nextAttemptOrdinal++;
    const prepared = await prepareVideoProviderRequest(input, init, attemptOrdinal);
    if (!prepared) return { response: globalThis.fetch(input, init) };
    // This callback is the durable before-dispatch barrier. Its failure must
    // leave providerCalls=0; the provider Request is sent exactly once afterward.
    await context.audit(prepared.receipt);
    return { response: globalThis.fetch(prepared.request) };
  });
  context.dispatchQueue = dispatchTurn.then(() => undefined, () => undefined);
  return (await dispatchTurn).response;
}
