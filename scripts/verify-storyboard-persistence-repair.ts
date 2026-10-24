import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import type { useStoryboardProjects } from "../src/hooks/use-storyboard-projects";
import { StoryboardProjectDocument } from "../src/lib/storyboard-project-contract";
import {
  mergeStoryboardRecoveryEdits, readStoryboardRecovery, storyboardRecoveryContentFingerprint,
  storyboardRecoveryStorageKey, writeStoryboardRecovery,
} from "../src/lib/storyboard-workspace-recovery";

const paths = ["src/hooks/use-storyboard-projects.ts", "src/lib/storyboard-workspace-recovery.ts"];
const hashes = () => Object.fromEntries(paths.map(path => [path, createHash("sha256").update(readFileSync(path)).digest("hex")]));
const before = hashes();
const source = readFileSync(paths[0], "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
let networkRequests = 0;
globalThis.fetch = (async () => { networkRequests++; throw new Error("NETWORK_FORBIDDEN"); }) as typeof fetch;
const checks: string[] = [];
const check = (name: string, action: () => void | Promise<void>) => Promise.resolve().then(action).then(() => { checks.push(name); });
type Document = { id: string; title?: string };
type Hook = ReturnType<typeof useStoryboardProjects<Document>>;
type ResponseFixture = { status: number; body: unknown; header?: string; error?: Error; waitForAbort?: boolean; deferred?: (options: RequestInit) => Promise<ResponseFixture> };
type Slot = { current?: unknown; value?: unknown; deps?: unknown[]; callback?: unknown; cleanup?: () => void };
const baseTime = Date.parse("2026-10-23T00:00:00Z");
const success = (id = "project-a", revision = 1): ResponseFixture => ({ status: 200, body: { project: { id, revision } } });
async function flush() { for (let i = 0; i < 12; i++) await Promise.resolve(); }

// Only React scheduling, browser timers/storage and fetch transport are simulated.
// The hook and recovery functions above are current source, not copied behavior.
function harness(responses: ResponseFixture[]) {
  let now = baseTime, cursor = 0, timerId = 0;
  const slots: Slot[] = [], effects: Array<() => void> = [], timers = new Map<number, { callback: () => void; at: number }>();
  const calls: Array<{ document: Document; expectedRevision: number; auth: string }> = [];
  const storage = new Map<string, string>();
  const same = (a?: unknown[], b?: unknown[]) => a && b && a.length === b.length && a.every((value, i) => value === b[i]);
  const react = {
    useRef(value: unknown) { const i = cursor++; return slots[i] ??= { current: value }; },
    useState(value: unknown) {
      const i = cursor++; slots[i] ??= { value };
      return [slots[i].value, (update: unknown) => { slots[i].value = typeof update === "function" ? update(slots[i].value) : update; }];
    },
    useCallback(callback: unknown, deps: unknown[]) {
      const i = cursor++; if (!same(slots[i]?.deps, deps)) slots[i] = { deps, callback };
      return slots[i].callback;
    },
    useEffect(callback: () => void | (() => void), deps: unknown[]) {
      const i = cursor++; if (!same(slots[i]?.deps, deps)) effects.push(() => {
        slots[i]?.cleanup?.(); slots[i] = { deps, cleanup: callback() || undefined };
      });
    },
  };
  const exported = {} as { useStoryboardProjects: (user: string, token: string) => Hook };
  runInNewContext(compiled, {
    exports: exported, require: (name: string) => {
      assert.ok(name === "react" || name === "@/lib/storyboard-project-contract", `Unexpected hook dependency: ${name}`);
      return name === "react" ? react : { sortStoryboardProjectsBySubmission: (value: unknown) => value };
    },
    Date: class extends Date { static now() { return now; } },
    DOMException, AbortController, Error, JSON, Map, Set, Number,
    localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => { storage.set(key, value); } },
    window: {
      setTimeout(callback: () => void, delay: number) { const id = ++timerId; timers.set(id, { callback, at: now + delay }); return id; },
      clearTimeout(id: number) { timers.delete(id); },
    },
    fetch: async (_url: string, options: RequestInit) => {
      if (options.method !== "POST") return { ok: true, json: async () => ({ projects: [], nextOffset: null }) };
      const request = JSON.parse(String(options.body));
      calls.push({ ...request, auth: (options.headers as Record<string, string>).Authorization });
      let response = responses.shift(); assert.ok(response, "Unexpected POST");
      if (response.deferred) response = await response.deferred(options);
      if (response.error) throw response.error;
      if (response.waitForAbort) await new Promise((_resolve, reject) => {
        options.signal?.addEventListener("abort", () => reject(new DOMException("This operation was aborted", "AbortError")), { once: true });
      });
      const resolved = response;
      return { ok: resolved.status === 200, status: resolved.status, headers: { get: () => resolved.header ?? null }, json: async () => resolved.body };
    },
  });
  function render(user = "fixture-user-a", token = "fixture-session-a") {
    cursor = 0; const hook = exported.useStoryboardProjects(user, token);
    while (effects.length) effects.shift()!();
    return hook;
  }
  return { calls, render, storage, now: () => now,
    advance(ms: number) { now += ms; for (const [id, timer] of timers) if (timer.at <= now) { timers.delete(id); timer.callback(); } },
    unmount() { for (const slot of slots) slot.cleanup?.(); },
  };
}

async function main() {
  const initial = { id: "project-a", title: "before outage" };
  for (const [label, failure] of [
    ["network", { status: 0, body: {}, error: new TypeError("Failed to fetch") }],
    ["503", { status: 503, body: { error: "temporary unavailable" } }],
    ["408", { status: 408, body: { error: "request timeout" } }],
  ] as Array<[string, ResponseFixture]>) await check(`${label}: retry confirms original body before latest edits at confirmed revision`, async () => {
    const test = harness([failure, success(), success("project-a", 2)]); let hook = test.render();
    const unchanged = JSON.stringify(initial);
    assert.equal(await hook.save(initial), false);
    assert.equal(await hook.save(initial), false);
    assert.equal(test.calls.length, 1, "Cooldown prevents duplicate queue submissions");
    hook = test.render(); assert.equal(hook.saveRetryAt, baseTime + 5000);
    assert.match(hook.message, /5 秒后可重试.*已提交项目将自动重试/); assert.doesNotMatch(hook.message, /过于频繁/);
    test.advance(5000); hook = test.render(); assert.equal(hook.saveRetryAt, 0, "Changed saveRetryAt wakes the main autosave effect");
    assert.equal(await hook.save({ ...initial, title: "edits made during outage" }), true);
    assert.equal(test.calls[1].document.title, initial.title); assert.equal(test.calls[2].document.title, "edits made during outage"); assert.equal(test.calls[2].expectedRevision, 1);
    assert.equal(test.calls[1].expectedRevision, 0); assert.equal(JSON.stringify(initial), unchanged);
    assert.equal(await hook.save({ ...initial, title: "edits made during outage" }), true);
    assert.equal(test.calls.length, 3, "Only confirmed content is deduplicated");
  });
  await check("actual 15-second request timeout becomes retryable 408; unmount abort stays silent", async () => {
    const test = harness([{ status: 0, body: {}, waitForAbort: true }, success(), success("project-a", 2)]); let hook = test.render();
    const pending = hook.save(initial); await flush(); assert.equal(test.calls.length, 1);
    test.advance(15000); assert.equal(await pending, false);
    hook = test.render(); assert.equal(hook.saveRetryAt, baseTime + 20000);
    test.advance(5000); hook = test.render(); assert.equal(hook.saveRetryAt, 0);
    assert.equal(await hook.save({ ...initial, title: "after timeout" }), true);
    const cancelled = harness([{ status: 0, body: {}, waitForAbort: true }]);
    const state = cancelled.render(); const waiting = state.save(initial); await flush();
    cancelled.unmount(); assert.equal(await waiting, false);
    assert.equal(cancelled.calls.length, 1); assert.equal(cancelled.render().saveRetryAt, 0);
  });
  await check("lost committed reply replays exact body; newer queued edits use each confirmed revision", async () => {
    let release!: (value: ResponseFixture) => void;
    const test = harness([
      { status: 503, body: { error: "reply lost after commit" } },
      { status: 0, body: {}, deferred: () => new Promise(resolve => { release = resolve; }) },
      success("project-a", 2), success("project-a", 3),
    ]);
    let hook = test.render(); assert.equal(await hook.save(initial), false);
    test.advance(5000); hook = test.render();
    const second = hook.save({ ...initial, title: "second" });
    await flush(); const third = hook.save({ ...initial, title: "third" });
    assert.deepEqual(test.calls[1], test.calls[0], "Full original document, revision and owner replay unchanged");
    release(success("project-a", 1)); assert.equal(await second, true); assert.equal(await third, true);
    assert.deepEqual(test.calls.map(call => call.expectedRevision), [0, 0, 1, 2]);
    assert.deepEqual(test.calls.map(call => call.document.title), [initial.title, initial.title, "second", "third"]);
  });
  await check("a real concurrent update rejects original replay and never submits edited replacement", async () => {
    const test = harness([{ status: 503, body: {} }, { status: 409, body: { code: "REVISION_CONFLICT", error: "other window changed" } }]);
    let hook = test.render(); assert.equal(await hook.save(initial), false); test.advance(5000); hook = test.render();
    assert.equal(await hook.save({ ...initial, title: "must remain local" }), false);
    assert.equal(test.calls.length, 2); assert.deepEqual(test.calls[0], test.calls[1]);
    assert.equal(await hook.save({ ...initial, title: "still local" }), false);
  });
  await check("Retry-After and bounded backoff preserve 429 recovery", async () => {
    const test = harness([{ status: 503, header: "12", body: {} }, { status: 429, body: { retryAfter: 8 } }, success()]);
    let hook = test.render(); assert.equal(await hook.save(initial), false);
    hook = test.render(); assert.equal(hook.saveRetryAt, baseTime + 12000);
    test.advance(12000); hook = test.render(); assert.equal(await hook.save(initial), false);
    hook = test.render(); assert.equal(hook.saveRetryAt, baseTime + 20000);
    test.advance(8000); hook = test.render(); assert.equal(await hook.save(initial), true);
    const repeated = harness([...Array.from({ length: 5 }, () => ({ status: 503, body: {} })), success(), { status: 503, body: {} }]);
    hook = repeated.render();
    for (const delay of [5000, 10000, 20000, 30000, 30000]) {
      assert.equal(await hook.save(initial), false); hook = repeated.render();
      assert.equal(hook.saveRetryAt - repeated.now(), delay);
      repeated.advance(delay); hook = repeated.render();
    }
    assert.equal(await hook.save(initial), true);
    assert.equal(await hook.save({ ...initial, title: "next edit" }), false);
    hook = repeated.render(); assert.equal(hook.saveRetryAt - repeated.now(), 5000, "A confirmed save resets backoff");
  });
  await check("409 and validation errors remain blocked until explicit action", async () => {
    for (const status of [409, 400, 403]) {
      const test = harness([{ status, body: { error: "manual action needed" } }, success()]);
      let hook = test.render(); assert.equal(await hook.save(initial), false);
      test.advance(60000); hook = test.render(); assert.equal(hook.saveRetryAt, 0);
      assert.equal(await hook.save(initial), false); assert.equal(test.calls.length, 1);
      assert.equal(await hook.save(initial, true), true);
    }
  });
  await check("account change drops queued saves, late responses, and stale refresh callbacks", async () => {
    let release!: (fixture: ResponseFixture) => void;
    const test = harness([{ status: 0, body: {}, deferred: () => new Promise(resolve => { release = resolve; }) }, success("project-b", 7)]);
    const old = test.render(); const pending = old.save(initial); const queued = old.save({ ...initial, title: "old queued" });
    await flush(); assert.equal(test.calls.length, 1);
    let current = test.render("fixture-user-b", "fixture-session-b");
    await old.refresh(); await flush(); current = test.render("fixture-user-b", "fixture-session-b");
    assert.equal(current.loading, false, "Stale refresh must not poison the new owner's loading or list sequence");
    assert.equal(await current.save({ id: "project-b", title: "new owner" }), true);
    release(success("project-a", 99)); assert.equal(await pending, false); assert.equal(await queued, false);
    assert.equal(await old.save(initial, true), false);
    current = test.render("fixture-user-b", "fixture-session-b");
    assert.equal(current.projects.length, 1); assert.equal(current.projects[0].id, "project-b");
    assert.equal(test.calls.length, 2); assert.equal(test.calls[1].auth, "Bearer fixture-session-b");
    assert.equal(test.storage.get("storyboard-project-versions:v1:fixture-user-a"), undefined);
    assert.equal(JSON.parse(test.storage.get("storyboard-project-versions:v1:fixture-user-b")!)["project-b"], 7);
  });

  const base = {
    id: "project-recovery", title: "saved title", createdAt: 1, updatedAt: 2,
    ratio: "16:9" as const, imageResolution: "2K", videoResolution: "1080p", videoDuration: 10,
    imageModelId: "fixture-image", videoModelId: "fixture-video",
    cards: [{ id: "card-a", order: 1, imagePrompt: "saved image prompt", videoPrompt: "saved video prompt", referenceImageUrls: [] as string[],
      imageStatus: "running", videoStatus: "running",
      imageClientRequestId: "image-attempt-a", imageClientRequestFingerprint: "image-params-a", imageAttemptOrdinal: 1,
      videoClientRequestId: "video-attempt-a", videoClientRequestFingerprint: "video-params-a" }],
  };
  const baseFingerprint = storyboardRecoveryContentFingerprint(base);
  const local = { ...base, title: "unsaved local title", cards: [{ ...base.cards[0], imagePrompt: "unsaved image edit", videoPrompt: "unsaved video edit" }] };
  const cloud = { ...base, updatedAt: 40, lastSubmittedAt: 30, cards: [{ ...base.cards[0],
    imageStatus: "done" as const, imageRecordId: "a".repeat(64), imageUrl: "/api/generated-images/a?ticket=new", imageBillingState: "charged", imagePriceCharged: 0.3,
    imageRef: { recordId: "a".repeat(64) }, imageRecoveryReady: true,
    videoStatus: "done" as const, videoTaskId: "video-task-a", videoUrl: "/api/video/content?taskId=video-task-a", videoProgress: 100,
    videoBillingState: "charged", videoPriceCharged: 0.55, continuousVideoInputFingerprint: "b".repeat(32),
  }] };
  await check("same-request polling accepts editable recovery while keeping cloud media/tasks/billing", () => {
    assert.equal(storyboardRecoveryContentFingerprint(cloud), baseFingerprint);
    const untouched = JSON.stringify({ cloud, local });
    const result = mergeStoryboardRecoveryEdits<typeof base>(cloud, { run: local, baseContentFingerprint: baseFingerprint });
    assert.equal(result.title, local.title); assert.equal(result.cards[0].imagePrompt, local.cards[0].imagePrompt);
    const restoredCard = result.cards[0] as Record<string, unknown>;
    for (const key of ["imageStatus", "imageRecordId", "imageUrl", "imageBillingState", "imagePriceCharged", "imageRef", "imageRecoveryReady", "videoStatus", "videoTaskId", "videoUrl", "videoProgress", "videoBillingState", "videoPriceCharged", "continuousVideoInputFingerprint"]) {
      assert.deepEqual(restoredCard[key], (cloud.cards[0] as Record<string, unknown>)[key], key);
    }
    assert.equal(JSON.stringify({ cloud, local }), untouched, "Neither failed recovery nor successful merge mutates its inputs");
    assert.equal(result.updatedAt, 40);
  });
  await check("new image attempt or video request and concurrent cloud edits reject stale recovery", () => {
    for (const changed of [
      { ...cloud, cards: [{ ...cloud.cards[0], imageClientRequestId: "image-attempt-b" }] },
      { ...cloud, cards: [{ ...cloud.cards[0], videoClientRequestId: "video-attempt-b" }] },
      { ...cloud, cards: [{ ...cloud.cards[0], imageAttemptOrdinal: 2 }] },
      { ...cloud, title: "new cloud edit" },
      { ...cloud, id: "other-project" },
    ]) assert.equal(mergeStoryboardRecoveryEdits<typeof base>(changed, { run: local, baseContentFingerprint: baseFingerprint }), changed);
  });
  await check("legacy content-only cache is accepted only for the same task lineage", () => {
    const legacy = JSON.parse(baseFingerprint); delete legacy.taskLineages;
    const envelope = { run: local, baseContentFingerprint: JSON.stringify(legacy) };
    const restored = mergeStoryboardRecoveryEdits<typeof base>(cloud, envelope);
    assert.equal(restored.title, local.title); assert.equal((restored.cards[0] as Record<string, unknown>).videoTaskId, "video-task-a");
    const newTask = { ...cloud, cards: [{ ...cloud.cards[0], videoClientRequestId: "other-attempt" }] };
    assert.equal(mergeStoryboardRecoveryEdits<typeof base>(newTask, envelope), newTask);
  });
  await check("legacy media identity changes conflict; signed URL refresh alone does not", () => {
    const oldMedia = { id: "media-project", title: "saved", cards: [{ id: "media-card", imageUrl: "https://fixture.invalid/image.png?q-signature=old", videoTaskId: "task-old" }] };
    const newerTicket = { ...oldMedia, cards: [{ ...oldMedia.cards[0], imageUrl: "https://fixture.invalid/image.png?q-signature=new" }] };
    const envelope = { run: { ...oldMedia, title: "local edit" }, baseContentFingerprint: storyboardRecoveryContentFingerprint(oldMedia) };
    const merged = mergeStoryboardRecoveryEdits(newerTicket, envelope);
    assert.equal(merged.title, "local edit"); assert.equal(merged.cards[0].imageUrl, newerTicket.cards[0].imageUrl);
    for (const item of [{ ...oldMedia.cards[0], videoTaskId: "task-new" }, { ...oldMedia.cards[0], imageUrl: "https://fixture.invalid/new.png" }]) {
      const changed = { ...oldMedia, cards: [item] }; assert.equal(mergeStoryboardRecoveryEdits(changed, envelope), changed);
    }
    const urlOnly = { id: "legacy-url-only", title: "saved", cards: [{ id: "url-card", videoUrl: "/api/video/proxy?taskId=task-a&media_ticket=old" }] };
    const newTask = { ...urlOnly, cards: [{ ...urlOnly.cards[0], videoUrl: "/api/video/proxy?taskId=task-b&media_ticket=new" }] };
    const ticketRenewed = { ...urlOnly, cards: [{ ...urlOnly.cards[0], videoUrl: "/api/video/proxy?media_ticket=new&taskId=task-a&q-signature=rotated" }] };
    const urlRecovery = { run: { ...urlOnly, title: "local edit" }, baseContentFingerprint: storyboardRecoveryContentFingerprint(urlOnly) };
    assert.notEqual(storyboardRecoveryContentFingerprint(newTask), urlRecovery.baseContentFingerprint, "URL-only task identity must not collapse into its proxy path");
    assert.equal(storyboardRecoveryContentFingerprint(ticketRenewed), urlRecovery.baseContentFingerprint);
    assert.equal(mergeStoryboardRecoveryEdits(newTask, urlRecovery), newTask);
    assert.equal(mergeStoryboardRecoveryEdits(ticketRenewed, urlRecovery).cards[0].videoUrl, ticketRenewed.cards[0].videoUrl);
  });
  await check("director intake and execution recover together; newer cloud director state wins", () => {
    const directorBase = { ...base, directorIntake: { phase: "assets", confirmedAssets: [] as string[] }, cards: [{ ...base.cards[0], directorExecution: { segmentId: "old" } }] };
    const directorLocal = { ...directorBase, directorIntake: { phase: "planned", confirmedAssets: ["actor-a"] }, cards: [{ ...directorBase.cards[0], directorExecution: { segmentId: "new" } }] };
    const envelope = { run: directorLocal, baseContentFingerprint: storyboardRecoveryContentFingerprint(directorBase) };
    const merged = mergeStoryboardRecoveryEdits(directorBase, envelope);
    assert.deepEqual(merged.directorIntake, directorLocal.directorIntake); assert.deepEqual(merged.cards[0].directorExecution, directorLocal.cards[0].directorExecution);
    const changed = { ...directorBase, directorIntake: { phase: "planned", confirmedAssets: ["different-actor"] } };
    assert.equal(mergeStoryboardRecoveryEdits(changed, envelope), changed);
  });
  await check("new local draft cards restore edits without accepting unverified task/media receipts", () => {
    const localDraft = { id: "new-draft-card", order: 2, imageStatus: "idle", videoStatus: "idle", imagePrompt: "new prompt", referenceImageUrls: [] };
    type FlexibleRun = { id: string; cards: Array<{ id: string; [key: string]: unknown }>; [key: string]: unknown };
    const recovery = { run: { ...local, cards: [...local.cards, localDraft] }, baseContentFingerprint: baseFingerprint };
    const restored = mergeStoryboardRecoveryEdits<FlexibleRun>(cloud, recovery);
    assert.equal(restored.cards.length, 2); assert.equal(restored.cards[1].imagePrompt, "new prompt");
    const injected = { ...recovery, run: { ...recovery.run, cards: [...local.cards, { ...localDraft, videoTaskId: "unconfirmed-task" }] } };
    assert.equal(mergeStoryboardRecoveryEdits<FlexibleRun>(cloud, injected), cloud);
  });
  await check("account/session storage isolation and rejected recovery retain local edits", async () => {
    const keyA = await storyboardRecoveryStorageKey("fixture-account-a", "fixture-session-a");
    const keyB = await storyboardRecoveryStorageKey("fixture-account-b", "fixture-session-a");
    const keyOtherSession = await storyboardRecoveryStorageKey("fixture-account-a", "fixture-session-b");
    assert.notEqual(keyA, keyB); assert.notEqual(keyA, keyOtherSession); assert.ok(!keyA.includes("fixture-session-a"));
    assert.equal(StoryboardProjectDocument.safeParse(local).success, true);
    const values = new Map<string, string>();
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
    writeStoryboardRecovery(storage, keyA, local, baseFingerprint);
    const original = values.get(keyA); const recovered = readStoryboardRecovery(storage, keyA); assert.ok(recovered);
    assert.equal(recovered.run.title, local.title); assert.equal(readStoryboardRecovery(storage, keyB), null); assert.equal(readStoryboardRecovery(storage, keyOtherSession), null);
    const newer = { ...cloud, title: "new cloud version" }; assert.equal(mergeStoryboardRecoveryEdits(newer, recovered as unknown as { run: typeof newer; baseContentFingerprint: string }), newer);
    assert.equal(values.get(keyA), original, "Conflicts must retain the unsaved local snapshot");
    values.set(keyB, original!); assert.equal(readStoryboardRecovery(storage, keyB), null, "Envelope scope must match the requested account/session key");
  });
  const after = hashes(); assert.deepEqual(after, before, "Tested source changed during execution"); assert.equal(networkRequests, 0);
  console.log(JSON.stringify({ passed: true, checks, sourceHashes: { before, after }, networkRequests, databaseWrites: 0, providerSubmissions: 0 }, null, 2));
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
