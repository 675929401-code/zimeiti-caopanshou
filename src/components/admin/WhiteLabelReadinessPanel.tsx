"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, CheckCircle2, Clipboard, Globe2, ImageUp, Loader2, Plus, RefreshCw, Rocket, Save, ServerCog, ShieldAlert, Trash2 } from "lucide-react";

import { refreshPublishedPlatformBranding } from "@/hooks/use-platform-branding";

type DomainStatus = {
  database?: { asOf?: string; runtimeBoundary?: Record<string, boolean | number | string | null> };
  integration?: { pendingSources?: Array<{ source?: string; state?: string; fact?: string }> };
};
type TenantBoundary = {
  boundaryState?: "unavailable" | "partial" | "verified";
  consistency?: {
    coverage?: { resources?: { expected?: number; integrated?: number } };
    issues?: Array<{ code?: string; severity?: string; message?: string }>;
  };
};
type WechatQrPurpose = "contact_wechat_qr_primary" | "contact_wechat_qr_secondary";
type DraftAssetIds = Partial<Record<WechatQrPurpose, string>>;
type WhiteLabelProfile = {
  profileId: string; brandName: string; brandShortName: string;
  brandSlogan: string; brandDescription: string; draftAssetIds: DraftAssetIds;
  contact: { name: string; wechat: string; phone: string; email: string };
  lifecycleStatus: string; revision: number; hostname: string; claimStatus: string;
  expectedTxtName: string; expectedTxtValue: string; ownershipStatus: string;
  routingStatus: string; tlsStatus: string; httpsStatus: string;
  brandReleaseStatus: string; brandBindingStatus: string; brandGeneration: number;
  draftReleaseId: string; publishedReleaseId: string; updatedAt: string;
};
type WhiteLabelState = { profiles: WhiteLabelProfile[]; asOf?: string };
type DraftForm = {
  profileId: string | null; expectedRevision: number; brandName: string;
  brandShortName: string; brandSlogan: string; brandDescription: string; hostname: string;
  contact: { name: string; wechat: string; phone: string; email: string };
  assetIds: DraftAssetIds;
};
type LocalQrPreview = { assetId: string; url: string };

const EMPTY_DRAFT: DraftForm = {
  profileId: null, expectedRevision: 0, brandName: "", brandShortName: "", hostname: "",
  brandSlogan: "", brandDescription: "", assetIds: {},
  contact: { name: "", wechat: "", phone: "", email: "" },
};

function formFromProfile(value: WhiteLabelProfile): DraftForm {
  return { profileId: value.profileId, expectedRevision: value.revision, brandName: value.brandName,
    brandShortName: value.brandShortName, brandSlogan: value.brandSlogan || "",
    brandDescription: value.brandDescription || "", hostname: value.hostname,
    contact: { ...value.contact }, assetIds: { ...(value.draftAssetIds || {}) } };
}

export function canSelectWhiteLabelProfile(dirty: boolean): boolean {
  return !dirty;
}

function dateTime(value?: string) {
  if (!value) return "暂无";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "暂无" : new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).format(date).replaceAll("/", "-");
}

function statusLabel(value?: string) {
  const labels: Record<string, string> = {
    unavailable: "未接入", partial: "部分接入", verified: "已验证", foundation_only: "基础数据层",
    pending_verification: "等待域名验证", domain_verified: "域名归属已验证", ready: "可以发布",
    published: "已发布", draft: "草稿", claimed: "已登记", pending: "待验证", failed: "失败",
    issued: "已签发", passed: "已通过", blocked: "等待网关接入",
  };
  return labels[value || ""] || value || "未知";
}

const INPUT_CLASS = "mt-1.5 h-11 w-full rounded-xl border border-[#d0d5dd] bg-white px-3 text-sm text-[#172033] outline-none transition focus:border-[#087f6d] focus:ring-2 focus:ring-[#087f6d]/10";
const TEXTAREA_CLASS = "mt-1.5 w-full resize-y rounded-xl border border-[#d0d5dd] bg-white px-3 py-3 text-sm leading-6 text-[#172033] outline-none transition focus:border-[#087f6d] focus:ring-2 focus:ring-[#087f6d]/10";

export default function WhiteLabelReadinessPanel({ token, onRequestUnlock }: { token: string; onRequestUnlock: () => void }) {
  const [domain, setDomain] = useState<DomainStatus | null>(null);
  const [boundary, setBoundary] = useState<TenantBoundary | null>(null);
  const [whiteLabel, setWhiteLabel] = useState<WhiteLabelState>({ profiles: [] });
  const [cnameTarget, setCnameTarget] = useState<string | null>(null);
  const [form, setForm] = useState<DraftForm>(EMPTY_DRAFT);
  const [savedSignature, setSavedSignature] = useState(JSON.stringify(EMPTY_DRAFT));
  const [localQrPreviews, setLocalQrPreviews] = useState<Partial<Record<WechatQrPurpose, LocalQrPreview>>>({});
  const qrObjectUrls = useRef<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [copied, setCopied] = useState("");
  const dirty = JSON.stringify(form) !== savedSignature;

  const selectProfile = useCallback((profile: WhiteLabelProfile | null) => {
    qrObjectUrls.current.forEach((url) => URL.revokeObjectURL(url));
    qrObjectUrls.current.clear();
    setLocalQrPreviews({});
    const next = profile ? formFromProfile(profile) : {
      ...EMPTY_DRAFT,
      contact: { ...EMPTY_DRAFT.contact },
      assetIds: {},
    };
    setForm(next); setSavedSignature(JSON.stringify(next)); setError(""); setNotice("");
  }, []);

  const load = useCallback(async (preferredProfileId?: string) => {
    setLoading(true); setError("");
    try {
      const headers = { Authorization: `Bearer ${token}` };
      const responses = await Promise.all([
        fetch("/api/admin/domain-release/status", { headers, cache: "no-store" }),
        fetch("/api/admin/multitenant-boundary", { headers, cache: "no-store" }),
        fetch("/api/admin/white-label", { headers, cache: "no-store" }),
      ]);
      const payloads = await Promise.all(responses.map((response) => response.json().catch(() => ({}))));
      if (!responses[0].ok && responses[0].status !== 503) throw new Error(payloads[0].error || "域名发布状态读取失败");
      if (!responses[1].ok && responses[1].status !== 503) throw new Error(payloads[1].error || "租户边界状态读取失败");
      if (!responses[2].ok) throw new Error(payloads[2].error || "贴牌配置读取失败");
      setDomain(payloads[0] as DomainStatus); setBoundary(payloads[1] as TenantBoundary);
      const nextState = (payloads[2].state || { profiles: [] }) as WhiteLabelState;
      setWhiteLabel(nextState);
      setCnameTarget(typeof payloads[2].cnameTarget === "string" ? payloads[2].cnameTarget : null);
      const selected = nextState.profiles.find((item) => item.profileId === preferredProfileId)
        || nextState.profiles.find((item) => item.profileId === form.profileId) || nextState.profiles[0] || null;
      selectProfile(selected);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "贴牌配置读取失败"); }
    finally { setLoading(false); }
  }, [form.profileId, selectProfile, token]);

  useEffect(() => { void load(); /* initial authoritative read */ }, [token]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => {
    qrObjectUrls.current.forEach((url) => URL.revokeObjectURL(url));
    qrObjectUrls.current.clear();
  }, []);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const activeProfile = useMemo(() => whiteLabel.profiles.find((item) => item.profileId === form.profileId) || null, [form.profileId, whiteLabel.profiles]);

  const write = async (action: "save-draft" | "verify-domain" | "publish") => {
    if (working) return;
    setWorking(action === "save-draft" ? "save" : action === "verify-domain" ? "verify" : "publish"); setError(""); setNotice("");
    try {
      const response = await fetch("/api/admin/white-label", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify(action === "save-draft"
          ? { action, ...form }
          : { action, profileId: activeProfile?.profileId, expectedRevision: activeProfile?.revision }),
      });
      const payload = await response.json().catch(() => ({}));
      if (response.status === 428 || payload.code === "ADMIN_STEP_UP_REQUIRED") {
        setError("保存、上传、验证或发布前，请先完成敏感操作验证。"); onRequestUnlock(); return;
      }
      if (!response.ok) throw new Error(payload.error || "贴牌配置操作失败");
      const profileId = String(payload.receipt?.profileId || activeProfile?.profileId || "");
      const successNotice = action === "verify-domain"
        ? payload.verified ? "DNS 归属验证通过；下一步可发布品牌版本，外网可见仍需 CNAME、网关与 TLS 接入。" : `尚未读取到正确 TXT 值（${payload.errorCode || "DNS_VALUE_MISMATCH"}）。配置生效后可再次验证。`
        : action === "publish"
          ? "白标品牌版本已发布并完成服务器读回；这不等于客户域名已经上线，仍需完成 CNAME、网关与 TLS/HTTPS 验证。"
          : "贴牌草稿已保存并完成数据库读回；草稿尚未发布，不会出现在公开页面。";
      if (action === "publish") refreshPublishedPlatformBranding();
      await load(profileId);
      setNotice(successNotice);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "贴牌配置操作失败"); }
    finally { setWorking(""); }
  };

  const uploadQr = async (purpose: WechatQrPurpose, file: File | null) => {
    if (!file || !activeProfile || working) return;
    setWorking(`upload:${purpose}`); setError(""); setNotice("");
    try {
      const upload = new FormData();
      upload.set("action", "upload-asset");
      upload.set("profileId", activeProfile.profileId);
      upload.set("expectedRevision", String(activeProfile.revision));
      upload.set("purpose", purpose);
      upload.set("file", file);
      const response = await fetch("/api/admin/white-label", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Idempotency-Key": crypto.randomUUID() },
        body: upload,
      });
      const payload = await response.json().catch(() => ({}));
      if (response.status === 428 || payload.code === "ADMIN_STEP_UP_REQUIRED") {
        setError("上传二维码前，请先完成敏感操作验证。"); onRequestUnlock(); return;
      }
      if (!response.ok) throw new Error(payload.error || "微信二维码上传失败");
      const assetId = typeof payload.asset?.id === "string" ? payload.asset.id : "";
      if (!assetId || payload.asset?.purpose !== purpose) throw new Error("二维码上传回执缺少有效资产编号");
      const previous = localQrPreviews[purpose];
      if (previous?.url) {
        URL.revokeObjectURL(previous.url);
        qrObjectUrls.current.delete(previous.url);
      }
      const previewUrl = URL.createObjectURL(file);
      qrObjectUrls.current.add(previewUrl);
      setLocalQrPreviews((current) => ({ ...current, [purpose]: { assetId, url: previewUrl } }));
      setForm((current) => ({ ...current, assetIds: { ...current.assetIds, [purpose]: assetId } }));
      setNotice("二维码已上传到白标专用资产库；请继续保存草稿。只有发布品牌版本后，公开页面才会展示。");
    } catch (caught) { setError(caught instanceof Error ? caught.message : "微信二维码上传失败"); }
    finally { setWorking(""); }
  };

  const removeQr = (purpose: WechatQrPurpose) => {
    const preview = localQrPreviews[purpose];
    if (preview?.url) {
      URL.revokeObjectURL(preview.url);
      qrObjectUrls.current.delete(preview.url);
    }
    setLocalQrPreviews((current) => {
      const next = { ...current };
      delete next[purpose];
      return next;
    });
    setForm((current) => {
      const assetIds = { ...current.assetIds };
      delete assetIds[purpose];
      return { ...current, assetIds };
    });
    setNotice("二维码已从当前草稿中移除；保存草稿后生效，已发布版本不会在重新发布前改变。");
  };

  const copy = async (label: string, value: string) => {
    try { await navigator.clipboard.writeText(value); setCopied(label); window.setTimeout(() => setCopied(""), 1_500); }
    catch { setError("复制失败，请手动选择文本复制。"); }
  };

  const runtime = domain?.database?.runtimeBoundary || {};
  const connectedRuntimeChecks = [runtime.dnsResolverConnected, runtime.tlsIssuerConnected, runtime.httpsProbeWorkerConnected, runtime.gatewayConnectorConnected, runtime.trustedHostResolutionConnected, runtime.unknownHostHardRejectActive, runtime.brandRuntimeBindingConnected].filter((value) => value === true).length;
  const issues = boundary?.consistency?.issues || [];
  const resourceCoverage = boundary?.consistency?.coverage?.resources;
  const pendingSources = domain?.integration?.pendingSources || [];

  const renderQrCard = (purpose: WechatQrPurpose, label: string) => {
    const assetId = form.assetIds[purpose] || "";
    const preview = localQrPreviews[purpose]?.assetId === assetId ? localQrPreviews[purpose]?.url : "";
    const uploadWorking = working === `upload:${purpose}`;
    return <article key={purpose} data-testid={`white-label-${purpose}`} className="rounded-2xl border border-[#d0d5dd] bg-[#f9fafb] p-4">
      <div className="flex items-start gap-3">
        <div className="grid h-20 w-20 shrink-0 place-items-center overflow-hidden rounded-xl border border-[#d0d5dd] bg-white p-1.5">
          {preview
            ? <img src={preview} alt={`${label}本地预览`} className="h-full w-full object-contain" />
            : assetId
              ? <div className="text-center"><CheckCircle2 className="mx-auto h-5 w-5 text-[#087f6d]" /><p className="mt-1 text-[9px] font-bold text-[#667085]">已有草稿资产</p></div>
              : <ImageUp className="h-5 w-5 text-[#98a2b3]" />}
        </div>
        <div className="min-w-0 flex-1"><h4 className="text-xs font-black text-[#172033]">{label}</h4><p className="mt-1 text-[11px] leading-5 text-[#667085]">PNG、JPEG 或 WebP；建议使用清晰正方形图片。</p>{assetId && <p className="mt-1 truncate font-mono text-[10px] text-[#667085]" title={assetId}>资产 {assetId.slice(0, 8)}</p>}</div>
      </div>
      <div className="mt-3 flex gap-2">
        <label className={`inline-flex h-9 flex-1 items-center justify-center gap-2 rounded-xl border border-dashed border-[#087f6d] bg-white px-3 text-xs font-black text-[#087f6d] ${!activeProfile || working ? "cursor-not-allowed opacity-40" : "cursor-pointer hover:bg-[#ecfdf7]"}`}>
          {uploadWorking ? <Loader2 className="h-4 w-4 animate-spin" /> : <ImageUp className="h-4 w-4" />}{assetId ? "替换图片" : "上传图片"}
          <input type="file" className="sr-only" aria-label={`上传${label}`} accept="image/png,image/jpeg,image/webp" disabled={!activeProfile || Boolean(working)} onChange={(event) => { void uploadQr(purpose, event.target.files?.[0] || null); event.currentTarget.value = ""; }} />
        </label>
        {assetId && <button type="button" aria-label={`移除${label}`} disabled={Boolean(working)} onClick={() => removeQr(purpose)} className="inline-flex h-9 items-center gap-1 rounded-xl border border-rose-200 bg-white px-3 text-xs font-bold text-rose-700 disabled:opacity-40"><Trash2 className="h-3.5 w-3.5" />移除</button>}
      </div>
      {!activeProfile && <p className="mt-2 text-[10px] font-bold text-amber-700">请先保存基本资料，建立白标配置后再上传。</p>}
    </article>;
  };

  return <section className="space-y-5" data-testid="white-label-readiness-panel">
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div><p className="text-xs font-bold uppercase tracking-[0.18em] text-[#087f6d]">White-label control plane</p><h2 className="mt-1 text-2xl font-black text-[#172033]">域名与贴牌</h2><p className="mt-2 max-w-3xl text-sm leading-6 text-[#667085]">这是白标品牌资料的单一配置入口：品牌文案、联系方式、微信二维码和域名统一填写。保存草稿不会公开；通过域名验证并发布品牌版本后，公开页面才读取已发布资料。</p></div>
      <button type="button" data-testid="white-label-refresh-authoritative" title={dirty ? "请先保存当前贴牌草稿" : "重新读取数据库与运行链路事实"} onClick={() => void load(form.profileId || undefined)} disabled={loading || Boolean(working) || dirty} className="inline-flex h-10 items-center gap-2 rounded-xl border border-[#d0d5dd] bg-white px-4 text-sm font-bold text-[#344054] disabled:cursor-not-allowed disabled:opacity-50"><RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />刷新事实回读</button>
    </div>
    {error && <div role="alert" className="rounded-2xl border border-rose-200 bg-rose-50 p-4 text-sm font-bold text-rose-800">{error}</div>}
    {notice && <div role="status" className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4 text-sm font-bold text-emerald-800">{notice}</div>}

    <div className="grid gap-5 xl:grid-cols-[280px_minmax(0,1fr)]">
      <aside className="rounded-2xl border border-[#d0d5dd] bg-white p-4 shadow-sm">
        <div className="flex items-center justify-between gap-2"><div><h3 className="font-black text-[#172033]">客户贴牌</h3><p className="mt-1 text-xs text-[#667085]">{whiteLabel.profiles.length} 份已保存配置</p></div><button type="button" disabled={dirty} title={dirty ? "请先保存当前贴牌草稿" : "新建贴牌配置"} onClick={() => selectProfile(null)} className="grid h-9 w-9 place-items-center rounded-xl bg-[#087f6d] text-white disabled:cursor-not-allowed disabled:opacity-40" aria-label="新建贴牌配置"><Plus className="h-4 w-4" /></button></div>
        <div className="mt-4 space-y-2">{whiteLabel.profiles.map((profile) => <button key={profile.profileId} type="button" disabled={!canSelectWhiteLabelProfile(dirty)} title={dirty ? "请先保存当前贴牌草稿" : undefined} onClick={() => selectProfile(profile)} className={`w-full rounded-xl border p-3 text-left disabled:cursor-not-allowed disabled:opacity-50 ${form.profileId === profile.profileId ? "border-[#087f6d] bg-[#ecfdf7]" : "border-[#eaecf0] bg-[#f9fafb] hover:border-[#98a2b3]"}`}><p className="truncate text-sm font-black text-[#172033]">{profile.brandName}</p><p className="mt-1 truncate font-mono text-[11px] text-[#667085]">{profile.hostname}</p><span className="mt-2 inline-flex rounded-full bg-white px-2 py-0.5 text-[10px] font-bold text-[#087f6d]">{statusLabel(profile.lifecycleStatus)}</span></button>)}{!whiteLabel.profiles.length && <p className="rounded-xl border border-dashed border-[#d0d5dd] p-4 text-xs leading-5 text-[#667085]">还没有客户贴牌配置。点击右上角加号开始。</p>}</div>
      </aside>

      <div className="rounded-2xl border border-[#d0d5dd] bg-white p-5 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-3 border-b border-[#eaecf0] pb-4"><div><h3 className="font-black text-[#172033]">{form.profileId ? "编辑贴牌草稿" : "新建贴牌草稿"}</h3><p className="mt-1 text-xs leading-5 text-[#667085]">保存草稿只写入后台，不代表发布或上线；公开页面永远只读取已发布版本。</p></div><div className="flex items-center gap-2">{dirty && <><span className="rounded-full bg-amber-100 px-2 py-1 text-[10px] font-bold text-amber-800">有未保存修改</span><button type="button" disabled={Boolean(working)} onClick={() => selectProfile(activeProfile)} className="h-10 rounded-xl border border-amber-300 bg-amber-50 px-3 text-xs font-bold text-amber-800 disabled:opacity-40">撤销修改</button></>}<button type="button" data-testid="white-label-save-draft" disabled={Boolean(working) || !dirty || !form.brandName.trim() || !form.hostname.trim()} onClick={() => void write("save-draft")} className="inline-flex h-10 items-center gap-2 rounded-xl bg-[#087f6d] px-4 text-sm font-black text-white disabled:cursor-not-allowed disabled:opacity-40">{working === "save" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}{working === "save" ? "保存并读回…" : "保存草稿"}</button></div></div>
        <div className="mt-5 grid gap-4 md:grid-cols-2">
          <label className="text-xs font-bold text-[#344054]">客户品牌名<input className={INPUT_CLASS} value={form.brandName} maxLength={120} onChange={(event) => setForm((current) => ({ ...current, brandName: event.target.value }))} placeholder="例如：某某内容科技" /></label>
          <label className="text-xs font-bold text-[#344054]">品牌简称<input className={INPUT_CLASS} value={form.brandShortName} maxLength={60} onChange={(event) => setForm((current) => ({ ...current, brandShortName: event.target.value }))} placeholder="用于侧栏和窄版标题" /></label>
          <label className="text-xs font-bold text-[#344054] md:col-span-2">品牌标语<input data-testid="white-label-brand-slogan" className={INPUT_CLASS} value={form.brandSlogan} maxLength={120} onChange={(event) => setForm((current) => ({ ...current, brandSlogan: event.target.value }))} placeholder="例如：让内容经营更简单" /></label>
          <label className="text-xs font-bold text-[#344054] md:col-span-2">品牌说明<textarea data-testid="white-label-brand-description" className={TEXTAREA_CLASS} value={form.brandDescription} maxLength={500} rows={3} onChange={(event) => setForm((current) => ({ ...current, brandDescription: event.target.value }))} placeholder="简要说明品牌定位、服务对象或核心价值" /></label>
          <label className="text-xs font-bold text-[#344054] md:col-span-2">客户域名<input className={`${INPUT_CLASS} font-mono`} value={form.hostname} maxLength={253} onChange={(event) => setForm((current) => ({ ...current, hostname: event.target.value }))} placeholder="例如：ai.customer.com（不要填写 https://）" /></label>
          <label className="text-xs font-bold text-[#344054]">联系人<input className={INPUT_CLASS} value={form.contact.name} maxLength={80} onChange={(event) => setForm((current) => ({ ...current, contact: { ...current.contact, name: event.target.value } }))} placeholder="例如：张经理" /></label>
          <label className="text-xs font-bold text-[#344054]">微信号<input className={INPUT_CLASS} value={form.contact.wechat} maxLength={80} onChange={(event) => setForm((current) => ({ ...current, contact: { ...current.contact, wechat: event.target.value } }))} placeholder="对方或项目联系人微信" /></label>
          <label className="text-xs font-bold text-[#344054]">联系电话<input className={INPUT_CLASS} value={form.contact.phone} maxLength={40} onChange={(event) => setForm((current) => ({ ...current, contact: { ...current.contact, phone: event.target.value } }))} placeholder="选填" /></label>
          <label className="text-xs font-bold text-[#344054]">联系邮箱<input className={INPUT_CLASS} value={form.contact.email} maxLength={254} onChange={(event) => setForm((current) => ({ ...current, contact: { ...current.contact, email: event.target.value } }))} placeholder="选填" /></label>
        </div>

        <section className="mt-5 border-t border-[#eaecf0] pt-5" data-testid="white-label-wechat-qr-settings">
          <div><h4 className="text-sm font-black text-[#172033]">微信二维码</h4><p className="mt-1 text-xs leading-5 text-[#667085]">二维码使用白标专用资产库，与默认平台品牌隔离。上传后还要保存草稿并发布品牌版本，访客才会看到。</p></div>
          <div className="mt-3 grid gap-3 md:grid-cols-2">
            {renderQrCard("contact_wechat_qr_primary", "微信二维码 1")}
            {renderQrCard("contact_wechat_qr_secondary", "微信二维码 2")}
          </div>
        </section>

        {activeProfile && <div className="mt-5 rounded-2xl border border-[#b7e4d8] bg-[#f2fbf8] p-4" data-testid="white-label-domain-instructions">
          <div className="flex flex-wrap items-start justify-between gap-3"><div><p className="text-sm font-black text-[#0b5d50]">域名接入步骤</p><p className="mt-1 text-xs leading-5 text-[#4b6b64]">先在域名服务商添加 TXT 记录。验证通过后，再配置 CNAME；TLS 与 HTTPS 由网关接入后签发。</p></div><button type="button" disabled={Boolean(working) || dirty} onClick={() => void write("verify-domain")} className="inline-flex h-9 items-center gap-2 rounded-xl border border-[#087f6d] bg-white px-3 text-xs font-black text-[#087f6d] disabled:opacity-40">{working === "verify" ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}验证 TXT</button></div>
          <div className="mt-4 grid gap-3 lg:grid-cols-2">{[
            { label: "TXT 主机记录", value: activeProfile.expectedTxtName },
            { label: "TXT 记录值", value: `zimeiti-verification=${activeProfile.expectedTxtValue}` },
            { label: "CNAME 目标", value: cnameTarget || "网关目标尚未配置" },
          ].map((item) => <div key={item.label} className="rounded-xl border border-[#d5ebe5] bg-white p-3"><p className="text-[11px] font-bold text-[#667085]">{item.label}</p><div className="mt-1 flex items-start gap-2"><code className="min-w-0 flex-1 break-all text-xs font-bold text-[#172033]">{item.value}</code>{!item.value.includes("尚未配置") && <button type="button" onClick={() => void copy(item.label, item.value)} className="grid h-7 w-7 shrink-0 place-items-center rounded-lg border border-[#d0d5dd] text-[#087f6d]" aria-label={`复制${item.label}`}>{copied === item.label ? <Check className="h-3.5 w-3.5" /> : <Clipboard className="h-3.5 w-3.5" />}</button>}</div></div>)}</div>
          <div className="mt-4 grid gap-2 sm:grid-cols-4">{[{ label: "归属", value: activeProfile.ownershipStatus }, { label: "路由", value: activeProfile.routingStatus }, { label: "证书", value: activeProfile.tlsStatus }, { label: "HTTPS", value: activeProfile.httpsStatus }].map((item) => <div key={item.label} className="rounded-xl bg-white p-3"><p className="text-[10px] font-bold text-[#667085]">{item.label}</p><p className="mt-1 text-xs font-black text-[#172033]">{statusLabel(item.value)}</p></div>)}</div>
          <div className="mt-4 border-t border-[#b7e4d8] pt-4" data-testid="white-label-publish-chain">
            <div className="grid gap-2 lg:grid-cols-4">
              {[
                { step: "1", title: "保存草稿", detail: dirty ? "有修改待保存" : "服务器已读回" },
                { step: "2", title: "验证 TXT", detail: activeProfile.ownershipStatus === "verified" ? "域名归属已验证" : "等待域名验证" },
                { step: "3", title: "发布品牌版本", detail: activeProfile.publishedReleaseId ? `已发布第 ${activeProfile.brandGeneration || 1} 代` : "尚未发布" },
                { step: "4", title: "外网接入", detail: activeProfile.httpsStatus === "verified" ? "HTTPS 已验证" : "仍需 CNAME / 网关 / TLS" },
              ].map((item) => <div key={item.step} className="rounded-xl border border-[#d5ebe5] bg-white p-3"><span className="text-[10px] font-black text-[#087f6d]">步骤 {item.step}</span><p className="mt-1 text-xs font-black text-[#172033]">{item.title}</p><p className="mt-1 text-[10px] leading-4 text-[#667085]">{item.detail}</p></div>)}
            </div>
            <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
              <p className="max-w-2xl text-xs leading-5 text-[#4b6b64]">“发布品牌版本”只冻结并公开当前白标资料；只有该域名的 CNAME、网关、TLS 与 HTTPS 全部验证后，才能称为正式上线。</p>
              <button type="button" data-testid="white-label-publish" disabled={Boolean(working) || dirty || activeProfile.ownershipStatus !== "verified"} onClick={() => void write("publish")} className="inline-flex h-10 items-center gap-2 rounded-xl bg-[#175cd3] px-4 text-sm font-black text-white disabled:cursor-not-allowed disabled:opacity-40">{working === "publish" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Rocket className="h-4 w-4" />}{working === "publish" ? "正在发布并读回…" : "发布品牌版本"}</button>
            </div>
          </div>
        </div>}
      </div>
    </div>

    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
      <article className="rounded-2xl border border-[#d0d5dd] bg-white p-4"><Globe2 className="h-5 w-5 text-[#087f6d]" /><p className="mt-4 text-xs font-bold text-[#667085]">已保存域名</p><p className="mt-1 text-2xl font-black text-[#172033]">{whiteLabel.profiles.length}</p><p className="mt-1 text-xs text-[#667085]">草稿不等于上线</p></article>
      <article className="rounded-2xl border border-[#d0d5dd] bg-white p-4"><ServerCog className="h-5 w-5 text-[#175cd3]" /><p className="mt-4 text-xs font-bold text-[#667085]">运行时连接</p><p className="mt-1 text-2xl font-black text-[#172033]">{connectedRuntimeChecks}/7</p><p className="mt-1 text-xs text-[#667085]">DNS、证书、网关、Host 与品牌绑定</p></article>
      <article className="rounded-2xl border border-[#d0d5dd] bg-white p-4"><ShieldAlert className="h-5 w-5 text-amber-600" /><p className="mt-4 text-xs font-bold text-[#667085]">租户隔离</p><p className="mt-1 text-2xl font-black text-[#172033]">{statusLabel(boundary?.boundaryState)}</p><p className="mt-1 text-xs text-[#667085]">{resourceCoverage ? `${resourceCoverage.integrated || 0}/${resourceCoverage.expected || 0} 资源闭环` : "尚无覆盖证据"}</p></article>
      <article className="rounded-2xl border border-[#d0d5dd] bg-white p-4"><CheckCircle2 className="h-5 w-5 text-violet-600" /><p className="mt-4 text-xs font-bold text-[#667085]">域名归属已验证</p><p className="mt-1 text-2xl font-black text-[#172033]">{whiteLabel.profiles.filter((item) => item.ownershipStatus === "verified").length}</p><p className="mt-1 text-xs text-[#667085]">状态采集于 {dateTime(domain?.database?.asOf || whiteLabel.asOf)}</p></article>
    </div>

    <details className="rounded-2xl border border-[#d0d5dd] bg-white p-5"><summary className="cursor-pointer font-black text-[#172033]">技术准备度与待接入项（{pendingSources.length + issues.length}）</summary><div className="mt-4 grid gap-5 xl:grid-cols-2"><section><h3 className="text-sm font-black text-[#344054]">运行链路 · {pendingSources.length}</h3><div className="mt-3 space-y-2">{pendingSources.slice(0, 8).map((source, index) => <div key={`${source.source}-${index}`} className="rounded-xl border border-[#eaecf0] bg-[#f9fafb] p-3"><div className="flex items-center justify-between gap-3"><p className="text-xs font-black text-[#344054]">{source.source || "未命名来源"}</p><span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-bold text-amber-800">{statusLabel(source.state)}</span></div>{source.fact && <p className="mt-1 text-xs leading-5 text-[#667085]">{source.fact}</p>}</div>)}</div></section><section><h3 className="text-sm font-black text-[#344054]">租户边界 · {issues.length}</h3><div className="mt-3 space-y-2">{issues.slice(0, 8).map((issue, index) => <div key={`${issue.code}-${index}`} className="rounded-xl border border-[#eaecf0] p-3"><p className="text-xs font-black text-[#344054]">{issue.code || "BOUNDARY_STATUS"}</p>{issue.message && <p className="mt-1 text-xs leading-5 text-[#667085]">{issue.message}</p>}</div>)}</div></section></div></details>
  </section>;
}
