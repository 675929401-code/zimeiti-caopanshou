import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isWorkspaceModelAssigned } from "../src/lib/workspace-model-assignment-settings";
import { isVideoCatalogDisplaySurface, isVisibleInPublicWorkspace } from "../src/lib/video-workspace-catalog";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { videoOperatorSubmissionAdmission, videoBillingAdapterAdmission } from "../src/lib/video-model-availability";
import { publicVideoModelCompatibilityMessage, publicVideoModelInputCompatibilityCode } from "../src/lib/video-model-public-status";

const active = { id: "active", is_active: true, is_hidden: false };
const inactive = { id: "inactive", is_active: false, is_hidden: false };
const hidden = { id: "hidden", is_active: true, is_hidden: true };

assert.equal(isWorkspaceModelAssigned({}, "image", active, "image-workbench"), false);
assert.equal(isWorkspaceModelAssigned({}, "image", inactive, "image-workbench"), false);
assert.equal(isWorkspaceModelAssigned({}, "image", hidden, "image-workbench"), false);
assert.equal(isWorkspaceModelAssigned({ "image-workbench": { inactive: true } }, "image", inactive, "image-workbench"), true);
assert.equal(isWorkspaceModelAssigned({ "image-workbench": { hidden: true } }, "image", hidden, "image-workbench"), true);
assert.equal(isWorkspaceModelAssigned({ "image-workbench": { active: false } }, "image", active, "image-workbench"), false);

const component = readFileSync(new URL("../src/components/admin/WorkspaceModelsAdminTab.tsx", import.meta.url), "utf8");
const route = readFileSync(new URL("../src/app/api/admin/workspace-models/route.ts", import.meta.url), "utf8");

for (const label of [
  "从模型池添加",
  "从当前页面移除",
  "当前页面尚未添加模型",
  "不兼容当前页面的模型不会出现在这里，也不会被停用",
]) assert.ok(component.includes(label), `missing workspace model status label: ${label}`);

assert.equal(component.includes("已加入，但生成停用"), false);
for (const surface of ["storyboard-video", "video-page"] as const) {
  assert.equal(isVideoCatalogDisplaySurface(surface), true);
  assert.equal(isVisibleInPublicWorkspace({ surfaceCompatible: false, maxReferenceImages: 0 }, surface), true,
    "assigned video models remain visible when input compatibility separately blocks submission");
}
assert.equal(isVideoCatalogDisplaySurface("image-workbench"), false);
assert.equal(isVisibleInPublicWorkspace({ surfaceCompatible: false, maxReferenceImages: 0 }, "image-workbench"), false);
assert.ok(component.includes("输入不兼容或能力待核验的模型会显示原因并禁用生成"));
assert.ok(route.includes("该模型接口通信异常，修复后才能添加到业务页面"));

assert.equal(component.includes("生成已启用，可加入工作台"), false);
const admissionStart = route.indexOf('const operatorAdmission = surface.kind === "video"');
const admissionEnd = route.indexOf("const assigned =", admissionStart);
assert.ok(admissionStart >= 0 && admissionEnd > admissionStart);
const realAdmissionBlock = route.slice(admissionStart, admissionEnd);
function actualAdminPublishable(protocol: Record<string, unknown>, endpoint = "https://gaorui.cc/v1", priceReady = true) {
  const holder = { exports: undefined as unknown as { publishable: boolean; capabilitiesVerified: boolean } };
  runInNewContext(ts.transpileModule(`${realAdmissionBlock}\nmodule.exports={publishable,capabilitiesVerified};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText, { module: holder, surface: { kind: "video" }, model: { protocol_type: "gaorui_video", model_name: "seedance-2.5", api_endpoint: endpoint, api_protocol_config: protocol },
    protocol, compatibility: { compatible: true, issues: [] }, active: true, hidden: false, configured: true, priceReady,
    videoOperatorSubmissionAdmission, videoBillingAdapterAdmission, publicVideoModelCompatibilityMessage, publicVideoModelInputCompatibilityCode });
  return holder.exports;
}
const bound = { protocol_family: "seedance_native_content", capability_contract_verified: false };
assert.deepEqual(JSON.parse(JSON.stringify(actualAdminPublishable(bound))), { publishable: true, capabilitiesVerified: false });
assert.equal(actualAdminPublishable({ ...bound, generation_paused: true }).publishable, false);
assert.equal(actualAdminPublishable({ capability_contract_verified: true }).publishable, false);
assert.equal(actualAdminPublishable(bound, "https://gaorui.cc.evil.invalid/v1").publishable, false);
assert.equal(actualAdminPublishable(bound, "https://gaorui.cc/v1", false).publishable, false);

console.log("workspace model assignment and status contract passed");
