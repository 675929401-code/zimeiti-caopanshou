import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { describeReferenceUpload, readReferenceUploadPending, resolveReferenceUpload, writeReferenceUploadPending, type ReferenceUploadPending } from "../src/lib/storyboard-reference-upload";
import { removeVisualAssetBindings, rollbackVisualAssetMode, unresolvedVisualAssetBindingIds } from "../src/lib/storyboard-visual-asset-binding";

const text = readFileSync("src/components/storyboard-workbench.tsx", "utf8");
const tree = ts.createSourceFile("main.tsx", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function actualCallback(name: string, context: Record<string, unknown>) {
  let code = "";
  const visit = (node: ts.Node) => { if (ts.isVariableDeclaration(node) && node.name.getText(tree) === name && node.initializer) code = ts.isCallExpression(node.initializer) ? node.initializer.arguments[0].getText(tree) : node.initializer.getText(tree); ts.forEachChild(node, visit); };
  visit(tree); assert.ok(code, name);
  return vm.runInNewContext(ts.transpileModule(`const extracted = ${code}; extracted;`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, context);
}
async function main() {
  let checks = 0;
  const check = (name: string, fn: () => void) => { fn(); checks++; console.log(`PASS ${name}`); };
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
  const file = new File([new Uint8Array([1, 2, 3])], "fixture.png", { type: "image/png" });
  const description = await describeReferenceUpload(file);
  const pending: ReferenceUploadPending = { id: "upload-1", contextId: "project-1", contextKind: "project", draft: { planId: "slot-1", role: "pet", name: "柯基", prompt: "Original prompt", tagsText: "", customCategory: "" }, ...description, status: "uploading" };
  let current = true, uploads = 0, reads = 0, registers = 0, failRead = true, failCas = false;
  const persist = (value: ReferenceUploadPending | null, removeId?: string) => writeReferenceUploadPending(storage, "owner-A", value, removeId);
  const io = { persist, stillCurrent: () => current, upload: async () => { uploads++; return { storageKey: "images/original.png" }; }, readOwned: async (key: string) => { reads++; if (failRead) throw new Error("owner unavailable"); return { assetId: "owned-uuid", storageKey: key, url: "https://fixture.example/original.png?signature=fresh" }; }, register: async () => { registers++; return failCas ? null : { candidate: "confirmed" }; } };
  await assert.rejects(() => resolveReferenceUpload({ ...io, pending, file }), /owner unavailable/u);
  const saved = readReferenceUploadPending(storage, "owner-A")[0];
  check("successful upload key survives owner failure", () => { assert.equal(uploads, 1); assert.equal(saved.storageKey, "images/original.png"); assert.equal(saved.status, "uploaded"); assert.equal(registers, 0); });
  check("pending storage contains no signed URL or token", () => { assert.ok(![...values.values()].join("").includes("https://")); assert.deepEqual(readReferenceUploadPending(storage, "owner-B"), []); });
  failRead = false; failCas = true;
  await assert.rejects(() => resolveReferenceUpload({ ...io, pending: saved }), /候选保存未确认/u);
  check("CAS failure retains original key and never reuploads", () => { assert.equal(uploads, 1); assert.equal(readReferenceUploadPending(storage, "owner-A")[0].storageKey, saved.storageKey); });
  failCas = false;
  const result = await resolveReferenceUpload({ ...io, pending: saved });
  check("explicit resume reads same key and removes confirmed pending", () => { assert.equal(uploads, 1); assert.equal(reads, 3); assert.deepEqual(result, { candidate: "confirmed" }); assert.deepEqual(readReferenceUploadPending(storage, "owner-A"), []); });
  current = false;
  await assert.rejects(() => resolveReferenceUpload({ ...io, pending, file }), /参考位置已变化/u);
  check("stale owner or project before upload sends no POST", () => assert.equal(uploads, 1));
  current = true;
  await assert.rejects(() => resolveReferenceUpload({ ...io, pending, file, upload: async () => { uploads++; current = false; return { storageKey: "images/late.png" }; } }), /原图已上传/u);
  check("late upload retains original scope key without registration", () => { const late = readReferenceUploadPending(storage, "owner-A")[0]; assert.equal(late.contextId, "project-1"); assert.equal(late.storageKey, "images/late.png"); assert.equal(registers, 2); });
  current = true;
  await assert.rejects(() => resolveReferenceUpload({ ...io, pending: { ...pending, id: "unknown-1" }, file, upload: async () => { uploads++; throw new Error("network unknown"); } }), /network unknown/u);
  const unknown = readReferenceUploadPending(storage, "owner-A").find(item => item.id === "unknown-1")!;
  await assert.rejects(() => resolveReferenceUpload({ ...io, pending: unknown }), /上传结果尚未确认/u);
  check("unknown upload is recorded and cannot automatically POST again", () => { assert.equal(unknown.status, "unknown"); assert.equal(uploads, 3); });
  let attemptedUploads = 0;
  await assert.rejects(() => resolveReferenceUpload({ ...io, pending, file, persist: () => { throw new Error("storage blocked"); }, upload: async () => { attemptedUploads++; return { storageKey: "unused" }; } }), /storage blocked/u);
  check("unavailable local persistence blocks upload before POST", () => assert.equal(attemptedUploads, 0));
  await assert.rejects(() => describeReferenceUpload(new File(["x"], "bad.txt", { type: "text/plain" })), /5MB/u);
  check("unsupported file rejected without model or upload call", () => assert.equal(uploads, 3));
  const plan = { mode: "selected" as const, assets: [{ id: "slot-1", role: "pet" as const, name: "Pet", description: "", imagePrompt: "", referenceKinds: ["identity" as const], source: { kind: "generated-image-history" as const, assetId: "owned", storageKey: "images/pet.png" } }] };
  const original = { id: "project-1", visualAssetPlan: plan, cards: [{ id: "card-1", order: 1, imageRequestSnapshot: { original: true }, referenceImageUrls: ["https://fixture.example/manual.png", "https://fixture.example/images/pet.png"], visualAssetRefs: [{ assetId: "slot-1", role: "pet" as const, referenceKinds: ["identity" as const], ownedReferenceUrl: "https://fixture.example/images/pet.png", boundReferenceUrl: "https://fixture.example/images/pet.png" }] }] };
  const runRef = { current: original };
  const context = { contextReadyRef: { current: true }, navigationRef: { current: false }, scopeMountedRef: { current: true }, visualAssetMutationRef: { current: false }, visualAssetGenerationRef: { current: false }, referenceUploadOperationRef: { current: null }, imageSubmissionsRef: { current: new Set() }, videoSubmissionsRef: { current: new Set() }, boardExportLocksRef: { current: new Set() }, userId: "owner", token: "token", imageDownloadOwnerRef: { current: "owner\0token" }, runRef, setRun: () => {}, setVisualAssetSaving: () => {}, setNotice: () => {}, removeVisualAssetBindings, unresolvedVisualAssetBindingIds, rollbackVisualAssetMode, createStoryboardPersistenceSnapshot: (value: unknown) => value, saveStoryboardProject: async () => false };
  const select = actualCallback("selectVisualAssetMode", context);
  assert.equal(await select("off"), false);
  check("actual off callback CAS failure preserves plan/manual/paid snapshot", () => { assert.equal(runRef.current.visualAssetPlan, plan); assert.deepEqual(runRef.current.cards[0], original.cards[0]); });
  const success = actualCallback("selectVisualAssetMode", { ...context, saveStoryboardProject: async () => true });
  assert.equal(await success("off"), true);
  check("actual off callback only removes auto references", () => { assert.equal(runRef.current.visualAssetPlan.mode, "off"); assert.deepEqual(Array.from(runRef.current.cards[0].referenceImageUrls), ["https://fixture.example/manual.png"]); assert.equal(runRef.current.cards[0].imageRequestSnapshot, original.cards[0].imageRequestSnapshot); });
  let selectedCalls = 0, display = "normal";
  const displayCallback = actualCallback("changeReferenceDisplayMode", { ...context, setReferenceDisplayMode: (value: string) => { display = value; }, selectVisualAssetMode: async () => { selectedCalls++; return false; } });
  await displayCallback("reference");
  check("entering role mode is display only with zero binding calls", () => { assert.equal(display, "reference"); assert.equal(selectedCalls, 0); });
  runRef.current = original;
  await displayCallback("normal");
  check("failed off CAS does not hide role UI", () => { assert.equal(display, "reference"); assert.equal(selectedCalls, 1); });
  const tokenOwner = { current: "owner\0token" };
  const tokenMode = actualCallback("selectVisualAssetMode", { ...context, imageDownloadOwnerRef: tokenOwner, saveStoryboardProject: async () => { tokenOwner.current = "owner\0new-token"; return false; } });
  assert.equal(await tokenMode("off"), false);
  check("token changed during mode CAS restores original automatic references", () => { assert.equal(runRef.current.visualAssetPlan, plan); assert.deepEqual(runRef.current.cards[0].referenceImageUrls, original.cards[0].referenceImageUrls); });
  let restoreEffect = "";
  const findRestore = (node: ts.Node) => { if (ts.isCallExpression(node) && node.expression.getText(tree) === "useEffect" && node.arguments[0]?.getText(tree).includes('referenceDisplayContextRef.current = run.id')) restoreEffect = node.arguments[0].getText(tree); ts.forEachChild(node, findRestore); };
  findRestore(tree); assert.ok(restoreEffect);
  for (const mode of ["off", "selected"] as const) {
    let restored = "";
    vm.runInNewContext(ts.transpileModule(`(${restoreEffect})()`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, { storageReady: true, contextReadyRef: { current: true }, projectContext: "ready", referenceDisplayContextRef: { current: "" }, run: { id: "restored", visualAssetPlan: { ...plan, mode } }, setReferenceDisplayMode: (value: string) => { restored = value; } });
    check(`actual restore effect respects persisted ${mode}`, () => assert.equal(restored, mode === "off" ? "normal" : "reference"));
  }
  const uploadStorage = new Map<string, string>();
  const ram = { getItem: (key: string) => uploadStorage.get(key) ?? null, setItem: (key: string, value: string) => { uploadStorage.set(key, value); } };
  const uploadRun = { current: { id: "project-actual", visualAssetWorkspace: { drafts: [pending.draft], candidates: [] } } };
  const uploadOperation = { current: null as string | null };
  const uploadMutation = { current: false };
  let actualPosts = 0, actualRead = 0, actualCas = false;
  const nativeCallback = actualCallback("uploadReferenceImage", { ...context, runRef: uploadRun, referenceUploadOperationRef: uploadOperation, referenceUploadPendingRef: { current: [] }, visualAssetMutationRef: uploadMutation,
    userId: "actual-owner", token: "actual-token", imageDownloadOwnerRef: { current: "actual-owner\0actual-token" }, crypto, FormData, AbortSignal, localStorage: ram,
    referenceOnly: false, readReferenceUploadPending, writeReferenceUploadPending, describeReferenceUpload, resolveReferenceUpload,
    setReferenceUploadPending: () => {}, setVisualAssetError: () => {}, saveVisualAssetContext: async () => { throw new Error("project upload must not create a reference session"); },
    fetch: async (_url: string, init: RequestInit) => { actualPosts++; assert.equal(_url, "/api/storage/upload"); const form = init.body as FormData; assert.equal(form.get("source"), "storyboard-reference-upload"); assert.equal(form.get("category"), "image"); return Response.json({ success: true, file: { key: "images/actual.png" } }); },
    readOwnedStoryboardImage: async (reference: { storageKey: string }) => { actualRead++; return { assetId: "actual-owned", storageKey: reference.storageKey, url: "https://fixture.example/actual.png", width: 1774, height: 887 }; },
    importReferenceImage: async (_image: unknown, _input: unknown, operation: string) => { assert.equal(operation, uploadOperation.current); assert.equal(uploadMutation.current, true, "internal import holds upload lock without a gap"); return actualCas ? { assetId: "actual-owned", planId: pending.draft.planId } : null; },
  });
  assert.equal(await nativeCallback(file, pending.draft), null);
  check("actual native callback CAS failure retains key with one upload", () => { assert.equal(actualPosts, 1); assert.equal(readReferenceUploadPending(ram, "actual-owner")[0].storageKey, "images/actual.png"); assert.equal(uploadMutation.current, false); });
  actualCas = true;
  assert.ok(await nativeCallback(undefined, pending.draft));
  check("actual native callback explicit read retry does not upload twice", () => { assert.equal(actualPosts, 1); assert.equal(actualRead, 2); assert.deepEqual(readReferenceUploadPending(ram, "actual-owner"), []); });
  const lateOwner = { current: "late-owner\0old-token" };
  const latePending = { current: [] as ReferenceUploadPending[] };
  let latePosts = 0, lateReads = 0, lateRegisters = 0;
  const lateCallback = actualCallback("uploadReferenceImage", { ...context, runRef: uploadRun, referenceUploadOperationRef: { current: null }, referenceUploadPendingRef: latePending, visualAssetMutationRef: { current: false },
    userId: "late-owner", token: "old-token", imageDownloadOwnerRef: lateOwner, crypto, FormData, AbortSignal, localStorage: ram, referenceOnly: false,
    readReferenceUploadPending, writeReferenceUploadPending, describeReferenceUpload, resolveReferenceUpload, setReferenceUploadPending: () => {}, setVisualAssetError: () => {},
    fetch: async () => { latePosts++; lateOwner.current = "late-owner\0new-token"; return Response.json({ success: true, file: { key: "images/late-owned.png" } }); },
    readOwnedStoryboardImage: async () => { lateReads++; }, importReferenceImage: async () => { lateRegisters++; },
  });
  assert.equal(await lateCallback(file, pending.draft), null);
  check("actual same-user token switch retains original key but never binds late response", () => { assert.equal(latePosts, 1); assert.equal(lateReads, 0); assert.equal(lateRegisters, 0); assert.equal(readReferenceUploadPending(ram, "late-owner")[0].storageKey, "images/late-owned.png"); assert.equal(latePending.current.length, 1, "only the pre-upload original scope RAM record remains"); });
  const child = readFileSync("src/components/storyboard-visual-assets-drawer.tsx", "utf8");
  check("native slot and creator use exact accessible upload/read hooks", () => { assert.ok(child.includes('data-testid="reference-native-upload"')); assert.ok(child.includes('data-testid="reference-upload-read"')); assert.ok(text.includes('source", "storyboard-reference-upload"')); assert.ok(text.includes('useState<"normal" | "reference">("normal")')); assert.ok(text.includes('run.visualAssetPlan?.mode === "selected" ? run.visualAssetPlan.assets : []')); });
  console.log(JSON.stringify({ status: "PASS", checks, realProviderCalls: 0, realUploads: 0, realDatabaseWrites: 0 }));
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
