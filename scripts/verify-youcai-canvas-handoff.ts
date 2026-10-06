import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  canvasShowcaseHandoffKey,
  consumeCanvasShowcaseReference,
  INSPIRATION_CANVAS_HANDOFF_KEY,
  consumeInspirationCanvasReference,
  parseInspirationCanvasReference,
  saveCanvasShowcaseReference,
  saveInspirationCanvasReference,
  type CanvasHandoffStorage,
} from "../src/features/official-inspiration/canvas-handoff";
import { CANVAS_SHARE_SHOWCASES } from "../src/features/official-inspiration/canvas-showcase-data";
import { toAppScopedHref, toYoucaiHref } from "../src/lib/youcai-routes";

class MemoryStorage implements CanvasHandoffStorage {
  private readonly values = new Map<string, string>();

  get length(): number {
    return this.values.size;
  }

  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }

  removeItem(key: string) {
    this.values.delete(key);
  }
}

function collectSourceFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return collectSourceFiles(target);
    return /\.(?:ts|tsx)$/u.test(entry.name) ? [target] : [];
  });
}

const projectRoot = process.cwd();
const sourceRoot = path.join(projectRoot, "src");
const read = (relativePath: string) => fs.readFileSync(path.join(projectRoot, relativePath), "utf8");

assert.equal(
  toYoucaiHref("/free-canvas"),
  "/youcai/free-canvas",
  "自由画布入口必须落到 Youcai 独立分支",
);
assert.equal(
  toYoucaiHref("/youcai/free-canvas"),
  "/youcai/free-canvas",
  "已带 Youcai 前缀的自由画布路由不得再次嵌套",
);
assert.equal(
  toAppScopedHref("/youcai/tools/canvas", "/youcai/free-canvas"),
  "/youcai/free-canvas",
  "创建按钮不得回到当前工具介绍页或产生 /youcai/youcai 自循环",
);
assert.equal(
  toAppScopedHref(
    "/youcai/tools/canvas",
    "/login?redirect=%2Fyoucai%2Ffree-canvas",
  ),
  "/login?redirect=%2Fyoucai%2Ffree-canvas",
  "未登录入口必须保留登录后的自由画布 redirect",
);

const storage = new MemoryStorage();
const item = {
  id: "handoff-fixture",
  title: "可编辑灵感参考",
  prompt: "保留角色一致性，并把这一段提示词导入真实画布文本卡片。",
  imagePath: "/short-drama/inspiration-paper-fox-v1.png",
  mediaType: "图片" as const,
  availability: "ready" as const,
};
assert.equal(saveInspirationCanvasReference(item, storage), true, "handoff 应成功写入 sessionStorage 适配器");
const saved = parseInspirationCanvasReference(storage.getItem(INSPIRATION_CANVAS_HANDOFF_KEY));
assert.equal(saved?.title, item.title);
assert.equal(saved?.prompt, item.prompt);
assert.equal(saved?.imagePath, item.imagePath);
assert.equal(saved?.schemaVersion, "official_inspiration_reference.v2");
assert.equal(saved?.mediaType, "image");
assert.equal(saved?.mediaPath, item.imagePath);
assert.equal(saved?.mediaRole, "primary");
assert.equal(saved?.workflow?.nodes.length, 2);
assert.equal(saved?.workflow?.edges.length, 1);
assert.equal(saved?.autoImport, true);

const consumed = consumeInspirationCanvasReference(storage);
assert.equal(consumed?.inspirationId, item.id, "消费者应得到完整 handoff");
assert.equal(
  storage.getItem(INSPIRATION_CANVAS_HANDOFF_KEY),
  null,
  "handoff 被读取后必须立即清除",
);
assert.equal(consumeInspirationCanvasReference(storage), null, "handoff 不得被重复消费");

storage.setItem(INSPIRATION_CANVAS_HANDOFF_KEY, JSON.stringify({ schemaVersion: "broken" }));
assert.equal(consumeInspirationCanvasReference(storage), null, "无效 handoff 不得导入画布");
assert.equal(storage.getItem(INSPIRATION_CANVAS_HANDOFF_KEY), null, "无效 handoff 也必须一次性清除");

const showcaseStorage = new MemoryStorage();
const firstShowcase = CANVAS_SHARE_SHOWCASES[0];
const secondShowcase = CANVAS_SHARE_SHOWCASES[1];
assert.equal(saveCanvasShowcaseReference(firstShowcase, showcaseStorage), true, "第一案例蓝图应成功写入");
assert.ok(showcaseStorage.getItem(canvasShowcaseHandoffKey(firstShowcase.id)));
assert.equal(saveCanvasShowcaseReference(secondShowcase, showcaseStorage), true, "第二案例蓝图应成功写入");
assert.equal(
  showcaseStorage.getItem(canvasShowcaseHandoffKey(firstShowcase.id)),
  null,
  "切换案例时必须清理第一案例未消费的陈旧蓝图",
);
assert.ok(showcaseStorage.getItem(canvasShowcaseHandoffKey(secondShowcase.id)));
assert.equal(
  consumeCanvasShowcaseReference(secondShowcase.id, showcaseStorage)?.inspirationId,
  secondShowcase.id,
  "当前案例必须只消费自己的蓝图",
);
assert.equal(consumeCanvasShowcaseReference(firstShowcase.id, showcaseStorage), null, "当前案例消费后不得串入第一案例");

const officialCanvasSource = read("src/features/official-core-routes/official-canvas-route.tsx");
assert.match(officialCanvasSource, /"\/youcai\/free-canvas"/u);
assert.match(officialCanvasSource, /redirect=%2Fyoucai%2Ffree-canvas/u);
assert.doesNotMatch(officialCanvasSource, /free-canvas\?mode=create/u);
assert.doesNotMatch(officialCanvasSource, /"\/tools\/canvas\?mode=create"/u);

const showcaseSource = read("src/features/official-inspiration/canvas-share-showcase.tsx");
assert.match(showcaseSource, /useAppScopedRouter/u);
assert.match(showcaseSource, /router\.push\(`\/youcai\/free-canvas\?showcase=\$\{encodeURIComponent\(showcase\.id\)\}`\)/u);
assert.match(showcaseSource, /data-canvas-shell=/u);

const gallerySource = read("src/features/official-inspiration/official-inspiration-gallery.tsx");
assert.match(gallerySource, /useAppScopedRouter/u);
assert.match(gallerySource, /router\.push\("\/youcai\/free-canvas"\)/u);
for (const source of [showcaseSource, gallerySource]) {
  assert.doesNotMatch(source, /router\.push\(`\/tools\/canvas/u);
  assert.doesNotMatch(source, /free-canvas\?mode=create/u);
}

const handoffModule = path.normalize(path.join(sourceRoot, "features/official-inspiration/canvas-handoff.ts"));
const consumerCalls = collectSourceFiles(sourceRoot)
  .filter((file) => path.normalize(file) !== handoffModule)
  .flatMap((file) => {
    const matches = fs.readFileSync(file, "utf8").match(/\bconsumeInspirationCanvasReference\s*\(/gu) ?? [];
    return matches.map(() => path.relative(projectRoot, file));
  });
assert.deepEqual(
  consumerCalls,
  [path.normalize("src/components/free-canvas-shell.tsx")],
  "canvas handoff 必须只有 FreeCanvasShell 一个消费端",
);

const shellSource = read("src/components/free-canvas-shell.tsx");
assert.match(shellSource, /initialReference=\{canvasHandoff\}/u);
assert.match(shellSource, /consumeCanvasShowcaseReference\(expectedShowcaseId\)/u);
assert.match(shellSource, /preferredReferenceId=\{expectedShowcaseId \|\| canvasHandoff\?\.inspirationId\}/u);
assert.match(shellSource, /data-canvas-shell="free-canvas"/u);
const canvasSource = read("src/components/manual-canvas.tsx");
assert.match(canvasSource, /createInspirationStarterCanvas/u);
assert.match(canvasSource, /if \(reference\.workflow\)/u);
assert.match(canvasSource, /reference\.workflow\.nodes\.map/u);
assert.match(canvasSource, /reference\.workflow\.edges/u);
assert.match(canvasSource, /灵感提示词/u);
assert.match(canvasSource, /原创参考图/u);
assert.match(canvasSource, /sourceReferenceId/u);
assert.match(canvasSource, /session\.sourceReferenceId === preferredReferenceId/u);
assert.match(canvasSource, /未找到指定示例的复制数据；已隔离为空白画布，请返回示例页重新点击“复制并继续创作”/u);

console.log(JSON.stringify({
  ok: true,
  route: "/youcai/free-canvas",
  consumer: consumerCalls[0],
  importedFields: [
    "inspirationId", "title", "prompt", "imagePath", "mediaPath", "mediaType", "mediaRole",
    "workflow.nodes", "workflow.edges",
  ],
  consumedExactlyOnce: true,
  staleShowcaseHandoffsRemoved: true,
  sessionIsolationByShowcaseId: true,
}, null, 2));
