import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const paths = {
  cover: new URL("../src/components/cover-studio.tsx", import.meta.url),
  generation: new URL("../src/lib/cover-generation-attempt.ts", import.meta.url),
  history: new URL("../src/app/api/cover/history/route.ts", import.meta.url),
};

const sources = Object.fromEntries(await Promise.all(
  Object.entries(paths).map(async ([name, path]) => [name, await readFile(path, "utf8")]),
));
const cover = sources.cover;
const checks = [
  ["legacy draft keys are retained only for cleanup", cover.includes("function clearLegacyCoverEditorDraft") && cover.includes("localStorage.removeItem(draftKey(ownerId))")],
  ["legacy IndexedDB assets are deleted instead of hydrated", cover.includes("window.indexedDB?.deleteDatabase(COVER_DRAFT_ASSET_DB_NAME)") && !cover.includes("indexedDB.open(COVER_DRAFT_ASSET_DB_NAME")],
  ["editor draft hydration is removed", !cover.includes("parseCoverStudioDraft") && !cover.includes("hydrateDraft") && !cover.includes("readCoverDraftReference")],
  ["editor draft autosave is removed", !cover.includes("localStorage.setItem(draftKey(") && !cover.includes("writeCoverDraftReference")],
  ["account mount scrubs legacy editor drafts", cover.includes('clearLegacyCoverEditorDraft(currentUserId || "anonymous")')],
  ["refresh detaches the old local pending selection", cover.includes("detachCoverGenerationTracking(localStorage, currentUserId)")],
  ["refresh loads account history without mounting a task", cover.includes("loadAccountHistory(1, controller.signal, false)")],
  ["history refresh preserves only an explicit current selection", cover.includes('tasks.some(task => task.id === previous) ? previous : ""')],
  ["each new submission receives isolated task tracking", cover.includes("const taskStorage = createTaskStorage()")],
  ["account history returns every active attempt", sources.history.includes("activeAttempts") && sources.history.includes("coverTaskStableKey")],
  ["local detach removes pending content rather than resuming it", sources.generation.includes("export function detachCoverGenerationTracking") && sources.generation.includes("saveState(storage, userId, { version: 1, pending: null, history: [] })")],
  ["the page no longer promises editor recovery after refresh", !cover.includes("当前输入自动保存，刷新后会继续载入")],
];

for (const [name, passed] of checks) assert.equal(passed, true, name);
console.log(`cover refresh separation zero-cost regression: ${checks.length}/${checks.length} assertions passed`);
console.log("providerCalls: 0; paidRequests: 0; browserWrites: 0");
