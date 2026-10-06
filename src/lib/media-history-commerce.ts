import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SignJWT, jwtVerify } from "jose";

import { getJwtSecretString } from "@/lib/auth";
import { isUserAccountDisabled } from "@/lib/user-account-status";
import { getSupabaseClient } from "@/storage/database/supabase-client";

export type MediaHistoryCommerceRole = "admin" | "student";
export type MediaHistoryCommerceKind = "image" | "video";
export type MediaHistoryCommerceStatus = "queued" | "processing" | "completed" | "failed" | "cancelled";

export type MediaHistoryCommercePreview = {
  available: boolean;
  kind: MediaHistoryCommerceKind;
  path: string;
  thumbnailPath: string;
  delivery: "bearer" | "ticket" | "none";
};

export type MediaHistoryCommerceItem = {
  id: string;
  kind: MediaHistoryCommerceKind;
  title: string;
  project: string;
  segment: string;
  source: string;
  sourcePath: string;
  retryPath: string;
  categoryKey: "commerce-agent";
  removable: false;
  status: MediaHistoryCommerceStatus;
  createdAt: string;
  completedAt: string | null;
  publicModelName: string;
  cost: number | null;
  costNote: string;
  previewPath: string;
  thumbnailPath: string;
  downloadPath: string;
  preview: MediaHistoryCommercePreview;
  errorMessage: string;
  aspectRatio: string;
  durationSeconds: number | null;
};

export type MediaHistoryCommerceAsset = {
  id: string;
  owner: string;
  name: string;
  type: string;
  size: number;
  createdAt: number;
  source: "upload" | "generated";
  jobId?: string;
  filePath: string;
};

type StoredBinding = {
  mainUserId?: string;
  mainRole?: "admin" | "user";
  exempt?: boolean;
};

type ForwardBinding = {
  mainUserId?: string;
  commerceOwnerId?: string;
};

type StoredAsset = Omit<MediaHistoryCommerceAsset, "filePath"> & {
  sha256?: string;
};

type StoredJob = {
  id?: string;
  owner?: string;
  input?: {
    kind?: string;
    prompt?: string;
    purpose?: string;
    aspectRatio?: string;
    duration?: number;
  };
  model?: { displayName?: string };
  route?: { label?: string };
  status?: string;
  createdAt?: number;
  updatedAt?: number;
  error?: string;
  assetIds?: string[];
  billing?: { amount?: number; status?: string };
};

type SqliteRow = { id?: unknown; owner?: unknown; value?: unknown; updated?: unknown };

const ASSET_ID = /^[A-Za-z0-9._-]{1,180}$/u;
const TICKET_TTL_SECONDS = 15 * 60;

function commerceDataDirectory(): string {
  const configured = String(process.env.COMMERCE_DATA_DIR || "").trim();
  if (configured && !path.isAbsolute(configured)) throw new Error("COMMERCE_DATA_DIR_MUST_BE_ABSOLUTE");
  return path.resolve(configured || path.join(process.cwd(), "runtime"));
}

function commerceDatabasePath(): string {
  return path.join(commerceDataDirectory(), "commerce.sqlite");
}

function assetFilePath(assetId: string): string | null {
  if (!ASSET_ID.test(assetId)) return null;
  const directory = path.resolve(commerceDataDirectory(), "assets");
  const target = path.resolve(directory, assetId);
  return path.dirname(target) === directory ? target : null;
}

function withReadonlyDatabase<T>(fallback: T, read: (database: DatabaseSync) => T): T {
  const databasePath = commerceDatabasePath();
  if (!existsSync(databasePath)) return fallback;
  const ReadonlyDatabase = DatabaseSync as unknown as new (
    filename: string,
    options: { readOnly: boolean },
  ) => DatabaseSync & { close?: () => void };
  const database = new ReadonlyDatabase(databasePath, { readOnly: true });
  try {
    const table = database.prepare("SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name='records'").get();
    return table ? read(database) : fallback;
  } finally {
    database.close?.();
  }
}

function parseJson<T>(value: unknown): T | null {
  try {
    return typeof value === "string" ? JSON.parse(value) as T : null;
  } catch {
    return null;
  }
}

function setting<T>(database: DatabaseSync, id: string): T | null {
  const row = database.prepare(
    "SELECT value FROM records WHERE bucket='settings' AND id=? AND owner='system' LIMIT 1",
  ).get(id) as SqliteRow | undefined;
  return parseJson<T>(row?.value);
}

function forwardBindingKey(mainUserId: string): string {
  return `main-user-map-${createHash("sha256").update(mainUserId).digest("hex")}`;
}

function bindingMatchesAccount(binding: StoredBinding | null, mainUserId: string, role: MediaHistoryCommerceRole): boolean {
  if (!binding || binding.mainUserId !== mainUserId) return false;
  const bindingIsAdmin = binding.mainRole ? binding.mainRole === "admin" : binding.exempt === true;
  return bindingIsAdmin === (role === "admin");
}

function boundCommerceOwners(database: DatabaseSync, mainUserId: string, role: MediaHistoryCommerceRole): string[] {
  const forward = setting<ForwardBinding>(database, forwardBindingKey(mainUserId));
  const forwardOwner = String(forward?.commerceOwnerId || "").trim();
  if (forward?.mainUserId === mainUserId && forwardOwner) {
    const reverse = setting<StoredBinding>(database, `main-bind-${forwardOwner}`);
    if (bindingMatchesAccount(reverse, mainUserId, role)) return [forwardOwner];
    throw new Error("COMMERCE_ACCOUNT_BINDING_MISMATCH");
  }

  const rows = database.prepare(
    "SELECT id,value FROM records WHERE bucket='settings' AND owner='system' AND id LIKE 'main-bind-%' ORDER BY updated DESC",
  ).all() as SqliteRow[];
  const owners: string[] = [];
  for (const row of rows) {
    const id = String(row.id || "");
    const binding = parseJson<StoredBinding>(row.value);
    if (!id.startsWith("main-bind-") || binding?.mainUserId !== mainUserId) continue;
    if (!bindingMatchesAccount(binding, mainUserId, role)) {
      throw new Error("COMMERCE_ACCOUNT_BINDING_ROLE_MISMATCH");
    }
    const owner = id.slice("main-bind-".length).trim();
    if (owner) owners.push(owner);
  }
  const uniqueOwners = [...new Set(owners)];
  // A legacy reverse-only mapping is accepted only when it identifies exactly
  // one owner. Duplicate/stale mappings must fail closed instead of widening
  // the current account's readable Commerce asset set.
  if (uniqueOwners.length > 1) throw new Error("COMMERCE_ACCOUNT_BINDING_AMBIGUOUS");
  return uniqueOwners;
}

function readRows(database: DatabaseSync, bucket: "jobs" | "assets", owner: string): SqliteRow[] {
  return database.prepare(
    "SELECT id,owner,value,updated FROM records WHERE bucket=? AND owner=? ORDER BY updated DESC,id DESC",
  ).all(bucket, owner) as SqliteRow[];
}

function persistedAsset(value: StoredAsset | null, expectedOwner: string): MediaHistoryCommerceAsset | null {
  if (!value || value.owner !== expectedOwner || !ASSET_ID.test(String(value.id || ""))) return null;
  const type = String(value.type || "").toLowerCase();
  if (!type.startsWith("image/") && !type.startsWith("video/")) return null;
  const target = assetFilePath(value.id);
  if (!target) return null;
  try {
    const file = statSync(target);
    if (!file.isFile() || !Number.isSafeInteger(value.size) || value.size <= 0 || file.size !== value.size) return null;
  } catch {
    return null;
  }
  return { ...value, type, filePath: target };
}

function mediaKind(type: string): MediaHistoryCommerceKind {
  return type.startsWith("video/") ? "video" : "image";
}

function safeEpoch(value: unknown, fallback = 0): number {
  const epoch = Number(value);
  return Number.isFinite(epoch) && epoch > 0 ? epoch : fallback;
}

function isoTime(value: unknown, fallback = 0): string {
  const epoch = safeEpoch(value, fallback);
  return epoch > 0 ? new Date(epoch).toISOString() : "";
}

function commerceStatus(value: string, deliveryReady: boolean): MediaHistoryCommerceStatus {
  if (value === "queued") return "queued";
  if (["running", "processing", "saving", "unknown"].includes(value)) return "processing";
  if (value === "succeeded") return deliveryReady ? "completed" : "failed";
  return "failed";
}

function finiteNumber(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function previewFor(kind: MediaHistoryCommerceKind, assetId: string, available: boolean): MediaHistoryCommercePreview {
  const target = available ? `/api/media-history/commerce/content/${encodeURIComponent(assetId)}` : "";
  return {
    available,
    kind,
    path: target,
    thumbnailPath: kind === "image" ? target : "",
    delivery: available ? (kind === "video" ? "ticket" : "bearer") : "none",
  };
}

function itemFromJob(job: StoredJob, asset: MediaHistoryCommerceAsset | null, owner: string): MediaHistoryCommerceItem | null {
  const jobId = String(job.id || "").trim();
  const inputKind = String(job.input?.kind || "");
  if (!jobId || job.owner !== owner || (inputKind !== "image" && inputKind !== "video")) return null;
  const kind = inputKind as MediaHistoryCommerceKind;
  if (asset && mediaKind(asset.type) !== kind) return null;
  const deliveryReady = Boolean(asset);
  const status = commerceStatus(String(job.status || ""), deliveryReady);
  const routeLabel = String(job.route?.label || "").trim();
  const purpose = String(job.input?.purpose || "").trim();
  const defaultLabel = kind === "image" ? "带货图片任务" : "带货视频任务";
  const label = routeLabel || purpose || defaultLabel;
  const title = String(asset?.name || "").trim() || label;
  const preview = previewFor(kind, asset?.id || "", status === "completed" && deliveryReady);
  const createdAt = safeEpoch(job.createdAt, asset?.createdAt || 0);
  const updatedAt = safeEpoch(job.updatedAt, createdAt);
  const terminal = ["succeeded", "failed", "save_failed"].includes(String(job.status || ""));
  const amount = finiteNumber(job.billing?.amount);
  return {
    id: asset ? `commerce:job:${jobId}:asset:${asset.id}` : `commerce:job:${jobId}`,
    kind,
    title,
    project: "带货 Agent",
    segment: label,
    source: "带货 Agent",
    sourcePath: "/commerce",
    retryPath: "",
    categoryKey: "commerce-agent",
    removable: false,
    status,
    createdAt: isoTime(createdAt),
    completedAt: terminal ? isoTime(updatedAt, createdAt) : null,
    publicModelName: String(job.model?.displayName || "带货 Agent 模型"),
    cost: amount,
    costNote: amount === null ? "账单未关联" : "带货 Agent 任务实际费用",
    previewPath: preview.path,
    thumbnailPath: preview.thumbnailPath,
    downloadPath: preview.available ? `${preview.path}?download=1` : "",
    preview,
    errorMessage: status === "failed"
      ? String(job.status || "") === "succeeded"
        ? "任务已完成，但结果资产未持久化，暂不可预览或下载。"
        : "带货 Agent 任务未完成，请返回来源页面查看并重试。"
      : "",
    aspectRatio: String(job.input?.aspectRatio || ""),
    durationSeconds: kind === "video" ? finiteNumber(job.input?.duration) : null,
  };
}

function itemFromOrphanAsset(asset: MediaHistoryCommerceAsset): MediaHistoryCommerceItem {
  const kind = mediaKind(asset.type);
  const preview = previewFor(kind, asset.id, true);
  return {
    id: `commerce:asset:${asset.id}`,
    kind,
    title: asset.name || (kind === "image" ? "带货图片" : "带货视频"),
    project: "带货 Agent",
    segment: kind === "image" ? "已保存图片" : "已保存视频",
    source: "带货 Agent",
    sourcePath: "/commerce",
    retryPath: "",
    categoryKey: "commerce-agent",
    removable: false,
    status: "completed",
    createdAt: isoTime(asset.createdAt),
    completedAt: isoTime(asset.createdAt),
    publicModelName: "原记录未标注",
    cost: null,
    costNote: "原资产未建立任务与账单的一对一关联",
    previewPath: preview.path,
    thumbnailPath: preview.thumbnailPath,
    downloadPath: `${preview.path}?download=1`,
    preview,
    errorMessage: "",
    aspectRatio: "",
    durationSeconds: null,
  };
}

function loadOwnerItems(database: DatabaseSync, owner: string): MediaHistoryCommerceItem[] {
  const assets = new Map<string, MediaHistoryCommerceAsset>();
  const assetIdsByJob = new Map<string, string[]>();
  for (const row of readRows(database, "assets", owner)) {
    const asset = persistedAsset(parseJson<StoredAsset>(row.value), owner);
    if (!asset) continue;
    assets.set(asset.id, asset);
    if (asset.jobId) assetIdsByJob.set(asset.jobId, [...(assetIdsByJob.get(asset.jobId) || []), asset.id]);
  }

  const seenAssets = new Set<string>();
  const items: MediaHistoryCommerceItem[] = [];
  for (const row of readRows(database, "jobs", owner)) {
    const job = parseJson<StoredJob>(row.value);
    if (!job) continue;
    const kind = String(job.input?.kind || "");
    if (kind !== "image" && kind !== "video") continue;
    const matchingAssets = [...new Set([
      ...(Array.isArray(job.assetIds) ? job.assetIds : []),
      ...(assetIdsByJob.get(String(job.id || "")) || []),
    ])]
      .map(id => assets.get(String(id)))
      .filter((asset): asset is MediaHistoryCommerceAsset => asset !== undefined && mediaKind(asset.type) === kind);
    if (matchingAssets.length) {
      for (const asset of matchingAssets) {
        if (seenAssets.has(asset.id)) continue;
        const item = itemFromJob(job, asset, owner);
        if (item) items.push(item);
        seenAssets.add(asset.id);
      }
    } else {
      const item = itemFromJob(job, null, owner);
      if (item) items.push(item);
    }
  }

  for (const asset of assets.values()) {
    if (asset.source !== "generated" || seenAssets.has(asset.id)) continue;
    items.push(itemFromOrphanAsset(asset));
  }
  return items;
}

export function loadCommerceMediaHistory(mainUserId: string, role: MediaHistoryCommerceRole): {
  items: MediaHistoryCommerceItem[];
  bound: boolean;
  failed: boolean;
} {
  try {
    return withReadonlyDatabase<{
      items: MediaHistoryCommerceItem[];
      bound: boolean;
      failed: boolean;
    }>({ items: [], bound: false, failed: true }, database => {
      const owners = boundCommerceOwners(database, mainUserId, role);
      if (!owners.length) return { items: [], bound: false, failed: false };
      return {
        items: owners.flatMap(owner => loadOwnerItems(database, owner)),
        bound: true,
        failed: false,
      };
    });
  } catch {
    return { items: [], bound: false, failed: true };
  }
}

export function findCommerceMediaHistoryAsset(
  mainUserId: string,
  role: MediaHistoryCommerceRole,
  assetId: string,
  expectedOwner?: string,
): MediaHistoryCommerceAsset | null {
  if (!ASSET_ID.test(assetId)) return null;
  try {
    return withReadonlyDatabase<MediaHistoryCommerceAsset | null>(null, database => {
      const owners = boundCommerceOwners(database, mainUserId, role);
      for (const owner of owners) {
        if (expectedOwner && owner !== expectedOwner) continue;
        const row = database.prepare(
          "SELECT value FROM records WHERE bucket='assets' AND id=? AND owner=? LIMIT 1",
        ).get(assetId, owner) as SqliteRow | undefined;
        const asset = persistedAsset(parseJson<StoredAsset>(row?.value), owner);
        if (asset) return asset;
      }
      return null;
    });
  } catch {
    return null;
  }
}

type CommerceMediaTicketPayload = {
  purpose: "media-history-commerce";
  userId: string;
  role: MediaHistoryCommerceRole;
  owner: string;
  assetId: string;
  scope: "playback" | "download";
};

function mediaTicketSecret(): Uint8Array {
  return new Uint8Array(createHash("sha256")
    .update(`${getJwtSecretString()}:media-history-commerce:v1`)
    .digest());
}

export async function createCommerceMediaHistoryTicket(input: Omit<CommerceMediaTicketPayload, "purpose">): Promise<string> {
  return new SignJWT({ purpose: "media-history-commerce", ...input } satisfies CommerceMediaTicketPayload)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${TICKET_TTL_SECONDS}s`)
    .sign(mediaTicketSecret());
}

export async function verifyCommerceMediaHistoryTicket(
  ticket: string,
  expected: { assetId: string; scope: "playback" | "download" },
): Promise<Omit<CommerceMediaTicketPayload, "purpose" | "scope" | "assetId"> & { assetId: string } | null> {
  try {
    const { payload } = await jwtVerify(ticket, mediaTicketSecret());
    if (
      payload.purpose !== "media-history-commerce"
      || payload.assetId !== expected.assetId
      || payload.scope !== expected.scope
      || typeof payload.userId !== "string"
      || typeof payload.owner !== "string"
      || (payload.role !== "admin" && payload.role !== "student")
    ) return null;
    const { data: user, error } = await getSupabaseClient().from("users")
      .select("id,role,status,is_active")
      .eq("id", payload.userId)
      .maybeSingle();
    if (error || !user || isUserAccountDisabled(user)) return null;
    const currentRole: MediaHistoryCommerceRole = user.role === "admin" ? "admin" : "student";
    if (currentRole !== payload.role) return null;
    return {
      userId: user.id,
      role: currentRole,
      owner: payload.owner,
      assetId: expected.assetId,
    };
  } catch {
    return null;
  }
}

export const MEDIA_HISTORY_COMMERCE_TICKET_TTL_SECONDS = TICKET_TTL_SECONDS;
