import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const sidebar = await readFile(new URL("../src/components/app-sidebar.tsx", import.meta.url), "utf8");
const marketplace = await readFile(new URL("../src/components/agent-marketplace.tsx", import.meta.url), "utf8");

assert.doesNotMatch(sidebar, /\bCoins\b/u, "侧栏不应继续引入或渲染独立积分卡图标");
assert.doesNotMatch(sidebar, /sb-credit-(?:label|value|icon-tile)/u, "侧栏不应继续渲染重复积分余额卡片");

const mediaHistoryShortcutStart = sidebar.indexOf("const MEDIA_HISTORY_SHORTCUT");
const mediaHistoryShortcutEnd = sidebar.indexOf("const TOOLBOX_SHORTCUT", mediaHistoryShortcutStart);
assert.ok(mediaHistoryShortcutStart >= 0 && mediaHistoryShortcutEnd > mediaHistoryShortcutStart, "缺少作品历史快捷入口定义");
const mediaHistoryShortcut = sidebar.slice(mediaHistoryShortcutStart, mediaHistoryShortcutEnd);
assert.match(mediaHistoryShortcut, /title:\s*"作品历史"[\s\S]*?link_value:\s*"\/media-history"/u, "作品历史必须直达统一媒体历史页");
assert.doesNotMatch(sidebar, /\u4f5c\u54c1\u76f4\u8fbe/u, "快捷导航不得出现错误命名");

const extractNormalizerStart = sidebar.indexOf("const isExtractShortcut");
const extractNormalizerEnd = sidebar.indexOf("const isToolboxShortcut", extractNormalizerStart);
const extractNormalizer = sidebar.slice(extractNormalizerStart, extractNormalizerEnd);
assert.match(extractNormalizer, /item\.link_value === "\/tools\?tab=text"/u, "快捷入口归一化必须识别当前文案提取路由");
assert.match(extractNormalizer, /item\.link_value === "\/extract"/u, "快捷入口归一化必须吞掉后台遗留旧路由");
assert.match(extractNormalizer, /title === "文案提取"/u, "快捷入口归一化必须吞掉后台遗留文案提取标题");

assert.match(sidebar, /next\.splice\(marketplaceIndex >= 0 \? marketplaceIndex \+ 1 : 0, 0, MEDIA_HISTORY_SHORTCUT\)/u, "应用广场后必须插入唯一作品历史入口");
assert.doesNotMatch(sidebar, /next\.splice\([^\n]*EXTRACT_SHORTCUT/u, "快捷导航不得重新插入文案提取入口");

const newConversationStart = sidebar.indexOf("const handleNewConversation");
const newConversationEnd = sidebar.indexOf("const handlePresetStart", newConversationStart);
const newConversation = sidebar.slice(newConversationStart, newConversationEnd);
assert.match(newConversation, /if \(!auth\?\.isAuthenticated \|\| !user\)[\s\S]*?window\.location\.replace\("\/"\)/u, "未登录时必须返回首页登录边界");
assert.match(newConversation, /startFreeChat\(\);\s*onNavigate\?\.\(\);/u, "所有已登录用户的新建对话必须进入自由对话");
assert.doesNotMatch(newConversation, /if \(isAdmin\)|activeAgent|createConversationAndChat/u, "新建自由对话不得再按管理员角色或当前智能体分流");

assert.match(sidebar, /<UserThemeSwitcher\s+menuSide="top"\s*\/>/u, "左侧栏底部必须保留唯一主题切换入口");
assert.doesNotMatch(marketplace, /UserThemeSwitcher|marketplace-nav-actions/u, "首页右上角不得继续渲染重复主题入口");
assert.doesNotMatch(marketplace, /管理导航入口|开启布局编辑模式|打开学习中心|setShowAddNav\(true\)|router\.push\("\/help"\)/u, "首页右上角临时管理入口必须保持收起");

console.log(JSON.stringify({
  passed: true,
  assertions: [
    "sidebar-balance-card-removed",
    "media-history-routes-to-unified-history",
    "legacy-extract-shortcuts-filtered",
    "new-chat-opens-free-chat-for-authenticated-users",
    "unauthenticated-new-chat-returns-home",
    "home-admin-actions-hidden",
    "theme-switcher-kept-in-sidebar-only",
  ],
}, null, 2));
