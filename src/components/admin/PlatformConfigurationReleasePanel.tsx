"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { WorkspaceSurface } from "@/lib/platform-configuration-contract";

type ReleaseKind = "model-pool" | "workspace-models";
type Row = Record<string, unknown>;
type CredentialChange = { modelKey: string; expectedExists: boolean; state: "pending" | "applied" };

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
  credentialChanges?: CredentialChange[];
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
    const credentials = Array.isArray(preview.credentialChanges) ? preview.credentialChanges.length : 0;
    return `新增 ${count(models.added)} · 移除 ${count(models.removed)} · 修改 ${count(models.changed)}${credentials ? ` · 凭据新增/替换 ${credentials} 项` : ""}`;
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

function credentialChangeRows(preview: Pick<Preview, "kind" | "credentialChanges">, release: Row, current: Row | null) {
  if (preview.kind !== "model-pool" || !Array.isArray(preview.credentialChanges)) return [];
  const models = [release, current].flatMap(row => {
    const snapshot = row?.snapshot;
    if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return [];
    const entries = (snapshot as Row).models;
    return Array.isArray(entries) ? entries.filter((entry): entry is Row => Boolean(entry && typeof entry === "object" && !Array.isArray(entry))) : [];
  });
  return preview.credentialChanges.map(change => {
    const model = models.find(entry => {
      const config = entry.configuration;
      if (!config || typeof config !== "object" || Array.isArray(config)) return false;
      return `${(config as Row).legacyTable}:${(config as Row).legacyId}` === change.modelKey;
    });
    const name = typeof model?.name === "string" && model.name.trim() ? model.name.trim() : "未命名模型";
    const historical = release.is_current !== true && ["published", "superseded"].includes(String(release.status));
    const state = change.state === "pending" ? "发布前尚未生效"
      : change.state === "applied" ? historical ? "已随历史版本生效，当前运行凭据以当前环境为准" : "已随该版本生效"
        : "状态待核对";
    // Only display-safe fields leave this projection. Never spread server metadata.
    return { name, operation: change.expectedExists === true ? "替换凭据" : "新增凭据", state };
  });
}

// Basic browser checks only; the server's canonical contract remains authoritative.
function readWorkspaceImport(value: unknown): Row {
  const surfaces: Record<WorkspaceSurface, "image" | "video"> = {
    "image-workbench": "image", "cover-studio": "image", "storyboard-image": "image", "free-canvas-image": "image", "film-studio-image": "image",
    "video-page": "video", "storyboard-video": "video", "free-canvas-video": "video", "film-studio-video": "video", "commerce-video": "video",
  };
  const object = (entry: unknown): entry is Row => Boolean(entry && typeof entry === "object" && !Array.isArray(entry));
  if (!object(value) || value.schema !== "workspace-model-config/v1") throw new Error("请选择工作台配置快照 JSON。");
  if (Object.keys(value).some((key) => !["schema", "modelPoolRelease", "surfaces"].includes(key))) throw new Error("快照包含不支持的字段。");
  const pool = value.modelPoolRelease;
  if (!object(pool) || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(pool.releaseId || "")) || !/^[0-9a-f]{64}$/i.test(String(pool.snapshotSha256 || ""))) throw new Error("模型资源池版本身份不完整。");
  if (Object.keys(pool).some((key) => !["releaseId", "snapshotSha256"].includes(key))) throw new Error("资源池身份包含不支持的字段。");
  if (!object(value.surfaces) || Object.keys(value.surfaces).length !== Object.keys(surfaces).length || Object.keys(value.surfaces).some((key) => !(key in surfaces))) throw new Error("快照必须包含完整的已知页面分配。");
  for (const [surface, kind] of Object.entries(surfaces)) {
    const entry = value.surfaces[surface];
    if (!object(entry) || entry.kind !== kind || Object.keys(entry).some((key) => !["kind", "assignedModelIds", "orderedModelIds"].includes(key)) || !Array.isArray(entry.assignedModelIds) || !Array.isArray(entry.orderedModelIds) || [...entry.assignedModelIds, ...entry.orderedModelIds].some((id) => typeof id !== "string" || !id.trim())) throw new Error("页面分配格式不完整。");
    const assigned = entry.assignedModelIds;
    const ordered = entry.orderedModelIds;
    if (new Set(assigned).size !== assigned.length || new Set(ordered).size !== ordered.length || ordered.some((id) => !assigned.includes(id))) throw new Error("页面模型必须唯一，排序只能引用已分配模型。");
  }
  return value;
}

export default function PlatformConfigurationReleasePanel({
  token,
  kind,
  refreshKey = 0,
  onPublished,
  focusReleaseId,
}: {
  token: string;
  kind: ReleaseKind;
  refreshKey?: number;
  onPublished?: () => void;
  focusReleaseId?: string | null;
}) {
  const endpoint = kind === "model-pool" ? "/api/admin/model-pool-releases" : "/api/admin/workspace-model-releases";
  const label = kind === "model-pool" ? "模型资源池" : "工作台模型";
  const [overview, setOverview] = useState<Overview | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [historyCredentials, setHistoryCredentials] = useState<Record<string, CredentialChange[]>>({});
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [expanded, setExpanded] = useState(false);
  const panelRef = useRef<HTMLElement>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [importSnapshot, setImportSnapshot] = useState<Row | null>(null);
  const [importSent, setImportSent] = useState(false);
  const importDispatchRef = useRef(false);
  const importReadRef = useRef(0);

  const readImportFile = async (file?: File) => {
    if (importDispatchRef.current) return;
    const sequence = ++importReadRef.current;
    setImportSnapshot(null);
    setError("");
    setNotice("");
    if (!file) return;
    try {
      if (file.size > 1024 * 1024) throw new Error("配置文件不能超过 1 MB。");
      const snapshot = readWorkspaceImport(JSON.parse(await file.text()));
      if (sequence === importReadRef.current) setImportSnapshot(snapshot);
    } catch (cause) {
      if (sequence === importReadRef.current) setError(cause instanceof SyntaxError ? "JSON 文件无法解析。" : messageOf(cause));
    }
  };

  const createImportedCandidate = async () => {
    if (kind !== "workspace-models" || !importSnapshot || importDispatchRef.current || busy || overview?.runtimeEnforcement.ready !== true) return;
    importDispatchRef.current = true;
    setImportSent(true);
    setBusy("import");
    setError("");
    setNotice("");
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ action: "draft", snapshot: importSnapshot, changeNote: "从已核对的配置快照导入候选" }),
      });
      const result = await json<{ release: Row }>(response);
      if (typeof result.release?.id !== "string" || !result.release.id) throw new Error("返回候选身份缺失。");
      setImportSnapshot(null);
      setPreview(null);
      setExpanded(true);
      setNotice(`已建立候选 v${version(result.release)}（${result.release.id}）；请校验并查看差异后再决定发布。`);
      await load();
    } catch (cause) {
      setError(`${messageOf(cause)} 请刷新版本列表核对结果，本次导入不会自动重试。`);
    } finally {
      setBusy("");
    }
  };

  useEffect(() => {
    if (!focusReleaseId) return;
    setExpanded(true);
    panelRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [focusReleaseId, refreshKey]);

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

  const readHistoricalCredentialState = async (releaseId: string) => {
    if (kind !== "model-pool") return;
    setBusy(`credentials:${releaseId}`);
    setError("");
    try {
      const response = await fetch(`${endpoint}?credentialReleaseId=${encodeURIComponent(releaseId)}`, {
        headers: { Authorization: `Bearer ${token}` }, cache: "no-store",
      });
      const data = await json<{ releaseId: string; credentialChanges: CredentialChange[] }>(response);
      if (data.releaseId !== releaseId || !Array.isArray(data.credentialChanges) || data.credentialChanges.some(change =>
        !change || typeof change.modelKey !== "string" || !change.modelKey || typeof change.expectedExists !== "boolean" || !["pending", "applied"].includes(change.state))) {
        throw new Error("凭据状态返回格式无效，请刷新后重试。");
      }
      setHistoryCredentials(current => ({ ...current, [releaseId]: data.credentialChanges }));
    } catch (cause) {
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
  const renderCredentialChanges = (row: Row, changes: CredentialChange[] | undefined, showEmpty = false) => {
    const credentials = credentialChangeRows({ kind, credentialChanges: changes }, row, overview?.current || null);
    if (!credentials.length) return showEmpty ? <p className="mt-2 text-xs text-[#667085]" data-testid="release-credential-empty">该版本没有凭据变更记录。</p> : null;
    return <div className="mt-2 rounded-md border border-[#b2ccff] bg-white px-3 py-2" aria-label="凭据变更摘要" data-testid="release-credential-changes">
      <p className="font-semibold">凭据新增/替换 {credentials.length} 项</p>
      <ul className="mt-1 space-y-1">
        {credentials.map((change, index) => <li key={index} className="break-words">{change.name} · {change.operation} · {change.state}</li>)}
      </ul>
    </div>;
  };
  const renderPreview = (row: Row) => {
    if (!preview || preview.candidate.releaseId !== String(row.id || "")) return null;
    return <div className="mt-3 rounded-md border border-[#b2ccff] bg-[#eff4ff] px-3 py-2 text-xs text-[#1849a9]">
      <p>v{preview.current?.releaseVersion || "无"} → v{preview.candidate.releaseVersion} · {diffSummary(preview)}</p>
      {renderCredentialChanges(row, preview.credentialChanges)}
      <span className="break-all font-mono text-[10px]">预览指纹 {preview.previewSha256}</span>
    </div>;
  };
  return (
    <section ref={panelRef} data-testid={`platform-release-panel-${kind}`} className="rounded-xl border border-[#d0d5dd] bg-[#f8fafc] p-4">
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
          {kind === "workspace-models" && <button type="button" onClick={() => setImportOpen((value) => !value)} disabled={Boolean(busy)} className="rounded-md border border-[#d0d5dd] bg-white px-3 py-2 text-xs font-semibold text-[#344054] disabled:opacity-50">导入配置候选</button>}
          {overview && !overview.current && candidates.length === 0 && (
            <button type="button" onClick={() => void bootstrap()} disabled={Boolean(busy) || runtime?.ready !== true} className="rounded-md bg-[#2563eb] px-3 py-2 text-xs font-semibold text-white hover:bg-[#1d4ed8] disabled:opacity-40">建立首个基线</button>
          )}
          <button type="button" onClick={() => void load()} disabled={Boolean(busy)} className="rounded-md border border-[#d0d5dd] bg-white px-3 py-2 text-xs font-semibold text-[#344054] hover:bg-[#f9fafb] disabled:opacity-50">刷新</button>
          <button type="button" onClick={() => setExpanded((value) => !value)} className="rounded-md border border-[#d0d5dd] bg-white px-3 py-2 text-xs font-semibold text-[#344054] hover:bg-[#f9fafb]">{expanded ? "收起版本" : "管理版本"}</button>
        </div>
      </div>

      {kind === "workspace-models" && importOpen && (
        <div className="mt-3 space-y-2 rounded-lg border border-[#d0d5dd] bg-white p-3" aria-label="导入配置候选">
          <label className="block text-xs font-semibold text-[#344054]">工作台配置 JSON
            <input type="file" accept=".json,application/json" disabled={Boolean(busy) || importSent} onChange={(event) => void readImportFile(event.currentTarget.files?.[0])} className="mt-2 block w-full text-xs" />
          </label>
          <p className="text-xs leading-5 text-[#667085]">只创建候选，不发布。文件仅在本页读取，版本差异仍需单独校验与审阅。</p>
          {importSnapshot && <div role="status" className="text-xs leading-5 text-[#475467]">
            <p>资源池版本：{String((importSnapshot.modelPoolRelease as Row).releaseId)}</p>
            {Object.entries(importSnapshot.surfaces as Row).map(([surface, entry]) => <p key={surface}>{surface}：{((entry as Row).assignedModelIds as string[]).length} 个分配 · {((entry as Row).orderedModelIds as string[]).length} 个排序</p>)}
          </div>}
          <button type="button" onClick={() => void createImportedCandidate()} disabled={!importSnapshot || Boolean(busy) || importSent || runtime?.ready !== true} className="rounded-md bg-[#2563eb] px-3 py-2 text-xs font-semibold text-white disabled:opacity-40">{importSent ? "本次导入已提交" : "确认创建候选"}</button>
        </div>
      )}

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
              <article key={releaseId} data-release-id={releaseId} className={`rounded-lg border bg-white p-3 ${releaseId === focusReleaseId ? "border-[#2563eb] ring-2 ring-[#b2ccff]" : "border-[#d0d5dd]"}`}>
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
                {isPreviewed && renderPreview(row)}
              </article>
            );
          })}

          {history.length > 0 && (
            <details>
              <summary className="cursor-pointer text-xs font-semibold text-[#475467]">历史发布与回滚（{history.length}）</summary>
              <div className="mt-2 space-y-2">
                {history.slice(0, 20).map((row) => <div key={String(row.id)} data-history-release-id={String(row.id)} className="rounded-md border border-[#eaecf0] bg-white px-3 py-2 text-xs">
                  <div className="flex flex-wrap items-center justify-between gap-2"><span>v{version(row)} · {String(row.status)} · {String(row.change_note || "无说明")}</span><div className="flex flex-wrap gap-2">
                    {kind === "model-pool" && <button type="button" disabled={Boolean(busy)} onClick={() => void readHistoricalCredentialState(String(row.id))} className="rounded border border-[#d0d5dd] px-2 py-1 font-semibold text-[#344054] disabled:opacity-50">查看凭据状态</button>}
                    {row.status === "superseded" && <button type="button" disabled={Boolean(busy)} onClick={() => void mutate("rollback", row)} className="rounded border border-[#d0d5dd] px-2 py-1 font-semibold text-[#344054] disabled:opacity-50">建立回滚候选</button>}
                  </div></div>
                  {kind === "model-pool" && Object.hasOwn(historyCredentials, String(row.id)) && renderCredentialChanges(row, historyCredentials[String(row.id)], true)}
                </div>)}
              </div>
            </details>
          )}
        </div>
      )}
    </section>
  );
}
