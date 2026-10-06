import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

import { createStoryboardPersistenceSnapshot } from "../src/lib/storyboard-local-persistence";

const componentPath = "src/components/storyboard-workbench.tsx";
const source = readFileSync(componentPath, "utf8");
const projectHook = readFileSync("src/hooks/use-storyboard-projects.ts", "utf8");
const projectApi = readFileSync("src/app/api/storyboard/projects/route.ts", "utf8");
const tree = ts.createSourceFile(componentPath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const transpile = (text: string) => ts.transpileModule(text, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

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

const CURRENT_KEY = "storyboard_prompt_workbench_current_v2";
const HISTORY_KEY = "storyboard_prompt_workbench_history_v2";
const STORYBOARD_IDLE_DRAFT_KEY = "storyboard_idle_draft_v1";
const userId = "offline-user";
const currentStorageKey = `${CURRENT_KEY}:user:${userId}`;
const historyStorageKey = `${HISTORY_KEY}:user:${userId}`;
const idleDraftStorageKey = `${STORYBOARD_IDLE_DRAFT_KEY}:user:${userId}`;
const legacyKeys = [CURRENT_KEY, HISTORY_KEY, STORYBOARD_IDLE_DRAFT_KEY, currentStorageKey, historyStorageKey, idleDraftStorageKey];
const localStorage = storageFixture([...legacyKeys.map((key) => [key, "legacy-local"] as [string, string]), ["unrelated", "keep"]]);
const sessionStorage = storageFixture([...legacyKeys.map((key) => [key, "legacy-session"] as [string, string]), ["unrelated", "keep"]]);
const initializationContext = {
  CURRENT_KEY, HISTORY_KEY, STORYBOARD_IDLE_DRAFT_KEY, currentStorageKey, historyStorageKey, idleDraftStorageKey, userId,
  localStorage, sessionStorage, URLSearchParams,
  window: { location: { search: "" } },
  historyRef: { current: [serializedRun] },
  agentHandoffConsumedRef: { current: false },
  setHistory(value: unknown) { initializationContext.history = value; },
  setStorageReady(value: boolean) { initializationContext.storageReady = value; },
  history: null as unknown,
  storageReady: false,
};
vm.runInNewContext(
  transpile(`globalThis.initializeStoryboard = ${firstCallback("useEffect", "for (const key of [")};`),
  initializationContext,
);
(initializationContext as typeof initializationContext & { initializeStoryboard: () => void }).initializeStoryboard();
for (const key of legacyKeys) {
  assert.equal(localStorage.entries.has(key), false, `legacy local key ${key} must be cleared`);
  assert.equal(sessionStorage.entries.has(key), false, `legacy session key ${key} must be cleared`);
}
assert.equal(localStorage.entries.get("unrelated"), "keep");
assert.equal(sessionStorage.entries.get("unrelated"), "keep");
assert.equal(initializationContext.storageReady, true);
assert.equal(Array.isArray(initializationContext.history), true);
assert.equal((initializationContext.history as unknown[]).length, 0);

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
    cloudReady: true,
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
assert.doesNotMatch(source, /saveCurrentProject/u, "工作台不应保留无效的手动保存工程回调");
assert.doesNotMatch(source, />\s*保存工程\s*</u, "工作台不应展示手动保存工程按钮");

const restoredRun = {
  ...blankRun,
  id: "restored-account-project",
  cards: [{ ...blankRun.cards[0], imageStatus: "done", imageUrl: "https://cdn.example/owned.png" }],
};
const restoreContext = {
  exports: {},
  project: { id: restoredRun.id },
  window: { confirm: () => true },
  cloud: { restore: async () => restoredRun },
  normalizeRun: (value: unknown) => value,
  scopeMountedRef: { current: true },
  videoHistoryHydratedRef: { current: true },
  submittedRunIdsRef: { current: new Set<string>() },
  runRef: { current: blankRun },
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
  transpile(`globalThis.restoreAccountProject = ${jsxCallback("cloud.restore(project.id)")};`),
  restoreContext,
);
await (restoreContext as typeof restoreContext & { restoreAccountProject: () => Promise<void> }).restoreAccountProject();
assert.equal((restoreContext.run as { id?: string }).id, restoredRun.id);
assert.equal(restoreContext.runRef.current.id, restoredRun.id);
assert.equal(restoreContext.submittedRunIdsRef.current.has(restoredRun.id), true);
assert.equal(restoreContext.historyOpen, false);

assert.doesNotMatch(source, /localStorage\.setItem\((?:currentStorageKey|historyStorageKey)/u, "旧浏览器草稿键不得再写入");
assert.doesNotMatch(source, /sessionStorage\.setItem\((?:currentStorageKey|historyStorageKey)/u, "旧会话草稿键不得再写入");
assert.match(source, /提交图片或视频后会自动保存到账户/u);
assert.match(projectHook, /request\(`\?id=\$\{encodeURIComponent\(id\)\}`\)/u, "账户恢复必须读取项目 API");
assert.match(projectApi, /\.eq\("owner_id", user\.id\)\.eq\("id", id\)/u, "账户恢复必须校验工程归属");

console.log(JSON.stringify({
  ok: true,
  cases: {
    legacyLocalAndSessionDraftsCleared: true,
    unrelatedBrowserStoragePreserved: true,
    unsubmittedBlankProjectAutosaveBlocked: true,
    submittedProjectAccountAutosave: true,
    noManualSaveControl: true,
    ownedAccountRestore: true,
    embeddedMediaStripped: true,
  },
  persistedBytes: JSON.stringify(snapshot).length,
  networkRequests: 0,
  providerRequests: 0,
  paidRequests: 0,
  databaseWrites: 0,
}, null, 2));
}

runAccountBehaviorChecks().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
