import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  INSPIRATION_CATEGORY_FILTERS,
  INSPIRATION_MEDIA_FILTERS,
  OFFICIAL_INSPIRATION_ITEMS,
  getInspirationSourceNote,
} from "../src/features/official-inspiration/inspiration-data";
import {
  INSPIRATION_CANVAS_HANDOFF_KEY,
  parseInspirationCanvasReference,
  saveInspirationCanvasReference,
  type CanvasHandoffStorage,
} from "../src/features/official-inspiration/canvas-handoff";
import { toAppScopedHref } from "../src/lib/youcai-routes";

class MemoryStorage implements CanvasHandoffStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

const root = process.cwd();
const gallerySource = readFileSync(
  path.join(root, "src/features/official-inspiration/official-inspiration-gallery.tsx"),
  "utf8",
);
const manifestPath = path.join(root, "public/short-drama/inspiration-media/v1/source-manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
  items: Array<{ localPath: string; sourceUrl: string; type: string; category: string }>;
};

assert.deepEqual(INSPIRATION_MEDIA_FILTERS, ["全部", "图片", "视频", "音频", "音乐"]);
assert.deepEqual(INSPIRATION_CATEGORY_FILTERS, [
  "全部分类", "角色", "场景", "道具", "风格", "分镜", "成片",
  "音乐", "语音", "音频", "音效", "图片", "视频", "其他",
]);

const counts = Object.fromEntries(
  ["图片", "音频", "视频"].map((type) => [
    type,
    OFFICIAL_INSPIRATION_ITEMS.filter((item) => item.mediaType === type).length,
  ]),
);
assert.ok(counts["图片"] >= 20, "图片卡数量不足");
assert.ok(counts["音频"] >= 10, "音频卡数量不足");
assert.ok(counts["视频"] >= 8, "视频卡数量不足");
const musicCount = OFFICIAL_INSPIRATION_ITEMS.filter(
  (item) => item.mediaType === "音频" && item.category === "音乐",
).length;
assert.ok(musicCount > 0, "音乐筛选必须命中真实音频素材，不能是空按钮");

const categoriesWithContent = INSPIRATION_CATEGORY_FILTERS.slice(1).filter((category) => (
  OFFICIAL_INSPIRATION_ITEMS.some((item) => item.category === category)
));
const categoriesWithoutContent = INSPIRATION_CATEGORY_FILTERS.slice(1).filter((category) => (
  !categoriesWithContent.includes(category)
));
assert.deepEqual(
  categoriesWithoutContent,
  ["音效", "其他"],
  "本地 224 条真实素材快照目前只有音效与其他无内容；页面必须隐藏空分类，不能伪造占位素材",
);
assert.match(gallerySource, /function getVisibleCategories\(\s*media: MediaFilter,\s*items: readonly OfficialInspirationItem\[\]/u);
assert.match(gallerySource, /items\.some\(\(entry\) =>/u);
assert.match(gallerySource, /visibleCategories\.map\(\(item\) =>/u);

const readyAudio = OFFICIAL_INSPIRATION_ITEMS.filter(
  (item) => item.mediaType === "音频" && item.availability !== "planned" && item.mediaPath,
);
const readyVideo = OFFICIAL_INSPIRATION_ITEMS.filter(
  (item) => item.mediaType === "视频" && item.availability !== "planned" && item.mediaPath,
);
assert.ok(readyAudio.length >= 3, "至少需要 3 条可播放音频");
assert.ok(readyVideo.length >= 8, "至少需要 8 条可播放视频");

const readyImages = OFFICIAL_INSPIRATION_ITEMS.filter(
  (item) => item.mediaType === "图片" && item.availability !== "planned" && item.mediaPath,
);
assert.equal(readyImages.length, counts["图片"], "图片卡必须全部绑定本地原图");

for (const item of OFFICIAL_INSPIRATION_ITEMS) {
  assert.ok(item.mediaPath?.startsWith("/"), `媒体不是本地路径: ${item.id}`);
  assert.ok(existsSync(path.join(root, "public", item.mediaPath!.slice(1))), `媒体文件缺失: ${item.mediaPath}`);
  assert.ok(item.previewPath.startsWith("/"), `预览不是本地路径: ${item.id}`);
  assert.ok(existsSync(path.join(root, "public", item.previewPath.slice(1))), `预览文件缺失: ${item.previewPath}`);
  if (item.mediaType === "图片") {
    assert.equal(item.previewPath, `/youcai-media/v1/thumbnails/${item.id}.webp`);
    const previewHeader = readFileSync(path.join(root, "public", item.previewPath.slice(1))).subarray(0, 12);
    assert.equal(previewHeader.subarray(0, 4).toString("ascii"), "RIFF", `缩略图 RIFF 头无效: ${item.id}`);
    assert.equal(previewHeader.subarray(8, 12).toString("ascii"), "WEBP", `缩略图 WEBP 头无效: ${item.id}`);
  }
}

const itemWithBothNotes = OFFICIAL_INSPIRATION_ITEMS.find(
  (item) => Boolean(item.sourceNote?.trim()) && Boolean(item.availabilityNote?.trim()),
);
assert(itemWithBothNotes, "至少需要一条同时具有来源和可用状态的素材");
assert.equal(
  getInspirationSourceNote(itemWithBothNotes),
  `${itemWithBothNotes.sourceNote} · ${itemWithBothNotes.availabilityNote}`,
  "详情必须完整显示每条真实 sourceNote 与 availabilityNote",
);

const handoffFixtures = [
  OFFICIAL_INSPIRATION_ITEMS.find((item) => item.mediaType === "图片"),
  readyAudio[0],
  readyVideo[0],
];
const expectedMediaTypes = ["image", "audio", "video"] as const;
handoffFixtures.forEach((item, index) => {
  assert(item, `缺少 handoff 素材类型: ${expectedMediaTypes[index]}`);
  const storage = new MemoryStorage();
  assert.equal(saveInspirationCanvasReference(item, storage), true, `${item.id} handoff 写入失败`);
  const imported = parseInspirationCanvasReference(storage.getItem(INSPIRATION_CANVAS_HANDOFF_KEY));
  assert(imported, `${item.id} handoff 解析失败`);
  assert.equal(imported.schemaVersion, "official_inspiration_reference.v2");
  assert.equal(imported.mediaType, expectedMediaTypes[index]);
  assert.equal(imported.mediaPath, item.mediaPath || item.imagePath);
  assert(imported.mediaPath.startsWith("/") && !imported.mediaPath.startsWith("//"));
  assert.equal(imported.workflow?.nodes.length, 2);
  assert.equal(imported.workflow?.edges.length, 1);
  const mediaNode = imported.workflow?.nodes.find((node) => node.id.endsWith(":media"));
  assert(mediaNode, `${item.id} 缺少媒体节点`);
  assert.equal(mediaNode.outputUrl, imported.mediaPath);
  assert(mediaNode.prompt.includes(`本地媒体路径：${imported.mediaPath}`));
  if (imported.mediaType === "audio") {
    assert.equal(mediaNode.kind, "upload", "音频必须降级为只读媒体引用节点");
    assert.equal(mediaNode.sourceKind, "audio");
    assert.match(mediaNode.prompt, /画布尚无音频原生节点/u);
  }
});

assert.equal(
  OFFICIAL_INSPIRATION_ITEMS.some((item) => item.availability === "planned"),
  false,
  "当前正式素材快照全部为本地 ready 项，不应恢复虚假的 planned 占位卡片",
);

const detailRedirect = `/youcai/inspiration?item=${encodeURIComponent(handoffFixtures[1]!.id)}`;
const loginHref = `/login?redirect=${encodeURIComponent(detailRedirect)}`;
assert.equal(
  toAppScopedHref("/youcai/inspiration", loginHref),
  loginHref,
  "未登录下载必须保留当前灵感详情 item redirect，不得双重 /youcai 嵌套",
);

const rejectingStorage: CanvasHandoffStorage = {
  getItem: () => null,
  setItem: () => { throw new Error("storage denied"); },
  removeItem: () => undefined,
};
assert.equal(
  saveInspirationCanvasReference(handoffFixtures[0]!, rejectingStorage),
  false,
  "sessionStorage 写入失败时必须向页面返回 false",
);
for (const unsafeMediaPath of [
  "https://example.invalid/remote.mp4",
  "//example.invalid/remote.mp4",
  "/short-drama/../private.mp4",
  "/short-drama/%2e%2e/private.mp4",
  "/short-drama/%252e%252e/private.mp4",
  "/short-drama/%5c..%5cprivate.mp4",
]) {
  assert.equal(
    saveInspirationCanvasReference({
      ...handoffFixtures[2]!,
      mediaPath: unsafeMediaPath,
    }, new MemoryStorage()),
    false,
    `handoff 必须拒绝非安全本地媒体路径: ${unsafeMediaPath}`,
  );
}

assert.equal(manifest.items.length, 6, "公开媒体来源清单应包含 6 条");
for (const item of manifest.items) {
  assert.match(item.sourceUrl, /^https:\/\/youcaiapp\.oss-[^/]+\.aliyuncs\.com\//);
  assert.ok(existsSync(path.join(root, "public", item.localPath.slice(1))), `来源清单文件缺失: ${item.localPath}`);
}

for (const requiredSource of [
  "getVisibleCategories",
  "InspirationCardMedia",
  "unoptimized",
  "setPreviewPath(item.imagePath)",
  "<video",
  "<audio key=",
  "controls onError={() => setFailed(true)}",
  "查看提示词",
  "最新",
  "最热",
  "const saved = saveInspirationCanvasReference(item)",
  "if (!saved)",
  "本次不会打开空画布",
  "matchesMediaFilter",
  "INSPIRATION_PAGE_SIZE",
  "IntersectionObserver",
  "继续加载瀑布流",
  "appendImageWorkbenchPromptTransfer",
  "storeYoucaiVideoPrefill",
  "storeYoucaiMusicPrefill",
  "本次不会打开没有素材提示词的空工作台",
  "role=\"alert\"",
  "/login?redirect=",
  "/youcai/inspiration?item=",
]) {
  assert.ok(gallerySource.includes(requiredSource), `灵感广场交互缺失: ${requiredSource}`);
}

console.log(JSON.stringify({
  ok: true,
  total: OFFICIAL_INSPIRATION_ITEMS.length,
  counts,
  readyAudio: readyAudio.length,
  readyVideo: readyVideo.length,
  musicFilterItems: musicCount,
  visibleCategories: categoriesWithContent,
  hiddenEmptyCategories: categoriesWithoutContent,
  publicMediaSnapshots: manifest.items.length,
  handoffV2MediaTypes: expectedMediaTypes,
  blocksNavigationOnStorageFailure: true,
  loginRedirectPreservesItem: true,
  preservesSourceAndAvailabilityNotes: true,
  progressiveWaterfall: true,
  workbenchPrefillHandoff: true,
}, null, 2));
