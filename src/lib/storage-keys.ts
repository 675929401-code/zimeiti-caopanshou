/**
 * 🔒 核心底层代码 — 锁定保护
 *
 * 本文件是统一存储键名常量。
 * 修改此文件需要用户明确同意，详见 AGENTS.md "🔒 锁定模块清单 #10 全局状态管理"。
 *
 * 锁定范围：整个文件
 * 锁定原因：键名是 localStorage 数据契约，修改会导致数据丢失
 */

/**
 * 集中管理的 localStorage Key 常量
 * 禁止在代码中直接使用字符串字面量，必须引用此模块中的常量
 */
export const STORAGE_KEYS = {
  // 认证
  AUTH_TOKEN: "auth_token",
  AUTH_USER: "auth_user",

  // 会话
  ACTIVE_CONVERSATION_ID: "active_conversation_id",

  // 页面视图
  ACTIVE_VIEW: "active_view",

  // UI 偏好
  APP_THEME: "app_theme",
  APP_MODE: "app_mode",
  PLATFORM_THEME: "platform_theme",
  PLATFORM_THEME_MODE: "platform_theme_mode",
  USER_THEME_PREFERENCE: "user_theme_preference",
  USER_THEME_MODE_PREFERENCE: "user_theme_mode_preference",
  SIDEBAR_WIDTH: "sidebar_width",
  SIDEBAR_COLLAPSED: "sidebar_collapsed",

  // 智能体
  PINNED_AGENT_IDS: "pinnedAgentIds",

  // 模型记忆
  LAST_USED_MODEL: "last_used_model",
  MODEL_OVERRIDE_PREFIX: "model_override_",

  // 布局（agent-marketplace 专用）
  AGENT_ORDER: "agent_order",
  CUSTOM_NAV_ITEMS: "custom_nav_items",
  CUSTOM_CATEGORIES: "custom_categories",
  NAV_OVERRIDES: "nav_overrides",
  CAT_OVERRIDES: "cat_overrides",
  AGENT_OVERRIDES: "agent_overrides",
  NAV_ORDER: "nav_order",
  CAT_ORDER: "cat_order",
  HIDDEN_NAV_KEYS: "hidden_nav_keys",
  NAV_DISPLAY_OVERRIDES: "nav_display_overrides",
  CAT_DISPLAY_OVERRIDES: "cat_display_overrides",
  AGENT_DISPLAY_OVERRIDES: "agent_display_overrides",

  // 对话本地缓存（write-through cache，防刷新/切换丢失）
  CONVERSATION_CACHE: "conv_cache",

  // 废弃（保留用于清理）
  DEPRECATED_USER_THEME_CHOICE: "user_theme_choice",
} as const;

export type StorageKey = (typeof STORAGE_KEYS)[keyof typeof STORAGE_KEYS];
