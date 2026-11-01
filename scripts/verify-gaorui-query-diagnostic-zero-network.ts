/* eslint-disable @typescript-eslint/no-explicit-any -- Production catch/snapshot functions run in an isolated VM with a narrow database fixture. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { checkGaoruiHealth, pollVideoTask, type VideoModelConfig } from "../src/lib/video-adapter";
import { classifyVideoProviderError, localVideoTaskFailureMessage, sanitizeVideoProviderDiagnostic } from "../src/lib/video-error-policy";

const config: VideoModelConfig = { id: "fixture-gaorui-model", name: "Fixture video", provider: "gaorui", model_name: "fixture-model",
  protocol_type: "gaorui_video", api_endpoint: "https://fixture.invalid/v1", api_key: "fixture-api-credential", price_per_use: 0.5, duration_seconds: 10, supports_image_input: true };
const taskId = "fixture/original task";
const expectedUrl = `https://fixture.invalid/v1/videos/${encodeURIComponent(taskId)}`;
const authMessage = "原任务状态查询权限异常，已保留原任务，请联系管理员；请勿重复生成。";
const files = ["src/lib/video-adapter.ts", "src/lib/video-task-status.ts", "src/lib/video-error-policy.ts", "scripts/verify-gaorui-query-diagnostic-zero-network.ts"];
const sourceHashes = Object.fromEntries(files.map(file => [file, createHash("sha256").update(readFileSync(file)).digest("hex")]));
const checks: string[] = [];
let requests: { url: string; method: string }[] = [];
let response: (() => Response | Promise<Response>) | undefined;
let forbiddenNetworkCalls = 0;
const logs: string[] = [];
const originals = { fetch: globalThis.fetch, log: console.log, warn: console.warn, error: console.error };
async function check(name: string, action: () => void | Promise<void>) { await action(); checks.push(name); }
function json(body: unknown, status = 200) { return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }); }
function compile(code: string, context: Record<string, any>) {
  const js = ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  return vm.runInNewContext(`(function(){ const exports={}; ${js}; return exports; })()`, { Error, Date, String, Number, Math, Promise, Object, Array, console, ...context });
}
const statusSource = ts.createSourceFile(files[1], readFileSync(files[1], "utf8"), ts.ScriptTarget.Latest, true);
const fn = (name: string) => {
  const node = statusSource.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.ok(node, `Missing production function ${name}`); return node;
};
const statusFunction = fn("resolveOwnedVideoTaskStatus");
const statusTry = statusFunction.body?.statements.find(ts.isTryStatement);
assert.ok(statusTry?.catchClause, "Production provider catch missing");
const catchCode = statusTry.catchClause.block.getText(statusSource);
const snapshotCode = ["normalizeProviderProgress", "providerPollMessage", "persistProviderPollSnapshot", "readLocalVideoTaskSnapshot"].map(name => fn(name).getText(statusSource)).join("\n");
function statusFixture(error: Error, initialStatus = "pending", advanceProvider = true) {
  const row: Record<string, unknown> = { id: "fixture-internal-task", task_id_external: taskId, user_id: "fixture-owner", status: initialStatus,
    billing_state: "provider_submitted", price_charged: 0, billing_idempotency_key: "fixture-original-billing-key", provider_poll_failures: 2,
    submission_error_code: null, provider_result_url: null, video_url: null, storage_url: null, provider_progress: 0 };
  const patches: Record<string, unknown>[] = [];
  const db = { from(table: string) {
    assert.equal(table, "video_tasks"); let patch: Record<string, unknown>; let matchedId: unknown; let statuses: string[];
    const chain = { update(value: Record<string, unknown>) { patch = value; return chain; },
      eq(column: string, value: unknown) { assert.equal(column, "id"); matchedId = value; return chain; },
      in(column: string, values: string[]) { assert.equal(column, "status"); statuses = values; return chain; },
      then(resolve: any, reject: any) { if (matchedId === row.id && statuses.includes(String(row.status))) { patches.push(structuredClone(patch)); Object.assign(row, patch); } return Promise.resolve({ error: null }).then(resolve, reject); } };
    return chain;
  } };
  const isolated = compile(`${snapshotCode}\nexport const executeCatch=async()=>${catchCode};\nexport const read=readLocalVideoTaskSnapshot;\nexport const persist=persistProviderPollSnapshot;`, {
    err: error, advanceProvider, providerPollFailureContext: { supabase: db, taskIdInternal: row.id, priorFailures: 2 },
    classifyVideoProviderError, sanitizeVideoProviderDiagnostic, localVideoTaskFailureMessage,
    videoTerminalErrorResponse: () => null, NextResponse: { json: (body: unknown, init?: unknown) => ({ body, init }) },
    createVideoAccessUrl: async () => "/fixture-playback-ticket", canRetryVideoHistoryTask: () => false,
    canManuallyRetryUnsubmittedVideoTask: async () => false,
  });
  return { row, patches, db, ...isolated };
}
async function main() {
  globalThis.fetch = async (input, init) => {
    if (!response) { forbiddenNetworkCalls++; throw new Error("REAL_NETWORK_FORBIDDEN"); }
    const url = String(input), method = init?.method || "GET"; requests.push({ url, method });
    assert.equal(method, "GET"); assert.ok(url === expectedUrl || url === "https://fixture.invalid/v1/videos/health_check");
    return response();
  };
  console.log = console.warn = console.error = (...values: unknown[]) => { logs.push(values.map(value => typeof value === "string" ? value : JSON.stringify(value)).join(" ")); };
  try {
    for (const item of [
      { name: "nested Chinese 403 takes precedence", status: 403, body: { error: { message: "该令牌无权访问模型  (request id: fixture)" }, message: "ignored top level" }, expected: "该令牌无权访问模型" },
      { name: "top-level 403", status: 403, body: { message: "forbidden" }, expected: "forbidden" },
      { name: "string error 401", status: 401, body: { error: "invalid token" }, expected: "invalid token" },
      { name: "non-JSON 403", status: 403, body: null, expected: "HTTP 403" },
      { name: "403 conflicting quota wording uses transport status", status: 403, body: { error: { message: "quota exhausted; task not found; download failed" } }, expected: "quota exhausted" },
    ]) await check(item.name, async () => {
      const before = requests.length; response = () => item.body ? json(item.body, item.status) : new Response("opaque fixture body", { status: item.status });
      let error: Error | undefined;
      try { await pollVideoTask(config, taskId); assert.fail("Must throw a query error, never return a failed task"); } catch (caught) { error = caught as Error; }
      assert.ok(error); assert.match(error.message, new RegExp(`HTTP ${item.status}`, "u")); assert.ok(error.message.includes(item.expected));
      assert.equal((error as Error & { videoProviderQueryHttpStatus: number }).videoProviderQueryHttpStatus, item.status);
      assert.equal(requests.length, before + 1); assert.equal(requests.at(-1)?.url, expectedUrl);
      const f = statusFixture(error), baseline = structuredClone(f.row), result = await f.executeCatch();
      assert.equal(result.body.errorCode, "CHANNEL_AUTH_INVALID"); assert.equal(result.body.retryable, false);
      assert.equal(f.patches.length, 1); assert.deepEqual(Object.keys(f.patches[0]).sort(), ["provider_last_polled_at", "provider_poll_failures", "provider_status_message"]);
      assert.equal(f.row.provider_status_message, authMessage); assert.equal(f.row.provider_poll_failures, 3);
      for (const key of Object.keys(baseline).filter(key => !Object.keys(f.patches[0]).includes(key))) assert.deepEqual(f.row[key], baseline[key]);
      const snapshot = await f.read({ task: f.row, taskId, userId: "fixture-owner", userRole: "student" });
      assert.equal(snapshot.body.taskId, taskId); assert.equal(snapshot.body.status, "pending"); assert.equal(snapshot.body.message, authMessage);
      assert.equal(snapshot.body.retryable, false); assert.equal(snapshot.body.priceCharged, 0); assert.equal(snapshot.body.billingState, "provider_submitted");
      await f.persist({ supabase: f.db, taskIdInternal: f.row.id, result: { taskId, status: "processing", progress: 60 }, modelName: "Fixture video" });
      assert.equal(f.row.provider_poll_failures, 0); assert.equal(f.row.status, "processing"); assert.equal(f.row.provider_progress, 60);
      assert.equal(f.row.provider_status_message, "上游已回报：视频正在生成"); assert.equal(f.row.billing_state, baseline.billing_state);
    });
    await check("403 diagnostic removes bearer, token and signed URL parameters", async () => {
      response = () => json({ error: { message: "forbidden Bearer fixture-private-bearer token=fixture-private-token https://media.fixture.invalid/video.mp4?signature=fixture-private-signature#private-fragment" } }, 403);
      await assert.rejects(pollVideoTask(config, taskId), (error: unknown) => {
        const message = String((error as Error).message); assert.match(message, /HTTP 403/u);
        for (const secret of ["fixture-private-bearer", "fixture-private-token", "fixture-private-signature", "private-fragment"]) assert.ok(!message.includes(secret)); return true;
      });
    });
    await check("5xx stays nonterminal and sanitizes logged nested diagnostics", async () => {
      response = () => json({ error: { message: "server failure Bearer fixture-5xx-secret token=fixture-5xx-token https://fixture.invalid/x?signature=fixture-5xx-signature" } }, 503);
      const result = await pollVideoTask(config, taskId); assert.equal(result.status, "processing"); assert.equal(result.taskId, taskId);
      assert.ok(logs.some(log => /HTTP 503/u.test(log)));
      for (const secret of ["fixture-5xx-secret", "fixture-5xx-token", "fixture-5xx-signature"]) assert.ok(!logs.join("\n").includes(secret));
    });
    await check("completed original task preserves success URL extraction", async () => {
      response = () => json({ id: taskId, status: "completed", progress: 100, url: "https://media.fixture.invalid/result.mp4" });
      const result = await pollVideoTask(config, taskId); assert.equal(result.status, "success"); assert.equal(result.taskId, taskId); assert.equal(result.videoUrl, "https://media.fixture.invalid/result.mp4");
    });
    await check("unknown successful response remains processing", async () => {
      response = () => json({ id: taskId, status: "fixture_unknown", progress: 30 }); assert.equal((await pollVideoTask(config, taskId)).status, "processing");
    });
    await check("network exception never resubmits original task", async () => {
      const before = requests.length; response = () => { throw new Error("fixture network unavailable"); };
      await assert.rejects(pollVideoTask(config, taskId), /fixture network unavailable/u); assert.equal(requests.length, before + 1);
    });
    await check("existing 404 terminal policy remains unchanged", async () => {
      response = () => json({}, 404); const result = await pollVideoTask(config, taskId); assert.equal(result.status, "failed"); assert.equal(result.error, "任务不存在或已过期");
    });
    for (const status of [200, 400, 401, 403, 404, 429, 503]) await check(`health probe status ${status}`, async () => {
      response = () => json({}, status); const result = await checkGaoruiHealth(config.api_endpoint, config.api_key);
      assert.equal(result.ok, status === 200 || status === 404); if (status === 404) assert.match(result.error || "", /仅确认接口可达/u);
    });
    await check("non-worker reads and terminal rows cannot acquire diagnostic writes", async () => {
      const error = Object.assign(new Error("HTTP 403"), { videoProviderQueryHttpStatus: 403 });
      const read = statusFixture(error, "pending", false); await read.executeCatch(); assert.equal(read.patches.length, 0);
      const terminal = statusFixture(error, "completed"); await terminal.executeCatch(); assert.equal(terminal.patches.length, 0);
    });
    await check("all adapter traffic is bounded to original task GET or health GET", () => {
      assert.equal(forbiddenNetworkCalls, 0); assert.ok(requests.every(request => request.method === "GET"));
      assert.ok(requests.every(request => request.url === expectedUrl || request.url.endsWith("/v1/videos/health_check")));
    });
  } finally { globalThis.fetch = originals.fetch; console.log = originals.log; console.warn = originals.warn; console.error = originals.error; }
  const output = `.codex-evidence/gaorui-query-diagnostic/${new Date().toISOString().replace(/[:.]/gu, "-")}`;
  mkdirSync(output, { recursive: true });
  const report = { passed: true, checks, sourceHashes, simulatedGetRequests: requests.length, realNetworkCalls: forbiddenNetworkCalls, providerGenerationCalls: 0,
    databaseWrites: 0, limitation: "Real adapter with mocked fetch; production catch and snapshot functions with in-memory database only. No real provider, storage or billing finalizer acceptance." };
  writeFileSync(`${output}/report.json`, JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
  console.log(JSON.stringify({ passed: true, checks: checks.length, report: `${output}/report.json`, providerGenerationCalls: 0, realNetworkCalls: 0 }));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
