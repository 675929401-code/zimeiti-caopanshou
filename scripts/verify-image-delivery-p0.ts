import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const read = (relativePath: string) => fs.readFileSync(path.join(root, relativePath), "utf8");

const persistRoute = read("src/app/api/image-workbench/persist/route.ts");
const reuseStart = persistRoute.indexOf("if (reusableStorageKey && body?.transform !== \"first_storyboard_panel\")");
const reuseEnd = persistRoute.indexOf("stage = \"import_image\"", reuseStart);
assert.ok(reuseStart >= 0 && reuseEnd > reuseStart, "image-workbench reuse branch is missing");
const reuseBranch = persistRoute.slice(reuseStart, reuseEnd);
assert.match(reuseBranch, /\.eq\("user_id", payload\.userId\)/, "reuse must bind the current user");
assert.match(reuseBranch, /\.eq\("storage_key", reusableStorageKey\)/, "reuse must bind the storage key");
assert.match(reuseBranch, /\.eq\("storage_provider", VIDEO_READY_IMAGE_PROVIDER\)/, "reuse must bind the provider");
assert.match(reuseBranch, /\.eq\("file_category", "image"\)/, "reuse must bind the image category");
assert.match(reuseBranch, /reusableAssetId\s*\?\s*ownedAssetQuery\.eq\("id", reusableAssetId\)/, "reuse must prefer assetId plus storageKey");
assert.doesNotMatch(reuseBranch, /\.eq\("source", "image-workbench"\)/, "asset reuse must not reject generated source values");
assert.match(reuseBranch, /storageManager\.exists\(reusableStorageKey/, "reuse must verify the existing object");
assert.doesNotMatch(reuseBranch, /storageManager\.upload|safeFetch|uploadFromUrl/, "existing objects must not be downloaded or uploaded again");

const transformStart = persistRoute.indexOf("if (reusableStorageKey && body?.transform === \"first_storyboard_panel\")");
const transformEnd = persistRoute.indexOf("} else if (dataUrl)", transformStart);
assert.ok(transformStart >= 0 && transformEnd > transformStart, "storyboard transform ownership branch is missing");
const transformOwnership = persistRoute.slice(transformStart, transformEnd);
assert.match(transformOwnership, /\.eq\("user_id", payload\.userId\)/, "storyboard transform must bind the current user");
assert.match(transformOwnership, /\.eq\("storage_key", reusableStorageKey\)/, "storyboard transform must bind the storage key");
assert.match(transformOwnership, /\.eq\("storage_provider", VIDEO_READY_IMAGE_PROVIDER\)/, "storyboard transform must bind the provider");
assert.match(transformOwnership, /\.eq\("file_category", "image"\)/, "storyboard transform must bind the image category");
assert.match(transformOwnership, /reusableAssetId\s*\?\s*ownedFileQuery\.eq\("id", reusableAssetId\)/, "storyboard transform must prefer assetId when provided");
assert.doesNotMatch(transformOwnership, /\.eq\("source", "image-workbench"\)/, "storyboard transform must accept owned generated source values");

const imageWorkbench = read("src/components/image-workbench.tsx");
assert.match(imageWorkbench, /generatedStorageKey,\s*generatedAssetId,\s*\);/s, "ImageWorkbench must pass generated storageKey and assetId to persistence");
assert.match(imageWorkbench, /!generatedStorageKey \|\| !generatedAssetId \|\| !generatedOperationId/, "ImageWorkbench must fail closed before any duplicate transfer");
assert.match(imageWorkbench, /operationId\?: string;/, "ImageWorkbench must retain operationId");
assert.match(imageWorkbench, /billingReferenceId\?: string;/, "ImageWorkbench must retain billingReferenceId");
assert.match(imageWorkbench, /"completed"\s*\|\s*"provider_completed_pending_delivery"/, "status DTO must accept server terminal enums");
assert.match(imageWorkbench, /checkedJob\.result\?\.canRecover === true/, "unknown-job refresh must use canRecover");
assert.match(imageWorkbench, /if \(ambiguousTransport\)[\s\S]*?inspectImageAttempt/, "ambiguous recovery must query every model through the shared status contract");
assert.doesNotMatch(imageWorkbench, /STRICT_GPT_IMAGE_PUBLIC_ID|state === "provider_completed"/, "recovery must not use a single-model or stale-enum gate");
assert.match(imageWorkbench, /generatedOperationId \? `image:\$\{generatedOperationId\}`/, "billing reference must derive from operationId");

const productionService = read("src/lib/short-drama/production-service.ts");
assert.match(productionService, /assetId: String\(image\.assetId \|\| ""\)/, "Film Studio generation snapshot must retain source assetId");
assert.match(productionService, /operationId,\s*billingReferenceId,/s, "Film Studio snapshot must retain operation and billing reference");
assert.match(productionService, /storageKey: generatedImage\.storageKey,[\s\S]*?assetId: generatedImage\.assetId/s, "Film Studio persistence must send storageKey and assetId together");
assert.match(productionService, /ledgerReference: String\(generation\.billingReferenceId/, "Film Studio settlement must retain the image ledger reference");

const manualCanvas = read("src/components/manual-canvas.tsx");
const uploadStart = manualCanvas.indexOf("async function uploadAsset(");
const uploadEnd = manualCanvas.indexOf("function deleteNode(", uploadStart);
assert.ok(uploadStart >= 0 && uploadEnd > uploadStart, "Canvas upload handler is missing");
const uploadHandler = manualCanvas.slice(uploadStart, uploadEnd);
assert.match(uploadHandler, /fetch\("\/api\/storage\/upload"/, "ordinary Canvas media must use unified storage upload");
assert.doesNotMatch(uploadHandler, /\/api\/bridge\/upload/, "ordinary Canvas media must not invoke the retired paid bridge");
assert.match(uploadHandler, /file\.type\.startsWith\("video\/"\) \? "video" : "image"/, "Canvas upload must preserve image/video category");
assert.match(manualCanvas, /generatedStorageKey \? "\/api\/image-workbench\/persist" : "\/api\/bridge\/image\/persist"/, "generated permanent objects must use the reuse-aware persist route");
assert.match(manualCanvas, /storageKey: generatedStorageKey,[\s\S]*?assetId: generatedAssetId/s, "Canvas must propagate generated storageKey and assetId");
assert.match(manualCanvas, /returnedOperationId \? `image:\$\{returnedOperationId\}`/, "Canvas billing reference must derive from operationId");
assert.match(manualCanvas, /!canResumePersistence && \(!candidateAssetId \|\| !candidateStorageKey \|\| !returnedOperationId\)/, "new Canvas generations must fail closed without durable asset and billing identity");
assert.doesNotMatch(manualCanvas, /billingReferenceId\s*=\s*`image:\$\{returnedTraceId\}`/, "Canvas must not treat provider task or trace IDs as billing operation IDs");

const retiredBridge = read("src/app/api/bridge/upload/route.ts");
assert.match(retiredBridge, /CANVAS_UPLOAD_BRIDGE_RETIRED/, "legacy bridge must fail closed with a stable code");
assert.match(retiredBridge, /billed: false/, "legacy bridge must explicitly report that it did not bill");
assert.match(retiredBridge, /status: 410/, "legacy bridge must not silently proxy uploads");
assert.doesNotMatch(retiredBridge, /\/api\/image\/generate|getPlatformUrl|referenceImageUrls/, "legacy bridge must not call a paid image provider");

console.log(JSON.stringify({
  ok: true,
  checks: 42,
  networkRequests: 0,
  paidCalls: 0,
  contracts: [
    "owned generated asset reuse",
    "zero-cost ordinary Canvas upload",
    "server-enum recovery via canRecover",
    "asset and billing identity propagation",
  ],
}, null, 2));
