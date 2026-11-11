"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { api } from "@/lib/api-client";
import { PublishingActionSchema, PublishingCenterSchema, PublishingMutationResponseSchema, type PublishingCenter, type PublishingPlatform } from "@/lib/publishing-contract";
import { PublishingV2ActionSchema, PublishingV2PageSchema, PublishingV2MutationSchema, PublishingV2DraftSchema, PublishingV2CollectionSchema, PublishingV2GroupSchema, PublishingV2BatchSchema, PublishingV2AttemptSchema, PublishingV2EventRecordSchema, PublishingV2ScheduleSchema, type PublishingV2Action, type PublishingV2Draft, type PublishingV2DraftInput, type PublishingV2Collection, type PublishingV2Group, type PublishingV2Batch, type PublishingV2Attempt, type PublishingV2EventRecord, type PublishingV2Schedule, type PublishingV2Media, type PublishingV2Query } from "@/lib/publishing-v2-contract";
import { createPublishingPluginRunner, inspectPublishingPlugin, publishingPluginMessage, type PublishingPluginAccount, type PublishingPluginProgress, type PublishingPluginParams } from "@/lib/publishing-plugin";
import { buildNativePluginPlatformConfig, NATIVE_PLATFORM_CAPABILITIES, prepareNativePluginContent, validateNativePublishingMedia } from "@/lib/publishing-native";
import { workbenchUserStorageKey, type WorkbenchIdentity } from "@/lib/workbench-user-storage";

type Claim = Extract<PublishingV2Action, { action: "claim" }>;
type Report = Extract<PublishingV2Action, { action: "report" }>;
type Pending = { action: PublishingV2Action; attemptId?: string; report?: Report };
type Resource = PublishingV2Query["resource"];
export type NativeEditor = { id?: string; revision: number; payload: PublishingV2DraftInput };
export type MainMediaItem = { id: string; kind: "image" | "video"; title: string; status: string; previewPath?: string | null; downloadPath?: string | null; expiresAt?: string | null };
export const blankNativeEditor = (collectionId: string | null = null): NativeEditor => ({ revision: 0, payload: { schemaVersion: 2, collectionId, contentType: "image", title: "", body: "", topics: [], media: [], targets: [] } });
export class NativeRequestError extends Error { constructor(message: string, readonly code?: string, readonly unknown = false) { super(message); } }
const provedFirstRejection = new Set(["PUBLISH_INPUT_INVALID", "PUBLISH_ACCESS_DENIED", "PUBLISH_PERMISSION_UNAVAILABLE", "PUBLISH_USER_DISABLED", "PUBLISH_EXECUTION_DISABLED", "PUBLISH_PLATFORM_DISABLED", "PUBLISH_PLATFORM_NOT_ALLOWED", "PUBLISH_DRAFT_NOT_FOUND", "PUBLISH_ACCOUNT_NOT_FOUND", "PUBLISH_ENTITLEMENT_NOT_FOUND", "PUBLISH_ENTITLEMENT_EXPIRED", "PUBLISH_NO_QUOTA", "PUBLISH_V2_COLLECTION_NOT_FOUND", "PUBLISH_V2_TARGET_NOT_FOUND", "PUBLISH_V2_TRANSPORT_UNCONFIGURED", "PUBLISH_V2_ACCOUNT_CHANGED", "PUBLISH_V2_ASSET_UNAVAILABLE", "PUBLISH_V2_MEDIA_INVALID", "PUBLISH_V2_NATIVE_SCHEDULE_UNAVAILABLE", "PUBLISH_V2_SCHEDULE_NOT_DUE", "PUBLISH_REVISION_CONFLICT"]);
export function mainAssetPath(reference: Extract<PublishingV2Media, { source: "main_asset" }>["reference"]) {
  if (reference.kind === "video_task") return `/api/video/storage/${encodeURIComponent(reference.id)}`;
  if (reference.kind === "image_asset") return `/api/media-history/content?assetId=${encodeURIComponent(reference.id)}`;
  if (reference.kind === "image_record") return `/api/media-history/content?recordId=${encodeURIComponent(reference.id)}`;
  return `/api/media-history/content?id=${encodeURIComponent(reference.id)}&index=${reference.index}`;
}

async function inspectFile(file: File): Promise<{ width?: number; height?: number; duration?: number }> {
  const url = URL.createObjectURL(file);
  try {
    if (file.type.startsWith("image/")) { const bitmap = await createImageBitmap(file); const result = { width: bitmap.width, height: bitmap.height }; bitmap.close(); return result; }
    return await new Promise((resolve, reject) => { const video = document.createElement("video"); const timer = window.setTimeout(() => { video.removeAttribute("src"); video.load(); reject(new Error("视频元信息读取超时，请检查文件")); }, 12000); video.preload = "metadata"; video.onloadedmetadata = () => { clearTimeout(timer); const result = { width: video.videoWidth, height: video.videoHeight, duration: video.duration }; video.removeAttribute("src"); video.load(); Number.isFinite(result.duration) && result.duration > 0 ? resolve(result) : reject(new Error("无法读取视频时长")); }; video.onerror = () => { clearTimeout(timer); reject(new Error("无法读取视频，请使用可播放的 MP4 文件")); }; video.src = url; });
  } finally { URL.revokeObjectURL(url); }
}

export function useNativePublishing(identity: WorkbenchIdentity) {
  const [center, setCenter] = useState<PublishingCenter | null>(null);
  const [ready, setReady] = useState(false); const [loading, setLoading] = useState(true);
  const [collections, setCollections] = useState<PublishingV2Collection[]>([]); const [drafts, setDrafts] = useState<PublishingV2Draft[]>([]); const [groups, setGroups] = useState<PublishingV2Group[]>([]);
  const [batches, setBatches] = useState<PublishingV2Batch[]>([]); const [attempts, setAttempts] = useState<PublishingV2Attempt[]>([]); const [events, setEvents] = useState<PublishingV2EventRecord[]>([]); const [schedules, setSchedules] = useState<PublishingV2Schedule[]>([]);
  const [editor, setEditor] = useState<NativeEditor>(blankNativeEditor); const [savedSignature, setSavedSignature] = useState("");
  const [busy, setBusy] = useState(""); const [error, setError] = useState(""); const [notice, setNotice] = useState("");
  const [files, setFiles] = useState<Map<string, File>>(new Map());
  const [liveAccounts, setLiveAccounts] = useState<Record<string, PublishingPluginAccount>>({}); const [confirmed, setConfirmed] = useState<string[]>([]); const [pluginVersion, setPluginVersion] = useState("");
  const [progress, setProgress] = useState<PublishingPluginProgress | null>(null); const [pending, setPending] = useState<Pending | null>(null); const [pendingLoaded, setPendingLoaded] = useState(false); const [legacyPending, setLegacyPending] = useState(false);
  const [activeSchedule, setActiveSchedule] = useState<PublishingV2Schedule | null>(null);
  const [more, setMore] = useState<Partial<Record<Resource, boolean>>>({});
  const pages = useRef<Partial<Record<Resource, number>>>({}); const lock = useRef(false); const mounted = useRef(false); const currentToken = useRef(identity.token); const editorRef = useRef(editor); const fileRef = useRef(files); const runner = useRef(createPublishingPluginRunner());
  const pendingKey = workbenchUserStorageKey("publishing.pending-execution.v2", identity.userId);
  useLayoutEffect(() => { currentToken.current = identity.token; editorRef.current = editor; fileRef.current = files; }, [identity.token, editor, files]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const ownerCurrent = useCallback(() => mounted.current && currentToken.current === identity.token && localStorage.getItem("auth_token") === identity.token, [identity.token]);
  const assertOwner = useCallback(() => { if (!ownerCurrent()) throw new Error("本站登录身份已变化，已停止操作。请重新登录并核对原任务。"); }, [ownerCurrent]);
  const post = useCallback(async (action: PublishingV2Action) => {
    assertOwner(); const payload = PublishingV2ActionSchema.parse(action);
    const response = await api.post("/api/publish-center/v2", payload, { token: identity.token, retries: 0 }); assertOwner();
    if (!response.success) throw new NativeRequestError(typeof response.error === "string" ? response.error : "操作结果待核对，请勿重复提交", typeof response.code === "string" ? response.code : undefined, response.outcome === "unknown");
    const parsed = PublishingV2MutationSchema.safeParse(response.data); if (!parsed.success) throw new NativeRequestError("返回格式待核对，请刷新原记录，不要重发", undefined, true); return parsed.data;
  }, [assertOwner, identity.token]);
  const refreshCenter = useCallback(async () => { const response = await api.get("/api/publish-center", { token: identity.token, retries: 0 }); assertOwner(); if (!response.success) throw new Error(typeof response.error === "string" ? response.error : "无法读取发布服务"); const value = PublishingCenterSchema.parse(response.data); setCenter(value); return value; }, [identity.token, assertOwner]);
  const loadResource = useCallback(async (resource: Resource, append = false) => {
    const page = append ? (pages.current[resource] || 1) + 1 : 1;
    const response = await api.get(`/api/publish-center/v2?resource=${resource}&page=${page}&pageSize=50${resource === "events" ? "&eventKind=browser_report" : ""}`, { token: identity.token, retries: 0 }); assertOwner();
    if (!response.success) throw new Error(typeof response.error === "string" ? response.error : "内容工作台暂不可用");
    const value = PublishingV2PageSchema.parse(response.data); if (!value.schemaReady) { setReady(false); return; } setReady(true); pages.current[resource] = page; setMore(previous => ({ ...previous, [resource]: value.hasMore }));
    switch (resource) {
      case "collections": { const items = value.items.map(item => PublishingV2CollectionSchema.parse(item)); setCollections(previous => append ? [...previous, ...items] : items); break; }
      case "drafts": { const items = value.items.map(item => PublishingV2DraftSchema.parse(item)); setDrafts(previous => append ? [...previous, ...items] : items); break; }
      case "groups": { const items = value.items.map(item => PublishingV2GroupSchema.parse(item)); setGroups(previous => append ? [...previous, ...items] : items); break; }
      case "batches": { const items = value.items.map(item => PublishingV2BatchSchema.parse(item)); setBatches(previous => append ? [...previous, ...items] : items); break; }
      case "attempts": { const items = value.items.map(item => PublishingV2AttemptSchema.parse(item)); setAttempts(previous => append ? [...previous, ...items] : items); break; }
      case "events": { const items = value.items.map(item => PublishingV2EventRecordSchema.parse(item)); setEvents(previous => append ? [...previous, ...items] : items); break; }
      case "schedules": { const items = value.items.map(item => PublishingV2ScheduleSchema.parse(item)); setSchedules(previous => append ? [...previous, ...items] : items); break; }
    }
  }, [identity.token, assertOwner]);
  const refresh = useCallback(async () => { await Promise.all([refreshCenter(), ...(["collections", "drafts", "groups", "batches", "attempts", "events", "schedules"] as Resource[]).map(resource => loadResource(resource))]); }, [refreshCenter, loadResource]);
  const run = useCallback(async (label: string, action: () => Promise<void>) => { if (lock.current) return; lock.current = true; setBusy(label); setError(""); setNotice(""); try { assertOwner(); await action(); } catch (reason) { if (mounted.current) setError(reason instanceof Error ? reason.message : "操作未完成"); } finally { lock.current = false; if (mounted.current) setBusy(""); } }, [assertOwner]);
  useEffect(() => {
    let active = true; setLoading(true);
    try { const value: unknown = JSON.parse(localStorage.getItem(pendingKey) || "null"); if (value) { const candidate = value as Pending; const action = PublishingV2ActionSchema.parse(candidate.action); if (!["claim", "create-batch"].includes(action.action)) throw new Error(); const report = candidate.report ? PublishingV2ActionSchema.parse(candidate.report) : undefined; if (report && report.action !== "report") throw new Error(); setPending({ action, ...(candidate.attemptId ? { attemptId: candidate.attemptId } : {}), ...(report?.action === "report" ? { report } : {}) }); } setPendingLoaded(true); setLegacyPending(localStorage.getItem(workbenchUserStorageKey("publishing.pending-execution.v1", identity.userId)) !== null); } catch { setError("待核对记录无法读取，已暂停执行。请保留浏览器数据并核对原任务。"); setPendingLoaded(false); }
    void refresh().catch(reason => { if (active) setError(reason instanceof Error ? reason.message : "读取失败"); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [refresh, pendingKey, identity.userId]);
  const persistPending = (value: Pending | null) => { assertOwner(); if (value) localStorage.setItem(pendingKey, JSON.stringify(value)); else localStorage.removeItem(pendingKey); setPending(value); };
  const patchEditor = (patch: Partial<PublishingV2DraftInput>) => { if (activeSchedule) { setActiveSchedule(null); setNotice("你已修改计划对应的草稿。本次改为手动新发布，原计划仍保留在日历中，不会自动完成。"); } setEditor(previous => ({ ...previous, payload: { ...previous.payload, ...patch } })); };
  const saveEditor = async () => {
    const current = editorRef.current; const signature = JSON.stringify(current.payload);
    if (current.id && signature === savedSignature) return { id: current.id, revision: current.revision, payload: current.payload };
    const result = await post({ action: "save-draft", ...(current.id ? { id: current.id } : {}), expectedRevision: current.revision, draft: current.payload });
    if (!result.draft) throw new NativeRequestError("草稿保存结果待核对，请先刷新内容库", undefined, true);
    setEditor(previous => ({ ...previous, id: result.draft!.id, revision: result.draft!.revision, ...(JSON.stringify(previous.payload) === signature ? { payload: result.draft!.payload } : {}) })); editorRef.current = { ...editorRef.current, id: result.draft.id, revision: result.draft.revision, ...(JSON.stringify(editorRef.current.payload) === signature ? { payload: result.draft.payload } : {}) }; setSavedSignature(JSON.stringify(result.draft.payload)); setDrafts(previous => [result.draft!, ...previous.filter(item => item.id !== result.draft!.id)]); return result.draft;
  };
  const addFiles = async (selected: File[], role: PublishingV2Media["role"]) => {
    const additions: PublishingV2Media[] = []; const nextFiles = new Map(fileRef.current);
    for (const file of selected) { if (file.size <= 0 || file.size > 10 * 1024 ** 3) throw new Error("文件为空或超过 10 GB"); if (role === "video" ? !/\.mp4$/i.test(file.name) : !["image/jpeg", "image/png", "image/webp"].includes(file.type)) throw new Error("请选择 MP4 视频或 JPG/PNG/WebP 图片"); const id = crypto.randomUUID(); additions.push({ id, role, fileName: file.name, size: file.size, type: file.type || "video/mp4", lastModified: file.lastModified, source: "local_file", requiresReselection: true, ...await inspectFile(file) }); nextFiles.set(id, file); }
    const previous = editorRef.current.payload.media; if (previous.length + additions.length > 30) throw new Error("每份草稿最多保存 30 个素材信息"); setFiles(nextFiles); fileRef.current = nextFiles; patchEditor({ media: [...previous, ...additions] });
  };
  const readMainFile = async (media: Extract<PublishingV2Media, { source: "main_asset" }>) => { const response = await fetch(mainAssetPath(media.reference), { headers: { Authorization: `Bearer ${identity.token}` }, cache: "no-store" }); assertOwner(); if (!response.ok) throw new Error("作品素材已过期或当前账号不可读取，请重新选择"); const blob = await response.blob(); if (!blob.size) throw new Error("素材内容为空"); return new File([blob], media.fileName, { type: blob.type || media.type, lastModified: media.lastModified }); };
  const importMain = async (item: MainMediaItem, role: PublishingV2Media["role"]) => {
    if (!item.downloadPath) throw new Error("该作品暂不可读取"); const url = new URL(item.downloadPath, window.location.origin); if (url.origin !== window.location.origin) throw new Error("仅允许读取本站作品");
    let reference: Extract<PublishingV2Media, { source: "main_asset" }>["reference"];
    const videoId = /^\/api\/video\/storage\/([a-f0-9-]{36})$/i.exec(url.pathname)?.[1];
    if (videoId) reference = { kind: "video_task", id: videoId };
    else if (url.pathname === "/api/media-history/content" && url.searchParams.get("assetId")) reference = { kind: "image_asset", id: url.searchParams.get("assetId")! };
    else if (url.pathname === "/api/media-history/content" && url.searchParams.get("recordId")) reference = { kind: "image_record", id: url.searchParams.get("recordId")! };
    else if (url.pathname === "/api/media-history/content" && url.searchParams.get("id") && /^\d+$/.test(url.searchParams.get("index") || "")) reference = { kind: "image_gallery", id: url.searchParams.get("id")!, index: Number(url.searchParams.get("index")) };
    else throw new Error("该作品来源暂不支持发布导入");
    const id = crypto.randomUUID(); const stub: Extract<PublishingV2Media, { source: "main_asset" }> = { id, role, fileName: `${item.title.slice(0, 100) || "主站作品"}.${item.kind === "video" ? "mp4" : "png"}`, size: 0, type: item.kind === "video" ? "video/mp4" : "image/png", lastModified: Date.now(), source: "main_asset", requiresReselection: false, reference };
    const file = await readMainFile(stub); const media = { ...stub, size: file.size, type: file.type, ...await inspectFile(file) }; assertOwner(); const retained = editorRef.current.payload.media; if (retained.length >= 30) throw new Error("素材数量已达上限"); const next = new Map(fileRef.current); next.set(id, file); fileRef.current = next; setFiles(next); patchEditor({ media: [...retained, media] }); setNotice("已从主站作品读取真实素材；草稿仅保存受控来源引用。");
  };
  const reselectFile = async (media: PublishingV2Media, file: File) => { if (media.source !== "local_file") throw new Error("请重新从主站作品选择此素材"); if (file.name !== media.fileName || file.size !== media.size || file.lastModified !== media.lastModified) throw new Error("所选文件与原素材信息不一致。请删除旧素材后添加新文件。"); const probe = await inspectFile(file); assertOwner(); if (!editorRef.current.payload.media.some(item => item.id === media.id)) throw new Error("草稿素材已变化，请重新选择需要关联的素材"); const next = new Map(fileRef.current); next.set(media.id, file); fileRef.current = next; setFiles(next); patchEditor({ media: editorRef.current.payload.media.map(item => item.id === media.id ? { ...item, ...probe, type: file.type || item.type } : item) }); };
  const restoreDraft = async (draft: PublishingV2Draft, localPlan?: PublishingV2Schedule) => { if (JSON.stringify(editorRef.current.payload) !== savedSignature && (editorRef.current.payload.title || editorRef.current.payload.media.length) && !window.confirm("当前编辑尚未保存，确认切换草稿？")) return; setActiveSchedule(localPlan || null); setEditor({ id: draft.id, revision: draft.revision, payload: draft.payload }); editorRef.current = { id: draft.id, revision: draft.revision, payload: draft.payload }; setSavedSignature(JSON.stringify(draft.payload)); setConfirmed([]); setProgress(null); const next = new Map<string, File>(); for (const media of draft.payload.media) { if (media.source === "main_asset") { try { next.set(media.id, await readMainFile(media)); } catch { setNotice("草稿已恢复，部分主站素材已失效。请重新选择；本机素材也需要重新关联原文件。"); } } } assertOwner(); setFiles(next); fileRef.current = next; };
  const detect = async (platform: PublishingPlatform) => {
    if (platform === "douyin") throw new Error("抖音官方 API 接力尚未配置，不能使用插件直发");
    const detected = await inspectPublishingPlugin(platform); assertOwner();
    const displayName = detected.account.nickname || detected.account.account || detected.account.uid;
    let account = center?.accounts.find(item => item.platform === platform && item.platformAccountId === detected.account.uid && item.displayName === displayName && (item.avatar || "") === (detected.account.avatar || ""));
    if (!account) {
      const response = await api.post("/api/publish-center", PublishingActionSchema.parse({ action: "save-account", account: { platform, platformAccountId: detected.account.uid, displayName, ...(detected.account.avatar ? { avatar: detected.account.avatar } : {}) } }), { token: identity.token, retries: 0 });
      assertOwner(); if (!response.success) throw new Error("当前账号摘要未保存，请重新读取"); account = PublishingMutationResponseSchema.parse(response.data).account; if (!account) throw new Error("账号摘要返回无效");
    }
    const accountId = account.id;
    setLiveAccounts(previous => ({ ...previous, [accountId]: detected.account })); setConfirmed(previous => previous.filter(id => id !== accountId)); setPluginVersion(detected.version); await refreshCenter(); setNotice("已读取当前浏览器账号。摘要未变化时复用原记录，发布前请勾选确认。");
  };
  const executeUnlocked = async () => {
    assertOwner(); if (pending || !pendingLoaded || legacyPending || localStorage.getItem(pendingKey)) throw new Error("存在待核对提交，当前不能再次发起");
    const draft = await saveEditor(); if (!center?.config.executionEnabled || !ready) throw new Error("外部发布尚未开放，内容和排期可以先保存");
    const executionTargets = activeSchedule ? draft.payload.targets.filter(target => target.id === activeSchedule.targetId) : draft.payload.targets;
    if (activeSchedule && (draft.id !== activeSchedule.draftId || draft.revision !== activeSchedule.draftVersion)) throw new Error("草稿版本已变化，请从日历重新打开计划，或退出该计划后手动发布");
    if (!executionTargets.length) throw new Error("请先选择至少一个有效目标账号");
    for (const target of executionTargets) { if (!center.accounts.some(item => item.id === target.accountId)) throw new Error("目标账号不可用"); if (target.platform === "douyin") throw new Error("抖音官方接力服务未配置"); if (!NATIVE_PLATFORM_CAPABILITIES.find(item => item.platform === target.platform)?.contentTypes.some(type => type === draft.payload.contentType)) throw new Error("目标平台不支持当前内容类型"); }
    for (const target of executionTargets) {
      const effective = target.mediaIds ? target.mediaIds.map(mediaId => draft.payload.media.find(item => item.id === mediaId)).filter((item): item is PublishingV2Media => !!item) : draft.payload.media.filter(item => item.role !== "cover");
      const covers = target.coverMediaId ? draft.payload.media.filter(item => item.id === target.coverMediaId) : target.mediaIds ? [] : draft.payload.media.filter(item => item.role === "cover");
      const actualMedia = (item: PublishingV2Media) => { const file = fileRef.current.get(item.id); return file ? { ...item, fileName: file.name, type: file.type, size: file.size } : item; };
      const prepared = prepareNativePluginContent(target.platform, target.titleOverride ?? draft.payload.title, target.bodyOverride ?? draft.payload.body, target.topicsOverride ?? draft.payload.topics);
      const errors = [...prepared.errors, ...validateNativePublishingMedia(target.platform, draft.payload.contentType, effective.map(actualMedia), covers[0] ? actualMedia(covers[0]) : undefined, target.scheduledAt)];
      if (draft.payload.contentType === "video" && covers.length !== 1) errors.push("请为当前目标明确选择一张封面");
      if (errors.length) throw new Error(errors.join("；"));
    }
    const batchAction: Extract<PublishingV2Action, { action: "create-batch" }> = { action: "create-batch", draftId: draft.id, draftVersion: draft.revision, targetIds: executionTargets.map(item => item.id), idempotencyKey: `batch:${draft.id}:${draft.revision}:${activeSchedule?.id || "manual"}` };
    persistPending({ action: batchAction }); const created = await post(batchAction).catch(reason => { if (reason instanceof NativeRequestError && !reason.unknown && reason.code && provedFirstRejection.has(reason.code)) persistPending(null); throw reason; }); if (!created.batch) throw new NativeRequestError("批次结果待核对", undefined, true); persistPending(null);
    const reserved = new Map<string, number>();
    for (const target of executionTargets) {
      assertOwner(); const requestKey = `claim:${created.batch.id}:${target.id}`;
      const priorResponse = await api.get(`/api/publish-center/v2?resource=attempts&requestKey=${encodeURIComponent(requestKey)}&pageSize=1`, { token: identity.token, retries: 0 }); assertOwner(); if (!priorResponse.success) throw new Error("原目标记录暂不可核对，已停止领取新的执行许可"); const priorPage = PublishingV2PageSchema.parse(priorResponse.data); if (!priorPage.schemaReady) throw new Error("原目标记录尚未就绪，已停止执行");
      if (priorPage.items.length) {
        const prior = PublishingV2AttemptSchema.parse(priorPage.items[0]); const reportResponse = await api.get(`/api/publish-center/v2?resource=events&attemptId=${prior.id}&eventKind=browser_report&pageSize=1`, { token: identity.token, retries: 0 }); assertOwner();
        if (reportResponse.success && PublishingV2PageSchema.parse(reportResponse.data).items.some(item => { const event = PublishingV2EventRecordSchema.safeParse(item); return event.success && event.data.kind === "browser_report"; })) continue;
        persistPending({ action: { action: "claim", batchId: created.batch.id, targetId: target.id, entitlementId: prior.entitlementId, idempotencyKey: requestKey, ...(activeSchedule ? { scheduleId: activeSchedule.id } : {}) }, attemptId: prior.id }); throw new Error("此目标已受理但尚无浏览器报告，结果待核对，不会重新领取或再次发布。");
      }
      const expected = liveAccounts[target.accountId]; if (!confirmed.includes(target.accountId) || !expected) throw new Error("请读取并确认尚未发起的目标浏览器账号"); const fresh = await inspectPublishingPlugin(target.platform); assertOwner(); if (fresh.account.uid !== expected.uid) throw new Error("浏览器账号已变化，批次后续目标已暂停，请重新读取并确认");
      const used = target.mediaIds ? draft.payload.media.filter(media => target.mediaIds!.includes(media.id)) : draft.payload.media.filter(media => media.role !== "cover"); const selectedCover = target.coverMediaId ? draft.payload.media.find(media => media.id === target.coverMediaId) : target.mediaIds ? undefined : draft.payload.media.find(media => media.role === "cover"); for (const media of [...used, ...(selectedCover ? [selectedCover] : [])]) if (!fileRef.current.has(media.id)) throw new Error("请重新关联本次目标使用的全部素材文件");
      const entitlement = [...center.entitlements].filter(item => item.platforms.includes(target.platform) && item.used + (reserved.get(item.id) || 0) < item.quota && Date.parse(item.expiresAt) > Date.now()).sort((a, b) => a.expiresAt.localeCompare(b.expiresAt))[0]; if (!entitlement) throw new Error("当前目标没有可用执行额度，批次后续目标已暂停");
      const claim: Claim = { action: "claim", batchId: created.batch.id, targetId: target.id, entitlementId: entitlement.id, idempotencyKey: `claim:${created.batch.id}:${target.id}`, ...(activeSchedule && activeSchedule.targetId === target.id ? { scheduleId: activeSchedule.id } : {}) };
      if (localStorage.getItem(pendingKey)) throw new Error("另一个页面已有待核对任务"); persistPending({ action: claim }); const permit = await post(claim).catch(reason => { if (reason instanceof NativeRequestError && !reason.unknown && reason.code && provedFirstRejection.has(reason.code)) persistPending(null); throw reason; }); if (!permit.attempt) throw new NativeRequestError("执行许可结果待核对", undefined, true); persistPending({ action: claim, attemptId: permit.attempt.id });
      if (permit.shouldExecute !== true) { const recorded = await api.get(`/api/publish-center/v2?resource=events&attemptId=${permit.attempt.id}&eventKind=browser_report&pageSize=1`, { token: identity.token, retries: 0 }); assertOwner(); if (recorded.success && PublishingV2PageSchema.parse(recorded.data).items.some(item => { const event = PublishingV2EventRecordSchema.safeParse(item); return event.success && event.data.kind === "browser_report"; })) { persistPending(null); continue; } await refresh(); throw new Error("此子任务已受理，结果待核对，不会再次调用插件。"); } reserved.set(entitlement.id, (reserved.get(entitlement.id) || 0) + 1);
      const frozen = permit.attempt.snapshot; const payload = frozen.draft; const frozenTarget = frozen.target;
      if (expected.uid !== frozen.account.platformAccountId || expected.platform !== frozen.account.platform) throw new Error("执行快照的账号与当前确认账号不一致，未调用插件");
      const effectiveMedia = frozenTarget.mediaIds ? frozenTarget.mediaIds.map(id => payload.media.find(item => item.id === id)).filter((item): item is PublishingV2Media => !!item) : payload.media.filter(item => item.role !== "cover");
      const videoMeta = effectiveMedia.find(item => item.role === "video"); const coverMeta = frozenTarget.coverMediaId ? payload.media.find(item => item.id === frozenTarget.coverMediaId) : frozenTarget.mediaIds ? undefined : payload.media.find(item => item.role === "cover");
      const prepared = prepareNativePluginContent(frozenTarget.platform, frozenTarget.titleOverride ?? payload.title, frozenTarget.bodyOverride ?? payload.body, frozenTarget.topicsOverride ?? payload.topics); if (prepared.errors.length) throw new Error(prepared.errors.join("；"));
      const common = { platform: frozenTarget.platform, title: prepared.title, desc: prepared.desc, topics: prepared.topics, requestId: permit.attempt.id, platformConfig: buildNativePluginPlatformConfig(frozenTarget.platform, { [frozenTarget.platform]: frozenTarget.options }, videoMeta?.width && videoMeta.height && videoMeta.duration ? { width: videoMeta.width, height: videoMeta.height, duration: videoMeta.duration, size: fileRef.current.get(videoMeta.id)?.size ?? videoMeta.size } : undefined), ...(frozenTarget.scheduledAt ? { scheduledTime: Date.parse(frozenTarget.scheduledAt) } : {}) };
      let params: PublishingPluginParams;
      if (payload.contentType === "video") { const video = videoMeta && fileRef.current.get(videoMeta.id); if (!video) throw new Error("执行快照对应的视频不可用，未调用插件"); params = { ...common, type: "video", video, ...(coverMeta && fileRef.current.get(coverMeta.id) ? { cover: fileRef.current.get(coverMeta.id)! } : {}) }; }
      else params = { ...common, type: "image", images: effectiveMedia.filter(item => item.role === "image").map(item => { const file = fileRef.current.get(item.id); if (!file) throw new Error("执行快照对应的图片不可用"); return file; }) };
      setProgress({ stage: "upload", progress: 0 }); let receipt;
      try { receipt = await runner.current.executeNative({ attemptId: permit.attempt.id, shouldExecute: permit.shouldExecute, platform: frozenTarget.platform }, expected, params, setProgress, ownerCurrent); } catch (reason) { throw new Error(publishingPluginMessage(reason)); }
      assertOwner(); const report = PublishingV2ActionSchema.parse({ action: "report", attemptId: permit.attempt.id, idempotencyKey: `report:${permit.attempt.id}`, success: receipt.success, ...(receipt.workId ? { workId: receipt.workId } : {}), ...(receipt.shareLink ? { shareLink: receipt.shareLink } : {}), ...(receipt.mediaMd5sum ? { mediaMd5sum: receipt.mediaMd5sum } : {}), ...(receipt.videoClipTaskId ? { videoClipTaskId: receipt.videoClipTaskId } : {}), ...(receipt.scheduledTime !== undefined ? { scheduledTime: receipt.scheduledTime } : {}), ...(receipt.publishTime ? { publishTime: receipt.publishTime } : {}), ...(receipt.errorCode ? { errorCode: receipt.errorCode } : {}) }); if (report.action !== "report") throw new Error("报告类型无效"); persistPending({ action: claim, attemptId: permit.attempt.id, report }); await post(report); persistPending(null); setProgress(null);
    }
    setConfirmed([]); setActiveSchedule(null); await refresh(); setNotice("浏览器报告已保存，请到各平台核对实际作品。不会自动重发或返还额度。");
  };
  const execute = async () => { if (!navigator.locks) throw new Error("当前浏览器不支持安全执行锁，请使用最新版 Chrome 或 Edge"); await navigator.locks.request(workbenchUserStorageKey("publishing.execution-lock.v2", identity.userId), { ifAvailable: true }, async held => { if (!held) throw new Error("另一个页面正在处理发布批次，请先核对该页面"); await executeUnlocked(); }); };
  const syncPending = async () => {
    if (!pending) return;
    if (pending.report) { await post(pending.report); persistPending(null); setNotice("原浏览器报告已同步，仍需核对平台作品"); }
    else {
      const requestKey = "idempotencyKey" in pending.action ? pending.action.idempotencyKey : ""; const resource = pending.action.action === "create-batch" ? "batches" : "attempts";
      const response = await api.get(`/api/publish-center/v2?resource=${resource}&requestKey=${encodeURIComponent(requestKey)}`, { token: identity.token, retries: 0 }); assertOwner(); if (!response.success) throw new Error("原任务暂不可查询，已保留待核对记录"); const page = PublishingV2PageSchema.parse(response.data);
      if (resource === "batches" && page.items.length) { persistPending(null); setNotice("已找到原批次。未重新领取执行许可，请先核对批次详情。"); }
      else if (resource === "attempts" && page.items.length) {
        const attempt = PublishingV2AttemptSchema.parse(page.items[0]); const recorded = await api.get(`/api/publish-center/v2?resource=events&attemptId=${attempt.id}&eventKind=browser_report&pageSize=1`, { token: identity.token, retries: 0 }); assertOwner();
        const hasReport = recorded.success && PublishingV2PageSchema.parse(recorded.data).items.some(item => { const event = PublishingV2EventRecordSchema.safeParse(item); return event.success && event.data.kind === "browser_report"; });
        if (hasReport) { persistPending(null); setNotice("原任务已有浏览器报告，已解除本机待核对标记；平台结果仍需核对。"); } else setNotice("已找到原执行，结果仍待平台核对。不会重新调用插件。");
      } else setNotice("原提交暂未查到，可能仍在处理中。已保留记录，不会自动重发。");
    }
    await refresh();
  };
  return { center, ready, loading, collections, drafts, groups, batches, attempts, events, schedules, editor, setEditor, patchEditor, savedSignature, files, setFiles, busy, error, setError, notice, setNotice, liveAccounts, confirmed, setConfirmed, pluginVersion, progress, pending, pendingLoaded, legacyPending, activeSchedule, setActiveSchedule, more, run, post, refresh, loadResource, saveEditor, addFiles, restoreDraft, detect, execute, syncPending, readMainFile, importMain, reselectFile, assertOwner, identity };
}
export type NativePublishingState = ReturnType<typeof useNativePublishing>;
