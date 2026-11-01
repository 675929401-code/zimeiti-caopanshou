import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import {
  parseStoryboardDirectorOriginalAssetQuery,
  resolveStoryboardDirectorOriginalAsset,
  storyboardDirectorOriginalAssetDependencies,
  StoryboardDirectorOriginalAssetError,
  type StoryboardDirectorOriginalAssetDependencies,
} from "../src/lib/server/storyboard-director-original-asset";
import { createImageFailureRequestSnapshot } from "../src/lib/image-failure-history";
import { buildStoryboardThreeViewPrompt } from "../src/lib/storyboard-visual-asset-three-view";

const userId = "account-A", projectId = "project-original-A", planId = "pet-main";
const historyRecordId = "a".repeat(64), otherHistory = "b".repeat(64);
const originalUrl = "https://fixture.invalid/original-three-view.png";
const legacyId = "174631a8-8b13-45f5-b072-f9919b122739";
const identityPrompt = "同一只成年柯基，橙白毛色、短腿、自然直立耳、蓝色项圈，白色背景完整展示同一宠物。";
const identityLock = "同一只成年橙白柯基，短腿直立耳，蓝色项圈保持一致。";
const prompt = buildStoryboardThreeViewPrompt("pet", undefined, identityPrompt, false);

function fixture(legacy = false) {
  const candidate = { assetId: legacy ? legacyId : `generated_${historyRecordId}`, planId, role: "pet", name: "我的柯基",
    prompt: legacy ? identityPrompt : prompt, historyRecordId, projectId, storageKey: "images/cropped-front.png", saved: true,
    tags: ["宠物", "主角"], customCategory: "科普角色", createdAt: "2026-10-23T00:00:00.000Z", source: "personal" };
  const asset = { id: planId, role: "pet", name: "柯基角色", identityLock, allowedChanges: [],
    referencePrompts: [{ kind: "turnaround", purpose: "人物宠物三视图", prompt: identityPrompt }],
    source: { kind: "generated-image-history", assetId: candidate.assetId, historyRecordId, storageKey: "images/cropped-front.png" } };
  const document = { directorIntake: { phase: "assets", confirmedAssets: [{ planId, sourceAssetId: legacyId, historyRecordId, role: "pet" }] },
    visualAssetPlan: { mode: "selected", assets: [asset], generationPolicy: { maxInitialImages: 1,
      initialRequiredAssetIds: [planId], initialDeferredAssetIds: [], environmentAnchorPolicy: "none" } },
    visualAssetWorkspace: { drafts: [], candidates: [candidate] } };
  const project = { id: projectId, owner_id: userId, deleted: false, document };
  const image = { record_id: historyRecordId, user_id: userId, state: "completed", delivery_state: "delivered",
    response: { deliveryMode: "provider_url", providerUrl: originalUrl, secretFixture: "PRIVATE_ERROR_SENTINEL" },
    request_snapshot: createImageFailureRequestSnapshot({ surface: "storyboard-workbench", prompt, publicModelId: "fixture-model",
      modelName: "Fixture Model", aspectRatio: "16:9", resolution: "2K", referenceImageUrls: [], quotedPriceYuan: 1, billingExempt: false }) };
  const calls = { projects: 0, images: 0, reads: 0 };
  const deps: StoryboardDirectorOriginalAssetDependencies = {
    async loadOwnedProject(id, owner) { calls.projects++; assert.equal(id, projectId); assert.equal(owner, userId); return project; },
    async loadOwnedImage(id, owner) { calls.images++; assert.equal(id, historyRecordId); assert.equal(owner, userId); return image; },
    async resolveReadableImage(id, owner, row) { calls.reads++; assert.equal(id, historyRecordId); assert.equal(owner, userId); assert.equal(row, image);
      return { reference: { recordId: historyRecordId, previewUrl: originalUrl } }; },
  };
  return { candidate, asset, document, project, image, calls, deps };
}
type Fixture = ReturnType<typeof fixture>;
const input = { userId, projectId, assetId: planId };
let passed = 0;

async function rejects(change: (value: Fixture) => void, expectedCode = "DIRECTOR_ORIGINAL_ASSET_UNAVAILABLE", expectedReads = 0) {
  const value = fixture(); change(value);
  await assert.rejects(resolveStoryboardDirectorOriginalAsset(input, value.deps), (error: unknown) => error instanceof StoryboardDirectorOriginalAssetError
    && error.code === expectedCode && !error.message.includes("PRIVATE_ERROR_SENTINEL"));
  assert.equal(value.calls.reads, expectedReads); passed++;
}

function routeHarness(deps: StoryboardDirectorOriginalAssetDependencies, authenticated = true) {
  const source = readFileSync("src/app/api/storyboard/director-assets/original/route.ts", "utf8");
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports: Record<string, unknown> = {};
  const database = { fixtureAuthenticatedClient: true };
  let authentications = 0, adapters = 0;
  vm.runInNewContext(js, { exports, require: (specifier: string) => {
    if (specifier === "next/server") return { NextResponse: { json: (body: unknown, options: { status?: number; headers?: object } = {}) => ({ body, status: options.status || 200, headers: options.headers }) } };
    if (specifier === "@/lib/api-middleware") return { withAuth: async (_request: unknown, callback: (user: { id: string }, db: unknown) => unknown) => {
      authentications++; return authenticated ? callback({ id: userId }, database) : { status: 401, body: { error: "Unauthorized" } };
    } };
    if (specifier === "@/lib/server/storyboard-director-original-asset") return {
      parseStoryboardDirectorOriginalAssetQuery, resolveStoryboardDirectorOriginalAsset, StoryboardDirectorOriginalAssetError,
      storyboardDirectorOriginalAssetDependencies: (db: unknown) => { assert.equal(db, database); adapters++; return deps; },
    };
    throw new Error(`Unapproved route dependency: ${specifier}`);
  } });
  return { get: exports.GET as (request: unknown) => Promise<{ status: number; body: unknown; headers: Record<string, string> }>,
    counts: () => ({ authentications, adapters }) };
}

async function main() {
  const originalFetch = globalThis.fetch;
  let networkRequests = 0;
  globalThis.fetch = async () => { networkRequests++; throw new Error("Network forbidden in original-asset contract checks"); };
  try {
    for (const legacy of [false, true]) {
      const value = fixture(legacy), before = JSON.stringify(value.document);
      const candidate = await resolveStoryboardDirectorOriginalAsset(input, value.deps);
      assert.equal(candidate.assetId, `generated_${historyRecordId}`); assert.equal(candidate.prompt, prompt);
      assert.equal(candidate.previewUrl, originalUrl); assert.equal(candidate.planId, planId); assert.equal(candidate.projectId, projectId);
      assert.equal(candidate.saved, false); assert.equal(candidate.source, "personal"); assert.equal(candidate.name, value.candidate.name);
      assert.deepEqual(candidate.tags, value.candidate.tags); assert.equal(candidate.customCategory, value.candidate.customCategory);
      assert.equal("storageKey" in candidate, false); assert.equal("confirmedAssets" in candidate, false);
      assert.equal(JSON.stringify(candidate).includes("PRIVATE_ERROR_SENTINEL"), false);
      assert.equal(JSON.stringify(value.document), before); assert.deepEqual(value.calls, { projects: 1, images: 1, reads: 1 }); passed++;
    }
    // A legacy generated ID may retain a library key while the drawer replaces
    // its compiled prompt with the editable raw draft. Recover only from history.
    const legacyGenerated = fixture(); legacyGenerated.candidate.prompt = identityPrompt;
    const legacyBefore = JSON.stringify(legacyGenerated.document);
    const recoveredGenerated = await resolveStoryboardDirectorOriginalAsset(input, legacyGenerated.deps);
    assert.equal(recoveredGenerated.assetId, `generated_${historyRecordId}`); assert.equal(recoveredGenerated.prompt, prompt);
    assert.equal(recoveredGenerated.previewUrl, originalUrl); assert.equal("storageKey" in recoveredGenerated, false);
    assert.equal(recoveredGenerated.saved, false); assert.equal("confirmedAssets" in recoveredGenerated, false);
    assert.equal(JSON.stringify(legacyGenerated.document), legacyBefore); assert.equal(legacyGenerated.calls.reads, 1); passed++;
    await rejects(value => { value.project.owner_id = "account-B"; }, "DIRECTOR_ORIGINAL_PROJECT_NOT_FOUND");
    await rejects(value => { value.project.deleted = true; }, "DIRECTOR_ORIGINAL_PROJECT_NOT_FOUND");
    await rejects(value => { value.image.user_id = "account-B"; });
    await rejects(value => { value.document.directorIntake.phase = "storyboard"; });
    await rejects(value => { value.asset.role = "environment"; });
    await rejects(value => { value.asset.referencePrompts[0].kind = "identity"; });
    await rejects(value => { value.candidate.projectId = "project-foreign"; });
    await rejects(value => { value.asset.source.kind = "uploaded-image"; });
    await rejects(value => { value.asset.source.historyRecordId = otherHistory; });
    await rejects(value => { value.candidate.assetId = `generated_${otherHistory}`; });
    await rejects(value => { value.candidate.historyRecordId = ""; });
    // A canonical original without a library key must retain the immutable prompt.
    await rejects(value => { Reflect.deleteProperty(value.candidate, "storageKey"); value.candidate.prompt = identityPrompt; });
    for (const [state, delivery] of [["running", "delivered"], ["failed", "delivered"], ["completed", "pending"], ["completed", "expired"]]) {
      await rejects(value => { value.image.state = state; value.image.delivery_state = delivery; });
    }
    await rejects(value => { Object.assign(value.image.response, { sourceExpiredAt: "2026-10-23T00:00:00.000Z" }); });
    await rejects(value => { value.image.response.deliveryMode = "stored_object"; });
    await rejects(value => { value.image.response.providerUrl = "http://127.0.0.1/private.png"; });
    await rejects(value => { value.image.request_snapshot!.surface = "image-workbench"; });
    await rejects(value => { value.image.request_snapshot!.prompt = "不相关的头像图片"; });
    // An owned UUID cannot confer three-view proof on an unrelated history row.
    const fake = fixture(true); fake.image.request_snapshot!.prompt = "不相关的头像图片";
    await assert.rejects(resolveStoryboardDirectorOriginalAsset(input, fake.deps), StoryboardDirectorOriginalAssetError);
    assert.equal(fake.calls.reads, 0); assert.equal(fake.document.directorIntake.confirmedAssets[0].sourceAssetId, legacyId); passed++;
    const withoutSource = fixture(); Reflect.deleteProperty(withoutSource.asset, "source");
    assert.equal((await resolveStoryboardDirectorOriginalAsset(input, withoutSource.deps)).historyRecordId, historyRecordId); passed++;
    await rejects(value => { Reflect.deleteProperty(value.asset, "source"); value.document.visualAssetWorkspace.candidates.push({
      ...value.candidate, assetId: `generated_${otherHistory}`, historyRecordId: otherHistory,
    }); });
    const selected = fixture(); selected.document.visualAssetWorkspace.candidates.unshift({
      ...selected.candidate, assetId: `generated_${otherHistory}`, historyRecordId: otherHistory,
    });
    assert.equal((await resolveStoryboardDirectorOriginalAsset(input, selected.deps)).historyRecordId, historyRecordId); passed++;
    const fromImage = fixture(true);
    fromImage.image.request_snapshot!.prompt = `${buildStoryboardThreeViewPrompt("pet", undefined, identityPrompt, true)}\n身份锁定：${identityLock}；除允许变化外保持一致。`;
    fromImage.image.request_snapshot!.mode = "image-to-image"; fromImage.image.request_snapshot!.referenceAssetRefs = [`ref_${"c".repeat(32)}`];
    assert.equal((await resolveStoryboardDirectorOriginalAsset(input, fromImage.deps)).prompt, fromImage.image.request_snapshot!.prompt); passed++;
    await rejects(value => { value.deps.resolveReadableImage = async () => { value.calls.reads++; throw new Error("PRIVATE_ERROR_SENTINEL"); }; }, "DIRECTOR_ORIGINAL_IMAGE_READ_UNAVAILABLE", 1);
    await rejects(value => { value.deps.resolveReadableImage = async () => { value.calls.reads++; return { reference: { recordId: otherHistory, previewUrl: originalUrl } }; }; }, undefined, 1);
    await rejects(value => { value.deps.resolveReadableImage = async () => { value.calls.reads++; return { reference: { recordId: historyRecordId, previewUrl: "https://fixture.invalid/cropped.png" } }; }; }, undefined, 1);

    assert.deepEqual(parseStoryboardDirectorOriginalAssetQuery(new URLSearchParams({ projectId, assetId: planId })), { projectId, assetId: planId }); passed++;
    for (const query of ["", "projectId=short&assetId=pet-main", `projectId=${projectId}&assetId=../pet`, `projectId=${projectId}&assetId=${planId}&assetId=other`, `projectId=${projectId}&projectId=other-project&assetId=${planId}`]) {
      assert.throws(() => parseStoryboardDirectorOriginalAssetQuery(new URLSearchParams(query)), StoryboardDirectorOriginalAssetError); passed++;
    }

    const request = { nextUrl: { searchParams: new URLSearchParams({ projectId, assetId: planId }) } };
    const success = fixture(); const handler = routeHarness(success.deps); const response = await handler.get(request);
    assert.equal(response.status, 200); assert.equal(response.headers["Cache-Control"], "private, no-store");
    assert.equal((response.body as { candidate: { assetId: string } }).candidate.assetId, `generated_${historyRecordId}`);
    assert.deepEqual(handler.counts(), { authentications: 1, adapters: 1 }); passed++;
    const unauthorized = routeHarness(fixture().deps, false); assert.equal((await unauthorized.get(request)).status, 401);
    assert.deepEqual(unauthorized.counts(), { authentications: 1, adapters: 0 }); passed++;
    const failing = fixture(); failing.deps.loadOwnedProject = async () => { throw new Error("PRIVATE_ERROR_SENTINEL database credentials"); };
    const failure = await routeHarness(failing.deps).get(request); assert.equal(failure.status, 503);
    assert.equal(JSON.stringify(failure.body).includes("PRIVATE_ERROR_SENTINEL"), false); passed++;

    // Exercise the production database adapter with a read-only fake client.
    const queries: Array<{ table: string; filters: Array<[string, unknown]>; columns: string }> = [];
    const adapterFixture = fixture();
    const db = { from: (table: string) => {
      const query = { table, filters: [] as Array<[string, unknown]>, columns: "" }; queries.push(query);
      const builder = { select: (columns: string) => { query.columns = columns; return builder; },
        eq: (key: string, value: unknown) => { query.filters.push([key, value]); return builder; },
        abortSignal: () => builder, maybeSingle: async () => ({ data: table === "storyboard_projects" ? adapterFixture.project : adapterFixture.image, error: null }) };
      return builder;
    } } as unknown as Parameters<typeof storyboardDirectorOriginalAssetDependencies>[0];
    const adapter = storyboardDirectorOriginalAssetDependencies(db);
    assert.equal(await adapter.loadOwnedProject(projectId, userId), adapterFixture.project);
    assert.equal(await adapter.loadOwnedImage(historyRecordId, userId), adapterFixture.image);
    assert.deepEqual(queries.map(query => [query.table, query.filters]), [
      ["storyboard_projects", [["id", projectId], ["owner_id", userId], ["deleted", false]]],
      ["image_generation_requests", [["record_id", historyRecordId], ["user_id", userId]]],
    ]);
    assert.equal(queries.some(query => query.columns.includes("secret")), false); passed++;
    assert.equal(networkRequests, 0);
    console.log(JSON.stringify({ passed, failed: 0, scope: "owned immutable original image recovery, auth route, safe errors and owner-filtered authenticated adapter", networkRequests, databaseWrites: 0, generationRequests: 0, confirmationWrites: 0 }));
  } finally { globalThis.fetch = originalFetch; }
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
