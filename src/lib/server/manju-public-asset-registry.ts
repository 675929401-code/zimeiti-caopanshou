import "server-only";

import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { StorageProviderType } from "@/storage/object";
import { resolveAppDataFile } from "@/lib/runtime-paths";

export type ManjuPublicAssetMediaType = "image" | "video" | "audio";
export type ManjuPublicAssetCategory =
  | "character"
  | "scene"
  | "prop"
  | "style"
  | "shot"
  | "film"
  | "music"
  | "voice"
  | "audio"
  | "sound-effect"
  | "image"
  | "video"
  | "other";

export interface ManjuPublicAssetRecord {
  id: string;
  path: string;
  storageProvider: StorageProviderType;
  storageKey: string;
  contentType: string;
  size: number;
  mediaType: ManjuPublicAssetMediaType;
  category: ManjuPublicAssetCategory;
  title: string;
  summary: string;
  prompt: string;
  filename: string;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  enabled: boolean;
  deletedAt: string | null;
  source: "manju-admin-upload";
}

interface ManjuPublicAssetRegistry {
  schemaVersion: 1;
  kind: "manju-public-assets";
  updatedAt: string;
  assets: ManjuPublicAssetRecord[];
}

export interface RegisterManjuPublicAssetInput {
  storageProvider: StorageProviderType;
  storageKey: string;
  contentType: string;
  size: number;
  title: string;
  summary?: string;
  prompt?: string;
  filename: string;
  createdBy: string;
  category?: ManjuPublicAssetCategory;
}

export type UpdateManjuPublicAssetInput = Partial<
  Pick<ManjuPublicAssetRecord, "title" | "summary" | "prompt" | "category" | "enabled">
>;

const REGISTRY_KIND = "manju-public-assets";
const DEFAULT_REGISTRY_NAME = "manju-public-assets.v1.json";
const ASSET_ID_PATTERN = /^manju-[a-z0-9][a-z0-9_-]{8,120}$/u;
const SAFE_STORAGE_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_./-]{0,511}$/u;
const CATEGORY_VALUES: readonly ManjuPublicAssetCategory[] = [
  "character",
  "scene",
  "prop",
  "style",
  "shot",
  "film",
  "music",
  "voice",
  "audio",
  "sound-effect",
  "image",
  "video",
  "other",
];

const CATEGORY_SET = new Set(CATEGORY_VALUES);

function registryPath(): string {
  const configured = process.env.MANJU_PUBLIC_ASSET_REGISTRY_PATH?.trim();
  if (configured) {
    if (!path.isAbsolute(configured)) {
      throw new Error("MANJU_PUBLIC_ASSET_REGISTRY_PATH must be an absolute path");
    }
    return path.resolve(/* turbopackIgnore: true */ configured);
  }
  return resolveAppDataFile(DEFAULT_REGISTRY_NAME);
}

function emptyRegistry(): ManjuPublicAssetRegistry {
  return {
    schemaVersion: 1,
    kind: REGISTRY_KIND,
    updatedAt: new Date(0).toISOString(),
    assets: [],
  };
}

function publicPathFor(id: string): string {
  return `/api/youcai/public-assets/${id}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function boolValue(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function numberValue(value: unknown): number {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : 0;
}

function categoryValue(value: unknown, fallback: ManjuPublicAssetCategory): ManjuPublicAssetCategory {
  return typeof value === "string" && CATEGORY_SET.has(value as ManjuPublicAssetCategory)
    ? value as ManjuPublicAssetCategory
    : fallback;
}

export function inferManjuPublicAssetMediaType(contentType: string): ManjuPublicAssetMediaType {
  const normalized = contentType.split(";", 1)[0]?.trim().toLowerCase() || "";
  if (normalized.startsWith("video/")) return "video";
  if (normalized.startsWith("audio/")) return "audio";
  return "image";
}

export function defaultManjuPublicAssetCategory(
  mediaType: ManjuPublicAssetMediaType,
): ManjuPublicAssetCategory {
  if (mediaType === "video") return "video";
  if (mediaType === "audio") return "audio";
  return "image";
}

function safeText(value: unknown, fallback: string, maximum: number): string {
  const raw = typeof value === "string" ? value : fallback;
  return raw.replace(/\s+/g, " ").trim().slice(0, maximum) || fallback;
}

function safeLongText(value: unknown, fallback: string, maximum: number): string {
  const raw = typeof value === "string" ? value : fallback;
  return raw.replace(/\r\n/g, "\n").trim().slice(0, maximum) || fallback;
}

function normalizeRecord(value: unknown): ManjuPublicAssetRecord | null {
  if (!isRecord(value)) return null;
  const id = stringValue(value.id);
  if (!ASSET_ID_PATTERN.test(id)) return null;
  const storageKey = stringValue(value.storageKey);
  if (!SAFE_STORAGE_KEY_PATTERN.test(storageKey) || storageKey.includes("..")) return null;
  const mediaType = inferManjuPublicAssetMediaType(stringValue(value.contentType));
  const createdAt = stringValue(value.createdAt, new Date(0).toISOString());
  const updatedAt = stringValue(value.updatedAt, createdAt);
  return {
    id,
    path: publicPathFor(id),
    storageProvider: stringValue(value.storageProvider) === "tencent_cos"
      ? "tencent_cos"
      : stringValue(value.storageProvider) === "coze_s3"
        ? "coze_s3"
        : "local",
    storageKey,
    contentType: stringValue(value.contentType, mediaType === "video" ? "video/mp4" : mediaType === "audio" ? "audio/mpeg" : "image/png"),
    size: numberValue(value.size),
    mediaType,
    category: categoryValue(value.category, defaultManjuPublicAssetCategory(mediaType)),
    title: safeText(value.title, "后台上传素材", 120),
    summary: safeText(value.summary, "漫剧工作台后台上传并登记的公开素材。", 300),
    prompt: safeLongText(value.prompt, "该素材由管理员上传，可作为漫剧工作台展示、参考图或画布示例素材。", 12_000),
    filename: safeText(value.filename, "asset", 180),
    createdAt,
    updatedAt,
    createdBy: safeText(value.createdBy, "admin", 160),
    enabled: boolValue(value.enabled, true),
    deletedAt: typeof value.deletedAt === "string" ? value.deletedAt : null,
    source: "manju-admin-upload",
  };
}

function parseRegistry(raw: unknown): ManjuPublicAssetRegistry {
  if (!isRecord(raw) || raw.schemaVersion !== 1 || raw.kind !== REGISTRY_KIND || !Array.isArray(raw.assets)) {
    throw new Error("manju public asset registry contract mismatch");
  }
  const assets = raw.assets
    .map(normalizeRecord)
    .filter((asset): asset is ManjuPublicAssetRecord => Boolean(asset));
  return {
    schemaVersion: 1,
    kind: REGISTRY_KIND,
    updatedAt: stringValue(raw.updatedAt, new Date(0).toISOString()),
    assets,
  };
}

function readRegistry(): ManjuPublicAssetRegistry {
  const filePath = registryPath();
  if (!fs.existsSync(/* turbopackIgnore: true */ filePath)) return emptyRegistry();
  const raw = fs.readFileSync(/* turbopackIgnore: true */ filePath, "utf8");
  return parseRegistry(JSON.parse(raw));
}

function writeRegistry(registry: ManjuPublicAssetRegistry): void {
  const filePath = registryPath();
  const directory = path.dirname(filePath);
  fs.mkdirSync(/* turbopackIgnore: true */ directory, { recursive: true });
  const temporaryPath = path.join(
    /* turbopackIgnore: true */ directory,
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`,
  );
  const serialized = `${JSON.stringify(registry, null, 2)}\n`;
  fs.writeFileSync(/* turbopackIgnore: true */ temporaryPath, serialized, { encoding: "utf8", flag: "wx" });
  fs.renameSync(/* turbopackIgnore: true */ temporaryPath, filePath);
}

function nextAssetId(storageKey: string): string {
  const digest = createHash("sha256").update(`${storageKey}:${randomUUID()}`, "utf8").digest("hex").slice(0, 16);
  return `manju-${digest}`;
}


export class ManjuAssetMutationError extends Error {
  constructor(public readonly code: string, public readonly status: number, message: string) {
    super(message);
    this.name = "ManjuAssetMutationError";
  }
}

function withRegistryMutation<T>(operation: () => T): T {
  const lockPath = registryPath() + ".lock";
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  let lock: number;
  try { lock = fs.openSync(lockPath, "wx", 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new ManjuAssetMutationError("ASSET_REGISTRY_BUSY", 503, "素材目录正在更新，请稍后重试");
    }
    throw error;
  }
  try {
    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
    return operation();
  } finally {
    fs.closeSync(lock);
    fs.unlinkSync(lockPath);
  }
}

export function replaceManjuPublicAssetFile(
  id: string,
  sourceAssetId: string,
  expectedUpdatedAt: string,
  expectedSourceUpdatedAt: string,
): ManjuPublicAssetRecord {
  return withRegistryMutation(() => {
    const registry = readRegistry();
    const index = registry.assets.findIndex((asset) => asset.id === id);
    const current = registry.assets[index];
    const source = registry.assets.find((asset) => asset.id === sourceAssetId);
    if (!current || current.deletedAt) throw new ManjuAssetMutationError("ASSET_NOT_FOUND", 404, "原素材不存在或已下线");
    if (!source || !source.enabled || source.deletedAt) throw new ManjuAssetMutationError("SOURCE_ASSET_UNAVAILABLE", 404, "替换素材不存在或已下线");
    if (current.id === source.id) throw new ManjuAssetMutationError("SAME_ASSET", 400, "请选择其他素材作为替换文件");
    if (current.updatedAt !== expectedUpdatedAt || source.updatedAt !== expectedSourceUpdatedAt) {
      throw new ManjuAssetMutationError("ASSET_VERSION_CONFLICT", 409, "素材已被更新，请刷新素材池后重新选择");
    }
    if (current.mediaType !== source.mediaType) throw new ManjuAssetMutationError("ASSET_TYPE_MISMATCH", 400, "替换文件必须与原素材类型相同");
    const now = new Date(Math.max(Date.now(), (Date.parse(current.updatedAt) || 0) + 1)).toISOString();
    const next: ManjuPublicAssetRecord = {
      ...current,
      storageProvider: source.storageProvider,
      storageKey: source.storageKey,
      contentType: source.contentType,
      size: source.size,
      filename: source.filename,
      updatedAt: now,
    };
    registry.assets[index] = next;
    registry.updatedAt = now;
    writeRegistry(registry);
    return next;
  });
}

export function listManjuPublicAssetsSync(options?: { includeDisabled?: boolean }): readonly ManjuPublicAssetRecord[] {
  const registry = readRegistry();
  const includeDisabled = options?.includeDisabled === true;
  return Object.freeze(
    registry.assets
      .filter((asset) => includeDisabled || (asset.enabled && !asset.deletedAt))
      .map((asset) => Object.freeze({ ...asset })),
  );
}

export function getManjuPublicAssetByIdSync(id: string): ManjuPublicAssetRecord | null {
  if (!ASSET_ID_PATTERN.test(id)) return null;
  return listManjuPublicAssetsSync({ includeDisabled: true }).find((asset) => asset.id === id) ?? null;
}

export function registerManjuPublicAsset(input: RegisterManjuPublicAssetInput): ManjuPublicAssetRecord {
  return withRegistryMutation(() => {
    const mediaType = inferManjuPublicAssetMediaType(input.contentType);
    const now = new Date().toISOString();
    const registry = readRegistry();
    const id = nextAssetId(input.storageKey);
    const record: ManjuPublicAssetRecord = {
      id,
      path: publicPathFor(id),
      storageProvider: input.storageProvider,
      storageKey: input.storageKey,
      contentType: input.contentType,
      size: input.size,
      mediaType,
      category: input.category ?? defaultManjuPublicAssetCategory(mediaType),
      title: safeText(input.title, input.filename || "后台上传素材", 120),
      summary: safeText(input.summary, "漫剧工作台后台上传并登记的公开素材。", 300),
      prompt: safeLongText(input.prompt, "该素材由管理员上传，可作为漫剧工作台展示、参考图或画布示例素材。", 12_000),
      filename: safeText(input.filename, "asset", 180),
      createdAt: now,
      updatedAt: now,
      createdBy: safeText(input.createdBy, "admin", 160),
      enabled: true,
      deletedAt: null,
      source: "manju-admin-upload",
    };
    if (registry.assets.length >= 1_000) throw new ManjuAssetMutationError("ASSET_REGISTRY_FULL", 409, "素材目录已达到容量上限，请先整理素材");
    registry.assets = [record, ...registry.assets];
    registry.updatedAt = now;
    writeRegistry(registry);
    return record;
  });
}

export function updateManjuPublicAsset(
  id: string,
  patch: UpdateManjuPublicAssetInput,
): ManjuPublicAssetRecord | null {
  return withRegistryMutation(() => {
    const registry = readRegistry();
    const index = registry.assets.findIndex((asset) => asset.id === id);
    if (index < 0) return null;
    const current = registry.assets[index];
    const now = new Date(Math.max(Date.now(), (Date.parse(registry.assets[index].updatedAt) || 0) + 1)).toISOString();
    const next: ManjuPublicAssetRecord = {
      ...current,
      ...(patch.title !== undefined ? { title: safeText(patch.title, current.title, 120) } : {}),
      ...(patch.summary !== undefined ? { summary: safeText(patch.summary, current.summary, 300) } : {}),
      ...(patch.prompt !== undefined ? { prompt: safeLongText(patch.prompt, current.prompt, 12_000) } : {}),
      ...(patch.category !== undefined ? { category: categoryValue(patch.category, current.category) } : {}),
      ...(patch.enabled !== undefined ? { enabled: Boolean(patch.enabled), deletedAt: patch.enabled ? null : current.deletedAt } : {}),
      updatedAt: now,
    };
    registry.assets[index] = next;
    registry.updatedAt = now;
    writeRegistry(registry);
    return next;
  });
}

export function softDeleteManjuPublicAsset(id: string): ManjuPublicAssetRecord | null {
  return withRegistryMutation(() => {
    const registry = readRegistry();
    const index = registry.assets.findIndex((asset) => asset.id === id);
    if (index < 0) return null;
    const now = new Date(Math.max(Date.now(), (Date.parse(registry.assets[index].updatedAt) || 0) + 1)).toISOString();
    const next = { ...registry.assets[index], enabled: false, deletedAt: now, updatedAt: now };
    registry.assets[index] = next;
    registry.updatedAt = now;
    writeRegistry(registry);
    return next;
  });
}

export function getManjuPublicAssetRegistryPath(): string {
  return registryPath();
}
