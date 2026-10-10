import assert from "node:assert/strict";
import fs from "node:fs";

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
assert.match(adminPage, /editOriginalAgentRef\.current = agent; setEditingAgent\(agent\)/u, "AGENT_EDIT_BASELINE_REQUIRED");
assert.doesNotMatch(adminPage, /JSON\.stringify\(\{ agentId: id, \.\.\.rest/u, "WHOLE_AGENT_PAYLOAD_FORBIDDEN");

assert.match(agentsRoute, /\.select\('id,category,user_access,avatar,cover_url,config_revision'\)/u, "CURRENT_AGENT_MEDIA_AND_REVISION_READ_REQUIRED");
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

assert.match(
  modelCompatibility,
  /applyModelPoolCompatibilityMutation\(await currentModelPoolWithLiveBindings\(\), mutation\)/u,
  "MODEL_ORDER_MUST_RECONCILE_LIVE_BINDINGS",
);
assert.match(
  modelCompatibility,
  /applyModelPoolCompatibilityMutation\(await currentModelPoolWithLiveBindings\(\), \{ action: "upsert", entry \}\)/u,
  "MODEL_UPSERT_MUST_RECONCILE_LIVE_BINDINGS",
);
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

console.log(JSON.stringify({
  passed: true,
  networkCalls: 0,
  contracts: [
    "agent model changes submit only changed allowlisted fields",
    "unchanged legacy media does not block model binding saves",
    "model ordering is local until explicit save",
    "explicit save validates, previews, publishes, and reads back",
    "all model mutations refresh live bindings without expanding release membership",
    "all model mutations preserve current credential ownership",
    "fractional deep-thinking deductions survive model-pool publication",
    "endpoint trailing-slash canonicalization does not revoke validation",
  ],
}, null, 2));
