"use client";

import { Clock3, Eye, EyeOff, LockKeyhole, ShieldCheck, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { AdminAccessClientState } from "@/lib/admin-governance";

function formatExpiry(value?: string | null) {
  if (!value) return "暂无";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "暂无";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(date).replaceAll("/", "-");
}

export function useAdminStepUpReady(status?: string, expiresAt?: string | null) {
  const [currentTime, setCurrentTime] = useState<number | null>(null);
  useEffect(() => {
    const update = () => setCurrentTime(Date.now());
    update();
    const timer = window.setInterval(update, 15_000);
    const expiryTime = expiresAt ? new Date(expiresAt).getTime() : Number.NaN;
    const expiryTimer = status === "ready" && Number.isFinite(expiryTime)
      ? window.setTimeout(update, Math.max(0, expiryTime - Date.now()) + 1)
      : null;
    return () => {
      window.clearInterval(timer);
      if (expiryTimer !== null) window.clearTimeout(expiryTimer);
    };
  }, [expiresAt, status]);
  return (status === "ready" || status === "maintenance")
    && Boolean(expiresAt && currentTime !== null && new Date(expiresAt).getTime() > currentTime);
}

function maintenanceRemaining(expiresAt: string | null, now: number) {
  const remainingSeconds = Math.max(0, Math.ceil((new Date(expiresAt || 0).getTime() - now) / 1000));
  const minutes = Math.floor(remainingSeconds / 60);
  const seconds = remainingSeconds % 60;
  return `${minutes}分${String(seconds).padStart(2, "0")}秒`;
}

export function AdminMaintenanceModeBanner({
  token,
  state,
  onChanged,
}: {
  token: string;
  state: AdminAccessClientState | null;
  onChanged: () => Promise<void> | void;
}) {
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const maintenance = state?.maintenanceLock;
  const active = useAdminStepUpReady(maintenance?.enabled ? "maintenance" : "missing", maintenance?.expiresAt);

  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [active]);

  if (!maintenance?.enabled || !active) return null;

  const restore = async () => {
    if (busy || state?.access.adminLevel !== "super_admin") return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/admin/access-control/maintenance-lock", {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
          "Idempotency-Key": crypto.randomUUID(),
        },
        body: JSON.stringify({
          enabled: false,
          reason: "超级管理员从全局横幅立即恢复所有二次验证锁",
          expectedRevision: maintenance.revision,
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || "恢复二次验证锁失败");
      await onChanged();
    } catch (restoreError) {
      setError(restoreError instanceof Error ? restoreError.message : "恢复二次验证锁失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div data-testid="admin-maintenance-mode-banner" role="status" className="shrink-0 border-b border-amber-300 bg-amber-100 px-4 py-3 text-amber-950">
      <div className="mx-auto flex w-full max-w-[1800px] flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-amber-900 text-amber-50"><Clock3 className="h-4 w-4" /></span>
          <div>
            <p className="text-sm font-black">超级管理员维护模式：二次验证已临时暂停 · 剩余 {maintenanceRemaining(maintenance.expiresAt, now)}</p>
            <p className="mt-1 text-xs leading-5">岗位权限、资源作用域、账务门禁和操作审计仍然生效；到期会自动恢复全部二次验证锁。</p>
            {error && <p role="alert" className="mt-1 text-xs font-bold text-rose-700">{error}</p>}
          </div>
        </div>
        {state?.access.adminLevel === "super_admin" && (
          <button type="button" disabled={busy} onClick={() => void restore()} className="h-9 rounded-lg bg-amber-950 px-4 text-xs font-black text-white disabled:opacity-50">
            {busy ? "正在恢复…" : "立即恢复所有锁"}
          </button>
        )}
      </div>
    </div>
  );
}

export function AdminSensitiveUnlockControl({
  token,
  state,
  onChanged,
  forceOpen = false,
  onForceOpenHandled,
}: {
  token: string;
  state: AdminAccessClientState | null;
  onChanged: () => Promise<void> | void;
  forceOpen?: boolean;
  onForceOpenHandled?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [mode, setMode] = useState<"auto" | "login" | "management">("auto");
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const triggerRef = useRef<HTMLButtonElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const unlocked = useAdminStepUpReady(state?.stepUp.status, state?.stepUp.expiresAt);
  const maintenanceActive = state?.stepUp.status === "maintenance" && unlocked;
  const managementPasswordAllowed = state?.access.adminLevel === "super_admin";

  useEffect(() => {
    if (!managementPasswordAllowed) setMode("login");
  }, [managementPasswordAllowed]);

  useEffect(() => {
    if (!forceOpen) return;
    if (maintenanceActive) {
      onForceOpenHandled?.();
      return;
    }
    setOpen(true);
    onForceOpenHandled?.();
  }, [forceOpen, maintenanceActive, onForceOpenHandled]);

  useEffect(() => {
    if (!open) return;
    const previousActive = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const overlay = overlayRef.current;
    const dialog = dialogRef.current;
    if (!overlay || !dialog) return;

    const background = Array.from(document.body.children)
      .filter((element): element is HTMLElement => element instanceof HTMLElement && element !== overlay && !element.contains(overlay))
      .map((element) => ({ element, inert: element.inert, ariaHidden: element.getAttribute("aria-hidden") }));
    for (const entry of background) {
      entry.element.inert = true;
      entry.element.setAttribute("aria-hidden", "true");
    }
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const focusableSelector = [
      "button:not([disabled])",
      "input:not([disabled])",
      "select:not([disabled])",
      "textarea:not([disabled])",
      "[href]",
      "[tabindex]:not([tabindex='-1'])",
    ].join(",");
    const focusFirst = window.requestAnimationFrame(() => {
      (dialog.querySelector<HTMLInputElement>("input[type='password'], input[type='text']")
        || dialog.querySelector<HTMLElement>(focusableSelector)
        || dialog).focus();
    });
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(focusableSelector))
        .filter((element) => element.getClientRects().length > 0);
      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", handleKeyDown, true);
    return () => {
      window.cancelAnimationFrame(focusFirst);
      document.removeEventListener("keydown", handleKeyDown, true);
      document.body.style.overflow = previousOverflow;
      for (const entry of background) {
        entry.element.inert = entry.inert;
        if (entry.ariaHidden === null) entry.element.removeAttribute("aria-hidden");
        else entry.element.setAttribute("aria-hidden", entry.ariaHidden);
      }
      const restoreTarget = previousActive?.isConnected ? previousActive : triggerRef.current;
      window.requestAnimationFrame(() => restoreTarget?.focus());
    };
  }, [open]);

  useEffect(() => {
    if (maintenanceActive && open) setOpen(false);
  }, [maintenanceActive, open]);

  const unlock = async () => {
    if (!password || busy) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/admin/access-control/unlock", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ password, mode: managementPasswordAllowed ? mode : "login" }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || "解锁失败");
      setPassword("");
      setOpen(false);
      await onChanged();
    } catch (unlockError) {
      setError(unlockError instanceof Error ? unlockError.message : "解锁失败");
    } finally {
      setBusy(false);
    }
  };

  const lock = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await fetch("/api/admin/access-control/unlock", {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      await onChanged();
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        data-testid="admin-sensitive-lock"
        onClick={() => maintenanceActive ? undefined : unlocked ? void lock() : setOpen(true)}
        aria-disabled={maintenanceActive || undefined}
        className={`inline-flex h-10 items-center gap-2 rounded-lg border px-3 text-sm font-bold transition-colors ${maintenanceActive ? "cursor-default border-amber-500/40 bg-amber-100 text-amber-900" : unlocked ? "border-emerald-500/30 bg-emerald-500/8 text-emerald-700" : "border-amber-500/30 bg-amber-500/8 text-amber-700"}`}
      >
        {unlocked ? <ShieldCheck className="h-4 w-4" /> : <LockKeyhole className="h-4 w-4" />}
        {maintenanceActive ? `维护模式至 ${formatExpiry(state?.stepUp.expiresAt).slice(-5)}` : unlocked ? `敏感操作已解锁至 ${formatExpiry(state?.stepUp.expiresAt).slice(-5)}` : "解锁敏感操作"}
      </button>

      {open && typeof document !== "undefined" && createPortal(
        <div ref={overlayRef} data-testid="admin-sensitive-unlock-overlay" className="fixed inset-0 z-[2147483647] grid place-items-center bg-black/45 p-6 backdrop-blur-[2px]" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setOpen(false); }}>
          <div ref={dialogRef} tabIndex={-1} data-slot="dialog-content" role="dialog" aria-modal="true" aria-labelledby="admin-unlock-title" className="w-full max-w-lg rounded-2xl border border-[#d0d5dd] bg-white shadow-2xl outline-none">
            <div className="flex items-start justify-between border-b border-[#eaecf0] px-6 py-5">
              <div><p className="text-xs font-bold text-[#067647]">后台安全确认</p><h2 id="admin-unlock-title" className="mt-1 text-xl font-black text-[#101828]">解锁敏感操作 10 分钟</h2></div>
              <button type="button" aria-label="关闭" onClick={() => setOpen(false)} className="grid h-9 w-9 place-items-center rounded-xl border border-[#d0d5dd] text-[#667085]"><X className="h-4 w-4" /></button>
            </div>
            <div className="space-y-4 p-6">
              <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm leading-6 text-amber-900">解锁只保存在 HttpOnly 会话中，不会把密码或解锁令牌暴露给页面。权限修改、充值、卡密、提示词、密钥和下载仍会逐项记录审计。</div>
              <div className={`grid gap-2 text-xs font-bold ${managementPasswordAllowed ? "grid-cols-3" : "grid-cols-1"}`}>
                {(managementPasswordAllowed ? ([
                  ["auto", "自动识别"],
                  ["login", "登录密码"],
                  ["management", "管理密码"],
                ] as const) : ([
                  ["login", "本人登录密码"],
                ] as const)).map(([value, label]) => (
                  <button key={value} type="button" onClick={() => setMode(value)} className={`rounded-xl border px-3 py-2.5 ${mode === value ? "border-[#079455] bg-[#ecfdf3] text-[#067647]" : "border-[#d0d5dd] text-[#475467]"}`}>{label}</button>
                ))}
              </div>
              <label className="block text-sm font-bold text-[#344054]">{managementPasswordAllowed && mode === "management" ? "平台管理密码" : managementPasswordAllowed && mode === "auto" ? "登录密码或平台管理密码" : "当前管理员登录密码"}
                <span className="relative mt-2 block"><input autoFocus type={showPassword ? "text" : "password"} value={password} onChange={(event) => setPassword(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void unlock(); }} className="h-12 w-full rounded-xl border border-[#d0d5dd] px-4 pr-12 outline-none focus:border-[#079455]" /><button type="button" aria-label={showPassword ? "隐藏密码" : "显示密码"} onClick={() => setShowPassword((value) => !value)} className="absolute right-3 top-1/2 -translate-y-1/2 text-[#667085]">{showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}</button></span>
              </label>
              {error && <p role="alert" className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm font-semibold text-rose-700">{error}</p>}
              <div className="flex justify-end gap-2"><button type="button" onClick={() => setOpen(false)} className="rounded-xl border border-[#d0d5dd] px-4 py-2.5 text-sm font-bold text-[#475467]">取消</button><button type="button" disabled={!password || busy} onClick={() => void unlock()} className="rounded-xl bg-[#079455] px-5 py-2.5 text-sm font-bold text-white disabled:opacity-40">{busy ? "验证中…" : "验证并解锁"}</button></div>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
