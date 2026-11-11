import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { z } from "zod";
import * as config from "../src/lib/server/cover-style-config";
import * as defaults from "../src/lib/server/cover-style-defaults";
import * as compiler from "../src/lib/cover-workbench-prompts";
import * as publication from "../src/lib/server/cover-workflow-publication";
import * as eligibility from "../src/lib/text-model-eligibility";
import * as activation from "../src/lib/model-activation-gate";
import * as pricing from "../src/lib/text-model-pricing";
import * as inputCapability from "../src/lib/llm-input-capability";

const effects = { network: 0, database: 0, provider: 0, secret: 0 };
const forbidden = () => { effects.network++; throw new Error("LIVE_EFFECT_FORBIDDEN"); };
const checks: string[] = [];
const savedFetch = globalThis.fetch; globalThis.fetch = forbidden;
function load(file: string, imports: Record<string, unknown>): Record<string, unknown> {
  const source = readFileSync(file, "utf8"), moduleContainer = { exports: {} };
  const output = ts.transpileModule(source, { fileName: file, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } });
  vm.runInNewContext(output.outputText, { module: moduleContainer, exports: moduleContainer.exports, Buffer, console, structuredClone,
    require(id: string) { assert.ok(Object.hasOwn(imports, id), `Unexpected executable dependency ${id}`); return imports[id]; } }, { filename: file });
  return moduleContainer.exports;
}
const publicIds = { toPublicModelId: (_kind: string, id: string) => `pm_fixture_${id}`, publicModelDisplayName: (row: Record<string, unknown>) => String(row.name),
  toPublicModelDto: (_kind: string, row: Record<string, unknown>, _index: number, capabilities: Record<string, unknown>) => ({
    id: `pm_fixture_${row.id}`, displayName: String(row.name), capabilities, variantLabel: "A", avatarUrl: "", publicPrice: 0 }) };
const modelPolicy = load("src/lib/manga-agent-model-policy.ts", { "@/lib/model-activation-gate": activation,
  "@/lib/public-model-dto": publicIds, "@/lib/text-model-eligibility": eligibility, "@/lib/text-model-pricing": pricing });
const catalog = defaults.createDefaultCoverStyleCatalog();
const runtime = load("src/lib/server/cover-admin-runtime.ts", { "server-only": {}, zod: { z },
  "@/storage/database/supabase-client": { getSupabaseClient: () => { effects.database++; throw new Error("LIVE_DATABASE_FORBIDDEN"); } },
  "../manga-agent-model-policy": modelPolicy, "../public-model-dto": publicIds, "../text-model-eligibility": eligibility,
  "../llm-input-capability": inputCapability, "../cover-workbench-prompts": compiler, "./cover-style-config": config,
  "./cover-workflow-publication": publication, "./cover-style-defaults": defaults,
  "./cover-style-store": { loadCoverStyleCatalog: async () => ({ catalog }), publishedCoverWorkflow: () => defaults.createDefaultCoverWorkflowRelease() },
}) as unknown as typeof import("../src/lib/server/cover-admin-runtime");
const model = (id: string, image: unknown, sort: number) => ({ id, name: `Fixture ${id}`, model_name: `fixture-${id}`, category: "text", is_active: true,
  is_hidden: false, user_access: "all", image_parsing: image, sort_order: sort, token_billing_enabled: true,
  input_cost_per_million: 1, output_cost_per_million: 2, cached_cost_per_million: 0, profit_margin: 10, token_rounding_unit: 0,
  max_context_tokens: 65_536, max_reply_tokens: 6000 });
const rows = [model("text", false, 0), model("vision", true, 1), { ...model("hidden", true, 2), is_hidden: true },
  { ...model("unpriced", true, 3), output_cost_per_million: null }, model("typo", "yes-but-unknown", 4)];
const db = { from(table: string) { assert.equal(table, "llm_models"); return { select: () => ({ order: async () => ({ data: rows, error: null }) }) }; } } as unknown as Parameters<typeof runtime.readCoverAnalysisModelOptions>[0];
const base = defaults.createDefaultCoverWorkflowRelease();
async function main() {
  const autoText = runtime.selectCoverAnalysisModel(rows, base, false), autoImage = runtime.selectCoverAnalysisModel(rows, base, true);
  assert.equal(autoText.internalId, "text"); assert.equal(autoText.id, "pm_fixture_text"); assert.equal(autoImage.internalId, "vision");
  const pinned = { ...base, textModelId: "vision", imageModelId: "vision" };
  assert.equal(runtime.selectCoverAnalysisModel(rows, pinned, false).internalId, "vision");
  for (const bad of ["missing", "hidden", "unpriced"]) assert.throws(() => runtime.selectCoverAnalysisModel(rows, { ...base, textModelId: bad }, false), /所配置的分析模型/u);
  for (const bad of ["text", "typo"]) assert.throws(() => runtime.selectCoverAnalysisModel(rows, { ...base, imageModelId: bad }, true), /所配置的分析模型/u);
  checks.push("raw configured IDs resolve through the actual published/visible/priced catalog; wrong-mode, hidden, unknown-vision and unpriced pins never auto-fallback");
  const options = await runtime.readCoverAnalysisModelOptions(db);
  assert.ok(options.some(option => option.id === "hidden" && !option.available)); assert.ok(options.some(option => option.id === "vision" && option.imageParsing));
  assert.ok(options.every(option => Object.keys(option).every(key => ["id", "displayName", "imageParsing", "available", "reason"].includes(key))));
  await runtime.validateCoverWorkflowModels(pinned, db, catalog);
  await assert.rejects(() => runtime.validateCoverWorkflowModels({ ...pinned, imageModelId: "text" }, db), /所配置的分析模型/u);
  checks.push("private model DTO is allowlisted and publication accepts complete immutable release targets while enforcing the vision slot");
  const sharedRules = "PRIVATE_GLOBAL_SENTINEL：先按当前文案确定唯一关系，再围绕关系表达标题。";
  for (const mode of ["script", "product", "reference", "compose"] as const) {
    const preview = await runtime.previewCoverAnalysisRuntime({ mode, workflowDraft: { sharedRules, textModelId: "text", imageModelId: "vision" } }, db);
    const input = publication.coverAdminPreviewMaterials(mode);
    const style = mode === "script" ? config.runtimeCoverStyle(catalog.entries[0].releases[0], catalog.entries[0].current!.publishedAt) : undefined;
    const workflowPayload = { ...base, sharedRules, textModelId: "text", imageModelId: "vision", releaseId: "preview:workflow" };
    const workflow = { ...workflowPayload, snapshotSha256: config.coverWorkflowReleaseHash(workflowPayload) };
    const exact = compiler.compileCoverAnalysisInputTemplate(input, [], style, workflow);
    assert.equal(preview.systemPrompt, exact.systemPrompt); assert.equal(preview.userMessage, exact.userMessage);
    assert.ok(preview.systemPrompt.includes(sharedRules)); assert.ok(!preview.systemPrompt.includes(defaults.COVER_BENCHMARK_ANALYSIS_RULES[0]));
    assert.ok(!preview.systemPrompt.includes("让人想知道这件具体事情的原因或后续"));
    assert.ok(!preview.systemPrompt.includes("将前序动作写成此刻已完成的道具状态"));
    assert.ok(preview.systemPrompt.includes("keyPoints必须有1至4项"));
    assert.equal(preview.styleApplied, mode === "script"); assert.equal(preview.model.id, mode === "reference" || mode === "compose" ? "vision" : "text");
    const textUnits = exact.systemPrompt.length + (exact.parts ? exact.parts.reduce((sum, part) => sum + (part.type === "text" ? part.text.length : 0), 0) : exact.userMessage.length);
    assert.equal(preview.textUnits, textUnits); if (exact.parts) assert.ok(preview.userMessage.includes("实际第1张图片"));
  }
  checks.push("all four modes replace shared business rules once, use actual style applicability and compare byte-exact compiler/transport text including image binding labels");
  const materials = publication.coverAdminPreviewMaterials("script"), dep1 = compiler.coverAnalysisDependencySnapshot(materials, undefined, base);
  const editedPayload = { ...base, sharedRules, releaseId: "global-next" }, edited = { ...editedPayload, snapshotSha256: config.coverWorkflowReleaseHash(editedPayload) };
  const dep2 = compiler.coverAnalysisDependencySnapshot(materials, undefined, edited);
  assert.notEqual(config.coverStyleHash(dep1), config.coverStyleHash(dep2));
  assert.notEqual(autoText.fingerprint, runtime.selectCoverAnalysisModel(rows, pinned, false).fingerprint);
  assert.equal(autoText.fingerprint, runtime.selectCoverAnalysisModel(rows.map(row => ({ ...row, sort_order: Number(row.sort_order) + 100 })), base, false).fingerprint);
  checks.push("effective common-rule release and actual selected-model identity produce separate reuse dependencies; sort-only changes retain selected identity");
  const oversized = structuredClone(catalog); const release = oversized.entries[0].releases[0];
  release.generationPrompt = "巨".repeat(45_000); release.snapshotSha256 = config.coverStyleReleaseHash(release);
  assert.throws(() => publication.validateCoverWorkflowPublication(oversized), /保存预算/u);
  const dormant = structuredClone(catalog); const draft = { ...dormant.entries[0].releases[0], releaseId: "draft-large", version: "2.0.0", sequence: 2,
    generationPrompt: "巨".repeat(45_000) }; draft.snapshotSha256 = config.coverStyleReleaseHash(draft);
  dormant.entries[0].releases.push(draft); dormant.entries[0].draftReleaseId = draft.releaseId;
  publication.validateCoverWorkflowPublication(dormant);
  const tinyRows = rows.map(row => row.id === "vision" ? { ...row, max_context_tokens: 20_000 } : row);
  const tinyDb = { from: () => ({ select: () => ({ order: async () => ({ data: tinyRows, error: null }) }) }) } as unknown as typeof db;
  await assert.rejects(() => runtime.validateCoverWorkflowModels(pinned, tinyDb, catalog), /上下文预算/u);
  checks.push("publication rejects UTF-8 duplicated frozen generation rules and actual pinned context overflow; an unrelated oversized draft cannot block an active release");
  await assert.rejects(() => runtime.previewCoverAnalysisRuntime({ mode: "script", injected: true } as never, db), /格式无效/u);
  catalog.entries[0].enabled = false;
  await assert.rejects(() => runtime.previewCoverAnalysisRuntime({ mode: "script", styleKey: catalog.entries[0].styleKey }, db), /已停用/u);
  assert.equal((await runtime.previewCoverAnalysisRuntime({ mode: "script", styleKey: catalog.entries[0].styleKey,
    releaseId: catalog.entries[0].current!.releaseId }, db)).styleApplied, true);
  assert.equal((await runtime.previewCoverAnalysisRuntime({ mode: "product", styleKey: catalog.entries[0].styleKey }, db)).styleApplied, false);
  catalog.entries[0].enabled = true;
  checks.push("current script preview rejects disabled style while explicit historical preview remains inspectable and product never applies style rules");
  assert.deepEqual(effects, { network: 0, database: 0, provider: 0, secret: 0 });
  console.log(JSON.stringify({ passed: true, assertions: checks.length, effects, checks }, null, 2));
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => { globalThis.fetch = savedFetch; });
