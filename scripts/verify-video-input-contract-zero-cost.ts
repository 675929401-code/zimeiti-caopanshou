import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { getVideoInputContract, validateVideoInputContract } from "../src/lib/video-input-contract";
import { getAiVideoPageInputCapabilities } from "../src/lib/ai-video-page-capabilities";

const image = "https://fixture.invalid/reference.png";
const audio = "https://fixture.invalid/voice.mp3";
let cases = 0;
function check(model: Record<string, unknown>, request: Parameters<typeof validateVideoInputContract>[1], expectedCode: string | null) {
  const contract = getVideoInputContract(model);
  assert.equal(validateVideoInputContract(contract, request)?.code || null, expectedCode);
  // The DTO fields produce the same controls and requirements as the server.
  const client = getAiVideoPageInputCapabilities({ capabilities: {
    supportsImageInput: model.supports_image_input === true,
    requiresImage: model.requires_image === true,
    workflowInputMode: contract.mode,
    supportsPrompt: contract.supportsPrompt,
    supportsSourceVideoInput: contract.supportsSourceVideoInput,
    requiresSourceVideo: contract.requiresSourceVideo,
    requiresFirstFrame: contract.requiresFirstFrame,
    requiresLastFrame: contract.requiresLastFrame,
    minReferenceImages: contract.minReferenceImages,
    maxReferenceImages: contract.maxReferenceImages,
    minReferenceAudios: contract.minReferenceAudios,
    maxReferenceAudios: contract.maxReferenceAudios,
    supportsAudioInput: contract.showAudioInputs,
  } });
  assert.deepEqual(client, contract);
  cases++;
}

const optionalImage = { supports_image_input: true, requires_image: false };
check(optionalImage, { prompt: "A moving cloud." }, null);
check(optionalImage, { prompt: "A moving cloud.", imageUrl: image }, null);
check(optionalImage, { prompt: "A moving cloud.", referenceImageUrls: [image, image] }, "VIDEO_REFERENCE_LIMIT_EXCEEDED");
check(optionalImage, { prompt: "" }, "VIDEO_PROMPT_REQUIRED");
check({ supports_image_input: false }, { prompt: "A moving cloud." }, null);
check({ supports_image_input: false }, { prompt: "A moving cloud.", imageUrl: image }, "VIDEO_REFERENCE_LIMIT_EXCEEDED");
const requiredImage = { supports_image_input: true, requires_image: true };
check(requiredImage, { prompt: "Animate this image." }, "VIDEO_REFERENCE_REQUIRED");
check(requiredImage, { prompt: "Animate this image.", referenceImageUrl: image }, null);
check(requiredImage, { prompt: "Animate this image.", referenceImageUrls: [image] }, null);
const frames = { supports_image_input: true, api_protocol_config: { workflow_input_mode: "first_last_frame" } };
check(frames, { prompt: "Smooth transition." }, "VIDEO_FIRST_FRAME_REQUIRED");
check(frames, { prompt: "Smooth transition.", imageUrl: image }, "VIDEO_LAST_FRAME_REQUIRED");
check(frames, { prompt: "Smooth transition.", imageUrl: image, lastFrameUrl: image }, null);
const multiImage = { supports_image_input: true, api_protocol_config: { workflow_input_mode: "multi_image", min_reference_images: 2, max_reference_images: 3 } };
check(multiImage, { prompt: "Combine these scenes.", referenceImageUrls: [image] }, "VIDEO_REFERENCE_REQUIRED");
check(multiImage, { prompt: "Combine these scenes.", referenceImageUrls: [image, image] }, null);
const speech = { supports_image_input: true, requires_image: true, api_protocol_config: { workflow_input_mode: "image_audio_lipsync", supports_prompt: false, supports_audio_input: true, min_reference_audios: 1, max_reference_audios: 1 } };
check(speech, { prompt: "", imageUrl: image }, "VIDEO_AUDIO_REQUIRED");
check(speech, { prompt: "", imageUrl: image, audioUrl: audio }, null);
check(speech, { imageUrl: image, referenceAudioUrls: [audio] }, null);
check(optionalImage, { prompt: "A moving cloud.", referenceAudioUrls: [audio] }, "VIDEO_AUDIO_LIMIT_EXCEEDED");
check({ api_protocol_config: { requires_source_video: true } }, { prompt: "Remove the background." }, "VIDEO_SOURCE_REQUIRED");
check({ api_protocol_config: { requires_source_video: true } }, { prompt: "Remove the background.", sourceVideoUrl: "https://fixture.invalid/source.mp4" }, null);
check({ api_protocol_config: { supports_source_video_input: true } }, { prompt: "Use an optional motion reference." }, null);
check({ api_protocol_config: { supports_source_video_input: true } }, { prompt: "Use an optional motion reference.", sourceVideoUrl: "https://fixture.invalid/source.mp4" }, null);
check({ supports_image_input: true, api_protocol_config: { reference_input_mode: "none", min_reference_images: 1 } }, { prompt: "Legacy pure text." }, null);
check({ supports_image_input: true, requires_image: true, api_protocol_config: { reference_input_mode: "none" } }, { prompt: "Required image remains required." }, "VIDEO_REFERENCE_REQUIRED");

const route = readFileSync(new URL("../src/app/api/video/generate/route.ts", import.meta.url), "utf8");
assert.doesNotMatch(route, /ImageGenerationClient|needsAutoRef|autoGenerateReference/u, "video submission must not implicitly create a billable image");
assert.ok(route.indexOf("const inputViolation = validateVideoInputContract") < route.indexOf("providerApiKey = resolveProviderSecret"));
assert.ok(route.indexOf("const reservation = await reserveVideoGenerationTask") < route.indexOf("result = await submitVideoTask"));
assert.match(route, /executionPrompt = inputContract\.supportsPrompt \?/u, "prompt-free workflows must not receive an invented prompt");
console.log(`[video-input-contract-zero-cost] PASS: ${cases} input/DTO parity cases, optional image vs required image, first/last frames, multi-image/audio, source video, prompt-free workflows, no implicit image generation, and reserve-before-video-submit. No network/database/wallet/provider calls.`);
