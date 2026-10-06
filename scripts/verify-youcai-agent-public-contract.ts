import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const routePath = join(root, "src/features/official-core-routes/official-agent-route.tsx");
const stylePath = join(root, "src/features/official-core-routes/official-agent-route.module.css");
const publicPagesPath = join(root, "src/features/official-public-pages/official-tv-page.tsx");

const route = readFileSync(routePath, "utf8");
const style = readFileSync(stylePath, "utf8");
const publicPages = readFileSync(publicPagesPath, "utf8");

function requireText(source: string, needle: string, label: string) {
  assert.ok(source.includes(needle), `${label}: missing ${needle}`);
}

for (const [testId, panel] of [
  ["agent-wechat-control", "wechat"],
  ["agent-authorization-control", "authorization"],
  ["agent-memory-control", "memory"],
] as const) {
  requireText(route, `data-testid="${testId}"`, `top control ${panel}`);
  requireText(route, `openControlPanel("${panel}")`, `top control ${panel}`);
}

for (const endpoint of [
  "/api/text-chat/weixin-binding",
  "/api/text-chat/memories",
  "/api/text-chat/conversations/",
]) {
  requireText(route, endpoint, "official read contract");
}

const controlStart = route.indexOf("async function openControlPanel");
const controlEnd = route.indexOf("function rememberComposerSelection", controlStart);
assert.ok(controlStart >= 0 && controlEnd > controlStart, "control panel implementation must be present");
const controlImplementation = route.slice(controlStart, controlEnd);
requireText(controlImplementation, 'method: "PATCH" | "DELETE"', "bounded same-app mutation contract");
assert.match(
  controlImplementation,
  /mutateControl\(\s*`\/api\/text-chat\/conversations\/\$\{encodeURIComponent\(activeConversation\.id\)\}`,\s*"PATCH"/u,
  "owned conversation authorization mutation",
);
requireText(controlImplementation, 'mutateControl("/api/text-chat/memories", "PATCH"', "owned memory update mutation");
requireText(controlImplementation, 'mutateControl(`/api/text-chat/memories?id=${encodeURIComponent(memoryId)}`, "DELETE"', "owned memory delete mutation");
requireText(controlImplementation, 'mutateControl("/api/text-chat/memories?all=true", "DELETE"', "owned memory clear mutation");
assert.ok(!controlImplementation.includes('mutateControl("/api/text-chat/weixin-binding'), "disabled WeChat control must not invent binding mutations");
assert.ok(!/\/api\/(?:llm|image|video|audio)|billing|credits_charged/iu.test(controlImplementation), "account-control mutations must remain zero-cost");
requireText(route, "agent-control-fail-closed", "fail-closed state");
requireText(route, "不会跳转主站或伪造已连接、已授权、已有记忆", "fail-closed copy");
assert.ok(!route.includes('router.push("/profile")'), "account controls must not jump to the main-site profile");

for (const trigger of [
  "agent-command-trigger",
  "agent-shortcut-trigger",
  "agent-asset-trigger-image",
  "agent-asset-trigger-video",
  "agent-asset-trigger-audio",
]) {
  requireText(route, `data-testid="${trigger}"`, "five composer entry points");
}

requireText(route, "/api/storage/files?category=${assetPickerKind}", "personal asset inventory");
requireText(route, "/api/storage/files/${encodeURIComponent(candidate.id)}/content", "same-site asset content");
requireText(route, "requiresAuth: true", "owned asset read contract");
for (const label of ["引用个人图片", "引用个人视频", "引用个人音频"]) {
  requireText(route, label, "personal asset entry");
}
assert.ok(!route.includes("OFFICIAL_INSPIRATION_ITEMS"), "personal asset picker must not mix inspiration cards");
assert.ok(!route.includes("assetSource"), "removed asset-source switch must stay removed");
for (const feature of ["assetQuery", "assetCategory", "assetSort", "favoriteAssetSet", "previewAssetId", "chooseAsset(asset)"]) {
  requireText(route, feature, "asset picker behavior");
}

for (const className of [
  ".controlDialog",
  ".controlUnavailable",
  ".authorizationSwitch",
  ".memoryList",
]) {
  requireText(style, className, "agent styles");
}
assert.ok(!style.includes(".assetSourceTabs"), "removed asset-source styles must stay removed");

requireText(publicPages, 'title: "漫剧TV"', "branch TV brand");
assert.ok(!publicPages.includes('title: "有彩TV"'), "legacy TV brand must be removed from branch page");
assert.ok(!publicPages.includes('title: "创作视界"'), "legacy contest brand must be removed from branch page");

console.log(JSON.stringify({
  ok: true,
  verified: {
    topAccountControls: 3,
    composerEntryPoints: 5,
    assetSources: ["personal"],
    mutationContracts: ["conversation-authorization-patch", "memory-patch", "memory-delete", "memory-clear"],
    weixinMutationRequests: 0,
    paidRequests: 0,
    branchBrands: ["漫剧TV"],
  },
}, null, 2));
