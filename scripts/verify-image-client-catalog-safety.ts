import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { parseCoverGenerationModels } from "@/lib/cover-generation-attempt";

const root = process.cwd();
const read = (relative: string) => fs.readFileSync(path.join(root, relative), "utf8");
const coverStudio = read("src/components/cover-studio.tsx");
const imageWorkbench = read("src/components/image-workbench.tsx");
const publicModelDto = read("src/lib/public-model-dto.ts");
const coverModelsRoute = read("src/app/api/cover-models/route.ts");

function publicModel(capabilities: Record<string, unknown>, publicPrice: number) {
  return {
    id: "pm_contract_model",
    displayName: "合同模型",
    variantLabel: "A",
    publicPrice,
    capabilities: {
      defaultResolution: "1K",
      resolutionPrices: ["1K=1.25"],
      ...capabilities,
    },
  };
}

const unavailable = parseCoverGenerationModels([publicModel({ available: false, priceReady: true }, 1.25)])[0];
const unpriced = parseCoverGenerationModels([publicModel({ available: true, priceReady: false }, 0)])[0];
const ready = parseCoverGenerationModels([publicModel({ available: true, priceReady: true }, 9.99)])[0];

assert.equal(unavailable.available, false, "unavailable cover model must remain unavailable");
assert.equal(unpriced.available, false, "priceReady=false must also make a cover model unavailable");
assert.equal(unpriced.price, null, "unknown price must remain null rather than look free");
assert.equal(ready.available, true, "fully ready cover model should remain selectable");
assert.equal(ready.price, 1.25, "default-resolution public price should win over unrelated base price");

const coverGuard = coverStudio.indexOf("if (!recovery && activeModel?.available !== true)");
const coverPriceGuard = coverStudio.indexOf("if (!recovery && activeModel?.priceReady !== true)");
const coverRequest = coverStudio.indexOf("runCoverGeneration({");
assert.ok(coverGuard >= 0 && coverPriceGuard >= 0 && coverGuard < coverRequest && coverPriceGuard < coverRequest,
  "cover readiness guards must run before runCoverGeneration can form a new image request");
assert.ok(coverStudio.includes('disabled={!model.available}'), "unavailable cover catalog rows must be disabled");
assert.ok(coverStudio.includes('activeModel?.available && activeModel.priceReady && activeModel.price != null'),
  "cover price must only render after availability and price readiness are confirmed");
assert.ok(coverStudio.includes('"价格待确认"'), "cover unknown price must have an explicit non-free label");

const workbenchGuard = imageWorkbench.indexOf("if (!recoveringJobs && (!activeModel?.available || !activeModel.price_ready))");
const workbenchRequest = imageWorkbench.indexOf('fetch("/api/image/generate"');
assert.ok(workbenchGuard >= 0 && workbenchGuard < workbenchRequest,
  "image workbench readiness guard must run before a new image request");
assert.ok(imageWorkbench.includes("activeModel?.available && activeModel.price_ready"),
  "image workbench generate eligibility must require both availability and price readiness");
assert.ok(imageWorkbench.includes('disabled={!model.available}'), "unavailable image workbench models must be disabled");
assert.ok(imageWorkbench.includes('selectedResolutionPrice == null ? "价格待确认"'),
  "image workbench unknown prices must not display as free");

const finitePriceStart = publicModelDto.indexOf("function finitePublicPrice");
const finitePriceEnd = publicModelDto.indexOf("const MODEL_AVATAR", finitePriceStart);
const finitePriceSource = publicModelDto.slice(finitePriceStart, finitePriceEnd);
assert.ok(!finitePriceSource.includes("cost_per_use"), "supplier cost must never be projected as a public price");
assert.ok(coverModelsRoute.includes("selling_price: Number.isFinite(sellingPrice) ? sellingPrice"),
  "cover catalog must project the verified default-resolution selling price");

let generationRequests = 0;
for (const model of [unavailable, unpriced]) {
  if (model.available && model.priceReady && model.price !== null) generationRequests += 1;
}
assert.equal(generationRequests, 0, "unavailable or unpriced catalog rows must form zero generation requests");

console.log(JSON.stringify({
  passed: true,
  checks: 16,
  generationRequests,
  realNetworkRequests: 0,
  databaseWrites: 0,
}, null, 2));
