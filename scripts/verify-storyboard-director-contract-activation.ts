import assert from "node:assert/strict";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";
import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import * as activation from "../src/lib/storyboard-director-contract-activation";
import * as identity from "../src/lib/storyboard-director-identity";
import { STORY_DIRECTOR_MOVIE_AGENT_ID, STORY_DIRECTOR_HIGH_ENERGY_AGENT_ID } from "../src/lib/story-director-overtime-gate";

const prompt = readFileSync("prompts/storyboard-narrative-unified-20261023.md", "utf8");
const id = STORY_DIRECTOR_MOVIE_AGENT_ID;
const serverNow = "2026-10-23T20:00:00.000Z";
const oldProduction = "2026-10-22T10:00:00+08:00";
const oldPerformance = "2026-10-23T12:00:00Z";
const flags = { production_contract_version: "storyboard_director_contract.v2", production_contract_activated_at: oldProduction,
  performance_contract: "storyboard_performance.v1", performance_contract_activated_at: oldPerformance };
const checks: string[] = [];
function check(name: string, fn: () => void) { fn(); checks.push(name); }
const normalize = (nextValue: unknown, previousValue: unknown = {}, extra: Record<string, unknown> = {}) => activation.normalizeStoryboardDirectorContractActivation({
  agentId: id, prompt, nextValue, previousValue, now: serverNow, ...extra,
});
const rejects = (fn: () => unknown) => assert.throws(fn, activation.StoryboardDirectorContractActivationError);

check("activation UI and server share exact official identity plus all three trusted prompt markers", () => {
  for (const agentId of [id, STORY_DIRECTOR_HIGH_ENERGY_AGENT_ID]) assert.equal(activation.canActivateStoryboardDirectorContracts(agentId, prompt), true);
  for (const agentId of ["叙事版", "other-agent", undefined]) assert.equal(activation.canActivateStoryboardDirectorContracts(agentId, prompt), false);
  for (const marker of ["storyboard_director_contract.v2", "storyboard_director_plan.v1", "storyboard_performance.v1"]) {
    assert.equal(activation.canActivateStoryboardDirectorContracts(id, prompt.replaceAll(marker, "old_marker")), false);
  }
});
check("explicit UI draft enables four scalars and preserves unrelated style configuration", () => {
  const value = { fontSize: 17, hybridImageGeneration: { enabled: true }, tags: [{ text: "保留", color: "blue" }] };
  const original = structuredClone(value);
  const next = activation.createStoryboardDirectorContractDraft({ agentId: id, prompt, value, now: serverNow });
  assert.deepEqual(next, { ...value, ...flags, production_contract_activated_at: serverNow, performance_contract_activated_at: serverNow });
  assert.deepEqual(value, original);
  assert.equal(next.hybridImageGeneration, value.hybridImageGeneration);
});
check("server owns both first-activation timestamps and ignores valid client backdating or future dating", () => {
  const submitted = { ...flags, fontSize: 18, performance_contract_activated_at: "2099-01-01T00:00:00Z" };
  assert.deepEqual(normalize(submitted), { ...submitted, production_contract_activated_at: serverNow, performance_contract_activated_at: serverNow });
});
check("existing production and performance timestamps remain independent and cannot be reset", () => {
  const submitted = { ...flags, production_contract_activated_at: serverNow, performance_contract_activated_at: serverNow, fontSize: 20 };
  assert.deepEqual(normalize(submitted, flags), { ...flags, fontSize: 20 });
});
check("enabling a second contract keeps the first timestamp and stamps only the new version", () => {
  const previous = { production_contract_version: flags.production_contract_version, production_contract_activated_at: oldProduction, fontSize: 18 };
  const draft = activation.createStoryboardDirectorContractDraft({ agentId: id, prompt, value: previous, now: "2099-01-01T00:00:00Z" });
  assert.equal(draft.production_contract_activated_at, oldProduction);
  assert.deepEqual(normalize(draft, previous), { ...draft, performance_contract_activated_at: serverNow });
});
check("wrong versions, invalid ISO timestamps and unpaired fields are rejected", () => {
  for (const key of activation.STORYBOARD_DIRECTOR_CONTRACT_FIELDS) {
    for (const bad of ["invalid", "", null, false, 7, { private: true }]) rejects(() => normalize({ ...flags, [key]: bad }));
    const missing = { ...flags } as Record<string, unknown>; delete missing[key]; rejects(() => normalize(missing));
  }
  rejects(() => normalize(flags, {}, { now: "invalid" }));
});
check("malformed persisted active timestamps require review instead of silently healing", () => {
  rejects(() => normalize(flags, { ...flags, production_contract_activated_at: "invalid" }));
  rejects(() => activation.createStoryboardDirectorContractDraft({ agentId: id, prompt, value: { ...flags, performance_contract_activated_at: "invalid" } }));
});
check("this activation workflow cannot delete or disable an already enabled contract", () => {
  for (const next of [{}, undefined, null, "legacy-style"]) rejects(() => normalize(next, flags));
  rejects(() => normalize({ production_contract_version: flags.production_contract_version, production_contract_activated_at: oldProduction }, flags));
});
check("foreign agents and legacy prompts cannot gain or mutate official contracts", () => {
  for (const agentId of ["other-agent", "叙事版", undefined]) rejects(() => normalize(flags, {}, { agentId }));
  rejects(() => normalize(flags, {}, { prompt: "old cinematic prompt" }));
  const unchanged = { ...flags, fontSize: 16 };
  assert.equal(normalize(unchanged, flags, { agentId: "other-agent" }), unchanged);
  assert.equal(normalize(unchanged, flags, { prompt: "old cinematic prompt", previousPrompt: "old cinematic prompt" }), unchanged);
  rejects(() => normalize({ ...flags, performance_contract_activated_at: serverNow }, flags, { prompt: "old cinematic prompt" }));
});
check("ordinary saves cannot remove prompt markers from an activated modern official director", () => {
  for (const agentId of [id, STORY_DIRECTOR_HIGH_ENERGY_AGENT_ID]) {
    for (const marker of ["storyboard_director_contract.v2", "storyboard_director_plan.v1", "storyboard_performance.v1"]) {
      rejects(() => normalize(flags, flags, { agentId, prompt: prompt.replaceAll(marker, "old_marker"), previousPrompt: prompt }));
    }
  }
  rejects(() => normalize(flags, flags, { prompt: "old prompt" }));
  const productionOnly = { production_contract_version: flags.production_contract_version, production_contract_activated_at: oldProduction };
  rejects(() => normalize(productionOnly, productionOnly, { prompt: "old prompt", previousPrompt: prompt }));
});
check("explicit rollback atomically pairs a legacy prompt with removal of all four scalars", () => {
  const next = { fontSize: 19, tags: ["keep"], hybridImageGeneration: { enabled: true } };
  assert.equal(normalize(next, flags, { prompt: "original legacy prompt", previousPrompt: prompt, action: "rollback" }), next);
  const productionOnly = { production_contract_version: flags.production_contract_version, production_contract_activated_at: oldProduction };
  assert.equal(normalize(next, productionOnly, { prompt: "original legacy prompt", action: "rollback" }), next);
  assert.deepEqual(flags, { production_contract_version: "storyboard_director_contract.v2", production_contract_activated_at: oldProduction,
    performance_contract: "storyboard_performance.v1", performance_contract_activated_at: oldPerformance });
});
check("rollback cannot target a foreign agent, a new-marker prompt, residual flags or an inactive contract", () => {
  rejects(() => normalize({}, flags, { agentId: "other-agent", prompt: "old prompt", action: "rollback" }));
  for (const systemPrompt of ["", " ", null, 7, prompt, "old storyboard_director_plan.v1", "old storyboard_director_contract.v2", "old storyboard_performance.v1"]) rejects(() => normalize({}, flags, { prompt: systemPrompt, action: "rollback" }));
  for (const key of activation.STORYBOARD_DIRECTOR_CONTRACT_FIELDS) for (const residual of [undefined, null]) rejects(() => normalize({ [key]: residual }, flags, { prompt: "old prompt", action: "rollback" }));
  for (const previous of [{}, { ...flags, performance_contract_activated_at: "invalid" }]) rejects(() => normalize({}, previous, { prompt: "old prompt", action: "rollback" }));
  rejects(() => normalize(null, flags, { prompt: "old prompt", action: "rollback" }));
  rejects(() => normalize({}, flags, { prompt: "old prompt", previousPrompt: prompt, action: "preserve" }));
  rejects(() => normalize({}, {}, { action: "unknown" }));
});
check("re-enabling after explicit rollback creates a new server activation boundary", () => {
  const restored = normalize({ fontSize: 16 }, flags, { prompt: "old prompt", action: "rollback" });
  const next = activation.createStoryboardDirectorContractDraft({ agentId: id, prompt, value: restored, now: oldProduction });
  const reactivated = normalize(next, restored, { action: "activate" }) as Record<string, unknown>;
  assert.equal(reactivated.production_contract_activated_at, serverNow); assert.equal(reactivated.performance_contract_activated_at, serverNow);
});
check("unrelated styles retain their original value and shape without activation", () => {
  for (const value of [{ fontSize: 16, private_style: [1, 2] }, {}, undefined, null, false, "legacy-style"]) assert.equal(normalize(value, {}, { agentId: "other-agent" }), value);
});

const source = readFileSync("src/components/admin/StoryboardDirectorContractEditor.tsx", "utf8");
const fixtureRequire = createRequire(path.resolve("package.json"));
const fixtureModule = { exports: {} as Record<string, unknown> };
const compiled = ts.transpileModule(source + "\nexports.__contractSignature = contractSignature;", { compilerOptions: {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX,
} }).outputText;
vm.runInNewContext(compiled, { exports: fixtureModule.exports, module: fixtureModule, require: (name: string) => {
  if (name === "@/lib/storyboard-director-contract-activation") return activation;
  if (name === "@/lib/storyboard-director-identity") return identity;
  return fixtureRequire(name);
} });
const Editor = fixtureModule.exports.default as ComponentType<{ agentId: string; prompt: string; value: object; disabled?: boolean; onChange: (value: object) => void; onRollback?: () => void }>;
check("real editor renders only the supported identity and prompt with four read-only contract rows", () => {
  const render = (agentId: string, systemPrompt: string, value: object = {}) => renderToStaticMarkup(createElement(Editor, { agentId, prompt: systemPrompt, value, onChange() {} }));
  assert.equal(render("other-agent", prompt), ""); assert.equal(render(id, "old prompt"), "");
  const html = render(id, prompt, { ...flags, private_prompt: "PRIVATE_SENTINEL" });
  for (const label of ["制作合同版本", "制作合同激活时间", "表演合同版本", "表演合同激活时间"]) assert.ok(html.includes(label));
  assert.ok(html.includes("已启用")); assert.ok(html.includes("disabled"));
  assert.doesNotMatch(html, /PRIVATE_SENTINEL|textarea|type="text"/u);
  const disabled = renderToStaticMarkup(createElement(Editor, { agentId: id, prompt, value: {}, disabled: true, onChange() {} }));
  assert.ok(disabled.includes("disabled")); assert.ok(disabled.includes("未启用"));
  const modern = renderToStaticMarkup(createElement(Editor, { agentId: id, prompt, value: flags, onChange() {}, onRollback() {} }));
  assert.match(modern, /<button[^>]*\sdisabled=""[^>]*>恢复旧版合同/u);
  const rollback = renderToStaticMarkup(createElement(Editor, { agentId: id, prompt: "old prompt", value: flags, onChange() {}, onRollback() {} }));
  assert.match(rollback, /恢复旧版合同/u); assert.doesNotMatch(rollback, /<button[^>]*\sdisabled=""[^>]*>恢复旧版合同/u);
});
check("actual editor click builds one pending draft without saving or bypassing disabled state", () => {
  const ast = ts.createSourceFile("Editor.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let handler = "";
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === "activate") handler = node.initializer?.getText(ast) || "";
    ts.forEachChild(node, visit);
  };
  visit(ast); assert.ok(handler);
  for (const [disabled, enabled] of [[false, false], [true, false], [false, true]]) {
    const changes: Record<string, unknown>[] = []; const pending: string[] = []; const errors: string[] = [];
    const callback = vm.runInNewContext(ts.transpileModule(`(${handler})`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, {
      agentId: id, prompt, value: { fontSize: 18 }, disabled, enabled, supportsActivation: true,
      createStoryboardDirectorContractDraft: activation.createStoryboardDirectorContractDraft,
      contractSignature: fixtureModule.exports.__contractSignature,
      setPendingSignature: (value: string) => pending.push(value), setError: (value: string) => errors.push(value),
      onChange: (value: Record<string, unknown>) => changes.push(value), Error,
    });
    callback();
    assert.equal(changes.length, disabled || enabled ? 0 : 1);
    assert.equal(pending.length, changes.length);
    if (changes.length) { assert.equal(changes[0].fontSize, 18); assert.equal(identity.hasStoryboardNarrativeRuntimeContract(changes[0]), true); assert.equal(errors[0], ""); }
  }
});
check("actual rollback click removes only four fields and signals a RAM action without persisting a temporary flag", () => {
  const ast = ts.createSourceFile("Editor.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let handler = "";
  const visit = (node: ts.Node) => { if (ts.isVariableDeclaration(node) && node.name.getText(ast) === "rollback") handler = node.initializer?.getText(ast) || ""; ts.forEachChild(node, visit); };
  visit(ast); assert.ok(handler);
  for (const [disabled, activated, supportsRollback] of [[false, true, true], [true, true, true], [false, false, true], [false, true, false]]) {
    const changes: Record<string, unknown>[] = []; let rollbackSignals = 0;
    const style = { ...flags, fontSize: 20, hybridImageGeneration: { enabled: true } };
    const callback = vm.runInNewContext(ts.transpileModule(`(${handler})`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, {
      disabled, activated, supportsRollback, style, STORYBOARD_DIRECTOR_CONTRACT_FIELDS: activation.STORYBOARD_DIRECTOR_CONTRACT_FIELDS,
      setPendingSignature() {}, setError() {}, onChange: (value: Record<string, unknown>) => changes.push(value), onRollback: () => { rollbackSignals++; },
    });
    callback();
    const expected = !disabled && activated && supportsRollback ? 1 : 0;
    assert.equal(changes.length, expected); assert.equal(rollbackSignals, expected);
    if (expected) assert.deepEqual(JSON.parse(JSON.stringify(changes[0])), { fontSize: 20, hybridImageGeneration: { enabled: true } });
  }
});

const report = { passed: true, checks, networkRequests: 0, databaseWrites: 0, modelRequests: 0, scope: "real server normalization helper, read-only SSR and actual controlled editor callback; saving belongs to the parent form" };
const output = ".codex-evidence/director-refinement-20261023/narrative-followup";
mkdirSync(output, { recursive: true }); writeFileSync(`${output}/contract-activation-result.json`, JSON.stringify(report, null, 2) + "\n"); console.log(JSON.stringify(report, null, 2));
