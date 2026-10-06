import {
  adminPlatformSettingPermission,
  isAdminPlatformSettingScope,
} from "@/lib/platform-settings-contract";
import {
  COMMAND_CENTER_ALL_PERMISSION_KEYS,
  COMMAND_CENTER_ENTRY_PERMISSION_KEYS,
  commandCenterPermissionKeysForView,
  normalizeCommandCenterView,
} from "@/lib/admin-command-center-domain";

export type AdminLevel = "super_admin" | "admin";

export const ADMIN_STEP_UP_COOKIE = "zimeiti_admin_step_up";
export const ADMIN_STEP_UP_TTL_SECONDS = 10 * 60;

export interface AdminPermissionDefinition {
  key: string;
  group: string;
  label: string;
  description: string;
  risk: "normal" | "sensitive" | "critical";
  stepUpRequired: boolean;
}

export const ADMIN_PERMISSION_CATALOG: readonly AdminPermissionDefinition[] = [
  { key: "admin.accounts.manage", group: "超级管理", label: "管理员与授权", description: "新增、停用管理员，修改管理员资料与后台权限。", risk: "critical", stepUpRequired: true },
  { key: "members.view", group: "会员与经营", label: "查看会员", description: "查看会员档案、状态与基础使用数据。", risk: "normal", stepUpRequired: false },
  { key: "member_content.view", group: "会员与经营", label: "查看会员内容", description: "查看会员聊天、作品与其私有媒体；下载或导出仍需二次确认。", risk: "sensitive", stepUpRequired: false },
  { key: "members.manage", group: "会员与经营", label: "编辑会员", description: "编辑会员资料、状态、套餐与账户恢复信息。", risk: "sensitive", stepUpRequired: true },
  { key: "members.delete", group: "会员与经营", label: "删除会员", description: "删除会员及其关联数据。", risk: "critical", stepUpRequired: true },
  { key: "member_permissions.manage", group: "会员与经营", label: "会员功能权限", description: "设置会员业务导航与智能体分类访问范围。", risk: "sensitive", stepUpRequired: true },
  { key: "invitations.manage", group: "会员与经营", label: "邀请关系与礼包", description: "查看邀请归因并决定、发放注册与正式会员奖励。", risk: "sensitive", stepUpRequired: true },
  { key: "packages.manage", group: "会员与经营", label: "套餐与试用", description: "维护套餐模板、开通套餐和试用策略。", risk: "sensitive", stepUpRequired: true },
  { key: "cards.manage", group: "会员与经营", label: "卡密系统", description: "生成、绑定、推送、兑换管理和作废卡密。", risk: "critical", stepUpRequired: true },
  { key: "billing.view", group: "资金与对账", label: "查看资金与账单", description: "查看余额、充值、消费、支付和对账记录。", risk: "normal", stepUpRequired: false },
  { key: "wallet.adjust", group: "资金与对账", label: "充值与调账", description: "给会员增加或扣减积分、现金并补录线下收款。", risk: "critical", stepUpRequired: true },
  { key: "billing.export", group: "资金与对账", label: "导出账单", description: "下载会员、邀请、充值、消费及公司对账数据。", risk: "critical", stepUpRequired: true },
  { key: "agents.view", group: "智能体与模型", label: "查看智能体", description: "查看智能体清单和非敏感运行配置。", risk: "normal", stepUpRequired: false },
  { key: "agents.manage", group: "智能体与模型", label: "管理智能体", description: "新增、上下架、排序、迁移和删除智能体。", risk: "sensitive", stepUpRequired: true },
  { key: "prompts.view", group: "智能体与模型", label: "查看内部提示词", description: "查看系统提示词、历史版本和内部知识资产。", risk: "critical", stepUpRequired: true },
  { key: "prompts.edit", group: "智能体与模型", label: "编辑内部提示词", description: "修改提示词、版本和防泄露策略。", risk: "critical", stepUpRequired: true },
  { key: "internal_tools.manage", group: "智能体与模型", label: "内部工具分类", description: "维护仅内部人员可见的智能体分类和入口。", risk: "critical", stepUpRequired: true },
  { key: "models.view", group: "智能体与模型", label: "查看模型资源", description: "查看模型目录、状态和脱敏后的渠道配置。", risk: "normal", stepUpRequired: false },
  { key: "models.manage", group: "智能体与模型", label: "管理模型与密钥", description: "新增模型、修改渠道、密钥、计费和发布状态。", risk: "critical", stepUpRequired: true },
  { key: "platform.settings.manage", group: "平台与界面", label: "平台基础规则", description: "修改跨业务的基础运行参数；不包含品牌、支付、外部连接和贴牌发布。", risk: "sensitive", stepUpRequired: true },
  { key: "brand.settings.manage", group: "平台与界面", label: "品牌与界面", description: "维护平台名称、品牌图片、主题与卡片布局，并执行品牌版本发布或回滚。", risk: "sensitive", stepUpRequired: true },
  { key: "integrations.manage", group: "平台与界面", label: "外部连接", description: "维护邮件、插件、外部平台和服务连接及其脱敏凭据。", risk: "critical", stepUpRequired: true },
  { key: "payment.settings.manage", group: "资金与对账", label: "支付系统配置", description: "维护支付渠道、商户号、密钥、网关和支付方式。", risk: "critical", stepUpRequired: true },
  { key: "white_label.manage", group: "平台与界面", label: "域名与贴牌", description: "管理租户边界、域名认领、DNS、TLS 和品牌绑定发布。", risk: "critical", stepUpRequired: true },
  { key: "announcements.manage", group: "平台与界面", label: "公告与通知", description: "创建、推送和撤回系统公告与站内通知。", risk: "sensitive", stepUpRequired: true },
  { key: "security.view", group: "安全与运维", label: "查看安全中心", description: "查看安全事件、提示词拦截和登录日志。", risk: "normal", stepUpRequired: false },
  { key: "security.manage", group: "安全与运维", label: "安全策略", description: "调整安全规则、敏感策略和平台操作密码。", risk: "critical", stepUpRequired: true },
  { key: "logs.view", group: "安全与运维", label: "查看运行日志", description: "查看全链路运行、故障、性能和操作日志。", risk: "normal", stepUpRequired: false },
  { key: "logs.export", group: "安全与运维", label: "导出日志", description: "下载登录、安全、运行和管理员审计记录。", risk: "critical", stepUpRequired: true },
  { key: "backups.manage", group: "安全与运维", label: "备份与同步", description: "执行数据导入、导出、备份、恢复与同步。", risk: "critical", stepUpRequired: true },
  { key: "deployment.execute", group: "安全与运维", label: "发布与部署", description: "触发受审计的版本发布或部署入口。", risk: "critical", stepUpRequired: true },
] as const;

export const ADMIN_PERMISSION_KEYS = ADMIN_PERMISSION_CATALOG.map((permission) => permission.key);

export const ADMIN_COMMAND_CENTER_PERMISSION_KEYS = COMMAND_CENTER_ALL_PERMISSION_KEYS;

const PERMISSION_KEY_SET = new Set(ADMIN_PERMISSION_KEYS);

export function normalizeAdminPermissionKeys(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const requested = new Set(value.filter((item): item is string => typeof item === "string"));
  return ADMIN_PERMISSION_KEYS.filter((key) => requested.has(key));
}

export function isAdminPermissionKey(value: unknown): value is string {
  return typeof value === "string" && PERMISSION_KEY_SET.has(value);
}

export interface AdminPermissionAnyRequirement {
  anyOf: readonly string[];
}

export type AdminPermissionRequirement = string | readonly string[] | AdminPermissionAnyRequirement;

export const ADMIN_TAB_PERMISSIONS: Readonly<Record<string, AdminPermissionRequirement>> = {
  "super-admin": "admin.accounts.manage",
  users: "members.view",
  invitations: "invitations.manage",
  "benefit-packages": "packages.manage",
  cami: "cards.manage",
  "login-logs": "security.view",
  credits: "wallet.adjust",
  "offline-payments": "billing.view",
  "billing-audit": "billing.view",
  payment: "payment.settings.manage",
  agents: "agents.view",
  trash: "agents.manage",
  models: "models.view",
  "workspace-models": "models.view",
  "aiweb-import": "agents.manage",
  general: "brand.settings.manage",
  theme: "brand.settings.manage",
  layout: "brand.settings.manage",
  "white-label": "white_label.manage",
  connection: "integrations.manage",
  announcements: "announcements.manage",
  dashboard: { anyOf: COMMAND_CENTER_ENTRY_PERMISSION_KEYS },
  security: "security.view",
  "guard-logs": "security.view",
  health: "logs.view",
  sync: "backups.manage",
  backup: "backups.manage",
};

export function adminPermissionKeysForTab(tab: string): readonly string[] {
  const requirement = ADMIN_TAB_PERMISSIONS[tab];
  if (!requirement) return [];
  if (typeof requirement === "string") return [requirement];
  return "anyOf" in requirement ? requirement.anyOf : requirement;
}

export function missingAdminPermissionKeys(
  grantedPermissionKeys: readonly string[],
  requiredPermissionKeys: readonly string[],
): string[] {
  const granted = new Set(grantedPermissionKeys);
  return requiredPermissionKeys.filter((permissionKey) => !granted.has(permissionKey));
}

export function hasAdminPermissionRequirement(
  grantedPermissionKeys: readonly string[],
  requirement: AdminPermissionRequirement,
): boolean {
  const granted = new Set(grantedPermissionKeys);
  if (typeof requirement === "string") return granted.has(requirement);
  if ("anyOf" in requirement) return requirement.anyOf.some((permissionKey) => granted.has(permissionKey));
  return requirement.every((permissionKey) => granted.has(permissionKey));
}

export interface AdminApiRequirement {
  permission: string;
  requireStepUp: boolean;
  operation: string;
}

export const ADMIN_SKILL_SOURCE_QUERY_KEY = "include_source";
export const ADMIN_SKILL_SOURCE_PERMISSIONS = {
  skills: "internal_tools.manage",
  skillPackages: "prompts.view",
} as const;
export const ADMIN_SKILL_WRITE_PERMISSIONS = {
  skills: "internal_tools.manage",
  skillPackages: "prompts.edit",
} as const;

export function adminSkillSourceRequested(searchParams?: URLSearchParams): boolean {
  const value = searchParams?.get(ADMIN_SKILL_SOURCE_QUERY_KEY)?.trim().toLowerCase();
  return value === "1" || value === "true";
}

export interface AdminAccessClientState {
  access: {
    authorityStatus: string;
    integrityValid: boolean;
    adminLevel: AdminLevel | null;
    permissionKeys: string[];
    revision: number;
    profileActive: boolean;
    updatedAt: string | null;
  };
  stepUp: {
    status: string;
    expiresAt: string | null;
    authMethod: "login_password" | "management_password" | null;
  };
  maintenanceLock: {
    status: string;
    enabled: boolean;
    revision: number;
    enabledAt: string | null;
    expiresAt: string | null;
    enableReason: string;
    disabledAt: string | null;
    disableReason: string;
    maxDurationMinutes: number;
  };
  tabAccess: Record<string, boolean>;
  managementPasswordSet: boolean;
  catalog: readonly AdminPermissionDefinition[];
}

function isWrite(method: string): boolean {
  return !["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase());
}

/**
 * Central API policy. Unknown /api/admin routes fall into the owner-only
 * admin.accounts.manage capability and require step-up. That permission is
 * never delegable, so a newly added route cannot become reachable merely
 * because an employee administrator has platform.settings.manage.
 */
export function adminRequirementForRequest(
  pathname: string,
  method: string,
  searchParams?: URLSearchParams,
): AdminApiRequirement | null {
  const write = isWrite(method);
  if (pathname.startsWith("/api/admin/access-control/self") || pathname.startsWith("/api/admin/access-control/unlock")) return null;
  if (pathname === "/api/admin/security-events/internal") return null;
  // manju-config resolves its capability from the requested configuration
  // domain (prompt, skill, agent/workflow, model policy, UI/content/media).
  // A single proxy permission would either leak a domain or block legitimate
  // least-privilege roles, so this route owns the fail-closed composite check.
  if (pathname.startsWith("/api/admin/manju-config")) return null;
  if (pathname === "/api/deploy") return { permission: "deployment.execute", requireStepUp: true, operation: "deployment" };
  if (pathname === "/api/settings/operation-password") return { permission: "security.manage", requireStepUp: write, operation: "operation_password" };
  if (pathname === "/api/settings/admin") {
    const scope = searchParams?.get("scope");
    // Missing/invalid scope is rejected by the route before any setting is
    // read. Valid scopes get the same field-level permission at both proxy and
    // route layers, so a brand administrator is not blocked by an unrelated
    // platform-wide permission and cannot cross into another settings domain.
    if (!isAdminPlatformSettingScope(scope)) return null;
    const mode = write ? "write" : "read";
    return {
      permission: adminPlatformSettingPermission(scope, mode),
      requireStepUp: true,
      operation: `platform_settings_${scope}_${mode}`,
    };
  }
  if (write && pathname === "/api/settings/layout") return { permission: "brand.settings.manage", requireStepUp: true, operation: "brand_layout_settings" };
  if (write && pathname === "/api/settings/ui-preferences") return { permission: "brand.settings.manage", requireStepUp: true, operation: "brand_navigation_preferences" };
  if (write && pathname === "/api/settings/video-page") return { permission: "brand.settings.manage", requireStepUp: true, operation: "brand_video_page_settings" };
  if (pathname === "/api/storyboard/agent") return {
    permission: write ? "prompts.edit" : "prompts.view",
    requireStepUp: true,
    operation: write ? "storyboard_prompt_update" : "storyboard_prompt_read",
  };
  if (pathname === "/api/voice/nest/authorize") return {
    permission: write ? "member_permissions.manage" : "members.view",
    requireStepUp: write,
    operation: write ? "voice_nest_member_authorization" : "voice_nest_member_list",
  };
  if (pathname === "/api/extract/reconciliation") return {
    permission: write ? "wallet.adjust" : "billing.view",
    requireStepUp: write,
    operation: write ? "extraction_reconciliation_commit" : "extraction_reconciliation_view",
  };
  if (pathname === "/api/video/detect-protocol") return {
    permission: "models.manage",
    requireStepUp: true,
    operation: write ? "video_protocol_detect" : "video_protocol_catalog_read",
  };
  if (pathname.startsWith("/api/video/channel-health")) return { permission: "models.manage", requireStepUp: true, operation: "model_channel_health" };
  if (pathname === "/api/payment/refund") return { permission: "wallet.adjust", requireStepUp: true, operation: "payment_refund" };
  if (!pathname.startsWith("/api/admin/")) return null;

  if (pathname.startsWith("/api/admin/access-control")) return { permission: "admin.accounts.manage", requireStepUp: true, operation: "admin_governance" };
  if (pathname.startsWith("/api/admin/branding/assets")) return {
    permission: "brand.settings.manage",
    requireStepUp: write,
    operation: write ? "platform_brand_asset_upload" : "platform_brand_asset_preview",
  };
  if (pathname === "/api/admin/branding") return {
    permission: "brand.settings.manage",
    // The route parses the requested action and performs step-up only for
    // publish/rollback. Draft saving intentionally remains permission-only.
    requireStepUp: false,
    operation: write ? "platform_brand_write_dispatch" : "platform_brand_read",
  };
  if (pathname.startsWith("/api/admin/canvas-prompt-presets")) return {
    permission: write ? "prompts.edit" : "prompts.view",
    requireStepUp: true,
    operation: "retired_canvas_prompt_presets",
  };
  if (pathname.startsWith("/api/admin/domain-release")) return {
    permission: "white_label.manage",
    requireStepUp: write,
    operation: write ? "domain_release_manage" : "domain_release_status",
  };
  if (pathname.startsWith("/api/admin/horizontal-scale-readiness")) return {
    permission: "logs.view",
    requireStepUp: false,
    operation: "horizontal_scale_readiness",
  };
  if (pathname.startsWith("/api/admin/multitenant-boundary")) return {
    permission: "white_label.manage",
    requireStepUp: false,
    operation: "multitenant_boundary",
  };
  if (pathname.startsWith("/api/admin/image-test") || pathname.startsWith("/api/admin/video-test")) return {
    permission: "models.manage",
    requireStepUp: true,
    operation: "model_connectivity_test",
  };
  if (pathname.startsWith("/api/admin/users/permissions")) return { permission: write ? "member_permissions.manage" : "members.view", requireStepUp: write, operation: "member_permissions" };
  if (pathname.startsWith("/api/admin/users")) {
    if (method.toUpperCase() === "DELETE") return { permission: "members.delete", requireStepUp: true, operation: "member_delete" };
    return { permission: write ? "members.manage" : "members.view", requireStepUp: write, operation: "members" };
  }
  if (pathname.startsWith("/api/admin/credits") || pathname.startsWith("/api/admin/cash")) return { permission: write ? "wallet.adjust" : "billing.view", requireStepUp: write, operation: "wallet" };
  if (pathname.startsWith("/api/admin/offline-payments")) return { permission: write ? "wallet.adjust" : "billing.view", requireStepUp: write, operation: "offline_payment" };
  if (/^\/api\/admin\/(balance-audit|revenue|user-transactions|reconciliation|payment-orders|payment-reconcile)/u.test(pathname)) {
    const exporting = searchParams?.get("format") === "csv" || pathname.includes("export");
    return { permission: exporting ? "billing.export" : "billing.view", requireStepUp: exporting || write, operation: exporting ? "billing_export" : "billing" };
  }
  if (pathname.startsWith("/api/admin/invitations")) {
    const exporting = searchParams?.get("format") === "csv";
    return { permission: exporting ? "billing.export" : "invitations.manage", requireStepUp: exporting || write, operation: exporting ? "invitation_export" : "invitations" };
  }
  if (/^\/api\/admin\/(member-packages|trial-plans|invitation-benefits)/u.test(pathname)) return { permission: "packages.manage", requireStepUp: write, operation: "packages" };
  if (pathname.startsWith("/api/admin/cami")) return { permission: "cards.manage", requireStepUp: write, operation: "cards" };
  // Commerce is a composite control plane.  The proxy enforces the primary
  // capability for each surface, while the routes enforce every additional
  // permission before reading prompts, member content, logs, or billing data.
  if (pathname === "/api/admin/commerce") {
    return { permission: "prompts.view", requireStepUp: true, operation: "commerce_configuration_overview" };
  }
  if (pathname.startsWith("/api/admin/commerce/models/canary")) {
    return { permission: "models.manage", requireStepUp: true, operation: "commerce_model_canary" };
  }
  if (pathname.startsWith("/api/admin/commerce/cards/canary")) {
    return { permission: "agents.manage", requireStepUp: true, operation: "commerce_card_canary" };
  }
  if (pathname.startsWith("/api/admin/commerce/jobs/trace")) {
    return { permission: "logs.view", requireStepUp: false, operation: "commerce_job_trace_view" };
  }
  if (pathname.startsWith("/api/admin/commerce/jobs")) {
    return { permission: write ? "wallet.adjust" : "billing.view", requireStepUp: write, operation: write ? "commerce_job_reconcile" : "commerce_job_finance_view" };
  }
  if (pathname.startsWith("/api/admin/commerce/voice-reconciliation")) {
    return { permission: write ? "wallet.adjust" : "billing.view", requireStepUp: write, operation: write ? "commerce_voice_reconciliation_manage" : "commerce_voice_reconciliation_view" };
  }
  if (pathname.startsWith("/api/admin/commerce/routes")) {
    return { permission: write ? "models.manage" : "models.view", requireStepUp: write, operation: write ? "commerce_model_route_manage" : "commerce_model_route_view" };
  }
  if (pathname.startsWith("/api/admin/commerce/releases")) {
    return { permission: write ? "agents.manage" : "prompts.view", requireStepUp: true, operation: write ? "commerce_release_manage" : "commerce_release_view" };
  }
  if (pathname.startsWith("/api/admin/commerce/cards")) {
    return { permission: write ? "agents.manage" : "agents.view", requireStepUp: write, operation: write ? "commerce_card_manage" : "commerce_card_view" };
  }
  if (pathname.startsWith("/api/admin/prompt-versions") || pathname.startsWith("/api/admin/commerce/prompts") || pathname.startsWith("/api/admin/manju-workbench/prompts")) {
    return { permission: write ? "prompts.edit" : "prompts.view", requireStepUp: true, operation: write ? "prompt_edit" : "prompt_view" };
  }
  // Public catalog mutation is an agents.manage capability. The route adds
  // internal_tools.manage only when the target row is private, hidden or
  // inactive, so content staff can maintain public catalogs without learning
  // that internal rows exist.
  if (pathname.startsWith("/api/admin/categories") || pathname.startsWith("/api/admin/nav-items")) return { permission: write ? "agents.manage" : "agents.view", requireStepUp: write, operation: "agent_categories" };
  if (pathname.startsWith("/api/admin/skill-packages")) {
    if (write) return { permission: ADMIN_SKILL_WRITE_PERMISSIONS.skillPackages, requireStepUp: true, operation: "skill_packages_manage" };
    if (adminSkillSourceRequested(searchParams)) {
      return { permission: ADMIN_SKILL_SOURCE_PERMISSIONS.skillPackages, requireStepUp: true, operation: "skill_package_source_view" };
    }
    return { permission: "agents.view", requireStepUp: false, operation: "skill_package_metadata_view" };
  }
  if (pathname.startsWith("/api/admin/skills")) {
    if (write) return { permission: ADMIN_SKILL_WRITE_PERMISSIONS.skills, requireStepUp: true, operation: "skills_manage" };
    if (adminSkillSourceRequested(searchParams)) {
      return { permission: ADMIN_SKILL_SOURCE_PERMISSIONS.skills, requireStepUp: true, operation: "skill_source_view" };
    }
    return { permission: "agents.view", requireStepUp: false, operation: "skill_metadata_view" };
  }
  if (pathname.startsWith("/api/admin/agents") || pathname.startsWith("/api/admin/agent-skills")) return { permission: write ? "agents.manage" : "agents.view", requireStepUp: write, operation: "agents" };
  if (pathname.startsWith("/api/admin/llm-test")) return { permission: "models.manage", requireStepUp: write, operation: "llm_test" };
  if (/^\/api\/admin\/(chat-models|video-models|cover-models|workspace-model-releases|model-pool-releases|model-health|credential-health|voice-config|voice-list|voice-services|voice-studio|voices)/u.test(pathname)) {
    return { permission: "models.manage", requireStepUp: true, operation: "model_internal_configuration" };
  }
  if (/^\/api\/admin\/(models|workspace-models)(?:\/|$)/u.test(pathname)) {
    return { permission: write ? "models.manage" : "models.view", requireStepUp: write, operation: "models" };
  }
  if (pathname.startsWith("/api/admin/announcements") || pathname.startsWith("/api/admin/notifications") || pathname.startsWith("/api/admin/popup-pushes")) return { permission: "announcements.manage", requireStepUp: write, operation: "announcements" };
  if (pathname.startsWith("/api/admin/unified-messaging")) return { permission: "announcements.manage", requireStepUp: write, operation: "unified_messaging" };
  // The proxy selects the primary capability for the requested bounded view;
  // the route repeats the complete view requirement before reading any source.
  if (pathname.startsWith("/api/admin/command-center")) {
    const view = normalizeCommandCenterView(searchParams?.get("view"));
    return {
      permission: commandCenterPermissionKeysForView(view)[0],
      requireStepUp: false,
      operation: `command_center_${view}`,
    };
  }
  if (pathname === "/api/admin/external-site-monitor") return { permission: "logs.view", requireStepUp: false, operation: "external_site_monitor_read" };
  if (pathname === "/api/admin/runtime-telemetry") return { permission: "logs.view", requireStepUp: false, operation: "runtime_telemetry_read" };
  if (pathname === "/api/admin/product-usage" && !write) return { permission: "members.view", requireStepUp: false, operation: "product_usage_analytics_read" };
  if (pathname === "/api/admin/slo-metrics/registry" && !write) return { permission: "logs.view", requireStepUp: false, operation: "slo_metric_registry_read" };
  if (pathname.startsWith("/api/admin/project-registry")) return { permission: "logs.view", requireStepUp: write, operation: "project_registry" };
  if (pathname.startsWith("/api/admin/incident-slo")) return { permission: write ? "security.manage" : "security.view", requireStepUp: write, operation: "incident_slo" };
  // Every administrator with security.view may inspect and step-up revoke only
  // their own server-owned login sessions. The route never accepts a target
  // user id, so this narrow self-service write does not grant security policy
  // administration or access to another administrator's sessions.
  if (pathname === "/api/admin/login-logs/sessions") {
    return { permission: "security.view", requireStepUp: write, operation: write ? "admin_session_self_revoke" : "admin_session_self_view" };
  }
  if (/^\/api\/admin\/(security-events|guard-logs|guard-rules|login-logs|password-audit)/u.test(pathname)) return { permission: write ? "security.manage" : "security.view", requireStepUp: write, operation: "security" };
  if (/^\/api\/admin\/(diagnostic-logs|operation-events)/u.test(pathname)) {
    const exporting = searchParams?.get("format") === "csv";
    return { permission: exporting ? "logs.export" : "logs.view", requireStepUp: exporting || write, operation: exporting ? "log_export" : "logs" };
  }
  if (pathname.startsWith("/api/admin/consistency-check")) return { permission: "billing.view", requireStepUp: write, operation: "billing_consistency" };
  if (/^\/api\/admin\/(backup|sync|storage)/u.test(pathname)) return { permission: "backups.manage", requireStepUp: write || pathname.includes("export"), operation: "backup_sync" };
  if (/^\/api\/admin\/(payment-config|payment-methods)/u.test(pathname)) return { permission: "payment.settings.manage", requireStepUp: true, operation: "payment_settings" };
  if (pathname.startsWith("/api/admin/plugins")) return { permission: "integrations.manage", requireStepUp: true, operation: "integrations" };
  if (pathname.startsWith("/api/admin/shortcuts")) return { permission: "brand.settings.manage", requireStepUp: true, operation: "brand_shortcuts" };
  if (/^\/api\/admin\/(config|services)/u.test(pathname)) return { permission: "models.manage", requireStepUp: true, operation: "model_engine_config" };
  if (/^\/api\/admin\/(aiweb-import|coze-import)/u.test(pathname)) return { permission: "prompts.edit", requireStepUp: true, operation: "agent_import" };
  if (pathname.startsWith("/api/admin/help")) return { permission: "platform.settings.manage", requireStepUp: write, operation: "platform_help" };
  if (pathname.startsWith("/api/admin/user-chats")) return { permission: "member_content.view", requireStepUp: false, operation: "member_content" };
  if (pathname.startsWith("/api/admin/commerce") || pathname.startsWith("/api/admin/manju-workbench")) return { permission: write ? "agents.manage" : "agents.view", requireStepUp: write, operation: "content_workbench" };

  return { permission: "admin.accounts.manage", requireStepUp: true, operation: "unmapped_admin_api" };
}
