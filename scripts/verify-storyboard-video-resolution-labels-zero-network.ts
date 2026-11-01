import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import * as capabilities from "../src/lib/video-model-capabilities";
import * as publicStatus from "../src/lib/video-model-public-status";

const source = readFileSync("src/components/storyboard-workbench.tsx", "utf8");
const tree = ts.createSourceFile("storyboard-workbench.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const names = ["firstText", "firstNumber", "firstOptionalNumber", "firstOptionalBoolean", "firstBoolean", "stringList", "numberList", "isWorkbenchRatio", "normalizeVideoModel", "videoResolutionDisplayLabel"];
const declarations = tree.statements.filter(node => ts.isFunctionDeclaration(node) && names.includes(node.name?.text || "")).map(node => node.getText(tree)).join("\n");
const context = { ...capabilities, ...publicStatus, WORKBENCH_RATIOS: ["16:9", "9:16", "1:1", "4:3", "3:4"], exports: {} as { normalizeVideoModel: (record: unknown) => Record<string, unknown>; label: (model: unknown, key: string) => string } };
runInNewContext(ts.transpileModule(declarations + "\nexports.normalizeVideoModel=normalizeVideoModel; exports.label=videoResolutionDisplayLabel;", { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, context);
const fixtures = [
  { name: "H3", label: "768P", duration: 1, unit: "output_second", price: 0.2 },
  { name: "Muse", label: "模型默认画质", duration: 8, unit: "per_use", price: 0.7 },
];
for (const fixture of fixtures) {
  const dto = { id: "fixture-" + fixture.name, displayName: fixture.name, publicPrice: fixture.price, capabilities: {
    available: true, generationReady: true, priceReady: true, capabilitiesVerified: true,
    billingUnit: fixture.unit, supportsImageInput: true, maxReferenceImages: 1,
    durationMode: "fixed", defaultDuration: fixture.duration, minDuration: fixture.duration, maxDuration: fixture.duration, nativeDurations: [fixture.duration],
    resolutionOptions: ["720p"], defaultResolution: "720p", resolutionPrices: ["720p=" + fixture.price], resolutionLabels: ["720p=" + fixture.label], aspectRatios: ["16:9"],
  } };
  const original = JSON.stringify(dto);
  const model = context.exports.normalizeVideoModel(dto);
  assert.equal(context.exports.label(model, "720p"), fixture.label, "actual normalized model must preserve the public display label");
  assert.equal(model.defaultResolution, "720p", "display label must not replace the machine key");
  const quote = capabilities.resolveVideoCharge(model, "720p", fixture.duration);
  assert.equal(quote.supported, true);
  assert.equal(quote.publicPrice, fixture.price, "display mapping must preserve the exact quote");
  assert.equal(capabilities.resolveVideoResolution(model, "720p").resolution, "720p");
  assert.equal(JSON.stringify(dto), original, "normalization/display must not mutate the historical or public record");
}
assert.equal(context.exports.label(undefined, "1080p"), "1080p");
assert.equal(context.exports.label(undefined, ""), "模型默认画质");
assert.equal(context.exports.label({ capabilitiesVerified: false, resolutionLabels: { "720p": "unverified-placeholder" } }, "720p"), "能力待核验");
for (const call of ["videoResolutionDisplayLabel(model, preferredResolution)", "videoResolutionDisplayLabel(activeVideoModel, value)", "videoResolutionDisplayLabel(model, resolution)", "videoResolutionDisplayLabel(activeVideoModel, activeVideoResolution)"]) assert.ok(source.includes(call), "display consumer must use the shared label: " + call);
assert.match(source, /<option key=\{value\} value=\{value\}>\{videoResolutionDisplayLabel/u);
assert.match(source, /resolution_tier: resolution,/u, "provider request must retain the original resolution key");
console.log(JSON.stringify({ passed: true, actualNormalizerExecuted: true, displayCases: fixtures.map(f => ({ name: f.name, key: "720p", display: f.label })), machineKeysAndQuotesUnchanged: true, historicalRecordUnchanged: true, networkRequests: 0, databaseCalls: 0, providerCalls: 0 }, null, 2));
