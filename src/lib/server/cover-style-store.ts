import "server-only";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseAdminClient } from "@/storage/database/supabase-client";
import { CoverStyleKeySchema } from "../cover-style-catalog";
import { createDefaultCoverStyleCatalog, createDefaultCoverWorkflowRelease } from "./cover-style-defaults";
import {
  COVER_STYLE_SETTING_KEY, CoverStyleDraftInputSchema, CoverWorkflowDraftInputSchema, CoverStyleStoreError,
  assertCoverStyleCatalog, coverStyleHash, coverStyleReleaseHash, coverStyleStableJson, publicCoverStyles, runtimeCoverStyle,
  coverWorkflowReleaseHash, type CoverStyleCatalog, type CoverStyleRelease, type CoverWorkflowRelease,
} from "./cover-style-config";
export type { CoverStyleRuntime } from "./cover-style-config";

const expected = z.object({ expectedRevision: z.number().int().nonnegative(), expectedHash: z.string().regex(/^[a-f0-9]{64}$/u) });
export const CoverStyleMutationSchema = z.discriminatedUnion("action", [
  expected.extend({ action: z.literal("draft"), styleKey: CoverStyleKeySchema, draft: CoverStyleDraftInputSchema }).strict(),
  expected.extend({ action: z.literal("publish"), styleKey: CoverStyleKeySchema }).strict(),
  expected.extend({ action: z.literal("rollback"), styleKey: CoverStyleKeySchema, releaseId: z.string().min(1).max(120) }).strict(),
  expected.extend({ action: z.literal("set-enabled"), styleKey: CoverStyleKeySchema, enabled: z.boolean() }).strict(),
  expected.extend({ action: z.literal("reorder"), styleKeys: z.array(CoverStyleKeySchema).max(40) }).strict(),
  expected.extend({ action: z.literal("workflow-draft"), draft: CoverWorkflowDraftInputSchema }).strict(),
  expected.extend({ action: z.literal("workflow-publish") }).strict(),
  expected.extend({ action: z.literal("workflow-rollback"), releaseId: z.string().min(1).max(120) }).strict(),
]);
export type CoverStyleMutation = z.infer<typeof CoverStyleMutationSchema>;
type RowIdentity = { id: string; updatedAt: string | null };
export type Loaded = { catalog: CoverStyleCatalog; hash: string; row: RowIdentity | null };
const conflict = (): never => { throw new CoverStyleStoreError("COVER_STYLE_REVISION_CONFLICT", "风格配置已更新，请读取最新版本后重新核对", 409); };
const unknown = (): never => { throw new CoverStyleStoreError("COVER_STYLE_WRITE_UNKNOWN", "本次风格保存结果待核对，请先刷新版本；不要重复提交", 503, "unknown"); };
const dbDefault = () => getSupabaseAdminClient();

export async function loadCoverStyleCatalog(db: SupabaseClient = dbDefault()): Promise<Loaded> {
  const result = await db.from("platform_settings").select("id,setting_key,setting_value,updated_at").eq("setting_key", COVER_STYLE_SETTING_KEY).maybeSingle();
  if (result.error) throw new CoverStyleStoreError("COVER_STYLE_READ_UNAVAILABLE", "风格配置暂不可读取", 503);
  if (!result.data) { const catalog = assertCoverStyleCatalog(createDefaultCoverStyleCatalog()); return { catalog, hash: coverStyleHash(catalog), row: null }; }
  try {
    const row = result.data;
    if (typeof row.id !== "string" || !row.id || typeof row.setting_value !== "string" || (row.updated_at !== null && (typeof row.updated_at !== "string" || !Number.isFinite(Date.parse(row.updated_at))))) throw new Error("invalid identity");
    const catalog = assertCoverStyleCatalog(JSON.parse(row.setting_value));
    return { catalog, hash: coverStyleHash(catalog), row: { id: row.id, updatedAt: row.updated_at } };
  } catch { throw new CoverStyleStoreError("COVER_STYLE_CATALOG_INVALID", "风格配置身份或版本校验失败，已阻止覆盖", 503); }
}
export function assertCoverStyleHistoryPreserved(before: CoverStyleCatalog, after: CoverStyleCatalog) {
  if (after.revision !== before.revision + 1 || after.audit.length < before.audit.length
    || before.audit.some((event, index) => coverStyleStableJson(event) !== coverStyleStableJson(after.audit[index])))
    throw new CoverStyleStoreError("COVER_STYLE_HISTORY_IMMUTABLE", "风格修订和旧审计记录不可覆盖", 409);
  for (const original of before.entries) {
    const next = after.entries.find(item => item.styleKey === original.styleKey);
    if (!next || next.releases.length < original.releases.length || next.publications.length < original.publications.length
      || original.releases.some((item, index) => coverStyleStableJson(item) !== coverStyleStableJson(next.releases[index]))
      || original.publications.some((item, index) => coverStyleStableJson(item) !== coverStyleStableJson(next.publications[index]))) {
      throw new CoverStyleStoreError("COVER_STYLE_HISTORY_IMMUTABLE", "已保存风格快照与发布记录不可删除或修改", 409);
    }
  }
  if (before.workflow) {
    const original = before.workflow, next = after.workflow;
    if (!next || next.releases.length < original.releases.length || next.publications.length < original.publications.length
      || original.releases.some((item, index) => coverStyleStableJson(item) !== coverStyleStableJson(next.releases[index]))
      || original.publications.some((item, index) => coverStyleStableJson(item) !== coverStyleStableJson(next.publications[index])))
      throw new CoverStyleStoreError("COVER_STYLE_HISTORY_IMMUTABLE", "拆解规则快照和发布记录不可删除或修改", 409);
  }
}
async function saveCoverStyleCatalog(db: SupabaseClient, loaded: Loaded, value: CoverStyleCatalog): Promise<Loaded> {
  const catalog = assertCoverStyleCatalog(value);
  assertCoverStyleHistoryPreserved(loaded.catalog, catalog);
  const serialized = coverStyleStableJson(catalog), oldTime = loaded.row?.updatedAt;
  const updatedAt = new Date(Math.max(Date.now(), oldTime ? Date.parse(oldTime) + 1 : 0)).toISOString();
  let result;
  try {
    if (!loaded.row) result = await db.from("platform_settings").insert({ setting_key: COVER_STYLE_SETTING_KEY, setting_value: serialized, updated_at: updatedAt }).select("id,setting_value,updated_at").maybeSingle();
    else {
      let query = db.from("platform_settings").update({ setting_value: serialized, updated_at: updatedAt }).eq("setting_key", COVER_STYLE_SETTING_KEY).eq("id", loaded.row.id);
      query = oldTime === null ? query.is("updated_at", null) : query.eq("updated_at", oldTime);
      result = await query.select("id,setting_value,updated_at").maybeSingle();
    }
  } catch { return unknown(); }
  if (result.error?.code === "23505" || (!result.error && !result.data)) return conflict();
  if (result.error || result.data?.setting_value !== serialized || typeof result.data?.id !== "string" || (loaded.row && result.data.id !== loaded.row.id)
    || Date.parse(String(result.data.updated_at)) !== Date.parse(updatedAt)) return unknown();
  try {
    const readback = await loadCoverStyleCatalog(db);
    if (!readback.row || readback.row.id !== result.data.id || readback.hash !== coverStyleHash(catalog)
      || Date.parse(String(readback.row.updatedAt)) !== Date.parse(updatedAt)) return unknown();
    return readback;
  } catch { return unknown(); }
}
export async function mutateCoverStyleCatalog(actorId: string, raw: unknown, db: SupabaseClient = dbDefault()) {
  const parsed = CoverStyleMutationSchema.safeParse(raw);
  if (!actorId || !parsed.success) throw new CoverStyleStoreError("COVER_STYLE_INPUT_INVALID", "风格操作参数或提示词无效", 400);
  const input = parsed.data, loaded = await loadCoverStyleCatalog(db);
  if (input.expectedRevision !== loaded.catalog.revision || input.expectedHash !== loaded.hash) return conflict();
  const next = structuredClone(loaded.catalog), at = new Date().toISOString();
  if (next.audit.length >= 4000) throw new CoverStyleStoreError("COVER_STYLE_CAPACITY", "风格审计容量已满，历史保留，请安排受控归档", 503);
  let releaseId: string | null = null;
  if (input.action === "workflow-draft" || input.action === "workflow-publish" || input.action === "workflow-rollback") {
    if (!next.workflow) {
      const builtin = createDefaultCoverWorkflowRelease();
      const current = { releaseId: builtin.releaseId, publishedAt: builtin.createdAt, publishedBy: builtin.createdBy };
      next.workflow = { current, draftReleaseId: null, releases: [builtin], publications: [{ ...current, action: "publish" }] };
    }
    const state = next.workflow;
    if (input.action === "workflow-draft") {
      if (state.releases.length >= 1000) throw new CoverStyleStoreError("COVER_STYLE_CAPACITY", "拆解规则版本容量已满，请先安排受控归档", 503);
      const sequence = Math.max(...state.releases.map(item => item.sequence)) + 1;
      const payload = { ...input.draft, releaseId: randomUUID(), version: `${sequence}.0.0`, sequence, createdAt: at, createdBy: actorId };
      const release: CoverWorkflowRelease = { ...payload, snapshotSha256: coverWorkflowReleaseHash(payload) };
      state.releases.push(release); state.draftReleaseId = release.releaseId; releaseId = release.releaseId;
    } else {
      if (state.publications.length >= 2000) throw new CoverStyleStoreError("COVER_STYLE_CAPACITY", "拆解规则发布记录容量已满，请先安排受控归档", 503);
      const target = input.action === "workflow-publish" ? state.draftReleaseId : input.releaseId;
      if (!target || !state.releases.some(item => item.releaseId === target)
        || (input.action === "workflow-rollback" && !state.publications.some(item => item.releaseId === target)))
        throw new CoverStyleStoreError("COVER_STYLE_RELEASE_INVALID", "请选择已保存的拆解规则，回退只允许曾发布的版本", 400);
      state.current = { releaseId: target, publishedAt: at, publishedBy: actorId };
      state.publications.push({ ...state.current, action: input.action === "workflow-publish" ? "publish" : "rollback" });
      releaseId = target;
      if (input.action === "workflow-publish") state.draftReleaseId = null;
    }
  } else if (input.action === "reorder") {
    if (new Set(input.styleKeys).size !== next.entries.length || input.styleKeys.length !== next.entries.length || next.entries.some(row => !input.styleKeys.includes(row.styleKey))) throw new CoverStyleStoreError("COVER_STYLE_ORDER_INVALID", "排序必须包含全部现有风格且不能重复", 400);
    for (const row of next.entries) row.order = input.styleKeys.indexOf(row.styleKey);
  } else {
    let row = next.entries.find(item => item.styleKey === input.styleKey);
    if (input.action === "draft") {
      if (!row) {
        if (next.entries.length >= 40) throw new CoverStyleStoreError("COVER_STYLE_CAPACITY", "风格数量已达上限", 503);
        row = { styleKey: input.styleKey, enabled: true, order: next.entries.length, current: null, draftReleaseId: null, releases: [], publications: [] };
        next.entries.push(row);
      }
      if (row.releases.length >= 1000) throw new CoverStyleStoreError("COVER_STYLE_CAPACITY", "该风格版本容量已满，旧版本保留", 503);
      const sequence = Math.max(0, ...row.releases.map(item => item.sequence)) + 1;
      const payload = { ...input.draft, releaseId: randomUUID(), styleKey: row.styleKey, version: `${sequence}.0.0`, sequence, createdAt: at, createdBy: actorId };
      const release: CoverStyleRelease = { ...payload, snapshotSha256: coverStyleReleaseHash(payload) };
      row.releases.push(release); row.draftReleaseId = release.releaseId; releaseId = release.releaseId;
    } else {
      if (!row) throw new CoverStyleStoreError("COVER_STYLE_NOT_FOUND", "风格不存在", 404);
      if (input.action === "set-enabled") row.enabled = input.enabled;
      else {
        if (row.publications.length >= 2000) throw new CoverStyleStoreError("COVER_STYLE_CAPACITY", "发布记录容量已满，历史保留", 503);
        const target = input.action === "publish" ? row.draftReleaseId : input.releaseId;
        if (!target || !row.releases.some(item => item.releaseId === target) || (input.action === "rollback" && !row.publications.some(item => item.releaseId === target))) throw new CoverStyleStoreError("COVER_STYLE_RELEASE_INVALID", "请选择已保存待发布版本，回退仅允许曾发布的版本", 400);
        row.current = { releaseId: target, publishedAt: at, publishedBy: actorId };
        row.publications.push({ ...row.current, action: input.action }); releaseId = target;
        if (input.action === "publish") row.draftReleaseId = null;
      }
    }
  }
  if (["publish", "rollback", "workflow-publish", "workflow-rollback"].includes(input.action) || (input.action === "set-enabled" && input.enabled)) {
    const { validateCoverWorkflowPublication } = await import("./cover-workflow-publication");
    validateCoverWorkflowPublication(next);
    const target = publishedCoverWorkflow(next);
    const { validateCoverWorkflowModels } = await import("./cover-admin-runtime");
    await validateCoverWorkflowModels({ sharedRules: target.sharedRules, textModelId: target.textModelId, imageModelId: target.imageModelId }, db, next);
  }
  next.revision++;
  next.audit.push({ revision: next.revision, action: input.action, styleKey: "styleKey" in input ? input.styleKey : null, releaseId, actorId, at });
  return saveCoverStyleCatalog(db, loaded, next);
}
export async function readPublicCoverStyles(db: SupabaseClient = dbDefault()) { return publicCoverStyles((await loadCoverStyleCatalog(db)).catalog); }
export async function resolvePublishedCoverStyle(styleKey: string, expectedVersion?: string, db: SupabaseClient = dbDefault()) {
  if (!CoverStyleKeySchema.safeParse(styleKey).success) throw new CoverStyleStoreError("COVER_STYLE_NOT_FOUND", "风格标识无效", 400);
  const { catalog } = await loadCoverStyleCatalog(db), row = catalog.entries.find(item => item.styleKey === styleKey);
  if (!row?.enabled || !row.current) throw new CoverStyleStoreError("COVER_STYLE_UNAVAILABLE", "该风格尚未发布或已停用", 409);
  const release = row.releases.find(item => item.releaseId === row.current!.releaseId)!;
  if (expectedVersion && release.version !== expectedVersion) throw new CoverStyleStoreError("COVER_STYLE_VERSION_CHANGED", "风格已有新版本，请重新选择并准备", 409);
  return runtimeCoverStyle(release, row.current.publishedAt);
}
export function publishedCoverWorkflow(catalog: CoverStyleCatalog): CoverWorkflowRelease {
  if (!catalog.workflow) return createDefaultCoverWorkflowRelease();
  const release = catalog.workflow.releases.find(item => item.releaseId === catalog.workflow!.current?.releaseId);
  if (!release) throw new CoverStyleStoreError("COVER_WORKFLOW_CATALOG_INVALID", "当前拆解规则版本不可核对", 503);
  return structuredClone(release);
}
export async function resolvePublishedCoverWorkflow(db: SupabaseClient = dbDefault()): Promise<CoverWorkflowRelease> {
  return publishedCoverWorkflow((await loadCoverStyleCatalog(db)).catalog);
}
export function coverWorkflowAdminDto(loaded: Loaded, releaseId?: string) {
  const current = publishedCoverWorkflow(loaded.catalog), state = loaded.catalog.workflow;
  const releases = state?.releases ?? [current];
  const draft = state?.releases.find(item => item.releaseId === state.draftReleaseId) ?? null;
  const viewed = releaseId ? releases.find(item => item.releaseId === releaseId) : draft ?? current;
  if (!viewed) throw new CoverStyleStoreError("COVER_STYLE_RELEASE_INVALID", "拆解规则版本不存在", 404);
  return { current, draft, viewed: structuredClone(viewed), releases: releases.map(item => ({ releaseId: item.releaseId,
    version: item.version, createdAt: item.createdAt, published: item.releaseId === current.releaseId || Boolean(state?.publications.some(event => event.releaseId === item.releaseId)) })) };
}
export function coverStyleAdminDto(loaded: Loaded, styleKey?: string, releaseId?: string, workflowReleaseId?: string) {
  const styles = loaded.catalog.entries.map(row => {
    const current = row.releases.find(release => release.releaseId === row.current?.releaseId), draft = row.releases.find(release => release.releaseId === row.draftReleaseId);
    return { styleKey: row.styleKey, displayName: current?.displayName ?? draft?.displayName ?? row.styleKey, enabled: row.enabled, order: row.order, currentVersion: current?.version ?? null, draftVersion: draft?.version ?? null };
  }).sort((a, b) => a.order - b.order || a.styleKey.localeCompare(b.styleKey));
  const row = styleKey ? loaded.catalog.entries.find(item => item.styleKey === styleKey) : null;
  if (styleKey && !row) throw new CoverStyleStoreError("COVER_STYLE_NOT_FOUND", "风格不存在", 404);
  const viewed = row?.releases.find(item => item.releaseId === (releaseId ?? row.draftReleaseId ?? row.current?.releaseId));
  if (releaseId && !viewed) throw new CoverStyleStoreError("COVER_STYLE_RELEASE_INVALID", "版本不属于当前风格", 404);
  const effective = viewed ? runtimeCoverStyle(viewed, row?.current?.publishedAt ?? viewed.createdAt).promptPack : null;
  return { revision: loaded.catalog.revision, hash: loaded.hash, styles, workflow: coverWorkflowAdminDto(loaded, workflowReleaseId), selected: row ? { styleKey: row.styleKey,
    currentReleaseId: row.current?.releaseId ?? null, draftReleaseId: row.draftReleaseId, viewed: viewed ?? null,
    editable: viewed && effective ? { displayName: viewed.displayName, description: viewed.description,
      analysisPrompt: effective.analysisRules.join("\n"), generationPrompt: effective.nativeCoverRules.join("\n"), completeRules: true as const } : null,
    releases: row.releases.map(item => ({ releaseId: item.releaseId, version: item.version, displayName: item.displayName, createdAt: item.createdAt, published: row.publications.some(event => event.releaseId === item.releaseId) })) } : null };
}
