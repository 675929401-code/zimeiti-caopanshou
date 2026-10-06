#!/usr/bin/env node
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");
const component = read("src/components/cover-studio.tsx");
const css = read("src/app/cover/cover-studio-v2.css");
const attemptRoute = read("src/app/api/cover/attempt/route.ts");
const historyRoute = read("src/app/api/cover/history/route.ts");
const migration = read("supabase/migrations/20260927143000_cover_multi_task_cancellation.sql");
const rollback = read("supabase/rollbacks/20260927143000_cover_multi_task_cancellation.rollback.sql");
const checks = [];
const check = (name, condition) => {
  assert.equal(Boolean(condition), true, name);
  checks.push(name);
};

const transpile = (source, kind = ts.ScriptKind.TS) => {
  const result = ts.transpileModule(source, {
    fileName: kind === ts.ScriptKind.TSX ? "fixture.tsx" : "fixture.ts",
    reportDiagnostics: true,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  });
  const errors = (result.diagnostics || []).filter((item) => item.category === ts.DiagnosticCategory.Error);
  assert.deepEqual(errors, [], `TypeScript fixture diagnostics: ${errors.map((item) => item.messageText).join(" | ")}`);
  return result.outputText;
};

function loadModule(relative, imports = {}) {
  const module = { exports: {} };
  const context = vm.createContext({
    module,
    exports: module.exports,
    require(id) {
      assert.ok(Object.hasOwn(imports, id), `Unexpected import: ${id}`);
      return imports[id];
    },
    AbortController,
    Blob,
    crypto: webcrypto,
    Date,
    Error,
    JSON,
    Response,
    URLSearchParams,
  });
  vm.runInContext(transpile(read(relative)), context, { filename: relative });
  return module.exports;
}

function extractFunction(source, name) {
  const tree = ts.createSourceFile("cover-studio.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let declaration = "";
  const visit = (node) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) declaration = node.getText(tree);
    ts.forEachChild(node, visit);
  };
  visit(tree);
  assert.ok(declaration, `Missing ${name}`);
  const context = vm.createContext({});
  vm.runInContext(`${transpile(`${declaration}\nglobalThis.extracted = ${name};`)}\n`, context);
  return context.extracted;
}

const selectedDirectionCss = css.slice(css.indexOf("2026-09-28 selected Cover Studio direction"));
const selectedSetupGridRule = /\.cover-rebuild-shell \.cover-setup-grid\s*\{([^}]*)\}/gu.exec(selectedDirectionCss)?.[1] || "";
const selectedWorkspaceRule = /\.cover-rebuild-shell \.cover-rebuild-workspace\s*\{([^}]*)\}/gu.exec(selectedDirectionCss)?.[1] || "";
const selectedSetupDeckRule = /\.cover-rebuild-shell \.cover-setup-deck\s*\{([^}]*)\}/gu.exec(selectedDirectionCss)?.[1] || "";
check("top control bar uses four integrated columns", /grid-template-columns:\s*repeat\(4,/u.test(selectedSetupGridRule));
check("selected full-width setup layout is canonical", /grid-template-columns:\s*clamp\(340px,[\s\S]*minmax\(0,\s*1fr\)/u.test(selectedWorkspaceRule)
  && /grid-column:\s*1\s*\/\s*-1/u.test(selectedSetupDeckRule)
  && /grid-row:\s*1/u.test(selectedSetupDeckRule));
check("cover follows the three single-palette theme contract", !/stellar-blue/u.test(css)
  && !/data-theme="soft-white"\]\[data-mode="dark"/u.test(css)
  && !/data-theme="crystal-aurora"\]\[data-mode="light"/u.test(css));
check("reference creation is expressed only as an input source", component.includes('type MaterialSourceId = "text" | "template" | "upload"') && !component.includes('"参考创作"'));
check("source choices are mutually exclusive and visible", [
  'selectMaterialSource("text")',
  'selectMaterialSource("template")',
  'selectMaterialSource("upload")',
].every((value) => component.includes(value)));
check("editor exposes one large primary decomposition result", component.includes('className="cover-copy-result-editor" aria-label="拆解结果"') && /\.cover-copy-result-editor\s*\{[\s\S]*?min-height:\s*142px/u.test(css));
check("auxiliary copy and visual description stay optional", component.includes("辅助短句（可选）") && component.includes("画面描述（高级）") && component.includes("promptAdvancedOpen &&"));
check("advanced visual description remains compact", /\.cover-prompt-editor textarea\s*\{[^}]*height:\s*92px/u.test(css));
check("brief input has bounded desktop height", /\.cover-director-panel \.cover-brief-card > textarea:first-of-type\s*\{[\s\S]*?height:\s*132px[\s\S]*?max-height:\s*156px/u.test(css));
check("template library is a searchable right drawer", component.includes("搜索模板名称或版式") && /\.cover-template-library-backdrop\s*\{[\s\S]*?justify-content:\s*flex-end/u.test(css));
check("reference material is outside the result canvas", component.includes('className="cover-reference-dock"') && component.indexOf('className="cover-reference-dock"') < component.indexOf('className="cover-director-panel"'));

check("legacy editor draft hydration and autosave are removed", !component.includes("hydrateDraft") && !component.includes("localStorage.setItem(draftKey(") && !component.includes("readCoverDraftReference"));
check("legacy browser draft is scrubbed without restoring it", component.includes("clearLegacyCoverEditorDraft(currentUserId || \"anonymous\")"));
check("refresh detaches editor selection from account tasks", component.includes("detachCoverGenerationTracking(localStorage, currentUserId)") && component.includes('tasks.some(task => task.id === previous) ? previous : ""'));
check("history loading does not auto-select an active attempt", component.includes("loadAccountHistory(1, controller.signal, false)"));
check("each submission owns isolated task storage", component.includes("const taskStorage = createTaskStorage()") && !component.includes("hasPendingGeneration"));
check("background updates do not steal another selected task", component.includes("selectedId === originalTaskId || selectedId === updated.id ? updated.id : selectedId"));
check("every cancellable current or historical task exposes terminate", (component.match(/cancelCoverTask\(/gu) || []).length >= 3 && component.includes("终止任务"));

check("template and uploaded references are sent through the real payload", component.includes("? [templateReference].filter(Boolean)") && component.includes("? [referenceImage]") && component.includes("referenceImageUrls,"));
check("visible copy is synchronized into the submitted prompt", component.includes("const submissionPrompt = syncCoverCopySemantics(prompt, title, subtitle)") && component.includes("prompt: submissionPrompt"));
const syncCopy = extractFunction(component, "syncCoverCopySemantics");
const synchronized = syncCopy("手工画面描述\n标题语义仅用于决定主体动作和留白，不得把文字画进底图：旧标题。\n保留结尾", "新标题第一行\n新标题第二行", "可选补充");
assert.match(synchronized, /新标题第一行 \/ 新标题第二行；可选补充/u);
assert.match(synchronized, /手工画面描述/u);
assert.match(synchronized, /保留结尾/u);
checks.push("edited copy updates semantics without discarding manual prompt content");

check("history reconciles stale work before reading", historyRoute.indexOf('rpc("reconcile_stale_cover_generation_attempts"') < historyRoute.indexOf('.from("cover_generation_attempts")'));
check("history reads cancelled timestamp and all active attempts", historyRoute.includes("cancelled_at") && historyRoute.includes("activeAttempts") && historyRoute.includes("coverTaskStableKey"));
check("failure write rereads the exact attempt around cancellation", attemptRoute.includes("let latest = await exactAttempt(userId, keys)") && attemptRoute.includes("latest = await exactAttempt(userId, keys) || settled"));
check("delivery checks terminal state before composition", attemptRoute.includes("latestBeforeDelivery") && attemptRoute.includes("latestBeforeRender") && attemptRoute.includes("isTerminalAttempt(latestBeforeRender)"));

const compositionMock = { coverCompositionValidationError: () => "" };
const durable = loadModule("src/lib/cover-durable-attempt.ts", { "@/lib/cover-composition": compositionMock });
const plan = { title: "两行标题", subtitle: "", aspectRatio: "3:4", layoutTemplateId: "gaoding-fixture", animationStyleId: "pet-3d" };
const task = { id: "cover-fixture", ratio: "3:4", title: plan.title, subtitle: "", prompt: "fixture prompt", source: "生成", createdAt: "2026-09-27T00:00:00.000Z", taskNo: 1, renderPlan: plan };
const safePayload = { prompt: task.prompt, modelId: "pm_fixture", mode: "local", style: "卡通风格", aspectRatio: "3:4", resolution: "1K", coverText: "", referenceImageUrls: [], referenceUsage: "general", historySurface: "cover-studio" };
const parsedDispatch = durable.parseCoverDispatchPayload({ ...safePayload, referenceImageUrls: ["data:image/png;base64,AAAA"] });
assert.equal(parsedDispatch.references.length, 1);
assert.equal(parsedDispatch.safe.referenceImageUrls.length, 0);
checks.push("durable parser separates transient reference bytes from safe snapshot");
const jsonbReorderedInput = {
  historySurface: safePayload.historySurface,
  referenceUsage: safePayload.referenceUsage,
  referenceImageUrls: [],
  coverText: safePayload.coverText,
  resolution: safePayload.resolution,
  aspectRatio: safePayload.aspectRatio,
  style: safePayload.style,
  mode: safePayload.mode,
  modelId: safePayload.modelId,
  prompt: safePayload.prompt,
};
assert.equal(durable.sameCoverGenerationInput(jsonbReorderedInput, parsedDispatch.safe), true);
assert.equal(durable.sameCoverGenerationInput({ ...jsonbReorderedInput, prompt: `${safePayload.prompt} changed` }, parsedDispatch.safe), false);
checks.push("jsonb key reordering cannot reject an equivalent dispatch and changed fields still fail closed");
const cancelledProjection = durable.coverAttemptProjection({
  id: "00000000-0000-4000-8000-000000000001",
  user_id: "00000000-0000-4000-8000-000000000002",
  surface: "cover-studio",
  client_idempotency_key: "cover_fixture_01",
  client_trace_id: "cover_fixture_01",
  state: "cancelled",
  task,
  generation_input: safePayload,
  requires_reference_reupload: false,
  created_at: "2026-09-27T00:00:00.000Z",
  updated_at: "2026-09-27T00:01:00.000Z",
  cancelled_at: "2026-09-27T00:01:00.000Z",
});
assert.equal(cancelledProjection.task.status, "cancelled");
assert.equal(cancelledProjection.task.cancellable, false);
assert.match(cancelledProjection.task.error, /实际账单核对/u);
checks.push("cancelled task is terminal and keeps truthful billing wording");

const generation = loadModule("src/lib/cover-generation-attempt.ts", {
  "@/lib/image-workbench-attempt-guard": { isConfirmedTerminalImageFailure: () => false },
  "@/lib/cover-composition": { coverCompositionMatches: () => true, coverCompositionValidationError: () => "" },
  "@/lib/image-resolution-pricing": { parsePublicImageResolutionPrices: () => ({}) },
});
const values = new Map();
const storage = {
  get length() { return values.size; },
  clear: () => values.clear(),
  getItem: (key) => values.get(key) ?? null,
  key: (index) => [...values.keys()][index] ?? null,
  removeItem: (key) => values.delete(key),
  setItem: (key, value) => values.set(key, String(value)),
};
storage.setItem("cover-generation:v1:user-fixture", JSON.stringify({ version: 1, pending: {
  clientIdempotencyKey: "cover_fixture_01",
  clientTraceId: "cover_fixture_01",
  updatedAt: Date.now(),
  task,
  resumePayload: { ...safePayload, resumeDeliveryOnly: true },
}, history: [] }));
generation.detachCoverGenerationTracking(storage, "user-fixture");
assert.equal(generation.readCoverGenerationState(storage, "user-fixture").pending, null);
assert.equal(storage.getItem("cover-generation:v1:user-fixture").includes("fixture prompt"), false);
checks.push("refresh detaches local tracking without retaining prompt content");

check("migration removes one-active lock and adds task cancellation", migration.includes("drop index if exists public.cover_generation_attempts_one_active_idx") && migration.includes("cancel_cover_generation_attempt"));
check("stale claimed task fails before dispatch without inventing provider work", migration.includes("COVER_CLAIM_EXPIRED_BEFORE_DISPATCH") && migration.includes("request.user_id = attempt.user_id::text"));
check("rollback preserves audit rows and restores original RPCs", !/delete\s+from\s+public\.cover_generation_attempts/iu.test(rollback) && rollback.includes("COVER_ROLLBACK_SUPERSEDED_ACTIVE") && (rollback.match(/create or replace function public\.claim_cover_generation_attempt/gu) || []).length === 1 && rollback.includes("create or replace function public.settle_cover_generation_attempt"));

console.log(JSON.stringify({
  passed: true,
  assertions: checks.length,
  providerCalls: 0,
  paidRequests: 0,
  browserWrites: 0,
  checks,
}, null, 2));
