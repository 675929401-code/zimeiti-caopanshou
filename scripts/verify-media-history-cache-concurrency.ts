import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

type Snapshot = {
  marker: string;
  rows: readonly unknown[];
  facets: Record<string, unknown>;
  sourceFailures: readonly string[];
  enumerationFailed: boolean;
  allSourcesFailed: boolean;
};

type CacheStats = {
  active: number;
  waiting: number;
  pending: number;
  settled: number;
  keys: string[];
};

type CacheHook = {
  load: (cacheKey: string, build: () => Promise<unknown>) => Promise<unknown>;
  invalidate: (cacheKey: string) => void;
  expireSettled: (cacheKey: string) => void;
  clear: () => void;
  stats: () => CacheStats;
  busyResponse: () => Response;
  limits: { active: number; waiting: number; settled: number };
};

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

function snapshot(marker: string, enumerationFailed = false): Snapshot {
  return {
    marker,
    rows: [],
    facets: {},
    sourceFailures: enumerationFailed ? ["fixture"] : [],
    enumerationFailed,
    allSourcesFailed: false,
  };
}

async function flush(): Promise<void> {
  await new Promise<void>(resolve => setImmediate(resolve));
}

async function waitUntil(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await flush();
  }
  throw new Error(`WAIT_TIMEOUT:${label}`);
}

async function verifyPendingJoinAndSettledTtl(hook: CacheHook): Promise<void> {
  hook.clear();
  const gate = deferred<Snapshot>();
  let builds = 0;
  const first = hook.load("join", async () => {
    builds += 1;
    return gate.promise;
  });
  const joined = hook.load("join", async () => {
    builds += 1;
    return snapshot("must-not-run");
  });
  assert.equal(joined, first, "pending 请求必须复用同一个 Promise");
  await waitUntil(() => builds === 1, "pending-builder-started");
  gate.resolve(snapshot("first"));
  assert.equal((await first as Snapshot).marker, "first");
  assert.equal((await joined as Snapshot).marker, "first");

  const cached = await hook.load("join", async () => {
    builds += 1;
    return snapshot("must-not-run-before-expiry");
  }) as Snapshot;
  assert.equal(cached.marker, "first", "settled TTL 内必须复用结果");
  assert.equal(builds, 1);

  hook.expireSettled("join");
  const refreshed = await hook.load("join", async () => {
    builds += 1;
    return snapshot("refreshed");
  }) as Snapshot;
  assert.equal(refreshed.marker, "refreshed", "settled TTL 到期后必须重建");
  assert.equal(builds, 2);
}

async function verifyEntryIdentityCas(hook: CacheHook): Promise<void> {
  hook.clear();
  const oldGate = deferred<Snapshot>();
  const newGate = deferred<Snapshot>();
  const oldPromise = hook.load("cas-success", () => oldGate.promise);
  await flush();
  hook.invalidate("cas-success");
  const newPromise = hook.load("cas-success", () => newGate.promise);
  oldGate.resolve(snapshot("old"));
  assert.equal((await oldPromise as Snapshot).marker, "old");
  const joinedNew = hook.load("cas-success", async () => snapshot("must-not-replace-new"));
  assert.equal(joinedNew, newPromise, "旧成功 Promise 不得覆盖新的 pending entry");
  newGate.resolve(snapshot("new"));
  assert.equal((await newPromise as Snapshot).marker, "new");

  const rejectedGate = deferred<Snapshot>();
  const replacementGate = deferred<Snapshot>();
  const rejected = hook.load("cas-reject", () => rejectedGate.promise);
  const rejectedOutcome = rejected.then(
    () => "resolved",
    () => "rejected",
  );
  await flush();
  hook.invalidate("cas-reject");
  const replacement = hook.load("cas-reject", () => replacementGate.promise);
  rejectedGate.reject(new Error("OLD_BUILD_FAILED"));
  assert.equal(await rejectedOutcome, "rejected");
  const joinedReplacement = hook.load("cas-reject", async () => snapshot("must-not-run"));
  assert.equal(joinedReplacement, replacement, "旧失败 Promise 不得删除新的 pending entry");
  replacementGate.resolve(snapshot("replacement"));
  assert.equal((await replacement as Snapshot).marker, "replacement");
}

async function verifyGlobalConcurrencyAndEviction(hook: CacheHook): Promise<void> {
  hook.clear();
  assert.deepEqual(hook.limits, { active: 4, waiting: 32, settled: 32 });
  const activeGates = Array.from({ length: hook.limits.active }, () => deferred<void>());
  let running = 0;
  let peak = 0;
  let started = 0;
  const activePromises = activeGates.map((gate, index) => hook.load(`active-${index}`, async () => {
    started += 1;
    running += 1;
    peak = Math.max(peak, running);
    try {
      await gate.promise;
      return snapshot(`active-${index}`);
    } finally {
      running -= 1;
    }
  }));
  await waitUntil(() => started === hook.limits.active, "four-active-builds");

  let queuedStarted = 0;
  const queuedPromises = Array.from({ length: hook.limits.waiting }, (_, index) => (
    hook.load(`queued-${index}`, async () => {
      queuedStarted += 1;
      return snapshot(`queued-${index}`);
    })
  ));
  await waitUntil(() => hook.stats().waiting === hook.limits.waiting, "waiting-queue-full");
  const beforeRelease = hook.stats();
  assert.equal(beforeRelease.active, 4);
  assert.equal(beforeRelease.waiting, 32);
  assert.equal(beforeRelease.pending, 36);
  assert.equal(beforeRelease.settled, 0);
  assert.equal(queuedStarted, 0);
  assert.ok(beforeRelease.keys.includes("active-0"), "settled LRU 不得淘汰 pending entry");

  const joined = hook.load("active-0", async () => snapshot("must-not-run"));
  assert.equal(joined, activePromises[0], "队列满时同 key 仍必须 join pending");
  assert.equal(hook.stats().waiting, 32, "同 key join 不得占用额外等待位");
  await assert.rejects(
    hook.load("overflow", async () => snapshot("must-not-run")),
    /MEDIA_HISTORY_BUSY/,
    "第 33 个等待构建必须快速失败",
  );

  for (const gate of activeGates) gate.resolve();
  await Promise.all([...activePromises, ...queuedPromises]);
  await waitUntil(() => hook.stats().active === 0 && hook.stats().waiting === 0, "limiter-drained");
  const completed = hook.stats();
  assert.equal(peak <= hook.limits.active, true, "并行构建不得超过 active=4");
  assert.equal(started + queuedStarted, 36);
  assert.equal(completed.pending, 0);
  assert.equal(completed.settled, 32, "只在 settled 后执行 32 账号 LRU");
}

async function verifyBusyResponseAndDeleteInvalidationSource(hook: CacheHook): Promise<void> {
  const response = hook.busyResponse();
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("retry-after"), "1");
  assert.equal(response.headers.get("cache-control"), "private, no-store");

  const routeSource = await readFile(
    path.join(process.cwd(), "src", "app", "api", "media-history", "route.ts"),
    "utf8",
  );
  assert.match(
    routeSource,
    /if \(response\.ok\) invalidateMediaHistorySnapshot\(user\.userId, user\.role\)/u,
    "DELETE 成功后必须主动失效账号快照",
  );
  assert.match(
    routeSource,
    /rows: merged\.map\(item => \(\{ item, searchText: searchableText\(item\) \}\)\)/u,
    "完整 DTO、排序与 searchText 必须在账号快照构建阶段完成",
  );
}

async function main(): Promise<void> {
  process.env.MEDIA_HISTORY_CACHE_TEST_HOOK = "1";
  await import("../src/app/api/media-history/route");
  const testGlobal = globalThis as typeof globalThis & {
    __MEDIA_HISTORY_CACHE_TEST_HOOK__?: CacheHook;
  };
  const hook = testGlobal.__MEDIA_HISTORY_CACHE_TEST_HOOK__;
  assert.ok(hook, "媒体历史缓存测试 hook 未注册");
  try {
    await verifyPendingJoinAndSettledTtl(hook);
    await verifyEntryIdentityCas(hook);
    await verifyGlobalConcurrencyAndEviction(hook);
    await verifyBusyResponseAndDeleteInvalidationSource(hook);
    hook.clear();
    console.log("media-history cache concurrency verification passed: pending join, settled TTL, CAS, settled-only LRU, active/waiting bounds, busy response, delete invalidation");
  } finally {
    delete testGlobal.__MEDIA_HISTORY_CACHE_TEST_HOOK__;
    delete process.env.MEDIA_HISTORY_CACHE_TEST_HOOK;
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
