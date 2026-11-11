import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import ts from "typescript";

// Exercise the actual GET loader with a fake clock/transport. No browser,
// provider, workflow, database or billing request is allowed in this verifier.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = "src/components/cover-workbench-client.ts";
const source = readFileSync(path.join(root, sourcePath), "utf8");
const ast = ts.createSourceFile(sourcePath, source, ts.ScriptTarget.Latest, true);
const names = ["CoverCatalogReadError", "createCoverCatalogLoader", "isRecord"];
const declarations = names.map(name => {
  const matches = ast.statements.filter(node => node.name?.text === name);
  assert.equal(matches.length, 1, `Expected the owning declaration ${name}`);
  return matches[0].getText(ast);
}).join("\n");
const compiled = ts.transpileModule(`${declarations}\nmodule.exports = {createCoverCatalogLoader};`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }, reportDiagnostics: true,
});
assert.deepEqual((compiled.diagnostics || []).filter(item => item.category === ts.DiagnosticCategory.Error), []);
const checks = [], requests = [];
const flush = async () => { for (let index = 0; index < 12; index++) await Promise.resolve(); };
function fixture() {
  let now = 0, timerId = 0, active = true;
  const timers = new Map(), queue = [], calls = [], changes = [];
  const document = { visibilityState: "visible" };
  const state = { status: "loading", error: "", choices: ["previous"], selection: "user-choice", draft: "保留文案" };
  const window = {
    setTimeout: (callback, delay) => { const id = ++timerId; timers.set(id, { callback, due: now + delay }); return id; },
    clearTimeout: id => timers.delete(id),
  };
  const fetch = (url, options) => {
    assert.equal(url, "/api/cover-styles"); assert.equal(options.method, "GET"); assert.equal(options.body, undefined);
    assert.equal(options.cache, "no-store"); assert.ok(options.signal instanceof AbortSignal);
    calls.push({ url, method: options.method }); requests.push({ url, method: options.method });
    assert.ok(queue.length, "Unexpected GET: duplicate refresh or an unplanned retry");
    return queue.shift()(options.signal);
  };
  const module = { exports: {} };
  vm.runInNewContext(compiled.outputText, { module, exports: module.exports, fetch, window, document,
    AbortController, Error, TypeError, Date: class extends Date { static now() { return now; } } }, { timeout: 5000 });
  const revision = { current: 0 };
  const loader = module.exports.createCoverCatalogLoader({ url: "/api/cover-styles", label: "画面风格目录", revision,
    isActive: () => active,
    parse: value => { if (!Array.isArray(value?.items)) throw new Error("invalid fixture catalog"); return value.items; },
    onLoading: () => { changes.push("loading"); state.status = "loading"; state.error = ""; },
    onSuccess: value => { changes.push("ready"); state.status = "ready"; state.choices = value; },
    onError: text => { changes.push("error"); state.status = "error"; state.error = text; },
  });
  const enqueue = (status = 200, body = { items: ["ready"] }, invalidJson = false) => queue.push(async () => ({
    status, ok: status >= 200 && status < 300,
    json: async () => { if (invalidJson) throw new SyntaxError("HTML gateway response"); return body; },
  }));
  const rejectNetwork = () => queue.push(async () => { throw new TypeError("Failed to fetch"); });
  const defer = (abortable = true) => {
    let resolve, reject;
    queue.push(signal => new Promise((res, rej) => {
      resolve = res; reject = rej;
      if (abortable) signal.addEventListener("abort", () => rej(new Error("aborted")), { once: true });
    }));
    return { resolve: value => resolve(value), reject: value => reject(value) };
  };
  const advance = async milliseconds => {
    const target = now + milliseconds;
    for (let count = 0; count < 100; count++) {
      const next = [...timers].filter(([, timer]) => timer.due <= target).sort((a, b) => a[1].due - b[1].due)[0];
      if (!next) break;
      now = next[1].due; timers.delete(next[0]); next[1].callback(); await flush();
      assert.ok(count < 99, "Timer storm");
    }
    now = target; await flush();
  };
  return { loader, state, calls, timers, changes, document, revision, enqueue, rejectNetwork, defer, advance,
    deactivate: () => { active = false; },
    finish: () => { loader.dispose(); assert.equal(timers.size, 0); assert.equal(state.selection, "user-choice"); assert.equal(state.draft, "保留文案"); },
  };
}

{
  const test = fixture(); test.rejectNetwork(); await test.loader.reload();
  assert.match(test.state.error, /画面风格目录.*自动重试/u); assert.doesNotMatch(test.state.error, /Failed to fetch/u);
  assert.equal(test.state.status, "error"); assert.deepEqual(test.state.choices, ["previous"]);
  test.enqueue(); await test.advance(999); assert.equal(test.calls.length, 1); await test.advance(1);
  assert.equal(test.state.status, "ready"); assert.deepEqual(test.state.choices, ["ready"]); test.finish();
  checks.push("transport failure uses Chinese feedback and recovers after the first 1s GET retry without changing draft/selection");
}
{
  const test = fixture(); test.enqueue(502, null, true); await test.loader.reload();
  assert.match(test.state.error, /服务暂时不可用.*自动重试/u);
  test.enqueue(403, null, true); await test.advance(1000);
  assert.match(test.state.error, /重新登录/u); assert.equal(test.timers.size, 0);
  await test.advance(60_000); test.loader.resume(); await flush(); assert.equal(test.calls.length, 2);
  test.enqueue(); await test.loader.reload(); assert.equal(test.state.status, "ready"); test.finish();
  checks.push("non-JSON 502 retries; non-JSON 403 stops automatic recovery until explicit reload");
}
for (const invalidJson of [false, true]) {
  const test = fixture(); test.enqueue(200, { invalid: true }, invalidJson); await test.loader.reload();
  assert.match(test.state.error, /数据格式暂不可用/u); assert.equal(test.timers.size, 0);
  await test.advance(60_000); test.loader.resume(); await flush(); assert.equal(test.calls.length, 1); test.finish();
}
checks.push("invalid JSON and invalid successful catalog data do not enter a retry loop");
{
  const test = fixture(); test.rejectNetwork(); await test.loader.reload();
  test.document.visibilityState = "hidden"; test.loader.pause(); await test.advance(60_000);
  assert.equal(test.calls.length, 1); assert.equal(test.timers.size, 0);
  test.enqueue(); test.document.visibilityState = "visible"; test.loader.resume(); await flush();
  assert.equal(test.state.status, "ready"); assert.equal(test.calls.length, 2); test.finish();
  checks.push("hidden pages pause retry timers and visibility recovery resumes the GET");
}
{
  const test = fixture(); const pending = test.defer(); const first = test.loader.reload();
  void test.loader.reload(); for (let index = 0; index < 20; index++) test.loader.resume();
  assert.equal(test.calls.length, 1);
  pending.resolve({ status: 200, ok: true, json: async () => ({ items: ["first"] }) }); await first;
  for (let index = 0; index < 20; index++) test.loader.resume(); await flush(); assert.equal(test.calls.length, 1);
  await test.advance(1000); test.enqueue(); test.loader.resume(); await flush(); assert.equal(test.calls.length, 2); test.finish();
  checks.push("in-flight deduplication and 1s event coalescing prevent focus/online refresh storms");
}
{
  const test = fixture(); test.defer(); void test.loader.reload(); await test.advance(12_000);
  assert.match(test.state.error, /读取超时.*自动重试/u); test.enqueue(); await test.advance(1000);
  assert.equal(test.state.status, "ready"); test.finish();
  checks.push("a hung GET aborts after 12s, exits loading and recovers without locking refresh forever");
}
{
  const test = fixture(); const pending = test.defer(false); const first = test.loader.reload();
  test.document.visibilityState = "hidden"; test.loader.pause(); pending.resolve({ status: 200, ok: true, json: async () => ({ items: ["stale"] }) });
  await first; assert.deepEqual(test.state.choices, ["previous"]); test.enqueue();
  test.document.visibilityState = "visible"; test.loader.resume(); await test.advance(1000);
  assert.equal(test.state.status, "ready"); assert.deepEqual(test.state.choices, ["ready"]); test.finish();
  checks.push("pause invalidates a late successful response before resuming against a fresh revision");
}
{
  const test = fixture(); const pending = test.defer(false); const first = test.loader.reload();
  test.loader.dispose(); const count = test.changes.length;
  pending.resolve({ status: 200, ok: true, json: async () => ({ items: ["late"] }) }); await first;
  assert.equal(test.changes.length, count); assert.equal(test.timers.size, 0); test.finish();
  const inactive = fixture(); const waiting = inactive.defer(false); const second = inactive.loader.reload(); inactive.deactivate();
  waiting.resolve({ status: 200, ok: true, json: async () => ({ items: ["late"] }) }); await second;
  assert.deepEqual(inactive.state.choices, ["previous"]); inactive.finish();
  checks.push("unmount and inactive-owner guards discard late responses and leave no timers");
}
{
  const test = fixture(); test.rejectNetwork(); await test.loader.reload();
  for (const delay of [1000, 2000, 4000, 8000, 16000, 30000, 30000]) {
    assert.equal(test.timers.size, 1); test.rejectNetwork(); await test.advance(delay - 1);
    const before = test.calls.length; await test.advance(1); assert.equal(test.calls.length, before + 1);
  }
  test.finish(); checks.push("repeated outages back off 1/2/4/8/16/30s and remain capped at 30s");
}
assert.ok(requests.every(item => item.method === "GET" && item.url === "/api/cover-styles"));
assert.equal(readFileSync(path.join(root, sourcePath), "utf8"), source, "Source changed during verification; rerun");
console.log(JSON.stringify({ passed: true, checks: checks.length, cases: checks, fixtureGets: requests.length,
  realNetworkCalls: 0, workflowPosts: 0, providerCalls: 0, billingCalls: 0,
  source: { path: sourcePath, sha256: createHash("sha256").update(source).digest("hex") } }, null, 2));
