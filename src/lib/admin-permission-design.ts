import {
  ADMIN_PERMISSION_KEYS,
  ADMIN_TAB_PERMISSIONS,
  hasAdminPermissionRequirement,
  type AdminPermissionRequirement,
  normalizeAdminPermissionKeys,
} from "@/lib/admin-governance";

// These permissions are never delegable to an ordinary administrator.  A
// second-factor/step-up session proves who is operating the account; it must
// never promote that account into the platform-owner trust boundary.
export const ADMIN_OWNER_ONLY_PERMISSION_KEYS = [
  "admin.accounts.manage",
  "prompts.view",
  "prompts.edit",
  "internal_tools.manage",
] as const;
export const ADMIN_CORE_TECH_PERMISSION_KEYS = [
  "prompts.view",
  "prompts.edit",
  "internal_tools.manage",
  "models.manage",
  "integrations.manage",
  "payment.settings.manage",
  "white_label.manage",
  "security.manage",
  "backups.manage",
  "deployment.execute",
] as const;

const OWNER_ONLY_PERMISSION_SET = new Set<string>(ADMIN_OWNER_ONLY_PERMISSION_KEYS);

export const ADMIN_PERMISSION_DEPENDENCIES: Readonly<Record<string, readonly string[]>> = {
  "member_content.view": ["members.view"],
  "members.manage": ["members.view"],
  "members.delete": ["members.view"],
  "member_permissions.manage": ["members.view"],
  "wallet.adjust": ["members.view", "billing.view"],
  "billing.export": ["billing.view"],
  "agents.manage": ["agents.view"],
  "prompts.view": ["agents.view"],
  "prompts.edit": ["prompts.view", "agents.view"],
  "internal_tools.manage": ["agents.view"],
  "models.manage": ["models.view"],
  "security.manage": ["security.view"],
  "logs.export": ["logs.view"],
  "deployment.execute": ["logs.view"],
  "payment.settings.manage": ["billing.view"],
  "white_label.manage": ["brand.settings.manage"],
};

export interface AdminJobTemplate {
  id: string;
  label: string;
  description: string;
  permissionKeys: readonly string[];
}

export const ADMIN_JOB_TEMPLATES: readonly AdminJobTemplate[] = [
  {
    id: "member-service",
    label: "会员客服",
    description: "处理会员资料与功能开通，不接触资金、提示词和系统配置。",
    permissionKeys: ["members.view", "members.manage", "member_permissions.manage"],
  },
  {
    id: "growth-operations",
    label: "增长运营",
    description: "负责邀请、套餐、卡密和公告，不接触账务调账与核心技术。",
    permissionKeys: [
      "members.view",
      "invitations.manage",
      "packages.manage",
      "cards.manage",
      "announcements.manage",
    ],
  },
  {
    id: "finance",
    label: "财务对账",
    description: "查看账单、处理调账和导出凭证，不接触模型密钥或提示词。",
    permissionKeys: ["members.view", "billing.view", "wallet.adjust", "billing.export"],
  },
  {
    id: "content-operations",
    label: "内容运营",
    description: "维护智能体产品信息和上下架，只查看模型目录，不读取内部提示词。",
    permissionKeys: ["agents.view", "agents.manage", "models.view"],
  },
  {
    id: "security-auditor",
    label: "安全审计",
    description: "查看安全事件和运行日志，不修改规则、不导出敏感记录。",
    permissionKeys: ["security.view", "logs.view"],
  },
] as const;

export interface AdminPermissionSurface {
  id: string;
  label: string;
  requirement: AdminPermissionRequirement;
}

export const ADMIN_PERMISSION_SURFACES: readonly AdminPermissionSurface[] = [
  { id: "dashboard", label: "平台指挥中心", requirement: ADMIN_TAB_PERMISSIONS.dashboard },
  { id: "members", label: "会员管理", requirement: "members.view" },
  { id: "member-content", label: "会员聊天与作品", requirement: "member_content.view" },
  { id: "invitations", label: "邀请关系", requirement: "invitations.manage" },
  { id: "benefits", label: "权益套餐", requirement: "packages.manage" },
  { id: "cards", label: "卡密系统", requirement: "cards.manage" },
  { id: "billing", label: "财务与账单", requirement: "billing.view" },
  { id: "payment", label: "支付系统", requirement: "payment.settings.manage" },
  { id: "announcements", label: "公告与通知", requirement: "announcements.manage" },
  { id: "agents", label: "智能体管理", requirement: "agents.view" },
  { id: "models", label: "模型与服务", requirement: "models.view" },
  { id: "branding", label: "品牌与界面", requirement: "brand.settings.manage" },
  { id: "integrations", label: "外部连接", requirement: "integrations.manage" },
  { id: "white-label", label: "域名与贴牌", requirement: "white_label.manage" },
  { id: "security", label: "安全审计", requirement: "security.view" },
  { id: "operations", label: "系统运维", requirement: "logs.view" },
  { id: "backup", label: "备份与同步", requirement: "backups.manage" },
] as const;

function requirementSatisfied(
  permissionKeys: ReadonlySet<string>,
  requirement: AdminPermissionRequirement,
): boolean {
  return hasAdminPermissionRequirement([...permissionKeys], requirement);
}

export function ownerOnlyAdminPermissionKeys(value: unknown): string[] {
  return normalizeAdminPermissionKeys(value).filter((key) => OWNER_ONLY_PERMISSION_SET.has(key));
}

export function normalizeDelegableAdminPermissionKeys(value: unknown): string[] {
  const expanded = new Set(
    normalizeAdminPermissionKeys(value).filter((key) => !OWNER_ONLY_PERMISSION_SET.has(key)),
  );
  let changed = true;
  while (changed) {
    changed = false;
    for (const permissionKey of [...expanded]) {
      for (const dependency of ADMIN_PERMISSION_DEPENDENCIES[permissionKey] || []) {
        if (OWNER_ONLY_PERMISSION_SET.has(dependency) || expanded.has(dependency)) continue;
        expanded.add(dependency);
        changed = true;
      }
    }
  }
  return ADMIN_PERMISSION_KEYS.filter(
    (permissionKey) => expanded.has(permissionKey) && !OWNER_ONLY_PERMISSION_SET.has(permissionKey),
  );
}

export function visibleAdminPermissionSurfaces(value: unknown): AdminPermissionSurface[] {
  const permissionKeys = new Set(normalizeDelegableAdminPermissionKeys(value));
  return ADMIN_PERMISSION_SURFACES.filter((surface) =>
    requirementSatisfied(permissionKeys, surface.requirement),
  );
}
