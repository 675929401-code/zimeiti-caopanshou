import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { VIDEO_TASK_DRAFT_TTL_MS } from "../src/lib/video-task-transfer";
import { VIDEO_WORKFLOW_DRAFT_TTL_MS } from "../src/lib/video-workflow-draft";
import { YOUCAI_PREFILL_TTL_MS } from "../src/lib/youcai-agent-routing";
import { GENERAL_SCRIPT_HANDOFF_MAX_AGE_MS } from "../src/lib/short-drama/general-script-storyboard-bridge";

const root = process.cwd();
const source = (relativePath: string) => readFileSync(path.join(root, relativePath), "utf8");

const taskTransfer = source("src/lib/video-task-transfer.ts");
const workflowDraft = source("src/lib/video-workflow-draft.ts");
const youcaiRouting = source("src/lib/youcai-agent-routing.ts");
const videoPage = source("src/app/video/page.tsx");
const messageItem = source("src/components/chat/message-item.tsx");
const imageWorkbench = source("src/components/image-workbench.tsx");
const storyboardWorkbench = source("src/components/storyboard-workbench.tsx");
const extractRoute = source("src/app/extract/page.tsx");
const generalScriptRoute = source("src/app/tools/text/general-script/page.tsx");

for (const [label, helper] of [
  ["video task transfer", taskTransfer],
  ["video workflow draft", workflowDraft],
  ["YouCai media prefill", youcaiRouting],
] as const) {
  assert.match(helper, /sessionStorage\.setItem/u, `${label} must use same-tab session storage`);
  assert.doesNotMatch(helper, /localStorage\.setItem/u, `${label} must not persist prompt or media content across browser sessions`);
}

assert.equal(VIDEO_TASK_DRAFT_TTL_MS, 2 * 60 * 1_000);
assert.equal(VIDEO_WORKFLOW_DRAFT_TTL_MS, 2 * 60 * 1_000);
assert.equal(YOUCAI_PREFILL_TTL_MS, 2 * 60 * 1_000);
assert.equal(GENERAL_SCRIPT_HANDOFF_MAX_AGE_MS, 2 * 60 * 1_000);

assert.match(taskTransfer, /ownerUserId: identity\.userId/u, "video handoff must bind the current account");
assert.match(taskTransfer, /ageMs < -60_000 \|\| ageMs > VIDEO_TASK_DRAFT_TTL_MS/u, "video handoff must reject stale and future-dated payloads");
assert.match(workflowDraft, /draft\.expiresAt > now \+ VIDEO_WORKFLOW_DRAFT_TTL_MS/u, "workflow handoff must reject extended client expiry");
assert.match(youcaiRouting, /window\.sessionStorage\.removeItem\(storageKey\);[\s\S]{0,180}JSON\.parse/u, "music prefill must be removed before parsing");

const workflowApply = videoPage.indexOf("if (!applyVideoWorkflowDraft(draft)) return false;");
const workflowClear = videoPage.indexOf("clearVideoWorkflowDraft();", workflowApply);
assert.ok(workflowApply >= 0 && workflowClear > workflowApply, "video page must clear a workflow only after applying it");
assert.doesNotMatch(videoPage, /localStorage\.getItem\([\s\S]{0,100}video_smart_import_text/u, "video page must not revive legacy smart-import text");
assert.doesNotMatch(videoPage, /addEventListener\("storage"/u, "session-only handoffs must not rely on cross-tab localStorage events");
assert.doesNotMatch(videoPage, /mergeVideoWorkflowDraft/u, "ordinary video-page edits must not recreate a browser draft");
assert.doesNotMatch(messageItem, /localStorage\.setItem\("video_smart_import_text"/u, "chat fallback must use the scoped transfer helper");
assert.equal((messageItem.match(/if \(!dispatched\)/gu) || []).length, 3, "all message-to-video branches must fail closed if handoff storage fails");
assert.doesNotMatch(messageItem, /window\.open\("\/video"/u, "message handoff must keep sessionStorage in the current tab");
assert.match(imageWorkbench, /临时交接 2 分钟内有效，读取一次即清除/u);
assert.match(imageWorkbench, /window\.location\.assign\(`\/video\?workflow=/u, "image-to-video handoff must navigate in the current tab");

assert.doesNotMatch(storyboardWorkbench, /localStorage\.setItem/u, "storyboard must not persist prompts, references or terminal results in localStorage");
assert.match(storyboardWorkbench, /localStorage\.removeItem\(key\)/u, "storyboard must delete old full snapshot keys");
assert.match(storyboardWorkbench, /sessionStorage\.getItem\(handoffStorageKey\)/u, "general-script handoff must use account-scoped session storage");
assert.match(storyboardWorkbench, /sessionStorage\.removeItem\(handoffStorageKey\)/u, "general-script handoff must be once-consumed");

assert.doesNotMatch(extractRoute, /components\/extract-tool/u, "legacy extract-tool component must remain unreachable from the active extract route");
assert.ok(!generalScriptRoute.includes("@/features/general-script/"), "legacy general-script storage must remain unreachable from the active route");
assert.match(generalScriptRoute, /features\/general-script-official\/general-script-official/u);

console.log(JSON.stringify({
  ok: true,
  ttlMinutes: 2,
  sessionOnly: ["video-task", "video-workflow", "youcai-music", "general-script-storyboard"],
  onceConsumed: ["video-workflow", "video-task", "youcai-music", "general-script-storyboard"],
  storyboardBrowserSnapshots: "retired-and-cleared",
  inactiveLegacyModules: ["src/components/extract-tool.tsx", "src/features/general-script/storage.ts"],
  networkRequests: 0,
  databaseWrites: 0,
  modelCalls: 0,
}, null, 2));
