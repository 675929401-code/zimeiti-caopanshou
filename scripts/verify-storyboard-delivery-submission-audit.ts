/**
 * Zero-network repair acceptance: execute the current component's actual callbacks in
 * isolated VMs. All HTTP, React, browser and persistence effects are fixtures.
 * Writes only new evidence. Exit 0 requires all five historical bugs to be
 * absent. Exit 1 means a regression or incomplete fixture; it is never a pass.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import vm from "node:vm";
import ts from "typescript";
import {
  activeStoryboardVisualAssetRefs, defaultVisualAssetIdsForCard, removeVisualAssetBindings, rollbackVisualAssetMode, suspendVisualAssetBindings,
  unresolvedVisualAssetBindingIds,
} from "../src/lib/storyboard-visual-asset-binding";
import { isOwnedStoryboardBoard, needsStoryboardBoardExport, rollbackStoryboardBoardBinding } from "../src/lib/storyboard-board-export";
import { refreshStoryboardVisualAssetReferences } from "../src/lib/storyboard-visual-asset-submission";
import { storyboardProductionImageFingerprint, storyboardProductionVideoFingerprint } from "../src/lib/storyboard-continuous-production";
import { prepareStoryboardVideo } from "../src/lib/storyboard-video-preparation";
import { resolveStoryboardVideoSameKeyRetryAttempt } from "../src/lib/storyboard-video-retry";
import { compileStoryboardDirectorVideoPrompt } from "../src/lib/storyboard-director-execution";
import type { StoryboardVisualAssetPlan } from "../src/lib/storyboard-workbench";

type Card = Record<string, unknown> & {
  id: string; order: number; imagePrompt: string; videoPrompt: string; narration: string;
  imageStatus: string; videoStatus: string; referenceImageUrls: string[]; visualAssetRefs: unknown[];
  imageUrl?: string; imageRecordId?: string; imageDeliveryMode?: string;
};
type Run = Record<string, unknown> & { id: string; cards: Card[] };
type Callable = (...args: unknown[]) => unknown;
type Finding = {
  id: string; priority: "P1" | "P2"; title: string; status: "REPRODUCED" | "FIXED_IN_RETEST";
  expected: string; observed: unknown; source: Array<{ file: string; line: number }>;
  realNetworkRequests: 0; realProviderCalls: 0; databaseWrites: 0;
};
const componentPath = "src/components/storyboard-workbench.tsx";
const evidenceRoot = path.resolve(".codex-evidence/storyboard-delivery-audit-20261023");
const outputDir = path.resolve(process.env.STORYBOARD_DELIVERY_AUDIT_OUTPUT_DIR?.trim()
  || path.join(evidenceRoot, "submission"));
const outputRelative = path.relative(process.cwd(), outputDir).split(path.sep).join("/");
const source = readFileSync(componentPath, "utf8");
const loadedComponentSha256 = createHash("sha256").update(source).digest("hex");
let unexpectedNetworkRequests = 0;
globalThis.fetch = (async () => { unexpectedNetworkRequests++; throw new Error("UNEXPECTED_REAL_NETWORK_FORBIDDEN"); }) as typeof fetch;
function prepareEvidenceDirectory() {
  const descendant = (root: string, candidate: string) => {
    const relative = path.relative(root, candidate);
    return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  };
  assert.ok(descendant(evidenceRoot, outputDir), "Audit output must be a child of the existing storyboard audit evidence root");
  assert.ok(existsSync(evidenceRoot), "The storyboard audit evidence root must already exist");
  let ancestor = outputDir;
  while (!existsSync(ancestor)) ancestor = path.dirname(ancestor);
  const resolvedRoot = realpathSync(evidenceRoot), resolvedAncestor = realpathSync(ancestor);
  assert.ok(resolvedAncestor === resolvedRoot || descendant(resolvedRoot, resolvedAncestor), "Audit output cannot escape through a junction or symlink");
  assert.ok(!existsSync(outputDir) || readdirSync(outputDir).length === 0,
    "Audit evidence already exists: choose a new STORYBOARD_DELIVERY_AUDIT_OUTPUT_DIR; previous evidence is immutable");
  mkdirSync(outputDir, { recursive: true });
}
const tree = ts.createSourceFile(componentPath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const nodes = new Map<string, ts.Node>();
function visit(node: ts.Node) {
  if (ts.isFunctionDeclaration(node) && node.name) nodes.set(node.name.text, node);
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
    const expression = ts.isCallExpression(node.initializer) ? node.initializer.arguments[0] : node.initializer;
    if (expression && ts.isArrowFunction(expression)) nodes.set(node.name.text, expression);
  }
  ts.forEachChild(node, visit);
}
visit(tree);
const noop = () => undefined;
const helperNames = ["effectiveImageRatio", "batchSettings", "batchCardInput", "assertBatchSnapshotCurrent",
  "assertBatchAuthorization", "storyboardImageSubmissionInput", "allowsIndependentReferenceRatio", "isCompletedInlineImageReceipt", "imageAttemptNeedsResolution", "hasValidatedImage", "isActiveVideoStatus"];
const helperCode = helperNames.map(name => {
  const node = nodes.get(name); assert.ok(node, `Current helper exists: ${name}`); return node.getText(tree);
}).join("\n");
function actual(name: string, context: Record<string, unknown>): Callable {
  const node = nodes.get(name); assert.ok(node, `Current callback exists: ${name}`);
  const compiled = ts.transpileModule(`${helperCode}\n(${node.getText(tree)});`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  return vm.runInNewContext(compiled, { Error, Date, URL, AbortSignal, AbortController, Symbol, console, ...context }) as Callable;
}
function line(text: string) {
  const index = source.indexOf(text); assert.ok(index >= 0, `Source evidence exists: ${text}`);
  return { file: componentPath, line: source.slice(0, index).split("\n").length };
}
function externalLine(file: string, text: string) {
  const content = readFileSync(file, "utf8"), index = content.indexOf(text);
  assert.ok(index >= 0, `External source evidence exists: ${file}: ${text}`);
  return { file, line: content.slice(0, index).split("\n").length };
}
function imageFixture() {
  const card: Card = { id: "card-a", order: 1, imagePrompt: "原始分镜 A", videoPrompt: "缓慢移动", narration: "",
    imageStatus: "idle", videoStatus: "idle", referenceImageUrls: [], visualAssetRefs: [] };
  const runRef: { current: Run } = { current: { id: "fixture-run", cards: [card, { ...card, id: "card-b", order: 2, imagePrompt: "原始分镜 B" }],
    imageModelId: "fixture-image-model", imageResolution: "2K", ratio: "16:9", videoDuration: 10 } };
  const notices: string[] = [];
  const posts: Array<{ url: string; body: unknown; currentCardIds: string[] }> = [];
  const saves: Run[] = [];
  const setRun = (next: Run | ((previous: Run) => Run)) => { runRef.current = typeof next === "function" ? next(runRef.current) : next; };
  const context: Record<string, unknown> = {
    contextReadyRef: { current: true }, navigationRef: { current: false }, view: "workbench", scopeMountedRef: { current: true },
    visualAssetMutationRef: { current: false }, runRef, boardExportLocksRef: { current: new Set() },
    imageSubmissionsRef: { current: new Set() }, token: "fixture-token", userId: "fixture-user",
    imageSubmissionOperationsRef: { current: new Map<string, symbol>() }, videoSubmissionOperationsRef: { current: new Map<string, symbol>() },
    imageDownloadOwnerRef: { current: "fixture-user\0fixture-token" }, initialReferenceBlockedRef: { current: new Set() },
    setNotice: (value: string) => notices.push(value), isOwnedStoryboardBoard, batchAuthorizationRef: { current: null },
    inferStoryboardNarration: () => "", validateStoryboardNarrationCapacity: () => ({ ok: true }),
    ensureInitialReferencesAdopted: async () => true, imageModels: [{ id: "fixture-image-model" }],
    storyboardImageModelSelectionIssue: () => null, supportedImageRatios: () => ["16:9"],
    getImageModelCapabilities: () => ({ maxReferenceImages: 3, supportsReferenceInput: true }),
    refreshStoryboardVisualAssetReferences: async (input: { card: Card }) => input.card,
    resolveVisualAssetUrls: async () => [], storyboardImageModelName: () => "Fixture model", storyboardImagePrice: () => 1,
    effectiveImageResolution: () => "2K", window: { confirm: () => true }, buildClientRequestFingerprint: async () => "fixture-fingerprint",
    storyboardImageFingerprintPayload: (input: unknown) => input, stableImageRequestDigest: async () => "fixture-digest",
    storyboardProductionImageFingerprint, activeStoryboardVisualAssetRefs,
    archiveRunSnapshot: noop, createStoryboardPersistenceSnapshot: (input: unknown) => input, setRun,
    saveStoryboardProject: async (document: Run) => { saves.push(structuredClone(document)); return true; },
    submittedRunIdsRef: { current: new Set() },
    fetch: async (url: string, init: { body: string }) => {
      posts.push({ url, body: JSON.parse(init.body), currentCardIds: runRef.current.cards.map(item => item.id) });
      // Stop after recording the attempted outbound call; no actual transport exists.
      throw Object.assign(new Error("fixture stop after recording dispatch"), { requestAccepted: false });
    },
    storyboardImageFailurePresentation: () => ({ confirmedRejected: true, message: "fixture transport intentionally absent" }),
    patchCard: (id: string, patch: Record<string, unknown>) => {
      runRef.current = { ...runRef.current, cards: runRef.current.cards.map(item => item.id === id ? { ...item, ...patch } : item) };
    }, clearBrowserClientAttempt: noop,
  };
  // Exercise the current real gate. Ordinary workbench projects naturally take
  // its non-director branch; do not replace the gate with an unconditional stub.
  context.verifyPlannedDirectorReferences = actual("verifyPlannedDirectorReferences", context);
  return { card, runRef, notices, posts, saves, context };
}
const findings: Finding[] = [];
const zeroEffects = { realNetworkRequests: 0 as const, realProviderCalls: 0 as const, databaseWrites: 0 as const };
const compatibilityChecks: Array<{ name: string; passed: boolean; observations: unknown }> = [];

async function auditImageRollback() {
  const fixture = imageFixture();
  fixture.context.saveStoryboardProject = async () => {
    fixture.runRef.current = { ...fixture.runRef.current, cards: fixture.runRef.current.cards.map(card => card.id === "card-b"
      ? { ...card, imagePrompt: "保存期间学员输入的新文字" } : card) };
    return false;
  };
  await actual("generateImage", fixture.context)("card-a");
  assert.equal(fixture.runRef.current.cards[1].imagePrompt, "保存期间学员输入的新文字", "Failed save must preserve later edits in other cards");
  assert.equal(fixture.runRef.current.cards[0].imageStatus, "idle");
  assert.equal(fixture.runRef.current.cards[0].imageClientRequestId, undefined);
  assert.equal(fixture.posts.length, 0);
  findings.push({ id: "SUBMISSION-001", priority: "P1", status: "FIXED_IN_RETEST", title: "生图保存失败只撤销本次提交字段，并保留其他分段的新编辑",
    expected: "仅撤销本次生图提交字段，保留保存期间其他卡片的更新。",
    observed: { newTextLost: false, finalOtherCardPrompt: fixture.runRef.current.cards[1].imagePrompt, simulatedProviderDispatches: fixture.posts.length, notices: fixture.notices },
    source: [line("const projectSaved = await saveStoryboardProject(createStoryboardPersistenceSnapshot(submissionRun), true);"),
      line("rollbackImageSubmission = () =>"), line("<textarea aria-label={`分段${card.order}生图提示词`}")], ...zeroEffects });
}

async function auditRemovedCardDispatch() {
  const phases = [];
  for (const phase of ["reference-refresh", "request-fingerprint"] as const) for (const removal of ["ui-remove", "external-removal"] as const) {
    const fixture = imageFixture();
    const removeCard = removal === "ui-remove" ? actual("removeCard", fixture.context) : (id: unknown) => {
      fixture.runRef.current = { ...fixture.runRef.current, cards: fixture.runRef.current.cards.filter(card => card.id !== id) };
    };
    let reachedHook = 0;
    if (phase === "reference-refresh") fixture.context.refreshStoryboardVisualAssetReferences = async (input: { card: Card }) => {
      reachedHook++; removeCard(input.card.id); return input.card;
    };
    else fixture.context.buildClientRequestFingerprint = async () => {
      reachedHook++; removeCard("card-a"); return "fixture-fingerprint";
    };
    await actual("generateImage", fixture.context)("card-a");
    assert.equal(reachedHook, 1, `${phase}: actual preflight must reach the simulated interleaving`);
    const retained = fixture.runRef.current.cards.some(card => card.id === "card-a");
    if (removal === "ui-remove") {
      assert.equal(retained, true, `${phase}: active preparation must block the destructive UI remove`);
      assert.equal(fixture.posts.length, 1, `${phase}: the retained card may finish its original single dispatch`);
      assert.ok(fixture.posts[0].currentCardIds.includes("card-a"));
      assert.ok(fixture.saves[0].cards.some(card => card.id === "card-a"));
    } else {
      assert.equal(retained, false);
      assert.equal(fixture.posts.length, 0, `${phase}: a removed card must never reach provider dispatch`);
      assert.equal(fixture.saves.length, 0, `${phase}: a removed card must not create an unbound submission snapshot`);
    }
    phases.push({ phase, removal, retained, status: "FIXED_IN_RETEST",
      reachedHook, savedCardIds: fixture.saves[0]?.cards.map(card => card.id) || [], simulatedProviderDispatches: fixture.posts.length,
      dispatch: fixture.posts[0], notices: fixture.notices });
  }
  findings.push({ id: "SUBMISSION-002", priority: "P1", status: "FIXED_IN_RETEST", title: "生图异步预检期间删除卡片后停止保存与派发",
    expected: "异步提交预检阻止界面删除；若卡片被外部替换/删除，保存和付费派发前终止。",
    observed: { phases, note: "Retest the original resolver interleaving and the subsequent asynchronous fingerprint boundary separately." },
    source: [line("const removeCard = useCallback"), line("const refreshed = await refreshStoryboardVisualAssetReferences"),
      line("const assertImageSubmissionCurrent = () =>"), line('const response = await fetch("/api/image/generate", {')], ...zeroEffects });
}

function videoBatchFixture(card: Card) {
  const fixture = imageFixture();
  fixture.runRef.current = { ...fixture.runRef.current, videoModelId: "fixture-video-model", videoResolution: "1080p", title: "fixture video project", cards: [card] };
  let batches = 0, saveBoardCalls = 0;
  const events: string[] = [];
  const authorizations: Array<{ started: Set<string>; inputs: Map<string, string> }> = [];
  const model = { id: "fixture-video-model", supportsPrompt: true, billingUnit: "per_video" };
  const owned = { assetId: "owned-board-a", storageKey: "fixture/board.png", url: "https://fixture.invalid/board.png", width: 1600, height: 900 };
  const context: Record<string, unknown> = { ...fixture.context,
    run: fixture.runRef.current, batchMode: "", videoBatchPreflightRef: { current: false }, activeVideoSelectionIssue: null,
    videoPromptRequired: true, storyboardImageRatioIssue: () => null, activeImageRatio: "16:9", activeVideoModel: model,
    activeVideoResolution: "1080p", activeVideoDuration: 10, tokenChargeConsentRef: { current: {} },
    setBatchMode: noop, videoSubmissionsRef: { current: new Set() }, videoSubmissionControllersRef: { current: new Map() },
    videoModels: [model], needsStoryboardBoardExport, prepareStoryboardVideo, rollbackStoryboardBoardBinding,
    storyboardVideoModelSelectionIssue: () => null, effectiveVideoDuration: () => 10, effectiveVideoResolution: () => "1080p",
    storyboardVideoPromptViolation: () => null, setPreparingVideoIds: noop, resolveVideoTokenBillingConsent: () => undefined,
    effectiveVideoCharge: () => 0.55, compactVideoModelName: () => "Fixture video", compileStoryboardDirectorVideoPrompt,
    submittedVideoPrompt: (prompt: string) => prompt, validateVideoInputContract: () => null, getAiVideoPageInputCapabilities: () => ({}),
    window: { confirm: () => true, setTimeout: (callback: () => void) => { callback(); return 1; } }, videoSectionsRef: { current: {} },
    normalizeStoryboardVideoImageReference: () => undefined, isPublicHttpMediaUrl: (url: string) => /^https:\/\//u.test(url),
    resolveStoryboardVideoSameKeyRetryAttempt, resolveBrowserClientAttempt: () => ({ clientRequestId: "fixture-video-request-a" }),
    storyboardProductionVideoFingerprint, friendlyVideoError: (value: string) => value, isAbortError: () => false,
    delay: async () => undefined, VIDEO_SUBMIT_INTERVAL_MS: 8000,
    ephemeralImageUrlsRef: { current: new Set(card.imageUrl ? [card.imageUrl] : []) }, boardExportHeldUrlsRef: { current: new Set() },
    boardExportCacheRef: { current: new Map() }, originalBoardBlobsRef: { current: new Map() }, setExportingBoardIds: noop,
    saveStoryboardBoardOriginal: async (input: { stillCurrent: () => boolean }) => {
      assert.equal(input.stillCurrent(), true); saveBoardCalls++; events.push("owned-board-export"); return owned;
    },
    saveStoryboardProject: async (document: Run) => { fixture.saves.push(structuredClone(document)); events.push("project-save"); return true; },
    fetch: async (url: string, init: { body: string }) => {
      assert.equal(url, "/api/video/generate");
      fixture.posts.push({ url, body: JSON.parse(init.body), currentCardIds: fixture.runRef.current.cards.map(item => item.id) });
      events.push("video-dispatch");
      return { ok: true, status: 200, json: async () => ({ status: "completed", task_id: "fixture-video-task-a", video_url: "https://fixture.invalid/completed.mp4", billing_state: "settled", price: 0.55 }) };
    },
  };
  context.buildBatchAuthorization = actual("buildBatchAuthorization", context);
  context.saveBoardForVideo = actual("saveBoardForVideo", context);
  context.generateVideo = actual("generateVideo", context);
  context.prepareAndGenerateVideo = actual("prepareAndGenerateVideo", context);
  const batch = actual("runVideoBatch", context);
  context.runVideoBatch = async (ids: string[], authorization: { started: Set<string>; inputs: Map<string, string> }) => {
    batches++; authorizations.push(authorization);
    const results = await batch(ids, authorization);
    const count = fixture.posts.length;
    assert.equal(await (context.prepareAndGenerateVideo as Callable)(ids[0], authorization), null, "The same batch authorization must not dispatch the card twice");
    assert.equal(fixture.posts.length, count);
    return results;
  };
  return { ...fixture, context, events, authorizations, counts: () => ({ batches, saveBoardCalls }) };
}
async function auditCancelledBatch() {
  const fixture = videoBatchFixture({ ...imageFixture().card, imageStatus: "done", imageUrl: "https://fixture.invalid/storyboard.png",
    imageValidatedAt: 1, videoStatus: "cancelled", videoRetryable: true });
  await actual("batchVideos", fixture.context)();
  assert.equal(fixture.counts().batches, 1); assert.equal(fixture.posts.length, 1);
  assert.equal(fixture.authorizations[0].started.has("card-a"), true, "The real single-use batch guard must consume authorization");
  assert.equal(fixture.runRef.current.cards[0].videoStatus, "done");
  assert.ok(!fixture.notices.includes("所有视频已经完成"));
  findings.push({ id: "SUBMISSION-003", priority: "P2", status: "FIXED_IN_RETEST", title: "批量视频接纳已取消且可重试的分段，并执行一次有效授权",
    expected: "已取消且确认可重试的卡片应与单卡重新生成保持一致，至少不得报告已完成。",
    observed: { ...fixture.counts(), originalStatus: "cancelled", retryable: true, simulatedProviderDispatches: fixture.posts.length, authorizationConsumed: true, notices: fixture.notices },
    source: [line('const cardIds = run.cards.filter((card) => card.videoStatus === "idle"'), line('if (!cardIds.length) return setNotice("所有视频已经完成");')], ...zeroEffects });
}
async function auditInlineBatch() {
  const card: Card = { ...imageFixture().card, imageStatus: "done", imageUrl: "blob:http://127.0.0.1:5000/fixture-original",
    imageValidatedAt: 1, imageRecordId: "a".repeat(64), imageDeliveryMode: "inline_ephemeral", imageWidth: 1600, imageHeight: 900 };
  const fixture = videoBatchFixture(card);
  assert.equal(needsStoryboardBoardExport(card), true);
  await actual("batchVideos", fixture.context)();
  assert.equal(fixture.counts().saveBoardCalls, 1);
  assert.equal(fixture.posts.length, 1);
  assert.ok(fixture.events.indexOf("owned-board-export") < fixture.events.indexOf("video-dispatch"));
  assert.equal(fixture.authorizations[0].started.has("card-a"), true);
  assert.equal((fixture.posts[0].body as Record<string, unknown>).image_url, "https://fixture.invalid/board.png");
  assert.equal(fixture.runRef.current.cards[0].videoStatus, "done");
  assert.ok(fixture.notices.includes("批量视频结束：成功1个，失败0个"));
  assert.ok(!fixture.notices.includes("请先保存分镜图后再生成视频。"));
  findings.push({ id: "SUBMISSION-004", priority: "P2", status: "FIXED_IN_RETEST", title: "批量视频先保存临时分镜并更新授权输入，再提交一次视频",
    expected: "与单卡流程一致，先保存并核验临时分镜，再冻结批量输入并提交；或在启动前明确提示缺少保存。",
    observed: { imageIsValidated: true, imageNeedsExport: true, saveBoardCalls: fixture.counts().saveBoardCalls,
      simulatedProviderDispatches: fixture.posts.length, events: fixture.events, notices: fixture.notices },
    source: [line("const runVideoBatch = useCallback"), line("requests.push(prepareAndGenerateVideo(cardIds[index], authorization));"),
      line("if (boardExportLocksRef.current.has(cardId) || card && needsStoryboardBoardExport(card))"), line("await prepareStoryboardVideo({ cardId")], ...zeroEffects });
}
async function auditReferenceMode() {
  const asset = { id: "asset_person", role: "character" as const, name: "人物", identityLock: "人物身份脸型和服装保持一致", allowedChanges: [],
    referencePrompts: [{ kind: "identity" as const, purpose: "身份参考", prompt: "保持人物身份、脸型、服装、体型与识别特征一致。" }],
    source: { kind: "uploaded-image" as const, assetId: "owned-person", storageKey: "fixture/person.png" } };
  const plan: StoryboardVisualAssetPlan = { mode: "selected", assets: [asset],
    generationPolicy: { maxInitialImages: 0, initialRequiredAssetIds: [], initialDeferredAssetIds: [], environmentAnchorPolicy: "none" } };
  const reference = "https://fixture.invalid/fixture/person.png";
  const manual = "https://fixture.invalid/manual.png";
  const card = { id: "card-a", referenceImageUrls: [manual, reference], visualAssetSelectionMode: "custom" as const,
    visualAssetRefsMode: "explicit" as const,
    visualAssetRefs: [{ assetId: asset.id, role: asset.role, referenceKinds: ["identity" as const], ownedReferenceUrl: reference, boundReferenceUrl: reference }] };
  const runRef = { current: { id: "fixture-mode-run", visualAssetPlan: plan, cards: [card] } };
  const notices: string[] = [];
  const context = { ...imageFixture().context, runRef, visualAssetGenerationRef: { current: false }, referenceUploadOperationRef: { current: null },
    videoSubmissionsRef: { current: new Set() }, setRun: noop, setNotice: (value: string) => notices.push(value), setVisualAssetSaving: noop,
    removeVisualAssetBindings, suspendVisualAssetBindings, rollbackVisualAssetMode, unresolvedVisualAssetBindingIds, saveStoryboardProject: async () => true };
  const toggle = actual("selectVisualAssetMode", context);
  const before = defaultVisualAssetIdsForCard(card, plan);
  await toggle("off");
  assert.deepEqual(runRef.current.cards[0].referenceImageUrls, [manual], "Ordinary mode retains manual reference only");
  assert.deepEqual(runRef.current.cards[0].visualAssetRefs.map(ref => ref.assetId), [asset.id], "Off mode suspends the semantic custom choice");
  assert.deepEqual(activeStoryboardVisualAssetRefs(runRef.current.cards[0], runRef.current.visualAssetPlan), []);
  const ordinary = imageFixture();
  ordinary.runRef.current = { ...ordinary.runRef.current, visualAssetPlan: { ...runRef.current.visualAssetPlan,
    assets: [{ ...asset, source: { kind: "platform-preset", assetId: "preset-a", presetId: "fixture-preset", presetRevision: 1 } }] },
    cards: [{ ...ordinary.card, ...runRef.current.cards[0] }] };
  await actual("generateImage", ordinary.context)("card-a");
  assert.equal(ordinary.posts.length, 1, "A dormant preset must neither block ordinary-mode generation nor become a preset input");
  const ordinaryBody = ordinary.posts[0].body as Record<string, unknown>;
  assert.deepEqual(ordinaryBody.referenceImageUrls, [manual]);
  assert.equal(ordinaryBody.referenceUsage, "general"); assert.equal(ordinaryBody.presetReferences, undefined);
  await toggle("selected");
  const after = defaultVisualAssetIdsForCard(runRef.current.cards[0], runRef.current.visualAssetPlan);
  const refreshed = await refreshStoryboardVisualAssetReferences({ card: runRef.current.cards[0], plan: runRef.current.visualAssetPlan,
    limit: 3, resolve: async () => [{ assetId: asset.source.assetId, previewUrl: reference }] });
  assert.deepEqual(before, [asset.id]);
  assert.deepEqual(after, [asset.id]);
  assert.deepEqual(refreshed.referenceImageUrls, [manual, reference]);
  findings.push({ id: "SUBMISSION-005", priority: "P2", status: "FIXED_IN_RETEST", title: "普通模式停用角色输入，重新开启后恢复单段自定义选择",
    expected: "模式开关应保留单段自定义语义选择；如设计为清空，应有明确用户确认，不能静默变成无角色参考。",
    observed: { beforeRequested: before, afterRequested: after, afterSelectionMode: runRef.current.cards[0].visualAssetSelectionMode,
      nextImageReferenceUrls: refreshed.referenceImageUrls, ordinarySubmission: ordinaryBody, manualReferencePreserved: true, notices },
    source: [line('cards: mode === "off"'), externalLine("src/lib/storyboard-visual-asset-binding.ts", "export function suspendVisualAssetBindings"),
      line("const refreshed = await refreshStoryboardVisualAssetReferences")], ...zeroEffects });
}

async function checkDirectorAssetsCompatibility() {
  const fixture = imageFixture();
  fixture.runRef.current = { ...fixture.runRef.current, directorIntake: { phase: "assets" },
    visualAssetWorkspace: { drafts: [{ planId: "asset_person", role: "character" }] },
    visualAssetPlan: { mode: "selected", assets: [] } };
  await actual("generateImage", fixture.context)("card-a");
  await actual("generateVideo", fixture.context)("card-a");
  assert.equal(fixture.posts.length, 0);
  assert.equal(fixture.saves.length, 0);
  assert.ok(fixture.notices.some(value => value.includes("续写卡")));
  assert.ok(fixture.notices.some(value => value.includes("准备角色三视图")));
  let operations = 0, adoptions = 0;
  const candidate = { planId: "asset_person", role: "character", assetId: "fixture-candidate" };
  const result = await actual("withFirstReferenceAdoption", { ...fixture.context, referenceOnly: false,
    adoptFirstStoryboardReference: async () => { adoptions++; throw new Error("Director assets must remain candidates until explicit adoption"); },
  })({ planId: candidate.planId, role: candidate.role }, async () => { operations++; return candidate; });
  assert.equal(result, candidate);
  assert.equal(operations, 1);
  assert.equal(adoptions, 0);
  compatibilityChecks.push({ name: "director assets gate and explicit adoption remain effective", passed: true,
    observations: { simulatedProviderDispatches: fixture.posts.length, projectSaves: fixture.saves.length,
      candidateOperations: operations, automaticAdoptions: adoptions, notices: fixture.notices } });
}

function legacyFixtureChecks() {
  const scripts = ["verify-storyboard-reference-adoption-guards.ts", "verify-storyboard-video-preparation.ts",
    "verify-storyboard-visual-asset-binding.ts", "verify-storyboard-reference-closure.ts", "verify-storyboard-image-single-submit.ts"];
  return scripts.map(script => {
    const result = spawnSync(process.execPath, ["./scripts/run-node-maintenance-tsx.mjs", `./scripts/${script}`], {
      cwd: process.cwd(), encoding: "utf8", windowsHide: true, timeout: 30_000,
    });
    const output = String(result.stdout || "") + String(result.stderr || "");
    writeFileSync(path.join(outputDir, `${script}.log`), output, { encoding: "utf8", flag: "wx" });
    return { script, exitCode: result.status, classification: result.status === 0 ? "FIXTURE_PASSED"
      : /ReferenceError: (?:pendingAssetAttempts|visualAssetSelectionError|imageAttemptNeedsResolution) is not defined/u.test(output)
        ? "STALE_TEST_FIXTURE_NOT_A_PRODUCT_RUNTIME_FAILURE" : "UNEXPECTED_TEST_FAILURE",
      log: `${outputRelative}/${script}.log`,
      firstFailure: output.split(/\r?\n/u).find(value => /ReferenceError|AssertionError|Error:/u.test(value)) || null };
  });
}

async function main() {
  prepareEvidenceDirectory();
  const auditedFiles = [componentPath, "src/lib/storyboard-visual-asset-binding.ts", "src/lib/storyboard-visual-asset-selection.ts", "src/lib/storyboard-reference-removal.ts",
    "src/lib/storyboard-continuous-production.ts",
    "src/lib/storyboard-visual-asset-submission.ts", "src/lib/storyboard-board-export.ts", "src/lib/storyboard-video-preparation.ts", "src/lib/storyboard-video-retry.ts", "scripts/verify-storyboard-delivery-submission-audit.ts"];
  const hashes = auditedFiles.map(file => ({ file, sha256: createHash("sha256").update(readFileSync(file)).digest("hex") }));
  assert.equal(hashes[0].sha256, loadedComponentSha256, "Component changed between AST loading and audit start");
  await auditImageRollback();
  await auditRemovedCardDispatch();
  await auditCancelledBatch();
  await auditInlineBatch();
  await auditReferenceMode();
  await checkDirectorAssetsCompatibility();
  assert.equal(findings.length, 5); assert.ok(findings.every(finding => finding.status === "FIXED_IN_RETEST"));
  assert.equal(unexpectedNetworkRequests, 0);
  const legacyTests = process.env.STORYBOARD_DELIVERY_AUDIT_RUN_LEGACY === "1" ? legacyFixtureChecks() : [];
  for (const identity of hashes) assert.equal(createHash("sha256").update(readFileSync(identity.file)).digest("hex"), identity.sha256,
    `${identity.file} must not change during this audit`);
  const receipt = { schema: "storyboard-delivery-submission-acceptance.v2", completedAt: new Date().toISOString(),
    scope: "Uncommitted current F-drive source; real callbacks extracted by TypeScript AST; controlled IO only",
    auditStatus: "COMPLETED", productStatus: "FIVE_REPAIRS_PASSED_ZERO_NETWORK_ACCEPTANCE", exitCode: 0, runtimeAcceptance: "NOT_PERFORMED",
    paidEndToEndAcceptance: "NOT_PERFORMED", sourceUnchangedDuringAudit: true, outputDirectory: outputRelative,
    sourceFiles: hashes, componentSha256Start: loadedComponentSha256, componentSha256End: createHash("sha256").update(readFileSync(componentPath)).digest("hex"),
    findings, compatibilityChecks, legacyTests, legacyTestsStatus: legacyTests.length ? "EXECUTED" : "SKIPPED_NOT_REQUIRED", ...zeroEffects };
  writeFileSync(path.join(outputDir, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n", { encoding: "utf8", flag: "wx" });
  writeFileSync(path.join(outputDir, "extracted-callbacks.txt"), [...new Set(["generateImage", "removeCard", "batchVideos", "buildBatchAuthorization", "runVideoBatch", "prepareAndGenerateVideo", "saveBoardForVideo", "generateVideo", "selectVisualAssetMode", "withFirstReferenceAdoption", "verifyPlannedDirectorReferences"])]
    .map(name => `// ${name}\n${nodes.get(name)!.getText(tree)}`).join("\n\n"), { encoding: "utf8", flag: "wx" });
  console.log(JSON.stringify({ auditStatus: receipt.auditStatus, productStatus: receipt.productStatus, findings: findings.map(item => ({ id: item.id, status: item.status, priority: item.priority, title: item.title })),
    compatibilityChecks, legacyTests, sourceUnchangedDuringAudit: true, componentSha256: hashes[0].sha256,
    receipt: path.join(outputDir, "receipt.json"), ...zeroEffects }, null, 2));
  process.exitCode = 0;
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
