/* eslint-disable @typescript-eslint/no-explicit-any -- The VM runs extracted production callbacks with explicit in-memory test doubles. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

const sourcePath = "src/components/storyboard-workbench.tsx";
const output = ".codex-evidence/storyboard-delivery-audit-20261023/repair/late-results";
const source = readFileSync(sourcePath, "utf8");
const sourceHash = createHash("sha256").update(source).digest("hex");
const tree = ts.createSourceFile(sourcePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function findNodes<T extends ts.Node>(root: ts.Node, predicate: (node: ts.Node) => node is T): T[] {
  const result: T[] = [];
  const visit = (node: ts.Node) => { if (predicate(node)) result.push(node as T); ts.forEachChild(node, visit); };
  visit(root); return result;
}
function callback(name: string): ts.ArrowFunction {
  const declaration = findNodes(tree, ts.isVariableDeclaration).find(node => node.name.getText(tree) === name);
  assert.ok(declaration?.initializer && ts.isCallExpression(declaration.initializer), `Missing callback: ${name}`);
  const fn = declaration.initializer.arguments[0];
  assert.ok(fn && ts.isArrowFunction(fn), `Missing callback body: ${name}`); return fn;
}
const imageCallback = callback("generateImage"), videoCallback = callback("generateVideo");
function variable(root: ts.Node, name: string): ts.VariableDeclaration {
  const found = findNodes(root, ts.isVariableDeclaration).find(node => node.name.getText(tree) === name);
  assert.ok(found?.initializer, `Missing production declaration: ${name}`); return found;
}
function declaration(root: ts.Node, name: string) { return `const ${name} = ${variable(root, name).initializer!.getText(tree)};`; }
function compile(code: string, context: Record<string, any>): any {
  const js = ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const deadlineExports = {};
  const deadlineCode = ts.transpileModule(readFileSync("src/lib/storyboard-request-deadline.ts", "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  vm.runInNewContext(deadlineCode, { exports: deadlineExports, module: { exports: deadlineExports },
    AbortController, DOMException, Response, setTimeout: context.deadlineSetTimeout || setTimeout, clearTimeout,
    fetch: (...args: any[]) => context.fetch(...args) });
  return vm.runInNewContext(js, { Error, TypeError, Object, Array, String, Number, Boolean, JSON, Set, Map, Promise,
    Date, Blob, AbortController, AbortSignal, DOMException, Response, console, URL, setTimeout, clearTimeout,
    fetch: () => { throw new Error("REAL_NETWORK_FORBIDDEN"); }, ...context, ...deadlineExports });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(finish => { resolve = finish; });
  return { promise, resolve };
}
async function flush() { for (let turn = 0; turn < 15; turn++) await Promise.resolve(); }
const checks: Array<{ name: string; passed: boolean }> = [];
async function check(name: string, action: () => Promise<void> | void) { await action(); checks.push({ name, passed: true }); console.log("PASS " + name); }

const imagePostBlock = findNodes(imageCallback, ts.isBlock).find(block => block.statements.some(statement =>
  ts.isVariableStatement(statement) && statement.declarationList.declarations.some(node => node.name.getText(tree) === "pendingInlineBlobUrl")));
assert.ok(imagePostBlock, "Missing actual image POST/decode try-finally block");
const imageFailureBlock = findNodes(imageCallback, ts.isTryStatement).find(statement => statement.catchClause?.block.getText(tree).includes("inspectStoryboardImageAttempt"))?.catchClause?.block;
assert.ok(imageFailureBlock, "Missing actual image failure/recovery callback");

function imageFixture() {
  const imageOperation = Symbol("image-operation-a");
  const requestSnapshot = { runId: "project-a", cardId: "card-a", cardOrder: 1, prompt: "Synthetic storyboard", modelId: "model-a",
    aspectRatio: "16:9", resolution: "2K", referenceImageUrls: [], visualAssetRefs: [], strictSingleSubmit: false };
  const initialCard = { id: "card-a", order: 1, imageStatus: "running", imageClientRequestId: "request-a", imageClientTraceId: "trace-a",
    imageClientRequestFingerprint: "fingerprint-a", imageRequestSnapshot: requestSnapshot, videoPrompt: "keep target edits" };
  const initialRun = { id: "project-a", cards: [initialCard, { id: "card-b", order: 2, videoPrompt: "keep neighbor edits" }] };
  const runRef = { current: initialRun as any };
  const log = { patches: [] as any[], notices: [] as string[], clearAttempts: [] as any[], revocations: [] as string[], restoreCalls: 0, posts: 0 };
  class RetryableImageFileError extends Error {}
  const context: Record<string, any> = {
    userId: "user-a", token: "token-a", cardId: "card-a", card: initialCard, current: initialRun,
    requestSnapshot, clientIdempotencyKey: "request-a", clientTraceId: "trace-a", imageClientRequestFingerprint: "fingerprint-a",
    recovering: false, modelName: "Synthetic model", imageSubmissionOwner: "user-a\0token-a", expectedImageInput: "same-input",
    imageProviderDispatched: true, completedInlineReceipt: null, runRef,
    scopeMountedRef: { current: true }, contextReadyRef: { current: true }, navigationRef: { current: false },
    imageDownloadOwnerRef: { current: "user-a\0token-a" }, imageSubmissionsRef: { current: new Set(["card-a"]) },
    imageOperation, imageSubmissionOperationsRef: { current: new Map([["card-a", imageOperation]]) },
    originalBoardBlobsRef: { current: new Map() }, ephemeralImageUrlsRef: { current: new Set() },
    assertPlannedDirectorReferencesCurrent() {}, storyboardImageSubmissionInput: () => "same-input",
    patchCard(id: string, patch: Record<string, any>) {
      log.patches.push({ id, patch }); runRef.current = { ...runRef.current, cards: runRef.current.cards.map((item: any) => item.id === id ? { ...item, ...patch } : item) };
    },
    setNotice: (message: string) => log.notices.push(message),
    clearBrowserClientAttempt: (...args: any[]) => log.clearAttempts.push(args),
    storyboardInlineReceiptFields: () => null,
    providerMediaUrl: (url: string) => url?.startsWith("https://") ? url : null,
    GeneratedImageReferenceSchema: { safeParse: () => ({ success: true }) },
    browserImageReady: async () => ({ width: 2048, height: 1152 }),
    imageDimensionsMatchAspectRatio: () => true,
    readOwnedStoryboardImage: async () => null,
    restoreOwnedBoard: async () => { log.restoreCalls++; return false; },
    inspectStoryboardImageAttempt: async () => ({ state: "processing" }),
    storyboardImageFailurePresentation: (_typed: any, _status: any, message: string) => ({ confirmedRejected: false, message }),
    rememberStoryboardBoardBlob: (store: Map<string, any>, url: string, value: any) => store.set(url, value),
    resolveGeneratedImageClientDelivery: async () => ({ url: "blob:fixture-inline", blob: new Blob(["synthetic"]), revoke: () => log.revocations.push("blob:fixture-inline") }),
    rollbackImageSubmission() {}, RetryableImageFileError,
    submissionRun: initialRun, submittedRunIdsRef: { current: new Set() }, batchAuthorization: undefined, preparedImageBatchInput: undefined,
    assertBatchSnapshotCurrent() {}, createStoryboardPersistenceSnapshot: (value: any) => value,
  };
  const mutateCard = (patch: Record<string, any>) => { runRef.current = { ...runRef.current, cards: runRef.current.cards.map((item: any) => item.id === "card-a" ? { ...item, ...patch } : item) }; };
  return { context, log, runRef, mutateCard };
}
const successfulImage = { images: [{ url: "https://synthetic.invalid/image.png", recordId: "record-a", deliveryMode: "provider_url", width: 2048, height: 1152 }], cashCharged: 0.3 };
const scopeChanges: Array<[string, (fixture: ReturnType<typeof imageFixture>) => void]> = [
  ["owner", test => { test.context.imageDownloadOwnerRef.current = "user-b\0token-b"; }],
  ["run", test => { test.runRef.current = { ...test.runRef.current, id: "project-b" }; }],
  ["removed card", test => { test.runRef.current = { ...test.runRef.current, cards: test.runRef.current.cards.filter((item: any) => item.id !== "card-a") }; }],
  ["new request", test => test.mutateCard({ imageClientRequestId: "request-b", imageClientTraceId: "trace-b" })],
  ["new operation", test => { test.context.imageSubmissionOperationsRef.current.set("card-a", Symbol("new-operation")); }],
];

const imageTry = findNodes(imageCallback, ts.isTryStatement).find(statement => statement.catchClause?.block === imageFailureBlock)!;
const imageGuards = ["sameImageSubmissionScope", "sameImageRequestCurrent", "assertImageSubmissionCurrent"].map(name => declaration(imageCallback, name)).join("\n");
const videoGuards = ["sameSubmissionScope", "sameVideoRequestCurrent", "assertSubmissionCurrent"].map(name => declaration(videoCallback, name)).join("\n");
const videoTry = findNodes(videoCallback, ts.isTryStatement).find(statement => statement.tryBlock.statements.some(node =>
  ts.isVariableStatement(node) && node.declarationList.declarations.some(item => item.getText(tree).includes('"/api/video/generate"'))));
assert.ok(videoTry?.catchClause && videoTry.finallyBlock, "Missing actual video POST/catch/finally");
const responseIndex = videoTry.tryBlock.statements.findIndex(node => ts.isVariableStatement(node)
  && node.declarationList.declarations.some(item => item.getText(tree).includes('"/api/video/generate"')));
assert.ok(responseIndex >= 0);
const videoPostBody = videoTry.tryBlock.statements.slice(responseIndex).map(node => node.getText(tree)).join("\n");
function postSaveBody(statement: ts.TryStatement) {
  const start = statement.tryBlock.statements.findIndex(node => ts.isVariableStatement(node)
    && node.declarationList.declarations.some(item => item.name.getText(tree) === "projectSaved"));
  assert.ok(start >= 0, "Missing actual project-save boundary");
  return statement.tryBlock.statements.slice(start).map(node => node.getText(tree)).join("\n");
}
const rollback = findNodes(videoCallback, ts.isBinaryExpression).find(node => node.left.getText(tree) === "rollbackVideoSubmission" && ts.isArrowFunction(node.right));
assert.ok(rollback, "Missing actual conditional rollback callback");
function imageRunner(test: ReturnType<typeof imageFixture>, failureOnly = false, afterSave = false) {
  const body = failureOnly ? imageFailureBlock!.getText(tree)
    : `{ try { ${afterSave ? postSaveBody(imageTry) : imagePostBlock!.getText(tree)} } catch (error) ${imageFailureBlock!.getText(tree)} }`;
  return compile(`${imageGuards}\n(async function(error) { try ${body} finally ${imageTry.finallyBlock!.getText(tree)} });`, test.context);
}
function videoFixture() {
  const videoOperation = Symbol("video-operation-a"), submissionController = new AbortController();
  const card = { id: "card-a", order: 1, imageUrl: "https://synthetic.invalid/board.png", videoPrompt: "original target prompt", videoStatus: "done",
    videoUrl: "https://synthetic.invalid/old.mp4", videoTaskId: "old-task", videoClientRequestId: "old-request", videoClientRequestFingerprint: "old-fingerprint", videoStartedAt: 100, videoBillingState: "settled" };
  const beforeSave = { id: "project-a", title: "original title", lastSubmittedAt: 100, updatedAt: 100,
    cards: [card, { id: "card-b", order: 2, videoPrompt: "original neighbor prompt" }] };
  const runRef = { current: beforeSave as any };
  const log = { updates: [] as any[], patches: [] as any[], notices: [] as string[], clears: [] as any[], polls: [] as any[] };
  const context: Record<string, any> = { cardId: "card-a", card, current: beforeSave, beforeSave, beforeCard: card, runRef, submittedAt: 1000,
    submissionOwner: "user-a\0token-a", scopeMountedRef: { current: true }, contextReadyRef: { current: true }, navigationRef: { current: false },
    imageDownloadOwnerRef: { current: "user-a\0token-a" }, model: { id: "model-a", supportsRemoteCancel: false }, modelName: "Synthetic model", duration: 10,
    stableVideoClientRequestId: "video-request-a", preparedClientRequestId: "video-request-a", videoClientRequestFingerprint: "video-fingerprint-a",
    storyboardProductionVideoFingerprint: () => "video-content-a", videoOperation, submissionController,
    videoSubmissionOperationsRef: { current: new Map([["card-a", videoOperation]]) }, videoSubmissionsRef: { current: new Set(["card-a"]) },
    videoSubmissionControllersRef: { current: new Map([["card-a", submissionController]]) },
    setRun: (value: any) => log.updates.push(value),
    patchCard(id: string, patch: any) { log.patches.push({ id, patch }); runRef.current = { ...runRef.current, cards: runRef.current.cards.map((item: any) => item.id === id ? { ...item, ...patch } : item) }; },
    setNotice: (value: string) => log.notices.push(value), clearBrowserClientAttempt: (...args: any[]) => log.clears.push(args),
    friendlyVideoError: (message: string) => message, isAbortError: (error: Error) => error.name === "AbortError",
    providerSubmissionDispatched: true, confirmedUnsubmitted: false, videoClientAttemptScope: "storyboard-video:project-a:card-a",
    token: "token-a", tokenBilling: null, executionPrompt: "Synthetic video", resolution: "1080p", submissionImageRef: null,
    submissionImageUrl: card.imageUrl, submissionImageStorageKey: undefined,
    normalizeRemoteVideoStatus: (status: string) => status,
    startPolling: async (...args: any[]) => { log.polls.push(args); return null; },
    submittedRunIdsRef: { current: new Set() }, batchAuthorization: undefined, assertBatchSnapshotCurrent() {}, assertPlannedDirectorReferencesCurrent() {},
    createStoryboardPersistenceSnapshot: (value: any) => value, batchCardInput: () => "input-a", submissionInput: "input-a",
    submissionSettings: JSON.stringify([undefined, undefined, undefined, undefined, undefined]), submissionConsent: "null", tokenChargeConsentRef: { current: null },
  };
  const patches = compile(`${declaration(videoCallback, "pendingVideoPatch")}\n${declaration(videoCallback, "videoSubmissionPatch")}\n({pendingVideoPatch,videoSubmissionPatch});`, context);
  Object.assign(context, patches, { writtenPatch: { ...patches.pendingVideoPatch, ...patches.videoSubmissionPatch } });
  runRef.current = { ...beforeSave, lastSubmittedAt: 1000, cards: beforeSave.cards.map(item => item.id === "card-a" ? { ...item, ...context.writtenPatch } : item) };
  context.submissionRun = runRef.current;
  const rollbackCallback = compile(`${videoGuards}\n(${rollback!.right.getText(tree)});`, context);
  context.rollbackVideoSubmission = rollbackCallback;
  const mutateCard = (patch: any) => { runRef.current = { ...runRef.current, cards: runRef.current.cards.map((item: any) => item.id === "card-a" ? { ...item, ...patch } : item) }; };
  return { context, log, runRef, mutateCard, rollback: rollbackCallback };
}
function videoRunner(test: ReturnType<typeof videoFixture>, beforeDispatch = false, afterSave = false) {
  const body = beforeDispatch ? 'throw new Error("SYNTHETIC_PRESAVE_NOT_CONFIRMED");' : afterSave ? postSaveBody(videoTry!) : videoPostBody;
  return compile(`${videoGuards}\n(async function() { try { ${body} } catch (error) ${videoTry!.catchClause!.block.getText(tree)} finally ${videoTry!.finallyBlock!.getText(tree)} });`, test.context);
}

// Production callback/guard/rollback AST is executed verbatim. Only async boundaries
// and external browser/provider/persistence helpers are supplied in memory.
async function main() {
  await check("positive control: current image response is displayed and clears its own lock", async () => {
    const test = imageFixture(); test.context.fetch = async () => ({ ok: true, json: async () => successfulImage });
    const result = await imageRunner(test)();
    assert.equal(result?.imageUrl, successfulImage.images[0].url);
    assert.equal(test.runRef.current.cards[0].imageStatus, "done"); assert.equal(test.log.patches.length, 1);
    assert.equal(test.context.imageSubmissionsRef.current.has("card-a"), false);
  });
  for (const [name, mutate] of scopeChanges) await check(`late image POST cannot update ${name}`, async () => {
    const test = imageFixture(), gate = deferred<any>(); test.context.fetch = () => gate.promise;
    const running = imageRunner(test)(); await flush(); mutate(test);
    gate.resolve({ ok: true, json: async () => successfulImage }); await running;
    assert.equal(test.log.patches.length, 0); assert.equal(test.log.notices.length, 0); assert.equal(test.log.clearAttempts.length, 0);
  });
  for (const [name, mutate] of scopeChanges) await check(`late image decode cannot update ${name}`, async () => {
    const test = imageFixture(), gate = deferred<any>();
    test.context.fetch = async () => ({ ok: true, json: async () => successfulImage }); test.context.browserImageReady = () => gate.promise;
    const running = imageRunner(test)(); await flush(); mutate(test); gate.resolve({ width: 2048, height: 1152 }); await running;
    assert.equal(test.log.patches.length, 0); assert.equal(test.log.notices.length, 0);
  });
  await check("late inline conversion revokes unadopted Blob without attaching it to the new request", async () => {
    const test = imageFixture(), gate = deferred<any>();
    test.context.fetch = async () => ({ ok: true, json: async () => ({ images: [{ url: "data:image/png;base64,fixture", deliveryMode: "inline_ephemeral", recordId: "record-a" }] }) });
    test.context.resolveGeneratedImageClientDelivery = () => gate.promise;
    const running = imageRunner(test)(); await flush(); test.mutateCard({ imageClientRequestId: "request-b" });
    gate.resolve({ url: "blob:fixture-inline", blob: new Blob(["synthetic"]), revoke: () => test.log.revocations.push("blob:fixture-inline") }); await running;
    assert.equal(test.log.patches.length, 0); assert.deepEqual(test.log.revocations, ["blob:fixture-inline"]);
    assert.equal(test.context.originalBoardBlobsRef.current.size, 0); assert.equal(test.context.ephemeralImageUrlsRef.current.size, 0);
  });
  for (const [name, mutate] of scopeChanges) await check(`late image error recovery cannot update ${name}`, async () => {
    const test = imageFixture(), gate = deferred<any>(); test.context.inspectStoryboardImageAttempt = () => gate.promise;
    const running = imageRunner(test, true)(new Error("Synthetic result unavailable")); await flush(); mutate(test);
    gate.resolve({ state: "processing", canRecover: true, message: "Synthetic recoverable checkpoint" }); await running;
    assert.equal(test.log.patches.length, 0); assert.equal(test.log.notices.length, 0); assert.equal(test.log.clearAttempts.length, 0);
  });
  await check("late owned-image URL refresh cannot update a replacement request", async () => {
    const test = imageFixture(), gate = deferred<any>();
    test.context.fetch = async () => ({ ok: true, json: async () => ({ images: [{ url: "https://synthetic.invalid/owned.png", assetId: "asset-a", storageKey: "owned/board.png" }] }) });
    test.context.browserImageReady = async () => { throw new Error("Synthetic expired signed URL"); };
    test.context.readOwnedStoryboardImage = () => gate.promise;
    const running = imageRunner(test)(); await flush(); test.mutateCard({ imageClientRequestId: "request-b" });
    gate.resolve({ url: "https://synthetic.invalid/resigned.png", storageKey: "owned/board.png", width: 2048, height: 1152 }); await running;
    assert.equal(test.log.patches.length, 0); assert.equal(test.log.notices.length, 0);
  });
  await check("late receipt restoration cannot overwrite a new account after its await", async () => {
    const test = imageFixture(), gate = deferred<boolean>();
    test.context.inspectStoryboardImageAttempt = async () => ({ state: "completed", deliveryMode: "inline_ephemeral" });
    test.context.storyboardInlineReceiptFields = () => ({ imageRecordId: "record-a", imageDeliveryMode: "inline_ephemeral" });
    test.context.restoreOwnedBoard = () => gate.promise;
    const running = imageRunner(test, true)(new Error("Synthetic delivery unavailable")); await flush();
    test.context.imageDownloadOwnerRef.current = "user-b\0token-b"; gate.resolve(false); await running;
    assert.equal(test.log.patches.length, 0); assert.equal(test.log.notices.length, 0);
  });
  await check("late image cleanup preserves a replacement operation lock", async () => {
    const test = imageFixture(), gate = deferred<any>(), newer = Symbol("new-image-operation"); test.context.fetch = () => gate.promise;
    const running = imageRunner(test)(); await flush(); test.context.imageSubmissionOperationsRef.current.set("card-a", newer);
    gate.resolve({ ok: true, json: async () => successfulImage }); await running;
    assert.equal(test.context.imageSubmissionsRef.current.has("card-a"), true);
    assert.equal(test.context.imageSubmissionOperationsRef.current.get("card-a"), newer);
  });
  await check("video pre-save failure restores only its own unchanged fields and preserves newer edits", async () => {
    const test = videoFixture(); test.context.providerSubmissionDispatched = false;
    test.mutateCard({ videoStatusDetail: "later target status", videoPrompt: "later target prompt" });
    test.runRef.current = { ...test.runRef.current, title: "later project title", cards: test.runRef.current.cards.map((item: any) => item.id === "card-b" ? { ...item, videoPrompt: "later neighbor prompt" } : item) };
    await videoRunner(test, true)();
    const target = test.runRef.current.cards[0];
    assert.equal(target.videoStatus, "done"); assert.equal(target.videoUrl, "https://synthetic.invalid/old.mp4");
    assert.equal(target.videoClientRequestId, "old-request"); assert.equal(target.videoStatusDetail, "later target status");
    assert.equal(target.videoPrompt, "later target prompt"); assert.equal(test.runRef.current.cards[1].videoPrompt, "later neighbor prompt");
    assert.equal(test.runRef.current.title, "later project title"); assert.equal(test.runRef.current.lastSubmittedAt, 100);
  });
  await check("video rollback does not rewind another card's newer submission timestamp", () => {
    const test = videoFixture();
    test.runRef.current = { ...test.runRef.current, cards: test.runRef.current.cards.map((item: any) => item.id === "card-b" ? { ...item, videoStartedAt: 1000, videoStatus: "queued", videoClientRequestId: "neighbor-new-request" } : item) };
    test.rollback(); assert.equal(test.runRef.current.lastSubmittedAt, 1000);
    assert.equal(test.runRef.current.cards[1].videoClientRequestId, "neighbor-new-request");
  });
  for (const name of ["owner", "run", "request", "operation"]) await check(`video rollback leaves replacement ${name} untouched`, () => {
    const test = videoFixture();
    if (name === "owner") test.context.imageDownloadOwnerRef.current = "user-b\0token-b";
    if (name === "run") test.runRef.current = { ...test.runRef.current, id: "project-b" };
    if (name === "request") test.mutateCard({ videoClientRequestId: "replacement-video-request" });
    if (name === "operation") test.context.videoSubmissionOperationsRef.current.set("card-a", Symbol("replacement-operation"));
    const before = JSON.stringify(test.runRef.current); test.rollback();
    assert.equal(JSON.stringify(test.runRef.current), before); assert.equal(test.log.updates.length, 0);
  });
  await check("positive control: current video response is displayed and owned controller is removed", async () => {
    const test = videoFixture(); test.context.fetch = async () => ({ ok: true, json: async () => ({ status: "completed", task_id: "video-task-a", video_url: "https://synthetic.invalid/new.mp4" }) });
    await videoRunner(test)(); assert.equal(test.runRef.current.cards[0].videoUrl, "https://synthetic.invalid/new.mp4");
    assert.equal(test.context.videoSubmissionControllersRef.current.size, 0); assert.equal(test.context.videoSubmissionsRef.current.size, 0);
  });
  await check("actual video POST deadline preserves original request key and unknown outcome without replay or clearing", async () => {
    const test = videoFixture(); let posts = 0; let aborted = false;
    test.context.deadlineSetTimeout = (fn: () => void, ms: number) => setTimeout(fn, ms === 240_000 ? 1 : ms);
    test.context.fetch = (_url: string, init: RequestInit) => { posts++;
      assert.equal((init.headers as Record<string, string>)["Idempotency-Key"], "video-request-a");
      init.signal?.addEventListener("abort", () => { aborted = true; }, { once: true });
      return new Promise(() => {});
    };
    await videoRunner(test)();
    const card = test.runRef.current.cards[0];
    assert.equal(posts, 1); assert.equal(aborted, true); assert.equal(test.log.clears.length, 0); assert.equal(test.log.polls.length, 0);
    assert.equal(card.videoClientRequestId, "video-request-a"); assert.equal(card.videoClientRequestFingerprint, "video-fingerprint-a");
    assert.notEqual(card.videoRetryable, true); assert.equal(card.videoBillingState, "pending"); assert.ok(["queued", "running"].includes(card.videoStatus));
    assert.match(card.videoStatusDetail, /结果暂未确认/u); assert.equal(test.context.videoSubmissionControllersRef.current.size, 0);
  });
  for (const name of ["owner", "run", "request", "operation"]) await check(`late video POST cannot update replacement ${name}`, async () => {
    const test = videoFixture(), gate = deferred<any>(); test.context.fetch = () => gate.promise;
    const running = videoRunner(test)(); await flush();
    if (name === "owner") test.context.imageDownloadOwnerRef.current = "user-b\0token-b";
    if (name === "run") test.runRef.current = { ...test.runRef.current, id: "project-b" };
    if (name === "request") test.mutateCard({ videoClientRequestId: "replacement-video-request" });
    if (name === "operation") test.context.videoSubmissionOperationsRef.current.set("card-a", Symbol("replacement-operation"));
    gate.resolve({ ok: true, json: async () => ({ status: "completed", task_id: "old-result", video_url: "https://synthetic.invalid/late.mp4" }) }); await running;
    assert.equal(test.log.patches.length, 0); assert.equal(test.log.notices.length, 0); assert.equal(test.log.polls.length, 0);
  });
  await check("late video cleanup preserves another operation's controller and submission lock", async () => {
    const test = videoFixture(), gate = deferred<any>(), controller = new AbortController(), operation = Symbol("new-video-operation");
    test.context.fetch = () => gate.promise; const running = videoRunner(test)(); await flush();
    test.context.videoSubmissionControllersRef.current.set("card-a", controller); test.context.videoSubmissionOperationsRef.current.set("card-a", operation);
    test.mutateCard({ videoClientRequestId: "replacement-video-request" });
    gate.resolve({ ok: true, json: async () => ({ status: "completed", task_id: "old-result", video_url: "https://synthetic.invalid/late.mp4" }) }); await running;
    assert.equal(test.context.videoSubmissionControllersRef.current.get("card-a"), controller);
    assert.equal(test.context.videoSubmissionOperationsRef.current.get("card-a"), operation);
    assert.equal(test.context.videoSubmissionsRef.current.has("card-a"), true);
  });
  await check("positive control: confirmed current image project save dispatches exactly once", async () => {
    const test = imageFixture(); test.context.saveStoryboardProject = async () => true;
    test.context.fetch = async () => { test.log.posts++; return { ok: true, json: async () => successfulImage }; };
    await imageRunner(test, false, true)(); assert.equal(test.log.posts, 1); assert.equal(test.runRef.current.cards[0].imageStatus, "done");
  });
  for (const [name, mutate] of scopeChanges) await check(`image project-save response cannot dispatch after ${name} changes`, async () => {
    const test = imageFixture(), gate = deferred<boolean>(); test.context.saveStoryboardProject = () => gate.promise;
    test.context.fetch = async () => { test.log.posts++; throw new Error("LATE_POST_FORBIDDEN"); };
    const running = imageRunner(test, false, true)(); await flush(); mutate(test); gate.resolve(true); await running;
    assert.equal(test.log.posts, 0); assert.equal(test.log.patches.length, 0); assert.equal(test.log.notices.length, 0);
  });
  await check("positive control: confirmed current video project save dispatches exactly once", async () => {
    const test = videoFixture(); let posts = 0; test.context.providerSubmissionDispatched = false; test.context.saveStoryboardProject = async () => true;
    test.context.fetch = async () => { posts++; return { ok: true, json: async () => ({ status: "completed", task_id: "video-task-a", video_url: "https://synthetic.invalid/new.mp4" }) }; };
    await videoRunner(test, false, true)(); assert.equal(posts, 1); assert.equal(test.runRef.current.cards[0].videoStatus, "done");
  });
  for (const name of ["owner", "run", "removed card", "request", "operation"]) await check(`video project-save response cannot dispatch after ${name} changes`, async () => {
    const test = videoFixture(), gate = deferred<boolean>(); let posts = 0; test.context.providerSubmissionDispatched = false;
    test.context.saveStoryboardProject = () => gate.promise;
    test.context.fetch = async () => { posts++; throw new Error("LATE_POST_FORBIDDEN"); };
    const running = videoRunner(test, false, true)(); await flush();
    if (name === "owner") test.context.imageDownloadOwnerRef.current = "user-b\0token-b";
    if (name === "run") test.runRef.current = { ...test.runRef.current, id: "project-b" };
    if (name === "removed card") test.runRef.current = { ...test.runRef.current, cards: test.runRef.current.cards.filter((item: any) => item.id !== "card-a") };
    if (name === "request") test.mutateCard({ videoClientRequestId: "replacement-video-request" });
    if (name === "operation") test.context.videoSubmissionOperationsRef.current.set("card-a", Symbol("replacement-operation"));
    gate.resolve(true); await running;
    assert.equal(posts, 0); assert.equal(test.log.patches.length, 0); assert.equal(test.log.updates.length, 0); assert.equal(test.log.notices.length, 0);
  });
  for (const edited of [false, true]) await check(edited
    ? "DIRECTOR-DURATION: an explicitly edited prompt proceeds to later validation"
    : "DIRECTOR-DURATION: unchanged ten-second director timeline rejects five-second model without fetch", async () => {
    const notices: string[] = []; let fetches = 0, compiledPrompts = 0;
    const originalPrompt = "十秒导演原始时间线";
    const card = { id: "card-a", order: 1, videoStatus: "idle", videoPrompt: edited ? "用户手动改为五秒时间线" : originalPrompt,
      imageUrl: "https://synthetic.invalid/board.png", directorExecution: { sourceVideoPrompt: originalPrompt, targetDurationSeconds: 10 } };
    const model = { id: "model-a", supportsPrompt: true };
    const context = { userId: "user-a", token: "token-a", view: "workbench", runRef: { current: { id: "project-a", videoModelId: "model-a", ratio: "16:9", videoDuration: 5, cards: [card] } },
      imageDownloadOwnerRef: { current: "user-a\0token-a" }, scopeMountedRef: { current: true }, contextReadyRef: { current: true }, navigationRef: { current: false },
      initialReferenceBlockedRef: { current: new Set() }, boardExportLocksRef: { current: new Set() }, videoSubmissionsRef: { current: new Set() },
      batchAuthorizationRef: { current: null }, videoModels: [model], verifyPlannedDirectorReferences: async () => () => {},
      needsStoryboardBoardExport: () => false, isActiveVideoStatus: () => false, hasValidatedImage: () => true, assertBatchAuthorization() {},
      storyboardImageRatioIssue: () => "", effectiveImageRatio: () => "16:9", storyboardVideoModelSelectionIssue: () => "", effectiveVideoDuration: () => 5,
      compileStoryboardDirectorVideoPrompt: (prompt: string) => { compiledPrompts++; return prompt; }, submittedVideoPrompt: (prompt: string) => prompt,
      storyboardVideoPromptViolation: () => "SYNTHETIC_LATER_VALIDATION_REACHED", setNotice: (message: string) => notices.push(message),
      fetch: () => { fetches++; throw new Error("DIRECTOR_DURATION_FETCH_FORBIDDEN"); } };
    const generate = compile(`(${videoCallback.getText(tree)});`, context);
    await generate("card-a"); assert.equal(fetches, 0);
    assert.equal(compiledPrompts, edited ? 1 : 0);
    assert.equal(notices.length, 1); assert.match(notices[0], edited ? /SYNTHETIC_LATER_VALIDATION_REACHED/u : /导演分镜按10秒编排，当前视频为5秒/u);
  });
}
main().then(() => {
  assert.equal(createHash("sha256").update(readFileSync(sourcePath)).digest("hex"), sourceHash, "Source changed during the regression run");
  mkdirSync(output, { recursive: true });
  writeFileSync(`${output}/tests.json`, JSON.stringify({ passed: true, sourcePath, sourceHash, checks,
    deadlineHelper: { path: "src/lib/storyboard-request-deadline.ts", sha256: createHash("sha256").update(readFileSync("src/lib/storyboard-request-deadline.ts")).digest("hex"), actualModuleExecuted: true },
    realNetworkCalls: 0, providerCalls: 0, databaseCalls: 0, productBuilds: 0, productPorts: 0 }, null, 2) + "\n");
}).catch(error => { console.error(error); process.exitCode = 1; });
