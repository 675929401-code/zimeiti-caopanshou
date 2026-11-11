import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import type { ClientRequest, IncomingMessage } from "node:http";
import type { AuthUser } from "../src/lib/api-middleware";
import { prepareNativeMainMediaBridge, readNativeMainMediaBridge, putNativeMainMediaBridgeBytes, type NativeMainMediaBridgeOptions } from "../src/lib/server/native-main-media-bridge";
import { nativeMainMediaBridgeCanonical, type NativeMainMediaBridgeDto, type NativeMainMediaBridgeSnapshot, type NativeMainMediaBridgePhaseDto } from "../src/lib/native-main-media-bridge-contract";

type Row = Record<string, unknown>;
type DB = Parameters<typeof prepareNativeMainMediaBridge>[1];
type Phase = NativeMainMediaBridgePhaseDto["phase"];
const uuid = (n: number) => `80000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const A: AuthUser = { id: uuid(1), role: "user", email: "fixture@example.invalid" }, B: AuthUser = { id: uuid(2), role: "user", email: "other@example.invalid" };
const stamp = "2026-11-10T00:00:00.000Z", namespaceA = `domestic:${"a".repeat(24)}`, namespaceB = `domestic:${"b".repeat(24)}`;
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aDrsAAAAASUVORK5CYII=", "base64");
const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const clone = <T>(value: T): T => structuredClone(value);
const object = (value: unknown) => value as Row;
const errorCode = (code: string) => (error: unknown) => !!error && typeof error === "object" && "code" in error && error.code === code;
const originalFetch = globalThis.fetch; let network = 0;
test.before(() => { globalThis.fetch = async () => { network++; throw new Error("NETWORK_FORBIDDEN_IN_MAIN_BRIDGE_TEST"); }; });
test.after(() => { globalThis.fetch = originalFetch; assert.equal(network, 0); });

function fixture() {
  let record: { owner: string; snapshot: NativeMainMediaBridgeSnapshot; dto: NativeMainMediaBridgeDto; phases: Record<Phase, NativeMainMediaBridgePhaseDto> } | undefined;
  let currentNamespace = namespaceA, fingerprint = "a".repeat(64), sourceBytes: Uint8Array = png, stale = false;
  let lookupError: unknown = null, failure: "sign-before" | "put-before" | "confirm-before" | "confirm-after" | "sign-url-lost" | "sign-fake-200" | "record-put-ack" | "claim-once" | undefined;
  let sourceResponse: (() => Response) | undefined, onRead: (() => void) | undefined, onSign: (() => void) | undefined;
  const calls: { name: string; owner: string; input: Row }[] = [], privateCalls: Row[] = [], proofs: Row[] = [], mainRequests: Request[] = [];
  const operations: Row[] = [], assets: Row[] = [];
  let signCalls = 0, putCalls = 0, confirmCalls = 0, permissionCalls = 0, denyAt = Infinity;
  const request = { requestKey: "fixture-main-bridge", reference: { kind: "image_record", id: "owner-image:1" }, mediaId: uuid(10) };
  const publicAsset = () => {
    assert.ok(record);
    const asset = assets[0]; return { id: asset.id, mediaId: record.dto.mediaId, fileName: record.snapshot.file.fileName, mime: asset.mime, size: asset.size, sha256: asset.sha256, hashSource: "browser_declared", state: asset.state, revision: 1, expiresAt: null, metadata: {}, createdAt: stamp, updatedAt: stamp };
  };
  function dto() { assert.ok(record); return clone({ ...record.dto, connectionCurrent: currentNamespace === record.snapshot.namespace }); }
  function increment() { assert.ok(record); record.dto.revision++; }
  function observe() {
    assert.ok(record);
    const p = record.phases, asset = assets[0];
    const signed = operations.find(row => row.kind === "asset_sign" && row.owner_id === record!.owner && row.asset_id === asset?.id && row.grant_used === true && row.dispatch_state === "settled");
    if (signed && asset?.sha256 === record.snapshot.file.sha256 && asset.size === record.snapshot.file.size && asset.mime === record.snapshot.file.mime) { p.sign.state = "recorded"; p.sign.recordedAt = stamp; }
    const confirmed = operations.find(row => row.kind === "asset_confirm" && row.owner_id === record!.owner && row.asset_id === asset?.id && row.grant_used === true && row.dispatch_state === "settled");
    if (confirmed && asset?.state === "ready" && p.put.state === "recorded") { p.confirm.state = "recorded"; p.confirm.recordedAt = stamp; }
    if (p.confirm.state === "recorded" && p.sign.state === "recorded" && p.put.state === "recorded") {
      record.dto.state = "ready"; record.dto.phase = null; record.dto.resultReference = { kind: "provider_asset", assetId: String(asset.id), mediaId: record.dto.mediaId };
    } else if (p.confirm.state === "claimed" || p.confirm.state === "unknown" || p.put.state === "claimed" || p.put.state === "unknown" || (stale && p.sign.state === "recorded" && p.put.state === "pending") || p.sign.state === "claimed" || p.sign.state === "unknown") {
      record.dto.state = "unknown";
    } else if (p.put.state === "recorded") { record.dto.state = "confirming"; record.dto.phase = "confirm"; }
    else if (p.sign.state === "recorded") { record.dto.state = "uploading"; record.dto.phase = "sign"; }
    increment(); return { bridge: dto(), alreadyFulfilled: false };
  }
  const db = { async rpc(name: string, raw: unknown) {
    const args = raw as { p_user_id: string; p_input: Row }, p = args.p_input, owner = args.p_user_id;
    calls.push({ name, owner, input: clone(p) });
    const fail = (message: string) => ({ data: null, error: { message } });
    if (name === "read_native_media_bridge_atomic") {
      if (lookupError) return { data: null, error: lookupError };
      if (p.action === "source-evidence") return owner === A.id ? { data: { sourceFingerprint: fingerprint }, error: null } : fail("NATIVE_BRIDGE_SOURCE_SCOPE_INVALID");
      if (p.action === "bridge" || p.action === "by-request-key") return { data: record && record.owner === owner && (p.action === "bridge" ? record.dto.id === p.bridgeId : record.dto.requestKey === p.requestKey) ? { found: true, bridge: dto() } : { found: false }, error: null };
      if (p.action === "invocation") {
        if (!record || owner !== record.owner || p.bridgeId !== record.dto.id) return fail("NATIVE_BRIDGE_INVOCATION_INVALID");
        const phase = record.phases[p.phase as Phase];
        if (p.dispatchId === null ? phase.state !== "pending" || phase.dispatchId !== null : p.dispatchId !== phase.dispatchId) return fail("NATIVE_BRIDGE_INVOCATION_INVALID");
        return { data: { bridge: dto(), snapshot: clone(record.snapshot), phase: clone(phase) }, error: null };
      }
      throw new Error(`unexpected bridge read ${String(p.action)}`);
    }
    assert.equal(name, "mutate_native_media_bridge_atomic");
    if (p.action === "prepare") {
      const snapshot = p.snapshot as NativeMainMediaBridgeSnapshot;
      if (record) { assert.equal(p.bridgeId, record.dto.id); assert.equal(nativeMainMediaBridgeCanonical(snapshot), nativeMainMediaBridgeCanonical(record.snapshot)); return { data: { bridge: dto(), alreadyFulfilled: true }, error: null }; }
      assert.equal(snapshot.sourceFingerprint, fingerprint); assert.equal(snapshot.namespace, currentNamespace); assert.equal(p.snapshotHash, hash(nativeMainMediaBridgeCanonical(snapshot)));
      const phases = Object.fromEntries((["sign", "put", "confirm"] as const).map(phase => [phase, { phase, state: "pending", dispatchId: null, operationRequestKey: `native-bridge:${String(p.bridgeId)}:${phase}`, operationId: null, assetId: null, providerAssetId: null, claimedAt: null, recordedAt: null }])) as Record<Phase, NativeMainMediaBridgePhaseDto>;
      record = { owner, snapshot: clone(snapshot), phases, dto: { id: String(p.bridgeId), requestKey: String(p.requestKey), reference: clone(snapshot.reference), mediaId: snapshot.mediaId, state: "prepared", revision: 1, phase: null, file: { mime: snapshot.file.mime, size: snapshot.file.size, sha256: snapshot.file.sha256 }, connectionCurrent: true, resultReference: null, errorCode: null, createdAt: stamp, updatedAt: stamp } };
      return { data: { bridge: dto(), alreadyFulfilled: false }, error: null };
    }
    if (!record || record.owner !== owner || p.bridgeId !== record.dto.id) return fail("NATIVE_BRIDGE_ACCESS_DENIED");
    if (p.action === "reconcile") return { data: observe(), error: null };
    if (p.action === "claim-phase") {
      if (failure === "claim-once") { failure = undefined; return { data: null, error: { code: "08006", message: "fixture claim connection lost before commit" } }; }
      if (p.currentNamespace !== record.snapshot.namespace) return fail("NATIVE_BRIDGE_NAMESPACE_CHANGED");
      if (fingerprint !== record.snapshot.sourceFingerprint) return fail("NATIVE_BRIDGE_SOURCE_CHANGED");
      const phase = record.phases[p.phase as Phase];
      if (phase.state !== "pending") return { data: { bridge: dto(), phase: clone(phase), shouldDispatch: false }, error: null };
      if (p.expectedRevision !== record.dto.revision) return fail("NATIVE_BRIDGE_REVISION_CONFLICT");
      if (phase.phase === "put" && record.phases.sign.state !== "recorded" || phase.phase === "confirm" && record.phases.put.state !== "recorded") return fail("NATIVE_BRIDGE_PHASE_INVALID");
      phase.state = "claimed"; phase.dispatchId = uuid(50 + ["sign", "put", "confirm"].indexOf(phase.phase)); phase.claimedAt = stamp;
      if (phase.phase !== "sign") { phase.assetId = record.phases.sign.assetId; phase.providerAssetId = record.phases.sign.providerAssetId; }
      record.dto.state = phase.phase === "confirm" ? "confirming" : "uploading"; record.dto.phase = phase.phase; increment();
      return { data: { bridge: dto(), phase: clone(phase), shouldDispatch: true }, error: null };
    }
    if (p.action === "record-put") {
      const phase = record.phases.put; assert.equal(p.dispatchId, phase.dispatchId); const proof = object(p.proof);
      assert.deepEqual(proof, { httpStatus: 201, mime: record.snapshot.file.mime, size: record.snapshot.file.size, sha256: record.snapshot.file.sha256 });
      proofs.push(clone(proof)); phase.state = "recorded"; phase.recordedAt = stamp; increment();
      if (failure === "record-put-ack") { failure = undefined; return { data: null, error: { code: "08006", message: "fixture persisted PUT receipt ack lost" } }; }
      return { data: { bridge: dto(), alreadyFulfilled: false }, error: null };
    }
    throw new Error(`unexpected bridge mutation ${String(p.action)}`);
  } } as unknown as DB;
  const options: NativeMainMediaBridgeOptions = {
    currentNamespace: () => currentNamespace,
    headers: new Headers({ cookie: "fixture-session=owner-a", authorization: "Bearer never-forward", range: "bytes=0-5" }),
    access: async () => { permissionCalls++; if (permissionCalls >= denyAt) throw new Error("fixture permission revoked"); return { revision: 1, checksum: "fixture" } as Awaited<ReturnType<NonNullable<NativeMainMediaBridgeOptions["access"]>>>; },
    readMain: async request => { mainRequests.push(request); assert.equal(request.method, "GET"); assert.equal(request.headers.get("range"), null); assert.equal(request.headers.get("authorization"), null); assert.equal(request.headers.get("cookie"), "fixture-session=owner-a"); assert.equal(new URL(request.url).origin, "http://native.internal"); onRead?.(); return sourceResponse?.() ?? new Response(sourceBytes as BodyInit, { headers: { "Content-Type": "image/png", "Content-Length": String(sourceBytes.byteLength) } }); },
    v3: async (action, context) => {
      assert.ok(record); privateCalls.push({ action: clone(action), context: clone(context) });
      if (action.action !== "upload-sign" && action.action !== "upload-confirm") throw new Error("private upload context accepts only sign/confirm");
      const phase = record.phases[context.phase]; assert.equal(phase.dispatchId, context.dispatchId); assert.equal(context.bridgeId, record.dto.id); assert.ok(["claimed", "unknown"].includes(phase.state)); assert.equal(action.requestKey, phase.operationRequestKey);
      if (action.action === "upload-sign") {
        signCalls++; if (failure === "sign-before") throw new Error("fixture sign outcome lost");
        if (failure === "sign-fake-200") return { body: { ok: true, upload: { assetId: uuid(30), url: "https://fixture.s3.amazonaws.com/upload?signature=fixture", method: "PUT", mime: action.mime } } };
        const asset: Row = { id: uuid(30), owner_id: A.id, connection_id: currentNamespace, state: "uploading", mime: action.mime, size: action.size, sha256: action.sha256, local_media_id: action.mediaId };
        assets.push(asset); const operation = { id: uuid(31), owner_id: A.id, kind: "asset_sign", asset_id: asset.id, grant_used: true, dispatch_state: "settled" }; operations.push(operation);
        phase.operationId = String(operation.id); phase.assetId = String(asset.id); phase.providerAssetId = "remote-fixture-upload";
        onSign?.();
        return { body: { ok: true, asset: publicAsset(), ...(failure === "sign-url-lost" ? {} : { upload: { assetId: asset.id, url: "https://fixture.s3.amazonaws.com/upload?signature=fixture", method: "PUT", mime: action.mime } }) } };
      }
      assert.equal(action.action, "upload-confirm"); confirmCalls++;
      if (failure === "confirm-before") throw new Error("fixture confirm lost before receipt");
      assert.equal(action.assetId, assets[0].id); assert.equal(record.phases.put.state, "recorded");
      assets[0].state = "ready"; phase.operationId = uuid(32); operations.push({ id: uuid(32), owner_id: A.id, kind: "asset_confirm", asset_id: assets[0].id, grant_used: true, dispatch_state: "settled" });
      if (failure === "confirm-after") throw new Error("fixture confirmed but ack lost");
      return { body: { ok: true, asset: publicAsset() } };
    },
    put: async (_url, bytes, mime) => { putCalls++; assert.ok(record); assert.equal(record.phases.put.state, "claimed"); assert.equal(hash(bytes), record.snapshot.file.sha256); assert.equal(mime, record.snapshot.file.mime); if (failure === "put-before") throw new Error("fixture PUT ack lost"); return { httpStatus: 201 }; },
  };
  const prepare = (raw: unknown = request) => prepareNativeMainMediaBridge(A, db, raw, options);
  return { db, options, request, calls, operations, assets, proofs, privateCalls, mainRequests, prepare, record: () => record!, counts: () => ({ signCalls, putCalls, confirmCalls, permissionCalls }), fail: (value: typeof failure) => { failure = value; }, failLookup: (value: unknown) => { lookupError = value; }, namespace: (value: string) => { currentNamespace = value; }, sourceFingerprint: (value: string) => { fingerprint = value; }, bytes: (value: Uint8Array) => { sourceBytes = value; }, response: (value?: () => Response) => { sourceResponse = value; }, onRead: (value: () => void) => { onRead = value; }, onSign: (value: () => void) => { onSign = value; }, stale: () => { stale = true; }, denyAt: (value: number) => { denyAt = value; } };
}

test("actual bytes/source evidence plus three unique phase grants produce only a local confirmed provider reference", async () => {
  const f = fixture(), result = await f.prepare();
  assert.equal(result.bridge.state, "ready"); assert.equal(result.bridge.resultReference?.assetId, uuid(30)); assert.equal(result.bridge.resultReference.mediaId, f.request.mediaId);
  assert.deepEqual(f.counts(), { signCalls: 1, putCalls: 1, confirmCalls: 1, permissionCalls: 4 }); assert.equal(f.proofs.length, 1);
  assert.equal(f.calls.filter(call => call.input.action === "source-evidence").length, 2);
  assert.deepEqual(f.privateCalls.map(call => object(call.context).phase), ["sign", "confirm"]);
  assert.equal(JSON.stringify(result).includes("signature="), false); assert.equal(JSON.stringify(result).includes("remote-fixture"), false); assert.equal(JSON.stringify(result).includes("namespace"), false);
  assert.equal(f.record().snapshot.file.sha256, hash(png)); assert.equal(f.record().snapshot.file.fileName, `native-bridge-${result.bridge.id}.png`);
});

test("ready replay precedes source reads, transport/config readiness and preserves historical result after rotation", async () => {
  const f = fixture(), first = await f.prepare(), before = f.mainRequests.length;
  f.options.readMain = async () => { throw new Error("completed replay must not download"); }; f.options.v3 = async () => { throw new Error("completed replay must not call provider"); };
  f.namespace(namespaceB); const replay = await f.prepare();
  assert.equal(replay.alreadyFulfilled, true); assert.equal(replay.bridge.state, "ready"); assert.equal(replay.bridge.connectionCurrent, false); assert.deepEqual(replay.bridge.resultReference, first.bridge.resultReference); assert.equal(f.mainRequests.length, before);
});

test("same-key changed args conflict and a foreign owner sees no bridge", async () => {
  const f = fixture(); await f.prepare();
  await assert.rejects(f.prepare({ ...f.request, mediaId: uuid(99) }), errorCode("NATIVE_MAIN_BRIDGE_IDEMPOTENCY_CONFLICT"));
  await assert.rejects(f.prepare({ ...f.request, reference: { kind: "image_record", id: "different" } }), errorCode("NATIVE_MAIN_BRIDGE_IDEMPOTENCY_CONFLICT"));
  assert.equal(await readNativeMainMediaBridge(B, f.db, { requestKey: f.request.requestKey }, f.options), null);
  assert.equal(f.counts().signCalls, 1);
});

test("lookup not-found and database error stay distinct and a GET acquires no mutation permit", async () => {
  const f = fixture(); assert.equal(await readNativeMainMediaBridge(A, f.db, { requestKey: f.request.requestKey }, f.options), null);
  f.failLookup({ code: "08006", message: "fixture connection lost" });
  await assert.rejects(readNativeMainMediaBridge(A, f.db, { requestKey: f.request.requestKey }, f.options), errorCode("NATIVE_MAIN_BRIDGE_STATE_UNAVAILABLE"));
  await assert.rejects(f.prepare(), errorCode("NATIVE_MAIN_BRIDGE_STATE_UNAVAILABLE"));
  assert.equal(f.calls.some(call => call.name.startsWith("mutate")), false); assert.equal(f.mainRequests.length, 0);
});

test("source fingerprint changes during the bounded byte read block preparation before sign", async () => {
  const f = fixture(); f.onRead(() => f.sourceFingerprint("b".repeat(64)));
  await assert.rejects(f.prepare(), errorCode("NATIVE_MAIN_BRIDGE_SOURCE_CHANGED"));
  assert.equal(f.calls.some(call => call.input.action === "prepare"), false); assert.equal(f.counts().signCalls, 0);
});

test("HTTP200 error body, MIME/container mismatch, range response, expiry, truncation and size overflow cannot sign", async () => {
  for (const response of [
    () => Response.json({ success: true }),
    () => new Response('{"error":"fake png"}', { headers: { "Content-Type": "image/png" } }),
    () => new Response(png, { status: 206, headers: { "Content-Type": "image/png" } }),
    () => new Response(png, { headers: { "Content-Type": "image/png", "Content-Range": "bytes 0-67/100" } }),
    () => new Response(null, { status: 410 }),
    () => new Response(png, { headers: { "Content-Type": "image/png", "Content-Length": String(png.length + 1) } }),
    () => new Response(png, { headers: { "Content-Type": "image/png", "Content-Length": String(20 * 1024 ** 2 + 1) } }),
    () => new Response(new Uint8Array(), { headers: { "Content-Type": "image/png" } }),
  ]) { const f = fixture(); f.response(response); await assert.rejects(f.prepare()); assert.equal(f.counts().signCalls, 0); assert.equal(f.calls.some(call => call.input.action === "prepare"), false); }
});

test("source video uses only the fixed owner proxy and clears Range/bearer input", async () => {
  const f = fixture(), bytes = Uint8Array.from([0, 0, 0, 16, 102, 116, 121, 112, 105, 115, 111, 109, 0, 0, 0, 0]);
  f.response(() => new Response(bytes, { headers: { "Content-Type": "video/mp4" } }));
  const result = await f.prepare({ ...f.request, reference: { kind: "video_task", id: "owner-video:1" } });
  assert.equal(result.bridge.state, "ready"); assert.equal(new URL(f.mainRequests[0].url).pathname, "/api/video/proxy"); assert.equal(new URL(f.mainRequests[0].url).search, "?id=owner-video%3A1&source=origin&forCapture=1"); assert.equal(f.record().snapshot.file.mime, "video/mp4");
});

test("every claimed phase is at most once after crash; unknown never re-signs or re-uploads", async () => {
  for (const failure of ["sign-before", "put-before", "confirm-before"] as const) {
    const f = fixture(); f.fail(failure); const first = await f.prepare(); assert.equal(first.bridge.state, "unknown");
    const before = f.counts(); f.fail(undefined); await f.prepare(); assert.equal(f.counts().signCalls, before.signCalls); assert.equal(f.counts().putCalls, before.putCalls); assert.equal(f.counts().confirmCalls, before.confirmCalls);
    assert.equal(f.record().dto.resultReference, null);
  }
});

test("a sign DTO or HTTP-like success without actual V3 ledger facts cannot authorize PUT", async () => {
  const f = fixture(); f.fail("sign-fake-200"); const result = await f.prepare();
  assert.equal(result.bridge.state, "unknown"); assert.equal(f.counts().putCalls, 0); assert.equal(f.counts().confirmCalls, 0); assert.equal(result.bridge.resultReference, null);
});

test("lost signature URL is never regenerated and eventually projects unknown without PUT", async () => {
  const f = fixture(); f.fail("sign-url-lost"); await assert.rejects(f.prepare(), errorCode("NATIVE_MAIN_BRIDGE_UPLOAD_URL_LOST"));
  f.stale(); f.fail(undefined); const observed = await f.prepare(); assert.equal(observed.bridge.state, "unknown"); assert.equal(f.counts().signCalls, 1); assert.equal(f.counts().putCalls, 0);
});

test("prepared-before-first-claim interruption can obtain only its original first grant on explicit same-key continuation", async () => {
  const f = fixture(); f.fail("claim-once"); await assert.rejects(f.prepare());
  assert.equal(f.record().dto.state, "prepared"); assert.equal(f.counts().signCalls, 0);
  const result = await f.prepare(); assert.equal(result.bridge.state, "ready"); assert.equal(f.counts().signCalls, 1); assert.equal(f.counts().putCalls, 1);
});

test("a persisted PUT with lost acknowledgement can obtain its first confirmation without another source download or PUT", async () => {
  const f = fixture(); f.fail("record-put-ack"); await assert.rejects(f.prepare());
  assert.equal(f.record().phases.put.state, "recorded"); assert.equal(f.record().phases.confirm.state, "pending"); const reads = f.mainRequests.length;
  const result = await f.prepare(); assert.equal(result.bridge.state, "ready"); assert.equal(f.counts().putCalls, 1); assert.equal(f.counts().signCalls, 1); assert.equal(f.counts().confirmCalls, 1); assert.equal(f.mainRequests.length, reads);
  assert.equal(f.calls.some(call => call.input.action === "invocation" && call.input.phase === "confirm" && call.input.dispatchId === null), true);
});

test("provider-confirmed ledger survives response loss and no re-confirmation occurs", async () => {
  const f = fixture(); f.fail("confirm-after"); const result = await f.prepare(); assert.equal(result.bridge.state, "ready");
  await f.prepare(); assert.equal(f.counts().confirmCalls, 1); assert.equal(f.proofs.length, 1);
});

test("namespace rotation after sign blocks a new PUT and preserves the original namespace", async () => {
  const f = fixture(); f.onSign(() => f.namespace(namespaceB));
  await f.prepare().catch(() => undefined); assert.equal(f.counts().signCalls, 1); assert.equal(f.counts().putCalls, 0); assert.equal(f.record().snapshot.namespace, namespaceA);
  const read = await readNativeMainMediaBridge(A, f.db, { bridgeId: f.record().dto.id }, f.options); assert.equal(read?.connectionCurrent, false);
});

test("namespace rotation during PUT preserves its real old receipt but cannot authorize confirmation", async () => {
  const f = fixture(), original = f.options.put!;
  f.options.put = async (...args) => { const result = await original(...args); f.namespace(namespaceB); return result; };
  await f.prepare().catch(() => undefined);
  assert.equal(f.proofs.length, 1); assert.equal(f.counts().putCalls, 1); assert.equal(f.counts().confirmCalls, 0); assert.equal(f.record().snapshot.namespace, namespaceA);
});

test("source change after sign cannot obtain a PUT grant and a non-2xx PUT can never be recorded as success", async () => {
  const f = fixture(); f.onSign(() => f.sourceFingerprint("b".repeat(64))); await f.prepare().catch(() => undefined); assert.equal(f.counts().putCalls, 0);
  const g = fixture(); g.options.put = async () => ({ httpStatus: 302 }); const result = await g.prepare();
  assert.equal(result.bridge.state, "unknown"); assert.equal(g.proofs.length, 0); assert.equal(g.counts().confirmCalls, 0);
});

test("actual body size is bounded even without Content-Length and cancellation cannot start a phase", async () => {
  const f = fixture(); f.response(() => new Response(new Uint8Array(20 * 1024 ** 2 + 1), { headers: { "Content-Type": "image/png" } }));
  await assert.rejects(f.prepare(), errorCode("NATIVE_MAIN_BRIDGE_SIZE_INVALID")); assert.equal(f.counts().signCalls, 0);
  const g = fixture(), controller = new AbortController(); g.options.signal = controller.signal; g.onRead(() => controller.abort());
  await assert.rejects(g.prepare()); assert.equal(g.calls.some(call => call.input.action === "claim-phase"), false);
});

test("permission revoked immediately before the first phase claim causes no provider call", async () => {
  const f = fixture(); f.denyAt(2); await assert.rejects(f.prepare()); assert.equal(f.counts().signCalls, 0); assert.equal(f.calls.some(call => call.input.action === "claim-phase"), false);
});

test("concurrent same-key imports share deterministic bridge identity and single-use phase grants", async () => {
  const f = fixture(); await Promise.allSettled([f.prepare(), f.prepare()]);
  assert.equal(new Set(f.calls.filter(call => call.input.action === "prepare").map(call => call.input.bridgeId)).size, 1);
  assert.equal(f.counts().signCalls, 1); assert.equal(f.counts().putCalls, 1); assert.equal(f.counts().confirmCalls, 1);
});

test("pending null invocation is read-only and a claimed phase rejects null", async () => {
  const f = fixture(); f.fail("claim-once"); await assert.rejects(f.prepare());
  const id = f.record().dto.id;
  const read = await f.db.rpc("read_native_media_bridge_atomic", { p_user_id: A.id, p_input: { action: "invocation", bridgeId: id, phase: "confirm", dispatchId: null, currentNamespace: namespaceA } } as never);
  assert.equal(read.error, null); assert.equal(object(read.data).phase && object(object(read.data).phase).dispatchId, null);
  f.fail("confirm-before"); await f.prepare();
  const after = await f.db.rpc("read_native_media_bridge_atomic", { p_user_id: A.id, p_input: { action: "invocation", bridgeId: id, phase: "confirm", dispatchId: null, currentNamespace: namespaceA } } as never);
  assert.ok(after.error); assert.equal(f.counts().confirmCalls, 1);
});

test("dedicated PUT pins one public DNS address and sends only fixed headers without redirects or credentials", async () => {
  let requestCalls = 0, endCalls = 0;
  const result = await putNativeMainMediaBridgeBytes("https://fixture.s3.amazonaws.com/owner-object?signature=fixture", png, "image/png", undefined, {
    lookup: async () => [{ address: "8.8.8.8", family: 4 }, { address: "1.1.1.1", family: 4 }],
    request: (options, callback) => {
      requestCalls++; assert.equal(options.method, "PUT"); assert.equal(options.hostname, "fixture.s3.amazonaws.com"); assert.equal(options.servername, options.hostname); assert.equal(options.family, 4);
      assert.deepEqual(options.headers, { "Content-Type": "image/png", "Content-Length": String(png.length) });
      const lookup = options.lookup as (hostname: string, options: object, callback: (error: unknown, address: string, family: number) => void) => void;
      lookup(String(options.hostname), {}, (error, address, family) => { assert.equal(error, null); assert.equal(address, "8.8.8.8"); assert.equal(family, 4); });
      const client = new EventEmitter() as EventEmitter & { setTimeout: () => unknown; end: (bytes: Uint8Array) => void; destroy: (error: Error) => void };
      client.setTimeout = () => client; client.destroy = error => { client.emit("error", error); };
      client.end = bytes => { endCalls++; assert.equal(hash(bytes), hash(png)); queueMicrotask(() => { const response = Object.assign(new EventEmitter(), { statusCode: 201 }); callback(response as IncomingMessage); response.emit("end"); }); };
      return client as unknown as ClientRequest;
    },
  });
  assert.equal(result.httpStatus, 201); assert.equal(requestCalls, 1); assert.equal(endCalls, 1);
});

test("PUT rejects unapproved destinations and any private DNS member before opening a socket", async () => {
  let sockets = 0, dns = 0;
  const credentialUrl = new URL("https://fixture.s3.amazonaws.com/upload");
  credentialUrl.username = "fixture-user"; credentialUrl.password = "fixture-password";
  const deps = { lookup: async () => { dns++; return [{ address: "8.8.8.8", family: 4 }, { address: "127.0.0.1", family: 4 }]; }, request: () => { sockets++; throw new Error("SOCKET_FORBIDDEN"); } };
  for (const url of ["http://fixture.s3.amazonaws.com/upload", credentialUrl.href, "https://fixture.s3.amazonaws.com:444/upload", "https://amazonaws.com.outside.example.com/upload", "https://127.0.0.1/upload"]) await assert.rejects(putNativeMainMediaBridgeBytes(url, png, "image/png", undefined, deps), errorCode("NATIVE_MAIN_BRIDGE_UPLOAD_TARGET_INVALID"));
  assert.equal(dns, 0);
  await assert.rejects(putNativeMainMediaBridgeBytes("https://fixture.s3.amazonaws.com/upload", png, "image/png", undefined, deps), errorCode("NATIVE_MAIN_BRIDGE_UPLOAD_TARGET_INVALID"));
  assert.equal(sockets, 0); assert.equal(dns, 1);
});

test("PUT transport failure never tries another DNS address or another request", async () => {
  let sockets = 0;
  await assert.rejects(putNativeMainMediaBridgeBytes("https://fixture.s3.amazonaws.com/upload", png, "image/png", undefined, { lookup: async () => [{ address: "8.8.8.8", family: 4 }, { address: "1.1.1.1", family: 4 }], request: () => { sockets++; const client = new EventEmitter() as EventEmitter & { setTimeout: () => unknown; end: () => void; destroy: (error: Error) => void }; client.setTimeout = () => client; client.destroy = error => { client.emit("error", error); }; client.end = () => queueMicrotask(() => client.emit("error", new Error("FIXTURE_SOCKET_FAILURE"))); return client as unknown as ClientRequest; } }), /FIXTURE_SOCKET_FAILURE/);
  assert.equal(sockets, 1);
});

test("PUT has a hard total deadline independently of socket idle time and never retries after timeout", async context => {
  context.mock.timers.enable({ apis: ["setTimeout"] }); let sockets = 0, client: EventEmitter | undefined;
  const promise = putNativeMainMediaBridgeBytes("https://fixture.s3.amazonaws.com/upload", png, "image/png", undefined, { lookup: async () => [{ address: "8.8.8.8", family: 4 }], request: () => {
    sockets++; const request = new EventEmitter() as EventEmitter & { setTimeout: () => unknown; end: () => void; destroy: (error: Error) => void }; client = request;
    request.setTimeout = () => request; request.end = () => {}; request.destroy = error => { request.emit("error", error); }; return request as unknown as ClientRequest;
  } });
  while (!client) await Promise.resolve();
  const rejected = assert.rejects(promise, /UPLOAD_TOTAL_TIMEOUT/); context.mock.timers.tick(300000); await rejected;
  assert.equal(sockets, 1);
});
