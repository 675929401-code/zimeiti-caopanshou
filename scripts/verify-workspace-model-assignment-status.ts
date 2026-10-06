import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isWorkspaceModelAssigned } from "../src/lib/workspace-model-assignment-settings";

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
assert.ok(route.includes(".filter((model) => model.publishable && !isWorkspaceModelCandidateBlocked"));
assert.ok(route.includes("该模型接口通信异常，修复后才能添加到业务页面"));

assert.equal(component.includes("生成已启用，可加入工作台"), false);

console.log("workspace model assignment and status contract passed");
