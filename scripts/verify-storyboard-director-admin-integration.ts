import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import * as activation from "../src/lib/storyboard-director-contract-activation";
import { STORY_DIRECTOR_MOVIE_AGENT_ID } from "../src/lib/story-director-overtime-gate";

const pagePath = "src/app/admin/page.tsx";
const routePath = "src/app/api/admin/agents/route.ts";
const pageSource = readFileSync(pagePath, "utf8");
const routeSource = readFileSync(routePath, "utf8");
const page = ts.createSourceFile(pagePath, pageSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const route = ts.createSourceFile(routePath, routeSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const prompt = readFileSync("prompts/storyboard-narrative-unified-20261023.md", "utf8");
const id = STORY_DIRECTOR_MOVIE_AGENT_ID;
const serverNow = "2026-10-23T20:00:00.000Z";
const flags = {
  production_contract_version: "storyboard_director_contract.v2", production_contract_activated_at: "2026-10-21T10:00:00+08:00",
  performance_contract: "storyboard_performance.v1", performance_contract_activated_at: "2026-10-22T12:00:00Z",
};
const checks: string[] = [];
async function check(name: string, test: () => void | Promise<void>) { await test(); checks.push(name); }
function plain<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
function findNode<T extends ts.Node>(source: ts.SourceFile, predicate: (node: ts.Node) => node is T): T {
  let match: T | undefined;
  const visit = (node: ts.Node) => { if (!match && predicate(node)) match = node; else if (!match) ts.forEachChild(node, visit); };
  visit(source); assert.ok(match, "所需源码节点必须存在"); return match;
}
function variable(source: ts.SourceFile, name: string): ts.VariableDeclaration {
  return findNode(source, (node): node is ts.VariableDeclaration => ts.isVariableDeclaration(node) && node.name.getText(source) === name);
}
function declaration(source: ts.SourceFile, name: string): string {
  return findNode(source, (node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === name).getText(source);
}
function evaluate<T>(source: string, context: Record<string, unknown>): T {
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  return vm.runInNewContext(compiled, { ...context, exports: {} }) as T;
}
const payloadBuilder = evaluate<(current: Record<string, unknown>, original: Record<string, unknown>, allowed: boolean) => Record<string, unknown>>(
  `const AGENT_EDITABLE_FIELDS = ${variable(page, "AGENT_EDITABLE_FIELDS").initializer!.getText(page)};
  ${["comparableAgentValue", "normalizedAgentPresetFields", "buildAgentUpdatePayload"].map(name => declaration(page, name)).join("\n")}
  buildAgentUpdatePayload;`, {},
);
const updateHandler = variable(page, "handleUpdateAgent").initializer!.getText(page);
type Row = Record<string, unknown> & { id: string; name: string; output_style: Record<string, unknown> };
const original: Row = { id, name: "电影叙事导演", config_revision: 7, system_prompt: prompt, output_style: { ...flags, fontSize: 14 }, category: "官方", user_access: "available", avatar: "", cover_url: "" };
function pageFixture(options: { success?: boolean; status?: number; canEditPrompts?: boolean; busy?: boolean; throws?: boolean; deferred?: Promise<void> } = {}) {
  let current: Row | null = { ...original, name: "保留用户名称草稿", system_prompt: "旧版完整提示词", output_style: { fontSize: 20, private_style: { keep: true } } };
  const action = { current: "rollback" as "rollback" | null };
  const originalRef: { current: Row | null } = { current: original };
  const sessionRef = { current: 1 };
  const requests: Record<string, unknown>[] = [];
  const messages: string[] = [];
  const busyValues: boolean[] = [];
  const handler = evaluate<() => Promise<void>>(`(${updateHandler});`, {
    canManageAgentConfiguration: true, canEditPrompts: options.canEditPrompts ?? true, agentSaveBusy: options.busy ?? false,
    editingAgent: current, editOriginalAgentRef: originalRef, directorContractActionRef: action,
    agentEditSession: 1, agentEditSessionRef: sessionRef, agentSaveInFlightRef: { current: false }, editPromptReading: false,
    closeAgentEditor: () => { sessionRef.current += 1; originalRef.current = null; action.current = null; current = null; },
    buildAgentUpdatePayload: payloadBuilder, STORYBOARD_DIRECTOR_CONTRACT_FIELDS: activation.STORYBOARD_DIRECTOR_CONTRACT_FIELDS,
    setEditingAgent: (value: Row | null | ((row: Row | null) => Row | null)) => { current = typeof value === "function" ? value(current) : value; },
    authHeaders: {}, fetch: async (_url: string, init: { body: string }) => {
      requests.push(JSON.parse(init.body)); if (options.deferred) await options.deferred;
      if (options.throws) throw new Error("模拟断开");
      return { ok: options.success ?? false, status: options.status ?? 400, json: async () => ({ success: options.success ?? false, code: options.status === 409 ? "AGENT_CONFIG_REVISION_CONFLICT" : undefined, error: "模拟失败" }) };
    },
    showMessage: (_kind: string, text: string) => messages.push(text), showSuccessAndSync: (text: string) => messages.push(text),
    setAgentSaveBusy: (value: boolean) => busyValues.push(value), editOriginalImagesRef: { current: { avatar: "", cover: "" } },
    setPendingEditAvatarKey() {}, setPendingEditCoverKey() {}, setEditAvatarPreview() {}, setEditAgentCoverPreview() {}, setEditShowAdvanced() {},
    discardPendingAgentImage() { throw new Error("测试不得触发素材操作"); }, loadAgents() {},
  });
  return { run: handler, action, originalRef, requests, messages, busyValues, current: () => current, switchTo: (row: Row) => { current = row; } };
}

async function main() {
  await check("真实保存回调在 400、409 和异常时只恢复四个合同字段，保留正文与其他草稿并清 RAM action", async () => {
    for (const options of [{ status: 400 }, { status: 409 }, { throws: true }]) {
      const fixture = pageFixture(options); await fixture.run();
      assert.equal(fixture.requests.length, 1); assert.equal(fixture.requests[0].directorContractAction, "rollback");
      assert.deepEqual(plain(fixture.current()), { ...original, name: "保留用户名称草稿", system_prompt: "旧版完整提示词", output_style: { ...flags, fontSize: 20, private_style: { keep: true } } });
      assert.equal(fixture.action.current, null); assert.deepEqual(fixture.busyValues, [true, false]);
    }
  });
  await check("真实保存回调成功后关闭编辑、清基线与 action，并一次提交提示词和合同配置", async () => {
    const fixture = pageFixture({ success: true }); await fixture.run();
    assert.equal(fixture.requests.length, 1); assert.equal(fixture.requests[0].system_prompt, "旧版完整提示词");
    assert.deepEqual(fixture.requests[0].output_style, { fontSize: 20, private_style: { keep: true } });
    assert.equal(fixture.requests[0].expected_revision, 7); assert.equal(fixture.current(), null);
    assert.equal(fixture.originalRef.current, null); assert.equal(fixture.action.current, null);
  });
  await check("权限失效时真实保存回调恢复合同并清 action，且不会提交；忙碌时不重复提交", async () => {
    const denied = pageFixture({ canEditPrompts: false }); await denied.run();
    assert.equal(denied.requests.length, 0); assert.equal(denied.action.current, null);
    assert.equal(denied.current()?.system_prompt, "旧版完整提示词");
    for (const key of activation.STORYBOARD_DIRECTOR_CONTRACT_FIELDS) assert.equal(denied.current()?.output_style[key], original.output_style[key]);
    const busy = pageFixture({ busy: true }); await busy.run(); assert.equal(busy.requests.length, 0);
  });
  await check("保存失败的迟到响应不会恢复到另一个智能体", async () => {
    let release!: () => void;
    const fixture = pageFixture({ deferred: new Promise<void>(resolve => { release = resolve; }) });
    const running = fixture.run(); const other = { ...original, id: "another-agent", output_style: { fontSize: 30 } };
    fixture.switchTo(other); release(); await running; assert.equal(fixture.current(), other); assert.equal(fixture.action.current, null);
  });
  const editor = findNode(page, (node): node is ts.JsxSelfClosingElement => ts.isJsxSelfClosingElement(node) && node.tagName.getText(page) === "StoryboardDirectorContractEditor");
  const editorAttribute = (name: string) => {
    const attribute = editor.attributes.properties.find((node): node is ts.JsxAttribute => ts.isJsxAttribute(node) && node.name.getText(page) === name);
    assert.ok(attribute?.initializer && ts.isJsxExpression(attribute.initializer) && attribute.initializer.expression);
    return (attribute.initializer as ts.JsxExpression).expression!.getText(page);
  };
  await check("真实编辑器属性只允许持久基线已激活的记录发 rollback；普通 onChange 清 action", () => {
    for (const value of [{}, flags, { ...flags, performance_contract_activated_at: "invalid" }]) {
      const action = { current: null as "rollback" | null };
      const handler = evaluate<(() => void) | undefined>(`(${editorAttribute("onRollback")});`, { hasActivatedStoryboardDirectorContract: activation.hasActivatedStoryboardDirectorContract, editOriginalAgentRef: { current: { output_style: value } }, directorContractActionRef: action, agentEditSession: 1, agentEditSessionRef: { current: 1 }, agentEditorAccessRef: { current: { prompts: true } } });
      assert.equal(typeof handler === "function", value === flags); handler?.(); assert.equal(action.current, value === flags ? "rollback" : null);
    }
    const action = { current: "rollback" as "rollback" | null }; let draft: unknown;
    evaluate<(value: unknown) => void>(`(${editorAttribute("onChange")});`, { directorContractActionRef: action, editingAgent: original, agentEditSession: 1, agentEditSessionRef: { current: 1 }, agentEditorAccessRef: { current: { prompts: true } }, setEditingAgent: (value: unknown) => { draft = typeof value === "function" ? value(original) : value; } })({ fontSize: 24 });
    assert.equal(action.current, null); assert.deepEqual(plain(draft), { ...original, output_style: { fontSize: 24 } });
    assert.ok(editor.parent.getText(page).includes("canEditPrompts &&")); assert.equal(editorAttribute("key"), "editingAgent.id"); assert.equal(editorAttribute("disabled"), "agentSaveBusy");
  });
  await check("取消、重新选择智能体和权限锁定均在源码处理函数中清除 RAM action", () => {
    const cancel = variable(page, "handleCancelEdit").initializer!.getText(page);
    assert.match(cancel, /closeAgentEditor\(agentEditSession\)/u);
    const begin = variable(page, "handleEditAgent").initializer!.getText(page);
    assert.match(begin, /directorContractActionRef\.current = null/u);
    const lock = findNode(page, (node): node is ts.CallExpression => ts.isCallExpression(node) && node.expression.getText(page) === "useEffect" && node.getText(page).includes("if (sensitiveUnlocked) return;") && node.getText(page).includes("closeAgentEditor()"));
    assert.match(lock.getText(page), /closeAgentEditor\(\)/u);
    const ref = variable(page, "directorContractActionRef").initializer!.getText(page); assert.match(ref, /useRef/u);
    assert.doesNotMatch(ref, /Storage|JSON/u);
  });

  const permissionDeclarations = ["AGENT_PROMPT_INPUT_KEYS", "AGENT_CONFIGURATION_INPUT_KEYS"].map(name => `const ${name} = ${variable(route, name).initializer!.getText(route)};`).join("\n")
    + declaration(route, "hasOwnInput") + declaration(route, "authorizeAgentFieldChanges");
  await check("真实字段鉴权对 action 同时要求 prompts.edit、models.manage 与 step-up，并在拒绝时停止", async () => {
    for (const denied of ["", "prompts.edit", "models.manage"]) {
      const calls: Array<{ capability: string; options: Record<string, unknown> }> = [];
      const failure = { status: 403 };
      const authorize = evaluate<(request: unknown, body: object) => Promise<unknown>>(`${permissionDeclarations}\nauthorizeAgentFieldChanges;`, {
        authorizeAdminCapability: async (_request: unknown, capability: string, options: Record<string, unknown>) => { calls.push({ capability, options }); return { ok: denied !== capability, response: failure }; },
      });
      const result = await authorize({}, { directorContractAction: "rollback" });
      assert.deepEqual(calls.map(call => call.capability), denied === "prompts.edit" ? ["prompts.edit"] : ["prompts.edit", "models.manage"]);
      assert.ok(calls.every(call => call.options.requireStepUp === true)); assert.equal(result, denied ? failure : null);
    }
  });
  const routeFunction = declaration(route, "PUT").replace(/^export\s+/u, "");
  function routeFixture(body: Record<string, unknown>, current: Record<string, unknown>, options: { denied?: string; conflict?: boolean; managementDenied?: boolean } = {}) {
    const queries: Array<{ table: string; select?: string; fields?: Record<string, unknown>; filters: Array<[string, unknown]> }> = [];
    const normalizations: Array<Parameters<typeof activation.normalizeStoryboardDirectorContractActivation>[0]> = [];
    const permissions: string[] = [];
    class FixedDate extends Date { constructor() { super(serverNow); } }
    const client = { from(table: string) {
      const query = { table, filters: [] as Array<[string, unknown]>, select: undefined as string | undefined, fields: undefined as Record<string, unknown> | undefined }; queries.push(query);
      const chain = {
        select(columns = "*") { query.select = columns; return chain; },
        eq(key: string, value: unknown) { query.filters.push([key, value]); return chain; },
        update(fields: Record<string, unknown>) { query.fields = fields; return chain; },
        async maybeSingle() { return { error: null, data: query.fields ? options.conflict ? null : { ...current, ...query.fields } : current }; },
      }; return chain;
    } };
    const handler = evaluate<(request: { json: () => Promise<unknown> }) => Promise<{ status: number; body: Record<string, unknown> }>>(`${permissionDeclarations}\n${routeFunction}\nPUT;`, {
      Date: FixedDate, console: { error() {} },
      authorizeAgentMutation: async () => ({ ok: !options.managementDenied, actor: { userId: "fixture-admin" }, response: { status: 403 } }),
      authorizeAdminCapability: async (_request: unknown, capability: string) => { permissions.push(capability); return { ok: capability !== options.denied, response: { status: 403, body: { code: "DENIED" } } }; },
      getSupabaseClient: () => client, isAgentRevisionSchemaMissing: () => false, categoryRequiresInternalAccess: async () => false,
      parseExpectedAgentRevision: (value: Record<string, unknown>) => value.expected_revision ?? null,
      expectedAgentRevisionRequired: () => ({ status: 400, body: { code: "AGENT_EXPECTED_REVISION_REQUIRED" } }),
      agentRevisionConflict: (expected: number, actual: number) => ({ status: 409, body: { code: "AGENT_CONFIG_REVISION_CONFLICT", expected, actual } }),
      replacementSecret: () => undefined,
      normalizeStoryboardDirectorContractActivation: (input: Parameters<typeof activation.normalizeStoryboardDirectorContractActivation>[0]) => { normalizations.push(input); return activation.normalizeStoryboardDirectorContractActivation(input); },
      StoryboardDirectorContractActivationError: activation.StoryboardDirectorContractActivationError,
      STORYBOARD_DIRECTOR_CONTRACT_FIELDS: activation.STORYBOARD_DIRECTOR_CONTRACT_FIELDS,
      invalidateAgentConfigCache() {}, invalidateBotsCache() {}, publicAgent: (value: unknown) => value,
      NextResponse: { json: (value: Record<string, unknown>, init?: { status: number }) => ({ status: init?.status ?? 200, body: value }) },
      agentImageFailure: () => null,
    });
    return { run: () => handler({ json: async () => body }), queries, normalizations, permissions };
  }
  const writes = (fixture: ReturnType<typeof routeFixture>) => fixture.queries.filter(query => query.fields);
  const submitted = { ...flags, production_contract_activated_at: "2099-01-01T00:00:00Z", performance_contract_activated_at: "2098-01-01T00:00:00Z", fontSize: 23 };
  await check("真实 PUT 从服务端行取得旧 prompt/style；首次激活由服务器时间归一化，一次 CAS 同存 prompt/style", async () => {
    const current = { ...original, output_style: { fontSize: 14 }, system_prompt: "旧服务端提示词" };
    const fixture = routeFixture({ agentId: id, expected_revision: 7, system_prompt: prompt, output_style: submitted, previousPrompt: "伪造旧稿", previousValue: flags }, current);
    assert.equal((await fixture.run()).status, 200); assert.equal(fixture.normalizations.length, 1);
    assert.equal(fixture.normalizations[0].previousPrompt, current.system_prompt); assert.equal(fixture.normalizations[0].previousValue, current.output_style);
    const write = writes(fixture); assert.equal(write.length, 1); assert.deepEqual(write[0].filters, [["id", id], ["config_revision", 7]]);
    assert.equal(write[0].fields?.system_prompt, prompt); assert.deepEqual(plain(write[0].fields?.output_style), { ...submitted, production_contract_activated_at: serverNow, performance_contract_activated_at: serverNow });
    assert.equal(write[0].fields?.updated_at, serverNow); assert.ok(fixture.queries[0].select?.includes("system_prompt,output_style"));
  });
  await check("真实 PUT 保留两个独立的既有激活时间，忽略客户端重置时间", async () => {
    const fixture = routeFixture({ agentId: id, expected_revision: 7, output_style: submitted }, original);
    assert.equal((await fixture.run()).status, 200); assert.deepEqual(plain(writes(fixture)[0].fields?.output_style), { ...flags, fontSize: 23 });
  });
  await check("真实 PUT 合法 rollback 同时保存旧稿与移除字段；action 从不进入持久字段", async () => {
    const fixture = routeFixture({ agentId: id, expected_revision: 7, directorContractAction: "rollback", system_prompt: "旧版完整提示词", output_style: { fontSize: 19 } }, original);
    assert.equal((await fixture.run()).status, 200); assert.deepEqual(plain(writes(fixture)[0].fields?.output_style), { fontSize: 19 });
    assert.equal(writes(fixture)[0].fields?.system_prompt, "旧版完整提示词"); assert.ok(!Object.hasOwn(writes(fixture)[0].fields!, "directorContractAction"));
    assert.deepEqual(fixture.permissions, ["prompts.edit", "models.manage"]);
  });
  await check("真实 PUT 拒绝隐式移除、部分标记降级与未知 action，返回 typed 400 且零写入", async () => {
    for (const changes of [{ output_style: {} }, { system_prompt: "旧版提示词" }, { system_prompt: prompt.replaceAll("storyboard_performance.v1", "removed_marker") }, { directorContractAction: "unknown" }, { directorContractAction: "rollback", system_prompt: prompt, output_style: {} }]) {
      const fixture = routeFixture({ agentId: id, expected_revision: 7, ...changes }, original); const result = await fixture.run();
      assert.equal(result.status, 400); assert.equal(result.body.code, "STORYBOARD_DIRECTOR_CONTRACT_INVALID"); assert.equal(writes(fixture).length, 0);
    }
  });
  await check("真实 PUT 直接修改合同四字段仍须 prompts.edit；只改无关样式时保持 models.manage 权限边界", async () => {
    const inactive = { ...original, output_style: { fontSize: 14 } };
    for (const field of ["output_style", "outputStyle"]) {
      const fixture = routeFixture({ agentId: id, expected_revision: 7, [field]: submitted }, inactive, { denied: "prompts.edit" });
      assert.equal((await fixture.run()).status, 403); assert.equal(writes(fixture).length, 0); assert.equal(fixture.normalizations.length, 0);
      assert.deepEqual(fixture.permissions, ["models.manage", "prompts.edit"]);
    }
    const unchanged = routeFixture({ agentId: id, expected_revision: 7, output_style: { ...flags, fontSize: 24 } }, original, { denied: "prompts.edit" });
    assert.equal((await unchanged.run()).status, 200); assert.deepEqual(unchanged.permissions, ["models.manage"]);
    assert.equal(writes(unchanged).length, 1);
  });
  await check("真实 PUT 在权限拒绝或读版本不符时不会读取合同归一化/写入，并保留最终 CAS 冲突保护", async () => {
    for (const denied of ["prompts.edit", "models.manage"]) {
      const fixture = routeFixture({ agentId: id, expected_revision: 7, directorContractAction: "rollback" }, original, { denied });
      assert.equal((await fixture.run()).status, 403); assert.equal(fixture.queries.length, 0); assert.equal(fixture.normalizations.length, 0);
    }
    for (const expected of [6, 8]) {
      const fixture = routeFixture({ agentId: id, expected_revision: expected, output_style: submitted }, original);
      assert.equal((await fixture.run()).status, 409); assert.equal(writes(fixture).length, 0); assert.equal(fixture.normalizations.length, 0);
    }
    const fixture = routeFixture({ agentId: id, expected_revision: 7, output_style: submitted }, original, { conflict: true });
    assert.equal((await fixture.run()).status, 409); assert.equal(writes(fixture).length, 1);
  });
  const files = [pagePath, routePath, "src/components/admin/StoryboardDirectorContractEditor.tsx", "src/lib/storyboard-director-contract-activation.ts", "scripts/verify-storyboard-director-admin-integration.ts", "scripts/verify-admin-agent-model-save-and-model-order-contract.ts"].map(path => ({ path, sha256: createHash("sha256").update(readFileSync(path)).digest("hex") }));
  const report = { passed: true, checkedAt: new Date().toISOString(), scope: "Actual AST-extracted admin callbacks and PUT with in-memory fakes; no live service or persistence", checks,
    promptTrimSha256: createHash("sha256").update(prompt.trim()).digest("hex"), files,
    effects: { networkRequests: 0, databaseReads: 0, databaseWrites: 0, modelRequests: 0, desktopActions: 0, builds: 0, portChanges: 0 },
    limitations: ["Real desktop verification, runningLatest identity, database activation and readback belong to root.", "CAS assertions cover the normal revision-managed path; pre-existing explicitly controlled local legacy mode remains outside this guarantee."] };
  const output = ".codex-evidence/director-refinement-20261023/narrative-followup";
  mkdirSync(output, { recursive: true }); writeFileSync(`${output}/admin-integration-result.json`, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
