import test from "node:test";
import assert from "node:assert/strict";
import type { VideoGenerateParams, VideoModelConfig } from "../src/lib/video-adapter";
import { gaoruiSeedanceNativeBody } from "../src/lib/gaorui-seedance-native-contract";
import {
  gaoruiCredentialBindingFingerprint,
  issueGaoruiTrustedPersonAsset,
  type GaoruiTrustedPersonAsset,
  type GaoruiTrustedPersonAssetData,
} from "../src/lib/gaorui-provider-asset-contract";

const SOURCE = "https://owned.cos.example/owned/person.png?q-signature=renewed";
const AUDIO = "https://owned.cos.example/owned/speech.wav?q-signature=audio";
const OWNER = "10000000-0000-4000-8000-000000000001";
const OWNED = "20000000-0000-4000-8000-000000000001";

function fixture() {
  const config: VideoModelConfig = {
    id: "offline-fast", name: "Offline Fast", model_name: "seedance-2.0-fast", provider: "gaorui", protocol_type: "gaorui_video",
    api_endpoint: "https://gaorui.cc/v1", api_key: "ram-fixture-credential", price_per_use: 0.5, duration_seconds: 4, supports_image_input: true,
  };
  const data: GaoruiTrustedPersonAssetData = {
    operationId: "30000000-0000-4000-8000-000000000001", userId: OWNER, ownedAssetId: OWNED,
    contentSha256: "a".repeat(64), modelId: config.id, modelName: "seedance-2.0-fast", endpointOrigin: "https://gaorui.cc",
    credentialBindingFingerprint: gaoruiCredentialBindingFingerprint({ secret: config.api_key, modelId: config.id, endpoint: config.api_endpoint }),
    sourceUrl: SOURCE, assetId: "asset_fixture", assetUrl: "asset://asset_fixture", type: "image", role: "reference_image", purpose: "person_reference",
  };
  const certificate = issueGaoruiTrustedPersonAsset(data);
  const params: VideoGenerateParams = {
    prompt: "Offline movement", duration: 4, aspectRatio: "9:16", resolutionTier: "720p", generateAudio: false,
    inputOwnerId: OWNER, gaoruiOwnedPersonAssetId: OWNED, gaoruiTrustedPersonAssets: [certificate],
    referenceImageUrl: SOURCE, audioUrl: AUDIO,
  };
  return { config, data, certificate, params };
}

test("issued full-scope certificate maps only its exact image and preserves reference audio", () => {
  const { config, params } = fixture();
  const before = JSON.stringify(params);
  const body = gaoruiSeedanceNativeBody(config, params);
  assert.deepEqual(body, { model: "seedance-2.0-fast", duration: 4, ratio: "9:16", resolution: "720p", generate_audio: false,
    content: [ { type: "text", text: "Offline movement" },
      { type: "image_url", image_url: { url: "asset://asset_fixture" }, role: "reference_image" },
      { type: "audio_url", audio_url: { url: AUDIO }, role: "reference_audio" } ] });
  assert.equal(JSON.stringify(params), before, "execution mapping must not mutate snapshots/params");
});

test("documented first-frame use maps one issued image without changing its role", () => {
  const { config, params } = fixture();
  const body = gaoruiSeedanceNativeBody(config, { ...params, imageUrl: SOURCE, referenceImageUrl: undefined, audioUrl: undefined });
  assert.deepEqual(body.content[1], { type: "image_url", image_url: { url: "asset://asset_fixture" }, role: "first_frame" });
});

test("public HTTPS validation runs before certificate mapping", () => {
  const { config, params, data } = fixture();
  for (const source of ["asset://asset_fixture", "http://owned.cos.example/person.png", "https://127.0.0.1/person.png", "https://localhost/person.png"]) {
    const certificate = issueGaoruiTrustedPersonAsset({ ...data, sourceUrl: source });
    assert.throws(() => gaoruiSeedanceNativeBody(config, { ...params, referenceImageUrl: source, gaoruiTrustedPersonAssets: [certificate] }), /GAORUI_SEEDANCE_MEDIA_URL_INVALID/u);
  }
  assert.throws(() => gaoruiSeedanceNativeBody(config, { ...params, imageUrl: SOURCE }), /GAORUI_SEEDANCE_INPUT_MODE_CONFLICT/u);
});

test("JSON and spread copies cannot recreate WeakSet authority", () => {
  const { config, params, certificate } = fixture();
  for (const forged of [JSON.parse(JSON.stringify(certificate)), { ...certificate }]) {
    assert.throws(() => gaoruiSeedanceNativeBody(config, { ...params, gaoruiTrustedPersonAssets: [forged] }), /GAORUI_PERSON_ASSET_UNTRUSTED/u);
  }
});

for (const [label, configPatch, paramsPatch] of [
  ["owner", {}, { inputOwnerId: "other-owner" }],
  ["owned asset", {}, { gaoruiOwnedPersonAssetId: "other-owned" }],
  ["missing owner", {}, { inputOwnerId: undefined }],
  ["missing owned asset", {}, { gaoruiOwnedPersonAssetId: undefined }],
  ["model id", { id: "other-model" }, {}],
  ["credential", { api_key: "other-ram-credential" }, {}],
  ["standard model", { model_name: "seedance-2.0" }, {}],
  ["other protocol", { protocol_type: "openapi_video" }, {}],
] as const) {
  test(`certificate rejects mismatched ${label}`, () => {
    const { config, params } = fixture();
    assert.throws(() => gaoruiSeedanceNativeBody({ ...config, ...configPatch }, { ...params, ...paramsPatch }), /GAORUI_PERSON_ASSET_SCOPE_MISMATCH/u);
  });
}

test("certificate rejects another provider origin", () => {
  const { config, params } = fixture();
  assert.throws(() => gaoruiSeedanceNativeBody({ ...config, api_endpoint: "https://another.example/v1" }, params), /GAORUI_ASSET_ENDPOINT_INVALID/u);
});

test("changed signature or unmatched source cannot reuse a valid certificate", () => {
  const { config, params } = fixture();
  assert.throws(() => gaoruiSeedanceNativeBody(config, { ...params, referenceImageUrl: SOURCE.replace("renewed", "previous") }), /GAORUI_PERSON_ASSET_SOURCE_MISMATCH/u);
  assert.throws(() => gaoruiSeedanceNativeBody(config, { ...params, referenceImageUrl: "https://other.example/person.png" }), /GAORUI_PERSON_ASSET_SOURCE_MISMATCH/u);
});

test("a certificate must match exactly one image and every certificate must be consumed", () => {
  const { config, params, certificate, data } = fixture();
  assert.throws(() => gaoruiSeedanceNativeBody(config, { ...params, imageUrls: [SOURCE] }), /GAORUI_PERSON_ASSET_SOURCE_MISMATCH/u);
  assert.throws(() => gaoruiSeedanceNativeBody(config, { ...params, gaoruiTrustedPersonAssets: [certificate, certificate] }), /GAORUI_PERSON_ASSET_SOURCE_MISMATCH/u);
  const unused = issueGaoruiTrustedPersonAsset({ ...data, sourceUrl: "https://owned.cos.example/unused.png" });
  assert.throws(() => gaoruiSeedanceNativeBody(config, { ...params, gaoruiTrustedPersonAssets: [certificate, unused] }), /GAORUI_PERSON_ASSET_SOURCE_MISMATCH/u);
});

test("last-frame, video and audio roles cannot consume a person image certificate", () => {
  const { config, params } = fixture();
  assert.throws(() => gaoruiSeedanceNativeBody(config, { ...params, imageUrl: "https://owned.cos.example/first.png", lastFrameUrl: SOURCE, referenceImageUrl: undefined, audioUrl: undefined }), /GAORUI_PERSON_ASSET_ROLE_UNSUPPORTED/u);
  assert.throws(() => gaoruiSeedanceNativeBody(config, { ...params, referenceImageUrl: undefined, sourceVideoUrl: SOURCE }), /GAORUI_PERSON_ASSET_SOURCE_MISMATCH/u);
  assert.throws(() => gaoruiSeedanceNativeBody(config, { ...params, referenceImageUrl: "https://owned.cos.example/other.png", audioUrl: SOURCE }), /GAORUI_PERSON_ASSET_SOURCE_MISMATCH/u);
});

test("unrelated image URLs remain HTTPS and ordinary requests retain their original body", () => {
  const { config, params } = fixture();
  const other = "https://owned.cos.example/unrelated.png";
  const body = gaoruiSeedanceNativeBody(config, { ...params, imageUrls: [other] });
  assert.deepEqual(body.content[2], { type: "image_url", image_url: { url: other }, role: "reference_image" });
  for (const model_name of ["seedance-2.0", "seedance-2.0-fast"] as const) {
    const publicBody = gaoruiSeedanceNativeBody({ ...config, model_name }, { ...params, gaoruiTrustedPersonAssets: undefined });
    assert.deepEqual(publicBody.content[1], { type: "image_url", image_url: { url: SOURCE }, role: "reference_image" });
  }
});

test("malformed certificate collections are rejected before a body can be returned", () => {
  const { config, params, certificate } = fixture();
  assert.throws(() => gaoruiSeedanceNativeBody(config, { ...params, gaoruiTrustedPersonAssets: {} as GaoruiTrustedPersonAsset[] }), /GAORUI_PERSON_ASSET_CERTIFICATES_INVALID/u);
  assert.throws(() => gaoruiSeedanceNativeBody(config, { ...params, gaoruiTrustedPersonAssets: Array.from({ length: 10 }, () => certificate) }), /GAORUI_PERSON_ASSET_CERTIFICATES_INVALID/u);
});
