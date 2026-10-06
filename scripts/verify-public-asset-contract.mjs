#!/usr/bin/env node

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";

const root = process.cwd();
const baseUrlIndex = process.argv.indexOf("--base-url");
const baseUrl = baseUrlIndex >= 0 ? String(process.argv[baseUrlIndex + 1] || "").replace(/\/$/u, "") : "";
const mediaRoot = path.join(root, "public", "youcai-media", "v1");
const sourceManifestPath = path.join(mediaRoot, "source-manifest.json");
const thumbnailManifestPath = path.join(mediaRoot, "thumbnails", "manifest.json");
const compatibilityPath = path.join(root, "deploy", "manifests", "public-asset-compatibility.v1.json");
const releasePolicyPath = path.join(root, "deploy", "policies", "release-policy.json");

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function safeRelativePath(relativePath) {
  const normalized = String(relativePath).replace(/\\/gu, "/");
  assert.ok(normalized && !normalized.startsWith("/") && !normalized.includes(".."), `unsafe asset path: ${relativePath}`);
  return normalized;
}

function expectedImageContract(format) {
  if (format === "jpeg") return { mime: "image/jpeg", extensions: new Set([".jpg", ".jpeg"]) };
  if (format === "png") return { mime: "image/png", extensions: new Set([".png"]) };
  if (format === "webp") return { mime: "image/webp", extensions: new Set([".webp"]) };
  return { mime: `image/${format}`, extensions: new Set([`.${format}`]) };
}

const sourceManifest = readJson(sourceManifestPath);
assert.equal(sourceManifest.length, 224, "YouCai source manifest must contain the reviewed 224-item snapshot");
const releasePolicy = readJson(releasePolicyPath);
const publicAssetManifestPath = path.join(root, ...String(releasePolicy.assets.manifest).split("/"));
const publicAssetManifest = readJson(publicAssetManifestPath);
assert.equal(publicAssetManifest.kind, "public-assets");
assert.equal(publicAssetManifest.mutableUploadsIncluded, false);
assert.equal(publicAssetManifest.fileCount, publicAssetManifest.files.length);
const pinnedAssets = new Map();
for (const file of publicAssetManifest.files) {
  const manifestPath = safeRelativePath(file.path);
  assert.ok(!pinnedAssets.has(manifestPath), `duplicate pinned asset path: ${manifestPath}`);
  assert.match(file.sha256, /^[0-9a-f]{64}$/u, `invalid pinned asset hash: ${manifestPath}`);
  assert.ok(Number.isSafeInteger(file.bytes) && file.bytes >= 0, `invalid pinned asset size: ${manifestPath}`);
  pinnedAssets.set(manifestPath, file);
}

function pinnedAsset(manifestPath) {
  const normalized = safeRelativePath(manifestPath);
  const entry = pinnedAssets.get(normalized);
  assert.ok(entry, `asset is not pinned by the public manifest: ${normalized}`);
  return entry;
}

const sourceManifestEntry = pinnedAsset("public/youcai-media/v1/source-manifest.json");
assert.equal(sourceManifestEntry.bytes, fs.statSync(sourceManifestPath).size);
assert.equal(sourceManifestEntry.sha256, sha256File(sourceManifestPath), "public asset manifest does not bind the source manifest bytes");
const localSourceAssetCount = sourceManifest.filter((item) => {
  const localPath = safeRelativePath(item.localPath);
  return fs.existsSync(path.join(mediaRoot, ...localPath.split("/")));
}).length;
assert.ok(
  localSourceAssetCount === 0 || localSourceAssetCount === sourceManifest.length,
  `partial local YouCai asset tree is forbidden: ${localSourceAssetCount}/${sourceManifest.length}`,
);
const fullLocalMode = localSourceAssetCount === sourceManifest.length;
if (fullLocalMode) assert.ok(fs.existsSync(thumbnailManifestPath), "full local asset mode requires the thumbnail manifest");

const counts = { image: 0, video: 0, audio: 0 };
const runtimePaths = [];
for (const item of sourceManifest) {
  assert.ok(item.id && item.type && item.localPath, "source manifest item is incomplete");
  counts[item.type] += 1;
  const localPath = safeRelativePath(item.localPath);
  const filePath = path.join(mediaRoot, ...localPath.split("/"));
  const pinnedSource = pinnedAsset(`public/youcai-media/v1/${localPath}`);
  assert.equal(pinnedSource.bytes, Number(item.size), `pinned source asset byte mismatch: ${localPath}`);
  assert.ok(pinnedSource.bytes > 0, `pinned source asset is empty: ${localPath}`);
  runtimePaths.push(`/youcai-media/v1/${localPath}`);
  if (fullLocalMode) {
    const stats = fs.statSync(filePath);
    assert.equal(stats.size, Number(item.size), `source asset byte mismatch: ${localPath}`);
    assert.equal(sha256File(filePath), pinnedSource.sha256, `source asset hash mismatch: ${localPath}`);
  }
  if (item.type === "image" && fullLocalMode) {
    const metadata = await sharp(filePath).metadata();
    assert.ok(metadata.format && metadata.width && metadata.height, `image cannot be decoded: ${localPath}`);
    const expected = expectedImageContract(metadata.format);
    assert.equal(item.mimeType, expected.mime, `image MIME mismatch: ${localPath}`);
    assert.ok(expected.extensions.has(path.extname(localPath).toLowerCase()), `image extension mismatch: ${localPath}`);
  } else if (item.type === "image") {
    const extension = path.extname(localPath).toLowerCase();
    const expectedMime = new Map([[".jpg", "image/jpeg"], [".jpeg", "image/jpeg"], [".png", "image/png"], [".webp", "image/webp"]]).get(extension);
    assert.ok(expectedMime, `unsupported pinned image extension: ${localPath}`);
    assert.equal(item.mimeType, expectedMime, `pinned image MIME mismatch: ${localPath}`);
  }
  if (item.type === "video") {
    pinnedAsset(`public/youcai-media/v1/posters/${item.id}.jpg`);
    const posterPath = path.join(mediaRoot, "posters", `${item.id}.jpg`);
    if (fullLocalMode) {
      const posterMetadata = await sharp(posterPath).metadata();
      assert.equal(posterMetadata.format, "jpeg", `video poster is not JPEG: ${item.id}`);
    }
    runtimePaths.push(`/youcai-media/v1/posters/${item.id}.jpg`);
  }
}
assert.deepEqual(counts, { image: 162, video: 44, audio: 18 });

let thumbnailCount = 0;
if (fullLocalMode) {
  const thumbnailManifest = readJson(thumbnailManifestPath);
  assert.equal(thumbnailManifest.kind, "youcai-inspiration-thumbnails");
  assert.equal(thumbnailManifest.sourceManifestSha256, sha256File(sourceManifestPath), "thumbnail manifest does not bind the current source manifest");
  assert.equal(thumbnailManifest.count, 162);
  const sourceById = new Map(sourceManifest.map((item) => [item.id, item]));
  for (const thumbnail of thumbnailManifest.items) {
    const source = sourceById.get(thumbnail.id);
    assert.equal(source?.type, "image", `thumbnail has no source image: ${thumbnail.id}`);
    const expectedSourcePath = `public/youcai-media/v1/${safeRelativePath(source.localPath)}`;
    assert.equal(thumbnail.sourcePath, expectedSourcePath, `thumbnail source path drift: ${thumbnail.id}`);
    const sourcePath = path.join(root, ...thumbnail.sourcePath.split("/"));
    const outputPath = path.join(root, ...safeRelativePath(thumbnail.outputPath).split("/"));
    assert.equal(thumbnail.sourceSha256, sha256File(sourcePath), `thumbnail source hash mismatch: ${thumbnail.id}`);
    assert.equal(thumbnail.outputSha256, sha256File(outputPath), `thumbnail output hash mismatch: ${thumbnail.id}`);
    assert.equal(thumbnail.outputSha256, pinnedAsset(thumbnail.outputPath).sha256, `thumbnail is not pinned: ${thumbnail.id}`);
    const metadata = await sharp(outputPath).metadata();
    assert.equal(metadata.format, "webp", `thumbnail is not WebP: ${thumbnail.id}`);
    assert.ok((metadata.width || 0) <= 720 && (metadata.height || 0) <= 720, `thumbnail exceeds 720px: ${thumbnail.id}`);
    runtimePaths.push(`/youcai-media/v1/thumbnails/${thumbnail.id}.webp`);
  }
  thumbnailCount = thumbnailManifest.count;
} else {
  pinnedAsset("public/youcai-media/v1/thumbnails/manifest.json");
  const imageItems = sourceManifest.filter((item) => item.type === "image");
  assert.equal(imageItems.length, 162);
  for (const item of imageItems) {
    pinnedAsset(`public/youcai-media/v1/thumbnails/${item.id}.webp`);
    runtimePaths.push(`/youcai-media/v1/thumbnails/${item.id}.webp`);
  }
  thumbnailCount = imageItems.length;
}

const compatibility = readJson(compatibilityPath);
assert.equal(compatibility.kind, "public-asset-compatibility-aliases");
for (const alias of compatibility.aliases) {
  const legacyPinned = pinnedAsset(alias.legacyPath);
  const canonicalPinned = pinnedAsset(alias.canonicalPath);
  assert.equal(legacyPinned.sha256, canonicalPinned.sha256, `pinned compatibility alias bytes differ: ${alias.legacyPath}`);
  const legacyPath = path.join(root, ...safeRelativePath(alias.legacyPath).split("/"));
  const canonicalPath = path.join(root, ...safeRelativePath(alias.canonicalPath).split("/"));
  if (fullLocalMode) {
    assert.ok(fs.existsSync(legacyPath), `missing rollback compatibility alias: ${alias.legacyPath}`);
    assert.ok(fs.existsSync(canonicalPath), `missing canonical compatibility target: ${alias.canonicalPath}`);
    assert.equal(sha256File(legacyPath), sha256File(canonicalPath), `compatibility alias bytes differ: ${alias.legacyPath}`);
  }
}

if (baseUrl) {
  const uniquePaths = [...new Set(runtimePaths)];
  const failures = [];
  let cursor = 0;
  async function worker() {
    while (cursor < uniquePaths.length) {
      const publicPath = uniquePaths[cursor];
      cursor += 1;
      try {
        const response = await fetch(`${baseUrl}${publicPath}`, { signal: AbortSignal.timeout(30_000) });
        if (!response.ok) failures.push({ publicPath, status: response.status });
        else await response.arrayBuffer();
      } catch (error) {
        failures.push({ publicPath, error: error instanceof Error ? error.message : String(error) });
      }
    }
  }
  await Promise.all(Array.from({ length: 8 }, () => worker()));
  assert.deepEqual(failures, [], `runtime asset requests failed: ${JSON.stringify(failures.slice(0, 20))}`);
}

console.log(JSON.stringify({
  ok: true,
  sourceItems: sourceManifest.length,
  counts,
  thumbnails: thumbnailCount,
  compatibilityAliases: compatibility.aliases.length,
  verificationMode: fullLocalMode ? "full-local-sha256-and-decode" : "pinned-external-manifest",
  pinnedAssetDigest: publicAssetManifest.digest,
  diskContract: fullLocalMode ? "passed" : "not-evaluated-assets-external",
  activationReady: false,
  runtimeBaseUrl: baseUrl || null,
}, null, 2));
