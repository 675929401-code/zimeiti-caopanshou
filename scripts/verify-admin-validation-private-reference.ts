import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { readAdminValidationReferences, restoreAdminValidationReferenceInputs, resolveAdminValidationReference, sameAdminValidationReferenceScope, writeAdminValidationReference, type AdminValidationReferencePending } from "../src/lib/admin-image-validation-reference";

async function main() {
  let passed = 0;
  const check = (name: string, action: () => void) => { action(); passed++; console.log(`PASS ${name}`); };
  const data = new Map<string, string>();
  const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); } };
  const scope = { userId: "owner", modelId: "model", configurationHash: "a".repeat(64), index: 0 };
  const file = new File(["original"], "original.png", { type: "image/png" });
  const uuid = "bb548089-56fe-4ca3-872c-83fd47cb6456", key = "images/owned-original.png", url = "https://fixture.example/owned-original.png?signature=full";
  let posts = 0, gets = 0, decodes = 0, failRead = false, failDecode = false, current = true;
  const io = { scope, token: "fixture-token", stillCurrent: () => current, persist: (pending: AdminValidationReferencePending) => writeAdminValidationReference(storage, pending),
    fetcher: (async (path: string | URL | Request, init?: RequestInit) => { if (init?.method === "POST") { posts++; assert.equal(path, "/api/storage/upload"); const form = init.body as FormData; assert.equal(form.get("source"), "admin-image-validation-reference"); return Response.json({ success: true, file: { key, url: "" } }); } gets++; assert.equal(path, `/api/storyboard/image?storageKey=${encodeURIComponent(key)}`); return failRead ? Response.json({ error: "metadata pending" }, { status: 404 }) : Response.json({ assetId: uuid, storageKey: key, url }); }) as typeof fetch,
    decode: async (value: string) => { decodes++; assert.equal(value, url); if (failDecode) throw new Error("decode unavailable"); },
  };
  const owned = await resolveAdminValidationReference({ ...io, file });
  check("actual helper accepts empty private upload URL and resolves fresh owned URL", () => { assert.equal(posts, 1); assert.equal(gets, 1); assert.equal(decodes, 1); assert.equal(owned.assetId, uuid); assert.equal(owned.url, url); });
  check("durable pending is account scoped and excludes URL/token", () => { assert.deepEqual(readAdminValidationReferences(storage, "another-owner"), []); const raw = [...data.values()].join(""); assert.ok(!raw.includes(url)); assert.ok(!raw.includes("fixture-token")); assert.equal(readAdminValidationReferences(storage, "owner")[0].status, "ready"); });
  const pending: AdminValidationReferencePending = { ...scope, status: "uploaded", storageKey: key };
  failRead = true;
  await assert.rejects(() => resolveAdminValidationReference({ ...io, pending }), /归属暂未确认/u);
  check("404 read failure does not reupload", () => assert.equal(posts, 1));
  failRead = false;
  await resolveAdminValidationReference({ ...io, pending });
  check("explicit same-key retry is GET only", () => assert.equal(posts, 1));
  await assert.rejects(() => resolveAdminValidationReference({ ...io, pending, file }), /勿重复上传/u);
  check("pending key rejects an accidental repeated file upload", () => assert.equal(posts, 1));
  failDecode = true;
  await assert.rejects(() => resolveAdminValidationReference({ ...io, pending }), /decode unavailable/u);
  failDecode = false;
  await resolveAdminValidationReference({ ...io, pending });
  check("decode failure can recover original key without POST", () => assert.equal(posts, 1));
  current = false;
  await assert.rejects(() => resolveAdminValidationReference({ ...io, file }), /账号已变化/u);
  check("stale context before upload blocks all new requests", () => assert.equal(posts, 1));
  current = true;
  await assert.rejects(() => resolveAdminValidationReference({ ...io, file, fetcher: (async () => { posts++; current = false; return Response.json({ success: true, file: { key, url: "" } }); }) as typeof fetch }), /原图已上传/u);
  check("token change after upload retains original scoped key without owner read", () => assert.equal(readAdminValidationReferences(storage, "owner")[0].storageKey, key));
  current = true;
  await assert.rejects(() => resolveAdminValidationReference({ ...io, pending: { ...pending, configurationHash: "b".repeat(64) } }), /不属于/u);
  check("late config and slot records cannot cross scope", () => { assert.equal(sameAdminValidationReferenceScope(scope, { ...scope, index: 1 }), false); assert.equal(sameAdminValidationReferenceScope(scope, { ...scope, userId: "other" }), false); });
  await assert.rejects(() => resolveAdminValidationReference({ ...io, pending, fetcher: (async () => Response.json({ assetId: uuid, storageKey: "images/other.png", url })) as typeof fetch }), /归属暂未确认/u);
  check("wrong owned key is rejected", () => assert.equal(posts, 2));
  await assert.rejects(() => resolveAdminValidationReference({ ...io, file, persist: () => { throw new Error("storage unavailable"); } }), /storage unavailable/u);
  check("storage unavailable stops before upload", () => assert.equal(posts, 2));
  await assert.rejects(() => resolveAdminValidationReference({ ...io, file, fetcher: (async () => { posts++; throw new Error("upload network unknown"); }) as typeof fetch }), /upload network unknown/u);
  const unknown = readAdminValidationReferences(storage, "owner")[0];
  await assert.rejects(() => resolveAdminValidationReference({ ...io, pending: unknown }), /勿重复上传/u);
  check("unknown upload without key never automatically retries", () => { assert.equal(unknown.status, "unknown"); assert.equal(posts, 3); });
  const source = readFileSync("src/components/admin-image-validation-dialog.tsx", "utf8"), tree = ts.createSourceFile("dialog.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let uploadCode = "";
  const visit = (node: ts.Node) => { if (ts.isVariableDeclaration(node) && node.name.getText(tree) === "upload" && node.initializer) uploadCode = node.initializer.getText(tree); ts.forEachChild(node, visit); }; visit(tree); assert.ok(uploadCode);
  let inputs = { referenceImageUrls: [""] }, actualPosts = 0, actualGets = 0;
  const clean = new Map<string, string>(); const ram = { getItem: (value: string) => clean.get(value) ?? null, setItem: (name: string, value: string) => { clean.set(name, value); } };
  const callback = vm.runInNewContext(ts.transpileModule(`(${uploadCode})`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, {
    uploading: false, referenceUploadLock: { current: false }, busy: false, lock: { current: false }, attempt: null, preparedReason: "", preparedCorrection: false, inputs, dto: { configurationHash: scope.configurationHash },
    userId: scope.userId, modelId: scope.modelId, token: "fixture", mounted: { current: true }, referenceOwnerRef: { current: JSON.stringify([scope.userId, "fixture", scope.modelId, scope.configurationHash]) },
    referenceUploadsRef: { current: [] }, setReferenceUploads: () => {}, setUploading: () => {}, setConfirmed: () => {}, setError: () => {}, localStorage: ram,
    readAdminValidationReferences, resolveAdminValidationReference, sameAdminValidationReferenceScope, writeAdminValidationReference, imageValidationSafeError: (value: unknown) => value,
    setInputs: (update: (value: typeof inputs) => typeof inputs) => { inputs = update(inputs); },
    fetch: async (_path: string, init?: RequestInit) => { if (init?.method === "POST") { actualPosts++; return Response.json({ success: true, file: { key, url: "" } }); } actualGets++; return Response.json({ assetId: uuid, storageKey: key, url }); },
    Image: class { src = ""; naturalWidth = 1536; naturalHeight = 1024; async decode() {} }, JSON,
  });
  await callback(file, 0);
  check("actual dialog upload callback fills owned URL after empty upload URL", () => { assert.equal(actualPosts, 1); assert.equal(actualGets, 1); assert.equal(inputs.referenceImageUrls[0], url); });
  await callback(undefined, 0);
  check("actual dialog read button path repeats only owner GET", () => { assert.equal(actualPosts, 1); assert.equal(actualGets, 2); });
  const secondSlot: AdminValidationReferencePending = { ...scope, index: 1, status: "uploaded", storageKey: key };
  const restoreDto: Parameters<typeof restoreAdminValidationReferenceInputs>[0] = { modelId: scope.modelId, configurationHash: scope.configurationHash,
    capabilities: { resolutionOptions: ["1K"], defaultResolution: "1K", supportsReferenceInput: true, referenceInputMode: "multi", identityReferenceLevel: "multi-subject", maxReferenceImages: 3, maxCharacterReferences: 3, referenceCapabilityLabel: "fixture" } };
  const blank = { prompt: "", resolution: "1K" as const, aspectRatio: "1:1", referenceMode: false, referenceImageUrls: [] as string[] };
  const restoredInputs = restoreAdminValidationReferenceInputs(restoreDto, blank, [secondSlot], scope.userId);
  check("refresh restores second-slot reachability without any persisted URL or automatic GET", () => { assert.deepEqual(restoredInputs.referenceImageUrls, ["", ""]); assert.equal(restoredInputs.referenceMode, true); assert.equal(actualGets, 2); });
  check("other model or config receipt cannot enlarge current slots", () => { assert.equal(restoreAdminValidationReferenceInputs({ ...restoreDto, modelId: "other" }, blank, [secondSlot], scope.userId), blank); assert.equal(restoreAdminValidationReferenceInputs({ ...restoreDto, configurationHash: "b".repeat(64) }, blank, [secondSlot], scope.userId), blank); });
  assert.throws(() => restoreAdminValidationReferenceInputs({ ...restoreDto, capabilities: { ...restoreDto.capabilities, maxReferenceImages: 1 } }, blank, [secondSlot], scope.userId), /原记录已保留/u);
  check("restored slot above current capability fails closed without truncation", () => assert.equal(secondSlot.index, 1));
  writeAdminValidationReference(ram, secondSlot);
  inputs = { referenceImageUrls: restoredInputs.referenceImageUrls };
  await callback(undefined, 1);
  check("actual dialog manually re-reads second restored slot with zero upload", () => { assert.equal(actualPosts, 1); assert.equal(actualGets, 3); assert.deepEqual(inputs.referenceImageUrls, ["", url]); });
  let removalDisabled = "";
  const findRemoval = (node: ts.Node) => { if (ts.isJsxElement(node) && node.openingElement.tagName.getText(tree) === "button" && node.getText(tree).includes('referenceImageUrls.filter((_, slot)')) {
    const attribute = node.openingElement.attributes.properties.find(item => ts.isJsxAttribute(item) && item.name.getText(tree) === "disabled");
    if (attribute && ts.isJsxAttribute(attribute) && attribute.initializer && ts.isJsxExpression(attribute.initializer)) removalDisabled = attribute.initializer.expression?.getText(tree) || "";
  } ts.forEachChild(node, findRemoval); }; findRemoval(tree); assert.ok(removalDisabled);
  check("actual JSX blocks deleting earlier empty slot when later receipt exists", () => assert.equal(vm.runInNewContext(removalDisabled, { uploading: false, hasReferenceUploads: true }), true));
  console.log(JSON.stringify({ status: "PASS", passed, realUploads: 0, realProviderCalls: 0, realDatabaseWrites: 0 }));
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
