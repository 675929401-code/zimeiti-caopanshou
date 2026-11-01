import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import * as jsxRuntime from "react/jsx-runtime";
import { toPublicModelDto, containsForbiddenPublicModelKey } from "../src/lib/public-model-dto";
import { readVideoDurationBehavior } from "../src/lib/video-duration-behavior";
import { VideoDurationBehaviorNotice } from "../src/components/video-duration-behavior-notice";
import { getVideoDurationCapabilities, getVideoResolutionCapabilities, getVideoBillingUnit, readVideoTokenPublicPricing, resolveVideoCharge } from "../src/lib/video-model-capabilities";
import { getAiVideoPageDefaultResolution } from "../src/lib/ai-video-page-capabilities";
import { publicVideoModelCompatibilityCode } from "../src/lib/video-model-public-status";

const copy = "所选秒数为目标时长，成片可能稍长。按所选秒数计费。";
const row = { id: "duration-fixture", public_name: "Duration fixture", selling_price: 0.25 };
const capabilities = { type: "video", durationMode: "range", minDuration: 1, maxDuration: 10, defaultDuration: 1,
  resolutionOptions: ["720p"], defaultResolution: "720p", available: true, generationReady: true, priceReady: true,
  verificationNotice: "private admin text", readinessMessage: "private provider text" };
const baseline = toPublicModelDto("video", row, 0, capabilities);
const marked = toPublicModelDto("video", { ...row, api_protocol_config: { duration_behavior: "requested_target", api_key: "private fixture" } }, 0, capabilities);
assert.equal(marked.capabilities.durationBehavior, "requested_target");
assert.equal(baseline.capabilities.durationBehavior, undefined);
assert.deepEqual({ ...marked, capabilities: { ...marked.capabilities, durationBehavior: undefined } },
  { ...baseline, capabilities: { ...baseline.capabilities, durationBehavior: undefined } }, "metadata must preserve IDs, price, admission and all other public fields");
for (const value of [undefined, null, "", "Requested_Target", "private arbitrary admin prose", {}, ["requested_target"]]) {
  assert.equal(readVideoDurationBehavior(value), undefined);
  assert.equal(toPublicModelDto("video", { ...row, api_protocol_config: { duration_behavior: value } }, 0, capabilities).capabilities.durationBehavior, undefined);
}
assert.equal(toPublicModelDto("video", row, 0, { ...capabilities, durationBehavior: "requested_target" }).capabilities.durationBehavior, undefined, "caller capability cannot forge protocol metadata");
assert.equal(toPublicModelDto("chat", { ...row, api_protocol_config: { duration_behavior: "requested_target" } }, 0, capabilities).capabilities.durationBehavior, undefined);
assert.equal(toPublicModelDto("video", { ...row, api_protocol_config: { duration_behavior: "requested_target" } }, 0, { ...capabilities, capabilitiesVerified: false }).capabilities.durationBehavior, undefined);
assert.equal(marked.capabilities.verificationNotice, "");
assert.equal(containsForbiddenPublicModelKey(marked), false);
assert.ok(!JSON.stringify(marked).includes("private"));

const dependencies = { readVideoDurationBehavior, getVideoDurationCapabilities, getVideoResolutionCapabilities,
  getVideoBillingUnit, readVideoTokenPublicPricing, getAiVideoPageDefaultResolution, publicVideoModelCompatibilityCode,
  VideoDurationBehaviorNotice, WORKBENCH_RATIOS: ["16:9", "9:16", "1:1"] };
function execute(code: string, extra: Record<string, unknown> = {}) {
  const scope = { ...dependencies, ...extra, exports: {} };
  const js = ts.transpileModule(code, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  return new Function(...Object.keys(scope), "require", js)(...Object.values(scope), (name: string) => {
    assert.equal(name, "react/jsx-runtime"); return jsxRuntime;
  });
}
for (const [file, normalizer, selected] of [
  ["src/app/video/page.tsx", "normalizePublicVideoModel", "selectedModel"],
  ["src/components/storyboard-workbench.tsx", "normalizeVideoModel", "activeVideoModel"],
]) {
  const source = readFileSync(file, "utf8");
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const helpers = new Set([normalizer, "firstText", "firstNumber", "firstBoolean", "firstOptionalBoolean", "firstOptionalNumber", "stringList", "numberList", "isWorkbenchRatio"]);
  const code = ast.statements.filter((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && Boolean(node.name && helpers.has(node.name.text))).map(node => node.getText(ast)).join("\n");
  const normalize = execute(`${code}\nreturn ${normalizer};`) as (value: unknown) => Record<string, unknown>;
  let consumer: ts.JsxSelfClosingElement | undefined;
  const visit = (node: ts.Node) => { if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(ast) === "VideoDurationBehaviorNotice") consumer = node; ts.forEachChild(node, visit); };
  visit(ast);
  assert.ok(consumer, `${file}: actual page must consume notice component`);
  assert.ok(consumer.getText(ast).includes(`${selected}?.durationBehavior`), "notice follows the selected model");
  const markedModel = normalize(marked);
  const unmarkedModel = normalize(baseline);
  assert.equal(markedModel.durationBehavior, "requested_target");
  assert.equal(unmarkedModel.durationBehavior, undefined);
  assert.equal(normalize({ ...baseline, capabilities: { ...baseline.capabilities, durationBehavior: "private arbitrary admin prose" } }).durationBehavior, undefined);
  assert.equal(markedModel.id, unmarkedModel.id);
  assert.equal(markedModel.pricePerUse, unmarkedModel.pricePerUse);
  assert.equal(markedModel.generationReady, unmarkedModel.generationReady);
  assert.deepEqual(resolveVideoCharge(markedModel, "720p", 1), resolveVideoCharge(unmarkedModel, "720p", 1));
  for (const model of [markedModel, unmarkedModel, undefined, markedModel, unmarkedModel]) {
    const element = execute(`return (${consumer.getText(ast)});`, { [selected]: model });
    const html = renderToStaticMarkup(element);
    assert.equal(html.includes(copy), model?.durationBehavior === "requested_target");
    assert.ok(!html.includes("private"));
  }
}
assert.equal(renderToStaticMarkup(createElement(VideoDurationBehaviorNotice, {})), "");
console.log("PASS duration behavior: DTO whitelist, private-copy exclusion, actual two-page normalizers/JSX consumers, model switches and price/admission preservation; zero network/DB/provider/wallet calls");
