import { createHash, randomUUID } from "node:crypto";
import sharp from "sharp";
import type { SupabaseClient } from "@supabase/supabase-js";
import { storageManager } from "@/storage/object";
import { getSupabaseAdminClient } from "@/storage/database/supabase-client";
import { validateImageFile } from "@/lib/image-file-validation";
import { emptyStoryboardPresetCatalog, STORYBOARD_PRESET_SETTING_KEY, StoryboardPresetCatalogSchema,
  StoryboardPresetDraftSchema, StoryboardPresetError, StoryboardPresetIdSchema, storyboardPresetPublicDto,
  type StoryboardPresetCatalog, type StoryboardPresetDraft } from "@/lib/storyboard-preset-assets";

const MAX_BYTES = 25 * 1024 * 1024;
type OwnedSource = { id: string; user_id: string; storage_key: string; storage_provider: string; content_type: string; file_category: string; file_size: number };
type Material = { storageKey: string; sha256: string; mime: "image/png" | "image/jpeg" | "image/webp"; width: number; height: number };
export async function inspectStoryboardPresetImage(bytes: Buffer, contentType: string) {
  if (!bytes.length || bytes.length > MAX_BYTES) throw new StoryboardPresetError("PRESET_IMAGE_INVALID", "图片大小无效");
  try {
    validateImageFile(bytes, contentType);
    const decoder = sharp(bytes, { failOn: "error", limitInputPixels: 16_000_000, animated: false });
    const metadata = await decoder.metadata();
    const width = Number(metadata.width), height = Number(metadata.height), pages = Number(metadata.pages || 1);
    const mime = ({ png: "image/png", jpeg: "image/jpeg", webp: "image/webp" } as const)[metadata.format as "png" | "jpeg" | "webp"];
    if (!mime || mime !== contentType || !Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width > 8192 || height > 8192 || !Number.isSafeInteger(pages) || pages !== 1) throw new Error("INVALID_IMAGE");
    await decoder.resize(1, 1).png().toBuffer();
    return { mime, width, height, sha256: createHash("sha256").update(bytes).digest("hex"), extension: metadata.format === "jpeg" ? "jpg" : metadata.format };
  } catch { throw new StoryboardPresetError("PRESET_IMAGE_INVALID", "图片格式或尺寸校验失败"); }
}
export type StoryboardPresetDependencies = {
  db: SupabaseClient;
  copySource(row: OwnedSource, presetId: string, actorId: string): Promise<Material>;
  sign(key: string): Promise<string>;
};
export function storyboardPresetDependencies(): StoryboardPresetDependencies {
  return {
    db: getSupabaseAdminClient(),
    sign: (key) => storageManager.getSignedUrl(key, { expireTime: 3600 }, "tencent_cos"),
    copySource: async (row, presetId, actorId) => {
      if (row.storage_provider !== "tencent_cos" || !row.storage_key || row.file_size <= 0 || row.file_size > MAX_BYTES) {
        throw new StoryboardPresetError("PRESET_SOURCE_INVALID", "请选择已保存到对象存储的25MB以内图片");
      }
      const bytes = await storageManager.readBounded(row.storage_key, MAX_BYTES, 20_000, "tencent_cos");
      if (bytes.length !== Number(row.file_size)) throw new StoryboardPresetError("PRESET_IMAGE_INVALID", "图片大小校验失败");
      const { mime, sha256, width, height, extension } = await inspectStoryboardPresetImage(bytes, row.content_type);
      const uploaded = await storageManager.upload(bytes, `${sha256}.${extension}`, mime, {
        providerType: "tencent_cos", strictProvider: true, publicRead: false,
        // Platform catalog owns this explicit copy. Omitting userId deliberately
        // avoids adding it to a private user's deletable file library.
        prefix: `storyboard-presets/${presetId}/${sha256}/`, category: "image",
        source: "storyboard_platform_preset", meta: { purpose: "storyboard_platform_preset", presetId, sha256, publishedBy: actorId },
      });
      if (uploaded.provider !== "tencent_cos" || !uploaded.key.startsWith(`storyboard-presets/${presetId}/${sha256}/`) || uploaded.size !== bytes.length || uploaded.contentType !== mime || uploaded.isPublic) {
        throw new StoryboardPresetError("PRESET_COPY_UNCONFIRMED", "预设独立素材保存尚未确认", 503);
      }
      // Read the actual copied object before publishing its immutable reference.
      const stored = await storageManager.readBounded(uploaded.key, MAX_BYTES, 20_000, "tencent_cos");
      if (createHash("sha256").update(stored).digest("hex") !== sha256) throw new StoryboardPresetError("PRESET_COPY_UNCONFIRMED", "预设独立素材读回不一致", 503);
      return { storageKey: uploaded.key, sha256, mime, width, height };
    },
  };
}
export async function loadStoryboardPresetCatalog(db: SupabaseClient) {
  const { data, error } = await db.from("platform_settings").select("setting_value").eq("setting_key", STORYBOARD_PRESET_SETTING_KEY).maybeSingle();
  if (error) throw new StoryboardPresetError("PRESET_READ_UNAVAILABLE", "预设库读取暂不可用", 503);
  if (!data) return { catalog: emptyStoryboardPresetCatalog(), raw: null as string | null };
  try {
    const raw = String(data.setting_value);
    return { catalog: StoryboardPresetCatalogSchema.parse(JSON.parse(raw)), raw };
  } catch { throw new StoryboardPresetError("PRESET_CATALOG_INVALID", "预设库数据校验失败，已阻止覆盖", 503); }
}
async function saveCatalog(db: SupabaseClient, catalog: StoryboardPresetCatalog, raw: string | null) {
  const value = JSON.stringify(StoryboardPresetCatalogSchema.parse(catalog));
  const row = { setting_key: STORYBOARD_PRESET_SETTING_KEY, setting_value: value, updated_at: new Date().toISOString() };
  const result = raw === null
    ? await db.from("platform_settings").insert(row).select("setting_value").maybeSingle()
    : await db.from("platform_settings").update({ setting_value: value, updated_at: row.updated_at }).eq("setting_key", STORYBOARD_PRESET_SETTING_KEY).eq("setting_value", raw).select("setting_value").maybeSingle();
  if (result.error?.code === "23505" || (!result.error && !result.data)) throw new StoryboardPresetError("PRESET_REVISION_CONFLICT", "预设库已被更新，请刷新后重试", 409);
  if (result.error || result.data?.setting_value !== value) throw new StoryboardPresetError("PRESET_SAVE_UNCONFIRMED", "预设保存未确认，请查询原操作", 503);
}
async function ownedSource(db: SupabaseClient, assetId: string, actorId: string) {
  const result = await db.from("user_files").select("id,user_id,storage_key,storage_provider,content_type,file_category,file_size")
    .eq("id", assetId).eq("user_id", actorId).eq("file_category", "image").maybeSingle();
  if (result.error) throw new StoryboardPresetError("PRESET_SOURCE_UNAVAILABLE", "素材归属暂不可核实", 503);
  const row = result.data as OwnedSource | null;
  if (!row || row.user_id !== actorId || row.id !== assetId || row.file_category !== "image") throw new StoryboardPresetError("PRESET_SOURCE_NOT_OWNED", "请选择当前管理员自己的已保存图片", 403);
  return row;
}
export type StoryboardPresetMutation = { action: "draft" | "publish" | "disable"; expectedRevision: number; presetId?: string; draft?: StoryboardPresetDraft };
export async function mutateStoryboardPresetCatalog(actorId: string, input: StoryboardPresetMutation, deps = storyboardPresetDependencies()) {
  if (!actorId || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0 || !["draft", "publish", "disable"].includes(input.action)) throw new StoryboardPresetError("PRESET_INPUT_INVALID", "操作或版本参数无效", 400);
  const loaded = await loadStoryboardPresetCatalog(deps.db);
  if (loaded.catalog.revision !== input.expectedRevision) throw new StoryboardPresetError("PRESET_REVISION_CONFLICT", "预设库已被更新，请刷新后重试", 409);
  const next = structuredClone(loaded.catalog);
  if (next.audit.length >= 1000) throw new StoryboardPresetError("PRESET_AUDIT_CAPACITY", "预设审计记录需归档后才能继续更新", 503);
  const presetId = input.presetId || (input.action === "draft" ? `preset-${randomUUID()}` : "");
  if (!StoryboardPresetIdSchema.safeParse(presetId).success) throw new StoryboardPresetError("PRESET_INPUT_INVALID", "预设标识无效", 400);
  let entry = next.entries.find((item) => item.presetId === presetId);
  if (input.action === "draft") {
    const parsed = StoryboardPresetDraftSchema.safeParse(input.draft);
    if (!parsed.success) throw new StoryboardPresetError("PRESET_INPUT_INVALID", "预设名称、类别或素材参数无效", 400);
    await ownedSource(deps.db, parsed.data.assetId, actorId);
    if (!entry) { entry = { presetId, disabled: false }; next.entries.push(entry); }
    entry.draft = { ...parsed.data, ownerId: actorId, savedAt: new Date().toISOString() };
  } else {
    if (!entry) throw new StoryboardPresetError("PRESET_NOT_FOUND", "预设不存在", 404);
    if (input.action === "disable") entry.disabled = true;
    else {
      if (!entry.draft || entry.draft.ownerId !== actorId) throw new StoryboardPresetError("PRESET_SOURCE_NOT_OWNED", "请先使用当前管理员的图片保存待审稿", 403);
      const row = await ownedSource(deps.db, entry.draft.assetId, actorId);
      const material = await deps.copySource(row, presetId, actorId);
      const { role, name, tags, customCategory, prompt } = entry.draft;
      const metadata = { role, name, tags, customCategory, prompt };
      entry.published = { ...metadata, ...material, revision: (entry.published?.revision || 0) + 1, publishedAt: new Date().toISOString(), publishedBy: actorId };
      entry.disabled = false;
    }
  }
  next.revision++;
  next.audit.push({ revision: next.revision, presetId, action: input.action, actorId, at: new Date().toISOString() });
  await saveCatalog(deps.db, next, loaded.raw);
  return { catalog: next, presetId };
}
export async function resolvePublishedStoryboardPresetReference(input: { presetId: string; revision?: number }, deps = storyboardPresetDependencies()) {
  if (!StoryboardPresetIdSchema.safeParse(input.presetId).success || (input.revision !== undefined && (!Number.isSafeInteger(input.revision) || input.revision < 1))) throw new StoryboardPresetError("PRESET_INPUT_INVALID", "预设标识或版本无效", 400);
  const { catalog } = await loadStoryboardPresetCatalog(deps.db);
  const entry = catalog.entries.find((item) => item.presetId === input.presetId);
  if (!entry || entry.disabled || !entry.published) throw new StoryboardPresetError("PRESET_NOT_AVAILABLE", "预设尚未发布或已停用", 404);
  if (input.revision !== undefined && input.revision !== entry.published.revision) throw new StoryboardPresetError("PRESET_VERSION_CHANGED", "预设已有新版本，请重新选择", 409);
  return storyboardPresetPublicDto(entry, await deps.sign(entry.published.storageKey));
}
export async function listPublishedStoryboardPresets(input: { role?: string; q?: string; offset?: number; limit?: number }, deps = storyboardPresetDependencies()) {
  const { catalog } = await loadStoryboardPresetCatalog(deps.db);
  const offset = input.offset ?? 0, limit = input.limit ?? 60;
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100 || (input.role && !["character", "pet", "environment", "prop"].includes(input.role)) || (input.q?.length || 0) > 120) throw new StoryboardPresetError("PRESET_INPUT_INVALID", "预设搜索参数无效", 400);
  const query = (input.q || "").trim().toLocaleLowerCase();
  const entries = catalog.entries.filter((entry) => !entry.disabled && entry.published && (!input.role || entry.published.role === input.role)
    && (!query || [entry.published.name, ...entry.published.tags, entry.published.customCategory].join(" ").toLocaleLowerCase().includes(query)));
  const presets = await Promise.all(entries.slice(offset, offset + limit).map(async (entry) => storyboardPresetPublicDto(entry, await deps.sign(entry.published!.storageKey))));
  return { presets, count: entries.length, nextOffset: offset + limit < entries.length ? offset + limit : null, revision: catalog.revision };
}
