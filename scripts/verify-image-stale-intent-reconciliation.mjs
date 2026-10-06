import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";

const root = process.cwd();
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const migration = read("supabase/migrations/20260926090000_image_stale_intent_reconciliation.sql");
const rollback = read("supabase/rollbacks/20260926090000_image_stale_intent_reconciliation.rollback.sql");
const exactOnce = read("src/lib/image-exactly-once.ts");
const statusRoute = read("src/app/api/image/status/route.ts");
const rejectionSource = read("src/lib/image-request-rejection.ts");
const failureHistory = read("src/lib/image-failure-history.ts");

for (const source of [exactOnce, statusRoute, rejectionSource, failureHistory]) {
  const output = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    reportDiagnostics: true,
  });
  assert.equal((output.diagnostics || []).filter((entry) => entry.category === ts.DiagnosticCategory.Error).length, 0);
}

assert.match(migration, /FOR UPDATE;/u);
assert.match(migration, /p_stale_after_seconds < 600/u);
assert.match(migration, /v_request\.state NOT IN \('intent', 'failed_unknown'\)/u);
assert.match(migration, /v_request\.response IS NOT NULL/u);
assert.match(migration, /apply_wallet_operation_atomic\([\s\S]*?'cash_refund'[\s\S]*?v_billing_key \|\| ':release'/u);
assert.ok(migration.indexOf("apply_wallet_operation_atomic(") < migration.indexOf("UPDATE public.image_generation_requests"));
assert.match(migration, /'source', 'platform',[\s\S]*?'code', 'IMAGE_PLATFORM_REQUEST_INTERRUPTED'/u);
assert.match(migration, /REVOKE ALL ON FUNCTION[\s\S]*FROM PUBLIC, anon, authenticated/u);
assert.match(migration, /GRANT EXECUTE ON FUNCTION[\s\S]*TO service_role/u);
assert.match(rollback, /DROP FUNCTION IF EXISTS public\.reconcile_stale_image_generation_request_atomic/u);

assert.match(exactOnce, /rpc\("reconcile_stale_image_generation_request_atomic"/u);
assert.match(exactOnce, /reconciled\.payloadFingerprint !== record\.payloadFingerprint/u);
assert.match(statusRoute, /const STALE_IMAGE_INTENT_SECONDS = 10 \* 60/u);
assert.match(statusRoute, /record\.state === "intent" \|\| record\.state === "failed_unknown"/u);
assert.match(statusRoute, /!record\.response/u);
assert.match(statusRoute, /parseImageFailureRequestSnapshot\(record\.requestSnapshot\)/u);
assert.match(statusRoute, /store\.reconcileStaleIntent\(record, user\.id, STALE_IMAGE_INTENT_SECONDS\)/u);
assert.match(rejectionSource, /"IMAGE_PLATFORM_REQUEST_INTERRUPTED"/u);
assert.match(rejectionSource, /value\.source === "platform"/u);
assert.match(failureHistory, /费用已自动退回。请重新提交一次。/u);

// Compile just the dependency-free receipt parser and exercise the new bound
// terminal receipt without importing application aliases or touching network.
const parserJs = ts.transpileModule(rejectionSource, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const module = { exports: {} };
vm.runInNewContext(`(function(module,exports){${parserJs}\n})(module,module.exports);`, {
  module,
  exports: module.exports,
});
const fingerprint = "a".repeat(64);
const parsed = module.exports.parseImageRequestRejectionReceipt({
  schema: "image_request_rejection.v1",
  payloadFingerprint: fingerprint,
  source: "platform",
  code: "IMAGE_PLATFORM_REQUEST_INTERRUPTED",
}, fingerprint);
assert.equal(JSON.stringify(parsed), JSON.stringify({ source: "platform", code: "IMAGE_PLATFORM_REQUEST_INTERRUPTED" }));
assert.equal(module.exports.parseImageRequestRejectionReceipt({
  schema: "image_request_rejection.v1",
  payloadFingerprint: "b".repeat(64),
  source: "platform",
  code: "IMAGE_PLATFORM_REQUEST_INTERRUPTED",
}, fingerprint), null);

console.log(JSON.stringify({
  passed: 21,
  networkCalls: 0,
  databaseWrites: 0,
  staleAfterSeconds: 600,
  checks: [
    "row-lock", "minimum-age", "intent-or-unknown-only", "no-response-only",
    "idempotent-refund", "refund-before-terminal", "platform-terminal-receipt",
    "service-role-only", "rollback", "store-rpc", "identity-fence", "status-age",
    "status-state", "status-no-response", "status-valid-snapshot", "status-reconcile", "typed-code",
    "typed-source", "failure-message", "parser-valid", "parser-fingerprint-bound",
  ],
}));
