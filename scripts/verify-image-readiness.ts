import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { evaluateImageGenerationReadiness } from "@/lib/image-generation-readiness";
import type { ProductionDatabaseReadiness } from "@/lib/production-database-readiness";

const complete: ProductionDatabaseReadiness = {
  ok: true, state: "ready", contractId: "fixture", contractVersion: "fixture", tableCount: 0, rpcCount: 0,
  missingTables: [], missingColumns: [], missingRpcs: [], missingRpcArguments: [], forbiddenRpcsPresent: [],
};
const cos = { initializedProviders: ["tencent_cos"] };
function missing(patch: Partial<ProductionDatabaseReadiness>): ProductionDatabaseReadiness {
  return {
    ...complete, ok: false, state: "migration-not-ready", code: "PRODUCTION_SCHEMA_MIGRATION_NOT_READY",
    error: "fixture missing schema", ...patch,
  } as ProductionDatabaseReadiness;
}
function expectCode(database: ProductionDatabaseReadiness, code: string, requiresBilling = true) {
  const result = evaluateImageGenerationReadiness(database, cos, requiresBilling);
  assert.equal(result.ready, false);
  assert.equal(!result.ready && result.code, code);
}

assert.deepEqual(evaluateImageGenerationReadiness(complete, cos, true), { ready: true });
expectCode(missing({ missingTables: ["image_generation_requests"] }), "IMAGE_IDEMPOTENCY_MIGRATION_NOT_READY");
expectCode(missing({ missingRpcs: ["save_image_generation_request"] }), "IMAGE_IDEMPOTENCY_MIGRATION_NOT_READY");
expectCode(missing({ missingRpcs: ["finalize_image_generation_delivery"] }), "IMAGE_IDEMPOTENCY_MIGRATION_NOT_READY");
expectCode(missing({ missingColumns: ["image_generation_requests.delivery_asset_id"] }), "IMAGE_IDEMPOTENCY_MIGRATION_NOT_READY");
expectCode(missing({ missingColumns: ["user_files.storage_provider"] }), "IMAGE_IDEMPOTENCY_MIGRATION_NOT_READY");
expectCode(missing({ missingRpcArguments: ["finalize_image_generation_delivery.p_user_id"] }), "IMAGE_IDEMPOTENCY_MIGRATION_NOT_READY");
expectCode(missing({ missingRpcs: ["apply_wallet_operation_atomic"] }), "BILLING_LEDGER_UNAVAILABLE");
expectCode(missing({ missingTables: ["cash_debt_records"] }), "BILLING_LEDGER_UNAVAILABLE");
expectCode(missing({ missingTables: ["wallet_ledger_entries"] }), "BILLING_LEDGER_UNAVAILABLE");
expectCode(missing({ missingTables: ["postgrest-openapi"] }), "IMAGE_PREREQUISITE_PROBE_UNAVAILABLE");
expectCode({
  ...complete, ok: false, state: "probe-unavailable", code: "PRODUCTION_SCHEMA_PROBE_UNAVAILABLE",
  error: "fixture probe unavailable",
}, "IMAGE_PREREQUISITE_PROBE_UNAVAILABLE");
assert.deepEqual(evaluateImageGenerationReadiness(missing({ missingRpcs: ["apply_wallet_operation_atomic"] }), cos, false), { ready: true });
assert.deepEqual(evaluateImageGenerationReadiness(missing({
  missingTables: ["short_drama_projects"], missingRpcs: ["publish_skill_package"],
  missingColumns: ["manju_admin_config.version"], missingRpcArguments: ["publish_skill_package.p_id"],
}), cos, true), { ready: true }, "unrelated module migrations must not block image generation");
const missingStorage = evaluateImageGenerationReadiness(complete, { initializedProviders: ["local"] }, true);
assert.equal(!missingStorage.ready && missingStorage.code, "IMAGE_STORAGE_NOT_READY");
const staleSchema = evaluateImageGenerationReadiness(complete, cos, true, [
  { name: "image_generation_requests", ready: false, code: "42703" },
]);
assert.equal(!staleSchema.ready && staleSchema.code, "IMAGE_IDEMPOTENCY_MIGRATION_NOT_READY");
const unavailableRead = evaluateImageGenerationReadiness(complete, cos, true, [
  { name: "user_files", ready: false, code: "READ_FAILED" },
]);
assert.equal(!unavailableRead.ready && unavailableRead.code, "IMAGE_PREREQUISITE_PROBE_UNAVAILABLE");
assert.deepEqual(evaluateImageGenerationReadiness(complete, cos, false, [
  { name: "wallet_operations", ready: false, code: "42P01" },
]), { ready: true });

// Supplemental wiring assertions keep the tested decision before the first side effect.
const route = readFileSync("src/app/api/image/generate/route.ts", "utf8");
const handler = route.slice(route.indexOf("export async function POST"));
assert.ok(handler.indexOf("probeImageGenerationReadiness(!isAdmin)") < handler.indexOf("await checkAndCollectDebt(userId)"));
assert.ok(handler.indexOf("probeImageGenerationReadiness(!isAdmin)") < handler.indexOf("await runImageExactlyOnce({"));
assert.ok(handler.indexOf("debtResult.availableBalance < sellingPrice") < handler.indexOf("await runImageExactlyOnce({"));
console.log(JSON.stringify({
  ok: true, mode: "pure-decision-fixtures-plus-route-wiring", cases: 18,
  providerCalls: 0, databaseWrites: 0, realGenerationVerified: false,
}, null, 2));
