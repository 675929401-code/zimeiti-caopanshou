import assert from "node:assert/strict";
import { coverReferenceTitleStyle } from "../src/lib/cover-reference-layout";
import { CoverVisualObservationSchema, parseCoverPrepareInput } from "../src/lib/cover-workbench-contract";
import { coverCompositionValidationError, COVER_OUTPUT_SPECS } from "../src/lib/cover-composition";

const sourceId = "00000000-0000-4000-8000-000000000001";
const referenceId = "00000000-0000-4000-8000-000000000002";
const materials = parseCoverPrepareInput({ clientRequestId: "reference_layout_01", text: "每天都能轻松搭配的随行杯",
  assets: [{ assetId: sourceId, role: "identity_subject" }, { assetId: referenceId, role: "style_reference" }] });
const source = CoverVisualObservationSchema.parse({ schemaVersion: "cover-visual-analysis/1", assetId: sourceId, assetRevision: 1, status: "ready",
  observations: [{ id: "subject", kind: "subject", description: "右上方的杯子", region: { x: .7, y: .1, width: .2, height: .25 } },
    { id: "space", kind: "negative_space", description: "左侧留白", region: { x: .04, y: .25, width: .4, height: .2 } }], ocr: [], palette: ["#ffffff"], uncertainties: [] });
const reference = CoverVisualObservationSchema.parse({ schemaVersion: "cover-visual-analysis/1", assetId: referenceId, assetRevision: 1, status: "ready",
  observations: [{ id: "title", kind: "title_zone", description: "右上方标题", region: { x: .7, y: .1, width: .25, height: .2 } }], ocr: [], palette: ["#111111", "#eeeeee"], uncertainties: [] });
const before = JSON.stringify({ materials, source, reference });
const adapted = coverReferenceTitleStyle({ materials, observations: [source, reference], sourceAssetId: sourceId });
assert.equal(adapted.x, .04); assert.equal(adapted.y, .25); assert.equal(adapted.width, .4);
assert.equal(adapted.color, "#111111");
assert.equal(JSON.stringify({ materials, source, reference }), before);
const noCollision = coverReferenceTitleStyle({ materials, observations: [{ ...source, observations: [] }, reference], sourceAssetId: sourceId });
assert.equal(noCollision.x, .7); assert.equal(noCollision.width, .25);
const darkSource = { ...source, palette: ["#000000"] };
const brightReference = { ...reference, palette: ["#ffcc00", "#997700"] };
assert.equal(coverReferenceTitleStyle({ materials, observations: [darkSource, brightReference], sourceAssetId: sourceId }).color, "#ffcc00");
const unreadable = { ...reference, status: "partial" as const };
assert.deepEqual(coverReferenceTitleStyle({ materials, observations: [source, unreadable], sourceAssetId: sourceId }), { x: .08, y: .07, width: .84, scale: 1 });
assert.equal(coverCompositionValidationError({ planVersion: 2, title: "轻松搭配", subtitle: "", aspectRatio: "3:4",
  outputSpec: { aspectRatio: "3:4", ...COVER_OUTPUT_SPECS["3:4"], format: "png", fit: "contain" },
  animationStyleId: "pixar-3d", layoutTemplateId: "gaoding-cover-workbench", titleStyle: adapted }), null);
console.log(JSON.stringify({ passed: true, checks: 5, networkCalls: 0, providerCalls: 0,
  cases: ["避开原图主体并使用可用留白", "保留可用参考标题区域", "依据原图明暗选择可读参考色", "未就绪观察不驱动排版", "输入不变且输出符合实际合成合同"] }, null, 2));
