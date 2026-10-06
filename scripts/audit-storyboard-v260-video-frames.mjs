import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const require = createRequire(import.meta.url);
const ffmpeg = require("ffmpeg-static");
const reviewId = process.argv[2];
if (!reviewId) {
  console.error("Usage: node scripts/audit-storyboard-v260-video-frames.mjs <reviewId>");
  process.exit(1);
}

const tmpDir = path.resolve(".tmp-e2e", reviewId);
const publicDir = path.resolve("public", "storyboard-reviews");
const reviewFile = path.join(publicDir, `${reviewId}.json`);
const review = JSON.parse(await readFile(reviewFile, "utf8"));

await mkdir(tmpDir, { recursive: true });
await mkdir(publicDir, { recursive: true });

function inspectMedia(file) {
  const result = spawnSync(ffmpeg, ["-hide_banner", "-i", file], { encoding: "utf8" });
  const text = `${result.stdout || ""}\n${result.stderr || ""}`;
  const videoLine = text.split(/\r?\n/u).find((line) => /Video:/u.test(line)) || "";
  const audioLine = text.split(/\r?\n/u).find((line) => /Audio:/u.test(line)) || "";
  const durationMatch = text.match(/Duration:\s*([0-9:.]+)/u);
  return {
    duration: durationMatch?.[1] || null,
    hasAudio: Boolean(audioLine),
    videoLine: videoLine.trim(),
    audioLine: audioLine.trim(),
  };
}

function makeContactSheet(videoFile, outputFile) {
  const result = spawnSync(ffmpeg, [
    "-y",
    "-hide_banner",
    "-i",
    videoFile,
    "-vf",
    "fps=2,scale=480:-1,tile=5x4:margin=8:padding=4",
    "-frames:v",
    "1",
    outputFile,
  ], { encoding: "utf8" });
  if (result.status !== 0 || !existsSync(outputFile)) {
    throw new Error(`抽帧失败：${result.stderr || result.stdout}`);
  }
}

const mediaAudit = [];
for (const card of review.run.cards) {
  const order = card.order;
  const videoFile = path.join(tmpDir, `${reviewId}-segment-${order}.mp4`);
  const contactFileName = `${reviewId}-segment-${order}-contact.png`;
  const contactFile = path.join(tmpDir, contactFileName);
  const info = inspectMedia(videoFile);
  makeContactSheet(videoFile, contactFile);
  await writeFile(path.join(publicDir, contactFileName), await readFile(contactFile));
  card.contactSheetUrl = `/storyboard-reviews/${contactFileName}`;
  mediaAudit.push({
    order,
    label: card.label,
    videoFile,
    contactSheetFile: contactFile,
    contactSheetUrl: card.contactSheetUrl,
    ...info,
  });
}

review.mediaAudit = mediaAudit;
review.updatedAt = new Date().toISOString();
await writeFile(reviewFile, JSON.stringify(review, null, 2), "utf8");
await writeFile(path.join(tmpDir, `${reviewId}.json`), JSON.stringify(review, null, 2), "utf8");
console.log(JSON.stringify({ reviewId, mediaAudit }, null, 2));
