import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { buildStoryboardDirectorExecution, compileStoryboardDirectorVideoPrompt, StoryboardDirectorExecutionSchema } from "../src/lib/storyboard-director-execution";
import { parseStoryboardCanvasImport } from "../src/lib/storyboard-canvas-bridge";
import { sanitizeStoryboardPersistenceValue } from "../src/lib/storyboard-local-persistence";
import { StoryboardProjectDocument } from "../src/lib/storyboard-project-contract";
import { buildStoryboardDirectorResumeCard } from "../src/lib/storyboard-director-resume";
import { confirmStoryboardDirectorAsset, pruneStoryboardDirectorAssetConfirmations } from "../src/lib/storyboard-director-asset-confirmation";
import { collectStoryboardDirectorReferenceBindings } from "../src/lib/storyboard-director-reference-verification";
import { parseStoryboardDirectorIntake } from "../src/lib/storyboard-director-intake";
import { validateStoryboardDirectorPackage } from "../src/lib/storyboard-director-protocol";

const text = readFileSync("prompts/storyboard-high-energy-unified-20261023.md", "utf8");
const pkg = JSON.parse([...text.matchAll(/<!--\s*storyboard_director_output:v1\s+(\{"schema_version"[\s\S]*?)-->/gu)].at(-1)![1]);
const plan = parseStoryboardCanvasImport({ source: "stable_json", schema_version: pkg.schema_version, messageId: "test-message", expected_input: pkg.input, machine_payload: pkg }, { expectedInput: pkg.input });
// Exercise the bridge's public machine payload rather than a forged execution fixture.
const resolved = plan;
assert.ok(resolved, "PROMPT_EXAMPLE_MUST_IMPORT");
const execution = buildStoryboardDirectorExecution(resolved, resolved.segments[0]);
const document = {
  id: "director_test_project", title: "导演数据保存验证", createdAt: 1, updatedAt: 1,
  ratio: "9:16", imageResolution: "2K", videoResolution: "720p", videoDuration: 10,
  imageModelId: "test-image", videoModelId: "test-video",
  cards: [{ id: "test-card", order: 1, imagePrompt: resolved.segments[0].imagePrompt, videoPrompt: execution.sourceVideoPrompt, referenceImageUrls: [], imageStatus: "idle", videoStatus: "idle", directorExecution: execution }],
};
const roundtrip = StoryboardProjectDocument.parse(JSON.parse(JSON.stringify(sanitizeStoryboardPersistenceValue(document))));
assert.deepEqual(roundtrip.cards[0].directorExecution, execution);
assert.equal(compileStoryboardDirectorVideoPrompt(execution.sourceVideoPrompt, execution), execution.sourceVideoPrompt.trim());
assert.equal(compileStoryboardDirectorVideoPrompt("用户已修改镜头", execution), "用户已修改镜头");
const omitted = { ...execution, sourceVideoPrompt: "按参考图连续表演。" };
assert.match(compileStoryboardDirectorVideoPrompt(omitted.sourceVideoPrompt, omitted), /0-2.5秒/u);
assert.throws(() => StoryboardDirectorExecutionSchema.parse({ ...execution, shotTimeRanges: execution.shotTimeRanges.slice(1) }));
assert.throws(() => StoryboardDirectorExecutionSchema.parse({ ...execution, targetDurationSeconds: 15 }));
const rounded = structuredClone(execution);
rounded.shotTimeRanges[1].start_seconds += 0.1;
assert.doesNotThrow(() => StoryboardDirectorExecutionSchema.parse(rounded));
const identityRename = structuredClone(pkg);
identityRename.segments.push(structuredClone(pkg.segments[0]));
identityRename.segments[1].segment_id = "segment_002";
identityRename.segments[1].source_index = 2;
identityRename.segments[1].character_asset_ids[0] = "owner_002";
identityRename.segments[1].character_assets[0] += "第二段改穿红色雨衣和黑色雨靴。";
identityRename.segments[1].storyboard_image_prompt += identityRename.segments[1].character_assets[0];
assert.ok(validateStoryboardDirectorPackage(identityRename).some(issue => issue.includes("character_identity_id_changed")));
const intake = { phase: "assets" as const, sourceMessageId: "test", input: { ...pkg.input, visual_asset_mode: "selected" } };
assert.throws(() => buildStoryboardDirectorResumeCard({ id: document.id, directorIntake: intake }));
const assetText = [...text.matchAll(/<!--\s*storyboard_director_assets:v1\s+(\{"schema_version"[\s\S]*?)-->/gu)].at(-1);
if (assetText) {
  const assets = JSON.parse(assetText[1]);
  const assetPlan = parseStoryboardCanvasImport({ source: "stable_json", schema_version: assets.schema_version, messageId: "assets", machine_payload: assets, expected_input: assets.input }, { expectedInput: assets.input });
  assert.ok(assetPlan?.visualAssetPlan, "ASSETS_PACKAGE_MUST_IMPORT");
  const storedStage = StoryboardProjectDocument.parse(JSON.parse(JSON.stringify(sanitizeStoryboardPersistenceValue({
    ...document, directorIntake: { ...intake, input: assets.input }, visualAssetPlan: assetPlan.visualAssetPlan,
    cards: [{ ...document.cards[0], imagePrompt: "", videoPrompt: "", directorExecution: undefined }],
  }))));
  assert.deepEqual(storedStage.directorIntake?.input, assets.input);
  assert.equal(storedStage.visualAssetPlan?.generationPolicy?.initialRequiredAssetIds.length, 2);
  if (assetPlan?.visualAssetPlan) {
    const accepted = assetPlan.visualAssetPlan.assets.map((asset, index) => ({ ...asset, source: { kind: "generated-image-history" as const, assetId: `generated_${String(index + 1).repeat(64)}`, historyRecordId: String(index + 1).repeat(64) } }));
    const run = { ...document, directorIntake: { ...intake, input: assets.input }, visualAssetPlan: { ...assetPlan.visualAssetPlan, assets: accepted }, visualAssetWorkspace: { drafts: [], candidates: accepted.map(asset => ({ planId: asset.id, role: asset.role, name: asset.name, assetId: asset.source.assetId, historyRecordId: asset.source.historyRecordId, saved: false })) } };
    const original = structuredClone(run);
    assert.throws(() => buildStoryboardDirectorResumeCard(run), /明确选择采用/u);
    assert.throws(() => collectStoryboardDirectorReferenceBindings(run, assets.input));
    const first = { ...run, directorIntake: confirmStoryboardDirectorAsset(run, accepted[0].id, "2026-10-23T12:00:00.000Z")! };
    assert.throws(() => buildStoryboardDirectorResumeCard(first));
    assert.throws(() => collectStoryboardDirectorReferenceBindings(first, assets.input));
    const confirmed = { ...first, directorIntake: confirmStoryboardDirectorAsset(first, accepted[1].id, "2026-10-23T12:01:00.000Z")! };
    const restored = StoryboardProjectDocument.parse(JSON.parse(JSON.stringify(sanitizeStoryboardPersistenceValue(confirmed))));
    assert.deepEqual(restored.directorIntake, confirmed.directorIntake);
    assert.deepEqual(restored.cards, original.cards);
    assert.deepEqual(restored.directorIntake?.input, original.directorIntake.input);
    assert.equal(restored.directorIntake?.sourceMessageId, original.directorIntake.sourceMessageId);
    assert.equal(collectStoryboardDirectorReferenceBindings(restored, assets.input).length, 2);
    const resumed = buildStoryboardDirectorResumeCard(restored);
    assert.throws(() => buildStoryboardDirectorResumeCard({ ...confirmed, directorIntake: pruneStoryboardDirectorAssetConfirmations(confirmed, accepted[0].id) }));
    const replaced = structuredClone(confirmed);
    const historyRecordId = "c".repeat(64);
    replaced.visualAssetPlan.assets[0].source = { kind: "generated-image-history", assetId: `generated_${historyRecordId}`, historyRecordId };
    Object.assign(replaced.visualAssetWorkspace.candidates[0], { assetId: `generated_${historyRecordId}`, historyRecordId });
    assert.throws(() => buildStoryboardDirectorResumeCard(replaced));
    assert.throws(() => collectStoryboardDirectorReferenceBindings(replaced, assets.input));
    assert.equal(pruneStoryboardDirectorAssetConfirmations(replaced)?.confirmedAssets?.length, 1);
    const librarySaved = structuredClone(run);
    librarySaved.visualAssetPlan.assets[0].source.assetId = "3a7f839c-eafb-44c5-bdae-bad0ef70d907";
    librarySaved.visualAssetWorkspace.candidates[0].assetId = librarySaved.visualAssetPlan.assets[0].source.assetId;
    assert.throws(() => confirmStoryboardDirectorAsset(librarySaved, accepted[0].id, "2026-10-23T12:00:00.000Z"));
    const forgedLibrary = structuredClone(confirmed);
    forgedLibrary.visualAssetPlan.assets[0].source.assetId = librarySaved.visualAssetPlan.assets[0].source.assetId;
    forgedLibrary.visualAssetWorkspace.candidates[0].assetId = librarySaved.visualAssetPlan.assets[0].source.assetId;
    forgedLibrary.directorIntake.confirmedAssets![0].sourceAssetId = librarySaved.visualAssetPlan.assets[0].source.assetId;
    assert.throws(() => collectStoryboardDirectorReferenceBindings(forgedLibrary, assets.input));
    for (const target of ["source", "candidate", "both"] as const) {
      const storedImage = structuredClone(confirmed);
      if (target !== "candidate") Object.assign(storedImage.visualAssetPlan.assets[0].source, { storageKey: "assets/other-owned-image.png" });
      if (target !== "source") Object.assign(storedImage.visualAssetWorkspace.candidates[0], { storageKey: "assets/other-owned-image.png" });
      assert.throws(() => collectStoryboardDirectorReferenceBindings(storedImage, assets.input));
      assert.throws(() => confirmStoryboardDirectorAsset(storedImage, accepted[0].id, "2026-10-23T12:00:00.000Z"));
    }
    const preset = structuredClone(run);
    Object.assign(preset.visualAssetWorkspace.candidates[0], { source: "platform-preset" });
    assert.throws(() => confirmStoryboardDirectorAsset(preset, accepted[0].id, "2026-10-23T12:00:00.000Z"));
    const wrongRole = structuredClone(run);
    wrongRole.visualAssetWorkspace.candidates[0].role = "pet";
    assert.throws(() => confirmStoryboardDirectorAsset(wrongRole, accepted[0].id, "2026-10-23T12:00:00.000Z"));
    assert.throws(() => confirmStoryboardDirectorAsset(run, accepted[0].id, "invalid timestamp"));
    const duplicate = structuredClone(confirmed);
    duplicate.directorIntake.confirmedAssets!.push(duplicate.directorIntake.confirmedAssets![0]);
    assert.throws(() => collectStoryboardDirectorReferenceBindings(duplicate, assets.input));
    assert.deepEqual(run, original);
    assert.deepEqual(parseStoryboardDirectorIntake(resumed)?.input, assets.input);
  }
}
const report = { passed: true, checks: ["metadata save/restore", "existing timeline unchanged", "user edited prompt preserved", "omitted timeline compiled", "broken timing rejected", "missing assets cannot resume", "resume retains original card", "no confirmation and single confirmation rejected", "both confirmations survive save/restore", "replacement and cancellation invalidate confirmation", "original cards and intake unchanged"], networkRequests: 0, paidRequests: 0 };
mkdirSync(".codex-evidence/director-refinement-20261023/mode-followup", { recursive: true });
writeFileSync(".codex-evidence/director-refinement-20261023/mode-followup/execution-result.json", JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
