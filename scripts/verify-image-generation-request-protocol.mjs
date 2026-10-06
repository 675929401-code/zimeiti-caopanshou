#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  ImageGenerationInputError,
  normalizeImageGenerationInput,
  readImageGenerationInput,
} from "../src/lib/image-generation-request.ts";
import {
  ImageProviderBindingError,
  imageReferenceContractIssue,
  resolveImageProviderContract,
} from "../src/lib/image-provider-contract.ts";
import { buildSecureSkillImagePayload } from "../src/lib/secure-skill-image-adapter.ts";
import {
  buildSecureSkillAsyncImagePayload,
  parseSecureSkillAsyncImageTask,
} from "../src/lib/secure-skill-async-image-adapter.ts";

const valid = {
  prompt: "A product portrait",
  mode: "local",
  aspectRatio: "16:9",
  resolution: "2k",
  clientTraceId: "trace_fixture_01",
  clientIdempotencyKey: "image_fixture_01",
};

const normalized = normalizeImageGenerationInput({
  ...valid,
  referenceImageUrls: Array.from({ length: 8 }, (_, index) => `https://example.invalid/${index}.png`),
  imageUrl: "https://example.invalid/final.png",
});
assert.equal(normalized.referenceImageUrls.length, 9);
assert.equal(normalized.resolution, "2K");

for (const body of [
  { ...valid, referenceImageUrls: ["https://example.invalid/ok.png", 3] },
  { ...valid, referenceImageUrls: [" "] },
  { ...valid, referenceImageUrls: "https://example.invalid/not-an-array.png" },
  { ...valid, mode: "surprise" },
  { ...valid, style: "x".repeat(257) },
  { ...valid, prompt: "x".repeat(12_001) },
  { ...valid, referenceImageUrls: Array(10).fill("https://example.invalid/same.png") },
]) {
  assert.throws(() => normalizeImageGenerationInput(body), ImageGenerationInputError);
}

const oversizedByHeader = new Request("https://platform.invalid/api/image/generate", {
  method: "POST",
  headers: { "content-type": "application/json", "content-length": String(33 * 1024 * 1024) },
  body: JSON.stringify(valid),
});
await assert.rejects(() => readImageGenerationInput(oversizedByHeader), (error) =>
  error instanceof ImageGenerationInputError && error.status === 413 && error.code === "IMAGE_REQUEST_TOO_LARGE");

const chat = resolveImageProviderContract({
  provider: "secure_skill_chat",
  model_name: "gemini-3.1-flash-image",
  api_endpoint: "https://token.secure-skill.com/v1",
  supports_image_input: true,
  api_protocol_config: { protocol: "chat_completions", reference_transport: "chat_inline_data", max_reference_images: 8 },
});
assert.equal(chat.requestProtocol, "chat_completions");
assert.equal(chat.referenceTransport, "chat_inline_data");
assert.equal(imageReferenceContractIssue(chat, 8), null);

const configuredGoogleNative = resolveImageProviderContract({
  provider: "secure_skill_chat",
  model_name: "gemini-3.1-flash-image",
  api_endpoint: "https://token.secure-skill.com/v1",
  supports_image_input: true,
  api_protocol_config: { image_protocol: "google_generate_content" },
});
assert.deepEqual(configuredGoogleNative, {
  requestProtocol: "google_generate_content",
  referenceTransport: "chat_inline_data",
  source: "configured",
});

const highChannel = resolveImageProviderContract({
  provider: "secure_skill",
  api_endpoint: "https://token.secure-skill.com/v1",
  supports_image_input: true,
  api_protocol_config: { protocol: "images_generations", reference_transport: "generations_url_array" },
});
assert.equal(highChannel.referenceTransport, "generations_url_array");

const configuredSecureSkillImages = resolveImageProviderContract({
  provider: "openai_compat",
  api_endpoint: "https://token.secure-skill.com/v1",
  supports_image_input: true,
  api_protocol_config: { protocol: "secure_skill_images" },
});
assert.deepEqual(configuredSecureSkillImages, {
  requestProtocol: "images_generations",
  referenceTransport: "generations_url_array",
  source: "configured",
});
const configuredSecureSkillAsyncImages = resolveImageProviderContract({
  provider: "secure_skill_images",
  api_endpoint: "https://token.secure-skill.com/v1",
  supports_image_input: true,
  api_protocol_config: { protocol: "images_generations_async", reference_transport: "generations_url_array" },
});
assert.deepEqual(configuredSecureSkillAsyncImages, {
  requestProtocol: "images_generations_async",
  referenceTransport: "generations_url_array",
  source: "configured",
});
const asyncPayload = buildSecureSkillAsyncImagePayload({
  modelName: "nano-banana-2",
  prompt: "fixture",
  resolution: "2K",
  aspectRatio: "16:9",
  pixelSize: "2048x1152",
  referenceImageUrls: ["https://owned.invalid/reference.png"],
});
assert.equal(asyncPayload.model, "nano-banana-2");
assert.deepEqual(asyncPayload.image_urls, ["https://owned.invalid/reference.png"]);
assert.equal(Object.hasOwn(asyncPayload, "image"), false);
assert.deepEqual(parseSecureSkillAsyncImageTask({ generation_id: "task-1", status: "in_progress" }), {
  id: "task-1", status: "processing", imageUrl: "", error: "",
});
assert.equal(parseSecureSkillAsyncImageTask({ id: "task-1", status: "succeeded", data: [{ url: "https://cdn.invalid/result.png" }] }).imageUrl,
  "https://cdn.invalid/result.png");
for (const referenceImageUrls of [undefined, ["https://owned.invalid/reference.png"]]) {
  const payload = buildSecureSkillImagePayload({
    modelName: "gpt-image-2",
    prompt: "fixture",
    resolution: "2K",
    aspectRatio: "16:9",
    ...(referenceImageUrls ? { referenceImageUrls } : {}),
  });
  assert.equal(payload.image_size, "2K");
  assert.equal(payload.aspect_ratio, "16:9");
  assert.equal(Object.hasOwn(payload, "size"), false, "secure_skill_images must never receive OpenAI WxH size");
}

const relay = resolveImageProviderContract({
  provider: "lconai",
  api_endpoint: "https://n.lconai.com/v1",
  supports_image_input: true,
  api_protocol_config: { protocol: "images_generations", reference_transport: "generations_url_array" },
});
assert.equal(relay.requestProtocol, "images_generations");
assert.equal(relay.referenceTransport, "generations_url_array");

assert.throws(() => resolveImageProviderContract({
  provider: "secure_skill_chat",
  model_name: "gemini-3.1-flash-image",
  api_endpoint: "https://token.secure-skill.com/v1",
  supports_image_input: true,
}), ImageProviderBindingError, "provider/host/model inference must stay disabled");

const configuredMulti = resolveImageProviderContract({
  provider: "custom",
  api_endpoint: "https://provider.invalid/v1",
  supports_image_input: true,
  api_protocol_config: { protocol: "openai_images_edits", reference_transport: "edits_multipart_array" },
});
assert.equal(configuredMulti.source, "configured");
assert.equal(configuredMulti.referenceTransport, "edits_multipart_array");
assert.equal(imageReferenceContractIssue(configuredMulti, 7), null);

const configuredSingle = resolveImageProviderContract({
  provider: "custom",
  api_endpoint: "https://provider.invalid/v1",
  supports_image_input: true,
  api_protocol_config: { reference_transport: "edits_multipart_single" },
});
assert.equal(imageReferenceContractIssue(configuredSingle, 2)?.code, "IMAGE_REFERENCE_PROTOCOL_LIMIT_EXCEEDED");

const route = await readFile("src/app/api/image/generate/route.ts", "utf8");
assert.doesNotMatch(route, /referenceImageUrls[\s\S]{0,300}\.slice\(0,\s*9\)/u);
assert.match(route, /for \(const \[index, url\] of references\.entries\(\)\)/u);
assert.match(route, /providerContract\.referenceTransport === "edits_multipart_array" \? "image\[\]" : "image"/u);
assert.match(route, /protocolConfig: candidate\.api_protocol_config \|\| \{\}/u);
assert.match(route, /\/v1beta\/models\/\$\{encodeURIComponent\(model\.model_name\)\}:generateContent/u);
const googleApiKeyHeaderPattern = new RegExp(
  ['"x-goog-', 'api-key"', ': providerApiKey'].join(""),
  "u",
);
assert.match(route, googleApiKeyHeaderPattern);
assert.match(route, /responseModalities: \["TEXT", "IMAGE"\]/u);
assert.match(route, /part\.inlineData/u);
assert.match(route, /providerContract\.requestProtocol === "images_generations_async"/u);
assert.match(route, /buildSecureSkillAsyncImagePayload/u);
assert.match(route, /\/v1\/images\/generations\/\{id\}/u);

console.log(JSON.stringify({
  result: "PASS",
  cases: 26,
  providerRequests: 0,
  databaseWrites: 0,
  validatedChannels: ["secure_skill_google_native", "secure_skill_images", "secure_skill_high", "lconai", "configured_openai_edits"],
}));
