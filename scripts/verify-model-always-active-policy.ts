import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { evaluateVideoChannelCircuit } from "../src/lib/video-channel-health-circuit";
import { modelRetirementPatch } from "../src/lib/model-retirement";

const source = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const unified = source("src/app/api/admin/models/route.ts");
const videos = source("src/app/api/admin/video-models/route.ts");
const covers = source("src/app/api/admin/cover-models/route.ts");
const coverItem = source("src/app/api/admin/cover-models/[id]/route.ts");
const quickAdd = source("src/app/api/admin/video-models/quick-add/route.ts");
const resourceUi = source("src/components/unified-models-tab.tsx");
const publicCatalog = source("src/app/api/video/models/route.ts");
const submit = source("src/app/api/video/generate/route.ts");
const legacyChatApi = source("src/app/api/admin/chat-models/route.ts");
const legacyChatUi = source("src/components/chat-models-tab.tsx");
const unifiedDialog = source("src/components/unified-model-dialog.tsx");
const videoDialog = source("src/components/video-model-dialog.tsx");
const invariantMigration = source("supabase/migrations/20260923183000_model_resource_visibility_invariant.sql");

assert.match(unified, /user_access: "available"[\s\S]*is_active: true[\s\S]*is_hidden: false/u);
assert.ok((unified.match(/updateFields\.is_active = true/gu) || []).length >= 2);
assert.ok((unified.match(/updateFields\.is_hidden = false/gu) || []).length >= 2);
assert.match(videos, /is_active: true,[\s\S]*is_hidden: false/u);
assert.match(videos, /updates\.is_active = true;[\s\S]*updates\.is_hidden = false/u);
assert.match(covers, /is_active: true,[\s\S]*is_hidden: false/u);
assert.match(coverItem, /pendingFields\.is_active = true;[\s\S]*pendingFields\.is_hidden = false/u);
assert.match(quickAdd, /is_active: true,[\s\S]*is_hidden: false/u);
assert.doesNotMatch(resourceUi, />暂停生成</u);
assert.doesNotMatch(resourceUi, />启用生成</u);
assert.doesNotMatch(resourceUi, />隐藏</u);
assert.doesNotMatch(resourceUi, />显示模型</u);
assert.doesNotMatch(legacyChatUi, /handleToggleActive|停用|type="checkbox"[\s\S]{0,100}formData\.is_active/u);
assert.doesNotMatch(unifiedDialog, /checked=\{form\.is_active\}/u);
assert.doesNotMatch(videoDialog, /checked=\{form\.is_active\}/u);
assert.match(legacyChatApi, /is_active: true/u);
assert.match(legacyChatApi, /updateData\.is_active = true/u);
for (const table of ["cover_models", "llm_models", "video_models"]) {
  assert.match(invariantMigration, new RegExp(`BEFORE INSERT OR UPDATE ON public\\.${table}`, "u"));
}
assert.match(invariantMigration, /provider IS DISTINCT FROM 'retired_configuration'/u);

assert.equal(evaluateVideoChannelCircuit(null).blocksProduction, false);
assert.equal(evaluateVideoChannelCircuit({
  channel_id: "prepared",
  is_healthy: false,
  consecutive_failures: 0,
  total_requests: 0,
  success_count: 0,
  fail_count: 0,
  timeout_count: 0,
  last_success_at: null,
  last_fail_at: null,
  last_error: null,
  updated_at: new Date().toISOString(),
}).blocksProduction, false);
assert.equal(evaluateVideoChannelCircuit({
  channel_id: "failed",
  is_healthy: false,
  consecutive_failures: 2,
  total_requests: 2,
  success_count: 0,
  fail_count: 2,
  timeout_count: 0,
  last_fail_at: new Date().toISOString(),
  last_error: "HTTP 401 unauthorized",
  updated_at: new Date().toISOString(),
}).blocksProduction, true);
assert.doesNotMatch(submit, /CHANNEL_HEALTH_UNVERIFIED/u);
assert.match(publicCatalog, /configuredForSubmission[\s\S]*m\.is_active === true && configuredForSubmission && priceReady/u);

assert.deepEqual(
  { active: modelRetirementPatch("video").is_active, hidden: modelRetirementPatch("video").is_hidden },
  { active: false, hidden: true },
);

console.log("model always-active policy contract passed");
