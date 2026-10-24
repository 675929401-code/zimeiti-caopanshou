/* eslint-disable @typescript-eslint/no-explicit-any -- Actual production functions execute against owner-scoped in-memory database doubles. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

const output = ".codex-evidence/storyboard-delivery-audit-20261023/repair/manual-retry-projection";
const paths = {
  status: "src/lib/video-task-status.ts", history: "src/app/api/video/history/route.ts",
  helper: "src/lib/video-manual-retry-eligibility.ts", identity: "src/lib/video-terminal-finalizer.ts",
  presentation: "src/lib/video-history-presentation.ts", main: "src/components/storyboard-workbench.tsx",
};
const sourceHashes: Record<string, string> = {};
const texts = Object.fromEntries(Object.entries(paths).map(([key, path]) => {
  const text = readFileSync(path, "utf8"); sourceHashes[path] = createHash("sha256").update(text).digest("hex"); return [key, text];
}));
function extract(key: keyof typeof paths, names: string[]) {
  const tree = ts.createSourceFile(paths[key], texts[key], ts.ScriptTarget.Latest, true, key === "main" ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  return names.map(name => {
    const fn = tree.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
    if (fn) return fn.getText(tree).replace(/^export\s+/u, "");
    for (const statement of tree.statements) if (ts.isVariableStatement(statement)) {
      const found = statement.declarationList.declarations.find(node => node.name.getText(tree) === name);
      if (found) return `const ${found.getText(tree)};`;
    }
    throw new Error(`Missing production declaration ${name}`);
  }).join("\n") + `\n;({${names.join(",")}});`;
}
function compile(code: string, context: Record<string, any> = {}) {
  return vm.runInNewContext(ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText,
    { Error, Object, Array, String, Number, Boolean, JSON, Set, Map, Promise, Date, URL, URLSearchParams,
      AbortController, setTimeout, clearTimeout, console: { ...console, warn() {} },
      fetch: () => { throw new Error("REAL_NETWORK_FORBIDDEN"); }, ...context });
}
const identity = compile(extract("identity", ["CLIENT_REQUEST_ID_PATTERN", "normalizeVideoClientRequestId", "buildVideoTaskIdentity"]), { createHash, VideoTerminalError: Error });
const presentation = compile(extract("presentation", ["canRetryVideoHistoryTask", "videoTokenBillingMessage", "sortVideoHistoryBySubmission"]));
const checks: Array<{ name: string; passed: boolean }> = [];
async function check(name: string, action: () => Promise<void> | void) { await action(); checks.push({ name, passed: true }); console.log("PASS " + name); }
const owner = "synthetic-owner-a";
function task(index = 1, patch: Record<string, any> = {}) {
  const client = `synthetic-manual-retry-${index}`;
  const ids = identity.buildVideoTaskIdentity(owner, client);
  return { id: ids.taskIdInternal, user_id: owner, client_request_id: client, billing_idempotency_key: ids.billingIdempotencyKey,
    request_fingerprint: "a".repeat(64), model_id: "synthetic-model", status: "failed", billing_state: "submission_failed",
    billing_unit: "per_use", price_charged: 0, billing_reserved_yuan: 0, submission_error_code: "VIDEO_PROVIDER_QUOTA_EXHAUSTED",
    provider_reconciliation_state: "dispatch_recorded", provider_dispatch_receipt: { status: 503 },
    task_label: "分镜工作台", prompt: "retain original prompt", batch_id: "project-a", card_index: index,
    created_at: new Date().toISOString(), error_message: "provider quota rejection", ...patch };
}
type QueryLog = { table: string; filters: Array<[string, unknown]>; columns: string };
function fixture(rows: Record<string, any>[], options: { ledger?: any[]; ledgerError?: boolean; changeAfterLedger?: boolean } = {}): Record<string, any> & { logs: QueryLog[] } {
  const logs: QueryLog[] = [];
  let ledgerRead = false;
  class Query {
    filters: Array<[string, any]> = []; columns = ""; single = false; start = 0; end = Infinity;
    constructor(readonly table: string) {}
    select(columns: string) { this.columns = columns; return this; }
    eq(key: string, value: any) { this.filters.push([key, value]); return this; }
    in(key: string, value: any[]) { this.filters.push([key, value]); return this; }
    is(key: string, value: any) { this.filters.push([key, value]); return this; }
    order() { return this; } or() { return this; }
    range(start: number, end: number) { this.start = start; this.end = end; return this; }
    limit(count: number) { this.end = count - 1; return this; }
    abortSignal() { return this; }
    maybeSingle() { this.single = true; return this; }
    update() { throw new Error("DATABASE_WRITE_FORBIDDEN"); }
    then(resolve: (value: any) => any, reject: (error: unknown) => any) {
      logs.push({ table: this.table, filters: this.filters, columns: this.columns });
      let values = this.table === "wallet_operations" ? options.ledger || [] : rows;
      if (this.table === "wallet_operations") ledgerRead = true;
      values = values.filter(row => this.filters.every(([key, value]) => Array.isArray(value) ? value.includes(row[key]) : value === null ? row[key] == null : row[key] === value));
      values = values.slice(this.start, this.end + 1).map(row => ({ ...row }));
      if (this.table === "video_tasks" && ledgerRead && options.changeAfterLedger) values = values.map(row => ({ ...row, task_id_external: "accepted-late" }));
      return Promise.resolve({ data: this.single ? values[0] || null : values, count: values.length,
        error: this.table === "wallet_operations" && options.ledgerError ? { code: "synthetic_failure" } : null }).then(resolve, reject);
    }
  }
  const db = { from: (table: string) => new Query(table) };
  const helperBody = texts.helper.replace(/^import[\s\S]*?from "@\/storage\/database\/supabase-client";\s*/u, "");
  const helperExports: Record<string, any> = {};
  compile(helperBody, { exports: helperExports, ...identity, getSupabaseAdminClient: () => db });
  const helper = helperExports.canManuallyRetryUnsubmittedVideoTask;
  const base: Record<string, any> = {
    ...presentation, canManuallyRetryUnsubmittedVideoTask: helper, getSupabaseClient: () => db,
    NextResponse: { json: (body: any, init?: any) => ({ status: init?.status || 200, json: async () => body }) },
    classifyVideoProviderError: () => ({ publicMessage: "generation failed", code: "VIDEO_PROVIDER_FAILED", retryable: true }),
    localVideoTaskFailureMessage: () => "", createVideoAccessUrl: async () => "/synthetic-ticket",
    publicModelDisplayName: () => "Synthetic video", toPublicModelId: () => "pm_synthetic", getVideoInputContract: () => ({ requiresSourceVideo: false }),
    supportsConfirmedVideoCancellation: () => false,
    parseVideoGenerationRequestSnapshot: (value: any) => { if (value.invalid) throw new Error("INVALID_SNAPSHOT"); return value; },
    isStoryboardVideoTask: (row: any) => String(row.task_label || "").startsWith("分镜工作台"),
    usableStoryboardArchive: () => false, isStoryboardArchiveExpired: () => false,
    storyboardVideoDeliveryState: () => "failed", storyboardVideoRetainedUntil: () => "",
    isVideoHistoryExplicitlyHidden: (row: any) => Boolean(row.history_hidden_at), isVideoHistoryExpired: () => false,
    isVideoHistoryProtected: (row: any) => ["pending", "queued", "processing"].includes(row.status),
    VIDEO_HISTORY_RETENTION_MS: 5 * 86400000, VIDEO_HISTORY_TERMINAL_STATUSES: ["completed", "failed", "cancelled", "expired"],
    VIDEO_HISTORY_SETTLED_BILLING_STATES: ["settled", "submission_failed"],
    reconcileStaleVideoSubmissionsForUser: async () => {},
    isCurrentDigitalHumanTask: (row: any) => String(row.task_label || "").startsWith("digital-human:"),
    authorizeCurrentApiUser: async () => ({ ok: true, user: { userId: owner } }), DIGITAL_HUMAN_TASK_FILTER: "synthetic-filter",
    attachPlaybackAccessSafe: async (row: any) => row, attachDigitalHumanRetrySources: async (values: any[]) => values,
  };
  const history = compile(extract("history", ["mapTaskRow", "mapTaskRowWithManualRetry", "historySurface", "belongsToHistorySurface", "POLICY_FIELDS", "readHistoryPolicyRows", "getScopedHistory", "dedupeByCardIndex", "GET"]), base);
  const status = compile(extract("status", ["normalizeProviderProgress", "readLocalVideoTaskSnapshot", "resolveOwnedVideoTaskStatus"]), base);
  return { ...history, ...status, helper, logs, db };
}
const request = (query: string) => ({ url: `http://synthetic.invalid/api/video/history?${query}`, nextUrl: new URL(`http://synthetic.invalid/?${query}`) });
async function projected(row: any, options = {}) {
  const f = fixture([row], options);
  const history = await f.mapTaskRowWithManualRetry(row, owner);
  const status = await (await f.readLocalVideoTaskSnapshot({ task: row, taskId: row.id, userId: owner, userRole: "student" })).json();
  return { f, history, status };
}
async function main() {
  await check("pure-history-submission-failed-zero-price-stays-locked", () => { assert.equal(fixture([task()]).mapTaskRow(task()).canRetry, false); });
  await check("verified-unsubmitted-status-and-history-enable-manual-retry", async () => {
    const { history, status } = await projected(task()); assert.equal(history.canRetry, true); assert.equal(status.retryable, true);
    assert.equal(history.id, task().id); assert.equal(history.prompt, "retain original prompt");
  });
  await check("advance-provider-status-terminal-branch-uses-owned-internal-id", async () => {
    const row = task(), f = fixture([row]);
    const value = await (await f.resolveOwnedVideoTaskStatus({ userId: owner, role: "student" }, new URLSearchParams({ taskId: row.id, modelId: "pm_synthetic" }), true)).json();
    assert.equal(value.retryable, true); assert.equal(value.billingState, "submission_failed");
    assert.ok(f.logs.filter(log => log.table === "wallet_operations").length === 1);
  });
  const blocked: Array<[string, Record<string, any>]> = [
    ["pending", { status: "pending" }], ["unknown", { submission_error_code: "VIDEO_SUBMIT_OUTCOME_UNKNOWN" }],
    ["token-billing", { billing_unit: "token" }], ["charged", { price_charged: 0.8 }],
    ["accepted-external-id", { task_id_external: "provider-task-a" }], ["provider-acknowledged", { provider_acknowledged_at: "2026-10-23T00:00:00Z" }],
    ["foreign-owner", { user_id: "synthetic-owner-b" }], ["token-quote", { billing_token_quote: {} }],
    ["saved-provider-result", { provider_result_url: "https://synthetic.invalid/result.mp4" }], ["unknown-reconciliation", { provider_reconciliation_state: "outcome_unknown" }],
  ];
  for (const [name, patch] of blocked) await check(`status-and-history-block-${name}`, async () => {
    const { history, status } = await projected(task(1, patch)); assert.equal(history.canRetry, false); assert.equal(status.retryable, false);
  });
  for (const [name, suffix, state] of [["charge-pending", "", "pending"], ["charge-settled", "", "completed"], ["release-refund", ":release", "completed"]]) {
    await check(`status-and-history-block-ledger-${name}`, async () => {
      const row = task(); const { history, status } = await projected(row, { ledger: [{ id: "ledger-a", user_id: owner, idempotency_key: row.billing_idempotency_key + suffix, status: state }] });
      assert.equal(history.canRetry, false); assert.equal(status.retryable, false);
    });
  }
  await check("status-and-history-fail-closed-on-ledger-query-error", async () => {
    const { history, status } = await projected(task(), { ledgerError: true }); assert.equal(history.canRetry, false); assert.equal(status.retryable, false);
  });
  await check("status-and-history-fail-closed-on-task-change-during-proof", async () => {
    const { history, status } = await projected(task(), { changeAfterLedger: true }); assert.equal(history.canRetry, false); assert.equal(status.retryable, false);
  });
  await check("history-invalid-durable-snapshot-remains-locked-without-ledger-lookup", async () => {
    const row = task(1, { request_snapshot: { invalid: true } }), f = fixture([row]);
    assert.equal((await f.mapTaskRowWithManualRetry(row, owner)).canRetry, false); assert.equal(f.logs.length, 0);
  });
  await check("ordinary-failed-history-classification-unchanged", async () => {
    const row = task(1, { billing_state: "failed" }), { f, history, status } = await projected(row);
    assert.equal(history.canRetry, true); assert.equal(status.retryable, true); assert.equal(f.logs.length, 0);
  });
  await check("scoped-history-pagination-proves-only-selected-owned-failed-candidates", async () => {
    const rows = [task(1), task(2, { status: "pending" }), task(3), task(4, { user_id: "foreign" })], f = fixture(rows);
    const page = await (await f.GET(request("surface=storyboard-workbench&limit=2&offset=0"))).json();
    assert.equal(page.tasks.length, 2); assert.equal(page.total, 3); assert.equal(page.nextOffset, 2);
    assert.equal(page.tasks[0].canRetry, true); assert.equal(page.tasks[1].canRetry, false);
    const ledger = f.logs.filter(log => log.table === "wallet_operations"); assert.equal(ledger.length, 1);
    assert.ok(f.logs.every(log => log.filters.some(([key, value]) => key === "user_id" && value === owner)));
  });
  await check("scoped-single-task-history-restores-original-card-after-refresh", async () => {
    const row = task(), f = fixture([row]);
    const page = await (await f.GET(request(`surface=storyboard-workbench&taskId=${row.id}`))).json();
    const { hydrateRunVideoTasks } = compile(extract("main", ["hydrateRunVideoTasks"]), { normalizeRemoteVideoStatus: (status: string) => status });
    const run = { id: "project-a", cards: [{ id: "card-a", order: 1, videoTaskId: row.id, videoStatus: "failed", videoRetryable: false, videoPrompt: "original video prompt", imageUrl: "object://synthetic-owned-image" }] };
    const restored = hydrateRunVideoTasks(run, page.tasks);
    assert.equal(restored.cards[0].videoRetryable, true); assert.equal(restored.cards[0].videoTaskId, row.id);
    assert.equal(restored.cards[0].videoPrompt, run.cards[0].videoPrompt); assert.equal(restored.cards[0].imageUrl, run.cards[0].imageUrl);
  });
  await check("scoped-single-task-history-denies-other-owner", async () => {
    const row = task(1, { user_id: "foreign" }), f = fixture([row]);
    assert.equal((await f.GET(request(`surface=storyboard-workbench&taskId=${row.id}`))).status, 404);
    assert.equal(f.logs.filter(log => log.table === "wallet_operations").length, 0);
  });
  for (const query of ["surface=digital-human&limit=10", "surface=digital-human&taskId=TASK"]) await check(`digital-human-history-projection-${query.includes("taskId") ? "single" : "page"}`, async () => {
    const row = task(1, { task_label: "digital-human:photo" }), f = fixture([row]);
    const page = await (await f.GET(request(query.replace("TASK", row.id)))).json();
    assert.equal(page.tasks.length, 1); assert.equal(page.tasks[0].canRetry, true);
  });
  mkdirSync(output, { recursive: true });
  writeFileSync(`${output}/report.json`, JSON.stringify({ checkedAt: new Date().toISOString(), passed: checks.every(item => item.passed), total: checks.length,
    sourceHashes, checks, method: "Actual AST-extracted production projections and actual shared helper; synthetic owner-scoped RAM database. No provider/network/database writes.",
    limits: ["No browser, build, production database or real provider involved.", "History policy/asset-signing and digital-human retry-asset boundaries mocked; tests target manual-retry projection and original-card hydration."] }, null, 2));
  console.log(`PASS ${checks.length} manual retry projection checks`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
