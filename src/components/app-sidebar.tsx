"use client";

import { useApp } from "@/contexts/app-context";
import { toast } from "sonner";
import {
  MessageSquare,
  Settings,
  LogOut,
  User,
  ChevronDown,
  KeyRound,
  Shield,
  Plus,
  LayoutGrid,
  Film,
  Palette,
  FileSearch,
  PenTool,
  ArrowDownUp,
  Bell
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { UserThemeSwitcher } from "@/components/user-theme-switcher";
import { ToolboxMenu } from "@/components/toolbox-menu";
import { resolveAgentAvatarUrl, resolveAvatarUrl } from "@/lib/utils";
import { getSemanticAgentAvatarFallback } from "@/lib/agent-avatar-aliases";
import {
  handlePlatformBrandLogoError,
  platformBrandLogoUrl,
  usePlatformBranding,
} from "@/hooks/use-platform-branding";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { PresetDialog } from "@/components/preset-dialog";
import type { PresetField } from "@/types/coze";
import { useRouter, usePathname } from "next/navigation";
import { useState, useEffect, useRef, useCallback, useMemo, type CSSProperties, type SyntheticEvent } from "react";
import { getPrimaryNavigationLabelForRoute, requestMarketplaceShowAll } from "@/lib/marketplace-navigation";
import { featurePermissionForPath } from "@/lib/member-permissions";
import { useMemberPermissions } from "@/components/member-permission-boundary";
import { MANGA_WORKBENCH_AGENT_ID } from "@/lib/virtual-chat-agents";

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

function BrandMark({
  src,
  fallbackText,
  onError,
}: {
  src?: string;
  fallbackText: string;
  onError: (event: SyntheticEvent<HTMLImageElement>) => void;
}) {
  if (!src) return <span aria-hidden="true">{fallbackText.slice(0, 1)}</span>;
  return (
    <img
      src={src}
      alt=""
      className="h-full w-full scale-[1.025] object-cover"
      onError={onError}
    />
  );
}

// 平台品牌只从后台品牌中心读取。侧栏不再维护一份浏览器本地副本，
// 避免管理员在这里改名/换图后只对当前浏览器生效、刷新或换设备丢失。
function SidebarProfile() {
  const platformBranding = usePlatformBranding();
  const platformLogoUrl = platformBrandLogoUrl(platformBranding, "square");
  const displayName = platformBranding.brand.name
    || (platformBranding.displayScope === "white_label" ? "品牌服务" : "自媒体操盘手");
  const publishedWechat = platformBranding.brand.contact.wechat.trim();
  const displaySubtitle = publishedWechat
    ? `微信：${publishedWechat}`
    : platformBranding.brand.slogan
    || platformBranding.brand.description
    || "AI 内容经营系统";

  return (
    <div
      data-testid="sidebar-platform-brand"
      className="sidebar-brand-card mt-0 px-3 rounded-none"
    >
      <div className="flex items-center gap-3">
        <Avatar className="ring-2 ring-[var(--sb-primary)]/30" style={{ width: `calc(40px * var(--sidebar-scale, 1))`, height: `calc(40px * var(--sidebar-scale, 1))`, minWidth: '32px', minHeight: '32px' }}>
          <AvatarFallback className="bg-transparent p-0 text-white" style={{ fontSize: `calc(16px * var(--sidebar-scale, 1))` }}>
            <BrandMark
              src={platformLogoUrl}
              fallbackText={displayName}
              onError={(event) => handlePlatformBrandLogoError(event, platformBranding)}
            />
          </AvatarFallback>
        </Avatar>
        <div className="flex-1 min-w-0">
          <div className="font-bold text-[clamp(14px,calc(15px*var(--sidebar-scale,1)),18px)] text-[var(--foreground)] truncate leading-tight">
            {displayName}
          </div>
          <div
            className="text-[clamp(11px,calc(12px*var(--sidebar-scale,1)),14px)] text-[var(--text-secondary)] truncate mt-0.5"
            title={displaySubtitle}
          >
            {displaySubtitle}
          </div>
        </div>
      </div>
    </div>
  );
}

export function AppSidebar({ isMobile, onNavigate }: { isMobile?: boolean; onNavigate?: () => void }) {
  const { state, dispatch, selectConversation, startChat, startFreeChat, setPendingPresetMessage, logout } = useApp();
  const memberPermission = useMemberPermissions();
  const router = useRouter();
  const pathname = usePathname();
  const [historyMenu, setHistoryMenu] = useState<string | null>(null);

  // Keep the current task visible; opening recharge is an explicit user action.
  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ mode?: string; message?: string }>).detail;
      const title = detail?.mode === "cash" ? "现金余额不足" : "积分不足";
      toast.error(title, {
        id: "insufficient-balance",
        description: detail?.message || "请充值后重新提交，当前任务会保留。",
        duration: 10000,
        action: { label: "去充值", onClick: () => router.push("/profile?tab=cami") },
      });
    };
    window.addEventListener("insufficient-balance", handler);
    return () => window.removeEventListener("insufficient-balance", handler);
  }, [router]);

  // 监听会员未激活/已过期事件，跳转个人中心卡密兑换
  useEffect(() => {
    const handler = () => router.push("/profile?tab=cami");
    window.addEventListener("membership-required", handler);
    return () => window.removeEventListener("membership-required", handler);
  }, [router]);


  const [presetAgent, setPresetAgent] = useState<{ id: string; name: string; iconUrl: string; presetFields: PresetField[] } | null>(null);
  // History uses one fixed desktop layout. Keep the scale stable so an
  // administrator cannot accidentally push the delete action over the title.
  const sidebarFontSize = 1.1;

  const { agents, conversations, activeConversationId, pinnedAgentIds, auth, view } = state;
  const user = auth?.user;
  const isAdmin = user?.role === 'admin';
  const grantedFeatureKeys = useMemo(
    () => new Set(memberPermission.snapshot?.featureNavigationKeys || []),
    [memberPermission.snapshot?.featureNavigationKeys],
  );
  const canUseMarketplace = Boolean(
    memberPermission.status === "ready" && grantedFeatureKeys.has("marketplace")
  );
  const visibleConversations = [...conversations]
    .filter((conv) => {
      if (!canUseMarketplace) return false;
      if (!conv.id || conv.source === "video") return false;
      // 漫剧工作台对话使用同一账号持久化，但只在 /youcai 分支内展示。
      if (conv.agentId === MANGA_WORKBENCH_AGENT_ID) return false;
      if (conv.lastMessage?.trim()) return true;
      return conv.messages.some((message) =>
        message.role === "assistant" &&
        Boolean(message.content?.trim() || message.reasoningContent?.trim() || message.generatedImages?.length)
      );
    })
    .sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0));
  const formatConversationTime = (timestamp?: number) => {
    if (!timestamp) return "";
    const date = new Date(timestamp);
    if (Number.isNaN(date.getTime())) return "";
    const clock = date.toLocaleTimeString("zh-CN", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    return `${date.getMonth() + 1}.${date.getDate()} ${clock}`;
  };

  const pinnedAgents = agents.filter((a) => {
    if (!canUseMarketplace) return false;
    if (a.id === "__free_chat__") return false; // 排除虚拟自由对话智能体
    if (!pinnedAgentIds.includes(a.id)) return false;
    // 非管理员过滤隐藏的智能体（无权限分类的智能体已在后端过滤）
    if (!isAdmin && a.user_access === "hidden") return false;
    return true;
  });

  // ── 快捷图标：从后端动态加载 ──
  interface ShortcutItem {
    id: string;
    title: string;
    icon_svg: string;
    icon_color: string;
    link_type: string;
    link_value: string;
  }
  const MEDIA_HISTORY_SHORTCUT: ShortcutItem = {
    id: "media-history",
    title: "作品历史",
    icon_svg: '<path d="M3 3v5h5"/><path d="M3.05 13a9 9 0 1 0 .5-5.5"/><path d="M12 7v5l3 2"/>',
    icon_color: "#3b82f6",
    link_type: "internal",
    link_value: "/media-history",
  };
  const TOOLBOX_SHORTCUT: ShortcutItem = {
    id: "toolbox",
    title: "效率工具",
    icon_svg: '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.8-3.8a6 6 0 0 1-7.9 7.9l-6.9 6.9a2.1 2.1 0 0 1-3-3l6.9-6.9a6 6 0 0 1 7.9-7.9l-3.8 3.8z"/>',
    icon_color: "#22c55e",
    link_type: "internal",
    link_value: "/tools",
  };
  const STORYBOARD_WORKBENCH_SHORTCUT: ShortcutItem = {
    id: "storyboard-workbench",
    title: "分镜编排",
    icon_svg: '<path d="M4 11h16v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z"/><path d="M4 11 6.5 5H10l-2.5 6M10 11l2.5-6H16l-2.5 6M16 11l2.5-6H20"/><path d="M4 5h16"/>',
    icon_color: "#f59e0b",
    link_type: "internal",
    link_value: "/storyboard-workbench",
  };
  const YOUCAI_STUDIO_SHORTCUT: ShortcutItem = {
    id: "youcai-studio",
    title: "漫剧创作",
    icon_svg: '<path d="m12 3-1.2 3.5a3 3 0 0 1-1.9 1.9L5.4 9.6l3.5 1.2a3 3 0 0 1 1.9 1.9L12 16.2l1.2-3.5a3 3 0 0 1 1.9-1.9l3.5-1.2-3.5-1.2a3 3 0 0 1-1.9-1.9z"/><path d="m18.5 15-.7 2a2 2 0 0 1-1.3 1.3l-2 .7 2 .7a2 2 0 0 1 1.3 1.3l.7 2 .7-2a2 2 0 0 1 1.3-1.3l2-.7-2-.7a2 2 0 0 1-1.3-1.3z"/>',
    icon_color: "#8b5cf6",
    link_type: "internal",
    link_value: "/youcai",
  };
  const COVER_STUDIO_SHORTCUT: ShortcutItem = {
    id: "cover-studio",
    title: "封面设计",
    icon_svg: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/>',
    icon_color: "#ec4899",
    link_type: "internal",
    link_value: "/cover",
  };
  const COMMERCE_AGENT_SHORTCUT: ShortcutItem = {
    id: "commerce-agent",
    title: "带货创作",
    icon_svg: '<path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/><path d="M3 6h18"/><path d="M16 10a4 4 0 0 1-8 0"/>',
    icon_color: "#f97316",
    link_type: "internal",
    link_value: "/commerce",
  };
  const isFormatterShortcut = (item: ShortcutItem) => {
    const title = repairMojibake(item.title);
    return item.link_value === "/formatter" || title === "格式" || title === "格式去除";
  };
  const isSegmentShortcut = (item: ShortcutItem) => {
    const title = repairMojibake(item.title);
    return item.link_value === "/segmenter" || title === "智能分段" || title === "分段工具";
  };
  const isExtractShortcut = (item: ShortcutItem) => {
    const title = repairMojibake(item.title);
    return item.id === "copy-extract" || item.link_value === "/tools?tab=text" || item.link_value === "/extract" || title === "文案提取" || title === "视频提取" || title === "视频文案提取" || title === "网页提取";
  };
  const isToolboxShortcut = (item: ShortcutItem) =>
    item.id === "toolbox" || item.link_value === "/tools" || ["工具箱", "效率工具"].includes(repairMojibake(item.title));
  const isVideoShortcut = (item: ShortcutItem) => {
    const title = repairMojibake(item.title);
    return item.link_value === "/video" || title === "视频制作" || title === "视频工坊" || title === "视频创作";
  };
  const isShortDramaShortcut = (item: ShortcutItem) => {
    const title = repairMojibake(item.title);
    return item.id === "short-drama" || item.link_value === "/short-drama" || title === "影视工坊" || title === "短剧工坊";
  };
  const isYoucaiStudioShortcut = (item: ShortcutItem) => {
    const title = repairMojibake(item.title);
    return item.id === "youcai-studio" || item.link_value === "/youcai" || title === "漫剧工作台" || title === "漫剧创作" || title === "有彩创作" || title === "有彩视界";
  };
  const isImageWorkbenchShortcut = (item: ShortcutItem) => {
    const title = repairMojibake(item.title);
    return (
    item.link_value === "/image-workbench" ||
      title === "AI生图工作台" ||
      title === "3D动画工作流" ||
      title === "3D动画"
    );
  };
  const isStoryboardWorkbenchShortcut = (item: ShortcutItem) => {
    const title = repairMojibake(item.title);
    return item.id === "storyboard-workbench" || item.link_value === "/storyboard-workbench" || title === "分镜工作台" || title === "分镜编排";
  };
  const isLegacyFreeCanvasShortcut = (item: ShortcutItem) => {
    const title = repairMojibake(item.title);
    return item.link_value === "/free-canvas" || title === "自由画布";
  };
  const isDigitalHumanShortcut = (item: ShortcutItem) => {
    const title = repairMojibake(item.title);
    return item.link_value === "/digital-human" || title === "AI数字人" || title === "Users AI数字人";
  };
  const isRetiredExternalWorkbenchShortcut = (item: ShortcutItem) => {
    const title = repairMojibake(item.title);
    const compactTitle = title.replace(/\s+/g, "").toLowerCase();
    const legacyCode = ["a", "i", "d"].join("");
    const manju = ["漫", "剧"].join("");
    return (
      item.id === `${legacyCode}-studio` ||
      item.link_value === `/${legacyCode}` ||
      item.link_value === `${legacyCode}-launch` ||
      compactTitle.includes(legacyCode) ||
      compactTitle.includes(`ai${manju}`) ||
      compactTitle.includes(`${manju}工作台`) ||
      compactTitle.includes(`${manju}平台`)
    );
  };
  const isMediaHistoryShortcut = (item: ShortcutItem) =>
    item.id === "media-history" || item.link_value === "/media-history" || repairMojibake(item.title) === "作品历史";
  const isCoverStudioShortcut = (item: ShortcutItem) =>
    item.id === "cover-studio" || item.link_value === "/cover" || ["封面制作", "封面设计"].includes(repairMojibake(item.title));
  const isCommerceAgentShortcut = (item: ShortcutItem) =>
    item.id === "commerce-agent" || item.link_value === "/commerce" || ["带货agent", "带货创作"].includes(repairMojibake(item.title).replace(/\s+/g, "").toLowerCase());
  const isAgentShortcut = (item: ShortcutItem) =>
    item.id === "fb4" ||
    item.link_value === "/agents" ||
    item.link_value === "agents" ||
    item.title.toLowerCase() === "agent" ||
    item.title.includes("\u667a\u80fd\u4f53");
  const normalizeShortcuts = (items: ShortcutItem[]) => {
    const next = items.filter((item) =>
      !isFormatterShortcut(item) &&
      !isSegmentShortcut(item) &&
      !isExtractShortcut(item) &&
      !isToolboxShortcut(item) &&
      !isShortDramaShortcut(item) &&
      !isYoucaiStudioShortcut(item) &&
      !isAgentShortcut(item) &&
      !isImageWorkbenchShortcut(item) &&
      !isStoryboardWorkbenchShortcut(item) &&
      !isDigitalHumanShortcut(item) &&
      !isRetiredExternalWorkbenchShortcut(item) &&
      !isLegacyFreeCanvasShortcut(item) &&
      !isMediaHistoryShortcut(item) &&
      !isCoverStudioShortcut(item) &&
      !isCommerceAgentShortcut(item)
    );
    const marketplaceIndex = next.findIndex((item) =>
      item.link_value === "marketplace" || repairMojibake(item.title) === "应用广场"
    );
    next.splice(marketplaceIndex >= 0 ? marketplaceIndex + 1 : 0, 0, MEDIA_HISTORY_SHORTCUT);
    const imageInsertAfter = next.findIndex(isVideoShortcut);
    const creativeInsertIndex = imageInsertAfter >= 0 ? imageInsertAfter + 1 : next.length;
    next.splice(
      creativeInsertIndex,
      0,
      YOUCAI_STUDIO_SHORTCUT,
      TOOLBOX_SHORTCUT,
    );
    next.push(STORYBOARD_WORKBENCH_SHORTCUT, COVER_STUDIO_SHORTCUT, COMMERCE_AGENT_SHORTCUT);
    return next;
  };

  // 兜底默认图标（API 失败时使用，保持原有体验）
  const FALLBACK_SHORTCUTS: ShortcutItem[] = [
    { id: "fb1", title: "应用广场", icon_svg: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>', icon_color: "#68c7b4", link_type: "action", link_value: "marketplace" },
    MEDIA_HISTORY_SHORTCUT,
    { id: "fb5", title: "视频创作", icon_svg: '<rect x="2" y="3" width="20" height="14" rx="2.5"/><path d="m10 9 5 3-5 3z"/><path d="M2 21h20"/>', icon_color: "#68c7b4", link_type: "internal", link_value: "/video" },
    YOUCAI_STUDIO_SHORTCUT,
    STORYBOARD_WORKBENCH_SHORTCUT,
    COVER_STUDIO_SHORTCUT,
    COMMERCE_AGENT_SHORTCUT,
    { id: "fb6", title: "声音制作", icon_svg: '<path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="22"/>', icon_color: "#68c7b4", link_type: "internal", link_value: "/voice-studio/workspace" },
  ];
  const [shortcuts, setShortcuts] = useState<ShortcutItem[]>(normalizeShortcuts(FALLBACK_SHORTCUTS));

  const visibleShortcuts = useMemo(() => {
    if (memberPermission.status !== "ready") return [];
    return shortcuts.filter((item) => {
      const isMarketplace = item.link_value === "marketplace" || repairMojibake(item.title) === "应用广场";
      const required = isMarketplace
        ? "marketplace"
        : featurePermissionForPath(item.link_value.startsWith("/") ? item.link_value : "/media-history");
      return required ? grantedFeatureKeys.has(required) : grantedFeatureKeys.has("marketplace");
    });
  }, [grantedFeatureKeys, memberPermission.status, shortcuts]);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/shortcuts").then((response) => response.json()).catch(() => ({})).then((shortcutData) => {
      if (cancelled) return;
      const source = Array.isArray(shortcutData?.shortcuts) && shortcutData.shortcuts.length > 0
        ? shortcutData.shortcuts
        : FALLBACK_SHORTCUTS;
      setShortcuts(normalizeShortcuts(source));
    });
    return () => { cancelled = true; };
  }, []);

  // 快捷图标点击处理
  const handleShortcutClick = useCallback((item: ShortcutItem) => {
    // 后台快捷项可能把“应用广场”保存成 internal；按标题也统一走主视图并重置筛选。
    if (item.link_value === "marketplace" || repairMojibake(item.title) === "应用广场") {
      dispatch({ type: "SET_ACTIVE_VIEW", payload: "marketplace" });
      requestMarketplaceShowAll();
      onNavigate?.();
      return;
    }
    if (item.link_type === "action") {
      return;
    } else if (item.link_type === "internal") {
      router.push(item.link_value);
      onNavigate?.();
    } else if (item.link_type === "external") {
      window.open(item.link_value, "_blank");
    }
  }, [dispatch, router, onNavigate]);

  const handleSelectConversation = (id: string) => {
    selectConversation(id);
    onNavigate?.();
  };

  const handleSelectAgent = (agentId: string) => {
    const agent = state.agents.find(a => a.id === agentId);
    if (!agent) return;

    // ── 前端安全拦截：已下架智能体禁止选择 ──
    if (!agent.is_active && state.auth.user?.role !== "admin") {
      toast.warning("该智能体已下架，暂不可使用");
      return;
    }

    // 如果智能体有预设字段，弹出配置对话框
    if (agent.presetFields && agent.presetFields.length > 0) {
      setPresetAgent({
        id: agent.id,
        name: agent.name,
        iconUrl: agent.iconUrl || "",
        presetFields: agent.presetFields,
      });
      return;
    }

    // 智能回溯逻辑：
    // - 如果当前正在与该智能体对话（点击同一智能体），则创建新对话（用户想重新开始）
    // - 如果切换到另一个智能体，优先恢复最近与该智能体的对话（回溯）
    // - 如果没有历史对话，则创建新对话
    // 侧边栏点击智能体始终创建新对话
    createConversationAndChat(agentId);
  };

  const createConversationAndChat = (agentId: string, presetValues?: Record<string, string>) => {
    const agent = state.agents.find(a => a.id === agentId);
    if (!agent) return;

    const conversationId = startChat(agentId);
    if (!conversationId) return;
    onNavigate?.();

    // ChatView waits for this exact conversation to mount before sending.
    if (presetValues && agent.presetFields) {
      const sortedFields = [...agent.presetFields].sort((a, b) => a.order - b.order);
      const formattedMessage = sortedFields
        .filter((f) => presetValues[f.id]?.trim())
        .map((f) => presetValues[f.id].trim())
        .join("\n");

      if (formattedMessage) {
        setPendingPresetMessage({ convId: conversationId, content: formattedMessage });
      }
    }
  };

  const handleNewConversation = () => {
    if (!auth?.isAuthenticated || !user) {
      try { sessionStorage.removeItem("entered_app"); } catch {}
      window.location.replace("/");
      return;
    }

    startFreeChat();
    onNavigate?.();
  };

  const handlePresetStart = (values: Record<string, string>) => {
    if (presetAgent) {
      createConversationAndChat(presetAgent.id, values);
    }
    setPresetAgent(null);
  };

  const handlePresetSkip = () => {
    if (presetAgent) {
      createConversationAndChat(presetAgent.id);
    }
    setPresetAgent(null);
  };

  const handlePresetClose = () => {
    // 关闭弹窗，不进入对话
    setPresetAgent(null);
  };

  const handleDeleteConversation = (id: string) => {
    dispatch({ type: "DELETE_CONVERSATION", payload: id });
  };

  const handleUnpin = (agentId: string) => {
    dispatch({ type: "UNPIN_AGENT", payload: agentId });
  };

  const handleLogout = () => {
    // 完整清理登录凭据，再清除“已进入应用”标记。
    // 首页与应用广场共用 `/`，必须硬导航才能让 Home 重新读取 sessionStorage，
    // 否则只 dispatch LOGOUT 会继续停在应用层并显示登录界面。
    logout();
    try {
      sessionStorage.removeItem("entered_app");
      sessionStorage.removeItem("trial_dialog_dismissed");
    } catch {}
    window.location.replace("/");
  };

  const sidebarWidth = state.sidebarWidth || 300;
  const [announcementUnread, setAnnouncementUnread] = useState(0);
  const [accountNotificationUnread, setAccountNotificationUnread] = useState(0);

  // 监听通知未读数
  useEffect(() => {
    const handler = (e: Event) => setAnnouncementUnread((e as CustomEvent).detail || 0);
    window.addEventListener("announcement-unread", handler);
    window.dispatchEvent(new Event("request-announcement-unread"));
    return () => window.removeEventListener("announcement-unread", handler);
  }, []);
  useEffect(() => {
    const handler = (event: Event) => setAccountNotificationUnread((event as CustomEvent).detail || 0);
    window.addEventListener("account-notification-unread", handler);
    window.dispatchEvent(new Event("request-account-notification-unread"));
    return () => window.removeEventListener("account-notification-unread", handler);
  }, []);
  // 可拖拽调整宽度
  const sidebarRef = useRef<HTMLDivElement>(null);
  const isDragging = useRef(false);
  const onDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isDragging.current = true;
    const startX = e.clientX;
    const startWidth = sidebarWidth;
    const onMouseMove = (ev: MouseEvent) => {
      if (!isDragging.current) return;
      const newWidth = Math.min(460, Math.max(280, startWidth + ev.clientX - startX));
      dispatch({ type: "SET_SIDEBAR_WIDTH", payload: newWidth });
    };
    const onMouseUp = () => {
      isDragging.current = false;
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  }, [sidebarWidth, dispatch]);

  return (
    <div
      ref={sidebarRef}
      className="sidebar-shell h-full bg-[var(--sidebar)] border-r border-[var(--sidebar-border)] flex flex-col overflow-hidden relative"
      // 桌面宽度由 page.tsx 外层统一控制（含新增的20px呼吸缝），侧栏内容铺满外框；移动抽屉仍固定280px。
      style={{ width: isMobile ? "280px" : "100%", minWidth: isMobile ? "280px" : "0", maxWidth: isMobile ? "280px" : "none", "--sidebar-scale": String(sidebarFontSize) } as React.CSSProperties}
    >
      {/* 个人信息模块 */}
      <SidebarProfile />
      {/* 快捷导航入口 — 工具功能收拢到单一工具箱，其他业务保持独立入口 */}
      <div className="sidebar-shortcut-section px-3 pb-2.5 pt-2 border-b border-[var(--border)]/40">
        <div className="sidebar-tool-heading mb-2 flex items-center gap-1.5 px-1 text-[clamp(13px,calc(13px*var(--sidebar-scale,1)),15px)] font-bold text-[var(--muted-foreground)]">
          <LayoutGrid className="h-4 w-4" aria-hidden="true" />
          <span>快捷导航</span>
          <span className="ml-auto font-medium opacity-70">{visibleShortcuts.length} 项</span>
        </div>
        <div className="sidebar-shortcut-grid grid grid-cols-3 gap-2">
          {visibleShortcuts.map((item) => {
            const displayTitle = getPrimaryNavigationLabelForRoute(item.link_value, item.title);
            const isShortcutActive = item.link_value === "marketplace"
              ? pathname === "/" && state.view === "marketplace"
              : item.link_type === "internal" && item.link_value.startsWith("/")
                ? pathname === item.link_value || pathname.startsWith(`${item.link_value}/`)
                : false;
            return item.id === "toolbox" ? (
              <ToolboxMenu
                key={item.id}
                variant="sidebar"
                style={{ "--shortcut-accent": item.icon_color } as CSSProperties}
                onNavigate={() => {
                  onNavigate?.();
                }}
              />
            ) : (
              <button
                key={item.id}
                onClick={() => handleShortcutClick(item)}
                aria-current={isShortcutActive ? "page" : undefined}
                className="sidebar-tool-card sidebar-shortcut-card group flex min-h-16 flex-col items-center justify-center gap-1 rounded-[10px] border border-[var(--border)] bg-[var(--card)] px-1 py-1 text-[var(--text-secondary)] transition-[transform,background-color,border-color,box-shadow] duration-200 hover:-translate-y-px hover:border-[var(--primary)]/35 hover:bg-[var(--accent)] hover:text-[var(--primary)] hover:shadow-sm"
                style={{ "--shortcut-accent": item.icon_color } as CSSProperties}
                title={displayTitle}
              >
                <span className="sidebar-shortcut-icon flex h-[30px] w-[30px] items-center justify-center rounded-[9px] bg-[var(--accent)] text-current transition-transform duration-200 group-hover:scale-[1.04]">
                  <svg
                    className="h-[18px] w-[18px]"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    dangerouslySetInnerHTML={{ __html: item.icon_svg }}
                  />
                </span>
                <span className="max-w-full text-center text-[clamp(13px,calc(13px*var(--sidebar-scale,1)),15px)] font-semibold leading-tight text-[var(--foreground)]">{displayTitle}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* 新建对话：所有已登录用户统一进入自由对话。 */}
      {canUseMarketplace && <div className="px-2.5 pb-2 pt-1 shrink-0">
        <button
          onClick={handleNewConversation}
          className="new-chat-btn w-full flex items-center justify-center gap-2 py-2 rounded-lg transition-[transform,background-color,box-shadow] duration-200 cursor-pointer font-semibold tracking-wide hover:-translate-y-px active:translate-y-0"
          style={{
            fontSize: 'clamp(13px, calc(14px * var(--sidebar-scale, 1)), 15px)',
            color: 'var(--primary-foreground)',
            background: 'var(--primary)',
            border: '1px solid color-mix(in srgb, var(--primary) 72%, var(--border))',
            borderRadius: '10px',
            boxShadow: 'var(--sidebar-primary-button-shadow)',
            letterSpacing: '0.02em',
          }}
        >
          <Plus className="w-4 h-4" strokeWidth={2.5} />
          <span>新建对话</span>
        </button>
      </div>}
      {/* 🔒 新建对话按钮 — 锁定区域结束 */}

      {/* 收藏的智能体 + 对话历史标题 — 固定不随对话列表滚动 */}
      <div className="shrink-0">
        {pinnedAgents.length > 0 && (
          <div className="px-3">
            <div className="my-1 border-t border-[var(--border)]/40" />
            {pinnedAgents.map((agent) => (
              <button
                key={agent.id}
                onClick={() => handleSelectAgent(agent.id)}
                className="sidebar-conversation-item w-full flex items-center gap-3 px-3 py-2 rounded-lg text-left hover:bg-[var(--accent)]"
              >
                <Avatar className="rounded-md w-8 h-8 shrink-0">
                  <AvatarImage src={resolveAgentAvatarUrl(agent.id, agent.name, agent.iconUrl)} alt={agent.name} />
                  <AvatarFallback
                    className="font-medium rounded-md text-[11px]"
                    style={{ backgroundColor: stringToColor(agent.name), color: "#fff" }}
                  >
                    {agent.name[0]}
                  </AvatarFallback>
                </Avatar>
                <span className="text-[13px] text-[var(--foreground)]/65 font-normal truncate">{agent.name}</span>
              </button>
            ))}
          </div>
        )}

        {/* 对话历史 */}
        <div className="mt-1 pt-1 border-t border-[var(--border)]/30">
          <div className="px-3 py-1 flex items-center">
            <span className="text-[clamp(11px,calc(12px*var(--sidebar-scale,1)),14px)] font-semibold tracking-wider uppercase text-[var(--text-secondary)]/80">
              对话历史
            </span>
          </div>
        </div>
      </div>

      {/* 对话列表 — 高度受限，内部滚动，自然延伸至底部固定区域上方 */}
      <div className="sidebar-scroll min-h-0 overflow-y-auto flex-1">

          {visibleConversations.length === 0 ? (
            <div className="px-3 py-8 text-center">
              <MessageSquare className="w-8 h-8 mx-auto mb-2 text-[var(--text-secondary)] opacity-40" />
              <p className="text-[12px] text-[var(--text-secondary)]">暂无对话记录</p>
            </div>
          ) : (
            <div className="sidebar-conv-list">
              {/* 🔒 侧边栏对话列表 — 锁定区域，禁止修改布局/间距/字号 */}
            {visibleConversations.map((conv) => {
              // 从 agents 列表同步获取最新的智能体信息
              // 优先按 id 查找，回退按 botId 查找（处理 chat/route 存储 Coze botId 的情况）
              const convAgent = agents.find((a) => a.id === conv.agentId) || agents.find((a) => a.botId && a.botId === conv.agentId);
              const agentName = convAgent?.name || conv.agentName || "智能体";
              const fallbackAgentIcon = getSemanticAgentAvatarFallback(conv.agentId || conv.id, agentName);
              const agentIcon = resolveAgentAvatarUrl(convAgent?.id || conv.agentId || conv.id, agentName, convAgent?.iconUrl || conv.agentIconUrl || "");
              const agentFirstChar = agentName[0] || "?";
              const isActive = activeConversationId === conv.id;
              // 格式化时间
              const timeStr = formatConversationTime(conv.updatedAt || conv.createdAt);
              return (
                <div key={conv.id} className={`sidebar-conv-item${isActive ? " active" : ""}`}
                  onClick={() => {
                    if (conv.source === "video") {
                      router.push("/video");
                      onNavigate?.();
                    } else {
                      handleSelectConversation(conv.id);
                    }
                  }}>
                  {/* 删除按钮 — hover 行才浮现，浮于右端 */}
                  <button className="sidebar-conv-delete"
                    type="button"
                    onClick={(e) => { e.stopPropagation(); handleDeleteConversation(conv.id); }}
                    title="删除对话"
                    aria-label={`删除对话：${agentName}`}>
                    <svg className="sidebar-conv-delete-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M3 6h18M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
                    </svg>
                  </button>
                                {/* 智能体头像 — 视频任务用Film图标 */}
                  <Avatar data-testid={`sidebar-history-avatar-${conv.id}`} className="shrink-0 rounded-lg" style={{ width: "calc(34px * var(--sidebar-scale, 1))", height: "calc(34px * var(--sidebar-scale, 1))", minWidth: "32px", minHeight: "32px" }}>
                    {conv.source === "video" ? (
                      <AvatarFallback
                        className="font-medium rounded-md"
                        style={{
                          fontSize: `calc(${10 * sidebarFontSize}px * var(--sidebar-scale, 1))`,
                          backgroundColor: "var(--primary)",
                          color: "#fff",
                        }}
                      >
                        <Film style={{ width: `calc(${10 * sidebarFontSize}px * var(--sidebar-scale, 1))`, height: `calc(${10 * sidebarFontSize}px * var(--sidebar-scale, 1))` }} />
                      </AvatarFallback>
                    ) : (
                      <>
                        <AvatarImage
                          src={agentIcon}
                          alt={agentName}
                          onError={(event) => {
                            const image = event.currentTarget;
                            if (image.dataset.fallback !== "1") {
                              image.dataset.fallback = "1";
                              image.src = fallbackAgentIcon;
                            }
                          }}
                        />
                        <AvatarFallback
                          className="font-medium rounded-md"
                          style={{
                            fontSize: `calc(${10 * sidebarFontSize}px * var(--sidebar-scale, 1))`,
                            backgroundColor: stringToColor(agentName),
                            color: "#fff",
                          }}
                        >
                          {agentFirstChar}
                        </AvatarFallback>
                      </>
                    )}
                  </Avatar>
                  {/* 智能体名称 + 时间：right 模式时间右对齐对称，below 模式时间居名称下方 */}
                  <span className="sidebar-conv-text">
                    <span className="sidebar-conv-name" title={agentName} style={{ fontSize: "clamp(13px, calc(14px * var(--sidebar-scale, 1)), 17px)" }}>{agentName}</span>
                    {timeStr && (
                      <span className="sidebar-conv-time" style={{ fontSize: "clamp(11px, calc(12px * var(--sidebar-scale, 1)), 14px)" }}>{timeStr}</span>
                    )}
                  </span>
                </div>
              );
            })}
            </div>
          )}
          {/* 🔒 侧边栏对话列表 — 锁定区域结束 */}
      </div>

      {/* 底部用户信息 — mt-auto 保持在底部，不随对话历史变化；仅保留发丝级顶部分隔线，无雾状底色 */}
      <div
        className="mt-auto shrink-0"
        style={{
          borderTop: '1px solid color-mix(in srgb, var(--sidebar-border) 60%, transparent)',
        }}
      >
        {/* 用户菜单 — 玻璃卡：触发器与通知铃铛兄弟布局 */}
        <div className="sidebar-glass-card hoverable mx-2 mb-1.5 mt-2 rounded-xl flex items-center gap-1 pl-2.5 pr-1 py-1.5 transition-all duration-300">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                data-testid="sidebar-user-menu-trigger"
                aria-label="打开账号菜单"
                className="user-menu-btn flex-1 min-w-0 flex items-center gap-2.5 px-0.5 py-1 rounded-lg cursor-pointer"
              >
              <Avatar
                className="rounded-full transition-all duration-300"
                style={{
                  width: `calc(30px * var(--sidebar-scale, 1))`,
                  height: `calc(30px * var(--sidebar-scale, 1))`,
                  minWidth: '24px',
                  minHeight: '24px',
                  boxShadow: '0 0 0 1.5px color-mix(in srgb, var(--sb-primary) 55%, transparent), 0 0 10px color-mix(in srgb, var(--sb-primary) 28%, transparent)',
                }}
              >
                {user?.avatarUrl && <AvatarImage src={user.avatarUrl} alt={user.displayName || "用户头像"} />}
                <AvatarFallback className="text-white font-bold rounded-full" style={{ background: 'var(--sb-gradient)', fontSize: `calc(13px * var(--sidebar-scale, 1))` }}>
                  {user?.displayName?.[0] || "U"}
                </AvatarFallback>
              </Avatar>
              <div className="flex-1 text-left min-w-0 flex flex-col items-start gap-px">
                <div className="flex items-center gap-1.5 w-full min-w-0">
                  <p className="text-[clamp(12px,calc(13px*var(--sidebar-scale,1)),16px)] font-semibold text-[var(--foreground)] truncate leading-tight">{user?.displayName}</p>
                  <span
                    className="inline-flex items-center min-h-5 px-1.5 py-px rounded-md text-[11px] font-bold shrink-0"
                    style={{
                      background: user?.role === "admin" ? 'var(--sb-gradient)' : 'color-mix(in srgb, var(--sb-primary) 12%, transparent)',
                      color: user?.role === "admin" ? '#ffffff' : 'var(--sb-primary)',
                      letterSpacing: '0.05em',
                      boxShadow: user?.role === "admin" ? '0 1px 5px color-mix(in srgb, var(--sb-primary) 35%, transparent)' : 'none',
                    }}
                  >
                    {user?.role === "admin" ? "管理员" : "用户"}
                  </span>
                </div>
                <span className="sb-user-caption">个人中心</span>
              </div>
              <ChevronDown className="w-4 h-4 text-[var(--text-secondary)] shrink-0 transition-transform duration-300" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            className="w-48 bg-[var(--popover)] border-[var(--border)] text-[var(--foreground)]"
          >
            <DropdownMenuItem
              onClick={() => router.push("/profile")}
              className="cursor-pointer hover:bg-[var(--accent)] focus:bg-[var(--accent)]"
            >
              <User className="w-4 h-4 mr-2" />
              个人中心
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => router.push("/profile?tab=password")}
              className="cursor-pointer hover:bg-[var(--accent)] focus:bg-[var(--accent)]"
            >
              <KeyRound className="w-4 h-4 mr-2" />
              {auth?.user?.hasPassword === false ? '设置密码' : '修改密码'}
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => router.push("/profile?tab=cami")}
              className="cursor-pointer hover:bg-[var(--accent)] focus:bg-[var(--accent)]"
            >
              <svg className="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 5v2m0 4v2m0 4v2M5 5a2 2 0 00-2 2v3a2 2 0 110 4v3a2 2 0 002 2h14a2 2 0 002-2v-3a2 2 0 110-4V7a2 2 0 00-2-2H5z" /></svg>
              卡密兑换
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => router.push("/profile?tab=records")}
              className="cursor-pointer hover:bg-[var(--accent)] focus:bg-[var(--accent)]"
            >
              <ArrowDownUp className="w-4 h-4 mr-2" />
              交易记录
            </DropdownMenuItem>
            <DropdownMenuSeparator className="bg-[var(--border)]" />
            {isAdmin && (
              <>
                <DropdownMenuItem
                  data-testid="sidebar-admin-entry"
                  onClick={() => {
                    router.push("/admin");
                    onNavigate?.();
                  }}
                  className="cursor-pointer hover:bg-[var(--accent)] focus:bg-[var(--accent)]"
                >
                  <Shield className="w-4 h-4 mr-2" />
                  管理后台
                </DropdownMenuItem>
                <DropdownMenuSeparator className="bg-[var(--border)]" />
              </>
            )}
            <DropdownMenuItem
              onClick={handleLogout}
              className="cursor-pointer hover:bg-[var(--accent)] focus:bg-[var(--accent)] text-[var(--destructive)]"
            >
              <LogOut className="w-4 h-4 mr-2" />
              退出登录
            </DropdownMenuItem>
          </DropdownMenuContent>
          </DropdownMenu>
          <UserThemeSwitcher menuSide="top" />
          {/* 通知铃铛 — 从积分条迁至用户行，功能分组更清晰 */}
          <button
            onClick={() => window.dispatchEvent(new Event(accountNotificationUnread > 0 ? "open-account-notifications" : "open-announcements"))}
            className="sidebar-bell-btn shrink-0 p-1.5 rounded-full transition-all duration-300 cursor-pointer relative"
            title="消息中心"
          >
            <Bell className="text-[var(--text-secondary)]" style={{ width: `calc(15px * var(--sidebar-scale, 1))`, height: `calc(15px * var(--sidebar-scale, 1))` }} />
            {announcementUnread + accountNotificationUnread > 0 && (
              <span
                className="absolute -top-1 -right-1 min-w-[17px] h-[17px] flex items-center justify-center text-white text-[11px] font-bold leading-none px-1"
                style={{
                  background: 'linear-gradient(135deg, #ef4444 0%, #f97316 100%)',
                  borderRadius: '999px',
                  boxShadow: '0 0 8px rgba(239,68,68,0.5)',
                }}
              >
                {announcementUnread + accountNotificationUnread > 99 ? "99+" : announcementUnread + accountNotificationUnread}
              </span>
            )}
          </button>
        </div>
      </div>

      {/* 预设配置弹窗 */}
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
    </div>
  );
}

// 字符串转颜色
function stringToColor(str: string): string {
  const colors = [
    "#165dff",
    "#00A3FF",
    "#9C6ADE",
    "#FFB020",
    "#E06C75",
    "#4CAF50",
    "#FF6B9D",
    "#5C6BC0",
  ];
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash);
  }
  return colors[Math.abs(hash) % colors.length];
}
