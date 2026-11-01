import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  PHASES, MAX_STORYBOARD_SEGMENTS, mediaPhaseSequence, assertMediaPhase, parseSelectedArgs, loadContracts, validateSelectedPackage, makeStagingDocument,
  assertDocumentInputs, assertSelectedBindings, readAssetPromptBuilder, assertPhasePredecessors,
  validateAnnotationProvenance, loadPackageProvenance, phaseGenerationContract, readPhaseModel,
  assertPhaseEvidence, pinAssetCandidate, assertAssetCandidatePins, assertReferenceCapacity, writeEvidence,
  cardIdForOrder, loadOfficialHandoff, verifyOfficialHandoffSource, assertFreshImportedDocument,
} from "./verify-storyboard-selected-media-live.mjs";
import { makeWorkbenchPaidPostHandler } from "./verify-image-workbench-live-e2e.mjs";

export function fixturePackage(segmentCount = 3) {
  const narration = "女孩把玩具轻放地面，小狗停下，抬头看她，然后安静坐好。";
  const assets = [
    { id: "character_main", role: "character", name: "女孩", identity_lock: "同一位年轻女性，短黑发，圆脸，身体比例和脸型跨段一致。",
      allowed_changes: ["姿态"], reference_prompts: [{ kind: "turnaround", purpose: "保持人物身份一致", prompt: "年轻女性人物正面侧面背面三视图，短黑发，圆脸，中性背景，完整身体，不含剧情。" }] },
    { id: "pet_main", role: "pet", name: "小狗", identity_lock: "同一只金毛犬，蜂蜜色毛发，棕色眼睛，体型与毛色跨段保持一致。",
      allowed_changes: ["姿态"], reference_prompts: [{ kind: "turnaround", purpose: "保持宠物身份一致", prompt: "同一只金毛犬正面侧面背面三视图，蜂蜜色毛发，棕色眼睛，中性背景，完整四足身体。" }] },
  ];
  const times = [0, 2.5, 5, 7.5, 10];
  const indices = Array.from({ length: segmentCount }, (_, index) => index + 1);
  return {
    schema_version: "storyboard_director_output.v1", artifact_type: "storyboard_director_package", director_mode: "high_energy",
    input: { schema_version: "storyboard_director_input.v1", director_mode: "high_energy", animation_style: "电影级高能3D动画喜剧",
      aspect_ratio: "16:9", target_duration_seconds: 10, special_notes: "不含可读文字",
      segmented_script: indices.map(i => `${i}.${narration}`).join("\n") },
    visual_asset_plan: { mode: "selected", assets,
      generation_policy: { max_initial_images: 2, initial_required_asset_ids: assets.map(a => a.id),
        initial_deferred_asset_ids: [], environment_anchor_policy: "per-scene-when-required" } },
    segments: indices.map(index => ({
      segment_id: `segment_${String(index).padStart(3, "0")}`, source_index: index, narration,
      target_duration_seconds: 10, estimated_narration_duration: 5.5, panel_count: 4, layout: "two_by_two",
      pacing_mode: "fast", actual_shot_count: 4, panoramic_anchor_role: null,
      shot_time_ranges: times.slice(0, 4).map((start, i) => ({
        shot_id: `shot_0${i + 1}`, start_seconds: start, end_seconds: times[i + 1], action_beat: `当前动作节拍${i + 1}`,
      })),
      continuity_links: [1, 2, 3].map(i => ({ from_shot: `shot_0${i}`, to_shot: `shot_0${i + 1}`,
        link_type: "action_bridge", description: "沿角色视线与动作方向连续衔接" })),
      character_assets: ["女孩", "小狗"],
      visual_asset_refs: assets.map(a => ({ asset_id: a.id, role: a.role, reference_kinds: ["identity"] })),
      semantic_visualizations: [{ trigger: "期待", visual_form: "小狗耳朵竖起", interaction: "看向女孩手中的玩具" }],
      storyboard_image_prompt: `第${index}段：严格四格2x2完整故事板，女孩放下玩具，小狗抬头，随后坐下，保持人物宠物身份一致，无可读文字。`,
      image_to_video_prompt: `第${index}段：读取完整故事板，10秒实际4镜头，0至2.5秒放下玩具，2.5至5秒小狗抬头，5至7.5秒女孩停下，7.5至10秒小狗坐好，无对白。`,
    })),
  };
}

export async function runSelfTest() {
  let checks = 0;
  const yes = fn => { fn(); checks++; };
  const no = fn => { assert.throws(fn); checks++; };
  const contracts = await loadContracts();
  const pkg = fixturePackage();
  const plan = validateSelectedPackage(pkg, contracts.parseBridge);
  checks++;
  const values = { "project-id": "storyboard-selected-fixture01", "run-id": "fixture-run01", "model-id": "pm_fixture", resolution: "1K", phase: "asset-character", "aspect-ratio": "1:1" };
  const args = ["--phase=asset-character", "--project-id=" + values["project-id"], "--run-id=" + values["run-id"],
    "--model-id=pm_fixture", "--resolution=1K", "--aspect-ratio=1:1", "--package-file=fixture.json", "--package-sha256=" + "a".repeat(64)];
  yes(() => assert.equal(parseSelectedArgs(args).values.phase, "asset-character"));
  const fullPhases = mediaPhaseSequence(13);
  yes(() => assert.equal(fullPhases.length, 16));
  yes(() => assert.deepEqual(fullPhases.slice(0, 3), ["asset-character", "asset-pet", "bind"]));
  yes(() => assert.deepEqual(fullPhases.filter(phase => phase.startsWith("storyboard-")), Array.from({ length: 13 }, (_, index) => `storyboard-${index + 1}`)));
  yes(() => assert.deepEqual(mediaPhaseSequence(3), PHASES));
  yes(() => assert.equal(mediaPhaseSequence(1).at(-1), "storyboard-1"));
  yes(() => assert.equal(mediaPhaseSequence(MAX_STORYBOARD_SEGMENTS).at(-1), `storyboard-${MAX_STORYBOARD_SEGMENTS}`));
  for (const count of [0, -1, 1.5, MAX_STORYBOARD_SEGMENTS + 1]) no(() => mediaPhaseSequence(count));
  const fullPackage = fixturePackage(13);
  const fullPlan = validateSelectedPackage(fullPackage, contracts.parseBridge);
  const fullDocument = contracts.projectSchema.parse(makeStagingDocument(fullPlan, values, 1000));
  yes(() => assert.equal(fullPlan.segments.length, 13));
  yes(() => assertDocumentInputs(fullDocument, fullPlan, values));
  yes(() => assert.equal(fullDocument.cards[12].imagePrompt, fullPackage.segments[12].storyboard_image_prompt));
  yes(() => assert.equal(fullDocument.cards[12].videoPrompt, fullPackage.segments[12].image_to_video_prompt));
  const fullExistingValues = { ...values, "project-id": "storyboard-run-fullfixture13", "existing-project-id": "storyboard-run-fullfixture13",
    cardOrderMap: fullPlan.segments.map((_, index) => ({ order: index + 1, id: `shot-fullfixture-${index + 1}` })) };
  const fullExistingDocument = contracts.projectSchema.parse(makeStagingDocument(fullPlan, fullExistingValues, 1000));
  fullExistingValues.nativePlan = fullExistingDocument.visualAssetPlan;
  yes(() => assertFreshImportedDocument(fullExistingDocument, fullPlan, fullExistingValues));
  yes(() => assert.equal(fullExistingDocument.cards[3].id, "shot-fullfixture-4"));
  yes(() => assert.equal(fullExistingDocument.cards[12].id, "shot-fullfixture-13"));
  no(() => assertDocumentInputs({ ...fullDocument, cards: fullDocument.cards.slice(0, 3) }, fullPlan, values));
  for (const phase of ["storyboard-4", "storyboard-13"]) {
    yes(() => assert.equal(parseSelectedArgs(args.map(arg => arg === "--phase=asset-character" ? `--phase=${phase}` : arg).map(arg => arg === "--aspect-ratio=1:1" ? "--aspect-ratio=16:9" : arg)).values.phase, phase));
    const order = assertMediaPhase(phase, fullPlan.segments.length);
    yes(() => assert.equal(fullPlan.segments[order - 1].imagePrompt, fullPackage.segments[order - 1].storyboard_image_prompt));
    const preceding = fullPhases.slice(0, fullPhases.indexOf(phase));
    const reports = Object.fromEntries(preceding.map(previous => [previous, { phase: previous, success: true }]));
    yes(() => assertPhasePredecessors(phase, reports, fullPlan.segments.length));
    for (const previous of preceding) {
      no(() => assertPhasePredecessors(phase, { ...reports, [previous]: { phase: previous, success: false } }, 13));
      no(() => assertPhasePredecessors(phase, { ...reports, [previous]: { phase: previous, state: "unknown" } }, 13));
    }
  }
  no(() => assertMediaPhase("storyboard-14", 13));
  no(() => assertPhasePredecessors("storyboard-14", {}, 13));
  for (const phase of ["storyboard-0", "storyboard-01", `storyboard-${MAX_STORYBOARD_SEGMENTS + 1}`, "storyboard-1.5", "asset-other"]) {
    no(() => assertMediaPhase(phase));
    no(() => parseSelectedArgs(args.map(arg => arg === "--phase=asset-character" ? `--phase=${phase}` : arg)));
  }
  yes(() => assert.equal(fullPhases.filter(phase => phase.startsWith("asset-")).length, 2));
  yes(() => assert.equal(phaseGenerationContract({ phase: "bind" }), null));
  const fullBind = parseSelectedArgs(args.filter(arg => !arg.startsWith("--model-id=") && !arg.startsWith("--resolution=") && !arg.startsWith("--aspect-ratio=")).map(arg => arg === "--phase=asset-character" ? "--phase=bind" : arg));
  yes(() => assert.equal(fullBind.maxCharge, 0));
  yes(() => assert.equal(fullBind.remainingBudget, 0));
  no(() => parseSelectedArgs([...args, "--execute"]));
  no(() => parseSelectedArgs([...args, "--self-test"]));
  no(() => parseSelectedArgs(args.map(a => a === "--phase=asset-character" ? "--phase=video" : a)));
  no(() => parseSelectedArgs(args.map(a => a.startsWith("--project-id=") ? "--project-id=../../elsewhere" : a)));
  no(() => parseSelectedArgs(args.map(a => a === "--resolution=1K" ? "--resolution=8K" : a)));
  no(() => parseSelectedArgs([...args, "--resolution=2K"]));
  no(() => parseSelectedArgs([...args, "--annotation-file=annotation.json"]));
  no(() => parseSelectedArgs([...args, "--annotation-sha256=" + "a".repeat(64)]));
  no(() => parseSelectedArgs([...args, "--annotation-file=annotation.json", "--annotation-sha256=invalid"]));
  const digest = value => createHash("sha256").update(value).digest("hex");
  const original = structuredClone(pkg);
  original.segments.forEach(segment => {
    segment.quality_checks = [{ check_id: "arbitrary_runtime_name", status: "unknown", detail: "尚无真实资产，等待宿主解析绑定。" }];
  });
  const originalBytes = Buffer.from(JSON.stringify(original));
  const manifest = {
    schema_version: "storyboard_quality_annotation.v1",
    original_package_file: "original.json", original_package_sha256: digest(originalBytes),
    annotations: original.segments.map((segment, index) => ({
      pointer: `/segments/${index}/quality_checks/0`,
      original_check_sha256: digest(JSON.stringify(segment.quality_checks[0])),
      verification: { kind: "visual_asset_binding", asset_ids: segment.visual_asset_refs.map(ref => ref.asset_id) },
    })),
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  const annotated = structuredClone(original);
  annotated.segments.forEach((segment, index) => { segment.quality_checks[0].verification = structuredClone(manifest.annotations[index].verification); });
  annotated.host_annotation = { schema_version: manifest.schema_version, original_package_sha256: digest(originalBytes), manifest_sha256: digest(manifestBytes) };
  const verify = (candidate = annotated, raw = originalBytes, sidecar = manifestBytes, pin = digest(manifestBytes)) =>
    validateAnnotationProvenance(candidate, raw, sidecar, pin);
  yes(() => assert.equal(verify().annotatedCheckCount, 3));
  for (const mutate of [
    p => { p.segments[0].quality_checks[0].status = "pass"; },
    p => { p.segments[0].quality_checks[0].detail += " 改写"; },
    p => { p.segments[0].quality_checks[0].check_id = "renamed"; },
    p => { p.segments[0].storyboard_image_prompt += " changed"; },
    p => { p.segments[0].image_to_video_prompt += " changed"; },
    p => { p.visual_asset_plan.assets[0].reference_prompts[0].prompt += " changed"; },
    p => { delete p.segments[0].quality_checks[0].verification; },
    p => { p.host_annotation.original_package_sha256 = "0".repeat(64); },
    p => { p.host_annotation.extra = true; },
  ]) {
    const changed = structuredClone(annotated); mutate(changed); no(() => verify(changed));
  }
  no(() => verify(annotated, Buffer.from(JSON.stringify(pkg))));
  no(() => verify(annotated, originalBytes, manifestBytes, "0".repeat(64)));
  for (const mutate of [
    m => { m.annotations[0].original_check_sha256 = "0".repeat(64); },
    m => { m.annotations[0].pointer = "/segments/0/quality_checks/99"; },
    m => { m.annotations.push(m.annotations[0]); },
    m => { m.annotations[0].verification.kind = "ignore_quality"; },
    m => { m.annotations[0].verification.asset_ids = ["character_main"]; },
    m => { m.annotations[0].verification.asset_ids.push("pet_main"); },
    m => { m.annotations[0].extra = true; },
    m => { m.annotations = []; },
  ]) {
    const changed = structuredClone(manifest); mutate(changed);
    const bytes = Buffer.from(JSON.stringify(changed)), candidate = structuredClone(annotated);
    candidate.host_annotation.manifest_sha256 = digest(bytes);
    no(() => verify(candidate, originalBytes, bytes, digest(bytes)));
  }
  yes(() => assert.equal(annotated.segments[0].quality_checks[0].status, "unknown"));
  yes(() => assert.deepEqual(annotated.segments[0].storyboard_image_prompt, original.segments[0].storyboard_image_prompt));
  const nativeProvenance = await loadPackageProvenance(pkg, { "package-sha256": digest(JSON.stringify(pkg)) });
  yes(() => assert.equal(nativeProvenance.mode, "native-package"));
  await assert.rejects(loadPackageProvenance(pkg, { "annotation-file": "not-read.json", "annotation-sha256": "a".repeat(64) })); checks++;
  await assert.rejects(loadPackageProvenance(annotated, {})); checks++;
  const annotatedPlan = validateSelectedPackage(annotated, contracts.parseBridge);
  yes(() => assert.equal(annotatedPlan.pendingRuntimePrerequisites.length, 3));
  const annotatedDocument = contracts.projectSchema.parse(makeStagingDocument(annotatedPlan, values, 1000));
  yes(() => assert.deepEqual(annotatedDocument.cards[0].qualityChecks[0].verification, manifest.annotations[0].verification));
  no(() => assertSelectedBindings(annotatedDocument, annotatedPlan, values));
  const lostEvidence = structuredClone(annotatedDocument);
  lostEvidence.cards[0].qualityChecks = [];
  no(() => assertDocumentInputs(lostEvidence, annotatedPlan, values));
  for (const mutate of [
    p => { p.schema_version = "storyboard-director-v2.6.0"; },
    p => { p.visual_asset_plan.mode = "off"; },
    p => { p.segments.pop(); },
    p => { p.visual_asset_plan.generation_policy.max_initial_images = 1; },
    p => { p.visual_asset_plan.assets[0].source = { kind: "generated-image-history", asset_id: "old" }; },
    p => { p.segments[0].visual_asset_refs = []; },
    p => { p.segments[0].visual_asset_refs[0].asset_id = "unknown_asset"; },
    p => { p.segments[0].visual_asset_refs.push(p.segments[0].visual_asset_refs[0]); },
    p => { p.input.target_duration_seconds = 15; },
  ]) {
    const changed = structuredClone(pkg); mutate(changed);
    no(() => validateSelectedPackage(changed, contracts.parseBridge));
  }
  const document = contracts.projectSchema.parse(makeStagingDocument(plan, values, 1000));
  yes(() => assertDocumentInputs(document, plan, values));
  yes(() => assert.ok(document.cards.every(card => card.visualAssetRefs.length === 2 && card.referenceImageUrls.length === 0)));
  yes(() => assert.deepEqual(document.visualAssetWorkspace.drafts.map(d => d.planId), plan.visualAssetPlan.assets.map(a => a.id)));
  no(() => assertSelectedBindings(document, plan, values));
  const ready = structuredClone(document);
  ready.visualAssetPlan.assets.forEach((asset, i) => {
    asset.source = { kind: "generated-image-history", assetId: `real-asset-${i}`, storageKey: `owned/${i}.png`,
      historyRecordId: String(i + 1).repeat(64), librarySaved: true };
  });
  ready.cards.forEach((card, i) => {
    card.visualAssetRefs = structuredClone(plan.segments[i].visualAssetRefs);
    card.referenceImageUrls = ["asset://real-asset-0", "asset://real-asset-1"];
  });
  yes(() => assertSelectedBindings(ready, plan, values));
  const deferredPackage = structuredClone(pkg);
  deferredPackage.visual_asset_plan.assets.push({
    id: "prop_later", role: "prop", name: "玩具", identity_lock: "后置玩具道具，保持颜色与轮廓一致。",
    allowed_changes: [], reference_prompts: [{ kind: "prop", purpose: "后续需要时准备", prompt: "单独玩具道具参考，完整轮廓与固定颜色，中性背景，无文字无人物。" }],
  });
  deferredPackage.visual_asset_plan.generation_policy.initial_deferred_asset_ids = ["prop_later"];
  const deferredPlan = validateSelectedPackage(deferredPackage, contracts.parseBridge);
  const deferredDocument = contracts.projectSchema.parse(makeStagingDocument(deferredPlan, values, 1000));
  yes(() => assert.equal(deferredDocument.visualAssetPlan.assets.length, 3));
  yes(() => assert.equal(deferredDocument.visualAssetWorkspace.drafts.length, 2));
  const deferredReady = structuredClone(ready);
  deferredReady.visualAssetPlan = structuredClone(deferredDocument.visualAssetPlan);
  deferredReady.visualAssetPlan.assets[0].source = ready.visualAssetPlan.assets[0].source;
  deferredReady.visualAssetPlan.assets[1].source = ready.visualAssetPlan.assets[1].source;
  yes(() => assertSelectedBindings(deferredReady, deferredPlan, values));
  for (const mutate of [
    p => { p.visual_asset_plan.generation_policy.initial_deferred_asset_ids = []; },
    p => { p.segments[0].visual_asset_refs.push({ asset_id: "prop_later", role: "prop", reference_kinds: ["prop"] }); },
    p => { p.visual_asset_plan.generation_policy.initial_required_asset_ids.push("prop_later"); },
  ]) {
    const changed = structuredClone(deferredPackage); mutate(changed);
    no(() => validateSelectedPackage(changed, contracts.parseBridge));
  }
  const unexpectedDeferredSource = structuredClone(deferredReady);
  unexpectedDeferredSource.visualAssetPlan.assets[2].source = ready.visualAssetPlan.assets[0].source;
  no(() => assertSelectedBindings(unexpectedDeferredSource, deferredPlan, values));
  for (const mutate of [
    d => { d.cards[0].imagePrompt = "old dog canary prompt"; },
    d => { d.cards[1].videoPrompt += " changed"; },
    d => { d.cards[0].visualAssetRefs.pop(); },
    d => { d.cards[1].referenceImageUrls.pop(); },
    d => { d.visualAssetPlan.assets[0].source.librarySaved = false; },
    d => { d.cards[2].videoStatus = "running"; },
  ]) {
    const changed = structuredClone(ready); mutate(changed);
    no(() => assertSelectedBindings(changed, plan, values));
  }
  yes(() => assertPhasePredecessors("asset-character", {}));
  no(() => assertPhasePredecessors("asset-pet", {}));
  no(() => assertPhasePredecessors("storyboard-3", { "storyboard-2": { phase: "storyboard-2", success: true } }));
  yes(() => assertPhasePredecessors("storyboard-3", Object.fromEntries(PHASES.slice(0, -1).map(phase => [phase, { phase, success: true }]))));
  const assetContract = phaseGenerationContract({ ...values, "model-id": "pm_PZ3hS353YQNbfRnz2_9Ro0aX" });
  const boardContract = phaseGenerationContract({ ...values, phase: "storyboard-1", "model-id": "pm_jzWh-719AmVJsapPKYwVMAO9",
    resolution: "2K", "aspect-ratio": "16:9" });
  yes(() => assert.equal(assetContract.aspectRatio, "1:1"));
  yes(() => assert.equal(boardContract.resolution, "2K"));
  no(() => phaseGenerationContract({ ...values, phase: "storyboard-1" }));
  no(() => phaseGenerationContract({ ...values, "aspect-ratio": "9:16" }));
  no(() => phaseGenerationContract({ ...values, phase: "bind" }));
  yes(() => assert.equal(phaseGenerationContract({ phase: "bind" }), null));
  yes(() => assert.equal(document.ratio, "16:9"));
  yes(() => assert.equal(document.imageRatio, "1:1"));
  const bindArgs = args.filter(arg => !/^--(?:phase|model-id|resolution|aspect-ratio)=/u.test(arg)).concat(["--phase=bind"]);
  yes(() => assert.equal(parseSelectedArgs(bindArgs).maxCharge, 0));
  no(() => parseSelectedArgs([...bindArgs, "--model-id=pm_fixture"]));
  no(() => parseSelectedArgs([...bindArgs, "--aspect-ratio=1:1"]));
  no(() => parseSelectedArgs([...bindArgs, "--max-charge=1"]));
  no(() => parseSelectedArgs([...bindArgs, "--execute"]));
  const bindPins = ["--execute", "--user-id=11111111-1111-4111-8111-111111111111", "--actor-role=admin",
    "--expected-source-version=R001215", "--expected-build-id=fixture-build", "--database-readiness=fixture.json",
    "--database-readiness-sha256=" + "b".repeat(64), "--expected-database-target=127.0.0.1:54322/zimeiti_local",
    "--expected-database-identity=" + "c".repeat(64), "--max-charge=0", "--remaining-budget=0"];
  yes(() => assert.equal(parseSelectedArgs([...bindArgs, ...bindPins]).flags.has("execute"), true));
  for (const pin of bindPins.filter(arg => /^--(?:user-id|expected-source-version|expected-build-id|database-readiness|database-readiness-sha256|expected-database-target|expected-database-identity)=/u.test(arg))) {
    no(() => parseSelectedArgs([...bindArgs, ...bindPins.filter(arg => arg !== pin)]));
  }
  let catalogReads = 0;
  const noGeneration = await readPhaseModel(null, async () => { catalogReads++; throw new Error("BIND_MUST_NOT_READ_CATALOG"); },
    { maxCharge: 0, remainingBudget: 0 });
  yes(() => assert.deepEqual(noGeneration, { rawModel: null, model: null, quote: 0 }));
  yes(() => assert.equal(catalogReads, 0));
  const catalogModels = [assetContract, boardContract].map(contract => ({ id: contract.modelId,
    capabilities: { available: true, priceReady: true, aspectRatios: [contract.aspectRatio],
      resolutionOptions: [contract.resolution], resolutionPrices: [`${contract.resolution}=0.1`], maxReferenceImages: 8 } }));
  for (const contract of [assetContract, boardContract]) {
    const current = await readPhaseModel(contract, async () => ({ models: catalogModels }), { maxCharge: 1, remainingBudget: 1 });
    yes(() => assert.equal(current.model.id, contract.modelId));
  }
  yes(() => assertReferenceCapacity(catalogModels[1], 2));
  no(() => assertReferenceCapacity({ capabilities: { maxReferenceImages: 1 } }, 2));
  no(() => assertReferenceCapacity({ capabilities: { requiresImage: true } }, 0));
  const historyContext = { projectId: values["project-id"], actorId: "fixture-actor", packageSha256: "a".repeat(64),
    provenance: { mode: "native-package", originalPackageSha256: "a".repeat(64), annotatedCheckCount: 0 } };
  const bundleFor = (phase, generationContract) => {
    const common = { phase, runId: values["run-id"], projectId: historyContext.projectId,
      actor: { id: historyContext.actorId }, packageSha256: historyContext.packageSha256,
      provenance: historyContext.provenance, generationContract, quote: generationContract ? 0.1 : 0,
      allocatedBudget: generationContract ? 1 : 0 };
    const receipt = generationContract ? { recordId: (phase === "asset-character" ? "1" : phase === "asset-pet" ? "2" : "3").repeat(64), assetId: null } : null;
    const keys = { clientIdempotencyKey: "fixture-request-" + phase, clientTraceId: "fixture-trace-" + phase };
    const bundle = {
      dispatch: { ...common, quote: generationContract ? 0.1 : 0, allocatedBudget: generationContract ? 1 : 0, workflowBudget: generationContract ? 1 : 0 },
      request: { ...common, ...generationContract, ...keys, generationPosts: generationContract ? 1 : 0,
        dispatchState: generationContract ? "persisted-before-forwarding" : "generation-forbidden" },
      terminal: { ...common, request: keys, deliveryReceipt: receipt, generationPosts: generationContract ? 1 : 0,
        terminalStatus: generationContract ? "completed" : "no-generation" },
      report: { ...common, success: true, modelId: generationContract?.modelId ?? null,
        resolution: generationContract?.resolution ?? null, aspectRatio: generationContract?.aspectRatio ?? null,
        request: keys, deliveryReceipt: receipt, generationPosts: generationContract ? 1 : 0,
        admission: { generationPostAttempts: generationContract ? 1 : 0, generationPostsContinued: generationContract ? 1 : 0, duplicateGenerationPostsBlocked: 0 },
        billing: { balanceDelta: generationContract ? 0.1 : 0, newTransactionCount: generationContract ? 1 : 0 } },
    };
    if (phase.startsWith("asset-")) {
      const index = phase === "asset-character" ? 0 : 1;
      const asset = ready.visualAssetPlan.assets[index];
      bundle.assetBinding = { planId: asset.id, role: asset.role, projectId: values["project-id"],
        generationAssetId: `generated_${receipt.recordId}`, assetId: asset.source.assetId,
        historyRecordId: receipt.recordId, storageKey: asset.source.storageKey };
      bundle.report.assetBinding = structuredClone(bundle.assetBinding);
    }
    return bundle;
  };
  const mixedBundles = Object.fromEntries(PHASES.map(phase => [phase, bundleFor(phase,
    phase === "bind" ? null : phase.startsWith("asset-") ? assetContract : boardContract)]));
  for (const [phase, bundle] of Object.entries(mixedBundles)) yes(() => assertPhaseEvidence(phase, bundle, historyContext));
  for (const record of ["dispatch", "request", "terminal", "report"]) {
    for (const field of ["projectId", "packageSha256", "runId"]) {
      const changed = structuredClone(mixedBundles["asset-character"]); changed[record][field] = "changed";
      no(() => assertPhaseEvidence("asset-character", changed, historyContext));
    }
    const wrongActor = structuredClone(mixedBundles["asset-character"]); wrongActor[record].actor.id = "other";
    no(() => assertPhaseEvidence("asset-character", wrongActor, historyContext));
    const drift = structuredClone(mixedBundles["asset-character"]); drift[record].generationContract.resolution = "2K";
    no(() => assertPhaseEvidence("asset-character", drift, historyContext));
  }
  const requestDrift = structuredClone(mixedBundles["asset-character"]); requestDrift.request.aspectRatio = "16:9";
  no(() => assertPhaseEvidence("asset-character", requestDrift, historyContext));
  const reportDrift = structuredClone(mixedBundles["asset-character"]); reportDrift.report.modelId = boardContract.modelId;
  no(() => assertPhaseEvidence("asset-character", reportDrift, historyContext));
  const bindDrift = structuredClone(mixedBundles.bind); bindDrift.report.admission.generationPostAttempts = 1;
  no(() => assertPhaseEvidence("bind", bindDrift, historyContext));
  const pinned = structuredClone(ready);
  pinned.visualAssetWorkspace.candidates = ["asset-character", "asset-pet"].map(phase => {
    const pin = mixedBundles[phase].assetBinding;
    return { ...pin, saved: true };
  });
  const phaseReports = Object.fromEntries(Object.entries(mixedBundles).map(([phase, bundle]) => [phase, bundle.report]));
  yes(() => assertAssetCandidatePins(pinned, plan, values, phaseReports, true));
  yes(() => assertSelectedBindings(pinned, plan, values, phaseReports));
  for (const field of ["assetId", "historyRecordId", "storageKey", "projectId", "planId"]) {
    const wrong = structuredClone(pinned); wrong.visualAssetWorkspace.candidates[0][field] = "unrelated-history-image";
    no(() => assertAssetCandidatePins(wrong, plan, values, phaseReports, true));
  }
  for (const field of ["assetId", "historyRecordId", "storageKey"]) {
    const wrong = structuredClone(pinned); wrong.visualAssetPlan.assets[0].source[field] = "unrelated-history-image";
    no(() => assertSelectedBindings(wrong, plan, values, phaseReports));
  }
  no(() => pinAssetCandidate(pinned, plan.visualAssetPlan.assets[0], { recordId: "f".repeat(64) }, values["project-id"], "wrong"));
  let bindForwards = 0, bindAborts = 0;
  const bindDiagnostics = { generationPostAttempts: 0, generationPostsContinued: 0, duplicateGenerationPostsBlocked: 0 };
  const bindHandler = makeWorkbenchPaidPostHandler({ diagnostics: bindDiagnostics, isArmed: () => phaseGenerationContract({ phase: "bind" }) !== null,
    expected: {}, checkFresh: async () => { throw new Error("BIND_MUST_NOT_FORWARD"); } });
  await bindHandler({ request: () => ({ method: () => "POST", postDataJSON: () => ({}) }),
    continue: async () => { bindForwards++; }, abort: async () => { bindAborts++; } });
  yes(() => assert.equal(bindForwards, 0));
  yes(() => assert.equal(bindAborts, 1));
  const immutable = new Map();
  const fakeIo = { writeFile: async (file, bytes, options) => {
    assert.equal(options.flag, "wx");
    if (immutable.has(file)) throw new Error("PHASE_OCCUPIED");
    immutable.set(file, bytes);
  } };
  await writeEvidence("/RAM/phase/dispatch.json", { generationContract: assetContract }, fakeIo);
  await assert.rejects(writeEvidence("/RAM/phase/dispatch.json", { generationContract: boardContract }, fakeIo), /PHASE_OCCUPIED/u);
  checks++;
  yes(() => assert.equal(JSON.parse(immutable.get("/RAM/phase/dispatch.json")).generationContract.modelId, assetContract.modelId));
  const capturedProjectId = "storyboard-run-fixture-official01";
  const capturedMap = [1, 2, 3].map(order => ({ order, id: `shot-fixture0${order}` }));
  const originalRaw = JSON.stringify(pkg);
  const nativeResult = contracts.parseStructured(originalRaw, true);
  const officialPkg = nativeResult.machine_payload;
  const nativeBytes = Buffer.from(JSON.stringify(officialPkg));
  const nativeDetail = contracts.buildReady("capture-message01", nativeResult);
  const nativeImportPlan = contracts.parseBridge(nativeDetail);
  const officialValues = { ...values, "project-id": capturedProjectId, "existing-project-id": capturedProjectId,
    "user-id": "11111111-1111-4111-8111-111111111111", "package-sha256": digest(nativeBytes),
    "handoff-provenance-file": path.resolve("RAM/provenance.json"), cardOrderMap: capturedMap };
  const imported = contracts.projectSchema.parse(makeStagingDocument(plan, officialValues, 1000));
  const nativeExpected = imported.visualAssetPlan;
  const createOfficialCase = (change = () => {}) => {
    const firstDoc = structuredClone(imported), readDoc = structuredClone(imported);
    const envelope = { schema_version: "agent_workbench_handoff.v1", artifact_type: "agent_workbench_handoff",
      source_route: "/", target: "storyboard-workbench", payload: structuredClone(nativeDetail) };
    const manifest = { schema_version: "official_storyboard_handoff_provenance.v1", success: true,
      runtime: { sourceVersion: "fixture-source", buildId: "fixture-build" }, noGenerationOrPaidRequests: true,
      audit: { generationPosts: 0, forwardedProjectPosts: 1, routeErrors: [], blockedMutations: [], pageErrors: [] }, ownerUserId: officialValues["user-id"],
      projectId: capturedProjectId, packageSha256: digest(nativeBytes), conversationId: "capture-conv01", messageId: "capture-message01",
      rawContentSha256: digest(Buffer.from(originalRaw)), commitKey: nativeDetail.commit_key, sourceRoute: "/",
      interactionEvidence: { draftImportClicked: true, previewConfirmed: true, librarySelectionClicked: true },
      firstProjectSave: { method: "POST", pathname: "/api/storyboard/projects", trigger: "library-selection",
        documentId: capturedProjectId, responseProjectId: capturedProjectId, urlProjectId: capturedProjectId, revision: 1,
        responseFile: "response.json" }, projectReadback: { projectId: capturedProjectId, ownerUserId: officialValues["user-id"], revision: 1 },
      cardOrderMap: structuredClone(capturedMap), artifacts: { rawAssistantFile: "raw.txt", nativePackageFile: "package.json",
        firstDocumentFile: "first.json", readbackDocumentFile: "readback.json", importPlanFile: "plan.json", handoffEnvelopeFile: "handoff-envelope.json" } };
    change({ manifest, firstDoc, readDoc, envelope });
    manifest.firstProjectSave.documentSha256 = digest(JSON.stringify(firstDoc));
    manifest.projectReadback.documentSha256 = digest(JSON.stringify(readDoc));
    const manifestBytes = Buffer.from(JSON.stringify(manifest));
    const files = { "provenance.json": manifestBytes, "raw.txt": Buffer.from(originalRaw), "package.json": nativeBytes,
      "handoff-envelope.json": Buffer.from(JSON.stringify(envelope)),
      "first.json": Buffer.from(JSON.stringify(firstDoc)), "readback.json": Buffer.from(JSON.stringify(readDoc)),
      "plan.json": Buffer.from(JSON.stringify(nativeImportPlan)), "response.json": Buffer.from(JSON.stringify({ project: { id: capturedProjectId, revision: 1 } })) };
    const base = path.dirname(officialValues["handoff-provenance-file"]);
    return { values: { ...officialValues, "handoff-provenance-sha256": digest(manifestBytes) },
      io: { readFile: async file => { const name = path.relative(base, file); if (!Object.hasOwn(files, name)) throw new Error("MISSING_CAPTURE_ARTIFACT"); return files[name]; } } };
  };
  const officialCase = createOfficialCase();
  const verifiedOfficial = await loadOfficialHandoff(officialCase.values, officialPkg, contracts, plan, officialCase.io);
  yes(() => assert.deepEqual(verifiedOfficial.cardOrderMap, capturedMap));
  yes(() => assert.equal(verifiedOfficial.summary.ownerUserId, officialValues["user-id"]));
  const capturedRuntime = { sourceVersion: "fixture-source", buildId: "fixture-build" };
  const sourceActor = { id: officialValues["user-id"] };
  const sourceHistory = { conversation: { id: "capture-conv01", user_id: sourceActor.id,
    messages: [{ id: "capture-message01", role: "assistant", content: originalRaw }] } };
  const sourceReads = [];
  yes(() => assert.equal(verifiedOfficial.captureRuntime.buildId, capturedRuntime.buildId));
  assert.equal(await verifyOfficialHandoffSource(verifiedOfficial, officialPkg, contracts, capturedRuntime, sourceActor, async url => {
    sourceReads.push(url); return sourceHistory;
  }), true); checks++;
  yes(() => assert.deepEqual(sourceReads, ["/api/conversations/history?id=capture-conv01"]));
  assert.equal(await verifyOfficialHandoffSource(null, officialPkg, contracts, capturedRuntime, sourceActor, async () => { throw new Error("LEGACY_MUST_NOT_READ"); }), false); checks++;
  await assert.rejects(verifyOfficialHandoffSource(verifiedOfficial, officialPkg, contracts, { ...capturedRuntime, buildId: "stale-build" }, sourceActor, async () => sourceHistory), /SELECTED_HANDOFF_CURRENT_RUNTIME_DRIFT/u); checks++;
  for (const mutate of [
    item => { item.conversation.id = "other-conversation"; },
    item => { item.conversation.user_id = "other-owner"; },
    item => { item.conversation.messages = []; },
    item => { item.conversation.messages[0].id = "other-message"; },
    item => { item.conversation.messages[0].role = "user"; },
    item => { item.conversation.messages[0].content += " altered"; },
  ]) {
    const changed = structuredClone(sourceHistory); mutate(changed);
    await assert.rejects(verifyOfficialHandoffSource(verifiedOfficial, officialPkg, contracts, capturedRuntime, sourceActor, async () => changed)); checks++;
  }
  await assert.rejects(verifyOfficialHandoffSource(verifiedOfficial, officialPkg, contracts, capturedRuntime, sourceActor, async () => { throw new Error("404_SOURCE_UNAVAILABLE"); }), /404_SOURCE_UNAVAILABLE/u); checks++;
  yes(() => assert.equal(cardIdForOrder(officialValues, 2), "shot-fixture02"));
  yes(() => assertFreshImportedDocument(imported, plan, { ...officialValues, nativePlan: nativeExpected }));
  const existingArgs = args.filter(arg => !arg.startsWith("--project-id=")).concat([
    `--existing-project-id=${capturedProjectId}`, "--handoff-provenance-file=RAM/provenance.json",
    "--handoff-provenance-sha256=" + "d".repeat(64), `--user-id=${officialValues["user-id"]}`]);
  yes(() => assert.equal(parseSelectedArgs(existingArgs).values["project-id"], capturedProjectId));
  no(() => parseSelectedArgs([...existingArgs, "--project-id=" + values["project-id"]]));
  no(() => parseSelectedArgs(existingArgs.filter(arg => !arg.startsWith("--handoff-provenance-sha256="))));
  no(() => parseSelectedArgs([...args, "--handoff-provenance-file=RAM/provenance.json"]));
  for (const change of [
    ({ manifest }) => { manifest.success = false; },
    ({ manifest }) => { manifest.noGenerationOrPaidRequests = false; },
    ({ manifest }) => { manifest.audit.generationPosts = 1; },
    ({ manifest }) => { manifest.audit.forwardedProjectPosts = 2; },
    ({ manifest }) => { manifest.audit.routeErrors = ["failed"]; },
    ({ manifest }) => { manifest.audit.blockedMutations = ["blocked"]; },
    ({ manifest }) => { delete manifest.runtime; },
    ({ manifest }) => { delete manifest.artifacts.handoffEnvelopeFile; },
    ({ envelope }) => { envelope.source_route = "/tools/text/text-chat"; },
    ({ envelope }) => { envelope.target = "canvas"; },
    ({ envelope }) => { envelope.payload.message_id = "other-message"; },
    ({ envelope }) => { envelope.payload.commit_key = "other-commit"; },
    ({ envelope }) => { envelope.payload.machine_payload.input.animation_style = "changed"; },
    ({ manifest }) => { manifest.ownerUserId = "other-owner"; },
    ({ manifest }) => { manifest.projectId = "storyboard-run-other01"; },
    ({ manifest }) => { manifest.packageSha256 = "f".repeat(64); },
    ({ manifest }) => { manifest.rawContentSha256 = "f".repeat(64); },
    ({ manifest }) => { manifest.commitKey = "forged-commit"; },
    ({ manifest }) => { manifest.interactionEvidence.previewConfirmed = false; },
    ({ manifest }) => { manifest.firstProjectSave.trigger = "api-created"; },
    ({ manifest }) => { manifest.firstProjectSave.responseProjectId = "other-project"; },
    ({ manifest }) => { manifest.projectReadback.ownerUserId = "other-owner"; },
    ({ manifest }) => { manifest.cardOrderMap[1].id = manifest.cardOrderMap[0].id; },
    ({ manifest }) => { manifest.artifacts.rawAssistantFile = "../outside.txt"; },
    ({ firstDoc }) => { firstDoc.cards[0].imagePrompt += " changed"; },
    ({ readDoc }) => { readDoc.cards[0].videoPrompt += " changed"; },
    ({ firstDoc }) => { firstDoc.cards[0].styleLock = "changed-lock"; },
    ({ readDoc }) => { readDoc.cards[0].sceneId = "changed-scene"; },
    ({ readDoc }) => { readDoc.cards[0].qualityChecks = [{ checkId: "forged", status: "pass", detail: "forged" }]; },
    ({ firstDoc }) => { firstDoc.cards[0].visualAssetRefs = []; },
    ({ readDoc }) => { readDoc.visualAssetPlan.assets[0].identityLock += " changed"; },
    ({ firstDoc }) => { firstDoc.cards[0].imageRecordId = "e".repeat(64); },
    ({ readDoc }) => { readDoc.cards[0].imageRetryBlocked = true; },
    ({ firstDoc }) => { firstDoc.visualAssetWorkspace.candidates.push({ assetId: "old-history" }); },
  ]) {
    const badCase = createOfficialCase(change);
    await assert.rejects(loadOfficialHandoff(badCase.values, officialPkg, contracts, plan, badCase.io)); checks++;
  }
  const formatter = await readAssetPromptBuilder();
  yes(() => assert.match(formatter.format("character", "单人全身三分之四正面"), /角色身份参考图[\s\S]*用户补充的固定资产描述：单人全身三分之四正面$/u));
  yes(() => assert.match(formatter.format("pet", "固定宠物单视角"), /宠物身份参考图[\s\S]*用户补充的固定资产描述：固定宠物单视角$/u));
  yes(() => assert.match(formatter.sha256, /^[a-f0-9]{64}$/u));
  let forwards = 0, aborts = 0;
  const diagnostics = { generationPostAttempts: 0, generationPostsContinued: 0, duplicateGenerationPostsBlocked: 0 };
  const handler = makeWorkbenchPaidPostHandler({ diagnostics, isArmed: () => true, expected: { modelId: "pm_fixture" }, checkFresh: async () => undefined });
  const route = { request: () => ({ method: () => "POST", postDataJSON: () => ({ modelId: "pm_fixture" }) }),
    continue: async () => { forwards++; }, abort: async () => { aborts++; } };
  await handler(route); await handler(route);
  yes(() => assert.equal(forwards, 1));
  yes(() => assert.equal(aborts, 1));
  yes(() => assert.equal(diagnostics.generationPostsContinued, 1));
  console.log(JSON.stringify({ success: true, kind: "storyboard-selected-media-selftest.v1", checks,
    networkCalls: 0, databaseWrites: 0, providerCalls: 0, browserRuns: 0 }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await runSelfTest();
