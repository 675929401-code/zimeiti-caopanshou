import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  INSPIRATION_CATEGORY_OVERRIDES,
  OFFICIAL_INSPIRATION_ITEMS,
} from "../src/features/official-inspiration/inspiration-data";
import { summarizeMediaHistoryCount } from "../src/lib/media-history-count";

function source(relativePath: string) {
  return readFileSync(resolve(process.cwd(), relativePath), "utf8");
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(?:ts|tsx)$/.test(entry.name) ? [path] : [];
  });
}

const brand = source("src/lib/manju-workbench-brand.ts");
assert.match(brand, /MANJU_WORKBENCH_BRAND = "漫剧工作台"/);
assert.match(brand, /MANJU_WORKBENCH_TITLE_TEMPLATE/);

const layout = source("src/app/youcai/layout.tsx");
assert.match(layout, /applicationName: MANJU_WORKBENCH_BRAND/);
assert.match(layout, /template: MANJU_WORKBENCH_TITLE_TEMPLATE/);

const youcaiSources = sourceFiles(resolve(process.cwd(), "src/app/youcai"))
  .map((path) => readFileSync(path, "utf8"))
  .join("\n");
assert.doesNotMatch(
  youcaiSources,
  /YoucAI\.art|YouCai\.art|有彩世界|有彩视界|有彩创作/,
  "/youcai 浏览器 metadata 不得回流旧品牌",
);
assert.match(source("src/app/youcai/page.tsx"), /MANJU_WORKBENCH_DEFAULT_TITLE/);

const styleFixtureId = "cmp6xtyjr0007vhp4b1ksrui4";
assert.equal(INSPIRATION_CATEGORY_OVERRIDES[styleFixtureId], "风格");
const styleFixture = OFFICIAL_INSPIRATION_ITEMS.find((item) => item.id === styleFixtureId);
assert(styleFixture, "灵感广场缺少本地风格素材 fixture");
assert.equal(styleFixture.category, "风格");
assert.equal(styleFixture.mediaType, "视频");
assert.equal(styleFixture.availability, "ready");
assert.match(styleFixture.prompt, /10风格闪变/u, "风格素材必须由内容语义支撑，不能只改标签");
const styleMediaPath = styleFixture.mediaPath || "";
assert(styleMediaPath.startsWith("/youcai-media/v1/videos/"), "风格素材必须使用本站版本化媒体路径");
assert.ok(
  existsSync(resolve(process.cwd(), "public", styleMediaPath.slice(1))),
  `风格素材本地文件不存在: ${styleMediaPath}`,
);
assert.equal(
  OFFICIAL_INSPIRATION_ITEMS.filter((item) => item.sourceNote?.includes("youcai.art")).length,
  OFFICIAL_INSPIRATION_ITEMS.length,
  "版本化素材的来源说明必须完整保留",
);

assert.deepEqual(
  summarizeMediaHistoryCount({
    totalCount: 378,
    items: Array.from({ length: 20 }),
    pagination: { limit: 20, totalKnown: true },
  }),
  { count: 378, exact: true, windowLimit: 20 },
);
assert.deepEqual(
  summarizeMediaHistoryCount({
    totalCount: null,
    items: Array.from({ length: 20 }),
    pagination: { limit: 20, totalKnown: false },
  }),
  { count: 20, exact: false, windowLimit: 20 },
);
assert.deepEqual(
  summarizeMediaHistoryCount({ total: 7, pagination: { limit: 20, totalKnown: true } }),
  { count: 7, exact: true, windowLimit: 20 },
);

const mediaHistory = source("src/app/api/media-history/route.ts");
assert.match(mediaHistory, /searchParams\.get\("includeTotal"\)/);
assert.match(mediaHistory, /select\("id", \{ count: "exact", head: true \}\)/);
assert.match(mediaHistory, /countImageGalleryItems/);
assert.match(mediaHistory, /\.ilike\("content", "%image_gallery%"\)/);
assert.match(mediaHistory, /totalCountSource/);
assert.match(mediaHistory, /countFailures/);

const account = source("src/features/youcai-account/youcai-account-page.tsx");
assert.match(account, /\/api\/media-history\?limit=20&includeTotal=true/);
assert.match(account, /summarizeMediaHistoryCount/);
assert.match(account, /生成记录总数/);
assert.match(account, /最近生成记录/);
assert.match(account, /当前窗口最多/);
assert.doesNotMatch(account, /generatedCountIsLowerBound/);

const film = source("src/features/youcai-film-studio/youcai-film-studio-portal.tsx");
assert.match(film, /type ProjectKindFilter = "all" \| ProjectKind/);
for (const [value, label] of [
  ["爽剧", "爽剧"],
  ["通用短剧", "短剧"],
  ["正剧", "正剧"],
  ["导入项目", "导入项目"],
] as const) {
  assert.ok(
    film.includes(`<option value="${value}">${label}</option>`),
    `影视项目筛选缺少 ${label}`,
  );
}

console.log("PASS verify-youcai-metadata-count-filter");
console.log("- /youcai metadata uses one 漫剧工作台 title template and keeps source attribution notes");
console.log("- inspiration style filter has a real ready local fixture with content-backed classification");
console.log("- account uses exact API totals when available and an explicitly labelled recent-record window otherwise");
console.log("- film project filter covers 爽剧、短剧、正剧、导入项目");
