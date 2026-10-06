#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";

const args = new Set(process.argv.slice(2));
if (!args.has("--write")) {
  console.error("BLOCKED: thumbnail generation writes public assets; review the source manifest and pass --write.");
  process.exit(2);
}

const root = process.cwd();
const mediaRoot = path.join(root, "public", "youcai-media", "v1");
const sourceManifestPath = path.join(mediaRoot, "source-manifest.json");
const outputRoot = path.join(mediaRoot, "thumbnails");
const outputManifestPath = path.join(outputRoot, "manifest.json");

function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function writeJsonAtomic(filePath, value) {
  const temporaryPath = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(temporaryPath, filePath);
}

if (!fs.existsSync(sourceManifestPath)) {
  console.error(`Missing source manifest: ${sourceManifestPath}`);
  process.exit(1);
}

const sourceItems = JSON.parse(fs.readFileSync(sourceManifestPath, "utf8"));
const imageItems = sourceItems.filter((item) => item.type === "image");
fs.mkdirSync(outputRoot, { recursive: true });
for (const name of fs.readdirSync(outputRoot)) {
  // Only clean partial files created by this generator after an interrupted run.
  if (/^[a-z0-9]+\.webp\.tmp-\d+-\d+$/u.test(name)) {
    fs.rmSync(path.join(outputRoot, name));
  }
}

let previousById = new Map();
if (fs.existsSync(outputManifestPath)) {
  try {
    const previous = JSON.parse(fs.readFileSync(outputManifestPath, "utf8"));
    previousById = new Map((previous.items || []).map((item) => [item.id, item]));
  } catch {
    previousById = new Map();
  }
}

const results = new Array(imageItems.length);
let cursor = 0;
let generated = 0;
let reused = 0;

async function worker() {
  while (cursor < imageItems.length) {
    const index = cursor;
    cursor += 1;
    const item = imageItems[index];
    const sourcePath = path.join(mediaRoot, ...String(item.localPath).replace(/\\/gu, "/").split("/"));
    const sourcePublicPath = `public/youcai-media/v1/${String(item.localPath).replace(/\\/gu, "/")}`;
    const outputPath = path.join(outputRoot, `${item.id}.webp`);
    if (!fs.existsSync(sourcePath)) throw new Error(`Missing image source: ${item.localPath}`);
    const sourceSha256 = sha256File(sourcePath);
    const previous = previousById.get(item.id);
    if (
      previous?.sourceSha256 === sourceSha256
      && fs.existsSync(outputPath)
      && sha256File(outputPath) === previous.outputSha256
    ) {
      results[index] = { ...previous, sourcePath: sourcePublicPath };
      reused += 1;
      continue;
    }

    const temporaryPath = `${outputPath}.tmp-${process.pid}-${index}`;
    try {
      // Let Node write the output bytes. On Windows, libvips can reject a
      // Unicode destination path even though it can read the same source path.
      const { data, info } = await sharp(sourcePath)
        .rotate()
        .resize({ width: 720, height: 720, fit: "inside", withoutEnlargement: true })
        .webp({ quality: 78, effort: 4 })
        .toBuffer({ resolveWithObject: true });
      fs.writeFileSync(temporaryPath, data);
      if (!info.width || !info.height || info.format !== "webp") {
        throw new Error(`Invalid generated thumbnail metadata for ${item.id}`);
      }
      fs.renameSync(temporaryPath, outputPath);
      const stats = fs.statSync(outputPath);
      results[index] = {
        id: item.id,
        sourcePath: sourcePublicPath,
        sourceSha256,
        outputPath: `public/youcai-media/v1/thumbnails/${item.id}.webp`,
        outputSha256: sha256File(outputPath),
        bytes: stats.size,
        width: info.width,
        height: info.height,
      };
      generated += 1;
    } finally {
      if (fs.existsSync(temporaryPath)) fs.rmSync(temporaryPath);
    }
  }
}

try {
  await Promise.all(Array.from({ length: 4 }, () => worker()));
  const expectedNames = new Set(imageItems.map((item) => `${item.id}.webp`));
  const unexpected = fs.readdirSync(outputRoot)
    .filter((name) => name.endsWith(".webp") && !expectedNames.has(name));
  if (unexpected.length > 0) {
    throw new Error(`Refusing to hide stale thumbnails; remove through reviewed asset lifecycle: ${unexpected.join(", ")}`);
  }
  const digest = crypto.createHash("sha256")
    .update(results.map((item) => `${item.outputSha256}  ${item.outputPath}\n`).join(""))
    .digest("hex");
  writeJsonAtomic(outputManifestPath, {
    schemaVersion: 1,
    kind: "youcai-inspiration-thumbnails",
    sourceManifestSha256: sha256File(sourceManifestPath),
    count: results.length,
    digest,
    items: results,
  });
  console.log(`PASS thumbnails: ${results.length} total, ${generated} generated, ${reused} reused, sha256=${digest}`);
} catch (error) {
  console.error(`Thumbnail generation failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
