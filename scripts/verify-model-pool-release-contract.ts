import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  buildPlatformConfigurationPreview,
  configurationSha256,
  diffModelPoolSnapshots,
  normalizeModelPoolSnapshot,
  validateModelPoolSnapshot,
  type ModelPoolSnapshot,
} from "../src/lib/platform-configuration-contract";

const root = process.cwd();
const read = (relative: string) => fs.readFileSync(path.join(root, relative), "utf8");
let passed = 0;
const check = (name: string, work: () => void) => {
  work();
  passed += 1;
  console.log(`PASS ${name}`);
};

function rawModel(kind: "agent" | "image" | "video", id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    kind,
    name: `${kind}-${id}`,
    modelName: `${kind}-upstream`,
    provider: "fixture-provider",
    protocol: kind === "agent" ? "openai-chat" : `${kind}-async-v1`,
    endpoint: `https://models.example.test/${kind}`,
    credentialRef: `env://${kind.toUpperCase()}_MODEL_KEY`,
    catalogState: "enabled",
    sortOrder: 10,
    capabilities: { references: kind === "video" ? { image: 9, video: 3, audio: 3 } : {} },
    pricing: { currency: "CNY", unit: "request", amount: 1 },
    configuration: { timeoutMs: 30_000 },
    ...overrides,
  };
}

function snapshot(models?: unknown[]): ModelPoolSnapshot {
  return normalizeModelPoolSnapshot({
    schema: "model-pool-config/v1",
    models: models || [rawModel("video", "video-1"), rawModel("agent", "agent-1"), rawModel("image", "image-1")],
  });
}

const baseline = snapshot();

check("模型池归一化固定排序并规范 endpoint", () => {
  assert.deepEqual(baseline.models.map((entry) => `${entry.kind}:${entry.id}`), ["agent:agent-1", "image:image-1", "video:video-1"]);
  assert.equal(baseline.models[0].endpoint, "https://models.example.test/agent");
});

check("相同逻辑快照不受输入顺序与对象键顺序影响", () => {
  const reordered = snapshot([
    { ...rawModel("image", "image-1"), pricing: { amount: 1, unit: "request", currency: "CNY" } },
    rawModel("video", "video-1"),
    rawModel("agent", "agent-1"),
  ]);
  assert.equal(configurationSha256(reordered), configurationSha256(baseline));
});

check("每类至少一个启用模型时确定性校验通过", () => {
  assert.deepEqual(validateModelPoolSnapshot(baseline), { ok: true, issues: [], warnings: [] });
});

check("缺少模型种类或全退役时校验失败", () => {
  const invalid = snapshot([
    rawModel("agent", "agent-1"),
    rawModel("image", "image-1", { catalogState: "retired" }),
  ]);
  const validation = validateModelPoolSnapshot(invalid);
  assert.equal(validation.ok, false);
  assert.ok(validation.issues.includes("模型池没有启用的 image 模型"));
  assert.ok(validation.issues.includes("模型池缺少 video 模型"));
});

check("差异预览区分新增、移除和内容变化", () => {
  const after = snapshot([
    rawModel("agent", "agent-1", { sortOrder: 20 }),
    rawModel("image", "image-2"),
    rawModel("video", "video-1"),
  ]);
  const diff = diffModelPoolSnapshots(baseline, after);
  assert.deepEqual(diff.models.added, ["image:image-2"]);
  assert.deepEqual(diff.models.removed, ["image:image-1"]);
  assert.deepEqual(diff.models.changed.map((entry) => entry.key), ["agent:agent-1"]);
  assert.equal(diff.changed, true);
});

check("发布预览哈希绑定 current、candidate 和差异", () => {
  const current = { releaseId: "00000000-0000-4000-8000-000000000001", releaseVersion: 1, snapshotSha256: configurationSha256(baseline), status: "published" };
  const candidateSnapshot = snapshot([...baseline.models.map((entry) => ({ ...entry })), rawModel("video", "video-2")]);
  const candidate = { releaseId: "00000000-0000-4000-8000-000000000002", releaseVersion: 2, snapshotSha256: configurationSha256(candidateSnapshot), status: "validated" };
  const first = buildPlatformConfigurationPreview({ kind: "model-pool", current: { identity: current, snapshot: baseline }, candidate: { identity: candidate, snapshot: candidateSnapshot } });
  const second = buildPlatformConfigurationPreview({ kind: "model-pool", current: { identity: current, snapshot: baseline }, candidate: { identity: candidate, snapshot: candidateSnapshot } });
  assert.equal(first.previewSha256, second.previewSha256);
  assert.equal(first.previewSha256.length, 64);
  assert.notEqual(first.previewSha256, buildPlatformConfigurationPreview({ kind: "model-pool", current: null, candidate: { identity: candidate, snapshot: candidateSnapshot } }).previewSha256);
});

check("只允许 env 或 secret 凭据引用", () => {
  assert.equal(snapshot([rawModel("agent", "a"), rawModel("image", "i"), rawModel("video", "v", { credentialRef: "secret://providers/minimax" })]).models[2].credentialRef, "secret://providers/minimax");
  assert.throws(() => snapshot([rawModel("agent", "a"), rawModel("image", "i"), rawModel("video", "v", { credentialRef: "sk-raw-secret" })]), /credentialRef/u);
});

for (const [label, configuration] of [
  ["api_key", { api_key: "raw" }],
  ["providerApiKey", { providerApiKey: "raw" }],
  ["client_secret", { client_secret: "raw" }],
  ["nested credentials", { nested: { credentials: "raw" } }],
] as const) {
  check(`配置快照拒绝明文密钥字段 ${label}`, () => {
    assert.throws(() => snapshot([rawModel("agent", "a"), rawModel("image", "i"), rawModel("video", "v", { configuration })]), /不能保存环境密钥/u);
  });
}

check("endpoint 拒绝内嵌身份、密钥查询和片段", () => {
  const make = (endpoint: string) => snapshot([rawModel("agent", "a"), rawModel("image", "i"), rawModel("video", "v", { endpoint })]);
  assert.throws(() => make(["https://", "user:pass@example.test/video"].join("")), /无内嵌凭据/u);
  assert.throws(() => make("https://example.test/video?x-api-key=raw"), /查询参数中保存密钥/u);
  assert.throws(() => make("https://example.test/video#token=raw"), /片段/u);
});

const migration = read("supabase/migrations/20260925054500_platform_configuration_versioning.sql");
const server = read("src/lib/server/platform-configuration-admin.ts");
const api = read("src/app/api/admin/model-pool-releases/route.ts");

check("迁移建立不可变模型池版本表和唯一 current", () => {
  assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.model_pool_config_releases/u);
  assert.match(migration, /model_pool_config_one_current[\s\S]*WHERE is_current = true/u);
  assert.match(migration, /PLATFORM_CONFIGURATION_SNAPSHOT_IMMUTABLE/u);
  assert.match(migration, /BEFORE UPDATE OR DELETE[\s\S]*reject_platform_configuration_release_mutation/u);
});

check("候选创建和发布均通过数据库原子函数", () => {
  assert.match(migration, /create_platform_configuration_candidate_atomic/u);
  assert.match(migration, /publish_platform_configuration_release_atomic/u);
  assert.match(migration, /pg_advisory_xact_lock/u);
  assert.match(migration, /PLATFORM_CONFIGURATION_CANDIDATE_CHANGED/u);
  assert.match(migration, /PLATFORM_CONFIGURATION_CURRENT_CHANGED/u);
});

check("数据库只允许从非当前历史版本复制完全相同的回滚候选", () => {
  assert.match(migration, /v_model_target[\s\S]*is_current = false/u);
  assert.match(migration, /v_model_target\.snapshot IS DISTINCT FROM p_snapshot/u);
  assert.match(migration, /v_model_target\.snapshot_sha256 IS DISTINCT FROM p_snapshot_sha256/u);
});

check("发布必须携带差异预览哈希且发布后精确读回", () => {
  assert.match(api, /publishPlatformConfigurationRelease\([\s\S]*body\.previewSha256/u);
  assert.match(server, /PLATFORM_CONFIGURATION_PREVIEW_STALE/u);
  assert.match(server, /publish_platform_configuration_release_atomic/u);
  assert.match(server, /PLATFORM_CONFIGURATION_PUBLISH_READBACK_MISMATCH/u);
});

console.log(JSON.stringify({
  passed,
  failed: 0,
  networkCalls: 0,
  databaseWrites: 0,
  walletCalls: 0,
  providerCalls: 0,
  checks: ["stable-snapshot", "secret-reference-only", "diff-preview-hash", "immutable-candidate", "atomic-publish", "exact-readback"],
}));
