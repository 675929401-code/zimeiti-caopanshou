import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { createImportedStoryboardVisualAssetWorkspace, isStoryboardVisualAssetCandidateForProject, storyboardReferenceImageSettings, normalizeStoryboardVisualAssetWorkspace } from "../src/lib/storyboard-visual-asset-workspace";
import { StoryboardVisualAssetPlanSchema } from "../src/lib/storyboard-workbench";

export async function runImportedAssetWorkspaceChecks() {
  let checks = 0;
  const check = (operation: () => void) => { operation(); checks++; };
  const board = { imageModelId: "board-c", imageResolution: "2K", imageRatio: "9:16" as const, ratio: "16:9" as const };
  check(() => assert.deepEqual(storyboardReferenceImageSettings(board), { modelId: "board-c", resolution: "2K", ratio: "9:16" }));
  const reference = { modelId: "reference-a", resolution: "1K", ratio: "1:1" as const };
  const independent = { ...board, visualAssetWorkspace: normalizeStoryboardVisualAssetWorkspace({
    generationSettings: reference, drafts: [], candidates: [],
  }) };
  check(() => assert.deepEqual(storyboardReferenceImageSettings(independent), reference));
  check(() => assert.equal(independent.imageRatio, "9:16"));
  check(() => assert.equal(independent.ratio, "16:9"));
  check(() => assert.deepEqual(storyboardReferenceImageSettings({ ...independent, imageRatio: "16:9" }), reference));
  check(() => assert.deepEqual(normalizeStoryboardVisualAssetWorkspace(JSON.parse(JSON.stringify(independent.visualAssetWorkspace)))?.generationSettings, reference));
  for (const generationSettings of [null, {}, { ...reference, ratio: "4:3" }, { modelId: "reference-a", ratio: "1:1" }]) {
    check(() => assert.throws(() => normalizeStoryboardVisualAssetWorkspace({ drafts: [], candidates: [], generationSettings })));
  }
  check(() => assert.equal(createImportedStoryboardVisualAssetWorkspace().generationSettings, undefined));
  const personPrompt = "人物穿学院风针织开衫和深色长裤，保持脸型与发型、衣料纹理和完整体态。\n第二行原文保留。";
  const petPrompt = "同一只蜂蜜棕色金毛，保留眼睛耳形与青绿项圈，完整四足自然站立。";
  const asset = (id: string, role: "character" | "pet" | "environment", prompt: string) => ({
    id, role, name: role === "character" ? "人物甲" : role === "pet" ? "宠物甲" : "客厅甲",
    identityLock: "固定身份外观和清晰可辨的主要特征，不随镜头改变。",
    allowedChanges: ["自然姿态"], referencePrompts: [{ kind: role === "environment" ? "environment-wide" : "identity", purpose: "首轮身份参考", prompt }],
  });
  const plan = StoryboardVisualAssetPlanSchema.parse({
    mode: "selected", assets: [asset("character_main", "character", personPrompt), asset("pet_main", "pet", petPrompt),
      asset("environment_living", "environment", "环境空间稳定，左侧窗光，后方沙发，保持自然材质和清晰通路。")],
    generationPolicy: { maxInitialImages: 2, initialRequiredAssetIds: ["character_main", "pet_main"],
      initialDeferredAssetIds: ["environment_living"], environmentAnchorPolicy: "per-scene-when-required" },
  });
  const original = JSON.stringify(plan);
  const prepared = createImportedStoryboardVisualAssetWorkspace(plan);
  check(() => assert.deepEqual(prepared.drafts.map(d => d.planId), ["character_main", "pet_main"]));
  check(() => assert.deepEqual(prepared.drafts.map(d => d.prompt), [personPrompt, petPrompt]));
  check(() => assert.deepEqual(prepared.candidates, []));
  check(() => assert.equal(JSON.stringify(plan), original));
  check(() => assert.equal(prepared.drafts.some(d => d.role === "environment"), false));
  prepared.drafts[0].prompt = "editable draft";
  check(() => assert.equal(plan.assets[0].referencePrompts[0].prompt, personPrompt));
  check(() => assert.deepEqual(createImportedStoryboardVisualAssetWorkspace(), { drafts: [], candidates: [] }));
  check(() => assert.deepEqual(createImportedStoryboardVisualAssetWorkspace({ mode: "off", assets: [] }), { drafts: [], candidates: [] }));
  const bound = structuredClone(plan);
  bound.assets[0].source = { kind: "uploaded-image", assetId: "owned-file-id", librarySaved: true, storageKey: "owned-key" };
  const boundBefore = JSON.stringify(bound);
  check(() => assert.deepEqual(createImportedStoryboardVisualAssetWorkspace(bound).drafts.map(d => d.planId), ["pet_main"]));
  check(() => assert.equal(JSON.stringify(bound), boundBefore));
  const reused = structuredClone(bound);
  reused.generationPolicy!.initialRequiredAssetIds = ["pet_main"];
  check(() => assert.deepEqual(createImportedStoryboardVisualAssetWorkspace(reused).drafts.map(d => d.planId), ["pet_main"]));
  const legacy = structuredClone(bound); delete legacy.generationPolicy;
  check(() => assert.deepEqual(createImportedStoryboardVisualAssetWorkspace(legacy), { drafts: [], candidates: [] }));
  for (const mutate of [
    (value: typeof plan) => { value.generationPolicy!.initialRequiredAssetIds.push("unknown_slot"); },
    (value: typeof plan) => { value.generationPolicy!.initialRequiredAssetIds = ["pet_main", "pet_main"]; },
    (value: typeof plan) => { value.generationPolicy!.initialDeferredAssetIds.push("pet_main"); },
    (value: typeof plan) => { value.generationPolicy!.maxInitialImages = 1; },
  ]) {
    const invalid = structuredClone(plan); mutate(invalid);
    check(() => assert.throws(() => createImportedStoryboardVisualAssetWorkspace(invalid)));
  }
  check(() => assert.equal(isStoryboardVisualAssetCandidateForProject({ projectId: "old" }, "new"), false));
  check(() => assert.equal(isStoryboardVisualAssetCandidateForProject({ projectId: "new" }, "new"), true));
  check(() => assert.equal(isStoryboardVisualAssetCandidateForProject({}, "new"), false));
  check(() => assert.equal(isStoryboardVisualAssetCandidateForProject({}, ""), true));
  check(() => assert.equal(isStoryboardVisualAssetCandidateForProject({ projectId: "old" }, ""), false));

  // Execute the actual import callback with inert dependencies, not a replacement implementation.
  const component = readFileSync("src/components/storyboard-workbench.tsx", "utf8");
  const tree = ts.createSourceFile("workbench.tsx", component, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let callback = "";
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(tree) === "applyImportedSegments"
      && node.initializer && ts.isCallExpression(node.initializer)) callback = node.initializer.arguments[0].getText(tree);
    ts.forEachChild(node, visit);
  }
  visit(tree);
  assert.ok(callback);
  const compile = (text: string) => ts.transpileModule(text, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
  } }).outputText;
  const importedSegments = [1, 2, 3].map(order => ({
    sourceNumber: order, narration: `原文${order}`, imagePrompt: `图像原文${order}`, videoPrompt: `视频原文${order}`,
    visualAssetRefs: [{ assetId: "character_main", role: "character", referenceKinds: ["identity"] },
      { assetId: "pet_main", role: "pet", referenceKinds: ["identity"] }],
  }));
  async function runImport(proposed: typeof plan | undefined, activePlan = plan, blocked?: "generating" | "upload" | "pending") {
    let serial = 0, stored: Record<string, unknown> | undefined, requests = 0;
    const old = { id: "old-project", ratio: "16:9", videoDuration: 10, cards: [], visualAssetPlan: structuredClone(activePlan),
      visualAssetWorkspace: { generationSettings: { modelId: "OLD_SETTINGS", resolution: "1K", ratio: "1:1" }, drafts: [{ planId: "old_slot", prompt: "OLD_DRAFT" }],
        candidates: [{ planId: "character_main", projectId: "old-project", previewUrl: "OLD_MEDIA" }] } };
    const oldBytes = JSON.stringify(old);
    const current = { current: old };
    const sandbox = {
      createImportedStoryboardVisualAssetWorkspace, visualAssetMutationRef: { current: false }, runRef: current, MAX_CARDS: 80,
      visualAssetGenerationRef: { current: blocked === "generating" },
      referenceUploadOperationRef: { current: blocked === "upload" ? "pending-upload" : null },
      pendingAssetAttempts: blocked === "pending" ? [{ requestId: "unresolved-request" }] : [],
      setVisualAssetSaving() {}, setNotice() {}, imageAttemptNeedsResolution: () => false, isActiveVideoStatus: () => false,
      resolveVisualAssetUrls: async () => [], referenceLimit: 8, requestedVisualAssetIds: () => [],
      bindVisualAssetPlan: (card: object) => ({ card: { ...card, referenceImageUrls: [], visualAssetRefs: [] }, missing: [], overLimit: [] }),
      archiveRunSnapshot() {}, createId: (prefix: string) => `${prefix}-${++serial}`,
      createCard: (order: number) => ({ id: `shot-${++serial}`, order, imageStatus: "idle", videoStatus: "idle", referenceImageUrls: [] }),
      isWorkbenchRatio: () => true, visualAssetReferenceKind: () => "identity",
      setRun: (value: Record<string, unknown>) => { stored = value; }, setExpandedVideoCards() {},
      fetch: () => { requests++; throw Error("NETWORK_FORBIDDEN"); },
    };
    const invoke = vm.runInNewContext(compile(`(${callback})`), sandbox) as (input: object) => Promise<string>;
    const returned = await invoke({ segments: importedSegments, ...(proposed !== undefined ? { visualAssetPlan: proposed } : {}),
      title: "真实导入", ratio: "16:9", videoDuration: 10, successNotice: "已导入" });
    if (blocked) {
      check(() => assert.equal(returned, null));
      check(() => assert.equal(stored, undefined));
      check(() => assert.equal(JSON.stringify(old), oldBytes));
      check(() => assert.equal(requests, 0));
      return old;
    }
    assert.ok(returned && stored);
    check(() => assert.equal(stored!.id, returned));
    check(() => assert.equal(JSON.stringify(old), oldBytes));
    check(() => assert.equal(requests, 0));
    check(() => assert.equal(JSON.stringify(stored).includes("OLD_"), false));
    check(() => assert.deepEqual(JSON.parse(JSON.stringify(stored!.visualAssetWorkspace)),
      createImportedStoryboardVisualAssetWorkspace(proposed || activePlan)));
    const cards = stored!.cards as Array<Record<string, unknown>>;
    check(() => assert.deepEqual(cards.map(c => c.imagePrompt), importedSegments.map(c => c.imagePrompt)));
    check(() => assert.deepEqual(cards.map(c => c.videoPrompt), importedSegments.map(c => c.videoPrompt)));
    return stored;
  }
  const imported = await runImport(plan);
  const importedCards = imported.cards as Array<{ visualAssetRefs: Array<{ assetId: string }> }>;
  check(() => assert.ok(importedCards.every(card => card.visualAssetRefs.every(ref => plan.assets.some(a => a.id === ref.assetId)))));
  await runImport(bound);
  await runImport({ mode: "off", assets: [] });
  await runImport(undefined);
  await runImport(undefined, { mode: "off", assets: [] });
  for (const state of ["generating", "upload", "pending"] as const) await runImport(plan, plan, state);

  // Execute the drawer's actual automatic result selection expression.
  const drawer = readFileSync("src/components/storyboard-visual-assets-drawer.tsx", "utf8");
  const resultLine = drawer.split("\n").find(line => line.trim().startsWith("const result = generated.find("));
  assert.ok(resultLine);
  const selectResult = (generated: object[], candidates: object[], selectedAssets: object[], projectId: string) =>
    vm.runInNewContext(resultLine.replace("const result =", "globalThis.result =") + "\nresult", {
      generated, props: { candidates, selectedAssets, projectId }, draft: { planId: "character_main" },
      isStoryboardVisualAssetCandidateForProject,
    });
  const oldCandidate = { planId: "character_main", projectId: "old-project", assetId: "old-image" };
  const newCandidate = { planId: "character_main", projectId: "new-project", assetId: "new-image" };
  check(() => assert.equal(selectResult([oldCandidate], [oldCandidate], [], "new-project"), undefined));
  check(() => assert.equal(selectResult([], [oldCandidate, newCandidate], [], "new-project"), newCandidate));
  const selectedOwned = { planId: "character_main", assetId: "explicitly-owned" };
  check(() => assert.equal(selectResult([], [oldCandidate], [selectedOwned], "new-project"), selectedOwned));
  return { success: true, checks, scope: "pure-helper-and-actual-import-callback-and-slot-selection", runtimeVerified: false };
}

if (process.argv[1]?.replace(/\\/gu, "/").endsWith("/verify-storyboard-imported-asset-workspace.ts")) {
  runImportedAssetWorkspaceChecks().then(result => console.log(JSON.stringify(result))).catch(error => {
    console.error(error); process.exitCode = 1;
  });
}
