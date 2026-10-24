import assert from "node:assert/strict";
import { saveStoryboardVisualAssetCandidates } from "../src/lib/storyboard-visual-asset-library";
import type { DrawerVisualAsset } from "../src/components/storyboard-visual-assets-drawer";

type Call = { url: string; method: string; body: Record<string, unknown> };
const candidate = (index: number, extra: Partial<DrawerVisualAsset> = {}): DrawerVisualAsset => ({
  assetId: `draft-${index}`, planId: `identity-${index}`, name: `角色 ${index}`,
  role: index % 2 ? "pet" : "character", previewUrl: `https://fixture.invalid/preview-${index}.png`,
  prompt: `三视图 ${index}`, saved: false, tags: ["三视图", "样板"], customCategory: "动画样板", ...extra,
});
function fixture(options: { metadataFailureAt?: number; resolveFailure?: boolean; persistFailure?: boolean } = {}) {
  const calls: Call[] = [];
  let metaCount = 0;
  const request: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method || "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : {};
    assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer fixture-only");
    calls.push({ url, method, body });
    // All generation, project save/apply, upload and external requests fail.
    if (method === "GET" && url.startsWith("/api/storyboard/visual-assets?recordId=")) {
      assert.equal(init?.cache, "no-store");
      return Response.json(options.resolveFailure ? { error: "owned record missing" } : { reference: { previewUrl: "https://fixture.invalid/owned-original.png?signed=fresh" } }, { status: options.resolveFailure ? 404 : 200 });
    }
    if (method === "POST" && url === "/api/image-workbench/persist") {
      assert.equal(body.intent, "user_asset_export");
      assert.equal(body.index, 0);
      return Response.json(options.persistFailure ? { error: "export failed" } : { assetId: `owned-${calls.length}`, key: `assets/owned-${calls.length}.png`, url: `https://fixture.invalid/saved-${calls.length}.png` }, { status: options.persistFailure ? 500 : 200 });
    }
    if (method === "POST" && url === "/api/storyboard/visual-assets") {
      metaCount++;
      return Response.json(metaCount === options.metadataFailureAt ? { error: "metadata failed" } : {
        asset: { assetId: body.assetId, previewUrl: "https://fixture.invalid/library.png", name: body.name, tags: body.tags, customCategory: body.customCategory, planId: "server-plan-must-not-rebind" },
      }, { status: metaCount === options.metadataFailureAt ? 500 : 200 });
    }
    throw new Error(`Forbidden request ${method} ${url}`);
  };
  return { request, calls };
}
async function main() {
  let cases = 0;
  const run = (selected: DrawerVisualAsset[], mock: ReturnType<typeof fixture>, exported = new Map<string, DrawerVisualAsset>()) => {
    const notifications: Array<{ saved: DrawerVisualAsset; original: DrawerVisualAsset }> = [];
    return { notifications, exported, result: saveStoryboardVisualAssetCandidates({ selected, projectId: "project-fixture", token: "fixture-only", exported, request: mock.request,
      onSaved: (saved, original) => notifications.push({ saved, original }),
    }) };
  };

  const generated = Object.freeze(candidate(1, { historyRecordId: "a".repeat(64) }));
  const generatedMock = fixture();
  const generatedRun = run([generated], generatedMock);
  const generatedResult = await generatedRun.result;
  assert.equal(generatedResult.error, undefined);
  assert.deepEqual(generatedMock.calls.map(({ url, method }) => [method, url]), [
    ["GET", `/api/storyboard/visual-assets?recordId=${"a".repeat(64)}`],
    ["POST", "/api/image-workbench/persist"], ["POST", "/api/storyboard/visual-assets"],
  ]);
  assert.equal(generatedMock.calls[1].body.url, "https://fixture.invalid/owned-original.png?signed=fresh");
  assert.deepEqual(generatedMock.calls[2].body, {
    assetId: "owned-2", role: "pet", name: "角色 1", prompt: "三视图 1", projectId: "project-fixture", tags: ["三视图", "样板"], customCategory: "动画样板",
  });
  assert.equal(generatedResult.assets[0].planId, generated.planId);
  assert.equal(generatedResult.assets[0].saved, true);
  assert.equal(generated.saved, false, "save must not mutate candidate or apply project state");
  assert.equal(generatedRun.notifications.length, 1);
  cases++;

  const cache = new Map<string, DrawerVisualAsset>();
  const firstMock = fixture({ metadataFailureAt: 1 });
  const first = await run([generated], firstMock, cache).result;
  assert.equal(first.error, "metadata failed");
  assert.deepEqual(first.assets, []);
  assert.deepEqual(first.savedNames, []);
  assert.equal(cache.size, 1, "successful export must survive metadata failure");
  const retryMock = fixture();
  const edited = { ...generated, name: "修改后的名字", tags: ["新标签"], customCategory: "新分类" };
  const retry = await run([edited], retryMock, cache).result;
  assert.equal(retry.error, undefined);
  assert.equal(retryMock.calls.length, 1, "retry must reuse export without owned resolve or another persist");
  assert.equal(retryMock.calls[0].url, "/api/storyboard/visual-assets");
  assert.equal(retryMock.calls[0].body.assetId, cache.get(generated.assetId)!.assetId);
  assert.deepEqual(retryMock.calls[0].body.tags, ["新标签"]);
  assert.equal(retryMock.calls[0].body.customCategory, "新分类");
  assert.equal(retry.assets[0].name, edited.name);
  cases++;

  const batch = Array.from({ length: 15 }, (_, index) => candidate(index));
  const batchMock = fixture();
  const batchRun = run(batch, batchMock);
  const batchResult = await batchRun.result;
  assert.equal(batchResult.error, undefined);
  assert.equal(batchResult.assets.length, 15, "library save must not inherit per-project reference limit");
  assert.equal(batchResult.savedNames.length, 15);
  assert.equal(batchRun.notifications.length, 15);
  assert.equal(batchMock.calls.filter((call) => call.url === "/api/image-workbench/persist").length, 15);
  assert.equal(batchMock.calls.length, 30);
  cases++;

  const saved = candidate(20, { saved: true, storageKey: "assets/already-owned.png" });
  const preset = candidate(21, { source: "platform-preset", presetId: "preset-fixture", presetRevision: 3 });
  const skipMock = fixture();
  const skipped = run([saved, preset], skipMock);
  const skippedResult = await skipped.result;
  assert.deepEqual(skippedResult.assets, [saved, preset]);
  assert.deepEqual(skippedResult.savedNames, []);
  assert.equal(skipMock.calls.length, 0, "saved and public preset items must not be copied to personal library");
  assert.equal(skipped.notifications.length, 0);
  cases++;

  const partialMock = fixture({ metadataFailureAt: 2 });
  const partialRun = run(batch.slice(0, 3), partialMock);
  const partial = await partialRun.result;
  assert.equal(partial.error, "metadata failed");
  assert.equal(partial.assets.length, 1);
  assert.deepEqual(partial.savedNames, [batch[0].name]);
  assert.equal(partialRun.notifications.length, 1);
  assert.equal(partialRun.exported.size, 2);
  assert.equal(partialMock.calls.length, 4, "stop after failure without pretending remaining candidates were saved");
  cases++;

  for (const mode of ["resolve", "persist"] as const) {
    const failedMock = fixture(mode === "resolve" ? { resolveFailure: true } : { persistFailure: true });
    const failedRun = run([generated], failedMock);
    const failed = await failedRun.result;
    assert.equal(failed.error, mode === "resolve" ? "owned record missing" : "export failed");
    assert.deepEqual(failed.assets, []);
    assert.deepEqual(failed.savedNames, []);
    assert.equal(failedRun.notifications.length, 0);
    assert.equal(failedRun.exported.size, 0);
    assert.equal(failedMock.calls.length, mode === "resolve" ? 1 : 2);
    cases++;
  }
  const storedMock = fixture();
  const stored = await run([candidate(30, { storageKey: "assets/exported.png" })], storedMock).result;
  assert.equal(stored.error, undefined);
  assert.equal(storedMock.calls.length, 1, "already exported candidate only needs library metadata");
  assert.equal(storedMock.calls[0].url, "/api/storyboard/visual-assets");
  cases++;
  console.log(JSON.stringify({ status: "PASS", cases, fullBatchSaved: 15, generationCalls: 0, projectApplyCalls: 0, providerCalls: 0, liveWrites: 0 }));
}
void main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
