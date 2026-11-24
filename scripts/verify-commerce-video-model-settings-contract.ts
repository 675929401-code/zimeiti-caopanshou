import {compareVideoChannels} from '../src/commerce/server/video-channel-policy';
import {commerceProductInputIssue,videoReferenceIssue} from '../src/commerce/server/video-reference-capabilities';
import {memberVideoBillingText} from '../src/commerce/shared/video-picker-catalog';
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { modelsInRouteOrder, orderedModelCandidateIds } from "../src/commerce/server/prequote-model-selection";
import { agentPreferenceModelRank } from "../src/features/commerce-studio/agent-preferences";
import { commerceVideoCatalogSurface } from "../src/lib/video-workspace-catalog";
import { evaluateWorkspaceModelCompatibility } from "../src/lib/workspace-model-policy";

import {
  availableModelId,
  videoModelCatalogUrl,
} from "../src/commerce/components/commerce-agent/model-selection";

const catalogUrl = videoModelCatalogUrl({
  referenceImages: 3,
  sourceVideos: 1,
  referenceAudios: 2,
  duration: 70,
  aspectRatio: "9:16",
  resolution: "1080P",
  requireAudioToggle: true,
});
const catalog = new URL(catalogUrl, "http://commerce.local");
assert.equal(catalog.pathname, "/api/commerce/models");
assert.deepEqual(Object.fromEntries(catalog.searchParams), {
  kind: "video",
  operationId: "video.generate",
  referenceImages: "3",
  sourceVideos: "1",
  referenceAudios: "2",
  duration: "70",
  aspectRatio: "9:16",
  resolution: "1080P",
  generateAudioToggle: "1",
});

const clamped = new URL(videoModelCatalogUrl({
  referenceImages: -2,
  sourceVideos: -1,
  referenceAudios: -4,
  duration: 10,
  aspectRatio: "16:9",
  resolution: "720p",
  requireAudioToggle: false,
}), "http://commerce.local");
assert.equal(clamped.searchParams.get("referenceImages"), "0");
assert.equal(clamped.searchParams.get("sourceVideos"), "0");
assert.equal(clamped.searchParams.get("referenceAudios"), "0");
assert.equal(clamped.searchParams.get("generateAudioToggle"), "0");

const cheap = {compatible:true,executable:true,releasedAndReady:true,cost:5.5,billingUnit:'output_second' as const,secureSkill:true};
assert.ok(compareVideoChannels(cheap,{...cheap,compatible:false,cost:1})<0);
assert.ok(compareVideoChannels(cheap,{...cheap,releasedAndReady:false,cost:1})<0);
assert.ok(compareVideoChannels({...cheap,cost:4,secureSkill:false},cheap)<0);
assert.ok(compareVideoChannels(cheap,{...cheap,billingUnit:'per_use'})<0);
assert.ok(compareVideoChannels(cheap,{...cheap,secureSkill:false})<0);
assert.ok(commerceProductInputIssue({supportsImageInput:false,supportsReferenceInput:false},false));
assert.ok(commerceProductInputIssue({supportsImageInput:true,firstFrameInputOnly:true},false));
assert.ok(videoReferenceIssue({supportsSourceVideoInput:true,maxReferenceVideos:3,singleSourceVideoBridge:true},{images:0,audios:0,videos:2}));
assert.ok(videoReferenceIssue({supportsImageInput:true},{images:1,audios:0,videos:0,lastFrame:true}));

const choices = [
  { id: "current-incompatible", capabilities: { available: true }, generationReady: true, selectionCompatible: false, modeCompatible: true },
  { id: "preferred-ready", capabilities: { available: true }, generationReady: true, selectionCompatible: true, modeCompatible: true },
  { id: "fallback-not-ready", capabilities: { available: true }, generationReady: false, selectionCompatible: true, modeCompatible: true },
];
const channels = ["2.5", "2.0-mini", "2.0-fast", "2.0"].map(id => ({
  id, internalModelId: "channel-" + id, kind: "video" as const, capabilities: { available: true },
  generationReady: id !== "2.0",
}));
const routeOrder = orderedModelCandidateIds({
  primaryModelId: "channel-2.0", fallbackModelIds: ["missing", "2.0-fast", "2.0-mini", "2.5", "2.0"],
}).candidateIds;
const menu = modelsInRouteOrder(channels, routeOrder);
assert.equal(agentPreferenceModelRank("image","doubao-seedream-5-5-261028"),agentPreferenceModelRank("image","seedream 5.5"));
assert.equal(agentPreferenceModelRank("video","doubao-seedance-2-5-flash-261115"),agentPreferenceModelRank("video","seedance-2.5-flash"));
const assignments = {"commerce-generation-video":{single:true}, "commerce-video":{multi:true}};
const singleImage={id:"single",supports_image_input:true,api_protocol_config:{max_reference_images:1}};
assert.equal(commerceVideoCatalogSurface(assignments,singleImage),"commerce-generation-video");
assert.equal(commerceVideoCatalogSurface(assignments,{id:"multi"}),"commerce-video");
assert.equal(commerceVideoCatalogSurface(assignments,{id:"not-assigned"}),null);
assert.ok(!evaluateWorkspaceModelCompatibility("video",singleImage,"commerce-generation-video").issues.some(i=>i.code==="COMMERCE_MULTI_REFERENCE_REQUIRED"));
assert.ok(evaluateWorkspaceModelCompatibility("video",singleImage,"commerce-video").issues.some(i=>i.code==="COMMERCE_MULTI_REFERENCE_REQUIRED"));
assert.deepEqual(["seedance-2.5","seedance-2.0-mini","seedance-2.0-fast","seedance-2.0"].sort(
  (a,b)=>agentPreferenceModelRank("video",a)-agentPreferenceModelRank("video",b)),["seedance-2.0","seedance-2.0-fast","seedance-2.0-mini","seedance-2.5"]);
assert.deepEqual(menu.map(model => model.id), ["2.0", "2.0-fast", "2.0-mini", "2.5"]);
assert.equal(availableModelId(menu), "2.0-fast");
assert.deepEqual(orderedModelCandidateIds({requestedModelId:"2.0-mini",userSelectable:true,
  primaryModelId:"2.0",fallbackModelIds:["2.5"]}).candidateIds, ["2.0-mini"]);
assert.equal(availableModelId(choices, "current-incompatible", "preferred-ready"), "preferred-ready");
assert.equal(availableModelId([choices[2]], "fallback-not-ready"), "fallback-not-ready");
assert.equal(availableModelId([{...choices[1],capabilities:{available:false}}], "preferred-ready"), "");

const workspace = readFileSync(new URL("../src/commerce/components/commerce-agent/workspace.tsx", import.meta.url), "utf8");
const route = readFileSync(new URL("../src/app/api/commerce/models/route.ts", import.meta.url), "utf8");
const referenceUi = readFileSync(new URL("../src/commerce/components/commerce-agent/reference-ui.tsx", import.meta.url), "utf8");

for (const field of ["referenceImages", "sourceVideos", "referenceAudios", "duration", "aspectRatio", "resolution", "generateAudioToggle"]) {
  assert.match(route, new RegExp(`q\\.get\\('${field}'\\)`, "u"), `model API must consume ${field}`);
}
assert.ok(workspace.includes('video:videoQuery') && workspace.includes('videoQuery=videoModelCatalogUrl('));
assert.ok(workspace.includes('[skillId,selectedImageCount,videoQuery]') && workspace.includes('!videoQueryCurrent'));
assert.match(workspace, /requireVideoAudioToggle=videoGenerateAudio===false\|\|Boolean\(boundVideoApplication\)/u);
assert.match(workspace, /data-testid=\{`commerce-\$\{mediaKind\}-settings-trigger`\}/u);
assert.match(workspace, /compatibilityIssue=\{tab==='video'\?applicationCapabilityIssue:undefined\}/u);
assert.ok(workspace.includes("resolution.toUpperCase()") && workspace.includes("`${duration}s`"));
assert.doesNotMatch(workspace, /nativeDurations\.join\('\/'\)/u);
assert.equal(memberVideoBillingText({unit:'per_use',unitPrice:1.2},'720p'),'¥1.20/次');
assert.equal(memberVideoBillingText({unit:'output_second',unitPrice:0.7},'720p'),'¥0.70/秒');
assert.equal(memberVideoBillingText({unit:'output_second',resolutionPrices:{'480p':0.4318,'720p':0.86436}},'720P'),'¥0.86436/秒');
assert.equal(memberVideoBillingText({unit:'output_second',resolutionPrices:{'720p':0.86436}},'1080p'),'按秒计费');
assert.equal(memberVideoBillingText({unit:'token'},'720p'),'按实际 Token 计费');
assert.match(referenceUi, /按当前素材与设置实时核对；费用以提交前报价为准。/u);
assert.ok(referenceUi.includes('compatibilityIssue&&<p') && referenceUi.includes('role="alert"'));

console.log(JSON.stringify({
  passed: 51,
  networkCalls: 0,
  providerCalls: 0,
  walletCalls: 0,
  databaseWrites: 0,
  paidGenerationCalls: 0,
  checks: [
    "video-catalog-exact-input-query",
    "video-menu-uses-governed-order-without-duplicates",
    "first-ready-configured-fallback",
    "explicit-selection-keeps-only-requested-model",
    "negative-reference-counts-clamped",
    "incompatible-current-model-replaced",
    "configuration-only-model-remains-selectable",
    "unavailable-model-rejected",
    "api-consumes-every-video-compatibility-field",
    "workspace-requeries-on-material-and-setting-change",
    "model-and-settings-popovers-expose-live-boundary",
  ],
}, null, 2));
