"use client";

import { useCallback, useEffect, useState } from "react";

interface ReadOnlyModelRow {
  id: string;
  name: string;
  model_type?: string;
  billing_mode?: string;
  selling_price?: number;
  price_per_use?: number;
  is_active?: boolean;
  is_hidden?: boolean;
  description?: string;
  category?: string;
}

const ADMIN_MODEL_CATALOG_TIMEOUT_MS = 20_000;

export function UnifiedModelsReadOnlyAdminTab({ token }: { token: string | null }) {
  const [models, setModels] = useState<ReadOnlyModelRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const loadModels = useCallback(async (signal?: AbortSignal) => {
    if (!token) {
      setModels([]);
      setError("管理员登录已失效，请重新登录");
      setLoading(false);
      return;
    }
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/admin/models", {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
        signal,
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload?.error || "模型目录读取失败");
      setModels(Array.isArray(payload?.models) ? payload.models : []);
    } catch (loadError) {
      if (signal?.aborted && signal.reason !== "timeout") return;
      setModels([]);
      setError(signal?.reason === "timeout"
        ? "模型目录响应超时，请刷新目录重试"
        : loadError instanceof Error ? loadError.message : "模型目录读取失败");
    } finally {
      if (!signal?.aborted || signal.reason === "timeout") setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort("timeout"), ADMIN_MODEL_CATALOG_TIMEOUT_MS);
    void loadModels(controller.signal);
    return () => {
      window.clearTimeout(timeoutId);
      controller.abort();
    };
  }, [loadModels]);

  return (
    <section className="space-y-4" data-testid="models-read-only-catalog">
      <div className="rounded-2xl border border-[var(--border)] bg-[var(--card)] p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="text-lg font-bold text-[var(--foreground)]">模型资源池</h3>
            <p className="mt-1 text-xs leading-5 text-[var(--muted-foreground)]">
              当前岗位只读取可用模型、公开售价和能力说明；供应商凭据、内部成本、路由参数和健康诊断不会发送到浏览器。
            </p>
          </div>
          <button
            type="button"
            onClick={() => void loadModels()}
            disabled={loading}
            className="rounded-lg border border-[var(--border)] px-3 py-2 text-xs font-semibold text-[var(--secondary-foreground)] disabled:opacity-50"
          >
            {loading ? "读取中…" : "刷新目录"}
          </button>
        </div>
      </div>

      {error ? (
        <div role="alert" className="rounded-2xl border border-rose-500/25 bg-rose-500/8 p-5 text-sm font-semibold text-rose-600">
          {error}。系统未用空数据冒充真实模型。
        </div>
      ) : loading ? (
        <div className="rounded-2xl border border-[var(--border)] bg-[var(--card)] p-8 text-center text-sm text-[var(--muted-foreground)]">正在读取模型目录…</div>
      ) : models.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-[var(--border)] bg-[var(--card)] p-8 text-center text-sm text-[var(--muted-foreground)]">当前没有可见模型。</div>
      ) : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {models.map((model) => {
            const price = Number(model.selling_price ?? model.price_per_use ?? 0);
            return (
              <article key={model.id} className="rounded-2xl border border-[var(--border)] bg-[var(--card)] p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h4 className="truncate font-semibold text-[var(--foreground)]">{model.name || "未命名模型"}</h4>
                    <p className="mt-1 text-xs text-[var(--muted-foreground)]">{model.model_type || model.category || "未标注类型"}</p>
                  </div>
                  <span className={`shrink-0 rounded-full px-2 py-1 text-[10px] font-semibold ${model.is_active === false || model.is_hidden ? "bg-slate-500/10 text-slate-500" : "bg-emerald-500/10 text-emerald-600"}`}>
                    {model.is_active === false || model.is_hidden ? "暂不可用" : "可用"}
                  </span>
                </div>
                {model.description && <p className="mt-3 line-clamp-2 text-xs leading-5 text-[var(--secondary-foreground)]">{model.description}</p>}
                <div className="mt-4 flex items-center justify-between border-t border-[var(--border)] pt-3 text-xs">
                  <span className="text-[var(--muted-foreground)]">{model.billing_mode || "平台计费"}</span>
                  <span className="font-semibold text-[var(--foreground)]">{Number.isFinite(price) ? `¥${price.toFixed(4)}` : "价格未提供"}</span>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
