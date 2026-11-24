'use client';

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";

type PatrolAdapter = "openai-billing" | "secure-skill" | "custom";

type ChannelSummary = {
  host: string;
  origin: string;
  adapter: PatrolAdapter;
  modelCount: number;
  models?: { name: string; modelName: string; table: string }[];
  balanceSupportedHint: boolean;
};

type ModelItem = { name: string; modelName: string; table: string; catalogVisible: boolean };

type ChannelResult = ChannelSummary & {
  status: "ok" | "degraded" | "down" | "unknown";
  httpStatus: number | null;
  latencyMs: number | null;
  credentialReady: boolean;
  modelsVisible: number;
  modelsMissing: string[];
  modelItems: ModelItem[];
  balanceUsd: number | null;
  usedUsd: number | null;
  balanceSupported: boolean;
  balanceState: "ok" | "unlimited" | "unsupported" | "missing-credential";
  error: string | null;
  checkedAt: string;
};

type Snapshot = { checkedAt: string; durationMs: number; channels: ChannelResult[] };

type ArrearsResult = { host: string; model: string; status: "ok" | "insufficient" | "auth-failed" | "error" | "skipped"; httpStatus: number | null; message: string };
type ArrearsSnapshot = { checkedAt: string; results: ArrearsResult[] };
type HistoryEntry = { capturedAt: string; channelCount: number; ok: number; degraded: number; down: number };
type AlertEntry = { id: number; createdAt: string; kind: "degraded" | "down" | "recovered" | "arrears" | "info"; channelHost: string; message: string };
type SchedulerState = { enabled: boolean; intervalMinutes: number; webhookConfigured: boolean };
type ModelFault = { model: string; host: string; kind: "arrears" | "auth" | "api" | "timeout" | "catalog"; detail: string; checkedAt: string };

const STATUS_LABEL: Record<ChannelResult["status"], string> = {
  ok: "正常",
  degraded: "降级",
  down: "不可用",
  unknown: "待验证",
};

const STATUS_STYLE: Record<ChannelResult["status"], string> = {
  ok: "bg-emerald-50 text-emerald-700 border-emerald-200",
  degraded: "bg-amber-50 text-amber-700 border-amber-200",
  down: "bg-rose-50 text-rose-700 border-rose-200",
  unknown: "bg-slate-50 text-slate-600 border-slate-200",
};

function usd(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  return `$${value.toFixed(2)}`;
}

function timeLabel(value: string | null | undefined): string {
  if (!value) return "尚未检测";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "尚未检测" : date.toLocaleString("zh-CN");
}

export function OpsPatrolPanel({ token, onRequestUnlock }: { token: string | null; onRequestUnlock?: () => void }) {
  const [channels, setChannels] = useState<ChannelSummary[]>([]);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [locked, setLocked] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [arrears, setArrears] = useState<ArrearsSnapshot | null>(null);
  const [arrearsRunning, setArrearsRunning] = useState(false);
  const [examRunning, setExamRunning] = useState(false);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [alerts, setAlerts] = useState<AlertEntry[]>([]);
  const [scheduler, setScheduler] = useState<SchedulerState | null>(null);
  const [faults, setFaults] = useState<ModelFault[]>([]);
  const [expandedHosts, setExpandedHosts] = useState<string[]>([]);

  const load = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/admin/ops/patrol", { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
      setChannels(Array.isArray(body.channels) ? body.channels : []);
      setSnapshot(body.lastRun || null);
      setLocked(Boolean(body.locked));
      setHistory(Array.isArray(body.history) ? body.history : []);
      setAlerts(Array.isArray(body.alerts) ? body.alerts : []);
      setScheduler(body.scheduler || null);
      setFaults(Array.isArray(body.faults) ? body.faults : []);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "渠道数据读取失败");
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => { void load(); }, [load]);

  const run = async () => {
    if (running) return;
    setRunning(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch("/api/admin/ops/patrol", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
      setSnapshot(body.snapshot || null);
      if (Array.isArray(body.snapshot?.channels)) {
        setChannels(body.snapshot.channels.map((item: ChannelResult) => ({
          host: item.host, origin: item.origin, adapter: item.adapter, modelCount: item.modelCount, balanceSupportedHint: item.balanceSupportedHint,
        })));
      }
      setNotice(`检测完成，用时 ${(Number(body.snapshot?.durationMs) / 1000).toFixed(1)} 秒`);
      void load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "检测失败");
    } finally {
      setRunning(false);
    }
  };

  const runExam = async () => {
    if (examRunning || running || arrearsRunning) return;
    if (!window.confirm("一键体检 = 渠道链路/目录检测 + 每个渠道 1 次 1-token 欠费探测（会产生极小费用）。确认执行？")) return;
    setExamRunning(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch("/api/admin/ops/patrol", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ action: "full" }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
      setSnapshot(body.snapshot || null);
      setArrears(body.arrears || null);
      setNotice("一键体检完成：链路、模型目录与欠费状态已更新");
      void load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "一键体检失败");
    } finally {
      setExamRunning(false);
    }
  };
  const results = snapshot?.channels || [];
  const displayRows: ChannelResult[] = results.length > 0 ? results : channels.map((channel) => ({
    ...channel,
    status: "unknown" as const,
    httpStatus: null,
    latencyMs: null,
    credentialReady: false,
    modelsVisible: 0,
    modelsMissing: [],
    modelItems: (channel.models ?? []).map((model) => ({ ...model, catalogVisible: false })),
    balanceUsd: null,
    usedUsd: null,
    balanceSupported: false,
    balanceState: "missing-credential" as const,
    error: locked ? "解锁后可检测" : null,
    checkedAt: "",
  }));
  const toggleHost = (host: string) => setExpandedHosts((current) => current.includes(host) ? current.filter((item) => item !== host) : [...current, host]);
  const runArrears = async () => {
    if (arrearsRunning || running) return;
    const count = channels.length || results.length;
    if (!window.confirm(`将对 ${count} 个渠道各发送 1 次 1-token 文本请求，用于判断是否欠费（会产生极小费用）。确认执行？`)) return;
    setArrearsRunning(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch("/api/admin/ops/patrol", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ action: "arrears" }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
      setArrears(body.arrears || null);
      setNotice("欠费探测完成");
      void load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "欠费探测失败");
    } finally {
      setArrearsRunning(false);
    }
  };
  const kpis = useMemo(() => {
    const ok = results.filter((item) => item.status === "ok").length;
    const degraded = results.filter((item) => item.status === "degraded").length;
    const down = results.filter((item) => item.status === "down" || item.status === "unknown").length;
    const balance = results.reduce((sum, item) => sum + (item.balanceSupported && Number.isFinite(item.balanceUsd) ? Number(item.balanceUsd) : 0), 0);
    const readable = results.filter((item) => item.balanceSupported).length;
    return { ok, degraded, down, balance, readable };
  }, [results]);

  const needsUnlock = /解锁|管理员密码/u.test(error);

  if (needsUnlock) {
    return (
      <section data-testid="ops-patrol-panel" className="min-w-0">
        <div className="rounded-2xl border border-[var(--border)] bg-[var(--card)] p-6">
          <h2 className="text-xl font-bold text-[var(--foreground)]">运营巡检</h2>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-[var(--muted-foreground)]">
            这里包含渠道余额、模型链路和欠费探测，属于敏感操作，需要先解锁管理员密码。解锁后可一键看到：
          </p>
          <ul className="mt-3 grid gap-1.5 text-sm text-[var(--foreground)] sm:grid-cols-2">
            <li>· 每个中转站的余额与是否欠费</li>
            <li>· 每个渠道下你本地添加的模型清单</li>
            <li>· 链路是否通、鉴权是否失败、目录是否可见</li>
            <li>· 延迟、失败原因与巡检时间</li>
          </ul>
          <button type="button" onClick={onRequestUnlock} className="mt-4 rounded-xl bg-[var(--primary)] px-5 py-2.5 text-sm font-semibold text-white">
            解锁并查看渠道
          </button>
        </div>
      </section>
    );
  }

  return (
    <section data-testid="ops-patrol-panel" className="min-w-0 space-y-4">
      <div className="rounded-2xl border border-[var(--border)] bg-[var(--card)] p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-xl font-bold text-[var(--foreground)]">运营巡检</h2>
            <p className="mt-1 max-w-3xl text-sm leading-6 text-[var(--muted-foreground)]">
              只聚合中转站渠道（官网直连的 DeepSeek/火山/百炼等不参与巡检），一键检测鉴权、连通、模型目录与余额。只做只读探测，不发起付费生成；密钥不出服务端。
              上次检测：{timeLabel(snapshot?.checkedAt)}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button type="button" onClick={() => void load()} disabled={loading || running} className="rounded-xl border border-[var(--border)] bg-[var(--background)] px-4 py-2 text-sm font-medium disabled:opacity-50">
              刷新
            </button>
            <button type="button" data-testid="ops-patrol-full" onClick={() => void runExam()} disabled={examRunning || running || arrearsRunning || loading} className="rounded-xl border border-emerald-300 bg-emerald-50 px-4 py-2 text-sm font-semibold text-emerald-800 disabled:opacity-50">
              {examRunning ? "体检中…" : "一键体检"}
            </button>
            <button type="button" data-testid="ops-patrol-arrears" onClick={() => void runArrears()} disabled={arrearsRunning || running || loading} className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-2 text-sm font-medium text-amber-800 disabled:opacity-50">
              {arrearsRunning ? "探测中…" : "欠费探测"}
            </button>
            <button type="button" data-testid="ops-patrol-run" onClick={() => void run()} disabled={running || loading} className="rounded-xl bg-[var(--primary)] px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">
              {running ? "检测中…" : "一键检测"}
            </button>
          </div>
        </div>
        {error && (
          <div role="alert" className="mt-3 rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-700">
            {error}
            {onRequestUnlock && <button type="button" onClick={onRequestUnlock} className="ml-2 underline">去解锁</button>}
          </div>
        )}
        {locked && (
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
            <span>已显示渠道清单；余额、检测与欠费探测需要解锁敏感操作。</span>
            {onRequestUnlock && <button type="button" onClick={onRequestUnlock} className="rounded-lg bg-amber-700 px-3 py-1.5 text-xs font-semibold text-white">去解锁</button>}
          </div>
        )}
        {notice && <div role="status" className="mt-3 rounded-xl bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{notice}</div>}
      </div>

      <div className="rounded-2xl border border-[var(--border)] bg-[var(--card)] p-5" data-testid="ops-patrol-faults">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm font-semibold text-[var(--foreground)]">模型故障清单</p>
          <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${faults.length > 0 ? "bg-rose-50 text-rose-700" : "bg-emerald-50 text-emerald-700"}`}>
            {faults.length > 0 ? `${faults.length} 个模型异常` : "未发现故障"}
          </span>
        </div>
        <p className="mt-1 text-xs text-[var(--muted-foreground)]">只报有问题的模型；按渠道自动判定欠费、鉴权失败、API 故障或超时。</p>
        {faults.length > 0 && (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[760px] text-left text-sm">
              <thead className="bg-[var(--accent)] text-xs font-semibold text-[var(--muted-foreground)]">
                <tr>
                  <th className="px-3 py-2">模型</th>
                  <th className="px-3 py-2">渠道</th>
                  <th className="px-3 py-2">故障类型</th>
                  <th className="px-3 py-2">证据</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--border)]">
                {faults.slice(0, 50).map((fault) => (
                  <tr key={`${fault.host}:${fault.model}`}>
                    <td className="px-3 py-2 font-medium text-[var(--foreground)]">{fault.model}</td>
                    <td className="px-3 py-2 text-xs text-[var(--muted-foreground)]">{fault.host}</td>
                    <td className="px-3 py-2">
                      <span className={`rounded px-1.5 py-0.5 text-xs font-semibold ${fault.kind === "arrears" ? "bg-rose-50 text-rose-700" : fault.kind === "auth" ? "bg-amber-50 text-amber-800" : "bg-slate-50 text-slate-700"}`}>
                        {fault.kind === "arrears" ? "欠费/余额不足" : fault.kind === "auth" ? "鉴权失败" : fault.kind === "timeout" ? "超时" : "API 故障"}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-xs text-[var(--muted-foreground)]">{fault.detail}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {[
          { label: "渠道", value: channels.length || results.length, hint: "按端点自动聚合" },
          { label: "正常", value: kpis.ok, hint: `降级 ${kpis.degraded}` },
          { label: "异常", value: kpis.down, hint: "不可用或待验证" },
          { label: "可读余额合计", value: usd(kpis.balance), hint: `${kpis.readable} 个渠道可读，其余需用户令牌` },
        ].map((card) => (
          <div key={card.label} className="rounded-2xl border border-[var(--border)] bg-[var(--card)] p-4">
            <p className="text-xs text-[var(--muted-foreground)]">{card.label}</p>
            <p className="mt-1 text-2xl font-bold text-[var(--foreground)]">{card.value}</p>
            <p className="mt-1 text-xs text-[var(--muted-foreground)]">{card.hint}</p>
          </div>
        ))}
      </div>

      <div className="overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--card)]">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--border)] px-5 py-3">
          <p className="text-sm font-semibold text-[var(--foreground)]">渠道余额与链路</p>
          <p className="text-xs text-[var(--muted-foreground)]">余额来自中转站计费接口；未开放余额的渠道只做连通与目录检测。</p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[980px] text-left text-sm">            <thead className="bg-[var(--accent)] text-xs font-semibold text-[var(--muted-foreground)]">
              <tr>
                <th className="px-4 py-3">渠道</th>
                <th className="px-4 py-3">状态</th>
                <th className="px-4 py-3">余额</th>
                <th className="px-4 py-3">已用</th>
                <th className="px-4 py-3">延迟</th>
                <th className="px-4 py-3">目录可见</th>
                <th className="px-4 py-3">说明</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border)]">
              {displayRows.map((item) => (
                <Fragment key={item.host}>
                  <tr data-testid="ops-patrol-channel">
                    <td className="px-4 py-3">
                      <p className="font-medium text-[var(--foreground)]">{item.host}</p>
                      <p className="text-xs text-[var(--muted-foreground)]">{item.modelCount} 个模型 · {item.adapter === "secure-skill" ? "自定义中转" : "OpenAI 兼容"}</p>
                      {item.modelItems.length > 0 && (
                        <button type="button" onClick={() => toggleHost(item.host)} className="mt-1 text-xs text-[#175cd3] underline">
                          {expandedHosts.includes(item.host) ? "收起模型" : "查看模型"}（{item.modelItems.length}）
                        </button>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <span data-testid="ops-patrol-status" className={`inline-flex rounded-full border px-2 py-0.5 text-xs font-semibold ${STATUS_STYLE[item.status]}`}>{STATUS_LABEL[item.status]}</span>
                    </td>
                    <td className="px-4 py-3 font-semibold">
                      {item.balanceSupported
                        ? usd(item.balanceUsd)
                        : item.balanceState === "unlimited"
                          ? "无法读取"
                          : item.balanceState === "missing-credential"
                            ? (locked ? "解锁后可见" : "需用户令牌")
                            : "接口不支持"}
                    </td>
                    <td className="px-4 py-3">{item.usedUsd === null ? "—" : usd(item.usedUsd)}</td>
                    <td className="px-4 py-3">{item.latencyMs === null ? "—" : `${item.latencyMs} ms`}</td>
                    <td className="px-4 py-3">{item.modelsVisible > 0 ? `${item.modelCount - item.modelsMissing.length}/${item.modelCount}` : "—"}</td>
                    <td className="px-4 py-3 text-xs text-[var(--muted-foreground)]">
                      {item.error || (item.modelsMissing.length > 0 ? `目录未见：${item.modelsMissing.slice(0, 3).join("、")}` : "正常")}
                    </td>
                  </tr>
                  {expandedHosts.includes(item.host) && (
                    <tr>
                      <td colSpan={7} className="bg-[var(--accent)] px-4 py-3">
                        <div className="flex flex-wrap gap-1.5">
                          {item.modelItems.map((model) => (
                            <span key={`${model.table}:${model.modelName || model.name}`} className={`rounded border px-2 py-1 text-xs ${model.catalogVisible ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-[var(--border)] bg-[var(--card)] text-[var(--muted-foreground)]"}`} title={model.catalogVisible ? "目录可见" : "目录未匹配（可能是别名或未开通）"}>
                              {model.name}
                            </span>
                          ))}
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
              {!displayRows.length && (
                <tr>
                  <td colSpan={7} className="px-4 py-10 text-center text-sm text-[var(--muted-foreground)]">
                    {loading ? "正在读取渠道…" : "还没有检测结果，点右上角「一键检测」开始。"}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <p className="border-t border-[var(--border)] px-5 py-3 text-xs leading-5 text-[var(--muted-foreground)]">
          真实余额需要在中转站用户中心生成 access token，并配置服务端环境变量
          <code className="mx-1 rounded bg-[var(--accent)] px-1">OPS_RELAY_&lt;HOST&gt;_ACCESS_TOKEN</code>
          （如 <code className="rounded bg-[var(--accent)] px-1">OPS_RELAY_GAORUI_CC_ACCESS_TOKEN</code>）；只配置模型 key 时余额会显示“无法读取”，可用「欠费探测」判断是否欠费。
        </p>
      </div>

      {arrears && (
        <div className="rounded-2xl border border-[var(--border)] bg-[var(--card)] p-5" data-testid="ops-patrol-arrears-result">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-semibold text-[var(--foreground)]">欠费探测</p>
            <p className="text-xs text-[var(--muted-foreground)]">每个渠道发 1 次 1-token 文本请求 · {timeLabel(arrears.checkedAt)}</p>
          </div>
          <div className="mt-3 grid gap-2 md:grid-cols-2">
            {arrears.results.map((item) => (
              <div key={item.host} className="flex flex-wrap items-center gap-2 rounded-xl border border-[var(--border)] px-3 py-2 text-xs">
                <span className="font-medium text-[var(--foreground)]">{item.host}</span>
                <span className={`rounded-full px-2 py-0.5 font-semibold ${item.status === "ok" ? "bg-emerald-50 text-emerald-700" : item.status === "insufficient" ? "bg-rose-50 text-rose-700" : item.status === "skipped" ? "bg-slate-50 text-slate-600" : "bg-amber-50 text-amber-700"}`}>
                  {item.status === "ok" ? "可调用" : item.status === "insufficient" ? "欠费/余额不足" : item.status === "auth-failed" ? "鉴权失败" : item.status === "skipped" ? "跳过" : "异常"}
                </span>
                <span className="text-[var(--muted-foreground)]">{item.message}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="grid gap-3 lg:grid-cols-2">
        <div className="rounded-2xl border border-[var(--border)] bg-[var(--card)] p-5">
          <div className="flex items-center justify-between gap-2">
            <p className="text-sm font-semibold text-[var(--foreground)]">自动巡检</p>
            <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${scheduler?.enabled ? "bg-emerald-50 text-emerald-700" : "bg-slate-50 text-slate-600"}`}>
              {scheduler?.enabled ? `每 ${scheduler.intervalMinutes} 分钟` : "已关闭"}
            </span>
          </div>
          <p className="mt-2 text-xs leading-5 text-[var(--muted-foreground)]">
            服务端到点自动执行只读巡检并写快照；状态变化才记录告警。
            {scheduler?.webhookConfigured ? " 告警 Webhook 已配置。" : " 告警 Webhook 未配置（OPS_ALERT_WEBHOOK_URL）。"}
          </p>
          <p className="mt-1 text-xs text-[var(--muted-foreground)]">关闭方式：OPS_PATROL_SCHEDULER=0；间隔：OPS_PATROL_INTERVAL_MINUTES。</p>
        </div>
        <div className="rounded-2xl border border-[var(--border)] bg-[var(--card)] p-5">
          <p className="text-sm font-semibold text-[var(--foreground)]">最近告警</p>
          {alerts.length === 0 ? (
            <p className="mt-2 text-xs text-[var(--muted-foreground)]">暂无状态变化告警。</p>
          ) : (
            <ul className="mt-2 space-y-1.5 text-xs text-[var(--muted-foreground)]">
              {alerts.slice(0, 5).map((alert) => (
                <li key={alert.id} className="flex gap-2">
                  <span className={`shrink-0 rounded px-1.5 py-0.5 font-semibold ${alert.kind === "recovered" ? "bg-emerald-50 text-emerald-700" : "bg-rose-50 text-rose-700"}`}>
                    {alert.kind === "recovered" ? "恢复" : alert.kind === "down" ? "不可用" : "降级"}
                  </span>
                  <span>{alert.message}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <div className="overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--card)]">
        <div className="border-b border-[var(--border)] px-5 py-3 text-sm font-semibold text-[var(--foreground)]">巡检历史</div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-left text-sm">
            <thead className="bg-[var(--accent)] text-xs font-semibold text-[var(--muted-foreground)]">
              <tr>
                <th className="px-4 py-2">时间</th>
                <th className="px-4 py-2">渠道</th>
                <th className="px-4 py-2">正常</th>
                <th className="px-4 py-2">降级</th>
                <th className="px-4 py-2">异常</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border)]">
              {history.slice(0, 8).map((entry) => (
                <tr key={entry.capturedAt}>
                  <td className="px-4 py-2 text-xs text-[var(--muted-foreground)]">{timeLabel(entry.capturedAt)}</td>
                  <td className="px-4 py-2">{entry.channelCount}</td>
                  <td className="px-4 py-2 text-emerald-700">{entry.ok}</td>
                  <td className="px-4 py-2 text-amber-700">{entry.degraded}</td>
                  <td className="px-4 py-2 text-rose-700">{entry.down}</td>
                </tr>
              ))}
              {history.length === 0 && (
                <tr><td colSpan={5} className="px-4 py-6 text-center text-xs text-[var(--muted-foreground)]">还没有历史记录，首次巡检后写入。</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}
