"use client";

/**
 * 对话头部模型切换器。
 * 只负责展示与选择：目录与持久化由 useChatModelSelection 统一管理，
 * 真实调用仍使用目录返回的 pm_ 标识，界面文案不参与路由。
 */

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Check, ChevronDown, Cpu, Loader2, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ChatModelGroup, ChatModelOption } from "@/lib/chat-model-catalog";
import { chatModelSwitcherDisplayGroups } from "@/lib/chat-model-switcher-display";
import type { ChatModelCatalogStatus } from "@/hooks/use-chat-model-selection";

export interface ChatModelSwitcherProps {
  disabled?: boolean;
  status: ChatModelCatalogStatus;
  groups: ChatModelGroup[];
  selectedModelId: string | null;
  selectedLabel: string;
  onSelect: (model: ChatModelOption) => void;
  onReload: () => void;
}

const TRIGGER_BASE =
  "ml-1 inline-flex h-6 max-w-[13rem] items-center gap-1 rounded-md border px-2 text-[11px] transition-colors";

export function ChatModelSwitcher({
  disabled = false,
  status,
  groups,
  selectedModelId,
  selectedLabel,
  onSelect,
  onReload,
}: ChatModelSwitcherProps) {
  const visibleGroups = chatModelSwitcherDisplayGroups(groups);
  if (status === "loading") {
    return (
      <span
        className={cn(TRIGGER_BASE, "border-[var(--border)] text-[var(--text-secondary)] opacity-80")}
        data-testid="chat-model-loading"
        aria-hidden
      >
        <Loader2 className="h-3 w-3 animate-spin" />
        <span>模型</span>
      </span>
    );
  }

  if (status === "error") {
    return (
      <button
        type="button"
        disabled={disabled}
        onClick={(event) => {
          event.stopPropagation();
          onReload();
        }}
        onDoubleClick={(event) => event.stopPropagation()}
        className={cn(
          TRIGGER_BASE,
          "border-amber-500/40 text-amber-600 hover:border-amber-500/60 hover:text-amber-500",
        )}
        title="模型目录读取失败，点击重新读取；重试前继续使用服务端默认模型"
        data-testid="chat-model-retry"
      >
        <RefreshCw className="h-3 w-3" />
        <span>重新读取模型</span>
      </button>
    );
  }

  if (status !== "ready" || visibleGroups.length === 0) {
    return (
      <span
        className={cn(TRIGGER_BASE, "border-[var(--border)] text-[var(--text-secondary)] opacity-80")}
        title={`当前菜单没有可切换模型；当前选择仍为${selectedLabel || "服务端默认模型"}`}
        data-testid="chat-model-empty"
      >
        <Cpu className="h-3 w-3" />
        <span>{selectedLabel || "默认模型"}</span>
      </span>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          className={cn(
            TRIGGER_BASE,
            "border-[var(--border)] bg-[var(--background)] text-[var(--text-secondary)] hover:border-[var(--primary)]/40 hover:text-[var(--foreground)] data-[state=open]:border-[var(--primary)]/50 data-[state=open]:text-[var(--foreground)]",
          )}
          title={`切换对话模型（当前：${selectedLabel || "服务端默认"}）`}
          aria-label="切换对话模型"
          data-testid="chat-model-trigger"
          onDoubleClick={(event) => event.stopPropagation()}
        >
          <Cpu className="h-3 w-3 shrink-0" />
          <span className="max-w-[9.5rem] truncate font-medium" data-testid="chat-model-label">
            {selectedLabel || "选择模型"}
          </span>
          <ChevronDown className="h-3 w-3 shrink-0 opacity-60" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        sideOffset={6}
        className="w-72 border-[var(--border)] bg-[var(--popover)] p-1.5 text-[var(--popover-foreground)] shadow-xl"
        onDoubleClick={(event) => event.stopPropagation()}
      >
        <DropdownMenuLabel className="px-2 pb-1 pt-1.5 text-[10px] font-medium text-[var(--muted-foreground)]">
          本对话模型
        </DropdownMenuLabel>
        {visibleGroups.map((group, index) => (
          <DropdownMenuGroup key={group.brand}>
            {index > 0 ? <DropdownMenuSeparator className="my-1 bg-[var(--border)]" /> : null}
            <DropdownMenuLabel className="px-2 py-1 text-[11px] font-semibold text-[var(--text-secondary)]">
              {group.title}
            </DropdownMenuLabel>
            {group.models.map((model) => {
              const active = model.id === selectedModelId;
              return (
                <DropdownMenuItem
                  key={model.id}
                  disabled={disabled}
                  onSelect={() => { if (!disabled) onSelect(model); }}
                  data-model-id={model.id}
                  data-active={active ? "true" : undefined}
                  className={cn(
                    "gap-2 rounded-md px-2 py-1.5 text-xs",
                    active && "bg-[var(--accent)] text-[var(--accent-foreground)]",
                  )}
                >
                  <span className="min-w-0 flex-1 truncate">{model.label}</span>
                  {active ? <Check className="h-3.5 w-3.5 shrink-0 text-[var(--primary)]" /> : null}
                </DropdownMenuItem>
              );
            })}
          </DropdownMenuGroup>
        ))}
        <DropdownMenuSeparator className="my-1 bg-[var(--border)]" />
        <div className="px-2 py-1.5 text-[10px] leading-relaxed text-[var(--muted-foreground)]">
          切换后从下一条消息开始生效，已有回复保持不变。
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
