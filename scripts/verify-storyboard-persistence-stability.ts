import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { createStoryboardPersistenceSnapshot } from "../src/lib/storyboard-local-persistence";
import { generatedImagePreviewUrl } from "../src/lib/generated-image-reference";
import { storyboardImageUnavailablePatch } from "../src/lib/storyboard-image-result-state";
import { inspectStoryboardRecoveryEdits, preserveStoryboardRecoveryConflict, readStoryboardRecovery, readStoryboardRecoveryConflicts, storyboardRecoveryContentFingerprint, writeStoryboardRecovery } from "../src/lib/storyboard-workspace-recovery";
import { validateOwnedGeneratedImageReceipt, validateOwnedGeneratedImageReference, resolveGeneratedImageReference, type GeneratedImageReferenceDependencies } from "../src/lib/server/generated-image-reference";

const checks: string[] = [];
const check = async (name: string, action: () => unknown) => { await action(); checks.push(name); };
const before = Object.fromEntries(["src/hooks/use-storyboard-projects.ts", "src/lib/storyboard-workspace-recovery.ts", "src/app/api/storyboard/projects/route.ts", "src/lib/server/generated-image-reference.ts"].map(path => [path, createHash("sha256").update(readFileSync(path)).digest("hex")]));
async function main() {
  const oldUrl = "https://assets.invalid/a.png?x-cos-process=image/crop,w_100&variant=front&q-signature=old&q-sign-time=old";
  const newUrl = oldUrl.replace("q-signature=old&q-sign-time=old", "q-sign-time=new&q-signature=new");
  const base = { id: "project-stable", title: "saved", createdAt: 1, updatedAt: 2, ratio: "16:9", imageResolution: "2K", videoResolution: "1080p", videoDuration: 10,
    imageModelId: "image", videoModelId: "video", cards: [{ id: "card-a", order: 1, imageStatus: "idle", videoStatus: "idle", imagePrompt: "saved", videoPrompt: "", referenceImageUrls: [oldUrl], visualAssetRefs: [{ role: "character", assetId: "actor", boundReferenceUrl: oldUrl, ownedReferenceUrl: oldUrl }] }] };
  const cloud = structuredClone(base); cloud.cards[0].referenceImageUrls = [newUrl]; cloud.cards[0].visualAssetRefs[0].boundReferenceUrl = newUrl; cloud.cards[0].visualAssetRefs[0].ownedReferenceUrl = newUrl;
  const local = structuredClone(base); local.cards[0].imagePrompt = "unsaved edit";
  const recovery = { run: local, baseContentFingerprint: storyboardRecoveryContentFingerprint(base) };
  await check("signature renewal restores edits using current cloud signatures in URLs and role markers", () => {
    const result = inspectStoryboardRecoveryEdits(cloud, recovery); assert.equal(result.status, "applied");
    assert.equal(result.run.cards[0].imagePrompt, "unsaved edit"); assert.equal(result.run.cards[0].referenceImageUrls[0], newUrl);
    assert.equal(result.run.cards[0].visualAssetRefs[0].boundReferenceUrl, newUrl); assert.equal(result.run.cards[0].visualAssetRefs[0].ownedReferenceUrl, newUrl);
  });
  await check("semantic crop, variant and unknown token query changes remain real conflicts", () => {
    for (const replacement of [newUrl.replace("w_100", "w_200"), newUrl.replace("front", "back"), `${newUrl}&token=different`]) {
      const changed = structuredClone(cloud); changed.cards[0].referenceImageUrls = [replacement];
      assert.equal(inspectStoryboardRecoveryEdits(changed, recovery).status, "conflict");
    }
  });
  await check("signature-looking text inside image prompt stays editable content and creates a conflict", () => {
    const saved = { ...base, cards: [{ ...base.cards[0], imagePrompt: oldUrl }] };
    const changed = { ...base, cards: [{ ...base.cards[0], imagePrompt: newUrl }] };
    assert.equal(inspectStoryboardRecoveryEdits(changed, { run: saved, baseContentFingerprint: storyboardRecoveryContentFingerprint(saved) }).status, "conflict");
  });
  await check("old v1 fingerprint with full signed reference URLs normalizes compatibly", () => {
    const prior = JSON.parse(storyboardRecoveryContentFingerprint(base));
    prior.cards[0].referenceImageUrls = [oldUrl]; prior.cards[0].visualAssetRefs[0].boundReferenceUrl = oldUrl; prior.cards[0].visualAssetRefs[0].ownedReferenceUrl = oldUrl;
    assert.equal(inspectStoryboardRecoveryEdits(cloud, { run: local, baseContentFingerprint: JSON.stringify(prior) }).status, "applied");
  });
  await check("bounded sidecar preserves first conflicting draft, rejects overwrite and propagates quota failures", () => {
    const values = new Map<string, string>(); const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
    preserveStoryboardRecoveryConflict(storage, "scope-a", recovery); preserveStoryboardRecoveryConflict(storage, "scope-a", recovery);
    assert.equal(values.size, 2); const saved = values.get("scope-a:conflict:project-stable");
    assert.equal(readStoryboardRecovery(storage, "scope-a:conflict:project-stable")?.run.cards[0].imagePrompt, "unsaved edit");
    assert.throws(() => preserveStoryboardRecoveryConflict(storage, "scope-a", { ...recovery, run: { ...local, title: "different" } }));
    assert.equal(values.get("scope-a:conflict:project-stable"), saved);
    assert.throws(() => preserveStoryboardRecoveryConflict({ ...storage, setItem: () => { throw Error("QuotaExceededError"); } }, "scope-b", recovery));
  });
  await check("conflict index discovers both drafts after primary switches to a fresh workspace", () => {
    const values = new Map<string, string>(); const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
    preserveStoryboardRecoveryConflict(storage, "scope-index", recovery);
    const second = { ...recovery, run: { ...local, title: "second unsaved draft" } };
    preserveStoryboardRecoveryConflict(storage, "scope-index:new-workspace", second, "scope-index");
    values.set("scope-index", JSON.stringify({ unrelatedFreshWorkspace: true }));
    assert.deepEqual(readStoryboardRecoveryConflicts(storage, "scope-index").map(item => item.run.title), ["saved", "second unsaved draft"]);
    assert.equal(readStoryboardRecoveryConflicts(storage, "different-session").length, 0);
    assert.throws(() => preserveStoryboardRecoveryConflict(storage, "different-session", recovery, "scope-index"));
    values.set("different-session:conflict-index", values.get("scope-index:conflict-index")!);
    assert.equal(readStoryboardRecoveryConflicts(storage, "different-session").length, 0);
  });
  await check("index quota failures retain primary and existing drafts; bounded index never evicts", () => {
    const values = new Map<string, string>([["scope-cap", "original primary"]]);
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
    const failed = { ...storage, setItem: (key: string, value: string) => { if (key.endsWith(":conflict-index")) throw Error("QuotaExceededError"); values.set(key, value); } };
    assert.throws(() => preserveStoryboardRecoveryConflict(failed, "scope-cap", recovery)); assert.equal(values.get("scope-cap"), "original primary");
    preserveStoryboardRecoveryConflict(storage, "scope-cap", recovery);
    for (let i = 1; i < 16; i++) preserveStoryboardRecoveryConflict(storage, "scope-cap", { ...recovery, run: { ...local, id: `project-index-${i}` } });
    const preserved = values.get("scope-cap:conflict-index");
    assert.throws(() => preserveStoryboardRecoveryConflict(storage, "scope-cap", { ...recovery, run: { ...local, id: "project-overflow" } }));
    assert.equal(values.get("scope-cap:conflict-index"), preserved); assert.equal(readStoryboardRecoveryConflicts(storage, "scope-cap").length, 16);
    assert.equal(values.has("scope-cap:conflict:project-overflow"), false); assert.equal(values.get("scope-cap"), "original primary");
  });
  await check("legacy unindexed occupied sidecar is registered before alternate draft preserves both after fresh", () => {
    const values = new Map<string, string>(); const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
    const scope = "legacy-upgrade", oldKey = `${scope}:conflict:${local.id}`;
    writeStoryboardRecovery(storage, oldKey, local, recovery.baseContentFingerprint);
    const originalBytes = values.get(oldKey); const newer = { ...recovery, run: { ...local, title: "newer primary draft B" } };
    assert.throws(() => preserveStoryboardRecoveryConflict(storage, scope, newer));
    assert.equal(values.get(oldKey), originalBytes);
    preserveStoryboardRecoveryConflict(storage, `${scope}:new-workspace`, newer, scope);
    values.set(scope, "fresh workspace");
    assert.deepEqual(readStoryboardRecoveryConflicts(storage, scope).map(item => item.run.title), [local.title, "newer primary draft B"]);
    const quotaStorage = { ...storage, getItem: (key: string) => key.endsWith(":conflict-index") ? null : storage.getItem(key), setItem: () => { throw Error("QuotaExceededError"); } };
    assert.throws(() => preserveStoryboardRecoveryConflict(quotaStorage, scope, newer)); assert.equal(values.get(oldKey), originalBytes);
  });
  const reference = { schema: "generated_image_ref.v1" as const, recordId: "a".repeat(64) };
  const expired = { state: "completed", delivery_state: "delivered", response: { deliveryMode: "provider_url", sourceExpiredAt: "2026-10-23T00:00:00Z", providerUrl: "https://assets.invalid/expired.png" } };
  let network = 0;
  const deps: GeneratedImageReferenceDependencies = { findOwned: async (_id, user) => user === "owner" ? expired : null, validateUrl: async () => { network++; throw Error("NETWORK_FORBIDDEN"); } };
  await check("owned expired delivered receipt may persist; media validation and video reuse remain rejected", async () => {
    assert.equal((await validateOwnedGeneratedImageReceipt({ userId: "owner", reference }, deps)).sourceExpiredAt, expired.response.sourceExpiredAt);
    await assert.rejects(validateOwnedGeneratedImageReference({ userId: "owner", reference }, deps), { code: "GENERATED_IMAGE_NOT_AVAILABLE" });
    await assert.rejects(resolveGeneratedImageReference({ userId: "owner", reference }, deps), { code: "GENERATED_IMAGE_NOT_AVAILABLE" });
    assert.equal(network, 0);
  });
  await check("storage receipt validator still rejects cross-owner, pending, undelivered and non-provider records", async () => {
    await assert.rejects(validateOwnedGeneratedImageReceipt({ userId: "intruder", reference }, deps), { code: "GENERATED_IMAGE_NOT_OWNED" });
    for (const row of [{ ...expired, state: "pending" }, { ...expired, delivery_state: "pending" }, { ...expired, response: { deliveryMode: "inline_ephemeral" } }]) {
      await assert.rejects(validateOwnedGeneratedImageReceipt({ userId: "owner", reference }, { ...deps, findOwned: async () => row }), { code: "GENERATED_IMAGE_NOT_AVAILABLE" });
    }
  });
  await check("actual project stabilize saves expired receipts alongside editable cards but rejects intruders", async () => {
    const source = readFileSync("src/app/api/storyboard/projects/route.ts", "utf8");
    const ast = ts.createSourceFile("route.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const names = ["possibleKey", "sameOwnedReferenceObject", "mapCurrentReferenceMarkers", "stabilize"];
    const statements = ast.statements.filter(item => ts.isFunctionDeclaration(item) && item.name && names.includes(item.name.text)).map(item => item.getText(ast));
    assert.equal(statements.length, names.length);
    const code = ts.transpileModule(statements.join("\n") + "\nexports.stabilize = stabilize;", { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
    const exported: { stabilize?: (db: unknown, owner: string, document: unknown) => Promise<Record<string, unknown>> } = {};
    runInNewContext(code, { exports: exported, structuredClone, URL, Set, Map, createStoryboardPersistenceSnapshot, generatedImagePreviewUrl, storyboardImageUnavailablePatch,
      mediaFields: ["imageUrl", "videoSourceImageUrl", "videoUrl", "videoContentUrl"],
      validateOwnedGeneratedImageReceipt: (input: Parameters<typeof validateOwnedGeneratedImageReceipt>[0]) => validateOwnedGeneratedImageReceipt(input, deps) });
    const db = { from: () => ({ select: () => ({ eq: () => ({ in: async () => ({ data: [], error: null }) }) }) }) };
    const input = structuredClone(base) as typeof base & { cards: Array<typeof base.cards[number] & { imageRef?: typeof reference; imageUrl?: string; videoSourceImageUrl?: string }> };
    input.cards[0].imageRef = reference; input.cards[0].imageUrl = "https://assets.invalid/expired.png"; input.cards[0].videoSourceImageUrl = input.cards[0].imageUrl;
    const result = await exported.stabilize!(db, "owner", input);
    const card = (result.cards as Array<Record<string, unknown>>)[0];
    assert.deepEqual(card.imageRef, reference); assert.equal(card.imageUrl, undefined); assert.equal(card.videoSourceImageUrl, undefined);
    assert.equal(card.imageRetryBlocked, true); assert.equal(card.imageStatus, "done"); assert.equal(card.imagePrompt, "saved");
    await assert.rejects(exported.stabilize!(db, "intruder", input), { code: "GENERATED_IMAGE_NOT_OWNED" });
  });
  console.log(JSON.stringify({ passed: true, checks, sourceHashes: before, networkRequests: network, databaseWrites: 0, providerSubmissions: 0 }, null, 2));
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
