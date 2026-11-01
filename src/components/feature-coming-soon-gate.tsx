"use client";

import { useApp } from "@/contexts/app-context";
import { useRouter } from "next/navigation";
import { ArrowLeft, Sparkles } from "lucide-react";

/** 独立的玻璃遮罩层，可被路由守卫或入口点击复用。 */
export function FeatureComingSoonOverlay({ title, onClose }: { title: string; onClose?: () => void }) {
  const router = useRouter();
  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-[color-mix(in_srgb,var(--background)_55%,transparent)] backdrop-blur-md p-6" data-testid="feature-coming-soon">
      <section className="w-full max-w-md rounded-2xl border border-[var(--border)] bg-[color-mix(in_srgb,var(--card)_88%,transparent)] p-7 shadow-2xl">
        <div className="mb-4 flex h-11 w-11 items-center justify-center rounded-xl bg-[var(--primary)]/12 text-[var(--primary)]">
          <Sparkles className="h-5 w-5" />
        </div>
        <h1 className="text-lg font-semibold text-[var(--foreground)]">{title} 正在开发中</h1>
        <p className="mt-2 text-sm leading-6 text-[var(--text-secondary)]">
          该模块还在打磨，暂不对普通账号开放。上线后会在这里直接可用，不需要重新申请。
        </p>
        <div className="mt-6 flex items-center gap-2">
          <button type="button" onClick={() => { onClose?.(); router.push("/?view=marketplace"); }}
            className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--primary)] px-3.5 py-2 text-sm font-medium text-[var(--primary-foreground)] transition-opacity hover:opacity-90">
            <ArrowLeft className="h-4 w-4" />返回应用广场
          </button>
          <button type="button" onClick={() => { onClose?.(); router.back(); }}
            className="rounded-lg border border-[var(--border)] px-3.5 py-2 text-sm text-[var(--text-secondary)] transition-colors hover:text-[var(--foreground)]">
            回到上一页
          </button>
        </div>
      </section>
    </div>
  );
}

/**
 * 用户端“开发中”玻璃遮罩：管理员可直接进入，普通用户看到提示。
 * 只做展示层拦截，不改变路由与权限合同。
 */
export function FeatureComingSoonGate({ title, children }: { title: string; children: React.ReactNode }) {
  const { state } = useApp();
  const isAdmin = state.auth.user?.role === "admin";
  if (isAdmin) return <>{children}</>;

  return (
    <div className="relative min-h-screen">
      <div aria-hidden="true" className="pointer-events-none select-none blur-[2px] opacity-60">{children}</div>
      <FeatureComingSoonOverlay title={title} />
    </div>
  );
}
