import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { GET as getInspiration } from "../src/app/api/inspiration/route";
import { GET as getSiteConfig } from "../src/app/api/site-config/route";
import { PUBLIC_INSPIRATION_AUTHOR_NAME } from "../src/features/official-inspiration/inspiration-data";
import {
  HOMEPAGE_HERO_MP4,
  HOMEPAGE_HERO_POSTER,
  HOMEPAGE_HERO_WEBM,
} from "../src/lib/youcai-hero-assets";
import { getPublicInspirationCatalog, getPublicSiteConfig } from "../src/lib/youcai-public-catalog";

type AssetManifestEntry = {
  path: string;
  fileBytes?: number;
  sha256?: string;
};

const expectedCanvasIds = [
  "canvas-showcase-78f7a4a9ce11-paper-fox-adventure",
  "cmsyrsury01e3caezkqyg5l5l",
  "cmsyrvsqh01jgcaez3xadrsob",
  "cmt37buny005u85fyne9adfac",
];

function assertNoStore(response: Response) {
  assert.match(response.headers.get("cache-control") ?? "", /private/i);
  assert.match(response.headers.get("cache-control") ?? "", /no-store/i);
}

function assertLocalPath(value: string | undefined, label: string) {
  if (value === undefined) return;
  assert.ok(value.startsWith("/"), `${label} must start with /`);
  assert.ok(!value.startsWith("//"), `${label} must not be protocol-relative`);
  assert.ok(!/^https?:/i.test(value), `${label} must not be remote`);
  assert.ok(!value.includes(".."), `${label} must not traverse directories`);
}

function assertAssetExists(value: string | undefined, label: string) {
  if (value === undefined) return;
  assertLocalPath(value, label);
  const absolutePath = path.join(process.cwd(), "public", value.slice(1));
  assert.ok(existsSync(absolutePath), `${label} is missing: ${value}`);
}

function assertManifestAsset(entry: AssetManifestEntry | undefined, expectedPath: string) {
  assert.ok(entry, `assets manifest is missing ${expectedPath}`);
  assert.equal(entry.path, expectedPath);
  const absolutePath = path.join(process.cwd(), "public", expectedPath.slice(1));
  const content = readFileSync(absolutePath);
  assert.equal(entry.fileBytes, content.byteLength, `${expectedPath} fileBytes drifted`);
  assert.equal(
    entry.sha256,
    createHash("sha256").update(content).digest("hex").toUpperCase(),
    `${expectedPath} sha256 drifted`,
  );
}

function collectSitePaths(value: unknown, key = "root", result: Array<{ key: string; value: string }> = []) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectSitePaths(item, `${key}[${index}]`, result));
    return result;
  }
  if (!value || typeof value !== "object") return result;
  for (const [childKey, childValue] of Object.entries(value)) {
    const path = `${key}.${childKey}`;
    if (["url", "link", "poster", "coverImage"].includes(childKey) && typeof childValue === "string") {
      result.push({ key: path, value: childValue });
    }
    collectSitePaths(childValue, path, result);
  }
  return result;
}

async function main() {
  assert.equal(PUBLIC_INSPIRATION_AUTHOR_NAME, "漫剧工作台");
  const catalog = getPublicInspirationCatalog();
  assert.equal(catalog.length, 224);
  assert.equal(catalog.filter((item) => item.type === "image").length, 162);
  assert.equal(catalog.filter((item) => item.type === "video").length, 44);
  assert.equal(catalog.filter((item) => item.type === "audio").length, 18);
  assert.equal(new Set(catalog.map((item) => item.id)).size, 224);
  for (const item of catalog) {
    assertAssetExists(item.url, `catalog.${item.id}.url`);
    assertAssetExists(item.metadata.previewUrl, `catalog.${item.id}.previewUrl`);
    assertAssetExists(item.metadata.posterUrl ?? undefined, `catalog.${item.id}.posterUrl`);
    assert.deepEqual(item.author, { nickname: PUBLIC_INSPIRATION_AUTHOR_NAME, avatar: null });
    assert.equal(item.ownerId, "public-catalog");
    assert.equal(item.isFavorited, false);
    assert.equal(item.isDownloaded, false);
  }

  const inspirationResponse = await getInspiration(new Request("http://local.test/api/inspiration?page=1&limit=20"));
  assert.equal(inspirationResponse.status, 200);
  assertNoStore(inspirationResponse);
  const inspirationBody = await inspirationResponse.json();
  assert.equal(inspirationBody.success, true);
  assert.equal(inspirationBody.data.length, 20);
  assert.deepEqual(inspirationBody.pagination, { page: 1, limit: 20, total: 224, totalPages: 12 });

  const videoResponse = await getInspiration(new Request("http://local.test/api/inspiration?type=video&limit=100"));
  assert.equal(videoResponse.status, 200);
  const videoBody = await videoResponse.json();
  assert.equal(videoBody.pagination.total, 44);
  assert.ok(videoBody.data.every((item: { type: string }) => item.type === "video"));

  const styleResponse = await getInspiration(new Request("http://local.test/api/inspiration?category=style&limit=100"));
  assert.equal(styleResponse.status, 200);
  const styleBody = await styleResponse.json();
  assert.ok(styleBody.pagination.total >= 1);
  assert.ok(styleBody.data.every((item: { category: string }) => item.category === "style"));

  const invalidResponse = await getInspiration(new Request("http://local.test/api/inspiration?limit=0"));
  assert.equal(invalidResponse.status, 400);
  assertNoStore(invalidResponse);
  const invalidBody = await invalidResponse.json();
  assert.equal(invalidBody.success, false);
  assert.equal(invalidBody.error.code, "INVALID_PAGINATION");

  const siteConfig = getPublicSiteConfig();
  assert.deepEqual(siteConfig.canvasExamples.map((item) => item.canvasId), expectedCanvasIds);
  assert.equal(siteConfig.banners.canvas[0]?.type, "video");
  assert.equal(siteConfig.banners.canvas[0]?.url, "/youcai-media/v1/featured/canvas-banner-youcai.mp4");
  assert.equal(siteConfig.heroVideo.url, HOMEPAGE_HERO_MP4);
  assert.equal(siteConfig.heroVideo.poster, HOMEPAGE_HERO_POSTER);
  assert.equal(new Set(siteConfig.backgroundVideos.map((item) => item.url)).size, siteConfig.backgroundVideos.length);
  for (const entry of collectSitePaths(siteConfig)) {
    if (entry.key.endsWith(".link")) assertLocalPath(entry.value, entry.key);
    else assertAssetExists(entry.value, entry.key);
  }

  const siteConfigResponse = await getSiteConfig();
  assert.equal(siteConfigResponse.status, 200);
  assertNoStore(siteConfigResponse);
  const siteConfigBody = await siteConfigResponse.json();
  assert.equal(siteConfigBody.success, true);
  assert.equal(siteConfigBody.data.canvasExamples.length, 4);
  assert.deepEqual(siteConfigBody.data.canvasExamples.map((item: { canvasId: string }) => item.canvasId), expectedCanvasIds);

  const homeSource = readFileSync(
    path.join(process.cwd(), "src/features/official-home/official-home-page.tsx"),
    "utf8",
  );
  assert.match(homeSource, /HOMEPAGE_HERO_WEBM/);
  assert.match(homeSource, /HOMEPAGE_HERO_MP4/);
  assert.match(homeSource, /HOMEPAGE_HERO_POSTER/);
  assert.ok(
    !homeSource.includes("hero-pipeline-loop-v1"),
    "homepage must not fall back to the film-studio pipeline hero",
  );

  const assetsManifest = JSON.parse(
    readFileSync(path.join(process.cwd(), "public/short-drama/assets-manifest.json"), "utf8"),
  ) as { assets: AssetManifestEntry[] };
  for (const expectedPath of [HOMEPAGE_HERO_POSTER, HOMEPAGE_HERO_MP4, HOMEPAGE_HERO_WEBM]) {
    assertManifestAsset(assetsManifest.assets.find((entry) => entry.path === expectedPath), expectedPath);
  }

  const serialized = JSON.stringify({ inspirationBody, siteConfigBody });
  assert.ok(!serialized.includes("youcaiapp.oss"));
  assert.ok(!serialized.includes("雪风"));
  assert.ok(!/api[_-]?key|access[_-]?token|password|secret/i.test(serialized));

  console.log(JSON.stringify({
    ok: true,
    catalog: {
      total: catalog.length,
      image: catalog.filter((item) => item.type === "image").length,
      video: catalog.filter((item) => item.type === "video").length,
      audio: catalog.filter((item) => item.type === "audio").length,
    },
    siteConfig: {
      canvasExamples: siteConfig.canvasExamples.length,
      localPathCount: collectSitePaths(siteConfig).length,
      canvasBanner: siteConfig.banners.canvas[0]?.url,
      heroVideo: siteConfig.heroVideo.url,
    },
    requests: {
      model: 0,
      mediaGeneration: 0,
      paid: 0,
    },
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
