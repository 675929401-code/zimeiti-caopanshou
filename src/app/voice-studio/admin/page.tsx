'use client';

import { SubPageHeader } from '@/components/sub-page-header';
import { VoiceStudioAdminTab } from '@/components/admin/VoiceStudioAdminTab';
import { useApp } from '@/contexts/app-context';
import { safeGetItem } from '@/lib/safe-storage';
import { STORAGE_KEYS } from '@/lib/storage-keys';
import { Settings } from 'lucide-react';
import { useEffect, useState } from 'react';

/**
 * 智音工坊后台入口 — 原生管理面板
 * 直接接入主站 admin/voices API，不使用 iframe
 */
export default function VoiceStudioAdminPage() {
  const { state } = useApp();
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);
  const isAdmin = state.auth.isAuthenticated && state.auth.user?.role === 'admin';
  const isRestoringSession = hydrated && !state.auth.isAuthenticated && Boolean(safeGetItem(STORAGE_KEYS.AUTH_TOKEN));

  if (!hydrated || isRestoringSession) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[var(--background)] px-6 text-center">
        <div aria-live="polite" role="status" className="max-w-md rounded-xl border border-[var(--border)] bg-[var(--card)] p-8">
          <Settings className="mx-auto mb-4 h-8 w-8 animate-pulse text-[var(--muted-foreground)]" />
          <h1 className="text-lg font-semibold text-[var(--foreground)]">正在核验管理员身份</h1>
          <p className="mt-2 text-sm text-[var(--muted-foreground)]">正在恢复当前登录状态，请稍候。</p>
        </div>
      </div>
    );
  }

  if (!isAdmin) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[var(--background)] px-6 text-center">
        <div className="max-w-md rounded-xl border border-[var(--border)] bg-[var(--card)] p-8">
          <Settings className="mx-auto mb-4 h-8 w-8 text-[var(--muted-foreground)]" />
          <h1 className="text-lg font-semibold text-[var(--foreground)]">仅管理员可访问智音工坊后台</h1>
          <p className="mt-2 text-sm text-[var(--muted-foreground)]">请返回首页并使用管理员账号登录。</p>
          <a className="mt-5 inline-flex rounded-lg border border-[var(--border)] px-4 py-2 text-sm text-[var(--foreground)]" href="/">
            返回首页登录
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-screen overflow-hidden" style={{ background: 'var(--background)' }}>
      <SubPageHeader
        title="智音工坊管理后台"
        subtitle="语音配置 · 音色管理 · 数据统计"
        icon={<Settings className="w-5 h-5" />}
        backHref="/admin"
      />

      <main className="flex-1 overflow-y-auto p-6">
        <VoiceStudioAdminTab />
      </main>
    </div>
  );
}
