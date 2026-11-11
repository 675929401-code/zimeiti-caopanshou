"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import dynamic from "next/dynamic";
import { useApp } from "@/contexts/app-context";
import { bipStep, BIP_STEPS, BIP_CATEGORY, BIP_CATEGORY_LABEL, TASK_CATEGORIES, displayCategory, matchesDisplayCategory } from "@/lib/business-ip/catalog";
import { getAuthorizedAgentDisplayKeys, isAgentAuthorizedInSnapshot } from "@/lib/agent-category-access";
import { isUnboundCatalogAgent } from "@/lib/agent-catalog-lifecycle";
import { Search, Sparkles, X, Layout, Pencil, LayoutGrid, AppWindow, UsersRound, Eraser, Scissors, Palette, FileSearch, Film, PenTool, Mic, Bot, UserRound, Video, Image, Music, BookOpen, Globe, ShoppingBag, Megaphone, MessageSquare, Puzzle, Clapperboard, Wrench, Heart, ChevronLeft, ChevronRight } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "sonner";
import { Input } from "@/components/ui/input";
import { resolveAgentAvatarUrl, resolveAvatarUrl } from "@/lib/utils";
import { getSemanticAgentAvatarFallback } from "@/lib/agent-avatar-aliases";
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area";
import { STORAGE_KEYS } from "@/lib/storage-keys";
import {
  consumeMarketplaceShowAllRequest,
  getPrimaryNavigationLabel,
  isPrimaryNavigationKey,
  MARKETPLACE_SHOW_ALL_EVENT,
  PRIMARY_NAVIGATION,
  PRIMARY_NAVIGATION_ORDER,
  resolvePrimaryNavigationKey,
} from "@/lib/marketplace-navigation";
import { useAgentFavorites } from "@/hooks/use-agent-favorites";
import { useMemberPermissions } from "@/components/member-permission-boundary";
import { PresetDialog } from "@/components/preset-dialog";
import { BusinessIpIntake } from "@/components/chat/business-ip-intake";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogClose,
} from "@/components/ui/dialog";
import { DEFAULT_CARD_LAYOUT, type PresetField, type CardLayout, getTitleFontFamily } from "@/types/coze";
import { getClientBootstrapAgentCatalog } from "@/lib/client-bootstrap-cache";

// 卡片标题默认字体：无衬线栈（衬线宋体与卡片 UI 风格割裂，仅当布局编辑器显式选字体时才用所选）
const CARD_TITLE_FONT_FAMILY = "'Noto Sans SC', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
const MARKETPLACE_EAGER_AVATAR_COUNT = 8;
const FAVORITES_CATEGORY = "favorites";
const FAVORITE_HEART_CLEARANCE_PX = 40;
const GOOGLE_TITLE_FONT_QUERIES: Record<string, string> = {
  "noto-serif-sc": "family=Noto+Serif+SC:wght@400;600;700;900",
  "noto-sans-sc": "family=Noto+Sans+SC:wght@400;500;600;700",
  "lxgw-wenkai": "family=LXGW+WenKai+TC:wght@400;700",
  "ma-shan-zheng": "family=Ma+Shan+Zheng",
  "zcool-xiaowei": "family=ZCOOL+XiaoWei",
  "zcool-kuaile": "family=ZCOOL+KuaiLe",
  "zcool-qingke": "family=ZCOOL+QingKe+HuangYou",
  "long-cang": "family=Long+Cang",
  "zhi-mang-xing": "family=Zhi+Mang+Xing",
  "liu-jian-mao-cao": "family=Liu+Jian+Mao+Cao",
};
const LEARNER_AGENT_NAVIGATION_KEYS = [
  BIP_CATEGORY,
  "task:影像编导",
  "task:文案创作",
  "task:获客转化",
  "自用",
] as const;
const LEARNER_AGENT_NAVIGATION_KEY_SET = new Set<string>(LEARNER_AGENT_NAVIGATION_KEYS);

async function loadAdminAgentRevisions(token: string, agentIds: string[]): Promise<Map<string, number>> {
  const wanted = new Set(agentIds);
  const revisions = new Map<string, number>();
  for (const path of ["/api/admin/agents", "/api/admin/agents?include_internal=1"]) {
    if (revisions.size === wanted.size) break;
    const response = await fetch(path, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    });
    if (!response.ok) {
      if (path.includes("include_internal")) break;
      throw new Error(`AGENT_REVISION_READ_FAILED:${response.status}`);
    }
    const payload = await response.json() as { agents?: Array<{ id?: unknown; config_revision?: unknown }> };
    for (const agent of payload.agents || []) {
      const id = String(agent.id || "");
      const revision = Number(agent.config_revision);
      if (wanted.has(id) && Number.isSafeInteger(revision) && revision >= 1) revisions.set(id, revision);
    }
  }
  if (revisions.size !== wanted.size) throw new Error("AGENT_EXPECTED_REVISION_REQUIRED");
  return revisions;
}
type LearnerPermissionSnapshot = {
  identityKey: string;
  status: "idle" | "loading" | "ready" | "error";
  agentIds: Set<string>;
  navigationKeys: Set<string>;
};
const LEGACY_CATEGORY_LABELS: Record<string, string> = {
  all: "全部",
  "task:获客转化": "获客转化",
  "自用": "自用",
};
const CATEGORY_LUCIDE_ICONS = {
  all: { Icon: UsersRound, color: "#38bdf8" },
  [FAVORITES_CATEGORY]: { Icon: Heart, color: "#fb7185" },
  [BIP_CATEGORY]: { Icon: UserRound, color: "#a78bfa" },
  "task:影像编导": { Icon: Clapperboard, color: "#f59e0b" },
  "task:文案创作": { Icon: PenTool, color: "#fb7185" },
  "task:获客转化": { Icon: Megaphone, color: "#34d399" },
  "自用": { Icon: Wrench, color: "#94a3b8" },
};
const MARKETPLACE_HIGH_PRIORITY_AVATAR_COUNT = 4;
const MARKETPLACE_ANIMATED_CARD_COUNT = 8;
import { ToolboxMenu } from "@/components/toolbox-menu";

// 仅管理员进入布局编辑模式时才需要这组拖拽编辑依赖，
// 普通用户和管理员的日常应用广场首屏不再提前解析它们。
const LayoutEditor = dynamic(() => import("@/components/layout-editor"), {
  ssr: false,
  loading: () => (
    <div
      role="status"
      aria-live="polite"
      className="fixed inset-0 z-[120] flex items-center justify-center bg-black/45 backdrop-blur-sm"
    >
      <div className="rounded-xl border border-white/10 bg-[#0B1020] px-4 py-3 text-sm text-white/80 shadow-xl">
        正在加载布局编辑器…
      </div>
    </div>
  ),
});

const ICON_GROUPS = [
  { label: "常用工具", icons: ["🛠️", "🔧", "⚙️", "🔨", "⛏️", "🔩", "🧰", "🪛", "🖇️", "📌"] },
  { label: "商务办公", icons: ["📊", "📈", "📉", "📋", "📝", "🗂️", "📁", "📂", "📑", "💼"] },
  { label: "创意设计", icons: ["🎨", "🖌️", "✏️", "🖊️", "🖌", "🎭", "🎪", "🖼️", "📸", "🎬"] },
  { label: "科技互联网", icons: ["🌐", "💻", "🖥️", "📱", "⌨️", "🖲️", "🔌", "💡", "⚡", "🔋"] },
  { label: "社交内容", icons: ["🎤", "🎙️", "📹", "📺", "📻", "📣", "📢", "💬", "💌", "📧"] },
  { label: "目标策略", icons: ["🎯", "🏆", "🥇", "🎖️", "🏅", "🏁", "🚀", "✨", "💎", "🔥"] },
  { label: "搜索分析", icons: ["🔍", "🔎", "🧐", "🕵️", "📊", "🧩", "🗺️", "🧭", "📡", "👁️"] },
  { label: "自然生活", icons: ["🌟", "🌈", "☀️", "🌙", "🌺", "🍀", "🌊", "🎵", "🎶", "❤️"] },
  { label: "标签标记", icons: ["🏷️", "🔖", "📌", "📎", "✅", "❌", "⚠️", "🆕", "🔴", "🟢"] },
  { label: "赛博朋克", icons: ["🤖", "👾", "🎮", "🕹️", "🔮", "🧿", "🌀", "💠", "🧬", "🫧"] },
  { label: "赛博科技", icons: ["🌃", "🌌", "🛸", "☄️", "🪐", "🏗️", "⚙️", "🔓", "🔏", "🛡️"] },
  { label: "自媒体运营", icons: ["📱", "💬", "📢", "📣", "🎥", "🎬", "🎤", "📻", "🗞️", "📰"] },
  { label: "电商带货", icons: ["🛒", "🛍️", "💰", "💳", "🏷️", "🎁", "📦", "🚚", "🏪", "🏬"] },
  { label: "文案创作", icons: ["✍️", "📝", "📖", "📕", "📗", "📘", "📙", "📚", "📜", "📃"] },
  { label: "营销推广", icons: ["🎯", "🎪", "🎟️", "🎨", "🖼️", "📊", "📈", "💼", "🤝", "🌐"] },
  { label: "短视频制作", icons: ["🎬", "🎥", "📹", "📽️", "🎞️", "🎭", "🎬", "📱", "🖥️", "🎵"] },
];
const ALL_ICONS = ICON_GROUPS.flatMap(g => g.icons);

function repairMojibake(value: string) {
  if (!value || !/[ÃÂÄÅÆÇÈÉÒÓÔÕÖØÙÚÛÜÝÞßà-ÿ]|[æåçèéä]|[\u0080-\u009f]/.test(value)) return value;
  try {
    const bytes = new Uint8Array(Array.from(value, (char) => char.charCodeAt(0) & 0xff));
    const repaired = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    return repaired.includes("�") ? value : repaired;
  } catch {
    return value;
  }
}

function isRetiredAidNavLabel(value: string) {
  const label = repairMojibake(value).toLowerCase();
  return (
    label.includes("aid") ||
    label.includes("ai漫剧") ||
    label.includes("ai剧作工坊") ||
    label.includes("漫剧工作台") ||
    label.includes("漫剧平台")
  );
}

function isLegacyFilmStudioNavLabel(value: string) {
  const label = repairMojibake(value);
  return label === "影视工坊" || label === "短剧工坊";
}

function isRetiredDigitalHumanNavLabel(value: string) {
  const label = repairMojibake(value).replace(/\s+/gu, "").toLowerCase();
  return label === "ai数字人" || label === "usersai数字人" || label === "aa数字人" || label === "数字人";
}

function isRetiredTopicsNavLabel(value: string) {
  const label = repairMojibake(value).replace(/\s+/gu, "");
  return ["行业选题", "选题工作台", "发布中心"].includes(label);
}

function isReplacedLegacyNavLabel(value: string) {
  const label = repairMojibake(value);
  if (isRetiredAidNavLabel(label) || isLegacyFilmStudioNavLabel(label) || isRetiredDigitalHumanNavLabel(label) || isRetiredTopicsNavLabel(label)) return true;
  return [
    "3D动画工作流",
    "3D动画",
    "分段工具",
    "智能分段",
    "文案提取",
    "视频提取",
    "网页提取",
    "视频文案提取",
    "文字排版",
    "格式整理",
    "工具箱",
  ].includes(label);
}

interface DisplayOverride {
  label?: string;
  name?: string;
  icon?: string;
  desc?: string;
  description?: string;
  iconUrl?: string;
}
type DisplayOverrides = Record<string, DisplayOverride>;

interface CategoryItem {
  id: string;
  name: string;
  icon: string;
  sort_order: number;
}

export function AgentMarketplace() {
  const router = useRouter();
  const pathname = usePathname();
  const { state, dispatch, startChat, sendMessage, saveLayoutConfig, resetLayoutConfig, setPendingPresetMessage, selectConversation } = useApp();
  const { agents, view, layoutConfig, editMode, auth, isLoadingAgents } = state;
  const isAdmin = auth.user?.role === "admin";
  const memberPermission = useMemberPermissions();
  const grantedFeatureKeys = useMemo(
    () => new Set(memberPermission.snapshot?.featureNavigationKeys || []),
    [memberPermission.snapshot?.featureNavigationKeys],
  );
  const {
    favorites: favoriteAgentIds,
    loaded: favoritesLoaded,
    status: favoritesStatus,
    error: favoritesError,
    pendingAgentIds: favoritePendingAgentIds,
    toggleFavorite: toggleAgentFavorite,
    refresh: refreshAgentFavorites,
  } = useAgentFavorites(auth.user?.id || "", auth.token);
  const [activeCategory, setActiveCategory] = useState("all");
  const [bipIntakeAgentId, setBipIntakeAgentId] = useState<string | null>(null);
  const [viewFilter, setViewFilter] = useState<"all" | "view_only">("all");
  const [searchQuery, setSearchQuery] = useState("");
  const learnerPermissionIdentityKey = state.auth.isAuthenticated
    ? `user:${auth.user?.id || "pending"}:${auth.user?.role || "unknown"}:${auth.token || "missing-token"}`
    : "guest";
  // Product entitlements are account-scoped for every authenticated identity.
  // Administrator role still enables management controls, but does not bypass
  // the saved business-feature or Agent-category grants.
  const isPermissionControlledIdentity = state.auth.isAuthenticated;
  const [learnerPermissionSnapshot, setLearnerPermissionSnapshot] = useState<LearnerPermissionSnapshot>({
    identityKey: "guest",
    status: "idle",
    agentIds: new Set(),
    navigationKeys: new Set(),
  });

  // Keep a permission snapshot bound to the exact user and token. This second,
  // fail-closed read prevents an older guest/catalog response from becoming
  // visible while the shared Agent store is being replaced after login.
  useEffect(() => {
    if (!isPermissionControlledIdentity) {
      setLearnerPermissionSnapshot({
        identityKey: learnerPermissionIdentityKey,
        status: "idle",
        agentIds: new Set(),
        navigationKeys: new Set(),
      });
      return;
    }
    if (!auth.token) {
      setLearnerPermissionSnapshot({
        identityKey: learnerPermissionIdentityKey,
        status: "error",
        agentIds: new Set(),
        navigationKeys: new Set(),
      });
      return;
    }

    const controller = new AbortController();
    const identityKey = learnerPermissionIdentityKey;
    setLearnerPermissionSnapshot({
      identityKey,
      status: "loading",
      agentIds: new Set(),
      navigationKeys: new Set(),
    });

    void (async () => {
      try {
        const response = await getClientBootstrapAgentCatalog(auth.token);
        if (controller.signal.aborted) return;
        if (!response.ok) throw new Error(`HTTP_${response.status}`);
        const payload = await response.json() as {
          agents?: Array<{ id?: unknown }>;
          navigationKeys?: unknown;
          navigation_keys?: unknown;
        };
        if (controller.signal.aborted) return;

        const returnedAgents = Array.isArray(payload.agents) ? payload.agents : [];
        const agentIds = new Set(
          returnedAgents
            .map((agent) => String(agent.id || "").trim())
            .filter(Boolean),
        );
        const rawNavigationKeys = Array.isArray(payload.navigationKeys)
          ? payload.navigationKeys
          : Array.isArray(payload.navigation_keys)
            ? payload.navigation_keys
            : null;
        // Authenticated learners require the authorization-aware response
        // contract. A guest-shaped response (for example after token expiry)
        // must fail closed instead of deriving broad access from public cards.
        if (!rawNavigationKeys) throw new Error("MISSING_NAVIGATION_KEYS");
        const navigationKeys = new Set<string>(
          rawNavigationKeys
            .map((key) => String(key || "").trim())
            .filter((key) => LEARNER_AGENT_NAVIGATION_KEY_SET.has(key)),
        );

        setLearnerPermissionSnapshot({ identityKey, status: "ready", agentIds, navigationKeys });
      } catch (error) {
        if (controller.signal.aborted) return;
        console.error("[agent-marketplace] learner permissions unavailable:", error instanceof Error ? error.message : "unknown");
        setLearnerPermissionSnapshot({
          identityKey,
          status: "error",
          agentIds: new Set(),
          navigationKeys: new Set(),
        });
      }
    })();

    return () => controller.abort();
  }, [auth.token, isPermissionControlledIdentity, learnerPermissionIdentityKey]);

  useEffect(() => {
    if (favoritesError) toast.error(favoritesError);
  }, [favoritesError]);

  // 左侧快捷入口点击“应用广场”时，统一回到全部智能体视图。
  useEffect(() => {
    const applyShowAll = () => {
      setActiveCategory("all");
      setViewFilter("all");
      setSearchQuery("");
    };
    const handleShowAll = () => {
      applyShowAll();
      consumeMarketplaceShowAllRequest();
    };
    window.addEventListener(MARKETPLACE_SHOW_ALL_EVENT, handleShowAll);
    if (consumeMarketplaceShowAllRequest()) applyShowAll();
    return () => window.removeEventListener(MARKETPLACE_SHOW_ALL_EVENT, handleShowAll);
  }, []);
  const [dbCategories, setDbCategories] = useState<{ id?: string; name: string; icon?: string; description?: string; sort_order?: number; is_active?: boolean; visibility?: string; user_can_use?: boolean }[]>([]);
  const [dbNavItems, setDbNavItems] = useState<{ id: string; name: string; icon: string; description: string; status: string; sort_order: number }[]>([]);
  const [presetAgent, setPresetAgent] = useState<{ id: string; name: string; iconUrl: string; presetFields: PresetField[] } | null>(null);

  // 自定义导航项
  interface NavItem { key: string; label: string; icon: string; desc: string; group?: string; iconType?: 'emoji' | 'lucide' | 'image'; iconImage?: string; navStatus?: 'active' | 'developing' | 'hidden'; }
  interface CategoryItem { key: string; label: string; icon: string; }
  const [customNavItems, setCustomNavItems] = useState<NavItem[]>([]);
  const [showAddNav, setShowAddNav] = useState(false);
  const [newNavItem, setNewNavItem] = useState({ label: "", icon: "🛠️", desc: "" });
  const [customCategories, setCustomCategories] = useState<CategoryItem[]>([]);
  const [showAddCategory, setShowAddCategory] = useState(false);
  const [newCategory, setNewCategory] = useState({ label: "", icon: "📁" });

  // 拖拽排序
  const [navOrder, setNavOrder] = useState<string[]>([]);
  const [catOrder, setCatOrder] = useState<string[]>([]);
  const [hiddenNavKeys, setHiddenNavKeys] = useState<string[]>([]);
  const [dragNavKey, setDragNavKey] = useState<string | null>(null);
  const [dragCatKey, setDragCatKey] = useState<string | null>(null);
  const [dragAgentKey, setDragAgentKey] = useState<string | null>(null);
  const [dragOverNavKey, setDragOverNavKey] = useState<string | null>(null);
  const [dragOverCatKey, setDragOverCatKey] = useState<string | null>(null);
  const [dragOverAgentKey, setDragOverAgentKey] = useState<string | null>(null);
  // 拖拽卡片到分类的状态
  const [dragAgentToCatOver, setDragAgentToCatOver] = useState<string | null>(null);
  // 移动分类成功的提示
  const [moveSuccessMsg, setMoveSuccessMsg] = useState<string | null>(null);
  const [agentOrder, setAgentOrder] = useState<string[]>(() => {
    if (typeof window !== "undefined") {
      try { const v = localStorage.getItem(STORAGE_KEYS.AGENT_ORDER); return v ? JSON.parse(v) : []; } catch { return []; }
    }
    return [];
  });

  // 编辑覆盖：存储修改后的名称/描述/图标
  const [navOverrides, setNavOverrides] = useState<Record<string, Partial<NavItem>>>({});
  const [catOverrides, setCatOverrides] = useState<Record<string, Partial<CategoryItem>>>({});
  const [agentOverrides, setAgentOverrides] = useState<Record<string, { name?: string; description?: string; iconUrl?: string }>>({});

  // 内联编辑状态
  const [inlineEdit, setInlineEdit] = useState<{ key: string; field: string; value: string } | null>(null);
  const [inlineValue, setInlineValue] = useState("");
  // 头像编辑弹出
  const [avatarEdit, setAvatarEdit] = useState<{ agentId: string; name: string; description: string; iconUrl: string } | null>(null);
  // 图标选择弹出
  const [iconPicker, setIconPicker] = useState<{ target: "nav" | "cat"; key: string; current: string } | null>(null);

  // 滑动指示器（智音工坊风格）
  const navContainerRef = useRef<HTMLDivElement>(null);
  const [navIndicator, setNavIndicator] = useState({ left: 0, width: 0, visible: false });
  const [navOverflow, setNavOverflow] = useState({ available: false, canScrollLeft: false, canScrollRight: false });
  const [pendingNavKey, setPendingNavKey] = useState<string | null>(null);
  const pendingNavKeyRef = useRef<string | null>(null);
  const pendingNavStartTimerRef = useRef<number | null>(null);
  const pendingNavTimeoutRef = useRef<number | null>(null);
  const clearPendingNavigation = useCallback(() => {
    if (pendingNavStartTimerRef.current !== null) window.clearTimeout(pendingNavStartTimerRef.current);
    if (pendingNavTimeoutRef.current !== null) window.clearTimeout(pendingNavTimeoutRef.current);
    pendingNavStartTimerRef.current = null;
    pendingNavTimeoutRef.current = null;
    pendingNavKeyRef.current = null;
    setPendingNavKey(null);
  }, []);

  const navigateRoute = useCallback((key: string, href: string) => {
    if (pendingNavKeyRef.current) return;
    if (pendingNavStartTimerRef.current !== null) window.clearTimeout(pendingNavStartTimerRef.current);
    if (pendingNavTimeoutRef.current !== null) window.clearTimeout(pendingNavTimeoutRef.current);
    pendingNavKeyRef.current = key;
    setPendingNavKey(key);

    pendingNavStartTimerRef.current = window.setTimeout(() => {
      pendingNavStartTimerRef.current = null;
      try {
        router.push(href);
      } catch {
        clearPendingNavigation();
      }
    }, 0);
    pendingNavTimeoutRef.current = window.setTimeout(clearPendingNavigation, 8_000);
  }, [clearPendingNavigation, router]);

  useEffect(() => {
    clearPendingNavigation();
    return clearPendingNavigation;
  }, [clearPendingNavigation, pathname]);

  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEYS.CUSTOM_NAV_ITEMS);
      if (saved) setCustomNavItems(JSON.parse(saved));
    } catch {}
    try {
      const saved = localStorage.getItem(STORAGE_KEYS.CUSTOM_CATEGORIES);
      if (saved) setCustomCategories(JSON.parse(saved));
    } catch {}
    try {
      const saved = localStorage.getItem(STORAGE_KEYS.NAV_DISPLAY_OVERRIDES);
      if (saved) {
        const parsed = JSON.parse(saved);
        // Migrate old flat format (string values) to new nested format (object values)
        const migrated: Record<string, Record<string, string>> = {};
        for (const [k, v] of Object.entries(parsed)) {
          migrated[k] = typeof v === "string" ? { label: v } : v as Record<string, string>;
        }
        setNavOverrides(migrated);
        localStorage.setItem(STORAGE_KEYS.NAV_DISPLAY_OVERRIDES, JSON.stringify(migrated));
      }
    } catch {}
    try {
      const saved = localStorage.getItem(STORAGE_KEYS.CAT_DISPLAY_OVERRIDES);
      if (saved) {
        const parsed = JSON.parse(saved);
        // Migrate old flat format (string values) to new nested format (object values)
        const migrated: Record<string, Record<string, string>> = {};
        for (const [k, v] of Object.entries(parsed)) {
          migrated[k] = typeof v === "string" ? { label: v } : v as Record<string, string>;
        }
        setCatOverrides(migrated);
        localStorage.setItem(STORAGE_KEYS.CAT_DISPLAY_OVERRIDES, JSON.stringify(migrated));
      }
    } catch {}
    try {
      const saved = localStorage.getItem(STORAGE_KEYS.AGENT_DISPLAY_OVERRIDES)
        || localStorage.getItem(STORAGE_KEYS.AGENT_OVERRIDES);
      if (saved) {
        const parsed = JSON.parse(saved);
        setAgentOverrides(parsed);
        localStorage.setItem(STORAGE_KEYS.AGENT_DISPLAY_OVERRIDES, JSON.stringify(parsed));
      }
    } catch {}
    try {
      const saved = localStorage.getItem(STORAGE_KEYS.NAV_ORDER);
      if (saved) setNavOrder(JSON.parse(saved));
    } catch {}
    try {
      const saved = localStorage.getItem(STORAGE_KEYS.CAT_ORDER);
      if (saved) setCatOrder(JSON.parse(saved));
    } catch {}
    try {
      const saved = localStorage.getItem(STORAGE_KEYS.HIDDEN_NAV_KEYS);
      if (saved) setHiddenNavKeys(JSON.parse(saved));
    } catch {}
  }, []);

  // 统一保存UI偏好：localStorage + 服务器
  const uiPrefsTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const saveUIPrefs = useCallback((updates: Record<string, unknown>) => {
    // 先保存到localStorage
    if (Object.keys(updates).length > 0) {
      Object.entries(updates).forEach(([key, value]) => {
        localStorage.setItem(key, JSON.stringify(value));
      });
    }
    // 防抖保存到服务器
    if (uiPrefsTimerRef.current) clearTimeout(uiPrefsTimerRef.current);
    uiPrefsTimerRef.current = setTimeout(() => {
      const prefs: Record<string, unknown> = {};
      try { prefs.nav_order = JSON.parse(localStorage.getItem(STORAGE_KEYS.NAV_ORDER) || "[]"); } catch {}
      try { prefs.cat_order = JSON.parse(localStorage.getItem(STORAGE_KEYS.CAT_ORDER) || "[]"); } catch {}
      try { prefs.agent_order = JSON.parse(localStorage.getItem(STORAGE_KEYS.AGENT_ORDER) || "[]"); } catch {}
      try { prefs.nav_overrides = JSON.parse(localStorage.getItem(STORAGE_KEYS.NAV_DISPLAY_OVERRIDES) || "{}"); } catch {}
      try { prefs.cat_overrides = JSON.parse(localStorage.getItem(STORAGE_KEYS.CAT_DISPLAY_OVERRIDES) || "{}"); } catch {}
      try { prefs.agent_overrides = JSON.parse(localStorage.getItem(STORAGE_KEYS.AGENT_DISPLAY_OVERRIDES) || "{}"); } catch {}
      try { prefs.custom_nav_items = JSON.parse(localStorage.getItem(STORAGE_KEYS.CUSTOM_NAV_ITEMS) || "[]"); } catch {}
      try { prefs.custom_categories = JSON.parse(localStorage.getItem(STORAGE_KEYS.CUSTOM_CATEGORIES) || "[]"); } catch {}
      try { prefs.hidden_nav_keys = JSON.parse(localStorage.getItem(STORAGE_KEYS.HIDDEN_NAV_KEYS) || "[]"); } catch {}

      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (auth.token) headers["Authorization"] = `Bearer ${auth.token}`;
      fetch("/api/settings/ui-preferences", {
        method: "PUT",
        headers,
        body: JSON.stringify({ preferences: prefs, token: auth.token }),
      }).then((r) => {
        if (!r.ok) console.warn("[agent-marketplace] savePreferences failed:", r.status);
      }).catch((e: unknown) => { console.error("[agent-marketplace] savePreferences error:", e instanceof Error ? e.message : e); });
    }, 1000);
  }, [auth.token]);

  // 从服务器加载UI偏好（统一入口，服务器数据优先于localStorage）
  useEffect(() => {
    const controller = new AbortController();
    // Forced session eviction returns to the public home with a full-page
    // navigation. React does not get a reliable unmount cleanup in that path,
    // so cancel this optional preference read before the browser tears it down
    // and reports a benign `Failed to fetch` as a product error.
    const abortForPageExit = () => controller.abort();
    window.addEventListener("beforeunload", abortForPageExit);
    window.addEventListener("pagehide", abortForPageExit);
    fetch("/api/settings/ui-preferences", { signal: controller.signal })
      .then((r) => r.json())
      .then((d) => {
        if (controller.signal.aborted) return;
        if (d.preferences) {
          const p = d.preferences as Record<string, unknown>;
          // 服务器数据始终覆盖localStorage + React状态（确保多设备/多浏览器同步）
          // 修复：空数组/空对象也要覆盖（清除旧的localStorage残留）
          const applyIfDefined = (
            serverVal: unknown,
            setter: (v: never) => void,
            storageKey: string,
            isEmptyValid: boolean = false,
          ) => {
            if (serverVal === undefined || serverVal === null) return;
            if (Array.isArray(serverVal) && serverVal.length === 0 && !isEmptyValid) return;
            if (typeof serverVal === "object" && !Array.isArray(serverVal) && Object.keys(serverVal as object).length === 0 && !isEmptyValid) return;
            setter(serverVal as never);
            localStorage.setItem(storageKey, JSON.stringify(serverVal));
          };
          // 空数组/空对象表示管理员主动清空了配置，必须覆盖本地残留
          const applyAlways = (
            serverVal: unknown,
            setter: (v: never) => void,
            storageKey: string,
          ) => {
            if (serverVal === undefined || serverVal === null) return;
            setter(serverVal as never);
            localStorage.setItem(storageKey, JSON.stringify(serverVal));
          };
          applyAlways(p.nav_order, setNavOrder, STORAGE_KEYS.NAV_ORDER);
          applyAlways(p.cat_order, setCatOrder, STORAGE_KEYS.CAT_ORDER);
          applyAlways(p.agent_order, setAgentOrder, STORAGE_KEYS.AGENT_ORDER);
          // Migrate flat string overrides to nested object format before applying
          const migrateOverrides = (val: unknown): unknown => {
            if (!val || typeof val !== "object" || Array.isArray(val)) return val;
            const migrated: Record<string, Record<string, string>> = {};
            for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
              migrated[k] = typeof v === "string" ? { label: v } : v as Record<string, string>;
            }
            return migrated;
          };
          applyIfDefined(migrateOverrides(p.nav_overrides), setNavOverrides, STORAGE_KEYS.NAV_DISPLAY_OVERRIDES);
          applyIfDefined(migrateOverrides(p.cat_overrides), setCatOverrides, STORAGE_KEYS.CAT_DISPLAY_OVERRIDES);
          applyAlways(p.agent_overrides, setAgentOverrides, STORAGE_KEYS.AGENT_DISPLAY_OVERRIDES);
          applyIfDefined(p.custom_nav_items, setCustomNavItems, STORAGE_KEYS.CUSTOM_NAV_ITEMS);
          applyIfDefined(p.custom_categories, setCustomCategories, STORAGE_KEYS.CUSTOM_CATEGORIES);
          applyAlways(p.hidden_nav_keys, setHiddenNavKeys, STORAGE_KEYS.HIDDEN_NAV_KEYS);

          // 回写机制：如果服务器数据全空但本地有管理员修改，自动回写到服务器
          // 解决之前因token BUG导致保存失败的历史遗留问题
          const serverHasData = (p.nav_overrides && Object.keys(p.nav_overrides as object).length > 0) ||
            (p.cat_overrides && Object.keys(p.cat_overrides as object).length > 0) ||
            (p.custom_nav_items && (p.custom_nav_items as unknown[]).length > 0) ||
            (p.custom_categories && (p.custom_categories as unknown[]).length > 0) ||
            (p.nav_order && (p.nav_order as unknown[]).length > 0) ||
            (p.cat_order && (p.cat_order as unknown[]).length > 0);
          if (!serverHasData && isAdmin) {
            // 检查本地是否有值得回写的自定义数据
            const localNavOverrides = localStorage.getItem(STORAGE_KEYS.NAV_DISPLAY_OVERRIDES);
            const localCatOverrides = localStorage.getItem(STORAGE_KEYS.CAT_DISPLAY_OVERRIDES);
            const localCustomNav = localStorage.getItem(STORAGE_KEYS.CUSTOM_NAV_ITEMS);
            const localCustomCat = localStorage.getItem(STORAGE_KEYS.CUSTOM_CATEGORIES);
            const localNavOrder = localStorage.getItem(STORAGE_KEYS.NAV_ORDER);
            const localCatOrder = localStorage.getItem(STORAGE_KEYS.CAT_ORDER);
            const hasLocalData = [localNavOverrides, localCatOverrides, localCustomNav, localCustomCat, localNavOrder, localCatOrder]
              .some(v => { if (!v) return false; try { const p = JSON.parse(v); return Array.isArray(p) ? p.length > 0 : Object.keys(p).length > 0; } catch { return false; } });
            if (hasLocalData) {
              console.log("[agent-marketplace] 检测到本地有未同步的UI配置，自动回写到服务器");
              const backfillPrefs: Record<string, unknown> = {};
              try { const v = JSON.parse(localNavOverrides || "{}"); if (Object.keys(v).length > 0) backfillPrefs.nav_overrides = v; } catch {}
              try { const v = JSON.parse(localCatOverrides || "{}"); if (Object.keys(v).length > 0) backfillPrefs.cat_overrides = v; } catch {}
              try { const v = JSON.parse(localCustomNav || "[]"); if (v.length > 0) backfillPrefs.custom_nav_items = v; } catch {}
              try { const v = JSON.parse(localCustomCat || "[]"); if (v.length > 0) backfillPrefs.custom_categories = v; } catch {}
              try { const v = JSON.parse(localNavOrder || "[]"); if (v.length > 0) backfillPrefs.nav_order = v; } catch {}
              try { const v = JSON.parse(localCatOrder || "[]"); if (v.length > 0) backfillPrefs.cat_order = v; } catch {}
              if (Object.keys(backfillPrefs).length > 0) {
                saveUIPrefs(backfillPrefs);
              }
            }
          }
        }
      })
      .catch((e: unknown) => {
        if (controller.signal.aborted || (e instanceof DOMException && e.name === "AbortError")) return;
        console.error("[agent-marketplace] loadUIPrefs failed:", e instanceof Error ? e.message : e);
      });
    return () => {
      window.removeEventListener("beforeunload", abortForPageExit);
      window.removeEventListener("pagehide", abortForPageExit);
      controller.abort();
    };
  }, [isAdmin, saveUIPrefs]);

  useEffect(() => {
    const controller = new AbortController();
    const headers: Record<string, string> = {};
    const token = state.auth.token;
    setDbCategories([]);
    if (token) headers["Authorization"] = `Bearer ${token}`;
    // Auth is restored from localStorage immediately after hydration. Defer the
    // account-scoped catalog briefly so the anonymous request is cancelled when
    // the stored account becomes available, and a stale response cannot replace
    // the current account's category permissions.
    const timer = window.setTimeout(() => {
      fetch("/api/categories", { headers, signal: controller.signal })
        .then((r) => r.json())
        .then((d) => {
          if (!controller.signal.aborted && d.categories) setDbCategories(d.categories);
        })
        .catch((e: unknown) => {
          if (controller.signal.aborted || (e instanceof DOMException && e.name === "AbortError")) return;
          console.error("[agent-marketplace] fetchCategories failed:", e instanceof Error ? e.message : e);
        });
    }, 80);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [state.auth.token]);

  // 加载数据库导航项
  useEffect(() => {
    fetch("/api/nav-items")
      .then((r) => r.json())
      .then((d) => {
        if (d.navItems) setDbNavItems(d.navItems);
      })
      .catch((e: unknown) => { console.error("[agent-marketplace] fetchNavItems failed:", e instanceof Error ? e.message : e); });
  }, []);

  // === 内联编辑处理 ===
  const startInlineEdit = (key: string, field: string, currentValue: string) => {
    setInlineEdit({ key, field, value: currentValue });
    setInlineValue(currentValue);
  };
  const commitInlineEdit = () => {
    if (!inlineEdit) return;
    const { key, field } = inlineEdit;
    if (field === "nav_label" || field === "nav_desc" || field === "nav_icon") {
      const updated = { ...navOverrides, [key]: { ...navOverrides[key], [field.replace("nav_", "")]: inlineValue } };
      setNavOverrides(updated);
      localStorage.setItem(STORAGE_KEYS.NAV_DISPLAY_OVERRIDES, JSON.stringify(updated));
    } else if (field === "cat_label" || field === "cat_icon") {
      const updated = { ...catOverrides, [key]: { ...catOverrides[key], [field.replace("cat_", "")]: inlineValue } };
      setCatOverrides(updated);
      localStorage.setItem(STORAGE_KEYS.CAT_DISPLAY_OVERRIDES, JSON.stringify(updated));
    } else if (field === "agent_name" || field === "agent_desc") {
      const updated = { ...agentOverrides, [key]: { ...agentOverrides[key], [field.replace("agent_", "")]: inlineValue } };
      setAgentOverrides(updated);
      localStorage.setItem(STORAGE_KEYS.AGENT_DISPLAY_OVERRIDES, JSON.stringify(updated));
    }
    setInlineEdit(null);
    setInlineValue("");
    saveUIPrefs({});
  };

  // 内置导航定义（组件级，供渲染和恢复弹窗共用）
  // 一级导航文字保持中性，图标用克制的语义色建立快速识别。
  const NAV_LUCIDE_ICONS: Record<string, { Icon: React.ComponentType<React.SVGProps<SVGSVGElement> & { className?: string; style?: React.CSSProperties }>; color: string }> = {
    commerce_agent: { Icon: ShoppingBag, color: "#d78a62" },
    marketplace: { Icon: AppWindow, color: "#55bfae" },
    segment: { Icon: Scissors, color: "#69ad87" },
    cover: { Icon: Palette, color: "#c69a61" },
    extract: { Icon: FileSearch, color: "#d0a45e" },
    create: { Icon: Film, color: "#64a8bc" },
    storyboard_workbench: { Icon: Clapperboard, color: "#d2a35c" },
    toolbox: { Icon: Wrench, color: "#75a9dc" },
    youcai: { Icon: Sparkles, color: "#a988d4" },
    copywriting: { Icon: PenTool, color: "#c98391" },
    voice: { Icon: Mic, color: "#c982a4" },
  };

  // Lucide 组件名 → 组件映射（用于数据库导航项的图标渲染）
  const LUCIDE_ICON_MAP: Record<string, { Icon: React.ComponentType<React.SVGProps<SVGSVGElement> & { className?: string; style?: React.CSSProperties }>; color: string }> = {
    LayoutGrid: { Icon: LayoutGrid, color: "#3b82f6" },
    Eraser: { Icon: Eraser, color: "#10b981" },
    Scissors: { Icon: Scissors, color: "#f43f5e" },
    Palette: { Icon: Palette, color: "#8b5cf6" },
    FileSearch: { Icon: FileSearch, color: "#f59e0b" },
    Film: { Icon: Film, color: "#06b6d4" },
    PenTool: { Icon: PenTool, color: "#f97316" },
    Mic: { Icon: Mic, color: "#ec4899" },
    Bot: { Icon: Bot, color: "#6366f1" },
    UserRound: { Icon: UserRound, color: "#14b8a6" },
    Video: { Icon: Video, color: "#ef4444" },
    Image: { Icon: Image, color: "#a855f7" },
    Music: { Icon: Music, color: "#eab308" },
    BookOpen: { Icon: BookOpen, color: "#0ea5e9" },
    Sparkles: { Icon: Sparkles, color: "#f59e0b" },
    Globe: { Icon: Globe, color: "#22c55e" },
    ShoppingBag: { Icon: ShoppingBag, color: "#f97316" },
    Megaphone: { Icon: Megaphone, color: "#ef4444" },
    MessageSquare: { Icon: MessageSquare, color: "#3b82f6" },
    Puzzle: { Icon: Puzzle, color: "#8b5cf6" },
    Clapperboard: { Icon: Clapperboard, color: "#f59e0b" },
    Wrench: { Icon: Wrench, color: "#22c55e" },
  };

  const builtInNavDefs = useMemo(() => {
    // 如果数据库有导航项，优先使用数据库数据
    if (dbNavItems.length > 0) {
      const legacyYoucaiNavLabels = new Set(["\u6709\u5f69\u521b\u4f5c", "\u6709\u5f69\u89c6\u754c"]);
      const dbDefs = dbNavItems.filter(item => !["格式", "格式去除"].includes(repairMojibake(item.name)) && !isRetiredAidNavLabel(item.name) && !isLegacyFilmStudioNavLabel(item.name) && !isRetiredDigitalHumanNavLabel(item.name) && !isRetiredTopicsNavLabel(item.name)).map(item => {
        const repairedName = repairMojibake(item.name);
        const normalizedName = legacyYoucaiNavLabels.has(repairedName)
          ? "漫剧工作台"
          : repairedName;
        // 根据名称匹配内置 key（向后兼容）
        const nameKeyMap: Record<string, string> = {
          "带货 Agent": "commerce_agent", "带货Agent": "commerce_agent",
          "应用广场": "marketplace", "工具箱": "toolbox", "效率工具": "toolbox", "分镜工作台": "storyboard_workbench", "分镜编排": "storyboard_workbench", "分段工具": "segment", "智能分段": "segment",
          "文案提取": "extract", "视频提取": "extract", "网页提取": "extract", "视频文案提取": "extract", "文字排版": "formatter", "格式整理": "formatter", "封面制作": "cover", "封面设计": "cover", "视频制作": "create", "视频工坊": "create", "视频创作": "create", "漫剧工作台": "youcai", "漫剧创作": "youcai", "文案操盘": "copywriting", "语音克隆": "voice", "智音工坊": "voice", "声音制作": "voice", "带货创作": "commerce_agent",
        };
        const key = resolvePrimaryNavigationKey(normalizedName) || resolvePrimaryNavigationKey(repairedName) || nameKeyMap[normalizedName] || nameKeyMap[repairedName] || `nav_${item.id.slice(0, 8)}`;
        return {
          key,
          label: normalizedName,
          icon: item.icon || "🛠️",
          iconType: (item as { icon_type?: string }).icon_type || "emoji",
          iconImage: (item as { icon_image?: string }).icon_image || "",
          desc: key === "youcai"
                ? "进入漫剧工作台"
                : repairMojibake(item.description || "") || `${normalizedName}模块`,
          group: "",
          navStatus: item.status, // 传递状态给占位页逻辑
          navId: item.id,
        };
      });
      const standardizedDefs = dbDefs.map((item) => isPrimaryNavigationKey(item.key)
        ? { ...item, label: getPrimaryNavigationLabel(item.key, item.label), group: "" }
        : item);
      for (const item of PRIMARY_NAVIGATION) {
        if (!standardizedDefs.some((definition) => definition.key === item.key)) {
          standardizedDefs.push({ key: item.key, label: item.label, icon: item.icon, iconType: "lucide" as const, iconImage: "", desc: item.description, group: "", navStatus: "active", navId: `builtin_${item.key}` });
        }
      }
      return Array.from(new Map(standardizedDefs.map((item) => [item.key, item] as const)).values());
    }
    // API 不可用时仍使用同一套稳定导航合同。
    return PRIMARY_NAVIGATION.map((item) => ({
      key: item.key,
      label: item.label,
      icon: item.icon,
      iconType: "lucide" as const,
      iconImage: "",
      desc: item.description,
      group: "",
      navStatus: "active",
    }));
  }, [dbNavItems]);

  // 从数据库分类动态生成导航项（排除已在内置导航中的分类）
  const dbCategoryNavDefs = useMemo(() => {
    return dbCategories
      .filter(c => c.is_active !== false && (isAdmin || c.visibility !== "private"))
      .map(c => ({
        key: `cat_${c.name}`,
        label: c.name,
        icon: c.icon || "📁",
        iconType: "emoji" as const,
        iconImage: "",
        desc: c.description || `${c.name}模块`,
        group: "智能体分类",
        categoryName: c.name,
      }));
  }, [dbCategories, isAdmin]);

  // 分类不在一级导航栏显示，仅在应用广场内部作为二级分类栏。
  // 核心能力始终固定在前；后台或用户创建的独立入口继续追加在后，
  // 避免标准化导航时静默吞掉既有自定义入口。
  const allNavKeys = useMemo<string[]>(() => {
    const collapsedToolKeys = new Set(["extract", "segment", "format", "formatter", "toolbox"]);
    const supplementalKeys = [
      ...navOrder,
      ...builtInNavDefs.map((item) => item.key),
      ...customNavItems
        .filter((item) => !isReplacedLegacyNavLabel(item.label))
        .map((item) => item.key),
    ].filter((key) => (
      !isPrimaryNavigationKey(key)
      && key !== "topics"
      && !collapsedToolKeys.has(key)
      && key !== "short_drama"
      && !hiddenNavKeys.includes(key)
    ));

    return [...PRIMARY_NAVIGATION_ORDER, ...Array.from(new Set(supplementalKeys))];
  }, [builtInNavDefs, customNavItems, hiddenNavKeys, navOrder]);

  const restorableHiddenNavKeys = useMemo(
    () => hiddenNavKeys.filter((key) => !isPrimaryNavigationKey(key)),
    [hiddenNavKeys],
  );

  useEffect(() => {
    if (restorableHiddenNavKeys.length === hiddenNavKeys.length) return;
    setHiddenNavKeys(restorableHiddenNavKeys);
    localStorage.setItem(STORAGE_KEYS.HIDDEN_NAV_KEYS, JSON.stringify(restorableHiddenNavKeys));
  }, [hiddenNavKeys, restorableHiddenNavKeys]);

  const handleNavDragStart = (key: string) => { setDragNavKey(key); };
  const handleNavDragOver = (e: React.DragEvent, key: string) => { e.preventDefault(); setDragOverNavKey(key); };
  const handleNavDrop = (targetKey: string) => {
    if (!dragNavKey || dragNavKey === targetKey) { setDragNavKey(null); setDragOverNavKey(null); return; }
    const newOrder = [...allNavKeys];
    const fromIdx = newOrder.indexOf(dragNavKey);
    const toIdx = newOrder.indexOf(targetKey);
    if (fromIdx === -1 || toIdx === -1) return;
    newOrder.splice(fromIdx, 1);
    newOrder.splice(toIdx, 0, dragNavKey);
    setNavOrder(newOrder);
    localStorage.setItem(STORAGE_KEYS.NAV_ORDER, JSON.stringify(newOrder));
    saveUIPrefs({});
    setDragNavKey(null);
    setDragOverNavKey(null);
  };
  const handleNavDragEnd = () => { setDragNavKey(null); setDragOverNavKey(null); };

  const allCatKeys = useMemo(() => {
    const fixedKeys = [BIP_CATEGORY, ...TASK_CATEGORIES.map(category => category.key), "自用"];
    const customKeys = customCategories.map(category => category.key).filter(key => !fixedKeys.includes(key as never));
    // 产品分类遵循稳定业务顺序；自定义分类在其后，避免本地旧排序再次把商业IP挤到后面。
    return ["all", FAVORITES_CATEGORY, ...fixedKeys, ...customKeys];
  }, [customCategories]);

  const learnerPermissionIsCurrent = isPermissionControlledIdentity
    && learnerPermissionSnapshot.identityKey === learnerPermissionIdentityKey;
  const isLearnerPermissionLoading = isPermissionControlledIdentity
    && (!learnerPermissionIsCurrent || learnerPermissionSnapshot.status === "loading");
  const learnerHasNoAgentGrant = isPermissionControlledIdentity
    && learnerPermissionIsCurrent
    && learnerPermissionSnapshot.status === "ready"
    && learnerPermissionSnapshot.agentIds.size === 0
    && learnerPermissionSnapshot.navigationKeys.size === 0;
  const learnerPermissionUnavailable = isPermissionControlledIdentity
    && learnerPermissionIsCurrent
    && learnerPermissionSnapshot.status === "error";
  const visibleCatKeys = useMemo(() => {
    if (!isPermissionControlledIdentity) return allCatKeys.filter(key=>key!=="自用");
    const permittedKeys = new Set<string>();
    if (learnerPermissionIsCurrent && learnerPermissionSnapshot.status === "ready") {
      learnerPermissionSnapshot.navigationKeys.forEach((key) => permittedKeys.add(key));
      const candidates = agents.filter((agent) => agent.user_access !== "hidden"
        && dbCategories.find((category) => category.name === agent.category)?.visibility !== "private");
      getAuthorizedAgentDisplayKeys(candidates, learnerPermissionSnapshot.agentIds, learnerPermissionSnapshot.navigationKeys)
        .forEach((key) => permittedKeys.add(key));
    }
    return [
      "all",
      FAVORITES_CATEGORY,
      ...LEARNER_AGENT_NAVIGATION_KEYS.filter((key) => permittedKeys.has(key)),
    ];
  }, [allCatKeys, agents, dbCategories, isPermissionControlledIdentity, learnerPermissionIsCurrent, learnerPermissionSnapshot.agentIds, learnerPermissionSnapshot.navigationKeys, learnerPermissionSnapshot.status]);

  useEffect(() => {
    if (!visibleCatKeys.includes(activeCategory)) {
      setActiveCategory("all");
      setViewFilter("all");
    }
  }, [activeCategory, visibleCatKeys]);

  const handleCatDragStart = (key: string) => { setDragCatKey(key); };
  const handleCatDragOver = (e: React.DragEvent, key: string) => { e.preventDefault(); setDragOverCatKey(key); };
  const handleCatDrop = (targetKey: string) => {
    if (!dragCatKey || dragCatKey === targetKey) { setDragCatKey(null); setDragOverCatKey(null); return; }
    const newOrder = [...allCatKeys];
    const fromIdx = newOrder.indexOf(dragCatKey);
    const toIdx = newOrder.indexOf(targetKey);
    if (fromIdx === -1 || toIdx === -1) return;
    newOrder.splice(fromIdx, 1);
    newOrder.splice(toIdx, 0, dragCatKey);
    setCatOrder(newOrder);
    localStorage.setItem(STORAGE_KEYS.CAT_ORDER, JSON.stringify(newOrder));
    saveUIPrefs({});
    setDragCatKey(null);
    setDragOverCatKey(null);
  };
  const handleCatDragEnd = () => { setDragCatKey(null); setDragOverCatKey(null); };

  // 智能体卡片拖拽排序（管理员拖拽后持久化到数据库sort_order）
  const handleAgentDragStart = (agentId: string) => { setDragAgentKey(agentId); };
  const handleAgentDragOver = (e: React.DragEvent, agentId: string) => { e.preventDefault(); setDragOverAgentKey(agentId); };
  const handleAgentDrop = async (targetId: string) => {
    if (!dragAgentKey || dragAgentKey === targetId) { setDragAgentKey(null); setDragOverAgentKey(null); return; }
    // Persist the complete stable order for the affected category. The
    // displayed list may be narrowed by search/favorites/read-only filters and
    // must never become the source of truth for a category-wide reorder.
    const dragged = agents.find((agent) => agent.id === dragAgentKey);
    const target = agents.find((agent) => agent.id === targetId);
    if (!dragged || !target || dragged.category !== target.category) return;
    const currentIds = agents
      .filter((agent) => agent.category === dragged.category)
      .sort((left, right) => (left.sort_order ?? 0) - (right.sort_order ?? 0) || left.id.localeCompare(right.id))
      .map((agent) => agent.id);
    const newOrder = [...currentIds];
    const fromIdx = newOrder.indexOf(dragAgentKey);
    const toIdx = newOrder.indexOf(targetId);
    if (fromIdx === -1 || toIdx === -1) return;
    newOrder.splice(fromIdx, 1);
    newOrder.splice(toIdx, 0, dragAgentKey);

    // 管理员：持久化排序到数据库
    let persisted = !isAdmin;
    if (isAdmin && auth.token) {
      try {
        const revisions = await loadAdminAgentRevisions(auth.token, newOrder);
        const response = await fetch("/api/admin/agents/reorder", {
          method: "PUT",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${auth.token}` },
          body: JSON.stringify({
            agents: newOrder.map((id) => ({ id, expected_revision: revisions.get(id) })),
          }),
        });
        persisted = response.ok;
        if (!response.ok) {
          const payload = await response.json().catch(() => ({}));
          toast.error(response.status === 409 ? "排序已被另一端更新，请刷新后重试" : (payload.error || "排序保存失败"));
        }
      } catch (e) {
        console.error("[agent-marketplace] reorder failed:", e);
        toast.error("无法读取最新配置版本，排序未保存");
      }
    }

    // Mirror the same complete category order locally. Updating only the
    // currently displayed subset would leave duplicate/stale sort_order values
    // until the next refresh.
    if (persisted) {
      newOrder.forEach((id, index) => {
        const original = agents.find((agent) => agent.id === id);
        if (original) original.sort_order = (index + 1) * 10;
      });
      dispatch({ type: "SET_AGENTS", payload: [...agents] });
    }

    setDragAgentKey(null);
    setDragOverAgentKey(null);
  };
  const handleAgentDragEnd = () => { setDragAgentKey(null); setDragOverAgentKey(null); setDragAgentToCatOver(null); };

  // 拖拽卡片到分类标签 — 更新智能体分类（移到新分类末尾）
  const handleAgentDropOnCategory = async (catKey: string) => {
    if (!dragAgentKey || catKey === "all") { setDragAgentToCatOver(null); return; }
    const agent = agents.find(a => a.id === dragAgentKey);
    if (!agent) { setDragAgentToCatOver(null); return; }
    // Display facets such as task:* and bip:loop are derived views, not stable
    // database categories. Never persist their translated label as category.
    const catItem = categories.find(c => c.key === catKey);
    const persistedCategory = catKey === "自用"
      ? "自用"
      : dbCategories.find(category => category.name === catKey || category.id === catKey)?.name || null;
    if (!persistedCategory) {
      setMoveSuccessMsg(`「${catItem?.label || catKey}」是展示分组，暂无稳定分类值，未移动`);
      setTimeout(() => setMoveSuccessMsg(null), 3500);
      setDragAgentToCatOver(null);
      setDragAgentKey(null);
      return;
    }
    if (agent.category === persistedCategory) { setDragAgentToCatOver(null); setDragAgentKey(null); return; }
    try {
      if (!auth.token) throw new Error("AUTH_TOKEN_REQUIRED");
      const revisions = await loadAdminAgentRevisions(auth.token, [agent.id]);
      const res = await fetch("/api/admin/agents", {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${auth.token}` },
        body: JSON.stringify({ agentId: agent.id, expected_revision: revisions.get(agent.id), category: persistedCategory }),
      });
      if (res.ok) {
        // 计算新分类末尾的 sort_order
        const sameCategoryAgents = agents.filter(a => a.category === persistedCategory && a.id !== agent.id);
        const maxSort = Math.max(0, ...sameCategoryAgents.map(a => a.sort_order ?? 0));
        const newSortOrder = maxSort + 10;
        // 更新本地agents列表中的分类和排序
        dispatch({ type: "UPDATE_AGENT_CATEGORY", payload: { agentId: agent.id, category: persistedCategory, sort_order: newSortOrder } });
        setMoveSuccessMsg(`已将「${agent.name}」移至「${catItem?.label || persistedCategory}」`);
        setTimeout(() => setMoveSuccessMsg(null), 2500);
      } else {
        const err = await res.json().catch(() => ({}));
        setMoveSuccessMsg(`移动失败：${err.error || "未知错误"}`);
        setTimeout(() => setMoveSuccessMsg(null), 3000);
      }
    } catch (e) {
      setMoveSuccessMsg(`移动失败：网络错误`);
      setTimeout(() => setMoveSuccessMsg(null), 3000);
    }
    setDragAgentToCatOver(null);
    setDragAgentKey(null);
  };
  const commitIconPick = (emoji: string) => {
    if (!iconPicker) return;
    const { target, key } = iconPicker;
    if (target === "nav") {
      const updated = { ...navOverrides, [key]: { ...navOverrides[key], icon: emoji } };
      setNavOverrides(updated);
      localStorage.setItem(STORAGE_KEYS.NAV_DISPLAY_OVERRIDES, JSON.stringify(updated));
    } else {
      const updated = { ...catOverrides, [key]: { ...catOverrides[key], icon: emoji } };
      setCatOverrides(updated);
      localStorage.setItem(STORAGE_KEYS.CAT_DISPLAY_OVERRIDES, JSON.stringify(updated));
    }
    setIconPicker(null);
    saveUIPrefs({});
  };
  const commitAvatarEdit = () => {
    if (!avatarEdit) return;
    const updated = { ...agentOverrides, [avatarEdit.agentId]: { ...agentOverrides[avatarEdit.agentId], iconUrl: avatarEdit.iconUrl, name: avatarEdit.name, description: avatarEdit.description } };
    setAgentOverrides(updated);
    localStorage.setItem(STORAGE_KEYS.AGENT_DISPLAY_OVERRIDES, JSON.stringify(updated));
    setAvatarEdit(null);
    saveUIPrefs({});
  };

  // "全部保存"到服务端（批量保存覆盖数据到platform_settings）
  const saveAllOverrides = async () => {
    const overrides = { nav: navOverrides, cat: catOverrides, agent: agentOverrides };
    try {
      await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${auth.token}` },
        body: JSON.stringify({ display_overrides: JSON.stringify(overrides) }),
      });
    } catch {}
  };

  const categories = useMemo(() => {
    const allItem = { key: "all", label: "全部助手", icon: "🎯" };
    const base: CategoryItem[] = [
      allItem,
      { key: FAVORITES_CATEGORY, label: "我的收藏", icon: "♥" },
      { key:BIP_CATEGORY, label:BIP_CATEGORY_LABEL, icon:"📌" },
      ...TASK_CATEGORIES,
      { key:"自用", label:"内部工具", icon:"📌" },
    ];
    return [...base, ...customCategories.filter(category => !base.some(item => item.key === category.key))];
  }, [customCategories]);

  // Search must use the same effective values that cards render. Admin display
  // overrides are presentation data and never change the persisted agent row.
  const getAgentName = useCallback((id: string, defaultName: string) => {
    const override = agentOverrides[id]?.name?.trim();
    return override || defaultName;
  }, [agentOverrides]);
  const getAgentDesc = useCallback((id: string, defaultDesc: string) => {
    const override = agentOverrides[id]?.description?.trim();
    return override || defaultDesc;
  }, [agentOverrides]);

  const removeCustomCategory = (key: string) => {
    const updated = customCategories.filter((c) => c.key !== key);
    setCustomCategories(updated);
    localStorage.setItem(STORAGE_KEYS.CUSTOM_CATEGORIES, JSON.stringify(updated));
    saveUIPrefs({});
    if (activeCategory === key) setActiveCategory("all");
  };

  // 判断分类是否为"仅展示" — 仅 visibility=view_only 的分类（用户无权限的分类已在后端过滤，不再返回）
  const viewOnlyCategoryNames = useMemo(() => {
    const names = new Set<string>();
    dbCategories.forEach(c => {
      if (c.visibility === "view_only" && !(c.name === "自用" && c.user_can_use === true)) names.add(c.name);
    });
    return names;
  }, [dbCategories]);

  const isAgentViewOnlyForUser = useCallback((agent: { category?: string; user_access?: string }) => {
    return agent.user_access === "view_only" || viewOnlyCategoryNames.has(agent.category || "")
      || (agent.category === "自用" && !dbCategories.some(c => c.name === "自用" && c.user_can_use === true));
  }, [viewOnlyCategoryNames,dbCategories]);

  const filteredAgents = useMemo(() => {
    let filtered = agents.filter((a) => a.id !== "__free_chat__"); // 排除虚拟自由对话智能体
    if (isPermissionControlledIdentity) {
      // Ordinary users fail closed until the permission snapshot for this exact
      // identity is ready. Intersecting by Agent id also prevents a late guest
      // response from leaking cards that merely share an allowed display tab.
      if (!learnerPermissionIsCurrent || learnerPermissionSnapshot.status !== "ready") {
        filtered = [];
      } else {
        filtered = filtered.filter((agent) => {
          return isAgentAuthorizedInSnapshot(agent, learnerPermissionSnapshot.agentIds, learnerPermissionSnapshot.navigationKeys);
        });
      }
    }
    // 非管理员过滤：隐藏 user_access=hidden 的智能体 + 隐藏 private 分类下的智能体
    if (!isAdmin) {
      filtered = filtered.filter((a) => {
        if (a.user_access === "hidden") return false;
        // 分类级别: private 分类下的智能体对用户完全不可见
        if (viewOnlyCategoryNames.has(a.category || "")) {
          // view_only 分类的智能体仍然可见（只是不可用），不在此处过滤
        }
        // 检查分类是否为 private（虽然 /api/bots 已经过滤，前端兜底）
        const dbCat = dbCategories.find(c => c.name === a.category);
        if (dbCat?.visibility === "private") return false;
        return true;
      });
    }
    // 收藏是附加归属，不会改变智能体原分类；仅“我的收藏”视图按收藏关系收窄。
    if (favoritesLoaded && activeCategory === FAVORITES_CATEGORY) {
      filtered = filtered.filter((agent) => favoriteAgentIds.has(agent.id));
    } else if (activeCategory === FAVORITES_CATEGORY) {
      // An unread/failed first snapshot is not an empty collection. Keep the
      // view empty until the user retries so unknown state cannot expose every
      // agent or submit the inverse favorite operation.
      filtered = [];
    }
    if (activeCategory !== "all" && activeCategory !== FAVORITES_CATEGORY) {
      filtered = filtered.filter((a) => matchesDisplayCategory(a, activeCategory));
    }
    if (viewFilter === "view_only") {
      filtered = filtered.filter((a) => isAgentViewOnlyForUser(a));
    }
    const q = searchQuery.trim().toLocaleLowerCase();
    if (q) {
      filtered = filtered.filter((agent) => (
        getAgentName(agent.id, agent.name).toLocaleLowerCase().includes(q)
        || getAgentDesc(agent.id, agent.description || "暂无描述").toLocaleLowerCase().includes(q)
      ));
    }
    return filtered;
  }, [agents, activeCategory, viewFilter, searchQuery, isAdmin, isPermissionControlledIdentity, learnerPermissionIsCurrent, learnerPermissionSnapshot.agentIds, learnerPermissionSnapshot.navigationKeys, learnerPermissionSnapshot.status, dbCategories, viewOnlyCategoryNames, favoriteAgentIds, favoritesLoaded, getAgentName, getAgentDesc]);

  // 智能体排序：分类级排序 + 分类内sort_order排序
  // 规则：1) "全部"视图下，按侧边栏分类顺序排列，越靠左的分类其智能体越靠前
  //       2) 分类内按 sort_order 排序（拖拽可调整，新添加的智能体默认靠后）
  const sortedAgents = useMemo(() => {
    if (activeCategory === "all") {
      // 获取分类顺序（排除"all"项）
      const catKeys = visibleCatKeys.filter(k => k !== "all" && k !== FAVORITES_CATEGORY);

      // 按分类分组
      const grouped = new Map<string, typeof filteredAgents>();
      filteredAgents.forEach(agent => {
        const cat = displayCategory(agent);
        if (!grouped.has(cat)) grouped.set(cat, []);
        grouped.get(cat)!.push(agent);
      });

      // 分类内按 sort_order 排序
      grouped.forEach((agents) => {
        agents.sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
      });

      // 按分类顺序展平
      const result: typeof filteredAgents = [];
      const seen = new Set<string>();
      catKeys.forEach(cat => {
        const catAgents = grouped.get(cat);
        if (catAgents) {
          result.push(...catAgents);
          seen.add(cat);
        }
      });

      // 添加不在 catKeys 中的分类（兜底）
      grouped.forEach((agents, cat) => {
        if (!seen.has(cat)) result.push(...agents);
      });

      return result;
    } else {
      // 特定分类：按 sort_order 排序
      return [...filteredAgents].sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
    }
  }, [filteredAgents, visibleCatKeys, activeCategory]);

  const handleSelectAgent = (agentId: string) => {
    const agent = agents.find((a) => a.id === agentId);
    if (!agent) return;
    if (isUnboundCatalogAgent(agent)) { toast.warning("该智能体尚未配置可用模型"); return; }
    // 非管理员无法使用未启用的智能体
    if (!agent.is_active && !isAdmin) {
      toast.warning("该智能体正在开发中，暂不可用");
      return;
    }
    // 非管理员无法使用"仅展示"的智能体（智能体级或分类级）
    if (isAgentViewOnlyForUser(agent)) {
      toast.warning("该智能体仅展示，暂不可用");
      return;
    }
    if (bipStep(agent.id)) {
      setBipIntakeAgentId(agent.id);
      return;
    }
    if (agent.presetFields && agent.presetFields.length > 0) {
      setPresetAgent({ id: agent.id, name: agent.name, iconUrl: agent.iconUrl || "", presetFields: agent.presetFields });
      return;
    }
    // 主页点击智能体卡片始终创建新对话
    startConversation(agentId);
  };

  const startConversation = (agentId: string, presetValues?: Record<string, string>, autoSendPreset = false, requestedConversationId?: string) => {
    const agent = agents.find((a) => a.id === agentId);
    if (!agent) return null;
    const newConvId = startChat(agentId, requestedConversationId);
    if (!newConvId) return null;
    if (presetValues) {
      // preset-dialog.tsx 已经将值格式化为 "标签：用户输入" 格式
      // 这里按字段排序拼接所有非空值，不再重复处理 contentPrefix 和 label
      const sortedFields = agent.presetFields 
        ? [...agent.presetFields].sort((a, b) => a.order - b.order)
        : [];
      const formattedMessage = sortedFields
        .filter((f) => presetValues[f.id]?.trim())
        .map((f) => presetValues[f.id].trim())
        .join("\n");
      // 对于没有 presetFields 的情况，直接拼接所有值
      const finalMessage = formattedMessage || Object.values(presetValues)
        .filter((v) => v?.trim())
        .join("\n");
      if (finalMessage) {
        setPendingPresetMessage({ convId: newConvId, content: finalMessage, autoSend: autoSendPreset });
      }
    }
    return newConvId;
  };

  const handlePresetStart = (values: Record<string, string>) => {
    if (presetAgent) startConversation(presetAgent.id, values);
    setPresetAgent(null);
  };

  const handlePresetSkip = () => {
    // 跳过预设，直接进入对话
    if (presetAgent) startConversation(presetAgent.id);
    setPresetAgent(null);
  };

  const handlePresetClose = () => {
    // 关闭弹窗，不进入对话
    setPresetAgent(null);
  };

  // 动态样式 — 从全局 layoutConfig 读取（支持按分类独立覆盖）
  // 找到当前分类对应的分类对象，获取其 name
  const activeCategoryObj = activeCategory === "all" ? null : dbCategories.find(c => c.id === activeCategory || c.name === activeCategory);
  const categoryOverrides = layoutConfig.categoryOverrides;
  const catOverride = activeCategoryObj?.id && categoryOverrides ? categoryOverrides[activeCategoryObj.id] : undefined;
  const cl = catOverride ? { ...layoutConfig.card, ...catOverride } : layoutConfig.card;
  const nl = layoutConfig.nav;
  const cal = layoutConfig.category;
  const clampUiNumber = (value: unknown, minimum: number, maximum: number, fallback: number) => {
    const numeric = Number(value);
    return Math.min(maximum, Math.max(minimum, Number.isFinite(numeric) ? numeric : fallback));
  };
  const marketplaceShellStyle = {
    minWidth: 0,
    minHeight: 0,
    "--market-nav-font-size": `${clampUiNumber(nl.fontSize, 14, 16, 15)}px`,
    "--market-nav-icon-size": `${clampUiNumber(nl.iconSize, 16, 18, 17)}px`,
    "--market-nav-padding-x": `${clampUiNumber(nl.buttonPaddingX, 7, 9, 8)}px`,
    "--market-nav-padding-y": `${clampUiNumber(nl.buttonPaddingY, 6, 8, 7)}px`,
    "--market-nav-gap": `${clampUiNumber(nl.buttonGap, 2, 4, 3)}px`,
    "--market-nav-radius": `${clampUiNumber(nl.buttonBorderRadius, 8, 14, 10)}px`,
    "--market-category-font-size": `${clampUiNumber(cal.fontSize, 16, 20, 16)}px`,
    "--market-category-padding-x": `${clampUiNumber(cal.tagPaddingX, 8, 10, 9)}px`,
    "--market-category-padding-y": `${clampUiNumber(cal.tagPaddingY, 6, 8, 7)}px`,
    "--market-category-gap": `${clampUiNumber(cal.tagGap, 4, 6, 5)}px`,
    "--market-category-radius": `${clampUiNumber(cal.tagBorderRadius, 8, 12, 10)}px`,
  } as React.CSSProperties;

  // 滑动指示器跟随活动项、容器滚动和桌面窗口尺寸变化。
  useEffect(() => {
    if (!navContainerRef.current) return;
    const container = navContainerRef.current;
    const updateIndicator = () => {
      const maximumScroll = Math.max(0, container.scrollWidth - container.clientWidth);
      const nextOverflow = {
        available: maximumScroll > 2,
        canScrollLeft: container.scrollLeft > 2,
        canScrollRight: container.scrollLeft < maximumScroll - 2,
      };
      setNavOverflow((current) => (
        current.available === nextOverflow.available
        && current.canScrollLeft === nextOverflow.canScrollLeft
        && current.canScrollRight === nextOverflow.canScrollRight
          ? current
          : nextOverflow
      ));
      const activeBtn = container.querySelector('.nav-pill-active') as HTMLElement | null;
      if (!activeBtn) {
        setNavIndicator((current) => current.visible ? { ...current, visible: false } : current);
        return;
      }
      const containerRect = container.getBoundingClientRect();
      const btnRect = activeBtn.getBoundingClientRect();
      setNavIndicator({
        left: btnRect.left - containerRect.left + container.scrollLeft,
        width: btnRect.width,
        visible: true,
      });
    };
    updateIndicator();
    const resizeObserver = new ResizeObserver(updateIndicator);
    resizeObserver.observe(container);
    const activeBtn = container.querySelector('.nav-pill-active');
    if (activeBtn) resizeObserver.observe(activeBtn);
    container.addEventListener('scroll', updateIndicator, { passive: true });
    window.addEventListener('resize', updateIndicator);
    return () => {
      resizeObserver.disconnect();
      container.removeEventListener('scroll', updateIndicator);
      window.removeEventListener('resize', updateIndicator);
    };
  }, [allNavKeys, pendingNavKey, view, nl.fontSize, nl.buttonPaddingX, nl.buttonPaddingY, nl.buttonGap, nl.iconSize]);

  const scrollPrimaryNavigation = useCallback((direction: -1 | 1) => {
    const container = navContainerRef.current;
    if (!container) return;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    container.scrollBy({
      left: direction * Math.max(240, Math.floor(container.clientWidth * 0.72)),
      behavior: reducedMotion ? "auto" : "smooth",
    });
  }, []);

  // 同步标题字体 CSS 变量（布局编辑器实时修改 / 保存加载时同步）
  useEffect(() => {
    const fontId = cl.titleFontFamily || "";
    const fontFamily = getTitleFontFamily(fontId);
    if (fontFamily) document.documentElement.style.setProperty("--font-title", fontFamily);
    else document.documentElement.style.removeProperty("--font-title");

    // Only fetch the selected web font. System fonts and the default stack need
    // no external stylesheet; loading the complete catalog added ~0.5 MiB to
    // every marketplace visit even when no custom font was selected.
    const FONT_LINK_ID = "google-fonts-link";
    const PRECONNECT_STYLE_ID = "google-fonts-style-preconnect";
    const PRECONNECT_FONT_ID = "google-fonts-file-preconnect";
    const query = GOOGLE_TITLE_FONT_QUERIES[fontId];
    const existing = document.getElementById(FONT_LINK_ID) as HTMLLinkElement | null;
    if (!query) {
      existing?.remove();
      document.getElementById(PRECONNECT_STYLE_ID)?.remove();
      document.getElementById(PRECONNECT_FONT_ID)?.remove();
      return;
    }

    const fontUrl = `https://fonts.googleapis.cn/css2?${query}&display=swap`;
    if (existing?.href === fontUrl) return;
    existing?.remove();
    for (const [id, href] of [
      [PRECONNECT_STYLE_ID, "https://fonts.googleapis.cn"],
      [PRECONNECT_FONT_ID, "https://fonts.gstatic.cn"],
    ] as const) {
      if (document.getElementById(id)) continue;
      const preconnect = document.createElement("link");
      preconnect.id = id;
      preconnect.rel = "preconnect";
      preconnect.href = href;
      preconnect.crossOrigin = "anonymous";
      document.head.appendChild(preconnect);
    }
    const link = document.createElement("link");
    link.id = FONT_LINK_ID;
    link.rel = "stylesheet";
    link.href = fontUrl;
    document.head.appendChild(link);
  }, [cl.titleFontFamily]);

  // 响应式网格：根据视口宽度动态计算列数
  const [responsiveColumns, setResponsiveColumns] = useState(cl.columns || 4);
  useEffect(() => {
    const updateColumns = () => {
      const vw = window.innerWidth;
      if (vw < 640) setResponsiveColumns(1);        // 手机: 单列
      else if (vw < 768) setResponsiveColumns(2);    // 大手机/小平板: 2列
      else if (vw < 1024) setResponsiveColumns(Math.min(cl.columns || 4, 2)); // 平板: 最多2列
      else if (vw < 1280) setResponsiveColumns(Math.min(cl.columns || 4, 3)); // 小桌面: 最多3列
      else setResponsiveColumns(cl.columns || 4);    // 大桌面: 配置列数
    };
    updateColumns();
    window.addEventListener("resize", updateColumns);
    return () => window.removeEventListener("resize", updateColumns);
  }, [cl.columns]);

  const gridStyle: React.CSSProperties & { "--marketplace-grid-template": string } = (() => {
    const cardMinWidth = (cl as any).cardMinWidth;
    const gapX = Math.max(Number(cl.gapX) || 0, 16);
    const gapY = Math.max(Number(cl.gapY) || 0, 16);
    if (cardMinWidth && cardMinWidth > 0) {
      // 使用精确卡片最小宽度
      return {
        "--marketplace-grid-template": `repeat(auto-fill, minmax(${cardMinWidth}px, 1fr))`,
        gap: `var(--marketplace-grid-gap, ${gapY}px ${gapX}px)`,
        justifyContent: "var(--marketplace-grid-justify, flex-start)",
        gridTemplateColumns: `var(--marketplace-grid-template, repeat(auto-fill, minmax(${cardMinWidth}px, 1fr)))`,
      };
    }
    // 自动均分模式
    return {
      "--marketplace-grid-template": `repeat(${responsiveColumns}, minmax(0, 1fr))`,
      gap: `var(--marketplace-grid-gap, ${gapY}px ${gapX}px)`,
      justifyContent: "var(--marketplace-grid-justify, flex-start)",
      gridTemplateColumns: `var(--marketplace-grid-template, repeat(${responsiveColumns}, minmax(0, 1fr)))`,
    };
  })();

  // 应用覆盖数据的辅助函数
  const getNavLabel = (key: string, defaultLabel: string) => {
    if (isPrimaryNavigationKey(key)) return getPrimaryNavigationLabel(key, defaultLabel);
    return navOverrides[key]?.label || defaultLabel;
  };
  const getNavIcon = (key: string, defaultIcon: string) => navOverrides[key]?.icon || defaultIcon;
  const getNavDesc = (key: string, defaultDesc: string) => navOverrides[key]?.desc || defaultDesc;
  const getCatLabel = (key: string, defaultLabel: string) => {
    const override = catOverrides[key]?.label?.trim();
    return !override || override === LEGACY_CATEGORY_LABELS[key] ? defaultLabel : override;
  };
  const getCatIcon = (key: string, defaultIcon: string) => catOverrides[key]?.icon || defaultIcon;
  const getAgentIcon = (id: string, defaultIcon: string, agentName = "") =>
    resolveAgentAvatarUrl(id, agentName, agentOverrides[id]?.iconUrl || defaultIcon);

  const isAvatarRight = cl.avatarPosition === "right";
  const isAvatarTop = cl.avatarPosition === "top" || cl.avatarPosition === "top-center";
  const isAvatarLeft = cl.avatarPosition === "left";
  const isAvatarCorner = ["top-left", "top-right", "bottom-left", "bottom-right"].includes(cl.avatarPosition);

  // Ordinary members never see cached Agent cards while the independent
  // permission authority is unresolved.  This protects against cross-account
  // browser cache leakage in addition to the API gate.
  if (isPermissionControlledIdentity && memberPermission.status !== "ready") {
    return (
      <div className="marketplace-shell flex h-full items-center justify-center bg-[var(--background)] px-6" role="status" data-testid="member-permission-loading">
        <div className="max-w-md rounded-2xl border border-[var(--border)] bg-[var(--card)] p-6 text-center text-sm text-[var(--muted-foreground)] shadow-lg">
          {memberPermission.status === "error" ? (memberPermission.error || "会员权限校验暂不可用") : "正在核对会员功能权限…"}
        </div>
      </div>
    );
  }
  if (isPermissionControlledIdentity && !grantedFeatureKeys.has("marketplace")) {
    return (
      <div className="marketplace-shell flex h-full items-center justify-center bg-[var(--background)] px-6" data-testid="marketplace-access-denied">
        <div className="max-w-md rounded-2xl border border-[var(--border)] bg-[var(--card)] p-7 text-center shadow-lg">
          <h2 className="text-lg font-semibold text-[var(--foreground)]">应用广场尚未开通</h2>
          <p className="mt-2 text-sm leading-6 text-[var(--muted-foreground)]">当前账号不会显示智能体、分类或历史缓存。请从已开通的业务入口继续使用，或联系管理员调整权限。</p>
        </div>
      </div>
    );
  }

  return (
    <div className="marketplace-shell voice-studio-root vs-workbench h-full flex flex-col overflow-hidden bg-[var(--background)]" style={marketplaceShellStyle}>
      {/* 编辑模式顶部保存栏 */}
      {isAdmin && editMode && (
        <div className="sticky top-0 z-50 flex items-center justify-between px-6 py-2.5 bg-[var(--primary)] text-[var(--primary-foreground)]">
          <div className="flex items-center gap-2 text-sm font-medium">
            <Layout className="w-4 h-4" />
            <span className="hidden sm:inline">编辑模式 — 双击文字/图标可修改，点击头像可编辑卡片</span>
            <span className="sm:hidden">编辑模式</span>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => {
                // 取消：清空所有临时覆盖
                setNavOverrides({});
                setCatOverrides({});
                setAgentOverrides({});
                dispatch({ type: "TOGGLE_EDIT_MODE" });
              }}
              className="px-3 py-1 rounded-md bg-white/20 hover:bg-white/30 text-sm transition-colors"
            >
              取消
            </button>
            <button
              onClick={() => {
                // 保存：写入localStorage
                try {
                  localStorage.setItem(STORAGE_KEYS.NAV_DISPLAY_OVERRIDES, JSON.stringify(navOverrides));
                  localStorage.setItem(STORAGE_KEYS.CAT_DISPLAY_OVERRIDES, JSON.stringify(catOverrides));
                  localStorage.setItem(STORAGE_KEYS.AGENT_DISPLAY_OVERRIDES, JSON.stringify(agentOverrides));
                } catch {}
                saveUIPrefs({});
                dispatch({ type: "TOGGLE_EDIT_MODE" });
              }}
              className="px-4 py-1 rounded-md bg-white text-[var(--primary)] text-sm font-semibold hover:bg-white/90 transition-colors"
            >
              保存修改
            </button>
          </div>
        </div>
      )}
      {/* 一级导航栏 */}
      <div className="nav-bar-wrapper relative shrink-0 overflow-x-auto nav-scroll-hide">
        {/* 导航栏项 */}
        <div className="primary-nav-rail" data-nav-overflow={navOverflow.available ? "true" : "false"}>
          <button
            type="button"
            className="nav-scroll-control nav-scroll-control-left"
            onClick={() => scrollPrimaryNavigation(-1)}
            disabled={!navOverflow.canScrollLeft}
            aria-label="向左浏览功能导航"
            aria-hidden={!navOverflow.available}
            tabIndex={navOverflow.available ? 0 : -1}
          >
            <ChevronLeft aria-hidden="true" />
          </button>
          {(() => {
          const allNavDefs = [
            ...builtInNavDefs,
            ...dbCategoryNavDefs,
            ...customNavItems.filter(n => !isReplacedLegacyNavLabel(n.label)).map(n => ({ ...n, group: n.group || "自定义" })),
          ];
          const navMap = new Map(allNavDefs.map(n => [n.key, n]));
          const orderedKeys = allNavKeys.filter((key) => (
            navMap.has(key)
            && (!isPrimaryNavigationKey(key) || grantedFeatureKeys.has(key))
          ));
          let lastGroup = "";
          const flatItems: { navKey: string; showDivider: boolean }[] = [];
          orderedKeys.forEach(k => {
            const nav = navMap.get(k)!;
            const g = nav.group || "";
            flatItems.push({ navKey: k, showDivider: g !== lastGroup && flatItems.length > 0 });
            lastGroup = g;
          });
          return (
            <div
              ref={navContainerRef}
              className="nav-bar-container min-w-0 flex flex-nowrap items-center overflow-x-auto nav-scroll-hide justify-start"
              data-primary-nav-style="plain-tabs"
              style={{ gap: `${nl.buttonGap}px` }}
              aria-label="一级功能导航"
              aria-busy={Boolean(pendingNavKey)}
              data-nav-pending={pendingNavKey || undefined}
            >
              {/* 滑动指示器 — 智音工坊风格 */}
              {navIndicator.visible && (
                <div
                  className="nav-pill-indicator"
                  data-pending={pendingNavKey ? "true" : undefined}
                  style={{ left: navIndicator.left, width: navIndicator.width }}
                />
              )}
              {flatItems.map(({ navKey, showDivider }) => {
                const nav = navMap.get(navKey)!;
                const displayLabel = getNavLabel(nav.key, nav.label);
                const displayIcon = getNavIcon(nav.key, nav.icon);
                const isDragging = dragNavKey === navKey;
                const isDragOver = dragOverNavKey === navKey;
                const isPending = pendingNavKey === nav.key;
                const isActive = isPending || (!pendingNavKey && view === nav.key);
                const navIcon = NAV_LUCIDE_ICONS[nav.key] || (nav.iconType === 'lucide' ? LUCIDE_ICON_MAP[nav.icon] : undefined);
                const NavIconComponent = navIcon?.Icon;
                if (nav.key === "toolbox" && !editMode) {
                  return (
                    <React.Fragment key={nav.key}>
                      {showDivider && <div className="nav-group-divider" />}
                      <div className="shrink-0">
                        <ToolboxMenu
                          variant="navigation"
                          disabled={Boolean(pendingNavKey)}
                          pending={isPending}
                          activeOverride={isActive}
                          navigate={(href) => navigateRoute(nav.key, href)}
                          style={{
                            fontSize: `${clampUiNumber(nl.fontSize, 14, 16, 15)}px`,
                            padding: `${nl.buttonPaddingY}px ${nl.buttonPaddingX}px`,
                            borderRadius: `${nl.buttonBorderRadius}px`,
                            touchAction: "manipulation",
                          }}
                        />
                      </div>
                    </React.Fragment>
                  );
                }
                return (
                  <React.Fragment key={nav.key}>
                    {showDivider && <div className="nav-group-divider" />}
                    <div
                      className={`shrink-0 group relative transition-all duration-200 ${isDragging ? "opacity-40 scale-95" : ""} ${isDragOver && editMode ? "ring-2 ring-[var(--primary)] ring-offset-1 rounded-xl" : ""}`}
                      {...(editMode && isAdmin && !isPrimaryNavigationKey(nav.key) ? {
                        draggable: true,
                        onDragStart: () => handleNavDragStart(navKey),
                        onDragOver: (e: React.DragEvent) => handleNavDragOver(e, navKey),
                        onDrop: () => handleNavDrop(navKey),
                        onDragEnd: handleNavDragEnd,
                      } : {})}
                    >
                      {editMode && isAdmin && !isPrimaryNavigationKey(nav.key) && (
                        <div className="absolute top-0.5 left-1/2 -translate-x-1/2 cursor-grab active:cursor-grabbing text-[var(--muted-foreground)] opacity-40 hover:opacity-100 transition-opacity z-10">
                          <svg width="14" height="6" viewBox="0 0 14 6" fill="currentColor"><circle cx="3" cy="1.5" r="1.2"/><circle cx="11" cy="1.5" r="1.2"/><circle cx="3" cy="4.5" r="1.2"/><circle cx="11" cy="4.5" r="1.2"/></svg>
                        </div>
                      )}
                      {editMode && isAdmin && !isPrimaryNavigationKey(nav.key) && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            if (nav.key.startsWith("custom_")) {
                              const updated = customNavItems.filter(n => n.key !== nav.key);
                              setCustomNavItems(updated);
                              localStorage.setItem(STORAGE_KEYS.CUSTOM_NAV_ITEMS, JSON.stringify(updated));
                              saveUIPrefs({});
                            } else {
                              const newHidden = [...hiddenNavKeys, nav.key];
                              setHiddenNavKeys(newHidden);
                              localStorage.setItem(STORAGE_KEYS.HIDDEN_NAV_KEYS, JSON.stringify(newHidden));
                            }
                            if (view === nav.key) dispatch({ type: "SET_ACTIVE_VIEW", payload: "marketplace" });
                          }}
                          className="absolute top-1.5 right-1.5 p-1 rounded-full bg-[var(--destructive)]/80 text-white opacity-0 group-hover:opacity-100 transition-opacity hover:bg-[var(--destructive)] z-10"
                        >
                          <X className="w-3 h-3" />
                        </button>
                      )}
                      <button
                        onClick={() => {
                          if (editMode || pendingNavKey) return;
                          const primaryRoute = PRIMARY_NAVIGATION.find((item) => item.key === nav.key)?.route;
                          if (primaryRoute && nav.key !== "marketplace") {
                            navigateRoute(nav.key, primaryRoute);
                            return;
                          }
                          if (nav.key === 'format') {
                            dispatch({ type: "SET_ACTIVE_VIEW", payload: "marketplace" });
                          } else if (nav.key === 'segment') {
                            router.push('/segmenter');
                          } else if (nav.key === 'cover') {
                            router.push('/cover');
                          } else if (nav.key === 'storyboard_workbench') {
                            router.push('/storyboard-workbench');
                          } else if (nav.key === 'extract') {
                            router.push('/extract');
                          } else if (nav.key === 'voice') {
                            router.push('/voice-studio/workspace');
                          } else if (nav.key === 'formatter') {
                            router.push('/formatter');
                          } else if (nav.key.startsWith('cat_')) {
                            // 分类导航项：有智能体 → 应用广场+选中分类，无智能体 → 开发中占位
                            const catName = (nav as any).categoryName || nav.label;
                            const hasAgents = agents.some(a => a.category === catName && (a.user_access !== 'hidden' || learnerPermissionSnapshot.agentIds.has(a.id)));
                            if (hasAgents) {
                              dispatch({ type: "SET_ACTIVE_VIEW", payload: "marketplace" });
                              setActiveCategory(catName);
                              setViewFilter("all");
                            } else {
                              dispatch({ type: "SET_ACTIVE_VIEW", payload: nav.key as any });
                            }
                          } else if ((nav as any).navStatus === 'developing') {
                            // 数据库导航项：developing → 显示开发中占位页
                            dispatch({ type: "SET_ACTIVE_VIEW", payload: nav.key as any });
                          } else if ((nav as any).navStatus === 'active') {
                            // 数据库导航项：active → 显示占位页（后续可对接具体功能页面路由）
                            dispatch({ type: "SET_ACTIVE_VIEW", payload: nav.key as any });
                          } else {
                            dispatch({ type: "SET_ACTIVE_VIEW", payload: nav.key as any });
                          }
                        }}
                        onDoubleClick={(e) => {
                          if (!editMode || !isAdmin) return;
                          e.stopPropagation();
                        }}
                        aria-current={isActive ? "page" : undefined}
                        data-nav-key={nav.key}
                        aria-disabled={Boolean(pendingNavKey) || undefined}
                        aria-busy={isPending || undefined}
                        data-nav-pending={isPending ? "true" : undefined}
                        className={`nav-pill select-none flex items-center gap-2 whitespace-nowrap transition-[color,background-color,border-color,transform] duration-200 active:scale-[0.98] ${
                          isActive
                            ? "nav-pill-active"
                            : "nav-pill-default"
                        }`}
                        style={{
                          "--nav-icon-color": navIcon?.color || "currentColor",
                          fontSize: `${clampUiNumber(nl.fontSize, 14, 16, 15)}px`,
                          padding: `${nl.buttonPaddingY}px ${nl.buttonPaddingX}px`,
                          borderRadius: `${nl.buttonBorderRadius}px`,
                          touchAction: 'manipulation',
                        } as React.CSSProperties}
                      >
                        {nav.iconType === "image" && nav.iconImage ? (
                          <img
                            src={nav.iconImage}
                            alt={displayLabel}
                            className="shrink-0 object-contain"
                            style={{
                              width: `${nl.iconSize}px`,
                              height: `${nl.iconSize}px`,
                              filter: "none",
                            }}
                          />
                        ) : NavIconComponent ? (
                          <NavIconComponent
                            className="nav-pill-icon shrink-0"
                            style={{
                              width: `${nl.iconSize}px`,
                              height: `${nl.iconSize}px`,
                              color: "var(--nav-icon-color)",
                              filter: "none",
                            }}
                            onDoubleClick={(e: React.MouseEvent<SVGSVGElement>) => { if (editMode && isAdmin) { e.stopPropagation(); setIconPicker({ target: "nav", key: nav.key, current: getNavIcon(nav.key, nav.icon) }); } }}
                          />
                        ) : (
                          <span
                            className="nav-pill-icon leading-none cursor-pointer"
                            style={{ fontSize: `${nl.iconSize}px` }}
                            onDoubleClick={(e) => { if (editMode && isAdmin) { e.stopPropagation(); setIconPicker({ target: "nav", key: nav.key, current: getNavIcon(nav.key, nav.icon) }); } }}
                          >{displayIcon}</span>
                        )}
                        <span
                          onDoubleClick={(e) => { if (editMode && isAdmin && !isPrimaryNavigationKey(nav.key)) { e.stopPropagation(); startInlineEdit(nav.key, "nav_label", displayLabel); } }}
                        >
                          {inlineEdit?.key === nav.key && inlineEdit?.field === "nav_label" ? (
                            <input
                              autoFocus
                              value={inlineValue}
                              onChange={(e) => setInlineValue(e.target.value)}
                              onBlur={() => { commitInlineEdit(); setInlineEdit(null); }}
                              onKeyDown={(e) => { if (e.key === "Enter") { commitInlineEdit(); setInlineEdit(null); } if (e.key === "Escape") setInlineEdit(null); }}
                              className="bg-transparent border-b-2 border-[var(--primary)] outline-none text-center w-full text-[14px] font-semibold"
                              onClick={(e) => e.stopPropagation()}
                            />
                          ) : displayLabel}
                        </span>
                      </button>
                    </div>
                  </React.Fragment>
                );
              })}
        </div>
        );
          })()}
          <button
            type="button"
            className="nav-scroll-control nav-scroll-control-right"
            onClick={() => scrollPrimaryNavigation(1)}
            disabled={!navOverflow.canScrollRight}
            aria-label="向右浏览功能导航"
            aria-hidden={!navOverflow.available}
            tabIndex={navOverflow.available ? 0 : -1}
          >
            <ChevronRight aria-hidden="true" />
          </button>
        </div>
      </div>

      {/* 导航与分类之间的渐变分隔线 — 已隐藏：让分类栏上边框与侧边栏品牌卡底线对齐融为一体 */}

      {/* 添加/恢复导航弹窗 */}
      {showAddNav && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setShowAddNav(false)} />
          <div className="relative w-full max-w-md bg-[var(--card)] border border-[var(--border)] rounded-2xl shadow-2xl animate-in fade-in zoom-in-95 duration-200 overflow-hidden">
            <div className="flex items-center justify-between px-6 py-4 border-b border-[var(--border)]">
              <h3 className="text-[15px] font-semibold text-[var(--foreground)]">添加导航</h3>
              <button onClick={() => setShowAddNav(false)} className="p-2 rounded-lg hover:bg-[var(--accent)] text-[var(--muted-foreground)] hover:text-[var(--foreground)] transition-colors">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="px-6 py-5 flex flex-col gap-4 max-h-[60vh] overflow-y-auto">
              {/* 恢复已删除的内置导航 */}
              {(() => {
                if (restorableHiddenNavKeys.length === 0) return null;
                return (
                  <div>
                    <label className="text-[13px] font-medium text-[var(--foreground)] mb-2 block">恢复已删除的导航</label>
                    <div className="flex flex-wrap gap-2">
                      {restorableHiddenNavKeys.map((key) => {
                        const def = [...builtInNavDefs, ...customNavItems.filter(n => !isReplacedLegacyNavLabel(n.label)).map(n => ({ ...n, group: n.group || "自定义" }))].find(n => n.key === key);
                        return (
                          <button
                            key={key}
                            onClick={() => {
                              const newHidden = hiddenNavKeys.filter(k => k !== key);
                              setHiddenNavKeys(newHidden);
                              localStorage.setItem(STORAGE_KEYS.HIDDEN_NAV_KEYS, JSON.stringify(newHidden));
                            }}
                            className="flex items-center gap-1.5 px-3 py-1.5 bg-[var(--secondary)]/50 hover:bg-[var(--primary)]/10 border border-[var(--border)]/50 hover:border-[var(--primary)]/30 rounded-lg text-[12px] text-[var(--foreground)] transition-all hover:shadow-sm"
                          >
                            <span>{def?.icon || "📌"}</span>
                            <span>{def?.label || key}</span>
                          </button>
                        );
                      })}
                    </div>
                    <div className="h-px bg-[var(--border)]/50 mt-4" />
                  </div>
                );
              })()}

              {/* 自定义导航 - 图标选择 */}
              <div>
                <label className="text-[13px] font-medium text-[var(--foreground)] mb-1.5 block">图标</label>
                <div className="space-y-2 max-h-[200px] overflow-y-auto">
                  {ICON_GROUPS.map((group) => (
                    <div key={group.label}>
                      <div className="text-[10px] text-[var(--muted-foreground)] mb-1">{group.label}</div>
                      <div className="flex gap-1.5 flex-nowrap overflow-x-auto">
                        {group.icons.map((emoji) => (
                          <button
                            key={emoji}
                            onClick={() => setNewNavItem(prev => ({ ...prev, icon: emoji }))}
                            className={`w-8 h-8 rounded-lg text-base flex items-center justify-center transition-all ${
                              newNavItem.icon === emoji
                                ? "bg-[var(--primary)] scale-110 shadow-md"
                                : "bg-[var(--secondary)]/50 hover:bg-[var(--secondary)] border border-[var(--border)]/30"
                            }`}
                          >
                            {emoji}
                          </button>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
              <div>
                <label className="text-[13px] font-medium text-[var(--foreground)] mb-1.5 block">名称 <span className="text-[var(--destructive)]">*</span></label>
                <input
                  value={newNavItem.label}
                  onChange={(e) => setNewNavItem(prev => ({ ...prev, label: e.target.value }))}
                  placeholder="例如：数据分析"
                  maxLength={8}
                  className="w-full px-4 py-2.5 bg-[var(--background)] border border-[var(--border)] rounded-xl text-sm text-[var(--foreground)] placeholder:text-[var(--muted-foreground)] focus:outline-none focus:border-[var(--primary)] focus:ring-2 focus:ring-[var(--primary)]/30 transition-all"
                />
              </div>
              <div>
                <label className="text-[13px] font-medium text-[var(--foreground)] mb-1.5 block">描述</label>
                <input
                  value={newNavItem.desc}
                  onChange={(e) => setNewNavItem(prev => ({ ...prev, desc: e.target.value }))}
                  placeholder="例如：AI数据分析助手"
                  maxLength={12}
                  className="w-full px-4 py-2.5 bg-[var(--background)] border border-[var(--border)] rounded-xl text-sm text-[var(--foreground)] placeholder:text-[var(--muted-foreground)] focus:outline-none focus:border-[var(--primary)] focus:ring-2 focus:ring-[var(--primary)]/30 transition-all"
                />
              </div>
            </div>
            <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-[var(--border)] bg-[var(--secondary)]/30">
              <button onClick={() => setShowAddNav(false)} className="px-5 py-2.5 text-sm text-[var(--muted-foreground)] hover:text-[var(--foreground)] rounded-lg hover:bg-[var(--accent)] transition-colors">
                取消
              </button>
              <button
                onClick={() => {
                  if (!newNavItem.label.trim()) return;
                  const item: NavItem = {
                    key: `custom_${Date.now()}`,
                    label: newNavItem.label.trim(),
                    icon: newNavItem.icon || "🛠️",
                    desc: newNavItem.desc.trim() || newNavItem.label.trim(),
                    group: "自定义",
                  };
                  const updated = [...customNavItems, item];
                  setCustomNavItems(updated);
                  localStorage.setItem(STORAGE_KEYS.CUSTOM_NAV_ITEMS, JSON.stringify(updated));
                  saveUIPrefs({});
                  setShowAddNav(false);
                  setNewNavItem({ label: "", icon: "🛠️", desc: "" });
                }}
                disabled={!newNavItem.label.trim()}
                className="px-6 py-2.5 text-sm font-medium text-[var(--primary-foreground)] bg-[var(--primary)] hover:opacity-90 rounded-lg transition-opacity shadow-lg shadow-[var(--primary)]/20 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                添加
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 添加自定义分类弹窗 */}
      {showAddCategory && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setShowAddCategory(false)} />
          <div className="relative w-full max-w-sm bg-[var(--card)] border border-[var(--border)] rounded-2xl shadow-2xl animate-in fade-in zoom-in-95 duration-200 overflow-hidden">
            <div className="flex items-center justify-between px-6 py-4 border-b border-[var(--border)]">
              <h3 className="text-[15px] font-semibold text-[var(--foreground)]">添加自定义分类</h3>
              <button onClick={() => setShowAddCategory(false)} className="p-2 rounded-lg hover:bg-[var(--accent)] text-[var(--muted-foreground)] hover:text-[var(--foreground)] transition-colors">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="px-6 py-5 flex flex-col gap-4">
              <div>
                <label className="text-[13px] font-medium text-[var(--foreground)] mb-1.5 block">图标</label>
                <div className="space-y-2 max-h-[200px] overflow-y-auto">
                  {ICON_GROUPS.map((group) => (
                    <div key={group.label}>
                      <div className="text-[10px] text-[var(--muted-foreground)] mb-1">{group.label}</div>
                      <div className="flex gap-1.5 flex-nowrap overflow-x-auto">
                        {group.icons.map((emoji) => (
                          <button
                            key={emoji}
                            onClick={() => setNewCategory(prev => ({ ...prev, icon: emoji }))}
                            className={`w-8 h-8 rounded-lg text-base flex items-center justify-center transition-all ${
                              newCategory.icon === emoji
                                ? "bg-[var(--primary)] scale-110 shadow-md"
                                : "bg-[var(--secondary)]/50 hover:bg-[var(--secondary)] border border-[var(--border)]/30"
                            }`}
                          >
                            {emoji}
                          </button>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
              <div>
                <label className="text-[13px] font-medium text-[var(--foreground)] mb-1.5 block">名称 <span className="text-[var(--destructive)]">*</span></label>
                <input
                  value={newCategory.label}
                  onChange={(e) => setNewCategory(prev => ({ ...prev, label: e.target.value }))}
                  placeholder="例如：数据分析"
                  maxLength={8}
                  className="w-full px-4 py-2.5 bg-[var(--background)] border border-[var(--border)] rounded-xl text-sm text-[var(--foreground)] placeholder:text-[var(--muted-foreground)] focus:outline-none focus:border-[var(--primary)] focus:ring-2 focus:ring-[var(--primary)]/30 transition-all"
                />
              </div>
            </div>
            <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-[var(--border)] bg-[var(--secondary)]/30">
              <button onClick={() => setShowAddCategory(false)} className="px-5 py-2.5 text-sm text-[var(--muted-foreground)] hover:text-[var(--foreground)] rounded-lg hover:bg-[var(--accent)] transition-colors">
                取消
              </button>
              <button
                onClick={() => {
                  if (!newCategory.label.trim()) return;
                  const item: CategoryItem = {
                    key: `custom_cat_${Date.now()}`,
                    label: newCategory.label.trim(),
                    icon: newCategory.icon || "📁",
                  };
                  const updated = [...customCategories, item];
                  setCustomCategories(updated);
                  localStorage.setItem(STORAGE_KEYS.CUSTOM_CATEGORIES, JSON.stringify(updated));
                  saveUIPrefs({});
                  setShowAddCategory(false);
                  setNewCategory({ label: "", icon: "📁" });
                }}
                disabled={!newCategory.label.trim()}
                className="px-6 py-2.5 text-sm font-medium text-[var(--primary-foreground)] bg-[var(--primary)] hover:opacity-90 rounded-lg transition-opacity shadow-lg shadow-[var(--primary)]/20 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                添加
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 二级分类栏（仅应用广场显示） */}
      {view === "marketplace" && <div className="marketplace-category-bar my-1 border-b border-[var(--border)] bg-[color-mix(in_srgb,var(--card)_60%,transparent)] backdrop-blur-sm py-1 shrink-0 relative">
        {/* 拖拽卡片到分类的提示（仅管理员） */}
        {dragAgentKey && isAdmin && (
          <div className="absolute -top-7 left-1/2 -translate-x-1/2 z-20 text-xs text-green-600 bg-green-500/10 border border-green-500/30 rounded-full px-3 py-0.5 whitespace-nowrap animate-pulse">
            拖拽到分类标签上即可移动
          </div>
        )}
        {/* 移动成功提示 */}
        {moveSuccessMsg && (
          <div className="absolute -top-8 left-1/2 -translate-x-1/2 z-20 text-xs text-white bg-green-500 rounded-full px-3 py-1 whitespace-nowrap shadow-lg transition-all">
            ✓ {moveSuccessMsg}
          </div>
        )}
        <div className="marketplace-category-inner flex min-w-0 flex-nowrap items-center gap-2 px-3 sm:gap-4 sm:px-5">
          <ScrollArea className="marketplace-category-scroll min-w-0 flex-1">
            <div className="flex items-center" style={{ gap: `${cal.tagGap}px` }}>
              {(() => {
                const catMap = new Map(categories.map(c => [c.key, c]));
                return visibleCatKeys.filter(k => catMap.has(k)).map((catKey) => {
                  const cat = catMap.get(catKey)!;
                  const isCustom = cat.key.startsWith("custom_cat_");
                  // 查找分类可见性
                  const dbCat = dbCategories.find(c => c.name === cat.key);
                  const catVisibility = dbCat?.visibility || "normal";
                  const displayLabel = getCatLabel(cat.key, cat.label);
                  const displayIcon = getCatIcon(cat.key, cat.icon);
                  const hasCustomIcon = Boolean(catOverrides[cat.key]?.icon && catOverrides[cat.key]?.icon !== cat.icon);
                  const categoryIcon = hasCustomIcon
                    ? undefined
                    : CATEGORY_LUCIDE_ICONS[cat.key as keyof typeof CATEGORY_LUCIDE_ICONS];
                  const CategoryIcon = categoryIcon?.Icon;
                  const isCatDragging = dragCatKey === catKey;
                  const isCatDragOver = dragOverCatKey === catKey;
                  const isAgentDragOverCat = dragAgentToCatOver === catKey;
                  const isVirtualCategory = catKey === "all" || catKey === FAVORITES_CATEGORY;
                  return (
                    <div
                      key={cat.key}
                      className={`group/cat relative transition-all duration-200 ${isCatDragging ? "opacity-40 scale-95" : ""} ${isCatDragOver && editMode && !isVirtualCategory ? "ring-2 ring-[var(--primary)] rounded-lg" : ""} ${isAgentDragOverCat && !isVirtualCategory ? "ring-2 ring-green-500 rounded-lg scale-105 bg-green-500/10" : ""}`}
                      draggable={editMode && isAdmin && !isVirtualCategory && !dragAgentKey}
                      onDragStart={editMode && isAdmin && !isVirtualCategory && !dragAgentKey ? () => handleCatDragStart(catKey) : undefined}
                      onDragOver={(e: React.DragEvent) => {
                        if (isAdmin && dragAgentKey && !isVirtualCategory) {
                          e.preventDefault();
                          setDragAgentToCatOver(catKey);
                        } else if (editMode && isAdmin) {
                          handleCatDragOver(e, catKey);
                        }
                      }}
                      onDragLeave={isAdmin && dragAgentKey && !isVirtualCategory ? () => setDragAgentToCatOver(null) : undefined}
                      onDrop={() => {
                        if (isAdmin && dragAgentKey && !isVirtualCategory) {
                          handleAgentDropOnCategory(catKey);
                        } else if (editMode && isAdmin) {
                          handleCatDrop(catKey);
                        }
                      }}
                      onDragEnd={editMode && isAdmin ? handleCatDragEnd : undefined}
                    >
                      <button
                        data-agent-category={cat.key}
                        aria-pressed={activeCategory === cat.key}
                        onClick={() => {
                          if (displayLabel === "文案提取") {
                            router.push("/extract");
                          } else {
                            setActiveCategory(cat.key);
                            setViewFilter("all");
                          }
                        }}
                        onDoubleClick={(e) => { if (editMode && isAdmin) { e.preventDefault(); e.stopPropagation(); setInlineEdit({ key: cat.key, field: "cat_label", value: displayLabel }); setInlineValue(displayLabel); } }}
                        className={`category-tab whitespace-nowrap flex items-center gap-2 ${
                          activeCategory === cat.key
                            ? "category-tab-active"
                            : "category-tab-default"
                        }`}
                        style={{
                          fontSize: `${Math.max(cal.fontSize, 14)}px`,
                          padding: `${cal.tagPaddingY}px ${Math.max(cal.tagPaddingX, 14)}px`,
                          borderRadius: `${Math.min(Math.max(cal.tagBorderRadius, 8), 12)}px`,
                        }}
                      >
                        <span
                          aria-hidden="true"
                          className="cat-tab-icon inline-flex items-center"
                          style={{ fontSize: `${Math.max(cal.fontSize + 4, 18)}px`, lineHeight: 1, flexShrink: 0 }}
                          onDoubleClick={(e) => { if (editMode && isAdmin) { e.stopPropagation(); setIconPicker({ target: "cat", key: cat.key, current: getCatIcon(cat.key, cat.icon) }); } }}
                        >{CategoryIcon ? <CategoryIcon className="h-[18px] w-[18px]" color={categoryIcon.color} strokeWidth={1.9} /> : displayIcon}</span>
                        {inlineEdit && inlineEdit.key === cat.key && inlineEdit.field === "cat_label" ? (
                          <input
                            autoFocus
                            value={inlineValue}
                            onChange={(e) => setInlineValue(e.target.value)}
                            onBlur={() => { commitInlineEdit(); setInlineEdit(null); }}
                            onKeyDown={(e) => { if (e.key === "Enter") { commitInlineEdit(); setInlineEdit(null); } if (e.key === "Escape") setInlineEdit(null); }}
                            className="bg-transparent border-b-2 border-[var(--primary)] outline-none text-inherit w-auto min-w-[40px] max-w-[120px]"
                            style={{ fontSize: "inherit", fontWeight: "inherit" }}
                          />
                        ) : (
                          <span
                            onDoubleClick={(e) => { if (editMode && isAdmin) { e.stopPropagation(); startInlineEdit(cat.key, "cat_label", displayLabel); } }}
                          >{displayLabel}</span>
                        )}

                        {cat.key === FAVORITES_CATEGORY && favoritesLoaded && (
                          <span className="min-w-5 rounded-full bg-[var(--primary)]/12 px-1.5 text-center text-[11px] font-semibold text-[var(--primary)]" aria-label={`已收藏 ${favoriteAgentIds.size} 个智能体`}>
                            {favoriteAgentIds.size}
                          </span>
                        )}

                        {/* 仅展示分类 — 不显示文字标签，导航栏提供筛选选项 */}
                      </button>
                      {isCustom && isAdmin && (
                        <button
                          onClick={(e) => { e.stopPropagation(); removeCustomCategory(cat.key); }}
                          className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full bg-[var(--destructive)] text-white flex items-center justify-center opacity-0 group-hover/cat:opacity-100 transition-opacity text-[10px] leading-none"
                        >
                          ×
                        </button>
                      )}
                    </div>
                  );
                });
              })()}

              {/* 分类添加入口已移至后台管理（导航栏分类管理），前端不再展示；后台添加的分类通过 dbCategories 自动呈现 */}
            </div>
            <ScrollBar orientation="horizontal" className="invisible" />
          </ScrollArea>
          <div className="marketplace-category-divider h-6 w-px shrink-0 bg-[var(--border)]" />
          <div className="marketplace-search relative w-60 shrink-0">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--muted-foreground)]" />
            <Input
              aria-label="搜索应用"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="搜索应用..."
              className="pl-9 bg-[var(--background)] border-[var(--border)] text-[var(--foreground)] placeholder:text-[var(--muted-foreground)] h-10 rounded-lg text-[14px] focus-visible:ring-[var(--primary)]"
            />
          </div>
        </div>
      </div>}


      {/* 通用"开发中"占位页 — 适用于所有无内容的导航项 */}
      {(() => {
        // 判断当前 view 是否需要显示"开发中"占位页
        if (view === "marketplace") return null;
        // 已有独立页面的导航项不走占位页
        if (["format", "segment", "extract"].includes(view as string)) return null;

        // 收集占位页信息
        let placeholderTitle = "";
        let placeholderIcon = "🛠️";
        let placeholderDesc = "";
        let showDevelopingHint = false; // 只有 developing 状态才显示"开发中"

        if ((view as string).startsWith("cat_")) {
          // 分类导航项
          const catNav = dbCategoryNavDefs.find(n => n.key === view);
          if (catNav) {
            // 如果该分类有智能体了，不走占位页（由应用广场展示）
            const catName = catNav.categoryName;
            const hasAgents = agents.some(a => a.category === catName && (a.user_access !== 'hidden' || learnerPermissionSnapshot.agentIds.has(a.id)));
            if (hasAgents) return null;
            placeholderTitle = catNav.label;
            placeholderIcon = catNav.icon;
            placeholderDesc = catNav.desc;
            showDevelopingHint = true; // 空分类视为开发中
          }
        } else if ((view as string).startsWith("nav_")) {
          // 数据库导航栏项
          const navDef = builtInNavDefs.find(n => n.key === view);
          if (navDef) {
            placeholderTitle = navDef.label;
            placeholderIcon = navDef.icon;
            placeholderDesc = navDef.desc;
            showDevelopingHint = (navDef as any).navStatus === 'developing';
          }
        } else {
          // 内置导航项（cover, create, copywriting 及自定义）
          const allNavDefs = [...builtInNavDefs, ...customNavItems.filter(n => !isReplacedLegacyNavLabel(n.label)).map(n => ({ ...n, group: n.group || "自定义" }))];
          const navDef = allNavDefs.find(n => n.key === view);
          if (navDef) {
            placeholderTitle = navDef.label;
            placeholderIcon = navDef.icon;
            placeholderDesc = navDef.desc;
            showDevelopingHint = (navDef as any).navStatus === 'developing';
          }
        }

        if (!placeholderTitle) return null;

        return (
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center max-w-lg px-6">
              <div className="text-7xl mb-6 animate-float">{placeholderIcon}</div>
              <h2
                className="text-3xl font-bold mb-3 tracking-wide"
                style={{
                  color: "var(--primary)",
                  textShadow: "0 0 30px var(--theme-glow, rgba(22,93,255,0.3))",
                }}
              >
                {placeholderTitle}
              </h2>
              {placeholderDesc && (
                <p className="text-sm leading-relaxed mb-2" style={{ color: "var(--text-secondary)" }}>
                  {placeholderDesc}
                </p>
              )}
              {showDevelopingHint && (
                <p className="text-xs mt-4" style={{ color: "var(--text-secondary)" }}>
                  功能开发中，敬请期待...
                </p>
              )}
            </div>
          </div>
        );
      })()}

      {/* 智能体卡片网格（仅应用广场） */}
      {view === "marketplace" && <div className="marketplace-scroll marketplace-depth flex-1 min-h-0 px-5 overflow-y-auto overflow-x-hidden sm:px-10">
        <div>
        {isLoadingAgents || isLearnerPermissionLoading || (activeCategory === FAVORITES_CATEGORY && !favoritesLoaded && !favoritesError) ? (
          <div className="marketplace-agent-grid grid mx-auto w-full max-w-[1624px]" style={{ ...gridStyle }}>
            {Array.from({ length: responsiveColumns * 2 }).map((_, i) => (
              <div
                key={i}
                className="rounded-2xl p-5 flex overflow-hidden"
                style={{
                  minHeight: cl.cardHeight || 140,
                  background: "rgba(255,255,255,0.04)",
                  border: "1px solid rgba(255,255,255,0.06)",
                  flexDirection: isAvatarTop ? "column" : "row",
                  alignItems: isAvatarTop ? undefined : "center",
                  gap: isAvatarTop ? 8 : cl.gapX || 12,
                }}
              >
                {!isAvatarRight && !isAvatarCorner && (
                  <Skeleton
                    className="shrink-0"
                    style={{
                      width: cl.avatarWidth || cl.avatarSize || 56,
                      height: cl.avatarHeight || cl.avatarSize || 56,
                      borderRadius: cl.avatarRadius === 50 ? '50%' : `${cl.avatarRadius || 14}px`,
                    }}
                  />
                )}
                <div className="flex-1 flex flex-col justify-center gap-2 min-w-0">
                  <Skeleton className="h-5 w-3/5" />
                  <Skeleton className="h-4 w-full" />
                  <Skeleton className="h-4 w-4/5" />
                </div>
              </div>
            ))}
          </div>
        ) : sortedAgents.length === 0 ? (
          <div className="text-center py-20">
            <Sparkles className="w-12 h-12 mx-auto mb-3 text-[var(--muted-foreground)] opacity-30" />
              <p className="text-[var(--text-secondary)]">
               {activeCategory === FAVORITES_CATEGORY && favoritesError && !favoritesLoaded
                 ? "收藏暂时无法读取"
                 : learnerPermissionUnavailable
                ? "智能体权限暂时无法读取"
                : learnerHasNoAgentGrant
                  ? "暂无智能体权限"
                  : activeCategory === FAVORITES_CATEGORY && searchQuery.trim() && favoriteAgentIds.size > 0
                    ? "没有匹配的收藏智能体"
                    : activeCategory === FAVORITES_CATEGORY
                      ? "还没有收藏智能体"
                    : agents.length > 0
                      ? "没有符合当前筛选的智能体"
                      : "暂无智能体"}
            </p>
            {learnerPermissionUnavailable && <p className="mt-2 text-sm text-[var(--muted-foreground)]">请刷新页面重试，权限恢复前不会展示任何智能体。</p>}
            {learnerHasNoAgentGrant && <p className="mt-2 text-sm text-[var(--muted-foreground)]">请联系管理员在“智能体导航栏”中开通可用分类。</p>}
            {activeCategory === FAVORITES_CATEGORY && favoritesError && !favoritesLoaded && (
              <>
                <p className="mt-2 text-sm text-[var(--muted-foreground)]">{favoritesError}。收藏状态确认前不会发送收藏操作。</p>
                <button
                  type="button"
                  className="mt-3 text-sm text-[var(--primary)] underline"
                  onClick={() => void refreshAgentFavorites()}
                  disabled={favoritesStatus === "loading"}
                >
                  {favoritesStatus === "loading" ? "正在重试…" : "重试读取收藏"}
                </button>
              </>
            )}
            {!learnerPermissionUnavailable && !learnerHasNoAgentGrant && activeCategory === FAVORITES_CATEGORY && searchQuery.trim() && favoriteAgentIds.size > 0 && (
              <button className="mt-2 text-sm text-[var(--primary)] underline" onClick={() => setSearchQuery("")}>清除收藏搜索</button>
            )}
            {!learnerPermissionUnavailable && !learnerHasNoAgentGrant && activeCategory === FAVORITES_CATEGORY && !searchQuery.trim() && !favoritesError && <p className="mt-2 text-sm text-[var(--muted-foreground)]">返回全部助手，点击卡片右上角的爱心即可收藏。</p>}
            {!favoritesError && !learnerPermissionUnavailable && !learnerHasNoAgentGrant && agents.length > 0
              ? <button className="mt-2 text-sm text-[var(--primary)] underline" onClick={() => { setActiveCategory('all'); setSearchQuery(''); setViewFilter('all'); }}>重置筛选</button>
              : !favoritesError && !learnerPermissionUnavailable && !learnerHasNoAgentGrant && <p className="text-sm text-[var(--text-secondary)] mt-2">暂无可用智能体，请稍后再来</p>}
          </div>
        ) : (
          <div className="marketplace-agent-grid grid mx-auto w-full max-w-[1624px]" style={{ ...gridStyle }}>
            {sortedAgents.map((agent, idx) => {
              const displayName = getAgentName(agent.id, agent.name);
              const displayDesc = getAgentDesc(agent.id, agent.description || "暂无描述");
              const displayIcon = getAgentIcon(agent.id, agent.iconUrl || "", displayName);
              const displayCover = resolveAvatarUrl(agent.cover_url || "");
              // 头像元素 — 支持非正方形宽高
              const avatarPx = cl.avatarSize || 72;
              const avatarW = cl.avatarWidth || avatarPx;
              const avatarH = cl.avatarHeight || avatarPx;
              const avatarRadiusPx = cl.avatarRadius === 50 ? '50%' : `${cl.avatarRadius}px`;
              const avatarEl = (
                <div className={`marketplace-agent-avatar-wrap relative z-[1] ${isAvatarCorner ? "absolute" : isAvatarTop ? "flex justify-center mb-2" : "shrink-0 flex items-center"}`} style={isAvatarCorner ? {
                  top: cl.avatarPosition.includes("top") ? cl.paddingY : undefined,
                  bottom: cl.avatarPosition.includes("bottom") ? cl.paddingY : undefined,
                  left: cl.avatarPosition.includes("left") ? cl.paddingX : undefined,
                  right: cl.avatarPosition.includes("right") ? cl.paddingX : undefined,
                  zIndex: 2,
                } : !isAvatarTop ? undefined : undefined}>
                  <div
                    className="marketplace-agent-avatar relative group/avatar overflow-hidden shrink-0"
                    style={{
                      width: avatarW,
                      height: avatarH,
                      borderRadius: avatarRadiusPx,
                      background: stringToColor(agent.name),
                      flexShrink: 0,
                    }}
                  >
                    {displayIcon ? (
                      <img
                        src={displayIcon}
                        alt={displayName}
                        width={Math.max(1, Math.round(Number(avatarW) || avatarPx))}
                        height={Math.max(1, Math.round(Number(avatarH) || avatarPx))}
                        loading={idx < MARKETPLACE_EAGER_AVATAR_COUNT ? "eager" : "lazy"}
                        decoding="async"
                        fetchPriority={idx < MARKETPLACE_HIGH_PRIORITY_AVATAR_COUNT ? "high" : "auto"}
                        draggable={false}
                        onError={(e) => {
                          const img = e.target as HTMLImageElement;
                          if (img.dataset.semanticFallback !== "1") {
                            img.dataset.semanticFallback = "1";
                            img.src = getSemanticAgentAvatarFallback(agent.id, displayName);
                            return;
                          }
                          img.style.display = 'none';
                          const fallback = img.nextElementSibling as HTMLElement | null;
                          if (fallback) fallback.style.display = 'flex';
                        }}
                        style={{
                          width: '100%',
                          height: '100%',
                          objectFit: 'cover',
                          borderRadius: avatarRadiusPx,
                          display: 'block',
                        }}
                      />
                    ) : null}
                    {/* 文字首字母回退 — displayIcon 有值时隐藏，img 加载失败时显示 */}
                    <div
                      style={{
                        width: '100%',
                        height: '100%',
                        borderRadius: avatarRadiusPx,
                        backgroundColor: stringToColor(agent.name),
                        color: '#fff',
                        fontSize: `${Math.max(12, Math.min(avatarW, avatarH) * 0.38)}px`,
                        fontWeight: 600,
                        display: displayIcon ? 'none' : 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                    >
                      {displayName[0]}
                    </div>
                    {isAdmin && editMode && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setAvatarEdit({
                            agentId: agent.id,
                            name: displayName,
                            description: displayDesc,
                            iconUrl: agentOverrides[agent.id]?.iconUrl ?? agent.iconUrl ?? "",
                          });
                        }}
                        className="absolute inset-0 flex items-center justify-center bg-black/50 opacity-0 group-hover/avatar:opacity-100 transition-opacity cursor-pointer"
                        style={{ borderRadius: avatarRadiusPx }}
                        title="点击编辑"
                      >
                        <Pencil className="w-4 h-4 text-white" />
                      </button>
                    )}
                  </div>
                </div>
              );

              // 文字元素
              const textEl = (
                <div className={`marketplace-agent-copy relative z-[1] ${isAvatarTop ? "w-full text-center" : "flex-1 overflow-hidden"}`} style={{
                  transform: `translate(${cl.textOffsetX || 0}px, ${cl.textOffsetY || 0}px)`,
                  paddingTop: isAvatarCorner && cl.avatarPosition.includes("top") ? (avatarH + 8) : undefined,
                  paddingBottom: isAvatarCorner && cl.avatarPosition.includes("bottom") ? (avatarH + 8) : undefined,
                  paddingLeft: isAvatarCorner && cl.avatarPosition.includes("left") ? (avatarW + 8) : undefined,
                  paddingRight: Math.max(
                    isAvatarCorner && cl.avatarPosition.includes("right") ? (avatarW + 8) : 0,
                    FAVORITE_HEART_CLEARANCE_PX,
                  ),
                }}>
                  <h3
                    className="marketplace-agent-title truncate leading-snug"
                    style={{
                      fontFamily: cl.titleFontFamily ? (getTitleFontFamily(cl.titleFontFamily) || CARD_TITLE_FONT_FAMILY) : CARD_TITLE_FONT_FAMILY,
                      fontSize: `${cl.titleFontSize}px`,
                      fontWeight: cl.titleFontWeight,
                      color: cl.titleColor || "var(--foreground)",
                      letterSpacing: `${cl.titleLetterSpacing || 0}px`,
                      transform: `translate(${cl.titleOffsetX || 0}px, ${cl.titleOffsetY || 0}px)`,
                    }}
                  >
                    {displayName}
                  </h3>
                  <p
                    className={`marketplace-agent-description ${isAvatarTop ? "mt-1" : "mt-1"}`}
                    style={{
                      fontSize: `${cl.descFontSize}px`,
                      fontWeight: cl.descFontWeight,
                      color: cl.descColor || "var(--text-secondary)",
                      letterSpacing: `${cl.descLetterSpacing || 0}px`,
                      lineHeight: `${cl.descLineHeight || 1.5}`,
                      ...(cl.descMaxLines > 0 ? {
                        display: "-webkit-box",
                        WebkitLineClamp: cl.descMaxLines,
                        WebkitBoxOrient: "vertical",
                        overflow: "hidden",
                      } : {}),
                    }}
                  >
                    {displayDesc}
                  </p>
                </div>
              );

              const isAgentDragging = dragAgentKey === agent.id;
              const isAgentDragOver = dragOverAgentKey === agent.id;
              const needsModel = isUnboundCatalogAgent(agent);
              const isDisabled = needsModel || (!agent.is_active && !isAdmin);
              const isInactive = !agent.is_active; // 智能体未启用
              const isViewOnly = isAgentViewOnlyForUser(agent); // 用户可见但不可用（智能体级或分类级）
              const isCardDisabled = isDisabled || isViewOnly;
              const activateAgent = () => {
                if (isCardDisabled) {
                  if (needsModel) toast.warning("该智能体尚未配置可用模型");
                  else if (isViewOnly) toast.warning("该智能体仅展示，暂不可用");
                  else if (isDisabled) toast.warning("该智能体正在开发中，暂不可用");
                  return;
                }
                handleSelectAgent(agent.id);
              };
              return (
                <div
                  key={agent.id}
                  data-agent-card-id={agent.id}
                  data-agent-display-category={displayCategory(agent)}
                  className={`group/agent relative overflow-hidden select-none ${idx < MARKETPLACE_ANIMATED_CARD_COUNT ? "animate-card-enter" : ""} ${isAgentDragging ? "opacity-40 scale-95" : ""} ${isAgentDragOver && editMode && isAdmin ? "ring-2 ring-[var(--primary)] ring-offset-1 rounded-xl" : ""}`}
                  style={{ animationDelay: idx < MARKETPLACE_ANIMATED_CARD_COUNT ? `${idx * 0.04}s` : undefined, touchAction: 'manipulation' }}
                  {...(editMode && isAdmin ? {
                    draggable: true,
                    onDragStart: () => handleAgentDragStart(agent.id),
                    onDragOver: (e: React.DragEvent) => handleAgentDragOver(e, agent.id),
                    onDrop: () => handleAgentDrop(agent.id),
                    onDragEnd: handleAgentDragEnd,
                  } : {})}
                >
                  {/* 拖拽手柄 — 编辑模式 */}
                  {editMode && isAdmin && (
                    <div className="absolute -top-1 left-1/2 -translate-x-1/2 z-10 opacity-0 group-hover/agent:opacity-100 transition-opacity cursor-grab active:cursor-grabbing">
                      <div className="flex flex-col items-center gap-[2px] bg-[var(--card)] border border-[var(--border)] rounded px-1 py-0.5 shadow-sm">
                        <span className="w-1.5 h-1.5 rounded-full bg-[var(--muted-foreground)]" />
                        <span className="w-1.5 h-1.5 rounded-full bg-[var(--muted-foreground)]" />
                        <span className="w-1.5 h-1.5 rounded-full bg-[var(--muted-foreground)]" />
                      </div>
                    </div>
                  )}
                  {/* 编辑模式下显示分类标签，可拖拽到分类移动 */}
                  {(editMode && isAdmin) && (
                    <div className="absolute top-1 left-1 z-10 opacity-0 group-hover/agent:opacity-100 transition-opacity">
                      <span className="text-[10px] bg-[var(--primary)]/15 text-[var(--primary)] border border-[var(--primary)]/20 rounded px-1.5 py-0.5 whitespace-nowrap">
                        {agent.category || "未分类"}
                      </span>
                    </div>
                  )}

                  <button
                    type="button"
                    data-agent-favorite-toggle={agent.id}
                    aria-pressed={favoriteAgentIds.has(agent.id)}
                    aria-busy={favoritePendingAgentIds.has(agent.id) || undefined}
                    disabled={!favoritesLoaded || favoritePendingAgentIds.has(agent.id)}
                    aria-label={`${favoriteAgentIds.has(agent.id) ? "取消收藏" : "收藏"}${displayName}`}
                    title={favoriteAgentIds.has(agent.id) ? "取消收藏" : "收藏到我的收藏"}
                    onClick={(event) => {
                      event.stopPropagation();
                      if (!favoritesLoaded) {
                        void refreshAgentFavorites();
                        return;
                      }
                      void toggleAgentFavorite(agent.id).catch(() => undefined);
                    }}
                    className={`absolute right-2 top-2 z-30 inline-flex h-8 w-8 items-center justify-center rounded-lg border shadow-sm backdrop-blur-sm transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary)] ${favoriteAgentIds.has(agent.id)
                      ? "border-rose-400/45 bg-rose-500/18 text-rose-400 hover:bg-rose-500/28"
                      : "border-[var(--border)] bg-[var(--card)]/88 text-[var(--muted-foreground)] hover:border-rose-400/45 hover:text-rose-400"
                    }`}
                  >
                    <Heart className="h-4 w-4" fill={favoriteAgentIds.has(agent.id) ? "currentColor" : "none"} aria-hidden="true" />
                  </button>

                  <div
                    data-agent-cover-url={displayCover || undefined}
                    onClick={(e) => {
                      if (editMode && isAdmin) { e.stopPropagation(); return; }
                      activateAgent();
                    }}
                    onKeyDown={(event) => {
                      if (event.key !== "Enter" && event.key !== " ") return;
                      event.preventDefault();
                      if (editMode && isAdmin) return;
                      activateAgent();
                    }}
                    role="button"
                    tabIndex={editMode && isAdmin ? -1 : isCardDisabled ? -1 : 0}
                    aria-disabled={isCardDisabled || undefined}
                    aria-label={`打开智能体：${displayName}`}
                    className={`${isCardDisabled ? "cursor-not-allowed" : "cursor-pointer"} agent-card-hover select-none flex relative overflow-hidden`}
                    style={{
                      // 固定高度，所有卡片尺寸一致
                      height: cl.cardHeight > 0
                        ? `var(--marketplace-card-height, ${cl.cardHeight}px)`
                        : "var(--marketplace-card-height, auto)",
                      borderRadius: `${cl.borderRadius}px`,
                      padding: `${cl.paddingY}px ${cl.paddingX}px`,
                      flexDirection: isAvatarTop ? "column" : "row",
                      alignItems: isAvatarTop ? undefined : "center",
                      touchAction: 'manipulation',
                      gap: isAvatarTop ? 0 : (cl.gapX || 12),
                      position: isAvatarCorner ? "relative" : undefined,
                      backgroundColor: cl.cardBg || `color-mix(in srgb, var(--card) ${cl.opacity ?? 72}%, transparent)`,
                      color: "var(--card-foreground)",
                      border: "1px solid color-mix(in srgb, var(--foreground) 8%, transparent)",
                      filter: isInactive && !isAdmin ? "grayscale(60%) brightness(0.85)" : isInactive && isAdmin ? "none" : "none",
                      opacity: isDisabled ? 0.55 : 1,
                    }}
                  >
                    {displayCover && (
                      <>
                        <img
                          src={displayCover}
                          alt=""
                          aria-hidden="true"
                          loading="lazy"
                          decoding="async"
                          draggable={false}
                          className="pointer-events-none absolute inset-0 z-0 h-full w-full object-cover opacity-30"
                          onError={(event) => { event.currentTarget.style.display = "none"; }}
                        />
                        <div
                          aria-hidden="true"
                          className="pointer-events-none absolute inset-0 z-0"
                          style={{ background: "linear-gradient(90deg, color-mix(in srgb, var(--card) 82%, transparent), color-mix(in srgb, var(--card) 58%, transparent))" }}
                        />
                      </>
                    )}
                    {isAvatarLeft && avatarEl}
                    {textEl}

                    {(isAvatarRight || isAvatarTop) && avatarEl}
                    {isAvatarCorner && avatarEl}

                    {/* 正在开发中遮罩 — 非管理员视角 */}
                    {isDisabled && (
                      <div className="absolute inset-0 flex items-center justify-center rounded-[inherit] bg-black/20 backdrop-blur-[1px] z-10">
                        <div className="bg-black/70 backdrop-blur-sm text-white text-xs font-medium px-3 py-1.5 rounded-full flex items-center gap-1.5 shadow-lg">
                          <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
                          {needsModel ? "待配置模型" : "正在开发中"}
                        </div>
                      </div>
                    )}



                    {/* 管理员看到的未启用标识 */}
                    {isInactive && isAdmin && !needsModel && (
                      <div className="absolute top-1.5 right-11 z-10 bg-amber-500/90 text-white text-[10px] font-medium px-1.5 py-0.5 rounded-full">
                        未启用
                      </div>
                    )}

                  </div>
                </div>
              );
            })}
          </div>
        )}
        </div>
        {/* ICP 备案号 - 已隐藏 */}
      </div>}

      {/* 预设配置弹窗 */}
      {bipIntakeAgentId && <BusinessIpIntake key={bipIntakeAgentId} agentId={bipIntakeAgentId} open onClose={()=>setBipIntakeAgentId(null)} onSkip={()=>{startConversation(bipIntakeAgentId);setBipIntakeAgentId(null);}} onPrepare={async(text,meta)=>{
        const preparedConversationId=`local_${Date.now()}_${Math.random().toString(36).slice(2,8)}`;
        if(meta?.businessProfileId){
          if(!auth.token)throw new Error('请先登录，再进入小助理');
          const response=await fetch('/api/business-ip/profiles',{
            method:'PUT',
            headers:{Authorization:`Bearer ${auth.token}`,'Content-Type':'application/json'},
            body:JSON.stringify({id:meta.businessProfileId,activate:true,conversation_id:preparedConversationId}),
          });
          const data=await response.json().catch(()=>({}));
          if(!response.ok)throw new Error(data.error||'业务资料绑定失败，请重试');
        }
        const created=startConversation(bipIntakeAgentId,{businessBrief:text},bipIntakeAgentId===BIP_STEPS[0].id,preparedConversationId);
        if(!created){
          if(meta?.businessProfileId&&auth.token){
            await fetch('/api/business-ip/profiles',{
              method:'PUT',
              headers:{Authorization:`Bearer ${auth.token}`,'Content-Type':'application/json'},
              body:JSON.stringify({unbind:true,conversation_id:preparedConversationId}),
            }).catch(()=>null);
          }
          throw new Error('新对话创建失败，请重试');
        }
        setBipIntakeAgentId(null);
      }} />}
      {presetAgent && (
        <PresetDialog
          agentId={presetAgent.id}
          agentName={presetAgent.name}
          agentIconUrl={presetAgent.iconUrl}
          fields={presetAgent.presetFields}
          onStart={handlePresetStart}
          onSkip={handlePresetSkip}
          onClose={handlePresetClose}
        />
      )}

      {/* 可视化布局编辑器 — 仅管理员编辑模式 */}
      {isAdmin && editMode && (
        <LayoutEditor
          layout={layoutConfig}
          onChange={(newLayout) => dispatch({ type: "SET_LAYOUT_CONFIG", payload: newLayout })}
          onSave={async () => { await saveLayoutConfig(layoutConfig); }}
          onReset={async () => { await resetLayoutConfig(); }}
          onClose={() => dispatch({ type: "TOGGLE_EDIT_MODE" })}
        />
      )}

      {/* 图标选择弹窗（双击导航/分类图标时弹出） */}
      <Dialog open={!!iconPicker} onOpenChange={(open: boolean) => { if (!open) setIconPicker(null); }}>
        <DialogContent className="sm:max-w-[440px] max-h-[70vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>选择图标</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            {ICON_GROUPS.map((group) => (
              <div key={group.label}>
                <div className="text-xs font-medium text-[var(--text-secondary)] mb-1.5">{group.label}</div>
                <div className="flex flex-nowrap gap-1.5 overflow-x-auto">
                  {group.icons.map((emoji) => (
                    <button
                      key={emoji}
                      onClick={() => {
                        if (!iconPicker) return;
                        const overrides = iconPicker.target === "nav" ? navOverrides : catOverrides;
                        const setOverrides = iconPicker.target === "nav" ? setNavOverrides : setCatOverrides;
                        const storageKey = iconPicker.target === "nav" ? "nav_overrides" : "cat_overrides";
                        const updated = { ...overrides };
                        updated[iconPicker.key] = { ...updated[iconPicker.key], icon: emoji };
                        setOverrides(updated);
                        localStorage.setItem(storageKey, JSON.stringify(updated));
                        setIconPicker(null);
                      }}
                      className={`w-9 h-9 rounded-lg flex items-center justify-center text-lg transition-all ${
                        iconPicker?.current === emoji ? "bg-[var(--primary)] text-[var(--primary-foreground)] scale-110" : "bg-[var(--muted)] hover:bg-[var(--primary)]/20"
                      }`}
                    >
                      {emoji}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
          <DialogFooter>
            <DialogClose asChild>
              <button className="px-4 py-2 rounded-lg text-sm text-[var(--muted-foreground)] hover:bg-[var(--muted)]">取消</button>
            </DialogClose>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 头像编辑弹窗（点击智能体头像时弹出） */}
      <Dialog open={!!avatarEdit} onOpenChange={(open: boolean) => { if (!open) setAvatarEdit(null); }}>
        <DialogContent className="sm:max-w-[420px]">
          <DialogHeader>
            <DialogTitle>编辑智能体</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="flex items-center gap-3">
              <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-[var(--primary)] to-[var(--primary)]/60 flex items-center justify-center text-white text-lg font-bold shrink-0 overflow-hidden">
                {avatarEdit?.iconUrl ? (
                  <img src={resolveAvatarUrl(avatarEdit.iconUrl)} alt="" className="w-full h-full object-cover" onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }} />
                ) : "AI"}
              </div>
              <div className="text-sm text-[var(--text-secondary)]">点击下方修改头像和文字</div>
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium text-[var(--foreground)]">智能体名称</label>
              <input
                value={avatarEdit?.name || ""}
                onChange={(e) => setAvatarEdit(prev => prev ? { ...prev, name: e.target.value } : null)}
                placeholder="输入智能体名称"
                className="w-full px-3 py-2 rounded-lg border border-[var(--border)] bg-[var(--card)] text-[var(--foreground)] text-sm focus:outline-none focus:ring-2 focus:ring-[var(--primary)]"
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium text-[var(--foreground)]">描述</label>
              <input
                value={avatarEdit?.description || ""}
                onChange={(e) => setAvatarEdit(prev => prev ? { ...prev, description: e.target.value } : null)}
                placeholder="输入智能体描述"
                className="w-full px-3 py-2 rounded-lg border border-[var(--border)] bg-[var(--card)] text-[var(--foreground)] text-sm focus:outline-none focus:ring-2 focus:ring-[var(--primary)]"
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium text-[var(--foreground)]">头像图标</label>
              <div className="flex items-center gap-3">
                <label className="cursor-pointer inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-[var(--primary)] text-[var(--primary-foreground)] text-sm hover:opacity-90 transition-opacity">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M17 8l-5-5-5 5M12 3v12" /></svg>
                  {avatarEdit?.iconUrl ? "更换图片" : "上传图片"}
                  <input type="file" accept="image/png,image/jpeg,image/gif,image/webp" className="hidden" onChange={async (e) => {
                    const file = e.target.files?.[0];
                    if (!file) return;
                    if (file.size > 2 * 1024 * 1024) return;
                    try {
                      const formData = new FormData();
                      formData.append("file", file);
                      const res = await fetch("/api/upload", { method: "POST", body: formData });
                      const data = await res.json();
                      if (data.success) {
                        setAvatarEdit(prev => prev ? { ...prev, iconUrl: data.url } : null);
                      }
                    } catch {}
                  }} />
                </label>
                {avatarEdit?.iconUrl && (
                  <button onClick={() => setAvatarEdit(prev => prev ? { ...prev, iconUrl: "" } : null)} className="text-xs text-[var(--muted-foreground)] hover:text-[var(--destructive)]">移除</button>
                )}
              </div>
            </div>
          </div>
          <DialogFooter>
            <DialogClose asChild>
              <button className="px-4 py-2 rounded-lg text-sm text-[var(--muted-foreground)] hover:bg-[var(--muted)]">取消</button>
            </DialogClose>
            <button
              onClick={() => {
                if (!avatarEdit) return;
                const updated = { ...agentOverrides };
                updated[avatarEdit.agentId] = { ...updated[avatarEdit.agentId], iconUrl: avatarEdit.iconUrl, name: avatarEdit.name, description: avatarEdit.description };
                setAgentOverrides(updated);
                localStorage.setItem(STORAGE_KEYS.AGENT_DISPLAY_OVERRIDES, JSON.stringify(updated));
                saveUIPrefs({ [STORAGE_KEYS.AGENT_DISPLAY_OVERRIDES]: updated });
                setAvatarEdit(null);
              }}
              className="px-4 py-2 rounded-lg text-sm bg-[var(--primary)] text-[var(--primary-foreground)] hover:opacity-90"
            >
              保存
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function stringToColor(str: string): string {
  const colors = ["#165DFF", "#00A3FF", "#9C6ADE", "#FFB020", "#E06C75", "#4CAF50", "#FF6B9D", "#5C6BC0"];
  let hash = 0;
  for (let i = 0; i < str.length; i++) hash = str.charCodeAt(i) + ((hash << 5) - hash);
  return colors[Math.abs(hash) % colors.length];
}
