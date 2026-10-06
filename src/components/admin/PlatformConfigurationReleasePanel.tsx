"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

type ReleaseKind = "model-pool" | "workspace-models";
type Row = Record<string, unknown>;

type RuntimeStatus = {
  ready: boolean;
  code: string;
  blockers: string[];
  checkedAt?: string;
};

type Overview = {
  releases: Row[];
  current: Row | null;
  runtimeEnforcement: RuntimeStatus;
};

type Preview = {
  kind: ReleaseKind;
  current: { releaseId: string; releaseVersion: number; snapshotSha256: string } | null;
  candidate: { releaseId: string; releaseVersion: number; snapshotSha256: string };
  diff: Row;
  previewSha256: string;
};

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : "操作失败";
}

async function json<T>(response: Response): Promise<T> {
  const data = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw new Error(data.error || "请求失败");
  return data;
}

function version(row: Row | null | undefined) {
  return row ? Number(row.release_version || 0) : 0;
}

function validation(row: Row) {
  const value = row.validation_result;
  return value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
}

function diffSummary(preview: Preview) {
  if (preview.kind === "model-pool") {
    const models = (preview.diff.models && typeof preview.diff.models === "object" ? preview.diff.models : {}) as Row;
    const count = (value: unknown) => Array.isArray(value) ? value.length : 0;
    return `新增 ${count(models.added)} · 移除 ${count(models.removed)} · 修改 ${count(models.changed)}`;
  }
  const surfaces = Array.isArray(preview.diff.surfaces) ? preview.diff.surfaces as Row[] : [];
  const changed = surfaces.filter((surface) => surface.changed === true);
  const additions = changed.reduce((sum, surface) => {
    const assignments = surface.assignments && typeof surface.assignments === "object" ? surface.assignments as Row : {};
    return sum + (Array.isArray(assignments.added) ? assignments.added.length : 0);
  }, 0);
  const removals = changed.reduce((sum, surface) => {
    const assignments = surface.assignments && typeof surface.assignments === "object" ? surface.assignments as Row : {};
    return sum + (Array.isArray(assignments.removed) ? assignments.removed.length : 0);
  }, 0);
  return `变更页面 ${changed.length} · 新增分配 ${additions} · 移除分配 ${removals}`;
}

export default function PlatformConfigurationReleasePanel({
  token,
  kind,
  refreshKey = 0,
  onPublished,
}: {
  token: string;
  kind: ReleaseKind;
  refreshKey?: number;
  onPublished?: () => void;
}) {
  const endpoint = kind === "model-pool" ? "/api/admin/model-pool-releases" : "/api/admin/workspace-model-releases";
  const label = kind === "model-pool" ? "模型资源池" : "工作台模型";
  const [overview, setOverview] = useState<Overview | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [expanded, setExpanded] = useState(false);

  const load = useCallback(async () => {
    if (!token) return;
    setError("");
    try {
      const response = await fetch(endpoint, {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
      });
      setOverview(await json<Overview>(response));
    } catch (cause) {
      setOverview(null);
      setError(messageOf(cause));
    }
  }, [endpoint, token]);

  useEffect(() => { void load(); }, [load, refreshKey]);

  const candidates = useMemo(() => (overview?.releases || []).filter((row) =>
    row.is_current !== true && ["draft", "validated"].includes(String(row.status))), [overview]);
  const history = useMemo(() => (overview?.releases || []).filter((row) =>
    row.is_current !== true && ["published", "superseded"].includes(String(row.status))), [overview]);

  const previewRelease = async (releaseId: string) => {
    setBusy(`preview:${releaseId}`);
    setError("");
    setNotice("");
    try {
      const response = await fetch(`${endpoint}?previewReleaseId=${encodeURIComponent(releaseId)}`, {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
      });
      const data = await json<{ preview: Preview }>(response);
      setPreview(data.preview);
      setNotice("差异预览已锁定；发布时会再次校验该指纹。");
    } catch (cause) {
      setPreview(null);
      setError(messageOf(cause));
    } finally {
      setBusy("");
    }
  };

  const bootstrap = async () => {
    setBusy("bootstrap");
    setError("");
    setNotice("");
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ action: "bootstrap", changeNote: `从当前运行配置建立${label}版本化基线` }),
      });
      await json(response);
      setExpanded(true);
      setNotice("迁移基线候选已建立；请检查校验结果和差异预览后再发布。");
      await load();
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy("");
    }
  };

  const mutate = async (action: "validate" | "publish" | "rollback", row: Row) => {
    const releaseId = String(row.id || "");
    if (!releaseId) return;
    if (action === "publish") {
      if (preview?.candidate.releaseId !== releaseId) {
        setError("请先读取该候选的差异预览，再发布同一版本。");
        return;
      }
      if (!window.confirm(`确认把${label}候选 v${version(row)} 原子发布为当前版本？`)) return;
    }
    setBusy(`${action}:${releaseId}`);
    setError("");
    setNotice("");
    try {
      const body = action === "rollback"
        ? { action, targetId: releaseId, changeNote: `从 v${version(row)} 创建回滚候选` }
        : action === "publish"
          ? { action, releaseId, previewSha256: preview!.previewSha256 }
          : { action, releaseId };
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      await json(response);
      setPreview(null);
      setNotice(action === "validate" ? "候选已重新校验。" : action === "rollback" ? "已从历史版本建立回滚候选，请预览后发布。" : "已原子发布并完成数据库读回。");
      await load();
      if (action === "publish") onPublished?.();
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy("");
    }
  };

  const runtime = overview?.runtimeEnforcement;
  return (
    <section data-testid={`platform-release-panel-${kind}`} className="rounded-xl border border-[#d0d5dd] bg-[#f8fafc] p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-bold text-[#172033]">{label}发布闭环</h3>
            <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${runtime?.ready ? "bg-[#dcfae6] text-[#067647]" : "bg-[#fef0c7] text-[#93370d]"}`}>
              {runtime?.ready ? "数据库门禁已读回" : "发布门禁待核对"}
            </span>
            <span className="rounded-full bg-white px-2 py-0.5 text-[11px] font-semibold text-[#475467]">当前 {overview?.current ? `v${version(overview.current)}` : "未发布"}</span>
            {candidates.length > 0 && <span className="rounded-full bg-[#eff4ff] px-2 py-0.5 text-[11px] font-semibold text-[#175cd3]">候选 {candidates.length}</span>}
          </div>
          <p className="mt-1 text-xs leading-5 text-[#667085]">保存只建立不可变候选；必须依次完成校验、差异预览和原子发布，运行端才会采用。密钥不会进入预览。</p>
        </div>
        <div className="flex gap-2">
          {overview && !overview.current && candidates.length === 0 && (
            <button type="button" onClick={() => void bootstrap()} disabled={Boolean(busy) || runtime?.ready !== true} className="rounded-md bg-[#2563eb] px-3 py-2 text-xs font-semibold text-white hover:bg-[#1d4ed8] disabled:opacity-40">建立首个基线</button>
          )}
          <button type="button" onClick={() => void load()} disabled={Boolean(busy)} className="rounded-md border border-[#d0d5dd] bg-white px-3 py-2 text-xs font-semibold text-[#344054] hover:bg-[#f9fafb] disabled:opacity-50">刷新</button>
          <button type="button" onClick={() => setExpanded((value) => !value)} className="rounded-md border border-[#d0d5dd] bg-white px-3 py-2 text-xs font-semibold text-[#344054] hover:bg-[#f9fafb]">{expanded ? "收起版本" : "管理版本"}</button>
        </div>
      </div>

      {error && <p role="alert" className="mt-3 rounded-md border border-[#fecdca] bg-[#fef3f2] px-3 py-2 text-xs text-[#b42318]">{error}</p>}
      {notice && <p className="mt-3 rounded-md border border-[#abefc6] bg-[#ecfdf3] px-3 py-2 text-xs text-[#067647]">{notice}</p>}
      {runtime && !runtime.ready && runtime.blockers.length > 0 && (
        <p className="mt-3 rounded-md border border-[#fedf89] bg-[#fffaeb] px-3 py-2 text-xs text-[#93370d]">发布保持关闭：{runtime.blockers.join("；")}</p>
      )}

      {expanded && (
        <div className="mt-4 space-y-3">
          {candidates.length === 0 ? (
            <div className="rounded-md border border-dashed border-[#d0d5dd] bg-white px-4 py-5 text-center text-xs text-[#667085]">暂无未发布候选。编辑模型、排序或调整工作台分配后会自动建立候选。</div>
          ) : candidates.map((row) => {
            const checked = validation(row);
            const releaseId = String(row.id || "");
            const isPreviewed = preview?.candidate.releaseId === releaseId;
            const issues = Array.isArray(checked.issues) ? checked.issues.map(String) : [];
            const warnings = Array.isArray(checked.warnings) ? checked.warnings.map(String) : [];
            return (
              <article key={releaseId} className="rounded-lg border border-[#d0d5dd] bg-white p-3">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-bold text-[#172033]">候选 v{version(row)} · {String(row.status || "draft")}</p>
                    <p className="mt-1 text-xs text-[#667085]">{String(row.change_note || "未填写变更说明")}</p>
                    <p className="mt-1 break-all font-mono text-[10px] text-[#98a2b3]">{String(row.snapshot_sha256 || "")}</p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <button type="button" disabled={Boolean(busy)} onClick={() => void mutate("validate", row)} className="rounded-md border border-[#d0d5dd] px-3 py-1.5 text-xs font-semibold text-[#344054] disabled:opacity-50">重新校验</button>
                    <button type="button" disabled={Boolean(busy)} onClick={() => void previewRelease(releaseId)} className="rounded-md border border-[#84adff] px-3 py-1.5 text-xs font-semibold text-[#175cd3] disabled:opacity-50">查看差异</button>
                    <button type="button" disabled={Boolean(busy) || row.status !== "validated" || !isPreviewed || runtime?.ready !== true} onClick={() => void mutate("publish", row)} className="rounded-md bg-[#2563eb] px-3 py-1.5 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:opacity-40">按预览发布</button>
                  </div>
                </div>
                {issues.length > 0 && <p className="mt-2 text-xs text-[#b42318]">阻断：{issues.join("；")}</p>}
                {warnings.length > 0 && <p className="mt-1 text-xs text-[#93370d]">提醒：{warnings.join("；")}</p>}
                {isPreviewed && <div className="mt-3 rounded-md border border-[#b2ccff] bg-[#eff4ff] px-3 py-2 text-xs text-[#1849a9]">v{preview.current?.releaseVersion || "无"} → v{preview.candidate.releaseVersion} · {diffSummary(preview)}<br /><span className="break-all font-mono text-[10px]">预览指纹 {preview.previewSha256}</span></div>}
              </article>
            );
          })}

          {history.length > 0 && (
            <details>
              <summary className="cursor-pointer text-xs font-semibold text-[#475467]">历史发布与回滚（{history.length}）</summary>
              <div className="mt-2 space-y-2">
                {history.slice(0, 20).map((row) => <div key={String(row.id)} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-[#eaecf0] bg-white px-3 py-2 text-xs"><span>v{version(row)} · {String(row.status)} · {String(row.change_note || "无说明")}</span>{row.status === "superseded" && <button type="button" disabled={Boolean(busy)} onClick={() => void mutate("rollback", row)} className="rounded border border-[#d0d5dd] px-2 py-1 font-semibold text-[#344054] disabled:opacity-50">建立回滚候选</button>}</div>)}
              </div>
            </details>
          )}
        </div>
      )}
    </section>
  );
}
