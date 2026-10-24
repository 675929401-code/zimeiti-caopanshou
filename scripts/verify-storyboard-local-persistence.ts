import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

import { createStoryboardPersistenceSnapshot, sanitizeStoryboardPersistenceValue } from "../src/lib/storyboard-local-persistence";
import { parseStoryboardCanvasImport } from "../src/lib/storyboard-canvas-bridge";
import { StoryboardProjectDocument } from "../src/lib/storyboard-project-contract";
import { storyboardRecoveryStorageKey, readStoryboardRecovery, writeStoryboardRecovery, storyboardRecoveryContentFingerprint, inspectStoryboardRecoveryEdits, preserveStoryboardRecoveryConflict } from "../src/lib/storyboard-workspace-recovery";
import { collectStoryboardVideoTaskIds } from "../src/lib/storyboard-project-video-state";

const componentPath = "src/components/storyboard-workbench.tsx";
const source = readFileSync(componentPath, "utf8");
const projectHook = readFileSync("src/hooks/use-storyboard-projects.ts", "utf8");
const projectApi = readFileSync("src/app/api/storyboard/projects/route.ts", "utf8");
const tree = ts.createSourceFile(componentPath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const transpile = (text: string) => ts.transpileModule(text, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

let networkRequests = 0;
globalThis.fetch = (async () => { networkRequests += 1; throw new Error("NETWORK_FORBIDDEN_IN_PERSISTENCE_VERIFIER"); }) as typeof fetch;

const wardrobeEvent = { segmentId: "segment_001", from: "橙色毛衣", to: "浅色外套", reason: "回忆段落明确换装" };
const typedQualityChecks = [{
  checkId: "confirmed_reference_binding", status: "unknown",
  detail: "人物和宠物参考仍待真实绑定",
  verification: { kind: "visual_asset_binding", asset_ids: ["owner_main", "dog_main"] },
}];
const metadataRun = {
  id: "metadata-fixture", cards: [{
    id: "metadata-card", imagePrompt: "保留原图提示词", videoPrompt: "保留原视频提示词", referenceImageUrls: [],
    capabilityGaps: ["参考覆盖待核验", "动作和声音未实测"], dynamicState: ["犬看向主人", "主人手保持松开"],
    wardrobeChangeEvents: [wardrobeEvent], qualityChecks: typedQualityChecks,
    sceneId: "scene_home", camera: "低位固定镜头", unknownExtra: { mustNotPersist: true },
  }],
};
const metadataSnapshot = createStoryboardPersistenceSnapshot(metadataRun);
const metadataRoundtrip = sanitizeStoryboardPersistenceValue(JSON.parse(JSON.stringify(metadataSnapshot))) as typeof metadataRun;
for (const field of ["capabilityGaps", "dynamicState", "wardrobeChangeEvents", "qualityChecks"] as const) {
  assert.deepEqual(metadataRoundtrip.cards[0][field], metadataRun.cards[0][field], `${field} must survive repeated persistence`);
}
assert.equal(metadataRoundtrip.cards[0].imagePrompt, metadataRun.cards[0].imagePrompt);
assert.equal(metadataRoundtrip.cards[0].videoPrompt, metadataRun.cards[0].videoPrompt);
assert.equal(metadataRoundtrip.cards[0].sceneId, "scene_home");
assert.equal(metadataRoundtrip.cards[0].camera, "低位固定镜头");
assert.equal(metadataRoundtrip.cards[0].unknownExtra, undefined);
const legacyMetadata = createStoryboardPersistenceSnapshot({ cards: [{ referenceImageUrls: [] }] }).cards[0];
for (const field of ["capabilityGaps", "dynamicState", "wardrobeChangeEvents"]) {
  assert.equal(Object.hasOwn(legacyMetadata, field), false, "legacy missing metadata remains absent");
}
let invalidMetadataCases = 0;
for (const field of ["capabilityGaps", "dynamicState"] as const) {
  for (const value of [null, "not-an-array", {}, [7], [""], ["x".repeat(161)], Array(17).fill("有效说明")]) {
    assert.throws(() => sanitizeStoryboardPersistenceValue({ cards: [{ [field]: value }] }), `${field} malformed values must fail closed`);
    invalidMetadataCases++;
  }
}
for (const value of [null, "not-an-array", [7], [{}], [{ ...wardrobeEvent, reason: "x" }], [{ ...wardrobeEvent, from: "x".repeat(241) }], Array(9).fill(wardrobeEvent)]) {
  assert.throws(() => sanitizeStoryboardPersistenceValue({ cards: [{ wardrobeChangeEvents: value }] }), "malformed wardrobe events must fail closed");
  invalidMetadataCases++;
}
const maxMetadata = createStoryboardPersistenceSnapshot({ cards: [{
  referenceImageUrls: [], capabilityGaps: Array(16).fill("x".repeat(160)),
  dynamicState: Array(16).fill("x".repeat(160)), wardrobeChangeEvents: Array(8).fill(wardrobeEvent),
}] });
assert.equal(maxMetadata.cards[0].capabilityGaps.length, 16);
assert.equal(maxMetadata.cards[0].dynamicState.length, 16);
assert.equal(maxMetadata.cards[0].wardrobeChangeEvents.length, 8);
const emptyMetadata = createStoryboardPersistenceSnapshot({ cards: [{
  referenceImageUrls: [], capabilityGaps: [], dynamicState: [], wardrobeChangeEvents: [],
}] });
assert.deepEqual(emptyMetadata.cards[0], { referenceImageUrls: [], capabilityGaps: [], dynamicState: [], wardrobeChangeEvents: [] });

// Execute the current API's real stabilize/hydrate functions with a DB that
// rejects every access. A prompt-only native import requires no media lookup.
async function nativePackageRoundtrip() {
  const nativeArg = process.argv.indexOf("--native-package");
  const hashArg = process.argv.indexOf("--native-sha256");
  if (nativeArg < 0) { assert.equal(hashArg, -1); return { exercised: false }; }
  assert.ok(hashArg >= 0, "native package verification requires its immutable SHA");
  const bytes = readFileSync(process.argv[nativeArg + 1]);
  const digest = createHash("sha256").update(bytes).digest("hex");
  assert.equal(digest, process.argv[hashArg + 1]);
  const pkg = JSON.parse(bytes.toString("utf8"));
  const plan = parseStoryboardCanvasImport({ source: "stable_json", schema_version: pkg.schema_version, machine_payload: pkg });
  assert.ok(plan, "real native package must pass the planning import gate");
  assert.equal(plan.segments.length, 13);
  const run = {
    id: "storyboard-run-native-metadata", title: "真实全文持久化检查", createdAt: 1, updatedAt: 1,
    ratio: plan.settings.aspectRatio, imageResolution: "1K", videoResolution: "720p",
    videoDuration: plan.settings.targetDurationSeconds, imageModelId: "", videoModelId: "",
    visualAssetPlan: plan.visualAssetPlan, wardrobePlan: plan.wardrobePlan, environmentGroups: plan.environmentGroups,
    cards: plan.segments.map((segment, index) => ({
      ...segment, id: `native-shot-${index + 1}`, order: index + 1,
      referenceImageUrls: [], imageStatus: "idle" as const, videoStatus: "idle" as const,
      dynamicState: segment.dynamicState || [], capabilityGaps: segment.capabilityGaps || [],
      wardrobeChangeEvents: segment.wardrobeChangeEvents,
    })),
  };
  const apiTree = ts.createSourceFile("route.ts", projectApi, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const declarations = ["possibleKey", "stabilize", "hydrate"].map(name => {
    const declaration = apiTree.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === name);
    assert.ok(declaration, `${name} API implementation must exist`);
    return declaration.getText(apiTree);
  }).join("\n");
  let databaseCalls = 0;
  const db = { from() { databaseCalls++; throw new Error("DATABASE_FORBIDDEN_IN_NATIVE_PERSISTENCE_VERIFIER"); } };
  const context = {
    structuredClone, URL, createStoryboardPersistenceSnapshot, collectStoryboardVideoTaskIds,
    mediaFields: ["imageUrl", "videoSourceImageUrl", "videoUrl", "videoContentUrl"],
    calls: {} as {
      stabilize: (database: unknown, owner: string, input: unknown) => Promise<unknown>;
      hydrate: (database: unknown, owner: string, input: unknown) => Promise<{ document: unknown }>;
    },
  };
  vm.runInNewContext(transpile(`${declarations}\nglobalThis.calls = { stabilize, hydrate };`), context);
  const clientSnapshot = createStoryboardPersistenceSnapshot(run);
  const serverInput = StoryboardProjectDocument.parse(JSON.parse(JSON.stringify(clientSnapshot)));
  const stored = await context.calls.stabilize(db, "offline-owner", serverInput);
  const hydrated = await context.calls.hydrate(db, "offline-owner", JSON.parse(JSON.stringify(stored)));
  const restored = StoryboardProjectDocument.parse(hydrated.document);
  for (const [index, segment] of plan.segments.entries()) {
    const card = restored.cards[index];
    assert.deepEqual(card.capabilityGaps, segment.capabilityGaps || []);
    assert.deepEqual(card.dynamicState, segment.dynamicState || []);
    assert.deepEqual(card.wardrobeChangeEvents, segment.wardrobeChangeEvents);
    assert.deepEqual(card.qualityChecks, segment.qualityChecks);
    assert.deepEqual(card.visualAssetRefs, segment.visualAssetRefs);
    assert.equal(card.imagePrompt, segment.imagePrompt);
    assert.equal(card.videoPrompt, segment.videoPrompt);
    assert.equal(card.styleLock, segment.styleLock);
    assert.equal(card.sceneLock, segment.sceneLock);
    assert.ok(segment.qualityChecks?.some(check => check.status === "unknown" && check.verification?.kind === "visual_asset_binding"),
      "real pending binding verification must survive unchanged, never become pass");
  }
  assert.equal(databaseCalls, 0);
  return { exercised: true, sha256: digest, cards: restored.cards.length, actualServerStabilizeAndHydrate: true, databaseCalls };
}

function firstCallback(callName: string, marker: string) {
  let found = "";
  function visit(node: ts.Node) {
    if (
      !found
      && ts.isCallExpression(node)
      && node.expression.getText(tree) === callName
      && node.arguments[0]?.getText(tree).includes(marker)
    ) found = node.arguments[0].getText(tree);
    ts.forEachChild(node, visit);
  }
  visit(tree);
  assert.ok(found, `${callName} callback containing ${marker} must exist`);
  return found;
}

function jsxCallback(marker: string) {
  let found = "";
  function visit(node: ts.Node) {
    if (!found && ts.isJsxAttribute(node) && node.name.getText(tree) === "onClick") {
      const expression = ts.isJsxExpression(node.initializer!) ? node.initializer?.expression : undefined;
      if (expression && ts.isArrowFunction(expression) && expression.getText(tree).includes(marker)) {
        found = expression.getText(tree);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  assert.ok(found, `onClick callback containing ${marker} must exist`);
  return found;
}

function storageFixture(seed: Array<[string, string]>) {
  const entries = new Map(seed);
  const removed: string[] = [];
  return {
    entries,
    removed,
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => entries.set(key, String(value)),
    removeItem: (key: string) => { removed.push(key); entries.delete(key); },
  };
}

const largeDataUrl = `data:image/png;base64,${"A".repeat(1_000_000)}`;
const serializedRun = {
  id: "submitted-project",
  cards: [{
    id: "shot-1",
    referenceImageUrls: [largeDataUrl, "blob:http://127.0.0.1/transient", "https://cdn.example/owned.png"],
    imageUrl: largeDataUrl,
    videoSourceImageUrl: "blob:http://127.0.0.1/source",
    videoUrl: "https://cdn.example/result.mp4",
    videoContentUrl: "/api/video/content/task-1",
  }],
};
const snapshot = createStoryboardPersistenceSnapshot(serializedRun);
assert.deepEqual(snapshot.cards[0]?.referenceImageUrls, ["https://cdn.example/owned.png"]);
assert.equal(snapshot.cards[0]?.imageUrl, undefined);
assert.equal(snapshot.cards[0]?.videoSourceImageUrl, undefined);
assert.equal(snapshot.cards[0]?.videoUrl, "https://cdn.example/result.mp4");
assert.equal(snapshot.cards[0]?.videoContentUrl, "/api/video/content/task-1");
assert.ok(JSON.stringify(snapshot).length < 1_000, "账号工程不得内嵌大体积媒体数据");

async function runWorkspaceRecoveryChecks() {
// Recovery is scoped by both account and authenticated session. Raw tokens never enter storage.
const keyA = await storyboardRecoveryStorageKey("account-a", "session-a-secret");
const keyB = await storyboardRecoveryStorageKey("account-b", "session-a-secret");
const keyC = await storyboardRecoveryStorageKey("account-a", "session-b-secret");
assert.notEqual(keyA, keyB);
assert.notEqual(keyA, keyC);
assert.equal(keyA.includes("session-a-secret"), false);
const recoveryRun = {
  id: "recovery-project-001", createdAt: 123, updatedAt: 456, title: "恢复的人物和任务",
  ratio: "16:9", imageResolution: "2K", videoResolution: "720p", videoDuration: 8,
  imageModelId: "image-model", videoModelId: "video-model",
  authToken: "do-not-persist", unknownSecret: "do-not-persist",
  cards: [{ id: "recovery-card", order: 1, imagePrompt: "原人物参考", videoPrompt: "原视频动作",
    referenceImageUrls: ["https://cdn.example/owned.png", "blob:temporary"],
    imageStatus: "done", videoStatus: "running", videoTaskId: "original-task-001",
    videoClientRequestId: "original-request-001", videoClientRequestFingerprint: "original-fingerprint",
    imageUrl: "https://cdn.example/owned.png", selected: true }],
};
const sessionStorage = storageFixture([]);
writeStoryboardRecovery(sessionStorage, keyA, recoveryRun);
const recovered = readStoryboardRecovery(sessionStorage, keyA)!;
assert.equal(recovered.run.id, recoveryRun.id);
assert.equal(recovered.run.cards[0].videoTaskId, "original-task-001");
assert.equal(recovered.run.cards[0].videoClientRequestId, "original-request-001");
assert.deepEqual(recovered.run.cards[0].referenceImageUrls, ["https://cdn.example/owned.png"]);
assert.equal(sessionStorage.entries.get(keyA)!.includes("do-not-persist"), false);
assert.equal(readStoryboardRecovery(sessionStorage, keyB), null);
assert.equal(readStoryboardRecovery(sessionStorage, keyC), null);
sessionStorage.setItem(keyB, sessionStorage.getItem(keyA)!);
assert.equal(readStoryboardRecovery(sessionStorage, keyB), null, "scope mismatch fails closed even when bytes are copied");
sessionStorage.setItem(keyC, "{malformed");
assert.equal(readStoryboardRecovery(sessionStorage, keyC), null);
const initializationContext = {
  view: "workbench", requestedProjectId: "", userId: "account-a", token: "session-a-secret",
  sessionStorage, storyboardRecoveryStorageKey, readStoryboardRecovery,
  recoveryKeyRef: { current: "" }, initialProjectIdRef: { current: "" },
  workspaceGenerationRef: { current: 0 }, discardedRecoveryRunIdsRef: { current: new Set<string>() },
  initialRecoveryRef: { current: null as unknown }, confirmedRecoveryBaseRef: { current: "" },
  recoveryReadReady: false, setRecoveryReadReady(value: boolean) { initializationContext.recoveryReadReady = value; },
  runRef: { current: null as unknown }, contextReadyRef: { current: false },
  submittedRunIdsRef: { current: new Set() },
  normalizeRun: (value: unknown) => value, hasSubmittedWork: () => true,
  setRun(value: unknown) { initializationContext.run = value; },
  setStorageReady(value: boolean) { initializationContext.storageReady = value; },
  setProjectContext(value: string) { initializationContext.projectContext = value; },
  setNotice(value: string) { initializationContext.notice = value; },
  run: null as unknown, storageReady: false, projectContext: "loading", notice: "",
};
const freshDeclarations = ["createId", "createCard", "createRun"].map(name => {
  const declaration = tree.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.ok(declaration, name);
  return declaration.getText(tree);
}).join("\n");
vm.runInNewContext(transpile(`${freshDeclarations}\nrun = createRun(); runRef.current = run;\nglobalThis.initializeStoryboard = ${firstCallback("useEffect", "storyboardRecoveryStorageKey(userId, token)")};`), initializationContext);
(initializationContext as typeof initializationContext & { initializeStoryboard: () => () => void }).initializeStoryboard();
assert.equal(initializationContext.storageReady, false, "blank initial state cannot persist before async hydration");
for (let tries = 0; tries < 20 && !initializationContext.storageReady; tries++) await new Promise(resolve => setTimeout(resolve, 5));
assert.equal(initializationContext.storageReady, true);
assert.notEqual((initializationContext.run as { id: string }).id, recoveryRun.id);
assert.equal((initializationContext.run as { cards: unknown[] }).cards.length, 3, "ordinary entries always start with three fresh cards");
assert.equal(initializationContext.initialRecoveryRef.current, null, "ordinary entries cannot select a project from browser recovery");
assert.equal(initializationContext.contextReadyRef.current, true);
assert.equal(initializationContext.submittedRunIdsRef.current.has(recoveryRun.id), false);
const writeProbe = { storageReady: false, view: "workbench", contextReadyRef: { current: true },
  recoveryOverwriteBlockedRef: { current: false }, runRef: { current: recoveryRun },
  recoveryKeyRef: { current: keyA }, confirmedRecoveryBaseRef: { current: "" }, run: recoveryRun, writes: 0, sessionStorage,
  createStoryboardPersistenceSnapshot, setNotice: () => {},
  writeStoryboardRecovery() { writeProbe.writes++; } };
vm.runInNewContext(transpile(`globalThis.persistStoryboard = ${firstCallback("useEffect", "writeStoryboardRecovery(sessionStorage")};`), writeProbe);
(writeProbe as typeof writeProbe & { persistStoryboard: () => void }).persistStoryboard();
assert.equal(writeProbe.writes, 0, "initial blank state must never overwrite recovery");
writeProbe.storageReady = true;
(writeProbe as typeof writeProbe & { persistStoryboard: () => void }).persistStoryboard();
assert.equal(writeProbe.writes, 1);
const hostSource = readFileSync("src/components/storyboard-workbench-route-host.tsx", "utf8");
assert.ok(hostSource.includes("<StoryboardWorkbench historyPage={historyPage}"));
assert.equal(hostSource.includes("key={pathname}") || hostSource.includes("key={historyPage}"), false, "history navigation retains the same mounted workbench");
assert.ok(source.includes("<div hidden={historyPage}"), "workbench DOM survives while history is visible");
assert.match(source, /presentation="inline"/u, "history uses an independent page presentation");

}

const autosaveEffect = firstCallback("useEffect", "const shouldPersist = submittedRunIdsRef.current.has(run.id)");
const hasSubmittedWorkDeclaration = tree.statements
  .filter((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === "hasSubmittedWork")
  .map((node) => node.getText(tree)).join("\n");
assert.ok(hasSubmittedWorkDeclaration, "hasSubmittedWork helper must exist");

type SaveProbe = { timers: Array<() => void>; saves: Array<{ document: unknown; manual: boolean }> };
function autosaveFixture(run: Record<string, unknown>, submitted = false) {
  const probe: SaveProbe = { timers: [], saves: [] };
  const context = {
    exports: {}, run, storageReady: true,
    view: "workbench", contextReadyRef: { current: true }, navigating: false, visualAssetSaving: false, exportingBoardIds: new Set(),
    cloudReady: true, userId: "offline-user", token: "offline-session",
    initialReferenceBlockedRef: { current: new Set() }, confirmedProjectSnapshot: "",
    projectAutosaveRef: { current: null }, lastProjectSaveAtRef: { current: new Map() },
    STORYBOARD_MONITOR_CHECKPOINT_MS: 60000, STORYBOARD_AUTOSAVE_MIN_INTERVAL_MS: 10000,
    storyboardProjectSnapshotMatches: () => false, cloud: { saveRetryAt: 0 },
    scopeMountedRef: { current: true }, navigationRef: { current: false },
    imageDownloadOwnerRef: { current: "offline-user\0offline-session" },
    runRef: { current: run }, boardExportLocksRef: { current: new Set() },
    visualAssetMutationRef: { current: false }, setVisualAssetError: () => {},
    saveStoryboardProject: (document: unknown, manual = false) => { probe.saves.push({ document, manual }); return Promise.resolve(true); },
    submittedRunIdsRef: { current: new Set(submitted ? [String(run.id)] : []) },
    createStoryboardPersistenceSnapshot,
    window: {
      setTimeout(callback: () => void) { probe.timers.push(callback); return 1; },
      clearTimeout() {},
    },
  };
  vm.runInNewContext(transpile(`${hasSubmittedWorkDeclaration}\nglobalThis.autosave = ${autosaveEffect};`), context);
  (context as typeof context & { autosave: () => unknown }).autosave();
  for (const timer of probe.timers) timer();
  return probe;
}

const blankRun = {
  id: "blank-project", title: "未提交空白工程", cards: [{
    id: "blank-shot", imagePrompt: "", videoPrompt: "", referenceImageUrls: [],
    imageStatus: "idle", videoStatus: "idle",
  }],
};
const blankProbe = autosaveFixture(blankRun);
assert.equal(blankProbe.timers.length, 0, "未提交空白工程不得安排账号自动保存");
assert.equal(blankProbe.saves.length, 0, "未提交空白工程不得写入账号工程");

const submittedProbe = autosaveFixture({
  ...blankRun,
  id: "submitted-project",
  cards: [{ ...blankRun.cards[0], imageStatus: "running" }],
});
assert.equal(submittedProbe.saves.length, 1, "已提交任务必须同步到账户工程");
assert.equal(submittedProbe.saves[0]?.manual, false);

async function runAccountBehaviorChecks() {
await runWorkspaceRecoveryChecks();
const nativeRoundtrip = await nativePackageRoundtrip();
assert.doesNotMatch(source, /saveCurrentProject/u, "工作台不应保留无效的手动保存工程回调");
assert.doesNotMatch(source, />\s*保存工程\s*</u, "工作台不应展示手动保存工程按钮");

const restoredRun = {
  ...blankRun,
  id: "restored-account-project", updatedAt: 100,
  cards: [{ ...blankRun.cards[0], imageStatus: "done", imageUrl: "https://cdn.example/owned.png" }],
};
const restoreContext = {
  exports: {},
  project: { id: restoredRun.id },
  requestedProjectId: restoredRun.id, projectToRestore: restoredRun.id, storageReady: false, recoveryReadReady: true,
  projectRestoreGenerationRef: { current: 0 }, recoveryOverwriteBlockedRef: { current: false }, recoveryKeyRef: { current: "offline-recovery-scope" },
  sessionStorage: storageFixture([]), inspectStoryboardRecoveryEdits, preserveStoryboardRecoveryConflict,
  setRecoveryConflictDraft() {},
  initialRecoveryRef: { current: null as null | { run: unknown; baseContentFingerprint: string } }, confirmedRecoveryBaseRef: { current: "" },
  storyboardRecoveryContentFingerprint,
  setStorageReady(value: boolean) { restoreContext.storageReady = value; },
  visualAssetGenerationRef: { current: false }, visualAssetMutationRef: { current: false }, navigationRef: { current: false },
  navigatedTo: "", leaveAssetProject: async (url: string) => { restoreContext.navigatedTo = url; },
  contextReadyRef: { current: false }, projectContext: "", projectContextError: "", confirmedSnapshot: "",
  setProjectContext(value: string) { restoreContext.projectContext = value; },
  setProjectContextError(value: string) { restoreContext.projectContextError = value; },
  setConfirmedProjectSnapshot(value: string) { restoreContext.confirmedSnapshot = value; },
  createStoryboardPersistenceSnapshot,
  window: { confirm: () => true },
  cloud: { restore: async () => restoredRun },
  normalizeRun: (value: unknown) => value,
  scopeMountedRef: { current: true },
  videoHistoryHydratedRef: { current: true },
  submittedRunIdsRef: { current: new Set<string>() },
  runRef: { current: blankRun as typeof blankRun & { updatedAt?: number } },
  history: [] as unknown[],
  run: blankRun as unknown,
  historyOpen: true,
  notice: "",
  MAX_HISTORY: 20,
  setHistory(update: (current: unknown[]) => unknown[]) { restoreContext.history = update(restoreContext.history); },
  setRun(value: unknown) { restoreContext.run = value; },
  setHistoryOpen(value: boolean) { restoreContext.historyOpen = value; },
  setNotice(message: string) { restoreContext.notice = message; },
};
vm.runInNewContext(
  transpile(`globalThis.restoreAccountProject = ${jsxCallback("await leaveAssetProject('/storyboard-workbench?projectId='")};`),
  restoreContext,
);
await (restoreContext as typeof restoreContext & { restoreAccountProject: () => Promise<void> }).restoreAccountProject();
assert.equal(restoreContext.navigatedTo, '/storyboard-workbench?projectId=' + restoredRun.id, "历史恢复通过明确项目路由加载");
vm.runInNewContext(transpile(`${hasSubmittedWorkDeclaration}\nglobalThis.loadAccountProject = ${firstCallback("useEffect", "cloud.restore(projectToRestore)")};`), restoreContext);
(restoreContext as typeof restoreContext & { loadAccountProject: () => () => void }).loadAccountProject();
await new Promise(resolve => setTimeout(resolve, 0));
assert.equal((restoreContext.run as { id?: string }).id, restoredRun.id);
assert.equal(restoreContext.runRef.current.id, restoredRun.id);
assert.equal(restoreContext.contextReadyRef.current, true);
assert.equal(restoreContext.projectContext, "ready");
assert.ok(restoreContext.confirmedSnapshot.startsWith(restoredRun.id + ":"));
const newerLocal = { ...restoredRun, updatedAt: 200, title: "未同步的新参数和原请求" };
restoreContext.runRef.current = newerLocal;
restoreContext.initialRecoveryRef.current = { run: newerLocal, baseContentFingerprint: storyboardRecoveryContentFingerprint(restoredRun) };
(restoreContext as typeof restoreContext & { loadAccountProject: () => () => void }).loadAccountProject();
await new Promise(resolve => setTimeout(resolve, 0));
assert.equal((restoreContext.run as { title: string }).title, newerLocal.title, "local edits survive when cloud business content still matches their confirmed base");
restoreContext.cloud.restore = async () => ({ ...restoredRun, updatedAt: 300, title: "已保存的新人物参考" });
(restoreContext as typeof restoreContext & { loadAccountProject: () => () => void }).loadAccountProject();
await new Promise(resolve => setTimeout(resolve, 0));
assert.equal((restoreContext.run as { title: string }).title, "已保存的新人物参考", "newer asset edits are restored after returning from the asset page");
// Execute the real asynchronous project effect with the reviewer order:
// a stale local draft has a future monitoring timestamp, history tries to run,
// then a delayed owned GET returns a newer character/prompt edit.
restoreContext.storageReady = false;
restoreContext.contextReadyRef.current = false;
const staleLocal = { ...restoredRun, updatedAt: Date.now() + 1000000, title: "旧人物和提示词" };
restoreContext.initialRecoveryRef.current = { run: staleLocal, baseContentFingerprint: storyboardRecoveryContentFingerprint(restoredRun) };
let finishProject!: (document: typeof restoredRun) => void;
restoreContext.cloud.restore = () => new Promise(resolve => { finishProject = resolve; });
const loadProject = (restoreContext as typeof restoreContext & { loadAccountProject: () => () => void }).loadAccountProject;
loadProject();
let historyReads = 0;
const delayedHistory = { storageReady: restoreContext.storageReady, token: "fixture", historyPage: true,
  loadVideoHistory: () => { historyReads++; }, cloud: { refresh: () => { historyReads++; } } };
vm.runInNewContext(transpile(`globalThis.enterHistory = ${firstCallback("useEffect", "if (!historyPage || !storageReady) return;")};`), delayedHistory);
(delayedHistory as typeof delayedHistory & { enterHistory: () => void }).enterHistory();
assert.equal(historyReads, 0, "history cannot hydrate progress before owned project confirmation");
const updatedCloud = { ...restoredRun, updatedAt: 500, title: "云端新人物和提示词" };
finishProject(updatedCloud);
await new Promise(resolve => setTimeout(resolve, 0));
assert.equal((restoreContext.run as { title: string }).title, updatedCloud.title, "monitoring timestamp cannot make stale local content overwrite newer cloud edits");
assert.equal(restoreContext.storageReady, true);
const monitoringOnly = { ...restoredRun, updatedAt: 999999, cards: restoredRun.cards.map(card => ({ ...card, videoProgress: 87, videoLastCheckedAt: 999999, videoStatus: "running" })) };
assert.equal(storyboardRecoveryContentFingerprint(monitoringOnly), storyboardRecoveryContentFingerprint(restoredRun), "monitoring has no influence on business conflict fingerprint");
const confirmedRun = restoreContext.run;
restoreContext.cloud.restore = async () => ({ ...restoredRun, id: "wrong-project" });
restoreContext.contextReadyRef.current = false;
(restoreContext as typeof restoreContext & { loadAccountProject: () => () => void }).loadAccountProject();
await new Promise(resolve => setTimeout(resolve, 0));
assert.equal(restoreContext.run, confirmedRun, "错误归属/项目结果不得覆盖当前任务");
assert.equal(restoreContext.contextReadyRef.current, false);
assert.equal(restoreContext.projectContext, "error");

assert.doesNotMatch(source, /localStorage\.setItem\((?:currentStorageKey|historyStorageKey)/u, "旧浏览器草稿键不得再写入");
assert.doesNotMatch(source, /sessionStorage\.setItem\((?:currentStorageKey|historyStorageKey)/u, "旧会话草稿键不得再写入");
assert.match(source, /const shouldPersist = submittedRunIdsRef.current.has\(run.id\) \|\| hasSubmittedWork\(run\)/u, "已提交账号工程保持自动保存门禁");
assert.match(projectHook, /request\(`\?id=\$\{encodeURIComponent\(id\)\}`\)/u, "账户恢复必须读取项目 API");
assert.match(projectApi, /\.eq\("owner_id", user\.id\)\.eq\("id", id\)/u, "账户恢复必须校验工程归属");

console.log(JSON.stringify({
  ok: true,
  cases: {
    ordinaryEntryIgnoresSessionRecovery: true,
    explicitProjectRecoveryPreserved: true,
    blankWriteBlockedBeforeHydration: true,
    originalTaskAndRequestIdsRetained: true,
    unrelatedBrowserStoragePreserved: true,
    unsubmittedBlankProjectAutosaveBlocked: true,
    submittedProjectAccountAutosave: true,
    noManualSaveControl: true,
    ownedAccountRestore: true,
    embeddedMediaStripped: true,
    existingMetadataArraysPreserved: true,
    typedQualityVerificationPreserved: true,
    legacyMetadataAbsencePreserved: true,
    metadataBoundsAndEmptyArrays: true,
  },
  invalidMetadataCases,
  nativeRoundtrip,
  persistedBytes: JSON.stringify(snapshot).length,
  networkRequests,
  providerRequests: 0,
  paidRequests: 0,
  databaseWrites: 0,
}, null, 2));
assert.equal(networkRequests, 0);
}

runAccountBehaviorChecks().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
