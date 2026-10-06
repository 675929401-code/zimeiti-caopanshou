import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyManjuCanvasOverrides,
  applyManjuInspirationOverrides,
  readManjuShowcaseCatalog,
} from "../src/lib/manju-showcase-runtime";
import {
  ManjuConfigPayloadError,
  validateManjuDomainContract,
  type ManjuConfigPayload,
  type ManjuJsonValue,
} from "../src/lib/server/manju-runtime-config";
import {
  getPublicInspirationCatalog,
  getPublicSiteConfig,
} from "../src/lib/youcai-public-catalog";

type JsonRecord = Record<string, unknown>;

interface SourceManifestItem {
  id: string;
  type: "image" | "video" | "audio";
  localPath: string;
  size: number;
}

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDirectory, "..");
const publicRoot = join(projectRoot, "public");
const manifestPath = join(publicRoot, "youcai-media", "v1", "source-manifest.json");
const componentPath = join(projectRoot, "src", "components", "admin", "ManjuShowcaseCatalogManager.tsx");
const assetRoutePath = join(projectRoot, "src", "app", "api", "admin", "manju-workbench", "assets", "route.ts");
const MAX_CONFIG_BYTES = 256 * 1024;

const failures: string[] = [];
const passes: string[] = [];

function check(condition: unknown, message: string): asserts condition {
  if (condition) passes.push(message);
  else failures.push(message);
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function safeSitePath(value: string): boolean {
  return value.startsWith("/")
    && !value.startsWith("//")
    && !value.includes("..")
    && !/^[a-z][a-z\d+.-]*:/iu.test(value);
}

function parseJsonFile(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

check(existsSync(componentPath), "结构化展示内容管理器文件存在");
check(existsSync(manifestPath), "公共素材事实清单存在");
check(existsSync(assetRoutePath), "后台素材上传登记路由存在");

const componentSource = existsSync(componentPath) ? readFileSync(componentPath, "utf8") : "";
const assetRouteSource = existsSync(assetRoutePath) ? readFileSync(assetRoutePath, "utf8") : "";
for (const endpoint of [
  "/api/inspiration",
  "/api/site-config",
  "/api/admin/manju-config",
]) {
  check(componentSource.includes(endpoint), `管理器读取 ${endpoint}`);
}
for (const contractKey of [
  "showcase_catalog",
  "v1",
  "inspiration",
  "overrides",
  "canvas_examples",
  "banners",
  "hero",
]) {
  check(componentSource.includes(contractKey), `管理器包含稳定契约字段 ${contractKey}`);
}
check(componentSource.includes("...basePayload"), "保存展示配置时保留原 media payload 字段");
check(componentSource.includes("...root"), "保存 v1 时保留 showcase_catalog 的其他版本字段");
check(componentSource.includes("TextEncoder"), "保存前执行完整 media payload 字节上限校验");
check(!componentSource.includes("FileReader"), "管理器不读取本地二进制文件");
check(componentSource.includes("new FormData()") && componentSource.includes("/api/admin/manju-workbench/assets"), "管理器支持管理员受控上传登记素材");
for (const token of [
  "requireAdmin",
  "request.formData()",
  "validateUploadBuffer",
  "safeUploadFileName",
  "storageManager.upload",
  "registerManjuPublicAsset",
  "resetPublicCatalogCache",
  "softDeleteManjuPublicAsset",
]) {
  check(assetRouteSource.includes(token), `后台素材路由包含 ${token}`);
}

for (const [relativePath, tokens, label] of [
  ["src/components/app-route-shell.tsx", ["domains.media", "readManjuShowcaseCatalog", "ManjuRuntimeContext.Provider"], "运行配置上下文读取已发布 media 域"],
  ["src/features/official-inspiration/official-inspiration-gallery.tsx", ["applyManjuInspirationOverrides", "configuredItems"], "灵感广场消费稀疏覆盖"],
  ["src/features/official-core-routes/official-canvas-route.tsx", ["applyManjuCanvasOverrides", "canvas:0"], "画布示例与横幅消费稀疏覆盖"],
  ["src/features/official-home/official-home-page.tsx", ["INSPIRATION_SPOTLIGHT_IDS", "showcaseCatalog?.hero"], "首页主视觉与精选素材消费发布配置"],
  ["src/features/official-tool-directory/official-tool-directory.tsx", ["banners.overrides", "bannerOverride"], "工具分类横幅消费发布配置"],
] as const) {
  const absolutePath = join(projectRoot, ...relativePath.split("/"));
  const text = existsSync(absolutePath) ? readFileSync(absolutePath, "utf8") : "";
  check(tokens.every((token) => text.includes(token)), label);
}

const runtimeFixture = readManjuShowcaseCatalog({
  showcase_catalog: {
    v1: {
      inspiration: { overrides: { a: { enabled: false }, b: { title: "新标题", sortOrder: 1 } } },
      canvas_examples: { order: ["canvas-b", "canvas-a"], overrides: { "canvas-a": { title: "新画布" } } },
      banners: { overrides: {} },
      hero: {},
    },
  },
});
check(Boolean(runtimeFixture), "前端运行时可解析 showcase_catalog.v1");
const inspirationFixture = applyManjuInspirationOverrides([
  { id: "a", title: "A", summary: "A", prompt: "A", category: "图片" },
  { id: "b", title: "B", summary: "B", prompt: "B", category: "图片" },
], runtimeFixture);
check(inspirationFixture.length === 1 && inspirationFixture[0]?.title === "新标题", "前端正确执行灵感启停、标题与排序覆盖");
const canvasFixture = applyManjuCanvasOverrides([
  { id: "canvas-a", title: "A", coverImage: "/a.png" },
  { id: "canvas-b", title: "B", coverImage: "/b.png" },
], runtimeFixture);
check(canvasFixture[0]?.id === "canvas-b" && canvasFixture[1]?.title === "新画布", "前端正确执行画布顺序与标题覆盖");

function contractPasses(domain: "content" | "media" | "feature_flags", payload: ManjuConfigPayload, version: string): boolean {
  try {
    validateManjuDomainContract(domain, payload, version);
    return true;
  } catch {
    return false;
  }
}

function contractFailsWith(
  domain: "content" | "media" | "feature_flags",
  payload: ManjuConfigPayload,
  version: string,
  expectedCode: string,
): boolean {
  try {
    validateManjuDomainContract(domain, payload, version);
    return false;
  } catch (error) {
    return error instanceof ManjuConfigPayloadError && error.code === expectedCode;
  }
}

const publicInspiration = getPublicInspirationCatalog();
const publicSiteConfig = getPublicSiteConfig();
const firstPublicAsset = publicInspiration[0];
const governedHeroFixture: ManjuJsonValue = firstPublicAsset
  ? { asset: { assetId: firstPublicAsset.id, path: firstPublicAsset.url } }
  : {};
const governedMediaFixture = {
  accepted_types: ["image", "video", "audio", "music"],
  showcase_catalog: {
    v1: {
      inspiration: { overrides: {} },
      canvas_examples: { overrides: {} },
      banners: { overrides: {} },
      hero: governedHeroFixture,
    },
  },
} satisfies ManjuConfigPayload;
check(contractPasses("media", governedMediaFixture, "1.1.0"), "服务端接受已登记素材的 media schema 1.1.0 配置");
check(
  contractPasses("media", { accepted_types: ["image"] }, "1.0.0"),
  "不可变 schema 1.0.0 仍可读取没有 showcase_catalog 的历史 media 修订",
);
check(
  contractFailsWith("media", { accepted_types: ["image"] }, "1.1.0", "SHOWCASE_CATALOG_REQUIRED"),
  "新 schema 1.1.0 拒绝缺失 showcase_catalog 的 media 发布",
);
const secondPublicAsset = publicInspiration[1];
if (firstPublicAsset && secondPublicAsset) {
  const mismatchedAsset = structuredClone(governedMediaFixture) as ManjuConfigPayload;
  const catalog = mismatchedAsset.showcase_catalog as JsonRecord;
  const v1 = catalog.v1 as JsonRecord;
  v1.hero = { asset: { assetId: firstPublicAsset.id, path: secondPublicAsset.url } };
  check(
    contractFailsWith("media", mismatchedAsset, "1.1.0", "SHOWCASE_ASSET_ID_PATH_MISMATCH"),
    "服务端拒绝 assetId 与 path 不匹配",
  );
}
const unknownCanvas = structuredClone(governedMediaFixture) as ManjuConfigPayload;
const unknownCatalog = unknownCanvas.showcase_catalog as JsonRecord;
const unknownV1 = unknownCatalog.v1 as JsonRecord;
unknownV1.canvas_examples = { overrides: { "unknown-canvas": { title: "不存在" } } };
check(
  contractFailsWith("media", unknownCanvas, "1.1.0", "SHOWCASE_CANVAS_ID_UNKNOWN"),
  "服务端拒绝未登记画布示例 ID",
);
check(
  contractPasses("content", {
    brand: "漫剧工作台",
    navigation: ["/youcai/inspiration", "/youcai/tools/canvas"],
    account_route: "/youcai/profile",
  }, "1.1.0"),
  "服务端接受受控 content 导航映射",
);
check(
  contractFailsWith("content", {
    brand: "漫剧工作台",
    navigation: ["/youcai/not-registered"],
    account_route: "/youcai/profile",
  }, "1.1.0", "CONTENT_NAVIGATION_INVALID"),
  "服务端拒绝未知前台导航映射",
);
check(
  contractPasses("feature_flags", {
    creative_agent: true,
    film_studio: true,
    canvas: true,
    inspiration: true,
    assets: true,
  }, "1.1.0"),
  "服务端接受显式公共功能开关",
);
check(
  publicSiteConfig.canvasExamples.length > 0,
  "服务端契约使用非空画布事实清单",
);

const manifestRaw = existsSync(manifestPath) ? parseJsonFile(manifestPath) : [];
check(Array.isArray(manifestRaw), "公共素材清单根节点是数组");
const manifest = Array.isArray(manifestRaw) ? manifestRaw as SourceManifestItem[] : [];
check(manifest.length === 224, "公共素材清单保持 224 项事实基线");
check(new Set(manifest.map((item) => item.id)).size === manifest.length, "公共素材 ID 唯一");
check(new Set(manifest.map((item) => item.localPath)).size === manifest.length, "公共素材 localPath 唯一");

const manifestById = new Map<string, SourceManifestItem>();
const knownPaths = new Set<string>();
let missingFiles = 0;
let sizeMismatches = 0;
for (const item of manifest) {
  if (!item || typeof item.id !== "string" || typeof item.localPath !== "string") {
    failures.push("公共素材清单包含无效条目");
    continue;
  }
  manifestById.set(item.id, item);
  const normalized = item.localPath.replace(/\\/gu, "/").replace(/^\/+/, "");
  const publicPath = `/youcai-media/v1/${normalized}`;
  knownPaths.add(publicPath);
  const diskPath = join(publicRoot, "youcai-media", "v1", ...normalized.split("/"));
  if (!existsSync(diskPath)) {
    missingFiles += 1;
    continue;
  }
  if (statSync(diskPath).size !== Number(item.size)) sizeMismatches += 1;
  if (item.type === "image") knownPaths.add(`/youcai-media/v1/thumbnails/${item.id}.webp`);
  if (item.type === "video") knownPaths.add(`/youcai-media/v1/posters/${item.id}.jpg`);
}
check(missingFiles === 0, "224 项主素材本地文件全部存在");
check(sizeMismatches === 0, "224 项主素材磁盘大小与清单一致");

for (const sourceRelativePath of [
  "src/lib/youcai-public-catalog.ts",
  "src/lib/youcai-hero-assets.ts",
  "src/features/official-inspiration/canvas-showcase-data.ts",
  "src/features/official-core-routes/official-canvas-route.tsx",
]) {
  const path = join(projectRoot, ...sourceRelativePath.split("/"));
  if (!existsSync(path)) continue;
  const source = readFileSync(path, "utf8");
  for (const match of source.matchAll(/["'`]((?:\/(?!\/)[^"'`\r\n]+?\.(?:png|jpe?g|webp|gif|avif|mp4|webm|mov|mp3|wav|m4a|aac|ogg)))["'`]/giu)) {
    if (safeSitePath(match[1])) knownPaths.add(match[1]);
  }
}

function validateAssetRef(value: unknown, path: string): void {
  if (!isRecord(value)) {
    failures.push(`${path} 必须是 { assetId?, path } 对象`);
    return;
  }
  const keys = Object.keys(value);
  if (keys.some((key) => key !== "assetId" && key !== "path")) failures.push(`${path} 包含未允许字段`);
  if (typeof value.path !== "string" || !safeSitePath(value.path) || !knownPaths.has(value.path)) {
    failures.push(`${path}.path 不是已登记本站素材路径`);
  }
  if (value.assetId !== undefined) {
    if (typeof value.assetId !== "string" || !manifestById.has(value.assetId)) {
      failures.push(`${path}.assetId 不存在于公共素材清单`);
    } else {
      const item = manifestById.get(value.assetId);
      const expectedPath = item ? `/youcai-media/v1/${item.localPath.replace(/\\/gu, "/").replace(/^\/+/, "")}` : "";
      if (value.path !== expectedPath) failures.push(`${path} 的 assetId 与 path 不匹配`);
    }
  }
}

function validateNoBinary(value: unknown, path = "showcase_catalog.v1"): void {
  if (typeof value === "string") {
    if (/^(?:data|blob):/iu.test(value.trim())) failures.push(`${path} 包含 data/blob 二进制或临时 URL`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => validateNoBinary(entry, `${path}[${index}]`));
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, entry] of Object.entries(value)) {
    if (/^(?:binary|base64|bytes|buffer|file|files)$/iu.test(key)) failures.push(`${path}.${key} 疑似二进制字段`);
    validateNoBinary(entry, `${path}.${key}`);
  }
}

function validateOptionalPayload(payloadFile: string): void {
  const absolutePath = isAbsolute(payloadFile) ? payloadFile : resolve(process.cwd(), payloadFile);
  check(existsSync(absolutePath), `待验配置文件存在：${absolutePath}`);
  if (!existsSync(absolutePath)) return;
  const raw = parseJsonFile(absolutePath);
  check(isRecord(raw), "待验配置根节点是 JSON 对象");
  if (!isRecord(raw)) return;
  const media = isRecord(raw.media) ? raw.media : raw;
  const showcase = isRecord(media.showcase_catalog) ? media.showcase_catalog : null;
  check(Boolean(showcase), "media payload 包含 showcase_catalog");
  if (!showcase) return;
  const v1 = isRecord(showcase.v1) ? showcase.v1 : null;
  check(Boolean(v1), "showcase_catalog 包含 v1");
  if (!v1) return;

  const allowedTopKeys = new Set(["inspiration", "canvas_examples", "banners", "hero"]);
  if (Object.keys(v1).some((key) => !allowedTopKeys.has(key))) failures.push("showcase_catalog.v1 包含未允许的顶层字段");
  validateNoBinary(v1);

  const inspiration = isRecord(v1.inspiration) ? v1.inspiration : null;
  check(Boolean(inspiration), "v1.inspiration 存在");
  if (inspiration) {
    if (Object.keys(inspiration).some((key) => key !== "overrides")) failures.push("v1.inspiration 只能保存 overrides，不能保存完整 items/catalog");
    const overrides = isRecord(inspiration.overrides) ? inspiration.overrides : {};
    for (const [id, override] of Object.entries(overrides)) {
      if (!manifestById.has(id)) failures.push(`inspiration.overrides.${id} 不存在于事实清单`);
      if (!isRecord(override)) {
        failures.push(`inspiration.overrides.${id} 必须是对象`);
        continue;
      }
      const allowed = new Set(["enabled", "title", "summary", "prompt", "category", "sortOrder"]);
      if (Object.keys(override).some((key) => !allowed.has(key))) failures.push(`inspiration.overrides.${id} 包含未允许字段`);
    }
  }

  const canvas = isRecord(v1.canvas_examples) ? v1.canvas_examples : null;
  check(Boolean(canvas), "v1.canvas_examples 存在");
  if (canvas) {
    if (Object.keys(canvas).some((key) => key !== "order" && key !== "overrides")) failures.push("v1.canvas_examples 包含未允许字段");
    if (canvas.order !== undefined && (!Array.isArray(canvas.order) || !canvas.order.every((id) => typeof id === "string") || new Set(canvas.order).size !== canvas.order.length)) {
      failures.push("v1.canvas_examples.order 必须是无重复字符串数组");
    }
    const overrides = isRecord(canvas.overrides) ? canvas.overrides : {};
    for (const [id, override] of Object.entries(overrides)) {
      if (!isRecord(override)) {
        failures.push(`canvas_examples.overrides.${id} 必须是对象`);
        continue;
      }
      const allowed = new Set(["enabled", "title", "tag", "cover"]);
      if (Object.keys(override).some((key) => !allowed.has(key))) failures.push(`canvas_examples.overrides.${id} 包含未允许字段`);
      if (override.cover !== undefined) validateAssetRef(override.cover, `canvas_examples.overrides.${id}.cover`);
    }
  }

  const banners = isRecord(v1.banners) ? v1.banners : null;
  check(Boolean(banners), "v1.banners 存在");
  if (banners) {
    if (Object.keys(banners).some((key) => key !== "overrides")) failures.push("v1.banners 只能保存 overrides");
    const overrides = isRecord(banners.overrides) ? banners.overrides : {};
    for (const [key, override] of Object.entries(overrides)) {
      if (!isRecord(override)) {
        failures.push(`banners.overrides.${key} 必须是对象`);
        continue;
      }
      const allowed = new Set(["enabled", "asset", "poster"]);
      if (Object.keys(override).some((field) => !allowed.has(field))) failures.push(`banners.overrides.${key} 包含未允许字段`);
      if (override.asset !== undefined) validateAssetRef(override.asset, `banners.overrides.${key}.asset`);
      if (override.poster !== undefined) validateAssetRef(override.poster, `banners.overrides.${key}.poster`);
    }
  }

  const hero = isRecord(v1.hero) ? v1.hero : null;
  check(Boolean(hero), "v1.hero 存在");
  if (hero) {
    const allowed = new Set(["enabled", "asset", "poster"]);
    if (Object.keys(hero).some((key) => !allowed.has(key))) failures.push("v1.hero 包含未允许字段");
    if (hero.asset !== undefined) validateAssetRef(hero.asset, "hero.asset");
    if (hero.poster !== undefined) validateAssetRef(hero.poster, "hero.poster");
  }

  const byteSize = Buffer.byteLength(JSON.stringify(media), "utf8");
  check(byteSize <= MAX_CONFIG_BYTES, `完整 media payload 不超过 ${MAX_CONFIG_BYTES} 字节（当前 ${byteSize}）`);
}

const payloadArgument = process.argv.slice(2).find((argument) => !argument.startsWith("-"));
if (payloadArgument) validateOptionalPayload(payloadArgument);

console.log("Manju showcase catalog verification");
for (const message of passes) console.log(`PASS ${message}`);
for (const message of failures) console.error(`FAIL ${message}`);
console.log(`SUMMARY ${passes.length} passed, ${failures.length} failed`);

if (failures.length > 0) process.exitCode = 1;
