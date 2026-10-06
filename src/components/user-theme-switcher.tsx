"use client";

import { Check, ChevronDown, Palette } from "lucide-react";
import { useApp } from "@/contexts/app-context";
import { USER_THEME_OPTIONS } from "@/lib/themes";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

type UserThemeSwitcherProps = {
  labeled?: boolean;
  menuSide?: "top" | "right" | "bottom" | "left";
};

export function UserThemeSwitcher({ labeled = false, menuSide = "bottom" }: UserThemeSwitcherProps) {
  const { state, saveUserThemePreference } = useApp();

  // 未登录访客只能继承后台平台默认主题。个人主题是账号偏好，
  // 登录态确认后才开放入口，避免匿名浏览器制造无归属的本地选择。
  if (!state.auth.isAuthenticated) return null;

  const currentTheme = USER_THEME_OPTIONS.find((option) => option.id === state.theme) || USER_THEME_OPTIONS[0];

  const selectTheme = (theme: string) => {
    void saveUserThemePreference(theme);
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={`theme-switcher-trigger inline-flex shrink-0 items-center justify-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--card)] text-[var(--foreground)] transition-colors duration-200 ${labeled ? "min-h-10 px-3 text-sm font-semibold" : "min-h-10 min-w-10 p-2"}`}
          aria-label={`切换视觉主题，当前${currentTheme.label}`}
          title={`切换视觉主题，当前${currentTheme.label}`}
          data-theme-switcher-trigger="true"
        >
          <Palette className="h-4 w-4 text-[var(--text-secondary)]" />
          {labeled && <span className="hidden whitespace-nowrap sm:inline">{currentTheme.label}</span>}
          {labeled && <ChevronDown className="hidden h-3.5 w-3.5 text-[var(--muted-foreground)] sm:block" aria-hidden="true" />}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" side={menuSide} sideOffset={8} className="theme-switcher-menu w-64 border-[var(--border)] bg-[var(--popover)] text-[var(--foreground)]">
        <DropdownMenuLabel className="text-[var(--muted-foreground)]">
          <span className="block text-sm font-semibold">视觉主题</span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator className="bg-[var(--border)]" />
        {USER_THEME_OPTIONS.map((option) => {
          const selected = state.theme === option.id;
          return (
            <DropdownMenuItem
              key={option.id}
              onSelect={() => selectTheme(option.id)}
              className="theme-switcher-option min-h-12 cursor-pointer gap-3 py-2.5 focus:bg-[var(--accent)]"
              aria-checked={selected}
              role="menuitemradio"
              data-theme-option={option.id}
            >
              <span
                className="h-3.5 w-3.5 shrink-0 rounded-full border border-white/20"
                style={{ background: option.dot, boxShadow: selected ? `0 0 0 3px ${option.ring}` : "none" }}
                aria-hidden="true"
              />
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-bold">{option.label}</span>
                <span className="mt-0.5 block text-xs leading-snug text-[var(--muted-foreground)]">{option.description}</span>
              </span>
              {selected && <Check className="h-4 w-4 shrink-0 text-[var(--primary)]" />}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
