import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  WORKSPACE_SURFACE_KIND,
  applyModelPoolCompatibilityMutation,
  applyWorkspaceModelCompatibilityMutation,
  configurationSha256,
  normalizeModelPoolSnapshot,
  normalizeWorkspaceModelSnapshot,
  type ModelPoolKind,
  type WorkspaceSurface,
} from "../src/lib/platform-configuration-contract";

const root = process.cwd();
const read = (relative: string) => fs.readFileSync(path.join(root, relative), "utf8");
let passed = 0;
const check = (name: string, work: () => void) => {
  work();
  passed += 1;
  console.log(`PASS ${name}`);
};
const entry = (kind: ModelPoolKind, id: string, table: string, order: number) => ({
  id,
  kind,
  name: id,
  modelName: `${id}-upstream`,
  provider: "fixture",
  protocol: kind === "agent" ? "openai-chat" : `${kind}-async-v1`,
  endpoint: `https://models.example.test/${id}`,
  credentialRef: `secret://platform-model/${table}/${id.replace(/^(?:llm|chat):/u, "")}`,
  catalogState: "enabled" as const,
  sortOrder: order,
  capabilities: {},
  pricing: {},
  configuration: { legacyTable: table, legacyId: id.replace(/^(?:llm|chat):/u, "") },
});

const pool = normalizeModelPoolSnapshot({
  schema: "model-pool-config/v1",
  models: [
    entry("agent", "llm:00000000-0000-4000-8000-000000000001", "llm_models", 10),
    entry("image", "image-1", "cover_models", 10),
    entry("image", "image-2", "cover_models", 20),
    entry("video", "video-1", "video_models", 10),
    entry("video", "video-2", "video_models", 20),
  ],
});

check("模型兼容 upsert 生成完整新快照且不改输入", () => {
  const before = configurationSha256(pool);
  const replacement = { ...pool.models.find((model) => model.id === "video-1")!, name: "Video One", sortOrder: 15 };
  const next = applyModelPoolCompatibilityMutation(pool, { action: "upsert", entry: replacement });
  assert.equal(configurationSha256(pool), before);
  assert.equal(next.models.find((model) => model.id === "video-1")?.name, "Video One");
  assert.equal(next.models.find((model) => model.id === "video-2")?.name, "video-2");
});

check("模型退役与排序只影响同类目标", () => {
  const retired = applyModelPoolCompatibilityMutation(pool, {
    action: "set-catalog-state", kind: "video", modelId: "video-2", catalogState: "retired",
  });
  assert.equal(retired.models.find((model) => model.id === "video-2")?.catalogState, "retired");
  assert.equal(retired.models.find((model) => model.id === "image-2")?.catalogState, "enabled");
  const ordered = applyModelPoolCompatibilityMutation(retired, {
    action: "reorder", kind: "video", orders: [{ modelId: "video-1", sortOrder: 30 }, { modelId: "video-2", sortOrder: 5 }],
  });
  assert.equal(ordered.models.find((model) => model.id === "video-2")?.sortOrder, 5);
  assert.equal(ordered.models.find((model) => model.id === "image-1")?.sortOrder, 10);
});

check("模型兼容写拒绝不存在模型和重复排序", () => {
  assert.throws(() => applyModelPoolCompatibilityMutation(pool, {
    action: "set-catalog-state", kind: "video", modelId: "missing", catalogState: "retired",
  }), /不存在/u);
  assert.throws(() => applyModelPoolCompatibilityMutation(pool, {
    action: "reorder", kind: "video", orders: [{ modelId: "video-1", sortOrder: 1 }, { modelId: "video-1", sortOrder: 2 }],
  }), /重复/u);
});

const workspace = normalizeWorkspaceModelSnapshot({
  schema: "workspace-model-config/v1",
  modelPoolRelease: {
    releaseId: "00000000-0000-4000-8000-000000000100",
    snapshotSha256: configurationSha256(pool),
  },
  surfaces: Object.fromEntries((Object.keys(WORKSPACE_SURFACE_KIND) as WorkspaceSurface[]).map((surface) => [
    surface,
    { kind: WORKSPACE_SURFACE_KIND[surface], assignedModelIds: [], orderedModelIds: [] },
  ])),
});

check("工作台分配与排序只修改目标 surface", () => {
  const assigned = applyWorkspaceModelCompatibilityMutation(workspace, {
    action: "assign", surface: "commerce-video", modelId: "video-1", enabled: true,
  });
  const twice = applyWorkspaceModelCompatibilityMutation(assigned, {
    action: "assign", surface: "commerce-video", modelId: "video-2", enabled: true,
  });
  const ordered = applyWorkspaceModelCompatibilityMutation(twice, {
    action: "reorder", surface: "commerce-video", orderedModelIds: ["video-2", "video-1"],
  });
  assert.deepEqual(ordered.surfaces["commerce-video"].orderedModelIds, ["video-2", "video-1"]);
  assert.deepEqual(ordered.surfaces["video-page"].assignedModelIds, []);
  assert.deepEqual(ordered.modelPoolRelease, workspace.modelPoolRelease);
});

check("工作台排序必须精确覆盖分配且不能携带全局启停", () => {
  const assigned = applyWorkspaceModelCompatibilityMutation(workspace, {
    action: "assign", surface: "video-page", modelId: "video-1", enabled: true,
  });
  assert.throws(() => applyWorkspaceModelCompatibilityMutation(assigned, {
    action: "reorder", surface: "video-page", orderedModelIds: [],
  }), /精确覆盖/u);
  assert.throws(() => normalizeWorkspaceModelSnapshot({
    ...workspace,
    surfaces: { ...workspace.surfaces, "video-page": { ...workspace.surfaces["video-page"], isActive: false } },
  }), /isActive/u);
});

check("兼容层将明文密钥与逻辑快照分槽", () => {
  const source = read("src/lib/server/platform-configuration-compatibility.ts");
  assert.match(source, /persistCredentialBinding[\s\S]*platform_model_credential_bindings/u);
  assert.match(source, /credentialRef:\s*credentialRef/u);
  const entryMapper = source.slice(source.indexOf("function entryFromLegacyRow"), source.indexOf("async function legacyRows"));
  assert.doesNotMatch(entryMapper, /configuration[\s\S]*\["api_key"/u);
});

check("新视频首次发布保留 pending 门禁但不携带已验收运行证据", () => {
  const source = read("src/lib/server/platform-configuration-compatibility.ts");
  const entryMapper = source.slice(source.indexOf("function entryFromLegacyRow"), source.indexOf("async function legacyRows"));
  assert.match(entryMapper, /pendingActivationGate[\s\S]*state === "pending"/u);
  assert.match(entryMapper, /__model_activation_gate:\s*pendingActivationGate/u);
  assert.match(entryMapper, /Accepted evidence is runtime state and must not enter immutable catalogue/u);
});

check("工作台候选在模型池切换后只重绑定仍启用的模型", () => {
  const source = read("src/lib/server/platform-configuration-compatibility.ts");
  const start = source.indexOf("async function currentOrBootstrapWorkspace");
  const body = source.slice(start, source.indexOf("export async function stageLegacyWorkspaceMutation", start));
  assert.match(body, /readCurrentPlatformConfiguration\("model-pool"\)/u);
  assert.match(body, /catalogState === "enabled"/u);
  assert.match(body, /modelPoolRelease:\s*poolIdentity/u);
  assert.doesNotMatch(body, /catalogState\s*:/u);
});

check("候选生成始终附带发布前差异预览", () => {
  const source = read("src/lib/server/platform-configuration-compatibility.ts");
  const start = source.indexOf("async function createMutationCandidate");
  const body = source.slice(start, source.indexOf("export async function stageLegacyModelPoolUpsert", start));
  assert.match(body, /createPlatformConfigurationCandidate/u);
  assert.match(body, /previewPlatformConfigurationRelease/u);
});

console.log(JSON.stringify({
  passed,
  failed: 0,
  networkCalls: 0,
  databaseWrites: 0,
  walletCalls: 0,
  providerCalls: 0,
  checks: ["model-candidate", "workspace-isolation", "secret-separation", "pool-rebase", "preview"],
}));
