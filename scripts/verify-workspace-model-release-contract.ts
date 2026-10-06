import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  WORKSPACE_SURFACE_KIND,
  buildPlatformConfigurationPreview,
  configurationSha256,
  diffWorkspaceModelSnapshots,
  normalizeModelPoolSnapshot,
  normalizeWorkspaceModelSnapshot,
  validateWorkspaceModelSnapshot,
  type WorkspaceModelSnapshot,
} from "../src/lib/platform-configuration-contract";

const root = process.cwd();
const read = (relative: string) => fs.readFileSync(path.join(root, relative), "utf8");
let passed = 0;
const check = (name: string, work: () => void) => {
  work();
  passed += 1;
  console.log(`PASS ${name}`);
};

const modelPool = normalizeModelPoolSnapshot({
  schema: "model-pool-config/v1",
  models: [
    { id: "agent-1", kind: "agent", name: "Agent", modelName: "agent-upstream", provider: "fixture", protocol: "openai-chat", endpoint: "https://models.example.test/agent", credentialRef: "env://AGENT_KEY", catalogState: "enabled", sortOrder: 1, capabilities: {}, pricing: { amount: 1 }, configuration: {} },
    { id: "image-1", kind: "image", name: "Image", modelName: "image-upstream", provider: "fixture", protocol: "image-async-v1", endpoint: "https://models.example.test/image", credentialRef: "env://IMAGE_KEY", catalogState: "enabled", sortOrder: 1, capabilities: {}, pricing: { amount: 1 }, configuration: {} },
    { id: "image-retired", kind: "image", name: "Retired", modelName: "retired", provider: "fixture", protocol: "image-async-v1", endpoint: "https://models.example.test/image-retired", credentialRef: "env://IMAGE_KEY", catalogState: "retired", sortOrder: 2, capabilities: {}, pricing: {}, configuration: {} },
    { id: "video-1", kind: "video", name: "Video", modelName: "video-upstream", provider: "fixture", protocol: "video-async-v1", endpoint: "https://models.example.test/video", credentialRef: "env://VIDEO_KEY", catalogState: "enabled", sortOrder: 1, capabilities: {}, pricing: { amount: 1 }, configuration: {} },
  ],
});
const poolRelease = {
  releaseId: "00000000-0000-4000-8000-000000000101",
  snapshotSha256: configurationSha256(modelPool),
};

function rawWorkspace(overrides: Partial<Record<keyof typeof WORKSPACE_SURFACE_KIND, Record<string, unknown>>> = {}) {
  return {
    schema: "workspace-model-config/v1",
    modelPoolRelease: poolRelease,
    surfaces: Object.fromEntries(Object.entries(WORKSPACE_SURFACE_KIND).map(([surface, kind]) => {
      const id = kind === "image" ? "image-1" : "video-1";
      return [surface, { kind, assignedModelIds: [id], orderedModelIds: [id], ...(overrides[surface as keyof typeof WORKSPACE_SURFACE_KIND] || {}) }];
    })),
  };
}

const baseline = normalizeWorkspaceModelSnapshot(rawWorkspace());

check("十个工作台表面均固定归属 image 或 video", () => {
  assert.equal(Object.keys(baseline.surfaces).length, Object.keys(WORKSPACE_SURFACE_KIND).length);
  for (const [surface, kind] of Object.entries(WORKSPACE_SURFACE_KIND)) assert.equal(baseline.surfaces[surface as keyof typeof WORKSPACE_SURFACE_KIND].kind, kind);
});

check("工作台引用精确模型池 releaseId 与 snapshotSha256", () => {
  assert.deepEqual(baseline.modelPoolRelease, poolRelease);
  assert.equal(validateWorkspaceModelSnapshot(baseline, modelPool).ok, true);
});

check("工作台结构不接受 catalogState 或全局启停字段", () => {
  assert.throws(() => normalizeWorkspaceModelSnapshot(rawWorkspace({ "commerce-video": { catalogState: "retired" } })), /未知字段 catalogState/u);
  assert.throws(() => normalizeWorkspaceModelSnapshot(rawWorkspace({ "commerce-video": { isActive: false } })), /未知字段 isActive/u);
});

check("工作台不能把 image 模型分配到 video 表面", () => {
  const invalid = normalizeWorkspaceModelSnapshot(rawWorkspace({ "commerce-video": { assignedModelIds: ["image-1"], orderedModelIds: ["image-1"] } }));
  const validation = validateWorkspaceModelSnapshot(invalid, modelPool);
  assert.equal(validation.ok, false);
  assert.ok(validation.issues.some((issue) => issue.includes("不存在或类型不匹配")));
});

check("工作台不能引用全局已退役模型", () => {
  const invalid = normalizeWorkspaceModelSnapshot(rawWorkspace({ "image-workbench": { assignedModelIds: ["image-retired"], orderedModelIds: ["image-retired"] } }));
  assert.ok(validateWorkspaceModelSnapshot(invalid, modelPool).issues.some((issue) => issue.includes("已退役模型")));
});

check("排序只能引用已分配模型", () => {
  assert.throws(() => normalizeWorkspaceModelSnapshot(rawWorkspace({ "video-page": { orderedModelIds: ["video-1", "video-2"] } })), /只能引用已分配模型/u);
});

check("空工作台分配在确定性校验中失败", () => {
  const invalid = normalizeWorkspaceModelSnapshot(rawWorkspace({ "cover-studio": { assignedModelIds: [], orderedModelIds: [] } }));
  assert.ok(validateWorkspaceModelSnapshot(invalid, modelPool).issues.includes("cover-studio 没有分配模型"));
});

check("模型池身份不一致时工作台校验失败", () => {
  const invalid = normalizeWorkspaceModelSnapshot({ ...rawWorkspace(), modelPoolRelease: { ...poolRelease, snapshotSha256: "a".repeat(64) } });
  assert.ok(validateWorkspaceModelSnapshot(invalid, modelPool).issues.includes("工作台引用的模型池哈希与实际快照不一致"));
});

check("工作台差异独立表达分配、顺序和模型池版本变化", () => {
  const after = normalizeWorkspaceModelSnapshot({
    ...rawWorkspace({ "commerce-video": { assignedModelIds: ["video-1", "video-2"], orderedModelIds: ["video-2", "video-1"] } }),
    modelPoolRelease: { releaseId: "00000000-0000-4000-8000-000000000102", snapshotSha256: "b".repeat(64) },
  });
  const diff = diffWorkspaceModelSnapshots(baseline, after);
  const commerce = diff.surfaces.find((entry) => entry.surface === "commerce-video");
  assert.equal(diff.modelPoolRelease.changed, true);
  assert.deepEqual(commerce?.assignments.added, ["video-2"]);
  assert.equal(commerce?.orderChanged, true);
  assert.equal(diff.changed, true);
});

check("工作台发布预览哈希对 current/candidate 身份稳定", () => {
  const current = { releaseId: "00000000-0000-4000-8000-000000000201", releaseVersion: 1, snapshotSha256: configurationSha256(baseline), status: "published" };
  const candidate = { releaseId: "00000000-0000-4000-8000-000000000202", releaseVersion: 2, snapshotSha256: configurationSha256(baseline), status: "validated" };
  const preview = buildPlatformConfigurationPreview({ kind: "workspace-models", current: { identity: current, snapshot: baseline }, candidate: { identity: candidate, snapshot: baseline } });
  assert.equal(preview.previewSha256.length, 64);
  assert.equal(preview.previewSha256, buildPlatformConfigurationPreview({ kind: "workspace-models", current: { identity: current, snapshot: baseline }, candidate: { identity: candidate, snapshot: baseline } }).previewSha256);
});

const migration = read("supabase/migrations/20260925054500_platform_configuration_versioning.sql");
const server = read("src/lib/server/platform-configuration-admin.ts");
const api = read("src/app/api/admin/workspace-model-releases/route.ts");

check("模型池和工作台使用独立不可变版本表", () => {
  assert.match(migration, /model_pool_config_releases/u);
  assert.match(migration, /workspace_model_config_releases/u);
  assert.match(migration, /workspace_model_config_one_current[\s\S]*WHERE is_current = true/u);
});

check("数据库原子发布在同一事务锁定当前模型池依赖", () => {
  assert.match(migration, /p_kind = 'workspace-models'[\s\S]*platform-configuration-publish:model-pool/u);
  assert.match(migration, /v_workspace_candidate\.snapshot #>> '\{modelPoolRelease,releaseId\}'[\s\S]*v_model_current\.id::text/u);
  assert.match(migration, /v_workspace_candidate\.snapshot #>> '\{modelPoolRelease,snapshotSha256\}'[\s\S]*v_model_current\.snapshot_sha256/u);
  assert.match(migration, /WORKSPACE_MODEL_POOL_NOT_CURRENT/u);
});

check("工作台发布前后均核对模型池与发布读回", () => {
  assert.match(server, /assertWorkspaceDependencyIsCurrent/u);
  assert.match(server, /WORKSPACE_MODEL_POOL_NOT_CURRENT/u);
  assert.match(server, /PLATFORM_CONFIGURATION_PUBLISH_READBACK_MISMATCH/u);
  assert.match(api, /body\.previewSha256/u);
});

check("rollback 只复制历史快照为新候选", () => {
  const rollbackStart = server.indexOf("export async function createPlatformConfigurationRollbackCandidate");
  const readStart = server.indexOf("export async function readCurrentPlatformConfiguration", rollbackStart);
  const body = server.slice(rollbackStart, readStart);
  assert.match(body, /createCandidateRow/u);
  assert.doesNotMatch(body, /publish_platform_configuration_release_atomic/u);
  assert.match(body, /rollbackTargetId: targetId/u);
  assert.match(migration, /v_workspace_target[\s\S]*is_current = false/u);
  assert.match(migration, /v_workspace_target\.snapshot IS DISTINCT FROM p_snapshot/u);
});

console.log(JSON.stringify({
  passed,
  failed: 0,
  networkCalls: 0,
  databaseWrites: 0,
  walletCalls: 0,
  providerCalls: 0,
  checks: ["workspace-isolation", "pool-reference", "assignment-validation", "diff-preview", "dependency-lock", "rollback-candidate-only"],
}));
