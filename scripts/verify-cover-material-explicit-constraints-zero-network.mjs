#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";
import sharp from "sharp";
import { z } from "zod";

// Reuse the existing actual-module loader and every isolated I/O port. Only
// expose its local `load` function; no production or original test is rewritten.
const root = process.cwd(), prepareFile = "scripts/verify-cover-prepare-zero-network.mjs";
const prepareSource = readFileSync(prepareFile, "utf8"), ast = ts.createSourceFile(prepareFile, prepareSource, ts.ScriptTarget.Latest, true);
const original = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "harness");
assert.ok(original?.body);
const statements = [...original.body.statements], last = statements.at(-1);
assert.ok(ts.isReturnStatement(last) && ts.isObjectLiteralExpression(last.expression));
statements[statements.length - 1] = ts.factory.updateReturnStatement(last, ts.factory.updateObjectLiteralExpression(last.expression,
  [...last.expression.properties, ...["load", "confirmRoute", "request"].map(name => ts.factory.createShorthandPropertyAssignment(name))]));
const harnessNode = ts.factory.updateFunctionDeclaration(original, original.modifiers, original.asteriskToken, original.name,
  original.typeParameters, original.parameters, original.type, ts.factory.updateBlock(original.body, statements));
const declarations = ["ownerA", "ownerB", "referenceId", "sha", "clone", "fields"].map(name => {
  const node = ast.statements.filter(ts.isVariableStatement).flatMap(item => [...item.declarationList.declarations]).find(item => item.name.text === name);
  assert.ok(node); return `const ${node.getText(ast)};`;
});
const code = ts.transpileModule(`${declarations.join("\n")}\n${ts.createPrinter().printNode(ts.EmitHint.Unspecified, harnessNode, ast)}\nmodule.exports.make=harness;`,
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
let forbiddenCalls = 0;
const forbidden = () => { forbiddenCalls++; throw Error("REAL_IO_FORBIDDEN"); };
class NextRequest extends Request { get nextUrl() { return new URL(this.url); } }
function make() {
  const module = { exports: {} }, ports = { module, root, assert, createHash, randomUUID, readFileSync, path, vm, sharp, ts, z,
    NextRequest, Request, Response, Buffer, URL, URLSearchParams, AbortSignal, Error, structuredClone, console, fetch: forbidden };
  new Function(...Object.keys(ports), code)(...Object.values(ports));
  return module.exports.make();
}
const hash = value => createHash("sha256").update(value).digest("hex"), checks = [];
const h = make(), prompts = h.load("src/lib/cover-workbench-prompts.ts"), material = h.load("src/lib/cover-material-composition.ts");
const version = material.COVER_MATERIAL_EXPLICIT_CONSTRAINTS_VERSION;
assert.equal(version, "cover-material-explicit-constraints/1");
const assetId = "00000000-0000-4000-8000-000000000003";
const compose = { ...h.materials("explicit_material_rules"), imageMode: "compose", contentKind: "product",
  text: "@图1作为主体。主体位于参照物后方，右手接触物体，参照物遮挡下半身。左上标题分两行。", assets: [{ assetId, imageNumber: 1, role: "style_reference" }] };
const before = JSON.stringify(compose), messages = prompts.compileCoverAnalysisMessages(compose), system = messages[0].content, data = JSON.parse(messages[1].content);
assert.equal(data.materialExplicitConstraintsVersion, version);
assert.equal(prompts.coverAnalysisDependencySnapshot(compose).materialExplicitConstraintsVersion, version);
assert.equal(JSON.stringify(compose), before);
checks.push("compose-only optional rule version is frozen in user data and dependencies without mutating materials");
assert.ok(system.includes("visualBrief.scene逐项保留")); assert.ok(system.includes("前后、左右、上下、内外"));
assert.ok(system.includes("当前位置、朝向、接触及前景遮挡后景")); assert.ok(system.includes("不能以完整展示人物或商品为由交换位置、反转遮挡"));
assert.ok(system.includes("真实sourceSpanId")); assert.ok(system.includes("fields覆盖visualBrief.scene及visualBrief.action"));
assert.ok(system.includes("关系冲突且无法同时成立时使用needs_input"));
assert.ok(system.includes("不新增空间表格、关系标签")); assert.ok(!system.includes("台面"));
checks.push("analysis carries generic source-backed directional/contact/occlusion rules in existing fields, with conflict clarification and no case-specific counter rule");
assert.ok(system.includes("primaryTitle必须实际换行表达")); assert.ok(system.includes("合法\\n转义"));
assert.ok(system.includes("对应primaryTitle的候选须连换行一起保持一致"));
assert.ok(system.includes("不为凑行数增加参数、卖点、数字或承诺")); assert.ok(system.includes("当前两行排版合同冲突时needs_input"));
checks.push("explicit title line count requires actual JSON-decoded newlines and consistent candidate text, without invented facts or output fields");
const bindings = material.resolveCoverMaterialBindings(compose), compiled = material.compileCoverMaterialCompositionPrompt(bindings, { explicitConstraintsVersion: version });
assert.ok(compiled.includes(version)); assert.ok(compiled.includes("前景物体按真实空间遮挡后方主体相应部位"));
assert.ok(compiled.includes("不能为了完整展示人物、商品或增加留白，把后方主体移到前方"));
assert.ok(compiled.includes("原文及已确认visualBrief.scene/action"));
assert.deepEqual(Object.keys(JSON.parse(compiled.split("\n").at(-1))).sort(), ["imageReferences", "productLabelCandidates", "schemaVersion", "untrustedInstructions", "untrustedText"]);
assert.throws(() => material.compileCoverMaterialCompositionPrompt(bindings, { explicitConstraintsVersion: "cover-material-explicit-constraints/unknown" }), error => error.code === "COVER_MATERIAL_CONSTRAINT_VERSION_INVALID");
checks.push("image compiler respects confirmed relations and physical occlusion, fails unknown rule versions and preserves the existing output schema");
for (const materials of [h.materials("legacy_absent"), { ...h.materials("preserve"), imageMode: "preserve", assets: compose.assets },
  { ...h.materials("product_text_only"), contentKind: "product" }]) {
  const dependency = prompts.coverAnalysisDependencySnapshot(materials), request = prompts.compileCoverAnalysisMessages(materials);
  assert.equal(Object.hasOwn(dependency, "materialExplicitConstraintsVersion"), false);
  assert.equal(Object.hasOwn(JSON.parse(request[1].content), "materialExplicitConstraintsVersion"), false);
  assert.equal(request[0].content.includes(version), false);
}
checks.push("absent/preserve/text-only product branches acquire no rule marker or additional instructions");
const stale = make(), prepared = await stale.post({ action: "prepare", materials: compose });
assert.equal(prepared.status, 200);
const row = stale.state.parents[0];
assert.equal(row.preparation.promptDependencies.materialExplicitConstraintsVersion, version);
delete row.preparation.promptDependencies.materialExplicitConstraintsVersion;
const rejected = await stale.post({ action: "analyze", operationId: prepared.body.operationId, consent: { analysis: true } });
assert.equal(rejected.status, 409); assert.equal(rejected.body.code, "COVER_PREPARATION_STALE"); assert.equal(stale.state.gatewayCalls, 0);
checks.push("actual prepare/analyze route rejects a missing frozen material rule before the fixture gateway or billing can be invoked");

async function confirmPaidParent(marker) {
  const current = make(), paidMaterials = { ...current.materials("explicit_paid_parent"), imageMode: "compose",
    text: "用@图1作为主体。以前总拖到最后，现在每天先做十分钟，终于开始行动。", assets: [{ assetId, imageNumber: 1, role: "identity_subject" }] };
  const preparation = await current.post({ action: "prepare", materials: paidMaterials });
  assert.equal(preparation.status, 200);
  const analyzed = await current.post({ action: "analyze", operationId: preparation.body.operationId, consent: { analysis: true } });
  assert.equal(analyzed.body.status, "review_ready", JSON.stringify(analyzed.body));
  const parent = current.state.parents[0];
  assert.equal(parent.billing.credits_charged, 2);
  if (marker === undefined) delete parent.preparation.promptDependencies.materialExplicitConstraintsVersion;
  else parent.preparation.promptDependencies.materialExplicitConstraintsVersion = marker;
  const frozen = JSON.stringify(parent), gatewayCalls = current.state.gatewayCalls, childrenBefore = current.state.children.length;
  const response = await current.confirmRoute.POST(current.request({ operationId: parent.id, clientRequestId: "explicit_rules_confirm_paid_parent",
    expectedAnalysisHash: analyzed.body.analysisHash, expectedImageQuoteHash: analyzed.body.quote.imageQuoteHash,
    edits: {}, consent: { image: true } }, "/api/cover-workbench/confirm"));
  assert.equal(current.state.gatewayCalls, gatewayCalls, "Confirming a paid analysis cannot call another analysis provider");
  assert.equal(current.state.children.length, childrenBefore, "No extra billed analysis attempt or execution can be created");
  assert.equal(JSON.stringify(parent), frozen, "The paid parent and its billing/analysis/dependencies are immutable");
  const child = current.state.parents.find(row => row.preparation.recordKind === "confirmation");
  if (child) { assert.equal(child.billing.credits_charged, 0); assert.equal(child.billing.reused_from_operation_id, parent.id); }
  return { status: response.status, body: await response.json(), child, current };
}
const legacyConfirmation = await confirmPaidParent(undefined);
assert.equal(legacyConfirmation.status, 200);
assert.equal(legacyConfirmation.child.result.generationInput.prompt.includes(version), false);
assert.equal(legacyConfirmation.child.result.generationPromptVersion, "cover-background/2.4.0+visual-binding-v1+cover-generated-overlay-safe-frame/1");
// Frozen from the actual pre-change service + both pre-change TS compilers;
// independently reproduced in the scoped legacy-before-hash-proof evidence.
assert.equal(hash(legacyConfirmation.child.result.generationInput.prompt), "b4fcc4e019d549b2bf36d130ff6f5b32830360683e3d7ba0a3b44ac9bdbd8b60", "Legacy paid-parent output must retain the pre-change compiler's complete prompt bytes");
checks.push("actual confirmation of an already paid parent without a marker preserves the old complete image prompt hash/version and creates only a free child");
const currentConfirmation = await confirmPaidParent(version);
assert.equal(currentConfirmation.status, 200);
assert.ok(currentConfirmation.child.result.generationInput.prompt.includes(version));
assert.equal(currentConfirmation.child.result.generationPromptVersion, `${legacyConfirmation.child.result.generationPromptVersion}+${version}`);
assert.equal(Object.hasOwn(currentConfirmation.child.result.generationInput, "materialExplicitConstraintsVersion"), false, "Private marker is not part of the public generation payload");
checks.push("actual new frozen-marker confirmation enables only the new material image rules and records the same version in private generation metadata");
for (const marker of [null, "", false, 0, {}, "cover-material-explicit-constraints/unknown"]) {
  const result = await confirmPaidParent(marker);
  assert.equal(result.status, 503); assert.equal(result.child, undefined);
  assert.equal(result.current.state.parents.length, 1);
}
checks.push("six illegal/unknown frozen markers fail confirmation before a child, new fee or provider execution; no normalization/default upgrade is allowed");

// Render the actual client review component through an inert JSX port. This
// exercises real select callbacks and exact projection, without React effects,
// browser, network or a copy of role-selection business logic.
const jsx = (type, props, key) => ({ type, props: props || {}, key });
const reviewSource = readFileSync("src/components/cover-plan-review.tsx", "utf8"), reviewModule = { exports: {} };
const reviewImports = { "react/jsx-runtime": { jsx, jsxs: jsx }, "lucide-react": { Check: "Check", RotateCcw: "RotateCcw", Sparkles: "Sparkles" },
  "@/lib/cover-review-contract": h.load("src/lib/cover-review-contract.ts"), "./cover-workbench.module.css": { default: {} } };
vm.runInNewContext(ts.transpileModule(reviewSource, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText,
  { module: reviewModule, exports: reviewModule.exports, fetch: forbidden, require(id) { assert.ok(Object.hasOwn(reviewImports, id), `Private/unplanned client import: ${id}`); return reviewImports[id]; } });
const review = reviewModule.exports, ids = [assetId, "00000000-0000-4000-8000-000000000004", "00000000-0000-4000-8000-000000000005"];
const rawAssets = ids.map((assetId, index) => ({ assetId, imageNumber: index + 1, role: "style_reference" })), rawSnapshot = JSON.stringify({ assets: rawAssets, materialRevision: 7 });
let draft = { topic: "来源主题", primaryTitle: "原文标题\n第二行", secondaryTitle: null, visualBrief: { subject: "主体", action: "接触", scene: "后方", emotion: "自然" },
  materialUsage: ids.map((assetId, index) => ({ assetId, imageNumber: index + 1, role: index < 2 ? "identity_subject" : "background_canvas" })) };
assert.deepEqual(rawAssets.map(asset => review.coverReviewedMaterialUsage(asset, draft).role), ["identity_subject", "identity_subject", "background_canvas"]);
assert.equal(review.coverReviewedMaterialUsage({ assetId: ids[2], imageNumber: 2 }, draft), undefined);
assert.equal(review.coverReviewedMaterialUsage({ imageNumber: 3 }, draft), undefined);
assert.equal(review.coverReviewedMaterialUsage(rawAssets[2], { ...draft, materialUsage: [...draft.materialUsage, draft.materialUsage[2]] }), undefined);
checks.push("left effective usage follows the draft only for a unique exact asset ID and image number; order/name/missing/duplicate bindings never substitute");
const nodes = tree => !tree ? [] : Array.isArray(tree) ? tree.flatMap(nodes) : typeof tree === "object" ? [tree, ...nodes(tree.props?.children)] : [];
const props = { analysis: { titleCandidates: [], evidence: [] }, disabled: false, confirmed: false, editableMaterialRoles: true,
  onChange(value) { draft = value; }, onReset: forbidden, onGenerate: forbidden, canGenerate: false, feeText: "免费编辑", error: "", generating: false };
const render = overrides => review.CoverPlanReview({ ...props, draft, ...overrides });
const editor = nodes(render()).find(node => node.type === "select" && node.props["aria-label"] === "方案图3用途");
assert.equal(editor.props.id, review.coverReviewMaterialRoleEditorId(ids[2], 3));
assert.ok(nodes(render()).some(node => node.props.id === "cover-plan-material-roles" && node.props.role === "group"));
editor.props.onChange({ target: { value: "style_reference" } });
assert.equal(review.coverReviewedMaterialUsage(rawAssets[2], draft).role, "style_reference");
assert.equal(JSON.stringify({ assets: rawAssets, materialRevision: 7 }), rawSnapshot);
assert.equal(draft.primaryTitle, "原文标题\n第二行");
checks.push("actual right role select updates the left projection for free while preserving raw roles, material revision, titles and all other plan fields");
for (const lock of [{ disabled: true }, { confirmed: true }, { editableMaterialRoles: false }]) {
  assert.ok(nodes(render(lock)).filter(node => node.type === "select" && String(node.props["aria-label"]).includes("用途")).every(node => node.props.disabled));
}
checks.push("processing/uncertain disabled, confirmed and original/noneditable role locks remain enforced by the actual component");
const workbenchSource = readFileSync("src/components/cover-workbench.tsx", "utf8"), workbenchAst = ts.createSourceFile("workbench.tsx", workbenchSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
assert.equal(workbenchAst.parseDiagnostics.length, 0);
const focus = workbenchAst.statements.find(ts.isFunctionDeclaration)?.getText(workbenchAst);
assert.ok(focus); // The exact focus handler has no mutating workbench method.
const focusStart = workbenchSource.indexOf("const focusMaterialRole ="), focusEnd = workbenchSource.indexOf("  const scenario =", focusStart);
const focusSource = workbenchSource.slice(focusStart, focusEnd);
assert.ok(focusSource.includes('setWorkspaceTab("plan")')); assert.ok(focusSource.includes("editor?.focus({ preventScroll: true })"));
assert.doesNotMatch(focusSource, /changeRole|changeReviewDraft|analy[sz]e|prepareRequest|fetch\(|bump\(|confirmAndGenerate/u);
assert.ok(workbenchSource.includes("disabled={inputsLocked || reviewedComposition}"));
checks.push("left plan navigation uses stable exact editor IDs and focus only, with no revision, analysis, prepare or generation mutation path");
const browserFile = "scripts/verify-cover-review-browser-readonly.mjs", browserSource = readFileSync(browserFile, "utf8"), browserAst = ts.createSourceFile(browserFile, browserSource, ts.ScriptTarget.Latest, true);
assert.equal(browserAst.parseDiagnostics.length, 0);
const browserDeclarations = new Map();
const visit = node => { if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && ["roleAssetIds", "roleMaterials"].includes(node.name.text)) browserDeclarations.set(node.name.text, node.initializer.getText(browserAst)); ts.forEachChild(node, visit); };
visit(browserAst);
const roleFixture = vm.runInNewContext(`const roleAssetIds=${browserDeclarations.get("roleAssetIds")}; (${browserDeclarations.get("roleMaterials")})`, { fetch: forbidden });
const parsedFixture = h.load("src/lib/cover-workbench-contract.ts").parseCoverPrepareInput(roleFixture);
assert.equal(parsedFixture.assets.length, 3); assert.ok(parsedFixture.assets.every(asset => asset.role === "style_reference"));
assert.equal(parsedFixture.materialRevision, 7); assert.equal(parsedFixture.imageMode, "compose");
assert.ok(browserSource.includes('for (const width of [1440, 1920])'));
assert.ok(browserSource.includes('await page.keyboard.press("Enter")')); assert.ok(browserSource.includes('document.activeElement?.id === id'));
assert.ok(browserSource.includes('report.requests.slice(fixtureStart).every(item => item.method === "GET")'));
assert.ok(browserSource.includes('rawAssetsAndRevisionUnchanged: true'));
checks.push("prepared browser fixture parses through the actual public contract; both desktop widths, keyboard focus and GET-only workflow assertions remain explicit without launching a browser");
assert.equal(forbiddenCalls, 0);
console.log(JSON.stringify({ passed: true, checks: checks.length, cases: checks, networkCalls: 0, providerCalls: 0, liveDatabaseCalls: 0,
  explicitConstraintsVersion: version, compiledMaterialSha256: hash(compiled), boundary: "Actual TS compilers, dependency preparation guard and client review callbacks; source-backed fixtures only. No LLM, browser or visual pass is claimed." }, null, 2));
