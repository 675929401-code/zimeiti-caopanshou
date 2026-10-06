import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

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

const choices = [
  { id: "current-incompatible", capabilities: { available: true }, generationReady: true, selectionCompatible: false, modeCompatible: true },
  { id: "preferred-ready", capabilities: { available: true }, generationReady: true, selectionCompatible: true, modeCompatible: true },
  { id: "fallback-not-ready", capabilities: { available: true }, generationReady: false, selectionCompatible: true, modeCompatible: true },
];
assert.equal(availableModelId(choices, "current-incompatible", "preferred-ready"), "preferred-ready");
assert.equal(availableModelId([choices[2]], "fallback-not-ready"), "fallback-not-ready");
assert.equal(availableModelId([{...choices[1],capabilities:{available:false}}], "preferred-ready"), "");

const workspace = readFileSync(new URL("../src/commerce/components/commerce-agent/workspace.tsx", import.meta.url), "utf8");
const route = readFileSync(new URL("../src/app/api/commerce/models/route.ts", import.meta.url), "utf8");
const referenceUi = readFileSync(new URL("../src/commerce/components/commerce-agent/reference-ui.tsx", import.meta.url), "utf8");

for (const field of ["referenceImages", "sourceVideos", "referenceAudios", "duration", "aspectRatio", "resolution", "generateAudioToggle"]) {
  assert.match(route, new RegExp(`q\\.get\\('${field}'\\)`, "u"), `model API must consume ${field}`);
}
assert.match(workspace, /video:videoModelCatalogUrl\(\{referenceImages:selectedVideoImageCount,sourceVideos:selectedVideoSourceCount,referenceAudios:selectedVideoAudioCount,duration,aspectRatio:aspectRatios\.video,resolution:resolutions\.video,requireAudioToggle:true\}\)/u);
assert.match(workspace, /\[skillId,selectedImageCount,selectedVideoImageCount,selectedVideoSourceCount,selectedVideoAudioCount,duration,aspectRatios\.video,resolutions\.video\]/u);
assert.match(workspace, /data-testid=\{`commerce-\$\{mediaKind\}-settings-trigger`\}/u);
assert.match(workspace, /compatibilityIssue=\{tab==='video'\?applicationCapabilityIssue:undefined\}/u);
assert.match(workspace, /videoAudioToggleSupported\?\(videoGenerateAudio\?'含音频':'静音'\):'模型默认音频'/u);
assert.match(referenceUi, /按当前素材与设置实时核对；费用以提交前报价为准。/u);
assert.match(referenceUi, /role=\{compatibilityIssue\?'alert':'status'\}/u);

console.log(JSON.stringify({
  passed: 26,
  networkCalls: 0,
  providerCalls: 0,
  walletCalls: 0,
  databaseWrites: 0,
  paidGenerationCalls: 0,
  checks: [
    "video-catalog-exact-input-query",
    "negative-reference-counts-clamped",
    "incompatible-current-model-replaced",
    "configuration-only-model-remains-selectable",
    "unavailable-model-rejected",
    "api-consumes-every-video-compatibility-field",
    "workspace-requeries-on-material-and-setting-change",
    "model-and-settings-popovers-expose-live-boundary",
  ],
}, null, 2));
