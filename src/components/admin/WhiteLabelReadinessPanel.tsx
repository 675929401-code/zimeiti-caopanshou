"use client";

import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, Globe2, RefreshCw, ServerCog, ShieldAlert } from "lucide-react";

type DomainStatus = {
  ok?: boolean;
  phase?: string;
  migrationApplied?: boolean;
  error?: string;
  database?: {
    asOf?: string;
    tableCounts?: Record<string, number>;
    prerequisites?: Record<string, number>;
    states?: Record<string, number>;
    runtimeBoundary?: Record<string, boolean | number | string | null>;
    hostnames?: Array<{
      hostname?: string;
      lifecycleStatus?: string;
      ownershipStatus?: string;
      routingStatus?: string;
      tlsStatus?: string;
      httpsStatus?: string;
    }>;
  };
  integration?: {
    connectedSources?: string[];
    pendingSources?: Array<{ source?: string; state?: string; fact?: string }>;
  };
};

type TenantBoundary = {
  generatedAt?: string;
  migrationRequired?: boolean;
  boundaryState?: "unavailable" | "partial" | "verified";
  phase?: string;
  tenants?: unknown[];
  sites?: unknown[];
  hostnames?: unknown[];
  brandReleases?: unknown[];
  resourceIntegrations?: unknown[];
  isolationReceipts?: unknown[];
  consistency?: {
    coverage?: {
      resources?: { expected?: number; registered?: number; integrated?: number };
    };
    issues?: Array<{ code?: string; severity?: string; message?: string }>;
  };
};

function dateTime(value?: string) {
  if (!value) return "暂无采集时间";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "暂无采集时间";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).format(date).replaceAll("/", "-");
}

function statusLabel(value?: string) {
  const labels: Record<string, string> = {
    unavailable: "未接入",
    partial: "部分接入",
    verified: "已验证",
    foundation_only: "基础数据层",
    foundation_status_only: "基础状态审计",
    draft: "草稿",
    pending: "待验证",
    pending_verification: "待验证",
    passed: "已通过",
    failed: "失败",
    issued: "已签发",
    published: "已发布",
  };
  return labels[value || ""] || value || "未知";
}

export default function WhiteLabelReadinessPanel({ token }: { token: string }) {
  const [domain, setDomain] = useState<DomainStatus | null>(null);
  const [boundary, setBoundary] = useState<TenantBoundary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const headers = { Authorization: `Bearer ${token}` };
      const [domainResponse, boundaryResponse] = await Promise.all([
        fetch("/api/admin/domain-release/status", { headers, cache: "no-store" }),
        fetch("/api/admin/multitenant-boundary", { headers, cache: "no-store" }),
      ]);
      const [domainPayload, boundaryPayload] = await Promise.all([
        domainResponse.json().catch(() => ({})),
        boundaryResponse.json().catch(() => ({})),
      ]);
      if (!domainResponse.ok && domainResponse.status !== 503) {
        throw new Error(domainPayload.error || "域名发布状态读取失败");
      }
      if (!boundaryResponse.ok && boundaryResponse.status !== 503) {
        throw new Error(boundaryPayload.error || "租户边界状态读取失败");
      }
      setDomain(domainPayload as DomainStatus);
      setBoundary(boundaryPayload as TenantBoundary);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "贴牌准备度读取失败");
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => { void load(); }, [load]);

  const runtime = domain?.database?.runtimeBoundary || {};
  const connectedRuntimeChecks = [
    runtime.dnsResolverConnected,
    runtime.tlsIssuerConnected,
    runtime.httpsProbeWorkerConnected,
    runtime.gatewayConnectorConnected,
    runtime.trustedHostResolutionConnected,
    runtime.unknownHostHardRejectActive,
    runtime.brandRuntimeBindingConnected,
  ].filter((value) => value === true).length;
  const resourceCoverage = boundary?.consistency?.coverage?.resources;
  const issues = boundary?.consistency?.issues || [];
  const pendingSources = domain?.integration?.pendingSources || [];
  const hostnames = domain?.database?.hostnames || [];

  return (
    <section className="space-y-5" data-testid="white-label-readiness-panel">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.18em] text-[#087f6d]">White-label readiness</p>
          <h2 className="mt-1 text-2xl font-black text-[#172033]">域名与贴牌</h2>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-[#667085]">这里显示真实租户隔离、域名认领、DNS、TLS、网关和品牌绑定证据。当前没有证据的环节会明确显示“未接入”，不会把数据库草稿当成已经完成域名映射。</p>
        </div>
        <button type="button" onClick={() => void load()} disabled={loading} className="inline-flex h-10 items-center gap-2 rounded-xl border border-[#d0d5dd] bg-white px-4 text-sm font-bold text-[#344054] disabled:opacity-50">
          <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />刷新事实
        </button>
      </div>

      {error && <div role="alert" className="rounded-2xl border border-rose-200 bg-rose-50 p-4 text-sm font-bold text-rose-800">{error}</div>}

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <article className="rounded-2xl border border-[#d0d5dd] bg-white p-4"><Globe2 className="h-5 w-5 text-[#087f6d]" /><p className="mt-4 text-xs font-bold text-[#667085]">自定义域名</p><p className="mt-1 text-2xl font-black text-[#172033]">{hostnames.length}</p><p className="mt-1 text-xs text-[#667085]">数据库记录，不代表已上线</p></article>
        <article className="rounded-2xl border border-[#d0d5dd] bg-white p-4"><ServerCog className="h-5 w-5 text-[#175cd3]" /><p className="mt-4 text-xs font-bold text-[#667085]">运行时连接</p><p className="mt-1 text-2xl font-black text-[#172033]">{connectedRuntimeChecks}/7</p><p className="mt-1 text-xs text-[#667085]">DNS、证书、网关、Host 与品牌绑定</p></article>
        <article className="rounded-2xl border border-[#d0d5dd] bg-white p-4"><ShieldAlert className="h-5 w-5 text-amber-600" /><p className="mt-4 text-xs font-bold text-[#667085]">租户隔离</p><p className="mt-1 text-2xl font-black text-[#172033]">{statusLabel(boundary?.boundaryState)}</p><p className="mt-1 text-xs text-[#667085]">{resourceCoverage ? `${resourceCoverage.integrated || 0}/${resourceCoverage.expected || 0} 资源闭环` : "尚无覆盖证据"}</p></article>
        <article className="rounded-2xl border border-[#d0d5dd] bg-white p-4"><CheckCircle2 className="h-5 w-5 text-violet-600" /><p className="mt-4 text-xs font-bold text-[#667085]">品牌发布记录</p><p className="mt-1 text-2xl font-black text-[#172033]">{boundary?.brandReleases?.length || 0}</p><p className="mt-1 text-xs text-[#667085]">状态采集于 {dateTime(domain?.database?.asOf || boundary?.generatedAt)}</p></article>
      </div>

      <div className="rounded-2xl border border-amber-200 bg-amber-50 p-5" data-testid="white-label-runtime-boundary">
        <p className="font-black text-amber-900">当前阶段：{statusLabel(domain?.phase || boundary?.phase)}</p>
        <p className="mt-2 text-sm leading-6 text-amber-800">域名注册、DNS 记录写入、证书签发、Nginx/网关路由和正式发布仍需独立接入并留下验证回执。在这些连接完成前，本页面只做真实状态审计，不提供会造成“已发布”误解的操作按钮。</p>
      </div>

      <div className="grid gap-5 xl:grid-cols-2">
        <section className="rounded-2xl border border-[#d0d5dd] bg-white p-5">
          <h3 className="font-black text-[#172033]">待接入链路 · {pendingSources.length}</h3>
          <div className="mt-4 space-y-2">
            {pendingSources.slice(0, 8).map((source, index) => (
              <div key={`${source.source || "source"}-${index}`} className="rounded-xl border border-[#eaecf0] bg-[#f9fafb] p-3">
                <div className="flex items-center justify-between gap-3"><p className="text-sm font-black text-[#344054]">{source.source || "未命名来源"}</p><span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-bold text-amber-800">{statusLabel(source.state)}</span></div>
                {source.fact && <p className="mt-1 text-xs leading-5 text-[#667085]">{source.fact}</p>}
              </div>
            ))}
            {!pendingSources.length && <p className="text-sm text-[#667085]">暂无来源状态；请先应用域名控制平面迁移。</p>}
          </div>
        </section>

        <section className="rounded-2xl border border-[#d0d5dd] bg-white p-5">
          <h3 className="font-black text-[#172033]">租户边界问题 · {issues.length}</h3>
          <div className="mt-4 space-y-2">
            {issues.slice(0, 8).map((issue, index) => (
              <div key={`${issue.code || "issue"}-${index}`} className="rounded-xl border border-[#eaecf0] p-3">
                <div className="flex items-center justify-between gap-3"><p className="text-sm font-black text-[#344054]">{issue.code || "BOUNDARY_STATUS"}</p><span className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${issue.severity === "error" ? "bg-rose-100 text-rose-800" : "bg-amber-100 text-amber-800"}`}>{issue.severity === "error" ? "错误" : "待完善"}</span></div>
                {issue.message && <p className="mt-1 text-xs leading-5 text-[#667085]">{issue.message}</p>}
              </div>
            ))}
            {!issues.length && <p className="text-sm text-emerald-700">当前快照未发现边界合同异常。</p>}
          </div>
        </section>
      </div>

      {hostnames.length > 0 && (
        <section className="overflow-hidden rounded-2xl border border-[#d0d5dd] bg-white">
          <div className="border-b border-[#eaecf0] px-5 py-4"><h3 className="font-black text-[#172033]">域名证据</h3></div>
          <div className="overflow-x-auto"><table className="min-w-full text-left text-sm"><thead className="bg-[#f9fafb] text-xs text-[#667085]"><tr><th className="px-5 py-3">域名</th><th className="px-5 py-3">认领</th><th className="px-5 py-3">路由</th><th className="px-5 py-3">TLS</th><th className="px-5 py-3">HTTPS</th></tr></thead><tbody className="divide-y divide-[#eaecf0]">{hostnames.map((hostname, index) => <tr key={`${hostname.hostname || "host"}-${index}`}><td className="px-5 py-3 font-mono font-bold text-[#344054]">{hostname.hostname || "未知"}</td><td className="px-5 py-3">{statusLabel(hostname.ownershipStatus)}</td><td className="px-5 py-3">{statusLabel(hostname.routingStatus)}</td><td className="px-5 py-3">{statusLabel(hostname.tlsStatus)}</td><td className="px-5 py-3">{statusLabel(hostname.httpsStatus)}</td></tr>)}</tbody></table></div>
        </section>
      )}
    </section>
  );
}
