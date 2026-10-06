"use client";

import { useEffect, useState, type ReactNode } from "react";
import { Fingerprint, KeyRound, MapPin, Network, RefreshCw, ShieldAlert, UserRoundSearch } from "lucide-react";

type Investigation = {
  event: {
    id: string;
    type: string;
    riskLevel: string;
    source: string;
    path: string | null;
    method: string | null;
    blocked: boolean;
    occurredAt: string;
    occurrenceCount: number;
    firstObservedAt: string | null;
    lastObservedAt: string | null;
  };
  actor: {
    classification: string;
    label: string;
    confidence: "high" | "medium" | "low" | "unavailable";
    relationship: string;
    account: {
      id: string;
      username: string | null;
      displayName: string | null;
      role: string | null;
      status: string | null;
      memberStatus: string | null;
      phoneMasked: string | null;
      emailMasked: string | null;
    } | null;
    evidence: string[];
  };
  network: {
    ipAddress: string | null;
    ipAvailability: "available" | "unavailable";
    ipUnavailableReason: string | null;
    ipHash: string | null;
    addressFamily: "ipv4" | "ipv6" | "unknown";
    scope: string;
    captureSource: string;
    trust: string;
    proxyChain: string[] | null;
    proxyChainStatus: string;
  };
  location: {
    status: string;
    country: string | null;
    province: string | null;
    city: string | null;
    county: string | null;
    source: string;
    precision: string;
    statement: string;
    lookedUpAt: string | null;
  };
  client: {
    rawUserAgent: string | null;
    deviceType: string;
    browser: { name: string; version: string | null };
    os: { name: string; version: string | null };
    automation: { suspected: boolean; signals: string[] };
    parser: string;
  };
  correlations: {
    byNetwork: Correlation;
    byAccount: Correlation;
    sessionEvidence: {
      status: string;
      matchingSessions: number;
    };
  };
  evidenceQuality: {
    status: "complete" | "partial" | "limited";
    limitations: string[];
    rawIpStored: boolean;
    exactLocationAvailable: boolean;
    proxyChainRecorded: boolean;
  };
  audit: {
    reason: string;
    revealedAt: string;
    permission: string;
    stepUpVerified: boolean;
  };
};

type Correlation = {
  matchedBy: string;
  total: number;
  highOrCritical: number;
  blocked: number;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
  topEventTypes: Array<{ type: string; count: number }> | string[];
  sampleCapped: boolean;
};

const confidenceLabels: Record<string, string> = {
  high: "高置信",
  medium: "中置信",
  low: "低置信",
  unavailable: "证据不足",
};

const scopeLabels: Record<string, string> = {
  loopback: "本机回环",
  private: "内网地址",
  link_local: "链路本地",
  public: "公网地址",
  reserved: "保留地址",
  invalid: "地址无效",
  unknown: "范围未知",
};

const relationshipLabels: Record<string, string> = {
  session_telemetry_match: "事件时段的账号、IP 与设备遥测匹配，仍不能等同自然人身份",
  verified_session_match: "事件发生时匹配到已验证会话",
  account_target_only: "仅命中或指向账号，不能证明账号本人发起",
  historical_event_reference: "仅有历史账号快照",
  no_account_reference: "未关联平台账号",
};

const sessionLabels: Record<string, string> = {
  matched_at_event_time: "事件时间命中有效会话",
  not_matched: "未命中同时段有效会话",
  not_applicable: "此类事件不适用会话判断",
  unavailable: "会话证据不可用",
};

function formatDate(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString("zh-CN", { hour12: false });
}

function correlationTypes(value: Correlation["topEventTypes"]): string {
  if (!Array.isArray(value) || value.length === 0) return "暂无";
  return value.map((item) => typeof item === "string" ? item : `${item.type} × ${item.count}`).join("、");
}

function EvidenceCard({ title, icon, children }: { title: string; icon: ReactNode; children: ReactNode }) {
  return (
    <section className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-4 shadow-sm">
      <h5 className="flex items-center gap-2 text-sm font-bold text-[var(--foreground)]">{icon}{title}</h5>
      <div className="mt-3 space-y-2 text-xs leading-5 text-[var(--muted-foreground)]">{children}</div>
    </section>
  );
}

function Fact({ label, value, mono = false }: { label: string; value: ReactNode; mono?: boolean }) {
  return (
    <div className="grid grid-cols-[88px_minmax(0,1fr)] gap-2">
      <span>{label}</span>
      <span className={`min-w-0 text-[var(--foreground)] ${mono ? "break-all font-mono" : "break-words"}`}>{value || "—"}</span>
    </div>
  );
}

export function SecurityEventInvestigation({
  eventId,
  token,
  sensitiveUnlocked,
  onRequestUnlock,
}: {
  eventId: string;
  token: string;
  sensitiveUnlocked: boolean;
  onRequestUnlock: () => void;
}) {
  const [reason, setReason] = useState("");
  const [investigation, setInvestigation] = useState<Investigation | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    setInvestigation(null);
    setError("");
    setReason("");
  }, [eventId]);

  useEffect(() => {
    if (sensitiveUnlocked) return;
    setInvestigation(null);
  }, [sensitiveUnlocked]);

  const reveal = async () => {
    const normalizedReason = reason.trim();
    if (normalizedReason.length < 8) {
      setError("请填写至少 8 个字的调查原因或工单说明");
      return;
    }
    if (!sensitiveUnlocked) {
      onRequestUnlock();
      return;
    }
    setLoading(true);
    setError("");
    try {
      const response = await fetch(`/api/admin/security-events/${encodeURIComponent(eventId)}/investigation?reason=${encodeURIComponent(normalizedReason)}`, {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
      });
      const payload = await response.json().catch(() => ({}));
      if (response.status === 428 || payload.code === "ADMIN_STEP_UP_REQUIRED") {
        onRequestUnlock();
        throw new Error("请完成管理员再次验证后重试");
      }
      if (!response.ok || !payload.investigation) {
        throw new Error(payload.error || "调查证据读取失败");
      }
      setInvestigation(payload.investigation as Investigation);
    } catch (reasonError) {
      setInvestigation(null);
      setError(reasonError instanceof Error ? reasonError.message : "调查证据读取失败");
    } finally {
      setLoading(false);
    }
  };

  if (!investigation) {
    return (
      <div className="mt-3 rounded-xl border border-dashed border-emerald-600/30 bg-emerald-500/[0.04] p-4" data-security-investigation-gate>
        <div className="flex flex-col gap-3 xl:flex-row xl:items-end">
          <label className="min-w-0 flex-1 text-xs font-semibold text-[var(--foreground)]">
            调查原因（会写入管理员审计）
            <input
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="例如：核查连续登录失败是否来自同一外部地址"
              maxLength={160}
              data-testid="security-investigation-reason"
              className="mt-2 h-10 w-full rounded-lg border border-[var(--border)] bg-[var(--background)] px-3 text-sm font-normal outline-none focus:border-emerald-600"
            />
          </label>
          <button
            type="button"
            onClick={() => sensitiveUnlocked ? void reveal() : onRequestUnlock()}
            disabled={loading}
            data-testid="security-investigation-reveal"
            className="inline-flex h-10 shrink-0 items-center justify-center gap-2 rounded-lg bg-emerald-700 px-4 text-xs font-bold text-white disabled:opacity-50"
          >
            {sensitiveUnlocked ? <Fingerprint className="h-4 w-4" /> : <KeyRound className="h-4 w-4" />}
            {loading ? "读取中…" : sensitiveUnlocked ? "读取单条调查证据" : "再次验证后调查"}
          </button>
        </div>
        <p className="mt-2 text-[11px] leading-5 text-[var(--muted-foreground)]">完整 IP 仅在本区域临时显示，关闭事件详情或解锁到期即从页面移除；不写入浏览器存储，不支持批量揭示。</p>
        {error && <p role="alert" className="mt-2 rounded-lg bg-red-500/8 px-3 py-2 text-xs font-semibold text-red-600">{error}</p>}
      </div>
    );
  }

  const account = investigation.actor.account;
  const geoLabel = [investigation.location.country, investigation.location.province, investigation.location.city, investigation.location.county].filter(Boolean).join(" · ");
  const qualityTone = investigation.evidenceQuality.status === "complete"
    ? "bg-emerald-500/10 text-emerald-700"
    : investigation.evidenceQuality.status === "partial"
      ? "bg-amber-500/10 text-amber-700"
      : "bg-red-500/10 text-red-700";

  return (
    <div className="mt-3 space-y-3 break-normal" data-security-investigation-result>
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-emerald-600/25 bg-emerald-500/[0.05] px-4 py-3">
        <div>
          <p className="text-sm font-bold text-[var(--foreground)]">受控调查证据</p>
          <p className="mt-0.5 text-[11px] text-[var(--muted-foreground)]">读取时间 {formatDate(investigation.audit.revealedAt)} · 权限 {investigation.audit.permission} · 再次验证已确认</p>
        </div>
        <div className="flex items-center gap-2">
          <span className={`rounded-full px-2.5 py-1 text-[11px] font-bold ${qualityTone}`}>证据{investigation.evidenceQuality.status === "complete" ? "完整" : investigation.evidenceQuality.status === "partial" ? "部分缺失" : "有限"}</span>
          <button type="button" onClick={() => void reveal()} disabled={loading} className="inline-flex items-center gap-1 rounded-lg border border-[var(--border)] px-2.5 py-1.5 text-[11px] font-bold text-[var(--foreground)] disabled:opacity-40"><RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />刷新</button>
          <button type="button" onClick={() => setInvestigation(null)} data-testid="security-investigation-hide" className="rounded-lg border border-[var(--border)] px-2.5 py-1.5 text-[11px] font-bold text-[var(--foreground)]">隐藏敏感证据</button>
        </div>
      </div>

      <div className="grid gap-3 xl:grid-cols-2 2xl:grid-cols-4">
        <EvidenceCard title="主体归因" icon={<UserRoundSearch className="h-4 w-4 text-emerald-700" />}>
          <Fact label="当前判断" value={investigation.actor.label} />
          <Fact label="置信度" value={confidenceLabels[investigation.actor.confidence] || investigation.actor.confidence} />
          <Fact label="账号关系" value={relationshipLabels[investigation.actor.relationship] || investigation.actor.relationship} />
          <Fact label="账号" value={account ? `${account.displayName || account.username || "未命名"} · ${account.role || "普通用户"}` : "未关联"} />
          {account && <Fact label="账号状态" value={[account.status, account.memberStatus, account.phoneMasked, account.emailMasked].filter(Boolean).join(" · ")} />}
          <div className="rounded-lg bg-[var(--background)] p-2">{investigation.actor.evidence.length > 0 ? investigation.actor.evidence.join("；") : "没有足够身份佐证"}</div>
        </EvidenceCard>

        <EvidenceCard title="网络线索" icon={<Network className="h-4 w-4 text-blue-600" />}>
          <Fact label="完整 IP" mono value={investigation.network.ipAddress || "不可用"} />
          <Fact label="地址范围" value={`${scopeLabels[investigation.network.scope] || investigation.network.scope} · ${investigation.network.addressFamily}`} />
          <Fact label="采集来源" value={investigation.network.captureSource} />
          <Fact label="可信状态" value={investigation.network.trust} />
          <Fact label="代理链" value={investigation.network.proxyChain?.join(" → ") || "历史记录未保存"} />
          {investigation.network.ipUnavailableReason && <div className="rounded-lg bg-amber-500/8 p-2 text-amber-700">{investigation.network.ipUnavailableReason}</div>}
          {investigation.network.ipHash && <Fact label="关联哈希" mono value={investigation.network.ipHash} />}
        </EvidenceCard>

        <EvidenceCard title="地区与网络情报" icon={<MapPin className="h-4 w-4 text-orange-600" />}>
          <Fact label="国家/地区" value={geoLabel || "不可用"} />
          <Fact label="数据来源" value={investigation.location.source} />
          <Fact label="定位精度" value={investigation.location.precision} />
          <Fact label="查询时间" value={formatDate(investigation.location.lookedUpAt)} />
          <div className="rounded-lg bg-[var(--background)] p-2 text-[var(--foreground)]">{investigation.location.statement}</div>
          <p className="text-[11px]">IP 地理位置只能作为区域线索，不能证明具体住址或实际操作者。</p>
        </EvidenceCard>

        <EvidenceCard title="设备与自动化特征" icon={<ShieldAlert className="h-4 w-4 text-violet-600" />}>
          <Fact label="设备类型" value={investigation.client.deviceType} />
          <Fact label="浏览器" value={[investigation.client.browser.name, investigation.client.browser.version].filter(Boolean).join(" ")} />
          <Fact label="操作系统" value={[investigation.client.os.name, investigation.client.os.version].filter(Boolean).join(" ")} />
          <Fact label="自动化嫌疑" value={investigation.client.automation.suspected ? "有" : "未发现"} />
          <Fact label="特征信号" value={investigation.client.automation.signals.join("、") || "暂无"} />
          <div className="max-h-24 overflow-auto rounded-lg bg-[var(--background)] p-2 font-mono text-[11px] break-all">{investigation.client.rawUserAgent || "未记录 User-Agent"}</div>
        </EvidenceCard>
      </div>

      <div className="grid gap-3 xl:grid-cols-3">
        <EvidenceCard title="同网络关联" icon={<Fingerprint className="h-4 w-4 text-blue-600" />}>
          <Fact label="关联事件" value={`${investigation.correlations.byNetwork.total} 条`} />
          <Fact label="高/严重" value={`${investigation.correlations.byNetwork.highOrCritical} 条`} />
          <Fact label="已拦截" value={`${investigation.correlations.byNetwork.blocked} 条`} />
          <Fact label="出现区间" value={`${formatDate(investigation.correlations.byNetwork.firstSeenAt)} 至 ${formatDate(investigation.correlations.byNetwork.lastSeenAt)}`} />
          <Fact label="主要类型" value={correlationTypes(investigation.correlations.byNetwork.topEventTypes)} />
        </EvidenceCard>
        <EvidenceCard title="同账号关联" icon={<UserRoundSearch className="h-4 w-4 text-emerald-700" />}>
          <Fact label="关联事件" value={`${investigation.correlations.byAccount.total} 条`} />
          <Fact label="高/严重" value={`${investigation.correlations.byAccount.highOrCritical} 条`} />
          <Fact label="会话判断" value={sessionLabels[investigation.correlations.sessionEvidence.status] || investigation.correlations.sessionEvidence.status} />
          <Fact label="匹配会话" value={`${investigation.correlations.sessionEvidence.matchingSessions} 个`} />
          <Fact label="主要类型" value={correlationTypes(investigation.correlations.byAccount.topEventTypes)} />
        </EvidenceCard>
        <EvidenceCard title="证据缺口与口径" icon={<ShieldAlert className="h-4 w-4 text-amber-600" />}>
          <Fact label="原始 IP" value={investigation.evidenceQuality.rawIpStored ? "已保存" : "未保存"} />
          <Fact label="精确地区" value={investigation.evidenceQuality.exactLocationAvailable ? "有来源" : "不可用"} />
          <Fact label="代理链" value={investigation.evidenceQuality.proxyChainRecorded ? "已记录" : "未记录"} />
          {(investigation.evidenceQuality.limitations || []).map((limitation) => <div key={limitation} className="rounded-lg bg-amber-500/8 p-2 text-amber-700">{limitation}</div>)}
        </EvidenceCard>
      </div>
    </div>
  );
}
