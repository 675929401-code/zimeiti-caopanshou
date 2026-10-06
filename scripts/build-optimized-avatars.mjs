import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

const root = process.cwd();
const avatarDir = path.join(root, "public", "avatars");
const outputDir = path.join(avatarDir, "optimized");
const supported = /\.(?:png|jpe?g|webp)$/iu;

await fs.mkdir(outputDir, { recursive: true });

const entries = await fs.readdir(avatarDir, { withFileTypes: true });
const outputs = [];

for (const entry of entries) {
  if (!entry.isFile() || !supported.test(entry.name)) continue;
  const input = path.join(avatarDir, entry.name);
  const basename = entry.name.replace(/\.[^.]+$/u, "");
  const output = path.join(outputDir, `${basename}.webp`);
  const sourceStat = await fs.stat(input);
  await sharp(input, { failOn: "none" })
    .rotate()
    .resize(160, 160, {
      fit: "cover",
      position: "centre",
      withoutEnlargement: false,
    })
    .webp({ quality: 74, effort: 4 })
    .toFile(output);
  const targetStat = await fs.stat(output);
  outputs.push({
    source: path.relative(root, input).replace(/\\/gu, "/"),
    output: path.relative(root, output).replace(/\\/gu, "/"),
    sourceKb: Math.round(sourceStat.size / 1024),
    outputKb: Math.round(targetStat.size / 1024),
  });
}

const savedKb = outputs.reduce((sum, item) => sum + Math.max(0, item.sourceKb - item.outputKb), 0);
console.log(JSON.stringify({
  ok: true,
  generated: outputs.length,
  outputDir: path.relative(root, outputDir).replace(/\\/gu, "/"),
  savedKb,
  largestSavings: outputs
    .slice()
    .sort((left, right) => (right.sourceKb - right.outputKb) - (left.sourceKb - left.outputKb))
    .slice(0, 12),
}, null, 2));
