import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  AUTODL_H3_SELFHOST_IMAGE_ENDPOINT,
  AUTODL_H3_SELFHOST_IMAGE_MODEL,
  AUTODL_H3_SELFHOST_PROVIDER,
  AUTODL_H3_SELFHOST_SECRET_REF,
  AUTODL_H3_SELFHOST_VIDEO_ENDPOINT,
  AUTODL_H3_SELFHOST_VIDEO_MODEL,
  assertAutodlH3SelfhostModelBinding,
  autodlH3SelfhostImageStoragePrefix,
  isOwnedAutodlH3SelfhostImageStorageKey,
} from "../src/lib/autodl-h3-selfhost";

function verifyExactModelBindings() {
  assert.equal(assertAutodlH3SelfhostModelBinding({
    kind: "image",
    provider: AUTODL_H3_SELFHOST_PROVIDER,
    modelName: AUTODL_H3_SELFHOST_IMAGE_MODEL,
    apiEndpoint: AUTODL_H3_SELFHOST_IMAGE_ENDPOINT,
    apiKey: AUTODL_H3_SELFHOST_SECRET_REF,
  }), true);
  assert.equal(assertAutodlH3SelfhostModelBinding({
    kind: "video",
    provider: AUTODL_H3_SELFHOST_PROVIDER,
    protocolType: AUTODL_H3_SELFHOST_PROVIDER,
    modelName: AUTODL_H3_SELFHOST_VIDEO_MODEL,
    apiEndpoint: AUTODL_H3_SELFHOST_VIDEO_ENDPOINT,
    apiKey: AUTODL_H3_SELFHOST_SECRET_REF,
  }), true);
  assert.equal(assertAutodlH3SelfhostModelBinding({
    kind: "image",
    provider: "legacy-provider",
    modelName: "legacy-image",
    apiEndpoint: "https://legacy.invalid/v1",
    apiKey: "secret://legacy",
  }), false, "legacy model bindings remain unchanged");

  assert.throws(() => assertAutodlH3SelfhostModelBinding({
    kind: "image",
    provider: "legacy-provider",
    modelName: AUTODL_H3_SELFHOST_IMAGE_MODEL,
    apiEndpoint: AUTODL_H3_SELFHOST_IMAGE_ENDPOINT,
    apiKey: AUTODL_H3_SELFHOST_SECRET_REF,
  }), /供应商与密钥引用必须成对/u);
  assert.throws(() => assertAutodlH3SelfhostModelBinding({
    kind: "image",
    provider: AUTODL_H3_SELFHOST_PROVIDER,
    modelName: "wrong-image-model",
    apiEndpoint: AUTODL_H3_SELFHOST_IMAGE_ENDPOINT,
    apiKey: AUTODL_H3_SELFHOST_SECRET_REF,
  }), /生图模型必须为系统固定值/u);
  assert.throws(() => assertAutodlH3SelfhostModelBinding({
    kind: "image",
    provider: AUTODL_H3_SELFHOST_PROVIDER,
    modelName: AUTODL_H3_SELFHOST_IMAGE_MODEL,
    apiEndpoint: "http://127.0.0.1:16011/v1/other",
    apiKey: AUTODL_H3_SELFHOST_SECRET_REF,
  }), /固定 \/v1 端点/u);
  assert.throws(() => assertAutodlH3SelfhostModelBinding({
    kind: "text",
    provider: "llm",
    modelName: "chat-model",
    apiEndpoint: "https://legacy.invalid/v1",
    apiKey: AUTODL_H3_SELFHOST_SECRET_REF,
  }), /只能绑定生图或视频模型/u);
}

function verifyUserScopedStorageKeys() {
  const userId = "user-fixture-a";
  const otherUserId = "user-fixture-b";
  const prefix = autodlH3SelfhostImageStoragePrefix(userId);
  assert.match(prefix, /^image-workbench\/autodl-h3-selfhost\/[a-f0-9]{24}\/$/u);
  assert.equal(prefix.includes(userId), false, "raw user id must not appear in the COS key");
  const key = `${prefix}2026/08/21/fixture_trace_0001.png`;
  assert.equal(isOwnedAutodlH3SelfhostImageStorageKey(key, userId), true);
  assert.equal(isOwnedAutodlH3SelfhostImageStorageKey(key, otherUserId), false);
  assert.equal(isOwnedAutodlH3SelfhostImageStorageKey(`${prefix}../other.png`, userId), false);
  assert.equal(isOwnedAutodlH3SelfhostImageStorageKey(`${prefix}2026/08/21/file.png?sig=raw`, userId), false);
}

function verifyRouteSourceGates() {
  const root = process.cwd();
  const adminSource = fs.readFileSync(path.join(root, "src/app/api/admin/models/route.ts"), "utf8");
  const generateSource = fs.readFileSync(path.join(root, "src/app/api/image/generate/route.ts"), "utf8");
  const persistSource = fs.readFileSync(path.join(root, "src/app/api/image-workbench/persist/route.ts"), "utf8");
  const workbenchSource = fs.readFileSync(path.join(root, "src/components/image-workbench.tsx"), "utf8");

  assert.match(adminSource, /assertAdminAutodlH3SelfhostBinding\("drawing"/u);
  assert.match(adminSource, /assertAdminAutodlH3SelfhostBinding\("text"/u);
  assert.match(adminSource, /assertAdminAutodlH3SelfhostBinding\("video"/u);

  const candidateStart = generateSource.indexOf("async function generateLocalImageCandidate");
  const bindingGate = generateSource.indexOf("assertAutodlH3SelfhostModelBinding({", candidateStart);
  const secretResolution = generateSource.indexOf("resolveProviderSecret(model.api_key)", candidateStart);
  const upstreamPost = generateSource.indexOf("fetchImageUpstream(apiUrl", candidateStart);
  assert.ok(candidateStart >= 0 && bindingGate > candidateStart);
  assert.ok(secretResolution > bindingGate, "H3 binding must fail before secret resolution");
  assert.ok(upstreamPost > secretResolution, "H3 binding must fail before the upstream POST");
  assert.match(generateSource, /autodlH3SelfhostImageStoragePrefix\(options\.userId\)/u);
  assert.match(generateSource, /autodlH3StoredObjectKey \? \{ storageKey: autodlH3StoredObjectKey \} : \{\}/u);
  assert.match(generateSource, /clientIdempotencyKey\?: string/u);
  assert.match(generateSource, /update\(`\$\{userId\}:\$\{requestedIdempotencyKey\}`\)/u);
  assert.match(generateSource, /idempotencyKey: `image-\$\{h3OperationId\}`/u);
  assert.match(generateSource, /const billingReferenceId = `image:\$\{h3OperationId\}`/u);
  assert.match(generateSource, /finalizeImageExactlyOnceDelivery\([\s\S]*billingReferenceId: `image:\$\{h3OperationId\}`/u);

  const reuseGate = persistSource.indexOf('if (reusableStorageKey && body?.transform !== "first_storyboard_panel")');
  const remoteImport = persistSource.indexOf("safeFetch(sourceUrl!");
  assert.ok(reuseGate >= 0 && remoteImport > reuseGate, "H3 COS reuse must bypass remote download/upload");
  assert.match(persistSource, /from\("user_files"\)[\s\S]*\.eq\("user_id", payload\.userId\)[\s\S]*\.eq\("storage_key", reusableStorageKey\)[\s\S]*\.eq\("storage_provider", VIDEO_READY_IMAGE_PROVIDER\)[\s\S]*\.eq\("file_category", "image"\)/u);
  assert.match(persistSource, /reusableAssetId \? ownedAssetQuery\.eq\("id", reusableAssetId\) : ownedAssetQuery/u);
  assert.match(persistSource, /storageManager\.exists\(reusableStorageKey, VIDEO_READY_IMAGE_PROVIDER\)/u);
  assert.match(persistSource, /reused: true/u);

  assert.match(workbenchSource, /images\?: Array<\{ url\?: string; storageKey\?: string; assetId\?: string \}>/u);
  assert.match(workbenchSource, /persistGeneratedImage\([\s\S]*generationTraceId,[\s\S]*generatedStorageKey,[\s\S]*generatedAssetId/u);
  assert.match(workbenchSource, /!generatedUrl \|\| !generatedStorageKey \|\| !generatedAssetId \|\| !generatedOperationId/u);
  assert.match(workbenchSource, /!data\.url \|\| !data\.key \|\| !data\.assetId \|\| !data\.historyRecordId/u);
  assert.match(workbenchSource, /generationInFlightRef\.current/u);
  assert.match(workbenchSource, /clientIdempotencyKey: generationKey/u);
  assert.match(workbenchSource, /job\.generationFingerprint === generationFingerprint/u);
}

function main() {
  verifyExactModelBindings();
  verifyUserScopedStorageKeys();
  verifyRouteSourceGates();
  console.log("AutoDL H3 image P0 verification passed (static/pure only; zero network, zero generation, zero DB writes).\n");
}

main();
