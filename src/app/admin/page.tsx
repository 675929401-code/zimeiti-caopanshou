"use client";
import { adminPasswordError } from "@/lib/admin-password-policy";
import { ADMIN_LOGIN_PATH } from "@/lib/admin-entry";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { copyToClipboard, resolveAvatarUrl } from "@/lib/utils";
import { renderMarkdown, parseThinkTags } from "@/lib/markdown-renderer";
import type {
  WorkspaceProjectId,
  WorkspaceSpecializedTarget,
} from "@/components/admin/WorkspaceModelsAdminTab";
import {
  AdminMaintenanceModeBanner,
  AdminSensitiveUnlockControl,
  useAdminStepUpReady,
} from "@/components/admin/admin-sensitive-unlock-control";

import { safeJsonParse, safeLocalStorageGet, safeLocalStorageSet, safeLocalStorageRemove } from "@/lib/utils";
import { getSemanticAgentAvatarFallback } from "@/lib/agent-avatar-aliases";
import { STORAGE_KEYS } from "@/lib/storage-keys";
import {
  ADMIN_THEME_OPTIONS,
  DEFAULT_MODE_PREFERENCE,
  DEFAULT_THEME,
  modeForTheme,
  normalizeTheme,
  normalizeThemeModePreference,
  resolveRenderedTheme,
  resolveThemeModeForTheme,
  type ThemeModePreference,
} from "@/lib/themes";
import { applyThemeColorSettings } from "@/lib/theme-color-settings";
import { invalidateClientBootstrapAppearance } from "@/lib/client-bootstrap-cache";
import {
  DEFAULT_PLATFORM_LOGO_URL,
  platformBrandLogoUrl,
  usePlatformBranding,
} from "@/hooks/use-platform-branding";
import { FileText, ArrowLeft, User, Search, Wallet, MessageSquare } from "lucide-react";

import type { OutputStyle } from "@/types/coze";
import type { PresetTemplateField } from "@/components/preset-template-editor";
import type { PromptVersionHistoryHandle } from "@/components/prompt-version-history";
import { Switch } from "@/components/ui/switch";
import StoryboardDirectorContractEditor from "@/components/admin/StoryboardDirectorContractEditor";
import StoryboardPromptPushCapabilityToggle from "@/components/admin/StoryboardPromptPushCapabilityToggle";
import AgentSearchToolbar from "@/components/admin/agent-search-toolbar";
import { filterAdminAgents, normalizeAdminAgentSearchQuery } from "@/lib/admin-agent-search";
import { BIP_CATEGORY, BIP_CATEGORY_LABEL, displayCategory, TASK_CATEGORIES } from "@/lib/business-ip/catalog";
import { hasActivatedStoryboardDirectorContract, STORYBOARD_DIRECTOR_CONTRACT_FIELDS } from "@/lib/storyboard-director-contract-activation";
import { normalizeAgentPresetFields, type AgentPresetField } from "@/lib/agent-preset-schema";
import { readPendingAdminWalletAttempts, submitAdminWalletRequest, type AdminWalletKind, type AdminWalletPayload, type PendingAdminWalletAttempt } from "@/lib/admin-wallet-client";
import { isQqEmail, normalizeQqEmail } from "@/lib/qq-email";
import {
  AGENT_NAVIGATION_OPTIONS,
  getAgentCategoryDisplayName,
  normalizeAllowedAgentNavigationKeys,
} from "@/lib/agent-category-access";
import {
  MEMBER_FEATURE_PERMISSION_OPTIONS,
  normalizeFeatureNavigationKeys,
} from "@/lib/member-permissions";
import {
  type AdminAccessClientState,
} from "@/lib/admin-governance";
import { visibleCommandCenterViews } from "@/lib/admin-command-center-domain";
import {
  adminPlatformSettingKeysForScope,
  adminPlatformSettingPermission,
  type AdminPlatformSettingScope,
} from "@/lib/platform-settings-contract";

const SuperAdminGovernancePanel = dynamic(
  () => import("@/components/admin/super-admin-governance-panel").then((module) => module.SuperAdminGovernancePanel),
  { ssr: false, loading: () => <div className="rounded-2xl border border-[#d0d5dd] bg-white p-8 text-sm text-[#667085]">正在加载授权模块…</div> },
);
const CommandCenterPanel = dynamic(
  () => import("@/components/admin/command-center-panel").then((module) => module.CommandCenterPanel),
  { ssr: false, loading: () => <div className="rounded-2xl border border-[var(--border)] bg-[var(--card)] p-8 text-sm text-[var(--muted-foreground)]">正在加载平台指挥中心…</div> },
);
const WorkspaceModelsAdminTab = dynamic(
  () => import("@/components/admin/WorkspaceModelsAdminTab").then((module) => module.WorkspaceModelsAdminTab),
  { ssr: false, loading: () => <div className="rounded-2xl border border-[#d0d5dd] bg-white p-8 text-sm text-[#667085]">正在加载授权模块…</div> },
);
const StoryboardPresetsAdminTab = dynamic(
  () => import("@/components/admin/StoryboardPresetsAdminTab").then((module) => module.StoryboardPresetsAdminTab),
  { ssr: false, loading: () => <div className="p-6 text-sm text-[var(--muted-foreground)]">正在加载角色预设…</div> },
);
const CommerceAgentAdminTab = dynamic(
  () => import("@/components/admin/CommerceAgentAdminTab").then((module) => module.CommerceAgentAdminTab),
  { ssr: false, loading: () => <div className="rounded-2xl border border-[#d0d5dd] bg-white p-8 text-sm text-[#667085]">正在加载授权模块…</div> },
);
const ManjuWorkbenchAdminTab = dynamic(
  () => import("@/components/admin/ManjuWorkbenchAdminTab").then((module) => module.ManjuWorkbenchAdminTab),
  { ssr: false, loading: () => <div className="rounded-2xl border border-[#d0d5dd] bg-white p-8 text-sm text-[#667085]">正在加载授权模块…</div> },
);
const SecurityCenterAdminTab = dynamic(
  () => import("@/components/admin/security-center-admin-tab").then((module) => module.SecurityCenterAdminTab),
  { ssr: false, loading: () => <div className="rounded-2xl border border-[var(--border)] bg-[var(--card)] p-8 text-sm text-[var(--muted-foreground)]">正在加载授权模块…</div> },
);
const GuardLogsAdminTab = dynamic(
  () => import("@/components/admin/guard-logs-admin-tab").then((module) => module.GuardLogsAdminTab),
  { ssr: false, loading: () => <div className="rounded-2xl border border-[var(--border)] bg-[var(--card)] p-8 text-sm text-[var(--muted-foreground)]">正在加载授权模块…</div> },
);
const LoginLogsAdminTab = dynamic(
  () => import("@/components/admin/login-logs-admin-tab").then((module) => module.LoginLogsAdminTab),
  { ssr: false, loading: () => <div className="rounded-2xl border border-[var(--border)] bg-[var(--card)] p-8 text-sm text-[var(--muted-foreground)]">正在加载授权模块…</div> },
);
const SyncAdminTab = dynamic(
  () => import("@/components/admin/sync-admin-tab").then((module) => module.SyncAdminTab),
  { ssr: false, loading: () => <div className="rounded-2xl border border-[var(--border)] bg-[var(--card)] p-8 text-sm text-[var(--muted-foreground)]">正在加载授权模块…</div> },
);
const BackupAdminTab = dynamic(
  () => import("@/components/admin/backup-admin-tab").then((module) => module.BackupAdminTab),
  { ssr: false, loading: () => <div className="rounded-2xl border border-[var(--border)] bg-[var(--card)] p-8 text-sm text-[var(--muted-foreground)]">正在加载授权模块…</div> },
);
const PaymentConfigAdminTab = dynamic(
  () => import("@/components/admin/payment-config-admin-tab").then((module) => module.PaymentConfigAdminTab),
  { ssr: false, loading: () => <div className="rounded-2xl border border-[var(--border)] bg-[var(--card)] p-8 text-sm text-[var(--muted-foreground)]">正在加载授权模块…</div> },
);
const ModelsAdminTab = dynamic(
  () => import("@/components/admin/models-admin-tab").then((module) => module.ModelsAdminTab),
  { ssr: false, loading: () => <div className="rounded-2xl border border-[var(--border)] bg-[var(--card)] p-8 text-sm text-[var(--muted-foreground)]">正在加载已授权模型目录…</div> },
);
const IntegrationSettingsAdminTab = dynamic(
  () => import("@/components/admin/integration-settings-admin-tab").then((module) => module.IntegrationSettingsAdminTab),
  { ssr: false, loading: () => <div className="rounded-2xl border border-[var(--border)] bg-[var(--card)] p-8 text-sm text-[var(--muted-foreground)]">正在加载已授权外部服务配置…</div> },
);
const PresetTemplateEditor = dynamic(
  () => import("@/components/preset-template-editor").then((module) => module.PresetTemplateEditor),
  { ssr: false, loading: () => <div className="rounded-2xl border border-[var(--border)] bg-[var(--card)] p-8 text-sm text-[var(--muted-foreground)]">正在加载授权模块…</div> },
);
const PromptVersionHistory = dynamic(
  () => import("@/components/prompt-version-history").then((module) => module.default),
  { ssr: false, loading: () => <div className="rounded-2xl border border-[var(--border)] bg-[var(--card)] p-8 text-sm text-[var(--muted-foreground)]">正在加载授权模块…</div> },
);
const BillingAuditPanel = dynamic(
  () => import("@/components/billing-audit-panel").then((module) => module.BillingAuditPanel),
  { ssr: false, loading: () => <div className="rounded-2xl border border-[var(--border)] bg-[var(--card)] p-8 text-sm text-[var(--muted-foreground)]">正在加载授权模块…</div> },
);
const DigitalHumanAdminTab = dynamic(
  () => import("@/components/admin/DigitalHumanAdminTab").then((module) => module.DigitalHumanAdminTab),
  { ssr: false, loading: () => <div className="rounded-2xl border border-[var(--border)] bg-[var(--card)] p-8 text-sm text-[var(--muted-foreground)]">正在加载授权模块…</div> },
);
const VoiceStudioAdminTab = dynamic(
  () => import("@/components/admin/VoiceStudioAdminTab").then((module) => module.VoiceStudioAdminTab),
  { ssr: false, loading: () => <div className="rounded-2xl border border-[var(--border)] bg-[var(--card)] p-8 text-sm text-[var(--muted-foreground)]">正在加载授权模块…</div> },
);
const PluginManagementTab = dynamic(
  () => import("@/components/admin/PluginManagementTab").then((module) => module.PluginManagementTab),
  { ssr: false, loading: () => <div className="rounded-2xl border border-[var(--border)] bg-[var(--card)] p-8 text-sm text-[var(--muted-foreground)]">正在加载授权模块…</div> },
);
const AnnouncementAdminPanel = dynamic(
  () => import("@/components/admin/announcement-admin-panel").then((module) => module.AnnouncementAdminPanel),
  { ssr: false, loading: () => <div className="rounded-2xl border border-[var(--border)] bg-[var(--card)] p-8 text-sm text-[var(--muted-foreground)]">正在加载授权模块…</div> },
);
const InvitationAttributionPanel = dynamic(
  () => import("@/components/admin/invitation-attribution-panel").then((module) => module.InvitationAttributionPanel),
  { ssr: false, loading: () => <div className="rounded-2xl border border-[var(--border)] bg-[var(--card)] p-8 text-sm text-[var(--muted-foreground)]">正在加载授权模块…</div> },
);
const MemberPackageAssignmentDialog = dynamic(
  () => import("@/components/admin/member-package-assignment-dialog").then((module) => module.MemberPackageAssignmentDialog),
  { ssr: false, loading: () => <div className="rounded-2xl border border-[var(--border)] bg-[var(--card)] p-8 text-sm text-[var(--muted-foreground)]">正在加载授权模块…</div> },
);
const MemberPackageTemplateManager = dynamic(
  () => import("@/components/admin/member-package-template-manager").then((module) => module.MemberPackageTemplateManager),
  { ssr: false, loading: () => <div className="rounded-2xl border border-[var(--border)] bg-[var(--card)] p-8 text-sm text-[var(--muted-foreground)]">正在加载授权模块…</div> },
);
const OperationFlightRecorderPanel = dynamic(
  () => import("@/components/admin/operation-flight-recorder-panel").then((module) => module.OperationFlightRecorderPanel),
  { ssr: false, loading: () => <div className="rounded-2xl border border-[var(--border)] bg-[var(--card)] p-8 text-sm text-[var(--muted-foreground)]">正在加载授权模块…</div> },
);
const PlatformBrandSettingsPanel = dynamic(
  () => import("@/components/admin/platform-brand-settings-panel").then((module) => module.PlatformBrandSettingsPanel),
  { ssr: false, loading: () => <div className="rounded-2xl border border-[var(--border)] bg-[var(--card)] p-8 text-sm text-[var(--muted-foreground)]">正在加载授权模块…</div> },
);
const WhiteLabelReadinessPanel = dynamic(
  () => import("@/components/admin/WhiteLabelReadinessPanel").then((module) => module.default),
  { ssr: false, loading: () => <div className="rounded-2xl border border-[var(--border)] bg-[var(--card)] p-8 text-sm text-[var(--muted-foreground)]">正在加载授权模块…</div> },
);
const LayoutTab = dynamic(
  () => import("@/components/admin/LayoutTab").then((module) => module.default),
  { ssr: false, loading: () => <div className="rounded-2xl border border-[var(--border)] bg-[var(--card)] p-8 text-sm text-[var(--muted-foreground)]">正在加载授权模块…</div> },
);

interface UserInfo {
  id: string;
  username?: string;
  name: string;
  displayName?: string; // deprecated, use name
  phone: string;
  email: string;
  role: string;
  credits: number;
  cashBalance?: number;
  cash_balance?: number; // deprecated, use cashBalance
  is_active?: boolean;
  isActive?: boolean;
  status?: string;
  memberStatus?: string;
  last_sign_in_at?: string | null;
  lastActive?: string;
  created_at?: string;
  createdAt?: string;
  allowed_categories?: string[] | null;
  allowedCategories?: string[] | null;
  allowed_navigation_keys?: string[] | null;
  allowedNavigationKeys?: string[] | null;
  featureNavigationKeys?: string[] | null;
  permissionRevision?: number;
  totalCreditRecharge?: number;
  totalCashRecharge?: number;
  totalCreditConsume?: number;
  totalCashConsume?: number;
  accountKind?: "normal" | "fixture" | "suspicious";
  accountFlags?: {
    isFixture?: boolean;
    isSuspicious?: boolean;
    label?: string | null;
    reasons?: string[];
  };
  accountFlagReasons?: string[];
}

interface AdminUserDeleteVerification {
  token: string;
  expiresAt: number;
}

interface AgentInfo {
  id: string;
  config_revision?: number;
  name: string;
  description: string;
  avatar: string;
  category: string;
  source: string;
  bot_id: string;
  model: string;
  system_prompt?: string;
  prompt_access?: "visible" | "protected";
  configuration_access?: "visible" | "protected";
  cost_per_message: number;
  base_fee?: number;
  sort_order: number;
  is_active: boolean;
  user_access?: "available" | "hidden";
  coze_coding_api_url?: string;
  coze_coding_api_token?: string;
  coze_coding_api_token_configured?: boolean;
  coze_coding_project_id?: string;
  preset_fields?: PresetFieldConfig[];
  output_style?: OutputStyle;
  enable_think_tags?: boolean;
  proxy_url?: string;
  deep_thinking_type?: number;
  deduct_deep_think?: number;
  max_context_rounds?: number;
  max_context_tokens?: number;
  max_reply_tokens?: number;
  timeout?: number;
  enable_web_search?: boolean;
  temperature?: number;
  response_format?: "text" | "markdown" | "json_object";
  deleted_at?: string | null;
  // 智能体级独立Token计费（已废弃，由模型预设计费替代）
  token_billing_enabled?: boolean;
  input_cost_per_million?: number;
  output_cost_per_million?: number;
  cached_cost_per_million?: number;
  profit_margin?: number;
  token_rounding_unit?: number;
  // 模型预设关联
  model_id?: string;
  model_billing?: {
    token_billing_enabled: boolean;
    billing_mode: string;
    cost_per_use: number;
    input_cost_per_million: number;
    output_cost_per_million: number;
    cached_cost_per_million: number;
    profit_margin: number;
    model_name: string;
  } | null;
  // 应用背景图
  cover_url?: string;
  // 聊天引导语
  guide_message?: string;
  // 新增字段
  frequency_limit?: number;
  image_parsing?: string;
  file_parsing?: string;
}

const AGENT_SENSITIVE_CLIENT_FIELDS = [
  "bot_id", "model", "system_prompt", "coze_coding_api_url", "coze_coding_api_token",
  "coze_coding_api_token_configured", "coze_coding_project_id", "preset_fields", "output_style",
  "enable_think_tags", "proxy_url", "deep_thinking_type", "deduct_deep_think", "max_context_rounds",
  "max_context_tokens", "max_reply_tokens", "timeout", "enable_web_search", "temperature",
  "response_format", "token_billing_enabled", "input_cost_per_million", "output_cost_per_million",
  "cached_cost_per_million", "profit_margin", "token_rounding_unit", "model_id", "model_billing",
] as const;

function stripAgentSensitiveClientFields(agent: AgentInfo): AgentInfo {
  const sanitized = { ...agent } as unknown as Record<string, unknown>;
  for (const field of AGENT_SENSITIVE_CLIENT_FIELDS) delete sanitized[field];
  return {
    ...sanitized,
    bot_id: "",
    model: "",
    prompt_access: "protected",
    configuration_access: "protected",
  } as unknown as AgentInfo;
}

const AGENT_EDITABLE_FIELDS = [
  "name", "description", "avatar", "category", "source", "bot_id", "model", "system_prompt",
  "cost_per_message", "base_fee", "sort_order", "is_active", "user_access", "coze_coding_api_url",
  "coze_coding_api_token", "coze_coding_project_id", "preset_fields", "output_style", "enable_think_tags",
  "proxy_url", "deep_thinking_type", "deduct_deep_think", "max_context_rounds", "max_context_tokens",
  "max_reply_tokens", "timeout", "enable_web_search", "temperature", "response_format",
  "token_billing_enabled", "input_cost_per_million", "output_cost_per_million", "cached_cost_per_million",
  "profit_margin", "token_rounding_unit", "model_id", "cover_url", "guide_message", "frequency_limit",
  "image_parsing", "file_parsing",
] as const satisfies readonly (keyof AgentInfo)[];

function comparableAgentValue(value: unknown): string {
  return JSON.stringify(value === undefined ? null : value);
}

function adminDisplayCategoryLabel(key: string): string {
  if (key === BIP_CATEGORY) return BIP_CATEGORY_LABEL;
  return TASK_CATEGORIES.find((category) => category.key === key)?.label || getAgentCategoryDisplayName(key);
}

function normalizedAgentPresetFields(value: AgentInfo["preset_fields"]): PresetFieldConfig[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  return value.map((field, index) => ({ ...field, order: index, sendLabel: field.sendLabel ?? true }));
}

function buildAgentUpdatePayload(current: AgentInfo, original: AgentInfo, canEditPrompts: boolean): Record<string, unknown> {
  const payload: Record<string, unknown> = { agentId: current.id };
  const revision = Number(original.config_revision);
  if (Number.isSafeInteger(revision) && revision >= 1) {
    payload.expected_revision = revision;
  }
  for (const field of AGENT_EDITABLE_FIELDS) {
    if (field === "system_prompt" && !canEditPrompts) continue;
    if (field === "coze_coding_api_token") {
      const replacement = String(current.coze_coding_api_token || "").trim();
      if (replacement) payload.coze_coding_api_token = replacement;
      continue;
    }
    const currentValue = field === "preset_fields" ? normalizedAgentPresetFields(current.preset_fields) : current[field];
    const originalValue = field === "preset_fields" ? normalizedAgentPresetFields(original.preset_fields) : original[field];
    if (comparableAgentValue(currentValue) === comparableAgentValue(originalValue)) continue;
    payload[field] = currentValue === undefined ? null : currentValue;
  }
  return payload;
}

function buildAgentMutationPayload(agent: AgentInfo, changes: Record<string, unknown>): Record<string, unknown> {
  const revision = Number(agent.config_revision);
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw new Error("AGENT_EXPECTED_REVISION_REQUIRED");
  }
  return { agentId: agent.id, expected_revision: revision, ...changes };
}

type PresetFieldConfig = AgentPresetField;

// PresetFieldConfig ↔ PresetTemplateField 转换工具
function presetToTemplate(fields: PresetFieldConfig[]): PresetTemplateField[] {
  return normalizeAgentPresetFields(fields).map((f) => ({
    id: f.id,
    type: f.type === "textarea" ? "textarea" as const : (f.type === "select" ? "select" as const : "input" as const),
    title: f.label,
    placeholder: f.placeholder || "",
    options: f.options || [],
    order: f.order,
    // 保留扩展字段
    ...(f.required !== undefined ? { required: f.required } : {}),
    ...(f.contentPrefix ? { contentPrefix: f.contentPrefix } : {}),
    ...(f.sendLabel !== undefined ? { sendLabel: f.sendLabel } : {}),
    ...(f.sendText ? { sendText: f.sendText } : {}),
    ...(f.description ? { description: f.description } : {}),
    ...(f.defaultValue ? { defaultValue: f.defaultValue } : {}),
  }));
}

function templateToPreset(fields: PresetTemplateField[]): PresetFieldConfig[] {
  return normalizeAgentPresetFields(fields.map((f, i) => ({
    id: f.id,
    label: f.title,
    type: f.type === "textarea" ? "textarea" as const : (f.type === "select" ? "select" as const : "text" as const),
    placeholder: f.placeholder || "",
    required: f.required ?? false,
    options: f.type === "select" && f.options ? f.options : [],
    order: f.order ?? i,
    sendLabel: f.sendLabel ?? true,
    ...(f.contentPrefix ? { contentPrefix: f.contentPrefix } : {}),
    ...(f.sendText ? { sendText: f.sendText } : {}),
    ...(f.description ? { description: f.description } : {}),
    ...(f.defaultValue ? { defaultValue: f.defaultValue } : {}),
  }))).map((field, index) => ({ ...field, order: index }));
}

interface PlatformSettings {
  platform_name: string;
  platform_cover: string;
  welcome_message: string;
  input_cost_per_million: string;
  output_cost_per_million: string;
  cached_cost_per_million: string;
  profit_margin: string;
  credits_per_yuan: string;
  token_rounding_unit: string;
  token_rounding_enabled: string;
  token_rounding_min: string;
  token_rounding_max: string;
  theme: string;
  theme_mode: string;
  theme_primary_color: string;
  theme_accent_color: string;
  theme_gradient_start: string;
  theme_gradient_mid: string;
  theme_gradient_end: string;
  coze_api_base_url: string;
  coze_api_token: string;
  coze_api_token_configured?: boolean;
  coze_workspace_id: string;
  coze_coding_api_url: string;
  coze_coding_api_token: string;
  coze_coding_api_token_configured?: boolean;
  cover_workflow_api_url: string;
  cover_workflow_app_id: string;
  cover_workflow_token: string;
  cover_workflow_token_configured?: boolean;
  thinking_model_name: string;
  thinking_model_api_base: string;
  thinking_model_api_key: string;
  thinking_model_api_key_configured?: boolean;
  extract_api_url: string;
  extract_api_token: string;
  extract_api_token_configured?: boolean;
  card_layout: string;
  page_layout: string;
  global_system_prefix: string;
  auto_avatar_enabled: string;
  auto_avatar_model_id: string;
  email_smtp_host: string;
  email_smtp_port: string;
  email_smtp_user: string;
  email_smtp_pass: string;
  email_smtp_pass_configured?: boolean;
  email_from: string;
}

function createDefaultPlatformSettings(): PlatformSettings {
  return {
    platform_name: "AI智能体工作台", platform_cover: "",
    welcome_message: "欢迎使用AI智能体工作台",
    input_cost_per_million: "25", output_cost_per_million: "125", cached_cost_per_million: "2.5",
    profit_margin: "50", credits_per_yuan: "50", token_rounding_unit: "0",
    token_rounding_enabled: "false", token_rounding_min: "100", token_rounding_max: "10000",
    theme: DEFAULT_THEME,
    theme_mode: DEFAULT_MODE_PREFERENCE,
    theme_primary_color: "#2F80FF",
    theme_accent_color: "#22D3EE",
    theme_gradient_start: "#2F80FF",
    theme_gradient_mid: "#38E3B0",
    theme_gradient_end: "#D946EF",
    coze_api_base_url: "https://api.coze.cn", coze_api_token: "", coze_api_token_configured: false, coze_workspace_id: "",
    coze_coding_api_url: "", coze_coding_api_token: "", coze_coding_api_token_configured: false,
    cover_workflow_api_url: "", cover_workflow_app_id: "", cover_workflow_token: "", cover_workflow_token_configured: false,
    thinking_model_name: "deepseek-reasoner", thinking_model_api_base: "", thinking_model_api_key: "", thinking_model_api_key_configured: false,
    extract_api_url: "", extract_api_token: "", extract_api_token_configured: false,
    card_layout: "",
    page_layout: "",
    global_system_prefix: "",
    auto_avatar_enabled: "true",
    auto_avatar_model_id: "",
    email_smtp_host: "", email_smtp_port: "465", email_smtp_user: "", email_smtp_pass: "", email_smtp_pass_configured: false, email_from: "",
  };
}

const LAYOUT_SETTING_FIELDS = ["page_layout", "card_layout"] as const satisfies readonly (keyof PlatformSettings)[];
const COZE_CONNECTION_SETTING_FIELDS = ["coze_api_base_url", "coze_api_token", "coze_workspace_id"] as const satisfies readonly (keyof PlatformSettings)[];
const SMTP_SETTING_FIELDS = ["email_smtp_host", "email_smtp_port", "email_smtp_user", "email_smtp_pass", "email_from"] as const satisfies readonly (keyof PlatformSettings)[];
const COVER_WORKFLOW_SETTING_FIELDS = ["cover_workflow_api_url", "cover_workflow_app_id", "cover_workflow_token"] as const satisfies readonly (keyof PlatformSettings)[];
const AVATAR_MODEL_SETTING_FIELDS = ["auto_avatar_model_id"] as const satisfies readonly (keyof PlatformSettings)[];
const CREDIT_EXCHANGE_SETTING_FIELDS = ["credits_per_yuan"] as const satisfies readonly (keyof PlatformSettings)[];
const GLOBAL_PROMPT_SETTING_FIELDS = ["global_system_prefix"] as const satisfies readonly (keyof PlatformSettings)[];
const ADMIN_SECRET_SETTING_FIELDS = new Set<keyof PlatformSettings>([
  "coze_api_token",
  "coze_coding_api_token",
  "cover_workflow_token",
  "thinking_model_api_key",
  "extract_api_token",
  "email_smtp_pass",
]);

function isBlankOrMaskedAdminSecret(value: string): boolean {
  const normalized = value.trim();
  return !normalized || /^(?:\*{3,}|•{3,}|已配置|configured)$/i.test(normalized);
}

function normalizePlatformThemeMode(themeValue: string, _themeModeValue: string) {
  return modeForTheme(normalizeTheme(themeValue));
}

type Tab = "super-admin" | "workspace-models" | "storyboard-presets" | "dashboard" | "agents" | "trash" | "users" | "invitations" | "credits" | "offline-payments" | "general" | "theme" | "connection" | "layout" | "models" | "announcements" | "health" | "security" | "guard-logs" | "login-logs" | "sync" | "backup" | "benefit-packages" | "cami" | "aiweb-import" | "payment" | "billing-audit" | "white-label";
type UserSubTab = "members" | "recharge" | "consumption" | "chats";
type MemberFilter = "all" | "inactive" | "trial" | "active" | "expired" | "test";

interface MemberListViewSnapshot {
  filter: MemberFilter;
  search: string;
  scrollTop: number;
}

interface AdminAgentCategory {
  id: string;
  name: string;
  icon: string;
  sort_order: number;
  is_active: boolean;
  agent_count?: number;
  visibility?: string;
}

const ALL_AGENT_NAVIGATION_KEYS = AGENT_NAVIGATION_OPTIONS.map((option) => option.key);
const ALL_MEMBER_FEATURE_KEYS = MEMBER_FEATURE_PERMISSION_OPTIONS.map((option) => option.key);
const MEMBER_PERMISSION_QUICK_PROFILE_KEYS = ["trial_member", "formal_member", "super_vip"] as const;
const MEMBER_PERMISSION_QUICK_PROFILE_LABELS: Record<(typeof MEMBER_PERMISSION_QUICK_PROFILE_KEYS)[number], string> = {
  trial_member: "体验包",
  formal_member: "正式会员",
  super_vip: "超级 VIP",
};

interface MemberPermissionProfileOption {
  key: string;
  version: number;
  name: string;
  description: string;
  featureNavigationKeys: string[];
  agentNavigationKeys: string[];
}

function getUserAllowedNavigationKeys(user: UserInfo): string[] {
  const persistedValue = user.allowedNavigationKeys !== undefined
    ? user.allowedNavigationKeys
    : user.allowed_navigation_keys !== undefined
      ? user.allowed_navigation_keys
      : user.allowedCategories !== undefined
        ? user.allowedCategories
        : user.allowed_categories;
  return normalizeAllowedAgentNavigationKeys(persistedValue);
}

/** 有效 Tab 列表 — 与 Tab 类型保持同步，用于运行时校验 sessionStorage 脏数据 */
const VALID_TABS: Tab[] = ["super-admin", "workspace-models", "storyboard-presets", "dashboard", "agents", "trash", "users", "invitations", "credits", "offline-payments", "general", "theme", "connection", "layout", "models", "announcements", "health", "security", "guard-logs", "login-logs", "sync", "backup", "benefit-packages", "cami", "aiweb-import", "payment", "billing-audit", "white-label"];

/** 校验 sessionStorage 恢复的 activeTab 是否为合法值 */
function isValidTab(v: unknown): v is Tab {
  return typeof v === "string" && VALID_TABS.includes(v as Tab);
}

const TABS: { key: Tab; label: string; icon: string }[] = [
  { key: "super-admin", label: "超级管理", icon: "M12 2.25c-2.25 1.875-5.25 2.25-7.5 2.25v5.625c0 4.875 3.375 9.375 7.5 11.625 4.125-2.25 7.5-6.75 7.5-11.625V4.5c-2.25 0-5.25-.375-7.5-2.25zm0 5.25a2.25 2.25 0 110 4.5 2.25 2.25 0 010-4.5zm-3.375 8.25a3.375 3.375 0 016.75 0" },
  { key: "dashboard", label: "指挥中心", icon: "M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 013 19.875v-6.75zM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V8.625zM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V4.125z" },
  { key: "agents", label: "智能体管理", icon: "M9.75 3.104v5.714a2.25 2.25 0 01-.659 1.591L5 14.5M9.75 3.104c-.251.023-.501.05-.75.082m.75-.082a24.301 24.301 0 014.5 0m0 0v5.714c0 .597.237 1.17.659 1.591L19.8 15.3" },
  { key: "trash", label: "回收站", icon: "M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" },
  { key: "users", label: "会员管理", icon: "M15 19.128a9.38 9.38 0 002.625.372 9.337 9.337 0 004.121-.952 4.125 4.125 0 00-7.533-2.493M15 19.128v-.003c0-1.113-.285-2.16-.786-3.07M15 19.128v.106A12.318 12.318 0 018.624 21c-2.331 0-4.512-.645-6.374-1.766l-.001-.109a6.375 6.375 0 0111.964-3.07M12 6.375a3.375 3.375 0 11-6.75 0 3.375 3.375 0 016.75 0zm8.25 2.25a2.625 2.625 0 11-5.25 0 2.625 2.625 0 015.25 0z" },
  { key: "invitations", label: "邀请关系", icon: "M18 7.5v3m0 0v3m0-3h3m-3 0h-3M9 6.75a3.75 3.75 0 110 7.5 3.75 3.75 0 010-7.5zM3.75 21a5.25 5.25 0 0110.5 0v.75H3.75V21z" },
  { key: "credits", label: "资金与计费", icon: "M12 6v12m-3-2.818l.879.659c1.171.879 3.07.879 4.242 0 1.172-.879 1.172-2.303 0-3.182C13.536 12.219 12.768 12 12 12c-.725 0-1.45-.22-2.003-.659-1.106-.879-1.106-2.303 0-3.182s2.9-.879 4.006 0l.415.33M21 12a9 9 0 11-18 0 9 9 0 0118 0z" },
  { key: "offline-payments", label: "线下收款", icon: "M3.75 6A2.25 2.25 0 016 3.75h12A2.25 2.25 0 0120.25 6v12A2.25 2.25 0 0118 20.25H6A2.25 2.25 0 013.75 18V6zm3 3.75h10.5M6.75 14.25h4.5" },
  { key: "general", label: "品牌与联系", icon: "M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z M15 12a3 3 0 11-6 0 3 3 0 016 0z" },
  { key: "theme", label: "界面设置", icon: "M4.098 19.902a3.75 3.75 0 005.304 0l6.401-6.402M6.75 21A3.75 3.75 0 013 17.25V4.125C3 3.504 3.504 3 4.125 3h5.25c.621 0 1.125.504 1.125 1.125v4.072M6.75 21a3.75 3.75 0 003.75-3.75V8.197M6.75 21h13.125c.621 0 1.125-.504 1.125-1.125v-5.25c0-.621-.504-1.125-1.125-1.125h-4.072M10.5 8.197l2.88-2.88c.438-.439 1.15-.439 1.59 0l3.712 3.713c.44.44.44 1.152 0 1.59l-2.879 2.88M6.75 17.25h.008v.008H6.75v-.008z" },
  { key: "connection", label: "模型与外部服务", icon: "M13.19 8.688a4.5 4.5 0 011.242 7.244l-4.5 4.5a4.5 4.5 0 01-6.364-6.364l1.757-1.757m13.35-.622l1.757-1.757a4.5 4.5 0 00-6.364-6.364l-4.5 4.5a4.5 4.5 0 001.242 7.244" },
  { key: "layout", label: "卡片布局", icon: "M3.75 6A2.25 2.25 0 016 3.75h2.25A2.25 2.25 0 0110.5 6v2.25a2.25 2.25 0 01-2.25 2.25H6a2.25 2.25 0 01-2.25-2.25V6zM3.75 15.75A2.25 2.25 0 016 13.5h2.25a2.25 2.25 0 012.25 2.25V18a2.25 2.25 0 01-2.25 2.25H6A2.25 2.25 0 013.75 18v-2.25zM13.5 6a2.25 2.25 0 012.25-2.25H18A2.25 2.25 0 0120.25 6v2.25A2.25 2.25 0 0118 10.5h-2.25a2.25 2.25 0 01-2.25-2.25V6zM13.5 15.75a2.25 2.25 0 012.25-2.25H18a2.25 2.25 0 012.25 2.25V18A2.25 2.25 0 0118 20.25h-2.25A2.25 2.25 0 0113.5 18v-2.25z" },
  { key: "models", label: "模型资源池", icon: "M9.75 3.104v5.714a2.25 2.25 0 01-.659 1.591L5 14.5M9.75 3.104c-.251.023-.501.05-.75.082m.75-.082a24.301 24.301 0 014.5 0m0 0v5.714c0 .597.237 1.17.659 1.591L19.8 15.3M14.25 3.104c.251.023.501.05.75.082M19.5 6.75l.75-.75M19.5 6.75H16.5M19.5 6.75V3.75M6.75 21h10.5a2.25 2.25 0 002.25-2.25V15a2.25 2.25 0 00-2.25-2.25H6.75A2.25 2.25 0 004.5 15v3.75A2.25 2.25 0 006.75 21z" },
  { key: "workspace-models", label: "工作台配置", icon: "M4.5 6.75h15M4.5 12h15m-15 5.25h15M8.25 4.5v4.5m7.5-4.5v4.5m-4.5.75v4.5m-3 0v4.5m7.5-4.5v4.5" },
  { key: "storyboard-presets", label: "角色预设", icon: "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8m11-3v6m-3-3h6" },
  { key: "announcements", label: "公告管理", icon: "M10.34 15.84c-.688-.06-1.386-.09-2.09-.09H7.5a4.5 4.5 0 110-9h.75c.704 0 1.402-.03 2.09-.09m0 9.18c.253.962.584 1.892.985 2.783.247.55.06 1.21-.463 1.511l-.657.38c-.551.318-1.26.117-1.527-.461a20.845 20.845 0 01-1.44-4.282m3.102.069a18.03 18.03 0 01-.59-4.59c0-1.586.205-3.124.59-4.59m0 9.18a23.848 23.848 0 018.835 2.535M10.34 6.66a23.847 23.847 0 008.835-2.535m0 0A23.74 23.74 0 0018.795 3m.38 1.125a23.91 23.91 0 011.014 5.395m-1.014 8.855c-.118.38-.245.754-.38 1.125m.38-1.125a23.91 23.91 0 001.014-5.395m0-3.46c.495.413.811 1.035.811 1.73 0 .695-.316 1.317-.811 1.73m0-3.46a24.347 24.347 0 010 3.46" },
  { key: "health", label: "系统运维", icon: "M21 8.25c0-2.485-2.099-4.5-4.688-4.5-1.935 0-3.597 1.126-4.312 2.733-.715-1.607-2.377-2.733-4.313-2.733C5.1 3.75 3 5.765 3 8.25c0 7.22 9 12 9 12s9-4.78 9-12z" },
  { key: "security", label: "安全中心", icon: "M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285z" },
  { key: "guard-logs", label: "提示词拦截", icon: "M12 9v3.75m0-10.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.75c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285z" },
  { key: "login-logs", label: "登录日志", icon: "M16.5 10.5V6.75a4.5 4.5 0 10-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H6.75a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z" },
  { key: "sync", label: "数据同步", icon: "M7.5 21L3 16.5m0 0L7.5 12M3 16.5h13.5m0-13.5L21 7.5m0 0L16.5 12M21 7.5H7.5" },
  { key: "backup", label: "数据备份", icon: "M20.25 6.375c0 2.278-3.694 4.125-8.25 4.125S3.75 8.653 3.75 6.375m16.5 0c0-2.278-3.694-4.125-8.25-4.125S3.75 4.097 3.75 6.375m16.5 0v11.25c0 2.278-3.694 4.125-8.25 4.125s-8.25-1.847-8.25-4.125V6.375m16.5 0v3.75m-16.5-3.75v3.75m16.5 0v3.75C20.25 16.153 16.556 18 12 18s-8.25-1.847-8.25-4.125v-3.75m16.5 0c0 2.278-3.694 4.125-8.25 4.125s-8.25-1.847-8.25-4.125" },
  { key: "benefit-packages", label: "权益与礼包", icon: "M20 12v8H4v-8m16 0H4m16 0h2V7h-4m-14 5H2V7h4m6 13V7m0 0H8.5A2.5 2.5 0 118 2c2 0 4 5 4 5zm0 0h3.5A2.5 2.5 0 1016 2c-2 0-4 5-4 5z" },
  { key: "cami", label: "卡密管理", icon: "M15 5v2m0 4v2m0 4v2M5 5a2 2 0 00-2 2v3a2 2 0 110 4v3a2 2 0 002 2h14a2 2 0 002-2v-3a2 2 0 110-4V7a2 2 0 00-2-2H5z" },
  { key: "payment", label: "支付配置", icon: "M2.25 8.25h15l1.5 10.5H3.75L2.25 8.25zM6.75 8.25V6a2.25 2.25 0 012.25-2.25h0A2.25 2.25 0 0111.25 6v2.25M15 12.75a1.5 1.5 0 11-3 0 1.5 1.5 0 013 0z" },
  { key: "billing-audit", label: "计费审计", icon: "M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" },
  { key: "aiweb-import", label: "智能体导入", icon: "M4.5 12a7.5 7.5 0 0015 0m-15 0a7.5 7.5 0 1115 0m-15 0H3m16.5 0H21m-1.5 0H12m-8.457 3.077l1.41-.513m14.095-5.13l1.41-.513M5.106 17.785l1.15-.964m11.49-9.642l1.149-.964M7.501 19.795l.75-1.3m7.5-12.99l.75-1.3m-6.063 16.658l.26-1.477m2.605-14.772l.26-1.477m0 17.726l-.26-1.477M10.698 4.614l-.26-1.477M16.5 19.794l-.75-1.299M7.5 4.205L12 12m0 0l4.5 7.795M12 12L7.5 4.205" },
  { key: "white-label", label: "域名与贴牌", icon: "M12 21a9.004 9.004 0 008.716-6.75M12 21a9.004 9.004 0 01-8.716-6.75M12 21c2.485 0 4.5-4.03 4.5-9S14.485 3 12 3m0 18c-2.485 0-4.5-4.03-4.5-9S9.515 3 12 3m0 0a9 9 0 018.716 6.75M12 3a9 9 0 00-8.716 6.75m17.432 0A17.93 17.93 0 0112 12c-3.162 0-6.133-.815-8.716-2.25m17.432 0a9.035 9.035 0 010 4.5m0 0A17.93 17.93 0 0112 16.5c-3.162 0-6.133-.815-8.716-2.25m0-4.5a9.035 9.035 0 000 4.5" },
];

const ADMIN_PRIMARY_NAVIGATION: Array<{ root: Tab; title: string; tabs: Tab[] }> = [
  { root: "dashboard", title: "平台指挥中心", tabs: ["dashboard"] },
  { root: "users", title: "会员管理", tabs: ["users", "invitations"] },
  { root: "benefit-packages", title: "权益与卡密", tabs: ["benefit-packages", "cami"] },
  { root: "credits", title: "财务与账单", tabs: ["credits", "offline-payments", "billing-audit"] },
  { root: "payment", title: "支付系统", tabs: ["payment"] },
  { root: "announcements", title: "公告与通知", tabs: ["announcements"] },
  { root: "agents", title: "智能体管理", tabs: ["agents", "aiweb-import", "trash"] },
  { root: "models", title: "模型与服务", tabs: ["models", "connection"] },
  { root: "workspace-models", title: "工作台配置", tabs: ["workspace-models", "storyboard-presets"] },
  { root: "general", title: "品牌与界面", tabs: ["general", "theme", "layout"] },
  { root: "white-label", title: "域名与贴牌", tabs: ["white-label"] },
  { root: "security", title: "安全审计", tabs: ["security", "guard-logs", "login-logs"] },
  { root: "health", title: "系统运维", tabs: ["health", "sync", "backup"] },
  { root: "super-admin", title: "权限管理", tabs: ["super-admin"] },
];

const ADMIN_TABS_BY_KEY = new Map(TABS.map((tab) => [tab.key, tab]));

const ADMIN_SECONDARY_LABELS: Partial<Record<Tab, string>> = {
  "super-admin": "权限管理",
  users: "会员档案",
  credits: "资金账户",
  connection: "外部服务",
  security: "安全总览",
  health: "系统健康",
  backup: "灾备证据",
};

function adminModuleForTab(tab: Tab) {
  return ADMIN_PRIMARY_NAVIGATION.find((module) => module.tabs.includes(tab));
}

function canExposeAdminTab(state: AdminAccessClientState | null, tab: Tab): boolean {
  if (!state) return false;
  if (tab === "super-admin") return state.access.authorityStatus === "ready"
    && state.access.integrityValid && state.tabAccess[tab] === true;
  if (tab === "aiweb-import" && !state.access.permissionKeys.includes("prompts.edit")) return false;
  return state.tabAccess[tab] === true;
}

const BASE_WORKSPACE_PROJECT_IDS: readonly WorkspaceProjectId[] = [
  "image",
  "cover",
  "storyboard",
  "video",
  "film",
];

// 旧书签仅做一次 URL 迁移，不再作为后台正式 tab 或前端导航项。
const LEGACY_WORKSPACE_TAB_PROJECT: Readonly<Record<string, WorkspaceProjectId>> = {
  commerce: "commerce",
  "digital-human": "video",
  "voice-studio": "voice",
  "manju-workbench": "manju",
  plugins: "tools",
  // The legacy editor and API are retired. Keep its stable deep link useful by
  // taking administrators to the live storyboard workspace configuration.
  "canvas-prompts": "storyboard",
};

const WORKSPACE_PROJECT_IDS: WorkspaceProjectId[] = [
  "image", "cover", "storyboard", "video", "film",
  "voice", "commerce", "manju", "tools",
];

function isWorkspaceProjectId(value: unknown): value is WorkspaceProjectId {
  return typeof value === "string" && WORKSPACE_PROJECT_IDS.includes(value as WorkspaceProjectId);
}

function normalizeWorkspaceProject(value: unknown): WorkspaceProjectId | null {
  if (value === "digital-human") return "video";
  return isWorkspaceProjectId(value) ? value : null;
}

// 分类列表已改为从API动态加载（见 categories state + loadCategories），此处保留兜底默认值
const FALLBACK_CATEGORIES = ["通用", "视频生成", "视频带货", "文案/撰写", "营销策略", "商业IP打造", "同城实体引流", "数据分析", "其他"];

// Dark theme input classes
const inputCls = "w-full px-3 py-2.5 bg-[var(--card)] border border-[var(--border)] rounded-xl text-sm text-[var(--foreground)] outline-none focus:border-[var(--primary)] transition-colors placeholder-[var(--muted-foreground)]";
const labelCls = "block text-sm text-[var(--secondary-foreground)] mb-1.5";
const cardCls = "bg-[var(--card)] rounded-2xl p-6 border border-[var(--border)]";
const btnPrimary = "px-4 py-2.5 bg-[var(--card)] text-[var(--foreground)] border border-[var(--border)] rounded-xl text-sm font-semibold hover:bg-[var(--accent)] hover:border-[var(--primary)]/30 transition-colors";
const btnGhost = "px-4 py-2.5 text-[var(--secondary-foreground)] rounded-xl text-sm hover:bg-[var(--border)] transition-colors";

function isFixtureUser(user?: UserInfo | null): boolean {
  return Boolean(user?.accountFlags?.isFixture || user?.accountKind === "fixture");
}

function getUserAccountStatus(user: UserInfo): "active" | "suspended" | "blocked" {
  if (user.status === "blocked" || user.status === "suspended" || user.status === "active") return user.status;
  return (user.isActive ?? user.is_active) === false ? "suspended" : "active";
}

function formatAdminDate(value?: string | null): string {
  if (!value) return "暂无";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "暂无";
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const valueOf = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value || "--";
  return `${valueOf("year")}-${valueOf("month")}-${valueOf("day")} ${valueOf("hour")}:${valueOf("minute")}`;
}

async function downloadAdminReconciliation(url: string, token: string | null, fallbackName: string) {
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token || ""}` }, cache: "no-store" });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error || "对账文件生成失败");
  }
  const blob = await response.blob();
  const disposition = response.headers.get("content-disposition") || "";
  const encodedName = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  const fileName = encodedName ? decodeURIComponent(encodedName) : fallbackName;
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = objectUrl;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(objectUrl);
}

function formatAccountFlagReasons(user: UserInfo): string {
  return (user.accountFlagReasons || user.accountFlags?.reasons || []).join("、");
}

type OfflinePaymentReceipt = {
  id: string;
  user_id: string;
  payment_channel: "wechat" | "alipay" | "bank_transfer" | "cash" | "other";
  business_type: string;
  amount: number;
  currency: string;
  paid_at: string;
  merchant_reference?: string | null;
  payer_reference_masked?: string | null;
  note?: string | null;
  status: "confirmed" | "voided";
  activation_event_id?: string | null;
  created_at: string;
  voided_at?: string | null;
  void_reason?: string | null;
  user?: { id: string; username?: string; display_name?: string; phone?: string; email?: string; member_status?: string } | null;
};

function localDateTimeInputValue() {
  const now = new Date();
  now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
  return now.toISOString().slice(0, 16);
}

function OfflinePaymentsTab({
  token,
  users,
  focusUserId = "",
  focusUserLabel = "",
  onClearFocus,
  onMemberChanged,
  showToast,
  hasWalletAdjustPermission,
  canAdjustWallet,
  hasBillingExportPermission,
  canExportBilling,
  onRequestUnlock,
}: {
  token: string | null;
  users: UserInfo[];
  focusUserId?: string;
  focusUserLabel?: string;
  onClearFocus?: () => void;
  onMemberChanged: () => unknown | Promise<unknown>;
  showToast: (type: "success" | "error", text: string) => void;
  hasWalletAdjustPermission: boolean;
  canAdjustWallet: boolean;
  hasBillingExportPermission: boolean;
  canExportBilling: boolean;
  onRequestUnlock: () => void;
}) {
  const eligibleUsers = useMemo(() => users.filter((user) => user.role !== "admin" && !isFixtureUser(user)), [users]);
  const [receipts, setReceipts] = useState<OfflinePaymentReceipt[]>([]);
  const [summary, setSummary] = useState({ confirmedCount: 0, confirmedAmount: 0, voidedCount: 0, wechatAmount: 0, truncated: false });
  const [loadingReceipts, setLoadingReceipts] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [page, setPage] = useState(1);
  const [totalCount, setTotalCount] = useState(0);
  const [statusFilter, setStatusFilter] = useState("");
  const [channelFilter, setChannelFilter] = useState("");
  const [search, setSearch] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [exporting, setExporting] = useState(false);
  const submissionKeyRef = useRef("");
  const showToastRef = useRef(showToast);
  const [form, setForm] = useState({
    userId: focusUserId,
    paymentChannel: "wechat",
    amount: "3980",
    paidAt: localDateTimeInputValue(),
    merchantReference: "",
    payerReferenceMasked: "",
    note: "",
  });

  useEffect(() => {
    if (focusUserId) setForm((current) => ({ ...current, userId: focusUserId }));
  }, [focusUserId]);
  useEffect(() => { showToastRef.current = showToast; }, [showToast]);

  const setFormField = (key: keyof typeof form, value: string) => {
    submissionKeyRef.current = "";
    setConfirmed(false);
    setForm((current) => ({ ...current, [key]: value }));
  };

  const loadReceipts = useCallback(async () => {
    if (!token) return;
    setLoadingReceipts(true);
    try {
      const params = new URLSearchParams({ page: String(page), pageSize: "30" });
      if (focusUserId) params.set("userId", focusUserId);
      if (statusFilter) params.set("status", statusFilter);
      if (channelFilter) params.set("channel", channelFilter);
      if (search.trim()) params.set("search", search.trim());
      const response = await fetch(`/api/admin/offline-payments?${params}`, {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || "线下收款凭证加载失败");
      setReceipts(payload.receipts || []);
      setSummary({
        confirmedCount: Number(payload.summary?.confirmedCount || 0),
        confirmedAmount: Number(payload.summary?.confirmedAmount || 0),
        voidedCount: Number(payload.summary?.voidedCount || 0),
        wechatAmount: Number(payload.summary?.wechatAmount || 0),
        truncated: Boolean(payload.summary?.truncated),
      });
      setTotalCount(Number(payload.totalCount || 0));
    } catch (error) {
      showToastRef.current("error", error instanceof Error ? error.message : "线下收款凭证加载失败");
    } finally {
      setLoadingReceipts(false);
    }
  }, [channelFilter, focusUserId, page, search, statusFilter, token]);

  useEffect(() => { void loadReceipts(); }, [loadReceipts]);

  const submitReceipt = async () => {
    if (!hasWalletAdjustPermission) return;
    if (!canAdjustWallet) {
      onRequestUnlock();
      return;
    }
    const amount = Number(form.amount);
    if (!form.userId || !Number.isFinite(amount) || amount <= 0 || !form.paidAt) {
      showToast("error", "请选择学员并填写有效金额和付款时间");
      return;
    }
    if (form.paymentChannel !== "cash" && form.merchantReference.trim().length < 4) {
      showToast("error", "非现金收款必须填写至少 4 位可核对交易流水号");
      return;
    }
    if (!confirmed) {
      showToast("error", "请先确认已经核对到账事实与学员归属");
      return;
    }
    const target = eligibleUsers.find((user) => user.id === form.userId);
    if (!target || target.memberStatus === "active") {
      showToast("error", "该学员不可执行首次学费补录与激活");
      return;
    }
    setSubmitting(true);
    try {
      const idempotencyKey = submissionKeyRef.current || `offline-payment:${form.userId}:${crypto.randomUUID()}`;
      submissionKeyRef.current = idempotencyKey;
      const response = await fetch("/api/admin/offline-payments", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
        body: JSON.stringify({
          ...form,
          amount,
          paidAt: new Date(form.paidAt).toISOString(),
          businessType: "membership_tuition",
          idempotencyKey,
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || "线下收款补录失败");
      submissionKeyRef.current = "";
      setConfirmed(false);
      setForm((current) => ({ ...current, merchantReference: "", payerReferenceMasked: "", note: "", paidAt: localDateTimeInputValue() }));
      showToast("success", "线下收款凭证已入账，会员已激活；邀请礼包仍需到邀请关系手动确认");
      await Promise.resolve(onMemberChanged());
      await loadReceipts();
    } catch (error) {
      showToast("error", `${error instanceof Error ? error.message : "线下收款补录失败"}。如网络中断，请直接重试当前表单，系统会复用同一操作编号。`);
    } finally {
      setSubmitting(false);
    }
  };

  const voidReceipt = async (receipt: OfflinePaymentReceipt) => {
    if (!hasWalletAdjustPermission) return;
    if (!canAdjustWallet) {
      onRequestUnlock();
      return;
    }
    const reason = window.prompt("请输入作废原因（至少 4 个字）。作废只冲销凭证，不会自动停用会员，需另行复核会员状态。", "");
    if (reason === null) return;
    if (reason.trim().length < 4) {
      showToast("error", "作废原因至少填写 4 个字");
      return;
    }
    if (!window.confirm(`确认作废收款凭证 ${receipt.merchant_reference || receipt.id}？原凭证会永久保留。`)) return;
    try {
      const idempotencyKey = `offline-payment-void:${receipt.id}:${crypto.randomUUID()}`;
      const response = await fetch("/api/admin/offline-payments", {
        method: "PATCH",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
        body: JSON.stringify({ receiptId: receipt.id, voidReason: reason.trim(), idempotencyKey }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || "凭证作废失败");
      showToast("success", "凭证已作废并保留审计记录；请到学员档案单独复核是否停用会员");
      await loadReceipts();
    } catch (error) {
      showToast("error", error instanceof Error ? error.message : "凭证作废失败");
    }
  };

  const exportAll = async () => {
    if (!hasBillingExportPermission) return;
    if (!canExportBilling) {
      onRequestUnlock();
      return;
    }
    setExporting(true);
    try {
      const params = new URLSearchParams({ format: "csv" });
      if (focusUserId) params.set("userId", focusUserId);
      await downloadAdminReconciliation(`/api/admin/reconciliation/recharges?${params}`, token, "会员资金完整对账.csv");
      showToast("success", focusUserId ? "已下载该学员的完整资金对账" : "已下载公司完整会员资金对账");
    } catch (error) {
      showToast("error", error instanceof Error ? error.message : "对账下载失败");
    } finally {
      setExporting(false);
    }
  };

  const selectedUser = eligibleUsers.find((user) => user.id === form.userId);
  const channelLabels: Record<string, string> = { wechat: "微信转账", alipay: "支付宝转账", bank_transfer: "银行转账", cash: "现金", other: "其他" };
  const totalPages = Math.max(1, Math.ceil(totalCount / 30));

  return (
    <div className="space-y-5" data-testid="offline-payments-workspace">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-black text-[var(--foreground)]">线下收款与会员激活</h2>
          <p className="mt-1 text-sm text-[var(--muted-foreground)]">先核验微信/支付宝/银行到账，再由同一事务生成收款凭证并激活会员；邀请礼包不会自动发放。</p>
        </div>
        {hasBillingExportPermission && (
          <button type="button" onClick={() => void exportAll()} disabled={exporting} className="rounded-xl border border-[var(--border)] bg-[var(--card)] px-4 py-2 text-sm font-semibold text-[var(--foreground)] hover:border-[var(--primary)]/40 disabled:opacity-50">
            {exporting ? "正在汇总..." : focusUserId ? "下载该学员完整对账" : "下载公司完整资金对账"}
          </button>
        )}
      </div>

      {focusUserId && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-emerald-500/25 bg-emerald-500/8 px-4 py-3">
          <p className="text-sm text-[var(--foreground)]">当前从学员档案进入：<strong>{focusUserLabel || focusUserId}</strong>，凭证列表已限定到该学员。</p>
          <button type="button" onClick={() => { setFormField("userId", ""); onClearFocus?.(); }} className="text-xs font-semibold text-emerald-600 hover:underline">查看全部学员</button>
        </div>
      )}

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.45fr)_minmax(320px,0.75fr)]">
        {hasWalletAdjustPermission && (
        <section className={`${cardCls} space-y-5`}>
          <div>
            <h3 className="text-base font-bold text-[var(--foreground)]">补录已到账学费</h3>
            <p className="mt-1 text-xs leading-relaxed text-[var(--muted-foreground)]">适用于学员线下支付 3980 元学费。系统只保存交易流水号和付款方脱敏尾号，不保存微信昵称、完整账号或聊天截图。</p>
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <div className="md:col-span-2">
              <label className={labelCls}>学员 *</label>
              <select value={form.userId} onChange={(event) => setFormField("userId", event.target.value)} className={inputCls} data-testid="offline-payment-user">
                <option value="">请选择注册学员</option>
                {eligibleUsers.map((user) => <option key={user.id} value={user.id} disabled={user.memberStatus === "active"}>{user.name || user.displayName || user.username || user.phone || user.email}{user.memberStatus === "active" ? "（已是正式会员）" : ""}</option>)}
              </select>
            </div>
            <div>
              <label className={labelCls}>收款渠道 *</label>
              <select value={form.paymentChannel} onChange={(event) => setFormField("paymentChannel", event.target.value)} className={inputCls}>
                {Object.entries(channelLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </div>
            <div>
              <label className={labelCls}>实收金额（元）*</label>
              <input type="number" min="0.01" step="0.01" value={form.amount} onChange={(event) => setFormField("amount", event.target.value)} className={inputCls} />
            </div>
            <div>
              <label className={labelCls}>付款时间 *</label>
              <input type="datetime-local" value={form.paidAt} onChange={(event) => setFormField("paidAt", event.target.value)} className={inputCls} />
            </div>
            <div>
              <label className={labelCls}>{form.paymentChannel === "cash" ? "收据/凭证号（可选）" : "交易流水号 *"}</label>
              <input value={form.merchantReference} onChange={(event) => setFormField("merchantReference", event.target.value)} className={inputCls} placeholder={form.paymentChannel === "wechat" ? "微信支付账单详情中的交易单号" : "可唯一核对的渠道流水号"} />
            </div>
            <div>
              <label className={labelCls}>付款方脱敏标识（可选）</label>
              <input value={form.payerReferenceMasked} onChange={(event) => setFormField("payerReferenceMasked", event.target.value)} className={inputCls} placeholder="例如 ****2468，只填尾号" />
            </div>
            <div>
              <label className={labelCls}>内部备注（可选）</label>
              <input value={form.note} onChange={(event) => setFormField("note", event.target.value)} className={inputCls} placeholder="例如：财务已在微信账单核对" />
            </div>
          </div>
          <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-amber-500/25 bg-amber-500/8 px-4 py-3 text-sm leading-relaxed text-[var(--foreground)]">
            <input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} className="mt-1 h-4 w-4" />
            <span>我已核对真实到账、付款金额、付款时间和学员归属。提交后将生成不可删除的财务凭证并激活会员，但不会自动赠送积分、现金或邀请礼包。</span>
          </label>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-xs text-[var(--muted-foreground)]">当前对象：{selectedUser ? (selectedUser.name || selectedUser.displayName || selectedUser.username) : "尚未选择"}</p>
            <button type="button" onClick={() => void submitReceipt()} disabled={submitting || !confirmed} className={`${btnPrimary} disabled:cursor-not-allowed disabled:opacity-40`} data-testid="offline-payment-submit">{submitting ? "正在入账..." : "确认入账并激活会员"}</button>
          </div>
        </section>
        )}

        <aside className={`${cardCls} h-fit space-y-4`}>
          <div>
            <h3 className="text-base font-bold text-[var(--foreground)]">数据安全边界</h3>
            <p className="mt-1 text-xs text-[var(--muted-foreground)]">财务凭证仅管理员可读；普通会员与匿名访问均被数据库权限拒绝。</p>
          </div>
          <div className="space-y-3 text-sm text-[var(--secondary-foreground)]">
            <p><strong className="text-[var(--foreground)]">最小化采集：</strong>只录流水号和脱敏尾号，不录完整微信号、身份证或支付截图。</p>
            <p><strong className="text-[var(--foreground)]">防重复入账：</strong>渠道 + 流水号永久唯一，重复提交复用同一操作编号。</p>
            <p><strong className="text-[var(--foreground)]">不可篡改：</strong>原凭证不能删除或覆盖；错误记录只能填写原因后作废。</p>
            <p><strong className="text-[var(--foreground)]">职责分离：</strong>收款只完成会员激活，邀请礼包必须另行人工确认与推送。</p>
          </div>
        </aside>
      </div>

      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <div className={`${cardCls} p-4`}><p className="text-xs text-[var(--muted-foreground)]">已确认线下收款</p><p className="mt-1 text-2xl font-black text-emerald-600">¥{summary.confirmedAmount.toFixed(2)}</p><p className="mt-1 text-xs text-[var(--muted-foreground)]">{summary.confirmedCount} 笔</p></div>
        <div className={`${cardCls} p-4`}><p className="text-xs text-[var(--muted-foreground)]">其中微信转账</p><p className="mt-1 text-2xl font-black text-green-600">¥{summary.wechatAmount.toFixed(2)}</p></div>
        <div className={`${cardCls} p-4`}><p className="text-xs text-[var(--muted-foreground)]">已作废凭证</p><p className={`mt-1 text-2xl font-black ${summary.voidedCount ? "text-amber-600" : "text-[var(--foreground)]"}`}>{summary.voidedCount}</p></div>
        <div className={`${cardCls} p-4`}><p className="text-xs text-[var(--muted-foreground)]">当前筛选记录</p><p className="mt-1 text-2xl font-black text-[var(--foreground)]">{totalCount}</p>{summary.truncated && <p className="mt-1 text-xs text-amber-600">汇总超过 10 万条，请使用对账导出</p>}</div>
      </div>

      <section className={`${cardCls} space-y-4`}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div><h3 className="text-base font-bold text-[var(--foreground)]">线下收款凭证</h3><p className="mt-1 text-xs text-[var(--muted-foreground)]">凭证状态与会员状态分开管理；作废凭证后系统不会擅自停用会员。</p></div>
          <div className="flex flex-wrap gap-2">
            <input value={search} onChange={(event) => { setSearch(event.target.value); setPage(1); }} className="rounded-lg border border-[var(--border)] bg-[var(--background)] px-3 py-2 text-sm" placeholder="搜索流水号/备注" />
            <select value={channelFilter} onChange={(event) => { setChannelFilter(event.target.value); setPage(1); }} className="rounded-lg border border-[var(--border)] bg-[var(--background)] px-3 py-2 text-sm"><option value="">全部渠道</option>{Object.entries(channelLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
            <select value={statusFilter} onChange={(event) => { setStatusFilter(event.target.value); setPage(1); }} className="rounded-lg border border-[var(--border)] bg-[var(--background)] px-3 py-2 text-sm"><option value="">全部状态</option><option value="confirmed">已确认</option><option value="voided">已作废</option></select>
            <button type="button" onClick={() => void loadReceipts()} className={btnGhost}>{loadingReceipts ? "加载中..." : "刷新"}</button>
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[980px] text-sm">
            <thead><tr className="border-b border-[var(--border)] text-left text-xs text-[var(--muted-foreground)]"><th className="px-3 py-3">付款时间</th><th className="px-3 py-3">学员</th><th className="px-3 py-3">渠道 / 流水号</th><th className="px-3 py-3 text-right">实收</th><th className="px-3 py-3">凭证状态</th><th className="px-3 py-3">会员激活</th><th className="px-3 py-3 text-right">操作</th></tr></thead>
            <tbody>
              {receipts.map((receipt) => (
                <tr key={receipt.id} className="border-b border-[var(--border)]/70 align-top last:border-0">
                  <td className="px-3 py-3 whitespace-nowrap">{formatAdminDate(receipt.paid_at)}</td>
                  <td className="px-3 py-3"><p className="font-semibold text-[var(--foreground)]">{receipt.user?.display_name || receipt.user?.username || "未知学员"}</p><p className="mt-0.5 text-xs text-[var(--muted-foreground)]">{receipt.user?.phone || receipt.user?.email || receipt.user_id}</p></td>
                  <td className="px-3 py-3"><p>{channelLabels[receipt.payment_channel] || receipt.payment_channel}</p><p className="mt-0.5 max-w-[260px] break-all font-mono text-xs text-[var(--muted-foreground)]">{receipt.merchant_reference || "无流水号"}</p>{receipt.payer_reference_masked && <p className="mt-0.5 text-xs text-[var(--muted-foreground)]">付款方 {receipt.payer_reference_masked}</p>}</td>
                  <td className="px-3 py-3 text-right font-bold text-[var(--foreground)]">¥{Number(receipt.amount || 0).toFixed(2)}</td>
                  <td className="px-3 py-3"><span className={`rounded-full px-2 py-1 text-xs font-semibold ${receipt.status === "confirmed" ? "bg-emerald-500/10 text-emerald-600" : "bg-amber-500/10 text-amber-600"}`}>{receipt.status === "confirmed" ? "已确认" : "已作废"}</span>{receipt.void_reason && <p className="mt-1 max-w-[220px] text-xs text-amber-600">{receipt.void_reason}</p>}</td>
                  <td className="px-3 py-3">{receipt.activation_event_id ? <span className="text-emerald-600">已生成激活事件</span> : <span className="text-amber-600">待人工核对</span>}</td>
                  <td className="px-3 py-3 text-right">{receipt.status === "confirmed" && hasWalletAdjustPermission ? <button type="button" onClick={() => void voidReceipt(receipt)} className="text-xs font-semibold text-red-500 hover:underline">作废凭证</button> : <span className="text-xs text-[var(--muted-foreground)]">原记录保留</span>}</td>
                </tr>
              ))}
              {!loadingReceipts && receipts.length === 0 && <tr><td colSpan={7} className="px-4 py-12 text-center text-sm text-[var(--muted-foreground)]">暂无符合条件的线下收款凭证</td></tr>}
            </tbody>
          </table>
        </div>
        <div className="flex items-center justify-between gap-3 border-t border-[var(--border)] pt-4 text-sm"><span className="text-[var(--muted-foreground)]">第 {page} / {totalPages} 页，共 {totalCount} 条</span><div className="flex gap-2"><button type="button" disabled={page <= 1} onClick={() => setPage((current) => Math.max(1, current - 1))} className={`${btnGhost} disabled:opacity-40`}>上一页</button><button type="button" disabled={page >= totalPages} onClick={() => setPage((current) => Math.min(totalPages, current + 1))} className={`${btnGhost} disabled:opacity-40`}>下一页</button></div></div>
      </section>
    </div>
  );
}

// ── 收益统计组件（充值记录 / 消费明细，嵌入学员管理子Tab） ──
function RevenueTab({ token, showToast, allCategories, initialSubTab, hideHeader, hideSubTabs, hasBillingExportPermission, canExportBilling, onRequestUnlock }: { token: string | null; showToast: (type: "success" | "error", text: string) => void; allCategories: { id: string; name: string; icon?: string; visibility?: string }[]; initialSubTab?: "recharge" | "consumption"; hideHeader?: boolean; hideSubTabs?: boolean; hasBillingExportPermission: boolean; canExportBilling: boolean; onRequestUnlock: () => void }) {
  // 子Tab：充值记录 / 消费明细
  const [subTab, setSubTab] = useState<"recharge" | "consumption">(initialSubTab || "recharge");
  const [loading, setLoading] = useState(false);
  const [startDate, setStartDate] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() - 30);
    return d.toISOString().slice(0, 10);
  });
  const [endDate, setEndDate] = useState(() => new Date().toISOString().slice(0, 10));

  // ── 充值记录 ──
  const [rechargeRecords, setRechargeRecords] = useState<Array<{
    id: string; userId: string; userName: string; phone: string; email: string;
    amount: number; balanceAfter: number | null; transactionType: string;
    description: string; category: string; createdAt: string;
  }>>([]);
  const [rechargeTotalCount, setRechargeTotalCount] = useState(0);
  const [rechargePage, setRechargePage] = useState(1);
  const [rechargeType, setRechargeType] = useState<string>("");
  const [rechargeSummary, setRechargeSummary] = useState({ totalCredits: 0, totalCash: 0, count: 0, unmatchedOrders: 0, offlineAmount: 0, offlineCount: 0, offlineVoided: 0 });
  const [rechargeExporting, setRechargeExporting] = useState(false);

  // ── 消费明细 ──
  const [consumptionRecords, setConsumptionRecords] = useState<Array<{
    id: string; userId: string; userName: string; modelId: string;
    costPrice: number; sellingPrice: number; profit: number;
    recordType: string; taskId: string; createdAt: string;
    creditsCharged: number; cashCharged: number;
  }>>([]);
  const [consumptionTotalCount, setConsumptionTotalCount] = useState(0);
  const [consumptionPage, setConsumptionPage] = useState(1);
  const [consumptionType, setConsumptionType] = useState<string>("");

  const recordTypeLabels: Record<string, string> = {
    chat: "智能体对话", video: "视频生成", image: "封面制作",
    deep_thinking: "深度思考", extract: "文案提取",
  };

  // ── 充值记录加载 ──
  const fetchRechargeRecords = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ page: String(rechargePage), page_size: "20", type: "recharge" });
      if (startDate) params.set("start_date", startDate);
      if (endDate) params.set("end_date", endDate);
      if (rechargeType) params.set("category", rechargeType);
      const reconciliationParams = new URLSearchParams({ summaryOnly: "1" });
      if (startDate) reconciliationParams.set("startDate", startDate);
      if (endDate) reconciliationParams.set("endDate", endDate);
      if (rechargeType) reconciliationParams.set("category", rechargeType);
      const [res, summaryResponse] = await Promise.all([
        fetch(`/api/admin/user-transactions?${params}`, { headers: { Authorization: `Bearer ${token}` } }),
        fetch(`/api/admin/reconciliation/recharges?${reconciliationParams}`, { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" }),
      ]);
      if (res.ok) {
        const data = await res.json();
        setRechargeRecords(data.transactions || []);
        setRechargeTotalCount(data.totalCount || 0);
      }
      if (summaryResponse.ok) {
        const payload = await summaryResponse.json();
        setRechargeSummary({
          totalCredits: Number(payload.summary?.totalCreditsCredited || 0),
          totalCash: Number(payload.summary?.totalCashCredited || 0),
          count: Number(payload.summary?.creditedOperationCount || 0),
          unmatchedOrders: Number(payload.summary?.unmatchedOrderCount || 0),
          offlineAmount: Number(payload.summary?.offlineConfirmedAmount || 0),
          offlineCount: Number(payload.summary?.offlineConfirmedCount || 0),
          offlineVoided: Number(payload.summary?.offlineVoidedCount || 0),
        });
      }
    } catch (err) {
      console.error("充值记录加载失败:", err);
    } finally {
      setLoading(false);
    }
  }, [rechargePage, startDate, endDate, rechargeType, token]);

  // ── 学员列表加载 ──

  // ── 消费明细加载 ──
  const fetchConsumptionRecords = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ period: "detail", page: String(consumptionPage), page_size: "20" });
      if (startDate) params.set("start_date", startDate);
      if (endDate) params.set("end_date", endDate);
      if (consumptionType) params.set("record_type", consumptionType);
      const res = await fetch(`/api/admin/revenue?${params}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        const data = await res.json();
        setConsumptionRecords(data.records || []);
        setConsumptionTotalCount(data.totalCount || 0);
      }
    } catch (err) {
      console.error("消费明细加载失败:", err);
    } finally {
      setLoading(false);
    }
  }, [consumptionPage, startDate, endDate, token, consumptionType]);

  useEffect(() => { if (subTab === "recharge") fetchRechargeRecords(); }, [fetchRechargeRecords, subTab]);

  useEffect(() => { if (subTab === "consumption") fetchConsumptionRecords(); }, [fetchConsumptionRecords, subTab]);

  const exportRechargeReconciliation = async () => {
    if (!hasBillingExportPermission) return;
    if (!canExportBilling) {
      onRequestUnlock();
      return;
    }
    if (rechargeExporting) return;
    setRechargeExporting(true);
    try {
      const params = new URLSearchParams({ format: "csv" });
      if (startDate) params.set("startDate", startDate);
      if (endDate) params.set("endDate", endDate);
      if (rechargeType) params.set("category", rechargeType);
      await downloadAdminReconciliation(`/api/admin/reconciliation/recharges?${params}`, token, "会员充值对账.csv");
      showToast("success", "已按当前筛选下载完整会员充值对账表");
    } catch (error) {
      showToast("error", error instanceof Error ? error.message : "对账文件下载失败");
    } finally {
      setRechargeExporting(false);
    }
  };

  return (
    <div className="space-y-5">
      {!hideHeader && (
        <div>
          <h3 className="text-lg font-bold">经营数据中心</h3>
          <p className="text-sm text-[var(--muted-foreground)] mt-1">收益统计 · 学员消费 · 流水明细（管理员使用不计入统计）</p>
        </div>
      )}

      {/* 子Tab切换 */}
      {!hideSubTabs && (
        <div className="flex items-center gap-1 p-1 rounded-lg bg-[var(--muted)]/30 w-fit">
          {[
            { key: "recharge", label: "充值记录", icon: Wallet },
            { key: "consumption", label: "消费明细", icon: FileText },
          ].map(tab => (
            <button key={tab.key} onClick={() => setSubTab(tab.key as typeof subTab)}
              className={`flex items-center gap-1.5 px-4 py-2 rounded-md text-sm font-medium transition ${
                subTab === tab.key ? "bg-[var(--primary)] text-white shadow-sm" : "text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
              }`}>
              <tab.icon className="h-4 w-4" />
              {tab.label}
            </button>
          ))}
        </div>
      )}

      {/* ── 充值记录 ── */}
      {subTab === "recharge" && (
        <>
          {/* 汇总卡片 */}
          <div className="grid grid-cols-2 gap-4 xl:grid-cols-6">
            <div className={`${cardCls} p-4 text-center`}>
              <div className="text-xs text-[var(--muted-foreground)] mb-1">积分充值总额</div>
              <div className="text-2xl font-bold text-blue-600">{rechargeSummary.totalCredits.toLocaleString()} <span className="text-sm font-normal">积分</span></div>
            </div>
            <div className={`${cardCls} p-4 text-center`}>
              <div className="text-xs text-[var(--muted-foreground)] mb-1">现金充值总额</div>
              <div className="text-2xl font-bold text-green-600">¥{rechargeSummary.totalCash.toFixed(2)}</div>
            </div>
            <div className={`${cardCls} p-4 text-center`}>
              <div className="text-xs text-[var(--muted-foreground)] mb-1">充值笔数</div>
              <div className="text-2xl font-bold text-[var(--foreground)]">{rechargeSummary.count}</div>
            </div>
            <div className={`${cardCls} p-4 text-center`}>
              <div className="text-xs text-[var(--muted-foreground)] mb-1">未匹配钱包入账订单</div>
              <div className={`text-2xl font-bold ${rechargeSummary.unmatchedOrders > 0 ? "text-amber-600" : "text-emerald-600"}`}>{rechargeSummary.unmatchedOrders}</div>
            </div>
            <div className={`${cardCls} p-4 text-center`}>
              <div className="text-xs text-[var(--muted-foreground)] mb-1">线下会员学费</div>
              <div className="text-2xl font-bold text-emerald-600">¥{rechargeSummary.offlineAmount.toFixed(2)}</div>
              <div className="mt-1 text-[10px] text-[var(--muted-foreground)]">{rechargeSummary.offlineCount} 笔确认</div>
            </div>
            <div className={`${cardCls} p-4 text-center`}>
              <div className="text-xs text-[var(--muted-foreground)] mb-1">作废线下凭证</div>
              <div className={`text-2xl font-bold ${rechargeSummary.offlineVoided > 0 ? "text-amber-600" : "text-[var(--foreground)]"}`}>{rechargeSummary.offlineVoided}</div>
            </div>
          </div>

          {/* 筛选栏 */}
          <div className="flex items-center gap-4 flex-wrap">
            <select value={rechargeType} onChange={e => { setRechargeType(e.target.value); setRechargePage(1); }}
              className="px-3 py-2 rounded-lg border bg-[var(--background)] text-[var(--foreground)] text-sm">
              <option value="">全部类型</option>
              <option value="credits">积分充值</option>
              <option value="cash">现金充值</option>
            </select>
            <input type="date" value={startDate} onChange={e => setStartDate(e.target.value)}
              className="px-3 py-2 rounded-lg border bg-[var(--background)] text-[var(--foreground)] text-sm" />
            <input type="date" value={endDate} onChange={e => setEndDate(e.target.value)}
              className="px-3 py-2 rounded-lg border bg-[var(--background)] text-[var(--foreground)] text-sm" />
            <button onClick={fetchRechargeRecords} disabled={loading}
              className="px-4 py-2 rounded-lg bg-[var(--primary)] text-white text-sm font-medium hover:opacity-90 transition disabled:opacity-50">
              {loading ? "加载中..." : "查询"}
            </button>
            {hasBillingExportPermission && (
              <>
                <button type="button" onClick={() => void exportRechargeReconciliation()} disabled={rechargeExporting}
                  className="px-4 py-2 rounded-lg border border-[var(--border)] bg-[var(--card)] text-[var(--foreground)] text-sm font-semibold hover:border-[var(--primary)]/40 transition disabled:opacity-50">
                  {rechargeExporting ? "正在汇总..." : "下载完整对账表 CSV"}
                </button>
                <span className="text-xs text-[var(--muted-foreground)]">导出包含当前日期/钱包筛选下的全部记录，不受页面分页限制。</span>
              </>
            )}
          </div>

          {/* 充值记录表格 */}
          <div className={`${cardCls} overflow-hidden p-0`}>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[var(--border)] bg-[var(--muted)]/30">
                  <th className="text-left px-4 py-3 font-medium text-[var(--muted-foreground)]">时间</th>
                  <th className="text-left px-4 py-3 font-medium text-[var(--muted-foreground)]">学员</th>
                  <th className="text-left px-4 py-3 font-medium text-[var(--muted-foreground)]">联系方式</th>
                  <th className="text-center px-4 py-3 font-medium text-[var(--muted-foreground)]">类型</th>
                  <th className="text-right px-4 py-3 font-medium text-[var(--muted-foreground)]">金额</th>
                  <th className="text-left px-4 py-3 font-medium text-[var(--muted-foreground)]">说明</th>
                </tr>
              </thead>
              <tbody>
                {rechargeRecords.length === 0 ? (
                  <tr><td colSpan={6} className="text-center py-8 text-[var(--muted-foreground)]">{loading ? "加载中..." : "暂无充值记录"}</td></tr>
                ) : rechargeRecords.map(r => (
                  <tr key={r.id} className="border-b border-[var(--border)] hover:bg-[var(--muted)]/20 transition cursor-pointer"
                    >
                    <td className="px-4 py-3 text-[var(--muted-foreground)] text-xs whitespace-nowrap">
                      {r.createdAt ? new Date(r.createdAt).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "-"}
                    </td>
                    <td className="px-4 py-3 font-medium text-[var(--primary)] hover:underline">{r.userName || "未知"}</td>
                    <td className="px-4 py-3 text-[var(--muted-foreground)] text-xs">{r.phone || r.email || "-"}</td>
                    <td className="px-4 py-3 text-center">
                      <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
                        r.category === "credits" ? "bg-blue-100 text-blue-700" : "bg-green-100 text-green-700"
                      }`}>
                        {r.category === "credits" ? "积分" : "现金"}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right font-mono font-medium text-green-600">
                      {r.category === "credits" ? `+${r.amount}` : `+¥${r.amount.toFixed(2)}`}
                    </td>
                    <td className="px-4 py-3 text-[var(--muted-foreground)] text-xs max-w-[200px] truncate" title={r.description}>{r.description || "-"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* 分页 */}
          {Math.ceil(rechargeTotalCount / 20) > 1 && (
            <div className="flex items-center justify-center gap-2">
              <button onClick={() => setRechargePage(p => Math.max(1, p - 1))} disabled={rechargePage <= 1}
                className="px-3 py-1.5 rounded border text-sm hover:bg-[var(--muted)]/20 disabled:opacity-40">上一页</button>
              <span className="text-sm text-[var(--muted-foreground)]">{rechargePage} / {Math.ceil(rechargeTotalCount / 20)}（共{rechargeTotalCount}条）</span>
              <button onClick={() => setRechargePage(p => Math.min(Math.ceil(rechargeTotalCount / 20), p + 1))} disabled={rechargePage >= Math.ceil(rechargeTotalCount / 20)}
                className="px-3 py-1.5 rounded border text-sm hover:bg-[var(--muted)]/20 disabled:opacity-40">下一页</button>
            </div>
          )}
        </>
      )}

      {/* ── 消费明细 ── */}
      {subTab === "consumption" && (
        <>
          {/* 筛选栏 */}
          <div className="flex items-center gap-4 flex-wrap">
            <select value={consumptionType} onChange={e => { setConsumptionType(e.target.value); setConsumptionPage(1); }}
              className="px-3 py-2 rounded-lg border bg-[var(--background)] text-[var(--foreground)] text-sm">
              <option value="">全部类型</option>
              <option value="chat">智能体对话</option>
              <option value="video">视频生成</option>
              <option value="image">封面制作</option>
              <option value="deep_thinking">深度思考</option>
              <option value="extract">文案提取</option>
            </select>
            <input type="date" value={startDate} onChange={e => setStartDate(e.target.value)}
              className="px-3 py-2 rounded-lg border bg-[var(--background)] text-[var(--foreground)] text-sm" />
            <input type="date" value={endDate} onChange={e => setEndDate(e.target.value)}
              className="px-3 py-2 rounded-lg border bg-[var(--background)] text-[var(--foreground)] text-sm" />
            <button onClick={fetchConsumptionRecords} disabled={loading}
              className="px-4 py-2 rounded-lg bg-[var(--primary)] text-white text-sm font-medium hover:opacity-90 transition disabled:opacity-50">
              {loading ? "加载中..." : "查询"}
            </button>
          </div>

          {/* 消费汇总 */}
          <div className="grid grid-cols-3 gap-4">
            <div className={`${cardCls} p-4 text-center`}>
              <div className="text-xs text-[var(--muted-foreground)] mb-1">积分消费总额</div>
              <div className="text-2xl font-bold text-amber-600">{consumptionRecords.reduce((s, r) => s + (r.creditsCharged || 0), 0).toFixed(2)} <span className="text-sm font-normal">积分</span></div>
            </div>
            <div className={`${cardCls} p-4 text-center`}>
              <div className="text-xs text-[var(--muted-foreground)] mb-1">现金消费总额</div>
              <div className="text-2xl font-bold text-red-500">¥{consumptionRecords.reduce((s, r) => s + (r.cashCharged || 0), 0).toFixed(2)}</div>
            </div>
            <div className={`${cardCls} p-4 text-center`}>
              <div className="text-xs text-[var(--muted-foreground)] mb-1">消费笔数</div>
              <div className="text-2xl font-bold text-[var(--foreground)]">{consumptionTotalCount}</div>
            </div>
          </div>

          {/* 消费明细表格 */}
          <div className={`${cardCls} overflow-hidden p-0`}>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[var(--border)] bg-[var(--muted)]/30">
                  <th className="text-left px-4 py-3 font-medium text-[var(--muted-foreground)]">时间</th>
                  <th className="text-left px-4 py-3 font-medium text-[var(--muted-foreground)]">学员</th>
                  <th className="text-left px-4 py-3 font-medium text-[var(--muted-foreground)]">类型</th>
                  <th className="text-left px-4 py-3 font-medium text-[var(--muted-foreground)]">模型/任务</th>
                  <th className="text-right px-4 py-3 font-medium text-[var(--muted-foreground)]">扣费</th>
                  <th className="text-right px-4 py-3 font-medium text-[var(--muted-foreground)]">售价</th>
                  <th className="text-right px-4 py-3 font-medium text-[var(--muted-foreground)]">成本</th>
                  <th className="text-right px-4 py-3 font-medium text-[var(--muted-foreground)]">利润</th>
                </tr>
              </thead>
              <tbody>
                {consumptionRecords.length === 0 ? (
                  <tr><td colSpan={8} className="text-center py-8 text-[var(--muted-foreground)]">{loading ? "加载中..." : "暂无消费数据"}</td></tr>
                ) : consumptionRecords.map(r => (
                  <tr key={r.id} className="border-b border-[var(--border)] hover:bg-[var(--muted)]/20 transition">
                    <td className="px-4 py-3 text-[var(--muted-foreground)] text-xs whitespace-nowrap">
                      {r.createdAt ? new Date(r.createdAt).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "-"}
                    </td>
                    <td className="px-4 py-3">
                      <span className="text-xs font-medium">{r.userName}</span>
                    </td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
                        r.recordType === "video" ? "bg-purple-100 text-purple-700" :
                        r.recordType === "chat" ? "bg-blue-100 text-blue-700" :
                        r.recordType === "image" ? "bg-pink-100 text-pink-700" :
                        r.recordType === "deep_thinking" ? "bg-amber-100 text-amber-700" :
                        r.recordType === "extract" ? "bg-teal-100 text-teal-700" :
                        "bg-gray-100 text-gray-700"
                      }`}>
                        {recordTypeLabels[r.recordType] || r.recordType}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-[var(--foreground)] text-xs max-w-[200px] truncate" title={r.modelId}>{r.modelId}</td>
                    <td className="px-4 py-3 text-right font-mono text-xs">
                      {r.creditsCharged > 0 ? (
                        <span className="text-amber-600">-{r.creditsCharged.toFixed(2)}<span className="text-[10px] ml-0.5 opacity-70">积分</span></span>
                      ) : r.cashCharged > 0 ? (
                        <span className="text-red-500">-¥{r.cashCharged.toFixed(2)}<span className="text-[10px] ml-0.5 opacity-70">现金</span></span>
                      ) : (
                        <span className="text-[var(--muted-foreground)]">-</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right text-green-600 font-mono">¥{r.sellingPrice.toFixed(4)}</td>
                    <td className="px-4 py-3 text-right text-orange-500 font-mono">¥{r.costPrice.toFixed(4)}</td>
                    <td className="px-4 py-3 text-right text-blue-600 font-mono font-medium">¥{r.profit.toFixed(4)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* 分页 */}
          {Math.ceil(consumptionTotalCount / 20) > 1 && (
            <div className="flex items-center justify-center gap-2">
              <button onClick={() => setConsumptionPage(p => Math.max(1, p - 1))} disabled={consumptionPage <= 1}
                className="px-3 py-1.5 rounded border text-sm hover:bg-[var(--muted)]/20 disabled:opacity-40">上一页</button>
              <span className="text-sm text-[var(--muted-foreground)]">{consumptionPage} / {Math.ceil(consumptionTotalCount / 20)}（共{consumptionTotalCount}条）</span>
              <button onClick={() => setConsumptionPage(p => Math.min(Math.ceil(consumptionTotalCount / 20), p + 1))} disabled={consumptionPage >= Math.ceil(consumptionTotalCount / 20)}
                className="px-3 py-1.5 rounded border text-sm hover:bg-[var(--muted)]/20 disabled:opacity-40">下一页</button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ============ 试用套餐管理 Tab ============
interface TrialPlanInfo {
  id: string;
  name: string;
  description: string;
  credits: number;
  duration_days: number;
  is_active: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
  agent_ids?: string[];
}

// ============ AIWeb 导入 Tab ============
function AIWebImportTab({ token, onImportComplete }: { token: string | null; onImportComplete: () => void }) {
  const [aiwebUrl, setAiwebUrl] = useState("http://121.40.25.118:9520");
  const [aiwebUsername, setAiwebUsername] = useState("super");
  const [aiwebPassword, setAiwebPassword] = useState("");
  const [targetCategory, setTargetCategory] = useState("文案/撰写");
  const [skipExisting, setSkipExisting] = useState(true);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<{
    success: boolean;
    summary: { total: number; created: number; skipped: number; errors: number };
    categories: Array<{ id: string; name: string }>;
    results: Array<{ name: string; status: string; error?: string }>;
  } | null>(null);
  const [error, setError] = useState("");

  const handleImport = async () => {
    if (!aiwebUrl || !aiwebUsername || !aiwebPassword) {
      setError("请填写AIWeb平台地址、用户名和密码");
      return;
    }
    setImporting(true);
    setError("");
    setImportResult(null);
    try {
      const resp = await fetch("/api/admin/aiweb-import", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          aiwebUrl,
          aiwebUsername,
          aiwebPassword,
          targetCategory,
          importOptions: { skipExisting },
        }),
      });
      const data = await resp.json();
      if (!resp.ok || data.error) {
        setError(data.error || "导入失败");
      } else {
        setImportResult(data);
        if (data.summary?.created > 0) {
          onImportComplete();
        }
      }
    } catch (err) {
      setError(`请求失败: ${String(err)}`);
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className={cardCls}>
      <h3 className="text-lg font-bold text-[var(--foreground)] mb-1">AIWeb 智能体导入</h3>
      <p className="text-xs text-[var(--muted-foreground)] mb-6">从 AIWeb 平台一键导入所有智能体（含提示词、预设卡片、模型配置等）</p>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
        <div>
          <label className={labelCls}>AIWeb 平台地址</label>
          <input className={inputCls} value={aiwebUrl} onChange={e => setAiwebUrl(e.target.value)} placeholder="http://121.40.25.118:9520" />
        </div>
        <div>
          <label className={labelCls}>管理员用户名</label>
          <input className={inputCls} value={aiwebUsername} onChange={e => setAiwebUsername(e.target.value)} placeholder="super" />
        </div>
        <div>
          <label className={labelCls}>管理员密码</label>
          <input className={inputCls} type="password" value={aiwebPassword} onChange={e => setAiwebPassword(e.target.value)} placeholder="AIWeb后台登录密码" />
        </div>
        <div>
          <label className={labelCls}>导入到分类</label>
          <select className={inputCls} value={targetCategory} onChange={e => setTargetCategory(e.target.value)}>
            {FALLBACK_CATEGORIES.map((c: string) => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
      </div>

      <div className="flex items-center gap-3 mb-6">
        <label className="flex items-center gap-2 text-sm text-[var(--secondary-foreground)] cursor-pointer">
          <input type="checkbox" checked={skipExisting} onChange={e => setSkipExisting(e.target.checked)} className="rounded" />
          跳过已存在的同名智能体
        </label>
      </div>

      <div className="flex gap-3 mb-6">
        <button onClick={handleImport} disabled={importing} className={`${btnPrimary} ${importing ? 'opacity-50 cursor-not-allowed' : ''}`}>
          {importing ? (
            <span className="flex items-center gap-2">
              <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg>
              正在导入...
            </span>
          ) : "开始导入"}
        </button>
      </div>

      {error && (
        <div className="p-4 bg-red-500/10 border border-red-500/20 rounded-xl mb-4">
          <p className="text-sm text-red-400">{error}</p>
        </div>
      )}

      {importResult && (
        <div className="space-y-4">
          <div className="grid grid-cols-3 gap-4">
            <div className="bg-emerald-500/10 border border-emerald-500/20 rounded-xl p-4 text-center">
              <div className="text-2xl font-bold text-emerald-400">{importResult.summary.created}</div>
              <div className="text-xs text-emerald-400/70 mt-1">成功导入</div>
            </div>
            <div className="bg-amber-500/10 border border-amber-500/20 rounded-xl p-4 text-center">
              <div className="text-2xl font-bold text-amber-400">{importResult.summary.skipped}</div>
              <div className="text-xs text-amber-400/70 mt-1">跳过</div>
            </div>
            <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-4 text-center">
              <div className="text-2xl font-bold text-red-400">{importResult.summary.errors}</div>
              <div className="text-xs text-red-400/70 mt-1">失败</div>
            </div>
          </div>

          {importResult.categories && importResult.categories.length > 0 && (
            <div>
              <h4 className="text-sm font-semibold text-[var(--foreground)] mb-2">源平台分类</h4>
              <div className="flex flex-wrap gap-2">
                {importResult.categories.map((c: { id: string; name: string }) => (
                  <span key={c.id} className="px-2 py-1 bg-[var(--border)] rounded-lg text-xs text-[var(--secondary-foreground)]">{c.name}</span>
                ))}
              </div>
            </div>
          )}

          {importResult.results && importResult.results.length > 0 && (
            <div>
              <h4 className="text-sm font-semibold text-[var(--foreground)] mb-2">导入明细</h4>
              <div className="max-h-[400px] overflow-y-auto rounded-xl border border-[var(--border)]">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-[var(--card)]">
                    <tr className="border-b border-[var(--border)]">
                      <th className="py-2 px-3 text-left text-[var(--muted-foreground)]">智能体名称</th>
                      <th className="py-2 px-3 text-left text-[var(--muted-foreground)]">状态</th>
                      <th className="py-2 px-3 text-left text-[var(--muted-foreground)]">说明</th>
                    </tr>
                  </thead>
                  <tbody>
                    {importResult.results.map((r: { name: string; status: string; error?: string }, i: number) => (
                      <tr key={i} className="border-b border-[var(--border)]/50">
                        <td className="py-2 px-3 text-[var(--foreground)]">{r.name}</td>
                        <td className="py-2 px-3">
                          {r.status === 'created' && <span className="text-emerald-400">已导入</span>}
                          {r.status === 'skipped' && <span className="text-amber-400">已跳过</span>}
                          {r.status === 'error' && <span className="text-red-400">失败</span>}
                        </td>
                        <td className="py-2 px-3 text-[var(--muted-foreground)] text-xs">{r.error || '-'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}

      <div className="mt-6 p-4 bg-[var(--border)]/30 rounded-xl">
        <h4 className="text-sm font-semibold text-[var(--foreground)] mb-2">导入说明</h4>
        <ul className="text-xs text-[var(--muted-foreground)] space-y-1.5">
          <li>1. 输入 AIWeb 后台的管理员账号密码（默认账号 super）</li>
          <li>2. 导入的智能体会自动转换预设卡片格式（AIWeb JSON → 我们 PresetField）</li>
          <li>3. 模型映射：DPC系列→deepseek，Claude系列→claude，GPT系列→gpt，GLM系列→glm</li>
          <li>4. 提示词和预设配置会完整保留并自动转换</li>
          <li>5. 导入后可在"智能体管理"中逐个调整模型、计费等细节配置</li>
        </ul>
      </div>
    </div>
  );
}

// ============ Coze 工作空间导入 Tab ============
function CozeImportTab({ token, onImportComplete }: { token: string | null; onImportComplete: () => void }) {
  const [workspaceId, setWorkspaceId] = useState("");
  const [botNames, setBotNames] = useState("");
  const [targetCategory, setTargetCategory] = useState("视频生成");
  const [defaultModel, setDefaultModel] = useState("deepseek-v4-flash");
  const [defaultCost, setDefaultCost] = useState(10);
  const [previewBots, setPreviewBots] = useState<Array<{ bot_id: string; bot_name: string; description: string; icon_url: string; already_imported: boolean; selected?: boolean }>>([]);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<{
    success: boolean;
    summary: { total: number; created: number; skipped: number; errors: number };
    results: Array<{ name: string; status: string; error?: string }>;
  } | null>(null);
  const [error, setError] = useState("");

  // 预览工作空间中的智能体列表
  const handlePreview = async () => {
    if (!workspaceId.trim()) {
      setError("请输入 Coze 工作空间 ID");
      return;
    }
    setPreviewLoading(true);
    setError("");
    setPreviewBots([]);
    try {
      const resp = await fetch(`/api/admin/coze-import?workspace_id=${encodeURIComponent(workspaceId.trim())}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await resp.json();
      if (!resp.ok || data.error) {
        setError(data.error || "获取列表失败");
      } else {
        setPreviewBots((data.bots || []).map((b: { bot_id: string; bot_name: string; description: string; icon_url: string; already_imported: boolean }) => ({
          ...b,
          selected: !b.already_imported, // 默认选中未导入的
        })));
        if (data.bots?.length === 0) {
          setError("该工作空间中没有找到智能体");
        }
      }
    } catch (err) {
      setError(`请求失败: ${String(err)}`);
    } finally {
      setPreviewLoading(false);
    }
  };

  // 切换智能体选择
  const toggleBot = (botId: string) => {
    setPreviewBots(prev => prev.map(b => b.bot_id === botId ? { ...b, selected: !b.selected } : b));
  };

  // 全选/取消全选
  const toggleAll = () => {
    const allSelected = previewBots.filter(b => !b.already_imported).every(b => b.selected);
    setPreviewBots(prev => prev.map(b => b.already_imported ? b : { ...b, selected: !allSelected }));
  };

  // 开始导入
  const handleImport = async () => {
    const selectedBots = previewBots.filter(b => b.selected && !b.already_imported);
    const nameList = botNames.trim() ? botNames.trim().split(/[,，\n]+/).map(s => s.trim()).filter(Boolean) : [];

    if (selectedBots.length === 0 && nameList.length === 0) {
      setError("请选择要导入的智能体或输入智能体名称");
      return;
    }

    setImporting(true);
    setError("");
    setImportResult(null);
    try {
      const resp = await fetch("/api/admin/coze-import", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          workspace_id: workspaceId.trim(),
          bot_names: nameList.length > 0 ? nameList : selectedBots.map(b => b.bot_name),
          category: targetCategory,
          model: defaultModel,
          cost_per_message: defaultCost,
          is_active: true,
        }),
      });
      const data = await resp.json();
      if (!resp.ok || data.error) {
        setError(data.error || "导入失败");
      } else {
        setImportResult(data);
        if (data.summary?.created > 0) {
          onImportComplete();
        }
      }
    } catch (err) {
      setError(`请求失败: ${String(err)}`);
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className={cardCls}>
      <h3 className="text-lg font-bold text-[var(--foreground)] mb-1">Coze 工作空间导入</h3>
      <p className="text-xs text-[var(--muted-foreground)] mb-6">从指定的 Coze 工作空间导入智能体为 LLM 类型（提取提示词，通过平台 LLM API 调用）</p>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
        <div className="md:col-span-2">
          <label className={labelCls}>Coze 工作空间 ID</label>
          <div className="flex gap-2">
            <input className={inputCls} value={workspaceId} onChange={e => setWorkspaceId(e.target.value)} placeholder="例如: 7617638254287913001（从 code.coze.cn/w/xxx 地址中提取）" />
            <button onClick={handlePreview} disabled={previewLoading} className={`${btnPrimary} shrink-0 ${previewLoading ? 'opacity-50 cursor-not-allowed' : ''}`}>
              {previewLoading ? "加载中..." : "预览"}
            </button>
          </div>
        </div>
        <div className="md:col-span-2">
          <label className={labelCls}>指定智能体名称（可选，逗号或换行分隔，不填则导入预览中勾选的）</label>
          <textarea className={inputCls + " min-h-[80px] resize-y"} value={botNames} onChange={e => setBotNames(e.target.value)} placeholder={"例如:\n文生视频3D风格8秒版\n文生视频2D风格10秒\n宠物科普动画导演10秒"} />
        </div>
        <div>
          <label className={labelCls}>导入到分类</label>
          <select className={inputCls} value={targetCategory} onChange={e => setTargetCategory(e.target.value)}>
            {FALLBACK_CATEGORIES.map((c: string) => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
        <div>
          <label className={labelCls}>默认模型</label>
          <input className={inputCls} value={defaultModel} onChange={e => setDefaultModel(e.target.value)} placeholder="glm-5.1" />
        </div>
        <div>
          <label className={labelCls}>每次对话积分消耗</label>
          <input className={inputCls} type="number" value={defaultCost} onChange={e => setDefaultCost(Number(e.target.value))} min={0} />
        </div>
      </div>

      {/* 预览列表 */}
      {previewBots.length > 0 && (
        <div className="mb-6">
          <div className="flex items-center justify-between mb-3">
            <h4 className="text-sm font-semibold text-[var(--foreground)]">工作空间智能体列表（共 {previewBots.length} 个）</h4>
            <button onClick={toggleAll} className="text-xs text-[var(--primary)] hover:underline">
              {previewBots.filter(b => !b.already_imported).every(b => b.selected) ? "取消全选" : "全选"}
            </button>
          </div>
          <div className="max-h-[400px] overflow-y-auto rounded-xl border border-[var(--border)]">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-[var(--card)]">
                <tr className="border-b border-[var(--border)]">
                  <th className="py-2 px-3 text-left w-10"></th>
                  <th className="py-2 px-3 text-left text-[var(--muted-foreground)]">智能体名称</th>
                  <th className="py-2 px-3 text-left text-[var(--muted-foreground)]">描述</th>
                  <th className="py-2 px-3 text-left text-[var(--muted-foreground)]">状态</th>
                </tr>
              </thead>
              <tbody>
                {previewBots.map((bot) => (
                  <tr key={bot.bot_id} className={`border-b border-[var(--border)]/50 ${bot.already_imported ? 'opacity-50' : ''}`}>
                    <td className="py-2 px-3">
                      <input
                        type="checkbox"
                        checked={bot.selected || false}
                        disabled={bot.already_imported}
                        onChange={() => toggleBot(bot.bot_id)}
                        className="rounded"
                      />
                    </td>
                    <td className="py-2 px-3 text-[var(--foreground)] font-medium">{bot.bot_name}</td>
                    <td className="py-2 px-3 text-[var(--muted-foreground)] text-xs max-w-[200px] truncate">{bot.description || '-'}</td>
                    <td className="py-2 px-3">
                      {bot.already_imported
                        ? <span className="text-amber-400 text-xs">已导入</span>
                        : <span className="text-emerald-400 text-xs">待导入</span>
                      }
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="flex gap-3 mb-6">
        <button onClick={handleImport} disabled={importing} className={`${btnPrimary} ${importing ? 'opacity-50 cursor-not-allowed' : ''}`}>
          {importing ? (
            <span className="flex items-center gap-2">
              <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg>
              正在导入...
            </span>
          ) : `导入选中的智能体为 LLM 类型`}
        </button>
      </div>

      {error && (
        <div className="p-4 bg-red-500/10 border border-red-500/20 rounded-xl mb-4">
          <p className="text-sm text-red-400">{error}</p>
        </div>
      )}

      {importResult && (
        <div className="space-y-4">
          <div className="grid grid-cols-3 gap-4">
            <div className="bg-emerald-500/10 border border-emerald-500/20 rounded-xl p-4 text-center">
              <div className="text-2xl font-bold text-emerald-400">{importResult.summary.created}</div>
              <div className="text-xs text-emerald-400/70 mt-1">成功导入</div>
            </div>
            <div className="bg-amber-500/10 border border-amber-500/20 rounded-xl p-4 text-center">
              <div className="text-2xl font-bold text-amber-400">{importResult.summary.skipped}</div>
              <div className="text-xs text-amber-400/70 mt-1">跳过</div>
            </div>
            <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-4 text-center">
              <div className="text-2xl font-bold text-red-400">{importResult.summary.errors}</div>
              <div className="text-xs text-red-400/70 mt-1">失败</div>
            </div>
          </div>

          {importResult.results && importResult.results.length > 0 && (
            <div>
              <h4 className="text-sm font-semibold text-[var(--foreground)] mb-2">导入明细</h4>
              <div className="max-h-[400px] overflow-y-auto rounded-xl border border-[var(--border)]">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-[var(--card)]">
                    <tr className="border-b border-[var(--border)]">
                      <th className="py-2 px-3 text-left text-[var(--muted-foreground)]">智能体名称</th>
                      <th className="py-2 px-3 text-left text-[var(--muted-foreground)]">状态</th>
                      <th className="py-2 px-3 text-left text-[var(--muted-foreground)]">说明</th>
                    </tr>
                  </thead>
                  <tbody>
                    {importResult.results.map((r: { name: string; status: string; error?: string }, i: number) => (
                      <tr key={i} className="border-b border-[var(--border)]/50">
                        <td className="py-2 px-3 text-[var(--foreground)]">{r.name}</td>
                        <td className="py-2 px-3">
                          {r.status === 'created' && <span className="text-emerald-400">已导入</span>}
                          {r.status === 'skipped' && <span className="text-amber-400">已跳过</span>}
                          {r.status === 'error' && <span className="text-red-400">失败</span>}
                        </td>
                        <td className="py-2 px-3 text-[var(--muted-foreground)] text-xs">{r.error || '-'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}

      <div className="mt-6 p-4 bg-[var(--border)]/30 rounded-xl">
        <h4 className="text-sm font-semibold text-[var(--foreground)] mb-2">导入说明</h4>
        <ul className="text-xs text-[var(--muted-foreground)] space-y-1.5">
          <li>1. 输入目标 Coze 工作空间 ID（从 code.coze.cn/w/xxx 地址中的数字部分获取）</li>
          <li>2. 点击"预览"查看工作空间中的所有智能体</li>
          <li>3. 勾选要导入的智能体，或在文本框中输入指定名称（逗号或换行分隔）</li>
          <li>4. 导入的智能体将以 <strong>LLM 类型</strong> 创建，提取原 Coze 智能体的 system_prompt</li>
          <li>5. 导入后可在"智能体管理"中逐个调整模型、计费等细节配置</li>
          <li>6. 需要先在“模型与外部服务”中配置好 Coze API Token</li>
        </ul>
      </div>
    </div>
  );
}

// ============ 卡密管理 Tab ============
function CamiTab({ token, users, focusUserId = "", focusUserLabel = "", onClearFocus, canManagePackages, canViewMembers }: { token: string | null; users: UserInfo[]; focusUserId?: string; focusUserLabel?: string; onClearFocus?: () => void; canManagePackages: boolean; canViewMembers: boolean }) {
  type CamiCodeRow = { id: string; code: string; credits: number; cash_balance: number; duration_days: number; plan_name: string; is_used: boolean; used_by: string | null; used_at: string | null; batch_id: string; created_at: string; expires_at: string | null; assigned_to?: string | null; assigned_at?: string | null; delivery_notification_id?: string | null; redemption_notification_id?: string | null; allowed_categories?: string[] | null; allowed_categories_status?: 'none' | 'stable' | 'legacy-resolved' | 'legacy-unresolved'; feature_navigation_keys?: string[] | null; profile_key?: string | null; profile_version?: number | null; package_assignment_id?: string | null };
  type CamiPackageOption = { key: string; version: number; name: string; membershipStatus: string; durationDays: number; credits: number; cashAmount: number; featureNavigationKeys: string[]; agentNavigationKeys: string[] };
  type CamiMemberContext = {
    member: { id: string; username?: string | null; display_name?: string | null; phone?: string | null; email?: string | null; member_status?: string | null; member_expires_at?: string | null; created_at?: string | null; last_sign_in_at?: string | null };
    packageState: {
      current?: { package_name?: string; membership_status?: string; profile_key?: string | null; profile_version?: number | null; created_at?: string; member_expires_at?: string | null } | null;
      trialDelivered: boolean;
      trialAssignment?: { package_name?: string; created_at?: string; member_expires_at?: string | null } | null;
      confirmedOfflinePayment?: { amount?: number; paid_at?: string; payment_channel?: string } | null;
      pendingCards: Array<{ id: string; plan_name?: string; assigned_at?: string }>;
      invitation?: { id: string; invited_at?: string; invitee_activated?: boolean; activated_at?: string | null } | null;
    };
  };
  const [codes, setCodes] = useState<CamiCodeRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [showCreate, setShowCreate] = useState(false);
  const [createForm, setCreateForm] = useState({ count: 10, profileKey: '', profileVersion: 0, expires_days: 30, prefix: 'AH' });
  const [camiPackages, setCamiPackages] = useState<CamiPackageOption[]>([]);
  const [creating, setCreating] = useState(false);
  const [createResult, setCreateResult] = useState<{ batch_id: string; codes: string[]; created: number } | null>(null);
  const [revealedCamiIds, setRevealedCamiIds] = useState<Set<string>>(() => new Set());
  const [assigningCard, setAssigningCard] = useState<CamiCodeRow | null>(null);
  const [assignmentUserId, setAssignmentUserId] = useState("");
  const [assignmentBusy, setAssignmentBusy] = useState(false);
  const [assignmentPassword, setAssignmentPassword] = useState("");
  const [assignmentConfirmed, setAssignmentConfirmed] = useState(false);
  const [assignmentContext, setAssignmentContext] = useState<CamiMemberContext | null>(null);
  const [assignmentContextLoading, setAssignmentContextLoading] = useState(false);
  const [assignmentError, setAssignmentError] = useState("");
  const assignableUsers = useMemo(() => canViewMembers ? users.filter((user) => user.role !== "admin" && !isFixtureUser(user)) : [], [canViewMembers, users]);
  const selectedCreatePackage = useMemo(() => camiPackages.find((item) => item.key === createForm.profileKey && item.version === createForm.profileVersion) || null, [camiPackages, createForm.profileKey, createForm.profileVersion]);
  const camiCategories = useMemo(
    () => AGENT_NAVIGATION_OPTIONS.map((option) => ({ id: option.key, name: option.label })),
    [],
  );
  const maskCamiCode = (value: string) => value.replace(/[A-Za-z0-9]/gu, "•");
  const toggleCamiReveal = (id: string) => {
    setRevealedCamiIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const loadCodes = async (p: number = 1) => {
    const resp = await fetch(`/api/admin/cami?page=${p}&size=20`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (resp.ok) {
      const data = await resp.json();
      setCodes(data.codes || []);
      setTotal(data.total || 0);
      setPage(p);
    }
  };

  const loadCamiPackages = useCallback(async () => {
    if (!token || !canManagePackages) {
      setCamiPackages([]);
      return;
    }
    const response = await fetch('/api/admin/member-packages', {
      headers: { Authorization: `Bearer ${token}` },
      cache: 'no-store',
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      setAssignmentError(payload.error || '正式会员套餐模板读取失败');
      return;
    }
    const activePackages = (Array.isArray(payload.templates) ? payload.templates : [])
      .filter((item: CamiPackageOption) => item.membershipStatus === 'active');
    setCamiPackages(activePackages);
    setCreateForm((current) => {
      if (activePackages.some((item: CamiPackageOption) => item.key === current.profileKey && item.version === current.profileVersion)) return current;
      const preferred = activePackages.find((item: CamiPackageOption) => item.key === 'formal_member') || activePackages[0];
      return preferred ? { ...current, profileKey: preferred.key, profileVersion: preferred.version } : current;
    });
  }, [canManagePackages, token]);

  const loadAssignmentContext = useCallback(async (userId: string) => {
    if (!token || !userId || !canManagePackages || !canViewMembers) {
      setAssignmentContext(null);
      return;
    }
    setAssignmentContextLoading(true);
    setAssignmentError('');
    try {
      const response = await fetch(`/api/admin/cami?member_id=${encodeURIComponent(userId)}`, {
        headers: { Authorization: `Bearer ${token}` },
        cache: 'no-store',
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || '学员状态读取失败');
      setAssignmentContext(payload as CamiMemberContext);
    } catch (contextError) {
      setAssignmentContext(null);
      setAssignmentError(contextError instanceof Error ? contextError.message : '学员状态读取失败');
    } finally {
      setAssignmentContextLoading(false);
    }
  }, [canManagePackages, canViewMembers, token]);

  useEffect(() => {
    void loadCodes();
    if (canManagePackages) void loadCamiPackages();
  }, [canManagePackages, loadCamiPackages]);

  useEffect(() => {
    if (canViewMembers && focusUserId && assignableUsers.some((user) => user.id === focusUserId)) setAssignmentUserId(focusUserId);
  }, [assignableUsers, canViewMembers, focusUserId]);

  useEffect(() => {
    if (!canManagePackages || !canViewMembers || !assigningCard || !assignmentUserId) {
      setAssignmentContext(null);
      return;
    }
    void loadAssignmentContext(assignmentUserId);
  }, [assigningCard, assignmentUserId, canManagePackages, canViewMembers, loadAssignmentContext]);

  const handleCreate = async () => {
    if (!canManagePackages) return;
    setCreating(true);
    try {
      const resp = await fetch('/api/admin/cami', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(createForm),
      });
      const data = await resp.json();
      if (resp.ok) {
        setCreateResult(data);
        loadCodes();
      } else {
        alert(data.error || '创建失败');
      }
    } finally {
      setCreating(false);
    }
  };

  const handleDeleteBatch = async (batchId: string) => {
    if (!confirm('确定删除该批次所有未使用的卡密？')) return;
    const resp = await fetch(`/api/admin/cami?batch_id=${batchId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    if (resp.ok) loadCodes();
  };

  const handleAssignCard = async () => {
    if (!canManagePackages || !canViewMembers) return;
    if (!assigningCard || !assignmentUserId || assignmentBusy) return;
    const target = assignableUsers.find((user) => user.id === assignmentUserId);
    if (!target) { alert("请选择有效学员"); return; }
    if (!assignmentContext || assignmentContextLoading) { setAssignmentError("请先等待学员状态核对完成"); return; }
    if (!assignmentPassword) { setAssignmentError("请输入管理员操作密码"); return; }
    if (!assignmentConfirmed) { setAssignmentError("请勾选已核对学员和套餐"); return; }
    const idempotencyKey = `cami-assignment:${assigningCard.id}:${crypto.randomUUID()}`;
    setAssignmentBusy(true);
    setAssignmentError("");
    try {
      const verifyResponse = await fetch("/api/auth/verify-password", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ password: assignmentPassword, purpose: "admin_cami_assignment" }),
      });
      const verifyPayload = await verifyResponse.json().catch(() => ({}));
      const reauthToken = verifyPayload?.camiAssignmentVerification?.token;
      if (!verifyResponse.ok || typeof reauthToken !== "string" || !reauthToken) {
        throw new Error(verifyPayload.error || "管理员密码验证失败");
      }
      const response = await fetch("/api/admin/cami", {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
          "Idempotency-Key": idempotencyKey,
          "x-admin-cami-assignment-reauth": reauthToken,
        },
        body: JSON.stringify({ cardId: assigningCard.id, userId: assignmentUserId, idempotencyKey }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || "卡密推送失败");
      alert(`“${assigningCard.plan_name || "会员套餐"}”激活卡已绑定并推送到学员账号；学员在个人中心一键兑换后才会正式生效。`);
      setAssigningCard(null);
      setAssignmentUserId("");
      setAssignmentPassword("");
      setAssignmentConfirmed(false);
      setAssignmentContext(null);
      await loadCodes(page);
    } catch (error) {
      setAssignmentError(error instanceof Error ? error.message : "卡密推送失败");
    } finally {
      setAssignmentBusy(false);
    }
  };

  const handleCopyCodes = (codesList: string[]) => {
    copyToClipboard(codesList.join('\n')).then((ok) => {
      alert(ok ? '已复制到剪贴板' : '复制失败，请选中文本后手动复制');
    });
  };

  // 一键复制单条卡密（带视觉反馈）
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const handleCopySingleCode = (codeStr: string, id: string) => {
    copyToClipboard(codeStr).then((ok) => {
      if (ok) {
        setCopiedId(id);
        setTimeout(() => setCopiedId(null), 1500);
      } else {
        alert('复制失败，请选中文本后手动复制');
      }
    });
  };

  // 按批次复制未使用的卡密
  const handleCopyBatchUnused = (batchId: string) => {
    const batchCodes = codes.filter(c => c.batch_id === batchId && !c.is_used && !c.assigned_to).map(c => c.code);
    if (batchCodes.length === 0) { alert('该批次没有未使用的卡密'); return; }
    copyToClipboard(batchCodes.join('\n')).then((ok) => alert(ok ? `已复制 ${batchCodes.length} 条未使用卡密` : '复制失败，请选中文本后手动复制'));
  };

  // 复制所有未使用的卡密
  const handleCopyAllUnused = () => {
    const unusedCodes = codes.filter(c => !c.is_used && !c.assigned_to).map(c => c.code);
    if (unusedCodes.length === 0) { alert('没有未使用的卡密'); return; }
    copyToClipboard(unusedCodes.join('\n')).then((ok) => alert(ok ? `已复制 ${unusedCodes.length} 条未使用卡密` : '复制失败，请选中文本后手动复制'));
  };

  return (
    <div className={cardCls}>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h3 className="text-lg font-bold text-[var(--foreground)]">卡密管理</h3>
          <p className="text-xs text-[var(--muted-foreground)] mt-1">会员激活凭证中心：选择套餐模板、绑定指定学员并推送到账户；学员在个人中心一键兑换，不需要复制卡密聊天。</p>
        </div>
        {canManagePackages && (
          <button onClick={() => setShowCreate(!showCreate)} className={btnPrimary}>
            {showCreate ? '收起' : '生成激活卡'}
          </button>
        )}
      </div>

      {canViewMembers && focusUserId && (
        <div className="mb-5 flex items-center justify-between rounded-xl border border-blue-500/20 bg-blue-500/8 px-4 py-3 text-sm text-blue-600">
          <span>发卡对象已锁定为：<strong>{focusUserLabel || focusUserId}</strong>。请选择一张“库存未绑定”激活卡并点击“发送激活卡”。</span>
          <button type="button" onClick={onClearFocus} className="font-semibold hover:underline">取消学员上下文</button>
        </div>
      )}

      {/* 创建表单 */}
      {canManagePackages && showCreate && (
        <div className="p-4 bg-[var(--border)]/20 rounded-xl mb-6 space-y-4">
          <div data-testid="cami-package-boundary" className="mb-4 rounded-xl border border-amber-500/20 bg-amber-500/8 px-4 py-3 text-xs leading-relaxed text-amber-700">激活卡只选择正式会员或超级 VIP 套餐模板，并冻结当时的会员期限、积分/现金与访问权限。体验包仍在“邀请关系 / 权益与礼包”派发，不会在这里重复发送；邀请人奖励也始终单独决定。</div>
          <div className="grid grid-cols-3 gap-4">
            <div>
              <label className={labelCls}>生成数量</label>
              <input className={inputCls} type="number" min={1} max={500} value={createForm.count} onChange={e => setCreateForm(f => ({ ...f, count: parseInt(e.target.value) || 1 }))} />
            </div>
            <div className="col-span-1">
              <label className={labelCls}>绑定套餐模板</label>
              <select
                data-testid="cami-package-template-select"
                className={inputCls}
                value={createForm.profileKey ? `${createForm.profileKey}:${createForm.profileVersion}` : ''}
                onChange={(event) => {
                  const selected = camiPackages.find((item) => `${item.key}:${item.version}` === event.target.value);
                  if (selected) setCreateForm((current) => ({ ...current, profileKey: selected.key, profileVersion: selected.version }));
                }}
              >
                <option value="">请选择正式套餐</option>
                {camiPackages.map((item) => <option key={`${item.key}:${item.version}`} value={`${item.key}:${item.version}`}>{item.name}</option>)}
              </select>
            </div>
            <div>
              <label className={labelCls}>卡密有效天数 <span className="text-[var(--muted-foreground)] text-[10px]">0=永久</span></label>
              <input className={inputCls} type="number" min={0} value={createForm.expires_days} onChange={e => setCreateForm(f => ({ ...f, expires_days: parseInt(e.target.value) || 0 }))} placeholder="0=永久" />
            </div>
          </div>
          {selectedCreatePackage ? (
            <div data-testid="cami-package-template-preview" className="grid grid-cols-4 gap-3 rounded-xl border border-violet-500/20 bg-violet-500/7 p-4 text-xs">
              <div><p className="text-[var(--muted-foreground)]">套餐</p><p className="mt-1 font-bold text-[var(--foreground)]">{selectedCreatePackage.name}</p></div>
              <div><p className="text-[var(--muted-foreground)]">会员期限</p><p className="mt-1 font-bold text-[var(--foreground)]">{selectedCreatePackage.durationDays === 0 ? '长期正式会员' : `${selectedCreatePackage.durationDays} 天`}</p></div>
              <div><p className="text-[var(--muted-foreground)]">兑换到账</p><p className="mt-1 font-bold text-[var(--foreground)]">{selectedCreatePackage.credits.toLocaleString()} 积分 · ¥{selectedCreatePackage.cashAmount.toFixed(2)}</p></div>
              <div><p className="text-[var(--muted-foreground)]">访问权限</p><p className="mt-1 font-bold text-[var(--foreground)]">{selectedCreatePackage.featureNavigationKeys.length} 项业务 · {selectedCreatePackage.agentNavigationKeys.length} 个智能体分类</p></div>
            </div>
          ) : <p role="alert" className="text-xs font-semibold text-rose-600">暂无可用的正式会员套餐模板，请先到“权益与礼包”配置。</p>}
          <button onClick={handleCreate} disabled={creating || !selectedCreatePackage} className={`${btnPrimary} disabled:opacity-50`}>
            {creating ? '生成中...' : '确认生成激活卡'}
          </button>

          {createResult && (
            <div className="mt-4 p-4 bg-emerald-500/10 border border-emerald-500/20 rounded-xl">
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm text-emerald-400 font-medium">已生成 {createResult.created} 张卡密</span>
                <button onClick={() => handleCopyCodes(createResult.codes)} className="text-xs px-3 py-1 bg-emerald-500/20 text-emerald-400 rounded-lg hover:bg-emerald-500/30">复制全部</button>
              </div>
              <div className="max-h-[200px] overflow-y-auto text-xs text-[var(--muted-foreground)] space-y-0.5">
                {createResult.codes.map((c, i) => (
                  <div key={i} className="flex items-center gap-1.5 group">
                    <span className="font-mono tracking-wider">{revealedCamiIds.has(`new-${i}`) ? c : maskCamiCode(c)}</span>
                    <button type="button" onClick={() => toggleCamiReveal(`new-${i}`)} className="shrink-0 rounded px-1 text-[10px] font-bold text-emerald-500 hover:bg-emerald-500/10">{revealedCamiIds.has(`new-${i}`) ? "隐藏" : "显示"}</button>
                    <button
                      onClick={() => handleCopySingleCode(c, `new-${i}`)}
                      className="shrink-0 p-0.5 rounded opacity-0 group-hover:opacity-100 hover:bg-emerald-500/10 transition-all"
                      title="复制"
                    >
                      {copiedId === `new-${i}` ? (
                        <svg className="w-3 h-3 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
                      ) : (
                        <svg className="w-3 h-3 text-emerald-400/60" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" /></svg>
                      )}
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* 卡密列表 */}
      <div className="flex items-center justify-between mb-3">
        <div className="text-xs text-[var(--muted-foreground)]">
          共 {total} 条卡密，未使用 {codes.filter(c => !c.is_used).length} 条
        </div>
        <div className="flex items-center gap-2">
          <button onClick={handleCopyAllUnused} className="text-xs px-3 py-1.5 bg-blue-500/10 text-blue-400 rounded-lg hover:bg-blue-500/20 transition-colors">
            复制全部未使用
          </button>
        </div>
      </div>
      <div className="rounded-xl border border-[var(--border)] overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-[var(--border)] bg-[var(--border)]/30">
              <th className="py-2.5 px-3 text-left text-[var(--muted-foreground)] font-medium">卡密</th>
              <th className="py-2.5 px-3 text-left text-[var(--muted-foreground)] font-medium">套餐</th>
              <th className="py-2.5 px-3 text-left text-[var(--muted-foreground)] font-medium">会员权益</th>
              <th className="py-2.5 px-3 text-left text-[var(--muted-foreground)] font-medium">套餐权限快照</th>
              <th className="py-2.5 px-3 text-left text-[var(--muted-foreground)] font-medium">绑定/兑换状态</th>
              <th className="py-2.5 px-3 text-left text-[var(--muted-foreground)] font-medium">有效期</th>
              <th className="py-2.5 px-3 text-left text-[var(--muted-foreground)] font-medium">操作</th>
            </tr>
          </thead>
          <tbody>
            {codes.length === 0 ? (
              <tr><td colSpan={7} className="py-8 text-center text-[var(--muted-foreground)]">暂无卡密</td></tr>
            ) : codes.map(c => (
              <tr key={c.id} data-testid={`cami-row-${c.id}`} className="border-b border-[var(--border)]/50 hover:bg-[var(--border)]/10">
                <td className="py-2 px-3">
                  <div className="flex items-center gap-1.5">
                    <span className="font-mono text-xs tracking-wider text-[var(--foreground)]">{!c.assigned_to && !c.is_used && revealedCamiIds.has(c.id) ? c.code : maskCamiCode(c.code)}</span>
                    {!c.assigned_to && !c.is_used ? <>
                      <button type="button" onClick={() => toggleCamiReveal(c.id)} className="shrink-0 rounded px-1 text-[10px] font-bold text-[var(--muted-foreground)] hover:bg-[var(--border)]/50">{revealedCamiIds.has(c.id) ? "隐藏" : "显示"}</button>
                      <button
                        onClick={() => handleCopySingleCode(c.code, c.id)}
                        className="shrink-0 p-1 rounded hover:bg-[var(--border)]/50 transition-colors"
                        title="复制库存卡密"
                      >
                        {copiedId === c.id ? (
                          <svg className="w-3.5 h-3.5 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
                        ) : (
                          <svg className="w-3.5 h-3.5 text-[var(--muted-foreground)]" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" /></svg>
                        )}
                      </button>
                    </> : <span className="text-[10px] text-[var(--muted-foreground)]">已绑定后永久隐藏</span>}
                  </div>
                </td>
                <td className="py-2 px-3 text-[var(--secondary-foreground)]"><p>{c.plan_name || '-'}</p>{c.profile_key ? <p className="mt-1 text-[10px] text-[var(--muted-foreground)]">模板 v{c.profile_version}</p> : <p className="mt-1 text-[10px] text-amber-500">历史卡</p>}</td>
                <td className="py-2 px-3 text-xs">
                  {c.duration_days === 0 && <span className="text-amber-400">永久会员</span>}
                  {c.duration_days > 0 && <span className="text-amber-400">{c.duration_days}天会员</span>}
                  {(c.credits > 0 || c.cash_balance > 0) && <p className="mt-1 text-[10px] text-[var(--muted-foreground)]">{Number(c.credits || 0).toLocaleString()} 积分 · ¥{Number(c.cash_balance || 0).toFixed(2)}</p>}
                </td>
                <td className="py-2 px-3 text-xs">
                  {c.profile_key
                    ? <span>{Array.isArray(c.feature_navigation_keys) ? c.feature_navigation_keys.length : 0} 项业务 · {Array.isArray(c.allowed_categories) ? c.allowed_categories.length : 0} 个智能体分类</span>
                    : c.allowed_categories_status === 'legacy-unresolved'
                    ? <span className="text-amber-500">历史权限（待重新配置）</span>
                    : Array.isArray(c.allowed_categories) && c.allowed_categories.length > 0
                      ? c.allowed_categories
                          .map(id => camiCategories.find(cat => cat.id === id)?.name)
                          .filter((name) => name !== undefined)
                          .join('、')
                      : <span className="text-[var(--muted-foreground)]">不追加智能体权限</span>}
                </td>
                <td className="py-2 px-3">
                  {c.is_used ? (
                    <div><span className="rounded bg-gray-500/20 px-2 py-0.5 text-xs text-gray-500">已兑换</span>{canViewMembers && <p className="mt-1 text-[10px] text-[var(--muted-foreground)]">{users.find((user) => user.id === c.used_by)?.name || c.used_by || "未知学员"}</p>}</div>
                  ) : c.assigned_to ? (
                    <div><span className="rounded bg-blue-500/10 px-2 py-0.5 text-xs text-blue-600">已绑定并推送</span>{canViewMembers && <p className="mt-1 text-[10px] text-[var(--muted-foreground)]">{users.find((user) => user.id === c.assigned_to)?.name || c.assigned_to}</p>}</div>
                  ) : <span className="rounded bg-emerald-500/20 px-2 py-0.5 text-xs text-emerald-600">库存未绑定</span>}
                </td>
                <td className="py-2 px-3 text-xs text-[var(--muted-foreground)]">
                  {c.expires_at ? new Date(c.expires_at).toLocaleDateString() : '永久'}
                </td>
                <td className="py-2 px-3">
                  {!c.is_used && (
                    <div className="flex items-center gap-2">
                      {canManagePackages && canViewMembers && !c.assigned_to && <button onClick={() => { setAssigningCard(c); setAssignmentUserId(focusUserId && assignableUsers.some((user) => user.id === focusUserId) ? focusUserId : ""); setAssignmentPassword(""); setAssignmentConfirmed(false); setAssignmentError(""); setAssignmentContext(null); }} className="text-xs font-semibold text-emerald-600 hover:text-emerald-500">发送激活卡</button>}
                      {canManagePackages && canViewMembers && !c.assigned_to && <span className="text-[var(--border)]">|</span>}
                      <button onClick={() => handleCopyBatchUnused(c.batch_id)} className="text-xs text-blue-500 hover:text-blue-400">复制批次</button>
                      {!c.assigned_to && <><span className="text-[var(--border)]">|</span><button onClick={() => handleDeleteBatch(c.batch_id)} className="text-xs text-red-500 hover:text-red-400">删除批次</button></>}
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {total > 20 && (
        <div className="flex items-center justify-center gap-3 mt-4">
          <button onClick={() => loadCodes(page - 1)} disabled={page <= 1} className="text-xs px-3 py-1.5 bg-[var(--border)]/30 rounded-lg disabled:opacity-50">上一页</button>
          <span className="text-xs text-[var(--muted-foreground)]">{page} / {Math.ceil(total / 20)}</span>
          <button onClick={() => loadCodes(page + 1)} disabled={page >= Math.ceil(total / 20)} className="text-xs px-3 py-1.5 bg-[var(--border)]/30 rounded-lg disabled:opacity-50">下一页</button>
        </div>
      )}

      {canManagePackages && canViewMembers && assigningCard && (
        <div data-testid="cami-assignment-dialog" className="fixed inset-0 z-[80] flex items-center justify-center bg-black/45 p-5" role="dialog" aria-modal="true" aria-label="发送会员激活卡">
          <div className="max-h-[calc(100vh-48px)] w-full max-w-4xl overflow-y-auto rounded-2xl border border-[var(--border)] bg-[var(--card)] p-5 shadow-2xl">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-xs font-bold text-emerald-600">会员激活路径 · 兑换后生效</p>
                <h3 className="mt-1 text-xl font-black text-[var(--foreground)]">发送会员激活卡</h3>
                <p className="mt-1 text-xs leading-relaxed text-[var(--muted-foreground)]">系统把激活卡绑定到学员账号并推送站内通知；学员无需复制或聊天，在个人中心一键兑换后才会开通会员。</p>
              </div>
              <button
                type="button"
                disabled={assignmentBusy}
                onClick={() => { setAssigningCard(null); setAssignmentUserId(""); setAssignmentPassword(""); setAssignmentConfirmed(false); setAssignmentContext(null); setAssignmentError(""); }}
                className="grid h-9 w-9 shrink-0 place-items-center rounded-xl border border-[var(--border)] text-lg text-[var(--muted-foreground)] hover:bg-[var(--muted)] disabled:opacity-50"
                aria-label="关闭发送激活卡"
              >×</button>
            </div>

            <div className="mt-4 grid grid-cols-4 gap-3 rounded-2xl border border-violet-500/20 bg-violet-500/7 p-3.5 text-sm">
              <div><p className="text-xs text-[var(--muted-foreground)]">激活套餐</p><p className="mt-1 font-black text-[var(--foreground)]">{assigningCard.plan_name || "会员套餐"}</p></div>
              <div><p className="text-xs text-[var(--muted-foreground)]">会员期限</p><p className="mt-1 font-black text-[var(--foreground)]">{assigningCard.duration_days === 0 ? "长期正式会员" : `${assigningCard.duration_days} 天`}</p></div>
              <div><p className="text-xs text-[var(--muted-foreground)]">兑换到账</p><p className="mt-1 font-black text-[var(--foreground)]">{Number(assigningCard.credits || 0).toLocaleString()} 积分 · ¥{Number(assigningCard.cash_balance || 0).toFixed(2)}</p></div>
              <div><p className="text-xs text-[var(--muted-foreground)]">权限快照</p><p className="mt-1 font-black text-[var(--foreground)]">{Array.isArray(assigningCard.feature_navigation_keys) ? assigningCard.feature_navigation_keys.length : 0} 项业务 · {Array.isArray(assigningCard.allowed_categories) ? assigningCard.allowed_categories.length : 0} 个智能体分类</p></div>
               <p className="col-span-4 break-all text-[11px] text-[var(--muted-foreground)]">激活凭证：<span className="font-mono font-semibold tracking-wider text-[var(--foreground)]">{maskCamiCode(assigningCard.code)}</span> · 绑定后学员只能一键激活，明文不会发送或进入其剪贴板{assigningCard.profile_key ? ` · 模板 ${assigningCard.profile_key} v${assigningCard.profile_version}` : " · 历史卡"}</p>
            </div>

            <label className="mt-4 block text-sm font-semibold text-[var(--foreground)]">选择学员
              <select
                value={assignmentUserId}
                onChange={(event) => { setAssignmentUserId(event.target.value); setAssignmentPassword(""); setAssignmentConfirmed(false); setAssignmentError(""); }}
                className={`${inputCls} mt-2`}
              >
                <option value="">请选择真实学员</option>
                {assignableUsers.map((user) => <option key={user.id} value={user.id}>{user.name || user.displayName || user.phone || user.email} · {user.memberStatus === "active" ? "已激活" : "未激活"}</option>)}
              </select>
            </label>

            {assignmentContextLoading && <div className="mt-4 rounded-xl border border-[var(--border)] p-4 text-sm text-[var(--muted-foreground)]">正在核对学员状态、体验包、线下收款和待兑换卡……</div>}
            {assignmentContext && !assignmentContextLoading && (
              <div data-testid="cami-assignment-member-context" className="mt-4 rounded-2xl border border-[var(--border)] bg-[var(--background)]/40 p-4">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-sm font-black text-[var(--foreground)]">{assignmentContext.member.display_name || assignmentContext.member.username || assignmentContext.member.phone || assignmentContext.member.email || "当前学员"}</p>
                    <p className="mt-1 text-xs text-[var(--muted-foreground)]">注册于 {assignmentContext.member.created_at ? new Date(assignmentContext.member.created_at).toLocaleString() : "时间未知"}</p>
                  </div>
                  <span className={`rounded-full px-3 py-1 text-xs font-bold ${assignmentContext.member.member_status === "active" ? "bg-emerald-500/12 text-emerald-600" : assignmentContext.member.member_status === "trial" ? "bg-blue-500/12 text-blue-600" : "bg-amber-500/12 text-amber-600"}`}>
                    {assignmentContext.member.member_status === "active" ? "正式会员" : assignmentContext.member.member_status === "trial" ? "试用会员" : "尚未激活"}
                  </span>
                </div>
                <div className="mt-3 grid grid-cols-4 gap-3 text-xs">
                  <div data-testid="cami-trial-delivery-state" className="rounded-xl border border-[var(--border)] p-3">
                    <p className="font-bold text-[var(--foreground)]">体验包</p>
                    <p className="mt-1 leading-relaxed text-[var(--muted-foreground)]">
                      {assignmentContext.member.member_status === "active"
                        ? "已正式激活，不再重复推送体验包"
                        : assignmentContext.packageState.trialDelivered
                          ? `已推送${assignmentContext.packageState.trialAssignment?.package_name ? `“${assignmentContext.packageState.trialAssignment.package_name}”` : "体验包"}${assignmentContext.packageState.trialAssignment?.member_expires_at ? `，有效至 ${new Date(assignmentContext.packageState.trialAssignment.member_expires_at).toLocaleString()}` : ""}`
                          : "尚未推送体验包"}
                    </p>
                    {assignmentContext.member.member_status !== "active" && !assignmentContext.packageState.trialDelivered && assignmentContext.packageState.invitation?.id && (
                      <button type="button" onClick={() => window.location.assign(`/admin?tab=invitations&member=${encodeURIComponent(assignmentContext.member.id)}`)} className="mt-2 font-bold text-blue-600 hover:underline">去邀请关系派发体验包</button>
                    )}
                  </div>
                  <div className="rounded-xl border border-[var(--border)] p-3">
                    <p className="font-bold text-[var(--foreground)]">线下付款</p>
                    <p className="mt-1 leading-relaxed text-[var(--muted-foreground)]">
                      {assignmentContext.packageState.confirmedOfflinePayment
                        ? `已确认 ¥${Number(assignmentContext.packageState.confirmedOfflinePayment.amount || 0).toFixed(2)}${assignmentContext.packageState.confirmedOfflinePayment.paid_at ? ` · ${new Date(assignmentContext.packageState.confirmedOfflinePayment.paid_at).toLocaleString()}` : ""}`
                        : "未找到已确认的会员学费补录；赠送激活卡也可继续，但请在确认项中说明依据"}
                    </p>
                  </div>
                  <div className="rounded-xl border border-[var(--border)] p-3">
                    <p className="font-bold text-[var(--foreground)]">当前套餐</p>
                    <p className="mt-1 leading-relaxed text-[var(--muted-foreground)]">{assignmentContext.packageState.current?.package_name || "暂无套餐记录"}{assignmentContext.packageState.current?.created_at ? ` · ${new Date(assignmentContext.packageState.current.created_at).toLocaleString()}` : ""}</p>
                  </div>
                  <div className={`rounded-xl border p-3 ${assignmentContext.packageState.pendingCards.length > 0 ? "border-rose-500/30 bg-rose-500/8" : "border-[var(--border)]"}`}>
                    <p className="font-bold text-[var(--foreground)]">待兑换激活卡</p>
                    <p className={`mt-1 leading-relaxed ${assignmentContext.packageState.pendingCards.length > 0 ? "text-rose-600" : "text-[var(--muted-foreground)]"}`}>
                      {assignmentContext.packageState.pendingCards.length > 0
                        ? `已有 ${assignmentContext.packageState.pendingCards.length} 张待兑换：${assignmentContext.packageState.pendingCards.map((card) => card.plan_name || card.id).join("、")}；请先处理原卡`
                        : "无待兑换卡，可继续发送"}
                    </p>
                  </div>
                </div>
              </div>
            )}

            <div className="mt-3 rounded-xl border border-blue-500/20 bg-blue-500/8 p-3 text-xs leading-relaxed text-blue-700">本操作只绑定并推送激活卡，不会立即改会员状态，也不会重复发体验包。学员兑换后，套餐权限、积分/现金与会员状态一次生效；若存在邀请关系，“正式会员邀请奖励”只进入待决定，仍由管理员另行确认。</div>

            <label className="mt-3 block text-sm font-semibold text-[var(--foreground)]">管理员操作密码
              <input
                data-testid="cami-assignment-admin-password"
                type="password"
                autoComplete="current-password"
                value={assignmentPassword}
                onChange={(event) => { setAssignmentPassword(event.target.value); setAssignmentError(""); }}
                className={`${inputCls} mt-2`}
                placeholder="输入当前管理员密码，5 分钟内本次操作有效"
              />
            </label>
            <label className="mt-3 flex cursor-pointer items-start gap-3 rounded-xl border border-amber-500/25 bg-amber-500/8 p-3 text-xs leading-relaxed text-amber-800">
              <input data-testid="cami-assignment-confirmed" type="checkbox" checked={assignmentConfirmed} onChange={(event) => { setAssignmentConfirmed(event.target.checked); setAssignmentError(""); }} className="mt-0.5 h-4 w-4" />
              <span>我已核对学员、套餐、付款或赠送依据，确认此卡只发给当前学员；发送后需由学员本人兑换。</span>
            </label>
            {assignmentError && <p role="alert" className="mt-3 rounded-xl bg-rose-500/10 px-3 py-2 text-xs font-semibold text-rose-600">{assignmentError}</p>}
            <div className="mt-4 flex justify-end gap-3">
              <button type="button" disabled={assignmentBusy} onClick={() => { setAssigningCard(null); setAssignmentUserId(""); setAssignmentPassword(""); setAssignmentConfirmed(false); setAssignmentContext(null); setAssignmentError(""); }} className={btnGhost}>取消</button>
              <button
                data-testid="cami-assignment-submit"
                type="button"
                disabled={assignmentBusy || assignmentContextLoading || !assignmentUserId || !assignmentContext || !assignmentPassword || !assignmentConfirmed || assignmentContext.packageState.pendingCards.length > 0}
                onClick={() => void handleAssignCard()}
                className={`${btnPrimary} disabled:cursor-not-allowed disabled:opacity-50`}
              >{assignmentBusy ? "密码复核并推送中..." : "验证密码并发送激活卡"}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function TrialPlansTab({ token, agents }: { token: string | null; agents: AgentInfo[] }) {
  const [plans, setPlans] = useState<TrialPlanInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [editingPlan, setEditingPlan] = useState<TrialPlanInfo | null>(null);
  const [form, setForm] = useState({ name: "", description: "", credits: 100, duration_days: 7, is_active: true, sort_order: 0 });
  const [selectedAgentIds, setSelectedAgentIds] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  const fetchPlans = useCallback(async () => {
    if (!token) return;
    try {
      setLoading(true);
      setLoadError("");
      const res = await fetch("/api/admin/trial-plans", {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "试用套餐目录读取失败");
      setPlans(data.plans || []);
    } catch (err) {
      console.error("获取试用套餐失败:", err);
      setLoadError(err instanceof Error ? err.message : "试用套餐目录读取失败");
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => { fetchPlans(); }, [fetchPlans]);

  const openCreate = () => {
    setEditingPlan(null);
    setForm({ name: "", description: "", credits: 100, duration_days: 7, is_active: true, sort_order: 0 });
    setSelectedAgentIds([]);
    setShowForm(true);
  };

  const openEdit = (plan: TrialPlanInfo) => {
    setEditingPlan(plan);
    setForm({ name: plan.name, description: plan.description, credits: plan.credits, duration_days: plan.duration_days, is_active: plan.is_active, sort_order: plan.sort_order });
    setSelectedAgentIds(plan.agent_ids || []);
    setShowForm(true);
  };

  const savePlan = async () => {
    if (!token || !form.name.trim()) return;
    setSaving(true);
    try {
      const url = editingPlan ? `/api/admin/trial-plans?id=${editingPlan.id}` : "/api/admin/trial-plans";
      const method = editingPlan ? "PUT" : "POST";
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ ...form, agent_ids: selectedAgentIds }),
      });
      if (res.ok) {
        setShowForm(false);
        fetchPlans();
      } else {
        const data = await res.json();
        alert(data.error || "保存失败");
      }
    } catch (err) {
      console.error("保存试用套餐失败:", err);
    } finally {
      setSaving(false);
    }
  };

  const deletePlan = async (id: string) => {
    if (!token || !confirm("确认删除此试用套餐？")) return;
    try {
      const res = await fetch(`/api/admin/trial-plans?id=${id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) fetchPlans();
    } catch (err) {
      console.error("删除试用套餐失败:", err);
    }
  };

  const toggleActive = async (plan: TrialPlanInfo) => {
    if (!token) return;
    try {
      const res = await fetch(`/api/admin/trial-plans?id=${plan.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ ...plan, agent_ids: plan.agent_ids || [], is_active: !plan.is_active }),
      });
      if (res.ok) fetchPlans();
    } catch (err) {
      console.error("切换状态失败:", err);
    }
  };

  const toggleAgent = (agentId: string) => {
    setSelectedAgentIds(prev =>
      prev.includes(agentId) ? prev.filter(id => id !== agentId) : [...prev, agentId]
    );
  };

  return (
    <div className="space-y-6">
      <div className="rounded-2xl border border-blue-500/25 bg-blue-500/8 p-4 text-sm leading-6 text-blue-700" data-testid="trial-plan-separation-note">
        <strong>试用套餐目录与邀请礼包分开管理。</strong> 本页保留原有试用套餐的新增、编辑、启停和智能体选择；它不会自动派发邀请码礼包，也不会自行产生支付订单。邀请注册赠送请到“权益与礼包”，真实收款与订单请到“资金与计费”。
        <div className="mt-3 flex gap-2"><a href="/admin?tab=benefit-packages" className="rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-bold text-white">去权益与礼包</a><a href="/admin?tab=payment" className="rounded-lg border border-blue-500/30 px-3 py-1.5 text-xs font-bold text-blue-700">去支付配置</a></div>
      </div>
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold text-[var(--foreground)]">试用套餐管理</h3>
          <p className="text-sm text-[var(--muted-foreground)] mt-1">配置新注册用户可选择的试用套餐，包括可用智能体、积分数和试用时长</p>
        </div>
        <button onClick={openCreate} className="px-4 py-2 bg-[var(--primary)] text-[var(--primary-foreground)] rounded-lg text-sm font-medium hover:opacity-90 transition-opacity">
          + 新增套餐
        </button>
      </div>

      {loadError ? (
        <div role="alert" className="rounded-2xl border border-rose-500/25 bg-rose-500/8 p-5 text-sm font-semibold text-rose-600">{loadError}。系统未用空数据冒充真实套餐。</div>
      ) : loading ? (
        <div className="text-center py-10 text-[var(--muted-foreground)]">加载中...</div>
      ) : plans.length === 0 ? (
        <div className="text-center py-10 text-[var(--muted-foreground)]">暂无试用套餐，请点击上方按钮新增</div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {plans.map(plan => {
            const planAgents = agents.filter(a => (plan.agent_ids || []).includes(a.id));
            return (
              <div key={plan.id} className={`bg-[var(--card)] rounded-xl border p-5 space-y-3 transition-all ${plan.is_active ? "border-[var(--border)]" : "border-[var(--border)] opacity-60"}`}>
                <div className="flex items-center justify-between">
                  <h4 className="font-semibold text-[var(--foreground)] text-base">{plan.name}</h4>
                  <span className={`text-xs px-2 py-0.5 rounded-full ${plan.is_active ? "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400" : "bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400"}`}>
                    {plan.is_active ? "启用" : "停用"}
                  </span>
                </div>
                {plan.description && <p className="text-xs text-[var(--muted-foreground)]">{plan.description}</p>}
                <div className="grid grid-cols-2 gap-2 text-sm">
                  <div className="bg-[var(--secondary)] rounded-lg p-2 text-center">
                    <div className="text-lg font-bold text-[var(--primary)]">{plan.credits}</div>
                    <div className="text-xs text-[var(--muted-foreground)]">积分</div>
                  </div>
                  <div className="bg-[var(--secondary)] rounded-lg p-2 text-center">
                    <div className="text-lg font-bold text-[var(--primary)]">{plan.duration_days}</div>
                    <div className="text-xs text-[var(--muted-foreground)]">天</div>
                  </div>
                </div>
                {planAgents.length > 0 && (
                  <div className="space-y-1">
                    <div className="text-xs font-medium text-[var(--muted-foreground)]">可用智能体 ({planAgents.length})</div>
                    <div className="flex flex-wrap gap-1">
                      {planAgents.slice(0, 5).map(a => (
                        <span key={a.id} className="text-xs bg-[var(--secondary)] px-2 py-0.5 rounded-full text-[var(--foreground)] truncate max-w-[120px]">{a.name}</span>
                      ))}
                      {planAgents.length > 5 && <span className="text-xs text-[var(--muted-foreground)]">+{planAgents.length - 5}个</span>}
                    </div>
                  </div>
                )}
                <div className="flex items-center gap-2 pt-2 border-t border-[var(--border)]">
                  <button onClick={() => openEdit(plan)} className="flex-1 py-1.5 text-xs bg-[var(--secondary)] rounded-lg hover:opacity-80 transition-opacity text-[var(--foreground)]">编辑</button>
                  <button onClick={() => toggleActive(plan)} className="flex-1 py-1.5 text-xs bg-[var(--secondary)] rounded-lg hover:opacity-80 transition-opacity text-[var(--foreground)]">{plan.is_active ? "停用" : "启用"}</button>
                  <button onClick={() => deletePlan(plan.id)} className="flex-1 py-1.5 text-xs bg-red-50 text-red-600 rounded-lg hover:opacity-80 transition-opacity dark:bg-red-900/20 dark:text-red-400">删除</button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* 新增/编辑弹窗 */}
      {showForm && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm z-[100] flex items-center justify-center">
          <div className="bg-[var(--card)] rounded-2xl shadow-2xl border border-[var(--border)] p-6 w-[640px] max-w-[90vw] max-h-[85vh] overflow-y-auto">
            <h3 className="text-lg font-semibold text-[var(--foreground)] mb-4">{editingPlan ? "编辑试用套餐" : "新增试用套餐"}</h3>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-[var(--foreground)] mb-1">套餐名称 *</label>
                <input value={form.name} onChange={(e) => setForm(f => ({ ...f, name: e.target.value }))} className="w-full px-3 py-2 bg-[var(--secondary)] border border-[var(--border)] rounded-lg text-sm text-[var(--foreground)]" placeholder="如：新用户体验包" />
              </div>
              <div>
                <label className="block text-sm font-medium text-[var(--foreground)] mb-1">套餐描述</label>
                <textarea value={form.description} onChange={(e) => setForm(f => ({ ...f, description: e.target.value }))} className="w-full px-3 py-2 bg-[var(--secondary)] border border-[var(--border)] rounded-lg text-sm text-[var(--foreground)] h-20 resize-none" placeholder="描述套餐内容和权益" />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-[var(--foreground)] mb-1">赠送积分</label>
                  <input type="number" value={form.credits} onChange={(e) => setForm(f => ({ ...f, credits: Number(e.target.value) }))} className="w-full px-3 py-2 bg-[var(--secondary)] border border-[var(--border)] rounded-lg text-sm text-[var(--foreground)]" min={0} />
                </div>
                <div>
                  <label className="block text-sm font-medium text-[var(--foreground)] mb-1">试用天数</label>
                  <input type="number" value={form.duration_days} onChange={(e) => setForm(f => ({ ...f, duration_days: Number(e.target.value) }))} className="w-full px-3 py-2 bg-[var(--secondary)] border border-[var(--border)] rounded-lg text-sm text-[var(--foreground)]" min={1} />
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-[var(--foreground)] mb-1">排序（数字越小越靠前）</label>
                <input type="number" value={form.sort_order} onChange={(e) => setForm(f => ({ ...f, sort_order: Number(e.target.value) }))} className="w-full px-3 py-2 bg-[var(--secondary)] border border-[var(--border)] rounded-lg text-sm text-[var(--foreground)]" min={0} />
              </div>
              <div>
                <label className="block text-sm font-medium text-[var(--foreground)] mb-2">
                  可用智能体 <span className="text-[var(--muted-foreground)] font-normal">(已选 {selectedAgentIds.length} 个)</span>
                </label>
                <div className="max-h-48 overflow-y-auto border border-[var(--border)] rounded-lg p-2 space-y-1 bg-[var(--secondary)]">
                  {agents.filter(a => a.is_active !== false).map(agent => (
                    <label key={agent.id} className="flex items-center gap-2 px-2 py-1.5 hover:bg-[var(--accent)] rounded cursor-pointer">
                      <input type="checkbox" checked={selectedAgentIds.includes(agent.id)} onChange={() => toggleAgent(agent.id)} className="rounded border-[var(--border)]" />
                      <span className="text-sm text-[var(--foreground)] truncate">{agent.name}</span>
                      <span className="text-xs text-[var(--muted-foreground)] ml-auto">{agent.source || "coze"}</span>
                    </label>
                  ))}
                  {agents.filter(a => a.is_active !== false).length === 0 && (
                    <div className="text-xs text-[var(--muted-foreground)] py-2 text-center">暂无可用智能体</div>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <input type="checkbox" checked={form.is_active} onChange={(e) => setForm(f => ({ ...f, is_active: e.target.checked }))} className="rounded" />
                <label className="text-sm text-[var(--foreground)]">立即启用</label>
              </div>
            </div>
            <div className="flex justify-end gap-3 mt-6">
              <button onClick={() => setShowForm(false)} className="px-4 py-2 text-sm bg-[var(--secondary)] rounded-lg hover:opacity-80 text-[var(--foreground)]">取消</button>
              <button onClick={savePlan} disabled={saving || !form.name.trim()} className="px-4 py-2 text-sm bg-[var(--primary)] text-[var(--primary-foreground)] rounded-lg hover:opacity-90 disabled:opacity-50">{saving ? "保存中..." : "保存"}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default function AdminPage() {
  const token = safeLocalStorageGet(STORAGE_KEYS.AUTH_TOKEN);
  const currentUserId = safeJsonParse<{id?: string}>(safeLocalStorageGet(STORAGE_KEYS.AUTH_USER), {})?.id ?? "";
  const authHeaders: Record<string, string> = { "Content-Type": "application/json", Authorization: `Bearer ${token || ""}` };
  const router = useRouter();
  const platformBranding = usePlatformBranding();
  const platformLogoUrl = platformBrandLogoUrl(platformBranding, "square");

  useEffect(() => {
    const body = document.body;
    const previousAdminSurface = body.getAttribute("data-admin-surface-active");
    body.setAttribute("data-admin-surface-active", "true");

    return () => {
      if (previousAdminSurface === null) body.removeAttribute("data-admin-surface-active");
      else body.setAttribute("data-admin-surface-active", previousAdminSurface);
    };
  }, []);

  const [activeTab, setActiveTab] = useState<Tab>("users");
  const [memberContextId, setMemberContextId] = useState("");
  const [workspaceProject, setWorkspaceProject] = useState<WorkspaceProjectId>("storyboard");
  const [importMode, setImportMode] = useState<"aiweb" | "coze">("aiweb");
  const [userSubTab, setUserSubTab] = useState<UserSubTab>("members");
  const [userInfo, setUserInfo] = useState<UserInfo | null>(null);
  const [adminAccess, setAdminAccess] = useState<AdminAccessClientState | null>(null);
  const sensitiveUnlocked = useAdminStepUpReady(
    adminAccess?.stepUp.status,
    adminAccess?.stepUp.expiresAt,
  );
  const sensitiveUnlockedRef = useRef(sensitiveUnlocked);
  useEffect(() => {
    sensitiveUnlockedRef.current = sensitiveUnlocked;
  }, [sensitiveUnlocked]);
  const grantedPermissionKeys = useMemo(
    () => new Set(adminAccess?.access.permissionKeys || []),
    [adminAccess?.access.permissionKeys],
  );
  const allowedCommandCenterViews = useMemo(
    () => visibleCommandCenterViews(
      adminAccess?.access.permissionKeys || [],
      adminAccess?.access.adminLevel === "super_admin",
    ),
    [adminAccess?.access.adminLevel, adminAccess?.access.permissionKeys],
  );
  const visibleAdminTabs = useMemo(
    () => ADMIN_PRIMARY_NAVIGATION
      .flatMap((module) => module.tabs)
      .filter((tab, index, tabs) => tabs.indexOf(tab) === index && canExposeAdminTab(adminAccess, tab)),
    [adminAccess],
  );
  const visibleAdminTabSet = useMemo(() => new Set(visibleAdminTabs), [visibleAdminTabs]);
  const firstAllowedTab = visibleAdminTabs[0] || null;
  const visibleWorkspaceProjectIds = useMemo(() => {
    const projects: WorkspaceProjectId[] = [...BASE_WORKSPACE_PROJECT_IDS];
    if (grantedPermissionKeys.has("models.manage")) projects.push("voice");
    if (grantedPermissionKeys.has("agents.view") && grantedPermissionKeys.has("prompts.view") && grantedPermissionKeys.has("models.view")) projects.push("commerce");
    if (grantedPermissionKeys.has("agents.manage") && grantedPermissionKeys.has("prompts.view")) projects.push("manju");
    if (grantedPermissionKeys.has("integrations.manage")) projects.push("tools");
    return projects;
  }, [grantedPermissionKeys]);
  const visibleWorkspaceProjectSet = useMemo(
    () => new Set<WorkspaceProjectId>(visibleWorkspaceProjectIds),
    [visibleWorkspaceProjectIds],
  );
  const hasGrantedStepUpCapability = useMemo(
    () => Boolean(adminAccess?.catalog.some((permission) =>
      permission.stepUpRequired && grantedPermissionKeys.has(permission.key),
    )),
    [adminAccess?.catalog, grantedPermissionKeys],
  );
  const canManageAgents = grantedPermissionKeys.has("agents.manage") && sensitiveUnlocked;
  const canManageAgentConfiguration = canManageAgents
    && grantedPermissionKeys.has("models.manage");
  const canViewInternalTools = grantedPermissionKeys.has("internal_tools.manage") && sensitiveUnlocked;
  const canManageInternalTools = canViewInternalTools;
  const canReadPrompts = grantedPermissionKeys.has("prompts.view") && sensitiveUnlocked;
  const canEditPrompts = grantedPermissionKeys.has("prompts.edit") && sensitiveUnlocked;
  const hasMembersManagePermission = grantedPermissionKeys.has("members.manage");
  const hasMembersDeletePermission = grantedPermissionKeys.has("members.delete");
  const hasMemberPermissionsManagePermission = grantedPermissionKeys.has("member_permissions.manage");
  const hasPackagesManagePermission = grantedPermissionKeys.has("packages.manage");
  const hasWalletAdjustPermission = grantedPermissionKeys.has("wallet.adjust");
  const canViewMembers = grantedPermissionKeys.has("members.view");
  const canViewMemberContent = grantedPermissionKeys.has("member_content.view");
  const canViewBilling = grantedPermissionKeys.has("billing.view");
  const hasBillingExportPermission = grantedPermissionKeys.has("billing.export");
  const canViewMemberSecurity = grantedPermissionKeys.has("security.view");
  const canManageMembers = hasMembersManagePermission && sensitiveUnlocked;
  const canDeleteMembers = hasMembersDeletePermission && sensitiveUnlocked;
  const canManageMemberPermissions = hasMemberPermissionsManagePermission && sensitiveUnlocked;
  const canManagePackages = hasPackagesManagePermission && sensitiveUnlocked;
  const canAdjustWallet = hasWalletAdjustPermission && sensitiveUnlocked;
  const canExportBilling = hasBillingExportPermission && sensitiveUnlocked;
  const readableSettingScopes = useMemo(
    () => (["brand", "integrations", "models", "payment", "prompts"] as const)
      .filter((scope) => grantedPermissionKeys.has(adminPlatformSettingPermission(scope, "read"))),
    [grantedPermissionKeys],
  );
  const hasBrandSettingsPermission = grantedPermissionKeys.has("brand.settings.manage");
  const hasIntegrationSettingsPermission = grantedPermissionKeys.has("integrations.manage");
  const hasModelSettingsPermission = grantedPermissionKeys.has("models.manage");
  const hasPaymentSettingsPermission = grantedPermissionKeys.has("payment.settings.manage");
  const hasSecuritySettingsPermission = grantedPermissionKeys.has("security.manage");
  const canManageBrandSettings = hasBrandSettingsPermission && sensitiveUnlocked;
  const canManageIntegrations = hasIntegrationSettingsPermission && sensitiveUnlocked;
  const canManageModelSettings = hasModelSettingsPermission && sensitiveUnlocked;
  const canManagePaymentSettings = hasPaymentSettingsPermission && sensitiveUnlocked;
  const canManageSecuritySettings = hasSecuritySettingsPermission && sensitiveUnlocked;
  const [unlockDialogRequested, setUnlockDialogRequested] = useState(false);
  const [users, setUsers] = useState<UserInfo[]>([]);
  const memberContextUser = useMemo(() => users.find((user) => user.id === memberContextId) || null, [memberContextId, users]);
  const memberContextLabel = memberContextUser?.name || memberContextUser?.displayName || memberContextUser?.phone || memberContextUser?.email || memberContextId;
  const [memberFilter, setMemberFilter] = useState<MemberFilter>("all");
  const [userSearch, setUserSearch] = useState("");
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [viewingPromptAgentId, setViewingPromptAgentId] = useState("");
  const [agentDataSource, setAgentDataSource] = useState<{ configuration: string; configurationId?: string | null; businessData: string } | null>(null);
  const [trashedAgents, setTrashedAgents] = useState<AgentInfo[]>([]);
  const agentsRequestSequenceRef = useRef(0);
  const agentsAbortControllerRef = useRef<AbortController | null>(null);
  const trashedAgentsRequestSequenceRef = useRef(0);
  const trashedAgentsAbortControllerRef = useRef<AbortController | null>(null);
  const [settings, setSettings] = useState<PlatformSettings>(createDefaultPlatformSettings);
  const [settingsBaseline, setSettingsBaseline] = useState<PlatformSettings>(createDefaultPlatformSettings);
  const lockedSettings = useMemo(() => createDefaultPlatformSettings(), []);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [themePushing, setThemePushing] = useState(false);
  const [pushedPlatformTheme, setPushedPlatformTheme] = useState<string | null>(null);
  const [pushedPlatformThemeMode, setPushedPlatformThemeMode] = useState<ThemeModePreference | null>(null);
  const visibleSettings = useMemo(() => sensitiveUnlocked ? settings : {
    ...lockedSettings,
    ...(pushedPlatformTheme ? { theme: pushedPlatformTheme } : {}),
    ...(pushedPlatformThemeMode ? { theme_mode: pushedPlatformThemeMode } : {}),
  }, [lockedSettings, pushedPlatformTheme, pushedPlatformThemeMode, sensitiveUnlocked, settings]);
  const pendingThemePublishRef = useRef<{ theme: string; themeMode: ThemeModePreference } | null>(null);
  const editableSettingKeys = useMemo(() => Array.from(new Set(
    readableSettingScopes.flatMap((scope) => adminPlatformSettingKeysForScope(scope)),
  )) as Array<keyof PlatformSettings>, [readableSettingScopes]);
  const settingsDirtyKeys = useMemo(() => sensitiveUnlocked
    ? editableSettingKeys.filter((key) => (
      typeof settings[key] === "string"
      && settings[key] !== settingsBaseline[key]
    ))
    : [], [editableSettingKeys, sensitiveUnlocked, settings, settingsBaseline]);
  const hasUnsavedAdminSettings = settingsDirtyKeys.length > 0;

  useEffect(() => {
    if (!hasUnsavedAdminSettings) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [hasUnsavedAdminSettings]);

  const previewPlatformAppearance = useCallback((themeValue: string, themeModeValue: string) => {
    if (typeof document === "undefined") return;
    const theme = normalizeTheme(themeValue);
    const themeMode = normalizePlatformThemeMode(theme, themeModeValue);
    const systemPrefersDark = typeof window !== "undefined"
      && window.matchMedia("(prefers-color-scheme: dark)").matches;
    const resolvedMode = resolveThemeModeForTheme(theme, themeMode, systemPrefersDark);
    const renderedTheme = resolveRenderedTheme(theme, themeMode, resolvedMode);
    const root = document.documentElement;
    root.setAttribute("data-theme-selection", theme);
    root.setAttribute("data-theme", renderedTheme);
    root.setAttribute("data-mode-preference", themeMode);
    root.setAttribute("data-mode", resolvedMode);
  }, []);

  const openAdminTab = useCallback((tab: Tab, historyMode: "push" | "replace" = "push") => {
    const nextTab = visibleAdminTabSet.has(tab) ? tab : firstAllowedTab;
    if (!nextTab) return;
    setActiveTab(nextTab);
    if (nextTab === "users") setUserSubTab("members");
    const url = new URL(window.location.href);
    url.searchParams.set("tab", nextTab);
    if (nextTab !== "workspace-models") url.searchParams.delete("project");
    url.searchParams.delete("member");
    setMemberContextId("");
    const nextUrl = `${url.pathname}${url.search}${url.hash}`;
    if (historyMode === "replace") {
      window.history.replaceState(null, "", nextUrl);
    } else {
      window.history.pushState(null, "", nextUrl);
    }
  }, [firstAllowedTab, visibleAdminTabSet]);

  const openMemberModule = useCallback((tab: Extract<Tab, "invitations" | "cami" | "login-logs" | "offline-payments">, userId: string) => {
    if (!visibleAdminTabSet.has(tab)) return;
    setActiveTab(tab);
    setMemberContextId(userId);
    const url = new URL(window.location.href);
    url.searchParams.set("tab", tab);
    url.searchParams.set("member", userId);
    url.searchParams.delete("project");
    window.history.pushState(null, "", `${url.pathname}${url.search}${url.hash}`);
  }, [visibleAdminTabSet]);

  const clearMemberContext = useCallback(() => {
    setMemberContextId("");
    const url = new URL(window.location.href);
    url.searchParams.delete("member");
    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  }, []);

  const openWorkspaceProject = useCallback((project: WorkspaceProjectId, historyMode: "push" | "replace" = "push") => {
    if (!visibleAdminTabSet.has("workspace-models")) return;
    const requestedProject = normalizeWorkspaceProject(project);
    const nextProject = requestedProject && visibleWorkspaceProjectSet.has(requestedProject)
      ? requestedProject
      : (visibleWorkspaceProjectIds[0] || "storyboard");
    setActiveTab("workspace-models");
    setWorkspaceProject(nextProject);
    const url = new URL(window.location.href);
    url.searchParams.set("tab", "workspace-models");
    url.searchParams.set("project", nextProject);
    const nextUrl = `${url.pathname}${url.search}${url.hash}`;
    if (historyMode === "replace") window.history.replaceState(null, "", nextUrl);
    else window.history.pushState(null, "", nextUrl);
  }, [visibleAdminTabSet, visibleWorkspaceProjectIds, visibleWorkspaceProjectSet]);

  const openWorkspaceAdminTarget = useCallback((target: WorkspaceSpecializedTarget) => {
    const project = LEGACY_WORKSPACE_TAB_PROJECT[target] || "storyboard";
    if (!visibleWorkspaceProjectSet.has(project)) return;
    openWorkspaceProject(project);
  }, [openWorkspaceProject, visibleWorkspaceProjectSet]);

  useEffect(() => {
    if (!adminAccess) return;
    const activateTabFromUrl = () => {
      const url = new URL(window.location.href);
      const requestedTab = url.searchParams.get("tab");
      const legacyProject = requestedTab ? LEGACY_WORKSPACE_TAB_PROJECT[requestedTab] : undefined;
      const validRequestedTab = isValidTab(requestedTab) ? requestedTab : null;
      const requestedProject = url.searchParams.get("project");
      const normalizedRequestedProject = normalizeWorkspaceProject(requestedProject);
      const candidateTab: Tab | null = legacyProject ? "workspace-models" : validRequestedTab;
      const nextTab = candidateTab && visibleAdminTabSet.has(candidateTab)
        ? candidateTab
        : firstAllowedTab;
      if (!nextTab) {
        setMemberContextId("");
        url.searchParams.delete("tab");
        url.searchParams.delete("project");
        url.searchParams.delete("member");
        window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
        return;
      }
      const projectCandidate = legacyProject || normalizedRequestedProject;
      const nextProject = projectCandidate && visibleWorkspaceProjectSet.has(projectCandidate)
        ? projectCandidate
        : (visibleWorkspaceProjectIds[0] || "storyboard");
      setActiveTab(nextTab);
      setWorkspaceProject(nextProject);
      setMemberContextId(["invitations", "cami", "login-logs", "offline-payments"].includes(nextTab) ? (url.searchParams.get("member") || "") : "");

      // activeTab 已由 URL 和组件状态管理。清掉旧版会话缓存，避免访问裸 /admin
      // 时被上一次停留的功能页（尤其是漫剧工作台）抢占首屏。
      try {
        sessionStorage.removeItem("app_state_admin_activeTab");
        sessionStorage.removeItem("app_state_admin_userSubTab");
      } catch { /* Storage may be unavailable. */ }

      const requestedTabAllowed = candidateTab !== null && visibleAdminTabSet.has(candidateTab);
      const projectNeedsReplacement = nextTab === "workspace-models" && requestedProject !== nextProject;
      if (legacyProject || !requestedTabAllowed || projectNeedsReplacement) {
        url.searchParams.set("tab", nextTab);
        if (nextTab === "workspace-models") url.searchParams.set("project", nextProject);
        else url.searchParams.delete("project");
        if (!["invitations", "cami", "login-logs", "offline-payments"].includes(nextTab)) {
          url.searchParams.delete("member");
        }
        if (nextTab === "users") setUserSubTab("members");
        window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
      }
    };

    activateTabFromUrl();
    window.addEventListener("popstate", activateTabFromUrl);
    return () => window.removeEventListener("popstate", activateTabFromUrl);
  }, [adminAccess, firstAllowedTab, visibleAdminTabSet, visibleWorkspaceProjectIds, visibleWorkspaceProjectSet]);

  // 操作密码相关状态
  const [opPasswordSet, setOpPasswordSet] = useState(false);
  const [opPasswordLoading, setOpPasswordLoading] = useState(false);
  const [showOpPasswordDialog, setShowOpPasswordDialog] = useState(false);
  const [opPasswordAction, setOpPasswordAction] = useState<"set" | "change" | "remove" | "generate">("set");
  const [opPasswordOld, setOpPasswordOld] = useState("");
  const [opPasswordNew, setOpPasswordNew] = useState("");
  const [opPasswordError, setOpPasswordError] = useState("");
  const [opPasswordSuccess, setOpPasswordSuccess] = useState("");
  const [generatedPassword, setGeneratedPassword] = useState("");
  const opPasswordRequestSequenceRef = useRef(0);
  const opPasswordAbortControllerRef = useRef<AbortController | null>(null);
  const [loading, setLoading] = useState(true);
  const [videoModelsList, setVideoModelsList] = useState<Record<string, unknown>[]>([]);
  const [editingVideoModel, setEditingVideoModel] = useState<Record<string, unknown> | null>(null);
  const [channelHealth, setChannelHealth] = useState<Record<string, Record<string, unknown>>>({});
  const [showVideoModelDialog, setShowVideoModelDialog] = useState(false);
  const [testingModelId, setTestingModelId] = useState<string | null>(null);
  // 视频模型延迟保存：本地暂存变更，点"保存"才持久化
  const [videoModelsDraft, setVideoModelsDraft] = useState<Record<string, unknown>[]>([]);
  const [videoModelsChanged, setVideoModelsChanged] = useState(false);
  const [videoModelsSaving, setVideoModelsSaving] = useState(false);

  const [showAddUser, setShowAddUser] = useState(false);
  const [editingUserAccess, setEditingUserAccess] = useState<UserInfo | null>(null);
  const [packageUser, setPackageUser] = useState<UserInfo | null>(null);
  const [editAccessCategories, setEditAccessCategories] = useState<string[]>([]);
  const [editFeatureNavigationKeys, setEditFeatureNavigationKeys] = useState<string[]>([]);
  const [editAccessRevision, setEditAccessRevision] = useState(0);
  const [editAccessProfiles, setEditAccessProfiles] = useState<MemberPermissionProfileOption[]>([]);
  const [editAccessProfile, setEditAccessProfile] = useState<{ key: string; version: number } | null>(null);
  const [editAccessReason, setEditAccessReason] = useState("");
  const [editAccessLoading, setEditAccessLoading] = useState(false);
  const [editAccessSaving, setEditAccessSaving] = useState(false);
  const [editAccessUpdatedAt, setEditAccessUpdatedAt] = useState<string | null>(null);
  const [editAccessIntegrityValid, setEditAccessIntegrityValid] = useState(true);
  const [viewingUserTransactions, setViewingUserTransactions] = useState<UserInfo | null>(null);
  const [transactionData, setTransactionData] = useState<any>(null);
  const [transactionLoading, setTransactionLoading] = useState(false);
  const [transactionTab, setTransactionTab] = useState<"lifecycle" | "all" | "credits" | "cash" | "consumption" | "video" | "daily" | "login">("lifecycle");
  const [transactionFilter, setTransactionFilter] = useState<"all" | "recharge" | "consume">("all");
  const [loginLogs, setLoginLogs] = useState<Array<any>>([]);
  const [loginLogsLoading, setLoginLogsLoading] = useState(false);
  const [memberUsageSummary, setMemberUsageSummary] = useState<{ login: { total: number; success: number; failed: number; today: number }; conversationCount: number } | null>(null);
  const [memberLifecycle, setMemberLifecycle] = useState<{ events: Array<{ id: string; kind: string; title: string; detail: string; occurredAt: string; status: string }>; summary?: { memberStatus?: string; invitationCount?: number; receivedRewardCount?: number; cardCount?: number; offlinePaymentCount?: number } } | null>(null);
  const [memberExportingId, setMemberExportingId] = useState("");
  const [showAddAgent, setShowAddAgent] = useState(false);
  const [addPresetFields, setAddPresetFields] = useState<PresetTemplateField[]>([]);
  const [addAgentCoverUrl, setAddAgentCoverUrl] = useState("");
  const [addAgentCoverPreview, setAddAgentCoverPreview] = useState("");
  const [addAgentCoverUploading, setAddAgentCoverUploading] = useState(false);
  const [showImportCoze, setShowImportCoze] = useState(false);
  const [showImportByIds, setShowImportByIds] = useState(false);
  const [importByIdsText, setImportByIdsText] = useState("");
  const [importByIdsCategory, setImportByIdsCategory] = useState("其他");
  const [importByIdsLoading, setImportByIdsLoading] = useState(false);
  const [importByIdsResult, setImportByIdsResult] = useState<{ imported: number; skipped: number; failed: number; details?: { imported: Array<{ bot_id: string; name: string }>; skipped: Array<{ bot_id: string; reason: string }>; failed: Array<{ bot_id: string; reason: string }> } } | null>(null);
  const [fetchBotInfoLoading, setFetchBotInfoLoading] = useState(false);
  const [cozeBots, setCozeBots] = useState<Array<{ bot_id: string; bot_name: string; description: string; icon_url: string; already_imported: boolean; selected?: boolean; category?: string }>>([]);
  const [importLoading, setImportLoading] = useState(false);
  const [importResult, setImportResult] = useState<{ imported: number; skipped: number } | null>(null);
  const [newUser, setNewUser] = useState({ phone: "", email: "", emailVerificationCode: "", password: "", displayName: "", role: "student", credits: 0, allowedCategories: [] as string[] });
  const [memberSecurityDialog, setMemberSecurityDialog] = useState<{
    kind: "identity_change" | "password_reset";
    user: UserInfo;
    username: string;
    email: string;
    newPassword: string;
    adminPassword: string;
  } | null>(null);
  const [memberVerificationSending, setMemberVerificationSending] = useState(false);
  const [memberSecuritySubmitting, setMemberSecuritySubmitting] = useState(false);

  // ── 聊天记录查看 ──
  const [chatDialogTitle, setChatDialogTitle] = useState("");
  const [chatLoading, setChatLoading] = useState(false);
  const [showChatDialog, setShowChatDialog] = useState(false);
  const [chatMessages, setChatMessages] = useState<Array<{ role: string; content: string; createdAt?: string }>>([]);

  // ── 聊天记录子Tab ──
  const [chatListFilter, setChatListFilter] = useState<string>("");
  const [chatListSearch, setChatListSearch] = useState("");
  const [userConversations, setUserConversations] = useState<Array<{
    id: string; agentName: string; agentId: string; source: string;
    createdAt: string; updatedAt: string; messageCount: number; lastMessage: string;
    userId?: string; userName?: string;
  }>>([]);
  const [chatListTotal, setChatListTotal] = useState(0);
  const [chatListPage, setChatListPage] = useState(1);
  const [chatListLoading, setChatListLoading] = useState(false);
  // 智能体使用统计
  const [agentUsageStats, setAgentUsageStats] = useState<Array<{
    agentId: string; agentName: string; conversationCount: number; messageCount: number; lastUsed: string;
  }>>([]);
  const [addAgentSource, setAddAgentSource] = useState<"coze_coding" | "llm">("llm");
  const [newAgent, setNewAgent] = useState({
    name: "", description: "", avatar: "", category: "通用", source: "llm", botId: "", model: "deepseek-v4-flash", systemPrompt: "", costPerMessage: 10, sortOrder: 0,
    cozeCodingApiUrl: "", cozeCodingApiToken: "", cozeCodingProjectId: "", isActive: true, output_style: undefined as OutputStyle | undefined, enable_think_tags: false as boolean,
    proxyUrl: "", deepThinkingType: 0, deductDeepThink: 1, maxContextRounds: 0, maxContextTokens: 0, maxReplyTokens: 16384, timeout: 300, enableWebSearch: false,
    temperature: undefined as number | undefined, response_format: undefined as "text" | "markdown" | "json_object" | undefined,
    // 智能体级独立Token计费
    token_billing_enabled: false as boolean,
    input_cost_per_million: undefined as number | undefined,
    output_cost_per_million: undefined as number | undefined,
    cached_cost_per_million: undefined as number | undefined,
    profit_margin: undefined as number | undefined,
    token_rounding_unit: 0 as number,
    // 模型预设关联
    modelId: "" as string,
    // 新增字段
    frequencyLimit: 50 as number,
    imageParsing: "none" as string,
    fileParsing: "none" as string,
    guide_message: "" as string,
  });
  const [addShowAdvanced, setAddShowAdvanced] = useState(false);
  const [editShowAdvanced, setEditShowAdvanced] = useState(false);
  const [avatarUploading, setAvatarUploading] = useState(false);
  const [avatarPreview, setAvatarPreview] = useState("");
  const [editAvatarUploading, setEditAvatarUploading] = useState(false);
  const [editAvatarPreview, setEditAvatarPreview] = useState("");
  const [editAgentCoverUploading, setEditAgentCoverUploading] = useState(false);
  const [editAgentCoverPreview, setEditAgentCoverPreview] = useState("");
  const [pendingAddAvatarKey, setPendingAddAvatarKey] = useState("");
  const [pendingAddCoverKey, setPendingAddCoverKey] = useState("");
  const [pendingEditAvatarKey, setPendingEditAvatarKey] = useState("");
  const [pendingEditCoverKey, setPendingEditCoverKey] = useState("");
  const editOriginalImagesRef = useRef({ avatar: "", cover: "" });
  const editOriginalAgentRef = useRef<AgentInfo | null>(null);
  const directorContractActionRef = useRef<"rollback" | null>(null);
  const agentEditSessionRef = useRef(0);
  const agentPromptReadRef = useRef(0);
  const agentSaveInFlightRef = useRef(false);
  const [agentEditSession, setAgentEditSession] = useState(0);
  const [editPromptReading, setEditPromptReading] = useState(false);
  const [agentSaveBusy, setAgentSaveBusy] = useState(false);
  // 候选头像列表：生成的头像供选择，持久化到 localStorage
  const [avatarCandidates, setAvatarCandidates] = useState<string[]>(() => {
    if (typeof window === "undefined") return [];
    try { return safeJsonParse<string[]>(safeLocalStorageGet("avatar_candidates"), []); } catch { return []; }
  });
  const [singleAvatarGenerating, setSingleAvatarGenerating] = useState(false);
  const [singleAvatarMode, setSingleAvatarMode] = useState<"add" | "edit" | null>(null);
  const [singleAvatarStatus, setSingleAvatarStatus] = useState("");
  const [singleAvatarStyle, setSingleAvatarStyle] = useState("主站3D卡通");
  const [singleAvatarCustomPrompt, setSingleAvatarCustomPrompt] = useState("");
  const [editingAgent, setEditingAgentState] = useState<AgentInfo | null>(null);
  const agentEditorAccessRef = useRef({ configuration: canManageAgentConfiguration, prompts: canEditPrompts });
  // A callback from an earlier render must never resurrect a closed edit session.
  const setEditingAgent = (update: React.SetStateAction<AgentInfo | null>) => {
    setEditingAgentState((current) => {
      if (!agentEditorAccessRef.current.configuration || agentEditSessionRef.current !== agentEditSession || !current
        || current.id !== editOriginalAgentRef.current?.id) return current;
      const next = typeof update === "function" ? update(current) : update;
      return next && next.id === current.id ? next : current;
    });
  };
  const closeAgentEditor = (expectedSession?: number) => {
    if (expectedSession !== undefined && agentEditSessionRef.current !== expectedSession) return false;
    agentEditSessionRef.current += 1;
    agentPromptReadRef.current += 1;
    editOriginalAgentRef.current = null;
    directorContractActionRef.current = null;
    setEditPromptReading(false);
    setEditingAgentState(null);
    setPendingEditAvatarKey("");
    setPendingEditCoverKey("");
    setEditAvatarPreview("");
    setEditAgentCoverPreview("");
    setEditAvatarUploading(false);
    setEditAgentCoverUploading(false);
    return true;
  };
  useEffect(() => {
    agentEditorAccessRef.current = { configuration: canManageAgentConfiguration, prompts: canEditPrompts };
    if (!canManageAgentConfiguration) closeAgentEditor();
    if (!canEditPrompts) { agentPromptReadRef.current += 1; setEditPromptReading(false); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canManageAgentConfiguration, canEditPrompts]);
  const resolveAvatarPreviewSrc = (value?: string | null) => {
    if (!value) return "";
    return value.startsWith("http") || value.startsWith("/") || value.startsWith("data:")
      ? value
      : `/api/avatars?key=${encodeURIComponent(value)}`;
  };
  const resolveTrashAvatarSrc = (agent: Pick<AgentInfo, "id" | "name" | "avatar">) => {
    const resolved = resolveAvatarUrl(agent.avatar);
    // 回收站也沿用应用广场的语义头像风格；未知远程 URL 或空字段使用稳定本地兜底。
    if (!resolved || /^https?:\/\//i.test(resolved)) {
      return getSemanticAgentAvatarFallback(agent.id, agent.name);
    }
    return resolved;
  };
  // 提示词版本历史 refs
  const editPromptVersionRef = useRef<PromptVersionHistoryHandle>(null);
  const newPromptVersionRef = useRef<PromptVersionHistoryHandle>(null);
  const [healthData, setHealthData] = useState<any>(null);
  const [healthLoading, setHealthLoading] = useState(false);
  const [healthActionError, setHealthActionError] = useState("");
  const [codingTestResult, setCodingTestResult] = useState<{ok: boolean; msg: string} | null>(null);
  const [codingTestLoading, setCodingTestLoading] = useState(false);
  const codingTestInFlightRef = useRef(false);
  const [systemLogs, setSystemLogs] = useState<any[]>([]);
  const [logFilter, setLogFilter] = useState("all");
  // ── 使用诊断状态 ──
  const [diagTab, setDiagTab] = useState<"auto" | "manual">("auto");
  const [diagLogs, setDiagLogs] = useState<any[]>([]);
  const [diagTotal, setDiagTotal] = useState(0);
  const [diagPage, setDiagPage] = useState(1);
  const [diagSummary, setDiagSummary] = useState<any>(null);
  const [diagFilterType, setDiagFilterType] = useState("");
  const [diagFilterSeverity, setDiagFilterSeverity] = useState("");
  const [diagFilterStatus, setDiagFilterStatus] = useState("");
  const [diagDetailId, setDiagDetailId] = useState<string | null>(null);
  const [diagDetail, setDiagDetail] = useState<any>(null);
  const [diagLoading, setDiagLoading] = useState(false);
  const [diagError, setDiagError] = useState("");
  const [diagUpdatingId, setDiagUpdatingId] = useState<string | null>(null);
  const [rechargeUserId, setRechargeUserId] = useState("");
  const [rechargeYuan, setRechargeYuan] = useState(100);
  const [bonusCredits, setBonusCredits] = useState(0);
  const [rechargeNotifyUser, setRechargeNotifyUser] = useState(false);
  const [adjustUserId, setAdjustUserId] = useState("");
  const [adjustCredits, setAdjustCredits] = useState(5000);
  const [adjustNotifyUser, setAdjustNotifyUser] = useState(false);
  const [cashTopupUserId, setCashTopupUserId] = useState("");
  const [cashTopupAmount, setCashTopupAmount] = useState(50);
  const [cashNotifyUser, setCashNotifyUser] = useState(false);
  const [walletBusy, setWalletBusy] = useState(false);
  const walletBusyRef = useRef(false);
  const usersRequestSequenceRef = useRef(0);
  const memberWorkspaceRef = useRef<HTMLDivElement | null>(null);
  const memberListViewSnapshotRef = useRef<MemberListViewSnapshot | null>(null);
  const adminUserDeleteVerificationRef = useRef<AdminUserDeleteVerification | null>(null);
  const [deletingUserIds, setDeletingUserIds] = useState<string[]>([]);
  const [pendingWalletAttempts, setPendingWalletAttempts] = useState<PendingAdminWalletAttempt[]>([]);
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);
  useEffect(() => {
    const restore = () => {
      try { setPendingWalletAttempts(readPendingAdminWalletAttempts(userInfo?.id || "")); }
      catch (error) { setMessage({ type: "error", text: error instanceof Error ? error.message : "余额操作记录无法读取" }); }
    };
    restore();
    window.addEventListener("storage", restore);
    return () => window.removeEventListener("storage", restore);
  }, [userInfo?.id]);
  const [cozeTestResult, setCozeTestResult] = useState<{ connected: boolean; botCount?: number; sampleBots?: Array<{ bot_id: string; bot_name: string }>; error?: string } | null>(null);
  useEffect(() => {
    if (sensitiveUnlocked) return;
    agentsRequestSequenceRef.current += 1;
    agentsAbortControllerRef.current?.abort();
    agentsAbortControllerRef.current = null;
    trashedAgentsRequestSequenceRef.current += 1;
    trashedAgentsAbortControllerRef.current?.abort();
    trashedAgentsAbortControllerRef.current = null;
    opPasswordRequestSequenceRef.current += 1;
    opPasswordAbortControllerRef.current?.abort();
    opPasswordAbortControllerRef.current = null;
    // A step-up lock or expiry must remove every value previously returned by
    // /api/settings/admin, including unknown keys added by a newer server.
    setSettings(createDefaultPlatformSettings());
    setSettingsBaseline(createDefaultPlatformSettings());
    setCozeTestResult(null);
    setAgents((current) => current.map(stripAgentSensitiveClientFields));
    setTrashedAgents((current) => current.map(stripAgentSensitiveClientFields));
    setAgentDataSource(null);
    setViewingPromptAgentId("");
    closeAgentEditor();
    setShowAddAgent(false);
    setShowImportCoze(false);
    setShowImportByIds(false);
    setShowVideoModelDialog(false);
    setEditingVideoModel(null);
    setNewAgent((current) => ({
      ...current,
      botId: "",
      systemPrompt: "",
      cozeCodingApiUrl: "",
      cozeCodingApiToken: "",
      cozeCodingProjectId: "",
      proxyUrl: "",
    }));
    setShowOpPasswordDialog(false);
    setOpPasswordOld("");
    setOpPasswordNew("");
    setOpPasswordError("");
    setOpPasswordSuccess("");
    setGeneratedPassword("");
    setOpPasswordLoading(false);
  }, [sensitiveUnlocked]);
  useEffect(() => () => {
    agentsAbortControllerRef.current?.abort();
    trashedAgentsAbortControllerRef.current?.abort();
    opPasswordAbortControllerRef.current?.abort();
  }, []);
  const [categories, setCategories] = useState<AdminAgentCategory[]>([]);
  // 动态分类列表：优先用API返回的分类，兜底用FALLBACK_CATEGORIES
  const categoryOptions = categories.length > 0 ? categories.map(c => c.name) : FALLBACK_CATEGORIES;
  const [llmModels, setLlmModels] = useState<Array<{
    id: string; name: string; model_name: string; description?: string; category?: string;
    api_endpoint?: string; api_key?: string; proxy_url?: string;
    billing_mode?: string; cost_per_use?: number; cost_price?: number;
    token_billing_enabled?: boolean; input_cost_per_million?: number | null;
    output_cost_per_million?: number | null; cached_cost_per_million?: number | null;
    profit_margin?: number | null; token_rounding_unit?: number;
    deep_thinking_type?: number; deduct_deep_think?: number;
    max_context_rounds?: number; max_context_tokens?: number; max_reply_tokens?: number;
    timeout?: number; enable_web_search?: boolean; temperature?: number | null;
    response_format?: string | null; is_active?: boolean; sort_order?: number;
    frequency_limit?: number; image_parsing?: string; file_parsing?: string; icon_url?: string;
  }>>([]);
  const [drawingModels, setDrawingModels] = useState<Array<{
    id: string; name: string; model_name: string; description?: string;
    selling_price?: number; price_per_use?: number; is_active?: boolean; sort_order?: number;
  }>>([]);
  const activeDrawingModels = drawingModels.filter(m => m.is_active !== false);
  const selectedAvatarModelId = visibleSettings.auto_avatar_model_id.trim();
  const selectedAvatarModelUnavailable = selectedAvatarModelId !== ""
    && !activeDrawingModels.some((model) => model.id === selectedAvatarModelId);
  const selectedAvatarModelIsSaved = selectedAvatarModelId === settingsBaseline.auto_avatar_model_id.trim();
  const isImageGenerationModel = (modelName?: string | null) =>
    /\b(gpt-image|glm-image|dall-e|stable-diffusion|sd3|flux|seedream|cogview|ideogram|imagen)\b/i.test(modelName || "");
  const [newCategoryName, setNewCategoryName] = useState("");
  const [newCategoryIcon, setNewCategoryIcon] = useState("");
  const [editingCategoryId, setEditingCategoryId] = useState<string | null>(null);
  const [editingCategoryName, setEditingCategoryName] = useState("");
  const [editingCategoryIcon, setEditingCategoryIcon] = useState("");
  const [deleteCategoryId, setDeleteCategoryId] = useState<string | null>(null);
  const [selectedCategoryId, setSelectedCategoryId] = useState<string | null>(null); // null=全部
  const [selectedDisplayCategory, setSelectedDisplayCategory] = useState<string | null>(null);
  const [agentSearchQuery, setAgentSearchQuery] = useState("");
  const hasAgentSearchQuery = normalizeAdminAgentSearchQuery(agentSearchQuery).length > 0;
  const [agentSortSaving, setAgentSortSaving] = useState(false);
  const agentSortSavingRef = useRef(false);
  const pendingAgentRevisionsRef = useRef<Record<string, { revision: number; category: string }>>({});
  const canDragAgentRows = canManageAgents && !hasAgentSearchQuery && !selectedDisplayCategory && !agentSortSaving;
  const [pendingSortOrders, setPendingSortOrders] = useState<Record<string, number>>({});
  const [pendingAgentSortOrders, setPendingAgentSortOrders] = useState<Record<string, number>>({});
  const [showImportCoding, setShowImportCoding] = useState(false);
  const [importCodingText, setImportCodingText] = useState("");
  // 拖拽分类迁移状态
  const [draggedAgentId, setDraggedAgentId] = useState<string | null>(null);
  const [dragOverCategoryId, setDragOverCategoryId] = useState<string | null>(null);
  // 智能体列表拖拽排序状态
  const [dragOverAgentId, setDragOverAgentId] = useState<string | null>(null);
  const [dragOverPosition, setDragOverPosition] = useState<"before" | "after">("before");
  // 列表行拖拽状态
  const [listDragOverIdx, setListDragOverIdx] = useState<number | null>(null);
  const handleAgentSearchChange = (query: string) => {
    setAgentSearchQuery(query);
    setDraggedAgentId(null);
    setDragOverCategoryId(null);
    setDragOverAgentId(null);
    setListDragOverIdx(null);
  };
  // 操作密码确认
  const [pendingAction, setPendingAction] = useState<((verification?: AdminUserDeleteVerification) => void | Promise<void>) | null>(null);
  const [actionPassword, setActionPassword] = useState("");
  const [actionPasswordError, setActionPasswordError] = useState("");
  const [showActionConfirm, setShowActionConfirm] = useState(false);
  const [actionConfirmTitle, setActionConfirmTitle] = useState("");
  const [actionConfirmPurpose, setActionConfirmPurpose] = useState<"generic" | "admin_user_delete">("generic");
  const [actionConfirmBusy, setActionConfirmBusy] = useState(false);

  // 需要密码确认的操作
  const confirmWithPassword = (
    title: string,
    action: (verification?: AdminUserDeleteVerification) => void | Promise<void>,
    purpose: "generic" | "admin_user_delete" = "generic",
  ) => {
    setActionConfirmTitle(title);
    setPendingAction(() => action);
    setActionConfirmPurpose(purpose);
    setActionPassword("");
    setActionPasswordError("");
    setShowActionConfirm(true);
  };

  const executeConfirmedAction = async () => {
    if (actionConfirmBusy) return;
    if (!actionPassword) { setActionPasswordError("请输入密码"); return; }
    setActionConfirmBusy(true);
    try {
      const res = await fetch("/api/auth/verify-password", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          password: actionPassword,
          purpose: actionConfirmPurpose === "admin_user_delete" ? "admin_user_delete" : undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) { setActionPasswordError(data.error || "密码错误"); return; }
      let deletionVerification: AdminUserDeleteVerification | undefined;
      if (actionConfirmPurpose === "admin_user_delete") {
        const candidate = data.deletionVerification;
        if (
          !candidate
          || typeof candidate.token !== "string"
          || !candidate.token
          || !Number.isFinite(Number(candidate.expiresAt))
        ) {
          setActionPasswordError("删除验证凭证生成失败，请重试");
          return;
        }
        deletionVerification = {
          token: candidate.token,
          expiresAt: Number(candidate.expiresAt),
        };
        adminUserDeleteVerificationRef.current = deletionVerification;
      }
      setShowActionConfirm(false);
      setActionPassword("");
      await pendingAction?.(deletionVerification);
      setPendingAction(null);
      setActionConfirmPurpose("generic");
    } catch {
      setActionPasswordError("验证失败，请重试");
    } finally {
      setActionConfirmBusy(false);
    }
  };
  const [importCodingCategory, setImportCodingCategory] = useState("其他");
  const [importCodingLoading, setImportCodingLoading] = useState(false);
  const [importCodingResult, setImportCodingResult] = useState<{ imported: number; skipped: number; failed: number; details?: { imported: Array<{ name: string; project_id: string }>; skipped: Array<{ name: string; reason: string }>; failed: Array<{ name: string; reason: string }> } } | null>(null);
  const [importCodingParsed, setImportCodingParsed] = useState<Array<{ name: string; api_url: string; project_id: string; api_token: string; valid: boolean; error?: string }>>([]);
  const [migrateToCategory, setMigrateToCategory] = useState("");
  const [importCozeLoading, setImportCozeLoading] = useState(false);
  const [importCozeResult, setImportCozeResult] = useState<{ imported: number; updated: number; skipped: number; failed: number; total: number; details: Array<{ name: string; status: string; error?: string }> } | null>(null);
  const [showImportCozeDialog, setShowImportCozeDialog] = useState(false);

  // 一键检测
  const [healthChecking, setHealthChecking] = useState(false);
  const [healthResults, setHealthResults] = useState<Array<{
    agentId: string; agentName: string; source: string;
    status: 'healthy' | 'unhealthy' | 'timeout' | 'error';
    responseTime: number; reply: string; error: string;
  }> | null>(null);

  // ── 批量头像生成 ──
  const [batchAvatarStyle, setBatchAvatarStyle] = useState("主站3D卡通");
  const [batchAvatarCustomPrompt, setBatchAvatarCustomPrompt] = useState("");
  const [batchAvatarLoading, setBatchAvatarLoading] = useState(false);
  const [batchAvatarProgress, setBatchAvatarProgress] = useState<{ current: number; total: number } | null>(null);
  const [batchAvatarResults, setBatchAvatarResults] = useState<Array<{
    id: string; name: string; avatarUrl: string; success: boolean; saved?: boolean; error?: string;
  }> | null>(null);

  const AVATAR_STYLES = ["主站3D卡通", "3D风", "卡通风", "科技风", "简约风", "渐变风", "国风"];

  const handleBatchAvatar = async () => {
    const eligibleAgents = agents.filter((agent) => agent.is_active !== false && !agent.avatar);
    if (eligibleAgents.length === 0) {
      showMessage("success", "当前没有需要生成头像的活跃智能体");
      return;
    }
    const selectedAgents = eligibleAgents.slice(0, 20);
    const agentIds = selectedAgents.map((agent) => agent.id);
    const promptHint = batchAvatarCustomPrompt ? `（自定义描述：${batchAvatarCustomPrompt}）` : "";
    const remainingHint = eligibleAgents.length > selectedAgents.length
      ? `\n受单批安全上限限制，本次只处理前 ${selectedAgents.length} 个，其余 ${eligibleAgents.length - selectedAgents.length} 个需下一批处理。`
      : "";
    if (!confirm(`本次将为 ${selectedAgents.length} 个无头像的活跃智能体调用生图模型，可能产生费用。\n风格：${batchAvatarStyle}${promptHint}${remainingHint}\n确认按此明确范围执行吗？`)) return;
    setBatchAvatarLoading(true);
    setBatchAvatarResults([]);
    setBatchAvatarProgress(null);
    try {
      const idempotencyKey = `avatar-batch:${window.crypto.randomUUID()}`;
      const res = await fetch("/api/admin/agents/batch-avatar", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify({
          agentIds,
          style: batchAvatarStyle,
          customPrompt: batchAvatarCustomPrompt || undefined,
          confirmPaidGeneration: true,
          confirmedAgentCount: agentIds.length,
        }),
      });
      const contentType = res.headers.get("content-type") || "";

      // SSE 流式响应
      if (contentType.includes("text/event-stream")) {
        const reader = res.body?.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        if (!reader) { setBatchAvatarLoading(false); return; }

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            try {
              const event = JSON.parse(line.slice(6));
              if (event.type === "start") {
                setBatchAvatarProgress({ current: 0, total: event.total });
              } else if (event.type === "progress") {
                setBatchAvatarProgress(prev => ({ current: (prev?.current || 0) + 1, total: event.total }));
                setBatchAvatarResults(prev => [...(prev || []), {
                  id: event.agentId, name: event.name,
                  avatarUrl: event.avatarUrl || "", success: event.success,
                  saved: event.saved, error: event.error,
                }]);
              } else if (event.type === "done") {
                showMessage("success", event.message);
                loadAgents();
              }
            } catch { /* ignore parse errors */ }
          }
        }
      } else {
        // 降级：普通 JSON 响应（singleAgent 模式）
        const data = await res.json();
        if (data.success) {
          showMessage("success", data.message);
          setBatchAvatarResults(data.results);
          loadAgents();
        } else {
          showMessage("error", data.error || "生成失败");
        }
      }
    } catch {
      showMessage("error", "批量头像生成请求失败，已生成的头像已保存到数据库，不会丢失");
      loadAgents(); // 刷新列表，展示已保存的结果
    } finally {
      setBatchAvatarLoading(false);
      setBatchAvatarProgress(null);
    }
  };

  const handleHealthCheck = async () => {
    setHealthChecking(true);
    setHealthResults(null);
    try {
      const res = await fetch('/api/admin/agents/health-check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${safeLocalStorageGet(STORAGE_KEYS.AUTH_TOKEN) || ''}` },
      });
      const data = await res.json();
      setHealthResults(data.results || []);
    } catch (err) {
      console.error('Health check failed:', err);
    } finally {
      setHealthChecking(false);
    }
  };

  // ── 使用诊断数据加载 ──
  const loadDiagLogs = useCallback(async (page = 1, signal?: AbortSignal) => {
    setDiagLoading(true);
    setDiagError("");
    try {
      const params = new URLSearchParams({ page: String(page), pageSize: "20" });
      if (diagFilterType) params.set("problemType", diagFilterType);
      if (diagFilterSeverity) params.set("severity", diagFilterSeverity);
      if (diagFilterStatus) params.set("status", diagFilterStatus);
      const res = await fetch(`/api/admin/diagnostic-logs?${params}`, { headers: authHeaders, signal });
      const data = await res.json();
      if (!res.ok || !Array.isArray(data.data)) throw new Error(data.error || "诊断记录读取失败");
      if (data.data) {
        setDiagLogs(data.data);
        setDiagTotal(data.total);
        setDiagPage(page);
        setDiagSummary(data.summary);
      }
    } catch (e) {
      if (!signal?.aborted && (!(e instanceof DOMException) || e.name !== "AbortError")) {
        console.error("[diagnostic] 加载失败:", e);
        setDiagError(e instanceof Error ? e.message : "诊断记录读取失败，请稍后刷新");
      }
    } finally {
      if (!signal?.aborted) setDiagLoading(false);
    }
  }, [diagFilterType, diagFilterSeverity, diagFilterStatus, token]);

  const loadDiagDetail = useCallback(async (id: string) => {
    try {
      const res = await fetch(`/api/admin/diagnostic-logs/${id}`, { headers: authHeaders });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "诊断详情读取失败");
      setDiagDetail(data);
      setDiagDetailId(id);
    } catch (e) {
      console.error("[diagnostic] 详情加载失败:", e);
      setDiagError(e instanceof Error ? e.message : "诊断详情读取失败");
    }
  }, [token]);

  const updateDiagStatus = useCallback(async (id: string, status: string, notes?: string) => {
    if (diagUpdatingId) return;
    setDiagUpdatingId(id);
    setDiagError("");
    try {
      const body: Record<string, string> = { status };
      if (notes !== undefined) body.admin_notes = notes;
      const response = await fetch(`/api/admin/diagnostic-logs/${id}`, {
        method: "PUT",
        headers: { ...authHeaders, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || "诊断状态保存失败");
      await loadDiagLogs(diagPage);
      if (diagDetailId === id) {
        await loadDiagDetail(id);
      }
    } catch (e) {
      console.error("[diagnostic] 更新状态失败:", e);
      setDiagError(e instanceof Error ? e.message : "诊断状态保存失败，请稍后重试");
    } finally {
      setDiagUpdatingId(null);
    }
  }, [diagPage, diagDetailId, diagUpdatingId, loadDiagLogs, loadDiagDetail, token]);

  const downloadDiagLog = useCallback((log: any) => {
    const blob = new Blob([JSON.stringify(log, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `diagnostic-${log.id}-${new Date(log.created_at).toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, []);

  const handleDownloadDiagLog = useCallback(async (id: string) => {
    setDiagError("");
    try {
      const response = await fetch(`/api/admin/diagnostic-logs/${id}`, { headers: { Authorization: `Bearer ${token || ""}` } });
      const data = await response.json();
      if (!response.ok) throw new Error(data?.error || "诊断日志下载失败");
      if (!data || typeof data !== "object" || Array.isArray(data) || data.id !== id) throw new Error("诊断日志格式不完整，请刷新后重试");
      downloadDiagLog(data);
    } catch (error) {
      setDiagError(error instanceof Error ? error.message : "诊断日志下载失败，请稍后重试");
    }
  }, [downloadDiagLog, token]);

  const deleteDiagLogs = useCallback(async (days: number) => {
    if (!confirm(`确定清理 ${days} 天前的诊断日志？`)) return;
    try {
      await fetch("/api/admin/diagnostic-logs", {
        method: "DELETE",
        headers: { ...authHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ days }),
      });
      loadDiagLogs(1);
    } catch (e) {
      console.error("[diagnostic] 清理失败:", e);
    }
  }, [loadDiagLogs]);

  const handleImportCoze = async () => {
    setImportCozeLoading(true);
    setImportCozeResult(null);
    try {
      const res = await fetch("/api/admin/agents/import-coze", {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({ overwrite: false }),
      });
      const data = await res.json();
      if (data.success) {
        setImportCozeResult(data);
        setShowImportCozeDialog(true);
        loadAgents();
        loadCategories();
        showSuccessAndSync(`导入完成：新增 ${data.imported} 个，更新 ${data.updated} 个，跳过 ${data.skipped} 个`);
      } else {
        showMessage("error", data.error || "导入失败");
      }
    } catch (err) {
      showMessage("error", "导入请求失败");
    } finally {
      setImportCozeLoading(false);
    }
  };

  const loadAdminAccess = useCallback(async (): Promise<AdminAccessClientState | null> => {
    if (!token) return null;
    try {
      const response = await fetch("/api/admin/access-control/self", {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        setAdminAccess(null);
        setMessage({
          type: "error",
          text: payload.error || "后台权限档案校验失败，所有受保护功能保持锁定",
        });
        return null;
      }
      setAdminAccess(payload as AdminAccessClientState);
      return payload as AdminAccessClientState;
    } catch {
      setAdminAccess(null);
      setMessage({ type: "error", text: "后台权限服务暂不可用，所有受保护功能保持锁定" });
      return null;
    }
  }, [token]);

  const checkAuth = useCallback(async () => {
    const redirectToLogin = () => {
      const destination = typeof window === "undefined" ? "/admin" : `${window.location.pathname}${window.location.search}`;
      router.push(`${ADMIN_LOGIN_PATH}?redirect=${encodeURIComponent(destination)}`);
    };
    if (!token) { redirectToLogin(); return; }
    try {
      const res = await fetch("/api/auth/me", { headers: authHeaders });
      const data = await res.json().catch(() => ({}));
      if (res.status === 401 || res.status === 403) {
        redirectToLogin();
        return;
      }
      if (!res.ok) {
        setMessage({ type: "error", text: data.error || "后台身份校验暂时失败，请稍后刷新重试" });
        return;
      }
      const user = data.user || data;
      if (!user || user.role !== "admin") { redirectToLogin(); return; }
      setUserInfo(user);
      await loadAdminAccess();
    } catch {
      setMessage({ type: "error", text: "后台身份校验网络异常，请检查连接后刷新重试" });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadAdminAccess, router, token]);

  const loadUsers = useCallback(async (): Promise<boolean> => {
    const requestSequence = ++usersRequestSequenceRef.current;
    try {
      // 会员名单始终读取完整目录。单用户编辑只保存在弹窗状态中，不能把 user_id/search
      // 带回此请求，否则关闭弹窗后“全部会员”会被一次单用户响应污染。
      const res = await fetch("/api/admin/users?page_size=500", {
        headers: authHeaders,
        cache: "no-store",
      });
      if (!res.ok) return false;
      const data = await res.json();
      if (requestSequence !== usersRequestSequenceRef.current) return false;
      setUsers(Array.isArray(data.users) ? data.users : []);
      return true;
    } catch {
      return false;
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── 聊天消息加载（查看单个会话） ──
  const fetchChatMessages = useCallback(async (conversationId: string, agentName: string, userName?: string) => {
    setChatLoading(true);
    setChatDialogTitle(userName ? `${userName} ↔ ${agentName}` : agentName);
    setShowChatDialog(true);
    try {
      const res = await fetch(`/api/admin/user-chats?conversation_id=${conversationId}&messages=true`, {
        headers: authHeaders,
      });
      if (res.ok) {
        const data = await res.json();
        setChatMessages(data.messages || []);
      }
    } catch (err) {
      console.error("聊天消息加载失败:", err);
    } finally {
      setChatLoading(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  // ── 聊天记录列表加载（全局视图） ──
  const fetchChatList = useCallback(async (pageNum?: number, searchOverride?: string) => {
    setChatListLoading(true);
    try {
      const params = new URLSearchParams({
        page: String(pageNum || chatListPage),
        pageSize: "20",
      });
      const searchVal = searchOverride !== undefined ? searchOverride : chatListSearch;
      if (searchVal) params.set("user_name", searchVal);
      const res = await fetch(`/api/admin/user-chats?${params}`, {
        headers: authHeaders,
      });
      if (res.ok) {
        const data = await res.json();
        setUserConversations(data.conversations || []);
        setChatListTotal(data.total || 0);
        setAgentUsageStats(data.agentUsage || []);
      }
    } catch (err) {
      console.error("聊天记录加载失败:", err);
    } finally {
      setChatListLoading(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, chatListPage, chatListSearch]);

  const loadAgents = useCallback(async () => {
    const query = new URLSearchParams();
    if (canViewInternalTools) query.set("include_internal", "1");
    if (canManageAgentConfiguration) query.set("include_configuration", "1");
    if (canReadPrompts) query.set("include_prompt", "1");
    const queryString = query.toString();
    const requestsSensitiveData = canViewInternalTools || canManageAgentConfiguration || canReadPrompts;
    const requestSequence = ++agentsRequestSequenceRef.current;
    agentsAbortControllerRef.current?.abort();
    const controller = new AbortController();
    agentsAbortControllerRef.current = controller;
    try {
      const res = await fetch(`/api/admin/agents${queryString ? `?${queryString}` : ""}`, {
        headers: authHeaders,
        signal: controller.signal,
      });
      if (res.ok) {
        const data = await res.json();
        if (controller.signal.aborted
          || requestSequence !== agentsRequestSequenceRef.current
          || (requestsSensitiveData && !sensitiveUnlockedRef.current)) return;
        setAgents((data.agents || []).map((agent: AgentInfo) => ({
          ...agent,
          system_prompt: agent.prompt_access === "visible" ? (agent.system_prompt || "") : undefined,
        })));
        setAgentDataSource(data.configurationAccess === "visible" ? (data.dataSource || null) : null);
        return true;
      }
      return false;
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")) console.error("智能体列表加载失败:", error);
      return false;
    } finally {
      if (requestSequence === agentsRequestSequenceRef.current) agentsAbortControllerRef.current = null;
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canManageAgentConfiguration, canReadPrompts, canViewInternalTools, token]);

  const loadTrashedAgents = useCallback(async () => {
    const query = new URLSearchParams({ trash: "1" });
    if (canViewInternalTools) query.set("include_internal", "1");
    const requestSequence = ++trashedAgentsRequestSequenceRef.current;
    trashedAgentsAbortControllerRef.current?.abort();
    const controller = new AbortController();
    trashedAgentsAbortControllerRef.current = controller;
    try {
      const res = await fetch(`/api/admin/agents?${query}`, { headers: authHeaders, signal: controller.signal });
      if (res.ok) {
        const data = await res.json();
        if (controller.signal.aborted
          || requestSequence !== trashedAgentsRequestSequenceRef.current
          || (canViewInternalTools && !sensitiveUnlockedRef.current)) return;
        const nextAgents = (data.agents || []) as AgentInfo[];
        setTrashedAgents(sensitiveUnlockedRef.current
          ? nextAgents
          : nextAgents.map(stripAgentSensitiveClientFields));
      }
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")) console.error("回收站智能体加载失败:", error);
    } finally {
      if (requestSequence === trashedAgentsRequestSequenceRef.current) trashedAgentsAbortControllerRef.current = null;
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canViewInternalTools]);

  const handleRestoreAgent = async (agent: AgentInfo) => {
    try {
      const res = await fetch("/api/admin/agents/restore", { method: "POST", headers: { ...authHeaders, "Content-Type": "application/json" }, body: JSON.stringify(buildAgentMutationPayload(agent, {})) });
      const data = await res.json();
      if (res.ok) { showSuccessAndSync("已恢复"); loadAgents(); loadTrashedAgents(); }
      else if (res.status === 409) { showMessage("error", "该智能体已在另一端更新，请刷新回收站后重试。"); loadTrashedAgents(); }
      else showMessage("error", data.error || "恢复失败");
    } catch { showMessage("error", "缺少有效配置版本，请刷新回收站后重试。"); loadTrashedAgents(); }
  };

  const handlePermanentDelete = (agent: AgentInfo) => {
    confirmWithPassword("永久删除智能体（此操作无法恢复）", async () => {
      try {
        const revision = Number(agent.config_revision);
        if (!Number.isSafeInteger(revision) || revision < 1) throw new Error("AGENT_EXPECTED_REVISION_REQUIRED");
        const res = await fetch(`/api/admin/agents?id=${encodeURIComponent(agent.id)}&permanent=1&expected_revision=${revision}`, { method: "DELETE", headers: authHeaders });
        if (res.ok) { showSuccessAndSync("已永久删除"); loadTrashedAgents(); }
        else { const data = await res.json(); showMessage("error", res.status === 409 ? "该智能体已在另一端更新，请刷新回收站后重试。" : (data.error || "永久删除失败")); if (res.status === 409) loadTrashedAgents(); }
      } catch { showMessage("error", "缺少有效配置版本，请刷新回收站后重试。"); loadTrashedAgents(); }
    });
  };

  const loadCategories = useCallback(async () => {
    try {
      const query = canViewInternalTools ? "?include_internal=1" : "";
      const res = await fetch(`/api/admin/categories${query}`, { headers: authHeaders });
      if (res.ok) {
        const data = await res.json();
        const cats = data.categories || [];
        // Enrich with agent counts
        const agentCounts: Record<string, number> = {};
        for (const a of agents) {
          agentCounts[a.category] = (agentCounts[a.category] || 0) + 1;
        }
        const hydratedCategories: AdminAgentCategory[] = cats.map((c: AdminAgentCategory) => ({
          ...c,
          agent_count: agentCounts[c.name] || 0,
        }));
        setCategories(hydratedCategories);
      }
    } catch {/* */}
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authHeaders, canViewInternalTools]);

  // 加载 LLM 模型预设列表
  const loadLlmModels = useCallback(async () => {
    try {
      const res = await fetch("/api/llm-models?admin=1", { headers: authHeaders });
      if (res.ok) {
        const data = await res.json();
        setLlmModels(data.models || []);
      }
    } catch {/* */}
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authHeaders]);

  const loadDrawingModels = useCallback(async () => {
    try {
      const res = await fetch("/api/cover-models", { headers: authHeaders });
      if (res.ok) {
        const data = await res.json();
        setDrawingModels(data.models || []);
      }
    } catch {/* */}
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authHeaders]);

  // Sync agent counts when agents change
  useEffect(() => {
    setCategories((prev) => {
      if (prev.length === 0) return prev;
      const agentCounts: Record<string, number> = {};
      for (const a of agents) {
        agentCounts[a.category] = (agentCounts[a.category] || 0) + 1;
      }
      return prev.map((c) => ({ ...c, agent_count: agentCounts[c.name] || 0 }));
    });
  }, [agents]);

  // Fetch Coze bots for batch import
  const handleFetchCozeBots = async () => {
    setImportLoading(true);
    setImportResult(null);
    try {
      const res = await fetch("/api/admin/agents/import", { headers: authHeaders });
      if (res.ok) {
        const data = await res.json();
        setCozeBots((data.bots || []).map((b: { bot_id: string; bot_name: string; description: string; icon_url: string; already_imported: boolean }) => ({
          ...b,
          selected: !b.already_imported,
          category: "其他",
        })));
        setShowImportCoze(true);
      } else {
        const data = await res.json();
        alert(data.error || "获取智能体列表失败，请先在平台设置中配置连接");
      }
    } catch {
      alert("网络错误，无法连接到智能体平台");
    } finally {
      setImportLoading(false);
    }
  };

  // Batch import selected Coze bots
  const handleImportCozeBots = async () => {
    const selectedBots = cozeBots.filter((b) => b.selected && !b.already_imported);
    if (selectedBots.length === 0) {
      alert("请选择要导入的智能体");
      return;
    }
    setImportLoading(true);
    try {
      const res = await fetch("/api/admin/agents/import", {
        method: "POST",
        headers: { ...authHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({
          bots: selectedBots.map((b) => ({
            bot_id: b.bot_id,
            name: b.bot_name,
            description: b.description,
            icon_url: b.icon_url,
            category: b.category,
          })),
        }),
      });
      if (res.ok) {
        const data = await res.json();
        setImportResult({ imported: data.imported, skipped: data.skipped });
        loadAgents();
      } else {
        const data = await res.json();
        alert(data.error || "导入失败");
      }
    } catch {
      alert("网络错误");
    } finally {
      setImportLoading(false);
    }
  };

  // Toggle bot selection
  const toggleBotSelection = (botId: string) => {
    setCozeBots((prev) =>
      prev.map((b) => (b.bot_id === botId ? { ...b, selected: !b.selected } : b))
    );
  };

  // Set category for a bot
  const setBotCategory = (botId: string, category: string) => {
    setCozeBots((prev) =>
      prev.map((b) => (b.bot_id === botId ? { ...b, category } : b))
    );
  };

  // Select/deselect all
  const toggleSelectAll = () => {
    const allSelected = cozeBots.filter((b) => !b.already_imported).every((b) => b.selected);
    setCozeBots((prev) =>
      prev.map((b) => (b.already_imported ? b : { ...b, selected: !allSelected }))
    );
  };

  const loadSettings = useCallback(async () => {
    try {
      // 品牌外观本身是前台公开启动配置；只有拥有品牌权限的管理员页面才加载它。
      if (grantedPermissionKeys.has("brand.settings.manage")) {
        setPushedPlatformTheme(null);
        setPushedPlatformThemeMode(null);
        const response = await fetch("/api/settings/appearance", { headers: authHeaders, cache: "no-store" });
        if (response.ok) {
          const data = await response.json();
          if (data.authority?.authoritative === true) {
            setPushedPlatformTheme(normalizeTheme(data.settings?.theme || DEFAULT_THEME));
            setPushedPlatformThemeMode(
              normalizeThemeModePreference(data.settings?.theme_mode) || DEFAULT_MODE_PREFERENCE,
            );
          } else {
            setPushedPlatformTheme(null);
            setPushedPlatformThemeMode(null);
          }
        }
      }

      // 内部设置严格按授权 scope 分开读取。未授权或已过期时不发请求，
      // 且并发中的旧请求不得在重新锁定后把敏感快照写回浏览器状态。
      if (!sensitiveUnlocked || !sensitiveUnlockedRef.current || readableSettingScopes.length === 0) return;
      const responses = await Promise.all(readableSettingScopes.map(async (scope) => {
        const response = await fetch(`/api/settings/admin?scope=${scope}`, {
          headers: authHeaders,
          cache: "no-store",
        });
        if (!response.ok) return null;
        const data = await response.json();
        return data.settings && typeof data.settings === "object" ? data.settings as Partial<PlatformSettings> : null;
      }));
      if (!sensitiveUnlockedRef.current) return;
      const scopedSettings = Object.assign({}, ...responses.filter(Boolean));
      setSettings((prev) => {
        const theme = normalizeTheme(scopedSettings.theme || prev.theme);
        const nextSettings = {
          ...prev,
          ...scopedSettings,
          theme,
          theme_mode: normalizePlatformThemeMode(theme, scopedSettings.theme_mode || prev.theme_mode),
        };
        if (grantedPermissionKeys.has("brand.settings.manage")) applyThemeColorSettings(nextSettings);
        return nextSettings;
      });
      setSettingsBaseline((prev) => {
        const theme = normalizeTheme(scopedSettings.theme || prev.theme);
        return {
          ...prev,
          ...scopedSettings,
          theme,
          theme_mode: normalizePlatformThemeMode(theme, scopedSettings.theme_mode || prev.theme_mode),
        };
      });
    } catch {/* */}
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sensitiveUnlocked, token, readableSettingScopes]);

  const loadOpPasswordStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/settings/operation-password", { headers: authHeaders });
      if (res.ok) {
        const data = await res.json();
        setOpPasswordSet(data.isSet);
      }
    } catch {/* */}
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleOpPasswordAction = async () => {
    const requestSequence = ++opPasswordRequestSequenceRef.current;
    opPasswordAbortControllerRef.current?.abort();
    opPasswordAbortControllerRef.current = null;
    setOpPasswordError("");
    setOpPasswordSuccess("");
    setOpPasswordLoading(true);
    try {
      const body: Record<string, string> = { action: opPasswordAction };
      if (opPasswordAction === "generate") {
        // no extra fields
      } else if (opPasswordAction === "set") {
        if (!opPasswordNew || opPasswordNew.length < 8) {
          setOpPasswordError("密码长度不能少于8位");
          setOpPasswordLoading(false);
          return;
        }
        body.newPassword = opPasswordNew;
      } else if (opPasswordAction === "change") {
        if (!opPasswordOld) { setOpPasswordError("请输入旧密码"); setOpPasswordLoading(false); return; }
        if (!opPasswordNew || opPasswordNew.length < 8) { setOpPasswordError("新密码长度不能少于8位"); setOpPasswordLoading(false); return; }
        body.password = opPasswordOld;
        body.newPassword = opPasswordNew;
      } else if (opPasswordAction === "remove") {
        if (!opPasswordOld) { setOpPasswordError("请输入操作密码"); setOpPasswordLoading(false); return; }
        body.password = opPasswordOld;
      }

      const controller = new AbortController();
      opPasswordAbortControllerRef.current = controller;
      const res = await fetch("/api/settings/operation-password", {
        method: "POST",
        headers: { ...authHeaders, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const data = await res.json();
      if (controller.signal.aborted
        || requestSequence !== opPasswordRequestSequenceRef.current
        || !sensitiveUnlockedRef.current) return;
      if (!res.ok) {
        setOpPasswordError(data.error || "操作失败");
        return;
      }

      if (opPasswordAction === "generate" && data.password) {
        setGeneratedPassword(data.password);
        setOpPasswordSet(true);
        setOpPasswordSuccess("操作密码已生成，请立即复制保存！此密码仅显示一次。");
      } else if (opPasswordAction === "remove") {
        setOpPasswordSet(false);
        setOpPasswordSuccess("操作密码已移除，将使用管理员登录密码验证");
        setOpPasswordOld("");
        setOpPasswordNew("");
      } else {
        setOpPasswordSet(true);
        setOpPasswordSuccess("操作密码设置成功");
        setOpPasswordOld("");
        setOpPasswordNew("");
      }
      loadOpPasswordStatus();
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")) {
        setOpPasswordError("操作失败，请重试");
      }
    } finally {
      if (requestSequence === opPasswordRequestSequenceRef.current) {
        opPasswordAbortControllerRef.current = null;
        setOpPasswordLoading(false);
      }
    }
  };

  const loadHealthData = useCallback(async () => {
    setHealthLoading(true);
    setHealthActionError("");
    try {
      const res = await fetch("/api/health", { headers: authHeaders });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "健康状态读取失败");
      setHealthData(data);
    } catch (error) {
      setHealthActionError(error instanceof Error ? error.message : "健康状态读取失败");
    }
    setHealthLoading(false);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  const loadSystemLogs = useCallback(async () => {
    try {
      const res = await fetch("/api/health?logs=true&limit=50", { headers: authHeaders });
      if (res.ok) { const data = await res.json(); setSystemLogs(data.logs || []); }
    } catch { /* ignore */ }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  const loadVideoModels = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/video-models", { headers: authHeaders });
      if (res.ok) { const data = await res.json(); setVideoModelsList(data.models || []); setVideoModelsDraft(data.models || []); setVideoModelsChanged(false); }
      // 同时加载通道健康状态
      const healthRes = await fetch("/api/video/channel-health", { headers: authHeaders });
      if (healthRes.ok) {
        const healthData = await healthRes.json();
        const healthMap: Record<string, Record<string, unknown>> = {};
        for (const h of (healthData.channels || [])) {
          healthMap[h.channel_id as string] = h;
        }
        setChannelHealth(healthMap);
      }
    } catch { /* ignore */ }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  const testVideoModel = useCallback(async (modelId: string) => {
    setTestingModelId(modelId);
    try {
      const res = await fetch("/api/admin/video-test", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders },
        body: JSON.stringify({ modelId }),
      });
      const data = await res.json();
      if (data.success) {
        let msg = `✅ 测试通过！${data.message}`;
        if (data.latency) msg += `\n延迟：${data.latency}ms`;
        if (data.details) msg += `\n详情：${data.details}`;
        alert(msg);
      } else {
        let msg = `❌ 测试失败：${data.message}`;
        if (data.details) msg += `\n详情：${data.details}`;
        if (data.latency) msg += `\n延迟：${data.latency}ms`;
        alert(msg);
      }
      loadVideoModels();
    } catch { alert("测试请求失败"); }
    setTestingModelId(null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, loadVideoModels]);

  const deleteVideoModel = useCallback((modelId: string) => {
    if (!confirm("确定删除此模型？删除后点击「保存更改」才会生效。")) return;
    setVideoModelsDraft(prev => prev.filter(m => m.id !== modelId));
    setVideoModelsChanged(true);
  }, []);

  // 保存所有视频模型变更到数据库
  const saveVideoModelsChanges = useCallback(async () => {
    // 检查计费变更
    const upsertModels = videoModelsDraft.filter(d => {
      const orig = videoModelsList.find(m => m.id === d.id);
      if (!orig) return true;
      return JSON.stringify(orig) !== JSON.stringify(d);
    });
    const billingChanged: string[] = [];
    for (const model of upsertModels) {
      const orig = videoModelsList.find(m => m.id === model.id);
      if (orig) {
        const billingFields = ["cost_price", "selling_price", "price_per_use"];
        for (const key of billingFields) {
          const oldVal = (orig as Record<string, unknown>)[key];
          const newVal = model[key];
          if (newVal != null && oldVal != null && Number(newVal) !== Number(oldVal)) {
            const label = key === "price_per_use" ? "单次售价" : key === "cost_price" ? "进货价" : "售价";
            billingChanged.push(`${model.name || model.id}: ${label} ${oldVal} → ${newVal}`);
          }
        }
      }
    }
    if (billingChanged.length > 0) {
      const confirmed = confirm(
        `⚠️ 视频模型计费规则变更确认\n\n` +
        `以下模型的计费字段发生变更：\n\n` +
        billingChanged.map(d => `• ${d}`).join("\n") +
        `\n\n变更后新生成的视频将按新价格计费。\n确定保存？`
      );
      if (!confirmed) return;
    }

    setVideoModelsSaving(true);
    try {
      // 找出被删除的模型（在原列表中但不在draft中）
      const deletedIds = videoModelsList.filter(m => !videoModelsDraft.find(d => d.id === m.id)).map(m => m.id as string);
      // 找出新增或修改的模型（在draft中）
      const upsertModels = videoModelsDraft.filter(d => {
        const orig = videoModelsList.find(m => m.id === d.id);
        if (!orig) return true; // 新增
        return JSON.stringify(orig) !== JSON.stringify(d); // 有变更
      });

      let errorMsg = "";
      // 删除模型
      for (const id of deletedIds) {
        const res = await fetch(`/api/admin/video-models?id=${id}`, { method: "DELETE", headers: authHeaders });
        if (!res.ok) { const data = await res.json().catch(() => ({})); errorMsg += `删除${id}失败: ${data.error || "未知错误"}\n`; }
      }
      // 更新模型
      for (const model of upsertModels) {
        const isNew = !videoModelsList.find(m => m.id === model.id);
        const res = await fetch("/api/admin/video-models", {
          method: isNew ? "POST" : "PUT",
          headers: { "Content-Type": "application/json", ...authHeaders },
          body: JSON.stringify(model),
        });
        if (!res.ok) { const data = await res.json().catch(() => ({})); errorMsg += `保存${model.name || model.id}失败: ${data.error || "未知错误"}\n`; }
      }

      if (errorMsg) { alert("部分操作失败:\n" + errorMsg); }
      loadVideoModels(); // 刷新列表
    } catch { alert("保存失败，请重试"); }
    setVideoModelsSaving(false);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, videoModelsList, videoModelsDraft, loadVideoModels]);

  // 重置为已保存的状态
  const resetVideoModelsChanges = useCallback(() => {
    setVideoModelsDraft(videoModelsList);
    setVideoModelsChanged(false);
  }, [videoModelsList]);

  const saveVideoModel = useCallback(async (model: Record<string, unknown>) => {
    const isEdit = !!model.id && videoModelsDraft.find(m => m.id === model.id);
    try {
      if (isEdit) {
        // 编辑：直接调用后端PUT
        const res = await fetch("/api/admin/video-models", {
          method: "PUT",
          headers: { "Content-Type": "application/json", ...authHeaders },
          body: JSON.stringify(model),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          alert(`保存失败: ${data.error || "未知错误"}`);
          return;
        }
        // 同步更新draft
        setVideoModelsDraft(prev => prev.map(m => m.id === model.id ? { ...m, ...model } : m));
      } else {
        // 新增：直接调用后端POST
        const res = await fetch("/api/admin/video-models", {
          method: "POST",
          headers: { "Content-Type": "application/json", ...authHeaders },
          body: JSON.stringify(model),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          alert(`添加失败: ${data.error || "未知错误"}`);
          return;
        }
        const saved = await res.json();
        const newId = saved?.model?.id || model.id || `temp-${Date.now()}`;
        setVideoModelsDraft(prev => [...prev, { ...model, id: newId, is_active: true, is_hidden: false }]);
      }
      loadVideoModels(); // 刷新列表
    } catch (e) {
      alert("保存失败，请重试");
    }
    setShowVideoModelDialog(false);
    setEditingVideoModel(null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, videoModelsDraft, loadVideoModels]);



  useEffect(() => { checkAuth().then(() => setLoading(false)); }, []);

  // 阻止Backspace后退导航（管理后台有大量输入框，Backspace容易触发浏览器后退）
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Backspace") {
        const tag = (e.target as HTMLElement)?.tagName;
        if (tag !== "INPUT" && tag !== "TEXTAREA" && !(e.target as HTMLElement)?.isContentEditable) {
          e.preventDefault();
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  useEffect(() => {
    if (!userInfo || !adminAccess) return;
    const permissions = new Set(adminAccess.access.permissionKeys);
    if (permissions.has("members.view")) void loadUsers();
    if (permissions.has("agents.view")) {
      void loadAgents();
      void loadCategories();
    }
    if (permissions.has("agents.manage")) void loadTrashedAgents();
    if (canManageAgentConfiguration) {
      void loadLlmModels();
      void loadDrawingModels();
    }
    if (grantedPermissionKeys.has("brand.settings.manage") || (readableSettingScopes.length && sensitiveUnlocked)) {
      void loadSettings();
    }
    if (permissions.has("security.manage") && sensitiveUnlocked) void loadOpPasswordStatus();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userInfo, adminAccess, canManageAgentConfiguration, readableSettingScopes, sensitiveUnlocked]);

  // 健康概览和系统日志只在有权限的管理员实际进入系统监控页时读取。
  // 普通后台标签初始化不得在服务端触发健康检查或相关依赖读取。
  useEffect(() => {
    if (!userInfo || activeTab !== "health" || !adminAccess?.access.permissionKeys.includes("logs.view")) return;
    void loadHealthData();
    void loadSystemLogs();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, userInfo, adminAccess?.access.permissionKeys]);

  // 诊断日志只在系统监控页读取。离开页面时主动取消请求，避免路由切换把
  // 浏览器取消请求误报成后台故障，也减少普通后台入口的无关查询。
  useEffect(() => {
    if (!userInfo || activeTab !== "health" || !adminAccess?.access.permissionKeys.includes("logs.view")) return;
    const controller = new AbortController();
    void loadDiagLogs(1, controller.signal);
    return () => controller.abort();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, userInfo, adminAccess?.access.permissionKeys]);

  // 每10分钟自动刷新用户列表（同步余额等实时数据）
  useEffect(() => {
    if (!userInfo || !adminAccess?.access.permissionKeys.includes("members.view")) return;
    const interval = setInterval(() => { loadUsers(); }, 10 * 60 * 1000);
    return () => clearInterval(interval);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userInfo, adminAccess?.access.permissionKeys]);

  // 聊天记录子Tab激活时加载
  useEffect(() => {
    if (userSubTab === "chats" && userInfo && adminAccess?.access.permissionKeys.includes("member_content.view")) fetchChatList(chatListPage, chatListSearch);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userSubTab, userInfo, chatListPage, adminAccess?.access.permissionKeys]);

  useEffect(() => {
    if ((userSubTab === "recharge" || userSubTab === "consumption") && !canViewBilling) {
      setUserSubTab("members");
    }
    if (userSubTab === "chats" && !canViewMemberContent) {
      setUserSubTab("members");
    }
  }, [canViewBilling, canViewMemberContent, userSubTab]);

  const showMessage = (type: "success" | "error", text: string) => { setMessage({ type, text }); setTimeout(() => setMessage(null), 3000); };
  const showSuccessAndSync = (text: string) => { showMessage("success", text); };

  const sendMemberVerificationCode = async (payload: {
    purpose: "create" | "email_change" | "password_reset";
    userId?: string;
    email?: string;
  }) => {
    if (!hasMembersManagePermission) return;
    if (!sensitiveUnlocked) {
      setUnlockDialogRequested(true);
      return;
    }
    if (payload.email !== undefined && !isQqEmail(payload.email)) {
      showMessage("error", "请输入QQ邮箱（例如 123456789@qq.com）");
      return false;
    }
    setMemberVerificationSending(true);
    try {
      const res = await fetch("/api/admin/users/verification-code", {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({ ...payload, email: payload.email ? normalizeQqEmail(payload.email) : undefined }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        showMessage("error", data.error || "验证码发送失败");
        return false;
      }
      showMessage("success", data.message || "验证码已发送");
      return true;
    } catch {
      showMessage("error", "验证码发送失败，请检查网络后重试");
      return false;
    } finally {
      setMemberVerificationSending(false);
    }
  };

  const verifyAdminAccountRecovery = async (password: string) => {
    if (!canManageMembers) {
      if (hasMembersManagePermission) setUnlockDialogRequested(true);
      return null;
    }
    if (!password) {
      showMessage("error", "请输入管理员操作密码");
      return null;
    }
    try {
      const res = await fetch("/api/auth/verify-password", {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({ password, purpose: "admin_user_account_recovery" }),
      });
      const data = await res.json().catch(() => ({}));
      const token = data?.accountRecoveryVerification?.token;
      if (res.ok && typeof token === "string" && token) return token;
      showMessage("error", data.error || "管理员身份验证失败");
      return null;
    } catch {
      showMessage("error", "管理员身份验证失败，请检查网络后重试");
      return null;
    }
  };

  const handleAddUser = async () => {
    if (!canManageMembers) {
      if (hasMembersManagePermission) setUnlockDialogRequested(true);
      return;
    }
    const email = normalizeQqEmail(newUser.email);
    if (!isQqEmail(email)) {
      showMessage("error", "QQ邮箱为必填项，请填写数字QQ号@qq.com");
      return;
    }
    if (!newUser.emailVerificationCode.trim()) {
      showMessage("error", "请输入QQ邮箱收到的验证码");
      return;
    }
    const passwordError = adminPasswordError(newUser.password);
    if (passwordError) { showMessage("error", passwordError); return; }
    if (newUser.credits !== 0) {
      showMessage("error", "请先创建用户，再到积分充值入口加积分，确保流水可审计");
      return;
    }
    if (/e2e|example\.invalid|test[_-]?/iu.test(`${newUser.displayName} ${newUser.email}`)) {
      showMessage("error", "测试/E2E账号不能写入真实会员库，请使用隔离测试库");
      return;
    }
    try {
      const { allowedCategories, ...accountFields } = newUser;
      const permissionFields = canManageMemberPermissions ? { allowedCategories } : {};
      const res = await fetch("/api/admin/users", { method: "POST", headers: authHeaders, body: JSON.stringify({ ...accountFields, ...permissionFields, email, role: newUser.role || "student" }) });
      const data = await res.json();
      if (res.ok) { 
        showSuccessAndSync(`学员 ${newUser.displayName} 创建成功`); 
        setShowAddUser(false); setNewUser({ phone: "", email: "", emailVerificationCode: "", password: "", displayName: "", role: "student", credits: 0, allowedCategories: [] }); loadUsers();
      }
      else { showMessage("error", data.error || "创建失败"); }
    } catch { showMessage("error", "网络错误"); }
  };

  const deleteUserWithVerification = async (
    userId: string,
    name: string,
    verification: AdminUserDeleteVerification,
  ) => {
    if (deletingUserIds.includes(userId)) return;
    setDeletingUserIds((current) => current.includes(userId) ? current : [...current, userId]);
    try {
      const res = await fetch(`/api/admin/users?id=${encodeURIComponent(userId)}`, {
        method: "DELETE",
        headers: {
          ...authHeaders,
          "x-admin-user-delete-reauth": verification.token,
        },
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (data.code === "ADMIN_USER_DELETE_REAUTH_REQUIRED") {
          adminUserDeleteVerificationRef.current = null;
        }
        showMessage("error", data.error || "删除失败");
        return;
      }

      // Invalidate every older list request before applying the successful
      // deletion locally. This keeps remaining members visible immediately,
      // even if an earlier GET finishes after the DELETE.
      usersRequestSequenceRef.current += 1;
      setUsers((current) => current.filter((user) => user.id !== userId));
      setMemberFilter("all");
      setUserSearch("");
      showSuccessAndSync(`已删除「${name}」，其他会员已同步显示`);
      await loadUsers();
    } catch {
      showMessage("error", "网络错误");
    } finally {
      setDeletingUserIds((current) => current.filter((id) => id !== userId));
    }
  };

  const handleDeleteUser = (userId: string, name: string) => {
    if (!canDeleteMembers) {
      if (hasMembersDeletePermission) setUnlockDialogRequested(true);
      return;
    }
    if (userId === currentUserId) { showMessage("error", "不能删除自己的账号"); return; }
    const cachedVerification = adminUserDeleteVerificationRef.current;
    if (cachedVerification && cachedVerification.expiresAt > Date.now() + 5_000) {
      if (!confirm(`确认删除用户「${name}」？删除后其账号将无法恢复。`)) return;
      void deleteUserWithVerification(userId, name, cachedVerification);
      return;
    }
    adminUserDeleteVerificationRef.current = null;
    confirmWithPassword(
      `删除用户「${name}」；验证通过后 10 分钟内连续删除无需重复输入密码。`,
      async (verification) => {
        if (!verification) {
          showMessage("error", "删除验证凭证缺失，请重新验证");
          return;
        }
        await deleteUserWithVerification(userId, name, verification);
      },
      "admin_user_delete",
    );
  };

  const captureMemberListView = () => {
    const scrollContainer = memberWorkspaceRef.current?.closest("main");
    memberListViewSnapshotRef.current = {
      filter: memberFilter,
      search: userSearch,
      scrollTop: scrollContainer instanceof HTMLElement ? scrollContainer.scrollTop : 0,
    };
  };

  const restoreMemberListView = () => {
    const snapshot = memberListViewSnapshotRef.current;
    if (!snapshot) return;
    setUserSubTab("members");
    setMemberFilter(snapshot.filter);
    setUserSearch(snapshot.search);
    window.requestAnimationFrame(() => {
      const scrollContainer = memberWorkspaceRef.current?.closest("main");
      if (scrollContainer instanceof HTMLElement) scrollContainer.scrollTop = snapshot.scrollTop;
    });
  };

  const closeMemberSecurityDialog = () => {
    if (memberSecuritySubmitting) return;
    setMemberSecurityDialog(null);
    restoreMemberListView();
  };

  const openUserAccessEditor = async (user: UserInfo) => {
    if (!canManageMemberPermissions) {
      if (hasMemberPermissionsManagePermission) setUnlockDialogRequested(true);
      return;
    }
    captureMemberListView();
    setEditingUserAccess(user);
    setEditAccessLoading(true);
    setEditAccessProfiles([]);
    setEditAccessProfile(null);
    setEditAccessReason("");
    setEditAccessRevision(0);
    setEditAccessUpdatedAt(null);
    setEditAccessIntegrityValid(true);
    setEditFeatureNavigationKeys([]);
    // API 返回前只保留现有智能体显示值作为占位，不允许保存。
    setEditAccessCategories(getUserAllowedNavigationKeys(user));
    try {
      const response = await fetch(`/api/admin/users/permissions?user_id=${encodeURIComponent(user.id)}`, {
        headers: authHeaders,
        cache: "no-store",
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        showMessage("error", data.error || "会员权限读取失败");
        setEditAccessIntegrityValid(false);
        return;
      }
      const permission = data.permission || {};
      setEditFeatureNavigationKeys(normalizeFeatureNavigationKeys(permission.featureNavigationKeys));
      setEditAccessCategories(normalizeAllowedAgentNavigationKeys(permission.agentNavigationKeys));
      setEditAccessRevision(Number(permission.revision || 0));
      setEditAccessUpdatedAt(typeof permission.updatedAt === "string" ? permission.updatedAt : null);
      setEditAccessIntegrityValid(permission.integrityValid === true);
      setEditAccessProfiles(Array.isArray(data.profiles) ? data.profiles : []);
      if (permission.sourceProfileKey && Number(permission.sourceProfileVersion) > 0) {
        setEditAccessProfile({ key: permission.sourceProfileKey, version: Number(permission.sourceProfileVersion) });
      }
    } catch {
      setEditAccessIntegrityValid(false);
      showMessage("error", "会员权限读取失败，请检查网络后重试");
    } finally {
      setEditAccessLoading(false);
    }
  };

  const closeUserAccessEditor = () => {
    if (editAccessSaving) return;
    setEditingUserAccess(null);
    restoreMemberListView();
  };

  const openPasswordReset = (user: UserInfo) => {
    if (!canManageMembers) {
      if (hasMembersManagePermission) setUnlockDialogRequested(true);
      return;
    }
    captureMemberListView();
    setMemberSecurityDialog({
      kind: "password_reset",
      user,
      username: user.username || "",
      email: normalizeQqEmail(user.email),
      newPassword: "",
      adminPassword: "",
    });
  };

  const openAccountRecovery = (user: UserInfo) => {
    if (!canManageMembers) {
      if (hasMembersManagePermission) setUnlockDialogRequested(true);
      return;
    }
    captureMemberListView();
    setMemberSecurityDialog({
      kind: "identity_change",
      user,
      username: user.username || "",
      email: normalizeQqEmail(user.email),
      newPassword: "",
      adminPassword: "",
    });
  };

  const submitMemberSecurityChange = async () => {
    if (!canManageMembers) {
      if (hasMembersManagePermission) setUnlockDialogRequested(true);
      return;
    }
    if (!memberSecurityDialog) return;
    const { kind, user, newPassword, adminPassword } = memberSecurityDialog;
    const username = memberSecurityDialog.username.trim();
    if (kind === "identity_change" && (!username || username.length > 64)) {
      showMessage("error", "登录账号不能为空且不能超过 64 个字符");
      return;
    }
    if (kind === "password_reset") {
      const passwordError = adminPasswordError(newPassword);
      if (passwordError) {
        showMessage("error", passwordError);
        return;
      }
    }
    setMemberSecuritySubmitting(true);
    try {
      const accountRecoveryToken = await verifyAdminAccountRecovery(adminPassword);
      if (!accountRecoveryToken) return;
      const payload = kind === "identity_change"
        ? { userId: user.id, username }
        : { userId: user.id, newPassword, resetPassword: true };
      const res = await fetch("/api/admin/users", {
        method: "PUT",
        headers: {
          ...authHeaders,
          "x-admin-user-account-reauth": accountRecoveryToken,
        },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        showMessage("error", data.error || (kind === "identity_change" ? "账号信息修改失败" : "密码重置失败"));
        return;
      }
      showSuccessAndSync(kind === "identity_change" ? "学员登录账号已更新，旧设备已退出" : "密码已重置，旧设备已退出");
      setMemberSecurityDialog(null);
      await loadUsers();
      restoreMemberListView();
    } catch {
      showMessage("error", "操作失败，请检查网络后重试");
    } finally {
      setMemberSecuritySubmitting(false);
    }
  };

  const handleToggleUserActive = async (user: UserInfo) => {
    if (!canManageMembers) {
      if (hasMembersManagePermission) setUnlockDialogRequested(true);
      return;
    }
    if (user.id === currentUserId) { showMessage("error", "不能修改自己的账号状态"); return; }
    const userStatus = getUserAccountStatus(user);
    let newStatus: string;
    if (userStatus === "active") {
      if (!confirm("确认暂停该用户？暂停后该用户将无法登录，但数据保留")) return;
      newStatus = "suspended";
    } else if (userStatus === "suspended") {
      newStatus = "blocked";
      if (!confirm("确认拉黑该用户？拉黑后该用户将被永久禁止登录")) return;
    } else {
      newStatus = "active";
    }
    try {
      const res = await fetch("/api/admin/users", { method: "PUT", headers: authHeaders, body: JSON.stringify({ userId: user.id, status: newStatus }) });
      if (res.ok) {
        const statusLabel = newStatus === "active" ? "已恢复" : newStatus === "suspended" ? "已暂停" : "已拉黑";
        showSuccessAndSync(statusLabel); loadUsers();
      }
    } catch {/* */}
  };

  const handleActivateMember = (user: UserInfo) => {
    if (!canAdjustWallet) {
      if (hasWalletAdjustPermission) setUnlockDialogRequested(true);
      return;
    }
    if (isFixtureUser(user)) {
      showMessage("error", "测试/验收账号禁止激活为正式会员，请保留审计证据后隔离或删除");
      return;
    }
    openMemberModule("offline-payments", user.id);
  };

  const handleDeactivateMember = async (user: UserInfo) => {
    if (!canManageMembers) {
      if (hasMembersManagePermission) setUnlockDialogRequested(true);
      return;
    }
    if (!confirm(`确认停用 ${user.name || user.displayName} 的会员？停用后该用户将无法使用平台功能。`)) return;
    try {
      const idempotencyKey = `member-deactivate:${user.id}:${crypto.randomUUID()}`;
      const res = await fetch("/api/admin/users", { method: "PUT", headers: { ...authHeaders, "Idempotency-Key": idempotencyKey }, body: JSON.stringify({ userId: user.id, memberStatus: "inactive", activationNote: "管理员人工停用", idempotencyKey }) });
      if (res.ok) { showSuccessAndSync(`已停用 ${user.name || user.displayName} 的会员`); loadUsers(); }
      else { const data = await res.json(); showMessage("error", data.error || "停用失败"); }
    } catch { showMessage("error", "网络错误"); }
  };

  const handleSaveUserAccess = async () => {
    if (!canManageMemberPermissions) {
      if (hasMemberPermissionsManagePermission) setUnlockDialogRequested(true);
      return;
    }
    if (!editingUserAccess || editAccessLoading || editAccessSaving || !editAccessIntegrityValid) return;
    setEditAccessSaving(true);
    try {
      const allowedCategories = normalizeAllowedAgentNavigationKeys(editAccessCategories);
      const featureNavigationKeys = normalizeFeatureNavigationKeys(editFeatureNavigationKeys);
      const idempotencyKey = `member-permission:${editingUserAccess.id}:${crypto.randomUUID()}`;
      const res = await fetch("/api/admin/users/permissions", {
        method: "PUT",
        headers: { ...authHeaders, "Idempotency-Key": idempotencyKey },
        body: JSON.stringify({
          userId: editingUserAccess.id,
          featureNavigationKeys,
          agentNavigationKeys: allowedCategories,
          expectedRevision: editAccessRevision,
          idempotencyKey,
          reason: editAccessReason.trim() || "管理员调整会员功能权限",
          sourceProfileKey: editAccessProfile?.key || null,
          sourceProfileVersion: editAccessProfile?.version || null,
        }),
      });
      if (res.ok) {
        showSuccessAndSync(`已更新 ${editingUserAccess.name || editingUserAccess.displayName || editingUserAccess.username} 的功能权限`);
        setEditingUserAccess(null);
        await loadUsers();
        restoreMemberListView();
      } else {
        const data = await res.json();
        showMessage("error", data.error || "更新失败");
      }
    } catch {
      showMessage("error", "网络错误");
    } finally {
      setEditAccessSaving(false);
    }
  };

  const handleUserStatus = async (user: UserInfo, targetStatus: string) => {
    if (!canManageMembers) {
      if (hasMembersManagePermission) setUnlockDialogRequested(true);
      return;
    }
    if (user.id === currentUserId) { showMessage("error", "不能修改自己的账号状态"); return; }
    if (isFixtureUser(user) && targetStatus === "active") {
      showMessage("error", "测试/验收账号禁止恢复为正常状态，请保留审计证据后隔离或删除");
      return;
    }
    const statusLabel = targetStatus === "active" ? "恢复" : targetStatus === "suspended" ? "暂停" : "拉黑";
    if (targetStatus === "blocked" && !confirm("确认拉黑该用户？拉黑后该用户将被永久禁止登录")) return;
    if (targetStatus === "suspended" && !confirm("确认暂停该用户？暂停后该用户将无法登录，但数据保留")) return;
    try {
      const res = await fetch("/api/admin/users", { method: "PUT", headers: authHeaders, body: JSON.stringify({ userId: user.id, status: targetStatus }) });
      if (res.ok) { showSuccessAndSync(`已${statusLabel}`); loadUsers(); }
      else { const data = await res.json().catch(() => ({})); showMessage("error", data.error || `${statusLabel}失败，请刷新后核对账号状态`); }
    } catch { showMessage("error", "请求未完成，请刷新后核对账号状态"); }
  };

  // 测试扣子编程智能体连接
  const testCodingConnection = async (apiUrl: string, providerToken: string) => {
    if (codingTestInFlightRef.current) return;
    if (!apiUrl || !providerToken) {
      setCodingTestResult({ ok: false, msg: '请先填写 API 地址和 Token' });
      return;
    }
    codingTestInFlightRef.current = true;
    setCodingTestLoading(true);
    setCodingTestResult(null);
    try {
      const res = await fetch('/api/coze/test-coding', {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ url: apiUrl, token: providerToken, projectId: newAgent.botId }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || data.message || '测试请求失败');
      setCodingTestResult({ ok: true, msg: '接口已响应；工作流运行结果需在实际调用中核对' });
      showMessage("success", "接口已响应；工作流运行结果需在实际调用中核对");
    } catch (error) {
      const message = error instanceof Error ? error.message : '测试请求未完成，请先核对上一次请求';
      setCodingTestResult({ ok: false, msg: message });
      showMessage("error", message);
    } finally {
      codingTestInFlightRef.current = false;
      setCodingTestLoading(false);
    }
  };

  // 一键解析扣子编程配置信息
  const parseCozeCodingConfig = (text: string) => {
    if (!text.trim()) return;
    const updated = { ...newAgent };
    // 尝试提取URL (https://xxx.coze.site)
    const urlMatch = text.match(/https?:\/\/([a-z0-9-]+)\.coze\.site/);
    if (urlMatch) {
      updated.cozeCodingApiUrl = `https://${urlMatch[1]}.coze.site/stream_run`;
    }
    // 尝试提取项目ID (纯数字，15-20位)
    const idMatch = text.match(/(?<!\d)(\d{15,20})(?!\d)/);
    if (idMatch) {
      updated.cozeCodingProjectId = idMatch[1];
    }
    // 尝试提取Token (eyJ开头的JWT)
    const tokenMatch = text.match(/eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/);
    if (tokenMatch) {
      updated.cozeCodingApiToken = tokenMatch[0];
    }
    setNewAgent(updated);
  };

  // 选择 LLM 模型预设后自动填充智能体配置
  const handleSelectLlmModel = (modelId: string, isEdit: boolean = false) => {
    if (!modelId) return;
    const m = llmModels.find(x => x.id === modelId);
    if (!m) return;
    // 选模型 → 自动启用TOKEN计费（无需手动切换）
    const autoTokenBilling = m.token_billing_enabled || (m.input_cost_per_million != null && m.output_cost_per_million != null);
    if (isEdit && editingAgent) {
      setEditingAgent({
        ...editingAgent,
        model_id: m.id,
        model: m.model_name || m.name,
        proxy_url: m.api_endpoint || m.proxy_url || "",
        coze_coding_api_token: m.api_key || "",
        cost_per_message: m.cost_per_use || 10,
        base_fee: m.cost_price || 0,
        token_billing_enabled: autoTokenBilling,
        input_cost_per_million: m.input_cost_per_million ?? undefined,
        output_cost_per_million: m.output_cost_per_million ?? undefined,
        cached_cost_per_million: m.cached_cost_per_million ?? undefined,
        profit_margin: m.profit_margin ?? undefined,
        token_rounding_unit: m.token_rounding_unit || 0,
        deep_thinking_type: m.deep_thinking_type || 0,
        deduct_deep_think: m.deduct_deep_think ?? 1,
        max_context_rounds: m.max_context_rounds || 0,
        max_context_tokens: m.max_context_tokens || 0,
        max_reply_tokens: m.max_reply_tokens || 0,
        timeout: m.timeout || 300,
        enable_web_search: m.enable_web_search || false,
        temperature: m.temperature ?? undefined,
        response_format: (m.response_format as "text" | "markdown" | "json_object") ?? undefined,
        frequency_limit: m.frequency_limit ?? 50,
        image_parsing: m.image_parsing || "none",
        file_parsing: m.file_parsing || "none",
      });
    } else {
      setNewAgent({
        ...newAgent,
        modelId: m.id,
        model: m.model_name || m.name,
        proxyUrl: m.api_endpoint || m.proxy_url || "",
        cozeCodingApiToken: m.api_key || "",
        costPerMessage: m.cost_per_use || 10,
        token_billing_enabled: autoTokenBilling,
        input_cost_per_million: m.input_cost_per_million ?? undefined,
        output_cost_per_million: m.output_cost_per_million ?? undefined,
        cached_cost_per_million: m.cached_cost_per_million ?? undefined,
        profit_margin: m.profit_margin ?? undefined,
        token_rounding_unit: m.token_rounding_unit || 0,
        deepThinkingType: m.deep_thinking_type || 0,
        deductDeepThink: m.deduct_deep_think ?? 1,
        maxContextRounds: m.max_context_rounds || 0,
        maxContextTokens: m.max_context_tokens || 0,
        maxReplyTokens: m.max_reply_tokens || 0,
        timeout: m.timeout || 300,
        enableWebSearch: m.enable_web_search || false,
        temperature: m.temperature ?? undefined,
        response_format: (m.response_format as "text" | "markdown" | "json_object") ?? undefined,
        frequencyLimit: m.frequency_limit ?? 50,
        imageParsing: m.image_parsing || "none",
        fileParsing: m.file_parsing || "none",
      });
    }
  };

  const applyDrawingModelToNewAgent = (modelName: string) => {
    const m = activeDrawingModels.find(x => x.model_name === modelName);
    // 生图模型写入 outputStyle.hybridImageGeneration，不覆盖对话模型
    const currentOutputStyle = newAgent.output_style || {};
    setNewAgent({
      ...newAgent,
      // model 保持不变（对话模型），不替换！
      source: newAgent.source || "llm",
      proxyUrl: newAgent.proxyUrl || "",
      output_style: {
        ...currentOutputStyle,
        hybridImageGeneration: {
          enabled: true,
          model: modelName,
          modelId: m?.id || "",
          routingMode: "auto",
          defaultCount: 1,
        },
      } as OutputStyle,
      token_billing_enabled: false,
      imageParsing: "none",
      fileParsing: "none",
    });
  };

  const applyDrawingModelToEditingAgent = (modelName: string) => {
    if (!editingAgent) return;
    const m = activeDrawingModels.find(x => x.model_name === modelName);
    // 生图模型写入 outputStyle.hybridImageGeneration，不覆盖对话模型
    const currentOutputStyle = editingAgent.output_style || {};
    setEditingAgent({
      ...editingAgent,
      // model 保持不变（对话模型），不替换！
      source: editingAgent.source || "llm",
      proxy_url: editingAgent.proxy_url || "",
      output_style: {
        ...currentOutputStyle,
        hybridImageGeneration: {
          enabled: true,
          model: modelName,
          modelId: m?.id || "",
          routingMode: "auto",
          defaultCount: 1,
        },
      } as OutputStyle,
      token_billing_enabled: false,
      image_parsing: "none",
      file_parsing: "none",
    });
  };

  const handleAddAgent = async () => {
    if (!canManageAgentConfiguration) return;
    try {
      const { modelId, ...rest } = newAgent;
      const convertedPresetFields = templateToPreset(addPresetFields);
      const agentData: Record<string, unknown> = { ...rest, source: addAgentSource, model_id: modelId || null, cover_url: addAgentCoverUrl || undefined, preset_fields: convertedPresetFields.length > 0 ? convertedPresetFields : [] };
      if (!canEditPrompts) delete agentData.systemPrompt;
      const res = await fetch("/api/admin/agents", { method: "POST", headers: authHeaders, body: JSON.stringify(agentData) });
      const data = await res.json();
      if (res.ok) { showSuccessAndSync(`智能体 ${newAgent.name} 创建成功`); setShowAddAgent(false); setAddShowAdvanced(false); setNewAgent({ name: "", description: "", avatar: "", category: "通用", source: "llm", botId: "", model: "deepseek-v4-flash", systemPrompt: "", costPerMessage: 10, sortOrder: 0, cozeCodingApiUrl: "", cozeCodingApiToken: "", cozeCodingProjectId: "", isActive: true, output_style: undefined, enable_think_tags: false, proxyUrl: "", deepThinkingType: 0, deductDeepThink: 1, maxContextRounds: 0, maxContextTokens: 0, maxReplyTokens: 16384, timeout: 300, enableWebSearch: false, temperature: undefined, response_format: undefined, token_billing_enabled: false, input_cost_per_million: undefined, output_cost_per_million: undefined, cached_cost_per_million: undefined, profit_margin: undefined, token_rounding_unit: 0, modelId: "", frequencyLimit: 50, imageParsing: "none", fileParsing: "none", guide_message: "" }); setAvatarPreview(""); setAddAgentSource("llm"); setAddPresetFields([]); setAddAgentCoverUrl(""); setAddAgentCoverPreview(""); setPendingAddAvatarKey(""); setPendingAddCoverKey(""); loadAgents(); }
      else { showMessage("error", data.error || "创建失败"); }
    } catch { showMessage("error", "网络错误"); }
  };

  const handleCancelAddAgent = () => {
    if (pendingAddAvatarKey) void discardPendingAgentImage(pendingAddAvatarKey);
    if (pendingAddCoverKey) void discardPendingAgentImage(pendingAddCoverKey);
    setPendingAddAvatarKey("");
    setPendingAddCoverKey("");
    setNewAgent((current) => ({ ...current, avatar: "" }));
    setAvatarPreview("");
    setAddAgentCoverUrl("");
    setAddAgentCoverPreview("");
    setShowAddAgent(false);
    setAddAgentSource("llm");
    setAddShowAdvanced(false);
  };

  // Auto-fetch bot info from Coze when Bot ID is entered
  const handleFetchBotInfo = async () => {
    if (!newAgent.botId.trim()) {
      showMessage("error", "请先输入 Bot ID");
      return;
    }
    setFetchBotInfoLoading(true);
    try {
      const res = await fetch("/api/admin/agents/fetch-info", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders },
        body: JSON.stringify({ bot_id: newAgent.botId.trim() }),
      });
      const data = await res.json();
      if (res.ok) {
        setNewAgent({
          ...newAgent,
          name: data.name || newAgent.name,
          description: data.description || newAgent.description,
          avatar: data.icon_url || newAgent.avatar,
        });
        if (data.icon_url) setAvatarPreview(data.icon_url);
        showMessage("success", `已获取：${data.name || "未知"}`);
      } else {
        showMessage("error", data.error || "获取失败，请检查 Bot ID 和 API 配置");
      }
    } catch {
      showMessage("error", "网络错误，无法连接智能体平台");
    } finally {
      setFetchBotInfoLoading(false);
    }
  };

  // Batch import by Bot IDs
  const handleImportByIds = async () => {
    // Extract Bot IDs from text: supports raw IDs, URLs, and "BotID|名称" format
    const extractBotIds = (text: string): string[] => {
      const ids = new Set<string>();
      // Pattern 1: URL containing /bot/ followed by digits (code.coze.cn/w/xxx/bot/BOTID)
      const botUrlPattern = /\/bot\/(\d+)/g;
      let match;
      while ((match = botUrlPattern.exec(text)) !== null) {
        if (match[1]) ids.add(match[1]);
      }
      // Pattern 2: URL containing /p/ followed by digits (code.coze.cn/p/PROJECTID - 扣子编程项目)
      const projectUrlPattern = /\/p\/(\d+)/g;
      while ((match = projectUrlPattern.exec(text)) !== null) {
        if (match[1]) ids.add(match[1]);
      }
      // Pattern 3: "BotID|名称" format or standalone numeric IDs
      const parts = text.split(/[\n,;，；\s]+/);
      for (const part of parts) {
        const trimmed = part.trim();
        if (!trimmed) continue;
        // Skip URLs
        if (trimmed.startsWith('http')) continue;
        // Support "BotID|名称" format - extract the ID part
        const pipeMatch = trimmed.match(/^(\d{5,})\|/);
        if (pipeMatch && pipeMatch[1]) {
          ids.add(pipeMatch[1]);
        } else if (/^\d{10,}$/.test(trimmed) && !ids.has(trimmed)) {
          ids.add(trimmed);
        }
      }
      return Array.from(ids);
    };

    // Extract name mapping from "BotID|名称" format
    const extractNameMap = (text: string): Map<string, string> => {
      const nameMap = new Map<string, string>();
      const parts = text.split(/[\n,;，；]+/);
      for (const part of parts) {
        const trimmed = part.trim();
        const pipeMatch = trimmed.match(/^(\d{5,})\|(.+)$/);
        if (pipeMatch && pipeMatch[1] && pipeMatch[2]) {
          nameMap.set(pipeMatch[1], pipeMatch[2].trim());
        }
      }
      return nameMap;
    };

    const ids = extractBotIds(importByIdsText);
    if (ids.length === 0) {
      showMessage("error", "未识别到 Bot ID，请粘贴智能体链接或输入 Bot ID");
      return;
    }
    const nameMap = extractNameMap(importByIdsText);
    // Convert nameMap to plain object for JSON serialization
    const names: Record<string, string> = {};
    nameMap.forEach((v, k) => { names[k] = v; });
    
    setImportByIdsLoading(true);
    setImportByIdsResult(null);
    try {
      const res = await fetch("/api/admin/agents/import-by-ids", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders },
        body: JSON.stringify({ bot_ids: ids, category: importByIdsCategory, names }),
      });
      const data = await res.json();
      if (res.ok) {
        setImportByIdsResult(data);
        if (data.imported > 0) {
          showSuccessAndSync(`成功导入 ${data.imported} 个智能体`);
          loadAgents();
        }
      } else {
        showMessage("error", data.error || "导入失败");
      }
    } catch {
      showMessage("error", "网络错误");
    } finally {
      setImportByIdsLoading(false);
    }
  };

  // Parse curl snippets for Coze Coding import
  const handleParseCodingCurls = () => {
    const text = importCodingText.trim();
    if (!text) { setImportCodingParsed([]); return; }

    // Split by double newlines or "curl" commands to identify individual entries
    const blocks = text.split(/\n\s*\n/).filter(b => b.trim());
    // Also split if there are multiple curl commands
    const curlBlocks: string[] = [];
    for (const block of blocks) {
      if (block.includes("curl")) {
        // Might have multiple curl commands in one block
        const parts = block.split(/(?=curl\s)/g).filter(p => p.trim());
        curlBlocks.push(...parts);
      } else {
        curlBlocks.push(block);
      }
    }

    const parsed = curlBlocks.map(block => {
      // Extract URL
      const urlMatch = block.match(/["']?(https?:\/\/[a-z0-9-]+\.coze\.site\/stream_run)["']?/i);
      const apiUrl = urlMatch ? urlMatch[1] : "";

      // Extract project_id
      const projectIdMatch = block.match(/"project_id"\s*:\s*"?(\d{10,})"?/);
      const projectId = projectIdMatch ? projectIdMatch[1] : "";

      // Extract token
      let apiToken = "";
      const tokenMatch = block.match(/Authorization["']?\s*:\s*["']?\s*Bearer\s+([\w.\-]+)/i);
      if (tokenMatch) {
        apiToken = tokenMatch[1];
      }
      if (!apiToken) {
        const jwtMatch = block.match(/(eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/);
        if (jwtMatch) apiToken = jwtMatch[1];
      }

      // Generate name from URL subdomain
      const subdomain = apiUrl ? apiUrl.replace(/^https?:\/\//, '').split('.')[0] : "";
      const name = subdomain ? `智能体-${subdomain}` : "未命名智能体";

      const errors: string[] = [];
      if (!apiUrl) errors.push("未找到 API 地址");
      if (!projectId) errors.push("未找到 Project ID");
      if (!apiToken) errors.push("未找到 Token");

      return { name, api_url: apiUrl, project_id: projectId, api_token: apiToken, valid: errors.length === 0, error: errors.length > 0 ? errors.join("；") : undefined };
    });

    setImportCodingParsed(parsed);
  };

  // Update a parsed coding agent's name
  const updateCodingParsedName = (index: number, name: string) => {
    setImportCodingParsed(prev => prev.map((p, i) => i === index ? { ...p, name } : p));
  };

  // Batch import parsed coding agents
  const handleImportCoding = async () => {
    const validAgents = importCodingParsed.filter(p => p.valid);
    if (validAgents.length === 0) {
      showMessage("error", "没有可导入的智能体，请检查信息是否完整");
      return;
    }

    setImportCodingLoading(true);
    try {
      const res = await fetch("/api/admin/agents/import-coding", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders },
        body: JSON.stringify({
          agents: validAgents.map(a => ({
            name: a.name,
            api_url: a.api_url,
            project_id: a.project_id,
            api_token: a.api_token,
            category: importCodingCategory,
          })),
        }),
      });
      const data = await res.json();
      if (res.ok) {
        setImportCodingResult(data);
        if (data.imported > 0) {
          showSuccessAndSync(`成功导入 ${data.imported} 个编程智能体`);
          loadAgents();
        }
      } else {
        showMessage("error", data.error || "导入失败");
      }
    } catch {
      showMessage("error", "网络错误");
    } finally {
      setImportCodingLoading(false);
    }
  };

  const uploadAgentImage = async (file: File, purpose: "avatar" | "cover") => {
    if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) {
      throw new Error("只支持 PNG、JPEG 或 WebP 图片");
    }
    if (file.size < 1 || file.size > 5 * 1024 * 1024) {
      throw new Error("图片大小必须在 5MB 以内");
    }
    const formData = new FormData();
    formData.append("purpose", purpose);
    formData.append("file", file);
    const response = await fetch("/api/admin/agents/assets", {
      method: "POST",
      headers: { Authorization: `Bearer ${token || ""}` },
      body: formData,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload?.success || !payload?.asset?.key) {
      throw new Error(payload?.error || "图片上传失败");
    }
    return payload.asset as { key: string; url: string; width: number; height: number };
  };

  const discardPendingAgentImage = async (key: string) => {
    if (!key) return;
    await fetch("/api/admin/agents/assets", {
      method: "DELETE",
      headers: authHeaders,
      body: JSON.stringify({ key }),
    }).catch(() => undefined);
  };

  const handleAvatarUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setAvatarUploading(true);
    try {
      const asset = await uploadAgentImage(file, "avatar");
      const previousPending = pendingAddAvatarKey;
      setNewAgent((current) => ({ ...current, avatar: asset.key }));
      setAvatarPreview(asset.url);
      setPendingAddAvatarKey(asset.key);
      if (previousPending && previousPending !== asset.key) void discardPendingAgentImage(previousPending);
      showMessage("success", `头像上传成功（${asset.width}×${asset.height}）`);
    } catch (error) {
      showMessage("error", error instanceof Error ? error.message : "头像上传失败");
    } finally {
      setAvatarUploading(false);
      e.target.value = "";
    }
  };

  const handleAddCoverUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setAddAgentCoverUploading(true);
    try {
      const asset = await uploadAgentImage(file, "cover");
      const previousPending = pendingAddCoverKey;
      setAddAgentCoverUrl(asset.key);
      setAddAgentCoverPreview(asset.url);
      setPendingAddCoverKey(asset.key);
      if (previousPending && previousPending !== asset.key) void discardPendingAgentImage(previousPending);
      showMessage("success", `背景图上传成功（${asset.width}×${asset.height}）`);
    } catch (error) {
      showMessage("error", error instanceof Error ? error.message : "背景图上传失败");
    } finally {
      setAddAgentCoverUploading(false);
      e.target.value = "";
    }
  };

  const handleEditAvatarUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const uploadSession = agentEditSession;
    const isCurrentUpload = () => agentEditSessionRef.current === uploadSession && agentEditorAccessRef.current.configuration;
    setEditAvatarUploading(true);
    try {
      const asset = await uploadAgentImage(file, "avatar");
      if (!isCurrentUpload()) { void discardPendingAgentImage(asset.key); return; }
      const previousPending = pendingEditAvatarKey;
      setEditingAgent((current) => current ? ({ ...current, avatar: asset.key }) : current);
      setEditAvatarPreview(asset.url);
      setPendingEditAvatarKey(asset.key);
      if (previousPending && previousPending !== asset.key) void discardPendingAgentImage(previousPending);
      showMessage("success", `头像上传成功（${asset.width}×${asset.height}）`);
    } catch (error) {
      if (isCurrentUpload()) showMessage("error", error instanceof Error ? error.message : "头像上传失败");
    } finally {
      if (isCurrentUpload()) setEditAvatarUploading(false);
      e.target.value = "";
    }
  };

  const handleEditCoverUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const uploadSession = agentEditSession;
    const isCurrentUpload = () => agentEditSessionRef.current === uploadSession && agentEditorAccessRef.current.configuration;
    setEditAgentCoverUploading(true);
    try {
      const asset = await uploadAgentImage(file, "cover");
      if (!isCurrentUpload()) { void discardPendingAgentImage(asset.key); return; }
      const previousPending = pendingEditCoverKey;
      setEditingAgent((current) => current ? ({ ...current, cover_url: asset.key }) : current);
      setEditAgentCoverPreview(asset.url);
      setPendingEditCoverKey(asset.key);
      if (previousPending && previousPending !== asset.key) void discardPendingAgentImage(previousPending);
      showMessage("success", `背景图上传成功（${asset.width}×${asset.height}）`);
    } catch (error) {
      if (isCurrentUpload()) showMessage("error", error instanceof Error ? error.message : "背景图上传失败");
    } finally {
      if (isCurrentUpload()) setEditAgentCoverUploading(false);
      e.target.value = "";
    }
  };

  // 一键生成单个智能体头像
  const generateSingleAvatar = async (mode: "add" | "edit") => {
    const generationSession = agentEditSession;
    const isCurrentGeneration = () => mode === "add" || (agentEditSessionRef.current === generationSession && agentEditorAccessRef.current.configuration);
    const agentName = mode === "add" ? newAgent.name : editingAgent?.name;
    const agentDesc = mode === "add" ? newAgent.description : editingAgent?.description;
    const agentId = mode === "edit" ? editingAgent?.id : undefined;
    if (!agentName?.trim()) { showMessage("error", "请先填写智能体名称，再生成头像"); return; }
    if (!confirm(`将为“${agentName.trim()}”调用生图模型生成 1 张头像，可能产生费用。确认继续吗？`)) return;
    setSingleAvatarGenerating(true);
    setSingleAvatarMode(mode);
    setSingleAvatarStatus("正在生成主站统一风格头像...");
    try {
      const idempotencyKey = `avatar-single:${window.crypto.randomUUID()}`;
      const requestBody: Record<string, unknown> = {
        style: singleAvatarStyle,
        customPrompt: singleAvatarCustomPrompt || undefined,
        singleAgent: { name: agentName.trim(), description: agentDesc || "" },
        confirmPaidGeneration: true,
        confirmedAgentCount: 1,
      };
      if (mode === "edit" && agentId) requestBody.agentId = agentId;

      const res = await fetch("/api/admin/agents/batch-avatar", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token || ""}`,
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify(requestBody),
      });

      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.success || !data.results?.length) {
        throw new Error(data?.error || "头像生成失败，请检查后台启用的头像生图模型");
      }

      const result = data.results[0];
      if (!result.success || !result.avatarUrl) {
        throw new Error(result.error || "头像生成未返回有效图片");
      }

      const newCandidates = [result.avatarUrl, ...avatarCandidates.filter((url) => url !== result.avatarUrl)].slice(0, 20);
      setAvatarCandidates(newCandidates);
      try { safeLocalStorageSet("avatar_candidates", JSON.stringify(newCandidates)); } catch {}
      if (!isCurrentGeneration()) { void loadAgents(); return; }

      if (mode === "add") {
        setNewAgent(prev => ({ ...prev, avatar: result.avatarUrl }));
        setAvatarPreview(result.avatarUrl);
      } else {
        setEditingAgent(prev => prev ? ({ ...prev, avatar: result.avatarUrl }) : prev);
        setEditAvatarPreview(result.avatarUrl);
        loadAgents();
      }
      setSingleAvatarStatus("头像生成成功");
      showMessage("success", mode === "edit" ? "头像生成成功，已自动保存到数据库" : "头像生成成功，已填入新增表单");
    } catch (error) {
      const msg = error instanceof Error ? error.message : "头像生成请求失败";
      if (isCurrentGeneration()) { setSingleAvatarStatus(msg); showMessage("error", msg); }
    } finally {
      setSingleAvatarGenerating(false);
      }
  };

  const handleUpdateAgent = async () => {
    if (!canManageAgentConfiguration || agentSaveBusy || agentSaveInFlightRef.current) return;
    if (editPromptReading) { showMessage("error", "提示词文件正在读取，请稍后保存"); return; }
    if (!editingAgent || !editingAgent.name) { showMessage("error", "请填写智能体名称"); return; }
    const saveSession = agentEditSession;
    const originalAgent = editOriginalAgentRef.current;
    if (agentEditSessionRef.current !== saveSession || !originalAgent || originalAgent.id !== editingAgent.id) {
      showMessage("error", "编辑基线已过期，请关闭后重新打开智能体");
      return;
    }
    const updatePayload = buildAgentUpdatePayload(editingAgent, originalAgent, canEditPrompts);
    const originalImages = { ...editOriginalImagesRef.current };
    const pendingContractAction = directorContractActionRef.current;
    const isCurrentSession = () => agentEditSessionRef.current === saveSession && editOriginalAgentRef.current === originalAgent;
    const restoreFailedContractDraft = () => {
      if (pendingContractAction !== "rollback" || !isCurrentSession()) return;
      setEditingAgent((current) => {
        if (!current || current.id !== originalAgent.id) return current;
        const restoredStyle: Record<string, unknown> = { ...(current.output_style || {}) };
        const originalStyle = (originalAgent.output_style || {}) as Record<string, unknown>;
        for (const key of STORYBOARD_DIRECTOR_CONTRACT_FIELDS) {
          if (Object.prototype.hasOwnProperty.call(originalStyle, key)) {
            restoredStyle[key] = originalStyle[key];
          } else delete restoredStyle[key];
        }
        return { ...current, output_style: restoredStyle as OutputStyle };
      });
    };
    if (pendingContractAction) {
      if (!canEditPrompts) { restoreFailedContractDraft(); directorContractActionRef.current = null; showMessage("error", "请重新验证提示词编辑权限后再操作制作合同"); return; }
      updatePayload.directorContractAction = pendingContractAction;
    }
    if (Object.keys(updatePayload).every((key) => key === "agentId" || key === "expected_revision")) {
      showMessage("success", "没有需要保存的修改");
      return;
    }
    agentSaveInFlightRef.current = true;
    setAgentSaveBusy(true);
    let saved = false;
    try {
      const res = await fetch("/api/admin/agents", {
        method: "PUT",
        headers: authHeaders,
        body: JSON.stringify(updatePayload),
      });
      const data = await res.json();
      if (!isCurrentSession()) { void loadAgents(); return; }
      if (res.ok && data.success) {
        saved = true;
        const obsoleteKeys = [
          originalImages.avatar !== editingAgent.avatar ? originalImages.avatar : "",
          originalImages.cover !== (editingAgent.cover_url || "") ? originalImages.cover : "",
        ].filter(Boolean);
        showSuccessAndSync("智能体更新成功");
        setPendingEditAvatarKey("");
        setPendingEditCoverKey("");
        closeAgentEditor(saveSession);
        setEditAvatarPreview("");
        setEditAgentCoverPreview("");
        setEditShowAdvanced(false);
        obsoleteKeys.forEach((key) => void discardPendingAgentImage(key));
        loadAgents();
      }
      else if (res.status === 409 && data.code === "AGENT_CONFIG_REVISION_CONFLICT") {
        showMessage("error", "该智能体已在另一端更新。为避免覆盖，请关闭编辑窗口并重新打开后再合并修改。");
        loadAgents();
      }
      else { showMessage("error", data.error || "更新失败"); }
    } catch { if (isCurrentSession()) showMessage("error", "更新失败"); }
    finally {
      if (!saved) restoreFailedContractDraft();
      if (isCurrentSession()) directorContractActionRef.current = null;
      agentSaveInFlightRef.current = false;
      setAgentSaveBusy(false);
    }
  };

  const handleDeleteAgent = (agent: AgentInfo) => {
    confirmWithPassword(`删除智能体「${agent.name}」（删除后将移至回收站）`, async () => {
      try {
        const revision = Number(agent.config_revision);
        if (!Number.isSafeInteger(revision) || revision < 1) throw new Error("AGENT_EXPECTED_REVISION_REQUIRED");
        const res = await fetch(`/api/admin/agents?id=${encodeURIComponent(agent.id)}&expected_revision=${revision}`, { method: "DELETE", headers: authHeaders });
        if (res.ok) { showSuccessAndSync("已移至回收站"); loadAgents(); loadTrashedAgents(); }
        else { const data = await res.json(); showMessage("error", res.status === 409 ? "该智能体已在另一端更新，请刷新后重试。" : (data.error || "删除失败")); if (res.status === 409) loadAgents(); }
      } catch { showMessage("error", "缺少有效配置版本，请刷新后重试。"); loadAgents(); }
    });
  };

  const handleDuplicateAgent = async (agent: AgentInfo) => {
    if (!canManageAgentConfiguration) return;
    try {
      // 副本排到正本后面紧挨着
      const duplicateSortOrder = (agent.sort_order || 0) + 1;
      const body: Record<string, unknown> = {
        name: `${agent.name} (副本)`,
        description: agent.description,
        avatar: agent.avatar || '',
        category: agent.category,
        source: agent.source,
        bot_id: agent.bot_id || '',
        model: agent.model || 'deepseek-v4-flash',
        system_prompt: agent.system_prompt || '',
        cost_per_message: agent.cost_per_message || 10,
        base_fee: agent.base_fee || 0,
        is_active: false, // 副本默认禁用，需管理员审核后启用
        coze_coding_api_url: agent.coze_coding_api_url || '',
        credential_source_agent_id: agent.id,
        coze_coding_project_id: agent.coze_coding_project_id || '',
        preset_fields: agent.preset_fields || [],
        output_style: agent.output_style || {},
        enable_think_tags: agent.enable_think_tags ?? false,
        proxy_url: agent.proxy_url || '',
        deep_thinking_type: agent.deep_thinking_type ?? 0,
        deduct_deep_think: agent.deduct_deep_think ?? 1,
        max_context_rounds: agent.max_context_rounds ?? 30,
        max_context_tokens: agent.max_context_tokens ?? 0,
        max_reply_tokens: agent.max_reply_tokens ?? 16384,
        timeout: agent.timeout ?? 300,
        enable_web_search: agent.enable_web_search ?? false,
        temperature: agent.temperature ?? null,
        response_format: agent.response_format ?? null,
        token_billing_enabled: agent.token_billing_enabled ?? false,
        input_cost_per_million: agent.input_cost_per_million ?? null,
        output_cost_per_million: agent.output_cost_per_million ?? null,
        cached_cost_per_million: agent.cached_cost_per_million ?? null,
        profit_margin: agent.profit_margin ?? null,
        token_rounding_unit: agent.token_rounding_unit ?? 0,
        user_access: agent.user_access || 'available',
        model_id: agent.model_id || null,
        frequency_limit: agent.frequency_limit ?? 50,
        image_parsing: agent.image_parsing || 'none',
        file_parsing: agent.file_parsing || 'none',
        cover_url: agent.cover_url || null,
        guide_message: agent.guide_message || '',
        sort_order: duplicateSortOrder,
      };
      if (!canEditPrompts) delete body.system_prompt;
      const res = await fetch("/api/admin/agents", { method: "POST", headers: authHeaders, body: JSON.stringify(body) });
      if (res.ok) {
        await loadAgents();
        showSuccessAndSync(`已创建「${agent.name}」的副本`);
      } else {
        const data = await res.json();
        showMessage("error", data.error || "创建副本失败");
      }
    } catch { showMessage("error", "网络错误"); }
  };

  const handleEditAgent = (agent: AgentInfo) => {
    const session = ++agentEditSessionRef.current;
    agentPromptReadRef.current += 1;
    setAgentEditSession(session);
    editOriginalAgentRef.current = structuredClone(agent);
    directorContractActionRef.current = null;
    setEditPromptReading(false);
    setEditingAgentState(structuredClone(agent));
    setEditAvatarUploading(false);
    setEditAgentCoverUploading(false);
    editOriginalImagesRef.current = { avatar: agent.avatar || "", cover: agent.cover_url || "" };
    setPendingEditAvatarKey("");
    setPendingEditCoverKey("");
    setEditAvatarPreview(resolveTrashAvatarSrc(agent));
    setEditAgentCoverPreview(resolveAvatarPreviewSrc(agent.cover_url));
    setEditShowAdvanced(false);
    void loadLlmModels();
    void loadDrawingModels();
  };

  const handleCancelEdit = () => {
    if (agentEditSessionRef.current !== agentEditSession) return;
    if (pendingEditAvatarKey) void discardPendingAgentImage(pendingEditAvatarKey);
    if (pendingEditCoverKey) void discardPendingAgentImage(pendingEditCoverKey);
    setPendingEditAvatarKey("");
    setPendingEditCoverKey("");
    closeAgentEditor(agentEditSession);
    setEditAvatarPreview("");
    setEditAgentCoverPreview("");
    setEditShowAdvanced(false);
  };

  const handleToggleAgentActive = async (agent: AgentInfo) => {
    try {
      const res = await fetch("/api/admin/agents", { method: "PUT", headers: authHeaders, body: JSON.stringify(buildAgentMutationPayload(agent, { isActive: !agent.is_active })) });
      if (res.ok) { showSuccessAndSync(agent.is_active ? "已禁用" : "已启用"); loadAgents(); }
      else if (res.status === 409) { showMessage("error", "该智能体已在另一端更新，请刷新后重试。"); loadAgents(); }
    } catch { showMessage("error", "缺少有效配置版本，请刷新后重试。"); loadAgents(); }
  };

  const handleTestCozeConnection = async () => {
    setCozeTestResult(null);
    try {
      // Save first so test uses latest settings
      const saved = await saveSettings("integrations", false, COZE_CONNECTION_SETTING_FIELDS);
      if (!saved) return;
      const res = await fetch("/api/coze/test", { method: "POST", headers: authHeaders });
      const data = await res.json();
      setCozeTestResult(data);
      if (data.connected) {
        const tip = data.tip ? `\n${data.tip}` : "";
        showMessage("success", `连接成功！发现 ${data.botCount ?? 0} 个智能体${tip}`);
      } else {
        showMessage("error", `连接失败：${data.error}`);
      }
    } catch {
      setCozeTestResult({ connected: false, error: "网络错误" });
      showMessage("error", "测试连接失败");
    }
  };

  // ─── Category CRUD ───
  const handleAddCategory = async () => {
    if (!newCategoryName.trim()) { showMessage("error", "请输入分类名称"); return; }
    try {
      const res = await fetch("/api/admin/categories", {
        method: "POST", headers: authHeaders,
        body: JSON.stringify({ name: newCategoryName.trim(), icon: newCategoryIcon.trim(), sortOrder: (categories.length + 1) * 100 }),
      });
      const data = await res.json();
      if (data.success) { showSuccessAndSync(`分类"${newCategoryName}"创建成功`); setNewCategoryName(""); setNewCategoryIcon(""); loadCategories(); }
      else { showMessage("error", data.error || "创建失败"); }
    } catch { showMessage("error", "创建失败"); }
  };

  const handleUpdateCategory = async (categoryId: string) => {
    if (!editingCategoryName.trim()) { showMessage("error", "分类名称不能为空"); return; }
    try {
      const res = await fetch("/api/admin/categories", {
        method: "PUT", headers: authHeaders,
        body: JSON.stringify({ categoryId, name: editingCategoryName.trim(), icon: editingCategoryIcon.trim() }),
      });
      const data = await res.json();
      if (data.success) { showSuccessAndSync("分类更新成功"); setEditingCategoryId(null); loadCategories(); loadAgents(); }
      else { showMessage("error", data.error || "更新失败"); }
    } catch { showMessage("error", "更新失败"); }
  };

  // 批量保存分类排序号
  const handleSaveSortOrders = async () => {
    const entries = Object.entries(pendingSortOrders);
    if (entries.length === 0) return;
    let allOk = true;
    for (const [categoryId, sortOrder] of entries) {
      try {
        const res = await fetch("/api/admin/categories", {
          method: "PUT", headers: authHeaders,
          body: JSON.stringify({ categoryId, sortOrder }),
        });
        const data = await res.json();
        if (!data.success) allOk = false;
      } catch { allOk = false; }
    }
    if (allOk) { showSuccessAndSync("排序已保存"); setPendingSortOrders({}); loadCategories(); }
    else { showMessage("error", "部分排序保存失败"); loadCategories(); }
  };

  // 保存智能体排序号
  const handleSaveAgentSortOrders = async () => {
    if (hasAgentSearchQuery || agentSortSavingRef.current) return;
    const ids = Object.keys(pendingAgentSortOrders);
    if (ids.length === 0) return;
    const byId = new Map(agents.map((agent) => [agent.id, agent]));
    const snapshots = pendingAgentRevisionsRef.current;
    if (ids.some((id) => !byId.has(id) || !snapshots[id] || byId.get(id)?.category !== snapshots[id].category)) {
      showMessage("error", "分类或列表已变化，请放弃草稿并刷新后重新排序。");
      return;
    }
    // Each affected storage category is submitted in full; the server verifies
    // completeness and revisions atomically, including rows not visible here.
    const entries = ids.sort((a, b) => pendingAgentSortOrders[a] - pendingAgentSortOrders[b])
      .map((id) => ({ id, expected_revision: snapshots[id].revision }));
    agentSortSavingRef.current = true;
    setAgentSortSaving(true);
    try {
      const res = await fetch("/api/admin/agents/reorder", {
        method: "PUT", headers: { ...authHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ agents: entries }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.success) {
        const fallback = res.status === 409 ? "排序或分类已被其他操作更改，请放弃草稿、刷新后重排。" : "排序保存失败，请稍后重试。";
        showMessage("error", `${data.error || fallback}${res.status === 409 ? " 请放弃草稿并刷新后重新排序。" : ""}`);
        return;
      }
      pendingAgentRevisionsRef.current = {};
      setPendingAgentSortOrders({});
      const refreshed = await loadAgents();
      if (refreshed) showSuccessAndSync("智能体排序已保存");
      else showMessage("error", "排序已保存，但列表刷新失败，请手动刷新。");
    } catch {
      showMessage("error", "排序结果未确认，请刷新核对后再重新排序。");
    } finally {
      agentSortSavingRef.current = false;
      setAgentSortSaving(false);
    }
  };

  // 移动单个智能体到指定分类
  const handleMoveAgentToCategory = async (agentId: string, targetCategory: string) => {
    if (Object.keys(pendingAgentSortOrders).length > 0 || agentSortSavingRef.current) {
      showMessage("error", "请先保存或放弃当前排序，再迁移智能体。");
      return;
    }
    try {
      const agent = agents.find((item) => item.id === agentId);
      if (!agent) throw new Error("AGENT_NOT_FOUND");
      const res = await fetch("/api/admin/agents", {
        method: "PUT", headers: { ...authHeaders, "Content-Type": "application/json" },
        body: JSON.stringify(buildAgentMutationPayload(agent, { category: targetCategory })),
      });
      const data = await res.json();
      if (data.success) { showSuccessAndSync("智能体已迁移"); loadAgents(); loadCategories(); }
      else { showMessage("error", data.error || "迁移失败"); }
    } catch { showMessage("error", "迁移失败"); }
  };


  // 拖拽排序：在智能体列表中拖拽调整顺序
  // 获取过滤并排序后的智能体列表
  const getCategoryFilteredAgents = () => {
    let filtered = agents;
    if (selectedDisplayCategory) return agents.filter((agent) => displayCategory(agent) === selectedDisplayCategory);
    if (selectedCategoryId) {
      const cat = categories.find((c) => c.id === selectedCategoryId);
      if (cat) {
        filtered = agents.filter((a) => a.category === cat.name);
      }
    }
    return filtered;
  };
  const getFilteredAndSortedAgents = () => {
    const filtered = filterAdminAgents(getCategoryFilteredAgents(), agentSearchQuery, llmModels);
    // 按分类排序顺序 + 智能体排序号排序
    const catOrderMap = new Map(categories.map((c, i) => [c.name, i]));
    return [...filtered].sort((a, b) => {
      const catA = catOrderMap.get(a.category) ?? 999;
      const catB = catOrderMap.get(b.category) ?? 999;
      if (catA !== catB) return catA - catB;
      const orderA = pendingAgentSortOrders[a.id] !== undefined ? pendingAgentSortOrders[a.id] : (a.sort_order ?? 0);
      const orderB = pendingAgentSortOrders[b.id] !== undefined ? pendingAgentSortOrders[b.id] : (b.sort_order ?? 0);
      return orderA - orderB;
    });
  };
  const handleDragReorderAgent = async (draggedId: string, targetId: string, position: "before" | "after") => {
    if (!canDragAgentRows || draggedId === targetId) return;
    const dragged = agents.find((agent) => agent.id === draggedId);
    const target = agents.find((agent) => agent.id === targetId);
    if (!dragged || !target || dragged.category !== target.category) return;
    const reordered = agents.filter((agent) => agent.category === dragged.category)
      .sort((a, b) => (pendingAgentSortOrders[a.id] ?? a.sort_order ?? 0) - (pendingAgentSortOrders[b.id] ?? b.sort_order ?? 0));
    if (reordered.some((agent) => !Number.isSafeInteger(Number(agent.config_revision)) || Number(agent.config_revision) < 1)) {
      showMessage("error", "缺少有效配置版本，请刷新后重试。");
      return;
    }
    const snapshot = pendingAgentRevisionsRef.current;
    reordered.forEach((agent) => { if (!snapshot[agent.id]) snapshot[agent.id] = { revision: Number(agent.config_revision), category: agent.category }; });
    reordered.splice(reordered.findIndex((agent) => agent.id === draggedId), 1);
    const targetIdx = reordered.findIndex((agent) => agent.id === targetId);
    reordered.splice(targetIdx + (position === "after" ? 1 : 0), 0, dragged);
    // 按10递增分配sort_order
    const updates: Record<string, number> = {};
    reordered.forEach((a, i) => { updates[a.id] = (i + 1) * 10; });
    setPendingAgentSortOrders((prev) => ({ ...prev, ...updates }));
  };
const handleDeleteCategory = async () => {
    if (!deleteCategoryId) return;
    try {
      const params = migrateToCategory ? `&migrate_to=${encodeURIComponent(migrateToCategory)}` : "";
      const res = await fetch(`/api/admin/categories?id=${deleteCategoryId}${params}`, { method: "DELETE", headers: authHeaders });
      const data = await res.json();
      if (data.success) {
        showSuccessAndSync(migrateToCategory ? `分类已删除，智能体已迁移至"${migrateToCategory}"` : "分类已删除");
        setDeleteCategoryId(null); setMigrateToCategory("");
        loadCategories(); loadAgents();
      } else { showMessage("error", data.error || "删除失败"); }
    } catch { showMessage("error", "删除失败"); }
  };

  const handleMigrateAgents = async (fromCategory: string, toCategory: string) => {
    if (!toCategory || fromCategory === toCategory) return;
    try {
      const client_agents = agents.filter((a) => a.category === fromCategory);
      for (const agent of client_agents) {
        const res = await fetch("/api/admin/agents", {
          method: "PUT", headers: authHeaders,
          body: JSON.stringify(buildAgentMutationPayload(agent, { category: toCategory })),
        });
        if (!res.ok) throw new Error(res.status === 409 ? "AGENT_CONFIG_REVISION_CONFLICT" : "AGENT_MIGRATION_FAILED");
      }
      showSuccessAndSync(`已将 ${client_agents.length} 个智能体迁移至"${toCategory}"`);
      loadAgents(); loadCategories();
    } catch { showMessage("error", "迁移失败"); }
  };

  const runAdminWallet = async (kind: AdminWalletKind, payload: AdminWalletPayload) => {
    if (!canAdjustWallet) {
      if (hasWalletAdjustPermission) setUnlockDialogRequested(true);
      return false;
    }
    if (walletBusyRef.current) return false;
    walletBusyRef.current = true;
    setWalletBusy(true);
    try {
      const data = await submitAdminWalletRequest({ adminId: userInfo?.id || "", kind, payload, headers: authHeaders });
      showMessage("success", data.alreadyFulfilled === true
        ? "原操作已确认，没有重复入账"
        : data.notificationDelivery === "not_required"
          ? "余额核对完成，无需通知"
          : data.notificationDelivery === "not_requested"
            ? "入账完成；本次未向学员推送通知"
            : "入账完成，本次通知已推送到学员通知中心");
      await loadUsers();
      return true;
    } catch (error) {
      showMessage("error", error instanceof Error ? error.message : "操作结果尚未确认，请核对原操作");
      return false;
    } finally {
      try { setPendingWalletAttempts(readPendingAdminWalletAttempts(userInfo?.id || "")); }
      catch (error) { showMessage("error", error instanceof Error ? error.message : "余额操作记录无法读取"); }
      walletBusyRef.current = false;
      setWalletBusy(false);
    }
  };

  const handleRecharge = async () => {
    if (!rechargeUserId) { showMessage("error", "请选择学员"); return; }
    const targetUser = users.find((user) => user.id === rechargeUserId);
    if (isFixtureUser(targetUser)) { showMessage("error", "测试/验收账号禁止充值，请使用隔离测试库"); return; }
    if (!rechargeYuan || rechargeYuan <= 0) { showMessage("error", "充值金额必须大于0"); return; }
    const creditsPerYuan = Number(settings.credits_per_yuan) || 50;
    const creditAmount = rechargeYuan * creditsPerYuan;
    const totalCredits = creditAmount + bonusCredits;
    const desc = bonusCredits > 0
      ? `充值${rechargeYuan}元=${creditAmount}积分 + 赠送${bonusCredits}积分（合计${totalCredits}积分）`
      : `充值${rechargeYuan}元=${creditAmount}积分`;
    if (await runAdminWallet("credit_topup", { userId: rechargeUserId, amount: totalCredits, description: desc, notifyUser: rechargeNotifyUser })) {
      setRechargeUserId(""); setBonusCredits(0); setRechargeNotifyUser(false);
    }
  };

  const handleAdjustCredits = async () => {
    if (!adjustUserId) { showMessage("error", "请选择学员"); return; }
    const targetUser = users.find((user) => user.id === adjustUserId);
    if (isFixtureUser(targetUser)) { showMessage("error", "测试/验收账号禁止调整积分，请使用隔离测试库"); return; }
    if (await runAdminWallet("credit_set", { userId: adjustUserId, credits: adjustCredits, notifyUser: adjustNotifyUser })) {
      setAdjustUserId(""); setAdjustCredits(5000); setAdjustNotifyUser(false);
    }
  };

  const handleCashTopup = async () => {
    if (!cashTopupUserId) { showMessage("error", "请选择学员"); return; }
    const targetUser = users.find((user) => user.id === cashTopupUserId);
    if (isFixtureUser(targetUser)) { showMessage("error", "测试/验收账号禁止现金充值，请使用隔离测试库"); return; }
    if (cashTopupAmount <= 0) { showMessage("error", "请输入有效金额"); return; }
    if (await runAdminWallet("cash_topup", { userId: cashTopupUserId, amount: cashTopupAmount, description: `管理员充值 ¥${cashTopupAmount}`, notifyUser: cashNotifyUser })) {
      setCashTopupUserId(""); setCashTopupAmount(50); setCashNotifyUser(false);
    }
  };

  const loadUserTransactions = async (user: UserInfo) => {
    setViewingUserTransactions(user);
    setTransactionLoading(true);
    setTransactionData(null);
    setMemberUsageSummary(null);
    setMemberLifecycle(null);
    setLoginLogs([]);
    setTransactionTab(canViewBilling ? "lifecycle" : canViewMemberSecurity ? "login" : "all");
    setTransactionFilter("all");
    try {
      const billingPromise = canViewBilling
        ? fetch(`/api/admin/user-transactions?userId=${user.id}`, { headers: authHeaders })
        : Promise.resolve(null);
      const loginPromise = canViewMemberSecurity
        ? fetch(`/api/admin/login-logs?userId=${user.id}&pageSize=50`, { headers: authHeaders })
        : Promise.resolve(null);
      const lifecyclePromise = canViewBilling
        ? fetch(`/api/admin/users/lifecycle?userId=${user.id}`, { headers: authHeaders, cache: "no-store" })
        : Promise.resolve(null);
      const chatPromise = canViewMemberContent
        ? fetch(`/api/admin/user-chats?user_id=${user.id}&pageSize=1`, { headers: authHeaders })
        : Promise.resolve(null);
      const [billingResponse, loginResponse, chatResponse, lifecycleResponse] = await Promise.all([
        billingPromise,
        loginPromise,
        chatPromise,
        lifecyclePromise,
      ]);
      const [billingData, loginData, chatData, lifecycleData] = await Promise.all([
        billingResponse?.json().catch(() => ({})) || Promise.resolve({}),
        loginResponse?.json().catch(() => ({})) || Promise.resolve({}),
        chatResponse?.json().catch(() => ({})) || Promise.resolve({}),
        lifecycleResponse?.json().catch(() => ({})) || Promise.resolve({}),
      ]);
      if (billingResponse && (!billingResponse.ok || !billingData.success)) {
        showMessage("error", billingData.error || "资金档案加载失败");
      }
      const nextTransactionData = billingResponse?.ok && billingData.success
        ? billingData.data
        : { summary: {}, transactions: [], revenueSummary: {}, revenueRecords: [], videoRecords: [], dailyStats: [], paymentOrders: [] };
      if (canViewBilling && nextTransactionData.summary) {
        nextTransactionData.summary.creditBalance = user.credits;
        nextTransactionData.summary.cashBalance = user.cashBalance ?? user.cash_balance ?? 0;
      }
      setTransactionData(nextTransactionData);
      setLoginLogs(loginResponse?.ok ? (loginData.logs || loginData.data || []) : []);
      setMemberUsageSummary({
        login: loginResponse?.ok ? (loginData.summary || { total: 0, success: 0, failed: 0, today: 0 }) : { total: 0, success: 0, failed: 0, today: 0 },
        conversationCount: chatResponse?.ok ? Number(chatData.total || 0) : 0,
      });
      setMemberLifecycle(lifecycleResponse?.ok ? { events: lifecycleData.events || [], summary: lifecycleData.summary || {} } : { events: [] });
    } catch {
      showMessage("error", "网络错误");
    } finally {
      setTransactionLoading(false);
    }
  };

  const exportMemberReconciliation = async (user: UserInfo) => {
    if (!canExportBilling) {
      if (hasBillingExportPermission) setUnlockDialogRequested(true);
      return;
    }
    if (memberExportingId) return;
    setMemberExportingId(user.id);
    try {
      const params = new URLSearchParams({ format: "csv", userId: user.id });
      await downloadAdminReconciliation(`/api/admin/reconciliation/recharges?${params}`, token, `${user.name || "学员"}-充值对账.csv`);
      showMessage("success", `已下载 ${user.name || user.phone || "该学员"} 的全部充值对账记录`);
    } catch (error) {
      showMessage("error", error instanceof Error ? error.message : "会员充值对账下载失败");
    } finally {
      setMemberExportingId("");
    }
  };

  // 加载用户登录日志
  const loadLoginLogs = async (userId: string) => {
    if (!canViewMemberSecurity) return;
    setLoginLogsLoading(true);
    try {
      const res = await fetch(`/api/admin/login-logs?userId=${userId}&pageSize=50`, { headers: authHeaders });
      const data = await res.json();
      if (res.ok) {
        setLoginLogs(data.logs || data.data || []);
        setMemberUsageSummary((current) => ({
          login: data.summary || { total: 0, success: 0, failed: 0, today: 0 },
          conversationCount: current?.conversationCount || 0,
        }));
      }
    } catch {
      // 静默失败
    } finally {
      setLoginLogsLoading(false);
    }
  };

  const handleLogout = () => { safeLocalStorageRemove(STORAGE_KEYS.AUTH_TOKEN); safeLocalStorageRemove(STORAGE_KEYS.AUTH_USER); router.push("/"); };

  // 手动保存设置
  const saveSettings = async (
    scope: AdminPlatformSettingScope,
    showSuccess = true,
    fieldKeys: readonly (keyof PlatformSettings)[] = adminPlatformSettingKeysForScope(scope) as readonly (keyof PlatformSettings)[],
  ): Promise<boolean> => {
    const sourceSettings = settings;
    const theme = normalizeTheme(sourceSettings.theme);
    const s = {
      ...sourceSettings,
      theme,
      theme_mode: normalizePlatformThemeMode(theme, sourceSettings.theme_mode),
    };
    const scopedPayload = Object.fromEntries(
      fieldKeys
        .map((key) => [key, s[key]])
        .filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    );
    setSettingsSaving(true);
    try {
      const res = await fetch(`/api/settings/admin?scope=${scope}`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify(scopedPayload),
      });
      const receipt = await res.json().catch(() => ({})) as {
        success?: boolean;
        verifiedKeys?: string[];
        verification?: string;
        error?: string;
      };
      if (res.ok) {
        const verifiedKeys = new Set(Array.isArray(receipt.verifiedKeys) ? receipt.verifiedKeys : []);
        const expectedVerifiedKeys = Object.entries(scopedPayload)
          .filter(([key, value]) => (
            !ADMIN_SECRET_SETTING_FIELDS.has(key as keyof PlatformSettings)
            || !isBlankOrMaskedAdminSecret(value)
          ))
          .map(([key]) => key);
        const missingVerifiedKey = expectedVerifiedKeys.find((key) => !verifiedKeys.has(key));
        if (receipt.success !== true || receipt.verification !== "database-readback" || missingVerifiedKey) {
          showMessage("error", missingVerifiedKey
            ? `保存回执缺少 ${missingVerifiedKey} 的数据库确认，请刷新后重试`
            : "保存回执未通过数据库读回确认，请刷新后重试");
          return false;
        }
        const savedFieldValues = Object.fromEntries(fieldKeys.map((key) => [
          key,
          ADMIN_SECRET_SETTING_FIELDS.has(key) ? "" : s[key],
        ])) as Partial<PlatformSettings>;
        setSettings((current) => ({
          ...current,
          ...savedFieldValues,
          ...(scope === "brand" ? { theme: s.theme, theme_mode: s.theme_mode } : {}),
          ...(scope === "integrations" ? {
            ...(fieldKeys.includes("coze_api_token") ? {
              coze_api_token: "",
              coze_api_token_configured: Boolean(s.coze_api_token.trim()) || current.coze_api_token_configured,
            } : {}),
            ...(fieldKeys.includes("coze_coding_api_token") ? {
              coze_coding_api_token: "",
              coze_coding_api_token_configured: Boolean(s.coze_coding_api_token.trim()) || current.coze_coding_api_token_configured,
            } : {}),
            ...(fieldKeys.includes("extract_api_token") ? {
              extract_api_token: "",
              extract_api_token_configured: Boolean(s.extract_api_token.trim()) || current.extract_api_token_configured,
            } : {}),
            ...(fieldKeys.includes("email_smtp_pass") ? {
              email_smtp_pass: "",
              email_smtp_pass_configured: Boolean(s.email_smtp_pass.trim()) || current.email_smtp_pass_configured,
            } : {}),
          } : {}),
          ...(scope === "models" ? {
            ...(fieldKeys.includes("cover_workflow_token") ? {
              cover_workflow_token: "",
              cover_workflow_token_configured: Boolean(s.cover_workflow_token.trim()) || current.cover_workflow_token_configured,
            } : {}),
            ...(fieldKeys.includes("thinking_model_api_key") ? {
              thinking_model_api_key: "",
              thinking_model_api_key_configured: Boolean(s.thinking_model_api_key.trim()) || current.thinking_model_api_key_configured,
            } : {}),
          } : {}),
        }));
        setSettingsBaseline((current) => ({ ...current, ...savedFieldValues }));
        if (scope === "brand") {
          applyThemeColorSettings(s);
          safeLocalStorageSet(STORAGE_KEYS.PLATFORM_THEME, s.theme);
          safeLocalStorageSet(STORAGE_KEYS.PLATFORM_THEME_MODE, s.theme_mode);
          previewPlatformAppearance(s.theme, s.theme_mode);
          invalidateClientBootstrapAppearance();
          window.dispatchEvent(new Event("theme-updated"));
        }
        if (showSuccess) showSuccessAndSync("设置已保存，并已完成数据库读回确认");
        return true;
      } else {
        showMessage("error", receipt.error || "保存失败");
        return false;
      }
    } catch {
      showMessage("error", "保存失败");
      return false;
    }
    finally { setSettingsSaving(false); }
  };

  const pushDefaultTheme = async (pending?: { theme: string; themeMode: ThemeModePreference }) => {
    const theme = normalizeTheme(pending?.theme || settings.theme);
    const themeMode = normalizePlatformThemeMode(theme, pending?.themeMode || settings.theme_mode);
    const themeName = ADMIN_THEME_OPTIONS.find((item) => item.id === theme)?.name || theme;
    if (!canManageBrandSettings) {
      pendingThemePublishRef.current = { theme, themeMode };
      setUnlockDialogRequested(true);
      showMessage("success", "完成安全验证后将自动发布所选主题");
      return;
    }
    pendingThemePublishRef.current = null;
    setThemePushing(true);
    try {
      const res = await fetch("/api/settings/admin?scope=brand", {
        method: "POST",
        headers: { ...authHeaders, "Idempotency-Key": crypto.randomUUID() },
        cache: "no-store",
        body: JSON.stringify({ theme, theme_mode: themeMode }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        showMessage("error", data.error || "默认主题推送失败");
        return;
      }

      const receiptTheme = normalizeTheme(data.settings?.theme);
      const receiptMode = normalizeThemeModePreference(data.settings?.theme_mode);
      if (receiptTheme !== theme || receiptMode !== themeMode) {
        showMessage("error", "主题写入回执不一致，未标记为已发布");
        return;
      }

      const publicResponse = await fetch(`/api/settings/appearance?published_at=${encodeURIComponent(data.publishedAt || "")}`, {
        cache: "no-store",
        headers: { "Cache-Control": "no-cache" },
      });
      const publicAppearance = await publicResponse.json().catch(() => ({}));
      const publicTheme = normalizeTheme(publicAppearance.settings?.theme);
      const publicMode = normalizeThemeModePreference(publicAppearance.settings?.theme_mode);
      if (
        !publicResponse.ok
        || publicAppearance.authority?.authoritative !== true
        || publicTheme !== theme
        || publicMode !== themeMode
      ) {
        showMessage("error", "主题已写入，但公共启动配置读回未确认，请刷新后重试");
        return;
      }

      setSettings((current) => ({ ...current, theme, theme_mode: themeMode }));
      setSettingsBaseline((current) => ({ ...current, theme, theme_mode: themeMode }));
      setPushedPlatformTheme(theme);
      setPushedPlatformThemeMode(themeMode);
      safeLocalStorageSet(STORAGE_KEYS.PLATFORM_THEME, theme);
      safeLocalStorageSet(STORAGE_KEYS.PLATFORM_THEME_MODE, themeMode);
      previewPlatformAppearance(theme, themeMode);
      invalidateClientBootstrapAppearance();
      window.dispatchEvent(new Event("theme-updated"));
      showSuccessAndSync(`“${themeName}”已发布并通过全站读回校验`);
    } catch {
      showMessage("error", "默认主题推送失败");
    } finally {
      setThemePushing(false);
    }
  };
  useEffect(() => {
    const pending = pendingThemePublishRef.current;
    if (!pending || !sensitiveUnlocked || !canManageBrandSettings || themePushing) return;
    pendingThemePublishRef.current = null;
    void pushDefaultTheme(pending);
  // Run once after the authoritative step-up state changes. Later renders see
  // a cleared ref, so an unlocked refresh never replays an earlier publish.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canManageBrandSettings, sensitiveUnlocked]);
  const updateSetting = (key: keyof PlatformSettings, value: string) => {
    setSettings({ ...settings, [key]: value });
  };

  const activeTabAllowed = visibleAdminTabSet.has(activeTab);

  if (loading) {
    return (
      <div
        className="admin-light-shell min-h-screen flex items-center justify-center bg-[var(--background)]"
        data-admin-theme="soft-white"
        data-theme="soft-white"
        data-mode="light"
      >
        <div className="text-[var(--muted-foreground)]">加载中...</div>
      </div>
    );
  }

  return (
    <div
      className="admin-light-shell flex h-screen min-w-0 flex-col bg-[#f5f7fa] text-[#172033]"
      data-admin-theme="soft-white"
      data-theme="soft-white"
      data-mode="light"
    >
      {token && (
        <AdminMaintenanceModeBanner
          token={token}
          state={adminAccess}
          onChanged={async () => { await loadAdminAccess(); }}
        />
      )}
      {/* Header */}
      <header className="shrink-0 border-b border-[#e4e7ec] bg-white px-4 py-3 sm:px-6">
        <div className="mx-auto flex w-full max-w-[1800px] flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex items-center gap-3">
              <div className="flex h-9 w-9 items-center justify-center overflow-hidden rounded-lg bg-[#071d58] shadow-sm">
                <img
                  src={platformLogoUrl}
                  alt=""
                  className="h-full w-full scale-[1.025] object-cover"
                  onError={(event) => {
                    event.currentTarget.onerror = null;
                    event.currentTarget.src = DEFAULT_PLATFORM_LOGO_URL;
                  }}
                />
              </div>
              <div><h1 className="text-lg font-bold text-[#172033]">管理后台</h1><p className="text-xs text-[#667085]">平台配置与业务运营</p></div>
          </div>
          <div className="flex flex-wrap items-center gap-2 sm:gap-3">
            {/* 全局后台操作 */}
            {canViewBilling && (
              <Link
                href="/admin/extraction-reconciliation"
                className="inline-flex h-10 items-center gap-2 rounded-lg border border-[#d0d5dd] bg-white px-3 text-sm font-bold text-[#344054] transition-colors hover:border-[#98a2b3] hover:bg-[#f9fafb]"
              >
                <FileText className="h-4 w-4 text-[#079455]" />
                提取异常对账
              </Link>
            )}
            {token && adminAccess && hasGrantedStepUpCapability && (
              <AdminSensitiveUnlockControl
                token={token}
                state={adminAccess}
                onChanged={async () => { await loadAdminAccess(); }}
                forceOpen={unlockDialogRequested}
                onForceOpenHandled={() => setUnlockDialogRequested(false)}
              />
            )}
            <button onClick={() => router.push("/")} className="rounded-lg border border-[var(--border)] px-3 py-2 text-sm font-medium text-[var(--foreground)] transition-colors hover:border-[var(--primary)] hover:text-[var(--primary)]">返回工作台</button>
            <span className="max-w-40 truncate px-1 text-sm font-medium text-[var(--secondary-foreground)]" title={userInfo?.displayName || userInfo?.name}>{userInfo?.displayName || userInfo?.name}</span>
            {hasUnsavedAdminSettings && (
              <span className="rounded-full border border-amber-200 bg-amber-50 px-3 py-1.5 text-xs font-bold text-amber-800" title={`${settingsDirtyKeys.length} 项设置尚未保存`}>
                {settingsDirtyKeys.length} 项未保存
              </span>
            )}
            <button onClick={handleLogout} className="rounded-lg px-3 py-2 text-sm font-medium text-[var(--secondary-foreground)] transition-colors hover:bg-[var(--destructive)]/10 hover:text-[var(--destructive)]">退出</button>
          </div>
        </div>
      </header>

      {/* Toast */}
      {message && (
        <div
          role={message.type === "success" ? "status" : "alert"}
          aria-live={message.type === "success" ? "polite" : "assertive"}
          data-testid="admin-operation-toast"
          className={`fixed top-4 right-4 z-[260] px-6 py-3 rounded-xl shadow-lg text-sm font-medium ${message.type === "success" ? "bg-[var(--primary)] text-[var(--background)]" : "bg-[var(--destructive)] text-[var(--foreground)]"}`}
        >
          {message.text}
        </div>
      )}

      <div className="flex min-h-0 flex-1 overflow-hidden bg-[#f5f7fa]">
        <aside className="hidden w-[236px] shrink-0 flex-col border-r border-[#e4e7ec] bg-white lg:flex">
          <div className="border-b border-[#eaecf0] px-5 py-4">
            <p className="text-sm font-bold text-[#172033]">后台功能</p>
            <p className="mt-1 text-xs text-[#667085]">核心功能直接进入</p>
          </div>
          <nav aria-label="管理后台一级导航" className="flex-1 overflow-y-auto px-3 py-4">
            <div className="space-y-1">
              {ADMIN_PRIMARY_NAVIGATION.map((module) => {
                const allowedTabs = module.tabs.filter((tabKey) => visibleAdminTabSet.has(tabKey));
                const targetTab = allowedTabs[0];
                if (!targetTab) return null;
                const tab = ADMIN_TABS_BY_KEY.get(targetTab);
                if (!tab) return null;
                const selected = allowedTabs.includes(activeTab);
                const label = targetTab === module.root
                  ? module.title
                  : (ADMIN_SECONDARY_LABELS[targetTab] || tab.label);
                return (
                  <button
                    key={targetTab}
                    type="button"
                    onClick={() => openAdminTab(targetTab)}
                    aria-current={selected ? "page" : undefined}
                    title={label}
                    data-testid={`admin-primary-nav-${targetTab}`}
                    className={`flex min-h-11 w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm font-semibold transition-colors ${selected ? "bg-[#eaf2ff] text-[#175cd3]" : "text-[#475467] hover:bg-[#f2f4f7] hover:text-[#172033]"}`}
                  >
                    <svg className="h-4 w-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={tab.icon} /></svg>
                    <span className="truncate">{label}</span>
                  </button>
                );
              })}
            </div>
          </nav>
        </aside>

        <main className="min-w-0 flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-[1680px] px-4 py-4 sm:px-6 sm:py-6 lg:px-8">
            <nav aria-label="移动端管理后台功能导航" className="mb-4 flex gap-2 overflow-x-auto border-b border-[#e4e7ec] bg-white p-2 lg:hidden">
              {ADMIN_PRIMARY_NAVIGATION.map((module) => {
                const allowedTabs = module.tabs.filter((tabKey) => visibleAdminTabSet.has(tabKey));
                const targetTab = allowedTabs[0];
                if (!targetTab) return null;
                const tab = ADMIN_TABS_BY_KEY.get(targetTab);
                if (!tab) return null;
                const selected = allowedTabs.includes(activeTab);
                const label = targetTab === module.root
                  ? module.title
                  : (ADMIN_SECONDARY_LABELS[targetTab] || tab.label);
                return <button key={targetTab} type="button" onClick={() => openAdminTab(targetTab)} aria-current={selected ? "page" : undefined} className={`shrink-0 rounded-md px-3 py-2 text-sm font-semibold ${selected ? "bg-[#eaf2ff] text-[#175cd3]" : "text-[#475467]"}`}>{label}</button>;
              })}
            </nav>

            {(() => {
              const activeModule = adminModuleForTab(activeTab);
              const allowedTabs = activeModule?.tabs.filter((tabKey) => visibleAdminTabSet.has(tabKey)) || [];
              if (!activeModule || allowedTabs.length <= 1) return null;
              return (
                <div className="mb-5 rounded-2xl border border-[var(--border)] bg-[var(--card)] p-2 shadow-sm" data-testid={`admin-module-${activeModule.root}`}>
                  <div className="flex flex-wrap items-center gap-2">
                    {visibleAdminTabSet.has(activeModule.root) && (
                      <>
                        <span className="px-2 text-xs font-black text-[var(--foreground)]">{activeModule.title}</span>
                        <span className="h-5 w-px bg-[var(--border)]" />
                      </>
                    )}
                    {allowedTabs.map((tabKey) => {
                      const tab = ADMIN_TABS_BY_KEY.get(tabKey);
                      if (!tab) return null;
                      return (
                        <button key={tabKey} type="button" onClick={() => openAdminTab(tabKey)} aria-current={activeTab === tabKey ? "page" : undefined} className={`rounded-xl px-3 py-2 text-sm font-semibold transition-colors ${activeTab === tabKey ? "bg-[var(--primary)] text-[var(--primary-foreground)]" : "text-[var(--secondary-foreground)] hover:bg-[var(--muted)]"}`}>
                          {ADMIN_SECONDARY_LABELS[tabKey] || tab.label}
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            })()}

        {!activeTabAllowed ? (
          <section data-testid="admin-access-empty" className="rounded-2xl border border-[#eaecf0] bg-white p-8 shadow-sm">
            <div className="mx-auto max-w-2xl text-center">
              <p className="text-sm leading-6 text-[#667085]">
                {firstAllowedTab ? "正在打开可用后台页面…" : "当前账号暂无可用后台页面。"}
              </p>
            </div>
          </section>
        ) : (
          <>
        {activeTab === "super-admin" && token && adminAccess && (
          <SuperAdminGovernancePanel
            token={token}
            state={adminAccess}
            onRequestUnlock={() => setUnlockDialogRequested(true)}
            onAccessChanged={async () => { await loadAdminAccess(); }}
          />
        )}

        {/* ========= Platform Command Center ========= */}
        {activeTab === "dashboard" && (
          <div className="min-w-0" data-testid="admin-command-center-surface">
            <CommandCenterPanel token={token} allowedViews={allowedCommandCenterViews} allowedAdminTabs={visibleAdminTabs} />
          </div>
        )}
        {/* ========= Agents Tab ========= */}
        {activeTab === "agents" && (
          <div>
            {grantedPermissionKeys.has("prompts.view") && !canReadPrompts ? (
              <div data-testid="admin-protected-content-locked" className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
                <span><span className="font-bold">受保护内容仍处于锁定状态。</span> 完成安全验证后才会读取。</span>
                <button type="button" onClick={() => setUnlockDialogRequested(true)} className="rounded-lg bg-amber-700 px-3 py-2 text-xs font-bold text-white">验证密码并读取</button>
              </div>
            ) : canReadPrompts ? (
              <div data-testid={adminAccess?.maintenanceLock.enabled ? "admin-prompt-access-maintenance" : "admin-prompt-access-ready"} className={`mb-5 rounded-xl border px-4 py-3 text-sm ${adminAccess?.maintenanceLock.enabled ? "border-amber-300 bg-amber-50 text-amber-900" : "border-emerald-200 bg-emerald-50 text-emerald-800"}`}>
                {adminAccess?.maintenanceLock.enabled
                  ? "维护模式放行：你仍须具备 prompts.view 权限；本次只暂停二次密码验证，查看行为继续写入审计。"
                  : "内部提示词已临时解锁；查看与修改会写入管理员审计日志，解锁到期后自动停止返回内容。"}
              </div>
            ) : null}
            {/* Category Management */}
            <div className="mb-5">
              <h2 className="mb-1 text-lg font-semibold text-[var(--foreground)]">前台展示分类</h2>
              <p className="mb-3 text-xs text-[var(--muted-foreground)]">与应用广场使用同一分类；这里只筛选展示，原始分类和权限不随之改变。前台分类筛选期间暂停排序。</p>
              <div className="flex flex-wrap gap-2">
                {[BIP_CATEGORY, ...TASK_CATEGORIES.map((category) => category.key), ...new Set(agents.map((agent) => displayCategory(agent)).filter((key) => key !== BIP_CATEGORY && !TASK_CATEGORIES.some((category) => category.key === key)))].map((key) => (
                  <button key={key} type="button" onClick={() => { setSelectedCategoryId(null); setSelectedDisplayCategory((current) => current === key ? null : key); }}
                    className={`rounded-lg border px-3 py-2 text-sm ${selectedDisplayCategory === key ? "border-[var(--primary)] bg-[var(--primary)]/10 text-[var(--primary)]" : "border-[var(--border)] bg-[var(--card)] text-[var(--foreground)]"}`}>
                    {adminDisplayCategoryLabel(key)} <span className="text-xs text-[var(--muted-foreground)]">{agents.filter((agent) => displayCategory(agent) === key).length}</span>
                  </button>
                ))}
              </div>
            </div>
            <div className="mb-6">
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-lg font-semibold text-[var(--foreground)]">原始分类管理 ({categories.length})</h2>
                {canManageInternalTools && <div className="flex items-center gap-2">
                  {Object.keys(pendingSortOrders).length > 0 && (
                    <button onClick={handleSaveSortOrders} className="px-4 py-1.5 bg-blue-500 hover:bg-blue-600 text-white rounded-md text-sm font-medium transition-colors shadow-sm">
                      保存排序
                    </button>
                  )}
                  <input value={newCategoryName} onChange={(e) => setNewCategoryName(e.target.value)} className={`${inputCls} w-40`} placeholder="新分类名称" />
                  <input value={newCategoryIcon} onChange={(e) => setNewCategoryIcon(e.target.value)} className={`${inputCls} w-20`} placeholder="图标" />
                  <button onClick={handleAddCategory} className={btnPrimary}>添加</button>
                </div>}
              </div>
              {/* 四宫格分类卡片 — 点击切换过滤智能体列表 + 支持拖拽智能体迁移 */}
              <div className="grid grid-cols-3 md:grid-cols-6 gap-3">
                {/* "全部"卡片 */}
                <div
                  className={`bg-[var(--card)] border rounded-xl p-3 transition-all cursor-pointer select-none ${
                    selectedCategoryId === null && selectedDisplayCategory === null
                      ? "border-[var(--primary)] ring-2 ring-[var(--primary)]/20 shadow-md shadow-[var(--primary)]/10"
                      : "border-[var(--border)] hover:border-[var(--primary)]/50 hover:shadow-sm"
                  }`}
                  onClick={() => { setSelectedCategoryId(null); setSelectedDisplayCategory(null); }}
                >
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-base">📋</span>
                    <span className="text-sm font-semibold text-[var(--foreground)]">全部</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] text-[var(--muted-foreground)]">{agents.length}个</span>
                  </div>
                </div>
                {categories.map((cat) => {
                  const isSelected = selectedCategoryId === cat.id;
                  const isDragOver = dragOverCategoryId === cat.id;
                  const catAgentCount = agents.filter(a => a.category === cat.name).length;
                  return (
                    <div
                      key={cat.id}
                      className={`relative bg-[var(--card)] border rounded-xl p-3 group transition-all cursor-pointer select-none ${
                        isSelected
                          ? "border-[var(--primary)] ring-2 ring-[var(--primary)]/20 shadow-md shadow-[var(--primary)]/10"
                          : isDragOver
                            ? "border-[var(--primary)] ring-2 ring-[var(--primary)]/40 bg-[var(--primary)]/5 shadow-lg shadow-[var(--primary)]/20 scale-[1.02]"
                            : "border-[var(--border)] hover:border-[var(--primary)]/50 hover:shadow-sm"
                      }`}
                      onClick={() => { setSelectedDisplayCategory(null); setSelectedCategoryId(isSelected ? null : cat.id); }}
                      onDragOver={(e) => { if (!canDragAgentRows) return; e.preventDefault(); e.dataTransfer.dropEffect = "move"; setDragOverCategoryId(cat.id); }}
                      onDragLeave={() => setDragOverCategoryId(null)}
                      onDrop={async (e) => {
                        if (!canDragAgentRows) return;
                        e.preventDefault();
                        setDragOverCategoryId(null);
                        const agentId = e.dataTransfer.getData("agent-id");
                        const agentCat = e.dataTransfer.getData("agent-category");
                        if (agentId && agentCat !== cat.name) {
                          await handleMoveAgentToCategory(agentId, cat.name);
                        }
                      }}
                    >
                      {/* 拖拽提示覆盖层 */}
                      {isDragOver && (
                        <div className="absolute inset-0 rounded-xl bg-[var(--primary)]/10 flex items-center justify-center z-10 pointer-events-none">
                          <span className="text-xs font-semibold text-[var(--primary)] bg-[var(--card)]/90 px-3 py-1.5 rounded-lg shadow">释放以迁移到此分类</span>
                        </div>
                      )}
                      {/* 第一行：排序号 + 图标 + 名称 + 编辑图标 */}
                      <div className="flex items-center gap-1.5 mb-2">
                        {canManageInternalTools && <div className="flex items-center gap-0.5">
                          <input
                            type="number"
                            min={1}
                            value={pendingSortOrders[cat.id] !== undefined ? pendingSortOrders[cat.id] : (cat.sort_order ?? 0)}
                            onChange={(e) => {
                              const v = parseInt(e.target.value);
                              if (!isNaN(v)) {
                                setPendingSortOrders(prev => ({ ...prev, [cat.id]: v }));
                              }
                            }}
                            className={`w-8 text-center text-[10px] bg-[var(--background)] border rounded px-0.5 py-0.5 transition-colors ${pendingSortOrders[cat.id] !== undefined ? "border-[var(--primary)] text-[var(--primary)]" : "border-[var(--border)] text-[var(--muted-foreground)]"}`}
                            title="排序号（越小越靠前）"
                            onClick={(e) => e.stopPropagation()}
                          />
                        </div>}
                        {canManageInternalTools && editingCategoryId === cat.id ? (
                          <div className="flex items-center gap-1 flex-1 min-w-0">
                            <input value={editingCategoryIcon} onChange={(e) => setEditingCategoryIcon(e.target.value)} className="w-8 text-center bg-[var(--background)] border border-[var(--border)] rounded px-0.5 py-0.5 text-sm text-[var(--foreground)]" onClick={(e) => e.stopPropagation()} />
                            <input value={editingCategoryName} onChange={(e) => setEditingCategoryName(e.target.value)} className="flex-1 min-w-0 bg-[var(--background)] border border-[var(--border)] rounded px-1 py-0.5 text-xs text-[var(--foreground)]" autoFocus onClick={(e) => e.stopPropagation()} />
                            <button onClick={(e) => { e.stopPropagation(); handleUpdateCategory(cat.id); }} className="text-[var(--success)] text-[10px] hover:underline shrink-0">保存</button>
                            <button onClick={(e) => { e.stopPropagation(); setEditingCategoryId(null); }} className="text-[var(--muted-foreground)] text-[10px] hover:underline shrink-0">取消</button>
                          </div>
                        ) : (
                          <>
                            <span className="text-lg leading-none">{cat.icon || "📌"}</span>
                            <span className="text-sm text-[var(--foreground)] font-medium truncate flex-1">{cat.name}</span>
                            {/* 编辑图标按钮 */}
                            {canManageInternalTools && <button
                              onClick={(e) => { e.stopPropagation(); setEditingCategoryId(cat.id); setEditingCategoryName(cat.name); setEditingCategoryIcon(cat.icon); }}
                              className="shrink-0 w-6 h-6 flex items-center justify-center rounded-md text-[var(--muted-foreground)] hover:text-[var(--primary)] hover:bg-[var(--primary)]/10 transition-all opacity-0 group-hover:opacity-100"
                              title="编辑分类"
                            >
                              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg>
                            </button>}
                          </>
                        )}
                      </div>
                      {/* 第二行：数量 + 可见性标签 + 操作按钮 */}
                      {editingCategoryId !== cat.id && (
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-1">
                            <span className="text-[10px] text-[var(--muted-foreground)]">{catAgentCount}个</span>
                            {cat.visibility === "view_only" && (
                              <span className="text-[9px] px-1.5 py-0 rounded-full bg-blue-500/15 text-blue-500">展示</span>
                            )}
                            {cat.visibility === "private" && (
                              <span className="text-[9px] px-1.5 py-0 rounded-full bg-gray-500/15 text-gray-500">私有</span>
                            )}
                          </div>
                          {canManageInternalTools && <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity" onClick={(e) => e.stopPropagation()}>
                            <select
                              value={cat.visibility || "normal"}
                              onChange={async (e) => {
                                const res = await fetch("/api/admin/categories", {
                                  method: "PUT",
                                  headers: { "Content-Type": "application/json", ...authHeaders },
                                  body: JSON.stringify({ categoryId: cat.id, visibility: e.target.value }),
                                });
                                if (res.ok) { showSuccessAndSync("可见性已更新"); loadCategories(); }
                                else { const data = await res.json(); showMessage("error", data.error || "更新失败"); }
                              }}
                              className="text-[9px] border border-[var(--border)] rounded px-0.5 py-0 bg-[var(--background)] text-[var(--foreground)]"
                            >
                              <option value="normal">正常</option>
                              <option value="view_only">仅展示</option>
                              <option value="private">私有</option>
                            </select>
                            <button onClick={() => setDeleteCategoryId(cat.id)} className="text-[10px] text-[var(--destructive)] hover:underline px-0.5">删除</button>
                          </div>}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
              {/* Delete confirmation dialog */}
              {canManageInternalTools && deleteCategoryId && (() => {
                const cat = categories.find((c) => c.id === deleteCategoryId);
                if (!cat) return null;
                const otherCats = categories.filter((c) => c.id !== deleteCategoryId);
                return (
                  <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
                    <div className="bg-[var(--card)] border border-[var(--border)] rounded-2xl p-6 w-96">
                      <h3 className="text-[var(--foreground)] font-semibold mb-2">删除分类"{cat.name}"</h3>
                      <p className="text-sm text-[var(--secondary-foreground)] mb-4">该分类下有 {cat.agent_count ?? 0} 个智能体，请选择迁移方式：</p>
                      <div className="space-y-3 mb-4">
                        <div>
                          <label className="text-xs text-[var(--secondary-foreground)] mb-1 block">迁移到分类：</label>
                          <select value={migrateToCategory} onChange={(e) => setMigrateToCategory(e.target.value)} className={inputCls}>
                            <option value="">直接删除（智能体分类置空）</option>
                            {otherCats.map((c) => <option key={c.id} value={c.name}>{c.icon} {c.name}</option>)}
                          </select>
                        </div>
                      </div>
                      <div className="flex gap-3">
                        <button onClick={handleDeleteCategory} className="px-4 py-2 bg-[var(--destructive)] text-[var(--foreground)] rounded-xl text-sm font-semibold hover:bg-[#FF6B6B] transition-colors">确认删除</button>
                        <button onClick={() => setDeleteCategoryId(null)} className={btnGhost}>取消</button>
                      </div>
                    </div>
                  </div>
                );
              })()}
            </div>

            {/* Agent List */}
            <div className="flex items-center justify-between mb-2">
              <h2 className="text-lg font-semibold text-[var(--foreground)]">智能体列表 ({getFilteredAndSortedAgents().length}{selectedCategoryId || selectedDisplayCategory || hasAgentSearchQuery ? ` / ${agents.length}` : ""})</h2>
              {canManageAgentConfiguration && <div className="flex items-center gap-2">
                <button
                  onClick={handleImportCoze}
                  disabled={importCozeLoading}
                  className="px-3 py-1.5 text-xs rounded-lg bg-[var(--brand)]/20 text-[var(--brand)] border border-[var(--brand)]/30 hover:bg-[var(--brand)]/30 transition-colors disabled:opacity-50"
                >
                  {importCozeLoading ? '导入中...' : '从Coze导入'}
                </button>
                <button
                  onClick={handleHealthCheck}
                  disabled={healthChecking}
                  className="px-3 py-1.5 text-xs rounded-lg bg-emerald-500/20 text-emerald-600 border border-emerald-500/30 hover:bg-emerald-500/30 transition-colors disabled:opacity-50"
                >
                  {healthChecking ? '检测中...' : '一键检测'}
                </button>
                <button onClick={() => { setShowAddAgent(true); loadLlmModels(); loadDrawingModels(); }} className={btnPrimary}>+ 添加智能体</button>
                {/* 明确范围并二次确认的头像生成 */}
                <div className="flex items-center gap-1.5">
                  <input
                    value={batchAvatarCustomPrompt}
                    onChange={(e) => setBatchAvatarCustomPrompt(e.target.value)}
                    placeholder="头像风格描述（可选）"
                    className="px-2 py-1.5 text-xs rounded-lg bg-[var(--background)] border border-[var(--border)] text-[var(--foreground)] w-32 placeholder:text-[var(--muted-foreground)]"
                  />
                  <select
                    value={batchAvatarStyle}
                    onChange={(e) => setBatchAvatarStyle(e.target.value)}
                    className="px-2 py-1.5 text-xs rounded-lg bg-[var(--background)] border border-[var(--border)] text-[var(--foreground)]"
                  >
                    {AVATAR_STYLES.map(s => <option key={s} value={s}>{s}</option>)}
                  </select>
                  <button
                    onClick={handleBatchAvatar}
                    disabled={batchAvatarLoading}
                    className="px-3 py-1.5 text-xs rounded-lg bg-[var(--accent)] text-[var(--secondary-foreground)] border border-[var(--border)] hover:bg-[var(--border)] transition-colors disabled:opacity-50"
                  >
                    {batchAvatarLoading ? (batchAvatarProgress ? `生成中 ${batchAvatarProgress.current}/${batchAvatarProgress.total}...` : '生成中...') : '生成缺失头像（最多20）'}
                  </button>
                </div>
              </div>}
            </div>
            <div className="mb-4 flex items-center gap-3 text-xs text-[var(--muted-foreground)]">
              {selectedCategoryId || selectedDisplayCategory ? (
                <span className="text-[var(--primary)] font-medium">
                  {selectedDisplayCategory ? `前台分类: ${adminDisplayCategoryLabel(selectedDisplayCategory)}` : `原始分类: ${categories.find(c => c.id === selectedCategoryId)?.name || ''}`}
                  <button onClick={() => { setSelectedCategoryId(null); setSelectedDisplayCategory(null); }} className="ml-2 underline text-[var(--muted-foreground)] hover:text-[var(--foreground)]">查看全部</button>
                </span>
              ) : null}
              <span>编程智能体: {getFilteredAndSortedAgents().filter(a => a.source === 'coze_coding').length} 个</span>
              <span>平台智能体: {getFilteredAndSortedAgents().filter(a => a.source === 'coze').length} 个</span>
              <span>LLM: {getFilteredAndSortedAgents().filter(a => a.source === 'llm').length} 个</span>
            </div>
            {agentDataSource && <div role="status" className="mb-4 rounded-lg border border-[var(--border)] bg-[var(--card)] px-4 py-3 text-sm text-[var(--muted-foreground)]">
              <strong className="text-[var(--foreground)]">智能体配置：{agentDataSource.configuration === 'local-acceptance' ? '本地验收库' : agentDataSource.configuration === 'shared-cloud' ? '云端共享' : agentDataSource.configuration === 'cloud' ? '云端数据库' : '本地数据库'}</strong>
              {agentDataSource.configurationId && <span className="ml-3 font-mono text-xs">配置身份：{agentDataSource.configurationId}</span>}
              <span className="ml-3">{agentDataSource.configuration === 'local-acceptance' ? '配置与账号数据均隔离在本机验收库，刷新页面会读取最新配置。' : agentDataSource.configuration === 'shared-cloud' ? '模型绑定与分类配置保存到云端，重新打开卡片读取最新配置。' : '保存修改无需重新部署代码。'}</span>
              <p className="mt-1">账号、聊天与账单：{agentDataSource.businessData === 'local' ? '本地测试库；未与线上用户数据合并' : '云端数据库'}。</p>
            </div>}
            <AgentSearchToolbar
              value={agentSearchQuery}
              onChange={handleAgentSearchChange}
              matchedCount={getFilteredAndSortedAgents().length}
              scopeCount={getCategoryFilteredAgents().length}
              totalCount={agents.length}
              categoryName={selectedDisplayCategory ? adminDisplayCategoryLabel(selectedDisplayCategory) : categories.find((category) => category.id === selectedCategoryId)?.name}
              isSearching={hasAgentSearchQuery}
              showAvatarScopeHint={canManageAgentConfiguration}
              onRefresh={async () => {
                if (Object.keys(pendingAgentSortOrders).length > 0) { showMessage("error", "请先保存或放弃排序草稿再刷新。"); return; }
                if (!await loadAgents()) showMessage("error", "智能体列表刷新失败，请检查连接或权限后重试。");
              }}
            />
            {canReadPrompts && viewingPromptAgentId && (() => {
              const promptAgent = agents.find((agent) => agent.id === viewingPromptAgentId);
              if (!promptAgent) return null;
              return (
                <section data-testid="admin-agent-prompt-readonly" className="mb-4 rounded-xl border border-[#b2ddff] bg-[#eff8ff] p-4 text-[#101828]">
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <p className="text-xs font-black text-[#175cd3]">只读系统提示词 · {adminAccess?.maintenanceLock.enabled ? "维护模式放行" : "二次验证放行"}</p>
                      <h3 className="mt-1 text-base font-black">{promptAgent.name}</h3>
                    </div>
                    <button type="button" onClick={() => setViewingPromptAgentId("")} className="rounded-lg border border-[#84caff] bg-white px-3 py-1.5 text-xs font-bold text-[#175cd3]">关闭</button>
                  </div>
                  <pre className="mt-3 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-xl border border-[#b2ddff] bg-white p-4 text-xs leading-6 text-[#344054]">{promptAgent.system_prompt || "该智能体当前没有系统提示词。"}</pre>
                </section>
              );
            })()}
            {/* 一键检测结果 */}
            {healthResults !== null && (
              <div className={`${cardCls} mb-4`}>
                <div className="flex items-center justify-between mb-3">
                  <h3 className="font-semibold text-[var(--foreground)]">检测结果</h3>
                  <div className="flex items-center gap-3 text-xs">
                    <span className="text-emerald-600">正常: {healthResults.filter(r => r.status === 'healthy').length}</span>
                    <span className="text-red-500">异常: {healthResults.filter(r => r.status !== 'healthy').length}</span>
                    <button onClick={() => setHealthResults(null)} className="text-[var(--muted-foreground)] hover:text-[var(--foreground)]">关闭</button>
                  </div>
                </div>
                <div className="space-y-2 max-h-80 overflow-y-auto">
                  {healthResults.map((r, i) => (
                    <div key={i} className={`p-3 rounded-lg border text-xs ${
                      r.status === 'healthy' ? 'bg-emerald-500/5 border-emerald-500/20' :
                      r.status === 'timeout' ? 'bg-yellow-500/5 border-yellow-500/20' :
                      'bg-red-500/5 border-red-500/20'
                    }`}>
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <span className={`inline-block w-2 h-2 rounded-full ${
                            r.status === 'healthy' ? 'bg-emerald-500' :
                            r.status === 'timeout' ? 'bg-yellow-500' : 'bg-red-500'
                          }`} />
                          <span className="font-medium text-[var(--foreground)]">{r.agentName}</span>
                          <span className="text-[var(--muted-foreground)]">({r.source})</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="text-[var(--muted-foreground)]">{r.responseTime > 0 ? `${r.responseTime}ms` : '-'}</span>
                          <span className={`px-2 py-0.5 rounded text-xs font-medium ${
                            r.status === 'healthy' ? 'bg-emerald-500/20 text-emerald-600' :
                            r.status === 'timeout' ? 'bg-yellow-500/20 text-yellow-600' :
                            'bg-red-500/20 text-red-500'
                          }`}>
                            {r.status === 'healthy' ? '正常' : r.status === 'timeout' ? '超时' : '异常'}
                          </span>
                        </div>
                      </div>
                      {r.status === 'healthy' && r.reply && (
                        <p className="mt-1 text-[var(--muted-foreground)] truncate">{r.reply}</p>
                      )}
                      {r.status !== 'healthy' && r.error && (
                        <p className="mt-1 text-red-400">{r.error}</p>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
            {/* 批量头像生成结果 */}
            {(batchAvatarResults !== null && batchAvatarResults.length > 0) && (
              <div className={`${cardCls} mb-4`}>
                <div className="flex items-center justify-between mb-3">
                  <h3 className="font-semibold text-[var(--foreground)]">头像生成结果</h3>
                  <div className="flex items-center gap-3 text-xs">
                    <span className="text-emerald-600">成功: {batchAvatarResults.filter(r => r.success).length}</span>
                    <span className="text-red-500">失败: {batchAvatarResults.filter(r => !r.success).length}</span>
                    {batchAvatarLoading && batchAvatarProgress && (
                      <span className="text-violet-500">进度: {batchAvatarProgress.current}/{batchAvatarProgress.total}</span>
                    )}
                    <button onClick={() => { setBatchAvatarResults(null); setBatchAvatarProgress(null); }} className="text-[var(--muted-foreground)] hover:text-[var(--foreground)]">关闭</button>
                  </div>
                </div>
                <div className="grid grid-cols-4 md:grid-cols-6 lg:grid-cols-8 gap-3">
                  {batchAvatarResults.map((r, i) => (
                    <div key={i} className={`p-2 rounded-lg border text-center ${
                      r.success ? 'bg-emerald-500/5 border-emerald-500/20' : 'bg-red-500/5 border-red-500/20'
                    }`}>
                      {r.success && r.avatarUrl ? (
                        <div className="relative">
                          <img src={r.avatarUrl.startsWith("http") ? r.avatarUrl : `/api/avatars?key=${encodeURIComponent(r.avatarUrl)}`} alt={r.name} className="w-10 h-10 rounded-lg mx-auto mb-1 object-cover" />
                          {r.saved && <span className="absolute -top-1 -right-1 w-3 h-3 bg-emerald-500 rounded-full border border-white" title="已保存到数据库"></span>}
                        </div>
                      ) : (
                        <div className="w-10 h-10 rounded-lg mx-auto mb-1 bg-[var(--muted)]/30 flex items-center justify-center text-xs text-red-400">✕</div>
                      )}
                      <p className="text-[10px] text-[var(--foreground)] truncate" title={r.name}>{r.name}</p>
                      {!r.success && <p className="text-[9px] text-red-400 truncate" title={r.error}>{r.error}</p>}
                    </div>
                  ))}
                </div>
              </div>
            )}
            {showAddAgent && canManageAgentConfiguration && (
              <div className={`${cardCls} mb-4`}>
                <div className="flex items-center justify-between mb-4">
                  <h3 className="font-semibold text-[var(--foreground)]">新增应用</h3>
                  <button onClick={handleCancelAddAgent} className="text-[var(--muted-foreground)] hover:text-[var(--foreground)] transition-colors">
                    <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
                  </button>
                </div>
                <div className="space-y-4">
                  {/* 类型选择器 - 顶部标签页风格 */}
                  <div className="flex items-center gap-0 border-b border-[var(--border)] -mt-1">
                    <button
                      type="button"
                      onClick={() => { setAddAgentSource("llm"); setNewAgent({ ...newAgent, source: "llm" }); }}
                      className={`px-5 py-2.5 text-sm font-medium transition-all border-b-2 -mb-px ${addAgentSource === "llm" ? "border-[var(--foreground)] text-[var(--foreground)]" : "border-transparent text-[var(--muted-foreground)] hover:text-[var(--foreground)]"}`}
                    >
                      LLM 直连
                    </button>
                  </div>

                  {/* 第一行：App名称 + App状态 */}
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className={labelCls}>*App名称</label>
                      <input value={newAgent.name} onChange={(e) => setNewAgent({ ...newAgent, name: e.target.value })} className={inputCls} placeholder="请填写App名称" />
                    </div>
                    <div>
                      <label className={labelCls}>*App状态</label>
                      <div className="flex items-center gap-3 mt-2">
                        <button type="button" onClick={() => setNewAgent({ ...newAgent, isActive: !newAgent.isActive })}
                          className={`relative w-10 h-5 rounded-full transition-colors ${newAgent.isActive ? 'bg-[var(--primary)]' : 'bg-[var(--border)]'}`}>
                          <span className={`absolute top-0.5 ${newAgent.isActive ? 'left-5' : 'left-0.5'} w-4 h-4 rounded-full bg-white shadow transition-all`} />
                        </button>
                        <span className="text-xs text-[var(--muted-foreground)]">{newAgent.isActive ? '启用' : '停用'}</span>
                      </div>
                    </div>
                  </div>

                  {/* 排序ID */}
                  <div className="w-32">
                    <label className={labelCls}>排序ID</label>
                    <input type="number" value={newAgent.sortOrder} onChange={(e) => setNewAgent({ ...newAgent, sortOrder: Number(e.target.value) })} className={inputCls} placeholder="100" />
                  </div>

                  {/* App分类 - 标签式选择 */}
                  <div>
                    <label className={labelCls}>*App分类</label>
                    <div className="mt-1.5 flex flex-wrap gap-2">
                      {categories.map((c) => (
                        <button
                          key={c.id}
                          type="button"
                          onClick={() => setNewAgent({ ...newAgent, category: c.name })}
                          className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium transition-all ${
                            newAgent.category === c.name
                              ? 'bg-[var(--foreground)] text-[var(--background)] shadow-sm'
                              : 'bg-[var(--card)] text-[var(--foreground)] hover:bg-[var(--accent)] border border-[var(--border)]'
                          }`}
                        >
                          <span>{c.icon}</span>
                          <span>{c.name}</span>
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* App描述 */}
                  <div>
                    <label className={labelCls}>*App描述</label>
                    <textarea value={newAgent.description} onChange={(e) => setNewAgent({ ...newAgent, description: e.target.value })} className={inputCls + " min-h-[60px] resize-y"} rows={2} placeholder="请填写App介绍信息..." />
                  </div>

                  {/* 聊天引导语 */}
                  <div>
                    <label className={labelCls}>聊天引导语</label>
                    <textarea value={newAgent.guide_message || ""} onChange={(e) => setNewAgent({ ...newAgent, guide_message: e.target.value })} className={inputCls + " min-h-[80px] resize-y"} rows={4} placeholder="用户打开聊天时显示的引导语，介绍智能体功能并引导用户提问。如：我是XXX，我可以帮你…&#10;请告诉我：1. … 2. …" />
                    <p className="text-[10px] text-[var(--muted-foreground)] mt-0.5">支持 **加粗** 标记，换行请直接回车。留空则显示默认引导语</p>
                  </div>

                  {/* ========= 扣子编程专属配置 ========= */}
                  {addAgentSource === "coze_coding" && (
                  <>
                    {/* 快捷：粘贴curl自动解析 */}
                    <div className="p-3 rounded-lg bg-emerald-500/5 border border-emerald-500/20">
                      <p className="text-xs text-emerald-600 font-medium mb-2">快速填入：粘贴 curl 命令，自动解析3项配置</p>
                      <textarea
                        className="w-full text-xs p-2 rounded border border-emerald-500/20 bg-[var(--background)] font-mono resize-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500/30 outline-none"
                        rows={3}
                        placeholder={`粘贴扣子编程「部署」页的 curl 命令，例如：\ncurl -X POST https://xxxx.coze.site/stream_run \\\n  -H 'Authorization: Bearer eyJ...' \\\n  -d '{"project_id":"7640..."}'`}
                        onChange={(e) => {
                          const text = e.target.value;
                          if (!text.trim()) return;
                          try {
                            const urlMatch = text.match(/https?:\/\/[^\s'"]+\/stream_run/);
                            const tokenMatch = text.match(/Bearer\s+([^\s'"]+)/) || text.match(/Authorization[:\s]+([^\s'"]+)/);
                            const pidMatch = text.match(/project_id["\s:]+["']?(\d+)/);
                            const updates: Record<string, string> = {};
                            if (urlMatch) updates.cozeCodingApiUrl = urlMatch[0];
                            if (tokenMatch) updates.cozeCodingApiToken = tokenMatch[1];
                            if (pidMatch) updates.botId = pidMatch[1];
                            if (Object.keys(updates).length > 0) {
                              setNewAgent({ ...newAgent, ...updates });
                            }
                          } catch {}
                        }}
                      />
                      <p className="text-[10px] text-emerald-600/70 mt-1">打开 code.coze.cn → 进入项目 → 点「部署」→ 复制 curl 命令 → 粘贴到此处</p>
                    </div>

                    {/* 3项必填配置 */}
                    <div className="space-y-3 p-3 rounded-lg bg-[var(--brand)]/5 border border-[var(--brand)]/15">
                      <p className="text-xs text-[var(--brand)] font-medium">扣子编程 API 配置（必填3项，可在上方粘贴 curl 自动填入）</p>
                      <div>
                        <label className={labelCls}>① API 地址 *</label>
                        <input value={newAgent.cozeCodingApiUrl} onChange={(e) => setNewAgent({ ...newAgent, cozeCodingApiUrl: e.target.value })} className={inputCls} placeholder="https://xxxx.coze.site/stream_run" />
                        <p className="text-[10px] text-[var(--muted-foreground)] mt-0.5">部署页 → curl 命令中 POST 后面的 URL</p>
                      </div>
                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <label className={labelCls}>② Project ID *</label>
                          <input value={newAgent.botId} onChange={(e) => setNewAgent({ ...newAgent, botId: e.target.value })} className={inputCls} placeholder="如 7640401180107178038" />
                          <p className="text-[10px] text-[var(--muted-foreground)] mt-0.5">curl --data 里的 project_id 值</p>
                        </div>
                        <div>
                          <label className={labelCls}>③ API Token *</label>
                          <input value={newAgent.cozeCodingApiToken} onChange={(e) => setNewAgent({ ...newAgent, cozeCodingApiToken: e.target.value })} className={inputCls} placeholder="eyJhbGciOiJSUzI1NiI..." />
                          <p className="text-[10px] text-[var(--muted-foreground)] mt-0.5">部署页「API Token」按钮生成</p>
                        </div>
                      </div>
                    </div>

                    {/* 连接测试 */}
                    {newAgent.cozeCodingApiUrl && newAgent.cozeCodingApiToken && (
                      <div className="flex items-center gap-3">
                        <button
                          disabled={codingTestLoading}
                          onClick={() => void testCodingConnection(newAgent.cozeCodingApiUrl || "", newAgent.cozeCodingApiToken || "")}
                          className="text-xs px-3 py-1.5 rounded-md bg-emerald-500/10 border border-emerald-500/30 text-emerald-600 hover:bg-emerald-500/20 transition-colors disabled:opacity-50"
                        >
                          {codingTestLoading ? "测试中…" : "发送测试请求"}
                        </button>
                        <span className="text-xs text-[var(--muted-foreground)]">将调用已配置的工作流，可能产生供应商费用</span>
                      </div>
                    )}
                  </>
                  )}

                  {/* ========= LLM 专属配置 ========= */}
                  {addAgentSource === "llm" && (
                  <>
                    {/* 选择预设模型 - 核心交互 */}
                    <div className="p-4 rounded-lg bg-[var(--card)] border border-[var(--border)] space-y-3">
                      <div className="flex items-center gap-2">
                        <svg className="w-5 h-5 text-[var(--secondary-foreground)]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 2a3 3 0 0 0-3 3v4a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"/><path d="M19 10v1a7 7 0 0 1-14 0v-1"/><line x1="12" y1="19" x2="12" y2="22"/></svg>
                        <p className="text-sm font-semibold text-[var(--foreground)]">选择预设模型</p>
                        <span className="text-[10px] text-[var(--muted-foreground)]">从模型管理中选择</span>
                      </div>
                      {llmModels.filter(m => m.is_active !== false).length > 0 ? (
                        <select value={newAgent.modelId || ""} onChange={(e) => { const v = e.target.value; setNewAgent({ ...newAgent, modelId: v }); if (v) handleSelectLlmModel(v, false); }} className={inputCls + " text-sm font-medium"}>
                          <option value="">-- 请选择模型 --</option>
                          {llmModels.filter(m => m.is_active !== false).map(m => (
                            <option key={m.id} value={m.id}>{m.name}{m.model_name !== m.name ? ` (${m.model_name})` : ''}</option>
                          ))}
                        </select>
                      ) : (
                        <div className="p-2.5 rounded-lg bg-amber-500/10 border border-amber-500/20 text-xs text-amber-700 dark:text-amber-400">
                          <p className="font-medium">暂无预设模型</p>
                          <p className="mt-0.5">请先在「模型管理」中添加模型预设</p>
                        </div>
                      )}
                      {newAgent.modelId && (
                        <div className="flex items-center gap-2 p-2.5 rounded-lg bg-green-500/10 border border-green-500/20 text-xs text-green-700 dark:text-green-400">
                          <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M20 6L9 17l-5-5"/></svg>
                          模型配置已自动完成（标识、API、计费参数）
                        </div>
                      )}
                      {!newAgent.modelId && (
                        <div className="space-y-3 p-3 rounded-lg bg-[var(--background)] border border-[var(--border)]">
                          <p className="text-xs font-medium text-[var(--foreground)]">模型标识</p>
                          <input value={newAgent.model || ""} onChange={(e) => setNewAgent({ ...newAgent, model: e.target.value })} className={inputCls + " text-sm"} placeholder="如 glm-5.1、gpt-4o（必填）" />
                          <p className="text-[10px] text-[var(--muted-foreground)]">API 密钥和接口地址使用全局配置，无需手动填写</p>
                        </div>
                      )}
                    </div>

                    {canEditPrompts && (
                    <div className="space-y-2">
                      <div className="flex items-center justify-between">
                        <label className="text-sm font-semibold text-[var(--foreground)]">提示词（System Prompt）</label>
                        <label className="cursor-pointer inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg bg-[var(--primary)]/10 border border-[var(--primary)]/20 text-[var(--primary)] hover:bg-[var(--primary)]/20 transition-colors">
                            <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
                            上传 .md 文件
                            <input type="file" accept=".md,.markdown,.txt" onChange={(e) => {
                              const file = e.target.files?.[0];
                              if (!file) return;
                              const reader = new FileReader();
                              reader.onload = (ev) => {
                                const text = ev.target?.result as string;
                                setNewAgent({ ...newAgent, systemPrompt: text });
                              };
                              reader.readAsText(file);
                              e.target.value = "";
                            }} className="hidden" />
                        </label>
                      </div>
                      <textarea
                        value={newAgent.systemPrompt}
                        onChange={(e) => setNewAgent({ ...newAgent, systemPrompt: e.target.value })}
                        onKeyDown={(e) => {
                          // 防抖：textarea内Backspace不触发浏览器后退
                          if (e.key === "Backspace" && e.target instanceof HTMLTextAreaElement) {
                            const ta = e.target as HTMLTextAreaElement;
                            if (ta.selectionStart > 0 || ta.selectionStart !== ta.selectionEnd) return;
                            e.preventDefault();
                          }
                        }}
                        className="w-full min-h-[500px] max-h-[700px] p-3 rounded-lg border border-[var(--border)] bg-[var(--background)] font-mono text-xs leading-relaxed resize-y focus:border-[var(--primary)] focus:ring-1 focus:ring-[var(--primary)]/30 outline-none"
                        placeholder={"在此粘贴提示词，或点击上方「上传 .md 文件」按钮\n\n支持 Markdown 格式，所有格式标记会完整保留并发送给模型。\n\n示例：\n# 角色设定\n你是一位短视频文案专家\n\n## 输出规范\n1. **标题**：不超过20字\n2. **正文**：分3段\n\n## 示例输出\n**标题**：3天涨粉10万的秘密"}
                      />
                      <StoryboardPromptPushCapabilityToggle
                        agentId="new_agent"
                        value={newAgent.output_style || {}}
                        onChange={(value) => setNewAgent((current) => ({ ...current, output_style: value }))}
                      />
                      {/* 提示词版本历史 */}
                      <div className="p-4 rounded-lg bg-[var(--card)] border border-[var(--border)] space-y-3">
                        <div className="flex items-center justify-between gap-3">
                          <div>
                            <p className="text-sm font-semibold text-[var(--foreground)]">生图能力</p>
                            <p className="text-[10px] text-[var(--muted-foreground)]">启用后，用户在聊天中发送绘图需求时直接生成图片画廊（不替换对话模型）。</p>
                          </div>
                          <button
                            type="button"
                            onClick={() => {
                              const imgGen = newAgent.output_style?.hybridImageGeneration;
                              if (imgGen?.enabled) {
                                // 禁用：清除 hybridImageGeneration 配置，不改动对话模型
                                const newOutputStyle = { ...(newAgent.output_style || {}) };
                                delete newOutputStyle.hybridImageGeneration;
                                setNewAgent({ ...newAgent, output_style: newOutputStyle as OutputStyle | undefined });
                                return;
                              }
                              const first = activeDrawingModels[0];
                              if (first) applyDrawingModelToNewAgent(first.model_name);
                              else showMessage("error", "请先在模型管理里启用至少一个绘图模型");
                            }}
                            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${newAgent.output_style?.hybridImageGeneration?.enabled ? "bg-[var(--primary)] text-white" : "bg-[var(--background)] text-[var(--muted-foreground)] border border-[var(--border)]"}`}
                          >
                            {newAgent.output_style?.hybridImageGeneration?.enabled ? "已启用" : "未启用"}
                          </button>
                        </div>
                        {newAgent.output_style?.hybridImageGeneration?.enabled && (
                          <div className="space-y-2">
                            {activeDrawingModels.length > 0 ? (
                              <select value={newAgent.output_style?.hybridImageGeneration?.model || ""} onChange={(e) => applyDrawingModelToNewAgent(e.target.value)} className={inputCls + " text-sm font-medium"}>
                                {activeDrawingModels.map(m => (
                                  <option key={m.id} value={m.model_name}>{m.name}{m.model_name !== m.name ? ` (${m.model_name})` : ""}</option>
                                ))}
                              </select>
                            ) : (
                              <div className="p-2.5 rounded-lg bg-amber-500/10 border border-amber-500/20 text-xs text-amber-700 dark:text-amber-400">
                                暂无可用绘图模型，请先到「模型管理」启用封面/绘图模型。
                              </div>
                            )}
                            <p className="text-[10px] text-[var(--muted-foreground)]">说明：生图模型不写入文字模型 UUID，只保存模型标识，避免保存智能体时报 model_id 格式错误。</p>
                          </div>
                        )}
                      </div>
                      <PromptVersionHistory
                        ref={newPromptVersionRef}
                        agentId="new_agent"
                        currentPrompt={newAgent.systemPrompt}
                        onRestore={(prompt) => setNewAgent({ ...newAgent, systemPrompt: prompt })}
                        authHeaders={{ Authorization: `Bearer ${safeLocalStorageGet(STORAGE_KEYS.AUTH_TOKEN)}` }}
                      />
                    </div>
                    )}

                    {/* 提问模板 - 双模式编辑器 */}
                    <div>
                      <label className="text-sm font-semibold text-[var(--foreground)] mb-2 block">提问模板</label>
                      <p className="text-[10px] text-[var(--muted-foreground)] mb-2">定义用户使用此智能体时需要填写的字段，用户端将以表单弹窗展示</p>
                      <PresetTemplateEditor
                        value={addPresetFields}
                        onChange={setAddPresetFields}
                      />
                    </div>
                  </>
                  )}

                  {/* 示例内容 */}
                  <div>
                    <label className={labelCls}>示例内容</label>
                    <textarea value={newAgent.description || ""} onChange={(e) => setNewAgent({ ...newAgent, description: e.target.value })} className={inputCls + " min-h-[60px] resize-y"} rows={2} placeholder="请填写App的demo示例数据..." />
                  </div>

                  {/* 应用图标 + App背景图 */}
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className={labelCls}>应用图标</label>
                      <div className="flex items-center gap-2 mt-1">
                        <div className="relative w-14 h-14 rounded-xl bg-[var(--border)] border border-[var(--border)] flex items-center justify-center overflow-hidden shrink-0">
                          {avatarPreview ? <img src={resolveAvatarPreviewSrc(avatarPreview)} alt="头像预览" className="w-full h-full object-cover" /> : <span className="text-[var(--muted-foreground)] text-lg">+</span>}
                          {singleAvatarGenerating && singleAvatarMode === "add" && (
                            <div className="absolute inset-0 bg-black/55 flex items-center justify-center text-[10px] text-white font-medium">生成中</div>
                          )}
                        </div>
                        <label className="cursor-pointer text-xs px-3 py-2 rounded bg-[var(--border)] border border-[var(--border)] text-[var(--secondary-foreground)] hover:border-[var(--brand)] hover:text-[var(--brand)] transition-colors shrink-0">
                          {avatarUploading ? "上传中..." : avatarPreview ? "替换头像" : "上传头像"}
                          <input type="file" accept="image/png,image/jpeg,image/webp" onChange={handleAvatarUpload} className="hidden" disabled={avatarUploading} />
                        </label>
                        {avatarPreview && <button type="button" onClick={() => { if (pendingAddAvatarKey) void discardPendingAgentImage(pendingAddAvatarKey); setPendingAddAvatarKey(""); setNewAgent((current) => ({ ...current, avatar: "" })); setAvatarPreview(""); }} className="text-xs text-[var(--destructive)] hover:underline">清除</button>}
                      </div>
                      <p className="mt-1 text-[10px] text-[var(--muted-foreground)]">PNG/JPEG/WebP，最大 5MB，建议使用接近正方形的图片。</p>
                      <div className="flex items-center gap-1.5 mt-1.5">
                        <select value={singleAvatarStyle} onChange={(e) => setSingleAvatarStyle(e.target.value)} className="text-[11px] px-1.5 py-1 rounded border border-[var(--border)] bg-[var(--card)] text-[var(--foreground)]">
                          {["赛博朋克","科技风","卡通风","简约风","渐变风","3D风","国风"].map(s => <option key={s} value={s}>{s}</option>)}
                        </select>
                        <input
                          value={singleAvatarCustomPrompt}
                          onChange={(e) => setSingleAvatarCustomPrompt(e.target.value)}
                          placeholder="描述(可选)"
                          className="text-[11px] px-1.5 py-1 rounded border border-[var(--border)] bg-[var(--card)] text-[var(--foreground)] w-20 placeholder:text-[var(--muted-foreground)]"
                        />
                        <button type="button" onClick={() => generateSingleAvatar("add")} disabled={singleAvatarGenerating} className="text-[11px] px-2.5 py-1 rounded bg-[var(--primary)] text-white hover:opacity-90 disabled:opacity-40 transition-opacity shrink-0">
                          {singleAvatarGenerating && singleAvatarMode === "add" ? "生成中..." : "一键生成"}
                        </button>
                        {avatarCandidates.length > 0 && (
                          <button onClick={() => { setAvatarCandidates([]); try { safeLocalStorageRemove("avatar_candidates"); } catch {} }} className="text-[11px] px-1.5 py-1 rounded border border-[var(--border)] text-[var(--muted-foreground)] hover:text-[var(--destructive)] hover:border-[var(--destructive)] transition-colors shrink-0" title="清空候选">清空</button>
                        )}
                      </div>
                      {singleAvatarStatus && singleAvatarMode === "add" && (
                        <div className={`mt-1.5 text-[10px] ${singleAvatarStatus.includes("成功") ? "text-emerald-500" : singleAvatarGenerating ? "text-[var(--primary)]" : "text-[var(--destructive)]"}`}>
                          {singleAvatarStatus}
                        </div>
                      )}
                      {/* 候选头像列表：从 localStorage 持久化，刷新后仍可用 */}
                      {avatarCandidates.length > 0 && (
                        <div className="mt-2">
                          <div className="text-[10px] text-[var(--muted-foreground)] mb-1">候选头像（点击选择）</div>
                          <div className="flex flex-wrap gap-1.5">
                            {avatarCandidates.map((url, idx) => (
                              <div
                                key={idx}
                                onClick={() => {
                                  if (pendingAddAvatarKey) void discardPendingAgentImage(pendingAddAvatarKey);
                                  setPendingAddAvatarKey("");
                                  setNewAgent(prev => ({ ...prev, avatar: url }));
                                  setAvatarPreview(url);
                                }}
                                className={`w-9 h-9 rounded-lg border-2 cursor-pointer overflow-hidden transition-all hover:scale-110 ${newAgent.avatar === url ? "border-[var(--brand)] ring-1 ring-[var(--brand)]" : "border-[var(--border)]"}`}
                              >
                                <img src={resolveAvatarPreviewSrc(url)} alt="" className="w-full h-full object-cover" />
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                    <div>
                      <label className={labelCls}>App背景图</label>
                      <div className="mt-1 space-y-2">
                        <div className="aspect-video w-full max-w-[260px] rounded-lg bg-[var(--border)] border border-[var(--border)] flex items-center justify-center overflow-hidden">
                          {addAgentCoverPreview ? <img src={addAgentCoverPreview} alt="App背景图预览" className="w-full h-full object-cover" /> : <span className="text-xs text-[var(--muted-foreground)]">尚未上传背景图</span>}
                        </div>
                        <div className="flex items-center gap-2">
                          <label className="cursor-pointer rounded-lg border border-[var(--border)] bg-[var(--border)] px-3 py-2 text-xs text-[var(--secondary-foreground)] hover:border-[var(--brand)] hover:text-[var(--brand)]">
                            {addAgentCoverUploading ? "上传中..." : addAgentCoverUrl ? "替换背景图" : "上传背景图"}
                            <input type="file" accept="image/png,image/jpeg,image/webp" onChange={handleAddCoverUpload} className="hidden" disabled={addAgentCoverUploading} />
                          </label>
                          {addAgentCoverUrl && <button type="button" onClick={() => { if (pendingAddCoverKey) void discardPendingAgentImage(pendingAddCoverKey); setPendingAddCoverKey(""); setAddAgentCoverUrl(""); setAddAgentCoverPreview(""); }} className="text-xs text-[var(--destructive)] hover:underline">清除</button>}
                        </div>
                        <p className="text-[10px] text-[var(--muted-foreground)]">PNG/JPEG/WebP，最大 5MB，建议横向图片。</p>
                      </div>
                    </div>
                  </div>


                  {/* 底部操作按钮 */}
                  <div className="flex justify-end gap-3 pt-3 border-t border-[var(--border)]">
                    <button onClick={handleCancelAddAgent} className={btnGhost}>取消</button>
                    <button onClick={handleAddAgent} className={btnPrimary}>确认新增</button>
                  </div>
                </div>
              </div>
            )}

            {/* Batch Import Coze Coding Agents */}
            {showImportCoding && (
              <div className={`${cardCls} mb-4`}>
                <div className="flex items-center justify-between mb-4">
                  <h3 className="font-semibold text-[var(--foreground)]">批量导入智能体</h3>
                  <button onClick={() => { setShowImportCoding(false); setImportCodingParsed([]); setImportCodingResult(null); }} className={btnGhost}>关闭</button>
                </div>

                <div className="p-3 rounded-lg bg-[var(--brand)]/5 border border-[var(--brand)]/15 mb-4 text-xs text-[var(--secondary-foreground)] space-y-1.5">
                  <p className="text-[var(--brand)] font-medium">操作步骤：</p>
                  <p>1. 打开 <span className="text-[var(--foreground)]">code.coze.cn</span> → 进入项目 → 点击「部署」</p>
                  <p>2. 点击「API 访问」→ 复制 <span className="text-[var(--foreground)]">curl</span> 代码（包含 URL + Token + project_id）</p>
                  <p>3. 每个智能体的 curl 代码粘贴到下方，用空行分隔多个智能体</p>
                  <p>4. 点击「解析」→ 确认信息 → 点击「导入」</p>
                </div>

                {/* Import result */}
                {importCodingResult && (
                  <div className="mb-4 p-3 rounded-lg bg-[var(--brand)]/10 border border-[var(--brand)]/20 text-sm">
                    <p className="text-[var(--brand)] font-medium">导入完成</p>
                    <div className="mt-1.5 text-xs space-y-1">
                      <p className="text-[var(--success)]">成功导入 {importCodingResult.imported} 个</p>
                      {importCodingResult.skipped > 0 && <p className="text-yellow-400">跳过 {importCodingResult.skipped} 个（已存在）</p>}
                      {importCodingResult.failed > 0 && <p className="text-[var(--destructive)]">失败 {importCodingResult.failed} 个</p>}
                    </div>
                    {importCodingResult.details?.imported && importCodingResult.details.imported.length > 0 && (
                      <div className="mt-2 space-y-1">
                        {importCodingResult.details.imported.map((b, i) => (
                          <div key={i} className="flex items-center gap-2 text-xs">
                            <span className="w-1.5 h-1.5 rounded-full bg-[var(--success)]" />
                            <span className="text-[var(--foreground)]">{b.name}</span>
                            <span className="text-[var(--muted-foreground)]">{b.project_id}</span>
                          </div>
                        ))}
                      </div>
                    )}
                    {importCodingResult.details?.failed && importCodingResult.details.failed.length > 0 && (
                      <div className="mt-2 space-y-1">
                        {importCodingResult.details.failed.map((b, i) => (
                          <div key={i} className="flex items-center gap-2 text-xs">
                            <span className="w-1.5 h-1.5 rounded-full bg-[var(--destructive)]" />
                            <span className="text-[var(--foreground)]">{b.name}</span>
                            <span className="text-[var(--destructive)]">{b.reason}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                <div className="space-y-4">
                  <div>
                    <label className={labelCls}>粘贴 curl 代码（每个智能体用空行分隔）</label>
                    <textarea
                      value={importCodingText}
                      onChange={(e) => setImportCodingText(e.target.value)}
                      className={`${inputCls} h-36 resize-y font-mono text-xs`}
                      placeholder={`粘贴每个智能体的 curl 代码，用空行分隔：\ncurl --location --request POST "https://brq56xbs3b.coze.site/stream_run" \\\n  --header "Authorization: Bearer eyJhbGci..." \\\n  --header "Content-Type: application/json" \\\n  --data '{"project_id": 7641259861149368358, ...}'\n\n（空行分隔下一个智能体）\ncurl --location --request POST "https://xxxxx.coze.site/stream_run" \\\n  --header "Authorization: Bearer eyJhbGci..." \\\n  --data '{"project_id": 9876543210, ...}'`}
                    />
                  </div>

                  <div className="flex items-end gap-3">
                    <div className="w-48">
                      <label className={labelCls}>统一分类</label>
                      <select value={importCodingCategory} onChange={(e) => setImportCodingCategory(e.target.value)} className={inputCls}>
                        {categories.map((c) => <option key={c.id} value={c.name}>{c.icon} {c.name}</option>)}
                      </select>
                    </div>
                    <button
                      onClick={handleParseCodingCurls}
                      disabled={!importCodingText.trim()}
                      className="px-4 py-2 text-sm rounded-lg bg-[#FF9500]/20 text-[#FF9500] border border-[#FF9500]/30 hover:bg-[#FF9500]/30 transition-colors disabled:opacity-40"
                    >
                      解析 curl
                    </button>
                  </div>

                  {/* Parsed results */}
                  {importCodingParsed.length > 0 && (
                    <div className="space-y-2">
                      <p className="text-xs text-[var(--secondary-foreground)]">已解析 {importCodingParsed.length} 个智能体，{importCodingParsed.filter(p => p.valid).length} 个信息完整可导入：</p>
                      {importCodingParsed.map((p, i) => (
                        <div key={i} className={`p-3 rounded-lg border text-xs ${p.valid ? "bg-[var(--success)]/5 border-[var(--success)]/20" : "bg-[var(--destructive)]/5 border-[var(--destructive)]/20"}`}>
                          <div className="flex items-center gap-2 mb-1.5">
                            <span className={`w-2 h-2 rounded-full ${p.valid ? "bg-[var(--success)]" : "bg-[var(--destructive)]"}`} />
                            {p.valid ? (
                              <input
                                value={p.name}
                                onChange={(e) => updateCodingParsedName(i, e.target.value)}
                                className="bg-transparent border-b border-[var(--border)] text-[var(--foreground)] text-sm px-1 py-0.5 flex-1 focus:border-[var(--brand)] outline-none"
                                placeholder="智能体名称"
                              />
                            ) : (
                              <span className="text-[var(--destructive)]">{p.error}</span>
                            )}
                          </div>
                          {p.valid && (
                            <div className="flex gap-4 text-[var(--muted-foreground)]">
                              <span>API: {p.api_url.replace(/https?:\/\//, '').split('/')[0]}</span>
                              <span>ID: {p.project_id}</span>
                              <span>Token: {p.api_token.slice(0, 20)}...</span>
                            </div>
                          )}
                        </div>
                      ))}
                      <div className="flex gap-3 pt-2">
                        <button
                          onClick={handleImportCoding}
                          disabled={importCodingLoading || importCodingParsed.filter(p => p.valid).length === 0}
                          className={btnPrimary + " disabled:opacity-40 disabled:cursor-not-allowed"}
                        >
                          {importCodingLoading ? "导入中..." : `导入 ${importCodingParsed.filter(p => p.valid).length} 个智能体`}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Coze 导入结果弹窗 */}
            {showImportCozeDialog && importCozeResult && (
              <div className={`${cardCls} mb-4`}>
                <div className="flex items-center justify-between mb-4">
                  <h3 className="font-semibold text-[var(--foreground)]">从Coze平台导入结果</h3>
                  <button onClick={() => setShowImportCozeDialog(false)} className="text-[var(--muted-foreground)] hover:text-[var(--foreground)] text-lg">&times;</button>
                </div>
                <div className="grid grid-cols-4 gap-3 mb-4">
                  <div className="p-3 rounded-lg bg-[var(--success)]/10 border border-[var(--success)]/20 text-center">
                    <div className="text-2xl font-bold text-[var(--success)]">{importCozeResult.imported}</div>
                    <div className="text-xs text-[var(--muted-foreground)] mt-1">新增</div>
                  </div>
                  <div className="p-3 rounded-lg bg-[var(--brand)]/10 border border-[var(--brand)]/20 text-center">
                    <div className="text-2xl font-bold text-[var(--brand)]">{importCozeResult.updated}</div>
                    <div className="text-xs text-[var(--muted-foreground)] mt-1">更新</div>
                  </div>
                  <div className="p-3 rounded-lg bg-yellow-500/10 border border-yellow-500/20 text-center">
                    <div className="text-2xl font-bold text-yellow-500">{importCozeResult.skipped}</div>
                    <div className="text-xs text-[var(--muted-foreground)] mt-1">跳过</div>
                  </div>
                  <div className="p-3 rounded-lg bg-[var(--destructive)]/10 border border-[var(--destructive)]/20 text-center">
                    <div className="text-2xl font-bold text-[var(--destructive)]">{importCozeResult.failed}</div>
                    <div className="text-xs text-[var(--muted-foreground)] mt-1">失败</div>
                  </div>
                </div>
                <div className="max-h-60 overflow-y-auto space-y-1.5">
                  {importCozeResult.details.map((d, i) => (
                    <div key={i} className="flex items-center gap-2 text-xs px-2 py-1.5 rounded bg-[var(--card)]/50">
                      {d.status === 'imported' && <span className="w-2 h-2 rounded-full bg-[var(--success)]" />}
                      {d.status === 'updated' && <span className="w-2 h-2 rounded-full bg-[var(--brand)]" />}
                      {d.status === 'skipped' && <span className="w-2 h-2 rounded-full bg-yellow-500" />}
                      {d.status === 'failed' && <span className="w-2 h-2 rounded-full bg-[var(--destructive)]" />}
                      <span className="text-[var(--foreground)] font-medium">{d.name}</span>
                      <span className="text-[var(--muted-foreground)]">
                        {d.status === 'imported' ? '已导入' : d.status === 'updated' ? '已更新' : d.status === 'skipped' ? '跳过' : '失败'}
                      </span>
                      {d.error && <span className="text-[var(--destructive)]">({d.error})</span>}
                    </div>
                  ))}
                </div>
                <div className="mt-4 flex justify-end">
                  <button onClick={() => setShowImportCozeDialog(false)} className={btnPrimary}>确认</button>
                </div>
              </div>
            )}

            {editingAgent && canManageAgentConfiguration && (
              <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ isolation: 'isolate' }}
                onClick={(e) => { if (e.target === e.currentTarget) handleCancelEdit(); }}>
                {/* 遮罩层 */}
                <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" />
                {/* 悬浮编辑框 - will-change防抖动 */}
                <div data-testid="admin-agent-edit-dialog" className="relative w-full max-w-3xl max-h-[90vh] bg-[var(--card)] rounded-2xl border border-[var(--border)] shadow-2xl flex flex-col" style={{ willChange: 'transform', contain: 'layout style paint' }}>
                  {/* 头部 - 固定不滚动 */}
                  <div className="flex items-center justify-between px-6 py-4 border-b border-[var(--border)] shrink-0">
                    <h3 className="font-semibold text-[var(--foreground)] text-lg">编辑智能体</h3>
                    <button onClick={handleCancelEdit} className="w-8 h-8 rounded-lg flex items-center justify-center text-[var(--muted-foreground)] hover:bg-[var(--border)] hover:text-[var(--foreground)] transition-colors cursor-pointer" title="关闭">
                      <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
                    </button>
                  </div>
                  {/* 内容区 - 可滚动 */}
                  <div className="flex-1 overflow-y-auto px-6 py-4" style={{ scrollbarWidth: 'thin' }} inert={agentSaveBusy}>
                  <div className="space-y-4">
                  <div className="grid grid-cols-2 gap-4">
                  {/* Edit Avatar Upload */}
                  <div className="col-span-2">
                    <label className={labelCls}>头像</label>
                    <div className="flex items-center gap-4 mt-1">
                      <div className="relative w-16 h-16 rounded-xl bg-[var(--border)] border-2 border-[var(--primary)] flex items-center justify-center overflow-hidden flex-shrink-0">
                        {editAvatarPreview ? (
                          <img src={resolveAvatarPreviewSrc(editAvatarPreview)} alt="头像预览" className="w-full h-full object-cover" />
                        ) : (
                          <span className="text-[var(--secondary-foreground)] text-2xl">?</span>
                        )}
                        {singleAvatarGenerating && singleAvatarMode === "edit" && (
                          <div className="absolute inset-0 bg-black/55 flex items-center justify-center text-[10px] text-white font-medium">生成中</div>
                        )}
                      </div>
                      <div className="flex-1">
                        <label className="cursor-pointer inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-[var(--border)] border border-[var(--border)] text-sm text-[var(--secondary-foreground)] hover:border-[var(--primary)] hover:text-[var(--primary)] transition-colors">
                          <svg xmlns="http://www.w3.org/2000/svg" className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
                          {editAvatarUploading ? "上传中..." : "更换头像"}
                          <input type="file" accept="image/png,image/jpeg,image/webp" onChange={handleEditAvatarUpload} className="hidden" disabled={editAvatarUploading} />
                        </label>
                        {editingAgent.avatar && <button type="button" onClick={() => { if (pendingEditAvatarKey) void discardPendingAgentImage(pendingEditAvatarKey); setPendingEditAvatarKey(""); setEditingAgent({ ...editingAgent, avatar: "" }); setEditAvatarPreview(""); }} className="ml-2 text-xs text-[var(--destructive)] hover:underline">清除头像</button>}
                        <p className="text-xs text-[var(--muted-foreground)] mt-1">支持 PNG/JPEG/WebP，不超过 5MB；不保存外部图片链接。</p>
                        <div className="flex items-center gap-1.5 mt-2">
                          <select value={singleAvatarStyle} onChange={(e) => setSingleAvatarStyle(e.target.value)} className="text-[11px] px-1.5 py-1 rounded border border-[var(--border)] bg-[var(--card)] text-[var(--foreground)]">
                            {["赛博朋克","科技风","卡通风","简约风","渐变风","3D风","国风"].map(s => <option key={s} value={s}>{s}</option>)}
                          </select>
                          <input
                            value={singleAvatarCustomPrompt}
                            onChange={(e) => setSingleAvatarCustomPrompt(e.target.value)}
                            placeholder="描述(可选)"
                            className="text-[11px] px-1.5 py-1 rounded border border-[var(--border)] bg-[var(--card)] text-[var(--foreground)] w-20 placeholder:text-[var(--muted-foreground)]"
                          />
                          <button type="button" onClick={() => generateSingleAvatar("edit")} disabled={singleAvatarGenerating} className="text-[11px] px-2.5 py-1 rounded bg-[var(--primary)] text-white hover:opacity-90 disabled:opacity-40 transition-opacity">
                            {singleAvatarGenerating && singleAvatarMode === "edit" ? "生成中..." : "一键生成"}
                          </button>
                          {avatarCandidates.length > 0 && (
                            <button onClick={() => { setAvatarCandidates([]); try { safeLocalStorageRemove("avatar_candidates"); } catch {} }} className="text-[11px] px-1.5 py-1 rounded border border-[var(--border)] text-[var(--muted-foreground)] hover:text-[var(--destructive)] hover:border-[var(--destructive)] transition-colors" title="清空候选">清空</button>
                          )}
                        </div>
                        {singleAvatarStatus && singleAvatarMode === "edit" && (
                          <div className={`mt-1.5 text-[10px] ${singleAvatarStatus.includes("成功") ? "text-emerald-500" : singleAvatarGenerating ? "text-[var(--primary)]" : "text-[var(--destructive)]"}`}>
                            {singleAvatarStatus}
                          </div>
                        )}
                        {/* 候选头像列表：从 localStorage 持久化，刷新后仍可用 */}
                        {avatarCandidates.length > 0 && (
                          <div className="mt-2">
                            <div className="text-[10px] text-[var(--muted-foreground)] mb-1">候选头像（点击选择）</div>
                            <div className="flex flex-wrap gap-1.5">
                              {avatarCandidates.map((url, idx) => (
                                <div
                                  key={idx}
                                  onClick={() => {
                                    if (!editingAgent) return;
                                    if (pendingEditAvatarKey) void discardPendingAgentImage(pendingEditAvatarKey);
                                    setPendingEditAvatarKey("");
                                    setEditingAgent({ ...editingAgent, avatar: url });
                                    setEditAvatarPreview(url);
                                  }}
                                  className={`w-9 h-9 rounded-lg border-2 cursor-pointer overflow-hidden transition-all hover:scale-110 ${editingAgent?.avatar === url ? "border-[var(--brand)] ring-1 ring-[var(--brand)]" : "border-[var(--border)]"}`}
                                >
                                  <img src={resolveAvatarPreviewSrc(url)} alt="" className="w-full h-full object-cover" />
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                  <div className="col-span-2">
                    <label className={labelCls}>App背景图</label>
                    <div className="mt-1 flex items-start gap-4">
                      <div className="aspect-video w-64 rounded-xl border border-[var(--border)] bg-[var(--border)] flex items-center justify-center overflow-hidden shrink-0">
                        {editAgentCoverPreview ? <img src={editAgentCoverPreview} alt="App背景图预览" className="h-full w-full object-cover" /> : <span className="text-xs text-[var(--muted-foreground)]">尚未上传背景图</span>}
                      </div>
                      <div>
                        <label className="cursor-pointer inline-flex items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--border)] px-4 py-2 text-sm text-[var(--secondary-foreground)] hover:border-[var(--primary)] hover:text-[var(--primary)]">
                          {editAgentCoverUploading ? "上传中..." : editingAgent.cover_url ? "替换背景图" : "上传背景图"}
                          <input type="file" accept="image/png,image/jpeg,image/webp" onChange={handleEditCoverUpload} className="hidden" disabled={editAgentCoverUploading} />
                        </label>
                        {editingAgent.cover_url && <button type="button" onClick={() => { if (pendingEditCoverKey) void discardPendingAgentImage(pendingEditCoverKey); setPendingEditCoverKey(""); setEditingAgent({ ...editingAgent, cover_url: "" }); setEditAgentCoverPreview(""); }} className="ml-2 text-xs text-[var(--destructive)] hover:underline">清除背景图</button>}
                        <p className="mt-2 text-xs text-[var(--muted-foreground)]">支持 PNG/JPEG/WebP，不超过 5MB，建议横向图片。</p>
                      </div>
                    </div>
                  </div>
                  <div><label className={labelCls}>名称 *</label><input value={editingAgent.name} onChange={(e) => setEditingAgent({ ...editingAgent, name: e.target.value })} className={inputCls} /></div>
                  <div><label className={labelCls}>分类 *</label><select value={editingAgent.category} onChange={(e) => setEditingAgent({ ...editingAgent, category: e.target.value })} className={inputCls}>{categories.map((c) => <option key={c.id} value={c.name}>{c.icon} {c.name}</option>)}</select></div>
                  <div><label className={labelCls}>使用权限</label><select value={editingAgent.user_access || "available"} onChange={(e) => setEditingAgent({ ...editingAgent, user_access: e.target.value as "available" | "hidden" })} className={inputCls}>
                    <option value="available">可用（正常显示和使用）</option>
                    <option value="hidden">隐藏（仅管理员可见）</option>
                  </select>
                  <p className="text-[10px] text-[var(--muted-foreground)] mt-0.5">"隐藏"：非管理员完全看不到该智能体；如需"可见不可用"效果，请在分类中设置可见性为"仅展示"</p>
                  </div>
                  <div className="col-span-2"><label className={labelCls}>描述</label><input value={editingAgent.description} onChange={(e) => setEditingAgent({ ...editingAgent, description: e.target.value })} className={inputCls} /></div>
                  <div className="col-span-2"><label className={labelCls}>聊天引导语</label><textarea value={editingAgent.guide_message || ""} onChange={(e) => setEditingAgent({ ...editingAgent, guide_message: e.target.value })} className={inputCls + " min-h-[80px] resize-y"} rows={4} placeholder="用户打开聊天时显示的引导语，介绍智能体功能并引导用户提问。如：我是XXX，我可以帮你…&#10;请告诉我：1. … 2. …" /><p className="text-[10px] text-[var(--muted-foreground)] mt-0.5">支持 **加粗** 标记，换行请直接回车。留空则显示默认引导语</p></div>
                  {/* 智能体类型切换 */}
                  <div className="col-span-2">
                    <label className={labelCls}>智能体类型</label>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => setEditingAgent({ ...editingAgent, source: "coze_coding" })}
                        className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${editingAgent.source === "coze_coding" ? "bg-[var(--foreground)] text-[var(--background)] shadow-sm" : "bg-[var(--card)] text-[var(--muted-foreground)] border border-[var(--border)] hover:border-[var(--foreground)]"}`}
                      >
                        扣子编程
                      </button>
                      <button
                        type="button"
                        onClick={() => setEditingAgent({ ...editingAgent, source: "llm" })}
                        className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${editingAgent.source === "llm" ? "bg-[var(--foreground)] text-[var(--background)] shadow-sm" : "bg-[var(--card)] text-[var(--muted-foreground)] border border-[var(--border)] hover:border-[var(--foreground)]"}`}
                      >
                        LLM 直连
                      </button>
                      {editingAgent.source === "coze_coding" && <span className="text-[10px] text-emerald-600">通过扣子编程部署</span>}
                      {editingAgent.source === "llm" && <span className="text-[10px] text-[var(--primary)]">直连大模型</span>}
                    </div>
                  </div>
                  {/* 扣子编程专属字段 */}
                  {editingAgent.source !== "llm" && (
                  <>
                  <div><label className={labelCls}>API 地址 *</label><input value={editingAgent.coze_coding_api_url || ""} onChange={(e) => setEditingAgent({ ...editingAgent, coze_coding_api_url: e.target.value })} className={inputCls} placeholder="部署页curl中的URL" /></div>
                  <div><label className={labelCls}>Project ID *</label><input value={editingAgent.coze_coding_project_id || editingAgent.bot_id} onChange={(e) => setEditingAgent({ ...editingAgent, coze_coding_project_id: e.target.value, bot_id: e.target.value })} className={inputCls} placeholder="curl中的project_id" /></div>
                  <div className="col-span-2"><label className={labelCls}>API Token *</label><input value={editingAgent.coze_coding_api_token || ""} onChange={(e) => setEditingAgent({ ...editingAgent, coze_coding_api_token: e.target.value })} className={inputCls} type="password" placeholder={editingAgent.coze_coding_api_token_configured ? "已配置；留空保留原 Token" : "部署页点击「API Token」生成"} />{editingAgent.coze_coding_api_token_configured && <p className="text-[10px] text-[var(--muted-foreground)] mt-1">原 Token 不会返回浏览器；输入新值才会替换</p>}</div>
                  </>
                  )}
                  {/* LLM 专属字段 */}
                  {editingAgent.source === "llm" && (
                  <>
                  {/* 选择预设模型 */}
                  <div>
                    <label className={labelCls}>选择预设模型</label>
                    {llmModels.filter(m => m.is_active !== false).length > 0 ? (
                      <select data-testid="admin-agent-model-select" value={editingAgent.model_id || ""} onChange={(e) => { const v = e.target.value; if (v) handleSelectLlmModel(v, true); else setEditingAgent({ ...editingAgent, model_id: undefined }); }} className={inputCls}>
                        <option value="">-- 从模型管理中选择 --</option>
                        {llmModels.filter(m => m.is_active !== false).map(m => (
                          <option key={m.id} value={m.id}>{m.name}{m.model_name !== m.name ? ` (${m.model_name})` : ''}</option>
                        ))}
                      </select>
                    ) : (
                      <div className="p-2 rounded-lg bg-amber-500/10 border border-amber-500/20 text-[10px] text-amber-700 dark:text-amber-400">
                        暂无预设模型，请先在「模型管理」中添加
                      </div>
                    )}
                    {editingAgent.model_id && (
                      <div className="flex items-center gap-2 p-2 rounded-lg bg-green-500/10 border border-green-500/20 text-[10px] text-green-700 dark:text-green-400 mt-1">
                        <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M20 6L9 17l-5-5"/></svg>
                        模型配置已自动完成
                      </div>
                    )}
                    {!editingAgent.model_id && (
                      <div className="mt-2">
                        <p className="text-[10px] font-medium text-[var(--foreground)] mb-1">模型标识</p>
                        <input value={editingAgent.model || ""} onChange={(e) => setEditingAgent({ ...editingAgent, model: e.target.value })} className={inputCls + " text-sm"} placeholder="如 glm-5.1、gpt-4o（必填）" />
                        <p className="text-[10px] text-[var(--muted-foreground)] mt-1">API 密钥和接口地址使用全局配置，无需手动填写</p>
                      </div>
                    )}
                  </div>
                  {canReadPrompts && (
                  <div className="col-span-2">
                    <div className="flex items-center justify-between mb-1">
                      <label className={labelCls}>提示词</label>
                      {canEditPrompts && <div className="flex items-center gap-2">
                        <label className="cursor-pointer px-2 py-0.5 rounded text-[10px] bg-[var(--primary)]/10 text-[var(--primary)] hover:bg-[var(--primary)]/20 transition-colors">
                          {editPromptReading ? "读取中…" : "上传 .md"}
                          <input type="file" accept=".md,.markdown,.txt" className="hidden" onChange={(e) => {
                            const file = e.target.files?.[0];
                            if (!file || agentEditSessionRef.current !== agentEditSession || !agentEditorAccessRef.current.prompts) return;
                            const fileSession = agentEditSession;
                            const readRequest = ++agentPromptReadRef.current;
                            setEditPromptReading(true);
                            const reader = new FileReader();
                            reader.onload = (ev) => {
                              if (agentEditSessionRef.current !== fileSession || agentPromptReadRef.current !== readRequest) return;
                              setEditPromptReading(false);
                              if (!agentEditorAccessRef.current.prompts) return;
                              const text = ev.target?.result as string;
                              setEditingAgent((current) => current ? { ...current, system_prompt: text } : current);
                            };
                            reader.onerror = () => {
                              if (agentEditSessionRef.current !== fileSession || agentPromptReadRef.current !== readRequest) return;
                              setEditPromptReading(false);
                              if (!agentEditorAccessRef.current.prompts) return;
                              showMessage("error", "提示词文件读取失败，请重试");
                            };
                            reader.readAsText(file);
                            e.target.value = "";
                          }} />
                        </label>
                        <button type="button" onClick={() => setEditingAgent({ ...editingAgent, system_prompt: "" })} className="px-2 py-0.5 rounded text-[10px] bg-red-50 text-red-500 hover:bg-red-100 transition-colors">清空</button>
                      </div>}
                    </div>
                    <textarea
                      value={editingAgent.system_prompt || ""}
                      onChange={(e) => { if (canEditPrompts) setEditingAgent({ ...editingAgent, system_prompt: e.target.value }); }}
                      readOnly={!canEditPrompts}
                      onKeyDown={(e) => {
                        // 防抖：textarea内Backspace不触发浏览器后退
                        if (e.key === "Backspace" && e.target instanceof HTMLTextAreaElement) {
                          const ta = e.target as HTMLTextAreaElement;
                          // 如果光标不在最前面或选中有文字，正常删除，不阻止
                          if (ta.selectionStart > 0 || ta.selectionStart !== ta.selectionEnd) return;
                          // 光标在最前面且无选中 → 阻止，防止退回上一页
                          e.preventDefault();
                        }
                      }}
                      className="w-full min-h-[500px] max-h-[700px] p-3 rounded-lg border border-[var(--border)] bg-[var(--background)] font-mono text-xs leading-relaxed resize-y focus:border-[var(--primary)] focus:ring-1 focus:ring-[var(--primary)]/30 outline-none"
                      placeholder="在此输入提示词，或上传 .md 文件..."
                    />
                    {canEditPrompts && <StoryboardDirectorContractEditor
                      key={editingAgent.id}
                      agentId={editingAgent.id}
                      prompt={editingAgent.system_prompt || ""}
                      value={editingAgent.output_style || {}}
                      disabled={agentSaveBusy}
                      onChange={(value) => {
                        if (agentEditSessionRef.current !== agentEditSession || !agentEditorAccessRef.current.prompts) return;
                        directorContractActionRef.current = null;
                        setEditingAgent((current) => current ? { ...current, output_style: value } : current);
                      }}
                      onRollback={hasActivatedStoryboardDirectorContract(editOriginalAgentRef.current?.output_style)
                        ? () => { if (agentEditSessionRef.current === agentEditSession && agentEditorAccessRef.current.prompts) directorContractActionRef.current = "rollback"; }
                        : undefined}
                    />}
                    {canEditPrompts && <StoryboardPromptPushCapabilityToggle
                      agentId={editingAgent.id}
                      value={editingAgent.output_style || {}}
                      disabled={agentSaveBusy}
                      onChange={(value) => {
                        if (agentEditSessionRef.current !== agentEditSession || !agentEditorAccessRef.current.prompts) return;
                        setEditingAgent((current) => current ? { ...current, output_style: value } : current);
                      }}
                    />}
                    {/* 提示词版本历史 */}
                    <div className="mt-3 p-3 rounded-lg bg-[var(--card)] border border-[var(--border)] space-y-3">
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <p className="text-xs font-semibold text-[var(--foreground)]">生图能力</p>
                          <p className="text-[10px] text-[var(--muted-foreground)]">启用后，该智能体的聊天回复会走图片生成并展示图片画廊。</p>
                        </div>
                        <button
                          type="button"
                          onClick={() => {
                            const imgGen = editingAgent.output_style?.hybridImageGeneration;
                            if (imgGen?.enabled) {
                              const newOutputStyle = { ...(editingAgent.output_style || {}) };
                              delete newOutputStyle.hybridImageGeneration;
                              setEditingAgent({ ...editingAgent, output_style: newOutputStyle as OutputStyle | undefined });
                              return;
                            }
                            const first = activeDrawingModels[0];
                            if (first) applyDrawingModelToEditingAgent(first.model_name);
                            else showMessage("error", "请先在模型管理里启用至少一个绘图模型");
                          }}
                          className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${editingAgent.output_style?.hybridImageGeneration?.enabled ? "bg-[var(--primary)] text-white" : "bg-[var(--background)] text-[var(--muted-foreground)] border border-[var(--border)]"}`}
                        >
                          {editingAgent.output_style?.hybridImageGeneration?.enabled ? "已启用" : "未启用"}
                        </button>
                      </div>
                      {editingAgent.output_style?.hybridImageGeneration?.enabled && (
                        <div className="space-y-2">
                          {activeDrawingModels.length > 0 ? (
                            <select value={editingAgent.output_style?.hybridImageGeneration?.model || ""} onChange={(e) => applyDrawingModelToEditingAgent(e.target.value)} className={inputCls + " text-sm"}>
                              {activeDrawingModels.map(m => (
                                <option key={m.id} value={m.model_name}>{m.name}{m.model_name !== m.name ? ` (${m.model_name})` : ""}</option>
                              ))}
                            </select>
                          ) : (
                            <div className="p-2 rounded-lg bg-amber-500/10 border border-amber-500/20 text-[10px] text-amber-700 dark:text-amber-400">
                              暂无可用绘图模型，请先到「模型管理」启用封面/绘图模型。
                            </div>
                          )}
                          <p className="text-[10px] text-[var(--muted-foreground)]">保存时只记录模型标识，不绑定文字模型 UUID。</p>
                        </div>
                      )}
                    </div>
                    {canEditPrompts && <PromptVersionHistory
                      ref={editPromptVersionRef}
                      agentId={editingAgent.id || ""}
                      currentPrompt={editingAgent.system_prompt || ""}
                      onRestore={(prompt) => setEditingAgent({ ...editingAgent, system_prompt: prompt })}
                      authHeaders={{ Authorization: `Bearer ${safeLocalStorageGet(STORAGE_KEYS.AUTH_TOKEN)}` }}
                    />}
                  </div>
                  )}
                  </>
                  )}
                  {/* 非LLM类型也支持编辑systemPrompt */}
                  {editingAgent.source !== "llm" && canReadPrompts && (
                  <div className="col-span-2">
                    <label className={labelCls}>提示词（可选，仅展示用）</label>
                    <textarea
                      value={editingAgent.system_prompt || ""}
                      onChange={(e) => { if (canEditPrompts) setEditingAgent({ ...editingAgent, system_prompt: e.target.value }); }}
                      readOnly={!canEditPrompts}
                      onKeyDown={(e) => {
                        if (e.key === "Backspace" && e.target instanceof HTMLTextAreaElement) {
                          const ta = e.target as HTMLTextAreaElement;
                          if (ta.selectionStart > 0 || ta.selectionStart !== ta.selectionEnd) return;
                          e.preventDefault();
                        }
                      }}
                      className="w-full h-[80px] p-2 rounded-lg border border-[var(--border)] bg-[var(--background)] text-xs font-mono leading-relaxed resize-none focus:outline-none focus:ring-1 focus:ring-[var(--primary)]"
                      placeholder="可选：填写提示词概要..."
                    />
                  </div>
                  )}
                  {/* 计费配置 — 选模型自动绑定计费，无需手动切换 */}
                  <div className="col-span-2 p-3 rounded-lg bg-[var(--muted)]/10 border border-[var(--border)] space-y-3">
                    <div className="flex items-center gap-2">
                      <svg className="w-4 h-4 text-[var(--primary)]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><path d="M16 8h-6a2 2 0 100 4h4a2 2 0 010 4H8"/><path d="M12 18V6"/></svg>
                      <span className="text-sm font-semibold text-[var(--foreground)]">计费配置</span>
                    </div>
                    {editingAgent.model_id ? (
                      /* 已关联模型 — 自动按模型计费 */
                      <div className="p-2.5 rounded-lg bg-emerald-500/5 border border-emerald-500/15 space-y-2">
                        <div className="flex items-center gap-2">
                          <svg className="w-3.5 h-3.5 text-emerald-600" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M20 6L9 17l-5-5"/></svg>
                          <span className="text-xs text-emerald-600 font-medium">按模型计费（自动）</span>
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-600 border border-emerald-500/20">已关联</span>
                        </div>
                        <div className="flex items-center gap-4 text-[11px] text-[var(--muted-foreground)]">
                          <span>模型: <b className="text-[var(--foreground)]">{editingAgent.model || "未知"}</b></span>
                          {(() => {
                            const m = llmModels.find(x => x.id === editingAgent.model_id);
                            if (m && m.token_billing_enabled) {
                              return (
                                <>
                                  {m.input_cost_per_million != null && <span>输入: ¥{m.input_cost_per_million}/M</span>}
                                  {m.output_cost_per_million != null && <span>输出: ¥{m.output_cost_per_million}/M</span>}
                                  {m.profit_margin != null && <span>利润率: {m.profit_margin}%</span>}
                                </>
                              );
                            }
                            return <span>使用全局计费配置</span>;
                          })()}
                        </div>
                        <p className="text-[10px] text-[var(--muted-foreground)]">切换模型会自动更换计费费率，无需手动设置</p>
                      </div>
                    ) : (
                      /* 未关联模型 — 按全局配置计费 */
                      <div className="p-2.5 rounded-lg bg-[var(--background)] border border-[var(--border)] space-y-2">
                        <div className="flex items-center gap-2">
                          <svg className="w-3.5 h-3.5 text-[var(--muted-foreground)]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>
                          <span className="text-xs text-[var(--muted-foreground)] font-medium">按全局配置计费</span>
                        </div>
                        <p className="text-[10px] text-[var(--muted-foreground)]">未关联预设模型，将使用全局计费参数（进货价+利润率自动计算）</p>
                        <p className="text-[10px] text-amber-600">建议选择预设模型，自动绑定对应计费费率</p>
                      </div>
                    )}
                  </div>
                  <div><label className={labelCls}>排序权重</label><input type="number" value={editingAgent.sort_order} onChange={(e) => setEditingAgent({ ...editingAgent, sort_order: Number(e.target.value) })} className={inputCls} /></div>
                  {/* 启用/禁用开关 */}
                  <div className="flex items-center gap-3">
                    <label className={labelCls}>学员可用</label>
                    <button
                      type="button"
                      onClick={() => setEditingAgent({ ...editingAgent, is_active: !editingAgent.is_active })}
                      className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors cursor-pointer ${editingAgent.is_active ? 'bg-[var(--primary)]' : 'bg-[var(--border)]'}`}
                    >
                      <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform shadow-sm ${editingAgent.is_active ? 'translate-x-6' : 'translate-x-1'}`} />
                    </button>
                    <span className={`text-xs font-medium ${editingAgent.is_active ? 'text-[var(--primary)]' : 'text-[var(--muted-foreground)]'}`}>
                      {editingAgent.is_active ? '已启用 — 学员可使用' : '未启用 — 学员看到"正在开发中"'}
                    </span>
                  </div>
                </div>

                {/* 提问模板 - 双模式编辑器 */}
                <div>
                  <label className="text-sm font-semibold text-[var(--foreground)] mb-2 block">提问模板</label>
                  <p className="text-[10px] text-[var(--muted-foreground)] mb-2">定义用户使用此智能体时需要填写的字段，用户端将以表单弹窗展示</p>
                  <PresetTemplateEditor
                    value={presetToTemplate(editingAgent.preset_fields || [])}
                    onChange={(fields) => setEditingAgent({ ...editingAgent, preset_fields: templateToPreset(fields) })}
                  />
                </div>

                {/* 高级配置 - 编辑模式 */}
                <div className="border border-[var(--border)] rounded-lg overflow-hidden">
                  <button
                    type="button"
                    onClick={() => setEditShowAdvanced(!editShowAdvanced)}
                    className="w-full flex items-center justify-between px-4 py-2.5 bg-[var(--muted)]/30 hover:bg-[var(--muted)]/50 transition-colors text-sm font-medium text-[var(--foreground)]"
                  >
                    <span className="flex items-center gap-2">
                      <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4"/></svg>
                      高级配置
                    </span>
                    <svg className={`w-4 h-4 transition-transform ${editShowAdvanced ? "rotate-180" : ""}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M6 9l6 6 6-6"/></svg>
                  </button>
                  {editShowAdvanced && (
                    <div className="p-4 space-y-4 bg-[var(--card)]">
                      {/* 对话轮数 + 上下文Tokens */}
                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <label className="text-[10px] text-[var(--muted-foreground)]">对话轮数</label>
                          <input type="number" min={0} value={editingAgent.max_context_rounds ?? 30} onChange={(e) => setEditingAgent({ ...editingAgent, max_context_rounds: Number(e.target.value) })} className={inputCls + " text-sm"} placeholder="30" />
                          <p className="text-[10px] text-[var(--muted-foreground)] mt-0.5">保留最近N轮对话，0=不限</p>
                        </div>
                        <div>
                          <label className="text-[10px] text-[var(--muted-foreground)]">上下文Tokens</label>
                          <input type="number" min={0} value={editingAgent.max_context_tokens ?? 0} onChange={(e) => setEditingAgent({ ...editingAgent, max_context_tokens: Number(e.target.value) })} className={inputCls + " text-sm"} placeholder="0" />
                          <p className="text-[10px] text-[var(--muted-foreground)] mt-0.5">上下文窗口上限，0=由模型决定</p>
                        </div>
                      </div>
                      {/* 回复Tokens + 超时 */}
                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <label className="text-[10px] text-[var(--muted-foreground)]">回复Tokens</label>
                          <input type="number" min={0} value={editingAgent.max_reply_tokens ?? 16384} onChange={(e) => setEditingAgent({ ...editingAgent, max_reply_tokens: Number(e.target.value) })} className={inputCls + " text-sm"} placeholder="16384" />
                          <p className="text-[10px] text-[var(--muted-foreground)] mt-0.5">单次回复上限，0=不限</p>
                        </div>
                        <div>
                          <label className="text-[10px] text-[var(--muted-foreground)]">超时时间(秒)</label>
                          <input type="number" min={30} value={editingAgent.timeout ?? 300} onChange={(e) => setEditingAgent({ ...editingAgent, timeout: Number(e.target.value) })} className={inputCls + " text-sm"} placeholder="300" />
                        </div>
                      </div>
                      {/* 深度思考模式 + 思考系数 */}
                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <label className="text-[10px] text-[var(--muted-foreground)]">深度思考模式</label>
                          <select value={editingAgent.deep_thinking_type ?? 0} onChange={(e) => setEditingAgent({ ...editingAgent, deep_thinking_type: Number(e.target.value) })} className={inputCls + " text-sm"}>
                            <option value={0}>不开启</option>
                            <option value={1}>全局思考(推理→对话)</option>
                            <option value={2}>自带思考(模型推理)</option>
                          </select>
                          <p className="text-[10px] text-[var(--muted-foreground)] mt-0.5">未配置时自动检测推理模型</p>
                        </div>
                        <div>
                          <label className="text-[10px] text-[var(--muted-foreground)]">思考积分系数</label>
                          <input type="number" min={1} step={0.1} value={editingAgent.deduct_deep_think ?? 1} onChange={(e) => setEditingAgent({ ...editingAgent, deduct_deep_think: Number(e.target.value) })} className={inputCls + " text-sm"} placeholder="1" />
                          <p className="text-[10px] text-[var(--muted-foreground)] mt-0.5">思考模式扣费=基础积分x系数</p>
                        </div>
                      </div>
                      {/* 温度 + 输出格式 */}
                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <label className="text-[10px] text-[var(--muted-foreground)]">温度系数</label>
                          <input type="number" min={0} max={2} step={0.1} value={editingAgent.temperature ?? ""} onChange={(e) => setEditingAgent({ ...editingAgent, temperature: e.target.value === "" ? undefined : Number(e.target.value) })} className={inputCls + " text-sm"} placeholder="模型默认" />
                          <p className="text-[10px] text-[var(--muted-foreground)] mt-0.5">0-2，越高越随机</p>
                        </div>
                        <div>
                          <label className="text-[10px] text-[var(--muted-foreground)]">输出格式</label>
                          <select value={editingAgent.response_format ?? ""} onChange={(e) => setEditingAgent({ ...editingAgent, response_format: (e.target.value || undefined) as "text" | "markdown" | "json_object" | undefined })} className={inputCls + " text-sm"}>
                            <option value="">模型默认</option>
                            <option value="text">文本(text)</option>
                            <option value="markdown">Markdown</option>
                            <option value="json_object">JSON</option>
                          </select>
                        </div>
                      </div>
                      {/* 联网搜索 + 频率限制 */}
                      <div className="grid grid-cols-2 gap-3">
                        <div className="flex items-center gap-3">
                          <label className="text-[10px] text-[var(--muted-foreground)]">联网搜索</label>
                          <button type="button" onClick={() => setEditingAgent({ ...editingAgent, enable_web_search: !editingAgent.enable_web_search })}
                            className={`relative w-9 h-5 rounded-full transition-colors ${editingAgent.enable_web_search ? 'bg-[var(--primary)]' : 'bg-[var(--border)]'}`}>
                            <span className={`absolute top-0.5 ${editingAgent.enable_web_search ? 'left-4' : 'left-0.5'} w-4 h-4 rounded-full bg-white shadow transition-all`} />
                          </button>
                        </div>
                        <div>
                          <label className="text-[10px] text-[var(--muted-foreground)]">频率限制(次/时)</label>
                          <input type="number" min={0} value={editingAgent.frequency_limit ?? 50} onChange={(e) => setEditingAgent({ ...editingAgent, frequency_limit: Number(e.target.value) })} className={inputCls + " text-sm"} placeholder="50" />
                          <p className="text-[10px] text-[var(--muted-foreground)] mt-0.5">每用户每小时，0=不限</p>
                        </div>
                      </div>
                      {/* 图片解析 + 文件解析 */}
                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <label className="text-[10px] text-[var(--muted-foreground)]">图片解析</label>
                          <select value={editingAgent.image_parsing ?? "none"} onChange={(e) => setEditingAgent({ ...editingAgent, image_parsing: e.target.value })} className={inputCls + " text-sm"}>
                            <option value="none">不解析</option>
                            <option value="auto">自动</option>
                            <option value="forced">强制</option>
                          </select>
                        </div>
                        <div>
                          <label className="text-[10px] text-[var(--muted-foreground)]">文件解析</label>
                          <select value={editingAgent.file_parsing ?? "none"} onChange={(e) => setEditingAgent({ ...editingAgent, file_parsing: e.target.value })} className={inputCls + " text-sm"}>
                            <option value="none">不解析</option>
                            <option value="auto">自动</option>
                            <option value="forced">强制</option>
                          </select>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
                </div>
                </div>
                {/* 底部按钮 - 固定不滚动 */}
                <div className="flex gap-3 px-6 py-4 border-t border-[var(--border)] shrink-0">
                  <button onClick={handleUpdateAgent} disabled={agentSaveBusy || editPromptReading} className={`${btnPrimary} disabled:cursor-not-allowed disabled:opacity-50`}>{agentSaveBusy ? "保存中…" : editPromptReading ? "读取文件中…" : "保存修改"}</button>
                  <button onClick={handleCancelEdit} className={btnGhost}>取消</button>
                </div>
              </div>
            </div>
            )}
            <div className="bg-[var(--card)] rounded-2xl border border-[var(--border)] overflow-hidden">
              {/* 拖拽排序保存提示 */}
              {canManageAgents && Object.keys(pendingAgentSortOrders).length > 0 && (
                <div className="flex items-center justify-between px-4 py-2 bg-blue-500/10 border-b border-blue-500/20">
                  <span className="text-xs text-blue-600 font-medium">排序已修改，请保存或放弃草稿</span>
                  <div className="flex gap-2">
                    <button type="button" disabled={agentSortSaving} onClick={() => { pendingAgentRevisionsRef.current = {}; setPendingAgentSortOrders({}); }} className="px-3 py-1 text-xs text-blue-600 disabled:opacity-50">放弃排序</button>
                    <button onClick={handleSaveAgentSortOrders} disabled={hasAgentSearchQuery || agentSortSaving} title={hasAgentSearchQuery ? "请先清空搜索再保存排序" : undefined} className="px-3 py-1 bg-blue-500 hover:bg-blue-600 text-white rounded-md text-xs font-medium transition-colors shadow-sm disabled:cursor-not-allowed disabled:opacity-50">
                      {agentSortSaving ? "保存中…" : "保存排序"}
                    </button>
                  </div>
                </div>
              )}
              <table className="w-full">
                <thead className="bg-[var(--card)] border-b border-[var(--border)]">
                  <tr>
                    <th className="text-left px-2 py-3 text-xs font-medium text-[var(--muted-foreground)] w-8"></th>
                    {["头像", "名称", "前台分类 / 原始分类", "来源", "模型", "计费模式", "状态", "操作"].map((h) => (
                      <th key={h} className={`text-left px-4 py-3 text-xs font-medium text-[var(--muted-foreground)] uppercase ${h === "操作" ? "text-right" : ""}`}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--border)]">
                  {getFilteredAndSortedAgents().map((agent, idx) => {
                    const isDragTarget = dragOverAgentId === agent.id;
                    const isDragged = draggedAgentId === agent.id;
                    return (
                      <tr key={agent.id}
                        className={`transition-colors ${isDragged ? "opacity-40 bg-[var(--border)]" : isDragTarget ? "bg-[var(--primary)]/[0.06]" : "hover:bg-[var(--border)]"}`}
                        draggable={canDragAgentRows}
                        onDragStart={(e) => {
                          if (!canDragAgentRows) return;
                          e.dataTransfer.setData("agent-id", agent.id);
                          e.dataTransfer.setData("agent-category", agent.category);
                          e.dataTransfer.effectAllowed = "move";
                          setDraggedAgentId(agent.id);
                          setDragOverAgentId(null);
                        }}
                        onDragOver={(e) => {
                          if (!canDragAgentRows) return;
                          e.preventDefault();
                          e.dataTransfer.dropEffect = "move";
                          if (draggedAgentId && draggedAgentId !== agent.id && agents.find((item) => item.id === draggedAgentId)?.category === agent.category) {
                            const rect = e.currentTarget.getBoundingClientRect();
                            const midY = rect.top + rect.height / 2;
                            setDragOverAgentId(agent.id);
                            setDragOverPosition(e.clientY < midY ? "before" : "after");
                          }
                        }}
                        onDragLeave={(e) => {
                          if (e.currentTarget.contains(e.relatedTarget as Node)) return;
                          if (dragOverAgentId === agent.id) {
                            setDragOverAgentId(null);
                          }
                        }}
                        onDrop={(e) => {
                          if (!canDragAgentRows) return;
                          e.preventDefault();
                          const draggedId = e.dataTransfer.getData("agent-id");
                          const draggedCat = e.dataTransfer.getData("agent-category");
                          setDragOverAgentId(null);
                          setDraggedAgentId(null);
                          if (!draggedId) return;
                          if (draggedCat === agent.category && draggedId !== agent.id) {
                            // 同分类内排序
                            handleDragReorderAgent(draggedId, agent.id, dragOverPosition);
                          } else if (draggedCat !== agent.category) showMessage("error", "排序只能在同一原始分类内进行；迁移请使用分类操作。");
                        }}
                        onDragEnd={() => { setDraggedAgentId(null); setDragOverAgentId(null); }}
                      >
                        {/* 拖拽手柄列 + 插入指示线 */}
                        <td className="px-1 py-3 relative">
                          {canDragAgentRows && <span className="cursor-grab active:cursor-grabbing text-[var(--muted-foreground)]/40 hover:text-[var(--muted-foreground)] select-none" title="拖拽排序">⠿</span>}
                          {isDragTarget && dragOverPosition === "before" && !isDragged && (
                            <div className="absolute top-0 left-0 right-0 h-0.5 bg-[var(--primary)] rounded-full z-20 shadow-[0_0_6px_var(--primary)]" />
                          )}
                          {isDragTarget && dragOverPosition === "after" && !isDragged && (
                            <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-[var(--primary)] rounded-full z-20 shadow-[0_0_6px_var(--primary)]" />
                          )}
                        </td>
                        <td className="px-4 py-3">
                          <div className="w-11 h-11 rounded-lg bg-[var(--border)] border border-[var(--border)] flex items-center justify-center overflow-hidden flex-shrink-0">
                            <img key={agent.id + agent.avatar} src={resolveTrashAvatarSrc(agent)} alt={agent.name} className="w-full h-full object-cover" onError={(event) => { const image = event.currentTarget; if (!image.dataset.fallback) { image.dataset.fallback = '1'; image.src = getSemanticAgentAvatarFallback(agent.id, agent.name); } }} />
                          </div>
                        </td>
                        <td className="px-4 py-3"><div className="font-medium text-[var(--foreground)] text-sm">{agent.name}</div><div className="text-xs text-[var(--muted-foreground)] mt-0.5">{(agent.description as string)?.slice(0, 40)}</div></td>
                        <td className="px-4 py-3">
                          <div className="group relative">
                            <span className="block text-sm text-[var(--secondary-foreground)]">{adminDisplayCategoryLabel(displayCategory(agent))}</span>
                            <span className="text-xs text-[var(--muted-foreground)] cursor-pointer hover:text-[var(--primary)]">原始：{agent.category || "未分类"}</span>
                            {canManageAgents && <div className="absolute left-0 top-full mt-1 bg-[var(--card)] border border-[var(--border)] rounded-lg shadow-xl py-1 z-10 hidden group-hover:block min-w-[120px]">
                              <div className="text-[10px] text-[var(--muted-foreground)] px-3 py-1">迁移到：</div>
                              {categoryOptions.filter((c) => c !== agent.category).map((c) => (
                                <button key={c} onClick={async () => {
                                  await handleMoveAgentToCategory(agent.id, c);
                                }} className="block w-full text-left px-3 py-1.5 text-xs text-[var(--secondary-foreground)] hover:bg-[var(--border)] hover:text-[var(--foreground)] transition-colors">{c}</button>
                              ))}
                            </div>}
                          </div>
                        </td>
                        <td className="px-4 py-3"><span className={`px-2 py-0.5 rounded-md text-xs font-medium ${agent.source === "llm" ? "bg-[var(--primary)]/15 text-[var(--primary)]" : agent.source === "coze_coding" ? "bg-emerald-500/15 text-emerald-600" : "bg-amber-500/15 text-amber-600"}`}>{agent.source === "llm" ? "LLM" : agent.source === "coze_coding" ? "编程" : "Coze"}</span></td>
                        <td className="px-4 py-3 text-sm text-[var(--secondary-foreground)]">{agent.configuration_access === "visible" ? (agent.source === "llm" ? (agent.model_id ? (llmModels.find(m => m.id === agent.model_id)?.model_name || agent.model || "-") : "未绑定模型，请编辑选择") : agent.source === "coze_coding" ? <span title={agent.coze_coding_project_id || agent.bot_id}>Proj: {(agent.coze_coding_project_id || agent.bot_id as string)?.slice(0, 8)}...</span> : <span title={agent.bot_id}>Bot: {(agent.bot_id as string)?.slice(0, 8)}...</span>) : "—"}</td>
                        <td className="px-4 py-3 text-sm">
                          {agent.configuration_access === "visible" ? <div className="flex flex-col gap-0.5">
                            {agent.model_id && agent.model_billing?.token_billing_enabled ? (
                              <>
                                <span className="text-emerald-600 font-medium">按模型计费</span>
                                <span className="text-[10px] text-emerald-600 bg-emerald-500/10 border border-emerald-500/15 rounded px-1 py-0 inline-flex items-center gap-0.5 w-fit">TOKEN</span>
                              </>
                            ) : (
                              <span className="text-[var(--muted-foreground)] text-xs">全局配置</span>
                            )}
                          </div> : <span className="text-[var(--muted-foreground)]">—</span>}
                        </td>
                        <td className="px-4 py-3">{canManageAgents ? <button onClick={() => handleToggleAgentActive(agent)} className={`px-2 py-0.5 rounded-md text-xs font-medium cursor-pointer ${agent.is_active ? "bg-[var(--primary)]/20 text-[var(--primary)]" : "bg-[var(--border)] text-[var(--muted-foreground)]"}`}>{agent.is_active ? "启用" : "禁用"}</button> : <span className="text-xs text-[var(--secondary-foreground)]">{agent.is_active ? "启用" : "禁用"}</span>}</td>
                        <td className="px-4 py-3">
                          {canManageAgents ? <select
                            value={agent.user_access || "available"}
                            onChange={async (e) => {
                              const res = await fetch("/api/admin/agents", { method: "PUT", headers: authHeaders, body: JSON.stringify(buildAgentMutationPayload(agent, { user_access: e.target.value })) });
                              if (res.ok) { showSuccessAndSync("权限已更新"); loadAgents(); }
                            }}
                            className="text-xs border border-[var(--border)] rounded px-1.5 py-0.5 bg-[var(--background)] text-[var(--foreground)]"
                          >
                            <option value="available">可用</option>
                            <option value="hidden">隐藏</option>
                          </select> : <span className="text-xs text-[var(--secondary-foreground)]">{agent.user_access === "hidden" ? "隐藏" : "可用"}</span>}
                        </td>
                        <td className="px-4 py-3 text-right space-x-2">
                          {canReadPrompts && <button type="button" onClick={() => setViewingPromptAgentId((current) => current === agent.id ? "" : agent.id)} className="text-xs text-[#175cd3] hover:underline">{viewingPromptAgentId === agent.id ? "收起提示词" : "查看提示词"}</button>}
                          {canManageAgentConfiguration && <button onClick={() => handleEditAgent(agent)} className="text-xs text-[var(--primary)] hover:underline cursor-pointer">编辑</button>}
                          {canManageAgentConfiguration && <button onClick={() => handleDuplicateAgent(agent)} className="text-xs text-emerald-500 hover:text-emerald-400 cursor-pointer">创建副本</button>}
                          {canManageAgents && <button type="button" onClick={() => handleDeleteAgent(agent)} className="text-xs text-[var(--destructive)] hover:text-[#FF6B6B] cursor-pointer">删除</button>}
                        </td>
                      </tr>
                    );
                  })}
                  {getFilteredAndSortedAgents().length === 0 && (<tr><td colSpan={9} className="text-center py-8 text-[var(--muted-foreground)] text-sm">{hasAgentSearchQuery ? "没有找到匹配的智能体，请调整关键词或清空搜索。" : "暂无智能体，点击上方按钮添加"}</td></tr>)}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* ========= Trash Tab ========= */}
        {activeTab === "trash" && (
          <div>
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold text-[var(--foreground)]">回收站 ({trashedAgents.length})</h2>
              <p className="text-sm text-[var(--muted-foreground)]">删除的智能体可在此恢复</p>
            </div>
            {trashedAgents.length === 0 ? (
              <div className="text-center py-16 text-[var(--muted-foreground)]">
                <svg className="w-16 h-16 mx-auto mb-4 opacity-30" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" /></svg>
                <p>回收站为空</p>
              </div>
            ) : (
              <div className="space-y-2.5">
                {trashedAgents.map((agent) => {
                  const avatarSrc = resolveTrashAvatarSrc(agent);
                  const deletedLabel = agent.deleted_at
                    ? new Date(agent.deleted_at).toLocaleString("zh-CN", { dateStyle: "short", timeStyle: "short" })
                    : "删除时间未知";
                  const sourceLabel = agent.source === "llm" ? "LLM 直连" : agent.source === "coze_coding" ? "扣子编程" : "Coze 平台";
                  return (
                    <div
                      key={agent.id}
                      className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 rounded-xl border border-[var(--border)] bg-[var(--card)]/75 px-3 py-2.5 transition-colors hover:border-[var(--primary)]/35 hover:bg-[var(--card)]"
                    >
                      <div className="h-11 w-11 shrink-0 overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--muted)]/35">
                        <img
                          src={avatarSrc}
                          alt=""
                          className="h-full w-full object-cover"
                          loading="lazy"
                          onError={(event) => {
                            const image = event.currentTarget;
                            if (image.dataset.fallbackApplied === "true") return;
                            image.dataset.fallbackApplied = "true";
                            image.src = getSemanticAgentAvatarFallback(agent.id, agent.name);
                          }}
                        />
                      </div>
                      <div className="min-w-0 flex items-center gap-x-4 gap-y-0.5">
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-semibold text-[var(--foreground)]" title={agent.name}>{agent.name}</p>
                          <p className="truncate text-xs text-[var(--muted-foreground)]" title={`${agent.category} · ${sourceLabel}`}>
                            {agent.category || "未分类"}<span className="mx-1.5 opacity-50">·</span>
                            <span className={agent.source === "llm" ? "text-[var(--primary)]" : agent.source === "coze_coding" ? "text-emerald-500" : "text-amber-500"}>{sourceLabel}</span>
                          </p>
                        </div>
                        <span className="hidden shrink-0 whitespace-nowrap text-xs text-[var(--muted-foreground)] sm:inline">删除于 {deletedLabel}</span>
                      </div>
                      <div className="flex shrink-0 items-center gap-1.5">
                        <button onClick={() => handleRestoreAgent(agent)} className="rounded-lg bg-[var(--primary)] px-3 py-1.5 text-xs font-medium text-white transition hover:opacity-90">恢复</button>
                        <button onClick={() => handlePermanentDelete(agent)} className="rounded-lg bg-[var(--destructive)] px-3 py-1.5 text-xs font-medium text-white transition hover:opacity-90">永久删除</button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* ========= Users Tab ========= */}
        {activeTab === "users" && (
          <div ref={memberWorkspaceRef} data-testid="admin-member-workspace">
            {/* 学员管理子Tab */}
            <div className="flex items-center gap-1 p-0.5 rounded-lg bg-[var(--muted)]/30 w-fit mb-4">
              {[
                { key: "members" as const, label: "会员名单", icon: User },
                { key: "chats" as const, label: "聊天记录", icon: MessageSquare },
                { key: "recharge" as const, label: "充值记录", icon: Wallet },
                { key: "consumption" as const, label: "消费明细", icon: FileText },
              ].filter((tab) => {
                if (tab.key === "chats") return canViewMemberContent;
                if (tab.key === "recharge" || tab.key === "consumption") return canViewBilling;
                return true;
              }).map(tab => (
                <button key={tab.key} onClick={() => setUserSubTab(tab.key)} aria-current={userSubTab === tab.key ? "page" : undefined}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition whitespace-nowrap ${
                    userSubTab === tab.key ? "bg-[var(--primary)] text-white shadow-sm" : "text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
                  }`}>
                  <tab.icon className="h-3.5 w-3.5" />
                  {tab.label}
                </button>
              ))}
            </div>

            {/* ── 会员名单 ── */}
            {userSubTab === "members" && (
            (() => {
              const fixtureCount = users.filter(u => u.role !== "admin" && isFixtureUser(u)).length;
              const realUsers = users.filter(u => u.role !== "admin" && !isFixtureUser(u));
              const inactiveCount = realUsers.filter(u => !u.memberStatus || u.memberStatus === "inactive").length;
              const activeCount = realUsers.filter(u => u.memberStatus === "active").length;
              const expiredCount = realUsers.filter(u => u.memberStatus === "expired").length;
              const trialCount = realUsers.filter(u => u.memberStatus === "trial").length;
              const filteredUsers = users.filter(u => {
                if (u.role === "admin" && memberFilter !== "all") return false;
                if (memberFilter === "test" && !isFixtureUser(u)) return false;
                if (isFixtureUser(u) && memberFilter !== "all" && memberFilter !== "test") return false;
                const membership = u.memberStatus || "inactive";
                if (memberFilter !== "all" && memberFilter !== "test" && membership !== memberFilter) return false;
                if (userSearch.trim()) {
                  const q = userSearch.trim().toLowerCase();
                  const name = (u.name || u.displayName || "").toLowerCase();
                  const phone = (u.phone || "").toLowerCase();
                  const email = (u.email || "").toLowerCase();
                  if (!name.includes(q) && !phone.includes(q) && !email.includes(q)) return false;
                }
                return true;
              });
              return (
              <>
              <div className="mb-5 space-y-4">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div>
                    <h2 className="text-xl font-semibold text-[var(--foreground)]">学员与会员</h2>
                    <p className="mt-1 text-sm text-[var(--muted-foreground)]">统一查看账号身份、会员权益、资产、智能体导航栏与最近活动。</p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {inactiveCount > 0 && <span className="rounded-xl border border-amber-500/20 bg-amber-500/8 px-3 py-2 text-xs font-semibold text-amber-600">{inactiveCount} 人待逐一核对付款；禁止批量激活</span>}
                    {hasMembersManagePermission && <button onClick={() => { if (!canManageMembers) { setUnlockDialogRequested(true); return; } loadCategories(); setShowAddUser(true); }} className={btnPrimary}>+ 添加学员</button>}
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5">
                  {[
                    { label: "真实学员", value: realUsers.length, tone: "text-[var(--foreground)]" },
                    { label: "正式会员", value: activeCount, tone: "text-emerald-500" },
                    { label: "试用中", value: trialCount, tone: "text-blue-500" },
                    { label: "未激活", value: inactiveCount, tone: "text-amber-500" },
                    { label: "已过期", value: expiredCount, tone: "text-orange-500" },
                  ].map(item => (
                    <div key={item.label} className="rounded-2xl border border-[var(--border)] bg-[var(--card)] px-4 py-3">
                      <p className="text-sm text-[var(--muted-foreground)]">{item.label}</p>
                      <p className={`mt-1 text-2xl font-semibold ${item.tone}`}>{item.value}</p>
                    </div>
                  ))}
                </div>

                <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-[var(--border)] bg-[var(--card)] p-3">
                  <div className="flex flex-wrap items-center gap-1.5">
                    {[
                      { key: "all" as const, label: "全部", count: users.length },
                      { key: "inactive" as const, label: "未激活", count: inactiveCount },
                      { key: "trial" as const, label: "试用", count: trialCount },
                      { key: "active" as const, label: "正式", count: activeCount },
                      { key: "expired" as const, label: "过期", count: expiredCount },
                      ...(fixtureCount > 0 ? [{ key: "test" as const, label: "测试/可疑", count: fixtureCount }] : []),
                    ].map(f => (
                      <button key={f.key} type="button" aria-pressed={memberFilter === f.key} onClick={() => setMemberFilter(f.key)}
                        className={`rounded-lg px-3 py-2 text-sm font-medium transition-colors ${memberFilter === f.key ? "bg-[var(--primary)] text-white" : "text-[var(--secondary-foreground)] hover:bg-[var(--accent)]"}`}>
                        {f.label} <span className="ml-1 opacity-75">{f.count}</span>
                      </button>
                    ))}
                  </div>
                  <div className="relative">
                    <input value={userSearch} onChange={(e) => setUserSearch(e.target.value)} placeholder="搜索姓名/手机/邮箱..."
                      className="w-64 rounded-xl border border-[var(--border)] bg-[var(--background)] py-2.5 pl-10 pr-3 text-sm text-[var(--foreground)] outline-none placeholder:text-[var(--muted-foreground)] focus:border-[var(--primary)]" />
                    <svg className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-[var(--muted-foreground)]" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg>
                  </div>
                </div>
              </div>
              {fixtureCount > 0 && (
                <div className="mb-4 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-500">
                  已识别 {fixtureCount} 个测试/验收或可疑账号。它们不可激活为正式会员，也不会出现在充值下拉的默认可选学员中；建议先保留交易与登录证据，再执行隔离或删除。
                </div>
              )}
            {/* 添加用户表单 */}
            {canManageMembers && showAddUser && (
              <div className={`${cardCls} mb-4`}>
                <div className="mb-4 flex items-start justify-between gap-4">
                  <div>
                    <h3 className="text-lg font-semibold text-[var(--foreground)]">添加学员</h3>
                    <p className="mt-1 text-sm text-[var(--muted-foreground)]">QQ邮箱为必填身份，创建前必须完成邮箱验证码校验。</p>
                  </div>
                  <button onClick={() => setShowAddUser(false)} className={btnGhost}>关闭</button>
                </div>
                <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                  <div><label className={labelCls}>显示名称 *</label><input value={newUser.displayName} onChange={(e) => setNewUser({ ...newUser, displayName: e.target.value })} className={inputCls} placeholder="学员姓名" /></div>
                  <div><label className={labelCls}>手机号</label><input type="tel" maxLength={11} value={newUser.phone} onChange={(e) => setNewUser({ ...newUser, phone: e.target.value.replace(/\D/g, "") })} className={inputCls} placeholder="选填，用于手机号登录" /></div>
                  <div>
                    <label className={labelCls}>QQ邮箱 *</label>
                    <div className="flex gap-2">
                      <input type="email" value={newUser.email} onChange={(e) => setNewUser({ ...newUser, email: e.target.value.trim(), emailVerificationCode: "" })} className={inputCls} placeholder="123456789@qq.com" />
                      <button type="button" disabled={memberVerificationSending || !isQqEmail(newUser.email)} onClick={() => sendMemberVerificationCode({ purpose: "create", email: newUser.email })} className="shrink-0 rounded-xl border border-[var(--border)] px-4 text-sm font-medium text-[var(--foreground)] transition-colors hover:bg-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-40">
                        {memberVerificationSending ? "发送中" : "发送验证码"}
                      </button>
                    </div>
                  </div>
                  <div><label className={labelCls}>QQ邮箱验证码 *</label><input inputMode="numeric" maxLength={6} value={newUser.emailVerificationCode} onChange={(e) => setNewUser({ ...newUser, emailVerificationCode: e.target.value.replace(/\D/g, "") })} className={inputCls} placeholder="6位验证码" /></div>
                  <div><label className={labelCls}>初始密码</label><input type="password" autoComplete="new-password" value={newUser.password} onChange={(e) => setNewUser({ ...newUser, password: e.target.value })} className={inputCls} placeholder="至少 8 个字符，请设置独立密码" /></div>
                  <div><label className={labelCls}>角色</label>
                    <select value={newUser.role} onChange={(e) => setNewUser({ ...newUser, role: e.target.value })} className={inputCls}>
                      <option value="student">学员</option>
                      <option value="admin">管理员</option>
                    </select>
                  </div>
                  {canManageMemberPermissions && <div className="md:col-span-2">
                    <label className={labelCls}>智能体导航栏</label>
                    <p className="mb-2 text-sm text-[var(--muted-foreground)]">已选择的导航会出现在学员端，并开放该导航下的智能体；不选择任何导航时，该用户看不到且不能使用任何智能体。</p>
                    {/* 智能体导航栏 — 可多选（勾选=可见可用，不勾选=不可见） */}
                    <div>
                      <p className="mb-2 text-sm font-medium text-[var(--secondary-foreground)]">可用导航</p>
                      <div className="flex flex-wrap gap-2" data-testid="member-agent-permission-options">
                      <button
                        type="button"
                        onClick={() => setNewUser({ ...newUser, allowedCategories: [...ALL_AGENT_NAVIGATION_KEYS] })}
                        className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all border ${
                          newUser.allowedCategories.length === ALL_AGENT_NAVIGATION_KEYS.length
                            ? "bg-[var(--foreground)] text-[var(--background)] border-[var(--foreground)]"
                            : "bg-[var(--card)] text-[var(--secondary-foreground)] border-[var(--border)] hover:border-[var(--foreground)]"
                        }`}
                      >
                        全选导航
                      </button>
                      {AGENT_NAVIGATION_OPTIONS.map((option) => (
                        <button
                          key={option.key}
                          type="button"
                          onClick={() => {
                            const newCats = newUser.allowedCategories.includes(option.key)
                              ? newUser.allowedCategories.filter((key: string) => key !== option.key)
                              : [...newUser.allowedCategories, option.key];
                            setNewUser({ ...newUser, allowedCategories: newCats });
                          }}
                          className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all border ${
                            newUser.allowedCategories.includes(option.key)
                              ? "bg-[var(--foreground)] text-[var(--background)] border-[var(--foreground)]"
                              : "bg-[var(--card)] text-[var(--secondary-foreground)] border-[var(--border)] hover:border-[var(--foreground)]"
                          }`}
                        >
                          {option.label}
                        </button>
                      ))}
                    </div>
                    </div>
                  </div>}
                </div>
                <p className="mt-3 rounded-xl bg-[var(--muted)]/30 px-3 py-2 text-sm text-[var(--muted-foreground)]">初始积分固定为 0。创建后请使用“积分充值/调整”入口，确保每笔资产变化都有流水。</p>
                <div className="flex gap-3 mt-4">
                  <button onClick={handleAddUser} className={btnPrimary}>确认添加</button>
                  <button onClick={() => setShowAddUser(false)} className={btnGhost}>取消</button>
                </div>
              </div>
            )}
            <div className="space-y-3">
              {filteredUsers.map((user) => {
                const accountStatus = getUserAccountStatus(user);
                const membership = user.memberStatus || "inactive";
                const assignedNavigationKeys = getUserAllowedNavigationKeys(user);
                const resolvedNavigationNames = assignedNavigationKeys.flatMap((key) => {
                  const label = AGENT_NAVIGATION_OPTIONS.find((option) => option.key === key)?.label;
                  return label ? [label] : [];
                });
                const featureCount = user.featureNavigationKeys?.length || 0;
                const permissionLabel = `${featureCount} 项业务 · ${resolvedNavigationNames.length} 个智能体分类`;
                const memberLabel = user.role === "admin"
                  ? "系统管理员"
                  : membership === "active" ? "正式会员" : membership === "trial" ? "试用会员" : membership === "expired" ? "会员过期" : "未激活";
                const memberTone = user.role === "admin" || membership === "active"
                  ? "bg-emerald-500/10 text-emerald-500"
                  : membership === "trial" ? "bg-blue-500/10 text-blue-500" : membership === "expired" ? "bg-orange-500/10 text-orange-500" : "bg-[var(--muted)] text-[var(--secondary-foreground)]";
                const accountLabel = accountStatus === "active" ? "账号正常" : accountStatus === "suspended" ? "账号暂停" : "账号拉黑";
                const accountTone = accountStatus === "active" ? "text-emerald-500" : accountStatus === "suspended" ? "text-amber-500" : "text-red-500";
                return (
                  <article key={user.id} data-testid="admin-member-card" className={`rounded-2xl border bg-[var(--card)] p-5 ${isFixtureUser(user) ? "border-amber-500/40" : "border-[var(--border)]"}`}>
                    <div className="grid gap-5 xl:grid-cols-[minmax(240px,1.45fr)_minmax(160px,0.75fr)_minmax(180px,0.9fr)_minmax(190px,0.9fr)]">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <h3 className="truncate text-base font-semibold text-[var(--foreground)]">{user.name || user.displayName || user.username}</h3>
                          <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${user.role === "admin" ? "bg-[var(--primary)]/15 text-[var(--primary)]" : "bg-[var(--muted)] text-[var(--secondary-foreground)]"}`}>{user.role === "admin" ? "管理员" : "学员"}</span>
                          {user.accountFlags?.label && <span className="rounded-full bg-amber-500/10 px-2.5 py-1 text-xs font-medium text-amber-500" title={formatAccountFlagReasons(user)}>{user.accountFlags.label}</span>}
                        </div>
                        <div className="mt-3 space-y-1.5 text-sm text-[var(--secondary-foreground)]">
                          <p className="truncate"><span className="text-[var(--muted-foreground)]">QQ邮箱：</span>{user.email || "未绑定"}</p>
                          <p><span className="text-[var(--muted-foreground)]">手机号：</span>{user.phone || "未填写"}</p>
                        </div>
                      </div>

                      <div>
                        <p className="text-sm font-medium text-[var(--foreground)]">会员与账号</p>
                        <div className="mt-3 flex flex-wrap gap-2">
                          <span className={`rounded-full px-2.5 py-1 text-sm font-medium ${memberTone}`}>{memberLabel}</span>
                          <span className={`rounded-full bg-[var(--muted)] px-2.5 py-1 text-sm font-medium ${accountTone}`}>{accountLabel}</span>
                        </div>
                      </div>

                      {(canViewBilling || hasMemberPermissionsManagePermission) && <div>
                        <p className="text-sm font-medium text-[var(--foreground)]">资产与权限</p>
                        {canViewBilling && <div className="mt-3 flex items-baseline gap-4">
                          <p className="text-sm text-[var(--muted-foreground)]"><span className="text-lg font-semibold text-[var(--primary)]">{Number(user.credits || 0).toLocaleString()}</span> 积分</p>
                          <p className="text-sm text-[var(--muted-foreground)]"><span className="text-lg font-semibold text-emerald-500">¥{Number(user.cashBalance ?? user.cash_balance ?? 0).toFixed(2)}</span> 现金</p>
                        </div>}
                        {hasMemberPermissionsManagePermission && <p className="mt-2 text-sm text-[var(--secondary-foreground)]" title={resolvedNavigationNames.join("、") || permissionLabel}>{permissionLabel}{resolvedNavigationNames.length > 0 ? ` · ${resolvedNavigationNames.slice(0, 2).join("、")}${resolvedNavigationNames.length > 2 ? "…" : ""}` : ""}</p>}
                      </div>}

                      <div>
                        <p className="text-sm font-medium text-[var(--foreground)]">最近活动</p>
                        <div className="mt-3 space-y-1.5 text-sm text-[var(--secondary-foreground)]">
                          {canViewMemberSecurity && <p><span className="text-[var(--muted-foreground)]">最近登录：</span>{formatAdminDate(user.last_sign_in_at || user.lastActive)}</p>}
                          <p><span className="text-[var(--muted-foreground)]">注册时间：</span>{formatAdminDate(user.createdAt || user.created_at)}</p>
                        </div>
                      </div>
                    </div>

                    <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-[var(--border)] pt-4">
                      <div data-testid="member-primary-actions" className="flex flex-wrap items-start gap-2">
                        <button type="button" onClick={() => loadUserTransactions(user)} className="rounded-lg bg-blue-500/10 px-3 py-2 text-sm font-medium text-blue-500 transition-colors hover:bg-blue-500/20">运营档案</button>
                        {hasPackagesManagePermission && user.role !== "admin" && !isFixtureUser(user) && <button data-testid="open-member-package-from-user" type="button" onClick={() => { if (!canManagePackages) { setUnlockDialogRequested(true); return; } setPackageUser(user); }} className="rounded-lg bg-violet-500/10 px-3 py-2 text-sm font-medium text-violet-600 transition-colors hover:bg-violet-500/20">配置会员套餐</button>}
                        {visibleAdminTabSet.has("invitations") && user.role !== "admin" && <button type="button" onClick={() => openMemberModule("invitations", user.id)} className="rounded-lg bg-amber-500/10 px-3 py-2 text-sm font-medium text-amber-600 transition-colors hover:bg-amber-500/20">邀请关系</button>}
                        {(hasPackagesManagePermission || hasMemberPermissionsManagePermission || hasMembersManagePermission) && <details data-testid="member-more-actions" className="group rounded-lg border border-[var(--border)] bg-[var(--background)]/50">
                          <summary className="cursor-pointer list-none px-3 py-2 text-sm font-medium text-[var(--secondary-foreground)] marker:hidden">更多账户操作</summary>
                          <div className="flex max-w-xl flex-wrap gap-2 border-t border-[var(--border)] p-2">
                            {hasPackagesManagePermission && visibleAdminTabSet.has("cami") && user.role !== "admin" && !isFixtureUser(user) && <button type="button" onClick={() => { if (!canManagePackages) { setUnlockDialogRequested(true); return; } openMemberModule("cami", user.id); }} className="rounded-lg bg-emerald-500/10 px-3 py-2 text-sm font-medium text-emerald-600 transition-colors hover:bg-emerald-500/20">发送激活卡</button>}
                            {hasMemberPermissionsManagePermission && <button type="button" onClick={() => void openUserAccessEditor(user)} className="rounded-lg bg-[var(--primary)]/10 px-3 py-2 text-sm font-medium text-[var(--primary)] transition-colors hover:bg-[var(--primary)]/20">单独调权限</button>}
                            {hasMembersManagePermission && <button type="button" onClick={() => openAccountRecovery(user)} className="rounded-lg bg-[var(--muted)] px-3 py-2 text-sm font-medium text-[var(--secondary-foreground)] transition-colors hover:bg-[var(--accent)]">编辑账号</button>}
                            {hasMembersManagePermission && <button type="button" onClick={() => openPasswordReset(user)} className="rounded-lg bg-[var(--muted)] px-3 py-2 text-sm font-medium text-[var(--secondary-foreground)] transition-colors hover:bg-[var(--accent)]">重置密码</button>}
                          </div>
                        </details>}
                      </div>
                      <p data-testid="member-activation-paths" className="mt-2 w-full text-xs leading-5 text-[var(--muted-foreground)]">运营档案仅展示当前账号有权查看的会员记录。</p>
                      <div className="flex flex-wrap gap-2">
                        {hasWalletAdjustPermission && visibleAdminTabSet.has("offline-payments") && user.role !== "admin" && !isFixtureUser(user) && (membership === "inactive" || membership === "expired") && <button onClick={() => handleActivateMember(user)} className="rounded-lg border border-emerald-500/30 px-3 py-2 text-sm font-medium text-emerald-500 hover:bg-emerald-500/10">补录线下收款并激活</button>}
                        {hasMembersManagePermission && user.role !== "admin" && membership === "active" && <button onClick={() => handleDeactivateMember(user)} className="rounded-lg border border-[var(--border)] px-3 py-2 text-sm font-medium text-[var(--secondary-foreground)] hover:bg-[var(--accent)]">停用会员</button>}
                        {hasMembersManagePermission && user.role !== "admin" && accountStatus === "active" && <button onClick={() => handleUserStatus(user, "suspended")} className="rounded-lg border border-amber-500/30 px-3 py-2 text-sm font-medium text-amber-500 hover:bg-amber-500/10">暂停账号</button>}
                        {hasMembersManagePermission && user.role !== "admin" && accountStatus === "suspended" && !isFixtureUser(user) && <button onClick={() => handleUserStatus(user, "active")} className="rounded-lg border border-emerald-500/30 px-3 py-2 text-sm font-medium text-emerald-500 hover:bg-emerald-500/10">恢复账号</button>}
                        {hasMembersManagePermission && user.role !== "admin" && accountStatus !== "blocked" && <button onClick={() => handleUserStatus(user, "blocked")} className="rounded-lg border border-red-500/30 px-3 py-2 text-sm font-medium text-red-500 hover:bg-red-500/10">拉黑</button>}
                        {hasMembersManagePermission && user.role !== "admin" && accountStatus === "blocked" && !isFixtureUser(user) && <button onClick={() => handleUserStatus(user, "active")} className="rounded-lg border border-emerald-500/30 px-3 py-2 text-sm font-medium text-emerald-500 hover:bg-emerald-500/10">解除拉黑</button>}
                        {hasMembersDeletePermission && user.id !== currentUserId && user.role !== "admin" && (
                          <button
                            disabled={deletingUserIds.includes(user.id)}
                            onClick={() => handleDeleteUser(user.id, user.name || user.displayName || "")}
                            className="rounded-lg px-3 py-2 text-sm font-medium text-[var(--destructive)] hover:bg-[var(--destructive)]/10 disabled:cursor-not-allowed disabled:opacity-40"
                          >
                            {deletingUserIds.includes(user.id) ? "删除中..." : "删除"}
                          </button>
                        )}
                      </div>
                    </div>
                  </article>
                );
              })}
              {filteredUsers.length === 0 && <div className="rounded-2xl border border-dashed border-[var(--border)] bg-[var(--card)] py-14 text-center text-sm text-[var(--muted-foreground)]">{memberFilter === "all" && !userSearch.trim() ? "暂无用户" : "没有匹配的用户"}</div>}
            </div>
            </>
            );
            })()
            )}

            {/* ── 聊天记录 ── */}
            {canViewMemberContent && userSubTab === "chats" && (
            <div className="space-y-4">
              {/* 搜索 + 统计 */}
              <div className="flex items-center justify-between flex-wrap gap-3">
                <div className="flex items-center gap-2">
                  <h2 className="text-lg font-semibold text-[var(--foreground)]">聊天记录</h2>
                  <span className="text-xs text-[var(--muted-foreground)]">共 {chatListTotal} 个会话</span>
                </div>
                <div className="flex items-center gap-2">
                  <div className="relative">
                    <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-[var(--muted-foreground)]" />
                    <input
                      type="text"
                      placeholder="搜索学员姓名/手机/邮箱"
                      value={chatListSearch}
                      onChange={e => setChatListSearch(e.target.value)}
                      onKeyDown={e => { if (e.key === "Enter") { setChatListPage(1); fetchChatList(1, chatListSearch); } }}
                      className="pl-8 pr-3 py-1.5 text-xs rounded-lg border border-[var(--border)] bg-[var(--background)] text-[var(--foreground)] focus:outline-none focus:ring-1 focus:ring-[var(--primary)] w-[220px]"
                    />
                  </div>
                  <button onClick={() => { setChatListPage(1); fetchChatList(1, chatListSearch); }} className={btnPrimary + " text-xs px-3 py-1.5"}>搜索</button>
                  {chatListSearch && <button onClick={() => { setChatListSearch(""); setChatListPage(1); fetchChatList(1, ""); }} className={btnGhost + " text-xs px-3 py-1.5"}>清除</button>}
                </div>
              </div>

              {/* 智能体使用统计 */}
              {agentUsageStats.length > 0 && (
                <div className="bg-[var(--card)] rounded-xl border border-[var(--border)] p-4">
                  <h3 className="text-sm font-medium text-[var(--foreground)] mb-3">智能体使用统计</h3>
                  <div className="flex flex-wrap gap-2">
                    {agentUsageStats.slice(0, 10).map(stat => (
                      <div key={stat.agentId} className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-[var(--muted)]/30 text-xs">
                        <span className="font-medium text-[var(--foreground)] truncate max-w-[120px]">{stat.agentName}</span>
                        <span className="text-[var(--primary)]">{stat.conversationCount}次</span>
                        <span className="text-[var(--muted-foreground)]">{stat.messageCount}条</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* 会话列表 */}
              <div className="bg-[var(--card)] rounded-2xl border border-[var(--border)] overflow-x-auto">
                {chatListLoading ? (
                  <div className="text-center py-12 text-[var(--muted-foreground)] text-sm">加载中...</div>
                ) : userConversations.length === 0 ? (
                  <div className="text-center py-12 text-[var(--muted-foreground)] text-sm">{chatListSearch ? "没有匹配的聊天记录" : "暂无聊天记录"}</div>
                ) : (
                  <table className="w-full min-w-[900px]">
                    <thead className="bg-[var(--card)] border-b border-[var(--border)]">
                      <tr>
                        {["学员", "智能体", "来源", "消息数", "最后消息", "更新时间", "操作"].map(h => (
                          <th key={h} className={`text-left px-3 py-2 text-[11px] font-medium text-[var(--muted-foreground)] uppercase whitespace-nowrap ${h === "操作" ? "text-right" : ""}`}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[var(--border)]">
                      {userConversations.map(conv => (
                        <tr key={conv.id} className="hover:bg-[var(--border)] transition-colors">
                          <td className="px-3 py-2 text-sm font-medium text-[var(--foreground)] whitespace-nowrap">{conv.userName}</td>
                          <td className="px-3 py-2 text-xs text-[var(--secondary-foreground)] whitespace-nowrap">{conv.agentName}</td>
                          <td className="px-3 py-2">
                            <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium ${conv.source === "coze" ? "bg-blue-500/10 text-blue-600" : "bg-violet-500/10 text-violet-600"}`}>
                              {conv.source === "coze" ? "Coze" : "LLM"}
                            </span>
                          </td>
                          <td className="px-3 py-2 text-xs text-[var(--secondary-foreground)] whitespace-nowrap">{conv.messageCount}</td>
                          <td className="px-3 py-2 text-xs text-[var(--muted-foreground)] max-w-[200px] truncate">{conv.lastMessage || "-"}</td>
                          <td className="px-3 py-2 text-[10px] text-[var(--muted-foreground)] whitespace-nowrap">
                            {conv.updatedAt ? new Date(conv.updatedAt).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "-"}
                          </td>
                          <td className="px-3 py-2 text-right">
                            <button onClick={() => fetchChatMessages(conv.id, conv.agentName, conv.userName)} className="text-[10px] px-1.5 py-0.5 rounded bg-violet-500/10 text-violet-600 hover:bg-violet-500/20 transition-colors">查看</button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>

              {/* 分页 */}
              {chatListTotal > 20 && (
                <div className="flex items-center justify-center gap-2">
                  <button onClick={() => { const p = Math.max(1, chatListPage - 1); setChatListPage(p); fetchChatList(p, chatListSearch); }} disabled={chatListPage <= 1} className="px-3 py-1 rounded-lg text-xs border border-[var(--border)] disabled:opacity-30 hover:bg-[var(--muted)] transition-colors">上一页</button>
                  <span className="text-xs text-[var(--muted-foreground)]">第 {chatListPage} 页 / 共 {Math.ceil(chatListTotal / 20)} 页</span>
                  <button onClick={() => { const p = chatListPage + 1; setChatListPage(p); fetchChatList(p, chatListSearch); }} disabled={chatListPage >= Math.ceil(chatListTotal / 20)} className="px-3 py-1 rounded-lg text-xs border border-[var(--border)] disabled:opacity-30 hover:bg-[var(--muted)] transition-colors">下一页</button>
                </div>
              )}
            </div>
            )}

            {/* ── 充值记录 ── */}
            {canViewBilling && userSubTab === "recharge" && (
              <RevenueTab token={token} showToast={showMessage} allCategories={categories} initialSubTab="recharge" hideHeader hideSubTabs hasBillingExportPermission={hasBillingExportPermission} canExportBilling={canExportBilling} onRequestUnlock={() => setUnlockDialogRequested(true)} />
            )}

            {/* ── 消费明细 ── */}
            {canViewBilling && userSubTab === "consumption" && (
              <RevenueTab token={token} showToast={showMessage} allCategories={categories} initialSubTab="consumption" hideHeader hideSubTabs hasBillingExportPermission={hasBillingExportPermission} canExportBilling={canExportBilling} onRequestUnlock={() => setUnlockDialogRequested(true)} />
            )}
          </div>
        )}

        {/* ========= Invitation attribution Tab ========= */}
        {activeTab === "invitations" && token && (
          <InvitationAttributionPanel
            token={token}
            focusUserId={memberContextId}
            focusUserLabel={memberContextLabel}
            onClearFocus={clearMemberContext}
            canManagePackages={canManagePackages}
            canExportBilling={canExportBilling}
          />
        )}

        {/* ========= Credits Tab ========= */}
        {activeTab === "credits" && (
          <div>
            <h2 className="text-lg font-semibold text-[var(--foreground)] mb-4">积分充值</h2>
            {pendingWalletAttempts.length > 0 && (
              <div className={`${cardCls} mb-4`} role="status" aria-live="polite">
                <p className="font-medium mb-2">有余额操作等待确认，原操作已保留</p>
                {pendingWalletAttempts.map(attempt => (
                  <div key={attempt.idempotencyKey} className="flex flex-wrap items-center gap-3 mt-2 text-sm">
                    <span>{users.find(user => user.id === attempt.payload.userId)?.name || "所选学员"} · {attempt.kind === "cash_topup" ? `现金充值 ¥${attempt.payload.amount}` : attempt.kind === "credit_set" ? `积分设为 ${attempt.payload.credits}` : `积分充值 ${attempt.payload.amount}`}</span>
                    <button type="button" disabled={walletBusy} onClick={() => runAdminWallet(attempt.kind, attempt.payload)} className={btnPrimary}>
                      {walletBusy ? "正在核对..." : "核对原操作"}
                    </button>
                  </div>
                ))}
              </div>
            )}
            <div className={cardCls}>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4 items-end">
                <div>
                  <label className={labelCls}>选择学员</label>
                  <select value={rechargeUserId} onChange={(e) => setRechargeUserId(e.target.value)} className={inputCls}>
                    <option value="">请选择</option>
                    {users.filter((u) => !isFixtureUser(u)).map((u) => (
                      <option key={u.id} value={u.id}>{u.name || u.phone || u.username}{u.role === "admin" ? "（管理员）" : ""} ({u.phone || '-'}) - {u.credits}积分</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className={labelCls}>充值金额（元）</label>
                  <div className="flex gap-2 flex-wrap">
                    {[50, 100, 200, 500].map((amt) => (
                      <button key={amt} onClick={() => setRechargeYuan(amt)} className={`px-3 py-2 rounded-lg text-xs font-medium transition-colors ${rechargeYuan === amt ? "bg-[var(--primary)] text-[var(--background)]" : "bg-[var(--border)] text-[var(--secondary-foreground)] hover:bg-[var(--border)]"}`}>{amt}元</button>
                    ))}
                  </div>
                </div>
                <div>
                  <label className={labelCls}>自定义金额（元）</label>
                  <input type="number" min="1" value={rechargeYuan} onChange={(e) => setRechargeYuan(Number(e.target.value))} className={inputCls} placeholder="输入金额" />
                </div>
              </div>
              <div className="mt-4 flex items-center gap-4">
                <button disabled={walletBusy} onClick={handleRecharge} className={btnPrimary}>{walletBusy ? "正在处理..." : "确认充值"}</button>
                {rechargeUserId && (() => { const u = users.find((u) => u.id === rechargeUserId); return u ? <span className="text-sm text-[var(--secondary-foreground)]">为 <strong className="text-[var(--foreground)]">{u.name || u.phone}</strong> 充值 </span> : null; })()}
                <span className="text-sm text-[var(--muted-foreground)]">
                  {rechargeYuan}元 = {(rechargeYuan * (Number(visibleSettings.credits_per_yuan) || 50)).toLocaleString()}积分
                  {bonusCredits > 0 && (
                    <span className="text-[var(--success)]"> + 赠送{bonusCredits.toLocaleString()}积分 = <strong className="text-[var(--foreground)]">{((rechargeYuan * (Number(visibleSettings.credits_per_yuan) || 50)) + bonusCredits).toLocaleString()}积分</strong></span>
                  )}
                </span>
              </div>
              <div className="mt-4 pt-4 border-t border-[var(--border)]">
                <label className={labelCls}>赠送积分（可选，充多送多）</label>
                <div className="flex gap-2 flex-wrap mb-2">
                  {[0, 500, 1000, 2000, 3000, 5000].map((amt) => (
                    <button key={amt} onClick={() => setBonusCredits(amt)} className={`px-3 py-2 rounded-lg text-xs font-medium transition-colors ${bonusCredits === amt ? "bg-[var(--success)] text-[var(--foreground)]" : "bg-[var(--border)] text-[var(--secondary-foreground)] hover:bg-[var(--border)]"}`}>
                      {amt === 0 ? "不赠送" : `+${amt.toLocaleString()}`}
                    </button>
                  ))}
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-[var(--muted-foreground)]">自定义赠送：</span>
                  <input type="number" min="0" value={bonusCredits} onChange={(e) => setBonusCredits(Math.max(0, Number(e.target.value)))} className="w-32 bg-[var(--card)] border border-[var(--border)] rounded-lg px-3 py-2 text-sm text-[var(--foreground)] focus:outline-none focus:border-[var(--success)]" placeholder="输入积分" />
                  <span className="text-xs text-[var(--muted-foreground)]">积分</span>
                </div>
                <label className="mt-4 flex cursor-pointer items-center gap-2 text-sm text-[var(--secondary-foreground)]">
                  <input
                    type="checkbox"
                    checked={rechargeNotifyUser}
                    onChange={(event) => setRechargeNotifyUser(event.target.checked)}
                    className="h-4 w-4 accent-[var(--primary)]"
                  />
                  本次入账后通知学员（默认不通知）
                </label>
              </div>
            </div>

            {/* ========= Cash Topup (视频专用现金账户) ========= */}
            <div className={`${cardCls} mt-6`}>
              <h3 className="font-semibold text-[var(--foreground)] mb-1">现金充值 <span className="text-xs font-normal text-[var(--muted-foreground)]">（视频生成专用，独立于积分）</span></h3>
              <p className="text-xs text-[var(--muted-foreground)] mb-4">为学员充值现金余额，视频生成按次扣费，用多少扣多少</p>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className={labelCls}>选择学员</label>
                  <select value={cashTopupUserId} onChange={(e) => setCashTopupUserId(e.target.value)} className={inputCls}>
                    <option value="">选择学员</option>
                    {users.filter((u) => u.role !== "admin" && !isFixtureUser(u)).map((u) => <option key={u.id} value={u.id}>{u.name || u.phone || u.username} ({u.phone || '-'}) - 余额¥{Number(u.cashBalance ?? 0).toFixed(2)}</option>)}
                  </select>
                </div>
                <div>
                  <label className={labelCls}>充值金额</label>
                  <div className="relative">
                    <input type="number" min="0.01" step="0.01" value={cashTopupAmount} onChange={(e) => setCashTopupAmount(Math.max(0, Number(e.target.value)))} className={inputCls} placeholder="50" />
                    <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-[var(--muted-foreground)]">元</span>
                  </div>
                </div>
              </div>
              <div className="flex gap-2 mt-3">
                {[10, 30, 50, 100, 200, 500].map(amt => (
                  <button key={amt} onClick={() => setCashTopupAmount(amt)} className={`px-3 py-2 rounded-lg text-xs font-medium transition-colors ${cashTopupAmount === amt ? "bg-emerald-500 text-white" : "bg-[var(--border)] text-[var(--secondary-foreground)] hover:bg-[var(--border)]"}`}>¥{amt}</button>
                ))}
              </div>
              <label className="mt-4 flex cursor-pointer items-center gap-2 text-sm text-[var(--secondary-foreground)]">
                <input
                  type="checkbox"
                  checked={cashNotifyUser}
                  onChange={(event) => setCashNotifyUser(event.target.checked)}
                  className="h-4 w-4 accent-emerald-500"
                />
                本次入账后通知学员（默认不通知）
              </label>
              <div className="mt-4 flex items-center gap-4">
                <button disabled={walletBusy} onClick={handleCashTopup} className="px-4 py-2 rounded-lg text-sm font-medium bg-emerald-500 text-white hover:brightness-110 transition-all">{walletBusy ? "正在处理..." : "确认充值"}</button>
                {cashTopupUserId && (() => { const u = users.find((u) => u.id === cashTopupUserId); return u ? <span className="text-sm text-[var(--secondary-foreground)]">为 <strong className="text-[var(--foreground)]">{u.name || u.phone}</strong> 充值 <strong className="text-emerald-500">¥{cashTopupAmount}</strong>（当前余额 ¥{Number(u.cashBalance ?? 0).toFixed(2)}）</span> : null; })()}
              </div>
            </div>

            {/* ========= 调整积分（放在最下面） ========= */}
            <div className={`${cardCls} mt-6`}>
              <h3 className="font-semibold text-[var(--foreground)] mb-1">调整积分</h3>
              <p className="text-xs text-[var(--muted-foreground)] mb-4">直接设置学员的积分数值（原积分将被覆盖）</p>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4 items-end">
                <div>
                  <label className={labelCls}>选择学员</label>
                  <select value={adjustUserId} onChange={(e) => setAdjustUserId(e.target.value)} className={inputCls}>
                    <option value="">请选择</option>
                    {users.filter((u) => u.role !== "admin").map((u) => (
                      <option key={u.id} value={u.id}>{u.name || u.phone || u.username} ({u.phone || '-'}) - 当前{u.credits}积分</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className={labelCls}>设置积分</label>
                  <div className="flex gap-2 flex-wrap">
                    {[0, 1000, 3000, 5000, 10000, 20000].map((amt) => (
                      <button key={amt} onClick={() => setAdjustCredits(amt)} className={`px-3 py-2 rounded-lg text-xs font-medium transition-colors ${adjustCredits === amt ? "bg-[#E8A838] text-[var(--background)]" : "bg-[var(--border)] text-[var(--secondary-foreground)] hover:bg-[var(--border)]"}`}>{amt === 0 ? "清零" : amt.toLocaleString()}</button>
                    ))}
                  </div>
                </div>
                <div>
                  <label className={labelCls}>自定义积分数</label>
                  <input type="number" min="0" value={adjustCredits} onChange={(e) => setAdjustCredits(Math.max(0, Number(e.target.value)))} className={inputCls} placeholder="输入积分数" />
                </div>
              </div>
              <label className="mt-4 flex cursor-pointer items-center gap-2 text-sm text-[var(--secondary-foreground)]">
                <input
                  type="checkbox"
                  checked={adjustNotifyUser}
                  onChange={(event) => setAdjustNotifyUser(event.target.checked)}
                  className="h-4 w-4 accent-[#E8A838]"
                />
                本次调整后通知学员（默认不通知）
              </label>
              <div className="mt-4 flex items-center gap-4">
                <button disabled={walletBusy} onClick={handleAdjustCredits} className="px-4 py-2 rounded-lg text-sm font-medium bg-[#E8A838] text-[var(--background)] hover:brightness-110 transition-all">{walletBusy ? "正在处理..." : "确认调整"}</button>
                {adjustUserId && (() => { const u = users.find((u) => u.id === adjustUserId); return u ? <span className="text-sm text-[var(--secondary-foreground)]">为 <strong className="text-[var(--foreground)]">{u.name || u.phone}</strong> 将积分设为 <strong className="text-[var(--foreground)]">{adjustCredits.toLocaleString()}</strong>（原 {u.credits.toLocaleString()}）</span> : null; })()}
              </div>
            </div>

            {/* ========= 积分汇率（模型计费已在"模型管理"中独立配置，此处仅保留汇率） ========= */}
            {hasPaymentSettingsPermission && (
            <div className={`${cardCls} mt-6`}>
              <div className="flex items-center gap-4">
                <div className="flex items-center gap-2">
                  <label className="text-sm font-medium text-[var(--foreground)]">积分汇率</label>
                  <span className="text-[10px] text-[var(--muted-foreground)]">1元 = {Number(visibleSettings.credits_per_yuan || 50)}积分</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-[var(--muted-foreground)]">每元积分数：</span>
                  <input
                    value={visibleSettings.credits_per_yuan}
                    onChange={(e) => updateSetting("credits_per_yuan", e.target.value)}
                    className="w-20 bg-[var(--card)] border border-[var(--border)] rounded-lg px-3 py-1.5 text-sm text-[var(--foreground)] focus:outline-none focus:border-[var(--primary)]"
                    placeholder="50"
                    type="number"
                    min="1"
                  />
                  <button onClick={() => void saveSettings("payment", true, CREDIT_EXCHANGE_SETTING_FIELDS)} disabled={settingsSaving || !canManagePaymentSettings}
                    className="px-3 py-1.5 rounded-lg bg-[var(--primary)] text-[var(--primary-foreground)] font-medium text-xs hover:opacity-90 transition disabled:opacity-50">
                    {settingsSaving ? "保存中..." : "保存"}
                  </button>
                </div>
              </div>
              <p className="text-[10px] text-[var(--muted-foreground)] mt-2">
                计费规则（进货价/利润率/Token取整）已迁移至「模型管理」中按模型独立配置，每个模型可设置不同的单价和利润，系统按模型级自动计费扣费。
              </p>
            </div>
            )}
          </div>
        )}

        {/* ========= Offline payment receipts ========= */}
        {activeTab === "offline-payments" && token && (
          <OfflinePaymentsTab
            token={token}
            users={users}
            focusUserId={memberContextId}
            focusUserLabel={memberContextLabel}
            onClearFocus={clearMemberContext}
            onMemberChanged={loadUsers}
            showToast={showMessage}
            hasWalletAdjustPermission={hasWalletAdjustPermission}
            canAdjustWallet={canAdjustWallet}
            hasBillingExportPermission={hasBillingExportPermission}
            canExportBilling={canExportBilling}
            onRequestUnlock={() => setUnlockDialogRequested(true)}
          />
        )}

        {/* ========= General Settings Tab ========= */}
        {activeTab === "general" && hasBrandSettingsPermission && (
          <div>
            <h2 className="text-lg font-semibold text-[var(--foreground)] mb-1">品牌与联系设置</h2>
            <p className="mb-4 text-xs leading-5 text-[var(--muted-foreground)]">管理平台名称、Logo、联系方式和客服二维码。保存草稿并发布后对访客生效。</p>
            {hasBrandSettingsPermission && (
              <PlatformBrandSettingsPanel
                token={token}
                onRequestUnlock={() => setUnlockDialogRequested(true)}
              />
            )}
            {(grantedPermissionKeys.has("prompts.view") || hasModelSettingsPermission || hasSecuritySettingsPermission) && (
            <div className={`${cardCls} mt-4`}>
              <div className="mb-4">
                <h3 className="font-semibold text-[var(--foreground)]">工作台执行默认</h3>
                <p className="mt-1 text-xs text-[var(--muted-foreground)]">管理智能体共享规则、自动头像和敏感操作验证。这里的保存不会直接发布品牌版本。</p>
              </div>
              {/* 全局头部预设 */}
              {grantedPermissionKeys.has("prompts.view") && (
              <div className="mt-4 p-3 rounded-lg bg-[var(--primary)]/5 border border-[var(--primary)]/15">
                <label className={`${labelCls} flex items-center gap-1.5`}>
                  全局头部预设
                  <span className="text-[10px] text-[var(--muted-foreground)] font-normal">（所有 LLM 智能体共享的系统前缀）</span>
                </label>
                <textarea
                  value={visibleSettings.global_system_prefix}
                  onChange={(e) => updateSetting("global_system_prefix", e.target.value)}
                  readOnly={!canEditPrompts}
                  className={`w-full text-sm p-3 rounded-lg border border-[var(--border)] bg-[var(--background)] focus:border-[var(--primary)] focus:ring-1 focus:ring-[var(--primary)]/30 outline-none resize-y min-h-[100px]`}
                  rows={5}
                  placeholder={"例如：\n你是【XX平台】的专业文案师，所有输出必须：\n1. 符合中国广告法，禁用极限词\n2. 包含至少一个行动号召(CTA)\n3. 段落不超过3行，适合手机阅读"}
                />
                <p className="text-[10px] text-[var(--muted-foreground)] mt-1.5">此内容会自动注入到所有 LLM 智能体的 system prompt 之前，用于统一品牌调性和基础规则。留空则不注入。</p>
                {canEditPrompts && (
                  <div className="mt-3 flex items-center justify-between">
                    <span className="text-xs text-[var(--muted-foreground)]">修改后需手动保存</span>
                    <button onClick={() => void saveSettings("prompts", true, GLOBAL_PROMPT_SETTING_FIELDS)} disabled={settingsSaving} className="px-4 py-1.5 rounded-lg bg-[var(--primary)] text-[var(--primary-foreground)] font-bold text-xs hover:opacity-90 transition disabled:opacity-50">
                      {settingsSaving ? "保存中..." : "保存提示词规则"}
                    </button>
                  </div>
                )}
              </div>
              )}

              {/* 头像生成默认模型：生成只允许由管理员显式发起 */}
              {hasModelSettingsPermission && (
              <div className="mt-4 p-3 rounded-lg bg-purple-500/5 border border-purple-500/15">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-purple-500"><path d="M15.75 6a3.75 3.75 0 1 1-7.5 0 3.75 3.75 0 0 1 7.5 0ZM4.501 20.118a7.5 7.5 0 0 1 14.998 0A17.933 17.933 0 0 1 12 21.75c-2.676 0-5.216-.584-7.499-1.632Z" /><path d="M18 3v2.25M21 6h-2.25M3 6h2.25M6 3v2.25" /></svg>
                    <label className={`${labelCls} mb-0`}>头像生成默认模型</label>
                    <span className="text-[10px] text-[var(--muted-foreground)] font-normal">（仅供管理员主动生成头像时使用）</span>
                  </div>
                  <span className="rounded-full bg-purple-500/10 px-2 py-1 text-[10px] font-semibold text-purple-700">不会在保存智能体时自动扣费</span>
                </div>
                <div className="mt-3 grid grid-cols-1 md:grid-cols-[minmax(0,1fr)_auto] gap-3 items-end">
                  <div>
                    <label className={labelCls}>头像生图模型</label>
                    <select
                      value={selectedAvatarModelId}
                      onChange={(e) => updateSetting("auto_avatar_model_id", e.target.value)}
                      className={inputCls}
                    >
                      <option value="">自动选择第一个启用的生图模型</option>
                      {selectedAvatarModelUnavailable && (
                        <option value={selectedAvatarModelId} disabled>
                          {selectedAvatarModelId}（{selectedAvatarModelIsSaved ? "当前已保存" : "当前选择"}，暂不可用于新生成）
                        </option>
                      )}
                      {activeDrawingModels.map((model) => (
                        <option key={model.id} value={model.id}>
                          {model.name}{model.model_name !== model.name ? ` (${model.model_name})` : ""}
                        </option>
                      ))}
                    </select>
                  </div>
                  <button
                    type="button"
                    onClick={loadDrawingModels}
                    className="px-3 py-2 rounded-lg text-xs border border-purple-500/20 text-purple-600 hover:bg-purple-500/10 transition font-medium"
                  >
                    刷新模型
                  </button>
                </div>
                <p className="text-[10px] text-[var(--muted-foreground)] mt-1.5">管理员可先手动上传头像；只有在「智能体管理」中明确点击单个或批量生成、确认数量并提交后，系统才调用生图模型。批量任务最多 20 个，默认不会在新建或保存智能体时触发。</p>
                <div className="mt-3 flex justify-end">
                  <button onClick={() => void saveSettings("models", true, AVATAR_MODEL_SETTING_FIELDS)} disabled={settingsSaving || !canManageModelSettings} className="px-4 py-1.5 rounded-lg bg-[var(--primary)] text-[var(--primary-foreground)] font-bold text-xs hover:opacity-90 transition disabled:opacity-50">
                    {settingsSaving ? "保存中..." : "保存模型默认项"}
                  </button>
                </div>
              </div>
              )}

              {/* 操作密码 */}
              {hasSecuritySettingsPermission && (
              <div className="mt-4 p-3 rounded-lg bg-amber-500/5 border border-amber-500/15">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-amber-500"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
                    <label className={`${labelCls} mb-0`}>操作密码</label>
                    <span className="text-[10px] text-[var(--muted-foreground)] font-normal">（删除智能体/用户等高危操作的二次验证密码）</span>
                  </div>
                  <div className="flex items-center gap-2">
                    {opPasswordSet ? (
                      <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-600 font-medium">已设置</span>
                    ) : (
                      <span className="text-[10px] px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-600 font-medium">未设置</span>
                    )}
                    <button
                      disabled={!canManageSecuritySettings}
                      onClick={() => {
                        setOpPasswordAction(opPasswordSet ? "change" : "generate");
                        setOpPasswordOld("");
                        setOpPasswordNew("");
                        setOpPasswordError("");
                        setOpPasswordSuccess("");
                        setGeneratedPassword("");
                        setShowOpPasswordDialog(true);
                      }}
                      className="px-3 py-1 rounded-lg text-xs bg-[var(--primary)] text-white hover:bg-[var(--primary)]/90 transition font-medium disabled:opacity-50"
                    >
                      {opPasswordSet ? "修改密码" : "设置密码"}
                    </button>
                    {opPasswordSet && (
                      <button
                        disabled={!canManageSecuritySettings}
                        onClick={() => {
                          setOpPasswordAction("remove");
                          setOpPasswordOld("");
                          setOpPasswordError("");
                          setOpPasswordSuccess("");
                          setGeneratedPassword("");
                          setShowOpPasswordDialog(true);
                        }}
                        className="px-3 py-1 rounded-lg text-xs border border-[var(--border)] text-[var(--muted-foreground)] hover:bg-[var(--background)] transition font-medium disabled:opacity-50"
                      >
                        移除
                      </button>
                    )}
                  </div>
                </div>
                <p className="text-[10px] text-[var(--muted-foreground)] mt-1.5">
                  {opPasswordSet
                    ? "操作密码已设置，执行删除等高危操作时需输入此密码验证。如未设置则使用管理员登录密码。"
                    : "尚未设置操作密码，当前使用管理员登录密码验证。建议设置独立的复杂操作密码以提高安全性。"}
                </p>
              </div>
              )}
            </div>
            )}
          </div>
        )}

        {/* ========= Theme Tab ========= */}
        {activeTab === "theme" && hasBrandSettingsPermission && (
          <div>
            <h2 className="text-lg font-semibold text-[var(--foreground)] mb-4">主题风格</h2>
            <div className={cardCls}>
              <label className={labelCls}>全站发布主题</label>
              <p className="mt-1 text-xs text-[var(--muted-foreground)]">主题发布直接写入运行配置并完成公共启动接口读回校验，不需要重新部署代码。没有有效个人偏好的账号立即采用这里的主题；已有个人选择按七天租约继续生效。</p>
              <div className="mt-3 grid max-w-2xl grid-cols-1 gap-3 sm:grid-cols-2">
                {ADMIN_THEME_OPTIONS.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    disabled={!sensitiveUnlocked}
                    title={sensitiveUnlocked ? undefined : "先完成安全验证再选择主题"}
                    aria-pressed={visibleSettings.theme === t.id}
                    onClick={() => {
                      const newSettings = {
                        ...settings,
                        theme: t.id,
                        theme_mode: normalizePlatformThemeMode(t.id, visibleSettings.theme_mode),
                      };
                      setSettings(newSettings);
                      previewPlatformAppearance(t.id, newSettings.theme_mode);
                    }}
                    className={`group relative rounded-xl p-4 border-2 transition-all enabled:hover:scale-[1.02] disabled:cursor-not-allowed disabled:opacity-70 ${visibleSettings.theme === t.id ? "border-[var(--primary)] shadow-lg shadow-[var(--primary)]/20" : "border-[var(--border)] hover:border-[var(--border)]"}`}
                  >
                    <div className="flex items-center gap-2 mb-2">
                      <span className="w-3.5 h-3.5 rounded-full shrink-0" style={{ backgroundColor: t.accent }} />
                      <span className="text-sm font-semibold text-[var(--foreground)]">{t.name}</span>
                      {pushedPlatformTheme === t.id && pushedPlatformThemeMode === modeForTheme(t.id) ? (
                        <span className="ml-auto text-[10px] px-1.5 py-0.5 rounded-full bg-[var(--primary)] text-[var(--primary-foreground)]">全站已发布</span>
                      ) : visibleSettings.theme === t.id ? (
                        <span className="ml-auto text-[10px] px-1.5 py-0.5 rounded-full border border-[var(--primary)]/45 text-[var(--primary)]">待推送</span>
                      ) : null}
                    </div>
                    <div className="flex gap-1.5 mb-2">
                      <span className="h-5 flex-1 rounded-md border border-[var(--border)]" style={{ backgroundColor: t.sidebar }} />
                      <span className="h-5 flex-[2] rounded-md border border-[var(--border)]" style={{ backgroundColor: t.bg }} />
                    </div>
                    <span className="block h-1.5 rounded-full w-3/4" style={{ backgroundColor: t.accent }} />
                    <p className="mt-2 text-[11px] text-[var(--muted-foreground)]">{t.desc}</p>
                  </button>
                ))}
              </div>
              <div className="mt-4 flex items-center justify-between">
                <span className="text-xs text-[var(--muted-foreground)]">后台始终保持柔光白；这里发布的是用户前台默认主题。</span>
                <button
                  type="button"
                  onClick={() => void pushDefaultTheme()}
                  disabled={themePushing || !hasBrandSettingsPermission || (
                    visibleSettings.theme === pushedPlatformTheme
                    && normalizePlatformThemeMode(visibleSettings.theme, visibleSettings.theme_mode) === pushedPlatformThemeMode
                  )}
                  data-admin-default-theme-push="true"
                  className="px-5 py-2 rounded-lg bg-[var(--primary)] text-[var(--primary-foreground)] font-bold text-sm hover:opacity-90 transition disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {themePushing
                    ? "发布并校验中..."
                    : visibleSettings.theme === pushedPlatformTheme
                      && normalizePlatformThemeMode(visibleSettings.theme, visibleSettings.theme_mode) === pushedPlatformThemeMode
                      ? "已全站生效"
                      : sensitiveUnlocked ? "发布到全站" : "解锁后自动发布"}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ========= Connection Tab ========= */}
        {activeTab === "connection" && hasIntegrationSettingsPermission && (
          <IntegrationSettingsAdminTab
            settings={visibleSettings}
            settingsSaving={settingsSaving}
            canManageIntegrations={canManageIntegrations}
            cozeTestResult={cozeTestResult}
            updateSetting={updateSetting}
            testConnection={handleTestCozeConnection}
            saveCozeSettings={() => void saveSettings("integrations", true, COZE_CONNECTION_SETTING_FIELDS)}
            saveSmtpSettings={() => void saveSettings("integrations", true, SMTP_SETTING_FIELDS)}
          />
        )}

        {/* ========= Card Layout Tab ========= */}
        {activeTab === "layout" && hasBrandSettingsPermission && (
          sensitiveUnlocked ? (
            <LayoutTab
              settings={settings}
              setSettings={setSettings}
              saveSettings={() => void saveSettings("brand", true, LAYOUT_SETTING_FIELDS)}
              settingsSaving={settingsSaving || !canManageBrandSettings}
              categories={categories.map(c => ({ id: c.id, name: c.name, icon: c.icon }))}
            />
          ) : (
            <div data-testid="layout-step-up-required" className="grid min-h-[420px] place-items-center rounded-3xl border border-[#d0d8d2] bg-[#fffefa] p-8 shadow-sm">
              <div className="max-w-xl text-center">
                <h2 className="text-xl font-black text-[#17201d]">工作台布局配置已锁定</h2>
                <p className="mt-3 text-sm leading-7 text-[#66716d]">布局与快捷入口属于品牌配置。验证管理员密码后才会读取当前配置并显示编辑控件。</p>
                <button type="button" onClick={() => setUnlockDialogRequested(true)} className="mt-5 rounded-xl bg-[#0b7466] px-5 py-2.5 text-sm font-bold text-white hover:bg-[#095f54]">
                  验证密码后读取
                </button>
              </div>
            </div>
          )
        )}

        {/* ========= Announcements Tab ========= */}
        {activeTab === "announcements" && (
          <AnnouncementAdminPanel token={token || ""} />
        )}
        {/* 系统健康监控 Tab */}
        {activeTab === "health" && (
          <div className="space-y-4">
            {/* 健康状态头部 */}
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-3">
                {healthData ? (
                  <span className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-sm font-medium ${
                    healthData.status === 'healthy' ? 'bg-green-500/15 text-green-600' :
                    healthData.status === 'degraded' ? 'bg-yellow-500/15 text-yellow-600' :
                    'bg-red-500/15 text-red-600'
                  }`}>
                    <span className={`w-2 h-2 rounded-full ${
                      healthData.status === 'healthy' ? 'bg-green-500 animate-pulse' :
                      healthData.status === 'degraded' ? 'bg-yellow-500' : 'bg-red-500'
                    }`} />
                    {healthData.status === 'healthy' ? '系统正常' : healthData.status === 'degraded' ? '部分异常' : '系统异常'}
                  </span>
                ) : (
                  <span className="text-sm text-[var(--muted-foreground)]">加载中...</span>
                )}
                <span className="text-xs text-[var(--muted-foreground)]">
                  上次检查: {healthData?.timestamp ? new Date(healthData.timestamp).toLocaleString("zh-CN") : '-'}
                </span>
              </div>
              <div className="flex gap-2">
                <button onClick={() => void loadHealthData()} disabled={healthLoading} className={btnGhost}>
                  {healthLoading ? '检查中...' : '立即检查'}
                </button>
              </div>
            </div>

            {healthActionError && (
              <div role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{healthActionError}</div>
            )}

            {/* 检查项详情 */}
            {healthData?.checks && (
              <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
                {Object.entries(healthData.checks).map(([key, check]: [string, any]) => (
                  <div key={key} className={`${cardCls} flex items-start gap-3`}>
                    <span className={`mt-0.5 w-3 h-3 rounded-full shrink-0 ${
                      check.status === 'healthy' ? 'bg-green-500' :
                      check.status === 'degraded' ? 'bg-yellow-500' : 'bg-red-500'
                    }`} />
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-[var(--foreground)]">{check.name || check.label || key}</div>
                      <div className="text-xs text-[var(--muted-foreground)] mt-0.5">{check.message}</div>
                      {check.autoFixed && (
                        <span className="inline-block mt-1 text-xs px-1.5 py-0.5 rounded bg-green-500/15 text-green-600">已自动修复</span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* 安全维护记录 */}
            {healthData && (
              <div data-testid="health-recent-fixes">
                <h3 className="text-sm font-medium text-[var(--foreground)] mb-2">安全维护结果</h3>
                {healthData.evidenceAvailability?.recentFixes === 'unavailable' ? (
                  <div role="status" className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                    近期维护记录来源暂不可用，本页不会把读取失败显示成“没有记录”。
                  </div>
                ) : Array.isArray(healthData.recentFixes) && healthData.recentFixes.length > 0 ? (
                  <div className="space-y-2">
                    {healthData.recentFixes.map((fix: any, i: number) => (
                      <div key={fix.id || `${fix.created_at || 'fix'}-${i}`} className={`${cardCls} flex items-center gap-3`}>
                        <span className={`text-sm ${fix.success ? 'text-green-500' : 'text-red-500'}`}>{fix.success ? '✓' : '✗'}</span>
                        <div className="flex-1 min-w-0">
                          <div className="text-sm text-[var(--foreground)]">{fix.issue || fix.issue_type || '维护项'}</div>
                          <div className="text-xs text-[var(--muted-foreground)]">{fix.message || fix.description}</div>
                          {(fix.action || fix.fix_action) && <div className="text-xs text-blue-600 mt-0.5">操作: {fix.action || fix.fix_action}</div>}
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="rounded-md border border-[var(--border)] bg-[var(--card)] px-3 py-2 text-xs text-[var(--muted-foreground)]">
                    当前没有已记录的安全维护结果。
                  </div>
                )}
              </div>
            )}

            {/* 巡检配置 */}
            <div className={`${cardCls}`}>
              <h3 className="text-sm font-medium text-[var(--foreground)] mb-2">定时健康检查</h3>
              <p className="text-xs text-[var(--muted-foreground)] mb-2">
                确定性探针负责记录数据库、对象存储、模型目录与供应商链路事实；诊断 Agent 只能归纳证据，不会自动重放付费任务或修改模型配置。
              </p>
              <div className="flex flex-wrap items-center gap-4 text-xs text-[var(--muted-foreground)]">
                <span className={healthData?.monitoring?.internalTriggerConfigured ? 'text-green-700' : 'text-amber-700'}>
                  内部触发鉴权: {healthData?.monitoring?.internalTriggerConfigured ? '已配置' : '未配置'}
                </span>
                <span>调度方式: 服务器外部调度</span>
                <span>自动修复: 关闭</span>
              </div>
              <p className="mt-2 text-xs text-[var(--muted-foreground)]">{healthData?.monitoring?.maintenanceScope || '安全维护不会自动修改数据库结构、模型配置或供应商状态。'}</p>
            </div>

            <OperationFlightRecorderPanel token={token} />

            {/* 近期日志 */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-sm font-medium text-[var(--foreground)]">近期日志</h3>
                <select value={logFilter} onChange={(e) => setLogFilter(e.target.value)} className="text-xs border rounded px-2 py-1 bg-[var(--card)]">
                  <option value="all">全部</option>
                  <option value="error">错误</option>
                  <option value="warn">警告</option>
                  <option value="info">信息</option>
                </select>
              </div>
              <div className="space-y-1.5 max-h-80 overflow-y-auto">
                {systemLogs.filter(l => logFilter === 'all' || l.level === logFilter).map((log: any) => (
                  <div key={log.id} className={`flex items-start gap-2 text-xs px-3 py-2 rounded ${
                    log.level === 'error' || log.level === 'critical' ? 'bg-red-500/5 border border-red-500/10' :
                    log.level === 'warn' ? 'bg-yellow-500/5 border border-yellow-500/10' :
                    'bg-[var(--muted)]/30'
                  }`}>
                    <span className={`shrink-0 font-medium ${
                      log.level === 'error' || log.level === 'critical' ? 'text-red-500' :
                      log.level === 'warn' ? 'text-yellow-600' : 'text-[var(--muted-foreground)]'
                    }`}>[{log.level.toUpperCase()}]</span>
                    <span className="text-[var(--muted-foreground)] shrink-0">{new Date(log.created_at).toLocaleString("zh-CN")}</span>
                    <span className="text-[var(--foreground)] flex-1">{log.message}</span>
                    {log.auto_fixed && <span className="shrink-0 text-green-500">已修复</span>}
                  </div>
                ))}
                {systemLogs.length === 0 && (
                  <div className="text-center py-6 text-[var(--muted-foreground)] text-xs">暂无日志记录</div>
                )}
              </div>
            </div>

            {/* ── 使用诊断 ── */}
            <div className="border-t border-[var(--border)] pt-4 mt-2">
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-3">
                  <h3 className="text-sm font-semibold text-[var(--foreground)]">使用诊断</h3>
                  {diagLogs.length > 0 && (
                    <span className="text-[10px] px-2 py-0.5 rounded-full bg-blue-500/15 text-blue-600 font-medium">
                      {diagLogs.filter((d: any) => d.status === 'pending').length} 待处理
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <button onClick={() => loadDiagLogs()} disabled={diagLoading} className={btnGhost}>
                    {diagLoading ? '加载中...' : '刷新'}
                  </button>
                </div>
              </div>

              {/* 诊断子Tab */}
              {diagError && <p role="alert" className="mb-3 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-800">{diagError}</p>}
              <div className="flex gap-1 mb-3 p-0.5 bg-[var(--muted)]/30 rounded-lg w-fit">
                <button onClick={() => setDiagTab("auto")} className={`px-3 py-1 text-xs rounded-md transition-colors ${diagTab === "auto" ? "bg-[var(--primary)] text-white" : "text-[var(--muted-foreground)] hover:text-[var(--foreground)]"}`}>
                  自动检测
                </button>
                <button onClick={() => setDiagTab("manual")} className={`px-3 py-1 text-xs rounded-md transition-colors ${diagTab === "manual" ? "bg-[var(--primary)] text-white" : "text-[var(--muted-foreground)] hover:text-[var(--foreground)]"}`}>
                  用户反馈
                </button>
              </div>

              {/* 筛选栏 */}
              <div className="flex flex-wrap gap-2 mb-3">
                <select value={diagFilterType} onChange={(e) => { setDiagFilterType(e.target.value); }} className="text-xs border rounded px-2 py-1 bg-[var(--card)]">
                  <option value="">全部类型</option>
                  <option value="chat_timeout">对话超时</option>
                  <option value="send_failed">发送失败</option>
                  <option value="stream_interrupted">流式中断</option>
                  <option value="api_error">API错误</option>
                  <option value="page_crash">页面崩溃</option>
                  <option value="slow_response">响应缓慢</option>
                  <option value="payment_create_failed">支付创建失败</option>
                  <option value="payment_callback_missing">支付回调未到账</option>
                  <option value="balance_not_updated">余额未更新</option>
                  <option value="payment_timeout">支付超时</option>
                  <option value="video_submit_failed">视频提交失败</option>
                  <option value="video_poll_timeout">视频轮询超时</option>
                  <option value="video_billing_error">视频计费异常</option>
                  <option value="video_all_channels_down">视频通道全部不可用</option>
                  <option value="cover_generate_failed">封面生成失败</option>
                  <option value="cover_workflow_timeout">封面流程超时</option>
                  <option value="cover_billing_error">封面计费异常</option>
                  <option value="auth_login_failed">登录失败</option>
                  <option value="auth_token_expired">登录状态过期</option>
                  <option value="auth_register_code_failed">注册验证码失败</option>
                  <option value="network_error">网络错误</option>
                  <option value="render_error">渲染错误</option>
                  <option value="manual_report">用户反馈</option>
                </select>
                <select value={diagFilterSeverity} onChange={(e) => { setDiagFilterSeverity(e.target.value); }} className="text-xs border rounded px-2 py-1 bg-[var(--card)]">
                  <option value="">全部级别</option>
                  <option value="low">低</option>
                  <option value="medium">中</option>
                  <option value="high">高</option>
                  <option value="critical">严重</option>
                </select>
                <select value={diagFilterStatus} onChange={(e) => { setDiagFilterStatus(e.target.value); }} className="text-xs border rounded px-2 py-1 bg-[var(--card)]">
                  <option value="">全部状态</option>
                  <option value="pending">待处理</option>
                  <option value="processing">处理中</option>
                  <option value="resolved">已解决</option>
                  <option value="ignored">已忽略</option>
                </select>
              </div>

              {/* 诊断日志列表 */}
              {diagLogs.length > 0 ? (
                <div className="space-y-2 max-h-96 overflow-y-auto">
                  {diagLogs
                    .filter((d: any) => {
                      if (diagTab === "auto" && d.problem_type === "manual_report") return false;
                      if (diagTab === "manual" && d.problem_type !== "manual_report") return false;
                      return true;
                    })
                    .map((diag: any) => (
                    <div key={diag.id} className={`${cardCls} space-y-2`}>
                      <div className="flex items-start gap-2">
                        <span className={`mt-0.5 shrink-0 text-sm ${
                          diag.severity === 'critical' ? 'text-red-600' :
                          diag.severity === 'high' ? 'text-red-500' :
                          diag.severity === 'medium' ? 'text-yellow-600' :
                          'text-blue-500'
                        }`}>
                          {diag.severity === 'critical' ? '🔴' : diag.severity === 'high' ? '🟠' : diag.severity === 'medium' ? '🟡' : '🔵'}
                        </span>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-xs font-medium text-[var(--foreground)]">
                              {({chat_timeout:'对话超时',send_failed:'发送失败',stream_interrupted:'流式中断',api_error:'API错误',page_crash:'页面崩溃',slow_response:'响应缓慢',payment_create_failed:'支付创建失败',payment_callback_missing:'支付回调未到账',balance_not_updated:'余额未更新',payment_timeout:'支付超时',video_submit_failed:'视频提交失败',video_poll_timeout:'视频轮询超时',video_billing_error:'视频计费异常',video_all_channels_down:'视频通道全部不可用',cover_generate_failed:'封面生成失败',cover_workflow_timeout:'封面流程超时',cover_billing_error:'封面计费异常',auth_login_failed:'登录失败',auth_token_expired:'登录状态过期',auth_register_code_failed:'注册验证码失败',network_error:'网络错误',render_error:'渲染错误',manual_report:'用户反馈'} as Record<string,string>)[diag.problem_type] || diag.problem_type}
                            </span>
                            <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${
                              diag.status === 'pending' ? 'bg-yellow-500/15 text-yellow-600' :
                              diag.status === 'processing' ? 'bg-blue-500/15 text-blue-600' :
                              diag.status === 'resolved' ? 'bg-green-500/15 text-green-600' :
                              'bg-gray-500/15 text-gray-500'
                            }`}>
                              {({pending:'待处理',processing:'处理中',resolved:'已解决',ignored:'已忽略'} as Record<string,string>)[diag.status] || diag.status}
                            </span>
                          </div>
                          <div className="text-xs text-[var(--muted-foreground)] mt-0.5">
                            {diag.display_name || diag.username || '未知用户'} · {new Date(diag.created_at).toLocaleString("zh-CN")}
                            {diag.agent_name && ` · 智能体: ${diag.agent_name}`}
                          </div>
                          {diag.description && (
                            <div className="text-xs text-[var(--foreground)] mt-1 line-clamp-2">{diag.description}</div>
                          )}
                        </div>
                      </div>
                      {/* 操作按钮 */}
                      <div className="flex items-center gap-2 pl-6">
                        <button onClick={() => void handleDownloadDiagLog(diag.id)} className="text-[10px] px-2 py-0.5 rounded border border-[var(--border)] text-[var(--muted-foreground)] hover:text-[var(--foreground)] transition-colors">
                          下载日志
                        </button>
                        <button onClick={async () => {
                          const prompt = `【诊断问题】类型: ${diag.problem_type}\n严重级别: ${diag.severity}\n用户: ${diag.display_name || diag.username}\n描述: ${diag.description || '无'}\n智能体: ${diag.agent_name || '无'}\n时间: ${diag.created_at}\n上下文: ${JSON.stringify(diag.context).substring(0, 500)}\n\n请分析这个问题的根因并给出修复建议。`;
                          const copied = await copyToClipboard(prompt);
                          if (!copied) { showMessage("error", "复制失败，请手动复制诊断内容"); return; }
                          window.open('/', '_blank');
                        }} className="text-[10px] px-2 py-0.5 rounded bg-[var(--primary)]/10 text-[var(--primary)] hover:bg-[var(--primary)]/20 transition-colors">
                          AI诊断
                        </button>
                        {diag.status === 'pending' && (
                          <>
                            <button disabled={Boolean(diagUpdatingId)} onClick={() => void updateDiagStatus(diag.id, 'resolved')} className="text-[10px] px-2 py-0.5 rounded border border-green-500/30 text-green-600 hover:bg-green-500/10 transition-colors disabled:opacity-50">
                              已解决
                            </button>
                            <button disabled={Boolean(diagUpdatingId)} onClick={() => void updateDiagStatus(diag.id, 'ignored')} className="text-[10px] px-2 py-0.5 rounded border border-[var(--border)] text-[var(--muted-foreground)] hover:text-[var(--foreground)] transition-colors disabled:opacity-50">
                              忽略
                            </button>
                          </>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-center py-8 text-[var(--muted-foreground)] text-xs">
                  {diagLoading ? '加载中...' : diagError ? '诊断记录暂不可用' : '暂无诊断记录'}
                </div>
              )}
            </div>
          </div>
        )}

        {/* ── 安全中心 Tab ── */}
        {activeTab === "security" && (
          <SecurityCenterAdminTab
            token={token}
            canManageSecurity={hasSecuritySettingsPermission}
            sensitiveUnlocked={sensitiveUnlocked}
            onRequestUnlock={() => setUnlockDialogRequested(true)}
          />
        )}

        {activeTab === "white-label" && token && grantedPermissionKeys.has("white_label.manage") && (
          <WhiteLabelReadinessPanel token={token} onRequestUnlock={() => setUnlockDialogRequested(true)} />
        )}

        {/* ── 计费审计 Tab ── */}
        {activeTab === "billing-audit" && (
          <BillingAuditPanel />
        )}

        {/* ── 防护日志 Tab ── */}
        {activeTab === "guard-logs" && (
          <GuardLogsAdminTab />
        )}

        {/* ── 登录日志 Tab ── */}
        {activeTab === "login-logs" && (
          <LoginLogsAdminTab focusUserId={memberContextId} focusUserLabel={memberContextLabel} onClearFocus={clearMemberContext} />
        )}

        {/* ── 统一模型管理 Tab ── */}
        {activeTab === "models" && (
          <ModelsAdminTab
            token={token}
            canManageModelsPermission={hasModelSettingsPermission}
            sensitiveUnlocked={sensitiveUnlocked}
            canManagePlugins={hasIntegrationSettingsPermission}
            canManagePaymentSettings={hasPaymentSettingsPermission}
            settings={visibleSettings}
            settingsSaving={settingsSaving}
            updateSetting={updateSetting}
            saveModelSettings={() => void saveSettings("models", true, COVER_WORKFLOW_SETTING_FIELDS)}
            onModelsChange={loadLlmModels}
          />
        )}

        {activeTab === "storyboard-presets" && token && grantedPermissionKeys.has("platform.settings.manage") && (
          <StoryboardPresetsAdminTab token={token} actorId={String(userInfo?.id || "")}
            accessEpoch={String(adminAccess?.stepUp.expiresAt || "")}
            ready={Boolean(userInfo?.id && adminAccess?.access.authorityStatus === "ready" && adminAccess.access.integrityValid && sensitiveUnlocked)}
            onRequestUnlock={() => setUnlockDialogRequested(true)} />
        )}

        {activeTab === "workspace-models" && token && (
          <WorkspaceModelsAdminTab
            token={token}
            selectedProject={workspaceProject}
            visibleProjectIds={visibleWorkspaceProjectIds}
            canManage={grantedPermissionKeys.has("models.manage") && sensitiveUnlocked}
            onProjectChange={openWorkspaceProject}
            onOpenModels={() => openAdminTab("models")}
            onOpenAdmin={openWorkspaceAdminTarget}
            renderAdminTarget={(target: WorkspaceSpecializedTarget) => {
              const protectedPanel = (
                <div data-testid="workspace-protected-config" className="rounded-md border border-dashed border-[#d0d5dd] bg-[#f9fafb] px-6 py-12 text-center text-sm text-[#667085]">
                  受保护配置需要完成安全验证后读取。
                </div>
              );
              if (target === "commerce") {
                if (!grantedPermissionKeys.has("agents.view") || !grantedPermissionKeys.has("prompts.view") || !grantedPermissionKeys.has("models.view")) return null;
                return canReadPrompts ? (
                  <CommerceAgentAdminTab
                    token={token}
                    permissionKeys={adminAccess?.access.permissionKeys || []}
                  />
                ) : protectedPanel;
              }
              if (target === "digital-human") {
                if (!grantedPermissionKeys.has("models.manage")) return null;
                return sensitiveUnlocked ? <DigitalHumanAdminTab token={token} /> : protectedPanel;
              }
              if (target === "voice-studio") {
                if (!grantedPermissionKeys.has("models.manage")) return null;
                return sensitiveUnlocked ? <VoiceStudioAdminTab /> : protectedPanel;
              }
              if (target === "plugins") {
                if (!grantedPermissionKeys.has("integrations.manage")) return null;
                return sensitiveUnlocked ? <PluginManagementTab token={token} /> : protectedPanel;
              }
              if (target === "manju-workbench") {
                if (!grantedPermissionKeys.has("agents.manage") || !grantedPermissionKeys.has("prompts.view")) return null;
                return canReadPrompts ? (
                  <ManjuWorkbenchAdminTab
                    token={token}
                    onOpenModels={() => openAdminTab("models")}
                    onOpenVoiceStudio={() => openWorkspaceProject("voice")}
                  />
                ) : protectedPanel;
              }
              return null;
            }}
          />
        )}

        {/* 数据同步 */}
        {activeTab === "sync" && (
          <SyncAdminTab token={token} />
        )}

        {/* 数据备份 */}
        {activeTab === "backup" && (
          <BackupAdminTab token={token} />
        )}

        {/* 邀请礼包与会员权益模板：不发起支付 */}
        {activeTab === "benefit-packages" && (
          <MemberPackageTemplateManager token={token} />
        )}

        {/* 智能体导入（AIWeb + Coze 合并） */}
        {activeTab === "aiweb-import" && (
          <div className="space-y-4">
            <div className="flex items-center gap-2 border-b border-[var(--border)] pb-3">
              <button
                onClick={() => setImportMode("aiweb")}
                className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${importMode === "aiweb" ? "bg-[var(--primary)] text-white" : "bg-[var(--card)] text-[var(--secondary-foreground)] hover:bg-[var(--border)]"}`}
              >
                AIWeb 导入
              </button>
              <button
                onClick={() => setImportMode("coze")}
                className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${importMode === "coze" ? "bg-[var(--primary)] text-white" : "bg-[var(--card)] text-[var(--secondary-foreground)] hover:bg-[var(--border)]"}`}
              >
                Coze 工作空间导入
              </button>
            </div>
            {importMode === "aiweb" ? (
              <AIWebImportTab token={token} onImportComplete={loadAgents} />
            ) : (
              <CozeImportTab token={token} onImportComplete={loadAgents} />
            )}
          </div>
        )}

        {/* 卡密管理 */}
        {activeTab === "cami" && (
          <CamiTab token={token} users={users} focusUserId={memberContextId} focusUserLabel={memberContextLabel} onClearFocus={clearMemberContext} canManagePackages={canManagePackages} canViewMembers={canViewMembers} />
        )}

        {/* 支付配置 */}
        {activeTab === "payment" && (
          <PaymentConfigAdminTab
            token={token}
            sensitiveUnlocked={sensitiveUnlocked}
            canViewBilling={Boolean(adminAccess?.access.permissionKeys.includes("billing.view"))}
            onRequestUnlock={() => setUnlockDialogRequested(true)}
          />
        )}

        {/* 统一模型编辑对话框 - 由 UnifiedModelsTab 内部管理 */}

        {/* ====== 学员邮箱与密码安全操作弹窗 ====== */}
        {memberSecurityDialog && (
          <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/55 p-4" onClick={closeMemberSecurityDialog}>
            <div role="dialog" aria-modal="true" aria-labelledby="member-security-dialog-title" data-testid="member-security-dialog" className="w-full max-w-lg rounded-2xl border border-[var(--border)] bg-[var(--card)] p-6 shadow-2xl" onClick={(event) => event.stopPropagation()}>
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h3 id="member-security-dialog-title" className="text-xl font-semibold text-[var(--foreground)]">{memberSecurityDialog.kind === "identity_change" ? "编辑学员账号" : "重置学员密码"}</h3>
                  <p className="mt-1 text-sm text-[var(--muted-foreground)]">{memberSecurityDialog.user.name || memberSecurityDialog.user.displayName || memberSecurityDialog.user.username}</p>
                </div>
                <button type="button" disabled={memberSecuritySubmitting} onClick={closeMemberSecurityDialog} className="rounded-lg px-3 py-2 text-sm text-[var(--muted-foreground)] hover:bg-[var(--accent)] disabled:opacity-40">关闭</button>
              </div>

              <div className="mt-5 space-y-4">
                {memberSecurityDialog.kind === "identity_change" ? (
                  <div className="space-y-4">
                    <div>
                      <label className={labelCls}>登录账号 *</label>
                      <input value={memberSecurityDialog.username} onChange={(event) => setMemberSecurityDialog({ ...memberSecurityDialog, username: event.target.value })} className={inputCls} placeholder="用于登录的账号" />
                    </div>
                    <div>
                      <label className={labelCls}>QQ安全邮箱（不可更改）</label>
                      <input type="email" value={memberSecurityDialog.email} readOnly aria-readonly="true" className={`${inputCls} cursor-not-allowed opacity-70`} />
                    </div>
                    <p className="rounded-xl border border-amber-500/20 bg-amber-500/5 px-4 py-3 text-sm text-[var(--muted-foreground)]">QQ邮箱是永久身份凭据，管理员也不能改写。这里仅允许调整登录账号；未绑定邮箱的历史账号须由学员本人完成一次性验证绑定。</p>
                  </div>
                ) : (
                  <div className="rounded-xl border border-[var(--border)] bg-[var(--muted)]/25 px-4 py-3">
                    <p className="text-sm text-[var(--muted-foreground)]">重置后处理</p>
                    <p className="mt-1 font-medium text-[var(--foreground)]">新密码立即生效，该学员所有旧设备退出。</p>
                  </div>
                )}

                {memberSecurityDialog.kind === "password_reset" && (
                  <div>
                    <label className={labelCls}>新密码 *</label>
                    <input type="password" autoComplete="new-password" value={memberSecurityDialog.newPassword} onChange={(event) => setMemberSecurityDialog({ ...memberSecurityDialog, newPassword: event.target.value })} className={inputCls} placeholder="至少 8 个字符" />
                  </div>
                )}

                <div>
                  <label className={labelCls}>管理员操作密码 *</label>
                  <input type="password" autoComplete="current-password" value={memberSecurityDialog.adminPassword} onChange={(event) => setMemberSecurityDialog({ ...memberSecurityDialog, adminPassword: event.target.value })} className={inputCls} placeholder="用于确认本次敏感操作" />
                </div>
              </div>

              <div className="mt-6 flex justify-end gap-3">
                <button type="button" disabled={memberSecuritySubmitting} onClick={closeMemberSecurityDialog} className={btnGhost}>取消</button>
                <button type="button" disabled={memberSecuritySubmitting || !memberSecurityDialog.adminPassword} onClick={submitMemberSecurityChange} className={`${btnPrimary} disabled:cursor-not-allowed disabled:opacity-40`}>
                  {memberSecuritySubmitting ? "提交中..." : memberSecurityDialog.kind === "identity_change" ? "确认并更新账号" : "确认并重置密码"}
                </button>
              </div>
            </div>
          </div>
        )}

        {packageUser && token && (
          <MemberPackageAssignmentDialog
            open
            token={token}
            recordId={null}
            userId={packageUser.id}
            userName={packageUser.name || packageUser.displayName || packageUser.username || packageUser.phone || "该会员"}
            existingAssignment={null}
            onClose={() => setPackageUser(null)}
            onChanged={async (resultMessage) => {
              setPackageUser(null);
              await loadUsers();
              showSuccessAndSync(resultMessage);
            }}
          />
        )}

        {/* ====== 会员功能权限编辑弹窗（全局） ====== */}
        {editingUserAccess && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={closeUserAccessEditor}>
            <div role="dialog" aria-modal="true" aria-labelledby="member-navigation-dialog-title" data-testid="member-navigation-dialog" className="flex max-h-[88vh] w-[min(920px,calc(100vw-48px))] flex-col overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--card)] shadow-2xl" onClick={(event) => event.stopPropagation()}>
              <div className="border-b border-[var(--border)] px-6 py-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h3 id="member-navigation-dialog-title" className="text-lg font-semibold text-[var(--foreground)]">会员功能权限</h3>
                    <p className="mt-1 text-sm text-[var(--muted-foreground)]">
                      <span className="font-medium text-[var(--foreground)]">{editingUserAccess.name || editingUserAccess.displayName || editingUserAccess.username}</span>
                      {editingUserAccess.role === "admin" && <span className="ml-2 text-xs text-[var(--primary)]">后台管理权由角色保留；此处只配置前台业务与智能体权限</span>}
                    </p>
                  </div>
                  <div className="text-right text-xs text-[var(--muted-foreground)]">
                    <p>权限版本 R{editAccessRevision}</p>
                    <p>{editAccessUpdatedAt ? `最近更新 ${formatAdminDate(editAccessUpdatedAt)}` : "尚无人工更新"}</p>
                  </div>
                </div>
                <div className="mt-4 rounded-xl border border-blue-500/15 bg-blue-500/7 px-3.5 py-3 text-xs leading-5 text-blue-600">
                  权限保存在独立数据库快照中。未勾选项目会同时从导航隐藏、阻止直达页面并拒绝对应接口；系统以后新增功能不会自动加入已有会员。模板只是复制起点，不会在后台悄悄改动已分配会员。
                </div>
              </div>

              <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
                {editAccessLoading ? (
                  <div className="flex min-h-56 items-center justify-center text-sm text-[var(--muted-foreground)]" role="status">正在读取数据库权限快照…</div>
                ) : !editAccessIntegrityValid ? (
                  <div className="rounded-xl border border-red-500/25 bg-red-500/10 px-4 py-4 text-sm text-red-600" role="alert">
                    权限快照缺失或完整性校验失败。为避免误覆盖，本窗口已锁定保存，请先核查数据库迁移与审计记录。
                  </div>
                ) : (
                  <div className="space-y-6">
                    {editAccessProfiles.length > 0 && (
                      <section data-testid="member-permission-quick-profiles">
                        <div className="mb-2 flex items-center justify-between gap-3">
                          <h4 className="text-sm font-semibold text-[var(--foreground)]">快速模板</h4>
                          <span className="text-xs text-[var(--muted-foreground)]">选择后仍可自定义；自定义会解除模板标记</span>
                        </div>
                        <div className="grid grid-cols-3 gap-3">
                          {MEMBER_PERMISSION_QUICK_PROFILE_KEYS.flatMap((key) => {
                            const profile = editAccessProfiles.find((candidate) => candidate.key === key);
                            return profile ? [profile] : [];
                          }).map((profile) => {
                            const selected = editAccessProfile?.key === profile.key && editAccessProfile?.version === profile.version;
                            return (
                              <button
                                key={`${profile.key}:${profile.version}`}
                                data-testid={`member-permission-profile-${profile.key}`}
                                type="button"
                                aria-pressed={selected}
                                onClick={() => {
                                  setEditFeatureNavigationKeys(normalizeFeatureNavigationKeys(profile.featureNavigationKeys));
                                  setEditAccessCategories(normalizeAllowedAgentNavigationKeys(profile.agentNavigationKeys));
                                  setEditAccessProfile({ key: profile.key, version: profile.version });
                                }}
                                className={`min-h-14 rounded-xl border px-4 py-3 text-left transition-colors ${selected ? "border-[var(--primary)] bg-[var(--primary)]/10" : "border-[var(--border)] bg-[var(--background)] hover:border-[var(--primary)]/40"}`}
                              >
                                <span className="text-sm font-semibold text-[var(--foreground)]">{MEMBER_PERMISSION_QUICK_PROFILE_LABELS[profile.key as keyof typeof MEMBER_PERMISSION_QUICK_PROFILE_LABELS]}</span>
                              </button>
                            );
                          })}
                        </div>
                      </section>
                    )}

                    <section>
                      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                        <div>
                          <h4 className="text-sm font-semibold text-[var(--foreground)]">业务功能导航</h4>
                          <p className="mt-0.5 text-xs text-[var(--muted-foreground)]">控制工作台入口、直达页面和该业务接口。</p>
                        </div>
                        <div className="flex gap-2">
                          <button type="button" onClick={() => { setEditFeatureNavigationKeys([...ALL_MEMBER_FEATURE_KEYS]); setEditAccessProfile(null); }} className="rounded-lg border border-[var(--border)] px-2.5 py-1.5 text-xs text-[var(--secondary-foreground)] hover:border-[var(--primary)]">全选</button>
                          <button type="button" onClick={() => { setEditFeatureNavigationKeys([]); setEditAccessProfile(null); }} className="rounded-lg border border-[var(--border)] px-2.5 py-1.5 text-xs text-[var(--secondary-foreground)] hover:border-amber-500">清空</button>
                        </div>
                      </div>
                      <div data-testid="member-feature-permission-options" className="grid grid-cols-3 gap-2.5">
                        {MEMBER_FEATURE_PERMISSION_OPTIONS.map((option) => {
                          const checked = editFeatureNavigationKeys.includes(option.key);
                          return (
                            <button
                              key={option.key}
                              type="button"
                              onClick={() => {
                                setEditFeatureNavigationKeys((previous) => checked ? previous.filter((key) => key !== option.key) : [...previous, option.key]);
                                setEditAccessProfile(null);
                              }}
                              className={`rounded-xl border px-3 py-2.5 text-left transition-colors ${checked ? "border-emerald-500/35 bg-emerald-500/10" : "border-[var(--border)] bg-[var(--background)] hover:border-[var(--foreground)]/35"}`}
                              aria-pressed={checked}
                            >
                              <span className="flex items-center justify-between gap-2 text-sm font-medium text-[var(--foreground)]"><span>{option.label}</span><span className={checked ? "text-emerald-500" : "text-[var(--muted-foreground)]"}>{checked ? "已开" : "关闭"}</span></span>
                              <span className="mt-1 block truncate text-[10px] text-[var(--muted-foreground)]">{option.route}</span>
                            </button>
                          );
                        })}
                      </div>
                      {editFeatureNavigationKeys.length === 0 && (
                        <div className="mt-3 rounded-lg border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-xs text-amber-600">该会员将看不到并无法调用任何业务工作台。</div>
                      )}
                    </section>

                    <section>
                      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                        <div>
                          <h4 className="text-sm font-semibold text-[var(--foreground)]">智能体分类</h4>
                          <p className="mt-0.5 text-xs text-[var(--muted-foreground)]">在应用广场权限之内，进一步限制可见卡片与对话调用。</p>
                        </div>
                        <div className="flex gap-2">
                          <button type="button" onClick={() => { setEditAccessCategories([...ALL_AGENT_NAVIGATION_KEYS]); setEditAccessProfile(null); }} className="rounded-lg border border-[var(--border)] px-2.5 py-1.5 text-xs text-[var(--secondary-foreground)] hover:border-[var(--primary)]">全选</button>
                          <button type="button" onClick={() => { setEditAccessCategories([]); setEditAccessProfile(null); }} className="rounded-lg border border-[var(--border)] px-2.5 py-1.5 text-xs text-[var(--secondary-foreground)] hover:border-amber-500">清空</button>
                        </div>
                      </div>
                      <div className="flex flex-wrap gap-2" data-testid="member-agent-permission-options">
                        {AGENT_NAVIGATION_OPTIONS.map((option) => {
                          const checked = editAccessCategories.includes(option.key);
                          return (
                            <button
                              key={option.key}
                              type="button"
                              onClick={() => {
                                setEditAccessCategories((previous) => checked ? previous.filter((key) => key !== option.key) : [...previous, option.key]);
                                setEditAccessProfile(null);
                              }}
                              className={`rounded-lg border px-3 py-2 text-xs font-medium transition-colors ${checked ? "border-emerald-600 bg-emerald-700 text-white shadow-sm" : "border-[var(--border)] bg-[var(--card)] text-[var(--foreground)] hover:border-emerald-600 hover:text-emerald-700"}`}
                              aria-pressed={checked}
                              data-testid={`member-agent-permission-${option.key}`}
                            >
                              {option.label}
                            </button>
                          );
                        })}
                      </div>
                      {editAccessCategories.length === 0 && (
                        <div className="mt-3 rounded-lg border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-xs text-amber-600" data-testid="member-navigation-empty-state">该会员不会看到或调用任何智能体。</div>
                      )}
                    </section>

                    <section>
                      <label className={labelCls}>变更说明</label>
                      <input value={editAccessReason} onChange={(event) => setEditAccessReason(event.target.value)} maxLength={500} className={inputCls} placeholder="例如：3980 正式会员，开放内容生产功能" />
                      <p className="mt-1 text-[10px] text-[var(--muted-foreground)]">说明、管理员、前后权限快照和操作时间都会写入不可修改的审计记录。</p>
                    </section>
                  </div>
                )}
              </div>

              <div className="flex items-center justify-between gap-3 border-t border-[var(--border)] px-6 py-4">
                <p className="text-xs text-[var(--muted-foreground)]">保存采用版本校验；其他窗口已更新时，本次会拒绝覆盖。</p>
                <div className="flex gap-3">
                  <button type="button" disabled={editAccessSaving} onClick={closeUserAccessEditor} className={btnGhost}>取消</button>
                  <button type="button" disabled={editAccessLoading || editAccessSaving || !editAccessIntegrityValid} onClick={handleSaveUserAccess} className={`${btnPrimary} disabled:cursor-not-allowed disabled:opacity-40`}>
                    {editAccessSaving ? "保存中…" : "保存功能权限"}
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ====== 交易明细弹窗（全局） ====== */}
        {viewingUserTransactions && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => setViewingUserTransactions(null)}>
            <div className="bg-[var(--card)] rounded-2xl border border-[var(--border)] w-full max-w-4xl max-h-[85vh] shadow-2xl flex flex-col" onClick={(e) => e.stopPropagation()}>
              {/* Header */}
              <div className="flex items-center justify-between px-6 py-4 border-b border-[var(--border)] shrink-0">
                <div>
                  <h3 className="text-lg font-semibold text-[var(--foreground)]">学员 360° 运营档案</h3>
                  <p className="text-sm text-[var(--muted-foreground)]">
                    {viewingUserTransactions.name || viewingUserTransactions.displayName || viewingUserTransactions.username}
                    {viewingUserTransactions.phone && <span className="ml-2">({viewingUserTransactions.phone})</span>}
                  </p>
                </div>
                <div className="flex flex-wrap items-center justify-end gap-2">
                  {hasBillingExportPermission && <button type="button" disabled={memberExportingId === viewingUserTransactions.id} onClick={() => void exportMemberReconciliation(viewingUserTransactions)} className="rounded-lg border border-blue-500/25 bg-blue-500/8 px-3 py-2 text-xs font-semibold text-blue-600 disabled:opacity-50">{memberExportingId === viewingUserTransactions.id ? "导出中..." : "下载全部充值记录"}</button>}
                  {hasWalletAdjustPermission && visibleAdminTabSet.has("offline-payments") && viewingUserTransactions.role !== "admin" && !isFixtureUser(viewingUserTransactions) && viewingUserTransactions.memberStatus !== "active" && <button type="button" onClick={() => { const user = viewingUserTransactions; setViewingUserTransactions(null); openMemberModule("offline-payments", user.id); }} className="rounded-lg bg-emerald-500/10 px-3 py-2 text-xs font-semibold text-emerald-600">补录收款并激活</button>}
                  {visibleAdminTabSet.has("invitations") && viewingUserTransactions.role !== "admin" && <button type="button" onClick={() => { const user = viewingUserTransactions; setViewingUserTransactions(null); openMemberModule("invitations", user.id); }} className="rounded-lg bg-amber-500/10 px-3 py-2 text-xs font-semibold text-amber-600">邀请礼包</button>}
                  {hasPackagesManagePermission && visibleAdminTabSet.has("cami") && viewingUserTransactions.role !== "admin" && !isFixtureUser(viewingUserTransactions) && <button type="button" onClick={() => { const user = viewingUserTransactions; setViewingUserTransactions(null); openMemberModule("cami", user.id); }} className="rounded-lg bg-emerald-500/10 px-3 py-2 text-xs font-semibold text-emerald-600">发会员卡</button>}
                  {visibleAdminTabSet.has("login-logs") && <button type="button" onClick={() => { const user = viewingUserTransactions; setViewingUserTransactions(null); openMemberModule("login-logs", user.id); }} className="rounded-lg bg-slate-500/10 px-3 py-2 text-xs font-semibold text-slate-600">完整登录审计</button>}
                  <button onClick={() => setViewingUserTransactions(null)} aria-label="关闭运营档案" className="ml-1 text-[var(--muted-foreground)] hover:text-[var(--foreground)] transition-colors">
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                  </button>
                </div>
              </div>

              {/* Loading */}
              {transactionLoading && (
                <div className="flex-1 flex items-center justify-center py-20">
                  <div className="animate-spin w-8 h-8 border-2 border-[var(--primary)] border-t-transparent rounded-full"></div>
                </div>
              )}

              {/* Content */}
              {!transactionLoading && transactionData && (
                <>
                  <div className="grid grid-cols-1 gap-3 border-b border-[var(--border)] px-6 py-4 md:grid-cols-4">
                    {canViewMemberSecurity && <>
                    <div className="rounded-xl border border-[var(--border)] bg-[var(--background)] p-3">
                      <p className="text-[10px] font-semibold uppercase tracking-wider text-[var(--muted-foreground)]">今日成功登录</p>
                      <p className="mt-1 text-xl font-black text-emerald-600">{memberUsageSummary?.login.today ?? 0}<span className="ml-1 text-xs font-medium">次</span></p>
                      <p className="mt-1 text-[10px] text-[var(--muted-foreground)]">最近：{formatAdminDate(viewingUserTransactions.last_sign_in_at || viewingUserTransactions.lastActive)}</p>
                    </div>
                    <div className="rounded-xl border border-[var(--border)] bg-[var(--background)] p-3">
                      <p className="text-[10px] font-semibold uppercase tracking-wider text-[var(--muted-foreground)]">累计登录审计</p>
                      <p className="mt-1 text-sm font-bold text-[var(--foreground)]">成功 {memberUsageSummary?.login.success ?? 0} · <span className="text-red-500">失败 {memberUsageSummary?.login.failed ?? 0}</span></p>
                      <p className="mt-1 text-[10px] text-[var(--muted-foreground)]">合计 {memberUsageSummary?.login.total ?? 0} 次尝试</p>
                    </div>
                    </>}
                    {canViewMemberContent && <div className="rounded-xl border border-[var(--border)] bg-[var(--background)] p-3">
                      <p className="text-[10px] font-semibold uppercase tracking-wider text-[var(--muted-foreground)]">聊天档案</p>
                      <p className="mt-1 text-xl font-black text-violet-600">{memberUsageSummary?.conversationCount ?? 0}<span className="ml-1 text-xs font-medium">个会话</span></p>
                      <button type="button" onClick={() => { const q = viewingUserTransactions.name || viewingUserTransactions.displayName || viewingUserTransactions.email || viewingUserTransactions.phone || ""; setViewingUserTransactions(null); setChatListSearch(q); setChatListPage(1); setUserSubTab("chats"); }} className="mt-1 text-[10px] font-semibold text-violet-600 hover:underline">查询聊天记录</button>
                    </div>}
                    {canViewBilling && (
                    <div className="rounded-xl border border-[var(--border)] bg-[var(--background)] p-3">
                      <p className="text-[10px] font-semibold uppercase tracking-wider text-[var(--muted-foreground)]">累计实际消耗</p>
                      <p className="mt-1 text-sm font-bold text-[var(--foreground)]">{Number(transactionData.summary.totalCreditsConsumed || 0).toLocaleString()} 积分</p>
                      <p className="mt-1 text-xs font-bold text-red-500">¥{Number(transactionData.summary.totalCashConsumed || 0).toFixed(2)} 现金</p>
                    </div>
                    )}
                  </div>
                  {/* 概览统计卡片 */}
                  {canViewBilling && (
                  <div className="grid grid-cols-3 md:grid-cols-6 gap-3 px-6 py-4 border-b border-[var(--border)] shrink-0">
                    <div className="rounded-xl bg-[var(--background)] border border-[var(--border)] p-3">
                      <p className="text-[10px] text-[var(--muted-foreground)] uppercase tracking-wider mb-1">积分余额</p>
                      <p className="text-lg font-bold text-[var(--primary)]">{transactionData.summary.creditBalance?.toLocaleString() ?? '-'}</p>
                      <p className="text-[10px] text-[var(--muted-foreground)] mt-1">充 {transactionData.summary.totalCreditsRecharged?.toLocaleString()} | 耗 {transactionData.summary.totalCreditsConsumed?.toLocaleString()}</p>
                    </div>
                    <div className="rounded-xl bg-[var(--background)] border border-[var(--border)] p-3">
                      <p className="text-[10px] text-[var(--muted-foreground)] uppercase tracking-wider mb-1">现金余额</p>
                      <p className="text-lg font-bold text-emerald-600">¥{Number(transactionData.summary.cashBalance ?? 0).toFixed(2)}</p>
                      <p className="text-[10px] text-[var(--muted-foreground)] mt-1">充 ¥{transactionData.summary.totalCashRecharged?.toFixed(2)} | 耗 ¥{transactionData.summary.totalCashConsumed?.toFixed(2)}</p>
                    </div>
                    <div className="rounded-xl bg-[var(--background)] border border-[var(--border)] p-3">
                      <p className="text-[10px] text-[var(--muted-foreground)] mb-1">💬 对话</p>
                      <p className="text-lg font-bold text-[var(--primary)]">{transactionData.revenueSummary?.chat?.count ?? 0}次</p>
                      <p className="text-[10px] text-[var(--muted-foreground)] mt-1">¥{(transactionData.revenueSummary?.chat?.totalSelling ?? 0).toFixed(2)}</p>
                    </div>
                    <div className="rounded-xl bg-[var(--background)] border border-[var(--border)] p-3">
                      <p className="text-[10px] text-[var(--muted-foreground)] mb-1">🎬 视频</p>
                      <p className="text-lg font-bold text-violet-600">{transactionData.revenueSummary?.video?.count ?? 0}次</p>
                      <p className="text-[10px] text-[var(--muted-foreground)] mt-1">¥{(transactionData.revenueSummary?.video?.totalSelling ?? 0).toFixed(2)}</p>
                    </div>
                    <div className="rounded-xl bg-[var(--background)] border border-[var(--border)] p-3">
                      <p className="text-[10px] text-[var(--muted-foreground)] mb-1">🎨 封面</p>
                      <p className="text-lg font-bold text-pink-600">{transactionData.revenueSummary?.image?.count ?? 0}次</p>
                      <p className="text-[10px] text-[var(--muted-foreground)] mt-1">¥{(transactionData.revenueSummary?.image?.totalSelling ?? 0).toFixed(2)}</p>
                    </div>
                    <div className="rounded-xl bg-[var(--background)] border border-[var(--border)] p-3">
                      <p className="text-[10px] text-[var(--muted-foreground)] mb-1">📋 提取</p>
                      <p className="text-lg font-bold text-amber-600">{(transactionData.revenueSummary?.extract?.count ?? 0) + (transactionData.revenueSummary?.deep_thinking?.count ?? 0)}次</p>
                      <p className="text-[10px] text-[var(--muted-foreground)] mt-1">¥{((transactionData.revenueSummary?.extract?.totalSelling ?? 0) + (transactionData.revenueSummary?.deep_thinking?.totalSelling ?? 0)).toFixed(2)}</p>
                    </div>
                  </div>
                  )}

                  {/* Tab切换 */}
                  <div className="flex items-center gap-1 px-6 pt-3 pb-2 border-b border-[var(--border)] shrink-0 flex-wrap">
                    {[
                      { key: "lifecycle" as const, label: "生命周期" },
                      { key: "all" as const, label: "全部记录" },
                      { key: "credits" as const, label: "积分记录" },
                      { key: "cash" as const, label: "现金记录" },
                      { key: "consumption" as const, label: "消费明细" },
                      { key: "video" as const, label: "视频明细" },
                      { key: "daily" as const, label: "每日统计" },
                      { key: "login" as const, label: "登录记录" },
                    ].filter((tab) => tab.key === "login" ? canViewMemberSecurity : canViewBilling).map((tab) => (
                      <button
                        key={tab.key}
                        onClick={() => {
                          setTransactionTab(tab.key);
                          if (tab.key === "login" && viewingUserTransactions) {
                            loadLoginLogs(viewingUserTransactions.id);
                          }
                        }}
                        className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                          transactionTab === tab.key
                            ? "bg-[var(--primary)] text-[var(--background)]"
                            : "text-[var(--muted-foreground)] hover:bg-[var(--border)]"
                        }`}
                      >
                        {tab.label}
                      </button>
                    ))}
                    {/* 充值/消耗筛选 */}
                    {canViewBilling && (transactionTab === "all" || transactionTab === "credits" || transactionTab === "cash") && (
                      <div className="ml-auto flex items-center gap-1">
                        {[
                          { key: "all" as const, label: "全部" },
                          { key: "recharge" as const, label: "充值" },
                          { key: "consume" as const, label: "消耗" },
                        ].map((f) => (
                          <button
                            key={f.key}
                            onClick={() => setTransactionFilter(f.key)}
                            className={`px-2 py-1 rounded text-[10px] font-medium transition-colors ${
                              transactionFilter === f.key
                                ? "bg-[var(--foreground)] text-[var(--background)]"
                                : "text-[var(--muted-foreground)] hover:bg-[var(--border)]"
                            }`}
                          >
                            {f.label}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* 列表区域 */}
                  <div className="flex-1 overflow-y-auto px-6 py-3">
                    {!canViewBilling && !canViewMemberSecurity && !canViewMemberContent && (
                      <div data-testid="member-dossier-minimal-view" className="py-10 text-center text-sm text-[var(--muted-foreground)]">当前岗位仅可查看会员基本资料。</div>
                    )}
                    {canViewBilling && transactionTab === "lifecycle" && (
                      <div className="space-y-3">
                        <div className="grid grid-cols-2 gap-2 md:grid-cols-5">
                          <div className="rounded-xl border border-[var(--border)] bg-[var(--background)] p-3"><p className="text-[10px] text-[var(--muted-foreground)]">当前会员状态</p><p className="mt-1 text-sm font-bold text-[var(--foreground)]">{memberLifecycle?.summary?.memberStatus === "active" ? "正式会员" : memberLifecycle?.summary?.memberStatus === "trial" ? "试用会员" : memberLifecycle?.summary?.memberStatus === "expired" ? "会员过期" : "未激活"}</p></div>
                          <div className="rounded-xl border border-[var(--border)] bg-[var(--background)] p-3"><p className="text-[10px] text-[var(--muted-foreground)]">成功邀请人数</p><p className="mt-1 text-sm font-bold text-[var(--foreground)]">{memberLifecycle?.summary?.invitationCount ?? 0}</p></div>
                          <div className="rounded-xl border border-[var(--border)] bg-[var(--background)] p-3"><p className="text-[10px] text-[var(--muted-foreground)]">已收邀请礼包</p><p className="mt-1 text-sm font-bold text-[var(--foreground)]">{memberLifecycle?.summary?.receivedRewardCount ?? 0}</p></div>
                          <div className="rounded-xl border border-[var(--border)] bg-[var(--background)] p-3"><p className="text-[10px] text-[var(--muted-foreground)]">关联会员卡</p><p className="mt-1 text-sm font-bold text-[var(--foreground)]">{memberLifecycle?.summary?.cardCount ?? 0}</p></div>
                          <div className="rounded-xl border border-[var(--border)] bg-[var(--background)] p-3"><p className="text-[10px] text-[var(--muted-foreground)]">确认线下收款</p><p className="mt-1 text-sm font-bold text-[var(--foreground)]">{memberLifecycle?.summary?.offlinePaymentCount ?? 0}</p></div>
                        </div>
                        {(memberLifecycle?.events || []).map((event, index) => (
                          <div key={event.id} className="flex gap-3 rounded-xl border border-[var(--border)] bg-[var(--background)] px-4 py-3">
                            <div className="flex flex-col items-center"><span className={`mt-1 h-2.5 w-2.5 rounded-full ${event.status === "sent" || event.status === "completed" || event.status === "active" || event.status === "activated" || event.status === "redeemed" ? "bg-emerald-500" : event.status === "waiting" || event.status === "draft" || event.status === "registered" ? "bg-amber-500" : "bg-slate-400"}`} />{index < (memberLifecycle?.events.length || 0) - 1 && <span className="mt-1 h-full min-h-6 w-px bg-[var(--border)]" />}</div>
                            <div className="min-w-0 flex-1"><div className="flex flex-wrap items-center justify-between gap-2"><p className="text-sm font-semibold text-[var(--foreground)]">{event.title}</p><time className="text-[10px] text-[var(--muted-foreground)]">{formatAdminDate(event.occurredAt)}</time></div><p className="mt-1 text-xs leading-relaxed text-[var(--muted-foreground)]">{event.detail}</p></div>
                          </div>
                        ))}
                        {(!memberLifecycle?.events || memberLifecycle.events.length === 0) && <div className="py-8 text-center text-sm text-[var(--muted-foreground)]">暂无生命周期事件</div>}
                      </div>
                    )}
                    {/* 全部/积分/现金记录 Tab */}
                    {canViewBilling && (transactionTab === "all" || transactionTab === "credits" || transactionTab === "cash") && (
                      <div className="space-y-2">
                        {transactionData.transactions
                          ?.filter((t: any) => {
                            if (transactionTab === "credits") return t.category === "credits";
                            if (transactionTab === "cash") return t.category === "cash";
                            return true;
                          })
                          .filter((t: any) => {
                            if (transactionFilter === "recharge") return t.transactionType === "recharge" || t.type === "recharge" || t.type === "topup";
                            if (transactionFilter === "consume") return t.transactionType === "consumption" || t.type === "consume" || t.type === "consumption";
                            return true;
                          })
                          .map((t: any) => {
                            const isRecharge = t.transactionType === "recharge" || t.type === "recharge" || t.type === "topup";
                            const isCredits = t.category === "credits";
                            const amount = Number(t.amount);
                            const displayAmount = isRecharge ? `+${Math.abs(amount)}` : `-${Math.abs(amount)}`;
                            const amountColor = isRecharge ? "text-emerald-600" : "text-red-500";
                            const categoryLabel = isCredits ? "积分" : "现金";
                            const categoryBadge = isCredits ? "bg-[var(--primary)]/10 text-[var(--primary)]" : "bg-emerald-500/10 text-emerald-600";

                            return (
                              <div key={t.id} className="flex items-center justify-between px-4 py-3 rounded-xl bg-[var(--background)] border border-[var(--border)] hover:border-[var(--foreground)]/20 transition-colors">
                                <div className="flex-1 min-w-0">
                                  <div className="flex items-center gap-2 mb-0.5">
                                    <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${categoryBadge}`}>{categoryLabel}</span>
                                    <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${isRecharge ? "bg-emerald-500/10 text-emerald-600" : "bg-red-500/10 text-red-500"}`}>
                                      {isRecharge ? "充值" : "消耗"}
                                    </span>
                                  </div>
                                  <p className="text-sm text-[var(--foreground)] truncate">{t.description || (isRecharge ? "充值" : "消耗")}</p>
                                  <p className="text-[10px] text-[var(--muted-foreground)] mt-0.5">
                                    {new Date(t.createdAt).toLocaleString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}
                                    {t.balanceAfter != null && <span className="ml-2">余额: {isCredits ? Number(t.balanceAfter).toLocaleString() : `¥${Number(t.balanceAfter).toFixed(2)}`}</span>}
                                  </p>
                                </div>
                                <div className={`text-base font-bold ${amountColor} whitespace-nowrap ml-4`}>
                                  {displayAmount}{isCredits ? " 积分" : " 元"}
                                </div>
                              </div>
                            );
                          })}
                        {(!transactionData.transactions || transactionData.transactions.length === 0) && (
                          <div className="text-center py-8 text-[var(--muted-foreground)] text-sm">暂无记录</div>
                        )}
                      </div>
                    )}

                    {/* 消费明细 Tab — 所有费用类型汇总 */}
                    {canViewBilling && transactionTab === "consumption" && (
                      <div className="space-y-3">
                        {/* 消费类型汇总卡片 */}
                        {transactionData.revenueSummary && (
                          <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
                            {[
                              { key: "chat", label: "智能体对话", icon: "💬", color: "text-[var(--primary)]" },
                              { key: "video", label: "视频生成", icon: "🎬", color: "text-violet-600" },
                              { key: "image", label: "封面生成", icon: "🎨", color: "text-pink-600" },
                              { key: "extract", label: "文案/视频提取", icon: "📋", color: "text-amber-600" },
                              { key: "deep_thinking", label: "深度思考", icon: "🧠", color: "text-indigo-600" },
                            ].map((cat) => {
                              const s = transactionData.revenueSummary[cat.key] || { count: 0, totalSelling: 0, totalCost: 0 };
                              if (s.count === 0) return null;
                              return (
                                <div key={cat.key} className="rounded-xl bg-[var(--background)] border border-[var(--border)] p-3">
                                  <div className="flex items-center gap-1.5 mb-1">
                                    <span className="text-sm">{cat.icon}</span>
                                    <span className="text-[10px] text-[var(--muted-foreground)]">{cat.label}</span>
                                  </div>
                                  <p className={`text-lg font-bold ${cat.color}`}>{s.count}次</p>
                                  <p className="text-[10px] text-[var(--muted-foreground)] mt-0.5">
                                    消费 ¥{s.totalSelling.toFixed(2)}
                                  </p>
                                </div>
                              );
                            })}
                          </div>
                        )}

                        {/* 消费明细列表 */}
                        {transactionData.revenueRecords && transactionData.revenueRecords.length > 0 ? (
                          <div className="space-y-2">
                            {transactionData.revenueRecords.map((r: any) => {
                              const typeMap: Record<string, { label: string; badge: string; icon: string }> = {
                                chat: { label: "智能体对话", badge: "bg-[var(--primary)]/10 text-[var(--primary)]", icon: "💬" },
                                video: { label: "视频生成", badge: "bg-violet-500/10 text-violet-600", icon: "🎬" },
                                image: { label: "封面生成", badge: "bg-pink-500/10 text-pink-600", icon: "🎨" },
                                extract: { label: "文案/视频提取", badge: "bg-amber-500/10 text-amber-600", icon: "📋" },
                                deep_thinking: { label: "深度思考", badge: "bg-indigo-500/10 text-indigo-600", icon: "🧠" },
                              };
                              const t = typeMap[r.recordType] || { label: r.recordType || "未知", badge: "bg-gray-500/10 text-gray-600", icon: "📌" };

                              return (
                                <div key={r.id} className="flex items-center justify-between px-4 py-3 rounded-xl bg-[var(--background)] border border-[var(--border)] hover:border-[var(--foreground)]/20 transition-colors">
                                  <div className="flex-1 min-w-0">
                                    <div className="flex items-center gap-2 mb-0.5">
                                      <span className="text-sm">{t.icon}</span>
                                      <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${t.badge}`}>{t.label}</span>
                                    </div>
                                    <p className="text-sm text-[var(--foreground)] truncate">{r.modelId || t.label}</p>
                                    <p className="text-[10px] text-[var(--muted-foreground)] mt-0.5">
                                      {new Date(r.createdAt).toLocaleString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}
                                      <span className="ml-2">成本 ¥{r.costPrice.toFixed(2)}</span>
                                    </p>
                                  </div>
                                  <div className="text-base font-bold text-red-500 whitespace-nowrap ml-4">
                                    ¥{r.sellingPrice.toFixed(2)}
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        ) : (
                          <div className="text-center py-8 text-[var(--muted-foreground)] text-sm">暂无消费记录</div>
                        )}
                      </div>
                    )}

                    {/* 视频明细 Tab */}
                    {canViewBilling && transactionTab === "video" && (
                      <div className="space-y-2">
                        {transactionData.videoTasks?.map((v: any) => (
                          <div key={v.id} className="flex items-center justify-between px-4 py-3 rounded-xl bg-[var(--background)] border border-[var(--border)] hover:border-[var(--foreground)]/20 transition-colors">
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2 mb-0.5">
                                <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-violet-500/10 text-violet-600">视频</span>
                                <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${v.status === "completed" ? "bg-emerald-500/10 text-emerald-600" : "bg-yellow-500/10 text-yellow-600"}`}>
                                  {v.status === "completed" ? "完成" : v.status}
                                </span>
                              </div>
                              <p className="text-sm text-[var(--foreground)]">{v.modelId}</p>
                              <p className="text-[10px] text-[var(--muted-foreground)] mt-0.5">
                                {new Date(v.createdAt).toLocaleString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}
                                {v.aspectRatio && <span className="ml-2">{v.aspectRatio}</span>}
                                {v.durationSeconds && <span className="ml-2">{v.durationSeconds}秒</span>}
                              </p>
                            </div>
                            <div className="text-base font-bold text-red-500 whitespace-nowrap ml-4">
                              ¥{Number(v.priceCharged).toFixed(2)}
                            </div>
                          </div>
                        ))}
                        {(!transactionData.videoTasks || transactionData.videoTasks.length === 0) && (
                          <div className="text-center py-8 text-[var(--muted-foreground)] text-sm">暂无视频记录</div>
                        )}
                      </div>
                    )}

                    {/* 每日统计 Tab */}
                    {canViewBilling && transactionTab === "daily" && (
                      <div>
                        <table className="w-full">
                          <thead>
                            <tr className="border-b border-[var(--border)]">
                              <th className="text-left py-2 text-xs font-medium text-[var(--muted-foreground)]">日期</th>
                              <th className="text-right py-2 text-xs font-medium text-[var(--muted-foreground)]">积分充值</th>
                              <th className="text-right py-2 text-xs font-medium text-[var(--muted-foreground)]">积分消耗</th>
                              <th className="text-right py-2 text-xs font-medium text-[var(--muted-foreground)]">现金充值</th>
                              <th className="text-right py-2 text-xs font-medium text-[var(--muted-foreground)]">现金消耗</th>
                              <th className="text-right py-2 text-xs font-medium text-[var(--muted-foreground)]">视频数</th>
                            </tr>
                          </thead>
                          <tbody>
                            {transactionData.dailyStats?.map((d: any) => (
                              <tr key={d.date} className="border-b border-[var(--border)] hover:bg-[var(--muted)]/30">
                                <td className="py-2 text-xs">{d.date}</td>
                                <td className="py-2 text-xs text-right text-emerald-600">+{d.creditsRecharged?.toLocaleString() ?? 0}</td>
                                <td className="py-2 text-xs text-right text-red-500">-{d.creditsConsumed?.toLocaleString() ?? 0}</td>
                                <td className="py-2 text-xs text-right text-emerald-600">+¥{d.cashRecharged?.toFixed(2) ?? "0.00"}</td>
                                <td className="py-2 text-xs text-right text-red-500">-¥{d.cashConsumed?.toFixed(2) ?? "0.00"}</td>
                                <td className="py-2 text-xs text-right">{d.videoCount ?? 0}</td>
                              </tr>
                            ))}
                            {(!transactionData.dailyStats || transactionData.dailyStats.length === 0) && (
                              <tr><td colSpan={6} className="text-center py-8 text-[var(--muted-foreground)] text-sm">暂无数据</td></tr>
                            )}
                          </tbody>
                        </table>
                      </div>
                    )}

                    {/* 在线支付记录（底部折叠区） */}
                    {canViewBilling && transactionTab === "all" && transactionData.paymentOrders && transactionData.paymentOrders.length > 0 && (
                      <div className="mt-6">
                        <h4 className="text-sm font-semibold text-[var(--foreground)] mb-2">在线支付订单</h4>
                        <div className="space-y-2">
                          {transactionData.paymentOrders.map((o: any) => {
                            const statusMap: Record<string, { label: string; cls: string }> = {
                              paid: { label: "已支付", cls: "bg-emerald-500/10 text-emerald-600" },
                              pending: { label: "待支付", cls: "bg-yellow-500/10 text-yellow-600" },
                              expired: { label: "已过期", cls: "bg-[var(--border)] text-[var(--muted-foreground)]" },
                            };
                            const st = statusMap[o.status] || statusMap.pending;
                            return (
                              <div key={o.id} className="flex items-center justify-between px-4 py-3 rounded-xl bg-[var(--background)] border border-[var(--border)]">
                                <div className="flex-1 min-w-0">
                                  <div className="flex items-center gap-2 mb-0.5">
                                    <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${st.cls}`}>{st.label}</span>
                                    <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-500/10 text-amber-600">{o.type === "credits" ? "积分" : "现金"}</span>
                                    {o.paymentProvider && <span className="text-[10px] text-[var(--muted-foreground)]">{o.paymentProvider}</span>}
                                  </div>
                                  <p className="text-sm text-[var(--foreground)]">¥{Number(o.amount).toFixed(2)}{o.creditsAmount ? ` = ${o.creditsAmount}积分` : ""}</p>
                                  <p className="text-[10px] text-[var(--muted-foreground)] mt-0.5">
                                    {new Date(o.createdAt).toLocaleString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}
                                    {o.paidAt && <span className="ml-2">支付于 {new Date(o.paidAt).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}</span>}
                                  </p>
                                </div>
                                <div className="text-base font-bold text-amber-600 whitespace-nowrap ml-4">¥{Number(o.amount).toFixed(2)}</div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}

                    {/* 登录记录 Tab */}
                    {canViewMemberSecurity && transactionTab === "login" && (
                      <div className="space-y-2 max-h-[400px] overflow-y-auto">
                        <table className="w-full text-sm">
                          <thead>
                            <tr className="border-b border-[var(--border)]">
                              <th className="text-left py-2 px-2 text-[var(--muted-foreground)] font-medium text-xs">时间</th>
                              <th className="text-left py-2 px-2 text-[var(--muted-foreground)] font-medium text-xs">IP地址</th>
                              <th className="text-left py-2 px-2 text-[var(--muted-foreground)] font-medium text-xs">设备</th>
                              <th className="text-left py-2 px-2 text-[var(--muted-foreground)] font-medium text-xs">状态</th>
                            </tr>
                          </thead>
                          <tbody>
                            {loginLogs.map((log: any) => (
                              <tr key={log.id} className="border-b border-[var(--border)]/50 hover:bg-[var(--muted)]/30">
                                <td className="py-2 px-2 text-xs">{new Date(log.created_at).toLocaleString("zh-CN")}</td>
                                <td className="py-2 px-2 text-xs font-mono">{log.ip_address || "-"}</td>
                                <td className="py-2 px-2 text-xs max-w-[200px] truncate" title={log.user_agent || ""}>{log.user_agent?.substring(0, 60) || "-"}</td>
                                <td className="py-2 px-2">
                                  {log.status === "success" ? (
                                    <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-emerald-500/10 text-emerald-600">成功</span>
                                  ) : (
                                    <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-red-500/10 text-red-600" title={log.fail_reason || ""}>失败</span>
                                  )}
                                </td>
                              </tr>
                            ))}
                            {loginLogs.length === 0 && (
                              <tr><td colSpan={4} className="text-center py-8 text-[var(--muted-foreground)] text-sm">暂无登录记录</td></tr>
                            )}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                </>
              )}
            </div>
          </div>
        )}

          </>
        )}

        {/* 操作密码确认对话框 */}
        {showActionConfirm && (
          <div className="fixed inset-0 bg-black/40 backdrop-blur-sm z-[200] flex items-center justify-center">
            <div className="bg-[var(--card)] rounded-2xl shadow-2xl border border-[var(--border)] p-6 w-[360px] max-w-[90vw]">
              <div className="flex items-center gap-2 mb-4">
                <div className="w-8 h-8 rounded-full bg-amber-500/15 flex items-center justify-center">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-amber-500"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
                </div>
                <h3 className="text-sm font-semibold text-[var(--foreground)]">操作确认</h3>
              </div>
              <p className="text-xs text-[var(--muted-foreground)] mb-4">{actionConfirmTitle}</p>
              {actionConfirmPurpose === "admin_user_delete" && (
                <p className="mb-3 rounded-lg bg-blue-500/10 px-3 py-2 text-xs text-blue-500">
                  本次验证仅保存在当前后台页面，10 分钟后或刷新页面后自动失效。
                </p>
              )}
              <div className="mb-4">
                <input
                  type="password"
                  value={actionPassword}
                  onChange={(e) => { setActionPassword(e.target.value); setActionPasswordError(""); }}
                  onKeyDown={(e) => { if (e.key === "Enter") executeConfirmedAction(); }}
                  disabled={actionConfirmBusy}
                  className="w-full px-3 py-2 rounded-lg border border-[var(--border)] bg-[var(--background)] text-sm focus:outline-none focus:ring-2 focus:ring-[var(--primary)]/30 focus:border-[var(--primary)]"
                  placeholder="请输入管理员登录密码或操作密码"
                  autoFocus
                />
                {actionPasswordError && <p className="text-[10px] text-red-500 mt-1">{actionPasswordError}</p>}
              </div>
              <div className="flex gap-2 justify-end">
                <button
                  disabled={actionConfirmBusy}
                  onClick={() => { setShowActionConfirm(false); setPendingAction(null); setActionConfirmPurpose("generic"); }}
                  className="px-4 py-1.5 rounded-lg text-xs border border-[var(--border)] text-[var(--muted-foreground)] hover:bg-[var(--background)] transition-colors disabled:opacity-40"
                >取消</button>
                <button
                  disabled={actionConfirmBusy}
                  onClick={executeConfirmedAction}
                  className="px-4 py-1.5 rounded-lg text-xs bg-[var(--primary)] text-white hover:bg-[var(--primary)]/90 transition-colors disabled:opacity-40"
                >{actionConfirmBusy ? "验证中..." : "确认"}</button>
              </div>
            </div>
          </div>
        )}

        {/* ── 聊天内容弹窗 ── */}
        {showChatDialog && (
          <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50" onClick={() => setShowChatDialog(false)}>
            <div className="bg-[var(--background)] rounded-xl shadow-2xl w-[800px] max-w-[92vw] max-h-[85vh] overflow-hidden flex flex-col" onClick={e => e.stopPropagation()}>
              {/* 头部 */}
              <div className="flex items-center justify-between px-5 py-3 border-b border-[var(--border)] shrink-0">
                <div className="flex items-center gap-2">
                  <button onClick={() => setShowChatDialog(false)} className="text-[var(--muted-foreground)] hover:text-[var(--foreground)]">
                    <ArrowLeft className="h-4 w-4" />
                  </button>
                  <MessageSquare className="h-4 w-4 text-[var(--primary)]" />
                  <span className="font-semibold text-sm text-[var(--foreground)]">{chatDialogTitle}</span>
                </div>
                <button onClick={() => setShowChatDialog(false)} className="text-[var(--muted-foreground)] hover:text-[var(--foreground)] text-xl leading-none">&times;</button>
              </div>
              {/* 聊天内容 */}
              <div className="flex-1 overflow-y-auto p-5 space-y-3">
                {chatLoading ? (
                  <div className="flex items-center justify-center py-12 text-[var(--muted-foreground)] gap-2">
                    <div className="w-4 h-4 border-2 border-[var(--primary)]/30 border-t-[var(--primary)] rounded-full animate-spin" />
                    <span className="text-sm">加载中...</span>
                  </div>
                ) : chatMessages.length === 0 ? (
                  <div className="text-center py-12 text-[var(--muted-foreground)] text-sm">暂无消息</div>
                ) : chatMessages.map((m: any, i: number) => (
                  <div key={i} className={`flex gap-2 ${m.role === "user" ? "flex-row-reverse" : "flex-row"}`}>
                    {/* 头像 */}
                    <div className={`w-7 h-7 rounded-full flex items-center justify-center shrink-0 text-[10px] font-bold ${
                      m.role === "user"
                        ? "bg-[var(--primary)] text-white"
                        : "bg-emerald-500/15 text-emerald-600"
                    }`}>
                      {m.role === "user" ? "U" : "AI"}
                    </div>
                    {/* 消息气泡 */}
                    <div className={`rounded-xl px-4 py-2.5 text-sm ${
                      m.role === "user"
                        ? "bg-[var(--primary)] text-white max-w-[85%] ml-auto"
                        : "bg-[var(--muted)]/30 text-[var(--foreground)] w-full"
                    }`}>
                      {m.role === "assistant" || m.role === "ai" ? (
                        <div className="markdown-body text-sm leading-relaxed" dangerouslySetInnerHTML={{ __html: renderMarkdown((() => { const r = parseThinkTags(m.content || ""); return r.displayContent; })()) }} />
                      ) : (
                        <div className="whitespace-pre-wrap break-words">{m.content}</div>
                      )}
                      <div className={`text-[10px] mt-1.5 ${m.role === "user" ? "text-white/50" : "text-[var(--muted-foreground)]"}`}>
                        {m.createdAt ? new Date(m.createdAt).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }) : ""}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
          </div>
        </main>
      </div>
    </div>
  );
}
