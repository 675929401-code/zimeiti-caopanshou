import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import * as capabilities from "../src/lib/video-model-capabilities";
import * as publicStatus from "../src/lib/video-model-public-status";
import { readVideoDurationBehavior } from "../src/lib/video-duration-behavior";
import { storyboardVideoModelSelectionIssue } from "../src/lib/storyboard-video-model-selection";
import * as jsxRuntime from "react/jsx-runtime";
import { renderToStaticMarkup } from "react-dom/server";

const source = readFileSync("src/components/storyboard-workbench.tsx", "utf8");
const tree = ts.createSourceFile("storyboard-workbench.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const names = ["firstText", "firstNumber", "firstOptionalNumber", "firstOptionalBoolean", "firstBoolean", "stringList", "numberList", "isWorkbenchRatio", "normalizeVideoModel", "videoResolutionDisplayLabel"];
const declarations = tree.statements.filter(node => ts.isFunctionDeclaration(node) && names.includes(node.name?.text || "")).map(node => node.getText(tree)).join("\n");
const context = { ...capabilities, ...publicStatus, readVideoDurationBehavior, WORKBENCH_RATIOS: ["16:9", "9:16", "1:1", "4:3", "3:4"], exports: {} as { normalizeVideoModel: (record: unknown) => Record<string, unknown>; label: (model: unknown, key: string) => string } };
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
const diagnosticOnly = context.exports.normalizeVideoModel({ id: "fixture-diagnostic", displayName: "挂牌画质模型", publicPrice: .2, capabilities: {
  available: true, generationReady: true, priceReady: true, capabilitiesVerified: false, durationBehavior: "requested_target",
  billingUnit: "per_use", supportsImageInput: true, maxReferenceImages: 1, durationMode: "fixed", defaultDuration: 8,
  minDuration: 8, maxDuration: 8, nativeDurations: [8], resolutionOptions: ["720p"], defaultResolution: "720p",
  resolutionPrices: ["720p=0.2"], resolutionLabels: ["720p=768P"], aspectRatios: ["16:9"],
} });
const target = { ratio: "16:9", duration: 8, resolution: "720p" };
const selectionIssue = (model: Record<string, unknown>) => storyboardVideoModelSelectionIssue(model as unknown as Parameters<typeof storyboardVideoModelSelectionIssue>[0], target);
assert.equal(context.exports.label(diagnosticOnly, "720p"), "768P", "a diagnostic verification flag must not replace a real public tier label");
assert.equal(selectionIssue(diagnosticOnly), "", "diagnostic verification metadata alone must not pause configured generation");
assert.equal(diagnosticOnly.durationBehavior, "requested_target", "normalization must preserve the actual duration behavior contract");
const paused: Record<string, unknown> = { ...diagnosticOnly, generationReady: false, compatibilityCode: "VIDEO_MODEL_SUBMISSION_PAUSED", readinessMessage: "该模型已暂停提交" };
assert.equal(context.exports.label(paused, "720p"), "", "paused generation has no misleading displayed specification");
assert.equal(selectionIssue(paused), "该模型已暂停提交", "submission admission must retain its independent compatibility reason");
assert.equal(paused.defaultResolution, "720p");
assert.equal(capabilities.resolveVideoCharge(paused, "720p", 8).publicPrice, .2, "a display pause must not mutate original billing keys or quotes");

// Render the real video-model button. A paused model stays discoverable while
// only its specification is suppressed; the row's admission remains disabled.
const rows: ts.JsxElement[] = [];
const collectRows = (node: ts.Node) => {
  if (ts.isJsxElement(node) && node.openingElement.tagName.getText(tree) === "button"
    && node.openingElement.attributes.properties.some(attribute => ts.isJsxAttribute(attribute)
      && attribute.name.getText(tree) === "aria-label" && attribute.initializer?.getText(tree).includes("选择视频模型："))) rows.push(node);
  ts.forEachChild(node, collectRows);
};
collectRows(tree); assert.equal(rows.length, 1, "one actual model-row consumer must own the public specification");
for (const model of [diagnosticOnly, paused]) {
  const rowModule = { exports: {} as { render: () => React.ReactNode } };
  runInNewContext(ts.transpileModule(`module.exports = { render: () => (${rows[0].getText(tree)}) };`, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, { module: rowModule, exports: rowModule.exports, require: (id: string) => { assert.equal(id, "react/jsx-runtime"); return jsxRuntime; },
    model, selectionIssue: selectionIssue(model), displayName: model.name, fullDisplayName: model.name, brand: "generic", channelLabel: "渠道A",
    priceLabel: "¥0.20/次", inputLabel: "图生视频", preferredResolution: "720p", run: { videoModelId: "" }, compactEditor: true, showAdminModelIds: false,
    ModelBadge: () => null, videoResolutionDisplayLabel: context.exports.label, videoModelInputHint: () => "需参考图" });
  const html = renderToStaticMarkup(rowModule.exports.render());
  assert.match(html, /挂牌画质模型/u, "paused models must remain visible in the actual row");
  assert.equal(html.includes('class="sbw-model-tier"'), model.generationReady !== false);
  assert.equal(html.includes('disabled=""'), model.generationReady === false);
  assert.match(html, /¥0\.20\/次/u, "the full original quote stays readable");
}
for (const call of ["videoResolutionDisplayLabel(model, preferredResolution)", "videoResolutionDisplayLabel(activeVideoModel, value)", "videoResolutionDisplayLabel(activeVideoModel, activeVideoResolution)"]) assert.ok(source.includes(call), "display consumer must use the shared label: " + call);
assert.match(source, /<option key=\{value\} value=\{value\}>\{videoResolutionDisplayLabel/u);
assert.match(source, /resolution_tier: resolution,/u, "provider request must retain the original resolution key");
console.log(JSON.stringify({ passed: true, actualNormalizerExecuted: true, displayCases: fixtures.map(f => ({ name: f.name, key: "720p", display: f.label })), machineKeysAndQuotesUnchanged: true, historicalRecordUnchanged: true, networkRequests: 0, databaseCalls: 0, providerCalls: 0 }, null, 2));
