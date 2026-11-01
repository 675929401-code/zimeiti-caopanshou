import assert from "node:assert/strict";
import fs from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";

import { applyModelPoolCompatibilityMutation, type ModelPoolEntry, type ModelPoolSnapshot } from "../src/lib/platform-configuration-contract";

const adminPage = fs.readFileSync("src/app/admin/page.tsx", "utf8");
const agentsRoute = fs.readFileSync("src/app/api/admin/agents/route.ts", "utf8");
const modelPool = fs.readFileSync("src/components/unified-models-tab.tsx", "utf8");
const modelCompatibility = fs.readFileSync("src/lib/server/platform-configuration-compatibility.ts", "utf8");
const fractionalProjectionMigration = fs.readFileSync(
  "supabase/migrations/20261006013000_llm_fractional_deep_think_projection.sql",
  "utf8",
);
const endpointProjectionMigration = fs.readFileSync(
  "supabase/migrations/20261006014500_llm_endpoint_normalized_activation_projection.sql",
  "utf8",
);

assert.match(adminPage, /const AGENT_EDITABLE_FIELDS = \[/u, "AGENT_UPDATE_ALLOWLIST_REQUIRED");
assert.match(adminPage, /buildAgentUpdatePayload\(editingAgent, originalAgent, canEditPrompts\)/u, "AGENT_DIFF_PAYLOAD_REQUIRED");
assert.match(adminPage, /editOriginalAgentRef\.current = structuredClone\(agent\)/u, "AGENT_EDIT_BASELINE_REQUIRED");
assert.match(adminPage, /setEditingAgentState\(structuredClone\(agent\)\)/u, "AGENT_EDIT_DRAFT_MUST_NOT_ALIAS_BASELINE");
assert.doesNotMatch(adminPage, /JSON\.stringify\(\{ agentId: id, \.\.\.rest/u, "WHOLE_AGENT_PAYLOAD_FORBIDDEN");

assert.match(agentsRoute, /\.select\('id,category,user_access,avatar,cover_url,config_revision(?:,[^']+)?'\)/u, "CURRENT_AGENT_MEDIA_AND_REVISION_READ_REQUIRED");
assert.match(agentsRoute, /updateData\.cover_url !== currentAgent\.cover_url/u, "UNCHANGED_COVER_MUST_NOT_REVALIDATE");
assert.match(agentsRoute, /updateData\.avatar !== currentAgent\.avatar/u, "UNCHANGED_AVATAR_MUST_NOT_REVALIDATE");
assert.match(agentsRoute, /updateData\.category !== currentAgent\.category/u, "UNCHANGED_CATEGORY_MUST_NOT_REORDER");

const reorderStart = modelPool.indexOf("const handleDragReorder");
const reorderEnd = modelPool.indexOf("const discardPendingOrder", reorderStart);
assert.ok(reorderStart >= 0 && reorderEnd > reorderStart, "LOCAL_REORDER_HANDLER_REQUIRED");
const reorderHandler = modelPool.slice(reorderStart, reorderEnd);
assert.doesNotMatch(reorderHandler, /fetch\(/u, "REORDER_MUST_REMAIN_LOCAL_UNTIL_EXPLICIT_SAVE");
assert.match(reorderHandler, /setOrderSaveState\("dirty"\)/u, "REORDER_DIRTY_STATE_REQUIRED");

assert.match(modelPool, /data-testid="save-model-order"/u, "MODEL_ORDER_SAVE_BUTTON_REQUIRED");
assert.match(modelPool, /action: "validate", releaseId/u, "MODEL_ORDER_VALIDATE_REQUIRED");
assert.match(modelPool, /previewReleaseId=/u, "MODEL_ORDER_PREVIEW_REQUIRED");
assert.match(modelPool, /action: "publish", releaseId, previewSha256/u, "MODEL_ORDER_PUBLISH_REQUIRED");
assert.match(modelPool, /排序发布后的数据库读回不一致/u, "MODEL_ORDER_READBACK_REQUIRED");

const modelOrderStart = modelCompatibility.indexOf("export async function stageLegacyModelPoolOrder(");
const modelOrderEnd = modelCompatibility.indexOf("function orderedAssigned(", modelOrderStart);
assert.ok(modelOrderStart >= 0 && modelOrderEnd > modelOrderStart, "MODEL_ORDER_HANDLER_REQUIRED");
assert.match(
  modelCompatibility.slice(modelOrderStart, modelOrderEnd),
  /applyModelPoolCompatibilityMutation\(await currentModelPoolWithLiveBindings\(\), mutation\)/u,
  "MODEL_ORDER_MUST_RECONCILE_LIVE_BINDINGS",
);
const upsertStart = modelCompatibility.indexOf("export async function stageLegacyModelPoolUpsert(");
const upsertEnd = modelCompatibility.indexOf("export async function stageLegacyModelPoolCatalogState(", upsertStart);
assert.ok(upsertStart >= 0 && upsertEnd > upsertStart, "MODEL_UPSERT_HANDLER_REQUIRED");
const upsertHandler = modelCompatibility.slice(upsertStart, upsertEnd);
assert.match(upsertHandler, /const videoBase = input\.table === "video_models" \? await readCurrentPlatformConfiguration\("model-pool"\) : null/u, "VIDEO_UPSERT_MUST_READ_IMMUTABLE_CURRENT_BASE");
assert.match(upsertHandler, /input\.table === "video_models" && !videoBase[\s\S]*MODEL_POOL_CURRENT_RELEASE_REQUIRED/u, "VIDEO_UPSERT_REQUIRES_PUBLISHED_BASE");
assert.match(upsertHandler, /applyModelPoolCompatibilityMutation\(videoBase \? videoBase\.snapshot : await currentModelPoolWithLiveBindings\(\), \{ action: "upsert", entry \}\)/u, "NONVIDEO_UPSERT_MUST_RECONCILE_LIVE_BINDINGS");
assert.match(upsertHandler, /expectedBase: \{ releaseId: string\(videoBase\.release\.id\), snapshotSha256: string\(videoBase\.release\.snapshot_sha256\) \}/u, "VIDEO_UPSERT_MUST_BIND_RELEASE_AND_SNAPSHOT");

// Execute the actual snapshot-selection and credential-preservation block in
// RAM. Its persistence dependencies only capture arguments; none loads a DB client.
const snapshotStart = upsertHandler.indexOf("  const videoBase =");
const snapshotEnd = upsertHandler.indexOf("  try { const preview =", snapshotStart);
assert.ok(snapshotStart >= 0 && snapshotEnd > snapshotStart, "MODEL_UPSERT_SNAPSHOT_BLOCK_REQUIRED");
const snapshotProgram = ts.transpileModule(
  `module.exports = async function(input, entry, credentialChanges) { ${upsertHandler.slice(snapshotStart, snapshotEnd)} return release; };`,
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
).outputText;
const fixtureEntry = (id: string, kind: ModelPoolEntry["kind"], endpoint: string, credentialRef?: string): ModelPoolEntry => ({
  id, kind, endpoint, ...(credentialRef ? { credentialRef } : {}), name: id, modelName: id,
  provider: "fixture", protocol: "fixture", catalogState: "enabled", sortOrder: 0,
  capabilities: {}, pricing: {}, configuration: {},
});
const withoutCredential = (entry: ModelPoolEntry): ModelPoolEntry => {
  const unbound = { ...entry };
  delete unbound.credentialRef;
  return unbound;
};
const unchangedAgent = fixtureEntry("agent-fixture", "agent", "https://published.invalid/v1", "secret://fixture/published-agent");
const publishedSnapshot: ModelPoolSnapshot = { schema: "model-pool-config/v1", models: [
  fixtureEntry("video-fixture", "video", "https://published.invalid/video", "secret://fixture/current-video"), unchangedAgent,
] };
const liveSnapshot: ModelPoolSnapshot = { ...publishedSnapshot, models: publishedSnapshot.models.map(entry =>
  entry.kind === "agent" ? { ...entry, endpoint: "https://live-drift.invalid/v1" } : entry) };
type StagedFixture = { snapshot: ModelPoolSnapshot; credentialChanges: unknown[]; expectedBase?: { releaseId: string; snapshotSha256: string } };
async function verifyUpsertSnapshot(table: string, options: { noCurrent?: boolean; unbound?: boolean; newCredential?: boolean } = {}) {
  let liveReads = 0;
  const fixtureModule = { exports: undefined as unknown as (input: object, entry: ModelPoolEntry, credentials: unknown[]) => Promise<StagedFixture> };
  runInNewContext(snapshotProgram, {
    module: fixtureModule, applyModelPoolCompatibilityMutation,
    string: (value: unknown) => String(value ?? "").trim(), PlatformConfigurationError: Error,
    readCurrentPlatformConfiguration: async () => options.noCurrent ? null : ({
      snapshot: options.unbound ? { ...publishedSnapshot, models: publishedSnapshot.models.map(withoutCredential) } : publishedSnapshot,
      release: { id: "release-fixture", snapshot_sha256: "a".repeat(64) },
    }),
    currentModelPoolWithLiveBindings: async () => { liveReads++; return liveSnapshot; },
    stagePlatformModelCandidateWithCredentials: async (input: StagedFixture) => input,
  });
  const kind = table === "video_models" ? "video" : table === "cover_models" ? "image" : "agent";
  const entry = fixtureEntry(table === "video_models" ? "video-fixture" : "edited-fixture", kind, "https://edited.invalid/model", "secret://fixture/new-binding");
  const credentials = options.newCredential ? [{ credential_ref: entry.credentialRef }] : [];
  if (options.noCurrent) {
    await assert.rejects(fixtureModule.exports({ table }, entry, credentials), /MODEL_POOL_CURRENT_RELEASE_REQUIRED/u);
    assert.equal(liveReads, 0);
    return;
  }
  const staged = await fixtureModule.exports({ table }, entry, credentials);
  assert.equal(staged.snapshot.models.find(model => model.id === entry.id)?.endpoint, entry.endpoint);
  assert.equal(staged.credentialChanges, credentials);
  if (table === "video_models") {
    assert.equal(liveReads, 0, "VIDEO_UPSERT_MUST_NOT_IMPORT_UNRELATED_LIVE_DRIFT");
    assert.deepEqual(staged.snapshot.models.find(model => model.id === unchangedAgent.id), options.unbound ? withoutCredential(unchangedAgent) : unchangedAgent);
    assert.equal(staged.expectedBase?.releaseId, "release-fixture");
    assert.equal(staged.expectedBase?.snapshotSha256, "a".repeat(64));
    assert.equal(staged.snapshot.models.find(model => model.id === entry.id)?.credentialRef,
      options.newCredential ? "secret://fixture/new-binding" : options.unbound ? undefined : "secret://fixture/current-video");
  } else {
    assert.equal(liveReads, 1, "NONVIDEO_UPSERT_MUST_REFRESH_LIVE_BINDINGS");
    assert.equal(staged.snapshot.models.find(model => model.id === unchangedAgent.id)?.endpoint, "https://live-drift.invalid/v1");
    assert.equal(staged.expectedBase, undefined);
  }
}
assert.match(
  modelCompatibility,
  /export async function stageLegacyModelPoolCatalogState[\s\S]*const snapshot = await currentModelPoolWithLiveBindings\(\)/u,
  "MODEL_CATALOG_STATE_MUST_RECONCILE_LIVE_BINDINGS",
);
assert.match(
  modelCompatibility,
  /current\.snapshot\.models\.map\(\(entry\) =>/u,
  "MODEL_ORDER_MUST_NOT_AUTO_PUBLISH_NEW_PHYSICAL_MODELS",
);
assert.match(
  modelCompatibility,
  /catalogState: entry\.catalogState,[\s\S]*sortOrder: entry\.sortOrder/u,
  "MODEL_ORDER_MUST_PRESERVE_RELEASE_CATALOG_STATE_AND_ORDER",
);
assert.match(
  modelCompatibility,
  /const liveBinding: ModelPoolEntry = \{ \.\.\.liveEntry \};[\s\S]*delete liveBinding\.credentialRef/u,
  "MODEL_ORDER_MUST_NOT_SYNTHESIZE_UNBOUND_CREDENTIAL_REFERENCES",
);
assert.ok(
  fractionalProjectionMigration.includes("deductDeepThink}', '')::numeric"),
  "FRACTIONAL_DEEP_THINK_PROJECTION_REQUIRED",
);
assert.ok(
  !fractionalProjectionMigration.includes("deductDeepThink}', '')::integer"),
  "FRACTIONAL_DEEP_THINK_INTEGER_CAST_FORBIDDEN",
);
assert.equal(
  (endpointProjectionMigration.match(/regexp_replace\(coalesce\([^\n]+\), '\/\+\$', ''\)/gu) || []).length,
  3,
  "ENDPOINT_BINDING_NORMALIZATION_REQUIRED",
);

async function main() {
  await verifyUpsertSnapshot("video_models");
  await verifyUpsertSnapshot("video_models", { unbound: true });
  await verifyUpsertSnapshot("video_models", { newCredential: true });
  await verifyUpsertSnapshot("video_models", { noCurrent: true });
  await verifyUpsertSnapshot("cover_models");
  await verifyUpsertSnapshot("llm_models");

  console.log(JSON.stringify({
    passed: true,
    networkCalls: 0,
    databaseCalls: 0,
    paidCalls: 0,
    actualUpsertSnapshotBlock: true,
    upsertSnapshotCases: 6,
    contracts: [
      "agent model changes submit only changed allowlisted fields",
      "unchanged legacy media does not block model binding saves",
      "model ordering is local until explicit save",
      "explicit save validates, previews, publishes, and reads back",
      "nonvideo upserts and ordering refresh live bindings without expanding release membership",
      "video upserts preserve unrelated published entries and bind the exact base release and snapshot",
      "video upserts preserve current credential references unless new credentials are supplied",
      "all model mutations preserve current credential ownership",
      "fractional deep-thinking deductions survive model-pool publication",
      "endpoint trailing-slash canonicalization does not revoke validation",
    ],
  }, null, 2));
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
