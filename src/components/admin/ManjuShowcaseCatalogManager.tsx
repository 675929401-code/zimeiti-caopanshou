"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { manjuDraftFingerprint } from "@/lib/manju-admin-draft-state";

interface Props {
  token: string;
}

type JsonRecord = Record<string, unknown>;
type MediaType = "image" | "video" | "audio";

interface InspirationItem {
  id: string;
  url: string;
  type: MediaType;
  category: string;
  prompt: string;
  metadata: {
    title: string;
    summary: string;
    previewUrl: string;
    posterUrl: string | null;
  };
}

interface SiteBanner {
  url: string;
  type: "image" | "video";
  link?: string;
  enabled?: boolean;
  poster?: string;
}

interface CanvasExample {
  canvasId: string;
  title: string;
  coverImage: string;
  tag?: string;
}

interface SiteConfig {
  banners: Record<string, readonly SiteBanner[]>;
  heroVideo: SiteBanner;
  backgroundVideos: readonly SiteBanner[];
  canvasExamples: readonly CanvasExample[];
}

interface ConfigRevision {
  id?: string;
  revision_id?: string;
  release_id?: string;
  active_release_id?: string;
  version?: number | string;
  status?: string;
  schema_version?: string;
  payload?: unknown;
  etag?: string;
  created_at?: string;
  updated_at?: string;
  published_at?: string;
  pointer?: ConfigRevision | null;
  release?: ConfigRevision | null;
  revision?: ConfigRevision | null;
}

interface ConfigResponse extends JsonRecord {
  ok?: boolean;
  storage_mode?: "native" | "compat";
  storage_generation?: number;
  error?: string;
  message?: string;
  code?: string;
  active?: ConfigRevision | null;
  revision?: ConfigRevision | null;
  drafts?: ConfigRevision[];
  history?: ConfigRevision[];
}

interface AssetRef {
  assetId?: string;
  path: string;
}

interface InspirationOverride {
  enabled?: boolean;
  title?: string;
  summary?: string;
  prompt?: string;
  category?: string;
  sortOrder?: number;
}

interface CanvasExampleOverride {
  enabled?: boolean;
  title?: string;
  tag?: string;
  cover?: AssetRef;
}

interface BannerOverride {
  enabled?: boolean;
  asset?: AssetRef;
  poster?: AssetRef;
}

interface ShowcaseCatalogV1 {
  inspiration: {
    overrides: Record<string, InspirationOverride>;
  };
  canvas_examples: {
    order?: string[];
    overrides: Record<string, CanvasExampleOverride>;
  };
  banners: {
    overrides: Record<string, BannerOverride>;
  };
  hero: BannerOverride;
}

interface AssetChoice {
  key: string;
  label: string;
  ref: AssetRef;
  mediaType: MediaType;
}

interface BannerDescriptor {
  key: string;
  group: string;
  index: number;
  banner: SiteBanner;
}

interface AdminUploadedAsset {
  id: string;
  path: string;
  storageProvider: string;
  storageKey: string;
  contentType: string;
  size: number;
  mediaType: MediaType;
  category: string;
  title: string;
  summary: string;
  prompt: string;
  filename: string;
  createdAt: string;
  updatedAt: string;
  enabled: boolean;
  deletedAt: string | null;
}

interface AdminAssetResponse extends JsonRecord {
  ok?: boolean;
  error?: string;
  code?: string;
  assets?: AdminUploadedAsset[];
  registry?: {
    assets?: AdminUploadedAsset[];
  };
}

type EditorTab = "assets" | "inspiration" | "canvas" | "banners" | "releases";

const ENVIRONMENT = "production";
const DOMAIN = "media";
const SCHEMA_VERSION = "1.1.0";
const MAX_CONFIG_BYTES = 256 * 1024;
const INSPIRATION_PAGE_LIMIT = 100;
const CATEGORY_OPTIONS = [
  { value: "image", label: "图片" },
  { value: "video", label: "视频" },
  { value: "audio", label: "音频" },
  { value: "character", label: "角色" },
  { value: "scene", label: "场景" },
  { value: "prop", label: "道具" },
  { value: "style", label: "风格" },
  { value: "shot", label: "分镜" },
  { value: "film", label: "成片" },
  { value: "music", label: "音乐" },
  { value: "voice", label: "语音" },
  { value: "sound-effect", label: "音效" },
  { value: "other", label: "其他" },
] as const;
const EMPTY_V1 = (): ShowcaseCatalogV1 => ({
  inspiration: { overrides: {} },
  canvas_examples: { overrides: {} },
  banners: { overrides: {} },
  hero: {},
});

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function cloneRecord(value: unknown): JsonRecord {
  if (!isRecord(value)) return {};
  return JSON.parse(JSON.stringify(value)) as JsonRecord;
}

function revisionValue(record: ConfigRevision | null | undefined): ConfigRevision {
  return record?.revision || record || {};
}

function revisionId(record: ConfigRevision | null | undefined): string {
  const revision = revisionValue(record);
  return String(
    record?.revision_id
      || record?.pointer?.revision_id
      || record?.release?.revision_id
      || revision.revision_id
      || revision.id
      || "",
  );
}

function releaseId(record: ConfigRevision | null | undefined): string {
  return String(
    record?.release_id
      || record?.active_release_id
      || record?.pointer?.active_release_id
      || record?.release?.id
      || record?.id
      || "",
  );
}

function revisionPayload(record: ConfigRevision | null | undefined): JsonRecord {
  return cloneRecord(revisionValue(record).payload);
}

function revisionVersion(record: ConfigRevision | null | undefined): string {
  const value = revisionValue(record).version;
  return value === undefined || value === null ? "—" : String(value);
}

function recordTime(record: ConfigRevision | null | undefined): string {
  const raw = record?.release?.created_at
    || record?.published_at
    || revisionValue(record).published_at
    || record?.updated_at
    || record?.created_at;
  if (!raw) return "时间未记录";
  const value = new Date(raw);
  return Number.isNaN(value.getTime()) ? raw : value.toLocaleString("zh-CN");
}

function shortId(value: string): string {
  if (!value) return "—";
  return value.length > 18 ? `${value.slice(0, 8)}…${value.slice(-6)}` : value;
}

function safeSitePath(value: string): boolean {
  return value.startsWith("/")
    && !value.startsWith("//")
    && !value.includes("..")
    && !/^[a-z][a-z\d+.-]*:/iu.test(value);
}

function inferMediaType(path: string): MediaType {
  const clean = path.split(/[?#]/u, 1)[0]?.toLowerCase() || "";
  if (/\.(?:mp4|webm|mov|m4v)$/u.test(clean)) return "video";
  if (/\.(?:mp3|wav|m4a|aac|ogg|flac)$/u.test(clean)) return "audio";
  return "image";
}

function readAssetRef(value: unknown): AssetRef | undefined {
  if (!isRecord(value) || typeof value.path !== "string") return undefined;
  const assetId = typeof value.assetId === "string" && value.assetId.trim()
    ? value.assetId.trim()
    : undefined;
  return { ...(assetId ? { assetId } : {}), path: value.path };
}

function readShowcaseV1(payload: JsonRecord): ShowcaseCatalogV1 {
  const result = EMPTY_V1();
  const root = isRecord(payload.showcase_catalog) ? payload.showcase_catalog : {};
  const v1 = isRecord(root.v1) ? root.v1 : {};

  const inspiration = isRecord(v1.inspiration) ? v1.inspiration : {};
  const inspirationOverrides = isRecord(inspiration.overrides) ? inspiration.overrides : {};
  for (const [id, raw] of Object.entries(inspirationOverrides)) {
    if (!isRecord(raw)) continue;
    const next: InspirationOverride = {};
    if (typeof raw.enabled === "boolean") next.enabled = raw.enabled;
    if (typeof raw.title === "string") next.title = raw.title;
    if (typeof raw.summary === "string") next.summary = raw.summary;
    if (typeof raw.prompt === "string") next.prompt = raw.prompt;
    if (typeof raw.category === "string") next.category = raw.category;
    if (typeof raw.sortOrder === "number") next.sortOrder = raw.sortOrder;
    result.inspiration.overrides[id] = next;
  }

  const canvas = isRecord(v1.canvas_examples) ? v1.canvas_examples : {};
  if (Array.isArray(canvas.order) && canvas.order.every((value) => typeof value === "string")) {
    result.canvas_examples.order = [...canvas.order];
  }
  const canvasOverrides = isRecord(canvas.overrides) ? canvas.overrides : {};
  for (const [id, raw] of Object.entries(canvasOverrides)) {
    if (!isRecord(raw)) continue;
    const next: CanvasExampleOverride = {};
    if (typeof raw.enabled === "boolean") next.enabled = raw.enabled;
    if (typeof raw.title === "string") next.title = raw.title;
    if (typeof raw.tag === "string") next.tag = raw.tag;
    const cover = readAssetRef(raw.cover);
    if (cover) next.cover = cover;
    result.canvas_examples.overrides[id] = next;
  }

  const banners = isRecord(v1.banners) ? v1.banners : {};
  const bannerOverrides = isRecord(banners.overrides) ? banners.overrides : {};
  for (const [key, raw] of Object.entries(bannerOverrides)) {
    if (!isRecord(raw)) continue;
    const next: BannerOverride = {};
    if (typeof raw.enabled === "boolean") next.enabled = raw.enabled;
    const asset = readAssetRef(raw.asset);
    const poster = readAssetRef(raw.poster);
    if (asset) next.asset = asset;
    if (poster) next.poster = poster;
    result.banners.overrides[key] = next;
  }

  const hero = isRecord(v1.hero) ? v1.hero : {};
  if (typeof hero.enabled === "boolean") result.hero.enabled = hero.enabled;
  const heroAsset = readAssetRef(hero.asset);
  const heroPoster = readAssetRef(hero.poster);
  if (heroAsset) result.hero.asset = heroAsset;
  if (heroPoster) result.hero.poster = heroPoster;
  return result;
}

function mergeShowcasePayload(basePayload: JsonRecord, v1: ShowcaseCatalogV1): JsonRecord {
  const root = isRecord(basePayload.showcase_catalog)
    ? cloneRecord(basePayload.showcase_catalog)
    : {};
  return {
    ...basePayload,
    showcase_catalog: {
      ...root,
      v1,
    },
  };
}

function assetRefEquals(left: AssetRef | undefined, right: AssetRef | undefined): boolean {
  if (!left && !right) return true;
  return Boolean(left && right && left.path === right.path);
}

function hasKeys(value: object): boolean {
  return Object.keys(value).length > 0;
}

function bannerKey(group: string, index: number): string {
  return `${group}:${index}`;
}

function baselineAssetRef(path: string, itemByPath: ReadonlyMap<string, InspirationItem>): AssetRef {
  const item = itemByPath.get(path);
  return item ? { assetId: item.id, path } : { path };
}

function compactInspirationOverride(
  item: InspirationItem,
  baselineIndex: number,
  raw: InspirationOverride,
): InspirationOverride {
  const result: InspirationOverride = {};
  if (raw.enabled === false) result.enabled = false;
  if (raw.title !== undefined && raw.title !== item.metadata.title) result.title = raw.title;
  if (raw.summary !== undefined && raw.summary !== item.metadata.summary) result.summary = raw.summary;
  if (raw.prompt !== undefined && raw.prompt !== item.prompt) result.prompt = raw.prompt;
  if (raw.category !== undefined && raw.category !== item.category) result.category = raw.category;
  if (raw.sortOrder !== undefined && raw.sortOrder !== baselineIndex) result.sortOrder = raw.sortOrder;
  return result;
}

function compactCanvasOverride(
  example: CanvasExample,
  raw: CanvasExampleOverride,
  itemByPath: ReadonlyMap<string, InspirationItem>,
): CanvasExampleOverride {
  const result: CanvasExampleOverride = {};
  if (raw.enabled === false) result.enabled = false;
  if (raw.title !== undefined && raw.title !== example.title) result.title = raw.title;
  if (raw.tag !== undefined && raw.tag !== (example.tag || "")) result.tag = raw.tag;
  if (raw.cover && !assetRefEquals(raw.cover, baselineAssetRef(example.coverImage, itemByPath))) {
    result.cover = raw.cover;
  }
  return result;
}

function compactBannerOverride(
  banner: SiteBanner,
  raw: BannerOverride,
  itemByPath: ReadonlyMap<string, InspirationItem>,
): BannerOverride {
  const result: BannerOverride = {};
  const baselineEnabled = banner.enabled ?? true;
  if (raw.enabled !== undefined && raw.enabled !== baselineEnabled) result.enabled = raw.enabled;
  if (raw.asset && !assetRefEquals(raw.asset, baselineAssetRef(banner.url, itemByPath))) result.asset = raw.asset;
  const baselinePoster = banner.poster ? baselineAssetRef(banner.poster, itemByPath) : undefined;
  if (raw.poster && !assetRefEquals(raw.poster, baselinePoster)) result.poster = raw.poster;
  return result;
}

function compactHeroOverride(
  hero: SiteBanner,
  raw: BannerOverride,
  itemByPath: ReadonlyMap<string, InspirationItem>,
): BannerOverride {
  return compactBannerOverride(hero, raw, itemByPath);
}

function normalizeV1(
  current: ShowcaseCatalogV1,
  inspiration: readonly InspirationItem[],
  siteConfig: SiteConfig,
): ShowcaseCatalogV1 {
  const result = EMPTY_V1();
  const itemByPath = new Map(inspiration.map((item) => [item.url, item]));
  inspiration.forEach((item, index) => {
    const compacted = compactInspirationOverride(item, index, current.inspiration.overrides[item.id] || {});
    if (hasKeys(compacted)) result.inspiration.overrides[item.id] = compacted;
  });

  const baselineOrder = siteConfig.canvasExamples.map((item) => item.canvasId);
  const order = current.canvas_examples.order;
  if (order && order.some((value, index) => value !== baselineOrder[index])) {
    result.canvas_examples.order = [...order];
  }
  for (const example of siteConfig.canvasExamples) {
    const compacted = compactCanvasOverride(
      example,
      current.canvas_examples.overrides[example.canvasId] || {},
      itemByPath,
    );
    if (hasKeys(compacted)) result.canvas_examples.overrides[example.canvasId] = compacted;
  }

  for (const [group, items] of Object.entries(siteConfig.banners)) {
    items.forEach((banner, index) => {
      const key = bannerKey(group, index);
      const compacted = compactBannerOverride(banner, current.banners.overrides[key] || {}, itemByPath);
      if (hasKeys(compacted)) result.banners.overrides[key] = compacted;
    });
  }
  result.hero = compactHeroOverride(siteConfig.heroVideo, current.hero, itemByPath);
  return result;
}

function buildAssetChoices(inspiration: readonly InspirationItem[], siteConfig: SiteConfig): AssetChoice[] {
  const byPath = new Map<string, AssetChoice>();
  for (const item of inspiration) {
    if (!safeSitePath(item.url) || byPath.has(item.url)) continue;
    byPath.set(item.url, {
      key: `asset:${item.id}`,
      label: `${item.metadata.title} · ${item.type} · ${item.id}`,
      ref: { assetId: item.id, path: item.url },
      mediaType: item.type,
    });
  }

  const addPath = (path: string | undefined, label: string) => {
    if (!path || !safeSitePath(path) || byPath.has(path)) return;
    byPath.set(path, {
      key: `path:${path}`,
      label: `${label} · ${path}`,
      ref: { path },
      mediaType: inferMediaType(path),
    });
  };

  addPath(siteConfig.heroVideo.url, "当前首页主视觉");
  addPath(siteConfig.heroVideo.poster, "当前首页主视觉海报");
  siteConfig.backgroundVideos.forEach((item, index) => {
    addPath(item.url, `背景视频 ${index + 1}`);
    addPath(item.poster, `背景视频 ${index + 1} 海报`);
  });
  for (const [group, items] of Object.entries(siteConfig.banners)) {
    items.forEach((item, index) => {
      addPath(item.url, `${group} 横幅 ${index + 1}`);
      addPath(item.poster, `${group} 横幅 ${index + 1} 海报`);
    });
  }
  siteConfig.canvasExamples.forEach((item) => addPath(item.coverImage, `${item.title}封面`));
  return [...byPath.values()].sort((left, right) => left.label.localeCompare(right.label, "zh-CN"));
}

function validateAssetRef(
  ref: AssetRef | undefined,
  label: string,
  knownPaths: ReadonlySet<string>,
  inspirationById: ReadonlyMap<string, InspirationItem>,
  issues: string[],
): void {
  if (!ref) return;
  if (!safeSitePath(ref.path) || !knownPaths.has(ref.path)) {
    issues.push(`${label} 只能引用已由 /api/inspiration 或 /api/site-config 登记的本站路径。`);
  }
  if (ref.assetId) {
    const asset = inspirationById.get(ref.assetId);
    if (!asset || asset.url !== ref.path) issues.push(`${label} 的 assetId 与本站素材路径不匹配。`);
  }
}

function validateV1(
  v1: ShowcaseCatalogV1,
  inspiration: readonly InspirationItem[],
  siteConfig: SiteConfig,
  choices: readonly AssetChoice[],
): string[] {
  const issues: string[] = [];
  const inspirationById = new Map(inspiration.map((item) => [item.id, item]));
  const categories = new Set(inspiration.map((item) => item.category));
  const knownPaths = new Set(choices.map((item) => item.ref.path));

  for (const [id, override] of Object.entries(v1.inspiration.overrides)) {
    if (!inspirationById.has(id)) {
      issues.push(`灵感覆盖引用了不存在的素材 ${id}。`);
      continue;
    }
    if (override.title !== undefined && (override.title.trim().length === 0 || override.title.length > 160)) {
      issues.push(`${id} 的标题必须为 1-160 个字符。`);
    }
    if (override.summary !== undefined && override.summary.length > 500) issues.push(`${id} 的摘要不能超过 500 个字符。`);
    if (override.prompt !== undefined && override.prompt.length > 12_000) issues.push(`${id} 的提示词不能超过 12000 个字符。`);
    if (override.category !== undefined && !categories.has(override.category)) issues.push(`${id} 使用了未知分类。`);
    if (override.sortOrder !== undefined && (!Number.isSafeInteger(override.sortOrder) || override.sortOrder < 0 || override.sortOrder > 100_000)) {
      issues.push(`${id} 的排序值必须为 0-100000 的整数。`);
    }
  }

  const canvasIds = siteConfig.canvasExamples.map((item) => item.canvasId);
  const canvasIdSet = new Set(canvasIds);
  if (v1.canvas_examples.order) {
    const order = v1.canvas_examples.order;
    if (order.length !== canvasIds.length || new Set(order).size !== canvasIds.length || order.some((id) => !canvasIdSet.has(id))) {
      issues.push("画布示例排序必须完整且每个现有 canvasId 只能出现一次。");
    }
  }
  for (const [id, override] of Object.entries(v1.canvas_examples.overrides)) {
    if (!canvasIdSet.has(id)) {
      issues.push(`画布覆盖引用了不存在的示例 ${id}。`);
      continue;
    }
    if (override.title !== undefined && (override.title.trim().length === 0 || override.title.length > 160)) {
      issues.push(`${id} 的标题必须为 1-160 个字符。`);
    }
    if (override.tag !== undefined && override.tag.length > 80) issues.push(`${id} 的标签不能超过 80 个字符。`);
    validateAssetRef(override.cover, `${id} 的封面`, knownPaths, inspirationById, issues);
  }

  const allowedBannerKeys = new Set<string>();
  for (const [group, items] of Object.entries(siteConfig.banners)) {
    items.forEach((_item, index) => allowedBannerKeys.add(bannerKey(group, index)));
  }
  for (const [key, override] of Object.entries(v1.banners.overrides)) {
    if (!allowedBannerKeys.has(key)) {
      issues.push(`横幅覆盖引用了不存在的位置 ${key}。`);
      continue;
    }
    validateAssetRef(override.asset, `${key} 的素材`, knownPaths, inspirationById, issues);
    validateAssetRef(override.poster, `${key} 的海报`, knownPaths, inspirationById, issues);
  }
  validateAssetRef(v1.hero.asset, "首页主视觉素材", knownPaths, inspirationById, issues);
  validateAssetRef(v1.hero.poster, "首页主视觉海报", knownPaths, inspirationById, issues);
  return issues;
}

function describeConfigError(body: ConfigResponse, fallback: string): string {
  const raw = body.error || body.message || fallback;
  if (body.code === "MIGRATION_NOT_READY" || /MIGRATION_NOT_READY|schema cache|relation .* does not exist/iu.test(raw)) {
    return "配置控制平面尚未就绪（MIGRATION_NOT_READY），本次不会伪造保存或发布结果。";
  }
  return raw;
}

async function readJson(response: Response): Promise<JsonRecord> {
  return await response.json().catch(() => ({})) as JsonRecord;
}

async function fetchAllInspiration(): Promise<InspirationItem[]> {
  const firstResponse = await fetch(`/api/inspiration?page=1&limit=${INSPIRATION_PAGE_LIMIT}&sort=latest`, { cache: "no-store" });
  const first = await readJson(firstResponse);
  if (!firstResponse.ok || first.success !== true || !Array.isArray(first.data)) {
    throw new Error("公共灵感素材目录读取失败。");
  }
  const pagination = isRecord(first.pagination) ? first.pagination : {};
  const totalPages = Number(pagination.totalPages) || 1;
  if (!Number.isSafeInteger(totalPages) || totalPages < 1 || totalPages > 100) {
    throw new Error("公共灵感素材分页信息无效。");
  }
  const pages = await Promise.all(
    Array.from({ length: totalPages - 1 }, async (_value, index) => {
      const page = index + 2;
      const response = await fetch(`/api/inspiration?page=${page}&limit=${INSPIRATION_PAGE_LIMIT}&sort=latest`, { cache: "no-store" });
      const body = await readJson(response);
      if (!response.ok || body.success !== true || !Array.isArray(body.data)) {
        throw new Error(`公共灵感素材第 ${page} 页读取失败。`);
      }
      return body.data as InspirationItem[];
    }),
  );
  const items = [...(first.data as InspirationItem[]), ...pages.flat()];
  if (new Set(items.map((item) => item.id)).size !== items.length) throw new Error("公共灵感素材包含重复 ID。");
  const expectedTotal = Number(pagination.total);
  if (Number.isSafeInteger(expectedTotal) && expectedTotal !== items.length) throw new Error("公共灵感素材分页未完整读取。");
  return items;
}

async function fetchSiteConfig(): Promise<SiteConfig> {
  const response = await fetch("/api/site-config", { cache: "no-store" });
  const body = await readJson(response);
  if (!response.ok || body.success !== true || !isRecord(body.data)) throw new Error("公共站点配置读取失败。");
  const data = body.data as unknown as SiteConfig;
  if (!isRecord(data.banners) || !Array.isArray(data.canvasExamples) || !isRecord(data.heroVideo)) {
    throw new Error("公共站点配置结构无效。");
  }
  return data;
}

async function fetchAdminUploadedAssets(token: string): Promise<AdminUploadedAsset[]> {
  const response = await fetch("/api/admin/manju-workbench/assets", {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  const body = await readJson(response) as AdminAssetResponse;
  if (!response.ok || body.ok === false) {
    throw new Error(body.error || "后台上传素材清单读取失败。");
  }
  return Array.isArray(body.assets) ? body.assets : [];
}

export function ManjuShowcaseCatalogManager({ token }: Props) {
  const [inspiration, setInspiration] = useState<InspirationItem[]>([]);
  const [uploadedAssets, setUploadedAssets] = useState<AdminUploadedAsset[]>([]);
  const [siteConfig, setSiteConfig] = useState<SiteConfig | null>(null);
  const [config, setConfig] = useState<ConfigResponse | null>(null);
  const [basePayload, setBasePayload] = useState<JsonRecord>({});
  const [v1, setV1] = useState<ShowcaseCatalogV1>(EMPTY_V1);
  const [schemaVersion, setSchemaVersion] = useState(SCHEMA_VERSION);
  const [selectedDraftId, setSelectedDraftId] = useState("");
  const [editorBase, setEditorBase] = useState<{ fingerprint: string; updatedAt?: string } | null>(null);
  const [selectedInspirationId, setSelectedInspirationId] = useState("");
  const [selectedCanvasId, setSelectedCanvasId] = useState("");
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState<EditorTab>("assets");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploadForm, setUploadForm] = useState({
    title: "",
    summary: "",
    prompt: "",
    category: "image",
  });
  const [replacementIds, setReplacementIds] = useState<Record<string, string>>({});
  const [assetDrafts, setAssetDrafts] = useState<Record<string, Partial<AdminUploadedAsset>>>({});

  const loadRecord = useCallback((record: ConfigRevision | null | undefined, draftId = "") => {
    const payload = revisionPayload(record);
    setBasePayload(payload);
    setV1(readShowcaseV1(payload));
    setSchemaVersion(SCHEMA_VERSION);
    setSelectedDraftId(draftId);
    setEditorBase({ fingerprint: manjuDraftFingerprint(readShowcaseV1(payload)), updatedAt: revisionValue(record).updated_at });
  }, []);

  const loadAll = useCallback(async (options?: { preserveNotice?: boolean; preserveEditor?: boolean; preferredDraftId?: string }) => {
    setBusy("load");
    setError("");
    if (!options?.preserveNotice) setNotice("");
    try {
      if (!token) throw new Error("管理员会话缺失，请重新登录后再试。");
      const configRequest = fetch(`/api/admin/manju-config?environment=${ENVIRONMENT}&domain=${DOMAIN}`, {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
      });
      const [nextInspiration, nextSiteConfig, nextUploadedAssets, configResponse] = await Promise.all([
        fetchAllInspiration(),
        fetchSiteConfig(),
        fetchAdminUploadedAssets(token),
        configRequest,
      ]);
      const configBody = await readJson(configResponse) as ConfigResponse;
      if (!configResponse.ok || configBody.ok === false) {
        throw new Error(describeConfigError(configBody, "素材配置控制平面读取失败。"));
      }
      const drafts = Array.isArray(configBody.drafts) ? configBody.drafts : [];
      const history = Array.isArray(configBody.history) ? configBody.history : [];
      const normalized = { ...configBody, drafts, history };
      setInspiration(nextInspiration);
      setUploadedAssets(nextUploadedAssets);
      setSiteConfig(nextSiteConfig);
      setConfig(normalized);
      if (!options?.preserveEditor) {
        const preferredDraft = options?.preferredDraftId
          ? drafts.find((draft) => revisionId(draft) === options.preferredDraftId)
          : drafts[0];
        if (options?.preferredDraftId && !preferredDraft) {
          setError("已保存的草稿暂未出现在刷新结果中。当前编辑已保留，请刷新后核对版本再发布。");
          return;
        }
        const preferred = preferredDraft || configBody.active || null;
        loadRecord(preferred, preferredDraft ? revisionId(preferredDraft) : "");
      }
      setSelectedInspirationId((current) => current || nextInspiration[0]?.id || "");
      setSelectedCanvasId((current) => current || nextSiteConfig.canvasExamples[0]?.canvasId || "");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "展示内容配置读取失败。");
    } finally {
      setBusy("");
    }
  }, [loadRecord, token]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  const inspirationById = useMemo(
    () => new Map(inspiration.map((item) => [item.id, item])),
    [inspiration],
  );
  const inspirationIndexById = useMemo(
    () => new Map(inspiration.map((item, index) => [item.id, index])),
    [inspiration],
  );
  const itemByPath = useMemo(
    () => new Map(inspiration.map((item) => [item.url, item])),
    [inspiration],
  );
  const categories = useMemo(
    () => [...new Set(inspiration.map((item) => item.category))].sort((left, right) => left.localeCompare(right, "zh-CN")),
    [inspiration],
  );
  const assetChoices = useMemo(
    () => siteConfig ? buildAssetChoices(inspiration, siteConfig) : [],
    [inspiration, siteConfig],
  );
  const assetChoiceByKey = useMemo(
    () => new Map(assetChoices.map((item) => [item.key, item])),
    [assetChoices],
  );
  const assetChoiceByPath = useMemo(
    () => new Map(assetChoices.map((item) => [item.ref.path, item])),
    [assetChoices],
  );
  const filteredInspiration = useMemo(() => {
    const keyword = query.trim().toLocaleLowerCase("zh-CN");
    if (!keyword) return inspiration;
    return inspiration.filter((item) => [item.id, item.metadata.title, item.metadata.summary, item.prompt, item.category, item.type]
      .some((value) => value.toLocaleLowerCase("zh-CN").includes(keyword)));
  }, [inspiration, query]);
  const banners = useMemo<BannerDescriptor[]>(() => {
    if (!siteConfig) return [];
    return Object.entries(siteConfig.banners).flatMap(([group, items]) => items.map((banner, index) => ({
      key: bannerKey(group, index),
      group,
      index,
      banner,
    })));
  }, [siteConfig]);
  const canvasOrder = useMemo(() => {
    if (!siteConfig) return [];
    return v1.canvas_examples.order || siteConfig.canvasExamples.map((item) => item.canvasId);
  }, [siteConfig, v1.canvas_examples.order]);

  const selectedInspiration = selectedInspirationId ? inspirationById.get(selectedInspirationId) : undefined;
  const selectedInspirationIndex = selectedInspirationId ? (inspirationIndexById.get(selectedInspirationId) ?? 0) : 0;
  const selectedInspirationOverride = selectedInspirationId ? v1.inspiration.overrides[selectedInspirationId] || {} : {};
  const selectedCanvas = siteConfig?.canvasExamples.find((item) => item.canvasId === selectedCanvasId);
  const selectedCanvasOverride = selectedCanvasId ? v1.canvas_examples.overrides[selectedCanvasId] || {} : {};
  const drafts = config?.drafts || [];
  const history = config?.history || [];
  const selectedDraft = drafts.find((item) => revisionId(item) === selectedDraftId);
  const hasUnsavedChanges = editorBase !== null && manjuDraftFingerprint(v1) !== editorBase.fingerprint;
  const activeReleaseId = releaseId(config?.active);
  const overrideCount = Object.keys(v1.inspiration.overrides).length
    + Object.keys(v1.canvas_examples.overrides).length
    + Object.keys(v1.banners.overrides).length
    + (hasKeys(v1.hero) ? 1 : 0)
    + (v1.canvas_examples.order ? 1 : 0);

  function patchInspiration(id: string, patch: Partial<InspirationOverride>) {
    const item = inspirationById.get(id);
    if (!item) return;
    const index = inspirationIndexById.get(id) ?? 0;
    setV1((current) => {
      const next = {
        ...current,
        inspiration: { overrides: { ...current.inspiration.overrides } },
      };
      const compacted = compactInspirationOverride(item, index, {
        ...(current.inspiration.overrides[id] || {}),
        ...patch,
      });
      if (hasKeys(compacted)) next.inspiration.overrides[id] = compacted;
      else delete next.inspiration.overrides[id];
      return next;
    });
  }

  function resetInspiration(id: string) {
    setV1((current) => {
      const overrides = { ...current.inspiration.overrides };
      delete overrides[id];
      return { ...current, inspiration: { overrides } };
    });
  }

  function patchCanvas(id: string, patch: Partial<CanvasExampleOverride>) {
    const example = siteConfig?.canvasExamples.find((item) => item.canvasId === id);
    if (!example) return;
    setV1((current) => {
      const next = {
        ...current,
        canvas_examples: {
          ...current.canvas_examples,
          overrides: { ...current.canvas_examples.overrides },
        },
      };
      const compacted = compactCanvasOverride(example, {
        ...(current.canvas_examples.overrides[id] || {}),
        ...patch,
      }, itemByPath);
      if (hasKeys(compacted)) next.canvas_examples.overrides[id] = compacted;
      else delete next.canvas_examples.overrides[id];
      return next;
    });
  }

  function resetCanvas(id: string) {
    setV1((current) => {
      const overrides = { ...current.canvas_examples.overrides };
      delete overrides[id];
      return { ...current, canvas_examples: { ...current.canvas_examples, overrides } };
    });
  }

  function moveCanvas(id: string, direction: -1 | 1) {
    if (!siteConfig) return;
    setV1((current) => {
      const baseline = siteConfig.canvasExamples.map((item) => item.canvasId);
      const order = [...(current.canvas_examples.order || baseline)];
      const index = order.indexOf(id);
      const target = index + direction;
      if (index < 0 || target < 0 || target >= order.length) return current;
      [order[index], order[target]] = [order[target], order[index]];
      const changed = order.some((value, orderIndex) => value !== baseline[orderIndex]);
      return {
        ...current,
        canvas_examples: {
          ...current.canvas_examples,
          ...(changed ? { order } : { order: undefined }),
        },
      };
    });
  }

  function patchBanner(descriptor: BannerDescriptor, patch: Partial<BannerOverride>) {
    setV1((current) => {
      const overrides = { ...current.banners.overrides };
      const compacted = compactBannerOverride(descriptor.banner, {
        ...(overrides[descriptor.key] || {}),
        ...patch,
      }, itemByPath);
      if (hasKeys(compacted)) overrides[descriptor.key] = compacted;
      else delete overrides[descriptor.key];
      return { ...current, banners: { overrides } };
    });
  }

  function patchHero(patch: Partial<BannerOverride>) {
    if (!siteConfig) return;
    setV1((current) => ({
      ...current,
      hero: compactHeroOverride(siteConfig.heroVideo, { ...current.hero, ...patch }, itemByPath),
    }));
  }

  function assetValue(ref: AssetRef | undefined, baselinePath: string): string {
    const path = ref?.path || baselinePath;
    return assetChoiceByPath.get(path)?.key || "";
  }

  function assetOptions(type: MediaType, currentPath?: string): AssetChoice[] {
    return assetChoices.filter((choice) => choice.mediaType === type || choice.ref.path === currentPath);
  }

  function choiceRef(value: string): AssetRef | undefined {
    const choice = assetChoiceByKey.get(value);
    return choice ? { ...choice.ref } : undefined;
  }

  async function postAction(action: "save-draft" | "publish" | "rollback", fields: JsonRecord): Promise<ConfigResponse | null> {
    setBusy(action);
    setError("");
    setNotice("");
    try {
      const response = await fetch("/api/admin/manju-config", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          action,
          environment: ENVIRONMENT,
          domain: DOMAIN,
          ...(Number.isSafeInteger(config?.storage_generation)
            ? { expected_storage_generation: config?.storage_generation }
            : {}),
          ...fields,
        }),
      });
      const body = await readJson(response) as ConfigResponse;
      if (!response.ok || body.ok === false) throw new Error(describeConfigError(body, "配置操作失败。"));
      return body;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "配置操作失败。");
      return null;
    } finally {
      setBusy("");
    }
  }

  async function saveDraft() {
    if (!siteConfig) return;
    if (!config?.active && drafts.length === 0 && Object.keys(basePayload).length === 0) {
      setError("media 配置域尚无活动版本或草稿。请先初始化并发布基础 media 策略，避免新建展示配置时丢失原字段。");
      return;
    }
    const normalized = normalizeV1(v1, inspiration, siteConfig);
    const issues = validateV1(normalized, inspiration, siteConfig, assetChoices);
    if (issues.length > 0) {
      setError(issues.slice(0, 5).join(" "));
      return;
    }
    const payload = mergeShowcasePayload(basePayload, normalized);
    const byteSize = new TextEncoder().encode(JSON.stringify(payload)).byteLength;
    if (byteSize > MAX_CONFIG_BYTES) {
      setError(`完整 media 配置为 ${byteSize} 字节，超过控制平面 ${MAX_CONFIG_BYTES} 字节上限。请继续保持稀疏覆盖。`);
      return;
    }
    const result = await postAction("save-draft", {
      payload,
      schema_version: schemaVersion,
      ...(selectedDraftId ? { revision_id: selectedDraftId } : {}),
      ...(selectedDraftId && editorBase?.updatedAt ? { expected_updated_at: editorBase.updatedAt } : {}),
    });
    if (!result) return;
    setNotice(`展示配置草稿已保存（${byteSize} 字节）；二进制素材仍留在 public/COS，不进入数据库。`);
    await loadAll({ preserveNotice: true, preferredDraftId: revisionId(result.revision) || selectedDraftId });
  }

  async function publishDraft(record?: ConfigRevision) {
    if (hasUnsavedChanges) {
      setError("当前示例或素材映射尚未保存，请先保存草稿，再发布最新内容。");
      return;
    }
    const targetId = revisionId(record) || selectedDraftId;
    if (!targetId) {
      setError("请先保存或选择一份草稿，再执行发布。");
      return;
    }
    const target = record || drafts.find((item) => revisionId(item) === targetId);
    if (!window.confirm(`确认发布 production/media v${revisionVersion(target)}？只有已发布版本会被前台读取。`)) return;
    const result = await postAction("publish", {
      revision_id: targetId,
      expected_active_release_id: activeReleaseId || null,
    });
    if (!result) return;
    setNotice("展示配置发布成功；活动版本已原子更新。");
    await loadAll({ preserveNotice: true });
  }

  async function rollbackRelease(record: ConfigRevision) {
    if (hasUnsavedChanges) {
      setError("当前示例或素材映射尚未保存，请先保存草稿，再切换发布版本。");
      return;
    }
    const targetReleaseId = releaseId(record);
    if (!targetReleaseId) {
      setError("该历史版本缺少 release_id，无法安全回滚。");
      return;
    }
    if (!window.confirm(`确认回滚到 production/media v${revisionVersion(record)}？系统会新建审计记录。`)) return;
    const result = await postAction("rollback", {
      target_release_id: targetReleaseId,
      expected_active_release_id: activeReleaseId || null,
    });
    if (!result) return;
    setNotice("回滚成功，已重新读取当前活动版本。");
    await loadAll({ preserveNotice: true });
  }

  function chooseDraft(record: ConfigRevision) {
    loadRecord(record, revisionId(record));
    setNotice("已载入所选 media 草稿；保存会保留该草稿中的其他 media 字段。");
  }

  function chooseActive() {
    if (!config?.active) return;
    loadRecord(config.active, "");
    setNotice("已载入当前活动 media 版本作为新草稿起点；原 media 字段会完整保留。");
  }

  async function uploadAdminAsset() {
    if (!uploadFile) {
      setError("请先选择一张图片、一个视频或一个音频文件。");
      return;
    }
    setBusy("asset-upload");
    setError("");
    setNotice("");
    try {
      const formData = new FormData();
      formData.set("file", uploadFile);
      formData.set("title", uploadForm.title || uploadFile.name.replace(/\.[^.]+$/u, ""));
      formData.set("summary", uploadForm.summary);
      formData.set("prompt", uploadForm.prompt);
      formData.set("category", uploadForm.category);
      const response = await fetch("/api/admin/manju-workbench/assets", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: formData,
      });
      const body = await readJson(response) as AdminAssetResponse;
      if (!response.ok || body.ok === false) throw new Error(body.error || "素材上传失败。");
      setNotice("素材已上传并登记；现在会出现在灵感素材和画布/横幅素材选择器中。");
      setUploadFile(null);
      setUploadForm({ title: "", summary: "", prompt: "", category: "image" });
      await loadAll({ preserveNotice: true, preserveEditor: true });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "素材上传失败。");
    } finally {
      setBusy("");
    }
  }

  async function updateAdminAsset(id: string, patch?: Partial<AdminUploadedAsset>) {
    const draft = { ...(assetDrafts[id] || {}), ...(patch || {}) };
    setBusy(`asset-save:${id}`);
    setError("");
    setNotice("");
    try {
      const response = await fetch("/api/admin/manju-workbench/assets", {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ id, ...draft }),
      });
      const body = await readJson(response) as AdminAssetResponse;
      if (!response.ok || body.ok === false) throw new Error(body.error || "素材信息保存失败。");
      setAssetDrafts((current) => {
        const next = { ...current };
        delete next[id];
        return next;
      });
      setNotice("素材信息已保存；公共素材目录已刷新。");
      await loadAll({ preserveNotice: true, preserveEditor: true });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "素材信息保存失败。");
    } finally {
      setBusy("");
    }
  }

  async function replaceAdminAsset(asset: AdminUploadedAsset) {
    const source = uploadedAssets.find((item) => item.id === replacementIds[asset.id]);
    if (!source || source.id === asset.id || source.mediaType !== asset.mediaType || !source.enabled || source.deletedAt) {
      setError("请选择同类型且已启用的替换素材。"); return;
    }
    setBusy("asset-replace:" + asset.id); setError(""); setNotice("");
    try {
      const response = await fetch("/api/admin/manju-workbench/assets", {
        method: "PATCH",
        headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
        body: JSON.stringify({ action: "replace-file", id: asset.id, sourceAssetId: source.id,
          expectedUpdatedAt: asset.updatedAt, expectedSourceUpdatedAt: source.updatedAt }),
      });
      const body = await readJson(response) as AdminAssetResponse;
      if (!response.ok || body.ok === false) throw new Error(body.error || "素材替换失败。");
      setReplacementIds((current) => ({ ...current, [asset.id]: "" }));
      setNotice("文件已替换，原素材链接、标题、提示词和展示配置已保留。");
      await loadAll({ preserveNotice: true, preserveEditor: true });
    } catch (reason) { setError(reason instanceof Error ? reason.message : "素材替换失败。"); }
    finally { setBusy(""); }
  }

  async function deleteAdminAsset(id: string) {
    if (!window.confirm("确认下线这项后台上传素材？这不会硬删除文件本体，但前台不会再把它作为可选展示素材。")) return;
    setBusy(`asset-delete:${id}`);
    setError("");
    setNotice("");
    try {
      const response = await fetch(`/api/admin/manju-workbench/assets?id=${encodeURIComponent(id)}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      const body = await readJson(response) as AdminAssetResponse;
      if (!response.ok || body.ok === false) throw new Error(body.error || "素材下线失败。");
      setNotice("素材已下线；如该素材仍被已发布配置引用，请在 media 配置中替换后重新发布。");
      await loadAll({ preserveNotice: true, preserveEditor: true });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "素材下线失败。");
    } finally {
      setBusy("");
    }
  }

  const tabClass = (value: EditorTab) => `rounded-md px-3 py-2 text-sm ${tab === value
    ? "bg-[var(--primary)] font-semibold text-white"
    : "border border-[var(--border)] text-[var(--foreground)]"}`;
  const fieldClass = "mt-1 w-full rounded-md border border-[var(--border)] bg-[var(--background)] px-3 py-2 text-sm text-[var(--foreground)]";
  const buttonClass = "rounded-md border border-[var(--border)] px-3 py-2 text-sm text-[var(--foreground)] disabled:cursor-not-allowed disabled:opacity-50";

  return (
    <section className="space-y-4 rounded-xl border border-[var(--border)] bg-[var(--card)] p-4" data-admin-section="manju-showcase-catalog">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold text-[var(--foreground)]">展示内容与素材示例</h3>
          <p className="mt-1 max-w-4xl text-xs leading-5 text-[var(--muted-foreground)]">
            管理漫剧工作台的素材、示例和首页展示。上传素材后，设置标题、提示词、排序和启用状态，保存草稿并发布。
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" className={buttonClass} onClick={() => void loadAll({ preserveEditor: true })} disabled={Boolean(busy)}>刷新三方事实源</button>
          <button type="button" className={buttonClass} onClick={() => void saveDraft()} disabled={Boolean(busy) || !siteConfig}>保存草稿</button>
          <button type="button" className="rounded-md bg-[var(--primary)] px-3 py-2 text-sm font-semibold text-white disabled:opacity-50" onClick={() => void publishDraft(selectedDraft)} disabled={Boolean(busy) || !selectedDraftId || hasUnsavedChanges}>发布所选草稿</button>
        </div>
      </header>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-6">
        <article className="rounded-md border border-[var(--border)] bg-[var(--background)] p-3"><small className="text-[var(--muted-foreground)]">灵感素材</small><strong className="mt-1 block text-sm text-[var(--foreground)]">{inspiration.length} 项</strong></article>
        <article className="rounded-md border border-[var(--border)] bg-[var(--background)] p-3"><small className="text-[var(--muted-foreground)]">后台上传</small><strong className="mt-1 block text-sm text-[var(--foreground)]">{uploadedAssets.filter((asset) => asset.enabled && !asset.deletedAt).length} 项</strong></article>
        <article className="rounded-md border border-[var(--border)] bg-[var(--background)] p-3"><small className="text-[var(--muted-foreground)]">画布示例</small><strong className="mt-1 block text-sm text-[var(--foreground)]">{siteConfig?.canvasExamples.length || 0} 项</strong></article>
        <article className="rounded-md border border-[var(--border)] bg-[var(--background)] p-3"><small className="text-[var(--muted-foreground)]">稀疏覆盖</small><strong className="mt-1 block text-sm text-[var(--foreground)]">{overrideCount} 组</strong></article>
        <article className="rounded-md border border-[var(--border)] bg-[var(--background)] p-3"><small className="text-[var(--muted-foreground)]">当前草稿</small><strong className="mt-1 block text-sm text-[var(--foreground)]">{selectedDraftId ? shortId(selectedDraftId) : "新草稿"}</strong></article>
        <article className="rounded-md border border-[var(--border)] bg-[var(--background)] p-3"><small className="text-[var(--muted-foreground)]">存储链路</small><strong className="mt-1 block text-sm text-[var(--foreground)]">{config?.storage_mode === "compat" ? "兼容存储" : config?.storage_mode === "native" ? "原生版本库" : "未读取"}{Number.isSafeInteger(config?.storage_generation) ? ` · G${config?.storage_generation}` : ""}</strong></article>
      </div>

      <div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-xs leading-5 text-[var(--secondary-foreground)]">
        禁止输入任意 URL。所有封面、横幅和主视觉只能从 <code>/api/inspiration</code> 与 <code>/api/site-config</code> 已登记的本站素材中选择；外链、data URL、blob URL 和二进制内容不会写入配置库。删除/下线展示内容请先关闭“前台启用”并发布，确认无页面引用后再从资产仓库做归档。
      </div>

      {error ? <div className="rounded-md border border-red-500/30 bg-red-500/5 p-3 text-sm text-red-600" role="alert"><strong>操作未完成：</strong>{error}</div> : null}
      {notice ? <div className="rounded-md border border-emerald-500/30 bg-emerald-500/5 p-3 text-sm text-emerald-600" role="status">{notice}</div> : null}
      {hasUnsavedChanges ? <p className="text-xs text-amber-600" role="status">当前示例或素材映射尚未保存。素材上传、编辑和刷新会保留这些修改；保存草稿后即可发布。</p> : null}
      {busy === "load" && !siteConfig ? <div className="p-8 text-center text-sm text-[var(--muted-foreground)]">正在读取灵感目录、站点配置和 media 发布记录…</div> : null}

      {siteConfig ? (
        <>
          <nav className="flex flex-wrap gap-2" aria-label="展示内容配置分区">
            <button type="button" className={tabClass("assets")} onClick={() => setTab("assets")}>上传/登记素材</button>
            <button type="button" className={tabClass("inspiration")} onClick={() => setTab("inspiration")}>灵感素材</button>
            <button type="button" className={tabClass("canvas")} onClick={() => setTab("canvas")}>画布示例</button>
            <button type="button" className={tabClass("banners")} onClick={() => setTab("banners")}>横幅与主视觉</button>
            <button type="button" className={tabClass("releases")} onClick={() => setTab("releases")}>草稿、发布与回滚</button>
          </nav>

          {tab === "assets" ? (
            <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(320px,0.8fr)_minmax(0,1.5fr)]">
              <section className="space-y-3 rounded-md border border-[var(--border)] bg-[var(--background)] p-4">
                <div>
                  <h4 className="font-semibold text-[var(--foreground)]">上传并登记参考素材</h4>
                  <p className="mt-1 text-xs leading-5 text-[var(--muted-foreground)]">
                    文件上传到对象存储，配置库只保存 assetId/path。上传完成后会自动进入 <code>/api/inspiration</code>，可在灵感素材、画布示例、横幅与主视觉里选择。
                  </p>
                </div>
                <label className="block text-xs text-[var(--muted-foreground)]">素材文件
                  <input
                    className={fieldClass}
                    type="file"
                    accept="image/*,video/mp4,video/webm,video/quicktime,audio/*"
                    onChange={(event) => {
                      const file = event.target.files?.[0] || null;
                      setUploadFile(file);
                      if (file && !uploadForm.title.trim()) {
                        setUploadForm((current) => ({ ...current, title: file.name.replace(/\.[^.]+$/u, "") }));
                      }
                    }}
                  />
                </label>
                <label className="block text-xs text-[var(--muted-foreground)]">展示标题
                  <input className={fieldClass} maxLength={120} value={uploadForm.title} onChange={(event) => setUploadForm((current) => ({ ...current, title: event.target.value }))} />
                </label>
                <label className="block text-xs text-[var(--muted-foreground)]">分类
                  <select className={fieldClass} value={uploadForm.category} onChange={(event) => setUploadForm((current) => ({ ...current, category: event.target.value }))}>
                    {CATEGORY_OPTIONS.map((category) => <option key={category.value} value={category.value}>{category.label}</option>)}
                  </select>
                </label>
                <label className="block text-xs text-[var(--muted-foreground)]">展示摘要
                  <textarea className={fieldClass} rows={3} maxLength={300} value={uploadForm.summary} onChange={(event) => setUploadForm((current) => ({ ...current, summary: event.target.value }))} />
                </label>
                <label className="block text-xs text-[var(--muted-foreground)]">提示词 / 使用说明
                  <textarea className={`${fieldClass} font-mono text-xs leading-5`} rows={8} maxLength={12_000} value={uploadForm.prompt} onChange={(event) => setUploadForm((current) => ({ ...current, prompt: event.target.value }))} />
                </label>
                <button
                  type="button"
                  className="w-full rounded-md bg-[var(--primary)] px-3 py-2 text-sm font-semibold text-white disabled:opacity-50"
                  disabled={busy === "asset-upload" || !uploadFile}
                  onClick={() => void uploadAdminAsset()}
                >
                  {busy === "asset-upload" ? "上传登记中…" : "上传并登记到素材池"}
                </button>
              </section>

              <section className="space-y-3 rounded-md border border-[var(--border)] bg-[var(--background)] p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <h4 className="font-semibold text-[var(--foreground)]">后台上传素材清单</h4>
                    <p className="mt-1 text-xs text-[var(--muted-foreground)]">可编辑标题、摘要、提示词、分类和启停；删除采用下线，文件本体保留。</p>
                  </div>
                  <button type="button" className={buttonClass} onClick={() => void loadAll()} disabled={Boolean(busy)}>刷新素材池</button>
                </div>
                {uploadedAssets.length === 0 ? (
                  <div className="rounded-md border border-dashed border-[var(--border)] p-8 text-center text-sm text-[var(--muted-foreground)]">
                    暂无后台上传素材。上传第一项后，它会同时出现在前台素材事实目录和本页选择器中。
                  </div>
                ) : null}
                <div className="max-h-[720px] space-y-3 overflow-auto pr-1">
                  {uploadedAssets.map((asset) => {
                    const draft = assetDrafts[asset.id] || {};
                    const disabled = Boolean(busy && busy !== `asset-save:${asset.id}` && busy !== `asset-delete:${asset.id}`);
                    return (
                      <article key={asset.id} className={`space-y-3 rounded-md border p-3 ${asset.enabled && !asset.deletedAt ? "border-[var(--border)] bg-[var(--card)]" : "border-amber-500/30 bg-amber-500/5"}`}>
                        <div className="flex flex-wrap items-start justify-between gap-2">
                          <div>
                            <strong className="text-sm text-[var(--foreground)]">{asset.title}</strong>
                            <p className="mt-1 break-all text-xs text-[var(--muted-foreground)]">{asset.id} · {asset.path}</p>
                          </div>
                          <span className="rounded-full bg-[var(--secondary)] px-2 py-1 text-[11px] text-[var(--secondary-foreground)]">{asset.mediaType} · {asset.category}</span>
                        </div>
                        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
                          <label className="block text-xs text-[var(--muted-foreground)]">标题
                            <input className={fieldClass} maxLength={120} value={draft.title ?? asset.title} onChange={(event) => setAssetDrafts((current) => ({ ...current, [asset.id]: { ...(current[asset.id] || {}), title: event.target.value } }))} />
                          </label>
                          <label className="block text-xs text-[var(--muted-foreground)]">分类
                            <select className={fieldClass} value={draft.category ?? asset.category} onChange={(event) => setAssetDrafts((current) => ({ ...current, [asset.id]: { ...(current[asset.id] || {}), category: event.target.value } }))}>
                              {CATEGORY_OPTIONS.map((category) => <option key={category.value} value={category.value}>{category.label}</option>)}
                            </select>
                          </label>
                        </div>
                        <label className="block text-xs text-[var(--muted-foreground)]">摘要
                          <textarea className={fieldClass} rows={2} maxLength={300} value={draft.summary ?? asset.summary} onChange={(event) => setAssetDrafts((current) => ({ ...current, [asset.id]: { ...(current[asset.id] || {}), summary: event.target.value } }))} />
                        </label>
                        <label className="block text-xs text-[var(--muted-foreground)]">提示词 / 使用说明
                          <textarea className={`${fieldClass} font-mono text-xs leading-5`} rows={5} maxLength={12_000} value={draft.prompt ?? asset.prompt} onChange={(event) => setAssetDrafts((current) => ({ ...current, [asset.id]: { ...(current[asset.id] || {}), prompt: event.target.value } }))} />
                        </label>
                        {!asset.deletedAt ? (
                          <div className="space-y-2 rounded-md border border-[var(--border)] p-3">
                            <label className="block text-xs text-[var(--muted-foreground)]">替换文件
                              <select aria-label={"替换文件：" + asset.title} className={fieldClass} value={replacementIds[asset.id] || ""}
                                disabled={Boolean(busy)} onChange={(event) => setReplacementIds((current) => ({ ...current, [asset.id]: event.target.value }))}>
                                <option value="">选择已上传的同类型素材</option>
                                {uploadedAssets.filter((item) => item.id !== asset.id && item.mediaType === asset.mediaType && item.enabled && !item.deletedAt)
                                  .map((item) => <option key={item.id} value={item.id}>{item.title} · {item.filename}</option>)}
                              </select>
                            </label>
                            <p className="text-xs text-[var(--muted-foreground)]">先上传新文件，再在这里替换。原素材链接和展示配置会保留。</p>
                            <button type="button" className={buttonClass} disabled={Boolean(busy) || !replacementIds[asset.id]}
                              onClick={() => void replaceAdminAsset(asset)}>{busy === "asset-replace:" + asset.id ? "替换中…" : "替换文件"}</button>
                          </div>
                        ) : null}
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <label className="flex items-center gap-2 text-sm text-[var(--foreground)]">
                            <input
                              type="checkbox"
                              checked={draft.enabled ?? asset.enabled}
                              onChange={(event) => setAssetDrafts((current) => ({ ...current, [asset.id]: { ...(current[asset.id] || {}), enabled: event.target.checked } }))}
                            />
                            前台素材池启用
                          </label>
                          <div className="flex flex-wrap gap-2">
                            <button type="button" className={buttonClass} disabled={disabled || busy === `asset-save:${asset.id}`} onClick={() => void updateAdminAsset(asset.id)}>
                              {busy === `asset-save:${asset.id}` ? "保存中…" : "保存素材信息"}
                            </button>
                            <button type="button" className="rounded-md border border-red-500/30 px-3 py-2 text-sm text-red-600 disabled:opacity-50" disabled={disabled || busy === `asset-delete:${asset.id}` || Boolean(asset.deletedAt)} onClick={() => void deleteAdminAsset(asset.id)}>
                              {asset.deletedAt ? "已下线" : busy === `asset-delete:${asset.id}` ? "下线中…" : "下线素材"}
                            </button>
                          </div>
                        </div>
                      </article>
                    );
                  })}
                </div>
              </section>
            </div>
          ) : null}

          {tab === "inspiration" ? (
            <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(280px,0.8fr)_minmax(0,1.7fr)]">
              <aside className="rounded-md border border-[var(--border)] bg-[var(--background)] p-3">
                <label className="text-xs text-[var(--muted-foreground)]">搜索 {inspiration.length} 项事实目录
                  <input className={fieldClass} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="ID、标题、摘要、提示词、分类" />
                </label>
                <div className="mt-3 max-h-[620px] space-y-2 overflow-auto pr-1">
                  {filteredInspiration.map((item) => {
                    const changed = Boolean(v1.inspiration.overrides[item.id]);
                    return (
                      <button key={item.id} type="button" className={`w-full rounded-md border p-3 text-left ${selectedInspirationId === item.id ? "border-[var(--primary)] bg-[var(--accent)]" : "border-[var(--border)] bg-[var(--card)]"}`} onClick={() => setSelectedInspirationId(item.id)}>
                        <span className="flex items-center justify-between gap-2"><strong className="line-clamp-2 text-sm text-[var(--foreground)]">{item.metadata.title}</strong>{changed ? <em className="shrink-0 rounded bg-amber-500/10 px-2 py-0.5 text-[10px] not-italic text-amber-600">已覆盖</em> : null}</span>
                        <small className="mt-1 block text-[var(--muted-foreground)]">{item.type} · {item.category} · {shortId(item.id)}</small>
                      </button>
                    );
                  })}
                </div>
              </aside>

              {selectedInspiration ? (
                <article className="space-y-3 rounded-md border border-[var(--border)] bg-[var(--background)] p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div><h4 className="font-semibold text-[var(--foreground)]">{selectedInspiration.metadata.title}</h4><p className="mt-1 break-all text-xs text-[var(--muted-foreground)]">{selectedInspiration.id} · {selectedInspiration.url}</p></div>
                    <button type="button" className={buttonClass} onClick={() => resetInspiration(selectedInspiration.id)} disabled={!v1.inspiration.overrides[selectedInspiration.id]}>恢复目录原值</button>
                  </div>
                  <label className="flex items-center gap-2 text-sm text-[var(--foreground)]"><input type="checkbox" checked={selectedInspirationOverride.enabled ?? true} onChange={(event) => patchInspiration(selectedInspiration.id, { enabled: event.target.checked })} />前台启用</label>
                  <label className="block text-xs text-[var(--muted-foreground)]">展示标题
                    <input className={fieldClass} maxLength={160} value={selectedInspirationOverride.title ?? selectedInspiration.metadata.title} onChange={(event) => patchInspiration(selectedInspiration.id, { title: event.target.value })} />
                  </label>
                  <label className="block text-xs text-[var(--muted-foreground)]">展示摘要
                    <textarea className={fieldClass} rows={3} maxLength={500} value={selectedInspirationOverride.summary ?? selectedInspiration.metadata.summary} onChange={(event) => patchInspiration(selectedInspiration.id, { summary: event.target.value })} />
                  </label>
                  <label className="block text-xs text-[var(--muted-foreground)]">提示词
                    <textarea className={`${fieldClass} font-mono text-xs leading-5`} rows={10} maxLength={12_000} value={selectedInspirationOverride.prompt ?? selectedInspiration.prompt} onChange={(event) => patchInspiration(selectedInspiration.id, { prompt: event.target.value })} />
                  </label>
                  <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                    <label className="block text-xs text-[var(--muted-foreground)]">分类
                      <select className={fieldClass} value={selectedInspirationOverride.category ?? selectedInspiration.category} onChange={(event) => patchInspiration(selectedInspiration.id, { category: event.target.value })}>{categories.map((category) => <option key={category} value={category}>{category}</option>)}</select>
                    </label>
                    <label className="block text-xs text-[var(--muted-foreground)]">排序值
                      <input className={fieldClass} type="number" min={0} max={100_000} step={1} value={selectedInspirationOverride.sortOrder ?? selectedInspirationIndex} onChange={(event) => patchInspiration(selectedInspiration.id, { sortOrder: Number(event.target.value) })} />
                    </label>
                  </div>
                </article>
              ) : <div className="rounded-md border border-dashed border-[var(--border)] p-8 text-center text-sm text-[var(--muted-foreground)]">请选择一项素材。</div>}
            </div>
          ) : null}

          {tab === "canvas" ? (
            <div className="grid grid-cols-1 gap-4 xl:grid-cols-[360px_minmax(0,1fr)]">
              <aside className="space-y-2 rounded-md border border-[var(--border)] bg-[var(--background)] p-3">
                {canvasOrder.map((id, index) => {
                  const example = siteConfig.canvasExamples.find((item) => item.canvasId === id);
                  if (!example) return null;
                  return (
                    <article key={id} className={`rounded-md border p-3 ${selectedCanvasId === id ? "border-[var(--primary)] bg-[var(--accent)]" : "border-[var(--border)] bg-[var(--card)]"}`}>
                      <button type="button" className="w-full text-left" onClick={() => setSelectedCanvasId(id)}><strong className="text-sm text-[var(--foreground)]">{index + 1}. {v1.canvas_examples.overrides[id]?.title || example.title}</strong><small className="mt-1 block text-[var(--muted-foreground)]">{shortId(id)}</small></button>
                      <div className="mt-2 grid grid-cols-2 gap-2"><button type="button" className={buttonClass} onClick={() => moveCanvas(id, -1)} disabled={index === 0}>上移</button><button type="button" className={buttonClass} onClick={() => moveCanvas(id, 1)} disabled={index === canvasOrder.length - 1}>下移</button></div>
                    </article>
                  );
                })}
              </aside>
              {selectedCanvas ? (
                <article className="space-y-3 rounded-md border border-[var(--border)] bg-[var(--background)] p-4">
                  <div className="flex items-center justify-between gap-2"><h4 className="font-semibold text-[var(--foreground)]">{selectedCanvas.title}</h4><button type="button" className={buttonClass} onClick={() => resetCanvas(selectedCanvas.canvasId)} disabled={!v1.canvas_examples.overrides[selectedCanvas.canvasId]}>恢复示例原值</button></div>
                  <p className="break-all text-xs text-[var(--muted-foreground)]">{selectedCanvas.canvasId}</p>
                  <label className="flex items-center gap-2 text-sm text-[var(--foreground)]"><input type="checkbox" checked={selectedCanvasOverride.enabled ?? true} onChange={(event) => patchCanvas(selectedCanvas.canvasId, { enabled: event.target.checked })} />前台启用</label>
                  <label className="block text-xs text-[var(--muted-foreground)]">标题<input className={fieldClass} maxLength={160} value={selectedCanvasOverride.title ?? selectedCanvas.title} onChange={(event) => patchCanvas(selectedCanvas.canvasId, { title: event.target.value })} /></label>
                  <label className="block text-xs text-[var(--muted-foreground)]">标签<input className={fieldClass} maxLength={80} value={selectedCanvasOverride.tag ?? selectedCanvas.tag ?? ""} onChange={(event) => patchCanvas(selectedCanvas.canvasId, { tag: event.target.value })} /></label>
                  <label className="block text-xs text-[var(--muted-foreground)]">封面（仅已登记本站图片）
                    <select className={fieldClass} value={assetValue(selectedCanvasOverride.cover, selectedCanvas.coverImage)} onChange={(event) => patchCanvas(selectedCanvas.canvasId, { cover: choiceRef(event.target.value) })}>
                      {assetOptions("image", selectedCanvasOverride.cover?.path || selectedCanvas.coverImage).map((choice) => <option key={choice.key} value={choice.key}>{choice.label}</option>)}
                    </select>
                  </label>
                  <p className="break-all rounded-md bg-[var(--card)] p-3 text-xs text-[var(--muted-foreground)]">当前封面：{selectedCanvasOverride.cover?.path || selectedCanvas.coverImage}</p>
                </article>
              ) : null}
            </div>
          ) : null}

          {tab === "banners" ? (
            <div className="space-y-4">
              <article className="space-y-3 rounded-md border border-[var(--border)] bg-[var(--background)] p-4">
                <h4 className="font-semibold text-[var(--foreground)]">首页主视觉</h4>
                <label className="flex items-center gap-2 text-sm text-[var(--foreground)]"><input type="checkbox" checked={v1.hero.enabled ?? siteConfig.heroVideo.enabled ?? true} onChange={(event) => patchHero({ enabled: event.target.checked })} />前台启用</label>
                <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
                  <label className="block text-xs text-[var(--muted-foreground)]">主素材
                    <select className={fieldClass} value={assetValue(v1.hero.asset, siteConfig.heroVideo.url)} onChange={(event) => patchHero({ asset: choiceRef(event.target.value) })}>{assetOptions(siteConfig.heroVideo.type, v1.hero.asset?.path || siteConfig.heroVideo.url).map((choice) => <option key={choice.key} value={choice.key}>{choice.label}</option>)}</select>
                  </label>
                  <label className="block text-xs text-[var(--muted-foreground)]">海报
                    <select className={fieldClass} value={assetValue(v1.hero.poster, siteConfig.heroVideo.poster || "")} onChange={(event) => patchHero({ poster: choiceRef(event.target.value) })}>{assetOptions("image", v1.hero.poster?.path || siteConfig.heroVideo.poster).map((choice) => <option key={choice.key} value={choice.key}>{choice.label}</option>)}</select>
                  </label>
                </div>
              </article>
              <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
                {banners.map((descriptor) => {
                  const override = v1.banners.overrides[descriptor.key] || {};
                  return (
                    <article key={descriptor.key} className="space-y-3 rounded-md border border-[var(--border)] bg-[var(--background)] p-4">
                      <div><h4 className="font-semibold text-[var(--foreground)]">{descriptor.group} · 横幅 {descriptor.index + 1}</h4><p className="mt-1 text-xs text-[var(--muted-foreground)]">链接保持为 {descriptor.banner.link || "无"}，本组件不接受任意链接输入。</p></div>
                      <label className="flex items-center gap-2 text-sm text-[var(--foreground)]"><input type="checkbox" checked={override.enabled ?? descriptor.banner.enabled ?? true} onChange={(event) => patchBanner(descriptor, { enabled: event.target.checked })} />前台启用</label>
                      <label className="block text-xs text-[var(--muted-foreground)]">横幅素材
                        <select className={fieldClass} value={assetValue(override.asset, descriptor.banner.url)} onChange={(event) => patchBanner(descriptor, { asset: choiceRef(event.target.value) })}>{assetOptions(descriptor.banner.type, override.asset?.path || descriptor.banner.url).map((choice) => <option key={choice.key} value={choice.key}>{choice.label}</option>)}</select>
                      </label>
                      {descriptor.banner.type === "video" && descriptor.banner.poster ? (
                        <label className="block text-xs text-[var(--muted-foreground)]">视频海报
                          <select className={fieldClass} value={assetValue(override.poster, descriptor.banner.poster)} onChange={(event) => patchBanner(descriptor, { poster: choiceRef(event.target.value) })}>{assetOptions("image", override.poster?.path || descriptor.banner.poster).map((choice) => <option key={choice.key} value={choice.key}>{choice.label}</option>)}</select>
                        </label>
                      ) : null}
                    </article>
                  );
                })}
              </div>
            </div>
          ) : null}

          {tab === "releases" ? (
            <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
              <section className="rounded-md border border-emerald-500/30 bg-emerald-500/5 p-4">
                <h4 className="font-semibold text-[var(--foreground)]">当前活动 media</h4>
                {config?.active ? <><p className="mt-3 text-sm text-[var(--secondary-foreground)]">v{revisionVersion(config.active)} · {recordTime(config.active)}</p><p className="mt-1 text-xs text-[var(--muted-foreground)]">Release {shortId(activeReleaseId)}</p><button type="button" className={`${buttonClass} mt-3 w-full`} onClick={chooseActive}>作为新草稿起点</button></> : <p className="mt-3 text-xs text-[var(--muted-foreground)]">尚无活动版本；为防丢失基础 media 字段，本组件会阻止从空对象直接保存。</p>}
              </section>
              <section className="rounded-md border border-[var(--border)] bg-[var(--background)] p-4">
                <h4 className="font-semibold text-[var(--foreground)]">草稿</h4>
                <div className="mt-3 max-h-96 space-y-2 overflow-auto">
                  {drafts.length === 0 ? <p className="text-xs text-[var(--muted-foreground)]">暂无草稿。</p> : null}
                  {drafts.map((record) => {
                    const id = revisionId(record);
                    return <article key={id} className={`rounded-md border p-3 ${id === selectedDraftId ? "border-[var(--primary)] bg-[var(--accent)]" : "border-[var(--border)] bg-[var(--card)]"}`}><strong className="text-sm text-[var(--foreground)]">v{revisionVersion(record)}</strong><p className="mt-1 text-xs text-[var(--muted-foreground)]">{recordTime(record)} · {shortId(id)}</p><div className="mt-2 grid grid-cols-2 gap-2"><button type="button" className={buttonClass} onClick={() => chooseDraft(record)} disabled={Boolean(busy)}>编辑</button><button type="button" className="rounded-md bg-[var(--primary)] px-3 py-2 text-sm text-white disabled:opacity-50" onClick={() => void publishDraft(record)} disabled={Boolean(busy) || hasUnsavedChanges}>发布</button></div></article>;
                  })}
                </div>
              </section>
              <section className="rounded-md border border-[var(--border)] bg-[var(--background)] p-4">
                <h4 className="font-semibold text-[var(--foreground)]">发布与回滚历史</h4>
                <div className="mt-3 max-h-96 space-y-2 overflow-auto">
                  {history.length === 0 ? <p className="text-xs text-[var(--muted-foreground)]">暂无发布历史。</p> : null}
                  {history.map((record) => {
                    const id = releaseId(record);
                    const active = Boolean(id && id === activeReleaseId);
                    return <article key={id || `${revisionVersion(record)}-${recordTime(record)}`} className="rounded-md border border-[var(--border)] bg-[var(--card)] p-3"><span className="flex items-center justify-between gap-2"><strong className="text-sm text-[var(--foreground)]">v{revisionVersion(record)}</strong><small className="text-[var(--muted-foreground)]">{active ? "当前活动" : record.status || "历史"}</small></span><p className="mt-1 text-xs text-[var(--muted-foreground)]">{recordTime(record)} · {shortId(id)}</p><button type="button" className={`${buttonClass} mt-2 w-full`} onClick={() => void rollbackRelease(record)} disabled={active || Boolean(busy)}>{active ? "当前版本" : "回滚到此版本"}</button></article>;
                  })}
                </div>
              </section>
            </div>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
