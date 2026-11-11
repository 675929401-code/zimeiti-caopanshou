import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { NativeMediaSourceSchema } from "../src/lib/native-main-media-contract";

const migration = readFileSync(new URL("../supabase/migrations/20261110130000_native_main_media_references.sql", import.meta.url), "utf8");
const rollback = readFileSync(new URL("../supabase/rollbacks/20261110130000_native_main_media_references.rollback.sql", import.meta.url), "utf8");
const fixture = readFileSync(new URL("./native-main-media-references.fixture.sql", import.meta.url), "utf8");
const id = "00000000-0000-4000-8000-000000000001";

test("source union excludes URLs, mixed provider/main identities and image_gallery", () => {
  assert(NativeMediaSourceSchema.safeParse({ kind: "provider_asset", assetId: id }).success);
  assert(NativeMediaSourceSchema.safeParse({ kind: "main_asset", reference: { kind: "image_asset", id } }).success);
  for (const source of [{ kind: "main_asset", assetId: id, reference: { kind: "image_asset", id } }, { kind: "provider_asset", assetId: id, reference: { kind: "image_record", id: "record" } }, { kind: "main_asset", reference: { kind: "image_gallery", id, index: 0 } }, { kind: "main_asset", reference: { kind: "image_record", id: "https://evil.example" } }]) assert(!NativeMediaSourceSchema.safeParse(source).success);
  assert.match(migration, /native_media_source_xor CHECK\(\(/);
  assert.match(migration, /IS TRUE\)/);
});

test("forward migration keeps V1 validation and old CRUD through private delegates", () => {
  assert.match(migration, /RENAME TO native_assert_draft_metadata_v1/);
  assert.match(migration, /PERFORM public\.native_assert_draft_metadata_v1\(p,d,p_user_id,p_connection\)/);
  assert.match(migration, /RENAME TO mutate_native_core_v1_atomic/);
  assert.match(migration, /RETURN public\.mutate_native_core_v1_atomic\(p_user_id,p_input\)/);
  assert.match(migration, /REVOKE ALL ON FUNCTION public\.mutate_native_core_v1_atomic\(text,jsonb\) FROM PUBLIC,anon,authenticated,service_role/);
  assert(!/INSERT INTO public\.pub3_assets/i.test(migration));
  assert.match(migration, /PERFORM public\.pub2_assert_media/);
});

test("clone copies exact source fields and fixture covers owner, CAS, usage and rollback", () => {
  assert.match(migration, /VALUES\(p_user_id,entry\.asset_id,entry\.source_kind,entry\.main_reference,collection,entry\.title,true,entry\.id\)/);
  assert.match(migration, /NATIVE_MEDIA_SOURCE_IMMUTABLE/);
  assert.match(fixture, /existing usage attribution survives media move/);
  assert.match(fixture, /main ledger source cannot cross members/);
  assert.match(fixture, /ROLLBACK;\s*$/);
  assert.match(rollback, /NATIVE_MEDIA_ROLLBACK_REQUIRES_PRESERVED_HISTORY/);
  assert(!/\bCASCADE\s*;/i.test(rollback));
});

test("V2 publish preparation and usage require exact source provenance", () => {
  assert.match(migration, /RENAME TO mutate_native_auxiliary_v1_atomic/);
  assert.match(migration, /public\.native_media_mapping_source\(x\)=public\.native_media_entry_source\(entry\)/);
  assert.match(migration, /RENAME TO native_core_media_usage_facts_v1/);
  assert.match(migration, /source_attribution_incomplete/);
  assert.match(migration, /WHEN EXISTS\(SELECT 1 FROM unproven\) THEN NULL/);
  assert.match(fixture, /main V2 browser reports stay separate and unbridged official receipt stays unknown/);
  assert.match(fixture, /V1 provider usage retains exact original result/);
  assert.match(rollback, /RENAME TO mutate_native_auxiliary_atomic/);
  assert.match(rollback, /RENAME TO native_core_media_usage_facts/);
});

test("official bridge gate covers direct SQL entry points while retaining issued replay", () => {
  assert.match(migration, /RENAME TO mutate_publish_v3_media_v1_atomic/);
  assert.match(migration, /m\.owner_id=p_owner AND m\.draft_id=p_draft AND m\.draft_version=p_version AND m\.payload->'schemaVersion'='2'::jsonb/);
  assert.match(migration, /NATIVE_MAIN_BRIDGE_REQUIRED/);
  assert.match(migration, /op\.kind='publish' AND NOT op\.grant_used/);
  assert.match(fixture, /main reference used only as official cover still requires bridge/);
  assert.match(fixture, /unconsumed native main operation grant stays blocked/);
  assert.match(fixture, /already-issued original operation exact-key replay remains readable/);
  assert.match(rollback, /RENAME TO mutate_publish_v3_atomic/);
});
