import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { storyboardProjectAutosaveFingerprint, STORYBOARD_AUTOSAVE_MIN_INTERVAL_MS, STORYBOARD_MONITOR_CHECKPOINT_MS } from "../src/lib/storyboard-project-autosave";

const source = readFileSync("src/components/storyboard-workbench.tsx", "utf8");
const tree = ts.createSourceFile("workbench.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let callback = "";
function walk(node: ts.Node) {
  if (ts.isCallExpression(node) && node.expression.getText(tree) === "useEffect" && node.arguments[0]?.getText(tree).includes("const monitorOnly") ) callback = node.arguments[0].getText(tree);
  if (ts.isCallExpression(node) && node.expression.getText(tree) === "useEffect" && node.arguments[0]?.getText(tree).includes("let monitorOnly")) callback = node.arguments[0].getText(tree);
  ts.forEachChild(node, walk);
}
walk(tree); assert.ok(callback, "actual autosave callback must be exercised");
let now = 100_000, serial = 0;
const timers = new Map<number, { due: number; callback: () => void }>();
const original = { id: "project", updatedAt: now, cards: Array.from({ length: 13 }, (_, i) => ({ id: `card-${i}`, videoStatus: "running", videoTaskId: `task-${i}`, videoLastCheckedAt: now, videoStatusDetail: "observed", videoPriceCharged: 0 })) };
const runRef = { current: structuredClone(original) };
const projectAutosaveRef: { current: null | { timer: number; runId: string; owner: string; dueAt: number } } = { current: null };
const saved: typeof original[] = [];
const context = vm.createContext({
  Date: { now: () => now }, JSON, Math,
  window: { setTimeout: (callback: () => void, delay: number) => { const id = ++serial; timers.set(id, { due: now + delay, callback }); return id; }, clearTimeout: (id: number) => timers.delete(id) },
  projectAutosaveRef, lastProjectSaveAtRef: { current: new Map([[original.id, now]]) },
  view: "workbench", contextReadyRef: { current: true }, navigating: false, navigationRef: { current: false }, storageReady: true,
  cloudReady: true, visualAssetSaving: false, exportingBoardIds: new Set(), submittedRunIdsRef: { current: new Set([original.id]) }, hasSubmittedWork: () => true,
  run: runRef.current, runRef, confirmedProjectSnapshot: original.id + ":" + JSON.stringify(original), cloud: { saveRetryAt: 0 },
  storyboardProjectSnapshotMatches: (run: typeof original, confirmed: string) => confirmed === run.id + ":" + JSON.stringify(run),
  createStoryboardPersistenceSnapshot: (run: typeof original) => structuredClone(run), storyboardProjectAutosaveFingerprint,
  STORYBOARD_AUTOSAVE_MIN_INTERVAL_MS, STORYBOARD_MONITOR_CHECKPOINT_MS,
  userId: "owner", token: "fixture", imageDownloadOwnerRef: { current: "owner\0fixture" }, scopeMountedRef: { current: true }, boardExportLocksRef: { current: new Set() },
  saveStoryboardProject: (run: typeof original) => { saved.push(run); return Promise.resolve(true); }, setVisualAssetError: (message: string) => { throw new Error(message); },
});
const effect = vm.runInContext(ts.transpileModule(`(${callback})`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
const update = () => { context.run = runRef.current; effect(); };
let passed = 0;
for (let tick = 1; tick <= 20; tick++) {
  now = 100_000 + tick * 1000;
  runRef.current = { ...runRef.current, updatedAt: now, cards: runRef.current.cards.map(card => ({ ...card, videoLastCheckedAt: now, videoStatusDetail: `observation ${tick}` })) };
  update();
  assert.equal(timers.size, 1, "13 active cards must share one monitoring checkpoint");
  assert.equal(projectAutosaveRef.current!.dueAt, 130_000, "monitoring must not restart the checkpoint timer");
}
assert.equal(saved.length, 0); passed++;
runRef.current.cards[0] = { ...runRef.current.cards[0], videoStatus: "done" };
update(); assert.equal(projectAutosaveRef.current!.dueAt, 121_200); passed++;
now = 120_500;
runRef.current.cards[1].videoLastCheckedAt = now; update();
assert.equal(projectAutosaveRef.current!.dueAt, 121_200); passed++;
now = 121_200;
const ready = timers.get(projectAutosaveRef.current!.timer)!;
timers.delete(projectAutosaveRef.current!.timer); ready.callback();
assert.equal(saved.length, 1); assert.equal(saved[0].cards[0].videoStatus, "done");
assert.equal(saved[0].cards[1].videoLastCheckedAt, 120_500, "actual saved snapshot must retain the latest monitoring fields"); passed++;
context.confirmedProjectSnapshot = original.id + ":" + JSON.stringify(runRef.current);
context.lastProjectSaveAtRef.current.set(original.id, now);
now += 100; runRef.current.cards[2].videoStatus = "done"; update();
assert.equal(projectAutosaveRef.current!.dueAt, 126_200, "ordinary autosaves must stay at least five seconds apart"); passed++;
now = 124_000; context.lastProjectSaveAtRef.current.set(original.id, now); update();
assert.equal(projectAutosaveRef.current!.dueAt, 129_000, "a successful manual save must push an older pending timer past the minimum interval"); passed++;
context.cloud.saveRetryAt = 140_000; update();
assert.equal(projectAutosaveRef.current!.dueAt, 140_000); assert.equal(timers.size, 1); passed++;
context.imageDownloadOwnerRef.current = "other-owner\0fixture";
now = 140_000; const blocked = timers.get(projectAutosaveRef.current!.timer)!;
timers.delete(projectAutosaveRef.current!.timer); blocked.callback();
assert.equal(saved.length, 1, "a timer from the previous account must not save"); passed++;
for (const key of ["videoStatus", "videoTaskId", "videoPriceCharged"] as const) {
  const changed = structuredClone(original); (changed.cards[0] as Record<string, unknown>)[key] = "changed";
  assert.notEqual(storyboardProjectAutosaveFingerprint(original), storyboardProjectAutosaveFingerprint(changed)); passed++;
}
console.log(JSON.stringify({ passed, failed: 0, activeCards: 13, monitoringTicks: 20, queuedTimers: 1, realNetworkRequests: 0, databaseWrites: 0 }));
