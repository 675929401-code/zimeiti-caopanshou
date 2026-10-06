"use client";

import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { ShieldAlert } from "lucide-react";

import { useApp } from "@/contexts/app-context";
import {
  featurePermissionForPath,
  hasFeaturePermission,
  type MemberPermissionSnapshot,
} from "@/lib/member-permissions";
import { STORAGE_KEYS } from "@/lib/storage-keys";

type ClientPermissionState = {
  status: "idle" | "loading" | "ready" | "anonymous" | "error";
  snapshot: MemberPermissionSnapshot | null;
  error: string;
  refresh: () => Promise<void>;
};

const MemberPermissionContext = createContext<ClientPermissionState>({
  status: "idle",
  snapshot: null,
  error: "",
  refresh: async () => undefined,
});

export function MemberPermissionProvider({ children }: { children: React.ReactNode }) {
  const { state } = useApp();
  const [status, setStatus] = useState<ClientPermissionState["status"]>("idle");
  const [snapshot, setSnapshot] = useState<MemberPermissionSnapshot | null>(null);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    const token = state.auth.token || (() => {
      try { return window.localStorage.getItem(STORAGE_KEYS.AUTH_TOKEN); } catch { return null; }
    })();
    if (!token) {
      setSnapshot(null);
      setError("");
      setStatus("anonymous");
      return;
    }
    setStatus("loading");
    setError("");
    try {
      const response = await fetch("/api/member-permissions", {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || !body.permission) {
        setSnapshot(null);
        setError(body.error || "会员权限校验失败");
        setStatus(response.status === 401 ? "anonymous" : "error");
        return;
      }
      setSnapshot(body.permission as MemberPermissionSnapshot);
      setStatus("ready");
    } catch {
      setSnapshot(null);
      setError("会员权限校验暂不可用");
      setStatus("error");
    }
  }, [state.auth.token]);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    const handleRefresh = () => { void refresh(); };
    window.addEventListener("member-permissions:refresh", handleRefresh);
    return () => window.removeEventListener("member-permissions:refresh", handleRefresh);
  }, [refresh]);

  const value = useMemo(() => ({ status, snapshot, error, refresh }), [error, refresh, snapshot, status]);
  return <MemberPermissionContext.Provider value={value}>{children}</MemberPermissionContext.Provider>;
}

export function useMemberPermissions() {
  return useContext(MemberPermissionContext);
}

export function MemberFeatureBoundary({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const permission = useMemberPermissions();
  const requiredFeature = featurePermissionForPath(pathname || "/");
  const allowed = requiredFeature == null || (
    permission.status === "ready"
    && permission.snapshot != null
    && permission.snapshot.integrityValid
    && hasFeaturePermission(
      permission.snapshot.role,
      permission.snapshot.featureNavigationKeys,
      requiredFeature,
    )
  );

  useEffect(() => {
    if (!requiredFeature || allowed || permission.status === "idle" || permission.status === "loading") return;
    const timer = window.setTimeout(() => router.replace("/"), 2500);
    return () => window.clearTimeout(timer);
  }, [allowed, permission.status, requiredFeature, router]);

  if (!requiredFeature || allowed) return <>{children}</>;
  if (permission.status === "idle" || permission.status === "loading") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[var(--background)] text-sm text-[var(--muted-foreground)]" role="status">
        正在核对会员功能权限…
      </div>
    );
  }
  return (
    <div className="flex min-h-screen items-center justify-center bg-[var(--background)] px-6">
      <div className="max-w-md rounded-2xl border border-[var(--border)] bg-[var(--card)] p-7 text-center shadow-xl" role="alert" data-testid="member-feature-access-denied">
        <ShieldAlert className="mx-auto mb-3 h-9 w-9 text-amber-500" aria-hidden="true" />
        <h1 className="text-lg font-semibold text-[var(--foreground)]">此功能尚未开通</h1>
        <p className="mt-2 text-sm leading-6 text-[var(--muted-foreground)]">
          {permission.error || "当前会员没有该业务功能权限。页面与接口均未放行，正在返回应用首页。"}
        </p>
        <button type="button" onClick={() => router.replace("/")} className="mt-5 rounded-lg bg-[var(--primary)] px-4 py-2 text-sm font-semibold text-[var(--primary-foreground)]">
          返回首页
        </button>
      </div>
    </div>
  );
}
