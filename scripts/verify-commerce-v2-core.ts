import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { baselineDirectorCatalog } from "../src/commerce/server/director-catalog";
import {
  COMMERCE_V2_DRAFT_SCHEMA,
  type ModelCapabilityProfile,
  type ProductionDraft,
  type ProductionTaskEvent,
  type ProductionTaskState,
} from "../src/commerce-v2/domain/contracts";
import { parseProductionDraft } from "../src/commerce-v2/domain/parse-draft";
import { assignDirectorMaterialRoles, validateDirectorMaterialContract } from "../src/commerce-v2/domain/director-material-contract";
import { compileProductionPlan } from "../src/commerce-v2/domain/production-plan";
import { assertProductionQuoteConfirmation, createProductionQuote } from "../src/commerce-v2/domain/quote-contract";
import { isProductionTaskTerminal, nextProductionTaskState, productionTaskCanRecover } from "../src/commerce-v2/domain/task-state-machine";

let passed = 0;
function check(run: () => void) {
  run();
  passed += 1;
}

const rollingModel: ModelCapabilityProfile = {
  id: "video-contract-fixture",
  displayName: "视频合同模型",
  configHash: "video-config-v7",
  available: true,
  executionReady: true,
  readinessMessage: "执行链已验收",
  billingUnit: "output_second",
  publicPrice: 0.125,
  capabilities: {
    supportsImageInput: true,
    maxReferenceImages: 10,
    minReferenceImages: 0,
    supportsSourceVideoInput: true,
    maxReferenceVideos: 1,
    requiresSourceVideo: false,
    supportsAudioInput: true,
    maxReferenceAudios: 1,
    supportsGenerateAudioToggle: true,
    aspectRatios: ["9:16", "16:9"],
    resolutionOptions: ["720p", "1080p"],
    nativeDurations: Array.from({ length: 12 }, (_, index) => index + 4),
    supportsRollingContinuation: true,
  },
};

function draft(durationSeconds = 10): ProductionDraft {
  return {
    schema: COMMERCE_V2_DRAFT_SCHEMA,
    id: "draft-contract-fixture",
    revision: 3,
    kind: "video",
    prompt: "商品保持外形一致，展示开箱、细节与真实使用动作。",
    skillKey: "video-direct",
    modelId: rollingModel.id,
    materials: [],
    videoSettings: {
      aspectRatio: "9:16",
      resolution: "720p",
      durationSeconds,
      generateAudio: true,
    },
  };
}

check(() => assert.equal(parseProductionDraft(draft()).schema, COMMERCE_V2_DRAFT_SCHEMA));
check(() => assert.throws(() => parseProductionDraft({ ...draft(), revision: 0 }), /草稿修订号无效/u));
check(() => assert.throws(() => parseProductionDraft({ ...draft(), videoSettings: { ...draft().videoSettings, durationSeconds: 81 } }), /4–80/u));
check(() => assert.throws(() => parseProductionDraft({ ...draft(), materials: [{ instanceId: "same", name: "a", kind: "image", role: "reference-image", source: "asset-library", assetId: "a" }, { instanceId: "same", name: "b", kind: "image", role: "reference-image", source: "asset-library", assetId: "b" }] }), /实例标识重复/u));
check(() => {
  const parsed = parseProductionDraft({ ...draft(), materials: [{ instanceId: "asset-meta", assetId: "asset-meta", name: "a.png", kind: "image", role: "product", source: "asset-library", mimeType: "image/png", size: 123, sha256: "a".repeat(64) }] });
  assert.deepEqual(parsed.materials[0], { instanceId: "asset-meta", assetId: "asset-meta", name: "a.png", kind: "image", role: "product", source: "asset-library", mimeType: "image/png", size: 123, sha256: "a".repeat(64) });
});
check(() => {
  const parsed = parseProductionDraft({
    ...draft(),
    director: { skillKey: "default-director", registryVersion: "registry", promptVersion: "prompt", outputProtocol: "director-script/v2", conversationId: "conversation", messageId: "message", applicationId: "application", script: "script" },
  });
  assert.equal(parsed.director?.conversationId, "conversation");
  assert.equal(parsed.director?.messageId, "message");
  assert.equal(parsed.director?.applicationId, "application");
});

const directorSlots = [
  { key: "product", label: "商品", min: 1, max: 2, kinds: ["image"] },
  { key: "voice", label: "声音", min: 0, max: 1, kinds: ["audio"] },
];
check(() => {
  const assigned = assignDirectorMaterialRoles([
    { instanceId: "i1", name: "product.png", kind: "image", role: "reference-image", source: "local-session" },
    { instanceId: "a1", name: "voice.wav", kind: "audio", role: "voice", source: "local-session" },
  ], directorSlots);
  assert.deepEqual(assigned.map((item) => item.role), ["product", "voice"]);
  assert.deepEqual(validateDirectorMaterialContract(assigned, directorSlots), []);
});
check(() => assert.match(validateDirectorMaterialContract([], directorSlots).join("\n"), /商品需要 1–2 个/u));
check(() => assert.match(validateDirectorMaterialContract([{ instanceId: "bad", name: "bad.mp4", kind: "video", role: "product", source: "local-session" }], directorSlots).join("\n"), /不能用于/u));

for (const [duration, expected] of [
  [30, [15, 15]],
  [60, [15, 15, 15, 15]],
  [70, [14, 14, 14, 14, 14]],
  [80, [14, 14, 13, 13, 13, 13]],
] as const) {
  check(() => {
    const plan = compileProductionPlan({ planId: `plan-${duration}`, draft: draft(duration), model: rollingModel });
    assert.deepEqual(plan.segments.map((segment) => segment.durationSeconds), expected);
    assert.equal(plan.segments[0]?.continuitySource, "input");
    assert.ok(plan.segments.slice(1).every((segment) => segment.continuitySource === "previous-final-frame"));
    assert.equal(plan.confirmable, true);
  });
}

check(() => {
  const plan = compileProductionPlan({
    planId: "temporary-material",
    draft: {
      ...draft(),
      materials: [{ instanceId: "local-1", name: "local.png", kind: "image", role: "reference-image", source: "local-session" }],
    },
    model: rollingModel,
  });
  assert.equal(plan.confirmable, false);
  assert.match(plan.executionIssues.join("\n"), /尚未进入资产库/u);
});

check(() => {
  const plan = compileProductionPlan({
    planId: "director-without-script",
    draft: {
      ...draft(),
      skillKey: "default-director",
      director: {
        skillKey: "default-director",
        registryVersion: "registry-v1",
        promptVersion: "prompt-v1",
        outputProtocol: "director-script/v2",
      },
    },
    model: rollingModel,
  });
  assert.equal(plan.confirmable, false);
  assert.match(plan.executionIssues.join("\n"), /编导尚未产出/u);
});

check(() => {
  const incompatible = structuredClone(rollingModel);
  incompatible.capabilities.supportsImageInput = false;
  incompatible.capabilities.maxReferenceImages = 0;
  const plan = compileProductionPlan({
    planId: "incompatible-reference",
    draft: {
      ...draft(),
      materials: [{ instanceId: "asset-1", assetId: "asset-1", name: "reference.png", kind: "image", role: "reference-image", source: "asset-library" }],
    },
    model: incompatible,
  });
  assert.equal(plan.confirmable, false);
  assert.match(plan.configurationIssues.join("\n"), /不接收参考图片/u);
});

const quotePlan = compileProductionPlan({ planId: "quote-plan", draft: draft(60), model: rollingModel });
const now = 1_800_000_000_000;
const quote = createProductionQuote({ quoteId: "quote-v2", plan: quotePlan, planHash: "plan-hash-v2", now });
check(() => assert.equal(quote.quantity, 60));
check(() => assert.equal(quote.payableTotal, 7.5));
check(() => assert.equal(assertProductionQuoteConfirmation({ quote, planHash: "plan-hash-v2", modelConfigHash: rollingModel.configHash, expectedPayableTotal: 7.5, now: now + 1 }), true));
check(() => assert.throws(() => assertProductionQuoteConfirmation({ quote, planHash: "changed", modelConfigHash: rollingModel.configHash, expectedPayableTotal: 7.5, now: now + 1 }), /重新报价/u));
check(() => assert.throws(() => assertProductionQuoteConfirmation({ quote, planHash: "plan-hash-v2", modelConfigHash: "changed", expectedPayableTotal: 7.5, now: now + 1 }), /模型配置已经变化/u));
check(() => assert.throws(() => assertProductionQuoteConfirmation({ quote, planHash: "plan-hash-v2", modelConfigHash: rollingModel.configHash, expectedPayableTotal: 7.5, now: quote.expiresAt }), /报价已过期/u));
check(() => assert.throws(() => assertProductionQuoteConfirmation({ quote, planHash: "plan-hash-v2", modelConfigHash: rollingModel.configHash, expectedPayableTotal: 7.6, now: now + 1 }), /金额/u));

check(() => {
  const events: ProductionTaskEvent[] = ["plan", "quote", "confirm", "enqueue", "start", "provider_succeeded", "save_succeeded"];
  const state = events.reduce<ProductionTaskState>((current, event) => nextProductionTaskState(current, event), "draft");
  assert.equal(state, "succeeded");
  assert.equal(isProductionTaskTerminal(state), true);
});
check(() => assert.throws(() => nextProductionTaskState("draft", "start"), /不允许事件/u));
check(() => {
  assert.equal(nextProductionTaskState("running", "dispatch_unknown"), "unknown");
  assert.equal(productionTaskCanRecover("unknown"), true);
  assert.equal(nextProductionTaskState("unknown", "provider_succeeded"), "saving");
});
check(() => {
  assert.equal(nextProductionTaskState("saving", "save_failed"), "save_failed");
  assert.equal(nextProductionTaskState("save_failed", "retry_save"), "saving");
});
check(() => {
  assert.equal(nextProductionTaskState("failed", "begin_refund"), "refunding");
  assert.equal(nextProductionTaskState("refunding", "refund_succeeded"), "refunded");
  assert.equal(isProductionTaskTerminal("refunded"), true);
});

check(() => {
  const directors = baselineDirectorCatalog();
  assert.equal(directors.length, 19);
  assert.equal(new Set(directors.map((director) => director.key)).size, 19);
  assert.ok(directors.every((director) => director.slots.length > 0));
});

const registrySource = readFileSync(new URL("../src/commerce-v2/server/director-registry.ts", import.meta.url), "utf8");
const catalogRoute = readFileSync(new URL("../src/app/api/commerce/v2/catalog/route.ts", import.meta.url), "utf8");
const planRoute = readFileSync(new URL("../src/app/api/commerce/v2/plan/route.ts", import.meta.url), "utf8");
const assetRoute = readFileSync(new URL("../src/app/api/commerce/v2/assets/route.ts", import.meta.url), "utf8");
const materialRegistry = readFileSync(new URL("../src/commerce-v2/server/material-registry.ts", import.meta.url), "utf8");
const compilationService = readFileSync(new URL("../src/commerce-v2/server/compile-production.ts", import.meta.url), "utf8");
const quoteRoute = readFileSync(new URL("../src/app/api/commerce/v2/quote/route.ts", import.meta.url), "utf8");
const quoteStore = readFileSync(new URL("../src/commerce-v2/server/quote-store.ts", import.meta.url), "utf8");
const directorRoute = readFileSync(new URL("../src/app/api/commerce/v2/director/route.ts", import.meta.url), "utf8");
const workbenchSource = readFileSync(new URL("../src/commerce-v2/components/workbench.tsx", import.meta.url), "utf8");

check(() => assert.match(registrySource, /identities\.length !== 19/u));
check(() => assert.match(registrySource, /const promptVersion = commerceV2Sha256/u));
check(() => assert.match(registrySource, /outputProtocol: "director-script\/v2"/u));
check(() => assert.match(catalogRoute, /requireIdentity\(request\)/u));
check(() => assert.match(catalogRoute, /paidSubmissionEnabled: false/u));
check(() => assert.match(planRoute, /sameOrigin\(request\)/u));
check(() => assert.match(planRoute, /compileCommerceV2Production/u));
check(() => assert.match(compilationService, /canonicalizeProductionMaterials/u));
check(() => assert.match(compilationService, /validateDirectorMaterialContract/u));
check(() => assert.match(planRoute, /databaseWrites: 0[\s\S]*walletCalls: 0[\s\S]*providerCalls: 0[\s\S]*paidGenerationCalls: 0/u));
check(() => assert.doesNotMatch(planRoute, /debit|reserve|dispatch|enqueue|fetch\s*\(/iu));
check(() => assert.match(materialRegistry, /readAsset\(material\.assetId, owner\)/u));
check(() => assert.match(materialRegistry, /sha256: asset\.sha256/u));
check(() => assert.match(assetRoute, /sameOrigin\(request\)/u));
check(() => assert.match(assetRoute, /storeAsset\(identity\.id/u));
check(() => assert.match(assetRoute, /walletCalls: 0[\s\S]*providerCalls: 0[\s\S]*paidGenerationCalls: 0/u));
check(() => assert.match(quoteRoute, /compileCommerceV2Production/u));
check(() => assert.match(quoteRoute, /confirmationEnabled: false/u));
check(() => assert.match(quoteRoute, /databaseWrites: 1[\s\S]*walletCalls: 0[\s\S]*providerCalls: 0[\s\S]*paidGenerationCalls: 0/u));
check(() => assert.match(quoteStore, /put\("commerce-v2-quotes"/u));
check(() => assert.match(quoteStore, /get<StoredProductionQuote>\("commerce-v2-quotes"/u));
check(() => assert.match(directorRoute, /commerceV2DirectorDefinition/u));
check(() => assert.match(directorRoute, /validateDirectorMaterialContract/u));
check(() => assert.match(directorRoute, /quoteDirectorTurn/u));
check(() => assert.match(directorRoute, /applyDirector/u));
check(() => assert.match(directorRoute, /confirmationEnabled: false/u));
check(() => assert.match(directorRoute, /walletCalls: 0[\s\S]*providerCalls: 0[\s\S]*paidGenerationCalls: 0/u));
check(() => assert.match(workbenchSource, /compileProductionPlan/u));
check(() => assert.match(workbenchSource, /commerce-v2:\$\{catalog\.workspaceKey\}:video-draft/u));
check(() => assert.match(workbenchSource, /付费提交仍保持关闭/u));

console.log(JSON.stringify({
  passed,
  networkCalls: 0,
  providerCalls: 0,
  walletCalls: 0,
  databaseWrites: 0,
  paidGenerationCalls: 0,
  contracts: [
    "strict-draft-parse",
    "30-60-70-80-second-rolling-plan",
    "real-final-frame-continuity",
    "material-durability-gate",
    "director-application-gate",
    "exact-capability-validation",
    "immutable-quote-confirmation",
    "recoverable-task-state-machine",
    "fixed-19-director-registry",
    "authenticated-zero-cost-api",
    "workspace-scoped-draft-persistence",
  ],
}, null, 2));
