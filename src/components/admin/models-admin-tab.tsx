"use client";

import dynamic from "next/dynamic";

const UnifiedModelsTab = dynamic(
  () => import("@/components/unified-models-tab").then((module) => module.default),
  { ssr: false, loading: () => <AuthorizedModuleLoading /> },
);
const UnifiedModelsReadOnlyAdminTab = dynamic(
  () => import("@/components/admin/unified-models-read-only-admin-tab").then((module) => module.UnifiedModelsReadOnlyAdminTab),
  { ssr: false, loading: () => <AuthorizedModuleLoading /> },
);

function AuthorizedModuleLoading() {
  return <div className="rounded-2xl border border-[var(--border)] bg-[var(--card)] p-8 text-sm text-[var(--muted-foreground)]">正在加载已授权模型目录…</div>;
}

type ModelSettingKey =
  | "cover_workflow_api_url"
  | "cover_workflow_app_id"
  | "cover_workflow_token";

interface ModelSettingsSnapshot {
  cover_workflow_api_url: string;
  cover_workflow_app_id: string;
  cover_workflow_token: string;
  cover_workflow_token_configured?: boolean;
}

interface ModelsAdminTabProps {
  token: string | null;
  canManageModelsPermission: boolean;
  sensitiveUnlocked: boolean;
  canManagePlugins: boolean;
  canManagePaymentSettings: boolean;
  settings: ModelSettingsSnapshot;
  settingsSaving: boolean;
  updateSetting: (key: ModelSettingKey, value: string) => void;
  saveModelSettings: () => void;
  onModelsChange: () => void | Promise<void>;
}

const inputCls = "w-full px-3 py-2.5 bg-[var(--card)] border border-[var(--border)] rounded-xl text-sm text-[var(--foreground)] outline-none focus:border-[var(--primary)] transition-colors placeholder-[var(--muted-foreground)]";

export function ModelsAdminTab({
  token,
  canManageModelsPermission,
  sensitiveUnlocked,
  canManagePlugins,
  canManagePaymentSettings,
  settings,
  settingsSaving,
  updateSetting,
  saveModelSettings,
  onModelsChange,
}: ModelsAdminTabProps) {
  const canManageModels = canManageModelsPermission && sensitiveUnlocked;

  return (
    <div className="space-y-6" data-testid="authorized-models-admin-tab">
      {canManageModelsPermission ? (
        <UnifiedModelsTab
          token={token}
          onModelsChange={onModelsChange}
          canManageModels={canManageModels}
          canManagePlugins={canManagePlugins && sensitiveUnlocked}
          canManagePaymentSettings={canManagePaymentSettings && sensitiveUnlocked}
        />
      ) : (
        <UnifiedModelsReadOnlyAdminTab token={token} />
      )}

      {canManageModelsPermission && (
        <div className="rounded-2xl border border-[var(--border)] bg-[var(--card)] p-6">
          <h3 className="font-semibold text-[var(--foreground)] mb-1">封面工作流连接</h3>
          <p className="text-xs text-[var(--muted-foreground)] mb-3">配置封面制作页面调用的 Coze Coding 工作流，工作流内置模型和风格。</p>
          <div className="space-y-3">
            <div>
              <label className="text-xs font-medium text-[var(--foreground)]">Stream Run URL</label>
              <input value={settings.cover_workflow_api_url || ""} onChange={(event) => updateSetting("cover_workflow_api_url", event.target.value)} className={inputCls} placeholder="https://xxxxx.coze.site/stream_run" />
            </div>
            <div>
              <label className="text-xs font-medium text-[var(--foreground)]">App ID</label>
              <input value={settings.cover_workflow_app_id || ""} onChange={(event) => updateSetting("cover_workflow_app_id", event.target.value)} className={inputCls} placeholder="应用 ID" />
            </div>
            <div>
              <label className="text-xs font-medium text-[var(--foreground)]">API Token</label>
              <input value={settings.cover_workflow_token || ""} onChange={(event) => updateSetting("cover_workflow_token", event.target.value)} className={inputCls} type="password" placeholder={settings.cover_workflow_token_configured ? "已配置；留空保留原密钥" : "粘贴工作流访问令牌"} />
              <p className="text-[10px] text-[var(--muted-foreground)] mt-1">从封面工作流部署页的 API 请求中获取。</p>
            </div>
          </div>
          <div className="flex items-center gap-4 mt-4">
            <span className="text-xs text-[var(--muted-foreground)]">修改后需手动保存</span>
            <button onClick={saveModelSettings} disabled={settingsSaving || !canManageModels} className="px-4 py-1.5 rounded-lg bg-[var(--primary)] text-[var(--primary-foreground)] font-bold text-xs hover:opacity-90 transition disabled:opacity-50">
              {settingsSaving ? "保存中..." : "保存"}
            </button>
            {settings.cover_workflow_token || settings.cover_workflow_token_configured ? (
              <div className="text-sm flex items-center gap-2 text-[var(--success)]"><span className="w-2 h-2 rounded-full bg-[var(--success)]" />已配置</div>
            ) : (
              <div className="text-sm flex items-center gap-2 text-[var(--destructive)]"><span className="w-2 h-2 rounded-full bg-[var(--destructive)]" />未配置</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
