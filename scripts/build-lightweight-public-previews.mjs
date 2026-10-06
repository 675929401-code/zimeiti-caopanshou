import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..");

const jobs = [
  {
    source: "public/short-drama/hero-dream-floral-v2.png",
    target: "public/short-drama/previews/hero-dream-floral-v2.webp",
    width: 1280,
    quality: 72,
    role: "homepage hero poster preview",
  },
  {
    source: "public/short-drama/hero-pipeline-v1.png",
    target: "public/short-drama/previews/hero-pipeline-v1.webp",
    width: 960,
    quality: 72,
    role: "pipeline card and banner preview",
  },
  {
    source: "public/short-drama/inspiration-silent-pet-v1.png",
    target: "public/short-drama/previews/inspiration-silent-pet-v1.webp",
    width: 720,
    quality: 72,
    role: "silent pet card preview",
  },
  {
    source: "public/short-drama/inspiration-paper-fox-v1.png",
    target: "public/short-drama/previews/inspiration-paper-fox-v1.webp",
    width: 720,
    quality: 72,
    role: "paper fox card preview",
  },
  {
    source: "public/short-drama/inspiration-product-film-v1.png",
    target: "public/short-drama/previews/inspiration-product-film-v1.webp",
    width: 720,
    quality: 72,
    role: "product film card preview",
  },
  {
    source: "public/short-drama/inspiration-moon-observatory-v1.png",
    target: "public/short-drama/previews/inspiration-moon-observatory-v1.webp",
    width: 720,
    quality: 72,
    role: "moon observatory card preview",
  },
  {
    source: "public/short-drama/film-studio-promo-bg-v2.png",
    target: "public/short-drama/previews/film-studio-promo-bg-v2.webp",
    width: 960,
    quality: 72,
    role: "film studio promo preview",
  },
  {
    source: "public/short-drama/film-studio-promo-bg-v3.png",
    target: "public/short-drama/previews/film-studio-promo-bg-v3.webp",
    width: 960,
    quality: 72,
    role: "film studio promo v3 preview",
  },
  {
    source: "public/product-assets/youcai-demo-v1/clean-v21/03-shot-02.png",
    target: "public/product-assets/youcai-demo-v1/clean-v21/previews/03-shot-02.webp",
    width: 640,
    quality: 72,
    role: "music card preview",
  },
];

async function fileSize(relativePath) {
  const info = await stat(path.join(projectRoot, relativePath));
  return info.size;
}

async function main() {
  const manifest = [];
  for (const job of jobs) {
    const source = path.join(projectRoot, job.source);
    const target = path.join(projectRoot, job.target);
    await mkdir(path.dirname(target), { recursive: true });
    const originalBytes = await fileSize(job.source);
    await sharp(source)
      .rotate()
      .resize({ width: job.width, withoutEnlargement: true })
      .webp({ quality: job.quality, effort: 5 })
      .toFile(target);
    const previewBytes = await fileSize(job.target);
    manifest.push({
      source: `/${job.source.replace(/^public\//u, "").replace(/\\/gu, "/")}`,
      preview: `/${job.target.replace(/^public\//u, "").replace(/\\/gu, "/")}`,
      role: job.role,
      width: job.width,
      originalBytes,
      previewBytes,
      savedBytes: originalBytes - previewBytes,
    });
  }

  await writeFile(
    path.join(projectRoot, "public", "short-drama", "previews", "manifest.json"),
    `${JSON.stringify({ version: "public-preview-assets.v1", generatedAt: new Date().toISOString(), assets: manifest }, null, 2)}\n`,
    "utf8",
  );

  const totalOriginal = manifest.reduce((sum, item) => sum + item.originalBytes, 0);
  const totalPreview = manifest.reduce((sum, item) => sum + item.previewBytes, 0);
  console.log(JSON.stringify({
    ok: true,
    generated: manifest.length,
    totalOriginalKb: Math.round(totalOriginal / 1024),
    totalPreviewKb: Math.round(totalPreview / 1024),
    savedKb: Math.round((totalOriginal - totalPreview) / 1024),
    largest: manifest
      .slice()
      .sort((a, b) => b.savedBytes - a.savedBytes)
      .slice(0, 5)
      .map((item) => ({
        source: item.source,
        preview: item.preview,
        originalKb: Math.round(item.originalBytes / 1024),
        previewKb: Math.round(item.previewBytes / 1024),
      })),
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
