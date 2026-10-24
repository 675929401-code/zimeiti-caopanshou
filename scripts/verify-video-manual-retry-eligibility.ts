/* eslint-disable @typescript-eslint/no-explicit-any -- Actual server code executes in isolated VMs with typed-independent database fixtures. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { classifyVideoProviderError, sanitizeVideoProviderDiagnostic } from "../src/lib/video-error-policy";

const paths = ["src/lib/video-manual-retry-eligibility.ts", "src/app/api/video/generate/route.ts", "src/lib/video-terminal-finalizer.ts", "src/lib/video-error-policy.ts", "scripts/verify-video-manual-retry-eligibility.ts"];
const hash = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
const sourceHashes = Object.fromEntries(paths.map(file => [file, hash(file)]));
const output = `.codex-evidence/storyboard-delivery-audit-20261023/repair/manual-retry/verification-${new Date().toISOString().replace(/[:.]/gu, "-")}`;
const checks: string[] = [];
let realNetworkCalls = 0;
globalThis.fetch = (async () => { realNetworkCalls++; throw new Error("REAL_NETWORK_FORBIDDEN"); }) as typeof fetch;
function tree(file: string) { return ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true); }
function nodes<T extends ts.Node>(root: ts.Node, predicate: (node: ts.Node) => node is T) {
  const result: T[] = []; const visit = (node: ts.Node) => { if (predicate(node)) result.push(node); ts.forEachChild(node, visit); }; visit(root); return result;
}
function compile(code: string, context: Record<string, any> = {}) {
  const js = ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  return vm.runInNewContext(`(function(){const exports={};${js};return exports;})()`, { createHash, Error, Promise, JSON, Object, Array, String, Number, Boolean, AbortController, AbortSignal,
    setTimeout, clearTimeout, console: { error() {}, warn() {}, log() {} }, URL, ...context });
}
const terminalTree = tree(paths[2]);
const identityCode = terminalTree.statements.filter(node => (ts.isFunctionDeclaration(node) && ["buildVideoTaskIdentity", "normalizeVideoClientRequestId"].includes(node.name?.text || ""))
  || (ts.isClassDeclaration(node) && node.name?.text === "VideoTerminalError") || (ts.isVariableStatement(node) && node.declarationList.declarations.some(d => d.name.getText(terminalTree) === "CLIENT_REQUEST_ID_PATTERN")))
  .map(node => node.getText(terminalTree)).join("\n");
const identity = compile(identityCode);
const helperTree = tree(paths[0]);
const helperCode = helperTree.statements.filter(node => !ts.isImportDeclaration(node)).map(node => node.getText(helperTree)).join("\n");
const helper = (overrides: Record<string, unknown> = {}) => compile(helperCode, { ...identity, getSupabaseAdminClient: () => { throw new Error("DEFAULT_DATABASE_FORBIDDEN"); }, ...overrides }).canManuallyRetryUnsubmittedVideoTask;
const canRetry = helper();
const userId = "manual-retry-fixture-owner", requestId = "fixture-original-video-request";
const taskIdentity = identity.buildVideoTaskIdentity(userId, requestId);
const billingKey = `video-terminal:${taskIdentity.taskIdInternal}`;
const baseline = () => ({ id: taskIdentity.taskIdInternal, user_id: userId, client_request_id: requestId, model_id: "fixture-video-model", request_fingerprint: "a".repeat(64),
  request_snapshot_hash: "b".repeat(64), routing_snapshot_hash: "c".repeat(64), status: "failed", billing_state: "submission_failed", billing_unit: "per_use", price_charged: 0,
  billing_operation_id: null, billing_idempotency_key: billingKey, billing_reserved_yuan: null, billing_token_quote: null, billing_token_usage: null,
  submission_error_code: "CHANNEL_QUOTA_UNAVAILABLE", task_id_external: null, video_url: null, storage_url: null, provider_result_url: null, content_url: null,
  provider_acknowledged_at: null, provider_reconciliation_state: "dispatch_recorded", provider_submission_receipt: null,
  provider_dispatch_receipt: { schemaVersion: 1, requests: [{ requestBodySha256: "d".repeat(64) }] }, provider_dispatch_started_at: "2026-10-23T18:00:00Z",
  created_at: "2026-10-23T18:00:00Z", completed_at: "2026-10-23T18:00:01Z" });
type DbOptions = { tasks?: any[]; ledger?: any; taskErrorAt?: number; ledgerError?: boolean; throwLookup?: boolean; hangLedger?: boolean; ignoreOwnerFilter?: boolean };
function database(options: DbOptions = {}) {
  const taskRows = options.tasks || [baseline(), baseline()]; const log: any[] = []; let taskReads = 0;
  const db = { from(table: string) {
    const query: any = { table, filters: [], selected: "", signal: undefined, limit: undefined, update: false }; log.push(query);
    const execute = async () => {
      if (options.throwLookup) throw new Error("fixture lookup rejected");
      if (query.update) return { data: { id: taskIdentity.taskIdInternal }, error: null };
      if (table === "video_tasks") {
        taskReads++; if (options.taskErrorAt === taskReads) return { data: null, error: { message: "fixture task read failed" } };
        const row = taskRows[Math.min(taskReads - 1, taskRows.length - 1)];
        const matches = row && query.filters.every(([kind, key, value]: any[]) => kind !== "eq" || options.ignoreOwnerFilter || row[key] === value);
        return { data: matches ? structuredClone(row) : null, error: null };
      }
      assert.equal(table, "wallet_operations");
      if (options.hangLedger) return new Promise<any>(() => undefined);
      if (options.ledgerError) return { data: null, error: { message: "fixture ledger read failed" } };
      const rows = options.ledger === undefined ? [] : options.ledger;
      return { data: Array.isArray(rows) ? rows.filter(row => query.filters.every(([kind, key, value]: any[]) => kind === "eq" ? row[key] === value : value.includes(row[key]))).slice(0, query.limit || Infinity) : rows, error: null };
    };
    const chain: any = { select(fields: string) { query.selected = fields; return chain; }, update() { query.update = true; return chain; },
      eq(key: string, value: unknown) { query.filters.push(["eq", key, value]); return chain; }, in(key: string, value: unknown) { query.filters.push(["in", key, value]); return chain; },
      limit(count: number) { query.limit = count; return chain; }, abortSignal(signal: AbortSignal) { query.signal = signal; return chain; },
      maybeSingle: execute, then: (resolve: any, reject: any) => execute().then(resolve, reject) }; return chain;
  } };
  return { db, log, taskRows, taskReads: () => taskReads };
}
const input = (db: any) => ({ taskId: taskIdentity.taskIdInternal, userId, db });
async function check(name: string, action: () => void | Promise<void>) { await action(); checks.push(name); }
const routeTree = tree(paths[1]);
const condition = (text: string) => {
  const node = nodes(routeTree, ts.isIfStatement).find(node => node.expression.getText(routeTree) === text);
  assert.ok(node, `Production branch missing: ${text}`); return node.getText(routeTree);
};
const actualFailedBranch = condition('result.status === "failed"'), actualUnknownBranch = condition('result.submissionOutcome === "unknown"');
class ProviderAdmissionBusyError extends Error { code = "PROVIDER_ADMISSION_BUSY"; status = 429; retryAfterSeconds = 4; }
function routeFixture(options: DbOptions & { markResult?: boolean; result?: any; providerAdmissionError?: any; token?: boolean } = {}) {
  const fixture = database(options); const calls = { mark: 0, helper: 0, binds: 0, receipts: 0 };
  const context: any = { ...fixture, result: options.result || { taskId: "", status: "failed", error: "HTTP 402 insufficient quota" },
    providerAdmissionError: options.providerAdmissionError || null, markVideoSubmissionFailed: async () => { calls.mark++; return options.markResult !== false; },
    canManuallyRetryUnsubmittedVideoTask: async (args: any) => { calls.helper++; return canRetry(args); },
    taskIdInternal: taskIdentity.taskIdInternal, userId, requestFingerprint: "a".repeat(64), tokenPendingFinancials: options.token ? { price: 0, reserved_amount: 0.5, billing_unit: "token" } : undefined,
    writeVideoTrace: async () => undefined, recordVideoTerminalOutcome: async () => undefined,
    bindVideoProviderTask: async () => { calls.binds++; }, persistVideoProviderSubmissionReceipt: async () => { calls.receipts++; },
    traceId: "fixture-trace", normalizedClientRequestId: requestId, traceModelId: "fixture-model", traceTaskLabel: "分镜工作台", tracePromptHash: "fixture-hash", submitStart: Date.now(), totalMs: 12,
    model_id: "fixture-model", selectedModel: { id: "fixture-model", model_name: "Fixture video", protocol_type: "fixture", api_endpoint: "https://fixture.invalid" },
    publicModelDisplayName: () => "Fixture video", classifyVideoProviderError, sanitizeVideoProviderDiagnostic, ProviderAdmissionBusyError,
    submitFailedBeforeProviderDispatch: false, NextResponse: { json: (body: any, init: any) => ({ body, init }) } };
  const executable = compile(`export const execute = async () => { ${actualUnknownBranch}\n${actualFailedBranch}\nreturn { fallthrough: true }; };`, context);
  return { ...fixture, calls, execute: executable.execute };
}

async function main() {
  await check("real quota-refusal row shape with dispatch_recorded and empty ledger permits only manual retry", async () => {
    const f = database(); assert.equal(await canRetry(input(f.db)), true); assert.equal(f.taskReads(), 2);
    const ledger = f.log.find(q => q.table === "wallet_operations"); assert.deepEqual(ledger.filters.map((f: any[]) => f[1]), ["user_id", "idempotency_key"]);
    assert.deepEqual(Array.from(ledger.filters[1][2]), [billingKey, `${billingKey}:release`, taskIdentity.billingIdempotencyKey, `${taskIdentity.billingIdempotencyKey}:release`]);
    assert.equal(ledger.limit, 1); assert.ok(f.log.every(q => q.signal instanceof AbortSignal));
  });
  await check("strict full-digest compatibility identity also queries its own original ledger key", async () => {
    const f = database({ tasks: [{ ...baseline(), billing_idempotency_key: taskIdentity.billingIdempotencyKey }] }); assert.equal(await canRetry(input(f.db)), true);
    assert.equal(f.log.find(q => q.table === "wallet_operations").filters[1][2][0], taskIdentity.billingIdempotencyKey);
  });
  for (const [storedKey, otherKey] of [[billingKey, taskIdentity.billingIdempotencyKey], [taskIdentity.billingIdempotencyKey, billingKey]]) {
    await check(`ledger under another verified alias blocks retry even when stored key is empty: ${storedKey.includes("vt_") ? "SQL" : "digest"}`, async () => {
      const f = database({ tasks: [{ ...baseline(), billing_idempotency_key: storedKey }], ledger: [{ id: "other-alias-refund", user_id: userId, idempotency_key: `${otherKey}:release`, operation_kind: "cash_refund", status: "failed" }] });
      assert.equal(await canRetry(input(f.db)), false);
    });
  }
  for (const [name, patch] of Object.entries({ crossOwner: { user_id: "another-owner" }, externalTask: { task_id_external: "provider-task" }, acknowledged: { provider_acknowledged_at: "2026-10-23" },
    acknowledgedState: { provider_reconciliation_state: "acknowledged" }, reconciliation: { provider_reconciliation_state: "reconciliation_required" }, manuallyTerminated: { provider_reconciliation_state: "manual_terminated" },
    unknown: { submission_error_code: "VIDEO_SUBMIT_OUTCOME_UNKNOWN" }, unconfirmed: { submission_error_code: "VIDEO_ADMISSION_RELEASE_UNCONFIRMED" },
    token: { billing_unit: "token" }, unknownUnit: { billing_unit: null }, reservation: { billing_reserved_yuan: 0.2 }, invalidReservation: { billing_reserved_yuan: "0" },
    tokenQuote: { billing_token_quote: {} }, tokenUsage: { billing_token_usage: {} }, operationId: { billing_operation_id: "wallet-operation" }, charged: { price_charged: 0.2 },
    stringZero: { price_charged: "0" }, missingPrice: { price_charged: null }, processing: { status: "processing" }, completed: { status: "completed" }, settled: { billing_state: "settled" },
    missingRequest: { client_request_id: null }, invalidRequest: { client_request_id: "short" }, wrongIdentity: { client_request_id: "another-client-request" },
    wrongBillingKey: { billing_idempotency_key: "another-billing-key" }, missingFingerprint: { request_fingerprint: "" }, receipt: { provider_submission_receipt: {} },
    videoPayload: { video_url: "https://fixture.invalid/result.mp4" }, storedPayload: { storage_url: "object://result" }, providerPayload: { provider_result_url: "https://fixture.invalid/result.mp4" }, contentPayload: { content_url: "https://fixture.invalid/content" } })) {
    await check(`helper denies ${name}`, async () => { const f = database({ tasks: [{ ...baseline(), ...patch }], ignoreOwnerFilter: true }); assert.equal(await canRetry(input(f.db)), false); });
  }
  for (const kind of ["cash_charge", "cash_refund", "reservation", "unexpected_kind"]) for (const status of ["completed", "pending", "failed", "cancelled"]) for (const suffix of ["", ":release"]) {
    await check(`any ledger row blocks ${kind}/${status}/${suffix || "original"}`, async () => { const f = database({ ledger: [{ id: "ledger-fixture", user_id: userId, idempotency_key: billingKey + suffix, operation_kind: kind, status }] }); assert.equal(await canRetry(input(f.db)), false); });
  }
  for (const options of [{ taskErrorAt: 1 }, { taskErrorAt: 2 }, { ledgerError: true }, { ledger: null }, { throwLookup: true }, { tasks: [null] }]) {
    await check(`lookup uncertainty fails closed ${JSON.stringify(options)}`, async () => { const f = database(options); assert.equal(await canRetry(input(f.db)), false); });
  }
  for (const patch of [{ request_fingerprint: "f".repeat(64) }, { request_snapshot_hash: "f".repeat(64) }, { completed_at: "2026-10-24" }, { status: "processing" }, { task_id_external: "late-provider" }]) {
    await check(`second read rejects changed ${Object.keys(patch)[0]}`, async () => { const f = database({ tasks: [baseline(), { ...baseline(), ...patch }] }); assert.equal(await canRetry(input(f.db)), false); });
  }
  await check("read timeout aborts query and returns false even for a non-settling adapter", async () => {
    let expire!: () => void; let ms = 0; const timed = helper({ setTimeout: (callback: () => void, duration: number) => { expire = callback; ms = duration; return 1; }, clearTimeout: () => undefined });
    const f = database({ hangLedger: true }), pending = timed(input(f.db));
    for (let i = 0; i < 10; i++) await Promise.resolve(); assert.equal(ms, 10000); expire(); assert.equal(await pending, false); assert.ok(f.log.every(q => q.signal.aborted));
  });
  await check("invalid caller inputs and unconfigured default database fail closed", async () => {
    assert.equal(await canRetry({ taskId: 42, userId }), false); assert.equal(await canRetry({ taskId: taskIdentity.taskIdInternal, userId }), false);
  });
  await check("generate actual failure branch qualifies quota refusal without changing provider error classification", async () => {
    assert.equal(classifyVideoProviderError("HTTP 402 insufficient quota").retryable, false);
    const f = routeFixture(), r = await f.execute(); assert.equal(r.body.retryable, true); assert.equal(r.body.submission_outcome, "not_submitted");
    assert.equal(r.body.task_submitted, false); assert.equal(r.body.billing_state, "submission_failed"); assert.equal(r.body.price, 0); assert.equal(f.calls.helper, 1);
  });
  for (const [name, options] of Object.entries({ markFalse: { markResult: false }, markTrueButRowUnchanged: { tasks: [{ ...baseline(), status: "processing" }] },
    ledgerPending: { ledger: [{ id: "ledger-fixture", user_id: userId, idempotency_key: billingKey, status: "pending" }] },
    newExternal: { tasks: [{ ...baseline(), task_id_external: "late-accepted" }] }, lookupError: { ledgerError: true } })) {
    await check(`generate actual branch keeps unconfirmed task locked: ${name}`, async () => { const f = routeFixture(options); const r = await f.execute(); assert.equal(r.body.retryable, false); assert.equal(r.body.status, "pending"); assert.equal(r.body.task_submitted, undefined); assert.equal(r.body.submission_outcome, undefined); assert.equal(r.init.status, 503); });
  }
  for (const key of ["videoUrl", "contentUrl"]) await check(`returned ${key} cannot acquire manual qualification`, async () => {
    const f = routeFixture({ result: { taskId: "", status: "failed", error: "insufficient quota", [key]: "https://fixture.invalid/result" } });
    const r = await f.execute(); assert.equal(r.body.retryable, false); assert.equal(r.body.status, "pending"); assert.equal(f.calls.mark, 0); assert.equal(f.calls.helper, 0);
  });
  await check("provider task ID keeps its previous failure path and never gets new manual qualification", async () => {
    const f = routeFixture({ result: { taskId: "provider-task", status: "failed", error: "insufficient quota" } }), r = await f.execute();
    assert.equal(f.calls.binds, 1); assert.equal(f.calls.helper, 0); assert.equal(r.body.retryable, false); assert.equal(r.body.submission_outcome, undefined);
  });
  await check("unknown submission keeps original task and cannot enter failure qualification", async () => {
    const f = routeFixture({ result: { taskId: "", status: "processing", submissionOutcome: "unknown" } }), r = await f.execute();
    assert.equal(r.body.retryable, false); assert.equal(r.body.submission_outcome, "unknown"); assert.equal(f.calls.mark, 0); assert.equal(f.calls.helper, 0);
  });
  for (const allowed of [true, false]) await check(`admission rejection uses same fresh helper proof: ${allowed}`, async () => {
    const f = routeFixture({ providerAdmissionError: new ProviderAdmissionBusyError("Synthetic admission busy"), ...(allowed ? {} : { tasks: [{ ...baseline(), status: "queued" }] }) }), r = await f.execute();
    assert.equal(r.body.retryable, allowed); assert.equal(f.calls.helper, 1); assert.equal(r.body.status, allowed ? "failed" : "pending");
    if (allowed) { assert.equal(r.body.billing_state, "submission_failed"); assert.equal(r.body.price, 0); assert.equal(r.init.headers["Retry-After"], "4"); }
  });
  for (const admission of [false, true]) await check(`Token rejection preserves billing-review semantics, not unknown outcome: admission=${admission}`, async () => {
    const f = routeFixture({ token: true, tasks: [{ ...baseline(), billing_unit: "token", billing_reserved_yuan: 0.5 }],
      ...(admission ? { providerAdmissionError: new ProviderAdmissionBusyError("Synthetic admission busy") } : {}) });
    const r = await f.execute(); assert.equal(r.body.status, "billing_pending"); assert.equal(r.body.retryable, false); assert.equal(r.body.billing_unit, "token");
    assert.equal(r.body.reserved_amount, 0.5); assert.equal(r.body.submission_outcome, undefined); assert.equal(r.body.task_submitted, undefined);
    assert.ok(r.body.error); assert.ok(r.body.message.includes("资格")); assert.equal(f.calls.helper, 0);
  });
  assert.equal(realNetworkCalls, 0); assert.deepEqual(Object.fromEntries(paths.map(file => [file, hash(file)])), sourceHashes);
}
mkdirSync(output, { recursive: true });
main().then(() => { writeFileSync(`${output}/tests.json`, JSON.stringify({ passed: true, checks, sourceHashes, realNetworkCalls, realProviderCalls: 0, databaseCalls: 0,
  method: "Actual complete helper and real failure/unknown route AST blocks; actual identity builder and classifier; all database operations are in-memory fixtures.", limitation: "Readback is not an atomic database lock; real owned-row verification is performed separately by Root/reviewer." }, null, 2) + "\n"); console.log(JSON.stringify({ passed: true, checks: checks.length, output })); })
  .catch(error => { writeFileSync(`${output}/tests.json`, JSON.stringify({ passed: false, checks, error: String(error.stack || error), sourceHashes, realNetworkCalls }, null, 2) + "\n"); console.error(error); process.exitCode = 1; });
