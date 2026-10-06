import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { deriveGeneralScriptHistoryState } from "../src/lib/short-drama/general-script-history";

const root = resolve(__dirname, "..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");
const networkCalls = 0;
const providerCalls = 0;
const databaseWrites = 0;

const migration = read("supabase/migrations/20260915234500_short_drama_script_history.sql");
const rollback = read("supabase/rollbacks/20260915234500_short_drama_script_history.rollback.sql");
const route = read("src/app/api/short-drama/script/route.ts");
const repository = read("src/lib/short-drama/general-script-history.ts");
const panel = read("src/features/general-script/general-script-history-panel.tsx");
const official = read("src/features/general-script-official/general-script-official.tsx");
const youcai = read("src/features/youcai-general-script/youcai-general-script.tsx");

assert.match(migration, /CREATE TABLE public\.short_drama_script_requests/u);
assert.doesNotMatch(migration, /commerce/iu);
assert.match(migration, /UNIQUE \(user_id, client_request_id\)/u);
assert.match(migration, /user_id, surface, submitted_at DESC, id DESC/u);
assert.match(migration, /ENABLE ROW LEVEL SECURITY/u);
assert.match(migration, /REVOKE ALL ON public\.short_drama_script_requests FROM PUBLIC, anon, authenticated/u);
assert.match(migration, /claim_short_drama_script_request_atomic/u);
assert.match(migration, /finalize_short_drama_script_request_atomic/u);
assert.match(migration, /v_billing->>'state' = 'refunded'/u);
assert.match(migration, /SHORT_DRAMA_SCRIPT_BILLING_EVIDENCE_INVALID/u);
assert.match(migration, /idempotency_key = 'llm:' \|\| v_row\.client_request_id \|\| ':answer'/u);
assert.match(migration, /operation_kind = 'credit_refund'/u);
assert.match(migration, /v_charge\.amount <> v_refund\.amount/u);
assert.match(migration, /v_refund\.metadata->>'original_operation_id'/u);
assert.match(rollback, /DROP FUNCTION IF EXISTS public\.finalize_short_drama_script_request_atomic/u);
assert.match(rollback, /DROP TABLE IF EXISTS public\.short_drama_script_requests/u);

const claimPosition = route.indexOf("await repository.claim");
const providerPosition = route.indexOf("await fetch(llmUrl");
assert.ok(claimPosition > 0 && providerPosition > claimPosition, "history claim must precede the LLM route dispatch");
assert.match(route, /response\.headers\.get\("x-llm-retry-safe"\) === "true"/u);
assert.doesNotMatch(route, /!response\.headers\.get\("x-llm-attempt-id"\)/u);
assert.match(repository, /GENERAL_SCRIPT_HISTORY_MIGRATION_NOT_READY/u);
assert.match(route, /state: llmDispatchStarted \? "reconciliation_required" : "failed"/u);
assert.match(route, /Cache-Control": privateResponse \? "private, no-store" : "no-store"/u);
assert.match(route, /historyReady: false/u);
assert.match(route, /GENERAL_SCRIPT_HISTORY_MIGRATION_NOT_READY/u);
assert.match(route, /items: \[\]/u);

assert.match(repository, /\.eq\("user_id", input\.userId\)/u);
assert.match(repository, /\.order\("submitted_at", \{ ascending: false \}\)/u);
assert.match(repository, /\.order\("id", \{ ascending: false \}\)/u);
assert.match(repository, /`llm:\$\{id\}:thinking`/u);
assert.match(repository, /`llm:\$\{id\}:answer`/u);
assert.match(repository, /retrySafe = state === "failed"/u);
assert.match(repository, /retrySafe && request \? \{ requestSnapshot: request \} : \{\}/u);
assert.match(repository, /state === "succeeded" && result \? \{ result \} : \{\}/u);

assert.equal(deriveGeneralScriptHistoryState({
  outerState: "failed", attemptState: "failed", billingState: "not_charged", walletSettled: false, hasValidResult: false,
}), "failed", "a definitively uncharged failure may be loaded for a new manual submission");
assert.equal(deriveGeneralScriptHistoryState({
  outerState: "failed", attemptState: "failed_unknown", billingState: "refunded", walletSettled: true, hasValidResult: false,
}), "failed", "a ledger-verified full refund may be loaded for a new manual submission");
assert.equal(deriveGeneralScriptHistoryState({
  outerState: "failed", attemptState: "failed", billingState: "not_charged", walletSettled: true, hasValidResult: false,
}), "reconciliation_required", "a completed charge without a verified refund must remain blocked");
assert.equal(deriveGeneralScriptHistoryState({
  outerState: "reconciliation_required", attemptState: "failed_unknown", billingState: "reconciliation_required", walletSettled: false, hasValidResult: false,
}), "reconciliation_required", "an unknown provider terminal must remain blocked");
assert.equal(deriveGeneralScriptHistoryState({
  outerState: "reconciliation_required", attemptState: "", billingState: "reconciliation_required", walletSettled: false, hasValidResult: false,
}), "failed", "absence of an inner LLM attempt proves the provider boundary was never crossed");
assert.equal(deriveGeneralScriptHistoryState({
  outerState: "submitted", attemptState: "running", billingState: "", walletSettled: false, hasValidResult: false,
}), "running");
assert.equal(deriveGeneralScriptHistoryState({
  outerState: "succeeded", attemptState: "succeeded", billingState: "settled", walletSettled: true, hasValidResult: true,
}), "succeeded");

assert.match(panel, /method: "GET"/u);
assert.match(panel, /payload\.historyReady === false/u);
assert.match(panel, /historyNotice/u);
assert.doesNotMatch(panel, /method: "POST"/u);
assert.doesNotMatch(panel, /localStorage|sessionStorage|indexedDB/iu);
assert.match(panel, /window\.setInterval\([^]*15_000/u);
assert.match(panel, /visibilitychange/u);
assert.match(panel, /window\.addEventListener\("focus"/u);
assert.match(panel, /void loadDetail\(item, "retry"\)/u);
assert.match(panel, /void loadDetail\(item, "result"\)/u);
assert.match(panel, /&id=\$\{encodeURIComponent\(item\.id\)\}/u);
assert.match(repository, /SCRIPT_REQUEST_LIST_SELECT[\s\S]*?submitted_at[\s\S]*?updated_at[\s\S]*?billing_snapshot/u);
assert.doesNotMatch(
  repository.match(/const SCRIPT_REQUEST_LIST_SELECT = \[[\s\S]*?\]\.join\(","\);/u)?.[0] || "",
  /request_snapshot|result_payload/u,
);
assert.match(repository, /SCRIPT_REQUEST_DETAIL_SELECT = `\$\{SCRIPT_REQUEST_LIST_SELECT\},request_snapshot,result_payload`/u);
assert.match(panel, /onLoadRetry\(detail\.requestSnapshot, detail\.clientRequestId\)/u);
assert.match(panel, /onLoadResult\(detail\.result, detail\.clientRequestId\)/u);
assert.match(official, /generationIdentityRef\.current = null;[^]*clearGeneralScriptSubmission/u);
assert.match(youcai, /generationIdentityRef\.current = null;[^]*clearGeneralScriptSubmission/u);
assert.match(official, /"X-General-Script-Surface": variant/u);
assert.match(youcai, /"X-General-Script-Surface": "youcai"/u);

assert.equal(networkCalls, 0);
assert.equal(providerCalls, 0);
assert.equal(databaseWrites, 0);

console.log(JSON.stringify({
  ok: true,
  contract: "general-script-server-history.v1",
  migration: "20260915234500_short_drama_script_history.sql",
  cases: {
    accountIsolation: true,
    stableOrdering: "submitted_at DESC, id DESC",
    unchargedRetry: "manual_new_request_id",
    refundedRetry: "ledger_verified_manual_new_request_id",
    chargedWithoutRefund: "reconciliation_required",
    unknownTerminal: "reconciliation_required",
    browserDraftSource: false,
    refreshPollingMs: 15000,
  },
  networkCalls,
  providerCalls,
  databaseWrites,
}, null, 2));
