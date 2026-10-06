"use client";

import { useCallback, useEffect, useState } from "react";
import { safeLocalStorageGet } from "@/lib/utils";
import { STORAGE_KEYS } from "@/lib/storage-keys";

const inputCls = "w-full px-3 py-2.5 bg-[var(--card)] border border-[var(--border)] rounded-xl text-sm text-[var(--foreground)] outline-none focus:border-[var(--primary)] transition-colors placeholder-[var(--muted-foreground)]";
const cardCls = "bg-[var(--card)] rounded-2xl p-6 border border-[var(--border)]";
const btnGhost = "px-4 py-2.5 text-[var(--secondary-foreground)] rounded-xl text-sm hover:bg-[var(--border)] transition-colors";
function formatAdminDate(value?: string | null): string {
  if (!value) return "暂无";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "暂无";
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const valueOf = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value || "--";
  return `${valueOf("year")}-${valueOf("month")}-${valueOf("day")} ${valueOf("hour")}:${valueOf("minute")}`;
}

export function LoginLogsAdminTab({ focusUserId = "", focusUserLabel = "", onClearFocus }: { focusUserId?: string; focusUserLabel?: string; onClearFocus?: () => void }) {
  const [logs, setLogs] = useState<Array<{
    id: string;
    user_id: string;
    username: string;
    display_name: string;
    ip_address: string;
    user_agent: string;
    login_method: string;
    status: string;
    fail_reason: string;
    created_at: string;
  }>>([]);
  const [summary, setSummary] = useState<{ total: number; success: number; failed: number; today: number }>({ total: 0, success: 0, failed: 0, today: 0 });
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [filterStatus, setFilterStatus] = useState("");
  const [loading, setLoading] = useState(false);
  const [loginLogError, setLoginLogError] = useState("");

  const fetchLogs = useCallback(async (p: number, status: string, signal?: AbortSignal) => {
    setLoading(true);
    setLoginLogError("");
    try {
      const token = safeLocalStorageGet(STORAGE_KEYS.AUTH_TOKEN);
      if (!token) throw new Error("管理员登录已失效，请重新登录");
      const params = new URLSearchParams({ page: String(p), pageSize: "20" });
      if (status) params.set("status", status);
      if (focusUserId) params.set("userId", focusUserId);
      const res = await fetch(`/api/admin/login-logs?${params}`, {
        headers: { Authorization: `Bearer ${token}` },
        signal,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "登录日志加载失败");
      if (data.logs) {
        setLogs(data.logs);
        setTotal(data.total);
        setSummary(data.summary);
      }
    } catch (e) {
      if (signal?.aborted) return;
      console.error("Failed to fetch login logs:", e);
      setLoginLogError(e instanceof Error ? e.message : "登录日志加载失败");
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [focusUserId]);

  useEffect(() => { setPage(1); }, [focusUserId]);

  useEffect(() => {
    const controller = new AbortController();
    void fetchLogs(page, filterStatus, controller.signal);
    return () => controller.abort();
  }, [page, filterStatus, fetchLogs]);

  /** 解析UA为简短描述 */
  const parseUA = (ua: string): string => {
    if (!ua || ua === "unknown") return "未知";
    if (/Mobile|Android|iPhone/i.test(ua)) {
      if (/iPhone/i.test(ua)) return "iPhone";
      if (/Android/i.test(ua)) return "Android";
      return "手机";
    }
    if (/Windows/i.test(ua)) return "Windows";
    if (/Mac/i.test(ua)) return "Mac";
    if (/Linux/i.test(ua)) return "Linux";
    return "桌面端";
  };

  /** 获取浏览器简短名 */
  const parseBrowser = (ua: string): string => {
    if (!ua || ua === "unknown") return "";
    if (/Edg\//i.test(ua)) return "Edge";
    if (/Chrome/i.test(ua) && !/Edg/i.test(ua)) return "Chrome";
    if (/Firefox/i.test(ua)) return "Firefox";
    if (/Safari/i.test(ua) && !/Chrome/i.test(ua)) return "Safari";
    return "";
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold text-[var(--foreground)]">登录日志</h3>
          <p className="text-xs text-[var(--muted-foreground)] mt-1">记录登录结果与失败原因；历史乱码在展示层修复，账号与 IP 默认脱敏。</p>
        </div>
        <button type="button" onClick={() => void fetchLogs(page, filterStatus)} disabled={loading} className={btnGhost + " text-xs disabled:opacity-50"}>{loading ? "刷新中..." : "刷新数据"}</button>
      </div>

      {loginLogError && (
        <div role="alert" className="flex items-center justify-between gap-3 rounded-xl border border-red-500/30 bg-red-500/5 px-4 py-3 text-sm text-red-600">
          <span>{loginLogError}</span>
          <button type="button" onClick={() => void fetchLogs(page, filterStatus)} className="font-semibold hover:underline">重试</button>
        </div>
      )}

      {focusUserId && (
        <div className="flex items-center justify-between rounded-xl border border-blue-500/20 bg-blue-500/8 px-4 py-3 text-sm text-blue-600">
          <span>当前只看：<strong>{focusUserLabel || focusUserId}</strong> 的登录审计</span>
          <button type="button" onClick={onClearFocus} className="font-semibold hover:underline">查看全部学员</button>
        </div>
      )}

      {/* 统计概览 */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className={cardCls + " !p-4"}>
          <div className="text-xs text-[var(--muted-foreground)]">总登录次数</div>
          <div className="text-2xl font-bold text-[var(--foreground)]">{summary.total}</div>
        </div>
        <div className={cardCls + " !p-4"}>
          <div className="text-xs text-[var(--muted-foreground)]">成功登录</div>
          <div className="text-2xl font-bold text-emerald-500">{summary.success}</div>
        </div>
        <div className={cardCls + " !p-4"}>
          <div className="text-xs text-[var(--muted-foreground)]">失败登录</div>
          <div className="text-2xl font-bold text-red-500">{summary.failed}</div>
        </div>
        <div className={cardCls + " !p-4"}>
          <div className="text-xs text-[var(--muted-foreground)]">今日登录</div>
          <div className="text-2xl font-bold text-blue-500">{summary.today}</div>
        </div>
      </div>

      {/* 筛选 */}
      <div className="flex gap-3 items-center flex-wrap">
        <select
          value={filterStatus}
          onChange={(e) => { setFilterStatus(e.target.value); setPage(1); }}
          className={inputCls + " !w-auto"}
        >
          <option value="">全部状态</option>
          <option value="success">成功</option>
          <option value="failed">失败</option>
        </select>
        <span className="text-xs text-[var(--muted-foreground)]">
          共 {total} 条记录
        </span>
      </div>

      {/* 日志列表 */}
      <div className="bg-[var(--card)] rounded-2xl border border-[var(--border)] overflow-hidden">
        <table className="w-full">
          <thead className="bg-[var(--card)] border-b border-[var(--border)]">
            <tr>
              {["用户", "IP地址", "设备/浏览器", "登录方式", "状态", "时间"].map((h) => (
                <th key={h} className="text-left px-4 py-3 text-xs font-medium text-[var(--muted-foreground)] uppercase">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--border)]">
            {logs.map((log) => (
              <tr key={log.id} className="hover:bg-[var(--border)] transition-colors">
                <td className="px-4 py-3">
                  <div>
                    <p className="text-sm font-medium text-[var(--foreground)]">{log.display_name || log.username || "-"}</p>
                    <p className="text-xs text-[var(--muted-foreground)]">{log.username}</p>
                  </div>
                </td>
                <td className="px-4 py-3 text-sm text-[var(--secondary-foreground)] font-mono">{log.ip_address || "-"}</td>
                <td className="px-4 py-3 text-sm text-[var(--secondary-foreground)]">
                  {parseUA(log.user_agent)}
                  {parseBrowser(log.user_agent) && <span className="text-[var(--muted-foreground)]"> / {parseBrowser(log.user_agent)}</span>}
                </td>
                <td className="px-4 py-3 text-sm text-[var(--secondary-foreground)]">{log.login_method === "password" ? "密码" : log.login_method}</td>
                <td className="px-4 py-3">
                  {log.status === "success" ? (
                    <span className="px-2 py-0.5 rounded-md text-xs font-medium bg-emerald-500/10 text-emerald-600">成功</span>
                  ) : (
                    <div>
                      <span className="px-2 py-0.5 rounded-md text-xs font-medium bg-red-500/10 text-red-500">失败</span>
                      {log.fail_reason && <p className="text-xs text-red-400 mt-0.5">{log.fail_reason}</p>}
                    </div>
                  )}
                </td>
                <td className="px-4 py-3 text-xs text-[var(--muted-foreground)]">{formatAdminDate(log.created_at)}</td>
              </tr>
            ))}
            {logs.length === 0 && (
              <tr><td colSpan={6} className="text-center py-8 text-[var(--muted-foreground)] text-sm">暂无登录日志</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {/* 分页 */}
      {total > 20 && (
        <div className="flex justify-center gap-2">
          <button
            onClick={() => setPage(Math.max(1, page - 1))}
            disabled={page === 1}
            className={btnGhost + " disabled:opacity-50"}
          >
            上一页
          </button>
          <span className="px-3 py-2 text-sm text-[var(--muted-foreground)]">
            第 {page} 页
          </span>
          <button
            onClick={() => setPage(page + 1)}
            disabled={page * 20 >= total}
            className={btnGhost + " disabled:opacity-50"}
          >
            下一页
          </button>
        </div>
      )}
    </div>
  );
}
