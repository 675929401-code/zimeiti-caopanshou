import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { nativeAiCanonical, nativeAiHash, NativeAiActionSnapshotSchema } from "../src/lib/native-ai-contract";
import { getVideoTokenPublicPricing } from "../src/lib/video-token-billing";

const migration = readFileSync(new URL("../supabase/migrations/20261110120000_native_ai_durable_actions.sql", import.meta.url), "utf8");
const rollback = readFileSync(new URL("../supabase/rollbacks/20261110120000_native_ai_durable_actions.rollback.sql", import.meta.url), "utf8");
const fixture = readFileSync(new URL("./native-ai-durable-actions.fixture.sql", import.meta.url), "utf8");

test("durable SQL exposes only two service mutation/read entry points and seven owner tables", () => {
  assert.deepEqual([...migration.matchAll(/CREATE TABLE public\.(pub_native_ai_\w+)/g)].map(match => match[1]), ["pub_native_ai_batches", "pub_native_ai_items", "pub_native_ai_actions", "pub_native_ai_slots", "pub_native_ai_requests", "pub_native_ai_events", "pub_native_ai_publish_manifests"]);
  assert.equal((migration.match(/SECURITY DEFINER/g) ?? []).length, 2);
  assert.match(migration, /ALTER TABLE public\.%I ENABLE ROW LEVEL SECURITY/);
  assert.match(migration, /REVOKE ALL ON TABLE public\.%I FROM PUBLIC,anon,authenticated,service_role/);
  assert.match(migration, /GRANT SELECT ON TABLE public\.%I TO service_role/);
  assert.deepEqual([...migration.matchAll(/GRANT EXECUTE ON FUNCTION public\.(\w+)/g)].map(match => match[1]), ["mutate_native_ai_atomic", "read_native_ai_atomic"]);
  assert(!/UPDATE\s+public\.users|INSERT\s+INTO\s+public\.(?:cash_transactions|revenue_records)|(?:reserve|settle|refund|purchase)_\w+\s*\(/i.test(migration));
});

test("dispatch and admission replay outputs remove their one-use permissions", () => {
  assert.match(migration, /jsonb_set\(r\.result,'\{shouldDispatch\}','false'\)/);
  assert.match(migration, /jsonb_set\(r\.result,'\{admission,newlyAdmitted\}','false'\)/);
  assert.match(migration, /IF s\.dispatch_id IS NOT NULL THEN v_dispatch:=false/);
  assert.match(migration, /Absence never restores a dispatch grant/);
  assert.match(fixture, /missing upstream record never restores dispatch/);
  assert.match(fixture, /batch budget includes prior unknown admissions/);
  assert.match(fixture, /ROLLBACK;\s*$/);
  assert(!/\bCOMMIT\s*;/i.test(fixture));
});

test("agent action listing checks the real task owner and uses stable bounded pagination", () => {
  assert.match(migration, /WHEN 'actions-for-task' THEN allowed:=ARRAY\['action','taskId','page','pageSize'\]/);
  assert.match(migration, /pub_native_agent_tasks WHERE owner_id=p_user_id AND id=\(p_input->>'taskId'\)::uuid/);
  assert.match(migration, /pub_native_ai_actions WHERE owner_id=p_user_id AND task_id=\(p_input->>'taskId'\)::uuid ORDER BY created_at DESC,id LIMIT v_size/);
  assert.match(migration, /native_ai_integer\(p_input->'pageSize',1,50\)/);
});

test("cross-language fixture has independently fixed canonical text and Decimal6 strings", async () => {
  const value = { z: [{ b: 2, a: "中" }], a: "0.000001", quote: { maxAmount: "1", quotedAmount: "0.6" } };
  const expected = '{"a":"0.000001","quote":{"maxAmount":"1","quotedAmount":"0.6"},"z":[{"a":"中","b":2}]}';
  assert.equal(nativeAiCanonical(value), expected);
  assert(fixture.includes(expected));
  assert.match(await nativeAiHash(value), /^[a-f0-9]{64}$/);
  // SQL preserves the server's digest and compares immutable JSON; it never
  // substitutes jsonb::text for JavaScript canonical action or wire hashing.
  assert.match(migration, /a\.snapshot IS DISTINCT FROM p_snapshot/);
  assert(!/p_hash IS DISTINCT FROM public\.native_ai_hash\(p_snapshot\)/.test(migration));
});

test("rollback refuses to erase operation history and local publishing stays a confirmation handoff", () => {
  assert.match(rollback, /NATIVE_AI_ROLLBACK_REQUIRES_PRESERVED_HISTORY/);
  assert.match(rollback, /to_regprocedure\('public\.native_media_register_source\(text,uuid,jsonb,text\)'\)/);
  assert.match(rollback, /NATIVE_AI_ROLLBACK_REQUIRES_MEDIA_130000_FIRST/);
  assert(!/\bCASCADE\s*;/i.test(rollback));
  assert.match(migration, /native-ai-publish-manifest\.v1/);
  assert.match(migration, /awaiting_user_confirmation/);
  assert.match(migration, /request_payload' IS DISTINCT FROM s\.wire_request-ARRAY\['requestKey','requestHash','connectionId'\]/);
  assert.equal(NativeAiActionSnapshotSchema.shape.version.value, "native-ai-action.v1");
});

test("tokenBilling fixture uses the real public video price-version producer", () => {
  const pricing = getVideoTokenPublicPricing({ api_protocol_config: { token_sale_prices_per_million: { "720p:no_reference_video": 12, "720p:reference_video": 18 } } });
  assert(pricing);
  assert(fixture.includes(pricing.priceVersion));
  assert.match(migration, /video_token_sale\.v1:/);
  assert.match(migration, /maxChargeYuan.*9007199254740991/);
  assert.match(migration, /count\(\*\) FROM jsonb_object_keys\(v\)\)<>2/);
});
