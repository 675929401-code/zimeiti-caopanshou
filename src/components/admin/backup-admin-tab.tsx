"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

const cardCls = "bg-[var(--card)] rounded-2xl p-6 border border-[var(--border)]";
const btnPrimary = "px-4 py-2.5 bg-[var(--card)] text-[var(--foreground)] border border-[var(--border)] rounded-xl text-sm font-semibold hover:bg-[var(--accent)] hover:border-[var(--primary)]/30 transition-colors";

interface BackupSummary {
  userCount: number;
  totalCredits: number;
  totalCash: number;
}
interface BackupStatus {
  exists: boolean;
  backupTime?: string;
  fileSize?: string;
  summary?: BackupSummary;
  tableCounts?: Record<string, number>;
}
interface BackupMessage {
  type: "success" | "error";
  text: string;
}
interface BackupControlTarget {
  targetKey: string;
  displayName: string;
  objectiveRpoLabel: string;
  objectiveRtoLabel: string;
  operationalStatus: "unavailable" | "configured" | "healthy" | "degraded" | "failed";
  statusReason: string;
  retentionEvidenceStatus: string;
  immutabilityEvidenceStatus: string;
  encryptionEvidenceStatus: string;
  replicationEvidenceStatus: string;
  pitrEvidenceStatus: string;
  latestSuccessfulBackupAt: string | null;
  latestVerifiedAt: string | null;
}
interface BackupControlPlaneSnapshot {
  generatedAt: string;
  schemaState: "available" | "unavailable";
  evidenceState: "available" | "partial" | "unavailable";
  targets: BackupControlTarget[];
  consistency: {
    targetCoverage: { expected: number; registered: number; externallyVerified: number };
    backupRunCoverage: { expectedTargets: number; verifiedTargets: number };
    protectionCoverage: { expectedTargets: number; verifiedTargets: number };
    restoreDrillCoverage: { expectedTargets: number; verifiedTargets: number };
    latestVerifiedRpoRto: {
      targetKey: string;
      measuredAt: string | null;
      observedRpoSeconds: number | null;
      observedRtoSeconds: number | null;
    } | null;
    issues: Array<{ code: string; severity: "warning" | "error"; subject: string; message: string }>;
  };
  executionBoundary: {
    mode: "plan_request_approval_only";
    backupExecutionEnabled: false;
    restoreExecutionEnabled: false;
    externalUploadEnabled: false;
    deletionEnabled: false;
    serviceSwitchEnabled: false;
  };
}
export function BackupAdminTab({ token }: { token: string | null }) {
  const [backupStatus, setBackupStatus] = useState<BackupStatus | null>(null);
  const [controlPlane, setControlPlane] = useState<BackupControlPlaneSnapshot | null>(null);
  const [controlPlaneError, setControlPlaneError] = useState("");
  const [loading, setLoading] = useState(false);
  const [backingUp, setBackingUp] = useState(false);
  const [message, setMessage] = useState<BackupMessage | null>(null);

  const authHeaders = useMemo(() => ({ "Content-Type": "application/json", Authorization: `Bearer ${token}` }), [token]);

  /* 加载备份状态 */
  const loadStatus = useCallback(async () => {
    setLoading(true);
    setControlPlaneError("");
    try {
      const [localResponse, controlResponse] = await Promise.all([
        fetch("/api/admin/backup", { headers: authHeaders }),
        fetch("/api/admin/backup-restore-control-plane", { headers: authHeaders, cache: "no-store" }),
      ]);
      if (localResponse.ok) setBackupStatus(await localResponse.json());
      const controlBody = await controlResponse.json().catch(() => ({}));
      if (!controlResponse.ok) throw new Error(String(controlBody.error || "灾备证据状态读取失败"));
      setControlPlane(controlBody as BackupControlPlaneSnapshot);
    } catch (err) {
      console.error("查询备份状态失败:", err);
      setControlPlaneError(err instanceof Error ? err.message : "灾备证据状态读取失败");
    } finally {
      setLoading(false);
    }
  }, [authHeaders]);

  useEffect(() => { void loadStatus(); }, [loadStatus]);

  // 防抖保护：在 textarea/input 中按 Backspace 时不触发浏览器后退
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "Backspace") return;
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "TEXTAREA") return; // textarea 已在 onKeyDown 中单独处理
      if (tag === "INPUT") {
        const input = e.target as HTMLInputElement;
        // 只在文本输入框光标在起始位置且无选中时阻止
        if (input.type === "text" || input.type === "search" || input.type === "password" || input.type === "number") {
          if (input.selectionStart === 0 && input.selectionStart === input.selectionEnd) {
            e.preventDefault();
          }
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  /* 手动备份 */
  const handleBackup = async () => {
    if (!confirm("确认创建本机临时快照？此操作会覆盖上一份本机快照，且不会生成外部灾备或恢复演练回执。")) return;
    setBackingUp(true);
    setMessage(null);
    try {
      const res = await fetch("/api/admin/backup", { method: "POST", headers: authHeaders });
      const data = await res.json();
      if (res.ok) {
        setMessage({ type: "success", text: `备份成功！共 ${String(data.summary?.userCount ?? 0)} 个用户，积分合计 ${String(data.summary?.totalCredits ?? 0)}，现金合计 ¥${String(data.summary?.totalCash ?? 0)}` });
        loadStatus();
      } else {
        setMessage({ type: "error", text: data.error || "备份失败" });
      }
    } catch (err) {
      setMessage({ type: "error", text: "备份异常: " + (err instanceof Error ? err.message : String(err)) });
    } finally {
      setBackingUp(false);
    }
  };

  const exists = backupStatus?.exists as boolean;

  return (
    <div className="space-y-6">
      {/* 提示信息 */}
      {message && (
        <div className={`p-3 rounded-xl text-sm ${message.type === "success" ? "bg-green-500/10 text-green-600 border border-green-500/20" : "bg-red-500/10 text-red-600 border border-red-500/20"}`}>
          {message.text}
        </div>
      )}

      {/* 灾备证据状态 */}
      <div className={cardCls} data-testid="backup-restore-evidence-panel">
        <div className="flex flex-wrap items-start justify-between gap-3 mb-4">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-base font-semibold text-[var(--foreground)]">灾备与恢复证据</h3>
              <span className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold ${controlPlane?.evidenceState === "available" ? "border-green-500/20 bg-green-500/10 text-green-700" : controlPlane?.evidenceState === "partial" ? "border-amber-500/20 bg-amber-500/10 text-amber-700" : "border-slate-500/20 bg-slate-500/10 text-slate-600"}`}>
                {controlPlane?.evidenceState === "available" ? "证据完整" : controlPlane?.evidenceState === "partial" ? "部分证据" : "暂无外部证据"}
              </span>
            </div>
            <p className="mt-1 text-xs leading-relaxed text-[var(--muted-foreground)]">
              目标策略与实际运行分开显示。只有外部备份、校验和、不可变副本和隔离恢复回执齐全后，才会报告实际 RPO/RTO。
            </p>
          </div>
          <button onClick={loadStatus} disabled={loading} className="text-xs font-semibold text-[var(--primary)] hover:underline">
            {loading ? "读取中…" : "刷新证据"}
          </button>
        </div>

        {controlPlaneError && (
          <div role="alert" className="mb-4 rounded-xl border border-red-500/20 bg-red-500/5 px-3 py-2 text-xs text-red-700">
            {controlPlaneError}；未将未知状态显示为正常。
          </div>
        )}

        {controlPlane ? (
          <>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              {[
                ["已登记目标", `${controlPlane.consistency.targetCoverage.registered}/${controlPlane.consistency.targetCoverage.expected}`],
                ["已核验备份", `${controlPlane.consistency.backupRunCoverage.verifiedTargets}/${controlPlane.consistency.backupRunCoverage.expectedTargets}`],
                ["不可变保护", `${controlPlane.consistency.protectionCoverage.verifiedTargets}/${controlPlane.consistency.protectionCoverage.expectedTargets}`],
                ["隔离恢复演练", `${controlPlane.consistency.restoreDrillCoverage.verifiedTargets}/${controlPlane.consistency.restoreDrillCoverage.expectedTargets}`],
              ].map(([label, value]) => (
                <div key={label} className="rounded-xl border border-[var(--border)] bg-[var(--background)] p-3">
                  <p className="text-[11px] text-[var(--muted-foreground)]">{label}</p>
                  <p className="mt-1 text-xl font-black text-[var(--foreground)]">{value}</p>
                </div>
              ))}
            </div>

            <div className="mt-4 grid gap-2 lg:grid-cols-2">
              {controlPlane.targets.map((target) => (
                <article key={target.targetKey} className="rounded-xl border border-[var(--border)] bg-[var(--background)] p-3">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-sm font-semibold text-[var(--foreground)]">{target.displayName}</p>
                      <p className="mt-1 text-[10px] text-[var(--muted-foreground)]">政策目标 RPO {target.objectiveRpoLabel} · RTO {target.objectiveRtoLabel}</p>
                    </div>
                    <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold ${target.operationalStatus === "healthy" ? "bg-green-500/10 text-green-700" : target.operationalStatus === "degraded" || target.operationalStatus === "configured" ? "bg-amber-500/10 text-amber-700" : target.operationalStatus === "failed" ? "bg-red-500/10 text-red-700" : "bg-slate-500/10 text-slate-600"}`}>
                      {target.operationalStatus === "healthy" ? "已核验" : target.operationalStatus === "degraded" ? "降级" : target.operationalStatus === "configured" ? "已配置未核验" : target.operationalStatus === "failed" ? "失败" : "不可用"}
                    </span>
                  </div>
                  <p className="mt-2 text-[11px] leading-relaxed text-[var(--muted-foreground)]">
                    最近成功：{target.latestSuccessfulBackupAt ? new Date(target.latestSuccessfulBackupAt).toLocaleString("zh-CN") : "暂无回执"}；最近核验：{target.latestVerifiedAt ? new Date(target.latestVerifiedAt).toLocaleString("zh-CN") : "暂无回执"}
                  </p>
                  <p className="mt-1 text-[10px] text-[var(--muted-foreground)]">
                    保留 {target.retentionEvidenceStatus} · 不可变 {target.immutabilityEvidenceStatus} · 加密 {target.encryptionEvidenceStatus} · 复制 {target.replicationEvidenceStatus} · PITR {target.pitrEvidenceStatus}
                  </p>
                </article>
              ))}
            </div>

            <div className="mt-4 rounded-xl border border-amber-500/20 bg-amber-500/5 px-3 py-2 text-xs leading-relaxed text-amber-800">
              当前控制面仅允许计划、申请和审批登记，备份执行、外部上传、恢复、删除和服务切换均未开放。最近实测 RPO/RTO：{controlPlane.consistency.latestVerifiedRpoRto ? `${controlPlane.consistency.latestVerifiedRpoRto.observedRpoSeconds ?? "未知"} 秒 / ${controlPlane.consistency.latestVerifiedRpoRto.observedRtoSeconds ?? "未知"} 秒` : "暂无合格隔离恢复回执"}。
            </div>
          </>
        ) : !loading && !controlPlaneError ? (
          <div className="rounded-xl border border-dashed border-[var(--border)] px-3 py-6 text-center text-sm text-[var(--muted-foreground)]">尚无灾备证据快照。</div>
        ) : null}
      </div>

      {/* 本机临时快照状态卡片 */}
      <div className={cardCls}>
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-base font-semibold text-[var(--foreground)] flex items-center gap-2">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-[var(--primary)]">
              <path d="M20.25 6.375c0 2.278-3.694 4.125-8.25 4.125S3.75 8.653 3.75 6.375m16.5 0c0-2.278-3.694-4.125-8.25-4.125S3.75 4.097 3.75 6.375m16.5 0v11.25c0 2.278-3.694 4.125-8.25 4.125s-8.25-1.847-8.25-4.125V6.375m16.5 0v3.75m-16.5-3.75v3.75m16.5 0v3.75C20.25 16.153 16.556 18 12 18s-8.25-1.847-8.25-4.125v-3.75m16.5 0c0 2.278-3.694 4.125-8.25 4.125s-8.25-1.847-8.25-4.125" />
            </svg>
            本机临时快照
          </h3>
          <button onClick={loadStatus} disabled={loading} className="text-xs text-[var(--primary)] hover:underline">
            {loading ? "加载中..." : "刷新"}
          </button>
        </div>

        {loading && !backupStatus ? (
          <div className="text-center py-8 text-[var(--muted-foreground)]">加载中...</div>
        ) : !exists ? (
          <div className="text-center py-8">
            <div className="text-[var(--muted-foreground)] mb-2">暂无本机快照</div>
            <div className="text-xs text-[var(--muted-foreground)]/60">本机快照仅用于开发和迁移辅助，不代表外部灾备或可恢复性。</div>
          </div>
        ) : (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div className="bg-[var(--background)] rounded-xl p-3">
              <div className="text-xs text-[var(--muted-foreground)] mb-1">备份时间</div>
              <div className="text-sm font-semibold text-[var(--foreground)]">{backupStatus?.backupTime ?? "未知"}</div>
            </div>
            <div className="bg-[var(--background)] rounded-xl p-3">
              <div className="text-xs text-[var(--muted-foreground)] mb-1">文件大小</div>
              <div className="text-sm font-semibold text-[var(--foreground)]">{backupStatus?.fileSize ?? "未知"}</div>
            </div>
            <div className="bg-[var(--background)] rounded-xl p-3">
              <div className="text-xs text-[var(--muted-foreground)] mb-1">用户总数</div>
              <div className="text-sm font-semibold text-[var(--primary)]">{backupStatus?.summary?.userCount ?? 0}</div>
            </div>
            <div className="bg-[var(--background)] rounded-xl p-3">
              <div className="text-xs text-[var(--muted-foreground)] mb-1">积分/现金合计</div>
              <div className="text-sm font-semibold text-[var(--primary)]">{backupStatus?.summary?.totalCredits ?? 0} / ¥{backupStatus?.summary?.totalCash ?? 0}</div>
            </div>
          </div>
        )}
      </div>

      {/* 本机临时快照操作 */}
      <div className={cardCls}>
        <h3 className="text-base font-semibold text-[var(--foreground)] mb-1">本机临时快照操作</h3>
        <p className="mb-4 text-xs text-[var(--muted-foreground)]">这些操作不会生成加密异地副本、PITR 或隔离恢复回执，不能作为业务连续性完成证据。</p>
        <div className="flex flex-wrap items-center gap-3">
          <button
            onClick={handleBackup}
            disabled={backingUp}
            className={`${btnPrimary} flex min-w-48 items-center justify-center gap-2 ${backingUp ? "opacity-50 cursor-not-allowed" : ""}`}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M12 4.5v15m7.5-7.5h-15" />
            </svg>
            {backingUp ? "创建中..." : "创建本机快照"}
          </button>
          <p className="max-w-2xl text-xs leading-relaxed text-[var(--muted-foreground)]">浏览器不提供快照下载、上传或直接恢复入口，避免把包含用户资产和凭据的数据文件暴露给前端。正式恢复只能由服务器侧受控流程执行。</p>
        </div>
      </div>

      {/* 各表记录统计 */}
      {exists && backupStatus?.tableCounts && (
        <div className={cardCls}>
          <h3 className="text-base font-semibold text-[var(--foreground)] mb-4">数据明细</h3>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {Object.entries(backupStatus.tableCounts as Record<string, number>).map(([table, count]) => {
              const isCore = ["users", "credit_transactions", "cash_transactions", "revenue_records", "payment_orders"].includes(table);
              const isConfig = ["agents", "categories", "platform_settings", "video_models", "cover_models", "announcements"].includes(table);
              const label = table.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
              return (
                <div key={table} className={`rounded-xl p-3 border ${isCore ? "bg-amber-500/5 border-amber-500/20" : isConfig ? "bg-blue-500/5 border-blue-500/20" : "bg-[var(--background)] border-[var(--border)]"}`}>
                  <div className="text-xs text-[var(--muted-foreground)] mb-0.5 flex items-center gap-1">
                    {isCore && <span className="w-1.5 h-1.5 rounded-full bg-amber-500" />}
                    {isConfig && <span className="w-1.5 h-1.5 rounded-full bg-blue-500" />}
                    {label}
                  </div>
                  <div className="text-lg font-bold text-[var(--foreground)]">{count}</div>
                </div>
              );
            })}
          </div>
          <div className="flex gap-4 mt-3 text-xs text-[var(--muted-foreground)]">
            <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-amber-500" />核心数据（学员资产）</span>
            <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-blue-500" />配置数据（平台运营）</span>
            <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-gray-400" />日志与历史</span>
          </div>
        </div>
      )}

      {/* 证据解释 */}
      <div className={cardCls}>
        <h3 className="text-base font-semibold text-[var(--foreground)] mb-4">如何判定灾备可用</h3>
        <div className="space-y-3 text-sm text-[var(--secondary-foreground)]">
          <div className="flex items-start gap-3">
            <div className="w-6 h-6 rounded-full bg-blue-500/10 flex items-center justify-center shrink-0 mt-0.5">
              <span className="text-[10px] font-bold text-blue-600">1</span>
            </div>
            <div><strong>备份回执</strong>：必须包含恢复点、对象清单、产物数量、字节数和 manifest 校验和。</div>
          </div>
          <div className="flex items-start gap-3">
            <div className="w-6 h-6 rounded-full bg-blue-500/10 flex items-center justify-center shrink-0 mt-0.5">
              <span className="text-[10px] font-bold text-blue-600">2</span>
            </div>
            <div><strong>保护证据</strong>：保留期、不可变、加密、异地复制与 PITR 分项核验，缺一项就明确显示缺失。</div>
          </div>
          <div className="flex items-start gap-3">
            <div className="w-6 h-6 rounded-full bg-blue-500/10 flex items-center justify-center shrink-0 mt-0.5">
              <span className="text-[10px] font-bold text-blue-600">3</span>
            </div>
            <div><strong>隔离恢复</strong>：只在隔离环境验证用户、登录、账本、配置、对象和 schema，生产写入必须为 0。</div>
          </div>
          <div className="flex items-start gap-3">
            <div className="w-6 h-6 rounded-full bg-blue-500/10 flex items-center justify-center shrink-0 mt-0.5">
              <span className="text-[10px] font-bold text-blue-600">4</span>
            </div>
            <div><strong>实测 RPO/RTO</strong>：只从成功隔离演练回执计算；政策目标不会显示成实际成绩。</div>
          </div>
          <div className="flex items-start gap-3">
            <div className="w-6 h-6 rounded-full bg-amber-500/10 flex items-center justify-center shrink-0 mt-0.5">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="text-amber-500"><path d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" /></svg>
            </div>
            <div><strong>当前边界</strong>：尚无合格外部备份和恢复演练回执时，本页会保持“暂无外部证据”，不会承诺自动备份或浏览器直接恢复。</div>
          </div>
        </div>
      </div>
    </div>
  );
}
