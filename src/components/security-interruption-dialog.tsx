"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ShieldAlert } from "lucide-react";
import { useApp } from "@/contexts/app-context";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import {
  APP_DIALOG_PRIORITY,
  claimAppDialog,
  currentAppDialogOwner,
  releaseAppDialog,
  type AppDialogOwner,
} from "@/lib/client-dialog-queue";

export const SECURITY_INTERRUPTION_EVENT = "app-security-interruption";
export const SECURITY_INTERRUPTION_ACK_EVENT = "app-security-interruption-acknowledged";

export interface SecurityInterruptionDetail {
  id?: string;
  title?: string;
  message: string;
  actionLabel?: string;
}

function validSecurityDetail(value: unknown): SecurityInterruptionDetail | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  const message = typeof candidate.message === "string" ? candidate.message.trim() : "";
  if (!message) return null;
  return {
    id: typeof candidate.id === "string" ? candidate.id.slice(0, 160) : undefined,
    title: typeof candidate.title === "string" ? candidate.title.trim().slice(0, 160) : undefined,
    message: message.slice(0, 2_000),
    actionLabel: typeof candidate.actionLabel === "string"
      ? candidate.actionLabel.trim().slice(0, 40)
      : undefined,
  };
}

/**
 * Global P0 claimant. Forced logout comes from the authoritative AppProvider
 * session reconciliation. Security guards can use SECURITY_INTERRUPTION_EVENT
 * for an equally exclusive, acknowledgement-required interruption.
 */
export function SecurityInterruptionDialog() {
  const { forcedLogoutReason, clearForcedLogout } = useApp();
  const [securityNotice, setSecurityNotice] = useState<SecurityInterruptionDetail | null>(null);
  const [claimedOwner, setClaimedOwner] = useState<AppDialogOwner | null>(null);

  useEffect(() => {
    const receive = (event: Event) => {
      const detail = validSecurityDetail((event as CustomEvent<unknown>).detail);
      if (detail) setSecurityNotice(detail);
    };
    window.addEventListener(SECURITY_INTERRUPTION_EVENT, receive);
    return () => window.removeEventListener(SECURITY_INTERRUPTION_EVENT, receive);
  }, []);

  const active = useMemo(() => {
    if (forcedLogoutReason) {
      return {
        owner: "forced-logout" as const,
        title: "登录状态已失效",
        message: forcedLogoutReason,
        description: "当前会话已被服务器撤销。请确认后返回主页重新登录。",
        actionLabel: "返回主页",
        id: "forced-logout",
      };
    }
    if (!securityNotice) return null;
    return {
      owner: "security" as const,
      title: securityNotice.title || "安全提醒",
      message: securityNotice.message,
      description: "这是需要当前账号确认的安全事件，其他平台弹窗已暂时排队。",
      actionLabel: securityNotice.actionLabel || "我已知晓",
      id: securityNotice.id || "security-interruption",
    };
  }, [forcedLogoutReason, securityNotice]);

  useEffect(() => {
    if (!active) {
      setClaimedOwner(null);
      return;
    }
    const claimed = claimAppDialog(active.owner, APP_DIALOG_PRIORITY.security);
    setClaimedOwner(claimed ? active.owner : null);
    return () => releaseAppDialog(active.owner);
  }, [active]);

  const acknowledge = useCallback(() => {
    if (!active) return;
    releaseAppDialog(active.owner);
    setClaimedOwner(null);
    if (active.owner === "forced-logout") {
      clearForcedLogout();
      return;
    }
    setSecurityNotice(null);
    window.dispatchEvent(new CustomEvent(SECURITY_INTERRUPTION_ACK_EVENT, {
      detail: { id: active.id },
    }));
  }, [active, clearForcedLogout]);

  const open = Boolean(active && claimedOwner === active.owner && currentAppDialogOwner() === active.owner);
  if (!active) return null;

  return (
    <Dialog open={open} onOpenChange={() => undefined}>
      <DialogContent data-testid="security-interruption-dialog" showCloseButton={false} className="w-[min(520px,calc(100vw-96px))] max-w-none rounded-2xl border border-rose-500/30 bg-[var(--card)] p-0 shadow-2xl">
        <header className="flex items-start gap-4 border-b border-[var(--border)] px-6 py-5">
          <span className="grid h-12 w-12 shrink-0 place-items-center rounded-xl border border-rose-500/25 bg-rose-500/10 text-rose-500"><ShieldAlert className="h-6 w-6" /></span>
          <div className="min-w-0">
            <DialogTitle className="text-xl font-black text-[var(--foreground)]">{active.title}</DialogTitle>
            <DialogDescription className="mt-1.5 text-sm leading-6 text-[var(--muted-foreground)]">{active.description}</DialogDescription>
          </div>
        </header>
        <div className="px-6 py-5">
          <p className="whitespace-pre-wrap rounded-xl border border-rose-500/25 bg-rose-500/8 p-4 text-sm leading-6 text-rose-500">{active.message}</p>
        </div>
        <footer className="flex justify-end border-t border-[var(--border)] px-6 py-4">
          <button type="button" onClick={acknowledge} className="h-10 rounded-xl bg-rose-600 px-5 text-sm font-bold text-white hover:bg-rose-700">{active.actionLabel}</button>
        </footer>
      </DialogContent>
    </Dialog>
  );
}
