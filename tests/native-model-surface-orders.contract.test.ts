import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
const original = readFileSync(new URL("../supabase/migrations/20260925054500_platform_configuration_versioning.sql", import.meta.url), "utf8");
const forward = readFileSync(new URL("../supabase/migrations/20261110140000_native_model_surface_orders.sql", import.meta.url), "utf8");
const rollback = readFileSync(new URL("../supabase/rollbacks/20261110140000_native_model_surface_orders.rollback.sql", import.meta.url), "utf8");
test("the ten original order expressions are byte-identical in forward and rollback", () => {
  const expression = /    '[^']+', public\.platform_configuration_order_map\(p_snapshot #> '\{surfaces,[^}]+,orderedModelIds\}'\)/gu;
  const lines = original.match(expression)!;
  assert.equal(lines.length, 10);
  for (const line of lines) { assert(forward.includes(line)); assert(rollback.includes(line)); }
});
test("new native order keys are conditional and immutable releases are not rewritten", () => {
  for (const scene of ["publish-center-image", "publish-center-video"]) assert(forward.includes(`IF (p_snapshot->'surfaces') ? '${scene}' THEN`));
  assert(!/UPDATE public\.(workspace_model_config_releases|model_pool_config_releases)/u.test(forward));
  assert.match(rollback, /NATIVE_MODEL_SURFACE_ROLLBACK_REQUIRES_FORWARD_REPAIR/u);
  assert(!/\bCASCADE\s*;/iu.test(rollback));
});
