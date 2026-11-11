import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { NativeMainMediaBridgeRequestSchema, NativeMainMediaBridgeSnapshotSchema } from "../src/lib/native-main-media-bridge-contract";
const migration = readFileSync(new URL("../supabase/migrations/20261110141000_native_main_media_bridge.sql", import.meta.url), "utf8");
const rollback = readFileSync(new URL("../supabase/rollbacks/20261110141000_native_main_media_bridge.rollback.sql", import.meta.url), "utf8");
const mediaRollback = readFileSync(new URL("../supabase/rollbacks/20261110130000_native_main_media_references.rollback.sql", import.meta.url), "utf8");
const id = "00000000-0000-4000-8000-000000000001";
const publicRequest = { requestKey: "bridge-fixture-0001", reference: { kind: "image_asset", id }, mediaId: id };
test("public bridge request cannot provide namespace, credentials or caller-declared byte proof", () => {
  assert(NativeMainMediaBridgeRequestSchema.safeParse(publicRequest).success);
  for (const extra of [{ namespace: "arbitrary" }, { sourceFingerprint: "a".repeat(64) }, { assetId: id }, { uploadUrl: "https://example.invalid" }, { file: { sha256: "a".repeat(64) } }]) assert(!NativeMainMediaBridgeRequestSchema.safeParse({ ...publicRequest, ...extra }).success);
  assert.match(migration, /CREATE FUNCTION public\.native_media_source_fingerprint/u);
  assert.match(migration, /'version',1,'owner',p_owner,'reference',p_reference,'facts',facts/u);
});
test("source snapshots use exact safe file types, limits and immutable server-generated identity", () => {
  const snapshot = { version: 1, reference: publicRequest.reference, mediaId: id, namespace: "fixture", sourceFingerprint: "a".repeat(64), file: { fileName: `native-bridge-${id}.png`, mime: "image/png", size: 16, sha256: "b".repeat(64) } };
  assert(NativeMainMediaBridgeSnapshotSchema.safeParse(snapshot).success);
  assert(!NativeMainMediaBridgeSnapshotSchema.safeParse({ ...snapshot, file: { ...snapshot.file, size: 20971521 } }).success);
  assert(!NativeMainMediaBridgeSnapshotSchema.safeParse({ ...snapshot, file: { ...snapshot.file, mime: "image/webp", fileName: `native-bridge-${id}.webp` } }).success);
  assert.match(migration, /NATIVE_BRIDGE_HISTORY_IMMUTABLE/u);
  assert.match(migration, /UNIQUE\(owner_id,namespace,media_id\)/u);
});
test("phase replay removes dispatch permission and does not reset a consumed claim", () => {
  assert.match(migration, /jsonb_set\(prior\.result,'\{shouldDispatch\}','false'\)/u);
  assert.match(migration, /IF p\.dispatch_id IS NOT NULL THEN result/u);
  assert(!/SET[^;]*dispatch_id\s*=\s*NULL/iu.test(migration));
  assert.match(migration, /state='pending' AND dispatch_id IS NULL/u);
  assert.match(migration, /NATIVE_BRIDGE_NAMESPACE_CHANGED/u);
});
test("ordinary V3 cannot acquire a reserved upload URL and private V3 requires exact grant binding", () => {
  assert.match(migration, /LIKE 'native-bridge-%'/u);
  assert.match(migration, /p\.operation_id=op\.id AND p\.asset_id=op\.subject_id AND p\.operation_request_key=op\.request_key/u);
  assert.match(migration, /result:=public\.mutate_publish_v3_media_v1_atomic\(p_user_id,v3\)/u);
  assert.match(migration, /v3->>'connectionId' IS DISTINCT FROM b\.namespace/u);
});
test("ready and official attribution depend on all three receipts and exact asset bytes", () => {
  assert.match(migration, /'server_put_ack'/u);
  assert.match(migration, /'provider_confirm'/u);
  assert.match(migration, /op\.grant_used AND op\.dispatch_state='settled'/u);
  assert.match(migration, /count\(\*\)=3 AND bool_and\(state='recorded'\)/u);
  assert.match(migration, /p_asset->'sha256'=b\.snapshot->'file'->'sha256'/u);
  assert(!/SET hash_source/iu.test(migration));
});
test("rollback preserves bridge history and enforces bridge before media reverse order", () => {
  assert.match(rollback, /NATIVE_BRIDGE_ROLLBACK_REQUIRES_PRESERVED_HISTORY/u);
  assert.match(mediaRollback, /NATIVE_MEDIA_ROLLBACK_REQUIRES_BRIDGE_141000_FIRST/u);
  assert.match(rollback, /CREATE OR REPLACE FUNCTION public\.mutate_publish_v3_atomic/u);
  assert(!/\bCASCADE\s*;/iu.test(rollback));
  assert.match(migration, /GRANT EXECUTE ON FUNCTION public\.mutate_native_media_bridge_atomic\(text,jsonb\) TO service_role/u);
});
