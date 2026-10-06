import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const projectRoot = process.cwd();
const adminPagePath = path.join(projectRoot, "src/app/admin/page.tsx");
const source = fs.readFileSync(adminPagePath, "utf8");
const workspaceModelsPath = path.join(projectRoot, "src/components/admin/WorkspaceModelsAdminTab.tsx");
const workspaceModelsSource = fs.readFileSync(workspaceModelsPath, "utf8");

assert.match(
  source,
  /const \[activeTab, setActiveTab\] = useState<Tab>\("users"\);/u,
  "裸 /admin 必须在首帧默认进入会员管理",
);
assert.doesNotMatch(
  source,
  /usePersistedState<Tab>\("admin_activeTab"/u,
  "后台主栏目不能再由旧 sessionStorage 状态恢复",
);
assert.match(source, /const \[userSubTab, setUserSubTab\] = useState<UserSubTab>\("members"\);/u);
assert.doesNotMatch(source, /usePersistedState<UserSubTab>/u, "会员管理首屏不能恢复旧子栏目");
assert.match(source, /const validRequestedTab = isValidTab\(requestedTab\) \? requestedTab : null;/u);
assert.match(source, /const candidateTab: Tab \| null = legacyProject \? "workspace-models" : validRequestedTab;/u);
assert.match(
  source,
  /const nextTab = candidateTab && visibleAdminTabSet\.has\(candidateTab\)[\s\S]{0,120}?firstAllowedTab;/u,
  "URL tab 必须经过当前管理员权限过滤并回退到第一个可用栏目",
);
assert.match(source, /sessionStorage\.removeItem\("app_state_admin_activeTab"\)/u);
assert.match(source, /sessionStorage\.removeItem\("app_state_admin_userSubTab"\)/u);
assert.match(source, /if \(nextTab === "users"\) setUserSubTab\("members"\);/u);
assert.match(source, /url\.searchParams\.set\("tab", nextTab\)/u, "后台必须把无效或无权 tab 规范化到精确 URL");

const validTabsMatch = source.match(/const VALID_TABS: Tab\[\] = \[([^\]]+)\];/u);
const navigationMatch = source.match(
  /const ADMIN_PRIMARY_NAVIGATION:[\s\S]+?= \[([\s\S]+?)\n\];\n\nconst ADMIN_TABS_BY_KEY/u,
);
assert.ok(validTabsMatch && navigationMatch, "ADMIN_TAB_COLLECTIONS_NOT_FOUND");

const validTabs = [...validTabsMatch[1].matchAll(/"([^"]+)"/gu)].map((match) => match[1]);
const modules = [...navigationMatch[1].matchAll(
  /\{\s*root:\s*"([^"]+)",\s*title:\s*"([^"]+)",\s*tabs:\s*\[([^\]]*)\]\s*\}/gu,
)].map((match) => ({
  root: match[1],
  title: match[2],
  tabs: [...match[3].matchAll(/"([^"]+)"/gu)].map((tabMatch) => tabMatch[1]),
}));
const mappedTabs = modules.flatMap((module) => module.tabs);

assert.equal(validTabs.length, 27, "当前后台必须登记 27 个 tab");
assert.equal(new Set(validTabs).size, 27, "VALID_TABS 不能包含重复项");
assert.equal(modules.length, 14, "当前桌面后台必须登记 14 个一级模块");
assert.equal(new Set(modules.map((module) => module.root)).size, 14, "一级模块 root 不能重复");
assert.equal(mappedTabs.length, 27, "14 个一级模块必须完整映射 27 个 tab");
assert.equal(new Set(mappedTabs).size, 27, "一级模块之间不能重复映射 tab");
assert.deepEqual(new Set(mappedTabs), new Set(validTabs), "一级模块映射必须与 VALID_TABS 完全一致");

const expectedModules = [
  ["dashboard", "平台指挥中心"],
  ["users", "会员管理"],
  ["benefit-packages", "权益与卡密"],
  ["credits", "财务与账单"],
  ["payment", "支付系统"],
  ["announcements", "公告与通知"],
  ["agents", "智能体管理"],
  ["models", "模型与服务"],
  ["workspace-models", "工作台配置"],
  ["general", "品牌与界面"],
  ["white-label", "域名与贴牌"],
  ["security", "安全审计"],
  ["health", "系统运维"],
  ["super-admin", "权限管理"],
] as const;
assert.deepEqual(
  modules.map(({ root, title }) => [root, title]),
  expectedModules,
  "一级导航模块名称或顺序与当前 14 模块契约不一致",
);
assert.ok(validTabs.includes("white-label"), "域名与贴牌必须是正式后台 tab");
assert.ok(!validTabs.includes("commerce"), "Commerce 不属于本轮通用管理员后台 tab");
assert.ok(!validTabs.includes("manju-workbench"), "漫剧工作台不属于本轮通用管理员后台 tab");

const headerStart = source.indexOf("<header");
const headerEnd = source.indexOf("</header>", headerStart);
assert.ok(headerStart >= 0 && headerEnd > headerStart, "ADMIN_HEADER_NOT_FOUND");
const header = source.slice(headerStart, headerEnd);
assert.match(header, /permissionKeys\.includes\("deployment\.execute"\)/u, "部署入口必须受当前管理员权限控制");
assert.match(header, /部署到线上/u, "全局后台操作区必须保留部署入口");
assert.doesNotMatch(header, /漫剧后台|openAdminTab\("manju-workbench"\)/u, "顶部不能保留独立漫剧后台入口");
assert.match(header, /flex-col gap-3 lg:flex-row/u, "顶部操作区必须支持桌面窗口收窄后的换行");

const navStart = source.indexOf('<nav aria-label="管理后台一级导航"');
const navEnd = source.indexOf("</nav>", navStart);
assert.ok(navStart >= 0 && navEnd > navStart, "ADMIN_DESKTOP_NAV_NOT_FOUND");
const nav = source.slice(navStart, navEnd);
assert.match(nav, /ADMIN_PRIMARY_NAVIGATION\.map/u);
assert.match(nav, /module\.tabs\.filter\(\(tabKey\) => visibleAdminTabSet\.has\(tabKey\)\)/u);
assert.match(nav, /const targetTab = allowedTabs\[0\]/u, "一级模块必须指向当前管理员可见的首个 tab");
assert.match(nav, /aria-current=\{selected \? "page" : undefined\}/u);
assert.match(nav, /text-sm font-semibold/u, "桌面后台导航字体必须保持可读尺寸与字重");
assert.match(nav, /space-y-1/u, "桌面后台导航必须保持左侧纵向模块结构");
assert.match(nav, /min-h-11/u, "桌面后台导航按钮必须有稳定点击高度");
assert.match(
  source,
  /const allowedTabs = activeModule\?\.tabs\.filter\(\(tabKey\) => visibleAdminTabSet\.has\(tabKey\)\) \|\| \[\];/u,
  "二级 tab 必须遵守当前管理员可见范围",
);
assert.doesNotMatch(workspaceModelsSource, /id: "digital-human", label: "数字人"/u, "已退役数字人不能保留工作台配置入口");
assert.match(source, /"digital-human": "video"/u, "旧数字人后台链接必须安全迁移到视频配置");

console.log(JSON.stringify({
  passed: true,
  defaultTab: "users",
  primaryModules: modules.length,
  mappedTabs: mappedTabs.length,
  validTabs: validTabs.length,
  whiteLabelTab: true,
  permissionAwareNavigation: true,
  excludedFromAdminSweep: ["commerce", "manju-workbench"],
  buildStarted: false,
  deploymentStarted: false,
}, null, 2));
