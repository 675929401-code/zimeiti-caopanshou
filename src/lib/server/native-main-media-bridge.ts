import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpsRequest, type RequestOptions } from "node:https";
import { isIP } from "node:net";
import type { ClientRequest, IncomingMessage } from "node:http";
import { NextRequest } from "next/server";
import type { AuthUser, getSupabase } from "@/lib/api-middleware";
import {
  NativeMainMediaBridgeRequestSchema, NativeMainMediaBridgeQuerySchema, NativeMainMediaBridgeDtoSchema,
  NativeMainMediaBridgeLookupSchema, NativeMainMediaBridgeClaimSchema, NativeMainMediaBridgeInvocationSchema,
  NativeMainMediaBridgeSnapshotSchema, NativeMainMediaBridgeMimeSchema, nativeMainMediaBridgeCanonical,
  nativeMainMediaBridgeMagicMatches, NATIVE_MAIN_BRIDGE_MAX_IMAGE_BYTES, NATIVE_MAIN_BRIDGE_MAX_VIDEO_BYTES,
  type NativeMainMediaBridgeDto, type NativeMainMediaBridgePhaseDto,
  type NativeMainMediaBridgeMutation,
} from "@/lib/native-main-media-bridge-contract";
import { nativeMainMediaPath, nativeMainMediaUuid, type NativeOwnedMediaRef } from "@/lib/native-main-media-contract";
import { PublishingV3ActionSchema, PublishingV3MutationSchema, type PublishingV3Action } from "@/lib/publishing-v3-contract";
import { isBlockedIpAddress } from "@/lib/safe-fetch";
import { assertNativeAccess } from "./native-operations-service";
import { isPublishingProviderUploadUrl } from "./publishing-provider";
import { PublishingError } from "./publishing-service";
import type { PublishingV3Result } from "./publishing-v3-service";

type DB = ReturnType<typeof getSupabase>;
type Row = Record<string, unknown>;
type Phase = NativeMainMediaBridgePhaseDto["phase"];
export interface NativeMainMediaBridgePrivateContext { bridgeId: string; phase: "sign" | "confirm"; dispatchId: string }
export interface NativeMainMediaBridgeOptions {
  currentNamespace: string | (() => string | Promise<string>);
  headers?: Headers;
  cookies?: { get(name: string): string | undefined };
  signal?: AbortSignal;
  access?: typeof assertNativeAccess;
  readMain?: (request: NextRequest) => Promise<Response>;
  v3?: (action: PublishingV3Action, context: NativeMainMediaBridgePrivateContext) => Promise<PublishingV3Result>;
  put?: (url: string, bytes: Uint8Array, mime: string, signal?: AbortSignal) => Promise<{ httpStatus: number }>;
}
export class NativeMainMediaBridgeError extends PublishingError {
  constructor(code: string, message: string, status = 409, public readonly bridgeId?: string, unknown = false) { super(code, message, status, unknown); }
}
const object = (value: unknown): Row => value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
const sha = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
const same = (left: unknown, right: unknown) => nativeMainMediaBridgeCanonical(left) === nativeMainMediaBridgeCanonical(right);
const phaseKey = (bridgeId: string, phase: Phase) => `native-bridge:${bridgeId}:${phase}`;
function refuse(code: string, message: string, status = 409, bridgeId?: string, unknown = false): never { throw new NativeMainMediaBridgeError(code, message, status, bridgeId, unknown); }
function invalid(): never { return refuse("NATIVE_MAIN_BRIDGE_INPUT_INVALID", "请核对主站素材、原请求标识和媒体身份", 400); }
function active(signal?: AbortSignal, bridgeId?: string) { if (signal?.aborted) return refuse("NATIVE_MAIN_BRIDGE_OUTCOME_UNKNOWN", "原上传已中断，请只核对原记录", 503, bridgeId, true); }
function databaseError(error: unknown, bridgeId?: string): never {
  const value = object(error), message = String(value.message || "");
  if (["42P01", "42883", "PGRST202", "PGRST204", "PGRST205"].includes(String(value.code))) return refuse("NATIVE_MAIN_BRIDGE_SCHEMA_NOT_READY", "主站素材上传桥尚未初始化，未发起上传", 503, bridgeId);
  if (/IDEMPOTENCY|PAYLOAD_CONFLICT/.test(message)) return refuse("NATIVE_MAIN_BRIDGE_IDEMPOTENCY_CONFLICT", "原请求标识已用于不同素材，请核对原记录", 409, bridgeId);
  if (/NAMESPACE|CONNECTION/.test(message)) return refuse("NATIVE_MAIN_BRIDGE_CONNECTION_CHANGED", "官方连接已变化，请只核对原素材记录", 409, bridgeId);
  if (/SOURCE|MEDIA_SCOPE|ASSET_INVALID/.test(message)) return refuse("NATIVE_MAIN_BRIDGE_SOURCE_CHANGED", "主站素材已变化、失效或不属于当前会员，未取得新的上传许可", 409, bridgeId);
  if (/REVISION/.test(message)) return refuse("NATIVE_MAIN_BRIDGE_REVISION_CONFLICT", "原素材桥已有新状态，请核对原记录", 409, bridgeId);
  if (/PHASE|DISPATCH|GRANT|INVOCATION/.test(message)) return refuse("NATIVE_MAIN_BRIDGE_PHASE_NOT_PENDING", "原上传步骤已领取或前置证据尚未齐全，请只核对原记录", 409, bridgeId);
  if (/ACCESS|PERMISSION/.test(message)) return refuse("NATIVE_MAIN_BRIDGE_ACCESS_DENIED", "当前会员未满足素材上传准入", 403, bridgeId);
  return refuse("NATIVE_MAIN_BRIDGE_STATE_UNAVAILABLE", "原上传状态暂不可确认，请只读取原记录，勿另建请求", 503, bridgeId, true);
}
async function rpc(db: DB, user: AuthUser, mutation: boolean, input: Row): Promise<Row> {
  const result: { data: unknown; error: unknown } = await db.rpc(mutation ? "mutate_native_media_bridge_atomic" : "read_native_media_bridge_atomic", { p_user_id: user.id, p_input: input } as never);
  if (result.error) databaseError(result.error, typeof input.bridgeId === "string" ? input.bridgeId : undefined);
  if (!result.data || typeof result.data !== "object" || Array.isArray(result.data)) return refuse("NATIVE_MAIN_BRIDGE_RECEIPT_INVALID", "原上传回执格式待核对，请读取原记录", 503, typeof input.bridgeId === "string" ? input.bridgeId : undefined, mutation);
  return object(result.data);
}
async function namespace(options: NativeMainMediaBridgeOptions) {
  const value = typeof options.currentNamespace === "function" ? await options.currentNamespace() : options.currentNamespace;
  if (!value || value.length > 200) return refuse("NATIVE_MAIN_BRIDGE_CONFIGURATION_UNAVAILABLE", "官方连接身份暂不可确认", 503);
  return value;
}
async function access(user: AuthUser, options: NativeMainMediaBridgeOptions) { await (options.access ?? assertNativeAccess)(user); }
async function lookup(user: AuthUser, db: DB, query: unknown, currentNamespace: string) {
  const parsed = NativeMainMediaBridgeQuerySchema.safeParse(query); if (!parsed.success) return invalid();
  const result = NativeMainMediaBridgeLookupSchema.parse(await rpc(db, user, false, { action: "bridgeId" in parsed.data ? "bridge" : "by-request-key", ...parsed.data, currentNamespace }));
  return result.found ? result.bridge : null;
}
/** Safe projection only; no provider construction, upload grant or source download. */
export async function readNativeMainMediaBridge(user: AuthUser, db: DB, query: unknown, options: NativeMainMediaBridgeOptions): Promise<NativeMainMediaBridgeDto | null> {
  await access(user, options);
  return lookup(user, db, query, await namespace(options));
}
async function evidence(user: AuthUser, db: DB, reference: NativeOwnedMediaRef) {
  const value = await rpc(db, user, false, { action: "source-evidence", reference });
  if (Object.keys(value).length !== 1 || typeof value.sourceFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(value.sourceFingerprint)) return refuse("NATIVE_MAIN_BRIDGE_RECEIPT_INVALID", "主站素材归属证据暂不可确认", 503);
  return value.sourceFingerprint;
}
async function defaultMainReader(request: NextRequest) {
  return new URL(request.url).pathname === "/api/video/proxy"
    ? (await import("@/app/api/video/proxy/route")).GET(request)
    : (await import("@/app/api/media-history/content/route")).GET(request);
}
async function readBytes(reference: NativeOwnedMediaRef, options: NativeMainMediaBridgeOptions): Promise<{ bytes: Uint8Array; file: NativeMainMediaBridgeDto["file"] }> {
  const path = reference.kind === "video_task" ? `/api/video/proxy?id=${encodeURIComponent(reference.id)}&source=origin&forCapture=1` : nativeMainMediaPath(reference);
  const headers = new Headers({ Accept: reference.kind === "video_task" ? "video/mp4" : "image/jpeg,image/png" });
  const cookie = options.headers?.get("cookie"); if (cookie) headers.set("cookie", cookie);
  // No inherited Range, URL, provider key, owner override or bearer header.
  const request = new NextRequest(`http://native.internal${path}`, { method: "GET", headers, signal: options.signal });
  const response = await (options.readMain ?? defaultMainReader)(request);
  const stop = async (code: string, message: string): Promise<never> => { await response.body?.cancel().catch(() => {}); return refuse(code, message); };
  if (response.status !== 200 || response.redirected || response.headers.has("content-range") || response.headers.get("x-media-fallback")) return stop("NATIVE_MAIN_BRIDGE_SOURCE_UNAVAILABLE", "主站素材未完成交付、已失效或暂不可读取");
  const parsedMime = NativeMainMediaBridgeMimeSchema.safeParse((response.headers.get("content-type") || "").split(";", 1)[0].trim().toLowerCase());
  if (!parsedMime.success || (reference.kind === "video_task") !== (parsedMime.data === "video/mp4")) return stop("NATIVE_MAIN_BRIDGE_FORMAT_UNSUPPORTED", "此上传桥接收原始 JPEG、PNG 和 MP4，不会自动转码或接受错误正文");
  const mime = parsedMime.data, maximum = mime === "video/mp4" ? NATIVE_MAIN_BRIDGE_MAX_VIDEO_BYTES : NATIVE_MAIN_BRIDGE_MAX_IMAGE_BYTES;
  const length = response.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)) || Number(length) > maximum)) return stop("NATIVE_MAIN_BRIDGE_SIZE_INVALID", "素材超过官方上传大小上限");
  if (!response.body) return refuse("NATIVE_MAIN_BRIDGE_SOURCE_UNAVAILABLE", "主站没有返回实际素材文件");
  const reader = response.body.getReader(), chunks: Buffer[] = []; let size = 0, complete = false;
  try {
    while (true) {
      if (options.signal?.aborted) throw new Error("SOURCE_ABORTED");
      const next = await reader.read(); if (next.done) { complete = true; break; }
      size += next.value.byteLength; if (size > maximum) return refuse("NATIVE_MAIN_BRIDGE_SIZE_INVALID", "素材超过官方上传大小上限");
      chunks.push(Buffer.from(next.value));
    }
  } finally { if (!complete) await reader.cancel().catch(() => {}); reader.releaseLock(); }
  if (!size || length !== null && Number(length) !== size) return refuse("NATIVE_MAIN_BRIDGE_SOURCE_UNAVAILABLE", "主站素材为空或传输不完整");
  const bytes = Buffer.concat(chunks, size);
  if (!nativeMainMediaBridgeMagicMatches(mime, bytes)) return refuse("NATIVE_MAIN_BRIDGE_FORMAT_UNSUPPORTED", "实际素材签名与格式不一致，未发起上传");
  return { bytes, file: { mime, size, sha256: sha(bytes) } };
}

export interface NativeMainBridgePutDependencies {
  lookup?: (hostname: string) => Promise<Array<{ address: string; family: number }>>;
  request?: (options: RequestOptions, callback: (response: IncomingMessage) => void) => ClientRequest;
}
/** One upload only. The signed URL stays in RAM and is never a public API target. */
export async function putNativeMainMediaBridgeBytes(url: string, bytes: Uint8Array, mime: string, signal?: AbortSignal, dependencies: NativeMainBridgePutDependencies = {}): Promise<{ httpStatus: number }> {
  const parsedMime = NativeMainMediaBridgeMimeSchema.safeParse(mime);
  if (!parsedMime.success || !bytes.byteLength || bytes.byteLength > (mime === "video/mp4" ? NATIVE_MAIN_BRIDGE_MAX_VIDEO_BYTES : NATIVE_MAIN_BRIDGE_MAX_IMAGE_BYTES)) return refuse("NATIVE_MAIN_BRIDGE_SIZE_INVALID", "上传文件的类型或大小不符合素材桥合同");
  if (!isPublishingProviderUploadUrl(url)) return refuse("NATIVE_MAIN_BRIDGE_UPLOAD_TARGET_INVALID", "官方签名上传地址未通过受控校验");
  const target = new URL(url), addresses = await (dependencies.lookup ?? (hostname => dnsLookup(hostname, { all: true, verbatim: true })))(target.hostname);
  if (!addresses.length || addresses.some(address => ![4, 6].includes(address.family) || isIP(address.address) !== address.family || isBlockedIpAddress(address.address))) return refuse("NATIVE_MAIN_BRIDGE_UPLOAD_TARGET_INVALID", "官方上传目的地址未通过公网校验");
  if (signal?.aborted) return refuse("NATIVE_MAIN_BRIDGE_OUTCOME_UNKNOWN", "原上传已中断，请只核对原记录", 503, undefined, true);
  const address = [...addresses].sort((left, right) => left.family - right.family)[0];
  return new Promise((resolve, reject) => {
    let settled = false, received = 0;
    const deadline: { timer?: ReturnType<typeof setTimeout> } = {};
    const finish = (error?: Error, status?: number) => { if (settled) return; settled = true; if (deadline.timer) clearTimeout(deadline.timer); signal?.removeEventListener("abort", abort); if (error) reject(error); else resolve({ httpStatus: status || 0 }); };
    const abort = () => request.destroy(new Error("UPLOAD_ABORTED"));
    const request = (dependencies.request ?? httpsRequest)({ protocol: "https:", hostname: target.hostname, servername: target.hostname, port: 443, path: `${target.pathname}${target.search}`, method: "PUT", headers: { "Content-Type": mime, "Content-Length": String(bytes.byteLength) }, family: address.family, lookup: (_name, _options, callback) => callback(null, address.address, address.family) }, response => {
      response.on("data", (chunk: Buffer) => { received += chunk.length; if (received > 65536) request.destroy(new Error("UPLOAD_RECEIPT_TOO_LARGE")); });
      response.once("end", () => finish(undefined, response.statusCode)); response.once("error", error => finish(error)); response.once("aborted", () => finish(new Error("UPLOAD_ACK_LOST")));
    });
    request.setTimeout(300000, () => request.destroy(new Error("UPLOAD_TIMEOUT")));
    deadline.timer = setTimeout(() => request.destroy(new Error("UPLOAD_TOTAL_TIMEOUT")), 300000);
    request.once("error", error => finish(error)); signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort(); else request.end(bytes);
  });
}

/** Explicit user action; only an unclaimed prepared bridge may obtain its first phase grant. */
export async function prepareNativeMainMediaBridge(user: AuthUser, db: DB, raw: unknown, options: NativeMainMediaBridgeOptions): Promise<NativeMainMediaBridgeMutation> {
  const parsed = NativeMainMediaBridgeRequestSchema.safeParse(raw); if (!parsed.success) return invalid();
  await access(user, options);
  const input = parsed.data, initialNamespace = await namespace(options);
  let bridge = await lookup(user, db, { requestKey: input.requestKey }, initialNamespace);
  if (bridge && (!same(bridge.reference, input.reference) || bridge.mediaId !== input.mediaId)) return refuse("NATIVE_MAIN_BRIDGE_IDEMPOTENCY_CONFLICT", "原请求标识已用于不同素材，请核对原记录", 409, bridge.id);
  const observe = async (id: string) => NativeMainMediaBridgeDtoSchema.parse((await rpc(db, user, true, { action: "reconcile", requestKey: `native-bridge:${id}:observe:${randomUUID()}`, currentNamespace: await namespace(options), bridgeId: id })).bridge);
  const v3 = options.v3 ?? (async (action, context) => (await import("./publishing-v3-service")).mutatePublishingV3(user, db, action, options.cookies ?? { get: () => undefined }, context));
  if (bridge && (bridge.state !== "prepared" || bridge.phase !== null || !bridge.connectionCurrent)) {
    if (bridge.state !== "ready") bridge = await observe(bridge.id);
    // A persisted PUT receipt can authorize the first confirmation without the
    // lost upload URL or another download. It never authorizes a second PUT.
    if (bridge.state === "confirming" && bridge.connectionCurrent) {
      const bridgeId = bridge.id;
      try {
        const currentNamespace = await namespace(options);
        const pending = NativeMainMediaBridgeInvocationSchema.parse(await rpc(db, user, false, { action: "invocation", bridgeId, phase: "confirm", dispatchId: null, currentNamespace }));
        if (pending.phase.state !== "pending" || pending.phase.dispatchId !== null || pending.phase.operationRequestKey !== phaseKey(bridgeId, "confirm") || pending.snapshot.namespace !== currentNamespace || !same(pending.snapshot.reference, input.reference) || pending.snapshot.mediaId !== input.mediaId || !same(pending.bridge.file, bridge.file)) return refuse("NATIVE_MAIN_BRIDGE_RECEIPT_INVALID", "原确认步骤与已上传素材不一致", 503, bridgeId, true);
        await access(user, options);
        active(options.signal, bridgeId);
        const claimed = NativeMainMediaBridgeClaimSchema.parse(await rpc(db, user, true, { action: "claim-phase", requestKey: `native-bridge:${bridgeId}:claim:confirm`, currentNamespace: await namespace(options), bridgeId, expectedRevision: pending.bridge.revision, phase: "confirm" }));
        if (!claimed.shouldDispatch) return { bridge: await observe(bridgeId), alreadyFulfilled: true };
        if (!claimed.phase.dispatchId || !claimed.phase.assetId) return refuse("NATIVE_MAIN_BRIDGE_RECEIPT_INVALID", "原素材确认许可不完整", 503, bridgeId, true);
        const invocation = NativeMainMediaBridgeInvocationSchema.parse(await rpc(db, user, false, { action: "invocation", bridgeId, phase: "confirm", dispatchId: claimed.phase.dispatchId, currentNamespace: await namespace(options) }));
        if (!invocation.bridge.connectionCurrent || invocation.phase.assetId !== claimed.phase.assetId || invocation.phase.dispatchId !== claimed.phase.dispatchId || !same(invocation.snapshot, pending.snapshot)) return refuse("NATIVE_MAIN_BRIDGE_RECEIPT_INVALID", "原素材确认许可已有变化", 503, bridgeId, true);
        active(options.signal, bridgeId);
        await v3({ action: "upload-confirm", requestKey: phaseKey(bridgeId, "confirm"), assetId: claimed.phase.assetId }, { bridgeId, phase: "confirm", dispatchId: claimed.phase.dispatchId });
        const confirmed = await observe(bridgeId);
        if (confirmed.state !== "ready" || confirmed.resultReference?.assetId !== claimed.phase.assetId) return refuse("NATIVE_MAIN_BRIDGE_OUTCOME_UNKNOWN", "官方确认结果尚未形成完整证据，请只核对原记录", 503, bridgeId, true);
        return { bridge: confirmed, alreadyFulfilled: false };
      } catch (error) {
        if (error instanceof NativeMainMediaBridgeError && ["NATIVE_MAIN_BRIDGE_PHASE_NOT_PENDING", "NATIVE_MAIN_BRIDGE_REVISION_CONFLICT"].includes(error.code)) return { bridge: await observe(bridgeId), alreadyFulfilled: true };
        try { const observed = await observe(bridgeId); if (["ready", "unknown", "failed_known"].includes(observed.state)) return { bridge: observed, alreadyFulfilled: true }; } catch { /* Preserve the original operation when observation is unavailable. */ }
        if (error instanceof NativeMainMediaBridgeError) throw error;
        return refuse("NATIVE_MAIN_BRIDGE_OUTCOME_UNKNOWN", "原素材确认结果暂不可确认，请只核对原记录", 503, bridgeId, true);
      }
    }
    return { bridge, alreadyFulfilled: true };
  }
  if (!/^(?:domestic|international):[a-f0-9]{24}$/.test(initialNamespace)) return refuse("NATIVE_MAIN_BRIDGE_CONNECTION_CHANGED", "官方素材连接尚未就绪，未发起上传", 409, bridge?.id);
  const before = await evidence(user, db, input.reference), source = await readBytes(input.reference, options), after = await evidence(user, db, input.reference);
  if (before !== after) return refuse("NATIVE_MAIN_BRIDGE_SOURCE_CHANGED", "读取期间主站素材已变化，请重新选择并确认", 409, bridge?.id);
  if (bridge && !same(bridge.file, source.file)) return refuse("NATIVE_MAIN_BRIDGE_SOURCE_CHANGED", "实际素材与原上传快照不一致，未取得新许可", 409, bridge.id);
  if (!bridge) {
    const bridgeId = nativeMainMediaUuid(sha(nativeMainMediaBridgeCanonical({ version: 1, ownerId: user.id, requestKey: input.requestKey })));
    const extension = source.file.mime === "image/jpeg" ? "jpg" : source.file.mime === "image/png" ? "png" : "mp4";
    const snapshot = NativeMainMediaBridgeSnapshotSchema.parse({ version: 1, reference: input.reference, mediaId: input.mediaId, namespace: initialNamespace, sourceFingerprint: before, file: { ...source.file, fileName: `native-bridge-${bridgeId}.${extension}` } });
    bridge = NativeMainMediaBridgeDtoSchema.parse((await rpc(db, user, true, { action: "prepare", requestKey: input.requestKey, currentNamespace: await namespace(options), bridgeId, snapshot, snapshotHash: sha(nativeMainMediaBridgeCanonical(snapshot)) })).bridge);
  }
  const bridgeId = bridge.id;
  const claim = async (phase: Phase) => {
    await access(user, options);
    active(options.signal, bridgeId);
    const currentNamespace = await namespace(options);
    const result = NativeMainMediaBridgeClaimSchema.parse(await rpc(db, user, true, { action: "claim-phase", requestKey: `native-bridge:${bridgeId}:claim:${phase}`, currentNamespace, bridgeId, expectedRevision: bridge!.revision, phase }));
    bridge = result.bridge;
    if (!result.shouldDispatch) return null;
    if (!result.phase.dispatchId) return refuse("NATIVE_MAIN_BRIDGE_RECEIPT_INVALID", "上传执行许可不完整，请核对原记录", 503, bridgeId, true);
    const invocation = NativeMainMediaBridgeInvocationSchema.parse(await rpc(db, user, false, { action: "invocation", bridgeId, phase, dispatchId: result.phase.dispatchId, currentNamespace }));
    if (invocation.bridge.id !== bridgeId || !invocation.bridge.connectionCurrent || invocation.snapshot.namespace !== initialNamespace || !same(invocation.snapshot.reference, input.reference) || invocation.snapshot.mediaId !== input.mediaId || !same({ mime: invocation.snapshot.file.mime, size: invocation.snapshot.file.size, sha256: invocation.snapshot.file.sha256 }, source.file) || invocation.snapshot.file.fileName !== `native-bridge-${bridgeId}.${source.file.mime === "image/jpeg" ? "jpg" : source.file.mime === "image/png" ? "png" : "mp4"}` || invocation.phase.phase !== phase || invocation.phase.dispatchId !== result.phase.dispatchId || invocation.phase.operationRequestKey !== phaseKey(bridgeId, phase)) return refuse("NATIVE_MAIN_BRIDGE_RECEIPT_INVALID", "上传许可与原素材快照不一致，请核对原记录", 503, bridgeId, true);
    active(options.signal, bridgeId);
    return invocation;
  };
  try {
    const sign = await claim("sign"); if (!sign) return { bridge: await observe(bridgeId), alreadyFulfilled: true };
    const signed = PublishingV3MutationSchema.parse((await v3(PublishingV3ActionSchema.parse({ action: "upload-sign", requestKey: phaseKey(bridgeId, "sign"), mediaId: input.mediaId, ...sign.snapshot.file }), { bridgeId, phase: "sign", dispatchId: sign.phase.dispatchId! })).body);
    bridge = await observe(bridgeId);
    if (!signed.upload || signed.upload.method !== "PUT" || signed.upload.mime !== source.file.mime) return refuse("NATIVE_MAIN_BRIDGE_UPLOAD_URL_LOST", "原签名上传地址已不可恢复，请只核对原素材记录，不会重新签名或上传", 409, bridgeId, true);
    const put = await claim("put"); if (!put) return { bridge: await observe(bridgeId), alreadyFulfilled: true };
    if (!put.phase.assetId || !put.phase.providerAssetId || signed.upload.assetId !== put.phase.assetId || signed.asset?.id !== put.phase.assetId) return refuse("NATIVE_MAIN_BRIDGE_RECEIPT_INVALID", "官方签名账本与上传资产不一致", 503, bridgeId, true);
    const acknowledgement = await (options.put ?? putNativeMainMediaBridgeBytes)(signed.upload.url, source.bytes, source.file.mime, options.signal);
    if (!Number.isInteger(acknowledgement.httpStatus) || acknowledgement.httpStatus < 200 || acknowledgement.httpStatus >= 300 || sha(source.bytes) !== source.file.sha256) return refuse("NATIVE_MAIN_BRIDGE_OUTCOME_UNKNOWN", "上传结果或实际文件暂不可确认，请核对原记录", 503, bridgeId, true);
    bridge = NativeMainMediaBridgeDtoSchema.parse((await rpc(db, user, true, { action: "record-put", requestKey: `native-bridge:${bridgeId}:put-receipt`, currentNamespace: await namespace(options), bridgeId, dispatchId: put.phase.dispatchId, proof: { httpStatus: acknowledgement.httpStatus, ...source.file } })).bridge);
    bridge = await observe(bridgeId);
    const confirm = await claim("confirm"); if (!confirm) return { bridge: await observe(bridgeId), alreadyFulfilled: true };
    if (!confirm.phase.assetId || confirm.phase.assetId !== put.phase.assetId) return refuse("NATIVE_MAIN_BRIDGE_RECEIPT_INVALID", "确认许可与原上传资产不一致", 503, bridgeId, true);
    await v3({ action: "upload-confirm", requestKey: phaseKey(bridgeId, "confirm"), assetId: confirm.phase.assetId }, { bridgeId, phase: "confirm", dispatchId: confirm.phase.dispatchId! });
    bridge = await observe(bridgeId);
    if (bridge.state !== "ready" || bridge.resultReference?.assetId !== confirm.phase.assetId || !bridge.connectionCurrent) return refuse("NATIVE_MAIN_BRIDGE_OUTCOME_UNKNOWN", "官方确认与上传账本尚未形成完整证据，请只核对原记录", 503, bridgeId, true);
    return { bridge, alreadyFulfilled: false };
  } catch (error) {
    try { bridge = await observe(bridgeId); if (bridge.state === "ready" || bridge.state === "unknown" || bridge.state === "failed_known") return { bridge, alreadyFulfilled: false }; } catch { /* No new dispatch may be inferred from an unavailable ledger. */ }
    if (error instanceof NativeMainMediaBridgeError) throw error;
    return refuse("NATIVE_MAIN_BRIDGE_OUTCOME_UNKNOWN", "原上传结果暂不可确认，请只核对原记录，勿另建请求", 503, bridgeId, true);
  }
}
