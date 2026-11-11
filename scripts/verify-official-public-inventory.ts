import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  OFFICIAL_TOOL_ALIASES,
  type OfficialToolAliasDefinition,
} from "../src/features/official-tool-aliases/official-tool-alias-map";
import { TOOL_CATEGORIES } from "../src/features/official-tool-directory/tool-directory-data";

const compatibleTargets = new Map([
  ["/tools/video/video-chat", "/video"],
  ["/tools/video/seedance-video", "/video"],
  ["/tools/video/minimax-video", "/video"],
] as const);

const unavailablePaths = [
  "/tools/video/jimeng-dreamactor-m20",
  "/tools/video/jimeng-omnihuman-v15",
  "/tools/video/happyhorse-video-edit",
  "/tools/video/pippit-video",
  "/tools/video/pippit-video-2",
  "/tools/video/pippit-marketing",
  "/tools/video/aliyun-super-resolve",
  // 独立 AI 生图工作台已下线：这些图片生成别名不再暴露生成落地页。
  "/tools/image/image-edit",
  "/tools/image/kling-image",
  "/tools/image/qwen-image",
  "/tools/image/volcengine-image",
] as const;

const expectedHomeTools = [
  "对话式视频创作",
  "图片生成 - 对话式",
  "音乐创作",
  "即梦AI-智能超清",
  "视频生成 - 即梦动作模仿2.0",
] as const;

const expectedResources = [
  "MiniMax Design",
  "Doubao Seedance 2.5 提示词指南",
  "即梦 Seedream 5.0 Pro 用户手册",
  "抖音短剧创作者中心",
  "Seedance 2.0 系列提示词指南",
  "Ofox API",
  "MiniMax H3 模型 - 使用手册",
  "MiMo 开放平台",
  "Hermes Agent",
  "Arena AI",
  "Artificial Analysis",
  "万镜一刻",
  "可灵视频 3.0 模型使用指南",
  "可灵图片模型Omni 3.0使用指南",
  "LibTV",
  "小云雀",
  "可灵AI",
  "MiniMax Token Plan",
  "智谱 Coding Plan",
  "豆包",
  "万相文生图提示词指南",
  "万相视频创作提示词指南",
  "即梦AI",
  "TapNow",
  "Seedream图片提示词指南",
  "Seedance视频提示词指南",
] as const;

const aliases = new Map<string, OfficialToolAliasDefinition>(
  OFFICIAL_TOOL_ALIASES.map((item) => [item.officialPath, item]),
);
assert.equal(aliases.size, OFFICIAL_TOOL_ALIASES.length, "official tool aliases must be unique");

for (const [path, targetHref] of compatibleTargets) {
  const alias = aliases.get(path);
  assert.ok(alias, `missing compatible alias: ${path}`);
  assert.equal(alias.status, "compatible", `${path} must remain a compatible mapping`);
  assert.equal(alias.targetHref, targetHref, `${path} must land on ${targetHref}`);
  assert.match(alias.boundary, /不保证/, `${path} must disclose its provider or pricing boundary`);
}

for (const path of unavailablePaths) {
  const alias = aliases.get(path);
  assert.ok(alias, `missing unavailable alias: ${path}`);
  assert.equal(alias.status, "unavailable", `${path} must remain unavailable`);
  assert.equal(alias.targetHref, undefined, `${path} must not expose a generation target`);
}

const directoryCards = Object.values(TOOL_CATEGORIES).flatMap((category) => category.tools);
const directoryByPath = new Map(directoryCards.map((card) => [card.officialPath, card]));

for (const path of compatibleTargets.keys()) {
  const card = directoryByPath.get(path);
  assert.ok(card, `missing directory card: ${path}`);
  assert.equal(card.availability, "available", `${path} card must be available`);
  assert.equal(card.href, path, `${path} card must use its exact same-slug route`);
}

for (const path of unavailablePaths) {
  const card = directoryByPath.get(path);
  assert.ok(card, `missing directory card: ${path}`);
  assert.ok(["coming", "retired"].includes(card.availability), `${path} card must be unavailable`);
  assert.equal(card.href, undefined, `${path} card must not bypass its unavailable alias`);
}

function extractOrderedTitles(source: string, blockPattern: RegExp): string[] {
  const block = source.match(blockPattern)?.[1];
  assert.ok(block, "expected source array block was not found");
  return [...block.matchAll(/\btitle:\s*"([^"]+)"/g)].map((match) => match[1]);
}

const homeSource = readFileSync(
  resolve(process.cwd(), "src/features/official-home/official-home-page.tsx"),
  "utf8",
);
const homeTitles = extractOrderedTitles(
  homeSource,
  /const TOOL_CARDS = \[([\s\S]*?)\]\s+(?:as const|satisfies readonly HomeToolCard\[\])\s*;/,
);
assert.deepEqual(homeTitles, [...expectedHomeTools], "home hot tools must match the current official order");

const publicSource = readFileSync(
  resolve(process.cwd(), "src/features/official-public-pages/official-resource-navigation-page.tsx"),
  "utf8",
);
const resourceTitles = extractOrderedTitles(
  publicSource,
  /const RESOURCE_ITEMS:[\s\S]*?= \[([\s\S]*?)\];\r?\n\r?\nconst GROUP_ORDER/,
);
assert.deepEqual(resourceTitles, [...expectedResources], "resource navigation must match the 26-item official order");
const publicSharedSource = readFileSync(
  resolve(process.cwd(), "src/features/official-public-pages/official-public-page-shared.tsx"),
  "utf8",
);
assert.match(publicSharedSource, /href="\/about">关于我们<\/AppScopedLink>/, "about footer must target /about");
assert.match(publicSharedSource, /href="\/business">商务合作<\/AppScopedLink>/, "business footer must target /business");

console.log("PASS official public inventory alignment");
const aliasStatusCounts = OFFICIAL_TOOL_ALIASES.reduce<Record<string, number>>((counts, alias) => {
  counts[alias.status] = (counts[alias.status] || 0) + 1;
  return counts;
}, {});
console.log(`aliases=${OFFICIAL_TOOL_ALIASES.length} compatible=${aliasStatusCounts.compatible || 0} unavailable=${aliasStatusCounts.unavailable || 0}`);
console.log("home_hot_tools=5 resources=26 footer_links=2");
console.log("paid_calls=0 network_calls=0");
