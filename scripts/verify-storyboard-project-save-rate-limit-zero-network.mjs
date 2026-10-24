import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";

// Exercise the real hook callbacks with an in-memory React scheduler and fetch.
// No HTTP, database, storage file, or provider operations are used.
const source = readFileSync("src/hooks/use-storyboard-projects.ts", "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
} }).outputText;

function harness(responses) {
  let now = Date.parse("2026-10-21T00:00:00Z"), cursor = 0, timerId = 0;
  const slots = [], effects = [], timers = new Map(), calls = [];
  const same = (a, b) => a && b && a.length === b.length && a.every((value, i) => value === b[i]);
  const react = {
    useRef(value) { const i = cursor++; return slots[i] ??= { current: value }; },
    useState(value) {
      const i = cursor++; slots[i] ??= { value };
      return [slots[i].value, update => { slots[i].value = typeof update === "function" ? update(slots[i].value) : update; }];
    },
    useCallback(callback, deps) {
      const i = cursor++; if (!same(slots[i]?.deps, deps)) slots[i] = { deps, callback };
      return slots[i].callback;
    },
    useEffect(callback, deps) {
      const i = cursor++; if (!same(slots[i]?.deps, deps)) effects.push(() => {
        slots[i]?.cleanup?.(); slots[i] = { deps, cleanup: callback() };
      });
    },
  };
  const exported = {};
  runInNewContext(compiled, {
    exports: exported, require: name => name === "react" ? react : { sortStoryboardProjectsBySubmission: value => value },
    Date: class extends Date { static now() { return now; } },
    DOMException, AbortController, Error, JSON, Map, Set, Number,
    localStorage: { getItem: () => null, setItem() {} },
    window: {
      setTimeout(callback, delay) { const id = ++timerId; timers.set(id, { callback, at: now + delay }); return id; },
      clearTimeout(id) { timers.delete(id); },
    },
    fetch: async (url, options) => {
      if (options.method !== "POST") return { ok: true, json: async () => ({ projects: [], nextOffset: null }) };
      calls.push(JSON.parse(options.body));
      const response = responses.shift(); assert.ok(response, "Unexpected POST");
      return { ok: response.status === 200, status: response.status,
        headers: { get: () => response.header ?? null }, json: async () => response.body };
    },
  });
  function render() {
    cursor = 0; const hook = exported.useStoryboardProjects("mock-user", "mock-token");
    while (effects.length) effects.shift()();
    return hook;
  }
  return { exported, calls, render, advance(ms) {
    now += ms;
    for (const [id, timer] of timers) if (timer.at <= now) { timers.delete(id); timer.callback(); }
  } };
}

const fixture = harness([]);
const parse = fixture.exported.storyboardRetryAfterMs;
const base = Date.parse("2026-10-21T00:00:00Z");
assert.equal(parse("7", 99, base), 7000);
assert.equal(parse("Wed, 21 Oct 2026 00:00:09 GMT", 99, base), 9000);
assert.equal(parse(null, 4, base), 4000);
assert.equal(parse("invalid", "6", base), 6000);
assert.equal(parse(null, undefined, base), 30000);
assert.equal(parse(null, null, base), 30000);
assert.equal(parse("0", 8, base), 1000);

const document = { id: "project-a", title: "initial draft" };
const success = revision => ({ status: 200, body: { project: { id: document.id, revision } } });
const rate = harness([
  { status: 429, header: "5", body: { error: "请求过于频繁", code: "RATE_LIMITED" } },
  success(1), success(2),
]);
let hook = rate.render();
const results = await Promise.all([hook.save(document), hook.save(document), hook.save(document, true), hook.save({ id: "project-b" })]);
assert.deepEqual(results, [false, false, false, false]);
assert.equal(rate.calls.length, 1, "All projects and manual saves share one cooldown");
hook = rate.render();
assert.equal(hook.saveRetryAt, base + 5000);
assert.match(hook.message, /尚未保存.*5 秒/);
rate.advance(2000);
assert.equal(await hook.save(document, true), false);
assert.equal(rate.calls.length, 1);
hook = rate.render(); assert.match(hook.message, /3 秒/);
rate.advance(3000);
hook = rate.render(); assert.equal(hook.saveRetryAt, 0, "One timer wakes autosave at expiry");
assert.equal(await hook.save({ ...document, title: "latest draft" }), true);
assert.equal(rate.calls[1].expectedRevision, 0, "429 must not advance revision");
assert.equal(rate.calls[1].document.title, "latest draft");
assert.equal(await hook.save({ ...document, title: "latest draft" }), true);
assert.equal(rate.calls.length, 2, "Only confirmed successful content is deduplicated");
assert.equal(await hook.save({ ...document, title: "newer draft" }), true);
assert.equal(rate.calls[2].expectedRevision, 1);

const conflict = harness([{ status: 409, body: { error: "版本冲突", code: "REVISION_CONFLICT" } }, success(3)]);
hook = conflict.render();
assert.equal(await hook.save(document), false);
assert.equal(await hook.save(document), false);
assert.equal(conflict.calls.length, 1, "409 keeps automatic save blocked");
assert.equal(await hook.save(document, true), true, "Manual conflict recovery remains available");

const invalid = harness([{ status: 400, body: { error: "无效任务" } }]);
hook = invalid.render();
assert.equal(await hook.save(document), false);
assert.equal(await hook.save(document), false);
assert.equal(invalid.calls.length, 1, "400 keeps automatic save blocked");

const bodyFallback = harness([{ status: 429, body: { error: "rate", retryAfter: 8 } }, success(1)]);
hook = bodyFallback.render(); assert.equal(await hook.save(document, true), false);
hook = bodyFallback.render(); assert.equal(hook.saveRetryAt, base + 8000);
bodyFallback.advance(8000); hook = bodyFallback.render();
assert.equal(await hook.save(document), true);

const typed = new fixture.exported.StoryboardProjectRequestError("rate", 429, "RATE_LIMITED", 5000);
assert.equal(typed.status, 429); assert.equal(typed.code, "RATE_LIMITED"); assert.equal(typed.retryAfterMs, 5000);
console.log(JSON.stringify({ passed: true, checks: ["retry-after seconds/date/body/default", "429 queue/manual/project cooldown", "expiry latest-document recovery", "revision/fingerprint preservation", "409 automatic block/manual recovery", "typed request error"], networkRequests: 0, databaseWrites: 0 }));
