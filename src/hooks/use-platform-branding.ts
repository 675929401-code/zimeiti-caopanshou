"use client";

import {
  createContext,
  createElement,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type SyntheticEvent,
} from "react";

import type {
  PlatformBrandAssetPurpose,
  PublicPlatformBranding,
} from "@/lib/branding/contracts";

export const FALLBACK_PLATFORM_BRANDING: PublicPlatformBranding = {
  displayScope: "platform",
  hostname: "localhost",
  source: "legacy",
  generation: 0,
  revisionId: null,
  revisionVersion: null,
  publishedAt: null,
  brand: {
    schema: "platform-brand/v1",
    name: "自媒体操盘手",
    shortName: "操盘手",
    slogan: "AI 内容经营系统",
    welcomeMessage: "欢迎回到内容工作台",
    description: "把策略、创作、生产与归档组织成可持续运转的内容系统。",
    seo: { title: "自媒体操盘手", description: "AI 内容经营系统" },
    colors: { primary: "#168D7A", accent: "#2F80FF" },
    // Contact details are publication data. A failed read must not resurrect a
    // hard-coded account that may belong to a different display brand.
    contact: { name: "", wechat: "", phone: "", email: "" },
    assetIds: {},
  },
  assets: {},
};

export const DEFAULT_PLATFORM_LOGO_URL = "/brand/platform-logo-display-256.webp";

const BRAND_CACHE_MAX_AGE_MS = 60_000;
const BRAND_REFRESH_EVENT = "platform-branding:refresh";
type CacheEntry = { branding: PublicPlatformBranding; cachedAt: number };
const cacheByHost = new Map<string, CacheEntry>();
const pendingByHost = new Map<string, Promise<PublicPlatformBranding>>();
const subscribersByHost = new Map<string, Set<(value: PublicPlatformBranding) => void>>();
const BrandingContext = createContext<PublicPlatformBranding | null>(null);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function publicBrandingHostCacheKey(branding: Pick<PublicPlatformBranding, "displayScope" | "hostname">): string {
  return `${branding.displayScope || "platform"}:${(branding.hostname || "").toLowerCase()}`;
}

function isPublicBranding(value: unknown, expected?: PublicPlatformBranding): value is PublicPlatformBranding {
  if (!isRecord(value) || (value.source !== "published" && value.source !== "legacy")) return false;
  if (value.displayScope !== "platform" && value.displayScope !== "white_label") return false;
  if (typeof value.hostname !== "string" || !value.hostname) return false;
  if (expected && publicBrandingHostCacheKey(value) !== publicBrandingHostCacheKey(expected)) return false;
  if (!Number.isSafeInteger(value.generation) || Number(value.generation) < 0) return false;
  if (!isRecord(value.brand) || value.brand.schema !== "platform-brand/v1") return false;
  if (typeof value.brand.name !== "string" || !value.brand.name.trim()) return false;
  if (!isRecord(value.brand.seo) || !isRecord(value.brand.colors) || !isRecord(value.brand.contact) || !isRecord(value.brand.assetIds)) return false;
  if (!isRecord(value.assets)) return false;
  for (const asset of Object.values(value.assets)) {
    if (asset == null) continue;
    if (!isRecord(asset) || typeof asset.url !== "string" || !asset.url.startsWith("/api/branding/assets/")) return false;
  }
  return true;
}

function publishToHost(key: string, value: PublicPlatformBranding): PublicPlatformBranding {
  cacheByHost.set(key, { branding: value, cachedAt: Date.now() });
  subscribersByHost.get(key)?.forEach((subscriber) => subscriber(value));
  return value;
}

async function fetchPublicBranding(expected: PublicPlatformBranding, force = false): Promise<PublicPlatformBranding> {
  const key = publicBrandingHostCacheKey(expected);
  const cached = cacheByHost.get(key);
  if (!force && cached && Date.now() - cached.cachedAt < BRAND_CACHE_MAX_AGE_MS) return cached.branding;
  const pending = pendingByHost.get(key);
  if (pending) return pending;

  const request = fetch("/api/branding", { credentials: "same-origin", cache: "no-store" })
    .then(async (response) => {
      const body = await response.json().catch(() => ({})) as { branding?: unknown };
      if (!response.ok || !isPublicBranding(body.branding, expected)) throw new Error("品牌配置不可用");
      return publishToHost(key, body.branding);
    })
    // White-label failures keep this Host's last snapshot or its server first
    // frame. They never fall through to the default platform identity.
    .catch(() => cacheByHost.get(key)?.branding || expected)
    .finally(() => pendingByHost.delete(key));
  pendingByHost.set(key, request);
  return request;
}

export function PlatformBrandingProvider({
  initialBranding,
  children,
}: {
  initialBranding: PublicPlatformBranding;
  children?: ReactNode;
}) {
  const key = useMemo(() => publicBrandingHostCacheKey(initialBranding), [initialBranding]);
  const [branding, setBranding] = useState(initialBranding);
  const currentRef = useRef(initialBranding);

  useEffect(() => {
    currentRef.current = initialBranding;
    setBranding(initialBranding);
    publishToHost(key, initialBranding);
    let active = true;
    const update = (value: PublicPlatformBranding) => {
      currentRef.current = value;
      if (active) setBranding(value);
    };
    const subscribers = subscribersByHost.get(key) || new Set<(value: PublicPlatformBranding) => void>();
    subscribers.add(update);
    subscribersByHost.set(key, subscribers);
    const refresh = () => void fetchPublicBranding(currentRef.current, true).then(update);
    const refreshIfStale = () => {
      const cached = cacheByHost.get(key);
      if (!cached || Date.now() - cached.cachedAt >= BRAND_CACHE_MAX_AGE_MS) refresh();
    };
    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") refreshIfStale();
    };
    window.addEventListener(BRAND_REFRESH_EVENT, refresh);
    window.addEventListener("focus", refreshIfStale);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      active = false;
      subscribers.delete(update);
      if (!subscribers.size) subscribersByHost.delete(key);
      window.removeEventListener(BRAND_REFRESH_EVENT, refresh);
      window.removeEventListener("focus", refreshIfStale);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [initialBranding, key]);

  return createElement(BrandingContext.Provider, { value: branding }, children);
}

export function refreshPublishedPlatformBranding(): void {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(BRAND_REFRESH_EVENT));
}

export function usePlatformBranding(): PublicPlatformBranding {
  const provided = useContext(BrandingContext);
  const [standalone, setStandalone] = useState<PublicPlatformBranding>(provided || FALLBACK_PLATFORM_BRANDING);
  useEffect(() => {
    if (provided) {
      setStandalone(provided);
      return;
    }
    let active = true;
    void fetchPublicBranding(standalone).then((value) => {
      if (active) setStandalone(value);
    });
    return () => { active = false; };
  }, [provided]); // eslint-disable-line react-hooks/exhaustive-deps
  return provided || standalone;
}

export type PlatformBrandLogoVariant = "square" | "horizontal-light" | "horizontal-dark";

export function platformBrandLogoUrl(
  branding: PublicPlatformBranding,
  variant: PlatformBrandLogoVariant = "square",
): string | undefined {
  const assets = branding.assets;
  const preferred = variant === "horizontal-dark"
    ? assets.logo_horizontal_dark
    : variant === "horizontal-light"
      ? assets.logo_horizontal_light
      : assets.logo_square;
  const source = preferred?.url
    || assets.logo_square?.url
    || assets.logo_horizontal_light?.url
    || assets.logo_horizontal_dark?.url
    || (branding.displayScope === "white_label" ? undefined : branding.legacyLogoUrl)
    || (branding.displayScope === "white_label" ? undefined : DEFAULT_PLATFORM_LOGO_URL);
  if (!source || !source.startsWith("/api/branding/assets/")) return source;
  const width = variant === "square" ? 256 : 512;
  return `${source}${source.includes("?") ? "&" : "?"}w=${width}`;
}

export function handlePlatformBrandLogoError(
  event: SyntheticEvent<HTMLImageElement>,
  branding: PublicPlatformBranding,
): void {
  const image = event.currentTarget;
  image.onerror = null;
  if (branding.displayScope === "white_label") {
    image.hidden = true;
    image.removeAttribute("src");
  } else if (!image.src.endsWith(DEFAULT_PLATFORM_LOGO_URL)) {
    image.src = DEFAULT_PLATFORM_LOGO_URL;
  } else {
    image.hidden = true;
  }
}

export function platformBrandAssetUrl(
  branding: PublicPlatformBranding,
  purpose: PlatformBrandAssetPurpose,
): string | undefined {
  return branding.assets[purpose]?.url;
}
