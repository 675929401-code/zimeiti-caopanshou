import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { shouldReturnUnauthenticatedVisitorHome } from "../src/lib/auth-route-boundary";
import {
  MEDIA_HISTORY_CATEGORY_KEYS,
  mediaHistoryCategoryFromVideoSource,
} from "../src/lib/media-history-contract";

const root = process.cwd();

async function source(path: string) {
  return readFile(resolve(root, path), "utf8");
}

function section(text: string, start: RegExp, end: RegExp, label: string): string {
  const startMatch = start.exec(text);
  assert.ok(startMatch?.index !== undefined, `${label}：缺少起始边界`);
  const tail = text.slice(startMatch.index + startMatch[0].length);
  const endMatch = end.exec(tail);
  assert.ok(endMatch?.index !== undefined, `${label}：缺少结束边界`);
  return tail.slice(0, endMatch.index);
}

function assertStableCategories(text: string, label: string) {
  for (const key of MEDIA_HISTORY_CATEGORY_KEYS) {
    assert.match(text, new RegExp(`["']${key}["']`), `${label}必须包含稳定分类 key：${key}`);
  }
}

function runIsolatedBrowserContract(script: string) {
  const result = spawnSync(process.execPath, [resolve(root, script)], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  assert.equal(
    result.status,
    0,
    `${script} 隔离浏览器门禁失败\n${result.stdout || ""}\n${result.stderr || ""}`,
  );
}

async function main() {
  const [
    page,
    styles,
    api,
    contentApi,
    thumbnailApi,
    videoPreview,
    videoPreviewClient,
    nativePreviewVerifier,
  ] = await Promise.all([
    source("src/app/media-history/page.tsx"),
    source("src/app/media-history/media-history.module.css"),
    source("src/app/api/media-history/route.ts"),
    source("src/app/api/media-history/content/route.ts"),
    source("src/app/api/video/thumbnail/[taskId]/route.ts"),
    source("src/components/media-history-video-preview.tsx"),
    source("src/lib/media-history-video-preview.ts"),
    source("scripts/verify-media-history-native-preview.mjs"),
  ]);

  assert.doesNotMatch(page, /redirect\("\/"\)/, "作品历史页不得再重定向回应用广场");
  assert.match(page, /export default function MediaHistoryPage\(\)/, "作品历史必须挂载真实聚合页面");
  assert.match(page, /title="作品历史"/, "页面标题必须与侧栏入口一致");
  assert.match(page, /const isAuthenticated = Boolean\(token && currentUserId\)/, "页面必须同时绑定 token 与当前用户");
  assert.match(
    page,
    /if \(!isAuthenticated\)[\s\S]*?setItems\(\[\]\)[\s\S]*?return;/,
    "未登录时不得请求受保护的作品历史接口",
  );
  assert.match(page, /Authorization: `Bearer \$\{token\}`/, "作品历史读取必须携带当前登录凭据");
  assert.equal(shouldReturnUnauthenticatedVisitorHome("/media-history"), true, "未登录访问作品历史必须沿用统一深链保护");
  assert.equal(shouldReturnUnauthenticatedVisitorHome("/"), false, "公开首页不得被作品历史保护规则误伤");

  assert.match(page, /function LazyMediaPreview\(/, "作品卡必须通过统一惰性预览组件渲染媒体");
  assert.match(
    page,
    /scopedItems\.map\([\s\S]*?<article[\s\S]*?<LazyMediaPreview item=\{item\} token=\{token\}/,
    "每张作品卡都必须挂载 LazyMediaPreview",
  );
  assert.match(page, /new IntersectionObserver\(/, "作品预览必须以 IntersectionObserver 延迟加载");
  assert.match(page, /observer\.observe\(node\)/, "惰性预览必须实际观察卡片媒体容器");
  assert.match(page, /observer\.disconnect\(\)/, "卡片进入视区或卸载后必须释放观察器");
  assert.match(page, /rootMargin:\s*["']\d+px 0px["']/, "预览应在接近视区时提前加载，避免滚动后空白");
  assert.match(
    page,
    /if \(!inViewport \|\| !imagePath \|\| item\.status !== "completed" \|\| !token\) return;/,
    "只有进入视区且已完成、已登录的作品才能读取图片字节",
  );
  assert.match(page, /headers:\s*\{ Authorization: `Bearer \$\{token\}` \}/, "图片与首帧读取必须使用 Bearer 鉴权");
  assert.match(page, /const blob = await response\.blob\(\)/, "完成图片必须把受保护响应转换为浏览器可展示的 Blob URL");
  assert.match(page, /blob\.type[\s\S]*?startsWith\("image\/"\)/, "卡片预览必须拒绝非图片响应");
  assert.match(page, /URL\.createObjectURL\(blob\)/, "完成图片必须生成浏览器可展示地址");
  assert.match(page, /URL\.revokeObjectURL\(/, "图片预览卸载或替换时必须回收 Blob URL");
  assert.match(
    page,
    /item\.kind === "video" \? item\.thumbnailPath : item\.previewPath/,
    "视频卡必须优先读取专用首帧地址，图片卡读取原图预览地址",
  );
  assert.match(
    page,
    /item\.thumbnailPath && imageState !== "error"[\s\S]*?<img[^>]+视频首帧[\s\S]*?:\s*\([\s\S]*?<MediaHistoryVideoPreview/,
    "视频卡必须优先展示静态首帧，并在首帧失败时回退原生 Range 预览",
  );
  assert.match(page, /生成完成后显示作品预览/, "运行中作品必须显示明确的等待占位");
  assert.match(page, /任务未交付，暂无可用预览/, "失败作品必须显示明确占位，不能请求破损媒体");
  assert.match(page, /任务已取消，暂无可用预览/, "已取消作品必须显示明确占位");

  assert.match(videoPreview, /requestMediaHistoryVideoUrl\(previewPath, token/, "原生视频回退必须先申请短期播放票据");
  assert.match(videoPreview, /src=\{`\$\{source\}#t=0\.1`\}/, "原生视频回退必须定位首帧附近而不是自动播放");
  assert.match(videoPreview, /controls playsInline preload="metadata"/, "原生视频回退必须仅预载 metadata 并提供显式播放控件");
  assert.doesNotMatch(videoPreview, /\bautoPlay\b|\bautoplay\b/, "作品列表中的视频不得自动播放");
  assert.match(videoPreview, /预览暂不可用，点击重试/, "播放票据或 Range 失败后必须允许重新签发重试");
  assert.doesNotMatch(videoPreview, /\.blob\s*\(/, "原生视频预览不得把整段视频读成 Blob");
  assert.doesNotMatch(videoPreviewClient, /\.blob\s*\(/, "视频票据客户端不得把整段视频读成 Blob");
  assert.match(videoPreviewClient, /scope:\s*options\.download \? "download" : "playback"/, "播放与下载必须使用不同票据 scope");
  assert.match(videoPreviewClient, /"\/api\/video\/proxy-download" : "\/api\/video\/proxy"/, "下载票据和播放票据必须落到不同代理入口");
  assert.match(videoPreviewClient, /Authorization: `Bearer \$\{token\}`/, "短期视频票据必须通过请求头鉴权，不能把账号 token 放进 URL");
  assert.match(videoPreviewClient, /target\.origin !== window\.location\.origin/, "票据返回地址必须限制为同源代理");
  assert.match(nativePreviewVerifier, /no whole-file blob fetch/, "隔离浏览器门禁必须覆盖禁止整视频 Blob 下载");
  assert.match(nativePreviewVerifier, /Range media requests/, "隔离浏览器门禁必须覆盖原生 Range 请求");
  assert.match(nativePreviewVerifier, /download-scoped URL/, "隔离浏览器门禁必须覆盖下载 scope");

  const openMedia = section(page, /const openMedia = useCallback\(/, /const deleteServerRecord = useCallback\(/, "打开预览与下载");
  assert.match(openMedia, /if \(item\.kind === "video"\)[\s\S]*?requestMediaHistoryVideoUrl\([\s\S]*?return;/, "视频打开与下载必须在 Blob 分支前走短期票据并直接返回");
  const videoBranchEnd = openMedia.indexOf("return;");
  const firstBlobRead = openMedia.indexOf("response.blob()");
  assert.ok(videoBranchEnd >= 0 && firstBlobRead > videoBranchEnd, "视频分支必须在任何 response.blob() 前结束");

  assertStableCategories(page, "作品历史页面");
  assert.match(page, /type CategoryKey = MediaHistoryCategoryKey/, "页面分类必须复用统一稳定 key");
  assert.match(page, /category,\s*\n\s*kind,\s*\n\s*q: serverQuery/, "页面必须把 category、kind、q 交给服务端筛选");
  assert.match(page, /includeTotal:\s*"true"/, "页面必须显式请求权威总数");
  assert.match(page, /setFacets\(readFacets\(data\)\)/, "分类和媒体类型数量必须来自服务端 facets");
  assert.match(page, /page\.total \?\? data\.totalCount \?\? data\.total/, "页面必须优先读取服务端分页总数");
  assert.match(page, /page\.currentCount/, "页面必须显示服务端当前页数量");
  assert.match(page, /pagination\.total[\s\S]*?pagination\.currentCount[\s\S]*?scopedItems\.length/, "界面必须同时展示匹配总数、当前页数量和已显示数量");
  assert.match(page, /item\.status === "failed" && item\.retryPath/, "只有失败且服务端给出 retryPath 的记录才允许载入后重试");
  assert.match(page, /window\.setInterval\(syncActiveHistory, 15_000\)/, "排队中或处理中任务必须每 15 秒刷新");
  assert.match(page, /window\.addEventListener\("focus", syncActiveHistory\)/, "窗口重新聚焦时必须刷新活动任务");
  assert.match(page, /document\.addEventListener\("visibilitychange", syncActiveHistory\)/, "页面重新可见时必须刷新活动任务");

  assert.match(api, /authorizeCurrentApiUser\(request\)/, "作品历史 API 必须绑定当前登录用户");
  assert.match(api, /MEDIA_HISTORY_CATEGORY_KEYS/, "作品历史 API 必须复用统一稳定分类 key");
  assert.match(api, /searchParams\.get\("category"\)/, "API 必须解析 category 参数");
  assert.match(api, /searchParams\.get\("kind"\)/, "API 必须解析 kind 参数");
  assert.match(api, /searchParams\.get\("q"\)/, "API 必须解析 q 搜索参数");
  assert.match(api, /categoryKey:/, "每条公共作品记录必须返回稳定 categoryKey");
  assert.match(api, /facets:\s*\{[\s\S]*?categories:[\s\S]*?kinds:/, "API 必须返回来源与媒体类型 facets");
  assert.match(api, /pagination:\s*\{[\s\S]*?total:[\s\S]*?currentCount:/, "API 分页必须同时返回筛选总数和当前页数量");
  assert.match(api, /currentCount:\s*items\.length/, "当前页数量必须由实际返回且可打开的 records 计算");
  assert.match(api, /const\s+items\s*=\s*[A-Za-z_$][\w$]*\.slice\(offset,\s*offset \+ limit\)/, "API 必须先完成服务端筛选再分页");
  assert.match(api, /conversation_messages/, "图片历史应复用现有消息记录");
  assert.match(api, /image_generation_requests/, "作品历史必须直接聚合已完成且已交付的生图记录");
  assert.match(api, /\.eq\("state",\s*"completed"\)[\s\S]*?\.eq\("delivery_state",\s*"delivered"\)/, "生图记录必须只纳入已完成且已交付结果");
  assert.match(api, /video_tasks/, "视频历史应复用现有任务记录");
  assert.match(api, /price_charged/, "视频费用应读取实际扣费字段");
  assert.match(api, /submission_error_code, billing_state, provider_result_url,[^\n]+price_charged/, "服务端必须读取安全重试所需的提交、计费和供应商终态");
  assert.match(api, /canRetryVideoHistoryTask\(row\)/, "媒体历史必须复用视频历史的安全重试门禁");
  assert.match(api, /retryTask=\$\{encodeURIComponent\(recordId\)\}/, "安全重试地址必须绑定原任务编号");
  assert.match(api, /mediaHistoryCategoryFromVideoSource\(\{[\s\S]*?storyboard,/, "视频分类必须调用统一来源映射");
  assert.equal(
    mediaHistoryCategoryFromVideoSource({ storyboard: true }),
    "storyboard-workbench",
    "分镜视频必须返回分镜工作台分类",
  );
  assert.match(api, /storage_url[\s\S]*?provider_result_url[\s\S]*?video_url/, "视频 completed 必须具有本地存储或受保护代理可读取的交付源");
  assert.match(api, /hasAuthenticatedDeliverySource/, "完成视频必须通过受鉴权交付源门禁");
  assert.match(api, /\["REMOVE_HISTORY",\s*"DELETE_SERVER_RECORD"\]\.includes/, "服务端必须校验历史移除确认口令");
  assert.match(api, /hideMediaHistoryItem/, "历史移除必须写入用户级隐藏记录，不能删除原始结果");
  assert.match(api, /ownedImageAssetMap/, "图片历史必须核对当前用户的永久资产");
  assert.match(api, /assetId/);
  assert.match(api, /storageKey/);
  assert.match(contentApi, /authorizeCurrentApiUser\(request\)/, "作品内容读取必须绑定当前登录用户");
  assert.match(contentApi, /searchParams\.get\("assetId"\)/, "直接生图资产必须支持稳定 assetId 读取");
  assert.match(contentApi, /from\("user_files"\)/, "图片内容必须从归属资产记录读取");
  assert.match(contentApi, /\.eq\("user_id",\s*user\.userId\)/, "直接生图资产必须再次校验当前账号归属");
  assert.match(contentApi, /storageManager\.read/, "图片内容必须读取持久化对象");
  assert.doesNotMatch(contentApi, /\bfetch\s*\(/, "不得重新拉取历史中的短时/远程 URL");
  assert.match(thumbnailApi, /"Cache-Control": "private, max-age=3600"/, "私有缩略图只允许账号浏览器短时缓存");
  assert.match(thumbnailApi, /"Vary": "Cookie, Authorization"/, "私有缩略图缓存必须按账号鉴权上下文隔离");
  assert.doesNotMatch(thumbnailApi, /"Cache-Control": "public/i, "私有缩略图不得声明为公共缓存");
  assert.doesNotMatch(api, /provider\s*:/i, "公共 DTO 不得暴露 provider 字段");
  assert.doesNotMatch(api, /internal(?:Model)?Id\s*:/i, "公共 DTO 不得暴露内部模型字段");
  assert.match(api, /right\.id\.localeCompare\(left\.id\)/, "同一提交时间的合并历史必须用唯一编号稳定排序");

  assert.match(styles, /\.preview\s*\{[\s\S]*?aspect-ratio:\s*16\s*\/\s*9/, "图片与视频首帧必须使用稳定预览区域，避免卡片跳动");
  assert.match(page, /confirmation:\s*"REMOVE_HISTORY"/, "从历史移除必须使用独立确认口令");
  assert.match(page, /原始对话、生成文件和账单会保留/, "移除历史前必须明确原始结果与账务仍保留");
  assert.match(page, /图片保留两天、视频保留三天/, "页面必须说明无上游到期信息时的回退期限");
  assert.match(page, /到期索引自动从列表清理/, "页面必须说明到期索引会自动清理");
  assert.match(page, /下载到电脑长期保存/, "长期保存必须引导用户显式下载到电脑");
  assert.doesNotMatch(page, /cacheVideoLocally|listUserMediaCache|保存浏览器副本|浏览器视频副本/, "作品历史不得提供类硬盘浏览器副本");
  assert.match(api, /resolveMediaHistoryRetention\(/, "服务端必须统一计算上游或回退到期时间");
  assert.match(api, /expiredCount:\s*snapshot\.expiredCount/, "服务端必须返回自动清理的过期索引数量");
  const viewportContracts = [
    { width: 1440, mode: "desktop", columns: "auto-fill >= 310px" },
    { width: 1920, mode: "desktop-wide", columns: "auto-fill >= 310px" },
  ];
  assert.deepEqual(viewportContracts.map((item) => item.mode), ["desktop", "desktop-wide"]);

  runIsolatedBrowserContract("scripts/verify-media-history-page-preview.mjs");
  runIsolatedBrowserContract("scripts/verify-media-history-native-preview.mjs");

  console.log(`media-history contract verification passed; auth/source categories/facets/pagination/lazy image+video previews/ticket isolation/upstream retention; desktopViewports=${viewportContracts.map((item) => item.width).join("/")}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
