"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CheckCircle2, History, ImageUp, Loader2, RefreshCw, RotateCcw, Save } from "lucide-react";

import {
  PLATFORM_BRAND_ASSET_PURPOSES,
  PLATFORM_BRAND_SCHEMA,
  type PlatformBrandAssetPurpose,
  type PlatformBrandPayload,
  type PublicPlatformBranding,
} from "@/lib/branding/contracts";
import { DEFAULT_PLATFORM_LOGO_URL, refreshPublishedPlatformBranding } from "@/hooks/use-platform-branding";

interface BrandRevision {
  id: string;
  revisionVersion: number;
  status: "draft" | "published";
  brand: PlatformBrandPayload;
  publishedAt: string | null;
  createdAt: string;
}

interface BrandAsset {
  id: string;
  purpose: PlatformBrandAssetPurpose;
  mimeType: string;
  bytes: number;
  width: number;
  height: number;
  createdAt: string;
  published: boolean;
  url: string | null;
}

interface BrandAdminState {
  migrationRequired: boolean;
  generation: number;
  draft: BrandRevision | null;
  published: BrandRevision | null;
  revisions: BrandRevision[];
  assets: BrandAsset[];
  publicBranding: PublicPlatformBranding;
}

interface LocalAssetPreview {
  assetId: string;
  url: string;
}

const PURPOSE_LABELS: Record<PlatformBrandAssetPurpose, { title: string; hint: string }> = {
  logo_square: { title: "主 Logo", hint: "建议 1:1，用于登录页、侧栏与头像式展示" },
  logo_horizontal_light: { title: "浅色背景横版 Logo", hint: "建议透明底，用于页眉和品牌落款" },
  logo_horizontal_dark: { title: "深色背景横版 Logo", hint: "用于深色主题和深色物料" },
  favicon: { title: "浏览器图标", hint: "建议 192×192 或更高的正方形图" },
  social_share: { title: "分享封面", hint: "建议 1200×630，用于链接分享预览" },
  login_background: { title: "登录背景", hint: "建议 16:9；不上传则继续使用主题背景" },
  contact_wechat_qr_primary: { title: "微信二维码 1", hint: "建议上传清晰的正方形二维码，发布后显示在首页联系我们区域" },
  contact_wechat_qr_secondary: { title: "微信二维码 2", hint: "选填，可用于第二位联系人或备用微信" },
};

const ADVANCED_ASSET_PURPOSES: readonly PlatformBrandAssetPurpose[] = [
  "logo_horizontal_light",
  "logo_horizontal_dark",
  "favicon",
  "social_share",
  "login_background",
];

const DEFAULT_PLATFORM_BRAND: PlatformBrandPayload = {
  schema: PLATFORM_BRAND_SCHEMA,
  name: "自媒体操盘手",
  shortName: "操盘手",
  slogan: "AI 内容经营系统",
  welcomeMessage: "欢迎回到自媒体操盘手",
  description: "把洞察、创作、生产和经营数据沉淀为可持续复用的内容资产。",
  seo: {
    title: "自媒体操盘手",
    description: "面向创作者与内容团队的 AI 内容经营系统。",
  },
  colors: {
    primary: "#168D7A",
    accent: "#2F80FF",
  },
  contact: {
    name: "",
    wechat: "",
    phone: "",
    email: "",
  },
  assetIds: {},
};

function cloneBrand(value: PlatformBrandPayload): PlatformBrandPayload {
  return JSON.parse(JSON.stringify(value)) as PlatformBrandPayload;
}

function completeInitialBrand(value: PlatformBrandPayload): PlatformBrandPayload {
  const defaults = cloneBrand(DEFAULT_PLATFORM_BRAND);
  const choose = (current: string, fallback: string) => current.trim() || fallback;
  return {
    ...defaults,
    ...value,
    name: choose(value.name, defaults.name),
    shortName: choose(value.shortName, defaults.shortName),
    slogan: choose(value.slogan, defaults.slogan),
    welcomeMessage: choose(value.welcomeMessage, defaults.welcomeMessage),
    description: choose(value.description, defaults.description),
    seo: {
      title: choose(value.seo.title, value.name.trim() || defaults.seo.title),
      description: choose(value.seo.description, defaults.seo.description),
    },
    colors: {
      primary: value.colors.primary || defaults.colors.primary,
      accent: value.colors.accent || defaults.colors.accent,
    },
    contact: {
      name: value.contact?.name || defaults.contact.name,
      wechat: value.contact?.wechat || defaults.contact.wechat,
      phone: value.contact?.phone || "",
      email: value.contact?.email || "",
    },
    assetIds: { ...value.assetIds },
  };
}

function formatDate(value: string | null): string {
  if (!value) return "未发布";
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(date)
    : value;
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function isHexColor(value: string): boolean {
  return /^#[0-9A-F]{6}$/iu.test(value);
}

export function PlatformBrandSettingsPanel({
  token,
  onRequestUnlock,
}: {
  token: string | null;
  onRequestUnlock: () => void;
}) {
  const [state, setState] = useState<BrandAdminState | null>(null);
  const [brand, setBrand] = useState<PlatformBrandPayload>(cloneBrand(DEFAULT_PLATFORM_BRAND));
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [localPreviews, setLocalPreviews] = useState<Partial<Record<PlatformBrandAssetPurpose, LocalAssetPreview>>>({});
  const localPreviewsRef = useRef<Partial<Record<PlatformBrandAssetPurpose, LocalAssetPreview>>>({});
  const objectPreviewUrls = useRef<Set<string>>(new Set());

  const clearLocalPreviews = () => {
    objectPreviewUrls.current.forEach((url) => URL.revokeObjectURL(url));
    objectPreviewUrls.current.clear();
    setLocalPreviews({});
  };

  const headers = useMemo(() => ({ Authorization: `Bearer ${token || ""}` }), [token]);

  const load = useCallback(async (): Promise<BrandAdminState | null> => {
    if (!token) {
      setError("缺少管理员登录凭据，无法读取品牌中心。");
      setLoading(false);
      return null;
    }
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/admin/branding", { headers, cache: "no-store" });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(String(body.error || "品牌中心读取失败"));
      const next = body.state as BrandAdminState;
      setState(next);
      const storedBrand = next.draft?.brand || next.published?.brand || next.publicBranding.brand || DEFAULT_PLATFORM_BRAND;
      // 首次启用品牌中心时补齐旧配置缺失的文案，避免管理员面对一片空表单。
      // 一旦已有草稿或发布版本，空值视为管理员的明确选择，不再擅自覆盖。
      setBrand(cloneBrand(!next.draft && !next.published ? completeInitialBrand(storedBrand) : storedBrand));
      return next;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "品牌中心读取失败");
      return null;
    } finally {
      setLoading(false);
    }
  }, [headers, token]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => () => {
    objectPreviewUrls.current.forEach((url) => URL.revokeObjectURL(url));
    objectPreviewUrls.current.clear();
  }, []);

  useEffect(() => {
    localPreviewsRef.current = localPreviews;
  }, [localPreviews]);

  useEffect(() => {
    if (!state || !token) return;
    const controller = new AbortController();
    const previewsToHydrate = PLATFORM_BRAND_ASSET_PURPOSES.flatMap((purpose) => {
      const assetId = brand.assetIds[purpose];
      if (!assetId) return [];
      const local = localPreviewsRef.current[purpose];
      if (local?.assetId === assetId) return [];
      const selected = state.assets.find((asset) => asset.id === assetId && asset.purpose === purpose);
      return selected && !selected.url ? [{ purpose, assetId }] : [];
    });
    if (!previewsToHydrate.length) return;

    void Promise.all(previewsToHydrate.map(async ({ purpose, assetId }) => {
      const response = await fetch(`/api/admin/branding/assets/${assetId}`, {
        headers,
        cache: "no-store",
        signal: controller.signal,
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as Record<string, unknown>;
        throw new Error(String(body.error || "草稿图片预览读取失败"));
      }
      const blob = await response.blob();
      if (!blob.type.startsWith("image/")) throw new Error("草稿图片预览格式无效");
      const previewUrl = URL.createObjectURL(blob);
      if (controller.signal.aborted) {
        URL.revokeObjectURL(previewUrl);
        return;
      }
      objectPreviewUrls.current.add(previewUrl);
      setLocalPreviews((current) => {
        const previous = current[purpose];
        if (previous?.url && previous.url !== previewUrl) {
          URL.revokeObjectURL(previous.url);
          objectPreviewUrls.current.delete(previous.url);
        }
        return { ...current, [purpose]: { assetId, url: previewUrl } };
      });
    })).catch((caught) => {
      if (!controller.signal.aborted) {
        setError(caught instanceof Error ? caught.message : "草稿图片预览读取失败");
      }
    });

    return () => controller.abort();
  }, [brand.assetIds, headers, state, token]);

  const baseline = state?.draft?.brand || state?.published?.brand || state?.publicBranding.brand;
  const dirty = Boolean(baseline && JSON.stringify(brand) !== JSON.stringify(baseline));
  const validationIssue = !brand.name.trim()
    ? "平台名称不能为空"
    : !isHexColor(brand.colors.primary) || !isHexColor(brand.colors.accent)
      ? "品牌颜色需填写 #RRGGBB 格式"
      : "";

  useEffect(() => {
    if (!dirty) return;
    const warnBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warnBeforeUnload);
    return () => window.removeEventListener("beforeunload", warnBeforeUnload);
  }, [dirty]);

  const patchBrand = (patch: Partial<PlatformBrandPayload>) => {
    setBrand((current) => ({ ...current, ...patch }));
    setNotice("");
  };

  const patchNested = <K extends "seo" | "colors" | "contact">(
    key: K,
    patch: Partial<PlatformBrandPayload[K]>,
  ) => {
    setBrand((current) => ({ ...current, [key]: { ...current[key], ...patch } }));
    setNotice("");
  };

  const restoreSavedBrand = () => {
    const saved = state?.draft?.brand || state?.published?.brand || state?.publicBranding.brand;
    if (!saved) return;
    setBrand(cloneBrand(saved));
    clearLocalPreviews();
    setError("");
    setNotice("已撤销本次未保存修改。");
  };

  const handleStepUp = (response: Response, body: Record<string, unknown>): boolean => {
    if (response.status === 428 || body.code === "ADMIN_STEP_UP_REQUIRED") {
      setError("发布、上传和回滚需要先完成敏感操作验证。");
      onRequestUnlock();
      return true;
    }
    return false;
  };

  const write = async (action: "save-draft" | "publish" | "rollback", revisionId?: string) => {
    if (!state || !token) return;
    setWorking(action);
    setError("");
    setNotice("");
    try {
      const response = await fetch("/api/admin/branding", {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({
          action,
          expectedGeneration: state.generation,
          ...(action === "save-draft" ? { brand } : { revisionId }),
        }),
      });
      const body = await response.json().catch(() => ({})) as Record<string, unknown>;
      if (handleStepUp(response, body)) return;
      if (!response.ok) throw new Error(String(body.error || "品牌配置操作失败"));
      if (action === "publish" || action === "rollback") {
        clearLocalPreviews();
        refreshPublishedPlatformBranding();
      }
      const reloaded = await load();
      if (!reloaded) {
        setError("操作已返回成功，但服务器权威状态读回失败；请勿重复提交，先刷新核对。");
      } else {
        setNotice(action === "save-draft"
          ? `品牌草稿已保存并完成服务器读回（配置代次 ${reloaded.generation}）；刷新页面不会丢失。`
          : action === "publish"
            ? `品牌版本已发布并完成服务器读回（配置代次 ${reloaded.generation}）。`
            : `已从历史版本生成回滚版本并完成服务器读回（配置代次 ${reloaded.generation}）。`);
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "品牌配置操作失败");
    } finally {
      setWorking("");
    }
  };

  const uploadFile = async (purpose: PlatformBrandAssetPurpose, file: File): Promise<BrandAsset | null> => {
    if (!state || !token) return null;
    const form = new FormData();
    form.set("purpose", purpose);
    form.set("file", file);
    const response = await fetch("/api/admin/branding/assets", {
      method: "POST",
      headers: { ...headers, "Idempotency-Key": crypto.randomUUID() },
      body: form,
    });
    const body = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (handleStepUp(response, body)) return null;
    if (!response.ok) throw new Error(String(body.error || "品牌图片上传失败"));
    const asset = body.asset as BrandAsset | undefined;
    if (!asset?.id || asset.purpose !== purpose) throw new Error("品牌图片上传回执缺少有效资产编号");
    setState((current) => current ? {
      ...current,
      assets: [asset, ...current.assets.filter((item) => item.id !== asset.id)],
    } : current);
    return asset;
  };

  const onFile = async (purpose: PlatformBrandAssetPurpose, file: File | null) => {
    if (!file) return;
    setWorking(`upload:${purpose}`);
    setError("");
    setNotice("");
    try {
      const asset = await uploadFile(purpose, file);
      if (!asset) return;
      const previewUrl = URL.createObjectURL(file);
      objectPreviewUrls.current.add(previewUrl);
      setLocalPreviews((current) => ({ ...current, [purpose]: { assetId: asset.id, url: previewUrl } }));
      setBrand((current) => ({
        ...current,
        assetIds: { ...current.assetIds, [purpose]: asset.id },
      }));
      setNotice(`${PURPOSE_LABELS[purpose].title}已上传到平台存储；保存草稿后才会进入待发布版本。`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "品牌图片上传失败");
    } finally {
      setWorking("");
    }
  };

  if (loading && !state) {
    return <div className="rounded-2xl border border-[var(--border)] bg-[var(--card)] p-8 text-center text-sm text-[var(--muted-foreground)]"><Loader2 className="mx-auto mb-2 animate-spin" size={20} />正在读取品牌中心…</div>;
  }

  if (!state) {
    return (
      <section className="rounded-2xl border border-amber-300/70 bg-amber-50/80 p-5" data-testid="brand-center-unavailable">
        <h3 className="font-bold text-amber-900">品牌中心尚未就绪</h3>
        <p className="mt-2 text-sm leading-6 text-amber-800">{error || "数据库迁移尚未应用。旧的 URL 字段不会作为新品牌配置继续使用。"}</p>
        <button type="button" onClick={() => void load()} className="mt-3 rounded-lg border border-amber-400 px-3 py-2 text-xs font-bold text-amber-900">重新读取</button>
      </section>
    );
  }

  const publicAssets = state.publicBranding.assets;
  const writesDisabled = state.migrationRequired;
  const assetPreview = (purpose: PlatformBrandAssetPurpose): string => {
    const selectedId = brand.assetIds[purpose];
    if (!selectedId) return "";
    const local = localPreviews[purpose];
    if (local?.assetId === selectedId) return local.url;
    const selected = state.assets.find((asset) => asset.id === selectedId && asset.purpose === purpose);
    if (selected?.url) return selected.url;
    const published = publicAssets[purpose];
    return published?.id === selectedId ? published.url : "";
  };
  const currentSquarePreview = assetPreview("logo_square") || DEFAULT_PLATFORM_LOGO_URL;
  const previewForPurpose = (purpose: PlatformBrandAssetPurpose): string => {
    const explicit = assetPreview(purpose);
    if (explicit) return explicit;
    return purpose === "login_background" || purpose.startsWith("contact_wechat_qr_") ? "" : currentSquarePreview;
  };
  const previewPrimary = isHexColor(brand.colors.primary) ? brand.colors.primary : "#168D7A";
  const previewAccent = isHexColor(brand.colors.accent) ? brand.colors.accent : "#2F80FF";
  const hasSavedBrand = Boolean(state.draft || state.published);
  const actionStatus = writesDisabled
    ? "品牌数据库尚未就绪"
    : dirty
      ? "有未保存修改"
      : state.draft
        ? "草稿已保存，等待发布"
        : state.published
          ? "当前版本已全站发布"
          : "默认资料待首次保存";
  const actionBar = () => (
    <div
      data-testid="brand-actions-sticky"
      className="sticky top-3 z-20 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-[var(--border)] bg-[color-mix(in_srgb,var(--card)_94%,transparent)] p-3 shadow-lg backdrop-blur-xl"
    >
      <div className="min-w-0">
        <p className="text-xs font-black text-[var(--foreground)]">{actionStatus}</p>
        <p className="mt-1 text-[11px] leading-4 text-[var(--muted-foreground)]">
          保存后刷新页面仍会保留；发布后才同步到首页、登录页、工作台、后台标题与分享信息。
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          data-testid="brand-refresh-authoritative"
          title={dirty ? "请先保存或撤销当前修改" : "重新读取服务器权威品牌版本"}
          disabled={Boolean(working) || loading || dirty}
          onClick={() => void load().then((next) => {
            if (next) setNotice(`已刷新并读回服务器品牌状态（配置代次 ${next.generation}）。`);
          })}
          className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--border)] px-3 py-2 text-xs font-bold text-[var(--muted-foreground)] disabled:cursor-not-allowed disabled:opacity-40"
        >
          <RefreshCw size={14} className={loading ? "animate-spin" : ""} />刷新回读
        </button>
        {dirty && hasSavedBrand && (
          <button type="button" disabled={Boolean(working)} onClick={restoreSavedBrand} className="rounded-lg border border-[var(--border)] px-3 py-2 text-xs font-bold text-[var(--muted-foreground)] disabled:opacity-40">
            撤销修改
          </button>
        )}
        <button
          type="button"
          data-testid="brand-save-draft"
          disabled={Boolean(working) || writesDisabled || Boolean(validationIssue) || !dirty}
          onClick={() => void write("save-draft")}
          className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--primary)] bg-[var(--card)] px-4 py-2 text-xs font-black text-[var(--primary)] shadow-sm disabled:cursor-not-allowed disabled:opacity-40"
        >
          {working === "save-draft" ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
          {working === "save-draft" ? "正在保存…" : "保存草稿"}
        </button>
        <button
          type="button"
          data-testid="brand-publish-draft"
          disabled={Boolean(working) || writesDisabled || !state.draft || dirty}
          onClick={() => void write("publish", state.draft?.id)}
          className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--primary)] px-4 py-2 text-xs font-black text-white shadow-sm disabled:cursor-not-allowed disabled:opacity-40"
        >
          {working === "publish" ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle2 size={14} />}
          {working === "publish" ? "正在发布…" : "发布到全站"}
        </button>
      </div>
    </div>
  );

  const renderAssetCard = (purpose: PlatformBrandAssetPurpose) => {
    const selectedId = brand.assetIds[purpose] || "";
    const matchingAssets = state.assets.filter((asset) => asset.purpose === purpose);
    const selected = matchingAssets.find((asset) => asset.id === selectedId);
    const preview = previewForPurpose(purpose);
    const automaticLabel = purpose === "logo_square"
      ? "使用平台内置 Logo"
      : purpose === "login_background"
        ? "使用主题背景"
        : purpose.startsWith("contact_wechat_qr_")
          ? "暂不展示这张二维码"
        : "使用主 Logo 自动适配";
    return (
      <article key={purpose} data-testid={`brand-asset-${purpose}`} className="rounded-xl border border-[var(--border)] bg-[var(--background)] p-3">
        <div className="flex items-start gap-3">
          <div className={`grid h-14 w-14 shrink-0 place-items-center overflow-hidden rounded-lg border border-[var(--border)] bg-white ${purpose === "logo_square" || purpose === "favicon" ? "p-0" : "p-1.5"}`}>
            {preview
              ? <img src={preview} alt={`${PURPOSE_LABELS[purpose].title}预览`} className={purpose === "logo_square" || purpose === "favicon" ? "h-full w-full scale-[1.025] object-cover" : "h-full w-full object-contain"} />
              : <ImageUp size={20} className="text-slate-400" />}
          </div>
          <div className="min-w-0"><h4 className="text-xs font-bold text-[var(--foreground)]">{PURPOSE_LABELS[purpose].title}</h4><p className="mt-1 text-[10px] leading-4 text-[var(--muted-foreground)]">{PURPOSE_LABELS[purpose].hint}</p></div>
        </div>
        <select aria-label={`选择${PURPOSE_LABELS[purpose].title}`} value={selectedId} onChange={(event) => { setBrand((current) => ({ ...current, assetIds: { ...current.assetIds, [purpose]: event.target.value || undefined } })); setNotice(""); }} className="mt-3 w-full rounded-lg border border-[var(--border)] bg-[var(--card)] px-2 py-2 text-xs text-[var(--foreground)]">
          <option value="">{automaticLabel}</option>
          {matchingAssets.map((asset) => <option key={asset.id} value={asset.id}>{asset.width}×{asset.height} · {formatBytes(asset.bytes)}{asset.published ? " · 已发布" : " · 草稿资产"}</option>)}
        </select>
        <label className="mt-2 flex cursor-pointer items-center justify-center gap-1.5 rounded-lg border border-dashed border-[var(--primary)]/50 px-3 py-2 text-xs font-bold text-[var(--primary)] hover:bg-[var(--primary)]/5">
          {working === `upload:${purpose}` ? <Loader2 size={14} className="animate-spin" /> : <ImageUp size={14} />}选择本地图片
          <input type="file" className="sr-only" aria-label={`上传${PURPOSE_LABELS[purpose].title}`} accept="image/png,image/jpeg,image/webp" disabled={Boolean(working) || writesDisabled} onChange={(event) => { void onFile(purpose, event.target.files?.[0] || null); event.currentTarget.value = ""; }} />
        </label>
        {selected && <p className="mt-2 truncate text-[10px] text-[var(--muted-foreground)]" title={selected.id}>资产 {selected.id.slice(0, 8)} · {selected.mimeType}</p>}
      </article>
    );
  };

  return (
    <section className="space-y-4" data-testid="platform-brand-settings">
      <div className="rounded-2xl border border-[var(--border)] bg-[var(--card)] p-5 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex min-w-0 items-start gap-4">
            <div className="grid h-16 w-16 shrink-0 place-items-center overflow-hidden rounded-2xl border border-[var(--border)] bg-white shadow-sm">
              <img src={currentSquarePreview} alt="当前平台 Logo" className="h-full w-full scale-[1.025] object-cover" />
            </div>
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-base font-black text-[var(--foreground)]">平台品牌中心</h3>
                <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-bold text-emerald-700">服务器资产 · 版本化发布</span>
              </div>
              <p className="mt-1 max-w-3xl text-xs leading-5 text-[var(--muted-foreground)]">图片直接上传到平台对象存储，并以稳定的站内地址对外提供。名称、文案和图片先保存草稿，再一次发布到登录页、主站与分享入口。</p>
              <p className="mt-2 text-[11px] text-[var(--muted-foreground)]">当前发布：{state.published ? `v${state.published.revisionVersion} · ${formatDate(state.published.publishedAt)}` : "尚无新品牌版本，前台继续读取兼容配置"} · 配置代次 {state.generation}</p>
            </div>
          </div>
          <button type="button" onClick={() => patchBrand({ ...cloneBrand(DEFAULT_PLATFORM_BRAND), assetIds: brand.assetIds })} className="rounded-lg border border-blue-300 bg-blue-50 px-3 py-2 text-xs font-bold text-blue-800">填入平台默认文案</button>
        </div>
      </div>

      {state.migrationRequired && (
        <div role="alert" className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm leading-6 text-amber-900">
          <strong>品牌控制平面尚未启用。</strong> 当前仅展示旧配置的兼容读取结果；数据库迁移就绪前，上传、保存、发布和回滚保持禁用，避免出现“界面显示成功但实际未生效”。
        </div>
      )}
      {error && <div role="alert" className="rounded-xl border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800">{error}</div>}
      {notice && <div role="status" className="rounded-xl border border-emerald-300 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">{notice}</div>}

      {actionBar()}

      <div className="rounded-2xl border border-[var(--border)] bg-[var(--card)] p-5 shadow-sm">
        <div className="mb-4 flex items-center justify-between gap-3">
          <div><h3 className="font-bold text-[var(--foreground)]">品牌信息</h3><p className="mt-1 text-xs text-[var(--muted-foreground)]">显示名称与 SEO 信息共用同一发布版本，避免各页面名称不一致。</p></div>
          {dirty && <span className="rounded-full bg-amber-500/10 px-2 py-1 text-[10px] font-bold text-amber-700">有未保存修改</span>}
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          <label className="text-xs font-semibold text-[var(--foreground)]">平台名称<input value={brand.name} maxLength={80} onChange={(event) => patchBrand({ name: event.target.value })} className="mt-1.5 w-full rounded-xl border border-[var(--border)] bg-[var(--background)] px-3 py-2.5 text-sm outline-none focus:border-[var(--primary)]" /></label>
          <label className="text-xs font-semibold text-[var(--foreground)]">平台简称<input value={brand.shortName} maxLength={40} onChange={(event) => patchBrand({ shortName: event.target.value })} className="mt-1.5 w-full rounded-xl border border-[var(--border)] bg-[var(--background)] px-3 py-2.5 text-sm outline-none focus:border-[var(--primary)]" /></label>
          <label className="text-xs font-semibold text-[var(--foreground)]">品牌标语<input value={brand.slogan} maxLength={120} onChange={(event) => patchBrand({ slogan: event.target.value })} className="mt-1.5 w-full rounded-xl border border-[var(--border)] bg-[var(--background)] px-3 py-2.5 text-sm outline-none focus:border-[var(--primary)]" /></label>
          <label className="text-xs font-semibold text-[var(--foreground)]">欢迎语<input value={brand.welcomeMessage} maxLength={240} onChange={(event) => patchBrand({ welcomeMessage: event.target.value })} className="mt-1.5 w-full rounded-xl border border-[var(--border)] bg-[var(--background)] px-3 py-2.5 text-sm outline-none focus:border-[var(--primary)]" /></label>
          <label className="text-xs font-semibold text-[var(--foreground)] md:col-span-2">品牌说明<textarea value={brand.description} maxLength={500} rows={3} onChange={(event) => patchBrand({ description: event.target.value })} className="mt-1.5 w-full resize-y rounded-xl border border-[var(--border)] bg-[var(--background)] px-3 py-2.5 text-sm outline-none focus:border-[var(--primary)]" /></label>
          <label className="text-xs font-semibold text-[var(--foreground)]">SEO 标题<input value={brand.seo.title} maxLength={70} onChange={(event) => patchNested("seo", { title: event.target.value })} className="mt-1.5 w-full rounded-xl border border-[var(--border)] bg-[var(--background)] px-3 py-2.5 text-sm outline-none focus:border-[var(--primary)]" /></label>
          <label className="text-xs font-semibold text-[var(--foreground)]">SEO 描述<input value={brand.seo.description} maxLength={180} onChange={(event) => patchNested("seo", { description: event.target.value })} className="mt-1.5 w-full rounded-xl border border-[var(--border)] bg-[var(--background)] px-3 py-2.5 text-sm outline-none focus:border-[var(--primary)]" /></label>
          <label className="text-xs font-semibold text-[var(--foreground)]">品牌主色<span className="mt-1.5 flex items-center gap-2"><input aria-label="选择品牌主色" type="color" value={isHexColor(brand.colors.primary) ? brand.colors.primary : "#168D7A"} onChange={(event) => patchNested("colors", { primary: event.target.value.toUpperCase() })} className="h-10 w-12 rounded-lg border border-[var(--border)] bg-transparent p-1" /><input aria-label="品牌主色十六进制值" value={brand.colors.primary} maxLength={7} onChange={(event) => patchNested("colors", { primary: event.target.value.toUpperCase() })} className="w-full rounded-xl border border-[var(--border)] bg-[var(--background)] px-3 py-2.5 font-mono text-sm" /></span></label>
          <label className="text-xs font-semibold text-[var(--foreground)]">品牌强调色<span className="mt-1.5 flex items-center gap-2"><input aria-label="选择品牌强调色" type="color" value={isHexColor(brand.colors.accent) ? brand.colors.accent : "#2F80FF"} onChange={(event) => patchNested("colors", { accent: event.target.value.toUpperCase() })} className="h-10 w-12 rounded-lg border border-[var(--border)] bg-transparent p-1" /><input aria-label="品牌强调色十六进制值" value={brand.colors.accent} maxLength={7} onChange={(event) => patchNested("colors", { accent: event.target.value.toUpperCase() })} className="w-full rounded-xl border border-[var(--border)] bg-[var(--background)] px-3 py-2.5 font-mono text-sm" /></span></label>
        </div>
        {validationIssue && <p role="alert" className="mt-3 text-xs font-semibold text-red-700">{validationIssue}</p>}
      </div>

      <div className="rounded-2xl border border-[var(--border)] bg-[var(--card)] p-5 shadow-sm" data-testid="platform-brand-contact-settings">
        <div className="mb-4">
          <h3 className="font-bold text-[var(--foreground)]">对外联系信息</h3>
          <p className="mt-1 text-xs leading-5 text-[var(--muted-foreground)]">单独维护平台对外联系人。保存草稿后刷新仍保留，发布后才显示到首页和工具页页脚；留空的项目不会展示。</p>
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          <label className="text-xs font-semibold text-[var(--foreground)]">联系人或客服名称<input value={brand.contact.name} maxLength={80} onChange={(event) => patchNested("contact", { name: event.target.value })} className="mt-1.5 w-full rounded-xl border border-[var(--border)] bg-[var(--background)] px-3 py-2.5 text-sm outline-none focus:border-[var(--primary)]" placeholder="例如：平台客服" /></label>
          <label className="text-xs font-semibold text-[var(--foreground)]">微信号<input value={brand.contact.wechat} maxLength={80} onChange={(event) => patchNested("contact", { wechat: event.target.value })} className="mt-1.5 w-full rounded-xl border border-[var(--border)] bg-[var(--background)] px-3 py-2.5 text-sm outline-none focus:border-[var(--primary)]" placeholder="填写已确认的微信号" /></label>
          <label className="text-xs font-semibold text-[var(--foreground)]">联系电话<input value={brand.contact.phone} maxLength={40} onChange={(event) => patchNested("contact", { phone: event.target.value })} className="mt-1.5 w-full rounded-xl border border-[var(--border)] bg-[var(--background)] px-3 py-2.5 text-sm outline-none focus:border-[var(--primary)]" placeholder="选填" /></label>
          <label className="text-xs font-semibold text-[var(--foreground)]">联系邮箱<input value={brand.contact.email} maxLength={254} onChange={(event) => patchNested("contact", { email: event.target.value })} className="mt-1.5 w-full rounded-xl border border-[var(--border)] bg-[var(--background)] px-3 py-2.5 text-sm outline-none focus:border-[var(--primary)]" placeholder="选填" /></label>
        </div>
        <div className="mt-5 border-t border-[var(--border)] pt-5">
          <div className="mb-3"><h4 className="text-xs font-black text-[var(--foreground)]">微信二维码</h4><p className="mt-1 text-[11px] leading-5 text-[var(--muted-foreground)]">可上传一张或两张。图片上传后仍需点击“保存草稿”，再点击“发布到全站”才会对访客生效。</p></div>
          <div className="grid gap-3 md:grid-cols-2">
            {renderAssetCard("contact_wechat_qr_primary")}
            {renderAssetCard("contact_wechat_qr_secondary")}
          </div>
        </div>
      </div>

      <div className="overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--card)] shadow-sm" aria-labelledby="brand-preview-title">
        <div className="flex items-center justify-between gap-3 border-b border-[var(--border)] px-5 py-3">
          <div><h3 id="brand-preview-title" className="font-bold text-[var(--foreground)]">发布前预览</h3><p className="mt-1 text-xs text-[var(--muted-foreground)]">预览当前编辑内容；它不会写入前台，直到草稿保存并完成发布。</p></div>
          <span className={`rounded-full px-2 py-1 text-[10px] font-bold ${dirty ? "bg-amber-500/10 text-amber-700" : "bg-emerald-500/10 text-emerald-700"}`}>{dirty ? "本地未保存" : state.draft ? "草稿已保存" : "当前兼容版本"}</span>
        </div>
        <div className="p-5">
          <div data-testid="brand-live-preview" className="relative overflow-hidden rounded-2xl border border-white/70 p-5 text-white shadow-lg" style={{ background: `linear-gradient(120deg, ${previewPrimary}, ${previewAccent})` }}>
            <div className="absolute -right-10 -top-12 h-36 w-36 rounded-full bg-white/15 blur-2xl" aria-hidden="true" />
            <div className="relative flex items-center gap-4">
              <span className="grid h-14 w-14 shrink-0 place-items-center overflow-hidden rounded-2xl bg-white shadow-sm"><img src={currentSquarePreview} alt="" className="h-full w-full scale-[1.025] object-cover" /></span>
              <div className="min-w-0"><p className="truncate text-xl font-black">{brand.name || "未命名平台"}</p><p className="mt-1 text-sm text-white/85">{brand.slogan || "尚未填写品牌标语"}</p></div>
            </div>
            <p className="relative mt-4 max-w-3xl text-xs leading-5 text-white/80">{brand.welcomeMessage || brand.description || "发布后，用户将在登录页和主站看到这里的品牌信息。"}</p>
          </div>
        </div>
      </div>

      <div className="rounded-2xl border border-[var(--border)] bg-[var(--card)] p-5 shadow-sm">
        <div className="mb-4"><h3 className="font-bold text-[var(--foreground)]">主 Logo</h3><p className="mt-1 text-xs text-[var(--muted-foreground)]">全站默认只需维护这一张 Logo。上传后先保存草稿；刷新后台仍可预览，发布后才对访客可见。</p></div>
        <div className="max-w-xl">{renderAssetCard("logo_square")}</div>

        <details className="mt-4 rounded-xl border border-[var(--border)] bg-[var(--background)]/45 p-3" data-testid="brand-advanced-assets">
          <summary className="cursor-pointer text-xs font-bold text-[var(--foreground)]">高级品牌适配（可选）</summary>
          <p className="mt-2 text-[11px] leading-5 text-[var(--muted-foreground)]">未单独配置时，横版标识、浏览器图标和分享入口会自动使用主 Logo；登录背景继续使用当前主题背景。</p>
          <div className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {ADVANCED_ASSET_PURPOSES.map(renderAssetCard)}
          </div>
        </details>

        <p className="mt-4 text-xs leading-5 text-[var(--muted-foreground)]"><strong className="text-[var(--foreground)]">发布流程：</strong>上传图片 → 保存草稿 → 检查版本 → 发布。页面顶部保留唯一操作栏，发布和回滚均写入管理员审计。</p>
      </div>

      {state.revisions.some((revision) => revision.status === "published" && revision.id !== state.published?.id) && (
        <details className="rounded-2xl border border-[var(--border)] bg-[var(--card)] p-4 shadow-sm">
          <summary className="flex cursor-pointer list-none items-center gap-2 text-sm font-bold text-[var(--foreground)]"><History size={16} />历史版本与回滚</summary>
          <div className="mt-3 space-y-2">
            {state.revisions.filter((revision) => revision.status === "published" && revision.id !== state.published?.id).map((revision) => (
              <div key={revision.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[var(--border)] bg-[var(--background)] px-3 py-2">
                <div><p className="text-xs font-bold text-[var(--foreground)]">v{revision.revisionVersion} · {revision.brand.name}</p><p className="mt-0.5 text-[10px] text-[var(--muted-foreground)]">发布于 {formatDate(revision.publishedAt)}</p></div>
                <button type="button" disabled={Boolean(working) || writesDisabled} onClick={() => void write("rollback", revision.id)} className="inline-flex items-center gap-1.5 rounded-lg border border-amber-300 bg-amber-50 px-3 py-1.5 text-xs font-bold text-amber-800 disabled:opacity-40"><RotateCcw size={13} />回滚到此版本</button>
              </div>
            ))}
          </div>
        </details>
      )}
    </section>
  );
}
