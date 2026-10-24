/* eslint-disable @typescript-eslint/no-explicit-any -- The VM supplies the production callback's heterogeneous browser and React bindings. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { createStoryboardPersistenceSnapshot } from "../src/lib/storyboard-local-persistence";
import { StoryboardProjectDocument } from "../src/lib/storyboard-project-contract";
import { isReferenceSessionId } from "../src/lib/storyboard-reference-workspace";
import { createImportedStoryboardVisualAssetWorkspace } from "../src/lib/storyboard-visual-asset-workspace";
import { clearStoryboardWorkspaceRecovery, inspectStoryboardRecoveryEdits, preserveStoryboardRecoveryConflict,
  readStoryboardRecovery, readStoryboardRecoveryConflicts, storyboardRecoveryContentFingerprint,
  storyboardRecoveryStorageKey, writeStoryboardRecovery } from "../src/lib/storyboard-workspace-recovery";

const path = "src/components/storyboard-workbench.tsx";
const source = readFileSync(path, "utf8");
const tree = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const transpile = (text: string) => ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
function callback(name: string, marker = "") {
  let found = "";
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(tree) === name && node.initializer) {
      found = ts.isCallExpression(node.initializer) ? node.initializer.arguments[0].getText(tree) : node.initializer.getText(tree);
    }
    if (name === "useEffect" && ts.isCallExpression(node) && node.expression.getText(tree) === name && node.arguments[0]?.getText(tree).includes(marker)) found = node.arguments[0].getText(tree);
    ts.forEachChild(node, visit);
  };
  visit(tree);
  assert.ok(found, `${name}: ${marker}`);
  return found;
}
const declarations = ["createId", "createCard", "createRun"].map(name => {
  const node = tree.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.ok(node, name);
  return node.getText(tree);
}).join("\n");
const checks: string[] = [];
async function check(name: string, action: () => unknown) { await action(); checks.push(name); }
function storage() {
  const entries = new Map<string, string>();
  return { entries, getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => { entries.set(key, value); }, removeItem: (key: string) => { entries.delete(key); } };
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
const flush = async () => { for (let i = 0; i < 12; i++) await new Promise(resolve => setImmediate(resolve)); };
let network = 0;
globalThis.fetch = (async () => { network++; throw new Error("NETWORK_FORBIDDEN"); }) as typeof fetch;
const ref = <T>(current: T) => ({ current });
// The harness executes the production callbacks; only browser and React scheduling are replaced.
function workspace(projectId = "") {
  const c: Record<string, any> = { Date, Math, Set, Map, URLSearchParams, Promise, JSON,
    userId: "reset-owner", token: "reset-secret", view: "workbench", requestedProjectId: projectId,
    requestedEntryProjectId: projectId, historyPage: false, recoveryReadReady: true, storageReady: true,
    projectContext: "ready", confirmedProjectSnapshot: "", pendingAssetAttempts: [], referenceLimit: 8, MAX_CARDS: 20,
    sessionStorage: storage(), history: [], notice: "", routes: [], canceledTimers: [], acknowledgments: [],
    window: { location: { search: "?projectId=old&entry=agent&handoff=storyboard&autoImport=1" }, clearTimeout: (id: number) => c.canceledTimers.push(id) },
    router: { replace: (url: string) => c.routes.push(url) },
    workbenchUserStorageKey: (key: string, owner: string) => `${key}:${owner}`,
    GENERAL_SCRIPT_HANDOFF_STORAGE_KEY: "general-script", GENERAL_SCRIPT_HANDOFF_RECEIPT_STORAGE_KEY: "general-receipt",
    acknowledgeAgentWorkbenchHandoffAcrossTabs: (...args: unknown[]) => { c.acknowledgments.push(args); return true; },
    createStoryboardPersistenceSnapshot, createImportedStoryboardVisualAssetWorkspace, isReferenceSessionId, storyboardRecoveryStorageKey, readStoryboardRecovery, readStoryboardRecoveryConflicts,
    imageAttemptNeedsResolution: () => false, isActiveVideoStatus: () => false,
    clearStoryboardWorkspaceRecovery, writeStoryboardRecovery, storyboardRecoveryContentFingerprint, inspectStoryboardRecoveryEdits, preserveStoryboardRecoveryConflict,
    normalizeRun: (value: unknown) => value, hasSubmittedWork: (run: any) => run.cards.some((card: any) => card.videoTaskId || card.imageRecordId),
    cloud: { restore: async () => null, save: async () => true },
  };
  for (const name of ["workspaceGenerationRef", "projectRestoreGenerationRef"]) c[name] = ref(0);
  for (const name of ["contextReadyRef", "scopeMountedRef"]) c[name] = ref(true);
  for (const name of ["navigationRef", "recoveryOverwriteBlockedRef", "agentHandoffConsumedRef", "agentImportBusyRef", "visualAssetMutationRef", "visualAssetGenerationRef", "videoBatchPreflightRef", "previousHistoryPageRef", "explicitHistorySelectionRef", "initialReferenceAdoptionRef"]) c[name] = ref(false);
  for (const name of ["initialRecoveryRef", "projectAutosaveRef", "batchAuthorizationRef", "continuousAuthorizationRef", "visualAssetBatchRef", "referenceUploadOperationRef", "visibleReferenceChoicesRef"]) c[name] = ref(null);
  for (const name of ["recoveryKeyRef", "confirmedRecoveryBaseRef", "automaticAgentImportRef", "referenceDisplayContextRef"]) c[name] = ref("");
  for (const name of ["discardedRecoveryRunIdsRef", "submittedRunIdsRef", "initialReferenceBlockedRef"]) c[name] = ref(new Set());
  for (const name of ["imageAutoResumeTimersRef", "lastProjectSaveAtRef"]) c[name] = ref(new Map());
  c.initialProjectIdRef = ref(projectId);
  c.imageDownloadOwnerRef = ref(c.userId + "\0" + c.token);
  c.agentHandoff = { status: "hidden" };
  for (const name of ["Run", "RecoveryReadReady", "StorageReady", "ProjectContext", "ProjectContextError", "Notice", "RecoveryConflictDraft", "RecoveryExtraDraft", "SavedRecoveryDrafts", "RecoveryProjectId", "ConfirmedProjectSnapshot", "CanDiscardRecovery", "FreshWorkspace", "AgentHandoff", "GeneralScriptHandoff", "GeneralScriptImportedRunId", "BatchMode", "ContinuousStatus", "ContinuousMessage", "ReferenceDisplayMode", "ResolvedVisualAssetPlan", "VisualAssetCandidates", "VisualAssetSaving", "VisualAssetGenerating", "VisualAssetError", "PreviewMedia", "UploadingCardId", "Navigating"]) {
    const key = name[0].toLowerCase() + name.slice(1);
    c[`set${name}`] = (value: unknown) => { c[key] = value; };
  }
  const context = vm.createContext(c);
  vm.runInContext(transpile(`${declarations}\nglobalThis.makeRun = createRun;`), context);
  c.run = c.makeRun(); c.runRef = ref(c.run);
  for (const name of ["startFreshWorkspace", "saveStoryboardProject", "applyImportedSegments", "confirmAgentHandoff", "confirmGeneralScriptHandoff", "runImageBatch", "runVideoBatch"]) {
    const body = callback(name);
    vm.runInContext(transpile(name === "startFreshWorkspace"
      ? `globalThis.${name} = (...args) => { const { agentHandoff, recoveryReadReady } = globalThis; return (${body})(...args); };`
      : `globalThis.${name} = ${body};`), context);
  }
  for (const [name, marker] of [["initialize", "storyboardRecoveryStorageKey(userId, token)"], ["restoreProject", "const generation = ++projectRestoreGenerationRef.current"], ["returnFromHistory", "const returningFromHistory"], ["persist", "writeStoryboardRecovery(sessionStorage, recoveryKeyRef.current"], ["synchronizeRun", "runRef.current = run;"]]) {
    vm.runInContext(transpile(`globalThis.${name} = ${callback("useEffect", marker)};`), context);
  }
  return c;
}
function assertBlank(c: Record<string, any>, old?: any) {
  assert.equal(c.run, c.runRef.current);
  assert.equal(c.run.cards.length, 3);
  assert.notEqual(c.run.id, old?.id);
  assert.equal(new Set(c.run.cards.map((card: any) => card.id)).size, 3);
  for (const card of c.run.cards) {
    for (const key of ["narration", "imagePrompt", "videoPrompt", "imageExactText"]) assert.equal(card[key], "");
    assert.equal(card.imageStatus, "idle"); assert.equal(card.videoStatus, "idle");
    assert.equal(card.referenceImageUrls.length, 0); assert.equal(card.visualAssetRefs.length, 0);
    for (const key of ["imageUrl", "videoUrl", "imageRecordId", "videoTaskId", "imageClientRequestId", "videoClientRequestId", "directorExecution"]) assert.equal(card[key], undefined);
    assert.equal(old?.cards.some((item: any) => item.id === card.id) || false, false);
  }
  assert.equal(c.run.visualAssetPlan.mode, "off"); assert.equal(c.run.visualAssetPlan.assets.length, 0);
  for (const key of ["visualAssetWorkspace", "directorIntake", "draftImportNotice", "environmentGroups"]) assert.equal(c.run[key], undefined);
  StoryboardProjectDocument.parse(createStoryboardPersistenceSnapshot(c.run));
}
async function main() {
  await check("ordinary entry and reload ignore a previous submitted recovery and start with three blank cards", async () => {
    const old = workspace().makeRun(); old.cards[0].videoTaskId = "paid-task-1"; old.cards[0].videoStatus = "running"; old.cards[0].imagePrompt = "old prompt";
    for (let visit = 0; visit < 2; visit++) {
      const c = workspace(); c.storageReady = false; c.recoveryReadReady = false;
      const key = await storyboardRecoveryStorageKey(c.userId, c.token);
      writeStoryboardRecovery(c.sessionStorage, key, old);
      c.initialize(); await flush();
      assertBlank(c, old); assert.equal(c.storageReady, true); assert.equal(c.projectContext, "ready");
      assert.equal(c.initialRecoveryRef.current, null); assert.equal(c.recoveryProjectId, undefined);
    }
  });
  await check("explicit project restore reapplies local edits only to the matching cloud baseline and retains task receipts", async () => {
    const c = workspace("explicit-project-001"), cloud = c.makeRun(); cloud.id = "explicit-project-001";
    cloud.cards[0].videoTaskId = "paid-original-task"; cloud.cards[0].videoStatus = "running";
    const local = structuredClone(cloud); local.cards[0].imagePrompt = "local exact edit";
    const key = await storyboardRecoveryStorageKey(c.userId, c.token);
    writeStoryboardRecovery(c.sessionStorage, key, local, storyboardRecoveryContentFingerprint(cloud));
    c.initialize(); await flush(); c.projectToRestore = cloud.id; c.cloud.restore = async () => cloud;
    c.restoreProject(); await flush();
    assert.equal(c.run.id, cloud.id); assert.equal(c.run.cards[0].imagePrompt, "local exact edit"); assert.equal(c.run.cards[0].videoTaskId, "paid-original-task");
    const wrong = workspace("other-explicit-001"); wrong.sessionStorage = c.sessionStorage; wrong.initialize(); await flush();
    assert.equal(wrong.initialRecoveryRef.current, null);
  });
  await check("one click clears current text, references, media, recovery, handoff and URL without deleting history or task receipts", async () => {
    const c = workspace("current-project-001"), old = c.run; old.id = "current-project-001";
    Object.assign(old.cards[0], { narration: "original", imagePrompt: "image", videoPrompt: "video", referenceImageUrls: ["https://owned.invalid/ref.png"], imageUrl: "https://owned.invalid/image.png", videoUrl: "https://owned.invalid/video.mp4", videoTaskId: "paid-original-task", videoStatus: "running" });
    old.directorIntake = { stale: true }; old.visualAssetWorkspace = { stale: true };
    c.history = [structuredClone(old)]; const historyBytes = JSON.stringify(c.history);
    c.recoveryKeyRef.current = await storyboardRecoveryStorageKey(c.userId, c.token);
    const persisted = { ...old, directorIntake: undefined, visualAssetWorkspace: undefined };
    writeStoryboardRecovery(c.sessionStorage, c.recoveryKeyRef.current, persisted);
    preserveStoryboardRecoveryConflict(c.sessionStorage, c.recoveryKeyRef.current, { run: persisted, baseContentFingerprint: "" });
    c.agentHandoff = { status: "ready", handoff: { handoff_id: "handoff-current" }, plan: {} };
    c.projectAutosaveRef.current = { timer: 1 }; c.imageAutoResumeTimersRef.current.set("old-card", 2);
    c.batchAuthorizationRef.current = {}; c.continuousAuthorizationRef.current = {};
    c.startFreshWorkspace(true);
    assertBlank(c, old); assert.equal(JSON.stringify(c.history), historyBytes);
    assert.equal(readStoryboardRecovery(c.sessionStorage, c.recoveryKeyRef.current), null);
    assert.equal(readStoryboardRecoveryConflicts(c.sessionStorage, c.recoveryKeyRef.current).length, 0);
    assert.equal(c.routes.at(-1), "/storyboard-workbench"); assert.equal(c.agentHandoff.status, "hidden");
    assert.equal(c.generalScriptHandoff.status, "hidden"); assert.equal(c.agentHandoffConsumedRef.current, true);
    assert.equal(c.acknowledgments[0][2], "handoff-current"); assert.deepEqual(c.canceledTimers, [1, 2]);
    assert.equal(c.batchAuthorizationRef.current, null); assert.equal(c.continuousAuthorizationRef.current, null);
    assert.equal(c.workspaceGenerationRef.current, 1); assert.equal(c.projectRestoreGenerationRef.current, 1);
  });
  await check("delayed project restore and its cleanup cannot refill or lock a cleared workspace", async () => {
    const c = workspace("late-project-001"), old = c.run; old.id = "late-project-001";
    c.projectToRestore = old.id; const pending = deferred<any>(); c.cloud.restore = () => pending.promise;
    const cleanup = c.restoreProject(); c.startFreshWorkspace(true); const fresh = c.run;
    pending.resolve(old); await flush(); cleanup();
    assert.equal(c.run, fresh); assertBlank(c, old); assert.equal(c.contextReadyRef.current, true);
    assert.equal(c.projectContext, "ready"); assert.equal(c.confirmedRecoveryBaseRef.current, "");
  });
  await check("clear before the session digest finishes removes the matching old recovery and never adopts it", async () => {
    const c = workspace("digest-project-001"), old = c.run; old.id = "digest-project-001";
    const key = await storyboardRecoveryStorageKey(c.userId, c.token);
    writeStoryboardRecovery(c.sessionStorage, key, old);
    const pending = deferred<string>(); c.storyboardRecoveryStorageKey = () => pending.promise;
    c.recoveryReadReady = false; c.initialize(); c.startFreshWorkspace(true); pending.resolve(key); await flush();
    assertBlank(c, old); assert.equal(readStoryboardRecovery(c.sessionStorage, key), null);
  });
  await check("history return without an explicit selection resets; a deliberate history selection remains visible", () => {
    const c = workspace(), old = c.run; old.cards[0].imagePrompt = "old draft";
    c.previousHistoryPageRef.current = true; c.returnFromHistory(); assertBlank(c, old);
    const selected = c.makeRun(); selected.cards[0].imagePrompt = "selected history"; c.run = selected; c.runRef.current = selected;
    c.previousHistoryPageRef.current = true; c.explicitHistorySelectionRef.current = true; c.returnFromHistory();
    assert.equal(c.run, selected); assert.equal(c.explicitHistorySelectionRef.current, false);
    const explicit = workspace("explicit-history-001"), retained = explicit.run;
    explicit.previousHistoryPageRef.current = true; explicit.returnFromHistory(); assert.equal(explicit.run, retained);
  });
  await check("late agent import at ID, lookup, restore and save boundaries cannot restore content or redirect after clear", async () => {
    for (const stage of ["id", "lookup", "restore", "save"]) {
      const c = workspace(), old = c.run, pending = deferred<any>(); const target = "agent-project-001";
      c.agentHandoff = { status: "ready", handoff: { handoff_id: "handoff-late", payload: {} }, plan: {} };
      c.storyboardAgentImportProjectId = () => stage === "id" ? pending.promise : Promise.resolve(target);
      c.fetch = async () => stage === "lookup" ? pending.promise : { ok: true };
      c.cloud.restore = () => stage === "restore" ? pending.promise : Promise.resolve({ ...old, id: target });
      if (stage === "save") { old.id = target; c.cloud.save = () => pending.promise; }
      const task = c.confirmAgentHandoff(); await flush(); c.startFreshWorkspace(true); const fresh = c.run;
      const ackCount = c.acknowledgments.length;
      pending.resolve(stage === "id" ? target : stage === "lookup" ? { ok: true } : stage === "save" ? true : { ...old, id: target });
      await task; assert.equal(c.run, fresh, stage); assertBlank(c, old);
      assert.equal(c.routes.at(-1), "/storyboard-workbench", stage); assert.equal(c.acknowledgments.length, ackCount, stage);
      assert.equal(c.agentHandoff.status, "hidden", stage); assert.equal(c.agentImportBusyRef.current, false);
    }
  });
  await check("a late reference-resolution import cannot replace fresh cards or release a new workspace mutation", async () => {
    const c = workspace(), pending = deferred<unknown[]>(), old = c.run;
    c.resolveVisualAssetUrls = () => pending.promise;
    const task = c.applyImportedSegments({ segments: [{ narration: "old import", imagePrompt: "old image", videoPrompt: "old video" }], title: "old import", visualAssetPlan: { mode: "off", assets: [] } });
    await flush(); c.startFreshWorkspace(true); const fresh = c.run;
    c.visualAssetMutationRef.current = true; c.visualAssetSaving = true;
    pending.resolve([]); assert.equal(await task, null);
    assert.equal(c.run, fresh); assertBlank(c, old); assert.equal(c.visualAssetMutationRef.current, true); assert.equal(c.visualAssetSaving, true);
  });
  await check("queued old saves stop before dispatch while an already dispatched save may finish only in history", async () => {
    const c = workspace(), old = c.run; let queued!: () => boolean;
    c.cloud.save = async (_run: unknown, _manual: boolean, canSave: () => boolean) => { queued = canSave; return true; };
    await c.saveStoryboardProject(old); assert.equal(queued(), true);
    c.startFreshWorkspace(true); assert.equal(queued(), false);
    const submitted = workspace(), pending = deferred<boolean>(); submitted.cloud.save = () => pending.promise;
    const task = submitted.saveStoryboardProject(submitted.run); submitted.startFreshWorkspace(true);
    const fresh = submitted.run; pending.resolve(true); assert.equal(await task, true);
    assert.equal(submitted.run, fresh); assert.equal(submitted.confirmedRecoveryBaseRef.current, ""); assert.equal(submitted.confirmedProjectSnapshot, "");
  });
  await check("batch clear stops unsubmitted cards without aborting or duplicating the dispatched request", async () => {
    for (const kind of ["images", "videos"]) {
      const c = workspace(), pause = deferred<void>(), response = deferred<any>(), dispatched: string[] = [];
      const authorization = { runId: c.run.id }; c.batchAuthorizationRef.current = authorization;
      c.delay = () => pause.promise; c.IMAGE_SUBMIT_INTERVAL_MS = 5; c.VIDEO_SUBMIT_INTERVAL_MS = 8;
      c.generateImage = c.prepareAndGenerateVideo = (id: string) => { dispatched.push(id); return response.promise; };
      const ids = c.run.cards.map((card: any) => card.id);
      const task = (kind === "images" ? c.runImageBatch : c.runVideoBatch)(ids, authorization);
      c.startFreshWorkspace(true); pause.resolve(); response.resolve({ id: "paid-history-result" }); await task;
      assert.deepEqual(dispatched, [ids[0]]); assertBlank(c);
    }
  });
  await check("stale persistence and render synchronization cannot write the cleared old run back", () => {
    const c = workspace(), old = c.run; c.recoveryKeyRef.current = "scoped-key"; c.startFreshWorkspace(true);
    const fresh = c.run; c.run = old; c.persist(); c.synchronizeRun();
    assert.equal(c.runRef.current, fresh); assert.equal(c.sessionStorage.entries.has("scoped-key"), false);
  });
  await check("selective recovery clearing preserves other projects, accounts, valid indexes and rejects corrupted indexes", async () => {
    const c = workspace(), current = c.makeRun(), other = c.makeRun(), s = storage();
    const scope = await storyboardRecoveryStorageKey("owner-a", "secret-a"), foreign = await storyboardRecoveryStorageKey("owner-b", "secret-a");
    assert.equal(scope.includes("secret-a"), false);
    writeStoryboardRecovery(s, scope, current); writeStoryboardRecovery(s, foreign, current);
    for (const run of [current, other]) for (const suffix of ["", ":new-workspace"]) preserveStoryboardRecoveryConflict(s, scope + suffix, { run, baseContentFingerprint: "" }, scope);
    clearStoryboardWorkspaceRecovery(s, scope, [current.id]);
    assert.equal(readStoryboardRecovery(s, scope), null); assert.ok(readStoryboardRecovery(s, foreign));
    assert.deepEqual(readStoryboardRecoveryConflicts(s, scope).map(item => item.run.id), [other.id, other.id]);
    clearStoryboardWorkspaceRecovery(s, scope, [current.id]);
    writeStoryboardRecovery(s, scope, other); clearStoryboardWorkspaceRecovery(s, scope, [current.id]); assert.equal(readStoryboardRecovery(s, scope)!.run.id, other.id);
    s.setItem(`${scope}:conflict-index`, JSON.stringify({ version: 1, scope, entries: [{ key: foreign, runId: current.id }] }));
    assert.throws(() => clearStoryboardWorkspaceRecovery(s, scope, [current.id])); assert.ok(readStoryboardRecovery(s, foreign));
    assert.equal(readStoryboardRecovery(s, scope)!.run.id, other.id);
    assert.throws(() => clearStoryboardWorkspaceRecovery({ ...s, removeItem() { throw new Error("storage denied"); } }, scope, [other.id]));
  });
  await check("unavailable storage still produces a fresh ordinary entry and reports incomplete local cleanup", () => {
    const c = workspace(), old = c.run; c.recoveryKeyRef.current = "blocked-scope";
    c.sessionStorage.removeItem = () => { throw new Error("denied"); }; c.startFreshWorkspace(true);
    assertBlank(c, old); assert.equal(c.routes.at(-1), "/storyboard-workbench"); assert.match(c.notice, /暂存未能完全移除/u);
  });
  assert.equal(network, 0);
  const hashes = Object.fromEntries([path, "src/lib/storyboard-workspace-recovery.ts"].map(path => [path, createHash("sha256").update(readFileSync(path)).digest("hex")]));
  console.log(JSON.stringify({ passed: true, checks, sourceHashes: hashes, networkRequests: network, databaseWrites: 0, providerSubmissions: 0 }, null, 2));
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
