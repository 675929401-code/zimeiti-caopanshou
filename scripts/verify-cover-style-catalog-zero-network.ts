import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import * as crypto from "node:crypto";
import ts from "typescript";
import { z } from "zod";
import * as metadata from "../src/lib/cover-style-catalog";
import * as config from "../src/lib/server/cover-style-config";
import * as defaults from "../src/lib/server/cover-style-defaults";
import * as publication from "../src/lib/server/cover-workflow-publication";
import { isReservedPlatformSettingKey } from "../src/lib/server/platform-settings-reserved";
import { adminRequirementForRequest, adminPermissionKeysForTab } from "../src/lib/admin-governance";
import { compileCoverAnalysisMessages, compileCoverNativePrompt, compileCoverBackgroundPrompt, coverAnalysisDependencySnapshot } from "../src/lib/cover-workbench-prompts";
import { coverOutputSpec, parseCoverPrepareInput, parseCoverContentAnalysis, type CoverContentAnalysis } from "../src/lib/cover-workbench-contract";
import { coverReviewPlanFromAnalysis, type CoverReviewFieldOrigins } from "../src/lib/cover-review-contract";

let forbiddenCalls = 0;
const forbidden = () => { forbiddenCalls++; throw new Error("LIVE_NETWORK_DATABASE_PROVIDER_FORBIDDEN"); };
const savedFetch = globalThis.fetch;
globalThis.fetch = forbidden;
const cases: string[] = [];
let rejectWorkflowModel = false;
let workflowModelChecks = 0;
const check = async (name: string, run: () => unknown) => { await run(); cases.push(name); };
function load(file: string, imports: Record<string, unknown>): Record<string, unknown> {
  const moduleContainer = { exports: {} }, source = readFileSync(file, "utf8");
  const compiled = ts.transpileModule(source, { fileName: file, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } });
  vm.runInNewContext(compiled.outputText, { module: moduleContainer, exports: moduleContainer.exports, Buffer, URL, Request, Response, console, structuredClone, fetch: forbidden,
    require(id: string) { assert.ok(Object.hasOwn(imports, id), `Unapproved runtime import ${id}`); return imports[id]; } }, { filename: file });
  return moduleContainer.exports;
}
const store = load("src/lib/server/cover-style-store.ts", { "server-only": {}, "node:crypto": crypto, zod: { z },
  "@/storage/database/supabase-client": { getSupabaseAdminClient: forbidden }, "../cover-style-catalog": metadata,
  "./cover-style-defaults": defaults, "./cover-style-config": config,
  "./cover-workflow-publication": publication,
  "./cover-admin-runtime": { validateCoverWorkflowModels: async (input: unknown) => {
    config.CoverWorkflowDraftInputSchema.parse(input); workflowModelChecks++;
    if (rejectWorkflowModel) throw new config.CoverStyleStoreError("COVER_ANALYSIS_CONFIGURED_MODEL_UNAVAILABLE", "fixture invalid model", 422);
  } } }) as unknown as typeof import("../src/lib/server/cover-style-store");
type Row = { id: string; setting_key: string; setting_value: string; updated_at: string | null };
class MemoryDb {
  row: Row | null = null; writes = 0; reads = 0; filters: Array<[string, unknown]> = [];
  failRead = false; insertRace = false; beforeWrite?: () => void; corruptReadback = false;
  from(table: string) {
    assert.equal(table, "platform_settings");
    let operation = "read", payload: Partial<Row> = {}; const filters: Array<[string, unknown]> = [];
    const query = { select: () => query, eq: (key: string, value: unknown) => { filters.push([key, value]); return query; },
      is: (key: string, value: unknown) => { filters.push([`is:${key}`, value]); return query; },
      insert: (value: Partial<Row>) => { operation = "insert"; payload = value; return query; },
      update: (value: Partial<Row>) => { operation = "update"; payload = value; return query; },
      maybeSingle: async () => {
        if (operation === "read") { this.reads++; if (this.failRead || (this.corruptReadback && this.writes)) return { data: null, error: { code: "fixture" } };
          return { data: this.row ? structuredClone(this.row) : null, error: null }; }
        this.writes++; this.filters = filters; this.beforeWrite?.(); this.beforeWrite = undefined;
        if (operation === "insert" && (this.row || this.insertRace)) return { data: null, error: { code: "23505" } };
        if (operation === "update" && (!this.row || filters.some(([key, value]) => this.row![key.replace(/^is:/u, "") as keyof Row] !== value))) return { data: null, error: null };
        this.row = { id: this.row?.id ?? "row-1", ...this.row, ...payload } as Row;
        return { data: structuredClone(this.row), error: null };
      } };
    return query;
  }
  client() { return this as unknown as Parameters<typeof store.loadCoverStyleCatalog>[0]; }
  seed(catalog = defaults.createDefaultCoverStyleCatalog(), updatedAt: string | null = "2035-01-01T00:00:00.123456+00:00") {
    this.row = { id: "seed-id", setting_key: config.COVER_STYLE_SETTING_KEY, setting_value: config.coverStyleStableJson(catalog), updated_at: updatedAt }; return this;
  }
}
const draft = { displayName: "纸艺故事", description: "内部生成规则独立管理", analysisPrompt: "ANALYSIS_RULE_SENTINEL：按真实关系选题。", generationPrompt: "GENERATION_RULE_SENTINEL：纸艺材质和完整中文标题。" };
async function mutate(db: MemoryDb, action: Record<string, unknown>) {
  const before = await store.loadCoverStyleCatalog(db.client());
  return store.mutateCoverStyleCatalog("fixture-admin", { expectedRevision: before.catalog.revision, expectedHash: before.hash, ...action }, db.client());
}
const rejectsCode = (code: string, run: () => Promise<unknown>) => assert.rejects(run, error => error instanceof config.CoverStyleStoreError && error.code === code);
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));

async function main() {
  try {
    await check("global workflow defaults are deterministic and reading old catalogs does not rewrite bytes or hashes", async () => {
      const db = new MemoryDb().seed(), before = db.row!.setting_value;
      const loaded = await store.loadCoverStyleCatalog(db.client());
      assert.equal(loaded.catalog.workflow, undefined);
      const first = await store.resolvePublishedCoverWorkflow(db.client());
      const second = store.coverWorkflowAdminDto(loaded).current;
      assert.equal(config.coverWorkflowReleaseHash(first), first.snapshotSha256);
      assert.deepEqual(plain(first), plain(second)); assert.equal(db.writes, 0); assert.equal(db.row!.setting_value, before);
    });
    await check("global draft publish rollback use immutable snapshots and preserve all previous style bytes", async () => {
      const db = new MemoryDb().seed(), original = await store.loadCoverStyleCatalog(db.client());
      const styleBytes = config.coverStyleStableJson(original.catalog.entries);
      const baseline = await store.resolvePublishedCoverWorkflow(db.client());
      const draftInput = { sharedRules: "GLOBAL_RULE_SENTINEL：只根据材料提炼主题。", textModelId: "internal-model-a", imageModelId: null };
      const saved = await mutate(db, { action: "workflow-draft", draft: draftInput });
      assert.equal(config.coverStyleStableJson(saved.catalog.entries), styleBytes);
      assert.equal((await store.resolvePublishedCoverWorkflow(db.client())).releaseId, baseline.releaseId);
      const draft = store.coverWorkflowAdminDto(saved).draft!;
      const bytes = config.coverStyleStableJson(saved.catalog.workflow!.releases);
      const active = await mutate(db, { action: "workflow-publish" });
      assert.equal(store.coverWorkflowAdminDto(active).current.releaseId, draft.releaseId);
      assert.equal(store.coverWorkflowAdminDto(active).draft, null);
      assert.equal(config.coverStyleStableJson(active.catalog.workflow!.releases), bytes);
      const rolled = await mutate(db, { action: "workflow-rollback", releaseId: baseline.releaseId });
      assert.equal(store.coverWorkflowAdminDto(rolled).current.releaseId, baseline.releaseId);
      assert.equal(config.coverStyleStableJson(rolled.catalog.entries), styleBytes);
      assert.equal(config.coverStyleStableJson(rolled.catalog.workflow!.releases), bytes);
      assert.equal(rolled.catalog.audit.at(-1)!.styleKey, null);
      const tampered = structuredClone(rolled.catalog); tampered.revision++; tampered.workflow!.releases[0].sharedRules = "changed";
      assert.throws(() => store.assertCoverStyleHistoryPreserved(rolled.catalog, tampered));
      await rejectsCode("COVER_STYLE_RELEASE_INVALID", () => mutate(db, { action: "workflow-rollback", releaseId: "missing" }));
    });
    await check("complete style editor can remove historical appended business rules without changing old releases", async () => {
      const db = new MemoryDb().seed(), old = await store.loadCoverStyleCatalog(db.client());
      const dto = store.coverStyleAdminDto(old, "cartoon");
      assert.equal(dto.selected!.editable!.completeRules, true);
      assert.match(dto.selected!.editable!.analysisPrompt, /无字静帧/u);
      const legacyBytes = config.coverStyleStableJson(old.catalog.entries[0].releases);
      await mutate(db, { action: "draft", styleKey: "cartoon", draft: { ...dto.selected!.editable!, analysisPrompt: "NEW_RULE_SENTINEL", generationPrompt: "NEW_IMAGE_SENTINEL" } });
      await mutate(db, { action: "publish", styleKey: "cartoon" });
      const runtime = await store.resolvePublishedCoverStyle("cartoon", undefined, db.client());
      assert.deepEqual(plain(runtime.promptPack.analysisRules), ["NEW_RULE_SENTINEL"]);
      assert.deepEqual(plain(runtime.promptPack.nativeCoverRules), ["NEW_IMAGE_SENTINEL"]);
      const now = await store.loadCoverStyleCatalog(db.client());
      assert.equal(config.coverStyleStableJson(now.catalog.entries[0].releases.slice(0, old.catalog.entries[0].releases.length)), legacyBytes);
    });
    await check("publication refuses over-budget rules before CAS without discarding saved drafts", async () => {
      const db = new MemoryDb().seed();
      await mutate(db, { action: "draft", styleKey: "cartoon", draft: { ...draft, analysisPrompt: "字".repeat(40_000) } });
      const writes = db.writes, current = (await store.loadCoverStyleCatalog(db.client())).catalog.entries[0].current!.releaseId;
      await assert.rejects(() => mutate(db, { action: "publish", styleKey: "cartoon" }), error => error instanceof config.CoverStyleStoreError
        && ["COVER_WORKFLOW_CONTEXT_EXCEEDED", "COVER_WORKFLOW_SNAPSHOT_EXCEEDED"].includes(error.code));
      assert.equal(db.writes, writes);
      const after = await store.loadCoverStyleCatalog(db.client());
      assert.equal(after.catalog.entries[0].current!.releaseId, current); assert.ok(after.catalog.entries[0].draftReleaseId);
    });
    await check("unpublished oversized drafts do not block a valid unrelated publication or workflow rollback", async () => {
      const db = new MemoryDb().seed();
      await mutate(db, { action: "draft", styleKey: "cartoon", draft: { ...draft, analysisPrompt: "A".repeat(49_999) } });
      await mutate(db, { action: "draft", styleKey: "funny-cartoon", draft });
      await mutate(db, { action: "publish", styleKey: "funny-cartoon" });
      const baseline = await store.resolvePublishedCoverWorkflow(db.client());
      await mutate(db, { action: "workflow-draft", draft: { sharedRules: baseline.sharedRules, textModelId: null, imageModelId: null } });
      await mutate(db, { action: "workflow-publish" });
      await mutate(db, { action: "workflow-rollback", releaseId: baseline.releaseId });
      assert.equal((await store.resolvePublishedCoverWorkflow(db.client())).releaseId, baseline.releaseId);
    });
    await check("large generation text cannot publish a private preparation exceeding the JSON storage cap", async () => {
      const db = new MemoryDb().seed();
      await mutate(db, { action: "draft", styleKey: "cartoon", draft: { ...draft, analysisPrompt: "short", generationPrompt: "字".repeat(45_000) } });
      const writes = db.writes;
      await rejectsCode("COVER_WORKFLOW_SNAPSHOT_EXCEEDED", () => mutate(db, { action: "publish", styleKey: "cartoon" }));
      assert.equal(db.writes, writes);
    });
    await check("store validates the selected workflow model before CAS and preserves current on rejection", async () => {
      const db = new MemoryDb().seed();
      await mutate(db, { action: "workflow-draft", draft: { sharedRules: "规则", textModelId: "missing-model", imageModelId: null } });
      const writes = db.writes, checks = workflowModelChecks;
      rejectWorkflowModel = true;
      try { await rejectsCode("COVER_ANALYSIS_CONFIGURED_MODEL_UNAVAILABLE", () => mutate(db, { action: "workflow-publish" })); }
      finally { rejectWorkflowModel = false; }
      assert.equal(db.writes, writes); assert.equal(workflowModelChecks, checks + 1);
      assert.equal((await store.resolvePublishedCoverWorkflow(db.client())).textModelId, null);
    });
    await check("missing row bootstrap is deterministic and public DTO has a strict neutral allowlist", async () => {
      const db = new MemoryDb(), a = await store.loadCoverStyleCatalog(db.client()), b = await store.loadCoverStyleCatalog(db.client());
      assert.equal(a.hash, b.hash); assert.equal(a.row, null); assert.equal(db.writes, 0);
      const dto = await store.readPublicCoverStyles(db.client());
      assert.deepEqual(plain(dto.styles.map(style => style.displayName)), ["暖光叙事", "趣味反差"]);
      for (const style of dto.styles) assert.deepEqual(Object.keys(style).sort(), ["description", "displayName", "order", "styleKey", "version"]);
      assert.ok(!/好运|哈尼|creator|prompt|research|https?:/iu.test(JSON.stringify(dto)));
    });
    await check("unavailable or corrupt persisted configuration never silently falls back", async () => {
      const db = new MemoryDb(); db.failRead = true;
      await rejectsCode("COVER_STYLE_READ_UNAVAILABLE", () => store.loadCoverStyleCatalog(db.client()));
      db.failRead = false; db.seed(); db.row!.setting_value = "{}";
      await rejectsCode("COVER_STYLE_CATALOG_INVALID", () => store.loadCoverStyleCatalog(db.client())); assert.equal(db.writes, 0);
    });
    await check("draft snapshots are immutable and invisible until publish; new keys compile both private rule stages", async () => {
      const db = new MemoryDb(), saved = await mutate(db, { action: "draft", styleKey: "paper-story", draft });
      assert.equal(saved.catalog.revision, 1); assert.equal((await store.readPublicCoverStyles(db.client())).styles.length, 2);
      await rejectsCode("COVER_STYLE_UNAVAILABLE", () => store.resolvePublishedCoverStyle("paper-story", undefined, db.client()));
      const beforeRelease = config.coverStyleStableJson(saved.catalog.entries[2].releases[0]);
      await mutate(db, { action: "publish", styleKey: "paper-story" });
      const runtime = await store.resolvePublishedCoverStyle("paper-story", "1.0.0", db.client());
      assert.equal(runtime.style.typography.maxLines, 2);
      assert.equal(config.coverStyleStableJson((await store.loadCoverStyleCatalog(db.client())).catalog.entries[2].releases[0]), beforeRelease);
      const materials = parseCoverPrepareInput({ clientRequestId: "style_fixture_0001", text: "我把书放在桌上，再开始工作。", styleKey: "paper-story" });
      const messages = compileCoverAnalysisMessages(materials, [], runtime), deps = coverAnalysisDependencySnapshot(materials, runtime);
      assert.ok(messages[0].content.includes(draft.analysisPrompt)); assert.ok(!messages[0].content.includes(draft.generationPrompt));
      assert.equal(deps.styleReleaseId, runtime.release.releaseId); assert.equal(deps.styleReleaseSha256, runtime.release.snapshotSha256);
      const analysis = parseCoverContentAnalysis({ schemaVersion: "cover-content-analysis/1", status: "ready", topic: materials.text, primaryTitle: "放下书开始工作", secondaryTitle: null,
        visualBrief: { subject: "一个人", action: "书已在桌上，人开始工作", scene: "桌边", emotion: "专注" },
        titleCandidates: [{ id: "t1", text: "放下书开始工作", evidenceRefs: ["e1"] }], evidence: [{ id: "e1", source: "text", quote: materials.text,
          fields: ["topic", "primaryTitle", "visualBrief.subject", "visualBrief.action", "visualBrief.scene", "visualBrief.emotion"] }], missingInformation: [],
        contentBreakdown: { summary: { text: materials.text, evidenceRefs: ["e1"] }, keyPoints: [{ text: "开始工作", evidenceRefs: ["e1"] }],
          logic: { text: "先放置书再工作", evidenceRefs: ["e1"] }, coverFocus: { text: "人开始工作", evidenceRefs: ["e1"] } },
        layoutIntent: { structure: "single", focus: "action", evidenceRefs: ["e1"] } }, materials);
      const input = { analysis, style: runtime.style, frozenPromptPack: runtime.promptPack, materials,
        generationSpec: { modelId: "pm_fixture", resolution: "2K" as const, aspectRatio: "3:4" as const, outputRatio: "3:4" as const, ratioEvidence: "declared_native" as const }, outputSpec: coverOutputSpec("3:4") };
      const prompt = compileCoverNativePrompt(input); assert.ok(prompt.includes(draft.generationPrompt)); assert.ok(!prompt.includes(draft.analysisPrompt));
      assert.doesNotMatch(prompt, /Pixar-style/u, "custom releases keep their own visual direction");
      for (const styleKey of ["cartoon", "funny-cartoon"]) {
        const selected = await store.resolvePublishedCoverStyle(styleKey, undefined, db.client());
        const script = { ...materials, styleKey };
        const historical = structuredClone(selected);
        historical.promptPack.analysisRules = [selected.release.analysisPrompt];
        historical.promptPack.nativeCoverRules = [selected.release.generationPrompt];
        const messagesFor = (pack: typeof selected) => compileCoverAnalysisMessages(script, [], pack)[0].content;
        const imageFor = (pack: typeof selected) => compileCoverNativePrompt({ ...input, materials: script, style: pack.style, frozenPromptPack: pack.promptPack });
        assert.ok(messagesFor(selected).includes(selected.release.analysisPrompt));
        assert.match(messagesFor(selected), /无字静帧/u);
        assert.match(imageFor(selected), /Pixar-style 3D animation/u);
        assert.ok(imageFor(selected).includes(selected.release.generationPrompt));
        assert.doesNotMatch(imageFor(historical), /Pixar-style 3D animation/u);
        assert.notDeepEqual(coverAnalysisDependencySnapshot(script, selected), coverAnalysisDependencySnapshot(script, historical));
        assert.doesNotMatch(compileCoverAnalysisMessages({ ...script, contentKind: "product" }, [], selected)[0].content, /无字静帧/u);
      }
      assert.ok(!/好运|哈尼|research\//iu.test(prompt + messages[0].content + JSON.stringify(deps)));
      assert.equal(deps.promptPack!.creator, ""); assert.equal(deps.promptPack!.sourceEvidence.report, "");
      const plan = coverReviewPlanFromAnalysis(analysis); plan.primaryTitle = "用户新标题"; plan.contentBreakdown.summary = "用户编辑的内容结论"; plan.layoutIntent.focus = "expression";
      const fields = ["topic", "primaryTitle", "secondaryTitle", "visualBrief.subject", "visualBrief.action", "visualBrief.scene", "visualBrief.emotion",
        "contentBreakdown.summary", "contentBreakdown.keyPoints", "contentBreakdown.logic", "contentBreakdown.coverFocus", "layoutIntent.structure", "layoutIntent.focus"];
      const fieldOrigins: CoverReviewFieldOrigins = Object.fromEntries(fields.map(field => [field, { source: "user_override" }]));
      const reviewed = { ...analysis, contentBreakdown: { ...analysis.contentBreakdown!, summary: { text: plan.contentBreakdown.summary, evidenceRefs: [] } }, layoutIntent: { ...plan.layoutIntent, evidenceRefs: [] } } as CoverContentAnalysis;
      assert.throws(() => compileCoverNativePrompt({ ...input, analysis: reviewed }));
      const confirmedReview = { plan, fieldOrigins };
      assert.ok(compileCoverNativePrompt({ ...input, analysis: reviewed, confirmedReview }).includes("用户新标题"));
      const background = compileCoverBackgroundPrompt({ ...input, analysis: reviewed, confirmedReview });
      assert.ok(background.includes("用户编辑的内容结论"));
      const backgroundScene = JSON.parse(background.split("\n").find(line => line.startsWith('{"visualBrief"'))!);
      assert.deepEqual(backgroundScene.layoutIntent, plan.layoutIntent);
      assert.equal(backgroundScene.layoutIntent.focus, "expression");
      assert.ok(background.includes("Do not draw title text"));
      assert.deepEqual(analysis.evidence, reviewed.evidence); assert.deepEqual(reviewed.layoutIntent!.evidenceRefs, []);
      assert.throws(() => compileCoverNativePrompt({ ...input, analysis: reviewed, confirmedReview: { plan, fieldOrigins: { ...fieldOrigins, primaryTitle: { source: "user_override", evidenceRefs: ["e1"] } } } }), /COVER_REVIEW_ORIGINS_INVALID/u);
      await mutate(db, { action: "draft", styleKey: "paper-story", draft: { ...draft, generationPrompt: "NEXT_GENERATION_RULE" } });
      await mutate(db, { action: "publish", styleKey: "paper-story" });
      assert.ok(compileCoverNativePrompt(input).includes(draft.generationPrompt)); assert.ok(!compileCoverNativePrompt(input).includes("NEXT_GENERATION_RULE"));
      await rejectsCode("COVER_STYLE_VERSION_CHANGED", () => store.resolvePublishedCoverStyle("paper-story", "1.0.0", db.client()));
    });
    await check("publication rollback only moves the pointer and retains every frozen release", async () => {
      const db = new MemoryDb(); await mutate(db, { action: "draft", styleKey: "cartoon", draft });
      await mutate(db, { action: "publish", styleKey: "cartoon" }); const before = await store.loadCoverStyleCatalog(db.client());
      const old = before.catalog.entries[0].releases[0].releaseId;
      const after = await mutate(db, { action: "rollback", styleKey: "cartoon", releaseId: old });
      assert.equal(after.catalog.entries[0].current!.releaseId, old); assert.equal(after.catalog.entries[0].releases.length, 2);
      assert.deepEqual(plain(after.catalog.entries[0].releases), plain(before.catalog.entries[0].releases));
      const changed = structuredClone(after.catalog); changed.revision++; changed.entries[0].releases[0].analysisPrompt = "changed";
      assert.throws(() => store.assertCoverStyleHistoryPreserved(after.catalog, changed), /不可删除或修改/u);
      changed.entries[0].releases = []; assert.throws(() => store.assertCoverStyleHistoryPreserved(after.catalog, changed));
    });
    await check("enable and complete ordering affect public choices; malformed ordering and blank prompts reject before writes", async () => {
      const db = new MemoryDb(); await mutate(db, { action: "reorder", styleKeys: ["funny-cartoon", "cartoon"] });
      assert.equal((await store.readPublicCoverStyles(db.client())).styles[0].styleKey, "funny-cartoon");
      await mutate(db, { action: "set-enabled", styleKey: "cartoon", enabled: false }); assert.equal((await store.readPublicCoverStyles(db.client())).styles.length, 1);
      await rejectsCode("COVER_STYLE_UNAVAILABLE", () => store.resolvePublishedCoverStyle("cartoon", undefined, db.client()));
      const writes = db.writes;
      await rejectsCode("COVER_STYLE_ORDER_INVALID", () => mutate(db, { action: "reorder", styleKeys: ["cartoon", "cartoon"] }));
      for (const name of ["analysisPrompt", "generationPrompt"]) await rejectsCode("COVER_STYLE_INPUT_INVALID", () => mutate(db, { action: "draft", styleKey: "cartoon", draft: { ...draft, [name]: " \n\t " } }));
      assert.equal(db.writes, writes); assert.equal(config.CoverStyleDraftInputSchema.parse({ ...draft, analysisPrompt: " \n valid \n " }).analysisPrompt, " \n valid \n ");
    });
    await check("stale revision and hash reject with no write or automatic merge", async () => {
      const db = new MemoryDb(), loaded = await store.loadCoverStyleCatalog(db.client());
      for (const patch of [{ expectedRevision: 5 }, { expectedHash: "0".repeat(64) }]) await rejectsCode("COVER_STYLE_REVISION_CONFLICT", () => store.mutateCoverStyleCatalog("admin", { action: "set-enabled", styleKey: "cartoon", enabled: false, expectedRevision: loaded.catalog.revision, expectedHash: loaded.hash, ...patch }, db.client()));
      assert.equal(db.writes, 0);
    });
    await check("CAS binds key plus row ID plus exact database timestamp and advances beyond future clock", async () => {
      const db = new MemoryDb().seed(), old = db.row!.updated_at!;
      await mutate(db, { action: "set-enabled", styleKey: "cartoon", enabled: false });
      assert.deepEqual(db.filters, [["setting_key", config.COVER_STYLE_SETTING_KEY], ["id", "seed-id"], ["updated_at", old]]);
      assert.ok(Date.parse(db.row!.updated_at!) > Date.parse(old)); assert.ok(db.filters.every(([, value]) => typeof value !== "string" || !value.includes("analysisPrompt")));
      const nullable = new MemoryDb().seed(undefined, null); await mutate(nullable, { action: "set-enabled", styleKey: "cartoon", enabled: false }); assert.ok(nullable.filters.some(([key, value]) => key === "is:updated_at" && value === null));
    });
    await check("first insert conflict and delete/recreate ABA return conflict without retries", async () => {
      const first = new MemoryDb(); first.insertRace = true;
      await rejectsCode("COVER_STYLE_REVISION_CONFLICT", () => mutate(first, { action: "set-enabled", styleKey: "cartoon", enabled: false })); assert.equal(first.writes, 1);
      const aba = new MemoryDb().seed(); aba.beforeWrite = () => { aba.row!.id = "recreated-id"; };
      await rejectsCode("COVER_STYLE_REVISION_CONFLICT", () => mutate(aba, { action: "set-enabled", styleKey: "cartoon", enabled: false })); assert.equal(aba.writes, 1);
    });
    await check("write readback unavailable is unknown and never automatically repeated", async () => {
      const db = new MemoryDb(); db.corruptReadback = true;
      await assert.rejects(() => mutate(db, { action: "set-enabled", styleKey: "cartoon", enabled: false }), error => error instanceof config.CoverStyleStoreError && error.code === "COVER_STYLE_WRITE_UNKNOWN" && error.outcome === "unknown");
      assert.equal(db.writes, 1); assert.ok(db.row);
    });
    await check("UTF-8 capacity is enforced without trimming retained releases", () => {
      const catalog = defaults.createDefaultCoverStyleCatalog(); const source = catalog.entries[0].releases[0];
      for (let index = 2; index <= 60; index++) { const release = { ...source, releaseId: `large-${index}`, version: `${index}.0.0`, sequence: index, analysisPrompt: "字".repeat(50_000) }; release.snapshotSha256 = config.coverStyleReleaseHash(release); catalog.entries[0].releases.push(release); }
      assert.throws(() => config.assertCoverStyleCatalog(catalog), error => error instanceof config.CoverStyleStoreError && error.code === "COVER_STYLE_CAPACITY"); assert.equal(catalog.entries[0].releases.length, 60);
    });
    await check("actual public/admin routes enforce read failures, DTO isolation and stepped-up prompt permissions", async () => {
      const next = { NextRequest: Request, NextResponse: { json: (body: unknown, init?: ResponseInit) => Response.json(body, init) } };
      const publicRoute = load("src/app/api/cover-styles/route.ts", { "next/server": next, "@/lib/server/cover-style-store": { readPublicCoverStyles: () => store.readPublicCoverStyles(new MemoryDb().client()) } }) as { GET(): Promise<Response> };
      const publicResponse = await publicRoute.GET(); assert.equal(publicResponse.status, 200); assert.ok(!JSON.stringify(await publicResponse.json()).includes("analysisPrompt"));
      const failing = load("src/app/api/cover-styles/route.ts", { "next/server": next, "@/lib/server/cover-style-store": { readPublicCoverStyles: async () => { throw new Error("private prompt text"); } } }) as { GET(): Promise<Response> };
      const failure = await failing.GET(); assert.equal(failure.status, 503); assert.ok(!JSON.stringify(await failure.json()).includes("private prompt"));
      const scopes: unknown[] = []; let allowed = false, touched = 0;
      const adminRoute = load("src/app/api/admin/cover-styles/route.ts", { "next/server": next, "@/lib/server/admin-governance-authority": {
        authorizeAdminCapability: async (_request: unknown, permission: string, options: unknown) => { scopes.push([permission, options]); return allowed ? { ok: true, actor: { userId: "admin" } } : { ok: false, response: Response.json({}, { status: 403 }) }; } },
        "@/lib/server/cover-request-body": { readCoverRequestJson: async () => ({}), CoverRequestBodyError: class extends Error {} },
        "@/lib/server/cover-style-store": { ...store, loadCoverStyleCatalog: async () => { touched++; return store.loadCoverStyleCatalog(new MemoryDb().client()); } },
        "@/lib/server/cover-style-config": config,
        "@/lib/server/cover-admin-runtime": { readCoverAnalysisModelOptions: async () => [], previewCoverAnalysisRuntime: forbidden } }) as { GET(request: unknown): Promise<Response>; POST(request: unknown): Promise<Response> };
      const request = { nextUrl: new URL("https://fixture.invalid/api/admin/cover-styles") };
      assert.equal((await adminRoute.GET(request)).status, 403); assert.equal((await adminRoute.POST(request)).status, 403); assert.equal(touched, 0);
      allowed = true; assert.equal((await adminRoute.GET(request)).status, 200);
      assert.deepEqual(scopes.slice(0, 2).map(item => (item as [string])[0]), ["prompts.view", "prompts.edit"]);
      for (const item of scopes) assert.equal((item as [string, { requireStepUp: boolean }])[1].requireStepUp, true);
      assert.deepEqual(adminPermissionKeysForTab("cover-styles"), ["prompts.view"]);
      assert.equal(adminRequirementForRequest("/api/admin/cover-styles", "POST"), null, "body-discriminated preview/write permission is owned by the authenticated route");
      assert.equal(isReservedPlatformSettingKey(config.COVER_STYLE_SETTING_KEY), true);
    });
    assert.equal(forbiddenCalls, 0);
    console.log(JSON.stringify({ passed: true, checks: cases.length, cases, networkCalls: forbiddenCalls, providerCalls: 0, liveDatabaseCalls: 0,
      evidence: "Actual store, compiler and route functions with in-memory Supabase/auth fixtures; no persisted settings, provider generation, browser or DB immutability acceptance" }, null, 2));
  } finally { globalThis.fetch = savedFetch; }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
