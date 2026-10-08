import "server-only";

import crypto from "node:crypto";
import sharp from "sharp";

const ALLOWED_WIDTHS = new Set([64, 128, 192, 256, 384, 512, 768, 1024]);
const MAX_CACHE_ENTRIES = 32;

interface CachedRendition {
  bytes: Buffer;
  sha256: string;
}

const renditionCache = new Map<string, CachedRendition>();

export function parseImageRenditionWidth(value: string | null): number | null {
  if (value === null || value === "") return null;
  const width = Number(value);
  if (!Number.isSafeInteger(width) || !ALLOWED_WIDTHS.has(width)) {
    throw new Error("IMAGE_RENDITION_WIDTH_INVALID");
  }
  return width;
}

export async function renderWebpRendition(
  source: Uint8Array,
  options: { cacheKey: string; width: number; lossless?: boolean },
): Promise<CachedRendition> {
  const encoding = options.lossless ? "webp-lossless" : "webp84";
  const cacheKey = `${options.cacheKey}:w${options.width}:${encoding}`;
  const cached = renditionCache.get(cacheKey);
  if (cached) return cached;

  const bytes = await sharp(source, { failOn: "warning" })
    .rotate()
    .resize({
      width: options.width,
      height: options.width,
      fit: "inside",
      withoutEnlargement: true,
    })
    .webp(options.lossless
      ? { lossless: true, effort: 5 }
      : { quality: 84, effort: 4, smartSubsample: true })
    .toBuffer();
  const result = {
    bytes,
    sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
  };

  renditionCache.set(cacheKey, result);
  while (renditionCache.size > MAX_CACHE_ENTRIES) {
    const oldest = renditionCache.keys().next().value;
    if (!oldest) break;
    renditionCache.delete(oldest);
  }
  return result;
}
