import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const readSource = (relativePath: string) => readFileSync(`${projectRoot}/${relativePath}`, "utf8");

const announcement = readSource("src/components/announcement-popup.tsx");
assert.match(
  announcement,
  /const \[readerOpen, setReaderOpen\] = useState\(false\)/,
  "新版公告必须以独立阅读器状态控制长方形 Dialog",
);
assert.match(announcement, /<Dialog open=\{readerOpen\}/, "公告阅读器必须继续使用可访问 Dialog");
assert.match(announcement, /width: "min\(1120px, calc\(100vw - 96px\)\)"/, "公告主弹窗必须保持桌面长方形宽度");
assert.match(announcement, /height: "min\(680px, calc\(100vh - 120px\)\)"/, "公告主弹窗必须保持桌面长方形高度");
assert.match(announcement, /fetchInbox\(true\)/, "登录和可见态恢复时必须检查账号未读公告");
assert.match(
  announcement,
  /const newlyPushed = firstLoad[\s\S]*?!isRead\(announcement\)[\s\S]*?!knownDeliveryKeysRef\.current\.has\(deliveryKey\(announcement\)\)[\s\S]*?!dismissalsRef\.current\.has\(deliveryKey\(announcement\)\)[\s\S]*?eligibleForAutomaticDisplay\(announcement\)/u,
  "新推送轻提示必须按未读、投递版本、当前登录关闭态与展示频控共同去重",
);
assert.match(
  announcement,
  /if \(allowAutoOpen && firstLoad && !readerOpenRef\.current\)[\s\S]*?!isRead\(announcement\)[\s\S]*?!dismissalsRef\.current\.has\(deliveryKey\(announcement\)\)[\s\S]*?eligibleForAutomaticDisplay\(announcement\)[\s\S]*?openReader\(candidate\.id, \{ automatic: true \}\)/u,
  "首次自动弹窗必须跳过已读或本次登录已关闭的版本，并经过展示频控",
);
assert.match(announcement, /rememberDismissed\(deliveryKey\(announcement\)\)/, "关闭公告阅读器必须记录当前投递版本的会话关闭态");
assert.match(announcement, /\/api\/announcements\/\$\{encodeURIComponent\(announcement\.id\)\}\/read/, "已阅读必须写入账号级接口");
assert.match(announcement, /data-testid="announcement-mark-read"/, "公告必须提供明确的标记已阅读动作");
assert.equal(
  announcement.match(/localStorage\.setItem\(/gu)?.length,
  1,
  "公告本地存储只允许保存自动展示频控账本，账号已读状态必须由服务端收件箱负责",
);
assert.match(announcement, /localStorage\.setItem\(DISPLAY_LEDGER_KEY,/, "自动展示频控必须使用专用账本键");
assert.doesNotMatch(announcement, /markAllRead|autoAnnouncement/, "新版公告不得退回批量代读或旧气泡状态");

const toolboxMenu = readSource("src/components/toolbox-menu.tsx");
assert.match(toolboxMenu, /const href = preferredToolboxHref\(\)[\s\S]*?router\.push\(href\)/u, "工具箱入口必须直接进入最终 tab URL");
assert.doesNotMatch(toolboxMenu, /router\.push\(["']\/tools["']\)/, "工具箱入口不得先进入无 tab 的中间路由");

const toolsPage = readSource("src/app/tools/page.tsx");
assert.match(toolsPage, /window\.history\.pushState\(/, "标签切换必须使用客户端 History API");
assert.match(toolsPage, /window\.history\.replaceState\(/, "缺失或非法 tab 必须无 RSC 地规范化 URL");
assert.match(toolsPage, /addEventListener\("popstate"/, "浏览器前进后退必须恢复标签状态");
assert.doesNotMatch(toolsPage, /router\.(?:push|replace)\(`\/tools\?tab=/, "标签切换不得触发整页 RSC 导航");
assert.match(toolsPage, /dynamic\(\(\) => import\("@\/app\/extract\/page"\)/, "大型工具页面应按当前标签加载");

const marketplace = readSource("src/components/agent-marketplace.tsx");
assert.match(marketplace, /loading=\{idx < MARKETPLACE_EAGER_AVATAR_COUNT \? "eager" : "lazy"\}/, "首屏外头像必须延迟加载");
assert.match(marketplace, /decoding="async"/, "头像必须异步解码");
assert.match(marketplace, /fetchPriority=\{idx < MARKETPLACE_HIGH_PRIORITY_AVATAR_COUNT \? "high" : "auto"\}/, "头像高优先级数量必须有上限");
assert.match(marketplace, /width=\{Math\.max\(/, "头像必须声明固有宽度");
assert.match(marketplace, /height=\{Math\.max\(/, "头像必须声明固有高度");
assert.match(marketplace, /idx < MARKETPLACE_ANIMATED_CARD_COUNT \? "animate-card-enter" : ""/, "卡片交错动画必须限制在首屏少量项");

const routeShell = readSource("src/components/app-route-shell.tsx");
const officialHome = readSource("src/features/official-home/official-home-page.tsx");
const appContext = readSource("src/contexts/app-context.tsx");
const botsRoute = readSource("src/app/api/bots/route.ts");
const conversationCache = readSource("src/lib/conversation-cache.ts");
const nextConfig = readSource("next.config.ts");
assert.match(routeShell, /let manjuRuntimeRequest: Promise<ManjuRuntimeView> \| null = null/, "runtime-config 必须合并并发请求");
assert.match(routeShell, /let manjuRuntimeCache:/, "runtime-config 必须跨 shell 重挂载缓存");
assert.match(routeShell, /if \(manjuRuntimeRequest\) return manjuRuntimeRequest/, "重挂载不得重复发起相同请求");
assert.doesNotMatch(routeShell, /new AbortController\(\)/, "shell 卸载不得中止供下一次挂载复用的共享请求");
assert.match(routeShell, /prefetch=\{false\}/, "侧栏链接不得因进入视口批量预取全部路由");
assert.match(routeShell, /onPointerEnter=\{\(\) => \{[\s\S]*?router\.prefetch\(item\.href\)/u, "桌面侧栏应按鼠标意图预取单一路由");
assert.match(routeShell, /onFocus=\{\(\) => \{[\s\S]*?router\.prefetch\(item\.href\)/u, "桌面侧栏应按键盘意图预取单一路由");
assert.match(officialHome, /function Link\([\s\S]*?prefetch=\{false\}/u, "漫剧首页链接不得因进入视口批量预取全部路由");
assert.match(officialHome, /onPointerEnter=\{\(event\) => \{[\s\S]*?prefetchOnIntent\(\)/u, "漫剧首页应按鼠标意图预取单一路由");
assert.match(officialHome, /onFocus=\{\(event\) => \{[\s\S]*?prefetchOnIntent\(\)/u, "漫剧首页应按键盘意图预取单一路由");
assert.equal(appContext.match(/fetch\("\/api\/bots\?shape=agents"/gu)?.length, 2, "主客户端首次加载和兜底重试都应请求单数组 Agent 响应");
assert.match(botsRoute, /url\.searchParams\.get\("shape"\) === "agents"[\s\S]*?\? \{ agents: formattedAgents, navigationKeys:/u, "Agent 接口必须支持不重复序列化的单数组响应并返回导航权限键");
assert.match(botsRoute, /: \{ bots: formattedAgents, agents: formattedAgents, navigationKeys:/u, "Agent 接口必须保留旧调用方兼容响应与导航权限键");
assert.match(conversationCache, /export function isBrowserConversationCacheEnabled\(\): false \{\s*return false;/u, "浏览器对话正文缓存必须永久停用");
assert.doesNotMatch(conversationCache, /localStorage\.setItem/u, "对话缓存兼容层不得写回正文");
assert.doesNotMatch(appContext, /convCacheTimerRef|beforeunload[\s\S]{0,300}saveConversationsToCache/u, "主客户端不得创建本地对话写入定时器");

for (const [aliasRoute, canonicalRoute] of [
  ["src/app/tools/chat/page.tsx", "/tools/text/text-chat"],
  ["src/app/youcai/tools/chat/page.tsx", "/youcai/tools/text/text-chat"],
] as const) {
  const source = readSource(aliasRoute);
  assert.match(
    source,
    /export\s+const\s+dynamic\s*=\s*["']force-dynamic["']/u,
    `${aliasRoute} 必须由服务端动态执行 redirect，避免先返回静态 200 壳再二次挂载`,
  );
  assert.match(
    source,
    new RegExp(`redirect\\(["']${canonicalRoute.replaceAll("/", "\\/")}['"]\\)`, "u"),
    `${aliasRoute} 必须保留 canonical 聊天入口兜底`,
  );
  const publicAlias = aliasRoute.includes("youcai") ? "/youcai/tools/chat" : "/tools/chat";
  const escapedAlias = publicAlias.replaceAll("/", "\\/");
  const escapedCanonical = canonicalRoute.replaceAll("/", "\\/");
  assert.match(
    nextConfig,
    new RegExp(
      `source:\\s*["']${escapedAlias}["'][\\s\\S]{0,160}?destination:\\s*["']${escapedCanonical}["'][\\s\\S]{0,120}?permanent:\\s*false`,
      "u",
    ),
    `${publicAlias} 必须在 next.config.ts 渲染前返回临时服务端重定向`,
  );
}

console.log("PASS navigation performance contract");
