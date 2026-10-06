import { readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import sharp from "../node_modules/.pnpm/sharp@0.34.5/node_modules/sharp/lib/index.js";

const root = resolve(process.argv[2] || ".tmp-e2e/douyin-benchmark/top-ten");
const cellWidth = 384;
const cellHeight = 216;
const columns = 4;
const rows = 4;

function frameLabel(rank, index) {
  const text = `#${rank}  frame ${String(index + 1).padStart(2, "0")}`;
  return Buffer.from(`
    <svg width="${cellWidth}" height="${cellHeight}" xmlns="http://www.w3.org/2000/svg">
      <rect x="0" y="0" width="${cellWidth}" height="34" fill="rgba(5,8,18,0.76)"/>
      <text x="12" y="23" fill="#ffffff" font-size="17" font-family="Arial, sans-serif">${text}</text>
    </svg>
  `);
}

const manifest = [];
for (let rank = 1; rank <= 10; rank += 1) {
  const framesDir = resolve(root, `watch-${String(rank).padStart(2, "0")}-balanced`, "frames");
  const files = (await readdir(framesDir))
    .filter((name) => /^frame_.*\.jpg$/u.test(name))
    .sort()
    .slice(0, columns * rows);
  const tiles = await Promise.all(files.map(async (name, index) => {
    const input = resolve(framesDir, name);
    const buffer = await sharp(input)
      .resize(cellWidth, cellHeight, { fit: "cover" })
      .composite([{ input: frameLabel(rank, index), top: 0, left: 0 }])
      .jpeg({ quality: 88 })
      .toBuffer();
    return {
      input: buffer,
      left: (index % columns) * cellWidth,
      top: Math.floor(index / columns) * cellHeight,
    };
  }));
  const output = resolve(root, `contact-${String(rank).padStart(2, "0")}-watch.jpg`);
  await sharp({
    create: {
      width: cellWidth * columns,
      height: cellHeight * rows,
      channels: 3,
      background: "#090b14",
    },
  }).composite(tiles).jpeg({ quality: 90 }).toFile(output);
  manifest.push({ rank, frameCount: files.length, frames: files.map((name) => resolve(framesDir, name)), output });
}

await writeFile(resolve(root, "watch-contact-manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
console.log(JSON.stringify(manifest.map(({ rank, frameCount, output }) => ({ rank, frameCount, output })), null, 2));
