import assert from "node:assert/strict";
import fs from "node:fs";

const read = (pathname) => fs.readFileSync(pathname, "utf8");
const workspace = read("src/components/admin/WorkspaceModelsAdminTab.tsx");
const storyboard = read("src/components/storyboard-workbench.tsx");
const requestStatus = read("src/app/api/video/request-status/route.ts");
const admin = read("src/app/admin/page.tsx");

const stageStart = workspace.indexOf("const stageOrder");
const stageEnd = workspace.indexOf("const moveToIndex", stageStart);
assert.ok(stageStart >= 0 && stageEnd > stageStart, "WORKSPACE_LOCAL_ORDER_STAGE_REQUIRED");
const stageBody = workspace.slice(stageStart, stageEnd);
assert.doesNotMatch(stageBody, /fetch\(/u, "WORKSPACE_REORDER_MUST_NOT_WRITE_BEFORE_SAVE");
assert.match(stageBody, /setDraftOrders/u, "WORKSPACE_SURFACE_DRAFT_REQUIRED");
assert.match(stageBody, /\[targetSurface\]: "dirty"/u, "WORKSPACE_DIRTY_STATE_REQUIRED");

assert.match(workspace, /data-testid="workspace-model-order-save"/u, "WORKSPACE_EXPLICIT_SAVE_BUTTON_REQUIRED");
assert.match(workspace, /action: "reorder"[\s\S]*surface: targetSurface/u, "WORKSPACE_SURFACE_SCOPED_REORDER_REQUIRED");
assert.match(workspace, /action: "validate", releaseId/u, "WORKSPACE_ORDER_VALIDATE_REQUIRED");
assert.match(workspace, /previewReleaseId=/u, "WORKSPACE_ORDER_PREVIEW_REQUIRED");
assert.match(workspace, /action: "publish", releaseId, previewSha256/u, "WORKSPACE_ORDER_PUBLISH_REQUIRED");
assert.match(workspace, /排序发布后的数据库回读不一致/u, "WORKSPACE_ORDER_READBACK_REQUIRED");

assert.match(requestStatus, /sameRequestKeyRequired: true/u, "VIDEO_RECONCILIATION_SAME_KEY_REQUIRED");
assert.match(requestStatus, /\.eq\('user_id', authorization\.user\.userId\)\.eq\('client_request_id', requestId\)/u, "VIDEO_RECONCILIATION_OWNER_SCOPE_REQUIRED");
assert.doesNotMatch(requestStatus, /generateVideo\(|generateVideoTask\(|from ['"]@\/lib\/video-adapter/u, "VIDEO_STATUS_LOOKUP_MUST_NOT_DISPATCH_PROVIDER");

const reconcileStart = storyboard.indexOf("const reconcileVideoRequest");
const reconcileEnd = storyboard.indexOf("useEffect(() => {", reconcileStart);
assert.ok(reconcileStart >= 0 && reconcileEnd > reconcileStart, "VIDEO_CLIENT_RECONCILIATION_REQUIRED");
const reconcileBody = storyboard.slice(reconcileStart, reconcileEnd);
assert.match(reconcileBody, /\/api\/video\/request-status/u, "VIDEO_REQUEST_STATUS_LOOKUP_REQUIRED");
assert.match(reconcileBody, /data\.found/u, "VIDEO_EXISTING_TASK_BIND_REQUIRED");
assert.match(reconcileBody, /data\.canResubmit && data\.sameRequestKeyRequired/u, "VIDEO_CONFIRMED_NO_TASK_GATE_REQUIRED");
assert.doesNotMatch(reconcileBody, /generateVideo\(/u, "VIDEO_RECONCILIATION_MUST_NOT_AUTO_RESUBMIT");
assert.match(storyboard, /videoNeedsRequestReconciliation\(card\) \? "刷新状态"/u, "VIDEO_MANUAL_REFRESH_ACTION_REQUIRED");
assert.match(storyboard, /!\(card\.videoClientRequestId && card\.videoClientRequestFingerprint\)/u, "VIDEO_RECOVERY_MUST_REUSE_STABLE_KEY");

assert.match(admin, /data-testid="admin-operation-toast"/u, "ADMIN_SAVE_FEEDBACK_REQUIRED");
assert.match(admin, /z-\[260\]/u, "ADMIN_SAVE_FEEDBACK_MUST_CLEAR_MODAL_LAYER");
assert.match(admin, /aria-live=/u, "ADMIN_SAVE_FEEDBACK_ACCESSIBILITY_REQUIRED");

console.log(JSON.stringify({
  passed: true,
  networkCalls: 0,
  providerCalls: 0,
  walletCalls: 0,
  contracts: [
    "workspace order changes remain local until explicit save",
    "each workspace surface saves through validate preview publish and readback",
    "lost video responses reconcile by owned stable request id",
    "reconciliation never auto-resubmits a paid request",
    "confirmed missing tasks reuse the original idempotency key on explicit retry",
    "agent save feedback renders above the edit modal",
  ],
}, null, 2));
