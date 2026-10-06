"use client";

import { useState, useCallback, useEffect, useRef } from "react";

import type {
  FinancialIssue,
  FinancialReconciliationResponse,
} from "@/lib/financial-reconciliation-contract";

type SourceTone = "green" | "blue" | "orange" | "purple" | "cyan" | "red" | "gray";

interface AuditLog {
  id: string;
  userId: string;
  field: string;
  oldValue: number;
  newValue: number;
  delta: number;
  createdAt: string;
  identity: {
    displayLabel: string;
    displayName: string;
    username: string | null;
    email: string | null;
    phone: string | null;
    role: string | null;
    accountKind: "fixture" | "suspicious" | "normal";
    accountNote: string | null;
    accountReasons: string[];
  };
  source: {
    category: string;
    label: string;
    tone: SourceTone;
    rawSource: string;
    sourceId: string | null;
    explanation: string;
  };
  network: {
    eventIp: string | null;
    eventIpStatus: "recorded" | "not_recorded";
    eventIpExplanation: string;
    lastLoginIp: string | null;
    lastLoginAt: string | null;
    lastLoginStatus: string | null;
  };
  operator: { id: string; displayName: string } | null;
  context: {
    route: string | null;
    writer: string | null;
    walletOperationId: string | null;
    walletOperationKind: string | null;
    walletIdempotencyKey: string | null;
  };
}

interface SourceInventory {
  observedRawSourceCount: number;
  observedRecordCount: number;
  standardCategoryCount: number;
  note: string;
  rawSources: Array<{
    rawSource: string;
    recordCount: number;
    category: string;
    label: string;
    explanation: string;
  }>;
  standardCategories: Array<{
    key: string;
    label: string;
    description: string;
    rawSources: readonly string[];
    contextual: boolean;
  }>;
}

interface SavedFinancialReconciliationCheckpoint {
  schemaVersion: number;
  savedAt: string;
  nextCursor: string;
  result: FinancialReconciliationResponse;
  issues: FinancialIssue[];
}

const FINANCIAL_RECONCILIATION_CHECKPOINT_KEY = "admin-financial-reconciliation-checkpoint-v2";
const FINANCIAL_RECONCILIATION_DISPLAY_ISSUE_LIMIT = 200;

const FIELD_LABELS: Record<string, string> = {
  credits: "积分",
  cash_balance: "现金",
};

const SOURCE_TONE_CLASSES: Record<SourceTone, string> = {
  green: "bg-green-500/10 text-green-700",
  blue: "bg-blue-500/10 text-blue-700",
  orange: "bg-orange-500/10 text-orange-700",
  purple: "bg-purple-500/10 text-purple-700",
  cyan: "bg-cyan-500/10 text-cyan-700",
  red: "bg-red-500/10 text-red-700",
  gray: "bg-gray-500/10 text-gray-700",
};

function formatNumber(value: number): string {
  return Number.isFinite(value) ? value.toFixed(2) : "—";
}

function contactLine(log: AuditLog): string {
  return log.identity.phone || log.identity.email || log.identity.username || "未绑定联系方式";
}

function mergeFinancialIssues(current: readonly FinancialIssue[], incoming: readonly FinancialIssue[]): FinancialIssue[] {
  const byId = new Map<string, FinancialIssue>();
  for (const item of [...current, ...incoming]) byId.set(item.id, item);
  return [...byId.values()].slice(-FINANCIAL_RECONCILIATION_DISPLAY_ISSUE_LIMIT);
}

function stageStatusLabel(status: FinancialReconciliationResponse["coverage"]["stages"][number]["status"]): string {
  if (status === "complete") return "已覆盖";
  if (status === "partial") return "部分覆盖";
  if (status === "unavailable") return "来源不可用";
  if (status === "running") return "扫描中";
  return "待扫描";
}

export function BillingAuditPanel() {
  const [auditLogs, setAuditLogs] = useState<AuditLog[]>([]);
  const [sourceInventory, setSourceInventory] = useState<SourceInventory | null>(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [filterField, setFilterField] = useState("");
  const [filterSource, setFilterSource] = useState("");
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [consistencyResult, setConsistencyResult] = useState<FinancialReconciliationResponse | null>(null);
  const [consistencyIssues, setConsistencyIssues] = useState<FinancialIssue[]>([]);
  const [nextConsistencyCursor, setNextConsistencyCursor] = useState<string | null | undefined>(undefined);
  const [scanRequestCursor, setScanRequestCursor] = useState<string | null | undefined>(undefined);
  const [checking, setChecking] = useState(false);
  const [scanActive, setScanActive] = useState(false);
  const [scanPausedByUser, setScanPausedByUser] = useState(false);
  const [pageVisible, setPageVisible] = useState(true);
  const [online, setOnline] = useState(true);
  const [retryAtMs, setRetryAtMs] = useState(0);
  const [activeSubTab, setActiveSubTab] = useState<"audit" | "consistency">("audit");
  const scanAbortRef = useRef<AbortController | null>(null);
  const scanRequestInFlightRef = useRef(false);

  const fetchAuditLogs = useCallback(async (currentPage: number, field: string, source: string) => {
    setLoading(true);
    setErrorMessage("");
    try {
      const token = localStorage.getItem("auth_token");
      const params = new URLSearchParams({ page: String(currentPage), pageSize: "20" });
      if (field) params.set("field", field);
      if (source) params.set("source", source);
      const response = await fetch(`/api/admin/balance-audit?${params}`, {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "余额审计读取失败");
      setAuditLogs(Array.isArray(data.logs) ? data.logs : []);
      setTotal(Number(data.total || 0));
      setSourceInventory(data.sourceInventory || null);
    } catch (error) {
      setAuditLogs([]);
      setErrorMessage(error instanceof Error ? error.message : "余额审计读取失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchAuditLogs(page, filterField, filterSource);
  }, [page, filterField, filterSource, fetchAuditLogs]);

  const loadConsistencyPage = useCallback(async (cursor: string | null) => {
    if (scanRequestInFlightRef.current) return;
    scanRequestInFlightRef.current = true;
    scanAbortRef.current?.abort();
    const controller = new AbortController();
    scanAbortRef.current = controller;
    setChecking(true);
    setErrorMessage("");
    try {
      const token = localStorage.getItem("auth_token");
      const params = new URLSearchParams({ pageSize: "50" });
      if (cursor) params.set("cursor", cursor);
      const response = await fetch(`/api/admin/consistency-check?${params}`, {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
        signal: controller.signal,
      });
      const data = await response.json();
      if (response.status === 429) {
        const retrySeconds = Math.max(1, Number(response.headers.get("Retry-After") || data.retryAfterSeconds || 1));
        setRetryAtMs(Date.now() + retrySeconds * 1_000);
        return;
      }
      if (!response.ok) throw new Error(data.error || "资金一致性扫描失败");
      const result = data as FinancialReconciliationResponse;
      setConsistencyResult(result);
      setNextConsistencyCursor(result.nextCursor);
      setScanRequestCursor(result.nextCursor ?? undefined);
      setRetryAtMs(Date.now() + result.rateLimit.minimumIntervalMs);
      setConsistencyIssues((current) => {
        const merged = mergeFinancialIssues(current, result.issues);
        if (result.nextCursor) {
          const checkpoint: SavedFinancialReconciliationCheckpoint = {
            schemaVersion: result.schemaVersion,
            savedAt: new Date().toISOString(),
            nextCursor: result.nextCursor,
            result,
            issues: merged,
          };
          sessionStorage.setItem(FINANCIAL_RECONCILIATION_CHECKPOINT_KEY, JSON.stringify(checkpoint));
        } else {
          sessionStorage.removeItem(FINANCIAL_RECONCILIATION_CHECKPOINT_KEY);
        }
        return merged;
      });
      if (!result.nextCursor) {
        setScanActive(false);
        setScanPausedByUser(false);
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      setScanActive(false);
      setErrorMessage(error instanceof Error ? error.message : "资金一致性扫描失败");
    } finally {
      if (scanAbortRef.current === controller) scanAbortRef.current = null;
      scanRequestInFlightRef.current = false;
      setChecking(false);
    }
  }, []);

  const startConsistencyScan = useCallback(() => {
    scanAbortRef.current?.abort();
    sessionStorage.removeItem(FINANCIAL_RECONCILIATION_CHECKPOINT_KEY);
    setConsistencyResult(null);
    setConsistencyIssues([]);
    setNextConsistencyCursor(undefined);
    setScanRequestCursor(null);
    setScanPausedByUser(false);
    setScanActive(true);
    setRetryAtMs(0);
  }, []);

  const pauseConsistencyScan = useCallback(() => {
    setScanPausedByUser(true);
    setScanActive(false);
    scanAbortRef.current?.abort();
  }, []);

  const resumeConsistencyScan = useCallback(() => {
    if (scanRequestCursor === undefined) return;
    setScanPausedByUser(false);
    setScanActive(true);
  }, [scanRequestCursor]);

  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(FINANCIAL_RECONCILIATION_CHECKPOINT_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw) as SavedFinancialReconciliationCheckpoint;
      if (!saved?.nextCursor || !saved.result || !Array.isArray(saved.issues)) {
        sessionStorage.removeItem(FINANCIAL_RECONCILIATION_CHECKPOINT_KEY);
        return;
      }
      if (Date.parse(saved.result.checkpoint.expiresAt) <= Date.now()) {
        sessionStorage.removeItem(FINANCIAL_RECONCILIATION_CHECKPOINT_KEY);
        return;
      }
      setConsistencyResult(saved.result);
      setConsistencyIssues(saved.issues.slice(-FINANCIAL_RECONCILIATION_DISPLAY_ISSUE_LIMIT));
      setNextConsistencyCursor(saved.nextCursor);
      setScanRequestCursor(saved.nextCursor);
      setScanPausedByUser(true);
    } catch {
      sessionStorage.removeItem(FINANCIAL_RECONCILIATION_CHECKPOINT_KEY);
    }
  }, []);

  useEffect(() => {
    const updateAvailability = () => {
      const visible = document.visibilityState === "visible";
      const connected = navigator.onLine;
      setPageVisible(visible);
      setOnline(connected);
      if (!visible || !connected) scanAbortRef.current?.abort();
    };
    updateAvailability();
    document.addEventListener("visibilitychange", updateAvailability);
    window.addEventListener("online", updateAvailability);
    window.addEventListener("offline", updateAvailability);
    return () => {
      document.removeEventListener("visibilitychange", updateAvailability);
      window.removeEventListener("online", updateAvailability);
      window.removeEventListener("offline", updateAvailability);
      scanAbortRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    if (!scanActive || scanPausedByUser || !pageVisible || !online || checking || scanRequestCursor === undefined) return;
    const delay = Math.max(0, retryAtMs - Date.now());
    const timer = window.setTimeout(() => {
      void loadConsistencyPage(scanRequestCursor);
    }, delay);
    return () => window.clearTimeout(timer);
  }, [checking, loadConsistencyPage, online, pageVisible, retryAtMs, scanActive, scanPausedByUser, scanRequestCursor]);

  const totalPages = Math.max(1, Math.ceil(total / 20));
  const environmentPaused = !pageVisible || !online;
  const scanFinished = Boolean(consistencyResult && nextConsistencyCursor === null && scanRequestCursor === undefined);
  const fullCoveragePass = Boolean(
    consistencyResult
    && consistencyResult.coverage.complete
    && consistencyResult.coverage.status === "complete"
    && consistencyResult.summary.totalIssues === 0,
  );

  return (
    <div className="space-y-4" data-testid="billing-audit-panel">
      <div className="flex gap-2 border-b pb-2">
        <button
          onClick={() => setActiveSubTab("audit")}
          className={`px-4 py-2 text-sm font-medium rounded-t-lg transition-colors ${
            activeSubTab === "audit"
              ? "bg-[var(--primary)] text-white"
              : "text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
          }`}
        >
          余额变更审计
        </button>
        <button
          onClick={() => setActiveSubTab("consistency")}
          className={`px-4 py-2 text-sm font-medium rounded-t-lg transition-colors ${
            activeSubTab === "consistency"
              ? "bg-[var(--primary)] text-white"
              : "text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
          }`}
        >
          一致性校验
        </button>
      </div>

      {errorMessage && (
        <div className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-700" role="alert">
          {errorMessage}
        </div>
      )}

      {activeSubTab === "audit" && (
        <>
          {sourceInventory && (
            <div className="rounded-xl border bg-[var(--card)]/70 p-4" data-testid="billing-source-inventory">
              <div className="flex flex-wrap items-baseline gap-x-5 gap-y-1">
                <strong className="text-sm">来源已核清</strong>
                <span className="text-sm">
                  当前数据出现 <b>{sourceInventory.observedRawSourceCount}</b> 个原始来源值，
                  共 {sourceInventory.observedRecordCount} 条
                </span>
                <span className="text-sm">
                  平台展示目录共 <b>{sourceInventory.standardCategoryCount}</b> 类
                </span>
              </div>
              <p className="mt-2 text-xs leading-5 text-[var(--muted-foreground)]">
                {sourceInventory.note}
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                {sourceInventory.rawSources.map((item) => (
                  <span
                    key={item.rawSource}
                    title={item.explanation}
                    className="rounded-full border px-2.5 py-1 text-xs"
                  >
                    {item.label} · <span className="font-mono">{item.rawSource}</span> · {item.recordCount}
                  </span>
                ))}
              </div>
            </div>
          )}

          <div className="flex gap-3 items-center flex-wrap">
            <select
              value={filterField}
              onChange={(event) => { setFilterField(event.target.value); setPage(1); }}
              className="px-3 py-1.5 text-sm border rounded-lg bg-[var(--card)] text-[var(--foreground)]"
            >
              <option value="">全部类型</option>
              <option value="credits">积分</option>
              <option value="cash_balance">现金</option>
            </select>
            <select
              value={filterSource}
              onChange={(event) => { setFilterSource(event.target.value); setPage(1); }}
              className="px-3 py-1.5 text-sm border rounded-lg bg-[var(--card)] text-[var(--foreground)]"
              aria-label="按原始来源筛选"
            >
              <option value="">全部原始来源</option>
              {(sourceInventory?.rawSources || []).map((item) => (
                <option key={item.rawSource} value={item.rawSource}>
                  {item.label} · {item.rawSource}（{item.recordCount}）
                </option>
              ))}
            </select>
            <span className="text-xs text-[var(--muted-foreground)]">筛选后共 {total} 条记录</span>
          </div>

          {loading ? (
            <div className="text-center py-8 text-[var(--muted-foreground)]">加载中...</div>
          ) : auditLogs.length === 0 ? (
            <div className="text-center py-8 text-[var(--muted-foreground)]">暂无审计记录</div>
          ) : (
            <div className="overflow-x-auto rounded-xl border" data-testid="billing-audit-table">
              <table className="w-full min-w-[1460px] text-sm">
                <thead className="bg-[var(--muted)]/30">
                  <tr className="border-b text-left text-[var(--muted-foreground)]">
                    <th className="p-3 font-medium">时间</th>
                    <th className="p-3 font-medium">用户身份</th>
                    <th className="p-3 font-medium">IP 证据</th>
                    <th className="p-3 font-medium">类型</th>
                    <th className="p-3 font-medium text-right">变更前</th>
                    <th className="p-3 font-medium text-right">变更后</th>
                    <th className="p-3 font-medium text-right">变动</th>
                    <th className="p-3 font-medium">标准来源 / 原始代码</th>
                    <th className="p-3 font-medium">操作凭证</th>
                  </tr>
                </thead>
                <tbody>
                  {auditLogs.map((log) => {
                    const positive = log.delta > 0;
                    return (
                      <tr key={log.id} className="border-b last:border-0 align-top hover:bg-[var(--card)]/50">
                        <td className="p-3 text-xs text-[var(--muted-foreground)] whitespace-nowrap">
                          {new Date(log.createdAt).toLocaleString("zh-CN")}
                        </td>
                        <td className="p-3 min-w-[220px]">
                          <div className="flex items-center gap-2">
                            <span className="font-medium">{log.identity.displayLabel}</span>
                            {log.identity.accountKind !== "normal" && (
                              <span className="rounded bg-purple-500/10 px-1.5 py-0.5 text-xs text-purple-700">
                                {log.identity.accountKind === "fixture" ? "系统测试" : "需核对"}
                              </span>
                            )}
                          </div>
                          {log.identity.displayLabel !== log.identity.displayName && (
                            <div className="mt-1 text-xs text-[var(--muted-foreground)]">{log.identity.displayName}</div>
                          )}
                          <div className="mt-1 text-xs">{contactLine(log)}</div>
                          <div className="mt-1 break-all font-mono text-xs text-[var(--muted-foreground)]">{log.userId}</div>
                        </td>
                        <td className="p-3 min-w-[220px] text-xs">
                          <div className={log.network.eventIp ? "font-mono text-[var(--foreground)]" : "text-amber-700"}>
                            {log.network.eventIp ? `本笔：${log.network.eventIp}` : "本笔：未记录 IP"}
                          </div>
                          <div className="mt-1 leading-5 text-[var(--muted-foreground)]">{log.network.eventIpExplanation}</div>
                          {log.network.lastLoginIp && (
                            <div className="mt-2 border-t pt-2 text-[var(--muted-foreground)]">
                              最近登录 IP（非本笔）：
                              <span className="font-mono text-[var(--foreground)]">{log.network.lastLoginIp}</span>
                            </div>
                          )}
                        </td>
                        <td className="p-3">
                          <span className="rounded bg-[var(--muted)]/60 px-1.5 py-0.5 text-xs">
                            {FIELD_LABELS[log.field] || log.field}
                          </span>
                        </td>
                        <td className="p-3 text-right font-mono text-xs">{formatNumber(log.oldValue)}</td>
                        <td className="p-3 text-right font-mono text-xs">{formatNumber(log.newValue)}</td>
                        <td className={`p-3 text-right font-mono text-xs font-semibold ${positive ? "text-green-600" : "text-red-600"}`}>
                          {positive ? "+" : ""}{formatNumber(log.delta)}
                        </td>
                        <td className="p-3 min-w-[260px]">
                          <span className={`rounded px-1.5 py-0.5 text-xs ${SOURCE_TONE_CLASSES[log.source.tone]}`}>
                            {log.source.label}
                          </span>
                          <div className="mt-1 font-mono text-xs text-[var(--muted-foreground)]">
                            原始：{log.source.rawSource}
                          </div>
                          <div className="mt-1 text-xs leading-5 text-[var(--muted-foreground)]">
                            {log.source.explanation}
                          </div>
                        </td>
                        <td className="p-3 min-w-[220px] text-xs">
                          <div className="break-all font-mono">{log.source.sourceId || "无来源标识"}</div>
                          <div className="mt-1 text-[var(--muted-foreground)]">
                            操作者：{log.operator ? `${log.operator.displayName}（${log.operator.id}）` : "未记录"}
                          </div>
                          {log.context.route && (
                            <div className="mt-1 break-all text-[var(--muted-foreground)]">入口：{log.context.route}</div>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {totalPages > 1 && (
            <div className="flex gap-2 items-center justify-center pt-2">
              <button
                onClick={() => setPage(Math.max(1, page - 1))}
                disabled={page === 1 || loading}
                className="px-3 py-1 text-sm border rounded disabled:opacity-50"
              >
                上一页
              </button>
              <span className="text-sm text-[var(--muted-foreground)]">{page} / {totalPages}</span>
              <button
                onClick={() => setPage(Math.min(totalPages, page + 1))}
                disabled={page === totalPages || loading}
                className="px-3 py-1 text-sm border rounded disabled:opacity-50"
              >
                下一页
              </button>
            </div>
          )}
        </>
      )}

      {activeSubTab === "consistency" && (
        <>
          <div className="rounded-xl border bg-[var(--card)]/70 p-4">
            <div className="flex flex-wrap items-center gap-3">
              {!scanActive && !scanPausedByUser && (
                <button
                  onClick={startConsistencyScan}
                  disabled={checking || environmentPaused}
                  className="rounded-lg bg-[var(--primary)] px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50 motion-reduce:transition-none"
                >
                  {consistencyResult ? "重新开始全量扫描" : "开始全量扫描"}
                </button>
              )}
              {scanActive && (
                <button
                  onClick={pauseConsistencyScan}
                  className="rounded-lg border px-4 py-2 text-sm font-medium transition-colors hover:bg-[var(--muted)]/40 motion-reduce:transition-none"
                >
                  暂停扫描
                </button>
              )}
              {scanPausedByUser && scanRequestCursor !== undefined && (
                <button
                  onClick={resumeConsistencyScan}
                  disabled={environmentPaused}
                  className="rounded-lg bg-[var(--primary)] px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50 motion-reduce:transition-none"
                >
                  继续检查点
                </button>
              )}
              <span className="text-xs leading-5 text-[var(--muted-foreground)]">
                每批最多 50 条，按签名检查点逐阶段继续；页面隐藏或离线时自动停止请求。
              </span>
            </div>
            <p className="mt-3 text-xs leading-5 text-[var(--muted-foreground)]">
              快照固定纳入范围（created_at ≤ snapshotAt），逐页读取当前行状态。扫描只读，不重算余额、不调用支付渠道。
            </p>
            {(environmentPaused || scanPausedByUser || checking) && (
              <div className="mt-3 rounded-lg border px-3 py-2 text-xs" aria-live="polite">
                {environmentPaused
                  ? (!online ? "网络离线，扫描已暂停；恢复联网后可继续。" : "页面不在前台，扫描已暂停；返回页面后可继续。")
                  : scanPausedByUser
                    ? "已保存签名检查点，可以从当前阶段继续。"
                    : "正在读取当前有界批次…"}
              </div>
            )}
          </div>

          {consistencyResult && (
            <div className="space-y-4" data-testid="financial-reconciliation-progress">
              <div className={`rounded-xl border p-4 ${
                fullCoveragePass
                  ? "border-green-500/30 bg-green-500/10"
                  : scanFinished && consistencyResult.coverage.status === "partial"
                    ? "border-amber-500/30 bg-amber-500/10"
                    : consistencyResult.summary.totalIssues > 0
                      ? "border-red-500/30 bg-red-500/10"
                      : "border-blue-500/30 bg-blue-500/10"
              }`}>
                <strong className={fullCoveragePass ? "text-green-700" : consistencyResult.summary.totalIssues > 0 ? "text-red-700" : "text-blue-700"}>
                  {fullCoveragePass
                    ? "全量范围通过"
                    : scanFinished && consistencyResult.coverage.status === "partial"
                      ? "扫描结束，但存在来源缺口，不能判定通过"
                      : scanFinished && consistencyResult.summary.totalIssues > 0
                        ? `全量扫描完成，发现 ${consistencyResult.summary.totalIssues} 个问题`
                      : consistencyResult.summary.totalIssues > 0
                        ? `已发现 ${consistencyResult.summary.totalIssues} 个问题，继续完成覆盖`
                        : "尚未完成全量覆盖"}
                </strong>
                <p className="mt-1 text-sm text-[var(--muted-foreground)]">
                  已扫描 {consistencyResult.coverage.scanned}
                  {consistencyResult.coverage.total == null ? " / 总量待核清" : ` / ${consistencyResult.coverage.total}`}
                  {" · "}严重 {consistencyResult.summary.critical}
                  {" · "}警告 {consistencyResult.summary.warning}
                  {" · "}信息 {consistencyResult.summary.info}
                </p>
                <p className="mt-1 text-xs text-[var(--muted-foreground)]">
                  快照 {new Date(consistencyResult.snapshotAt).toLocaleString("zh-CN")} ·
                  最近批次 {new Date(consistencyResult.checkedAt).toLocaleString("zh-CN")} ·
                  检查点有效至 {new Date(consistencyResult.checkpoint.expiresAt).toLocaleString("zh-CN")}
                </p>
              </div>

              <div className="grid gap-3 xl:grid-cols-2">
                {consistencyResult.coverage.stages.map((stage) => (
                  <div key={stage.id} className="rounded-xl border p-4">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <strong className="text-sm">{stage.label}</strong>
                      <span className={`rounded-full px-2 py-1 text-xs ${
                        stage.status === "complete"
                          ? "bg-green-500/10 text-green-700"
                          : stage.status === "partial" || stage.status === "unavailable"
                            ? "bg-amber-500/10 text-amber-700"
                            : "bg-blue-500/10 text-blue-700"
                      }`}>
                        {stageStatusLabel(stage.status)}
                      </span>
                    </div>
                    <p className="mt-2 text-xs leading-5 text-[var(--muted-foreground)]">{stage.description}</p>
                    <p className="mt-2 text-xs">
                      扫描 {stage.scanned}{stage.total == null ? " / 总量待核清" : ` / ${stage.total}`}
                      {" · "}问题 {stage.issues.totalIssues}
                    </p>
                    <p className="mt-1 break-words font-mono text-xs text-[var(--muted-foreground)]">
                      来源：{stage.sources.join(" + ")}
                    </p>
                  </div>
                ))}
              </div>

              {consistencyResult.coverage.sourceGaps.length > 0 && (
                <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4">
                  <strong className="text-sm text-amber-800">来源缺口</strong>
                  <div className="mt-2 space-y-2">
                    {consistencyResult.coverage.sourceGaps.map((sourceGap) => (
                      <div key={`${sourceGap.stageId}-${sourceGap.source}-${sourceGap.code}`} className="text-xs leading-5">
                        <span className="font-mono">{sourceGap.source}</span> · {sourceGap.code} · {sourceGap.detail}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {consistencyResult.summary.totalIssues > consistencyIssues.length && (
                <p className="text-xs text-[var(--muted-foreground)]">
                  共发现 {consistencyResult.summary.totalIssues} 个问题；界面保留最近 {FINANCIAL_RECONCILIATION_DISPLAY_ISSUE_LIMIT} 条，汇总计数来自签名检查点。
                </p>
              )}
              {consistencyIssues.map((issue) => (
                <div key={issue.id} className="rounded-lg border p-3 text-sm">
                  <div className="flex flex-wrap gap-2">
                    <span className={issue.severity === "critical" ? "text-red-700" : issue.severity === "warning" ? "text-amber-700" : ""}>
                      {issue.severity === "critical" ? "严重" : issue.severity === "warning" ? "警告" : "信息"}
                    </span>
                    <span className="font-mono text-xs">{issue.type}</span>
                    {issue.userId && <span className="break-all font-mono text-xs">{issue.userId}</span>}
                  </div>
                  <p className="mt-1 text-[var(--muted-foreground)]">{issue.detail}</p>
                  <p className="mt-1 break-all font-mono text-xs text-[var(--muted-foreground)]">
                    {issue.sourceRefs.join(" · ")}
                  </p>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
