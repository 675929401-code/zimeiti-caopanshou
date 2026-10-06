#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, "..");
const publicRoot = path.join(projectRoot, "public");
const productRoot = path.join(publicRoot, "product-assets", "youcai-demo-v1");
const evidenceRoot = path.join(
  projectRoot,
  "evidence-archive",
  "storyboard",
  "2026-08-14",
  "three-directors-golden-v53",
  "covers",
);
const fixedTimestamp = "2026-08-28T00:00:00.000Z";

const sources = {
  graph: {
    path: path.join(publicRoot, "demo-assets", "clean-v21-images", "graph.json"),
    sha256: "76304f82e7f29cf164cfe8256adbb21739d3f49d9087546fa11d7b1fb156ad7b",
  },
  review: {
    path: path.join(publicRoot, "storyboard-reviews", "three-directors-golden-v53.json"),
    sha256: "f134fd5812a139aea769124efd187707456ed17c098c11b75845e546bf73b63f",
  },
  video: {
    path: path.join(publicRoot, "storyboard-reviews", "storyboard-v260-three-media-1786970156693-segment-1.mp4"),
    sha256: "d6524c289b2fdc2d6846e1234bbce1f30a250d17a05f7d3ef79fc70f74767cdd",
  },
  poster: {
    path: path.join(publicRoot, "storyboard-reviews", "storyboard-v260-three-media-1786970156693-segment-1.png"),
    sha256: "acfc55194b3c3d4056315962e23abab9f12805760f945e20d9b316c9f5f45599",
  },
};

const cleanImageNames = [
  "00-character-golden.png",
  "01-character-owner.png",
  "02-shot-01.png",
  "03-shot-02.png",
  "04-shot-03.png",
  "05-shot-04.png",
  "06-shot-05.png",
  "07-shot-06.png",
  "08-shot-07.png",
  "09-shot-08.png",
];

const modes = [
  {
    id: "exaggerated",
    label: "故事版导演｜高能夸张",
    fileName: "exaggerated.webp",
    alt: "高能夸张故事板封面，展示金毛等待主人回家的连续镜头",
  },
  {
    id: "cinematic",
    label: "故事版导演｜电影叙事",
    fileName: "cinematic.webp",
    alt: "影视叙事故事板封面，展示玄关空间内主人离开与金毛等待",
  },
  {
    id: "lyrical",
    label: "故事版导演｜抒情情感",
    fileName: "lyrical.webp",
    alt: "抒情情感故事板封面，展示金毛守着拖鞋等待主人回家",
  },
];

function fail(message) {
  throw new Error(message);
}

function sha256Buffer(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function sha256File(filePath) {
  return sha256Buffer(fs.readFileSync(filePath));
}

function assertSource(source, label) {
  if (!fs.existsSync(source.path)) fail(`missing ${label} source`);
  const actual = sha256File(source.path);
  if (actual !== source.sha256) {
    fail(`${label} source changed; expected ${source.sha256}, received ${actual}`);
  }
}

function writeImmutableBuffer(filePath, buffer) {
  const expected = sha256Buffer(buffer);
  if (fs.existsSync(filePath)) {
    const existing = sha256File(filePath);
    if (existing !== expected) {
      fail(`immutable curated asset already exists with different bytes: ${path.relative(projectRoot, filePath)}`);
    }
    return;
  }

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp-${process.pid}-${crypto.randomUUID()}`;
  let descriptor;
  try {
    descriptor = fs.openSync(temporaryPath, "wx", 0o644);
    fs.writeFileSync(descriptor, buffer);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporaryPath, filePath);
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    fs.rmSync(temporaryPath, { force: true });
    throw error;
  }
}

function writeImmutableJson(filePath, value) {
  writeImmutableBuffer(filePath, Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8"));
}

function copyImmutable(sourcePath, destinationPath) {
  writeImmutableBuffer(destinationPath, fs.readFileSync(sourcePath));
}

function publicUrl(filePath) {
  const relative = path.relative(publicRoot, filePath).split(path.sep).join("/");
  if (!relative || relative.startsWith("../")) fail("curated file escaped public root");
  return `/${relative}`;
}

function mimeFor(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".json") return "application/json";
  if (extension === ".mp4") return "video/mp4";
  if (extension === ".png") return "image/png";
  if (extension === ".webp") return "image/webp";
  return "application/octet-stream";
}

async function fileRecord(filePath) {
  const record = {
    path: publicUrl(filePath),
    bytes: fs.statSync(filePath).size,
    sha256: sha256File(filePath),
    mime: mimeFor(filePath),
  };
  if ([".png", ".webp"].includes(path.extname(filePath).toLowerCase())) {
    const metadata = await sharp(filePath).metadata();
    return { ...record, width: metadata.width, height: metadata.height };
  }
  return record;
}

function scrubEphemeralValues(value) {
  if (typeof value === "string") {
    return /https?:\/\/|\/api\/video\/proxy|q-sign-|127\.0\.0\.1/iu.test(value) ? "" : value;
  }
  if (Array.isArray(value)) return value.map((entry) => scrubEphemeralValues(entry));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, scrubEphemeralValues(entry)]),
  );
}

function curateEditableGraph() {
  const sourceGraph = JSON.parse(fs.readFileSync(sources.graph.path, "utf8"));
  const graph = scrubEphemeralValues(sourceGraph);
  const imageNodes = graph.nodes.filter((node) => node?.data?.kind === "image");
  if (graph.nodes.length !== 53 || graph.edges.length !== 74 || imageNodes.length !== cleanImageNames.length) {
    fail("clean-v21 graph topology no longer matches the reviewed 53-node/74-edge/10-image contract");
  }

  imageNodes.forEach((node, index) => {
    const imagePath = path.join(productRoot, "clean-v21", cleanImageNames[index]);
    node.data.outputUrl = publicUrl(imagePath);
    node.data.providerContentUrl = "";
    node.data.taskId = "";
    node.data.history = [];
    node.data.error = "";
    node.data.status = "succeeded";
  });
  for (const node of graph.nodes) {
    if (!node?.data) continue;
    if ("providerContentUrl" in node.data) node.data.providerContentUrl = "";
    if ("taskId" in node.data) node.data.taskId = "";
    if ("history" in node.data && node.data.kind !== "text") node.data.history = [];
    if ("error" in node.data) node.data.error = "";
  }

  graph.id = "youcai-clean-v21-product-demo-v1";
  graph.name = "产品演示 · 金毛等待主人 · 可编辑画布 v1";
  graph.updatedAt = fixedTimestamp;
  const outputPath = path.join(productRoot, "clean-v21", "graph.json");
  const serialized = JSON.stringify(graph);
  if (/https?:\/\/|\/api\/video\/proxy|q-sign-|127\.0\.0\.1/iu.test(serialized)) {
    fail("curated editable graph still contains an ephemeral URL marker");
  }
  writeImmutableJson(outputPath, graph);
  return outputPath;
}

async function createStoryboardPoster() {
  const outputPath = path.join(productRoot, "storyboard-v260", "poster.webp");
  const buffer = await sharp(sources.poster.path)
    .rotate()
    .resize({ width: 1280, height: 1280, fit: "inside", withoutEnlargement: true })
    .webp({ quality: 82, effort: 5 })
    .toBuffer();
  writeImmutableBuffer(outputPath, buffer);
  return outputPath;
}

function contentTypeExtension(contentType) {
  if (contentType.includes("png")) return ".png";
  if (contentType.includes("webp")) return ".webp";
  if (contentType.includes("gif")) return ".gif";
  return ".jpg";
}

async function downloadModeCovers(review) {
  const cards = review?.run?.cards;
  if (!Array.isArray(cards)) fail("v53 review does not contain cards");

  for (const mode of modes) {
    const card = cards.find((candidate) => candidate?.label === mode.label);
    if (!card || card.imageStatus !== "done" || typeof card.imageUrl !== "string") {
      fail(`v53 review is missing a completed cover for ${mode.id}`);
    }
    const url = new URL(card.imageUrl);
    if (url.protocol !== "https:" || url.hostname !== "ai-agent-main-storage-1434868362.cos.ap-guangzhou.myqcloud.com") {
      fail(`v53 cover host is not approved for ${mode.id}`);
    }

    const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(45_000) });
    if (!response.ok) fail(`v53 cover download failed for ${mode.id}: HTTP ${response.status}`);
    const contentType = (response.headers.get("content-type") || "").toLowerCase();
    if (!contentType.startsWith("image/")) fail(`v53 cover is not an image for ${mode.id}`);
    const declaredBytes = Number(response.headers.get("content-length") || 0);
    if (declaredBytes > 20 * 1024 * 1024) fail(`v53 cover is too large for ${mode.id}`);
    const original = Buffer.from(await response.arrayBuffer());
    if (!original.length || original.length > 20 * 1024 * 1024) fail(`v53 cover size is invalid for ${mode.id}`);

    writeImmutableBuffer(
      path.join(evidenceRoot, `${mode.id}${contentTypeExtension(contentType)}`),
      original,
    );
    const optimized = await sharp(original)
      .rotate()
      .resize({ width: 1600, height: 1000, fit: "inside", withoutEnlargement: true })
      .webp({ quality: 84, effort: 5 })
      .toBuffer();
    writeImmutableBuffer(path.join(productRoot, "storyboard-modes", mode.fileName), optimized);
  }
}

function verifyNoEphemeralMarkers(filePaths) {
  const forbidden = /https?:\/\/|\/api\/video\/proxy|q-sign-|127\.0\.0\.1/iu;
  for (const filePath of filePaths) {
    if (path.extname(filePath).toLowerCase() !== ".json") continue;
    const content = fs.readFileSync(filePath, "utf8");
    if (forbidden.test(content)) fail(`curated JSON contains an ephemeral marker: ${publicUrl(filePath)}`);
  }
}

async function main() {
  Object.entries(sources).forEach(([label, source]) => assertSource(source, label));

  const cleanSourceRoot = path.join(publicRoot, "demo-assets", "clean-v21-images");
  const cleanOutputRoot = path.join(productRoot, "clean-v21");
  for (const fileName of cleanImageNames) {
    copyImmutable(path.join(cleanSourceRoot, fileName), path.join(cleanOutputRoot, fileName));
  }
  const graphPath = curateEditableGraph();

  const videoPath = path.join(productRoot, "storyboard-v260", "video.mp4");
  copyImmutable(sources.video.path, videoPath);
  const posterPath = await createStoryboardPoster();

  const review = JSON.parse(fs.readFileSync(sources.review.path, "utf8"));
  const downloadRequested = process.argv.includes("--download-v53-covers");
  const confirmationIndex = process.argv.indexOf("--confirm");
  const confirmation = confirmationIndex >= 0 ? process.argv[confirmationIndex + 1] : "";
  if (downloadRequested) {
    if (confirmation !== "three-directors-golden-v53") {
      fail("cover localization requires --confirm three-directors-golden-v53");
    }
    await downloadModeCovers(review);
  }

  const modeCards = [];
  for (const mode of modes) {
    const imagePath = path.join(productRoot, "storyboard-modes", mode.fileName);
    if (!fs.existsSync(imagePath)) {
      fail(`missing localized mode cover ${mode.fileName}; run with --download-v53-covers and the exact confirmation`);
    }
    modeCards.push({
      id: mode.id,
      label: mode.label,
      imageStatus: "ready",
      imagePath: publicUrl(imagePath),
      alt: mode.alt,
      ...await fileRecord(imagePath),
    });
  }

  const modesManifestPath = path.join(productRoot, "storyboard-modes", "manifest.json");
  writeImmutableJson(modesManifestPath, {
    schemaVersion: 1,
    kind: "curated-storyboard-mode-covers",
    assetReleaseId: "youcai-demo-v1",
    sourceReviewId: "three-directors-golden-v53",
    sourceRecordSha256: sources.review.sha256,
    curatedAt: fixedTimestamp,
    cards: modeCards,
  });

  const inventoryPaths = [
    ...cleanImageNames.map((fileName) => path.join(cleanOutputRoot, fileName)),
    graphPath,
    videoPath,
    posterPath,
    ...modes.map((mode) => path.join(productRoot, "storyboard-modes", mode.fileName)),
    modesManifestPath,
  ];
  const productManifestPath = path.join(productRoot, "manifest.json");
  writeImmutableJson(productManifestPath, {
    schemaVersion: 1,
    kind: "curated-product-demo-assets",
    assetReleaseId: "youcai-demo-v1",
    immutable: true,
    mutableUploadsIncluded: false,
    evidenceIncluded: false,
    curatedAt: fixedTimestamp,
    files: await Promise.all(inventoryPaths.map((filePath) => fileRecord(filePath))),
  });

  verifyNoEphemeralMarkers([graphPath, modesManifestPath, productManifestPath]);
  console.log(JSON.stringify({
    ok: true,
    assetReleaseId: "youcai-demo-v1",
    productRoot: path.relative(projectRoot, productRoot),
    fileCount: inventoryPaths.length + 1,
    bytes: [...inventoryPaths, productManifestPath]
      .reduce((total, filePath) => total + fs.statSync(filePath).size, 0),
    localizedV53Covers: modes.length,
    sourceEvidenceMutated: false,
  }, null, 2));
}

await main();
