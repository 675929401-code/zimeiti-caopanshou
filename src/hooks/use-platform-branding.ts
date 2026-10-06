"use client";

import { useEffect, useState } from "react";

import type {
  PlatformBrandAssetPurpose,
  PublicPlatformBranding,
} from "@/lib/branding/contracts";

export const FALLBACK_PLATFORM_BRANDING: PublicPlatformBranding = {
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
    seo: {
      title: "自媒体操盘手",
      description: "AI 内容经营系统",
    },
    colors: {
      primary: "#168D7A",
      accent: "#2F80FF",
    },
    assetIds: {},
  },
  assets: {},
};

// Next publishes src/app/icon.png as a stable, version-controlled /icon.png
// route. Keep the platform fallback on that tracked asset so a rebuild or a
// deployment cannot lose the logo through public/**/*.png ignore rules.
export const DEFAULT_PLATFORM_LOGO_URL = "/icon.png";

const BRAND_CACHE_MAX_AGE_MS = 60_000;
const BRAND_REFRESH_EVENT = "platform-branding:refresh";
const subscribers = new Set<(value: PublicPlatformBranding) => void>();

let cachedBranding: PublicPlatformBranding | null = null;
let cachedAt = 0;
let pendingBranding: Promise<PublicPlatformBranding> | null = null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isPublicBranding(value: unknown): value is PublicPlatformBranding {
  if (!isRecord(value) || (value.source !== "published" && value.source !== "legacy")) return false;
  if (!Number.isSafeInteger(value.generation) || Number(value.generation) < 0) return false;
  if (!isRecord(value.brand) || value.brand.schema !== "platform-brand/v1") return false;
  if (typeof value.brand.name !== "string" || !value.brand.name.trim()) return false;
  if (!isRecord(value.brand.seo) || !isRecord(value.brand.colors) || !isRecord(value.brand.assetIds)) return false;
  if (!isRecord(value.assets)) return false;

  // Published images must use the stable same-origin asset route. This keeps a
  // malformed response from reintroducing expiring third-party asset links.
  for (const asset of Object.values(value.assets)) {
    if (asset == null) continue;
    if (!isRecord(asset) || typeof asset.url !== "string" || !asset.url.startsWith("/api/branding/assets/")) {
      return false;
    }
  }
  return true;
}

function publishToSubscribers(value: PublicPlatformBranding): PublicPlatformBranding {
  cachedBranding = value;
  cachedAt = Date.now();
  subscribers.forEach((subscriber) => subscriber(value));
  return value;
}

async function fetchPublicBranding(force = false): Promise<PublicPlatformBranding> {
  if (!force && cachedBranding && Date.now() - cachedAt < BRAND_CACHE_MAX_AGE_MS) return cachedBranding;
  if (pendingBranding) return pendingBranding;

  pendingBranding = fetch("/api/branding", {
    credentials: "same-origin",
    cache: "no-store",
  })
    .then(async (response) => {
      const body = await response.json().catch(() => ({})) as { branding?: unknown };
      if (!response.ok || !isPublicBranding(body.branding)) throw new Error("品牌配置不可用");
      return publishToSubscribers(body.branding);
    })
    .catch(() => cachedBranding || FALLBACK_PLATFORM_BRANDING)
    .finally(() => {
      pendingBranding = null;
    });

  return pendingBranding;
}

/**
 * Notify mounted public surfaces after a publish or rollback. The event does
 * not carry draft data; every consumer re-reads the public published snapshot.
 */
export function refreshPublishedPlatformBranding(): void {
  cachedAt = 0;
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(BRAND_REFRESH_EVENT));
}

export function usePlatformBranding(): PublicPlatformBranding {
  const [branding, setBranding] = useState<PublicPlatformBranding>(
    cachedBranding || FALLBACK_PLATFORM_BRANDING,
  );

  useEffect(() => {
    let active = true;
    const update = (value: PublicPlatformBranding) => {
      if (active) setBranding(value);
    };
    const refresh = () => {
      void fetchPublicBranding(true).then(update);
    };
    const refreshIfStale = () => {
      if (!cachedBranding || Date.now() - cachedAt >= BRAND_CACHE_MAX_AGE_MS) refresh();
    };
    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") refreshIfStale();
    };

    subscribers.add(update);
    void fetchPublicBranding().then(update);
    window.addEventListener(BRAND_REFRESH_EVENT, refresh);
    window.addEventListener("focus", refreshIfStale);
    document.addEventListener("visibilitychange", refreshWhenVisible);

    return () => {
      active = false;
      subscribers.delete(update);
      window.removeEventListener(BRAND_REFRESH_EVENT, refresh);
      window.removeEventListener("focus", refreshIfStale);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, []);

  return branding;
}

export type PlatformBrandLogoVariant = "square" | "horizontal-light" | "horizontal-dark";

export function platformBrandLogoUrl(
  branding: PublicPlatformBranding,
  variant: PlatformBrandLogoVariant = "square",
): string {
  const assets = branding.assets;
  const preferred = variant === "horizontal-dark"
    ? assets.logo_horizontal_dark
    : variant === "horizontal-light"
      ? assets.logo_horizontal_light
      : assets.logo_square;
  return preferred?.url
    || assets.logo_square?.url
    || assets.logo_horizontal_light?.url
    || assets.logo_horizontal_dark?.url
    || branding.legacyLogoUrl
    || DEFAULT_PLATFORM_LOGO_URL;
}

export function platformBrandAssetUrl(
  branding: PublicPlatformBranding,
  purpose: PlatformBrandAssetPurpose,
): string | undefined {
  return branding.assets[purpose]?.url;
}
