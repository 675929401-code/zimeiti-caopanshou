import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { storyboardProductionPlanFingerprint, storyboardProductionAssetFingerprint, storyboardProductionImageFingerprint, storyboardProductionVideoFingerprint, storyboardProductionBlocker, storyboardProductionQuote, runStoryboardProductionQueue, type ProductionRun } from "../src/lib/storyboard-continuous-production";
import { confirmStoryboardDirectorAsset, pruneStoryboardDirectorAssetConfirmations } from "../src/lib/storyboard-director-asset-confirmation";
import { collectStoryboardDirectorReferenceBindings } from "../src/lib/storyboard-director-reference-verification";
import { StoryboardDirectorIntakeStateSchema } from "../src/lib/storyboard-director-resume";
import { StoryboardProjectDocument } from "../src/lib/storyboard-project-contract";
import { sanitizeStoryboardPersistenceValue } from "../src/lib/storyboard-local-persistence";
import { buildStoryboardThreeViewPrompt } from "../src/lib/storyboard-visual-asset-three-view";
import { createImportedStoryboardVisualAssetWorkspace } from "../src/lib/storyboard-visual-asset-workspace";

const passed: string[] = [];
function check(name: string, test: () => void) { test(); passed.push(name); }
function fixture(): ProductionRun {
  const assets = (["character", "pet"] as const).map((role, index) => ({
    id: index ? "pet_main" : "owner_main", role, name: index ? "金毛豆豆" : "男主人阿林",
    identityLock: "完整保留原始人物或宠物身份、衣着与风格，全片保持一致。", allowedChanges: ["表情"],
    referencePrompts: [{ kind: "turnaround" as const, purpose: "角色三视图定妆", prompt: `原始${role}身份描述，墨绿衣服或金毛，保留独特风格与完整身形，三个视角均保持身份。` }],
  }));
  const visualAssetPlan = { mode: "selected" as const, assets, generationPolicy: { maxInitialImages: 2, initialRequiredAssetIds: assets.map(asset => asset.id), initialDeferredAssetIds: [], environmentAnchorPolicy: "none" as const } };
  return {
    id: "storyboard-run-zero-cost", ratio: "9:16", imageRatio: "9:16", imageResolution: "2K", videoResolution: "1080p", videoDuration: 10,
    imageModelId: "image-model", videoModelId: "video-model", visualAssetPlan,
    visualAssetWorkspace: createImportedStoryboardVisualAssetWorkspace(visualAssetPlan),
    directorIntake: { phase: "planned", sourceMessageId: "original-message", input: { schema_version: "storyboard_director_input.v1", segmented_script: "1.【完整保留原文。】", director_mode: "high_energy", animation_style: "黏土定格动画", aspect_ratio: "9:16", target_duration_seconds: 10, special_notes: "墨绿衣服与金毛，全片保持身份。", visual_asset_mode: "参考图模式" } },
    cards: [1, 2].map(number => ({ id: "card-" + number, order: number, narration: "完整保留原文。", imagePrompt: "分镜图提示词 " + number, videoPrompt: "视频提示词 " + number,
      imageStatus: "idle", videoStatus: "idle", referenceImageUrls: [], visualAssetSelectionMode: "custom" as const,
      visualAssetRefs: assets.map(asset => ({ assetId: asset.id, role: asset.role, referenceKinds: ["identity"] })) })),
  };
}
function generated(run: ProductionRun, index: number) {
  const asset = run.visualAssetPlan!.assets[index];
  const draft = run.visualAssetWorkspace!.drafts.find(item => item.planId === asset.id)!;
  const historyRecordId = (index ? "b" : "a").repeat(64);
  const candidate = { assetId: `generated_${historyRecordId}`, planId: asset.id, projectId: run.id, role: asset.role, name: asset.name,
    prompt: buildStoryboardThreeViewPrompt(asset.role as "character" | "pet", undefined, draft.prompt, false), historyRecordId, saved: false };
  run.visualAssetWorkspace!.candidates.push(candidate);
  asset.source = { kind: "generated-image-history", assetId: candidate.assetId, historyRecordId };
  return candidate;
}
function confirm(run: ProductionRun, index: number) {
  run.directorIntake = confirmStoryboardDirectorAsset(run, run.visualAssetPlan!.assets[index].id, "2026-10-23T16:00:00Z");
}

async function main() {
  check("planned intake and all original drafts survive import", () => {
    const run = fixture(); assert.equal(StoryboardDirectorIntakeStateSchema.parse(run.directorIntake).phase, "planned");
    assert.equal(run.visualAssetWorkspace!.drafts.length, 2); assert.equal(run.cards.length, 2);
    assert.equal(run.visualAssetWorkspace!.drafts[0].prompt, run.visualAssetPlan!.assets[0].referencePrompts[0].prompt);
    assert.equal(run.cards[0].imagePrompt, "分镜图提示词 1");
  });
  check("uncreated, generated-only and half-confirmed references cannot execute", () => {
    const run = fixture(); assert.throws(() => collectStoryboardDirectorReferenceBindings(run, run.directorIntake!.input));
    generated(run, 0); generated(run, 1); assert.throws(() => collectStoryboardDirectorReferenceBindings(run, run.directorIntake!.input));
    confirm(run, 0); assert.throws(() => collectStoryboardDirectorReferenceBindings(run, run.directorIntake!.input));
    confirm(run, 1); assert.equal(collectStoryboardDirectorReferenceBindings(run, run.directorIntake!.input).length, 2);
  });
  check("foreign project, upload, fabricated history and changed identity drafts are blocked", () => {
    const run = fixture(); generated(run, 0); generated(run, 1); confirm(run, 0); confirm(run, 1);
    const candidate = run.visualAssetWorkspace!.candidates[0]; candidate.projectId = "foreign-project";
    assert.throws(() => confirm(run, 0)); assert.throws(() => collectStoryboardDirectorReferenceBindings(run, run.directorIntake!.input)); candidate.projectId = run.id;
    run.visualAssetPlan!.assets[0].source!.kind = "uploaded-image"; assert.throws(() => confirm(run, 0)); run.visualAssetPlan!.assets[0].source!.kind = "generated-image-history";
    run.visualAssetPlan!.assets[0].source!.assetId = "fabricated_asset"; assert.throws(() => confirm(run, 0)); run.visualAssetPlan!.assets[0].source!.assetId = candidate.assetId;
    run.visualAssetWorkspace!.drafts[0].prompt += "更换服装。";
    assert.equal(pruneStoryboardDirectorAssetConfirmations(run)!.confirmedAssets!.length, 1);
    assert.throws(() => collectStoryboardDirectorReferenceBindings(run, run.directorIntake!.input)); assert.throws(() => confirm(run, 0));
  });
  check("expected generation/adoption progress keeps plan fingerprint but changes source identity", () => {
    const run = fixture(); const plan = storyboardProductionPlanFingerprint(run); const sources = storyboardProductionAssetFingerprint(run);
    generated(run, 0); generated(run, 1); confirm(run, 0); confirm(run, 1);
    run.visualAssetPlan!.defaultAssetIds = run.visualAssetPlan!.assets.map(asset => asset.id);
    assert.equal(storyboardProductionPlanFingerprint(run), plan); assert.notEqual(storyboardProductionAssetFingerprint(run), sources);
    const card = run.cards[0]; card.referenceImageUrls = ["/api/storyboard/visual-assets?recordId=" + "a".repeat(64) + "&ticket=one"];
    card.visualAssetRefs![0].boundReferenceUrl = card.referenceImageUrls[0];
    assert.equal(storyboardProductionPlanFingerprint(run), plan);
    const image = storyboardProductionImageFingerprint(run, card); card.referenceImageUrls[0] = card.referenceImageUrls[0].replace("one", "two"); card.visualAssetRefs![0].boundReferenceUrl = card.referenceImageUrls[0];
    assert.equal(storyboardProductionImageFingerprint(run, card), image);
  });
  check("model, prompt, framing, exact text, source identity and video motion each invalidate dependent output", () => {
    const run = fixture(); generated(run, 0); generated(run, 1); confirm(run, 0); confirm(run, 1); const card = run.cards[0];
    const base = storyboardProductionImageFingerprint(run, card);
    for (const mutate of [(copy: ProductionRun) => { copy.imageModelId += "-changed"; }, (copy: ProductionRun) => { copy.imageRatio = "16:9"; }, (copy: ProductionRun) => { copy.cards[0].imagePrompt += " changed"; }, (copy: ProductionRun) => { copy.cards[0].imageExactText = "精确文字"; }, (copy: ProductionRun) => { copy.visualAssetPlan!.assets[0].source!.historyRecordId = "c".repeat(64); }]) {
      const copy = structuredClone(run); mutate(copy); assert.notEqual(storyboardProductionImageFingerprint(copy, copy.cards[0]), base);
    }
    card.imageRecordId = "d".repeat(64); const video = storyboardProductionVideoFingerprint(run, card);
    card.videoPrompt += " changed"; assert.notEqual(storyboardProductionVideoFingerprint(run, card), video);
    card.videoPrompt = "视频提示词 1"; run.videoDuration = 15; assert.notEqual(storyboardProductionVideoFingerprint(run, card), video);
  });
  check("only matching completed media is skipped; failed, unknown and stale work blocks continuation", () => {
    const run = fixture(); const card = run.cards[0]; card.imageStatus = "done";
    assert.match(storyboardProductionBlocker(run), /已有分镜图/u);
    card.continuousImageInputFingerprint = storyboardProductionImageFingerprint(run, card); assert.equal(storyboardProductionBlocker(run), "");
    card.imageRetryBlocked = true; assert.match(storyboardProductionBlocker(run), /原生成请求/u); card.imageRetryBlocked = false;
    card.videoStatus = "running"; assert.match(storyboardProductionBlocker(run), /原生成请求/u); card.videoStatus = "failed"; assert.match(storyboardProductionBlocker(run), /失败/u);
    card.videoStatus = "idle"; card.imageReferenceState = "stale"; assert.match(storyboardProductionBlocker(run), /参考已改变/u);
  });
  check("price authorization includes references plus both generation stages and rejects unknown rates", () => {
    assert.equal(storyboardProductionQuote({ references: 2, images: 7, videos: 7, referencePrice: 0.2, imagePrice: 0.2, videoPrice: 1.5 }), 12.3);
    assert.throws(() => storyboardProductionQuote({ references: 2, images: 1, videos: 1, referencePrice: 0.2, imagePrice: Number.NaN, videoPrice: 1.5 }));
  });
  check("input fingerprints persist without a durable dispatch permission or workflow cursor", () => {
    const run = fixture(); run.cards[0].continuousImageInputFingerprint = storyboardProductionImageFingerprint(run, run.cards[0]);
    run.cards[0].continuousVideoInputFingerprint = storyboardProductionVideoFingerprint(run, run.cards[0]);
    const saved = sanitizeStoryboardPersistenceValue({ ...run, title: "测试项目", createdAt: 1, updatedAt: 1, authorized: true, continuousProduction: { running: true } }) as ProductionRun & Record<string, unknown>;
    assert.equal(saved.cards[0].continuousImageInputFingerprint, run.cards[0].continuousImageInputFingerprint);
    assert.equal(saved.cards[0].continuousVideoInputFingerprint, run.cards[0].continuousVideoInputFingerprint);
    assert.equal(saved.authorized, undefined); assert.equal(saved.continuousProduction, undefined); StoryboardProjectDocument.parse(saved);
  });
  {
    const events: string[] = []; const cards = fixture().cards;
    const outcome = await runStoryboardProductionQueue({ current: () => true, cards: () => cards, references: async () => false,
      onStage: stage => events.push(stage), image: async id => { events.push(id); return true; }, video: async id => { events.push(id); return true; } });
    assert.equal(outcome, "waiting"); assert.deepEqual(events, ["references"]); passed.push("explicit reference confirmation is a hard queue barrier");
  }
  {
    const events: string[] = []; const cards = fixture().cards;
    const outcome = await runStoryboardProductionQueue({ current: () => true, cards: () => cards, references: async () => true,
      onStage: () => undefined, image: async id => { events.push("image:" + id); cards.find(card => card.id === id)!.imageStatus = "done"; return true; },
      video: async id => { assert.ok(cards.every(card => card.imageStatus === "done")); events.push("video:" + id); return true; } });
    assert.equal(outcome, "completed"); assert.deepEqual(events, ["image:card-1", "image:card-2", "video:card-1", "video:card-2"]); passed.push("serial images finish before any video dispatch");
  }
  {
    const events: string[] = []; const cards = fixture().cards;
    const outcome = await runStoryboardProductionQueue({ current: () => true, cards: () => cards, references: async () => true,
      onStage: () => undefined, image: async id => { events.push(id); return false; }, video: async () => { throw new Error("must not dispatch"); } });
    assert.equal(outcome, "stopped"); assert.deepEqual(events, ["card-1"]); passed.push("failed or unknown result stops successors without retry");
  }
  {
    let active = true; const events: string[] = []; const cards = fixture().cards;
    const outcome = await runStoryboardProductionQueue({ current: () => active, cards: () => cards, references: async () => true,
      onStage: () => undefined, image: async id => { events.push(id); active = false; return true; }, video: async () => { throw new Error("must not dispatch"); } });
    assert.equal(outcome, "stopped"); assert.deepEqual(events, ["card-1"]); passed.push("pause, owner change or input invalidation prevents the next paid dispatch");
  }
  {
    const cards = fixture().cards; cards[0].imageStatus = "done"; cards[0].videoStatus = "done"; const events: string[] = [];
    await runStoryboardProductionQueue({ current: () => true, cards: () => cards, references: async () => true, onStage: () => undefined,
      image: async id => { events.push("image:" + id); return true; }, video: async id => { events.push("video:" + id); return true; } });
    assert.deepEqual(events, ["image:card-2", "video:card-2"]); passed.push("a resumed queue skips verified completed cards");
  }
  const report = { status: "PASS", zeroNetwork: true, paidRequests: 0, count: passed.length, passed };
  mkdirSync(".codex-evidence/director-refinement-20261023/continuous-followup", { recursive: true });
  writeFileSync(".codex-evidence/director-refinement-20261023/continuous-followup/continuous-production-zero-cost.json", JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
