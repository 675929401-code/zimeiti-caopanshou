#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

const argument = (name) => process.argv.find((value) => value.startsWith(`${name}=`))?.slice(name.length + 1) || "";
const catalogPath = path.resolve(argument("--catalog"));
const outputPath = path.resolve(argument("--output"));
const billingUnit = argument("--billing-unit");
const excluded = new Set(argument("--exclude-internal-ids").split(",").map((value) => value.trim()).filter(Boolean));
const included = new Set(argument("--include-internal-ids").split(",").map((value) => value.trim()).filter(Boolean));
assert.ok(catalogPath && outputPath, "CATALOG_AND_OUTPUT_REQUIRED");
assert.ok(["per_use", "output_second", "provider_token"].includes(billingUnit), "BILLING_UNIT_REQUIRED");
const evidenceRoot = `${path.resolve(".codex-evidence")}${path.sep}`;
assert.ok(outputPath.startsWith(evidenceRoot), "OUTPUT_MUST_STAY_IN_EVIDENCE_ROOT");
await fs.access(outputPath).then(() => assert.fail("OUTPUT_ALREADY_EXISTS"), () => undefined);

const catalog = JSON.parse(await fs.readFile(catalogPath, "utf8"));
assert.ok(
  ["storyboard-workbench", "video-page"].includes(catalog.scope),
  "SUPPORTED_WORKSPACE_CATALOG_REQUIRED",
);
assert.ok(Array.isArray(catalog.models) && Array.isArray(catalog.public), "CATALOG_SHAPE_INVALID");
const mapping = new Map(catalog.models.map((model) => [model.publicId, model]));
const selectedPublic = catalog.public.filter((model) => {
  const mapped = mapping.get(model.id);
  if (billingUnit === "provider_token") return mapped?.providerBillingUnit === "token";
  return model.capabilities?.billingUnit === billingUnit && mapped?.providerBillingUnit !== "token";
})
  .filter((model) => included.size === 0 || included.has(mapping.get(model.id)?.internalId))
  .filter((model) => !excluded.has(mapping.get(model.id)?.internalId));
const models = selectedPublic.map((model) => {
  const mapped = mapping.get(model.id);
  assert.ok(mapped?.internalId, `PUBLIC_MODEL_MAPPING_MISSING:${model.id}`);
  return mapped;
});
assert.equal(new Set(models.map((model) => model.internalId)).size, models.length, "DUPLICATE_INTERNAL_MODEL");

const report = {
  schema: "reviewed_video_billing_scope.v1",
  checkedAt: new Date().toISOString(),
  sourceCatalog: path.relative(process.cwd(), catalogPath),
  surface: catalog.scope,
  billingUnit,
  includedInternalIds: [...included],
  excludedInternalIds: [...excluded],
  models,
  review: selectedPublic.map((model) => ({
    internalId: mapping.get(model.id).internalId,
    publicId: model.id,
    displayName: model.displayName,
    publicPrice: model.publicPrice,
    defaultResolution: model.capabilities?.defaultResolution || null,
    defaultDuration: model.capabilities?.defaultDuration || null,
    workflowInputMode: model.capabilities?.workflowInputMode || null,
    available: model.capabilities?.available !== false,
    providerBillingUnit: mapping.get(model.id).providerBillingUnit || null,
    publicBillingPending: mapping.get(model.id).publicBillingPending === true,
  })),
  providerRequests: 0,
  paidGenerationRequests: 0,
  databaseWrites: 0,
};
await fs.mkdir(path.dirname(outputPath), { recursive: true });
await fs.writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
console.log(JSON.stringify({ billingUnit, modelCount: models.length, output: outputPath }));
