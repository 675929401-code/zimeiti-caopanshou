import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { toYoucaiHref } from "../src/lib/youcai-routes";
import { OFFICIAL_INSPIRATION_ITEMS } from "../src/features/official-inspiration/inspiration-data";

const root = process.cwd();

function source(relativePath: string): string {
  return readFileSync(resolve(root, relativePath), "utf8");
}

function between(input: string, start: string, end: string): string {
  const startIndex = input.indexOf(start);
  const endIndex = input.indexOf(end, startIndex + start.length);
  assert.notEqual(startIndex, -1, `missing block start: ${start}`);
  assert.notEqual(endIndex, -1, `missing block end: ${end}`);
  return input.slice(startIndex, endIndex);
}

function titleHrefItems(block: string): Array<{ title: string; href: string }> {
  return [...block.matchAll(/\{[\s\S]*?\b(?:label|title):\s*"([^"]+)"[\s\S]*?\bhref:\s*"([^"]+)"[\s\S]*?\}/gu)]
    .map((match) => ({ title: match[1], href: match[2] }));
}

function branchRouteExists(href: string): boolean {
  const pathname = new URL(href, "http://youcai.local").pathname;
  if (!pathname.startsWith("/youcai")) return false;
  const directPage = resolve(root, `src/app${pathname}/page.tsx`);
  if (existsSync(directPage)) return true;
  if (/^\/youcai\/tools\/[^/]+\/[^/]+$/u.test(pathname)) {
    return existsSync(resolve(root, "src/app/youcai/tools/[category]/[tool]/page.tsx"));
  }
  if (/^\/youcai\/articles\/[^/]+$/u.test(pathname)) {
    return existsSync(resolve(root, "src/app/youcai/articles/[slug]/page.tsx"));
  }
  return false;
}

const shellSource = source("src/components/app-route-shell.tsx");
const shellCss = source("src/components/app-route-shell.module.css");
const homeSource = source("src/features/official-home/official-home-page.tsx");
const homeCss = source("src/features/official-home/official-home-page.module.css");
const creationSource = source("src/features/official-tool-directory/official-creation-center.tsx");
const directoryCss = source("src/features/official-tool-directory/official-tool-directory.module.css");
const adminSource = source("src/app/admin/page.tsx");

const expectedSidebar = [
  ["个人资产", "/assets"],
  ["Skill 专家", "/skills"],
  ["创作中心", "/tools"],
  ["创作 Agent", "/tools/text/text-chat"],
  ["影视工坊", "/tools/film-studio"],
  ["漫剧画布", "/tools/canvas"],
  ["灵感广场", "/inspiration"],
  ["漫剧TV", "/youcai-tv"],
  ["帮助中心", "/articles"],
  ["积分充值", "/recharge"],
  ["推荐计划", "/referral"],
] as const;

const sidebarBlock = between(shellSource, "const YOUCAI_NAVIGATION_GROUPS", "function Brand");
const sidebarItems = titleHrefItems(sidebarBlock);
assert.deepEqual(
  sidebarItems.map((item) => [item.title, item.href]),
  expectedSidebar.map((item) => [...item]),
  "Youcai sidebar order or target changed",
);

const verifiedScopedTargets = new Set<string>();
for (const [label, href] of expectedSidebar) {
  const scoped = toYoucaiHref(href);
  assert.equal(scoped.startsWith("/youcai"), true, `${label} escaped the Youcai branch: ${scoped}`);
  assert.equal(/^\/youcai\/youcai(?:\/|$)/u.test(scoped), false, `${label} has a duplicated /youcai prefix`);
  assert.equal(branchRouteExists(scoped), true, `${label} target has no page: ${scoped}`);
  verifiedScopedTargets.add(scoped);
}
assert.equal(toYoucaiHref("/youcai/tools"), "/youcai/tools", "pre-scoped route must not be prefixed twice");
assert.equal(
  toYoucaiHref("/login?redirect=%2Fprofile"),
  "/login?redirect=%2Fyoucai%2Fprofile",
  "shared login must stay on the main service while its redirect returns to Youcai",
);
assert.doesNotMatch(sidebarBlock, /视界杯|世界杯|资源导航|creative-horizon|href:\s*"\/navigation"/u, "retired non-delivery navigation must stay hidden");
for (const retiredRoute of [
  "src/app/youcai/creative-horizon/page.tsx",
  "src/app/youcai/navigation/page.tsx",
  "src/app/creative-horizon/page.tsx",
  "src/app/navigation/page.tsx",
]) {
  assert.match(source(retiredRoute), /redirect\("\/youcai"\)/u, `${retiredRoute} must redirect to the Youcai home`);
}

const homeToolBlock = between(homeSource, "const TOOL_CARDS", "const FILM_STAGES");
const homeToolTitles = [...homeToolBlock.matchAll(/\btitle:\s*"([^"]+)"/gu)].map((match) => match[1]);
const activeHomeTools = titleHrefItems(homeToolBlock);
assert.equal(homeToolTitles.length, 5, "home must expose five hot-tool cards");
assert.equal((homeToolBlock.match(/available:\s*true/gu) || []).length, 3, "home must expose exactly three connected hot tools");
assert.equal((homeToolBlock.match(/available:\s*false/gu) || []).length, 2, "home must disclose exactly two pending hot tools");
assert.equal(activeHomeTools.length, 3, "pending home tools must not retain a clickable href");
assert.match(homeSource, /data-disabled="true"/u, "pending home cards must render as disabled articles");
for (const item of activeHomeTools) {
  const scoped = toYoucaiHref(item.href);
  assert.equal(branchRouteExists(scoped), true, `home tool target has no route: ${item.title} -> ${scoped}`);
  verifiedScopedTargets.add(scoped);
}

const inspirationBlock = between(homeSource, "const INSPIRATION_SPOTLIGHT_IDS", "] as const;");
const inspirationIds = [...inspirationBlock.matchAll(/"([A-Za-z0-9_-]+)"/gu)].map((match) => match[1]);
assert.equal(inspirationIds.length, 4, "home inspiration collection must keep four cards");
const inspirationCatalogIds = new Set(OFFICIAL_INSPIRATION_ITEMS.map((item) => item.id));
for (const id of inspirationIds) {
  assert.equal(inspirationCatalogIds.has(id), true, `home inspiration entity is missing from the active catalog: ${id}`);
  const scoped = toYoucaiHref(`/inspiration?item=${encodeURIComponent(id)}`);
  assert.equal(branchRouteExists(scoped), true, `home inspiration target has no route: ${scoped}`);
  verifiedScopedTargets.add(new URL(scoped, "http://youcai.local").pathname);
}

const categoryBlock = between(homeSource, "const CREATIVE_CATEGORIES", "function HomeHero");
const categoryItems = titleHrefItems(categoryBlock);
assert.equal(categoryItems.length, 5, "home creation collection must keep five cards");
for (const item of categoryItems) {
  const scoped = toYoucaiHref(item.href);
  assert.equal(branchRouteExists(scoped), true, `home category target has no route: ${item.title} -> ${scoped}`);
  verifiedScopedTargets.add(scoped);
}

const creationBlock = between(creationSource, "const CREATION_ENTRIES", "export function OfficialCreationCenter");
const creationItems = titleHrefItems(creationBlock);
assert.equal(creationItems.length, 6, "creation center must keep six category cards");
for (const item of creationItems) {
  const scoped = toYoucaiHref(item.href);
  assert.equal(branchRouteExists(scoped), true, `creation-center target has no route: ${item.title} -> ${scoped}`);
  verifiedScopedTargets.add(scoped);
}

assert.match(directoryCss, /\.categoryTabs[\s\S]*?overflow-x:\s*auto/gu, "tool category tabs must scroll horizontally on narrow screens");
assert.match(directoryCss, /\.filterGroup[\s\S]*?overflow-x:\s*auto/gu, "tool filters must scroll horizontally on narrow screens");
assert.match(shellCss, /\[data-youcai="true"\] \.navigation[\s\S]*?overscroll-behavior-y:\s*contain/u, "branch sidebar must own its vertical scroll");
assert.match(shellCss, /@media \(max-width:\s*767px\)[\s\S]*?\.main[\s\S]*?margin-left:\s*0/u, "mobile shell must not reserve desktop sidebar width");
assert.match(homeCss, /@media \(max-width:\s*767px\)/u, "home must keep a narrow-screen layout");

assert.match(adminSource, /import \{ ManjuWorkbenchAdminTab \}/u, "admin must import the Manju workbench tab");
assert.match(adminSource, /key:\s*"manju-workbench",\s*label:\s*"漫剧工作台"/u, "admin must expose the 漫剧工作台 tab label");
assert.match(adminSource, /activeTab === "manju-workbench"[\s\S]*?<ManjuWorkbenchAdminTab/u, "admin must render the Manju workbench tab");

console.log(JSON.stringify({
  ok: true,
  sidebarRoutes: sidebarItems.length,
  uniqueVerifiedBranchTargets: verifiedScopedTargets.size,
  homeCards: {
    hotTotal: homeToolTitles.length,
    hotClickable: activeHomeTools.length,
    hotPending: homeToolTitles.length - activeHomeTools.length,
    inspiration: inspirationIds.length,
    inspirationEntityReferencesValid: true,
    creationCategories: categoryItems.length,
  },
  creationCenterCards: creationItems.length,
  retiredRoutes: ["/youcai/creative-horizon", "/youcai/navigation", "/creative-horizon", "/navigation"],
  adminManjuWorkbenchStaticAssertion: true,
  networkCalls: 0,
  modelCalls: 0,
}, null, 2));
