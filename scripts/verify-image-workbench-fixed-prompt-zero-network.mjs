#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  modelSupportsRequestedImageParameters,
  selectPublicImageModel,
} from "./verify-image-workbench-live-e2e.mjs";

const root = process.cwd();
const verifierPath = path.join(root, "scripts", "verify-image-workbench-live-e2e.mjs");
const source = fs.readFileSync(verifierPath, "utf8");

function runPlan(args) {
  const result = spawnSync(process.execPath, [verifierPath, ...args], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    timeout: 30_000,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

const smokeRunId = `image_smoke_plan_${process.pid}_${Date.now()}`;
const smokeEvidence = path.join(root, ".codex-evidence", "image-workbench-live-ui-only", smokeRunId);
assert.equal(fs.existsSync(smokeEvidence), false);
const smoke = runPlan([`--run-id=${smokeRunId}`]);
assert.equal(smoke.mode, "plan");
assert.equal(smoke.acceptanceProfile, "smoke");
assert.equal(smoke.networkCalls, 0);
assert.equal(smoke.databaseCalls, 0);
assert.equal(smoke.filesystemWrites, 0);
assert.equal(smoke.generationPosts, 0);
assert.equal(smoke.providerCalls, 0);
assert.equal(smoke.paidCalls, 0);
assert.equal(smoke.automaticRetries, 0);
assert.equal(smoke.requestedInputs.prompt, null);
assert.equal(smoke.requestedInputs.imageCount, 1);
assert.equal(smoke.modelSelection, "existing smoke selection behavior");
assert.equal(smoke.executeWillFailClosedBeforeBrowserClick, false);
assert.doesNotMatch(smoke.executeCommand, /--prompt=|--resolution=|--aspect-ratio=|--image-count=/u);
assert.equal(fs.existsSync(smokeEvidence), false, "SMOKE_PLAN_MUST_NOT_WRITE_EVIDENCE");

const exactPrompt = "同一位穿黄色雨衣的短发女孩站在雨夜公交站左侧，右手举透明雨伞，左手把红色纸飞机递给一只坐着的柯基；中景平视，蓝紫霓虹倒影，画面内不要文字、水印、额外人物或额外犬只。";
const fixedRunId = `image_fixed_plan_${process.pid}_${Date.now()}`;
const fixedEvidence = path.join(root, ".codex-evidence", "image-workbench-live-ui-only", fixedRunId);
assert.equal(fs.existsSync(fixedEvidence), false);
const fixed = runPlan([
  `--run-id=${fixedRunId}`,
  `--prompt=${exactPrompt}`,
  "--resolution=1K",
  "--aspect-ratio=16:9",
  "--image-count=1",
]);
assert.equal(fixed.mode, "plan");
assert.equal(fixed.acceptanceProfile, "fixed-prompt-adherence");
assert.deepEqual(fixed.requestedInputs, {
  prompt: exactPrompt,
  promptSha256: fixed.requestedInputs.promptSha256,
  resolution: "1K",
  aspectRatio: "16:9",
  imageCount: 1,
});
assert.match(fixed.requestedInputs.promptSha256, /^[a-f0-9]{64}$/u);
assert.equal(fixed.networkCalls, 0);
assert.equal(fixed.databaseCalls, 0);
assert.equal(fixed.filesystemWrites, 0);
assert.equal(fixed.generationPosts, 0);
assert.equal(fixed.providerCalls, 0);
assert.equal(fixed.paidCalls, 0);
assert.equal(fixed.providerEvidence.ready, false);
assert.deepEqual(fixed.providerEvidence.missing, ["ready1330ReceiptStore"]);
assert.equal(fixed.executeWillFailClosedBeforeBrowserClick, "unless fresh 1330 readiness succeeds");
for (const expected of ["--prompt=", "--resolution=1K", "--aspect-ratio=16:9", "--image-count=1"]) {
  assert.ok(fixed.executeCommand.includes(expected), `FIXED_EXECUTE_COMMAND_MISSING:${expected}`);
}
assert.equal(fs.existsSync(fixedEvidence), false, "FIXED_PLAN_MUST_NOT_WRITE_EVIDENCE");

const availableButWrong = {
  id: "pm_wrong",
  displayName: "Wrong Shape",
  available: true,
  priceReady: true,
  publicPrice: 0.2,
  resolutionPrices: { "1K": 0.2 },
  resolutionOptions: ["1K"],
  aspectRatios: ["1:1"],
};
const unavailableMatch = {
  id: "pm_unavailable",
  displayName: "Unavailable Match",
  available: false,
  priceReady: true,
  publicPrice: 0.1,
  resolutionPrices: { "1K": 0.1 },
  resolutionOptions: ["1K"],
  aspectRatios: ["16:9"],
};
const exactMatch = {
  id: "pm_exact",
  displayName: "Exact Match",
  available: true,
  priceReady: true,
  publicPrice: 0.3,
  resolutionPrices: { "1K": 0.3 },
  resolutionOptions: ["1K", "2K"],
  aspectRatios: ["16:9", "1:1"],
};
const fixedOptions = {
  acceptanceProfile: "fixed-prompt-adherence",
  resolution: "1K",
  aspectRatio: "16:9",
  modelId: "",
  modelName: "Nano Banana 2",
  modelNameExplicit: false,
};
assert.equal(modelSupportsRequestedImageParameters(availableButWrong, "1K", "16:9"), false);
assert.equal(modelSupportsRequestedImageParameters(unavailableMatch, "1K", "16:9"), false);
assert.equal(modelSupportsRequestedImageParameters(exactMatch, "1K", "16:9"), true);
assert.equal(
  selectPublicImageModel([availableButWrong, unavailableMatch, exactMatch], fixedOptions)?.id,
  exactMatch.id,
  "FIXED_PROFILE_MUST_DYNANICALLY_SKIP_INCOMPATIBLE_OR_UNAVAILABLE_MODELS",
);
assert.equal(selectPublicImageModel([availableButWrong], fixedOptions), null);
assert.equal(selectPublicImageModel([exactMatch], { ...fixedOptions, modelId: "pm_missing" }), null);

const smokeNamed = { ...availableButWrong, id: "pm_smoke", displayName: "Nano Banana 2" };
assert.equal(selectPublicImageModel([exactMatch, smokeNamed], {
  acceptanceProfile: "smoke",
  modelId: "",
  modelName: "Nano Banana 2",
})?.id, smokeNamed.id, "DEFAULT_SMOKE_MODEL_SELECTION_REGRESSED");

const providerGateIndex = source.indexOf("report.providerEvidence.ready");
const accountEvidenceIndex = source.indexOf("const before = await readAccountEvidence");
const browserIndex = source.indexOf("browser = await chromium.launch");
const clickIndex = source.indexOf("await generateButton.click()");
assert.ok(providerGateIndex > 0, "FIXED_PROVIDER_EVIDENCE_GATE_REQUIRED");
assert.ok(providerGateIndex < accountEvidenceIndex, "FIXED_PROVIDER_EVIDENCE_GATE_MUST_PRECEDE_ACCOUNT_READS");
assert.ok(providerGateIndex < browserIndex, "FIXED_PROVIDER_EVIDENCE_GATE_MUST_PRECEDE_BROWSER_CREATION");
assert.ok(providerGateIndex < clickIndex, "FIXED_PROVIDER_EVIDENCE_GATE_MUST_PRECEDE_GENERATION_CLICK");
assert.match(source, /generationPostLimit:\s*1/u);
assert.match(source, /automaticRetries:\s*0/u);

const partial = spawnSync(process.execPath, [verifierPath, "--run-id=partial_fixed", `--prompt=${exactPrompt}`], {
  cwd: root,
  encoding: "utf8",
  windowsHide: true,
  timeout: 30_000,
});
assert.notEqual(partial.status, 0, "PARTIAL_FIXED_INPUTS_MUST_FAIL_CLOSED");
assert.match(`${partial.stderr}\n${partial.stdout}`, /FIXED_PROMPT_REQUIRES_PROMPT_RESOLUTION_ASPECT_RATIO_AND_IMAGE_COUNT/u);

console.log(JSON.stringify({
  passed: true,
  mode: "zero-network-fixed-image-prompt-contract",
  networkCalls: 0,
  databaseCalls: 0,
  filesystemWrites: 0,
  assertions: {
    defaultSmokeBehaviorPreserved: true,
    fixedInputsExplicitAndExact: true,
    dynamicCapabilitySelection: true,
    actualProviderEvidenceRequiresFresh1330PreflightAndReadback: true,
    fixedExecuteFailsClosedUnless1330IsReady: true,
    browserGenerationPostLimit: 1,
    automaticRetries: 0,
  },
}, null, 2));
