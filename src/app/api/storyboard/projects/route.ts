import { createHash } from "node:crypto";
import { z } from "zod";
import { withAuth } from "@/lib/api-middleware";
import type { SupabaseClient } from "@supabase/supabase-js";
import { StoryboardProjectDocument, StoryboardProjectId, deriveStoryboardSubmittedAt, sortStoryboardProjectsBySubmission } from "@/lib/storyboard-project-contract";
import {
  collectStoryboardVideoTaskIds,
  findStoryboardVideoTask,
  normalizeStoryboardVideoTaskStatus,
  reconcileStoryboardProjectVideoTasks,
  shouldRetainStoryboardProject,
  type StoryboardVideoTaskSnapshot,
} from "@/lib/storyboard-project-video-state";
import { storageManager, type StorageProviderType } from "@/storage/object";
import { createVideoAccessUrl } from "@/lib/video-access-ticket";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const MAX_BYTES = 2 * 1024 * 1024;
const PROJECT_LIST_BATCH_SIZE = 100;
const MAX_PROJECT_LIST_ROWS = 500;
const VIDEO_TASK_BATCH_SIZE = 100;
const VIDEO_TASK_FIELDS = "id,task_id_external,model_id,status,error_message,submission_error_code,billing_state,price_charged,provider_result_url,completed_at";
type Database = SupabaseClient;
type Document = z.infer<typeof StoryboardProjectDocument>;
type Asset = { id: string; storage_key: string; storage_provider: StorageProviderType };
const mediaFields = ["imageUrl", "videoSourceImageUrl", "videoUrl", "videoContentUrl"] as const;
const saveSchema = z.object({ document: StoryboardProjectDocument, expectedRevision: z.number().int().nonnegative() }).strict();
const deleteSchema = z.object({ id: StoryboardProjectId, expectedRevision: z.number().int().positive() }).strict();
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "private, no-store" } });

function failure(error: unknown) {
  const record = error as { code?: string; message?: string };
  const message = String(record?.message || "");
  if (error instanceof z.ZodError || error instanceof SyntaxError) return json({ code: "INVALID_PROJECT", error: "任务数据不完整，请检查后重试" }, 400);
  if (message === "BODY_TOO_LARGE") return json({ code: message, error: "任务内容过大，请减少镜头或提示词长度" }, 413);
  if (message === "EMBEDDED_MEDIA") return json({ code: message, error: "请等待参考素材上传完成后再保存" }, 400);
  if (message === "ASSET_NOT_OWNED") return json({ code: message, error: "任务引用的图片不属于当前账号或已被移除" }, 403);
  if (/STORYBOARD_REVISION_CONFLICT/u.test(message)) return json({ code: "REVISION_CONFLICT", error: "任务已在其他窗口更新，本地编辑已保留；请从最近任务打开最新版本后再编辑" }, 409);
  if (/STORYBOARD_NOT_FOUND/u.test(message)) return json({ code: "PROJECT_NOT_FOUND", error: "任务不存在或已删除" }, 404);
  if (message === "PROJECT_LIST_LIMIT") return json({ code: message, error: "任务数量超过安全读取上限，请先整理旧任务后重试" }, 503);
  if (/42P01|42883|PGRST202|PGRST205/u.test(String(record?.code))) return json({ code: "MIGRATION_NOT_READY", error: "任务保存服务尚未启用，当前页面内容不会清空" }, 503);
  console.error("[storyboard/projects]", record?.code || "UNKNOWN");
  return json({ code: "PROJECT_STORAGE_FAILED", error: "任务暂时无法保存或读取，当前页面内容不会清空，请稍后重试" }, 503);
}

async function body(request: Request) {
  if (Number(request.headers.get("content-length") || 0) > MAX_BYTES) throw Error("BODY_TOO_LARGE");
  const reader = request.body?.getReader();
  if (!reader) throw new SyntaxError("empty body");
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_BYTES) { await reader.cancel(); throw Error("BODY_TOO_LARGE"); }
      parts.push(chunk.value);
    }
  } finally { reader.releaseLock(); }
  return JSON.parse(Buffer.concat(parts).toString("utf8")) as unknown;
}

function stableJson(value: unknown, depth = 0): unknown {
  if (depth > 20) throw new SyntaxError("too deep");
  if (Array.isArray(value)) return value.map((item) => stableJson(item, depth + 1));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stableJson(item, depth + 1)]));
}

function possibleKey(value: unknown) {
  if (typeof value !== "string") return "";
  try { return decodeURIComponent(new URL(value).pathname).replace(/^\/+/, ""); } catch { return ""; }
}

async function stabilize(db: Database, owner: string, input: Document): Promise<Document> {
  const document = structuredClone(input);
  const keys = new Set<string>();
  for (const card of document.cards) {
    if (typeof card.imageStorageKey === "string" && card.imageStorageKey) keys.add(card.imageStorageKey);
    for (const url of [...card.referenceImageUrls, ...mediaFields.map((field) => card[field])]) {
      if (typeof url === "string" && /^(?:blob|data):/iu.test(url)) throw Error("EMBEDDED_MEDIA");
      const key = possibleKey(url);
      if (key) keys.add(key);
    }
  }
  const assets: Asset[] = [];
  const wanted = [...keys];
  for (let offset = 0; offset < wanted.length; offset += 100) {
    const result = await db.from("user_files").select("id,storage_key,storage_provider").eq("user_id", owner).in("storage_key", wanted.slice(offset, offset + 100));
    if (result.error) throw result.error;
    assets.push(...(result.data || []) as Asset[]);
  }
  const byKey = new Map(assets.map((asset) => [asset.storage_key, asset]));
  const stableUrl = (url: unknown) => {
    const asset = byKey.get(possibleKey(url));
    return asset ? `asset://${asset.id}` : url;
  };
  for (const card of document.cards) {
    for (const field of mediaFields) if (card[field]) card[field] = stableUrl(card[field]);
    card.referenceImageUrls = card.referenceImageUrls.map((url) => String(stableUrl(url)));
    if (card.imageStorageKey) {
      const asset = byKey.get(String(card.imageStorageKey));
      if (!asset) throw Error("ASSET_NOT_OWNED");
      card.imageUrl = `asset://${asset.id}`;
    }
    delete card.imageValidatedAt;
    if (card.videoTaskId) { delete card.videoUrl; delete card.videoContentUrl; }
  }
  return document;
}

async function loadOwnedVideoTasks(db: Database, owner: string, taskIds: readonly string[]) {
  const tasks: StoryboardVideoTaskSnapshot[] = [];
  for (let offset = 0; offset < taskIds.length; offset += VIDEO_TASK_BATCH_SIZE) {
    const batch = taskIds.slice(offset, offset + VIDEO_TASK_BATCH_SIZE);
    const results = await Promise.allSettled([
      db.from("video_tasks").select(VIDEO_TASK_FIELDS).eq("user_id", owner).in("id", batch),
      db.from("video_tasks").select(VIDEO_TASK_FIELDS).eq("user_id", owner).in("task_id_external", batch),
    ]);
    for (const result of results) {
      if (result.status === "fulfilled" && !result.value.error) {
        tasks.push(...(result.value.data || []) as StoryboardVideoTaskSnapshot[]);
      }
    }
  }
  const unique = new Map<string, StoryboardVideoTaskSnapshot>();
  for (const task of tasks) {
    const key = `${String(task.id || "")}\u0000${String(task.task_id_external || "")}\u0000${String(task.model_id || "")}`;
    unique.set(key, task);
  }
  return [...unique.values()];
}

async function hydrate(db: Database, owner: string, input: Document) {
  let document = structuredClone(input);
  const ids = new Set<string>();
  for (const card of document.cards) for (const url of [...card.referenceImageUrls, ...mediaFields.map((field) => card[field])]) {
    if (typeof url === "string" && url.startsWith("asset://")) ids.add(url.slice(8));
  }
  const urls = new Map<string, string>();
  const wanted = [...ids];
  for (let offset = 0; offset < wanted.length; offset += 100) {
    const result = await db.from("user_files").select("id,storage_key,storage_provider").eq("user_id", owner).in("id", wanted.slice(offset, offset + 100));
    if (result.error) throw result.error;
    const assets = (result.data || []) as Asset[];
    const signed = await Promise.allSettled(assets.map(async (asset) => ({
      id: asset.id,
      url: await storageManager.getSignedUrl(asset.storage_key, { expireTime: 3600 }, asset.storage_provider),
    })));
    for (const item of signed) {
      if (item.status === "fulfilled" && item.value.url) urls.set(item.value.id, item.value.url);
    }
  }
  const restore = (url: unknown) => typeof url === "string" && url.startsWith("asset://") ? urls.get(url.slice(8)) || "" : url;
  for (const card of document.cards) {
    for (const field of mediaFields) if (card[field]) card[field] = restore(card[field]);
    card.referenceImageUrls = card.referenceImageUrls.map((url) => String(restore(url))).filter(Boolean);
  }
  const taskIds = collectStoryboardVideoTaskIds([document]);
  if (taskIds.length) {
    // Resolve the exact owned task, including older projects outside recent-history pagination.
    const tasks = await loadOwnedVideoTasks(db, owner, taskIds);
    document = reconcileStoryboardProjectVideoTasks(document, tasks);
    const playableCards = document.cards.map(async (card) => {
      if (!card.videoTaskId) return;
      const task = findStoryboardVideoTask(card, tasks);
      if (task && normalizeStoryboardVideoTaskStatus(task.status) === "done") {
        const taskId = String(task.id || "").trim();
        if (!taskId) return;
        // The stored document may contain an older provider task id. Response
        // snapshots always expose our owned local id so the client can mint a
        // fresh playback ticket whenever the user opens the completed video.
        card.videoTaskId = taskId;
        const access = await Promise.allSettled([
          createVideoAccessUrl({ taskId, userId: owner, role: "student", scope: "playback" }),
          createVideoAccessUrl({ taskId, userId: owner, role: "student", scope: "thumbnail" }),
        ]);
        if (access[0].status === "fulfilled") {
          card.videoUrl = access[0].value;
          card.videoStatusDetail = "生成成功，播放地址已同步";
        }
        if (access[1].status === "fulfilled") card.videoThumbnailUrl = access[1].value;
      }
    });
    await Promise.allSettled(playableCards);
  }
  return document;
}

function summaryWithDocument(row: Record<string, unknown>, hydrated?: Document) {
  const createdAt = String(row.created_at || row.updated_at || "");
  const updatedAt = String(row.updated_at || row.created_at || "");
  return {
    id: String(row.id),
    title: String(row.title),
    revision: Number(row.revision),
    createdAt,
    updatedAt,
    submittedAt: deriveStoryboardSubmittedAt(row.document),
    cardCount: Number(row.card_count),
    ...(hydrated ? {
      cards: [...hydrated.cards]
        .sort((left, right) => left.order - right.order)
        .map((card) => ({
          id: card.id,
          order: card.order,
          imageStatus: card.imageStatus,
          videoStatus: card.videoStatus,
          imageUrl: String(card.imageUrl || ""),
          videoTaskId: String(card.videoTaskId || ""),
          videoUrl: String(card.videoUrl || ""),
          videoThumbnailUrl: String(card.videoThumbnailUrl || ""),
        })),
    } : {}),
  };
}

function summary(row: Record<string, unknown>) {
  return summaryWithDocument(row);
}

async function listOwnedProjectRows(db: Database, ownerId: string) {
  let rows: Record<string, unknown>[] = [];
  for (let cursor = 0; cursor < MAX_PROJECT_LIST_ROWS; cursor += PROJECT_LIST_BATCH_SIZE) {
    const result = await db
      .from("storyboard_projects")
      .select("id,title,revision,updated_at,created_at,card_count,document")
      .eq("owner_id", ownerId)
      .eq("deleted", false)
      .order("updated_at", { ascending: false })
      .order("id", { ascending: false })
      .range(cursor, cursor + PROJECT_LIST_BATCH_SIZE);
    if (result.error) throw result.error;
    const page = (result.data || []) as Record<string, unknown>[];
    const hasMore = page.length > PROJECT_LIST_BATCH_SIZE;
    const batch = page.slice(0, PROJECT_LIST_BATCH_SIZE);
    rows.push(...batch);
    if (!hasMore) {
      const taskIds = collectStoryboardVideoTaskIds(rows.map((row) => row.document), { onlyActive: true });
      const tasks = await loadOwnedVideoTasks(db, ownerId, taskIds);
      rows = rows.map((row): Record<string, unknown> => ({
        ...row,
        document: reconcileStoryboardProjectVideoTasks(row.document, tasks),
      }));
      const byId = new Map(rows.map((row) => [String(row.id), row]));
      return sortStoryboardProjectsBySubmission(rows.map(summary))
        .filter((project) => shouldRetainStoryboardProject(
          byId.get(project.id)?.document,
          project.submittedAt,
        ))
        .map((project) => byId.get(project.id))
        .filter((row): row is Record<string, unknown> => Boolean(row));
    }
  }
  throw Error("PROJECT_LIST_LIMIT");
}

export async function GET(request: Request) {
  return withAuth(request, async (user, authenticatedDb) => {
    const db: Database = authenticatedDb;
    try {
      const url = new URL(request.url);
      const id = url.searchParams.get("id");
      if (id) {
        StoryboardProjectId.parse(id);
        const result = await db.from("storyboard_projects").select("*").eq("owner_id", user.id).eq("id", id).eq("deleted", false).maybeSingle();
        if (result.error) throw result.error;
        if (!result.data) return json({ code: "PROJECT_NOT_FOUND", error: "任务不存在或无权访问" }, 404);
        return json({ project: { ...summary(result.data), document: await hydrate(db, user.id, result.data.document as Document) } });
      }
      const offset = z.coerce.number().int().nonnegative().max(100000).parse(url.searchParams.get("offset") || 0);
      const projects = await listOwnedProjectRows(db, user.id);
      const page = projects.slice(offset, offset + 50);
      const hydrated = await Promise.allSettled(page.map((row) => hydrate(
        db,
        user.id,
        row.document as Document,
      )));
      const projectSummaries = page.map((row, index) => summaryWithDocument(
        row,
        hydrated[index]?.status === "fulfilled" ? hydrated[index].value : undefined,
      ));
      return json({ projects: projectSummaries, nextOffset: projects.length > offset + 50 ? offset + 50 : null });
    } catch (error) { return failure(error); }
  });
}

export async function POST(request: Request) {
  return withAuth(request, async (user, authenticatedDb) => {
    const db: Database = authenticatedDb;
    try {
      const parsed = saveSchema.parse(await body(request));
      const document = await stabilize(db, user.id, parsed.document);
      const contentHash = createHash("sha256").update(JSON.stringify(stableJson(document))).digest("hex");
      const result = await db.rpc("save_storyboard_project", { p_owner_id: user.id, p_id: document.id, p_expected_revision: parsed.expectedRevision, p_title: document.title, p_document: document, p_content_hash: contentHash });
      if (result.error) throw result.error;
      const row = Array.isArray(result.data) ? result.data[0] : result.data;
      if (!row?.id) throw Error("EMPTY_SAVE");
      return json({ project: summary(row) });
    } catch (error) { return failure(error); }
  });
}

export async function DELETE(request: Request) {
  return withAuth(request, async (user, authenticatedDb) => {
    const db: Database = authenticatedDb;
    try {
      const parsed = deleteSchema.parse(await body(request));
      const result = await db.rpc("delete_storyboard_project", { p_owner_id: user.id, p_id: parsed.id, p_expected_revision: parsed.expectedRevision });
      if (result.error) throw result.error;
      return json({ deleted: true, id: parsed.id });
    } catch (error) { return failure(error); }
  });
}
