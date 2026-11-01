import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import * as activation from "../src/lib/storyboard-director-contract-activation";
import { hasStoryboardNarrativeRuntimeContract } from "../src/lib/storyboard-director-identity";

const sourcePath = "src/app/admin/page.tsx";
const source = readFileSync(sourcePath, "utf8");
const ast = ts.createSourceFile(sourcePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function nodes(predicate: (node: ts.Node) => boolean) {
  const found: ts.Node[] = []; const visit = (node: ts.Node) => { if (predicate(node)) found.push(node); ts.forEachChild(node, visit); }; visit(ast); return found;
}
function variable(name: string) { const node = nodes(node => ts.isVariableDeclaration(node) && node.name.getText(ast) === name)[0] as ts.VariableDeclaration; assert.ok(node?.initializer, name); return node.initializer!.getText(ast); }
function declaration(name: string) { const node = nodes(node => ts.isFunctionDeclaration(node) && node.name?.text === name)[0]; assert.ok(node, name); return node.getText(ast); }
function evaluate<T>(code: string, context: Record<string, unknown>): T {
  return vm.runInNewContext(ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, { ...context, exports: {} }) as T;
}
const buildPayload = evaluate<(current: Row, original: Row, canEdit: boolean) => Record<string, unknown>>(
  `const AGENT_EDITABLE_FIELDS = ${variable("AGENT_EDITABLE_FIELDS")};\n${["comparableAgentValue", "normalizedAgentPresetFields", "buildAgentUpdatePayload"].map(declaration).join("\n")}\nbuildAgentUpdatePayload;`, {},
);
const fileChange = (nodes(node => ts.isJsxAttribute(node) && node.name.getText(ast) === "onChange" && Boolean(node.initializer?.getText(ast).includes("new FileReader()")) && Boolean(node.initializer?.getText(ast).includes("setEditingAgent")))[0] as ts.JsxAttribute).initializer as ts.JsxExpression;
const editor = nodes(node => ts.isJsxSelfClosingElement(node) && node.tagName.getText(ast) === "StoryboardDirectorContractEditor")[0] as ts.JsxSelfClosingElement;
const contractChange = (editor.attributes.properties.find(node => ts.isJsxAttribute(node) && node.name.getText(ast) === "onChange") as ts.JsxAttribute).initializer as ts.JsxExpression;
const accessEffect = nodes(node => ts.isCallExpression(node) && node.expression.getText(ast) === "useEffect" && node.getText(ast).includes("agentEditorAccessRef.current ="))[0] as ts.CallExpression;
type Row = { id: string; name: string; config_revision: number; system_prompt: string; output_style: Record<string, unknown>; avatar: string; cover_url: string; [key: string]: unknown };
const prompt = readFileSync("prompts/storyboard-narrative-unified-20261023.md", "utf8");
const row = (id = "agent-1786633444187-594spj"): Row => ({ id, name: id, config_revision: 7, system_prompt: prompt, output_style: {}, avatar: `${id}-avatar`, cover_url: `${id}-cover` });
function fixture() {
  let draft: Row | null = null; let session = 0; let busy = false; let reading = false;
  let avatarPreview = ""; let coverPreview = ""; let pendingAvatar = ""; let pendingCover = "";
  let avatarBusy = false; let coverBusy = false;
  const sessionRef = { current: 0 }; const originalRef: { current: Row | null } = { current: null };
  const promptReadRef = { current: 0 };
  const actionRef = { current: null as "rollback" | null }; const inFlight = { current: false };
  const imagesRef = { current: { avatar: "", cover: "" } }; const accessRef = { current: { configuration: true, prompts: true } };
  const requests: Array<{ url: string; body: Record<string, unknown>; resolve: (value: unknown) => void }> = [];
  const uploads: Array<{ resolve: (value: unknown) => void }> = []; const discarded: string[] = []; const messages: string[] = [];
  const readers: Array<{ onload?: (event: unknown) => void; onerror?: () => void }> = [];
  class Reader { onload?: (event: unknown) => void; onerror?: () => void; constructor() { readers.push(this); } readAsText() {} }
  const rawSet = (value: Row | null | ((current: Row | null) => Row | null)) => { draft = typeof value === "function" ? value(draft) : value; };
  function render() {
    const context: Record<string, unknown> = {
      agentEditSession: session, agentEditSessionRef: sessionRef, editOriginalAgentRef: originalRef, directorContractActionRef: actionRef,
      agentPromptReadRef: promptReadRef,
      agentSaveInFlightRef: inFlight, agentEditorAccessRef: accessRef, editingAgent: draft,
      agentSaveBusy: busy, editPromptReading: reading, canManageAgentConfiguration: accessRef.current.configuration, canEditPrompts: accessRef.current.prompts,
      setEditingAgentState: rawSet, setAgentEditSession: (value: number) => { session = value; }, setEditPromptReading: (value: boolean) => { reading = value; },
      setAgentSaveBusy: (value: boolean) => { busy = value; }, setPendingEditAvatarKey: (value: string) => { pendingAvatar = value; }, setPendingEditCoverKey: (value: string) => { pendingCover = value; },
      setEditAvatarPreview: (value: string) => { avatarPreview = value; }, setEditAgentCoverPreview: (value: string) => { coverPreview = value; },
      setEditAvatarUploading: (value: boolean) => { avatarBusy = value; }, setEditAgentCoverUploading: (value: boolean) => { coverBusy = value; },
      editOriginalImagesRef: imagesRef, pendingEditAvatarKey: pendingAvatar, pendingEditCoverKey: pendingCover,
      setEditShowAdvanced() {}, resolveTrashAvatarSrc: (agent: Row) => agent.avatar, resolveAvatarPreviewSrc: (value: string) => value,
      loadLlmModels() {}, loadDrawingModels() {}, loadAgents() {}, structuredClone,
      showMessage: (_kind: string, text: string) => messages.push(text), showSuccessAndSync: (text: string) => messages.push(text),
      buildAgentUpdatePayload: buildPayload, STORYBOARD_DIRECTOR_CONTRACT_FIELDS: activation.STORYBOARD_DIRECTOR_CONTRACT_FIELDS, authHeaders: {},
      fetch: (url: string, init: { body: string }) => new Promise(resolve => { requests.push({ url, body: JSON.parse(init.body), resolve }); }),
      uploadAgentImage: () => new Promise(resolve => { uploads.push({ resolve }); }), discardPendingAgentImage: (key: string) => { discarded.push(key); },
      FileReader: Reader,
      newAgent: { name: "new", description: "" }, singleAvatarStyle: "fixture", singleAvatarCustomPrompt: "", avatarCandidates: [], token: "",
      confirm: () => true, window: { crypto: { randomUUID: () => "fixture-idempotency" } }, setSingleAvatarGenerating() {}, setSingleAvatarMode() {}, setSingleAvatarStatus() {}, setAvatarCandidates() {}, safeLocalStorageSet() {},
    };
    context.setEditingAgent = evaluate(variable("setEditingAgent"), context);
    context.closeAgentEditor = evaluate(variable("closeAgentEditor"), context);
    const callback = <T>(name: string) => evaluate<T>(`(${variable(name)});`, context);
    return {
      open: callback<(agent: Row) => void>("handleEditAgent"), close: callback<() => void>("handleCancelEdit"), save: callback<() => Promise<void>>("handleUpdateAgent"),
      uploadAvatar: callback<(event: unknown) => Promise<void>>("handleEditAvatarUpload"), uploadCover: callback<(event: unknown) => Promise<void>>("handleEditCoverUpload"),
      generateAvatar: callback<(mode: "edit") => Promise<void>>("generateSingleAvatar"),
      file: evaluate<(event: unknown) => void>(`(${fileChange.expression!.getText(ast)});`, context),
      contract: evaluate<(value: unknown) => void>(`(${contractChange.expression!.getText(ast)});`, context),
      update: context.setEditingAgent as (value: unknown) => void,
      permission: evaluate<() => void>(`(${accessEffect.arguments[0].getText(ast)});`, context),
    };
  }
  const respond = (index: number, success: boolean) => requests[index].resolve({ ok: success, status: success ? 200 : 400, json: async () => ({ success, error: "fixture failure" }) });
  return { render, requests, readers, uploads, discarded, messages, originalRef, actionRef, inFlight, accessRef, respond,
    state: () => ({ draft, session, busy, reading, avatarPreview, coverPreview, pendingAvatar, pendingCover, avatarBusy, coverBusy }),
    pending: () => { pendingAvatar = "B-pending-avatar"; pendingCover = "B-pending-cover"; },
  };
}
const checks: string[] = [];
async function check(name: string, run: () => Promise<void> | void) { await run(); checks.push(name); }
const fileEvent = () => ({ target: { files: [{}], value: "selected" } });
async function main() {
  await check("actual file completion preserves a contract enabled after the read started", async () => {
    const f = fixture(); f.render().open(row()); let view = f.render(); view.file(fileEvent());
    view.contract(activation.createStoryboardDirectorContractDraft({ agentId: row().id, prompt, value: {} }));
    assert.equal(hasStoryboardNarrativeRuntimeContract(f.state().draft?.output_style), true);
    f.readers[0].onload!({ target: { result: `${prompt}\nfixture upload` } });
    assert.equal(hasStoryboardNarrativeRuntimeContract(f.state().draft?.output_style), true); assert.equal(f.state().reading, false);
    view = f.render(); const saving = view.save(); assert.equal(f.requests.length, 1); f.respond(0, true); await saving;
    assert.equal(f.state().draft, null); assert.equal(f.originalRef.current, null);
    f.readers[0].onload!({ target: { result: prompt } }); view.contract({}); view.update(row());
    assert.equal(f.state().draft, null); assert.equal(f.originalRef.current, null);
  });
  await check("file reading blocks save and late callbacks cannot affect a closed or reopened same-id editor", async () => {
    const f = fixture(); f.render().open(row()); const old = f.render(); old.file(fileEvent());
    await f.render().save(); assert.equal(f.requests.length, 0); assert.equal(f.state().reading, true);
    f.render().close(); f.render().open(row()); const baseline = f.originalRef.current;
    f.readers[0].onload!({ target: { result: "stale prompt" } }); old.update({ ...row(), name: "stale name" }); old.contract({ unsafe: true }); old.close();
    assert.equal(f.state().draft?.system_prompt, prompt); assert.equal(f.state().draft?.name, row().name); assert.equal(f.originalRef.current, baseline);
    assert.deepEqual(f.state().draft?.output_style, {});
  });
  await check("only the newest file read owns prompt contents and the save gate under either completion order", async () => {
    for (const order of [[0, 1], [1, 0]]) {
      const f = fixture(); f.render().open(row()); f.render().file(fileEvent()); f.render().file(fileEvent());
      for (const index of order) {
        f.readers[index].onload!({ target: { result: index === 0 ? "oldest-selected" : "newest-selected" } });
        if (index === 0 && order[0] === 0) { assert.equal(f.state().reading, true); await f.render().save(); assert.equal(f.requests.length, 0); }
      }
      assert.equal(f.state().draft?.system_prompt, "newest-selected"); assert.equal(f.state().reading, false);
    }
  });
  await check("same-render duplicate save clicks issue one request using the synchronous owner lock", async () => {
    const f = fixture(); f.render().open(row()); const view = f.render(); view.update({ ...row(), name: "changed" });
    const savingView = f.render(); const first = savingView.save(); const second = savingView.save();
    assert.equal(f.requests.length, 1); assert.equal(f.inFlight.current, true); f.respond(0, true); await Promise.all([first, second]); assert.equal(f.inFlight.current, false);
  });
  await check("late success or failure preserves new same-id and different-id sessions including actions and image ownership", async () => {
    for (const id of [row().id, "agent_B"]) for (const success of [true, false]) {
      const f = fixture(); f.render().open(row()); f.render().update({ ...row(), name: "save A" }); const saving = f.render().save();
      f.render().close(); f.render().open(row(id)); f.pending(); f.actionRef.current = "rollback"; const baseline = f.originalRef.current;
      await f.render().save(); assert.equal(f.requests.length, 1);
      f.respond(0, success); await saving;
      assert.equal(f.state().draft?.id, id); assert.equal(f.state().draft?.name, id); assert.equal(f.originalRef.current, baseline); assert.equal(f.actionRef.current, "rollback");
      assert.equal(f.state().pendingAvatar, "B-pending-avatar"); assert.equal(f.state().pendingCover, "B-pending-cover");
      assert.ok(!f.discarded.includes(`${id}-avatar`) && !f.discarded.includes(`${id}-cover`)); assert.equal(f.inFlight.current, false);
    }
  });
  await check("late avatar and cover uploads do not change another session or its preview/pending/busy state", async () => {
    for (const kind of ["uploadAvatar", "uploadCover"] as const) {
      const f = fixture(); f.render().open(row()); const uploading = f.render()[kind](fileEvent()); f.render().close(); f.render().open(row("agent_B")); f.pending();
      const before = f.state(); f.uploads[0].resolve({ key: "A-late-upload", url: "A-late-preview", width: 256, height: 256 }); await uploading;
      assert.deepEqual(f.state(), before); assert.deepEqual(f.discarded.filter(value => value === "A-late-upload"), ["A-late-upload"]);
    }
  });
  await check("late generated-avatar response cannot populate another open editor", async () => {
    const f = fixture(); f.render().open(row()); const generating = f.render().generateAvatar("edit"); f.render().close(); f.render().open(row("agent_B")); const before = f.state();
    f.requests[0].resolve({ ok: true, json: async () => ({ success: true, results: [{ success: true, avatarUrl: "A-generated" }] }) }); await generating;
    assert.deepEqual(f.state(), before);
  });
  await check("current permission revocation rejects late file contents and configuration revocation invalidates the session", () => {
    const f = fixture(); f.render().open(row()); f.render().file(fileEvent()); f.accessRef.current.prompts = false; f.render().permission();
    f.readers[0].onload!({ target: { result: "forbidden late prompt" } }); assert.equal(f.state().draft?.system_prompt, prompt); assert.equal(f.state().reading, false);
    const old = f.render(); f.accessRef.current.configuration = false; f.render().permission(); assert.equal(f.state().draft, null); assert.equal(f.originalRef.current, null);
    f.accessRef.current = { configuration: true, prompts: true }; f.render().permission(); old.update(row()); assert.equal(f.state().draft, null);
  });
  const report = { passed: true, checkedAt: new Date().toISOString(), checks, sourceSha256: createHash("sha256").update(source).digest("hex"),
    scope: "Actual AST-extracted begin/close/draft/save/FileReader/upload/generation/effect callbacks; in-memory responses and state only",
    effects: { networkRequests: 0, databaseReads: 0, databaseWrites: 0, modelRequests: 0, desktopActions: 0, builds: 0 },
    limitation: "The source timing defects are reproduced and covered offline; live incident trigger and final desktop behavior belong to root." };
  const output = ".codex-evidence/narrative-refinement-20261023"; mkdirSync(output, { recursive: true }); writeFileSync(`${output}/admin-editor-session-result.json`, JSON.stringify(report, null, 2) + "\n"); console.log(JSON.stringify(report, null, 2));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
