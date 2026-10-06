import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import {
  CANVAS_SHARE_SHOWCASES,
  getCanvasShareShowcase,
} from "../src/features/official-inspiration/canvas-showcase-data";
import {
  canvasShowcaseHandoffKey,
  consumeCanvasShowcaseReference,
  INSPIRATION_CANVAS_HANDOFF_KEY,
  parseInspirationCanvasReference,
  saveCanvasShowcaseReference,
  type CanvasHandoffStorage,
} from "../src/features/official-inspiration/canvas-handoff";

const projectRoot = process.cwd();
const routeSource = readFileSync(
  path.join(projectRoot, "src/features/official-core-routes/official-canvas-route.tsx"),
  "utf8",
);
const routeStyles = readFileSync(
  path.join(projectRoot, "src/features/official-core-routes/official-canvas-route.module.css"),
  "utf8",
);
const detailSource = readFileSync(
  path.join(projectRoot, "src/features/official-inspiration/canvas-share-showcase.tsx"),
  "utf8",
);
const detailStyles = readFileSync(
  path.join(projectRoot, "src/features/official-inspiration/canvas-share-showcase.module.css"),
  "utf8",
);
const showcaseDataSource = readFileSync(
  path.join(projectRoot, "src/features/official-inspiration/canvas-showcase-data.ts"),
  "utf8",
);
const freeCanvasSource = readFileSync(
  path.join(projectRoot, "src/components/manual-canvas.tsx"),
  "utf8",
);
const freeCanvasShellSource = readFileSync(
  path.join(projectRoot, "src/components/free-canvas-shell.tsx"),
  "utf8",
);

const dedicatedCoverPreviews = [
  "/youcai-media/v1/canvas-showcases/paper-fox/06-cover.preview.webp",
  "/youcai-media/v1/canvas-showcases/m8/01-cockpit-family.preview.webp",
] as const;
for (const previewPath of dedicatedCoverPreviews) {
  const previewDiskPath = path.join(projectRoot, "public", ...previewPath.slice(1).split("/"));
  assert.equal(existsSync(previewDiskPath), true, `案例轻量封面不存在：${previewPath}`);
  assert.ok(statSync(previewDiskPath).size < 80 * 1024, `案例轻量封面超过 80 KiB：${previewPath}`);
  assert.ok(routeSource.includes(previewPath), `画布首页没有使用轻量封面：${previewPath}`);
}

for (const forbidden of [
  /刺猬/u,
  /黑色鱼/u,
  /蒙古/u,
  /藏族/u,
  /北京.{0,8}拼贴/u,
  /智能手机/u,
  /柑桔/u,
  /官网公开快照未显示可播放结果/u,
]) {
  assert.equal(forbidden.test(showcaseDataSource), false, `案例数据仍包含跨案例污染：${forbidden}`);
}

function publicFileExists(publicPath: string): boolean {
  assert.match(publicPath, /^\/(?!\/)/u, `媒体必须是同源绝对路径：${publicPath}`);
  return existsSync(publicDiskPath(publicPath));
}

function publicDiskPath(publicPath: string): string {
  return path.join(projectRoot, "public", ...publicPath.slice(1).split("/"));
}

interface DerivedMediaManifestEntry {
  showcase: "pet-manga" | "m8-ad";
  kind: "image" | "video";
  localPath: string;
  publicPath: string;
  sourceLocalPath: string;
  provenance: "project-local-derived";
  transform: string;
  mimeType: "image/jpeg" | "video/mp4";
  bytes: number;
  sha256: string;
  durationSeconds?: number;
}

interface DerivedMediaManifest {
  schemaVersion: 1;
  policy: {
    remoteSources: false;
    thirdPartyLogos: false;
    officialGenerationClaimed: false;
  };
  counts: { images: number; videos: number };
  entries: DerivedMediaManifestEntry[];
}

const derivedManifestPath = path.join(
  projectRoot,
  "public/youcai-media/v1/canvas-showcases/derived/manifest.json",
);
assert.equal(existsSync(derivedManifestPath), true, "本地派生媒体清单不存在");
const derivedManifest = JSON.parse(readFileSync(derivedManifestPath, "utf8")) as DerivedMediaManifest;
assert.equal(derivedManifest.schemaVersion, 1, "本地派生媒体清单版本错误");
assert.deepEqual(derivedManifest.policy, {
  remoteSources: false,
  thirdPartyLogos: false,
  officialGenerationClaimed: false,
  note: "All entries are deterministic previews derived from project-local same-showcase media. They are not presented as benchmark-site outputs.",
}, "本地派生媒体必须明确无远程来源、无第三方 Logo、非官网生成结果");
assert.deepEqual(derivedManifest.counts, { images: 146, videos: 12 }, "本地派生媒体数量必须稳定");
assert.equal(derivedManifest.entries.length, 158, "本地派生媒体清单条目数量错误");
assert.equal(new Set(derivedManifest.entries.map((entry) => entry.publicPath)).size, 158, "本地派生媒体路径不得重复");
for (const entry of derivedManifest.entries) {
  assert.equal(entry.provenance, "project-local-derived", `${entry.publicPath} 来源标记错误`);
  assert.match(entry.publicPath, /^\/youcai-media\/v1\/canvas-showcases\/derived\/(pet|m8)\//u);
  assert.doesNotMatch(entry.publicPath, /https?:|logo|watermark/u, `${entry.publicPath} 不得引入远程素材、Logo 或水印`);
  assert.doesNotMatch(entry.sourceLocalPath, /https?:|^\/\//u, `${entry.publicPath} 来源必须是项目本地路径`);
  const assetPath = publicDiskPath(entry.publicPath);
  const sourcePath = path.join(projectRoot, "public/youcai-media/v1", ...entry.sourceLocalPath.split("/"));
  assert.equal(existsSync(assetPath), true, `${entry.publicPath} 派生媒体不存在`);
  assert.equal(existsSync(sourcePath), true, `${entry.publicPath} 本地来源不存在`);
  assert.equal(statSync(assetPath).size, entry.bytes, `${entry.publicPath} 文件字节数与清单不一致`);
  assert.equal(
    createHash("sha256").update(readFileSync(assetPath)).digest("hex"),
    entry.sha256,
    `${entry.publicPath} SHA-256 与清单不一致`,
  );
  if (entry.kind === "image") {
    assert.equal(entry.mimeType, "image/jpeg");
    assert.match(entry.publicPath, /\.jpg$/u);
  } else {
    assert.equal(entry.mimeType, "video/mp4");
    assert.equal(entry.durationSeconds, 3);
    assert.match(entry.publicPath, /\.mp4$/u);
  }
}

class MemoryStorage implements CanvasHandoffStorage {
  private readonly values = new Map<string, string>();

  get length(): number {
    return this.values.size;
  }

  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }

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

assert.equal(CANVAS_SHARE_SHOWCASES.length, 4, "入口必须恰好提供 4 个完整案例");
assert.equal(new Set(CANVAS_SHARE_SHOWCASES.map((item) => item.id)).size, 4, "案例 id 必须唯一");

assert.match(routeSource, /<video[\s\S]*?autoPlay=\{bannerVideoActive\}[\s\S]*?muted[\s\S]*?loop[\s\S]*?playsInline[\s\S]*?preload="none"/u, "顶部必须保留静音循环真实 video，并在播放前禁用预载");
assert.match(routeSource, /const bannerOverride = showcaseCatalog\?\.banners\.overrides\["canvas:0"\]/u, "顶部横幅必须读取漫剧 media 域发布覆盖");
assert.match(routeSource, /const bannerVideo = bannerOverride\?\.asset\?\.path \|\| "\/youcai-media\/v1\/featured\/canvas-banner-youcai\.mp4"/u, "顶部必须保留当前已归档本地 MP4 作为默认值");
assert.match(routeSource, /const bannerPoster = bannerOverride\?\.poster\?\.path \|\| "\/short-drama\/hero-pipeline-v1\.png"/u, "顶部静态图只能作为 poster 降级并支持后台覆盖");
assert.match(routeSource, /\{bannerVideoActive \? <source src=\{bannerVideo\} type="video\/mp4" \/> : null\}/u, "顶部 video source 必须在用户主动播放后才绑定已治理的横幅素材变量");
assert.match(routeSource, /aria-label=\{bannerVideoActive \? "停止画布创作演示并释放视频流量"[\s\S]*?: "播放画布创作演示"\}/u, "顶部必须提供可访问的按需播放与停止入口");
assert.equal(/<source[^>]+src="https?:\/\//u.test(routeSource), false, "顶部视频不得依赖远程第三方地址");
assert.match(routeSource, /applyManjuCanvasOverrides\(CANVAS_SHARE_SHOWCASES,\s*showcaseCatalog\)/u, "入口卡片必须以案例数据为基线并应用漫剧 media 域覆盖");
assert.match(routeSource, /configuredShowcases\.map/u, "入口卡片必须渲染已治理后的案例列表");
assert.match(routeSource, /href=\{`\/youcai\/share\/canvas\/\$\{showcase\.id\}`\}/u, "每张卡片必须进入当前分支自己的详情页");
assert.match(routeSource, /showcase\.coverMediaType === "video"/u, "入口卡片必须按官网媒体类型渲染图片或视频");
assert.match(routeSource, /showcase\.tag \? <span/u, "官网无标签的卡片不得渲染空标签胶囊");
assert.match(routeSource, /从示例开始/u, "入口必须保留官网公开分区标题");
assert.match(routeSource, /查看完整创作流程，复制后即可继续编辑和创作。/u, "入口必须保留官网公开说明");
assert.match(routeSource, /<Link[\s\S]*?className=\{styles\.showcaseCard\}[\s\S]*?aria-label=\{`查看并复制/u, "四张案例整卡必须可点击");
assert.match(routeSource, /<span>查看并复制<\/span>/u, "四张卡片必须使用官网公开操作文案");
assert.match(routeStyles, /\.bannerVideo\s*\{/u, "顶部视频必须有独立样式");
assert.match(routeStyles, /\.bannerControl\s*\{/u, "顶部按需播放按钮必须有独立样式");
assert.equal(publicFileExists("/youcai-media/v1/featured/canvas-banner-youcai.mp4"), true, "顶部本地 MP4 不存在");
assert.equal(publicFileExists("/short-drama/hero-pipeline-v1.png"), true, "顶部 poster 不存在");

assert.match(detailSource, /LayoutGrid/u, "详情页缺少画布视图按钮");
assert.match(detailSource, /aria-label="列表视图"/u, "详情页缺少列表视图按钮");
assert.match(detailSource, /fitView/u, "详情页缺少适配视图逻辑");
assert.match(detailSource, /aria-label="适配视图"/u, "详情页缺少适配视图按钮");
assert.match(detailSource, /canvasStage/u, "详情页缺少按缩放尺寸承载的画布舞台");
assert.match(detailSource, /const MIN_ZOOM = 5/u, "大型案例适配视图必须允许缩放到 5%");
assert.match(detailSource, /x:\s*\(viewport\.clientWidth - layout\.width \* scale\) \/ 2/u, "适配视图必须按 transform 居中而非回到左上角");
assert.match(detailSource, /data-minimap-for/u, "详情页必须渲染真实 SVG 导航缩略图");
assert.match(detailSource, /navigateFromMiniMap/u, "缩略图必须支持点击与拖动定位");
assert.match(detailSource, /resolveDraggedViewportCenter/u, "缩略图拖动必须保留抓取偏移，不能按下即跳动");
assert.match(detailSource, /onPointerCancel=\{finishMiniMapDrag\}/u, "缩略图必须在指针取消时清理拖动状态");
assert.match(detailSource, /data-full-view=\{!miniMapInteractive \|\| undefined\}/u, "完整画布已进入视口时缩略图必须明确标记为非交互状态");
assert.match(detailSource, /onPointerDown=\{beginPan\}/u, "画布空白区域必须支持拖动平移");
assert.match(detailSource, /addEventListener\("wheel",\s*zoomWithWheel,\s*\{\s*passive:\s*false\s*\}\)/u, "画布滚轮必须用非 passive 原生监听在画布内部缩放");
assert.match(detailSource, /removeEventListener\("wheel",\s*zoomWithWheel\)/u, "画布滚轮缩放监听必须在卸载时清理");
assert.equal(detailSource.includes("onWheel={zoomWithWheel}"), false, "画布不得继续使用会触发 passive preventDefault 错误的 React onWheel");
assert.match(detailStyles, /\.canvasViewport\s*\{[\s\S]*?overflow:\s*hidden/u, "详情画布必须由 transform 平移缩放并裁切在单一视口内");
assert.equal(detailStyles.includes("linear-gradient(125deg"), false, "画布背景不得出现紫色粗斜杠装饰");
assert.match(detailStyles, /background-size:\s*20px 20px/u, "画布背景必须使用 20x20 点阵");
assert.match(detailStyles, /\.edgeLayer path\s*\{[\s\S]*?stroke:\s*rgb\(226, 232, 240\)[\s\S]*?stroke-width:\s*2/u, "可见连线必须是 2px 浅灰线");
assert.match(detailStyles, /\.miniMap\s*\{[\s\S]*?width:\s*220px[\s\S]*?min-height:\s*96px[\s\S]*?max-height:\s*160px/u, "导航缩略图必须按画布宽高比在 220x96~160 范围内自适应");
assert.match(detailStyles, /\.miniMap\[data-interactive="true"\][\s\S]*?cursor:\s*grab/u, "可交互缩略图必须提供可抓取光标提示");
assert.match(detailStyles, /\.miniMapViewportMask\s*\{[\s\S]*?fill:\s*none/u, "缩略导航的视口标记不得使用大块填色遮挡节点");
assert.match(detailStyles, /\.page\s*\{[\s\S]*?height:\s*100dvh[\s\S]*?overflow:\s*hidden/u, "详情页必须只占一个浏览器视口，不能再套一层页面画布");
assert.match(detailStyles, /\.canvasViewport\s*\{[\s\S]*?flex:\s*1 1 auto[\s\S]*?overflow:\s*hidden/u, "详情页必须由内部画布视口承载平移缩放并隐藏溢出内容");
assert.match(detailStyles, /\.listView\s*\{[\s\S]*?flex:\s*1[\s\S]*?overflow:\s*auto/u, "列表模式必须在同一视口内独立滚动");
assert.match(detailStyles, /\.nodeCard\s*\{[\s\S]*?position:\s*absolute/u, "节点必须按计算坐标绝对定位");
assert.match(detailSource, /width:\s*nodeWidth\(node\),\s*height:\s*nodeHeight\(node\)/u, "画布节点实际高度必须与布局、连线和缩略图使用同一尺寸");
assert.match(detailStyles, /\.nodeCard\s*>\s*p,[\s\S]*?\.nodeCard\s*>\s*\.editableBody\s*\{[\s\S]*?overflow:\s*auto/u, "固定高度节点的长文必须在节点内部滚动");
assert.match(detailSource, /if \(view !== "canvas"\) return;[\s\S]*?requestAnimationFrame\(\(\) => fitView\(\)\)[\s\S]*?\[fitView,\s*showcase\.id,\s*view\]/u, "列表切回画布后必须按当前案例布局重置为确定的可见视图");
assert.equal(showcaseDataSource.includes("groupAssignments"), false, "公开快照不得按距离猜测分组归属");
assert.equal(showcaseDataSource.includes("dx <= 2_200"), false, "公开快照不得使用超大矩形吞并附近节点");
assert.match(detailStyles, /\.videoPreview\s+video/u, "详情页必须渲染本地视频预览");
assert.match(detailStyles, /\.audioPreview\s+audio/u, "详情页必须渲染本地音频预览");
assert.match(freeCanvasSource, /reference\.workflow\.nodes\.map/u, "自由画布必须遍历导入全部节点");
assert.match(freeCanvasSource, /reference\.workflow\.edges[\s\S]*?\.filter[\s\S]*?\.map/u, "自由画布必须导入全部有效连线");
assert.equal(/reference\.workflow\.nodes\.slice\(0,\s*2\)/u.test(freeCanvasSource), false, "自由画布不得只导入两个节点");
assert.match(freeCanvasSource, /session\.sourceReferenceId === preferredReferenceId/u, "自由画布必须按当前 showcase id 隔离恢复会话");
assert.match(freeCanvasSource, /未找到指定示例的复制数据；已隔离为空白画布，请返回示例页重新点击“复制并继续创作”/u, "缺少指定副本时不得回退到上一案例");
assert.match(freeCanvasShellSource, /preferredReferenceId=\{expectedShowcaseId \|\| canvasHandoff\?\.inspirationId\}/u, "自由画布入口必须把当前 showcase id 传给会话隔离层");
assert.equal(detailSource.includes("进入创作画布"), false, "详情页不得再渲染第二套画布入口栏");
assert.equal(detailSource.includes("styles.footer"), false, "详情页不得为嵌套 footer 预留布局");

const forbiddenFooterTerms = ["ICP备", "有彩世界", "youcai.art"];
for (const term of forbiddenFooterTerms) {
  assert.equal(routeSource.includes(term), false, `画布页脚不得保留第三方标识：${term}`);
}
assert.match(routeSource, /© 2026 漫剧工作台/u, "画布页脚必须使用当前分支品牌");

const expected = [
  {
    id: "canvas-showcase-78f7a4a9ce11-paper-fox-adventure",
    title: "示例｜纸上小狐狸的奇幻冒险",
    tag: "",
    coverImage: "/youcai-media/v1/canvas-showcases/paper-fox/06-cover.jpg",
    nodes: 13,
    edges: 17,
    kinds: { text: 5, image: 3, video: 3, audio: 1, music: 1 },
  },
  {
    id: "cmsyrsury01e3caezkqyg5l5l",
    title: "示例：漫剧（未完成）",
    tag: "短剧",
    coverImage: "/youcai-media/v1/images/cmojwg45f038f110s9yuy8hua.png",
    nodes: 78,
    edges: 71,
    kinds: { group: 6, image: 67, text: 2, video: 2, audio: 1 },
  },
  {
    id: "cmsyrvsqh01jgcaez3xadrsob",
    title: "示例：奕派M8广告",
    tag: "广告",
    coverImage: "/youcai-media/v1/canvas-showcases/m8/01-cockpit-family.jpg",
    nodes: 139,
    edges: 148,
    kinds: { group: 11, image: 106, text: 8, video: 11, music: 2, audio: 1 },
  },
  {
    id: "cmt37buny005u85fyne9adfac",
    title: "我在古代当花魁 · 创作画布示例",
    tag: "爽剧",
    coverImage: "/youcai-media/v1/images/cmt1m9fmb02vk7fsayssbhkzx.png",
    nodes: 85,
    edges: 14,
    kinds: { group: 3, image: 28, "video-plan": 54 },
  },
] as const;

assert.deepEqual(
  CANVAS_SHARE_SHOWCASES.map(({ id, title, tag }) => ({ id, title, tag })),
  expected.map(({ id, title, tag }) => ({ id, title, tag })),
  "四案例顺序、标题与标签必须等于 2026-08-24 官网公开状态",
);

const showcaseMediaSets: Array<ReadonlySet<string>> = [];

const summaries = CANVAS_SHARE_SHOWCASES.map((showcase, index) => {
  const contract = expected[index];
  assert.equal(getCanvasShareShowcase(showcase.id)?.id, showcase.id, `${showcase.title} 详情路由不可解析`);
  assert.equal(showcase.nodes.length, contract.nodes, `${showcase.title} 节点数量必须与官网公开快照一致`);
  assert.equal(showcase.edges.length, contract.edges, `${showcase.title} 连线数量必须与官网公开快照一致`);
  assert.equal(showcase.coverMediaType, "image", `${showcase.title} 官网当前卡片封面类型是图片`);
  assert.equal(showcase.coverImage, contract.coverImage, `${showcase.title} 必须使用与官网案例内容对应的固定本地封面`);
  assert.equal(publicFileExists(showcase.coverImage), true, `${showcase.title} 本地封面文件不存在`);
  assert.equal(showcase.description, "打开示例查看节点编排与创作流程，一键复制为自己的画布。");
  assert.deepEqual(showcase.officialSnapshot, {
    sourceUrl: `https://youcai.art/share/canvas/${showcase.id}`,
    capturedAt: "2026-08-24",
    nodeCount: contract.nodes,
    edgeCount: contract.edges,
  });

  const kindCounts = showcase.nodes.reduce<Record<string, number>>((counts, node) => {
    counts[node.kind] = (counts[node.kind] ?? 0) + 1;
    return counts;
  }, {});
  assert.deepEqual(kindCounts, contract.kinds, `${showcase.title} 节点媒体类型必须与官网公开快照一致`);
  const kinds = new Set(showcase.nodes.map((node) => node.kind));

  const nodeIds = new Set(showcase.nodes.map((node) => node.id));
  assert.equal(nodeIds.size, showcase.nodes.length, `${showcase.title} 节点 id 重复`);
  for (const node of showcase.nodes) {
    assert.equal(Number.isFinite(node.position.x) && Number.isFinite(node.position.y), true, `${showcase.title}/${node.title} 坐标无效`);
    assert.ok(node.position.x >= 0 && node.position.y >= 0, `${showcase.title}/${node.title} 不得散落到负坐标`);
    if (node.imagePath) assert.equal(publicFileExists(node.imagePath), true, `${showcase.title}/${node.title} 图片不存在`);
    if (node.mediaPath) assert.equal(publicFileExists(node.mediaPath), true, `${showcase.title}/${node.title} 媒体不存在`);
    if (node.kind === "image") {
      assert.ok(node.imagePath, `${showcase.title}/${node.title} 声明为图片的节点必须挂载本地图片`);
      assert.doesNotMatch(node.imagePath, /https?:|^\/\//u, `${showcase.title}/${node.title} 图片不得依赖远程地址`);
      assert.doesNotMatch(node.status, /待归档|未生成/u, `${showcase.title}/${node.title} 图片不得残留占位状态`);
    }
    if (node.kind === "video") {
      assert.ok(node.mediaPath, `${showcase.title}/${node.title} 声明为视频的节点必须挂载本地视频`);
      assert.doesNotMatch(node.mediaPath, /https?:|^\/\//u, `${showcase.title}/${node.title} 视频不得依赖远程地址`);
      assert.ok(node.posterPath && publicFileExists(node.posterPath), `${showcase.title}/${node.title} 视频 poster 不存在`);
      assert.doesNotMatch(node.status, /待归档|未生成/u, `${showcase.title}/${node.title} 视频不得残留占位状态`);
    }
    if (node.kind === "video-plan") {
      assert.equal(node.mediaPath, undefined, `${showcase.title}/${node.title} 官网未生成视频不得伪造本地结果`);
      assert.match(node.status, /未生成/u, `${showcase.title}/${node.title} 必须保留官网未生成状态`);
    }
    if (node.kind === "audio" || node.kind === "music") {
      assert.ok(node.mediaPath, `${showcase.title}/${node.title} 声明为音频的节点必须挂载本地音频`);
      assert.doesNotMatch(node.mediaPath, /https?:|^\/\//u, `${showcase.title}/${node.title} 音频不得依赖远程地址`);
      assert.doesNotMatch(node.status, /待归档|未生成/u, `${showcase.title}/${node.title} 音频不得残留占位状态`);
    }
  }
  const groups = showcase.nodes.filter((node) => node.kind === "group");
  for (const group of groups) {
    assert.equal(group.width, 720, `${showcase.title}/${group.title} 无显式边界时必须使用安全固定宽度`);
    assert.equal(group.height, 520, `${showcase.title}/${group.title} 无显式边界时必须使用安全固定高度`);
  }
  if (groups.length > 0) {
    assert.equal(showcase.nodes.some((node) => Boolean(node.parentId)), false, `${showcase.title} 公开快照不得伪造父子语义`);
  }

  const localMedia = new Set<string>([showcase.coverImage]);
  for (const node of showcase.nodes) {
    for (const mediaPath of [node.imagePath, node.mediaPath, node.posterPath]) {
      if (mediaPath) localMedia.add(mediaPath);
    }
  }
  showcaseMediaSets.push(localMedia);

  if (showcase.id === "cmsyrvsqh01jgcaez3xadrsob") {
    const m8ImageNodes = showcase.nodes.filter((node) => node.kind === "image");
    assert.equal(m8ImageNodes.length, 106, "M8 必须保留 106 个官网图片节点");
    assert.equal(new Set(m8ImageNodes.map((node) => node.imagePath)).size, 106, "M8 的 106 个图片节点必须使用 106 个独立本地文件");
    for (const node of m8ImageNodes) {
      assert.ok(node.imagePath);
      assert.match(
        node.imagePath,
        /^\/youcai-media\/v1\/canvas-showcases\/(?:m8\/|derived\/m8\/images\/)/u,
        "M8 图片不得串用非汽车案例素材",
      );
    }
    assert.equal(m8ImageNodes.filter((node) => node.imagePath?.includes("/derived/m8/images/")).length, 96, "M8 必须补齐 96 个同主题派生图片文件");
    const m8VideoNodes = showcase.nodes.filter((candidate) => candidate.kind === "video");
    assert.equal(m8VideoNodes.length, 11);
    assert.equal(new Set(m8VideoNodes.map((node) => node.mediaPath)).size, 11, "M8 的 11 个视频节点必须使用 11 个独立本地 MP4");
    for (const node of m8VideoNodes) {
      assert.match(node.mediaPath || "", /^\/youcai-media\/v1\/canvas-showcases\/derived\/m8\/videos\/m8-\d{2}\.mp4$/u);
    }
    const m8AudioPaths = showcase.nodes
      .filter((candidate) => candidate.kind === "audio" || candidate.kind === "music")
      .map((node) => node.mediaPath);
    assert.equal(new Set(m8AudioPaths).size, 3, "M8 的 2 个音乐节点和 1 个声音节点必须使用独立本地音频");
    assert.deepEqual(new Set(m8AudioPaths), new Set([
      "/youcai-media/v1/audio/cmreqtxrp00x412o9vht6yoxw.mp3",
      "/youcai-media/v1/audio/cmrepdsql005912o9i4yhyz21.mp3",
      "/youcai-media/v1/audio/cmreoz0lg002b12o91tl24a2k.mp3",
    ]), "M8 音频必须来自项目内科技/家庭氛围素材");
  }

  if (showcase.id === "cmsyrsury01e3caezkqyg5l5l") {
    const petImageNodes = showcase.nodes.filter((node) => node.kind === "image");
    assert.equal(petImageNodes.length, 67, "宠物漫剧必须保留 67 个官网图片节点");
    assert.equal(new Set(petImageNodes.map((node) => node.imagePath)).size, 67, "宠物漫剧 67 个图片节点必须使用独立本地文件");
    assert.equal(petImageNodes.filter((node) => node.imagePath?.includes("/derived/pet/images/")).length, 50, "宠物漫剧必须补齐 50 个同主题派生图片文件");
    const petVideoNodes = showcase.nodes.filter((node) => node.kind === "video");
    assert.equal(petVideoNodes.length, 2);
    assert.equal(new Set(petVideoNodes.map((node) => node.mediaPath)).size, 2, "宠物漫剧 2 个视频节点必须使用独立本地 MP4");
    assert.equal(petVideoNodes.filter((node) => node.mediaPath?.includes("/derived/pet/videos/")).length, 1, "宠物漫剧必须补齐 1 个同主题派生视频文件");
  }

  if (showcase.id === "cmt37buny005u85fyne9adfac") {
    const ancientImagePaths = showcase.nodes
      .filter((node) => node.kind === "image")
      .map((node) => node.imagePath || "");
    assert.equal(ancientImagePaths.length, 28, "花魁案例必须保留 28 个人物、场景和道具节点");
    assert.equal(new Set(ancientImagePaths).size, 28, "花魁案例的 28 个图片节点不得重复房间图占位");
  }

  const edgeIds = new Set<string>();
  for (const edge of showcase.edges) {
    assert.equal(edgeIds.has(edge.id), false, `${showcase.title} 连线 id 重复`);
    edgeIds.add(edge.id);
    assert.equal(nodeIds.has(edge.source), true, `${showcase.title} 连线来源不存在：${edge.source}`);
    assert.equal(nodeIds.has(edge.target), true, `${showcase.title} 连线目标不存在：${edge.target}`);
    assert.notEqual(edge.source, edge.target, `${showcase.title} 不允许自连线`);
  }
  const storage = new MemoryStorage();
  assert.equal(saveCanvasShowcaseReference(showcase, storage), true, `${showcase.title} 复制蓝图保存失败`);
  assert.equal(storage.getItem(INSPIRATION_CANVAS_HANDOFF_KEY), null, `${showcase.title} 不得写入可串案例的全局 handoff key`);
  const handoffKey = canvasShowcaseHandoffKey(showcase.id);
  const payload = parseInspirationCanvasReference(storage.getItem(handoffKey));
  assert.ok(payload?.workflow, `${showcase.title} 复制蓝图无法解析`);
  assert.equal(payload.workflow.nodes.length, showcase.nodes.length, `${showcase.title} 复制后节点丢失`);
  assert.equal(payload.workflow.edges.length, showcase.edges.length, `${showcase.title} 复制后连线丢失`);
  assert.deepEqual(
    new Set(payload.workflow.nodes.map((node) => node.sourceKind)),
    kinds,
    `${showcase.title} 复制后原始节点类型丢失`,
  );
  assert.equal(consumeCanvasShowcaseReference(showcase.id, storage)?.inspirationId, showcase.id);
  assert.equal(storage.getItem(handoffKey), null, `${showcase.title} handoff 必须只消费一次`);

  return {
    id: showcase.id,
    title: showcase.title,
    nodes: showcase.nodes.length,
    edges: showcase.edges.length,
    images: showcase.nodes.filter((node) => node.kind === "image").length,
    videos: showcase.nodes.filter((node) => node.kind === "video").length,
    audios: showcase.nodes.filter((node) => node.kind === "audio" || node.kind === "music").length,
  };
});

for (let left = 0; left < showcaseMediaSets.length; left += 1) {
  for (let right = left + 1; right < showcaseMediaSets.length; right += 1) {
    const shared = [...showcaseMediaSets[left]].filter((mediaPath) => showcaseMediaSets[right].has(mediaPath));
    assert.deepEqual(shared, [], `${expected[left].title} 与 ${expected[right].title} 不得串用案例媒体`);
  }
}

const isolationStorage = new MemoryStorage();
const firstShowcase = CANVAS_SHARE_SHOWCASES[0];
const secondShowcase = CANVAS_SHARE_SHOWCASES[1];
assert.equal(saveCanvasShowcaseReference(firstShowcase, isolationStorage), true);
assert.ok(isolationStorage.getItem(canvasShowcaseHandoffKey(firstShowcase.id)), "第一案例必须先写入独立 handoff");
assert.equal(saveCanvasShowcaseReference(secondShowcase, isolationStorage), true);
assert.equal(isolationStorage.getItem(canvasShowcaseHandoffKey(firstShowcase.id)), null, "复制第二案例时必须清除第一案例的陈旧 handoff");
assert.ok(isolationStorage.getItem(canvasShowcaseHandoffKey(secondShowcase.id)), "第二案例 handoff 不得被误删");
assert.equal(consumeCanvasShowcaseReference(secondShowcase.id, isolationStorage)?.inspirationId, secondShowcase.id);
for (const showcase of CANVAS_SHARE_SHOWCASES) {
  assert.equal(isolationStorage.getItem(canvasShowcaseHandoffKey(showcase.id)), null, "消费后不得遗留任何案例 handoff");
}
assert.equal(consumeCanvasShowcaseReference(firstShowcase.id, isolationStorage), null, "已切换案例不得回退导入第一案例");

assert.equal(getCanvasShareShowcase("local-showcase-paper-fox-adventure")?.nodes.length, 13, "纸狐历史别名必须继续可用");

console.log(JSON.stringify({
  ok: true,
  checks: {
    topLocalLoopVideo: true,
    independentShowcases: 4,
    gridListToggle: true,
    fitView: true,
    fullWorkflowHandoff: true,
    isolatedShowcaseMedia: true,
    isolatedShowcaseSessions: true,
    declaredMediaNodesComplete: true,
    derivedLocalMedia: derivedManifest.entries.length,
    remainingDeclaredMediaPlaceholders: 0,
    dedicatedCoverPreviews: dedicatedCoverPreviews.length,
    singleViewportShowcase: true,
    externalCalls: 0,
  },
  showcases: summaries,
}, null, 2));
