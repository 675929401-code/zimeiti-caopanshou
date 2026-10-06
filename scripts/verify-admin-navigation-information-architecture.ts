import fs from "node:fs";
import path from "node:path";

const projectRoot = process.cwd();
const adminPagePath = path.join(projectRoot, "src", "app", "admin", "page.tsx");
const source = fs.readFileSync(adminPagePath, "utf8");
const integrationSettingsSource = fs.readFileSync(
  path.join(projectRoot, "src", "components", "admin", "integration-settings-admin-tab.tsx"),
  "utf8",
);

function requireMatch(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function blockBetween(start: string, end: string) {
  const startIndex = source.indexOf(start);
  requireMatch(startIndex >= 0, `缺少源码区块：${start}`);
  const endIndex = source.indexOf(end, startIndex + start.length);
  requireMatch(endIndex > startIndex, `源码区块未闭合：${start}`);
  return source.slice(startIndex, endIndex);
}

const expectedModules = [
  { root: "dashboard", title: "平台指挥中心", tabs: ["dashboard"] },
  { root: "users", title: "会员管理", tabs: ["users", "invitations"] },
  { root: "benefit-packages", title: "权益与卡密", tabs: ["benefit-packages", "cami"] },
  { root: "credits", title: "财务与账单", tabs: ["credits", "offline-payments", "billing-audit"] },
  { root: "payment", title: "支付系统", tabs: ["payment"] },
  { root: "announcements", title: "公告与通知", tabs: ["announcements"] },
  { root: "agents", title: "智能体管理", tabs: ["agents", "aiweb-import", "trash"] },
  { root: "models", title: "模型与服务", tabs: ["models", "connection"] },
  { root: "workspace-models", title: "工作台配置", tabs: ["workspace-models"] },
  { root: "general", title: "品牌与界面", tabs: ["general", "theme", "layout"] },
  { root: "white-label", title: "域名与贴牌", tabs: ["white-label"] },
  { root: "security", title: "安全审计", tabs: ["security", "guard-logs", "login-logs"] },
  { root: "health", title: "系统运维", tabs: ["health", "sync", "backup"] },
  { root: "super-admin", title: "权限管理", tabs: ["super-admin"] },
] as const;

const navigationBlock = blockBetween(
  "const ADMIN_PRIMARY_NAVIGATION:",
  "const ADMIN_TABS_BY_KEY",
);
const validTabsBlock = blockBetween("const VALID_TABS:", "/** 校验 sessionStorage");
const primaryLabels = [...navigationBlock.matchAll(/title:\s*"([^"]+)"/gu)].map((match) => match[1]);
const expectedPrimaryNavigation = expectedModules.map((navModule) => navModule.title);

requireMatch(
  JSON.stringify(primaryLabels) === JSON.stringify(expectedPrimaryNavigation),
  `一级导航顺序不正确：${primaryLabels.join(" / ")}`,
);

for (const navModule of expectedModules) {
  const expectedLine = `{ root: "${navModule.root}", title: "${navModule.title}", tabs: [${navModule.tabs.map((tab) => `"${tab}"`).join(", ")}] }`;
  requireMatch(navigationBlock.includes(expectedLine), `一级导航映射不正确：${navModule.root}`);
  for (const tab of navModule.tabs) {
    requireMatch(validTabsBlock.includes(`"${tab}"`), `导航引用了未兼容的 tab key：${tab}`);
  }
}

const mappedTabs = expectedModules.flatMap((navModule) => [...navModule.tabs]);
requireMatch(expectedModules.length === 14, `一级导航模块数量不正确：${expectedModules.length}`);
requireMatch(mappedTabs.length === 27, `后台 tab 数量不正确：${mappedTabs.length}`);
requireMatch(new Set(expectedModules.map((navModule) => navModule.root)).size === expectedModules.length, "一级导航 root 重复");
requireMatch(new Set(mappedTabs).size === mappedTabs.length, "同一个正式 tab 被放进多个一级导航");
requireMatch(expectedModules.some((navModule) => navModule.root === "payment" && navModule.tabs.length === 1), "支付系统必须是可直达的独立一级入口");
requireMatch(!expectedModules.some((navModule) => navModule.title.includes("邮箱")), "邮箱/SMTP 不应成为独立一级入口");

for (const legacyTab of ["commerce", "digital-human", "voice-studio", "manju-workbench", "plugins", "canvas-prompts"]) {
  requireMatch(!validTabsBlock.includes(`"${legacyTab}"`), `旧工作台映射仍被当成正式 tab：${legacyTab}`);
  const escapedLegacyTab = legacyTab.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  requireMatch(new RegExp(`(?:"${escapedLegacyTab}"|${escapedLegacyTab}):\\s*"`, "u").test(source), `旧书签缺少一次性 URL 迁移：${legacyTab}`);
}
requireMatch(source.includes("const LEGACY_WORKSPACE_TAB_PROJECT"), "旧工作台深链兼容映射被移除");
requireMatch(source.includes('"canvas-prompts": "storyboard"'), "旧画布提示词深链没有映射到真实分镜工作台配置");
requireMatch(!source.includes('{ key: "canvas-prompts"'), "已退役画布提示词空壳被重新放回后台导航");
requireMatch(!validTabsBlock.includes('"trial-plans"'), "试用套餐仍被当成正式 tab");
requireMatch(!source.includes('{ key: "trial-plans"'), "试用套餐仍在 TABS 列表");
requireMatch(!source.includes('activeTab === "trial-plans"'), "试用套餐仍有前端渲染分支");
for (const retiredTab of ["commerce", "voice-studio", "manju-workbench", "plugins"]) {
  requireMatch(!source.includes(`{ key: "${retiredTab}"`), `旧工作台入口仍在 TABS 列表：${retiredTab}`);
}
requireMatch(!source.includes("<CanvasPromptPresetsTab"), "已退役画布提示词组件被重新挂载");
requireMatch(source.includes('{ key: "connection", label: "模型与外部服务"'), "connection 稳定 key 未显示为“模型与外部服务”");
requireMatch(!source.includes('label: "平台连接"'), "导航仍显示旧名称“平台连接”");
requireMatch(!source.includes('>平台连接</h2>'), "连接页标题仍显示旧名称“平台连接”");

requireMatch(source.includes('aria-label="管理后台一级导航"'), "桌面端一级导航缺少清晰语义");
requireMatch(source.includes("ADMIN_PRIMARY_NAVIGATION.map((module) =>"), "一级导航未由统一信息架构驱动");
requireMatch(source.includes("const selected = allowedTabs.includes(activeTab);"), "一级导航未按子 tab 维持选中态");
requireMatch(source.includes("const allowedTabs = module.tabs.filter((tabKey) => visibleAdminTabSet.has(tabKey));"), "一级导航没有保留权限判断");
requireMatch(source.includes("onClick={() => openAdminTab(targetTab)}"), "一级导航没有保留稳定 tab 深链入口");
requireMatch(source.includes("const allowedTabs = activeModule?.tabs.filter((tabKey) => visibleAdminTabSet.has(tabKey)) || [];"), "二级导航没有按权限过滤");
requireMatch(source.includes("if (!activeModule || allowedTabs.length <= 1) return null;"), "单页一级模块仍重复显示空洞二级导航");
requireMatch(source.includes("ADMIN_SECONDARY_LABELS[tabKey] || tab.label"), "二级功能名称未和稳定 tab key 分离");
requireMatch(!source.includes("视频平台通知"), "无前台消费者的视频平台通知编辑器仍在后台");
requireMatch(!source.includes("历史品牌色配置"), "不生效的历史品牌色编辑器仍在后台");
requireMatch(!source.includes("恢复历史配置示例"), "不生效的历史主题恢复入口仍在后台");
requireMatch(!source.includes("推理模型连接"), "没有运行消费者的推理模型配置仍在后台");
requireMatch(!source.includes("视频文案提取连接"), "没有运行消费者的文案提取配置仍在后台");
requireMatch(!source.includes("填写下方\"编程连接\""), "后台仍引导管理员填写已退役的全局编程连接");
requireMatch(integrationSettingsSource.includes("邮件服务配置"), "注册和登录验证码所需的 SMTP 配置被误删");
requireMatch(integrationSettingsSource.includes("注册验证码/登录验证码发送"), "SMTP 配置缺少实际业务用途说明");

console.log(JSON.stringify({
  passed: true,
  primaryNavigation: expectedPrimaryNavigation,
  primaryCount: expectedPrimaryNavigation.length,
  mappedTabCount: mappedTabs.length,
  mappedTabs,
  legacyDeepLinksPreserved: true,
  permissionAwareEntrySelection: true,
  connectionDisplayName: "模型与外部服务",
  retiredDeadEditors: ["历史品牌色", "全局编程连接", "推理模型连接", "视频文案提取连接"],
  retainedEmbeddedServices: ["SMTP 注册/登录验证码"],
}, null, 2));
