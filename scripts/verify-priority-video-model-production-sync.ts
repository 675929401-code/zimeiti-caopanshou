import assert from "node:assert/strict";

import {
  EXISTING_PRICE_IDS,
  NEW_MODEL_IDS,
  VEO_COMPONENTS_ID,
  type VideoModelRecord,
} from "./configure-priority-video-models-local";
import { selectPriorityVideoProductionTargets } from "./configure-priority-video-models-target";

function row(id: string): VideoModelRecord {
  return {
    id,
    name: id,
    model_name: id,
    provider: "fixture",
    protocol_type: "fixture",
    api_endpoint: "https://fixture.invalid/v1",
    api_key: `secret://fixture-${id}`,
    price_per_use: 1,
    cost_price: 0.8,
    is_active: true,
    is_hidden: false,
    api_protocol_config: {
      __model_activation_gate: { state: "evidence_ready", marker: id },
    },
  };
}

const before = [
  ...EXISTING_PRICE_IDS.map(row),
  row(VEO_COMPONENTS_ID),
  row("unrelated-model"),
];

const safe = selectPriorityVideoProductionTargets(before, false);
assert.deepEqual(safe.targets.map((entry) => entry.id).sort(), [...NEW_MODEL_IDS, ...EXISTING_PRICE_IDS].sort());
assert.equal(safe.targets.some((entry) => entry.id === VEO_COMPONENTS_ID), false);
assert.equal(safe.plan.after.find((entry) => entry.id === "unrelated-model")?.name, "unrelated-model");
for (const id of NEW_MODEL_IDS) {
  const target = safe.targets.find((entry) => entry.id === id);
  assert.ok(target);
  assert.equal(target.is_active, false);
  assert.equal(target.is_hidden, true);
  assert.match(String(target.api_key), /^secret:\/\//u);
}

const withVeo = selectPriorityVideoProductionTargets(before, true);
assert.equal(withVeo.targets.some((entry) => entry.id === VEO_COMPONENTS_ID), true);
assert.equal(withVeo.targets.find((entry) => entry.id === VEO_COMPONENTS_ID)?.is_active, false);
assert.equal(withVeo.targets.find((entry) => entry.id === VEO_COMPONENTS_ID)?.is_hidden, true);

process.stdout.write(`${JSON.stringify({
  passed: true,
  defaultTargetCount: safe.targets.length,
  veoTierUpdateOptIn: true,
  databaseWrites: 0,
  providerRequests: 0,
  paidGenerationCalls: 0,
})}\n`);
