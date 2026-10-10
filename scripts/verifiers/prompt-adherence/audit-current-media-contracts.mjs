import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const read = relative => readFile(path.join(root, relative), "utf8");
const [imageRequest, imageParameters, imageSnapshot, imageHistory, videoRoute, videoSnapshot, videoHistory, h3Adapter, videoAdapter, videoParameterIntegrityTest] = await Promise.all([
  read("src/lib/image-generation-request.ts"),
  read("src/lib/image-parameter-contract.ts"),
  read("src/lib/image-failure-history.ts"),
  read("src/app/api/image-workbench/history/route.ts"),
  read("src/app/api/video/generate/route.ts"),
  read("src/lib/video-budget-reservation.ts"),
  read("src/app/api/video/history/route.ts"),
  read("src/lib/video-autodl-comfyui-workflow.ts"),
  read("src/lib/video-adapter.ts"),
  read("scripts/verify-video-parameter-integrity-contract.mjs"),
]);

for (const token of ["prompt", "aspectRatio", "resolution", "referenceImageUrls", "referenceUsage"]) assert.match(imageRequest, new RegExp(token, "u"));
for (const token of ["negativePrompt: \"rejected\"", "seed: \"rejected\"", "imageCount", "effectivePrompt", "payloadFingerprint"]) {
  assert.match(`${imageParameters}\n${imageSnapshot}`, new RegExp(token, "u"));
}
for (const token of ["request_snapshot", "effectivePrompt", "providerProtocol", "outputPixelSize"]) assert.match(imageHistory, new RegExp(token, "u"));

for (const token of ["userPrompt", "effectivePrompt", "negativePrompt", "referenceAssets", "targetDurationSeconds", "effectiveDurationSeconds", "fps", "seed", "generateAudio", "providerPayloadHash"]) {
  assert.match(videoSnapshot, new RegExp(token, "u"));
}
for (const token of ["requestSnapshot", "retryInputs", "referenceAudioUrls", "sourceVideoUrl"]) assert.match(videoHistory, new RegExp(token, "u"));

const h3BuildBody = h3Adapter.match(/function buildBody[\s\S]*?function normalizeStatus/u)?.[0] || "";
assert.match(h3BuildBody, /body\.prompt = params\.prompt/u);
assert.match(h3BuildBody, /body\[durationField\] = durationFor/u);
assert.match(h3BuildBody, /body\.resolution = resolutionFor/u);
assert.match(h3BuildBody, /ref_image_/u);
assert.match(h3BuildBody, /ref_audio_/u);

const h3RouteAcceptsNegative = /negativePrompt: negative_prompt \|\| undefined/u.test(videoRoute);
const h3RouteAcceptsGenerateAudio = /generateAudio: typeof generateAudio === "boolean"/u.test(videoRoute);
const h3ProviderBodyForwardsNegative = /negativePrompt/u.test(h3BuildBody);
const h3ProviderBodyForwardsGenerateAudio = /generateAudio/u.test(h3BuildBody);
const h3ValidatorRejectsNegativeOrToggle = /negativePrompt|generateAudio/u.test(
  h3Adapter.match(/export function validateAutodlComfyuiWorkflowInput[\s\S]*?function buildBody/u)?.[0] || "",
);

const guardedProtocols = videoAdapter.match(/const PRICED_PARAMETER_GUARDED_PROTOCOLS = new Set\(\[[\s\S]*?\]\);/u)?.[0] || "";
const h3GloballyGuarded = guardedProtocols.includes("autodl_comfyui_workflow");
const h3HostedNegativeRejectionCovered = /baseConfig\("autodl_comfyui_workflow"\), \{ duration: 8, negativePrompt:/u.test(videoParameterIntegrityTest);
const h3HostedAudioToggleRejectionCovered = /baseConfig\("autodl_comfyui_workflow"\), \{ duration: 8, generateAudio:/u.test(videoParameterIntegrityTest);
const h3LegacyNegativeRejectionCovered = /baseConfig\("autodl_comfyui_h3"\), \{ duration: 8, negativePrompt:/u.test(videoParameterIntegrityTest);
const h3LegacyAudioToggleRejectionCovered = /baseConfig\("autodl_comfyui_h3"\), \{ duration: 8, generateAudio:/u.test(videoParameterIntegrityTest);
const h3SelfhostNegativeRejectionCovered = /baseConfig\("autodl_h3_selfhost"\), \{ duration: 8, negativePrompt:/u.test(videoParameterIntegrityTest);
const h3SelfhostAudioToggleRejectionCovered = /baseConfig\("autodl_h3_selfhost"\), \{ duration: 8, generateAudio:/u.test(videoParameterIntegrityTest);
const h3ZeroNetworkRejectionCoverage = [
  h3HostedNegativeRejectionCovered,
  h3HostedAudioToggleRejectionCovered,
  h3LegacyNegativeRejectionCovered,
  h3LegacyAudioToggleRejectionCovered,
  h3SelfhostNegativeRejectionCovered,
  h3SelfhostAudioToggleRejectionCovered,
].every(Boolean);
assert.equal(h3ZeroNetworkRejectionCoverage, true, "H3 protocols must retain zero-network rejection coverage for undeclared negativePrompt and generateAudio controls");
const findings = [];
if (h3RouteAcceptsNegative && !h3ProviderBodyForwardsNegative && !h3ValidatorRejectsNegativeOrToggle && !h3GloballyGuarded) {
  findings.push({
    id: "H3-NEGATIVE-PROMPT-SNAPSHOT-WITHOUT-DISPATCH",
    severity: "high",
    status: "open",
    boundary: "A request snapshot can contain negativePrompt while the hosted H3 provider body omits it and no pre-dispatch rejection is visible."
  });
}
if (h3RouteAcceptsGenerateAudio && !h3ProviderBodyForwardsGenerateAudio && !h3ValidatorRejectsNegativeOrToggle && !h3GloballyGuarded) {
  findings.push({
    id: "H3-GENERATE-AUDIO-SNAPSHOT-WITHOUT-DISPATCH",
    severity: "high",
    status: "open",
    boundary: "A request snapshot can contain generateAudio while the hosted H3 provider body omits it; reference audio transport is a separate capability."
  });
}

process.stdout.write(`${JSON.stringify({
  schema: "media_submission_contract_audit.v1",
  evidenceLevel: "source_and_zero_network_contract_only",
  image: {
    publicInputNormalized: true,
    negativePromptDisposition: "rejected",
    seedDisposition: "rejected",
    snapshotVersion: "image_generation_request_snapshot.v2",
    successHistoryReadbackIncludesIntegrityFields: true
  },
  ordinaryVideo: {
    snapshotVersion: "video_generation_request_snapshot.v1",
    snapshotIncludesPromptParametersAndReferenceRoles: true,
    providerPayloadHashPresent: true,
    historyReadbackIncludesRetryInputs: true,
    note: "Actual field dispatch still depends on the selected protocol adapter; lock the exact current model before the paid canary."
  },
  h3Video: {
    hostedWorkflowBodyFields: ["prompt", "duration_or_audio_duration", "resolution", "first_or_reference_images", "reference_audios"],
    sourceVideoRejected: true,
    unsupportedControls: {
      negativePrompt: h3GloballyGuarded && !h3ProviderBodyForwardsNegative ? "rejected_before_dispatch_when_not_declared" : "requires_review",
      generateAudio: h3GloballyGuarded && !h3ProviderBodyForwardsGenerateAudio ? "rejected_before_dispatch_when_not_declared" : "requires_review"
    },
    zeroNetworkRejectionCoverage: {
      hostedWorkflow: h3HostedNegativeRejectionCovered && h3HostedAudioToggleRejectionCovered,
      legacyHosted: h3LegacyNegativeRejectionCovered && h3LegacyAudioToggleRejectionCovered,
      selfhost: h3SelfhostNegativeRejectionCovered && h3SelfhostAudioToggleRejectionCovered,
      allCovered: h3ZeroNetworkRejectionCoverage
    },
    findings
  },
  semanticBoundary: "No source or request snapshot proves the generated pixels, motion, identity, negative constraints, or audio semantics.",
  providerRequests: 0,
  paidCalls: 0,
  databaseWrites: 0
}, null, 2)}\n`);
