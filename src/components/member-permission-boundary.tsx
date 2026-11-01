"use client";

import React, { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { FeatureComingSoonOverlay } from "@/components/feature-coming-soon-gate";
import { useApp } from "@/contexts/app-context";
import { ShieldAlert } from "lucide-react";
import {
  featurePermissionForPath,
  hasFeaturePermission,
  type MemberPermissionSnapshot,
} from "@/lib/member-permissions";
import { createClientAccountScope } from "@/lib/client-account-scope";

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
  const scopeOwner = useRef(createClientAccountScope());
  const scope = scopeOwner.current.prepare(state.auth);
  useLayoutEffect(() => scopeOwner.current.activate(scope), [scope]);
  const abortRef = useRef<AbortController | null>(null);
  const [result, setResult] = useState<{
    epoch: string;
    status: ClientPermissionState["status"];
    snapshot: MemberPermissionSnapshot | null;
    error: string;
  } | null>(null);

  const refresh = useCallback(async () => {
    if (!scope?.isCurrent()) return;
    const isCurrent = scope.beginRequest("permissions");
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setResult({ epoch: scope.epoch, status: "loading", snapshot: null, error: "" });
    try {
      const response = await fetch("/api/member-permissions", {
        headers: { Authorization: `Bearer ${scope.token}` },
        cache: "no-store",
        signal: controller.signal,
      });
      const body = await response.json().catch(() => ({}));
      if (!isCurrent()) return;
      if (!response.ok || !body.permission || body.permission.userId !== scope.userId) {
        setResult({ epoch: scope.epoch, snapshot: null,
          error: body.error || "会员权限校验失败",
          status: response.status === 401 ? "anonymous" : "error" });
        return;
      }
      setResult({ epoch: scope.epoch, status: "ready", snapshot: body.permission as MemberPermissionSnapshot, error: "" });
    } catch {
      if (!isCurrent()) return;
      setResult({ epoch: scope.epoch, snapshot: null, error: "会员权限校验暂不可用", status: "error" });
    }
  }, [scope]);

  useEffect(() => {
    void refresh();
    return () => abortRef.current?.abort();
  }, [refresh]);
  useEffect(() => {
    const handleRefresh = () => { void refresh(); };
    window.addEventListener("member-permissions:refresh", handleRefresh);
    return () => window.removeEventListener("member-permissions:refresh", handleRefresh);
  }, [refresh]);

  // Scope changes must hide the old ready snapshot in this render, before effects.
  const value = useMemo<ClientPermissionState>(() => ({
    status: scope ? result?.epoch === scope.epoch ? result.status : "loading" : "anonymous",
    snapshot: scope && result?.epoch === scope.epoch ? result.snapshot : null,
    error: scope && result?.epoch === scope.epoch ? result.error : "",
    refresh,
  }), [refresh, result, scope]);
  return <MemberPermissionContext.Provider value={value}>{children}</MemberPermissionContext.Provider>;
}

export function useMemberPermissions() {
  return useContext(MemberPermissionContext);
}

export function MemberFeatureBoundary({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const permission = useMemberPermissions();
  const { state } = useApp();
  // 未上线模块优先展示“开发中”玻璃遮罩：先于会员权限判断，否则用户只会看到“此功能尚未开通”
  const comingSoon = /^\/(?:youcai|commerce)(?:\/|$)/u.test(pathname || "")
    ? pathname.startsWith("/commerce") ? "带货创作" : "漫剧创作"
    : "";
  const requiredFeature = featurePermissionForPath(pathname || "/");
  const allowed = requiredFeature == null || (
    permission.status === "ready"
    && state.auth.isAuthenticated
    && Boolean(state.auth.token)
    && permission.snapshot != null
    && permission.snapshot.userId === state.auth.user?.id
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

  if (comingSoon && state.auth.user?.role !== "admin") return <FeatureComingSoonOverlay title={comingSoon} />;
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
