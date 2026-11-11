import assert from "node:assert/strict";
import test from "node:test";
import {
  NativeMainMediaBridgeRequestSchema, NativeMainMediaBridgeQuerySchema, NativeMainMediaBridgeSnapshotSchema,
  NativeMainMediaBridgeDtoSchema, NativeMainMediaBridgeFileSchema, NativeMainMediaBridgeLookupSchema,
  nativeMainMediaBridgeMagicMatches, nativeMainMediaBridgeCanonical,
  NATIVE_MAIN_BRIDGE_MAX_IMAGE_BYTES, NATIVE_MAIN_BRIDGE_MAX_VIDEO_BYTES,
} from "../src/lib/native-main-media-bridge-contract";

const uuid = (n: number) => `70000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const reference = { kind: "image_record", id: "fixture-image:1" } as const;
const request = { requestKey: "fixture-bridge-request", reference, mediaId: uuid(1) };
const file = { mime: "image/png", size: 68, sha256: "a".repeat(64) };
const snapshot = { version: 1, reference, mediaId: uuid(1), namespace: `domestic:${"a".repeat(24)}`, sourceFingerprint: "b".repeat(64), file: { ...file, fileName: `native-bridge-${uuid(2)}.png` } };
const dto = { id: uuid(2), requestKey: request.requestKey, reference, mediaId: request.mediaId, state: "prepared", revision: 1, phase: null, file, connectionCurrent: true, resultReference: null, errorCode: null, createdAt: "2026-11-10T00:00:00.000Z", updatedAt: "2026-11-10T00:00:00.000Z" };
const fetchOriginal = globalThis.fetch; let network = 0;
test.before(() => { globalThis.fetch = async () => { network++; throw new Error("NETWORK_FORBIDDEN_IN_BRIDGE_CONTRACT_TEST"); }; });
test.after(() => { globalThis.fetch = fetchOriginal; assert.equal(network, 0); });

test("public import accepts only request key, exact owned reference and stable media identity", () => {
  assert.deepEqual(NativeMainMediaBridgeRequestSchema.parse(request), request);
  for (const extra of [{ namespace: "override" }, { sourceFingerprint: "b".repeat(64) }, { assetId: uuid(8) }, { uploadUrl: "https://outside.example.com" }, { ownerId: uuid(9) }, { file }]) assert.equal(NativeMainMediaBridgeRequestSchema.safeParse({ ...request, ...extra }).success, false);
  assert.equal(NativeMainMediaBridgeRequestSchema.safeParse({ ...request, reference: { kind: "image_record", id: "https://outside.example.com/file" } }).success, false);
  assert.equal(NativeMainMediaBridgeRequestSchema.safeParse({ ...request, mediaId: "provider-remote-id" }).success, false);
});

test("GET has exactly one local lookup dimension and never accepts a remote/provider ID", () => {
  assert.ok(NativeMainMediaBridgeQuerySchema.safeParse({ requestKey: request.requestKey }).success);
  assert.ok(NativeMainMediaBridgeQuerySchema.safeParse({ bridgeId: uuid(2) }).success);
  for (const value of [{}, { bridgeId: uuid(2), requestKey: request.requestKey }, { assetId: uuid(4) }, { bridgeId: "remote-provider-id" }, { requestKey: request.requestKey, namespace: "override" }]) assert.equal(NativeMainMediaBridgeQuerySchema.safeParse(value).success, false);
});

test("snapshot fixes source kind, filename extension, actual bounds and a 200-character namespace", () => {
  assert.ok(NativeMainMediaBridgeSnapshotSchema.safeParse(snapshot).success);
  for (const change of [{ namespace: "x".repeat(201) }, { sourceFingerprint: "not-a-digest" }, { file: { ...snapshot.file, fileName: "outside.png" } }, { file: { ...snapshot.file, mime: "image/jpeg" } }, { reference: { kind: "video_task", id: "video:1" } }, { url: "https://outside.example.com" }]) assert.equal(NativeMainMediaBridgeSnapshotSchema.safeParse({ ...snapshot, ...change }).success, false);
  assert.ok(NativeMainMediaBridgeFileSchema.safeParse({ ...file, size: NATIVE_MAIN_BRIDGE_MAX_IMAGE_BYTES }).success);
  assert.equal(NativeMainMediaBridgeFileSchema.safeParse({ ...file, size: NATIVE_MAIN_BRIDGE_MAX_IMAGE_BYTES + 1 }).success, false);
  assert.ok(NativeMainMediaBridgeFileSchema.safeParse({ ...file, mime: "video/mp4", size: NATIVE_MAIN_BRIDGE_MAX_VIDEO_BYTES }).success);
  assert.equal(NativeMainMediaBridgeFileSchema.safeParse({ ...file, mime: "video/mp4", size: NATIVE_MAIN_BRIDGE_MAX_VIDEO_BYTES + 1 }).success, false);
  for (const mime of ["image/webp", "image/svg+xml", "application/json", "application/octet-stream"]) assert.equal(NativeMainMediaBridgeFileSchema.safeParse({ ...file, mime }).success, false);
});

test("only confirmed ready bridges expose a local provider asset result and retain the approved media ID", () => {
  assert.ok(NativeMainMediaBridgeDtoSchema.safeParse(dto).success);
  const resultReference = { kind: "provider_asset", assetId: uuid(3), mediaId: request.mediaId };
  assert.equal(NativeMainMediaBridgeDtoSchema.safeParse({ ...dto, resultReference }).success, false);
  assert.equal(NativeMainMediaBridgeDtoSchema.safeParse({ ...dto, state: "ready" }).success, false);
  assert.ok(NativeMainMediaBridgeDtoSchema.safeParse({ ...dto, state: "ready", connectionCurrent: false, resultReference }).success);
  assert.equal(NativeMainMediaBridgeDtoSchema.safeParse({ ...dto, state: "ready", resultReference: { ...resultReference, mediaId: uuid(90) } }).success, false);
  assert.equal(NativeMainMediaBridgeDtoSchema.safeParse({ ...dto, state: "ready", resultReference: { ...resultReference, assetId: "remote-provider-id" } }).success, false);
  for (const extra of [{ namespace: snapshot.namespace }, { snapshot }, { uploadUrl: "https://outside.example.com" }, { providerAssetId: "remote-id" }]) assert.equal(NativeMainMediaBridgeDtoSchema.safeParse({ ...dto, ...extra }).success, false);
});

test("lookup false cannot conceal a partial or malformed successful receipt", () => {
  assert.deepEqual(NativeMainMediaBridgeLookupSchema.parse({ found: false }), { found: false });
  assert.ok(NativeMainMediaBridgeLookupSchema.safeParse({ found: true, bridge: dto }).success);
  for (const value of [{ found: true }, { found: false, bridge: dto }, { found: true, bridge: { ...dto, revision: 0 } }, { found: false, error: "db unavailable" }]) assert.equal(NativeMainMediaBridgeLookupSchema.safeParse(value).success, false);
});

test("canonical snapshots reject hidden non-JSON values and retain ordered facts", () => {
  assert.equal(nativeMainMediaBridgeCanonical({ b: 1, a: 2 }), nativeMainMediaBridgeCanonical({ a: 2, b: 1 }));
  assert.notEqual(nativeMainMediaBridgeCanonical([1, 2]), nativeMainMediaBridgeCanonical([2, 1]));
  for (const value of [{ x: undefined }, new Array(1), { n: Number.NaN }]) assert.throws(() => nativeMainMediaBridgeCanonical(value));
});

test("actual MIME must agree with closed PNG/JPEG/MP4 container signatures", () => {
  const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const jpeg = Uint8Array.from([255, 216, 255, 224]);
  const mp4 = Uint8Array.from([0, 0, 0, 16, 102, 116, 121, 112, 105, 115, 111, 109, 0, 0, 0, 0]);
  assert.ok(nativeMainMediaBridgeMagicMatches("image/png", png)); assert.ok(nativeMainMediaBridgeMagicMatches("image/jpeg", jpeg)); assert.ok(nativeMainMediaBridgeMagicMatches("video/mp4", mp4));
  assert.equal(nativeMainMediaBridgeMagicMatches("image/png", jpeg), false); assert.equal(nativeMainMediaBridgeMagicMatches("image/jpeg", png), false);
  for (const value of [new TextEncoder().encode('{"success":true}'), new Uint8Array(), Uint8Array.from([...mp4.slice(0, 8), 104, 101, 105, 99, 0, 0, 0, 0]), Uint8Array.from([0, 0, 0, 30, ...mp4.slice(4)])]) assert.equal(nativeMainMediaBridgeMagicMatches("video/mp4", value), false);
});
