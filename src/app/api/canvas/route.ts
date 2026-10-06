import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { getTokenFromHeaders, verifyToken } from "@/lib/auth";
import { WorkflowEdgeSchema, WorkflowNodeSchema } from "@/lib/workflow-schema";
import { storageManager } from "@/storage/object";
import type { StorageProviderType } from "@/storage/object";
import { getSupabaseClient } from "@/storage/database/supabase-client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 4 * 1024 * 1024;
const MAX_PAGE_SIZE = 100;
const CANVAS_ID = /^canvas:[0-9a-f-]{36}$/iu;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9:_-]{16,160}$/u;

const ViewportSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  zoom: z.number().finite().min(0.05).max(8),
}).strict();

const CanvasDocumentSchema = z.object({
  schemaVersion: z.literal(1),
  session: z.object({
    id: z.string().regex(CANVAS_ID),
    name: z.string().trim().min(1).max(160),
    sourceReferenceId: z.string().max(240).optional(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    nodes: z.array(z.unknown()).max(500),
    edges: z.array(z.unknown()).max(2_000),
    storyboardSettings: z.unknown().optional(),
  }).passthrough(),
  viewport: ViewportSchema,
  runHistory: z.array(z.unknown()).max(100),
  diagnostics: z.array(z.unknown()).max(500),
}).passthrough();

const SaveSchema = z.object({
  action: z.literal("save"),
  canvasId: z.string().regex(CANVAS_ID),
  expectedRevision: z.number().int().nonnegative(),
  idempotencyKey: z.string().regex(IDEMPOTENCY_KEY),
  document: CanvasDocumentSchema,
}).strict();

const CopySchema = z.object({
  action: z.literal("copy"),
  sourceCanvasId: z.string().regex(CANVAS_ID),
  name: z.string().trim().min(1).max(160).optional(),
  idempotencyKey: z.string().regex(IDEMPOTENCY_KEY),
}).strict();

const DeleteSchema = z.object({
  canvasId: z.string().regex(CANVAS_ID),
  expectedRevision: z.number().int().positive(),
  idempotencyKey: z.string().regex(IDEMPOTENCY_KEY),
}).strict();

type JsonObject = Record<string, unknown>;
type OwnedAsset = {
  id: string;
  storage_key: string;
  storage_provider: StorageProviderType;
};

function noStore(body: unknown, init?: ResponseInit) {
  const headers = new Headers(init?.headers);
  headers.set("Cache-Control", "private, no-store");
  return Response.json(body, { ...init, headers });
}

function pageInteger(value: string | null, fallback: number, minimum: number, maximum: number) {
  if (value === null || value.trim() === "") return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : fallback;
}

async function requireUser(request: Request) {
  const token = getTokenFromHeaders(request.headers);
  return token ? verifyToken(token) : null;
}

function isMigrationMissing(error: unknown) {
  const record = error && typeof error === "object" ? error as { code?: string; message?: string } : {};
  const text = `${record.code || ""} ${record.message || ""}`;
  return /PGRST202|PGRST205|42P01|42883|schema cache|canvas_documents|save_canvas_document_atomic|CANVAS_SERVICE_ROLE_MISSING/iu.test(text);
}

function apiFailure(error: unknown) {
  const record = error && typeof error === "object" ? error as { code?: string; message?: string } : {};
  const message = String(record.message || "");
  if (isMigrationMissing(error)) {
    return noStore({ error: "画布服务端存储尚未启用", code: "MIGRATION_NOT_READY" }, { status: 503 });
  }
  if (/CANVAS_REVISION_CONFLICT/u.test(message)) {
    const currentRevision = Number(message.split(":").at(-1));
    return noStore({
      error: "画布已被其他页面更新，请刷新后再保存",
      code: "REVISION_CONFLICT",
      currentRevision: Number.isSafeInteger(currentRevision) ? currentRevision : undefined,
    }, { status: 409 });
  }
  if (/CANVAS_IDEMPOTENCY_CONFLICT/u.test(message)) {
    return noStore({ error: "幂等键已用于不同的画布请求", code: "IDEMPOTENCY_CONFLICT" }, { status: 409 });
  }
  if (/CANVAS_NOT_FOUND/u.test(message)) {
    return noStore({ error: "画布不存在或无权访问", code: "CANVAS_NOT_FOUND" }, { status: 404 });
  }
  console.error("[canvas/persistence] failed", record.code || "UNKNOWN");
  return noStore({ error: "画布服务端存储失败", code: "CANVAS_STORAGE_FAILED" }, { status: 500 });
}

function encodeStablePart(value: string) {
  return Buffer.from(value, "utf8").toString("base64url");
}

function decodeStablePart(value: string) {
  return Buffer.from(value, "base64url").toString("utf8");
}

function objectUri(asset: OwnedAsset) {
  return `object://${asset.storage_provider}/${encodeStablePart(asset.storage_key)}`;
}

function publicUri(path: string) {
  return `app-public://${encodeStablePart(path)}`;
}

function isPlainObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function getCanvasDatabase() {
  const db = getSupabaseClient();
  if (!process.env.COZE_SUPABASE_SERVICE_ROLE_KEY) throw new Error("CANVAS_SERVICE_ROLE_MISSING");
  return db;
}

function collectAssetIds(value: unknown, result = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    value.forEach((item) => collectAssetIds(item, result));
    return result;
  }
  if (!isPlainObject(value)) return result;
  if (typeof value.assetId === "string" && value.assetId.trim()) result.add(value.assetId.trim());
  Object.values(value).forEach((item) => collectAssetIds(item, result));
  return result;
}

async function loadOwnedAssets(ownerId: string, ids: Set<string>) {
  if (ids.size === 0) return new Map<string, OwnedAsset>();
  if (ids.size > 1_000) throw new Error("CANVAS_ASSET_LIMIT_EXCEEDED");
  const db = getCanvasDatabase();
  const lookup = await db
    .from("user_files")
    .select("id,storage_key,storage_provider")
    .eq("user_id", ownerId)
    .in("id", [...ids]);
  if (lookup.error) throw lookup.error;
  const assets = new Map<string, OwnedAsset>();
  for (const row of (lookup.data || []) as OwnedAsset[]) assets.set(String(row.id), row);
  if (assets.size !== ids.size) throw new Error("CANVAS_ASSET_NOT_OWNED");
  return assets;
}

function assertNoEmbeddedPayload(value: unknown): void {
  if (typeof value === "string") {
    if (/(?:^|["'\s])(?:data|blob):/iu.test(value.trim())) throw new Error("CANVAS_EMBEDDED_MEDIA_FORBIDDEN");
    return;
  }
  if (Array.isArray(value)) {
    value.forEach(assertNoEmbeddedPayload);
    return;
  }
  if (isPlainObject(value)) Object.values(value).forEach(assertNoEmbeddedPayload);
}

function stableDocumentValue(value: unknown, assets: Map<string, OwnedAsset>): unknown {
  if (Array.isArray(value)) return value.map((item) => stableDocumentValue(item, assets));
  if (!isPlainObject(value)) return value;

  const result: JsonObject = {};
  const assetId = typeof value.assetId === "string" ? value.assetId.trim() : "";
  const asset = assetId ? assets.get(assetId) : undefined;
  for (const [key, item] of Object.entries(value)) {
    if (key === "pendingPersistUrl" || key === "providerContentUrl") {
      result[key] = "";
      continue;
    }
    if (key === "outputUrl" && typeof item === "string" && item) {
      if (asset) {
        result[key] = objectUri(asset);
      } else if (item.startsWith("/")) {
        result[key] = publicUri(item);
      } else if (/^(?:object|app-public):\/\//iu.test(item)) {
        result[key] = item;
      } else {
        throw new Error("CANVAS_TEMPORARY_MEDIA_FORBIDDEN");
      }
      continue;
    }
    if ((key === "clientRequestFingerprint" || key === "imageRequestFingerprint")
      && typeof item === "string" && /(?:https?:\/\/|(?:data|blob):)/iu.test(item)) {
      throw new Error("CANVAS_TEMPORARY_MEDIA_FORBIDDEN");
    }
    if (key === "storageKey" && typeof item === "string" && item) {
      if (!asset) throw new Error("CANVAS_ASSET_NOT_OWNED");
      const stable = objectUri(asset);
      if (item !== asset.storage_key && item !== stable) throw new Error("CANVAS_ASSET_KEY_MISMATCH");
      result[key] = stable;
      continue;
    }
    result[key] = stableDocumentValue(item, assets);
  }
  return result;
}

async function hydrateDocumentValue(value: unknown, assets: Map<string, OwnedAsset>, signedUrls: Map<string, string>): Promise<unknown> {
  if (Array.isArray(value)) return Promise.all(value.map((item) => hydrateDocumentValue(item, assets, signedUrls)));
  if (!isPlainObject(value)) {
    if (typeof value === "string" && value.startsWith("app-public://")) return decodeStablePart(value.slice("app-public://".length));
    return value;
  }

  const result: JsonObject = {};
  const assetId = typeof value.assetId === "string" ? value.assetId.trim() : "";
  const asset = assetId ? assets.get(assetId) : undefined;
  for (const [key, item] of Object.entries(value)) {
    if (key === "outputUrl" && typeof item === "string") {
      if (item.startsWith("object://")) {
        if (!asset) throw new Error("CANVAS_ASSET_NOT_OWNED");
        let signed = signedUrls.get(asset.id);
        if (!signed) {
          signed = await storageManager.getSignedUrl(asset.storage_key, { expireTime: 60 * 60 }, asset.storage_provider);
          if (!signed) throw new Error("CANVAS_MEDIA_ACCESS_URL_MISSING");
          signedUrls.set(asset.id, signed);
        }
        result[key] = signed;
      } else if (item.startsWith("app-public://")) {
        result[key] = decodeStablePart(item.slice("app-public://".length));
      } else {
        result[key] = item;
      }
      continue;
    }
    if (key === "storageKey" && typeof item === "string" && item.startsWith("object://")) {
      if (!asset) throw new Error("CANVAS_ASSET_NOT_OWNED");
      result[key] = asset.storage_key;
      continue;
    }
    result[key] = await hydrateDocumentValue(item, assets, signedUrls);
  }
  return result;
}

function validateDocument(document: z.infer<typeof CanvasDocumentSchema>, canvasId: string) {
  if (document.session.id !== canvasId) throw new Error("CANVAS_DOCUMENT_ID_MISMATCH");
  for (const node of document.session.nodes) {
    if (!WorkflowNodeSchema.safeParse(node).success) throw new Error("CANVAS_NODE_INVALID");
  }
  for (const edge of document.session.edges) {
    if (!WorkflowEdgeSchema.safeParse(edge).success) throw new Error("CANVAS_EDGE_INVALID");
  }
  assertNoEmbeddedPayload(document);
}

async function stableDocument(ownerId: string, document: z.infer<typeof CanvasDocumentSchema>, canvasId: string) {
  validateDocument(document, canvasId);
  const assets = await loadOwnedAssets(ownerId, collectAssetIds(document));
  return stableDocumentValue(document, assets) as JsonObject;
}

async function hydratedDocument(ownerId: string, document: unknown) {
  const assets = await loadOwnedAssets(ownerId, collectAssetIds(document));
  return hydrateDocumentValue(document, assets, new Map<string, string>());
}

function requestHash(value: unknown) {
  const normalize = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(normalize);
    if (!isPlainObject(item)) return item;
    return Object.fromEntries(Object.entries(item).map(([key, nested]) => [
      key,
      key === "createdAt" || key === "updatedAt" ? "" : normalize(nested),
    ]));
  };
  return createHash("sha256").update(JSON.stringify(normalize(value)), "utf8").digest("hex");
}

async function parseJsonBody(request: Request) {
  const declared = Number(request.headers.get("content-length") || 0);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw new Error("CANVAS_BODY_TOO_LARGE");
  const raw = await request.text();
  if (Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) throw new Error("CANVAS_BODY_TOO_LARGE");
  return JSON.parse(raw) as unknown;
}

async function saveAtomic(args: {
  ownerId: string;
  canvasId: string;
  expectedRevision: number;
  idempotencyKey: string;
  name: string;
  document: JsonObject;
  operation: "save" | "copy";
  hash: string;
}) {
  const db = getCanvasDatabase();
  const result = await db.rpc("save_canvas_document_atomic", {
    p_owner_id: args.ownerId,
    p_canvas_id: args.canvasId,
    p_expected_revision: args.expectedRevision,
    p_idempotency_key: args.idempotencyKey,
    p_operation: args.operation,
    p_request_hash: args.hash,
    p_name: args.name,
    p_document: args.document,
  });
  if (result.error) throw result.error;
  const row = Array.isArray(result.data) ? result.data[0] : result.data;
  if (!row?.canvas_id) throw new Error("CANVAS_SAVE_EMPTY_RESULT");
  return row as {
    canvas_id: string;
    canvas_name: string;
    canvas_revision: number;
    canvas_created_at: string;
    canvas_updated_at: string;
    idempotent_replay: boolean;
  };
}

async function readOwnedCanvas(ownerId: string, canvasId: string) {
  const db = getCanvasDatabase();
  const lookup = await db
    .from("canvas_documents")
    .select("id,name,revision,document,created_at,updated_at")
    .eq("id", canvasId)
    .eq("owner_id", ownerId)
    .eq("deleted", false)
    .maybeSingle();
  if (lookup.error) throw lookup.error;
  return lookup.data || null;
}

function canvasSummary(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    name: String(row.name),
    revision: Number(row.revision),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export async function GET(request: Request) {
  const user = await requireUser(request);
  if (!user) return noStore({ error: "请先登录", code: "UNAUTHORIZED" }, { status: 401 });
  const url = new URL(request.url);
  const canvasId = url.searchParams.get("canvasId")?.trim() || "";
  try {
    if (canvasId) {
      if (!CANVAS_ID.test(canvasId)) return noStore({ error: "画布编号无效" }, { status: 400 });
      const row = await readOwnedCanvas(user.userId, canvasId);
      if (!row) return noStore({ error: "画布不存在或无权访问" }, { status: 404 });
      return noStore({
        canvas: {
          ...canvasSummary(row),
          document: await hydratedDocument(user.userId, row.document),
        },
      });
    }

    const includeDocuments = url.searchParams.get("includeDocuments") === "1";
    const limit = pageInteger(url.searchParams.get("limit"), 50, 1, MAX_PAGE_SIZE);
    const offset = pageInteger(url.searchParams.get("offset"), 0, 0, 1_000_000);
    const db = getCanvasDatabase();
    const lookup = await db
      .from("canvas_documents")
      .select(
        includeDocuments ? "id,name,revision,document,created_at,updated_at" : "id,name,revision,created_at,updated_at",
        { count: "exact" },
      )
      .eq("owner_id", user.userId)
      .eq("deleted", false)
      .order("updated_at", { ascending: false })
      .range(offset, offset + limit - 1);
    if (lookup.error) throw lookup.error;
    const canvases = await Promise.all((lookup.data || []).map(async (row: Record<string, unknown>) => ({
      ...canvasSummary(row),
      ...(includeDocuments ? { document: await hydratedDocument(user.userId, row.document) } : {}),
    })));
    const total = Number(lookup.count) || canvases.length;
    const nextOffset = offset + canvases.length;
    return noStore({
      canvases,
      pagination: {
        offset,
        limit,
        total,
        nextOffset: nextOffset < total ? nextOffset : null,
      },
    });
  } catch (error) {
    return apiFailure(error);
  }
}

export async function POST(request: Request) {
  const user = await requireUser(request);
  if (!user) return noStore({ error: "请先登录", code: "UNAUTHORIZED" }, { status: 401 });
  try {
    const body = await parseJsonBody(request);
    const save = SaveSchema.safeParse(body);
    if (save.success) {
      const document = await stableDocument(user.userId, save.data.document, save.data.canvasId);
      const row = await saveAtomic({
        ownerId: user.userId,
        canvasId: save.data.canvasId,
        expectedRevision: save.data.expectedRevision,
        idempotencyKey: save.data.idempotencyKey,
        name: save.data.document.session.name,
        document,
        operation: "save",
        hash: requestHash({ ...save.data, document }),
      });
      return noStore({
        canvas: {
          id: row.canvas_id,
          name: row.canvas_name,
          revision: Number(row.canvas_revision),
          createdAt: row.canvas_created_at,
          updatedAt: row.canvas_updated_at,
        },
        idempotentReplay: Boolean(row.idempotent_replay),
      });
    }

    const copy = CopySchema.safeParse(body);
    if (!copy.success) return noStore({ error: "画布保存参数无效", details: save.error.issues.slice(0, 3) }, { status: 400 });
    const source = await readOwnedCanvas(user.userId, copy.data.sourceCanvasId);
    if (!source) return noStore({ error: "源画布不存在或无权访问" }, { status: 404 });
    const now = new Date().toISOString();
    const targetCanvasId = `canvas:${randomUUID()}`;
    const copied = structuredClone(source.document) as JsonObject;
    const session = isPlainObject(copied.session) ? copied.session : {};
    const copyName = copy.data.name || `${String(source.name)} 副本`;
    copied.session = { ...session, id: targetCanvasId, name: copyName, createdAt: now, updatedAt: now };
    for (const key of ["runHistory", "diagnostics"] as const) {
      if (!Array.isArray(copied[key])) continue;
      copied[key] = (copied[key] as unknown[]).map((entry) => isPlainObject(entry) ? { ...entry, canvasId: targetCanvasId } : entry);
    }
    const row = await saveAtomic({
      ownerId: user.userId,
      canvasId: targetCanvasId,
      expectedRevision: 0,
      idempotencyKey: copy.data.idempotencyKey,
      name: copyName,
      document: copied,
      operation: "copy",
      hash: requestHash({ action: "copy", sourceCanvasId: copy.data.sourceCanvasId, name: copyName }),
    });
    const created = await readOwnedCanvas(user.userId, row.canvas_id);
    if (!created) throw new Error("CANVAS_COPY_READBACK_MISSING");
    return noStore({
      canvas: {
        ...canvasSummary(created),
        document: await hydratedDocument(user.userId, created.document),
      },
      idempotentReplay: Boolean(row.idempotent_replay),
    }, { status: row.idempotent_replay ? 200 : 201 });
  } catch (error) {
    if (error instanceof SyntaxError) return noStore({ error: "请求 JSON 无效" }, { status: 400 });
    const message = error instanceof Error ? error.message : "";
    if (/CANVAS_BODY_TOO_LARGE/u.test(message)) return noStore({ error: "画布文档超过 4MB 上限" }, { status: 413 });
    if (/CANVAS_(?:DOCUMENT_ID_MISMATCH|NODE_INVALID|EDGE_INVALID)/u.test(message)) return noStore({ error: "画布文档结构无效" }, { status: 400 });
    if (/CANVAS_(?:EMBEDDED_MEDIA_FORBIDDEN|TEMPORARY_MEDIA_FORBIDDEN)/u.test(message)) {
      return noStore({ error: "画布含 data URL、blob URL 或未转存的临时外链", code: "STABLE_ASSET_REQUIRED" }, { status: 422 });
    }
    if (/CANVAS_(?:ASSET_NOT_OWNED|ASSET_KEY_MISMATCH)/u.test(message)) {
      return noStore({ error: "画布素材缺少当前账号的永久资产记录", code: "ASSET_OWNERSHIP_REQUIRED" }, { status: 422 });
    }
    return apiFailure(error);
  }
}

export async function DELETE(request: Request) {
  const user = await requireUser(request);
  if (!user) return noStore({ error: "请先登录", code: "UNAUTHORIZED" }, { status: 401 });
  try {
    const parsed = DeleteSchema.safeParse(await parseJsonBody(request));
    if (!parsed.success) return noStore({ error: "删除画布参数无效" }, { status: 400 });
    const hash = requestHash({ action: "delete", ...parsed.data });
    const db = getCanvasDatabase();
    const result = await db.rpc("delete_canvas_document_atomic", {
      p_owner_id: user.userId,
      p_canvas_id: parsed.data.canvasId,
      p_expected_revision: parsed.data.expectedRevision,
      p_idempotency_key: parsed.data.idempotencyKey,
      p_request_hash: hash,
    });
    if (result.error) throw result.error;
    const row = Array.isArray(result.data) ? result.data[0] : result.data;
    return noStore({ deleted: true, canvasId: row?.canvas_id || parsed.data.canvasId, idempotentReplay: Boolean(row?.idempotent_replay) });
  } catch (error) {
    if (error instanceof SyntaxError) return noStore({ error: "请求 JSON 无效" }, { status: 400 });
    return apiFailure(error);
  }
}
