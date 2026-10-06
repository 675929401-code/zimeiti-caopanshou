"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useApp } from "@/contexts/app-context";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  normalizePopupDismissBehavior,
  type PopupDismissBehavior,
} from "@/lib/popup-push-domain";

const PERSISTENT_DISMISSALS_KEY = "trial_popup_persistent_dismissals_v1";

interface PopupConfig {
  id: string;
  title: string;
  content: string;
  wechat_id: string;
  wechat_label: string;
  wechat_note: string;
  show_cami_entry: boolean;
  show_trial_plans: boolean;
  target_audience: string;
  is_enabled: boolean;
  priority: number;
  dismiss_behavior: PopupDismissBehavior;
}

interface TrialPlanDialogProps {
  open: boolean;
  onClose: () => void;
  onActivated: () => void;
}

type PopupResolution = "idle" | "loading" | "configured" | "empty" | "fallback";

function persistentDismissals(): Set<string> {
  try {
    const value = JSON.parse(localStorage.getItem(PERSISTENT_DISMISSALS_KEY) || "[]") as unknown;
    return new Set(Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);
  } catch {
    return new Set();
  }
}

function rememberPersistentDismissal(id: string) {
  if (!id || id === "fallback") return;
  const values = persistentDismissals();
  values.add(id);
  try {
    localStorage.setItem(PERSISTENT_DISMISSALS_KEY, JSON.stringify([...values].slice(-100)));
  } catch {
    // The session dismissal in the page shell remains the safe fallback.
  }
}

/**
 * Historical component name retained for call-site compatibility. Packages are
 * now administrator-managed: the user can redeem an assigned card, but cannot
 * self-activate a trial and bypass membership approval or permission snapshots.
 */
export function TrialPlanDialog({ open, onClose }: TrialPlanDialogProps) {
  const { state } = useApp();
  const [popupConfig, setPopupConfig] = useState<PopupConfig | null>(null);
  const [resolution, setResolution] = useState<PopupResolution>("idle");
  const isAdmin = state.auth.user?.role === "admin";

  useEffect(() => {
    if (!open || isAdmin) return;
    let active = true;
    setPopupConfig(null);
    setResolution("loading");
    void (async () => {
      try {
        const response = await fetch("/api/popup-pushes", { cache: "no-store" });
        const payload = await response.json().catch(() => ({}));
        if (!active) return;
        if (response.ok && payload.success === true && Array.isArray(payload.popups)) {
          const first = payload.popups[0] as Partial<PopupConfig> | undefined;
          if (!first || typeof first.id !== "string") {
            setResolution("empty");
            return;
          }
          setPopupConfig({
            ...first,
            dismiss_behavior: normalizePopupDismissBehavior(first.dismiss_behavior),
          } as PopupConfig);
          setResolution("configured");
          return;
        }
        setResolution("fallback");
      } catch {
        if (active) setResolution("fallback");
      }
    })();
    return () => { active = false; };
  }, [isAdmin, open]);

  const fallbackConfig = useMemo(() => ({
    id: "fallback",
    title: "欢迎使用智能体平台",
    content: "您当前尚未开通会员权限，需联系管理员核对后开通。",
    wechat_id: "",
    wechat_label: "联系管理员开通会员",
    wechat_note: "",
    show_cami_entry: true,
    show_trial_plans: false,
    target_audience: "all",
    is_enabled: true,
    priority: 0,
    dismiss_behavior: "session",
  } satisfies PopupConfig), []);
  const config = popupConfig || fallbackConfig;

  useEffect(() => {
    if (!open || resolution === "idle" || resolution === "loading" || resolution === "fallback") return;
    if (resolution === "empty") {
      onClose();
      return;
    }
    if (config.dismiss_behavior === "persistent" && persistentDismissals().has(config.id)) {
      onClose();
    }
  }, [config.dismiss_behavior, config.id, onClose, open, resolution]);

  const closeWithConfiguredBehavior = useCallback(() => {
    if (resolution === "configured" && config.dismiss_behavior === "persistent") {
      rememberPersistentDismissal(config.id);
    }
    onClose();
    if (resolution === "configured" && config.dismiss_behavior === "always") {
      window.setTimeout(() => sessionStorage.removeItem("trial_dialog_dismissed"), 0);
    }
  }, [config.dismiss_behavior, config.id, onClose, resolution]);

  if (isAdmin || resolution === "idle" || resolution === "loading" || resolution === "empty") return null;

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => { if (!nextOpen) closeWithConfiguredBehavior(); }}>
      <DialogContent className="bg-gradient-to-br from-white to-slate-50 sm:max-w-[500px] dark:from-slate-900 dark:to-slate-800">
        <DialogHeader>
          <DialogTitle className="text-center text-xl">{config.title}</DialogTitle>
          <DialogDescription className="text-center">{config.content}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {config.wechat_id && (
            <div className="rounded-xl border-2 border-violet-200 bg-gradient-to-r from-violet-50 to-purple-50 p-5 dark:border-violet-800 dark:from-violet-950/30 dark:to-purple-950/30">
              <p className="text-sm font-semibold text-violet-900 dark:text-violet-100">{config.wechat_label}</p>
              <div className="mt-3 rounded-lg border border-violet-100 bg-white/80 px-4 py-3 dark:border-violet-900 dark:bg-slate-800/80">
                <p className="text-xs text-violet-600 dark:text-violet-400">管理员微信</p>
                <p className="mt-1 text-lg font-bold tracking-wide text-slate-900 dark:text-slate-100">{config.wechat_id}</p>
              </div>
              {config.wechat_note && <p className="mt-2 text-center text-xs text-violet-500 dark:text-violet-400">{config.wechat_note}</p>}
            </div>
          )}

          {config.show_cami_entry && (
            <div className="rounded-xl border border-amber-200 bg-amber-50/50 p-4 dark:border-amber-800 dark:bg-amber-950/20">
              <p className="text-sm font-semibold text-amber-800 dark:text-amber-200">已有管理员发放的会员卡？</p>
              <p className="mt-1 text-sm leading-6 text-amber-700 dark:text-amber-300">前往「个人中心 → 卡密兑换」输入卡密。只有与你账号绑定的有效卡密可以激活会员。</p>
            </div>
          )}

          <div className="rounded-xl border border-emerald-200 bg-emerald-50/60 p-4 dark:border-emerald-800 dark:bg-emerald-950/20" data-testid="admin-managed-member-package-note">
            <div className="flex items-center gap-2 text-sm font-semibold text-emerald-800 dark:text-emerald-200">
              <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6l4 2m5-2a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
              套餐由管理员核对后开通
            </div>
            <p className="mt-2 text-sm leading-6 text-emerald-700 dark:text-emerald-300">试用、正式会员和超级 VIP 均由管理员选择权限与赠送额度。开通后会自动到账，并通过登录弹窗、右下角提醒和个人中心「账号消息」通知你，无需自行领取。</p>
          </div>
        </div>

        <DialogFooter><Button variant="ghost" onClick={closeWithConfiguredBehavior} className="w-full">{config.dismiss_behavior === "always" ? "暂时关闭" : "我知道了"}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
