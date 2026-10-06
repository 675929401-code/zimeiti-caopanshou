import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  INSPIRATION_MEDIA_FILTERS,
  OFFICIAL_INSPIRATION_ITEMS,
} from "../src/features/official-inspiration/inspiration-data";

const root = process.cwd();
const source = (relativePath: string) => readFileSync(resolve(root, relativePath), "utf8");

assert.deepEqual(INSPIRATION_MEDIA_FILTERS, ["全部", "图片", "视频", "音频", "音乐"]);
const musicItems = OFFICIAL_INSPIRATION_ITEMS.filter(
  (item) => item.mediaType === "音频" && item.category === "音乐" && item.mediaPath,
);
assert.ok(musicItems.length > 0, "音乐筛选必须由真实本地音频素材支撑");

const gallery = source("src/features/official-inspiration/official-inspiration-gallery.tsx");
for (const required of [
  "const INSPIRATION_PAGE_SIZE = 36",
  "function matchesMediaFilter",
  "new IntersectionObserver",
  "继续加载瀑布流",
  "appendImageWorkbenchPromptTransfer",
  "storeYoucaiVideoPrefill",
  "storeYoucaiMusicPrefill",
  "进入画布或工作台只传递本站素材引用与提示词",
  "素材文件加载失败",
  "本次不会打开没有素材提示词的空工作台",
]) {
  assert.ok(gallery.includes(required), `灵感交付缺失: ${required}`);
}
const galleryCss = source("src/features/official-inspiration/official-inspiration.module.css");
assert.match(galleryCss, /\.gallery\s*\{[\s\S]*?column-count:\s*4/u, "桌面端必须保留瀑布列布局");
assert.match(galleryCss, /\.loadMore\s*\{/u, "渐进瀑布必须有可操作的加载兜底");
assert.match(galleryCss, /\.mediaError\s/u, "媒体失败必须有可见错误态");

const assets = source("src/features/official-core-routes/official-assets-route.tsx");
for (const required of [
  "hasLoadedAssetsRef",
  "const preservingSnapshot = hasLoadedAssetsRef.current",
  "已保留上次成功加载的资产",
  "当前继续显示上次成功加载的资产",
  "fetchAssetJson",
  "controller.abort()",
]) {
  assert.ok(assets.includes(required), `个人资产刷新恢复缺失: ${required}`);
}
assert.doesNotMatch(assets, /aria-disabled="true">提示词/u, "个人资产不得保留可点击但无行为的提示词页签");
assert.doesNotMatch(assets, /disabled>最热/u, "个人资产不得展示没有热度数据源的死按钮");

const account = source("src/features/youcai-account/youcai-account-page.tsx");
assert.match(account, /snapshotRef\.current/u);
assert.match(account, /已保留上次成功同步的账户数据/u);
assert.match(account, /loading && !snapshot/u, "后台刷新不得覆盖已有账户快照");

const referral = source("src/features/youcai-billing/youcai-billing-pages.tsx");
assert.match(referral, /window\.setTimeout\([\s\S]*?8_000/u, "登录核验必须有界");
assert.match(referral, /hasLoadedInvitationRef/u);
assert.match(referral, /已保留上次成功加载的推荐数据/u);

const publicPages = source("src/features/official-public-pages/official-tv-page.tsx");
for (const required of [
  "const TV_VIDEO_ITEMS = OFFICIAL_INSPIRATION_ITEMS",
  "本站视频精选",
  "controls",
  "查看来源与提示词",
]) {
  assert.ok(publicPages.includes(required), `公共导航交付缺失: ${required}`);
}

const aliases = new Map([
  ["src/app/inspiration/page.tsx", "/youcai/inspiration"],
  ["src/app/assets/page.tsx", "/youcai/assets"],
  ["src/app/youcai-tv/page.tsx", "/youcai/youcai-tv"],
  ["src/app/creative-horizon/page.tsx", "/youcai"],
  ["src/app/navigation/page.tsx", "/youcai"],
  ["src/app/articles/page.tsx", "/youcai/articles"],
  ["src/app/skills/page.tsx", "/youcai/skills"],
]);
for (const [file, target] of aliases) {
  assert.ok(existsSync(resolve(root, file)), `缺少兼容路由: ${file}`);
  assert.ok(source(file).includes(`redirect("${target}")`), `${file} 未直达 ${target}`);
}

const help = source("src/features/youcai-help/youcai-help-center.tsx");
assert.match(help, /onRetry/u);
assert.match(help, /重新加载/u);
assert.match(help, /controller\.abort\(\)/u);
assert.match(help, /读取超时/u);

for (const boundary of [
  "src/app/youcai/inspiration/loading.tsx",
  "src/app/youcai/inspiration/error.tsx",
]) {
  assert.ok(existsSync(resolve(root, boundary)), `缺少灵感路由状态边界: ${boundary}`);
}

console.log(JSON.stringify({
  ok: true,
  inspiration: {
    total: OFFICIAL_INSPIRATION_ITEMS.length,
    musicFilterItems: musicItems.length,
    progressiveBatchSize: 36,
    workbenchPrefillOnly: true,
  },
  snapshotRecovery: ["assets", "profile", "referral"],
  publicNavigation: {
    aliases: aliases.size,
    tvUsesLocalInventory: true,
    retiredNonDeliveryRoutes: ["creative-horizon", "navigation"],
  },
  networkCalls: 0,
  modelCalls: 0,
  paymentCalls: 0,
}, null, 2));
