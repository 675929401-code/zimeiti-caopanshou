#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import ts from "typescript";
import { z } from "zod";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const clone = value => JSON.parse(JSON.stringify(value));
const sha = value => createHash("sha256").update(value).digest("hex");
let networkCalls = 0, modelCalls = 0;
const forbidden = () => { networkCalls++; throw new Error("External I/O is forbidden"); };
const owner = "00000000-0000-4000-8000-000000000001", other = "00000000-0000-4000-8000-000000000002";
const id = "00000000-0000-4000-8000-000000000003";
class NextRequest extends Request { get nextUrl() { return new URL(this.url); } }
const allowed = new Set(["src/lib/cover-composition.ts", "src/lib/cover-number-evidence.ts", "src/lib/cover-source-spans.ts",
  "src/lib/cover-benchmark-profiles.ts", "src/lib/cover-benchmark-prompt-packs.ts", "src/lib/cover-workbench-contract.ts", "src/lib/cover-workbench-prompts.ts",
  "src/lib/cover-material-composition.ts", "src/lib/cover-material-usage.ts",
  "src/lib/cover-benchmark-layout.ts",
  "src/lib/cover-analysis-envelope.ts",
  "src/lib/cover-narrative-summary.ts", "src/lib/cover-animation-brief.ts",
  "src/lib/cover-style-catalog.ts", "src/lib/cover-review-contract.ts", "src/lib/cover-durable-attempt.ts",
  "src/lib/server/cover-style-config.ts", "src/lib/server/cover-style-defaults.ts", "src/lib/server/cover-analysis-business-defaults.ts", "src/lib/server/cover-review-projection.ts",
  "src/lib/cover-reference-layout.ts", "src/lib/image-resolution-pricing.ts", "src/lib/server/cover-analysis-recovery.ts",
  "src/lib/server/cover-prepare-repository.ts", "src/lib/server/cover-prepare-service.ts", "src/lib/server/cover-request-body.ts", "src/app/api/cover/prepare/route.ts"]);
function loader(imports = {}) {
  const cache = new Map();
  function load(relative) {
    assert.ok(allowed.has(relative), `Unapproved executable module ${relative}`);
    if (cache.has(relative)) return cache.get(relative);
    const module = { exports: {} }; cache.set(relative, module.exports);
    const compiled = ts.transpileModule(readFileSync(path.join(root, relative), "utf8"), { fileName: relative, reportDiagnostics: true,
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } });
    assert.deepEqual((compiled.diagnostics || []).filter(item => item.category === ts.DiagnosticCategory.Error), []);
    vm.runInNewContext(compiled.outputText, { module, exports: module.exports, Buffer, URL, Request, Response, AbortSignal, console,
      fetch: forbidden, require(name) {
        if (Object.hasOwn(imports, name)) return imports[name];
        if (name === "./cover-admin-runtime") return { resolveCoverAnalysisModel: forbidden };
        if (name === "./cover-workflow-publication") return { compileCoverAdminPreview: forbidden, assertCoverPrivateSnapshotBudget: forbidden };
        if (name === "node:crypto") return { createHash };
        if (name === "server-only") return {};
        if (name === "zod") return { z };
        if (name === "next/server") return { NextRequest, NextResponse: { json: (value, init) => Response.json(value, init) } };
        const resolved = name.startsWith("@/") ? `src/${name.slice(2)}.ts`
          : `${path.posix.normalize(path.posix.join(path.posix.dirname(relative), name))}.ts`;
        return load(resolved);
      } }, { filename: relative });
    return module.exports;
  }
  return load;
}
const pure = loader(), contract = pure("src/lib/cover-workbench-contract.ts"), spans = pure("src/lib/cover-source-spans.ts"), prompts = pure("src/lib/cover-workbench-prompts.ts");
const fields = ["topic", "primaryTitle", "secondaryTitle", "visualBrief.subject", "visualBrief.action", "visualBrief.scene", "visualBrief.emotion"];
const materials = { schemaVersion: "cover-prepare/1", clientRequestId: "fixture-original-analysis", materialRevision: 1,
  text: "每天先做十分钟。", assets: [], styleKey: "cartoon", outputRatio: "16:9", modelId: "pm_fixture_image", resolution: "2K" };
const baseline = { schemaVersion: "cover-content-analysis/1", status: "ready", topic: "从行动开始", primaryTitle: "先做十分钟", secondaryTitle: null,
  visualBrief: { subject: "一个人", action: "开始做事", scene: "日常桌面", emotion: "开始行动" },
  titleCandidates: [{ id: "t1", text: "先做十分钟", evidenceRefs: ["e1"] }],
  evidence: [{ id: "e1", source: "text", quote: materials.text, fields }], missingInformation: [] };
{
  const conclusion = { text: "从每天先做十分钟开始", evidenceRefs: ["e1"] };
  const withBreakdown = { ...clone(baseline), contentBreakdown: { summary: conclusion, keyPoints: [conclusion],
    logic: { text: "原文提出开始行动的方法，没有给出后续结果", evidenceRefs: ["e1"] },
    coverFocus: { text: "表现开始动手的瞬间", evidenceRefs: ["e1"] } } };
  const parsed = contract.parseCoverContentAnalysis(withBreakdown, materials);
  assert.equal(parsed.contentBreakdown.summary.text, conclusion.text);
  assert.equal(Object.hasOwn(contract.parseCoverContentAnalysis(baseline, materials), "contentBreakdown"), false,
    "Already-paid replies without a breakdown stay unchanged, rather than fabricating a retrospective analysis");
  for (const corrupt of [value => { value.contentBreakdown.keyPoints[0].evidenceRefs = ["missing"]; },
    value => { value.contentBreakdown.logic.evidenceRefs = ["e1", "e1"]; },
    value => { value.contentBreakdown.keyPoints[0].text = "每天做二十分钟"; },
    value => { value.contentBreakdown.coverFocus.text = "销量第一"; },
    value => { value.contentBreakdown.keyPoints = []; }]) {
    const bad = clone(withBreakdown); corrupt(bad);
    assert.throws(() => contract.parseCoverContentAnalysis(bad, materials),
      error => ["ANALYSIS_EVIDENCE_INVALID", "ANALYSIS_UNGROUNDED_CLAIM", "ANALYSIS_SCHEMA_INVALID"].includes(error.code));
  }
  const prompt = prompts.compileCoverBackgroundPrompt({ analysis: parsed, style: contract.resolveCoverStyle("cartoon"),
    generationSpec: { modelId: "pm_fixture_image", resolution: "2K", aspectRatio: "16:9", outputRatio: "16:9", ratioEvidence: "declared_native" },
    outputSpec: contract.coverOutputSpec("16:9") });
  assert.ok(prompt.includes('"contentIntent"') && prompt.includes(parsed.contentBreakdown.coverFocus.text),
    "The same persisted content breakdown must enter actual artwork compilation");
  const messages = prompts.compileCoverAnalysisMessages(materials);
  assert.ok(messages[0].content.includes("summary用一句话概括") && messages[0].content.includes("ready时必须提供contentBreakdown和layoutIntent"));
  assert.equal(JSON.parse(messages[1].content).protocolVersion, prompts.COVER_ANALYSIS_PROMPT_VERSION);
}
const checks = ["summary, key points, source-content logic and cover focus persist with unique existing evidence references, reject new quantities/promises, and enter actual artwork compilation; old paid replies stay unchanged"];
{
  const parser = pure("src/lib/cover-analysis-envelope.ts");
  const valid = JSON.stringify({ analysis: { text: '引号\\与括号}在字符串里' }, visualObservations: [] });
  assert.equal(parser.parseCoverAnalysisEnvelope(valid).normalization, undefined);
  const broken = valid.replace(',"visualObservations":', '},"visualObservations":');
  const fixed = parser.parseCoverAnalysisEnvelope(broken);
  assert.equal(JSON.stringify(fixed.value), valid);
  assert.equal(fixed.normalization.originalSha256, sha(broken));
  assert.equal(fixed.normalization.normalizedSha256, sha(valid));
  const trailing = `${valid} \n}\t`;
  const trailingFixed = parser.parseCoverAnalysisEnvelope(trailing);
  assert.equal(trailingFixed.normalization.kind, "single_trailing_envelope_closure");
  const normalizedTrailing = trailing.slice(0, trailingFixed.normalization.offset) + trailing.slice(trailingFixed.normalization.offset + 1);
  assert.equal(normalizedTrailing, `${valid} \n\t`);
  assert.equal(JSON.stringify(trailingFixed.value), valid);
  assert.equal(trailingFixed.normalization.originalSha256, sha(trailing));
  assert.equal(trailingFixed.normalization.normalizedSha256, sha(normalizedTrailing));
  assert.equal(parser.parseCoverAnalysisEnvelope(normalizedTrailing).normalization, undefined);
  for (const invalid of [valid.slice(0, -1), broken.replace('},"visualObservations":', '}},"visualObservations":'),
    valid+' trailing prose', '{"analysis":{},"other":[]},"visualObservations":[]}',
    '{"analysis":{},"visualObservations":[]},"untrusted":true}',
    '{"analysis":{"v":1},"analysis":{"v":2}},"visualObservations":[]}',
    '{"analysis":{},"visualObservations":[{"discarded":true}]},"visualObservations":[]}',
    '{"analysis":{},"\\u0061nalysis":{"v":2}},"visualObservations":[]}',
    valid + '}}', valid + '}{}', valid + '}[]', valid + '} prose', valid + '}1', valid + '}true',
    valid + '{}', valid.slice(0, -1) + ']', '{"analysis":{"text":"unterminated},"visualObservations":[]}}',
    '{"analysis":{"text":"bad\\q"},"visualObservations":[]}}',
    '{"analysis":{},"visualObservations":[],"other":true}}',
    '{"analysis":{},"analysis":{"v":2},"visualObservations":[]}}',
    '{"analysis":{},"\\u0061nalysis":{"v":2},"visualObservations":[]}}',
    '{"analysis":[],"visualObservations":[]}}', '{"analysis":{},"visualObservations":{}}}',
    '{"analysis":{"v":1}},"visualObservations":[]}}']) {
    assert.throws(() => parser.parseCoverAnalysisEnvelope(invalid));
  }
  const livePath = path.join(root, '.codex-evidence/cover-paid-20261106-3fd15654/four-modes/warm_relationship_layout/analysis-diagnostic.json');
  if (existsSync(livePath)) {
    const actual = JSON.parse(readFileSync(livePath, 'utf8'));
    const recovered = parser.parseCoverAnalysisEnvelope(actual.parsed.unparsedFinalOutput);
    assert.equal(recovered.normalization.kind, 'single_premature_envelope_closure');
    const analysis = contract.parseCoverContentAnalysis(recovered.value.analysis, actual.materials);
    assert.ok(analysis.contentBreakdown && analysis.layoutIntent);
  }
  checks.push("actual complete paid semantic breakdown with one extra envelope brace reparses unchanged; truncation, extra properties, multiple defects and trailing prose remain invalid");
  checks.push("one trailing root brace removes exactly one non-value byte with distinct offset/SHA evidence; multiple objects, truncation, string/inner errors, duplicate root keys and all extra content remain invalid");
}
{
  const actualPath=path.join(root,'.codex-evidence/cover-paid-20261106-3fd15654/four-modes/product_description/analysis-diagnostic.json');
  if(existsSync(actualPath)){
    const actual=JSON.parse(readFileSync(actualPath,'utf8'));
    const analysis=actual.parsed.analysis||actual.parsed;
    assert.equal(contract.parseCoverContentAnalysis(analysis,actual.materials).visualBrief.subject,analysis.visualBrief.subject);
    for(const subject of ['一只装保温杯','每盒一个保温杯','内含一只保温杯','赠送一只保温杯','一箱米白色保温杯','一只800mL米白色保温杯']){
      const bad=clone(analysis);bad.visualBrief.subject=subject;
      assert.throws(()=>contract.parseCoverContentAnalysis(bad,actual.materials),error=>error.code==='ANALYSIS_UNGROUNDED_CLAIM',subject);
    }
    const plural=clone(actual.materials);plural.text=plural.text.replace('一款','两个');
    const bad=clone(analysis);bad.evidence=[{id:'e1',source:'text',quote:plural.text,fields},{id:'e2',source:'text',quote:plural.text,fields}];
    assert.throws(()=>contract.parseCoverContentAnalysis(bad,plural),error=>error.code==='ANALYSIS_UNGROUNDED_CLAIM');
    checks.push('actual single depicted product is not a pack count; contents, per-package/bonus quantities, classifier changes and unsupported capacity stay strict');
  }
}
{
  const text = "第一句。\n第二句，不能丢字！最后一段";
  const sourceSpans = spans.buildCoverSourceSpans({ text });
  for (const span of sourceSpans) assert.equal(text.slice(span.start, span.end), span.text);
  assert.equal(new Set(sourceSpans.map(span => span.id)).size, sourceSpans.length);
  const wire = { ...clone(baseline), secondaryTitle: "", evidence: [{ id: "e1", sourceSpanId: "t1", fields }] };
  const hydrated = contract.prepareCoverContentAnalysisEvidence(wire, materials);
  assert.equal(hydrated.value.evidence[0].quote, materials.text); assert.equal(hydrated.value.evidence[0].source, "text");
  assert.equal(hydrated.sourceAudit.bindings[0].start, 0); assert.equal(hydrated.value.secondaryTitle, null);
  assert.equal(contract.parseCoverContentAnalysis(wire, materials).primaryTitle, baseline.primaryTitle);
  assert.throws(() => contract.parseCoverContentAnalysis({ ...wire, evidence: [{ id: "e1", sourceSpanId: "foreign-span", fields }] }, materials), error => error.code === "ANALYSIS_EVIDENCE_INVALID");
  assert.throws(() => contract.parseCoverContentAnalysis({ ...wire, evidence: [{ id: "e1", sourceSpanId: "t1", fields, quote: "invented" }] }, materials));
  const user = JSON.parse(prompts.compileCoverAnalysisMessages(materials)[1].content);
  assert.equal(user.sourceSpans[0].text, materials.text); assert.equal(user.sourceSpans[0].start, 0);
  assert.ok(!Object.hasOwn(user, "untrustedText"), "Do not duplicate large source bodies and exhaust the fixed context budget");
  checks.push("source spans preserve continuous original slices and offsets; wire IDs hydrate canonical evidence and reject invented/conflicting references");
}
{
  assert.equal(Object.hasOwn(contract.parseCoverContentAnalysis(baseline, materials), "layoutIntent"), false);
  const withLayout = { ...clone(baseline), layoutIntent: { structure: "single", focus: "action", evidenceRefs: ["e1"] } };
  assert.equal(contract.parseCoverContentAnalysis(withLayout, materials).layoutIntent.focus, "action");
  for (const layoutIntent of [{ structure: "single", focus: "action", evidenceRefs: ["missing"] },
    { structure: "single", focus: "action", evidenceRefs: ["e1", "e1"] },
    { structure: "invented", focus: "action", evidenceRefs: ["e1"] },
    { structure: "single", focus: "action", evidenceRefs: ["e1"], inferredFromStyle: true }]) {
    assert.throws(() => contract.parseCoverContentAnalysis({ ...clone(baseline), layoutIntent }, materials),
      error => ["ANALYSIS_EVIDENCE_INVALID", "ANALYSIS_SCHEMA_INVALID"].includes(error.code));
  }
  checks.push("optional semantic layout intent keeps old canonical replies unchanged and only admits closed enums with existing unique evidence references");
}
{
  const original = "它只是把自己的饭点排在了你的作息后面，你几点关灯，它就几点开饭";
  const quote = "你几点关灯，它几点开饭";
  const aligned = spans.alignCoverSourceQuote(quote, original);
  assert.equal(aligned.quote, "你几点关灯，它就几点开饭"); assert.equal(original.slice(aligned.start, aligned.end), aligned.quote);
  assert.equal(aligned.kind, "source_inserted_particles");
  assert.equal(spans.alignCoverSourceQuote(quote, `${original}。${original}`), null, "Ambiguous occurrences cannot be repaired");
  assert.equal(spans.alignCoverSourceQuote(quote, "你几点不关灯，它就几点开饭"), null, "Negation cannot be omitted");
  assert.equal(spans.alignCoverSourceQuote("这瓶容量10毫升方便随身带", "这瓶容量100毫升方便随身带"), null);
  assert.equal(spans.alignCoverSourceQuote("型号A1适合随身携带使用", "型号A-1适合随身携带使用"), null);
  checks.push("legacy quote alignment permits only a unique real slice with bounded source particles/punctuation, never ambiguity, negation, quantity or SKU changes");
}
{
  const value = clone(baseline); value.primaryTitle = "先做10分钟"; value.titleCandidates[0].text = value.primaryTitle;
  assert.equal(contract.parseCoverContentAnalysis(value, materials).primaryTitle, value.primaryTitle);
  value.primaryTitle = "先做11分钟"; value.titleCandidates[0].text = value.primaryTitle;
  assert.throws(() => contract.parseCoverContentAnalysis(value, materials), error => error.code === "ANALYSIS_UNGROUNDED_CLAIM");
  const product = { ...materials, contentKind: "product", text: "这款水杯容量500毫升，适合通勤。" };
  const parsedInput = contract.parseCoverPrepareInput(materials);
  assert.equal(Object.hasOwn(parsedInput, "contentKind"), false, "Legacy absent contentKind must not alter stored material hashes");
  assert.equal(contract.parseCoverPrepareInput(product).contentKind, "product");
  const messages = prompts.compileCoverAnalysisMessages(product);
  assert.match(messages[0].content, /没有商品照片.*创意示意图/u);
  assert.equal(JSON.parse(messages[1].content).contentKind, "product");
  checks.push("equivalent Chinese/Arabic quantities pass while new numbers fail; product descriptions remain photo-optional and legacy script fingerprints stay representationally compatible");
}
{
  const assetId = "00000000-0000-4000-8000-000000000004";
  const input = contract.parseCoverPrepareInput({ ...materials, text: "请把@图1中的人物放在自然光中", imageMode: "compose",
    assets: [{ assetId, role: "identity_subject", imageNumber: 1 }] });
  const description = "年轻女性，微笑，室外自然光，轻松";
  const visual = { schemaVersion: "cover-visual-analysis/1", assetId, assetRevision: 1, status: "ready",
    observations: [{ id: "o1", kind: "subject", description, region: null }], ocr: [], palette: [], uncertainties: [] };
  const analysis = { ...clone(baseline), topic: "自然光下的微笑", primaryTitle: "自在微笑",
    titleCandidates: [{ id: "t1", text: "自在微笑", evidenceRefs: ["e1"] }],
    visualBrief: { subject: "@图1中的女性", action: "@图1中的人物微笑", scene: "室外自然光", emotion: "轻松" },
    evidence: [{ id: "e1", source: "visual_observation", assetId, observationId: "o1", quote: description, fields }] };
  const accepted = contract.parseCoverContentAnalysis(analysis, input, [visual]);
  assert.equal(accepted.visualBrief.subject, "@图1中的女性", "Only the numeric-check copy may lose reference labels");
  const fullwidth = clone(analysis); fullwidth.visualBrief.subject = "＠图１中的女性";
  assert.equal(contract.parseCoverContentAnalysis(fullwidth, input, [visual]).visualBrief.subject, fullwidth.visualBrief.subject);
  for (const [subject, code] of [["@图2中的女性", "COVER_IMAGE_REFERENCE_MISSING"], ["@图1中的20岁女性", "ANALYSIS_UNGROUNDED_CLAIM"],
    ["20岁女性", "ANALYSIS_UNGROUNDED_CLAIM"], ["图1中的女性", "ANALYSIS_UNGROUNDED_CLAIM"]]) {
    const rejected = clone(analysis); rejected.visualBrief.subject = subject;
    assert.throws(() => contract.parseCoverContentAnalysis(rejected, input, [visual]), error => error.code === code, subject);
  }
  for (const target of ["primary", "secondary", "candidate"]) {
    const rejected = clone(analysis);
    if (target === "primary") { rejected.primaryTitle = "@图1自在微笑"; rejected.titleCandidates[0].text = rejected.primaryTitle; }
    if (target === "secondary") rejected.secondaryTitle = "@图1中的人";
    if (target === "candidate") rejected.titleCandidates.push({ id: "t2", text: "@图1自在微笑", evidenceRefs: ["e1"] });
    assert.throws(() => contract.parseCoverContentAnalysis(rejected, input, [visual]), error => error.code === "ANALYSIS_IMAGE_REFERENCE_IN_TITLE", target);
  }
  const manual = "@图1自在微笑", locked = { ...input, manualTitle: manual }, manualAnalysis = clone(analysis);
  manualAnalysis.primaryTitle = manual; manualAnalysis.titleCandidates[0].text = manual;
  assert.equal(contract.parseCoverContentAnalysis(manualAnalysis, locked, [visual]).primaryTitle, manual);
  const badManual = "@图2自在微笑"; manualAnalysis.primaryTitle = badManual; manualAnalysis.titleCandidates[0].text = badManual;
  assert.throws(() => contract.parseCoverContentAnalysis(manualAnalysis, { ...input, manualTitle: badManual }, [visual]), error => error.code === "COVER_IMAGE_REFERENCE_MISSING");
  const product = { ...input, contentKind: "product" }, productAnalysis = clone(analysis);
  productAnalysis.visualBrief.subject = "@图1中的500毫升水杯";
  assert.throws(() => contract.parseCoverContentAnalysis(productAnalysis, product, [visual]), error => error.code === "ANALYSIS_UNGROUNDED_CLAIM");
  checks.push("only verified image-reference offsets are excluded from numeric checking; unknown/bare references, new ages/specs and automatic title labels reject while exact locked titles retain binding validation");
}

const samplePath = path.join(root, ".codex-evidence/cover-paid-20261106-3fd15654/analysis-failure/owned-reparse-input.json");
const localSample = existsSync(samplePath) ? JSON.parse(readFileSync(samplePath, "utf8")) : null;
const funnyPath = path.join(root, ".codex-evidence/cover-paid-20261106-3fd15654/four-modes/funny_action/analysis-diagnostic.json");
const funnySample = existsSync(funnyPath) ? JSON.parse(readFileSync(funnyPath, "utf8")) : null;
const sample = localSample || { operationId: id, materials: { ...materials, text: "它只是把自己的饭点排在了你的作息后面，你几点关灯，它就几点开饭" },
  parsed: { analysis: { ...clone(baseline), topic: "等待主人", primaryTitle: "等你关灯才开饭", titleCandidates: [{ id: "t1", text: "等你关灯才开饭", evidenceRefs: ["e1"] }],
    visualBrief: { subject: "一只狗", action: "等待主人关灯后开饭", scene: "日常居家", emotion: "等待与陪伴" },
    evidence: [{ id: "e1", source: "text", quote: "你几点关灯，它几点开饭", fields }] }, visualObservations: [] } };
function fixture({ parentState = "failed", corrupt, badQuote = false, ownedSample = sample, rawContent } = {}) {
  const sampleMaterials = clone(ownedSample.materials);
  const body = clone(ownedSample.parsed);
  if (badQuote) body.analysis.evidence[0].quote = "你几点不关灯，它几点开饭";
  const billing = ownedSample.billing ? { credits_charged: ownedSample.billing.credits_charged, operation_id: ownedSample.billing.operation_id }
    : { credits_charged: 2.63, operation_id: "fixture-existing-paid-wallet" };
  const payload = { choices: [{ message: { content: rawContent ?? JSON.stringify(body) } }], _billing: billing };
  const analysisKey = `cover_analysis_${sha(`${owner}:${sampleMaterials.clientRequestId}`).slice(0, 48)}`;
  const recordId = sha(`${owner}\0${analysisKey}`), raw = JSON.stringify(payload), responseHash = sha(raw);
  const parent = { id: ownedSample.operationId, user_id: owner, client_request_id: sampleMaterials.clientRequestId,
    material_fingerprint: "m".repeat(64), revision: sampleMaterials.materialRevision, state: parentState, materials: sampleMaterials,
    preparation: { analysisPayloadFingerprint: "a".repeat(64), route: "text_to_image", style: clone(contract.resolveCoverStyle(sampleMaterials.styleKey)),
      outputSpec: contract.coverOutputSpec(sampleMaterials.outputRatio), generationSpec: { modelId: sampleMaterials.modelId, resolution: "2K",
        aspectRatio: sampleMaterials.outputRatio, outputRatio: sampleMaterials.outputRatio, ratioEvidence: "declared_native" },
      quote: { image: { modelName: "fixture image" } },
      ...(ownedSample.workflowVersion === 3 ? { workflowVersion: 3, recordKind: "analysis", analysisPromptVersion: prompts.COVER_ANALYSIS_PROMPT_VERSION } : {}) },
    result: null, billing: clone(billing), consent: { analysis: true, ...(ownedSample.workflowVersion === 3 ? {} : { image: true }) },
    analysis_request_id: analysisKey, analysis_attempt_id: recordId, error_code: ownedSample.code || "ANALYSIS_EVIDENCE_INVALID",
    created_at: "2026-11-06T00:00:00.000Z", updated_at: "2026-11-06T00:00:00.000Z" };
  const child = { record_id: recordId, user_id: owner, client_request_id: analysisKey, state: "succeeded", attempt_no: 1,
    payload_fingerprint: "a".repeat(64), http_status: 200, response_body: raw, response_fingerprint: responseHash,
    result_reference: `llm-result:${recordId}:1:${responseHash}` };
  if (corrupt === "owner") child.user_id = other;
  if (corrupt === "key") child.client_request_id = "another-request";
  if (corrupt === "record") child.record_id = "0".repeat(64);
  if (corrupt === "payload") child.payload_fingerprint = "0".repeat(64);
  if (corrupt === "hash") child.response_fingerprint = "0".repeat(64);
  if (corrupt === "reference") child.result_reference = "nonempty-but-wrong";
  if (corrupt === "http") child.http_status = 201;
  if (corrupt === "billing") parent.billing.credits_charged = 2.64;
  if (corrupt === "unknown") child.state = "failed_unknown";
  const state = { actor: owner, parent, child, mutations: [], reads: [], successfulRecoveries: 0 };
  const fieldValue = (row, field) => field.includes("->>") ? row[field.split("->>")[0]]?.[field.split("->>")[1]] : row[field];
  const db = { from(table) {
    assert.ok(["cover_prepare_operations", "llm_request_attempts"].includes(table), `Unexpected table ${table}`);
    const filters = []; let patch;
    const query = { select() { return query; }, eq(field, value) { filters.push([field, value]); return query; }, order() { return query; }, limit() { return query; },
      update(value) { assert.equal(table, "cover_prepare_operations"); patch = value; return query; },
      async maybeSingle() {
        state.reads.push(table);
        const row = table === "cover_prepare_operations" ? state.parent : state.child;
        if (!filters.every(([field, value]) => String(fieldValue(row, field)) === String(value))) return { data: null, error: null };
        if (patch) { state.mutations.push({ patch: clone(patch), filters: clone(filters) });
          if (row.state === "failed" && patch.state === "plan_ready") state.successfulRecoveries++;
          Object.assign(row, clone(patch)); }
        return { data: clone(row), error: null };
      } };
    return query;
  } };
  const imports = { "@/storage/database/supabase-client": { getSupabaseClient: () => db },
    "@/lib/llm-request-idempotency": { fingerprintLlmRequest: forbidden },
    "@/lib/current-api-user": { authorizeCurrentApiUser: async () => ({ ok: true, user: { userId: state.actor } }) },
    "@/app/api/llm/route": { POST: () => { modelCalls++; throw new Error("Original paid analysis recovery must not dispatch a model"); } },
    "@/app/api/cover-models/route": { GET: forbidden }, "@/storage/object": { storageManager: new Proxy({}, { get: () => forbidden }) },
    sharp: { default: forbidden }, "@/lib/manga-agent-model-policy": { buildMangaAgentModelCatalog: forbidden } };
  const load = loader(imports), route = load("src/app/api/cover/prepare/route.ts");
  async function get() { const response = await route.GET(new NextRequest(`https://fixture.invalid/api/cover/prepare?operationId=${parent.id}`));
    return { status: response.status, body: await response.json() }; }
  async function post() { const response = await route.POST(new NextRequest("https://fixture.invalid/api/cover/prepare", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "analyze", operationId: parent.id, consent: { analysis: true, image: true } }) }));
    return { status: response.status, body: await response.json() }; }
  return { state, get, post, load, originalRaw: raw, originalBilling: clone(billing) };
}
{
  const test = fixture();
  const response = await test.get();
  assert.equal(response.status, 200); assert.equal(response.body.status, "plan_ready", JSON.stringify(response.body.analysisIssue));
  assert.deepEqual(test.state.parent.billing, test.originalBilling); assert.equal(test.state.child.response_body, test.originalRaw);
  assert.equal(test.state.successfulRecoveries, 1); assert.equal(test.state.parent.error_code, null);
  const audit = test.state.parent.result.analysisSourceAudit;
  assert.equal(response.body.analysisSourceAudit, undefined, "Private source audit stays in the saved result, outside the public projection");
  assert.ok(audit.repairs.some(item => item.evidenceId === "e1" && item.kind === "source_inserted_particles"));
  assert.ok(response.body.analysis.evidence.every(item => item.source !== "text" || test.state.parent.materials.text.includes(item.quote)));
  assert.equal(test.state.parent.result.analysisRecovery.newAnalysisCalls, 0); assert.equal(test.state.parent.result.analysisRecovery.reusedPaidResponse, true);
  assert.equal(response.body.renderPlan.titleStyle.colorMode, "palette");
  const mutation = test.state.mutations.find(item => item.patch.state === "plan_ready");
  assert.equal(Object.hasOwn(mutation.patch, "billing"), false);
  for (const key of ["user_id", "client_request_id", "analysis_request_id", "analysis_attempt_id", "state", "error_code", "updated_at", "billing->>operation_id", "billing->>credits_charged"]) {
    assert.ok(mutation.filters.some(([field]) => field === key), `Paid recovery must fence ${key}`);
  }
  checks.push(localSample ? "actual locally supplied paid Claude reply revalidates the unique omitted particle, preserves original child bytes/fees and reaches plan_ready with zero model calls"
    : "portable old paid-reply fixture revalidates its unique omitted particle and reaches plan_ready without changing fees or child bytes");
}
{
  const paidPath = path.join(root, ".codex-evidence/cover-rebuild-20261106-bc1a/review-real-r1690/cases/haoyun-cat-review-v3/analysis-response-private.json");
  if (existsSync(paidPath)) {
    const receiptBytes = readFileSync(paidPath, "utf8"); const paid = JSON.parse(receiptBytes);
    const cases = JSON.parse(readFileSync(path.join(root, ".codex-evidence/cover-rebuild-20261106-bc1a/acceptance-cases-review-v3.json"), "utf8"));
    const source = cases.cases.find(item => item.id === "haoyun-cat-review-v3");
    assert.ok(source); assert.equal(paid.operationId, "986c3169-4b22-4187-8ab8-ecbc7ba61dd3");
    assert.equal(paid.billing.credits_charged, 5.7); assert.throws(() => JSON.parse(paid.content));
    const sourceMaterials = contract.parseCoverPrepareInput({ clientRequestId: "actual_paid_v3_transport_fixture", text: source.text,
      assets: [], styleKey: source.style, outputRatio: source.ratio, modelId: source.modelId, resolution: source.resolution });
    const parser = pure("src/lib/cover-analysis-envelope.ts"); const recovered = parser.parseCoverAnalysisEnvelope(paid.content);
    assert.equal(recovered.normalization.kind, "single_trailing_envelope_closure");
    assert.equal(recovered.normalization.offset, paid.content.length - 1);
    assert.equal(recovered.normalization.originalSha256, sha(paid.content));
    assert.equal(recovered.normalization.normalizedSha256, sha(paid.content.slice(0, -1)));
    assert.equal(JSON.stringify(recovered.value), paid.content.slice(0, -1));
    const semantic = contract.parseCoverContentAnalysis(recovered.value.analysis, sourceMaterials);
    assert.ok(semantic.contentBreakdown && semantic.layoutIntent);
    assert.equal(semantic.primaryTitle, recovered.value.analysis.primaryTitle);
    assert.ok(semantic.evidence.every(item => item.source !== "text" || source.text.includes(item.quote)));
    for (const corrupt of [value => { value.contentBreakdown.summary.text += " 每天二十分钟"; },
      value => { value.contentBreakdown.coverFocus.text += " 全网最低"; },
      value => { value.evidence[0].sourceSpanId = "missing_source_span"; }]) {
      const invalid = clone(recovered.value.analysis); corrupt(invalid);
      assert.throws(() => contract.parseCoverContentAnalysis(invalid, sourceMaterials), error => ["ANALYSIS_UNGROUNDED_CLAIM", "ANALYSIS_EVIDENCE_INVALID"].includes(error.code));
    }
    const test = fixture({ rawContent: paid.content, ownedSample: { operationId: paid.operationId, materials: sourceMaterials,
      parsed: clone(recovered.value), billing: paid.billing, code: "COVER_ANALYSIS_FORMAT_INVALID", workflowVersion: 3 } });
    const result = await test.get();
    assert.equal(result.status, 200); assert.equal(result.body.status, "review_ready", JSON.stringify(result.body.analysisIssue));
    assert.equal(test.state.parent.state, "plan_ready"); assert.equal(test.state.successfulRecoveries, 1);
    assert.equal(test.state.parent.result.analysisTransportNormalization.kind, "single_trailing_envelope_closure");
    assert.equal(test.state.parent.result.analysisTransportNormalization.originalSha256, sha(paid.content));
    assert.equal(test.state.parent.result.analysisRecovery.newAnalysisCalls, 0);
    assert.equal(test.state.parent.result.analysisRecovery.reusedPaidResponse, true);
    assert.equal(result.body.generationInput, undefined); assert.equal(result.body.analysisTransportNormalization, undefined);
    assert.deepEqual(test.state.parent.billing, test.originalBilling); assert.equal(test.state.child.response_body, test.originalRaw);
    assert.equal(readFileSync(paidPath, "utf8"), receiptBytes); assert.equal(modelCalls, 0);
    checks.push("actual 5.70-credit V3 reply 986c3169 passes full source-evidence/schema/quantity checks and real prepare GET/CAS recovery to review_ready with private normalization audit, unchanged original reply/bill and zero LLM calls");
  }
}
{
  const paidPath = path.join(root, ".codex-evidence/cover-rebuild-20261106-bc1a/review-real-r1692/cases/haoyun-person-pet-review-v3/original-analysis-diagnostic.json");
  if (existsSync(paidPath)) {
    const bytes = readFileSync(paidPath, "utf8"), paid = JSON.parse(bytes);
    const raw = pure("src/lib/cover-analysis-envelope.ts").parseCoverAnalysisEnvelope(paid.content).value;
    const canonical = spans.hydrateCoverAnalysisEvidence(raw.analysis, paid.materials).value;
    const prepared = contract.prepareCoverContentAnalysisEvidence(raw.analysis, paid.materials);
    const normalization = prepared.sourceAudit.narrativeSummaryNormalization;
    assert.equal(normalization.kind, "leading_indefinite_narrative_event");
    assert.equal(normalization.fieldPath, "contentBreakdown.summary");
    assert.equal(normalization.originalText, raw.analysis.contentBreakdown.summary.text);
    assert.equal(normalization.normalizedText, normalization.originalText.slice(2));
    assert.equal(contract.parseCoverContentAnalysis(raw.analysis, paid.materials).status, "ready");
    assert.equal(contract.prepareCoverContentAnalysisEvidence(prepared.value, paid.materials).sourceAudit.narrativeSummaryNormalization, undefined);
    for (const text of ["一次使用就有效的观察，让人相信产品。", "一次训练便见效的经历，让人改变。", "一次服药后的经历，让人改变。",
      "仅一次互动，就改变了关系。", "只有一次游戏，就有变化。", "第一次互动，让人改变。", "一次性的游戏，让人改变。",
      "一次每周进行的互动，让人改变。", "一次单次的游戏，让人改变。",
      "一次三次扔球游戏，让人改变。", "三次扔球游戏，让人改变。", "一次疗程后的观察，让人改变。", "一次广告中的游戏，让人改变。",
      "一次心不在焉的扔球游戏，让人每天多玩三次。", "一次游戏后" ]) {
      const bad = clone(canonical); bad.contentBreakdown.summary.text = text;
      assert.throws(() => contract.parseCoverContentAnalysis(bad, paid.materials), error => error.code === "ANALYSIS_UNGROUNDED_CLAIM", text);
    }
    const product = clone(canonical);
    assert.throws(() => contract.parseCoverContentAnalysis(product, { ...paid.materials, contentKind: "product" }), error => error.code === "ANALYSIS_UNGROUNDED_CLAIM");
    const noArticle = clone(canonical); noArticle.contentBreakdown.summary.text = "每次游戏，让人改变。";
    const unchanged = contract.prepareCoverContentAnalysisEvidence(noArticle, paid.materials);
    assert.equal(unchanged.value.contentBreakdown.summary.text, noArticle.contentBreakdown.summary.text);
    assert.equal(unchanged.sourceAudit.narrativeSummaryNormalization, undefined, "An unnumbered frequency phrase is outside this normalization, not an article to remove");
    for (const scope of [{ ...paid.materials, assets: [{ assetId: "00000000-0000-4000-8000-000000000004", role: "style_reference" }] },
      { ...paid.materials, imageMode: "compose" }, { ...paid.materials, text: paid.materials.text + "我们进行了三次扔球游戏。" }]) {
      const refused = contract.prepareCoverContentAnalysisEvidence(canonical, scope);
      assert.equal(refused.value.contentBreakdown.summary.text, canonical.contentBreakdown.summary.text);
      assert.equal(refused.sourceAudit.narrativeSummaryNormalization, undefined);
    }
    const badTitle = clone(canonical); badTitle.primaryTitle = "一次扔球游戏"; badTitle.titleCandidates[0].text = badTitle.primaryTitle;
    assert.throws(() => contract.parseCoverContentAnalysis(badTitle, paid.materials), error => error.code === "ANALYSIS_UNGROUNDED_CLAIM" && error.details.fieldPath === "primaryTitle");
    const conflict = clone(canonical), conflictSource = "我们进行了三次扔球游戏。";
    conflict.evidence.find(item => item.id === "e2").quote = conflictSource;
    assert.throws(() => contract.parseCoverContentAnalysis(conflict, { ...paid.materials, text: paid.materials.text + conflictSource }), error => error.code === "ANALYSIS_UNGROUNDED_CLAIM");
    const test = fixture({ rawContent: paid.content, ownedSample: { operationId: paid.operationId, materials: paid.materials,
      parsed: clone(raw), billing: paid.billing, code: paid.errorCode, workflowVersion: 3 } });
    const response = await test.get();
    assert.equal(response.status, 200); assert.equal(response.body.status, "review_ready", JSON.stringify(response.body.analysisIssue));
    assert.equal(test.state.parent.result.analysis.contentBreakdown.summary.text, normalization.normalizedText);
    assert.equal(test.state.parent.result.analysisSourceAudit.narrativeSummaryNormalization.originalText, normalization.originalText);
    assert.equal(response.body.analysisSourceAudit, undefined);
    assert.equal(test.state.parent.result.analysisRecovery.newAnalysisCalls, 0);
    assert.equal(test.state.child.response_body, test.originalRaw); assert.deepEqual(test.state.parent.billing, test.originalBilling);
    assert.equal(readFileSync(paidPath, "utf8"), bytes); assert.equal(modelCalls, 0);
    checks.push("actual 0.22-credit person/pet reply recovers by removing only the leading indefinite script-summary article with private deterministic audit; title/product/only-first-frequency/multiple-count/regimen/advertising and conflicting source counts stay rejected, original response/bill unchanged with zero LLM calls");
  }
}
{
  const illustration = (text, scene, extraMaterials = {}) => ({ input: { ...materials, text, ...extraMaterials }, value: { ...clone(baseline),
    primaryTitle: "开始行动", titleCandidates: [{ id: "t1", text: "开始行动", evidenceRefs: ["e1"] }],
    visualBrief: { ...baseline.visualBrief, scene }, evidence: [{ id: "e1", source: "text", quote: text, fields }] } });
  for (const scene of ["一杯咖啡", "一张清单", "一台电脑", "一盏台灯", "一本书", "一把椅子"]) {
    const { input, value } = illustration("咖啡泡好了，准备开始工作。", scene);
    assert.equal(contract.parseCoverContentAnalysis(value, input).visualBrief.scene, scene, "Canonical scene must stay intact");
  }
  for (const [text, scene, extra] of [["桌边有两杯咖啡，准备工作。", "一杯咖啡", {}], ["房间有两盏台灯，准备工作。", "一盏台灯", {}],
    ["桌边没有一杯咖啡，准备工作。", "一杯咖啡", {}],
    ["咖啡泡好了，准备开始工作。", "每盒一杯咖啡", { contentKind: "product" }], ["咖啡泡好了，准备开始工作。", "一箱咖啡", {}],
    ["咖啡泡好了，准备开始工作。", "一杯500毫升咖啡", {}], ["咖啡泡好了，准备开始工作。", "只有一杯咖啡", {}]]) {
    const { input, value } = illustration(text, scene, extra);
    assert.throws(() => contract.parseCoverContentAnalysis(value, input), error => error.code === "ANALYSIS_UNGROUNDED_CLAIM", scene);
  }
  const title = illustration("咖啡泡好了，准备开始工作。", "咖啡");
  title.value.primaryTitle = "一杯咖啡"; title.value.titleCandidates[0].text = title.value.primaryTitle;
  assert.throws(() => contract.parseCoverContentAnalysis(title.value, title.input), error => error.code === "ANALYSIS_UNGROUNDED_CLAIM");
  if (funnySample) {
    const test = fixture({ ownedSample: funnySample });
    const response = await test.get();
    assert.equal(response.body.status, "plan_ready", JSON.stringify(response.body.analysisIssue));
    assert.ok(response.body.analysis.visualBrief.scene.includes("一杯"));
    assert.deepEqual(test.state.parent.billing, test.originalBilling); assert.equal(test.state.child.response_body, test.originalRaw);
    assert.equal(test.state.parent.result.analysisRecovery.newAnalysisCalls, 0); assert.equal(test.state.successfulRecoveries, 1);
  }
  checks.push("creative script scenes admit indefinite single visual entities without altering canonical text; explicit differing counts, product/package/spec/title quantities stay strict and the local paid coffee reply replays with zero model calls");
}
{
  const point = { text: materials.text, evidenceRefs: ["e1"] };
  const broken = { text: "未经证明的商品承诺", evidenceRefs: ["e1", "e7"] };
  const analysis = { ...clone(baseline), visualBrief: { ...baseline.visualBrief, subject: "原文主体" },
    layoutIntent: { structure: "single", focus: "action", evidenceRefs: ["e1"] },
    contentBreakdown: { summary: point, keyPoints: [broken, point], logic: { ...broken, evidenceRefs: ["e1", "e7", "e8"] }, coverFocus: point } };
  const ownedSample = { operationId: id, materials: { ...materials, contentKind: "product" }, workflowVersion: 3,
    billing: { credits_charged: 0.53, operation_id: "fixture-product-analysis" }, parsed: { analysis, visualObservations: [] } };
  const test = fixture({ ownedSample });
  const recovered = await test.get();
  assert.equal(recovered.body.status, "review_ready", JSON.stringify(recovered.body.analysisIssue));
  assert.deepEqual(clone(recovered.body.analysis.contentBreakdown), { summary: point, keyPoints: [point, point], logic: point, coverFocus: point });
  assert.equal(recovered.body.analysis.primaryTitle, analysis.primaryTitle);
  assert.equal(test.state.parent.result.analysisSourceAudit.breakdownSourceReplacements.length, 2);
  assert.deepEqual(test.state.parent.billing, test.originalBilling);
  assert.equal(test.state.child.response_body, test.originalRaw);
  await test.get();
  assert.equal(test.state.successfulRecoveries, 1);

  const unverifiable = clone(ownedSample);
  unverifiable.parsed.analysis.contentBreakdown.logic.evidenceRefs = ["e8"];
  const stopped = fixture({ ownedSample: unverifiable });
  const failed = await stopped.get();
  assert.equal(failed.body.status, "failed");
  assert.equal(failed.body.analysisIssue.fieldPath, "contentBreakdown.logic");
  assert.equal(failed.body.analysisIssue.canRecoverFromReceipt, false);
  assert.equal(failed.body.analysisIssue.action, "edit_materials");
  const mutations = stopped.state.mutations.length;
  await stopped.get();
  assert.equal(stopped.state.mutations.length, mutations);
  assert.deepEqual(stopped.state.parent.billing, stopped.originalBilling);
  assert.equal(stopped.state.child.response_body, stopped.originalRaw);
  checks.push("paid product replay replaces only broken editorial claims with owned verbatim source; unsupported references stop once, with no rebilling");
}
for (const corrupt of ["owner", "key", "record", "payload", "hash", "reference", "http", "billing"]) {
  const test = fixture({ corrupt }); const oldBilling = clone(test.state.parent.billing);
  const response = await test.get();
  assert.equal(response.body.status, "failed", corrupt); assert.equal(test.state.successfulRecoveries, 0, corrupt);
  assert.deepEqual(test.state.parent.billing, oldBilling); assert.equal(modelCalls, 0);
}
{
  const test = fixture(); test.state.actor = other;
  assert.equal((await test.get()).body.status, "empty"); assert.equal((await test.post()).status, 404);
  assert.equal(test.state.reads.includes("llm_request_attempts"), false);
}
checks.push("cross-owner, wrong original key/record/payload/response SHA/result reference/status or changed billing cannot authorize paid failed→ready");
{
  const test = fixture({ badQuote: true }); const response = await test.get();
  assert.equal(response.body.status, "failed"); assert.equal(test.state.parent.result.analysisIssue.category, "source_reference");
  assert.equal(response.body.analysisIssue.fieldPath, "evidence.0.quote"); assert.equal(response.body.analysisIssue.evidenceId, "e1");
  assert.deepEqual(test.state.parent.billing, test.originalBilling); assert.equal(test.state.successfulRecoveries, 0);
  const unknown = fixture({ parentState: "unknown", corrupt: "unknown" });
  assert.equal((await unknown.post()).body.status, "unknown"); assert.equal(modelCalls, 0);
  checks.push("irreparable negation exposes the classified field/reference reason and preserves billing; unknown recovery only reads its original child");
}
{
  const test = fixture(); const responses = await Promise.all([test.get(), test.get()]);
  assert.ok(responses.every(response => response.body.status === "plan_ready")); assert.equal(test.state.successfulRecoveries, 1);
  const service = test.load("src/lib/server/cover-prepare-service.ts");
  const json = JSON.stringify({ analysis: baseline, visualObservations: [] });
  assert.deepEqual(clone(service.extractCoverLlmJson({ choices: [{ message: { content: [{ type: "text", text: json }] } }] })), JSON.parse(json));
  assert.throws(() => service.extractCoverLlmJson({ content: `explanation ${json}` }), error => error.code === "COVER_ANALYSIS_FORMAT_INVALID");
  assert.throws(() => service.extractCoverLlmJson({ content: [{ type: "tool_result", text: json }] }), error => error.code === "COVER_ANALYSIS_FORMAT_INVALID");
  checks.push("concurrent verified recovery acquires one parent CAS; explicit text-block transport is accepted while prose/unknown block extraction is rejected");
}
assert.equal(networkCalls, 0); assert.equal(modelCalls, 0);
console.log(JSON.stringify({ passed: true, checks: checks.length, networkCalls, providerCalls: modelCalls, liveDatabaseCalls: 0,
  localPaidResponseReparsed: Boolean(localSample), localFunnyResponseReparsed: Boolean(funnySample), evidence: "Actual strict parser, span hydration, prompts, service, owner-bound prepare GET/POST and fenced repository; original paid response content is local optional evidence, auth/child/DB/billing are fixtures, no live fee or provider claim.", cases: checks }, null, 2));
