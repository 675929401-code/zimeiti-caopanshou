import "server-only";

import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  HELP_CENTER_SETTING_KEY,
  articlePublicationIssues,
  cloneHelpCatalog,
  createSeedHelpCatalog,
  isSafeReturnPath,
  normalizeHelpCatalog,
  validateHelpCatalog,
  type HelpArticle,
  type HelpArticleStatus,
  type HelpArticleType,
  type HelpArticleVisibility,
  type HelpCatalog,
  type HelpCategoryId,
  type HelpFailure,
  type HelpStep,
} from "@/lib/help-center-domain";

export interface LoadedHelpCatalog {
  catalog: HelpCatalog;
  source: "platform_settings" | "seed";
  error: string;
  persisted: boolean;
  storageRevision: string | null;
}

export interface SaveHelpCatalogOptions {
  persisted: boolean;
  expectedStorageRevision: string | null;
}

export class HelpCatalogConflictError extends Error {
  constructor(message = "帮助内容已被其他管理员更新，请刷新后重试") {
    super(message);
    this.name = "HelpCatalogConflictError";
  }
}

function stringValue(value: unknown, fallback = "", max = 20_000): string {
  return typeof value === "string" ? value.trim().slice(0, max) : fallback;
}

function stringList(value: unknown, maxItems = 40, maxLength = 500): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => stringValue(item, "", maxLength))
    .filter(Boolean)
    .slice(0, maxItems);
}

function steps(value: unknown): HelpStep[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const row = item as Record<string, unknown>;
    const title = stringValue(row.title, "", 120);
    const body = stringValue(row.body, "", 1_500);
    return title && body ? [{ title, body }] : [];
  }).slice(0, 30);
}

function failures(value: unknown): HelpFailure[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const row = item as Record<string, unknown>;
    const problem = stringValue(row.problem, "", 180);
    const action = stringValue(row.action, "", 1_500);
    return problem && action ? [{ problem, action }] : [];
  }).slice(0, 30);
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === "string" && allowed.includes(value as T) ? value as T : fallback;
}

function isoDate(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function storageRevision(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
}

export async function loadHelpCatalog(client: SupabaseClient): Promise<LoadedHelpCatalog> {
  const result = await client
    .from("platform_settings")
    .select("setting_value, updated_at")
    .eq("setting_key", HELP_CENTER_SETTING_KEY)
    .maybeSingle();

  if (result.error) {
    return {
      catalog: createSeedHelpCatalog(),
      source: "seed",
      error: result.error.message,
      persisted: false,
      storageRevision: null,
    };
  }

  const persisted = Boolean(result.data);
  const revision = storageRevision(result.data?.updated_at);
  if (!result.data?.setting_value) {
    return { catalog: createSeedHelpCatalog(), source: "seed", error: "", persisted, storageRevision: revision };
  }

  try {
    const parsed = normalizeHelpCatalog(JSON.parse(String(result.data.setting_value)));
    const issues = validateHelpCatalog(parsed);
    if (issues.length) {
      return {
        catalog: createSeedHelpCatalog(),
        source: "seed",
        error: `已保存帮助数据校验失败：${issues.slice(0, 3).join("；")}`,
        persisted,
        storageRevision: revision,
      };
    }
    return { catalog: parsed, source: "platform_settings", error: "", persisted, storageRevision: revision };
  } catch (error) {
    return {
      catalog: createSeedHelpCatalog(),
      source: "seed",
      error: error instanceof Error ? error.message : "帮助数据无法解析",
      persisted,
      storageRevision: revision,
    };
  }
}

export async function saveHelpCatalog(
  client: SupabaseClient,
  catalog: HelpCatalog,
  options: SaveHelpCatalogOptions,
): Promise<string | null> {
  const issues = validateHelpCatalog(catalog);
  if (issues.length) throw new Error(issues.slice(0, 5).join("；"));
  const row = {
    setting_key: HELP_CENTER_SETTING_KEY,
    setting_value: JSON.stringify(catalog),
    updated_at: catalog.updatedAt,
  };

  if (!options.persisted) {
    const result = await client
      .from("platform_settings")
      .insert(row)
      .select("updated_at")
      .single();
    if (result.error) {
      if (result.error.code === "23505") throw new HelpCatalogConflictError();
      throw result.error;
    }
    return storageRevision(result.data?.updated_at);
  }

  let query = client
    .from("platform_settings")
    .update({ setting_value: row.setting_value, updated_at: row.updated_at })
    .eq("setting_key", HELP_CENTER_SETTING_KEY);
  query = options.expectedStorageRevision
    ? query.eq("updated_at", options.expectedStorageRevision)
    : query.is("updated_at", null);
  const result = await query.select("updated_at").maybeSingle();
  if (result.error) throw result.error;
  if (!result.data) throw new HelpCatalogConflictError();
  return storageRevision(result.data.updated_at);
}

export function sanitizeHelpArticle(
  value: unknown,
  catalog: HelpCatalog,
  existing: HelpArticle | undefined,
  now = new Date(),
): HelpArticle {
  const source = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const mediaIds = stringList(source.mediaIds, 20, 100).filter((id) => catalog.media.some((media) => media.id === id));
  const status = enumValue<HelpArticleStatus>(source.status, ["draft", "published"], existing?.status || "draft");
  const publishedAt = status === "published"
    ? isoDate(source.publishedAt) || existing?.publishedAt || now.toISOString()
    : isoDate(source.publishedAt);
  const returnPathCandidate = stringValue(source.returnPath, existing?.returnPath || "/help", 300);
  const requestedId = stringValue(source.id, "", 100);
  const id = existing?.id || (/^article-[a-z0-9-]{3,92}$/i.test(requestedId) ? requestedId : `article-${randomUUID()}`);

  return {
    id,
    slug: stringValue(source.slug, existing?.slug || "", 80).toLowerCase(),
    categoryId: enumValue<HelpCategoryId>(source.categoryId, ["quick-start", "guides", "cases", "faq", "troubleshooting"], existing?.categoryId || "guides"),
    articleType: enumValue<HelpArticleType>(source.articleType, ["guide", "case", "faq", "troubleshooting"], existing?.articleType || "guide"),
    title: stringValue(source.title, existing?.title || "", 180),
    summary: stringValue(source.summary, existing?.summary || "", 500),
    keywords: stringList(source.keywords, 30, 80),
    body: stringValue(source.body, existing?.body || "", 20_000),
    applicability: stringValue(source.applicability, existing?.applicability || "", 3_000),
    preparation: stringList(source.preparation, 40, 1_000),
    steps: steps(source.steps),
    costAndWait: stringValue(source.costAndWait, existing?.costAndWait || "", 4_000),
    successCriteria: stringList(source.successCriteria, 40, 1_000),
    failures: failures(source.failures),
    notes: stringValue(source.notes, existing?.notes || "", 4_000),
    returnPath: isSafeReturnPath(returnPathCandidate) ? returnPathCandidate : "/help",
    returnLabel: stringValue(source.returnLabel, existing?.returnLabel || "返回帮助中心", 80),
    status,
    pinned: source.pinned === true,
    recommended: source.recommended === true,
    sortOrder: Math.max(0, Math.min(9_999, Math.round(Number(source.sortOrder) || 0))),
    visibility: enumValue<HelpArticleVisibility>(source.visibility, ["public", "authenticated", "admins"], existing?.visibility || "public"),
    publishedAt,
    updatedAt: now.toISOString(),
    readMinutes: Math.max(1, Math.min(60, Math.round(Number(source.readMinutes) || existing?.readMinutes || 3))),
    mediaIds,
    coverMediaId: mediaIds.includes(String(source.coverMediaId || "")) ? String(source.coverMediaId) : mediaIds[0] || null,
  };
}

export function prepareCatalogForSave(catalog: HelpCatalog, now = new Date()): HelpCatalog {
  const next = cloneHelpCatalog(catalog);
  next.revision += 1;
  next.updatedAt = now.toISOString();
  next.history = next.history.slice(0, 60);
  return next;
}

export function publicationIssues(article: HelpArticle, catalog: HelpCatalog): string[] {
  return articlePublicationIssues(article, catalog.media);
}
