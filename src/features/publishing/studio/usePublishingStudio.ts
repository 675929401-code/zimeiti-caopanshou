'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { z } from 'zod'
import { NativePreparedPublishSchema, nativePreparePlanCanonical, type NativePreparedPublish, type NativePreparePublish } from '@/lib/native-operations-contract'
import type { PublishingStudioBootstrap } from '@/lib/publishing-studio-contract'
import { PublishingV3AuthSessionSchema, PublishingV3MutationSchema, PublishingV3OperationSchema, PublishingV3PageSchema, PublishingV3UserActionSchema } from '@/lib/publishing-v3-contract'
import { PublishingV2MutationSchema } from '@/lib/publishing-v2-contract'
import { PublishingStudioDraftSchema, PublishingStudioPlanSchema } from '@/lib/publishing-studio-contract'
import { nativeAssetPath } from '@/lib/native-operations-contract'
import { nativeMainMediaPath } from '@/lib/native-main-media-contract'
import type { PublishingAuthorizationSession } from '@/lib/publishing-authorization-contract'
import { inspectPublishingPlugin, publishingPluginMessage } from '@/lib/publishing-plugin'
import { assertHostSession, getHostSession, getHostSessionRevision, hostStorageKey, loadHostSession, subscribeHostSession } from './host-session'
import { nativeSha256 } from './native-assets'
import { buildNativePublishPlan, readNativePlanFiles } from './native-publish-plan'
import { confirmNativeOfficialMainMedia } from './native-media-bridge-client'
import { readNativeUnclaimedAccountIds, executeNativePublishing, executeNativeScheduledPublish, prepareNativePublishing, readNativePending, recoverNativePublish, subscribeNativePending } from './native-publishing'
import { isNativeOAuthPlatform, readNativeOAuthSession, safeNativeAuthorizationUrl, selectNativeOAuth, startNativeOAuth } from './native-oauth'
import { selectNativeAuthorization, startNativeAuthorization } from './native-auth'
import { projectStudioHistory, projectStudioGenericRecord, readStudioHistory, readStudioHistoryPage, readStudioImport, readStudioWorkspace, studioRequest } from './studio-api'
import { allDraftMedia, assertStudioPreflight, copyStudioDraft, effectiveStudioTargetContent, emptyStudioDraft, freezeStudioDraft, materializeStudioDraft, readStudioMedia, studioContentHash, studioPlanItems, targetStudioMedia } from './studio-draft'
import { restoreStudioStoredDraft, restoreStudioLegacyDraft, saveStudioDraft } from './studio-save'
import { reselectStudioPlanFiles } from './studio-plan-recovery'
import { completeStudioGeneric, readStudioGenericOriginalDraft, observeStudioGeneric, executeStudioGeneric, prepareStudioGeneric, readStudioGenericPending } from './studio-generic'
import { PublishingGenericMutationSchema, type PublishingGenericMutation } from '@/lib/publishing-generic-contract'
import { buildStudioBrowserLocalPlan, prepareStudioBrowserLocal, readBrowserLocalPending, recoverBrowserLocalPending, completeBrowserLocalPlan, subscribeBrowserLocalPending } from './studio-browser-local'
import { prepareStudioLegacyPlan, readStudioLegacyPending, recoverStudioLegacyPending, completeStudioLegacyPlan, subscribeStudioLegacyPending, verifyStudioLegacyPrepared } from './studio-legacy-plan'
import type { PublishingStudioController, StudioAccount, StudioAuthorization, StudioBridgeConfirmation, StudioCheck, StudioDraft, StudioHistoryItem, StudioHistoryQuery, StudioImportItem, StudioMedia, StudioPlatform, StudioReview } from './types'

import { publishingCashQuoteProof, type PublishingCashQuote } from '@/lib/publishing-cash-contract'
import { assertStudioCashFresh, buildStudioCashInput, readStudioCashQuote } from './studio-cash'
import { legacyStudioCashInput } from './studio-cash-legacy'
import { readStudioCashPending, rememberStudioCashPending, restoreStudioCashPending, completeStudioCashPending } from './studio-cash-recovery'

interface FrozenReview { legacyCash?: { prepared?: NativePreparedPublish; plan?: NativePreparePublish; generic?: PublishingGenericMutation; local?: boolean }; cashQuote: PublishingCashQuote; recovery?: boolean; remainingIds: string[]; id: string; owner: string; sessionRevision: number; editRevision: number; draft: StudioDraft; accounts: StudioAccount[]; contentHash: string; resume?: z.infer<typeof PublishingStudioPlanSchema> }
const networkFailure = (reason: unknown) => reason instanceof TypeError && /failed to fetch|networkerror|load failed/iu.test(reason.message)
const message = (reason: unknown) => reason instanceof z.ZodError ? '输入或服务回执不符合发布合同，请检查字段并重新读取' : networkFailure(reason) ? '网络连接中断，请检查本地发布服务后刷新重试' : reason instanceof Error ? reason.message : '操作结果暂不可确认，请核对原记录'

export function usePublishingStudio(): PublishingStudioController {
  const [session, setSession] = useState<PublishingStudioController['session']>({ loading: true, authenticated: false })
  const [workspace, setWorkspace] = useState<PublishingStudioController['workspace']>({ loading: true, ready: false })
  const [draft, setDraft] = useState<StudioDraft>(emptyStudioDraft)
  const [accounts, setAccounts] = useState<StudioAccount[]>([]), [platforms, setPlatforms] = useState<StudioPlatform[]>([])
  const [bootstrap, setBootstrap] = useState<PublishingStudioBootstrap | null>(null)
  const [busy, setBusy] = useState<string | null>(null), [error, setError] = useState<string | null>(null), [notice, setNotice] = useState<string | null>(null)
  const [checks, setChecks] = useState<StudioCheck[]>([]), [review, setReview] = useState<StudioReview | null>(null), [pending, setPending] = useState(false)
  const [history, setHistory] = useState<StudioHistoryItem[]>([]), [historyLoading, setHistoryLoading] = useState(false)
  const [historyPage, setHistoryPage] = useState({ page: 1, pageSize: 30, total: 0, hasMore: false })
  const [recordDetail, setRecordDetail] = useState<StudioHistoryItem | null>(null), [userAction, setUserAction] = useState<PublishingStudioController['userAction']>(null)
  const [importItems, setImportItems] = useState<StudioImportItem[]>([]), [importLoading, setImportLoading] = useState(false), [importOpen, setImportOpen] = useState(false)
  const [bridgeConfirmation, setBridgeConfirmation] = useState<StudioBridgeConfirmation | null>(null), [authorization, setAuthorization] = useState<StudioAuthorization | null>(null)
  const [authorizationFlow, setAuthorizationFlow] = useState<PublishingStudioController['authorizationFlow']>(null)
  const frozen = useRef<FrozenReview | null>(null), editing = useRef(0), busyRef = useRef(false), mounted = useRef(false)
  const draftRef = useRef(draft), accountsRef = useRef(accounts), bootstrapRef = useRef(bootstrap), platformsRef = useRef(platforms)
  const blobs = useRef(new Set<string>()), bridgeResolver = useRef<((approved: boolean) => void) | null>(null)
  const authRef = useRef<PublishingAuthorizationSession | z.infer<typeof PublishingV3AuthSessionSchema> | null>(null)
  const authorizationVisible = useRef(false)
  const authorizationGeneration = useRef(0)
  const importRevision = useRef(0), historyRequest = useRef(0)
  const resumePlan = useRef<z.infer<typeof PublishingStudioPlanSchema> | null>(null)
  draftRef.current = draft; accountsRef.current = accounts; bootstrapRef.current = bootstrap; platformsRef.current = platforms

  function invalidate() { editing.current++; frozen.current = null; setReview(null); setChecks([]) }
  function replaceDraft(next: StudioDraft) { invalidate(); resumePlan.current = null; draftRef.current = next; setDraft(next) }
  function revokeBlobs() { for (const url of blobs.current) URL.revokeObjectURL(url); blobs.current.clear() }
  function syncPending() { try { setPending(!!readNativePending() || !!readStudioGenericPending() || !!readBrowserLocalPending() || !!readStudioLegacyPending() || !!readStudioCashPending()) } catch (reason) { setPending(true); setError(message(reason)) } }
  function guard(owner: string, revision: number, edit?: number) {
    if (!mounted.current) throw new Error('工作台已关闭，已停止后续操作')
    assertHostSession(owner, revision)
    if (edit !== undefined && editing.current !== edit) throw new Error('内容已变化，原确认已失效，请重新检查')
  }
  async function run(label: string, work: () => Promise<void>) {
    if (busyRef.current) return
    const runOwner = getHostSession()?.user.id, runRevision = getHostSessionRevision()
    busyRef.current = true; setBusy(label); setError(null); setNotice(null)
    try { await work() } catch (reason) { if (mounted.current) { setError(message(reason)); if (label === '检查发布内容') setChecks([{ id: 'preflight', label: '发布前检查', status: 'error', detail: message(reason) }]) } }
    finally {
      // Refresh the actual wallet once, including interrupted/uncertain executions. Never retry business actions.
      if (['确认并提交发布', '核对原发布任务'].includes(label) && mounted.current && runOwner && getHostSession()?.user.id === runOwner && getHostSessionRevision() === runRevision) {
        let timer: ReturnType<typeof setTimeout> | undefined
        try { await Promise.race([loadHostSession(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('余额读取超时')), 8000) })]) }
        catch { if (mounted.current && getHostSession()?.user.id === runOwner && getHostSessionRevision() === runRevision) setSession(value => ({ ...value, cashBalance: undefined })) }
        finally { if (timer !== undefined) clearTimeout(timer) }
      }
      busyRef.current = false; if (mounted.current) { setBusy(null); syncPending() }
    }
  }
  function installWorkspace(value: Awaited<ReturnType<typeof readStudioWorkspace>>) {
    const selected = new Set(accountsRef.current.filter(value => value.selected).map(value => value.id))
    const next = value.accounts.map(account => ({ ...account, selected: selected.has(account.id) }))
    accountsRef.current = next; bootstrapRef.current = value.bootstrap; platformsRef.current = value.platforms
    setAccounts(next); setPlatforms(value.platforms); setBootstrap(value.bootstrap)
    setWorkspace({ loading: false, ready: true })
  }
  async function refreshWorkspace() {
    const actor = assertHostSession(), revision = getHostSessionRevision()
    setWorkspace(value => ({ ...value, loading: true, error: undefined }))
    try { const value = await readStudioWorkspace(); guard(actor.user.id, revision); installWorkspace(value); return value }
    catch (reason) {
      if (mounted.current && getHostSession()?.user.id === actor.user.id && getHostSessionRevision() === revision) setWorkspace(value => ({ ...value, loading: false, error: message(reason) }))
      throw reason
    }
  }
  useEffect(() => {
    mounted.current = true
    const clear = () => {
      const current = getHostSession()
      if (current) { if (mounted.current) setSession({ loading: false, authenticated: true, userName: current.user.displayName || current.user.username, cashBalance: current.wallet.cashCents / 100, credits: current.wallet.credits }); return }
      invalidate(); revokeBlobs(); draftRef.current = emptyStudioDraft(); setDraft(draftRef.current); accountsRef.current = []; setAccounts([]); setPlatforms([]); setBootstrap(null); setHistory([]); setRecordDetail(null); setUserAction(null); setImportItems([]); setImportOpen(false); setAuthorization(null); authRef.current = null
      setWorkspace({ loading: false, ready: false })
      bridgeResolver.current?.(false); bridgeResolver.current = null; setBridgeConfirmation(null)
      authorizationGeneration.current++; authorizationVisible.current = false; setAuthorizationFlow(null); setSession({ loading: false, authenticated: false, error: '主站会话已变化，请重新进入工作台' })
    }
    const sessionOff = subscribeHostSession(clear), pendingOff = subscribeNativePending(syncPending), browserPendingOff = subscribeBrowserLocalPending(syncPending), legacyPendingOff = subscribeStudioLegacyPending(syncPending)
    const storage = (event: StorageEvent) => { if ([':pending-publish', ':browser-local-prepare', ':studio-generic-publish', ':studio-legacy-plan', ':studio-cash-publish'].some(suffix => event.key?.endsWith(suffix))) { invalidate(); syncPending() } }
    const refreshSession = () => { if (document.visibilityState === 'visible') void loadHostSession().catch(reason => { if (mounted.current) setError(message(reason)) }) }
    window.addEventListener('storage', storage); window.addEventListener('focus', refreshSession); document.addEventListener('visibilitychange', refreshSession)
    void (async () => {
      try {
        const actor = await loadHostSession(); if (!mounted.current) return
        setSession({ loading: false, authenticated: true, userName: actor.user.displayName || actor.user.username, cashBalance: actor.wallet.cashCents / 100, credits: actor.wallet.credits })
        await refreshWorkspace(); syncPending()
      } catch (reason) { if (mounted.current) { setSession(value => ({ ...value, loading: false, ...(!value.authenticated ? { error: message(reason) } : {}) })); setError(message(reason)) } }
    })()
    // This ref is a generation counter, intentionally advanced at cleanup; it is not a DOM node.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    return () => { mounted.current = false; editing.current++; frozen.current = null; sessionOff(); pendingOff(); browserPendingOff(); legacyPendingOff(); window.removeEventListener('storage', storage); window.removeEventListener('focus', refreshSession); document.removeEventListener('visibilitychange', refreshSession); bridgeResolver.current?.(false); bridgeResolver.current = null; revokeBlobs() }
    // Session lifetime is owned by this mounted workbench; actions use refs for current form state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function patchDraft(patch: Partial<StudioDraft>) { replaceDraft({ ...draftRef.current, ...patch }) }
  function patchTarget(id: string, patch: StudioDraft['targetOverrides'][string]) { patchDraft({ targetOverrides: { ...draftRef.current.targetOverrides, [id]: { ...draftRef.current.targetOverrides[id], ...patch } } }) }
  async function localMedia(file: File): Promise<StudioMedia> {
    if (!['image/jpeg', 'image/png', 'image/webp', 'video/mp4'].includes(file.type)) throw new Error('请选择 JPEG、PNG、WebP 图片或 MP4 成片；实际格式按所选平台检查')
    if (file.size <= 0 || file.size > (file.type === 'video/mp4' ? 100 : 20) * 1024 ** 2) throw new Error('图片应不超过 20 MiB，MP4 应不超过 100 MiB')
    const url = URL.createObjectURL(file); blobs.current.add(url)
    return readStudioMedia({ id: crypto.randomUUID(), name: file.name, url, kind: file.type.startsWith('video/') ? 'video' : 'image', size: file.size, file, status: 'reading', stage: 'local' })
  }
  async function addFiles(files: File[]) { await run('读取素材', async () => {
    const owner = assertHostSession().user.id, revision = getHostSessionRevision(), edit = editing.current
    const values = await Promise.all(files.map(localMedia)); guard(owner, revision, edit)
    if (resumePlan.current) {
      const restored = await reselectStudioPlanFiles(draftRef.current, values, () => guard(owner, revision, edit))
      invalidate(); draftRef.current = restored; setDraft(restored); setNotice('已核对原文件，原计划身份保持不变；检查并确认后才会执行'); return
    }
    const combined = [...draftRef.current.media, ...values]
    if (combined.length > 100 || new Set(combined.map(value => value.kind)).size > 1) throw new Error('素材池最多 100 份，请选择相同类型的图片或视频；每个平台的实际数量单独检查')
    patchDraft({ media: combined, contentType: combined[0]?.kind === 'video' ? 'video' : 'image' })
  }) }
  async function cover(file: File, accountId?: string) { await run('读取封面', async () => {
    const owner = assertHostSession().user.id, revision = getHostSessionRevision(), edit = editing.current
    if (!file.type.startsWith('image/')) throw new Error('封面需要一张图片')
    const value = await localMedia(file); guard(owner, revision, edit)
    if (resumePlan.current) {
      const restored = await reselectStudioPlanFiles(draftRef.current, [value], () => guard(owner, revision, edit))
      invalidate(); draftRef.current = restored; setDraft(restored); setNotice('已核对原封面，原计划身份保持不变；检查并确认后才会执行'); return
    }
    if (accountId) patchTarget(accountId, { cover: value }); else patchDraft({ cover: value })
  }) }
  function removeMedia(id: string) { const value = draftRef.current; patchDraft({ media: value.media.filter(item => item.id !== id), cover: value.cover?.id === id ? undefined : value.cover, targetOverrides: Object.fromEntries(Object.entries(value.targetOverrides).map(([key, override]) => [key, { ...override, mediaIds: override.mediaIds?.filter(value => value !== id), cover: override.cover?.id === id ? undefined : override.cover }])) }) }
  function toggleAccount(id: string) { invalidate(); resumePlan.current = null; const next = accountsRef.current.map(value => value.id === id ? { ...value, selected: !value.selected } : value); accountsRef.current = next; setAccounts(next) }

  async function loadImport(kind: 'media' | 'draft' = 'media') {
    const request = ++importRevision.current
    setImportLoading(true); setError(null)
    try { const actor = assertHostSession(), revision = getHostSessionRevision(); const values = await readStudioImport(kind); guard(actor.user.id, revision); if (request === importRevision.current) setImportItems(values) }
    catch (reason) { if (mounted.current && request === importRevision.current) setError(message(reason)) }
    finally { if (mounted.current && request === importRevision.current) setImportLoading(false) }
  }
  async function openImport() { setImportOpen(true); await loadImport('media') }
  async function importItem(id: string) { await run('导入内容', async () => {
    const item = importItems.find(item => item.id === id); if (!item) throw new Error('请重新选择当前导入列表中的条目')
    const owner = assertHostSession().user.id, revision = getHostSessionRevision(), edit = editing.current, current = () => guard(owner, revision, edit)
    if (item.kind === 'draft') {
      if (item.storage === 'studio') {
        const result = z.object({ id: z.string().uuid(), revision: z.number().int().positive(), payload: z.unknown() }).passthrough().parse(await studioRequest(`publishing/generic?resource=profile&draftId=${id}&draftVersion=${item.revision}`)); current()
        const restored = restoreStudioStoredDraft(result.id, result.revision, result.payload)
        replaceDraft(restored); setAccounts(previous => previous.map(account => ({ ...account, selected: !!restored.targetOverrides[account.id] }))); setImportOpen(false); setNotice('已恢复完整稿件；发布前会重新核对当前账号、素材和平台规则'); return
      }
      const result = PublishingStudioDraftSchema.parse(await studioRequest(`studio/drafts/${id}`)); current()
      const payload = result.draft.payload, metadata = result.metadata
      const selectedMedia = new Map<string, StudioMedia>()
      for (const item of payload.media) {
        const mapping = metadata.media.find(value => value.mediaId === item.id)!
        const source = 'source' in mapping ? mapping.source : { kind: 'provider_asset' as const, assetId: mapping.assetId }
        const url = source.kind === 'main_asset' ? nativeMainMediaPath(source.reference) : nativeAssetPath(source.assetId)
        const value = await readStudioMedia({ id: item.id, name: item.fileName, kind: item.role === 'video' ? 'video' : 'image', size: item.size, url, status: 'reading' }); current()
        if (value.id !== item.id || item.hash && await nativeSha256(value.file!) !== item.hash) throw new Error('草稿素材与保存时的来源或摘要不一致，请核对原素材')
        selectedMedia.set(item.id, { ...value, nativeMediaEntryId: result.mediaEntryRefs.find(reference => reference.mediaId === item.id)?.mediaEntryId })
      }
      const raw: StudioDraft = { ...emptyStudioDraft(), contentType: payload.contentType, title: payload.title, body: payload.body, topics: [...payload.topics], sourceDraftId: result.draft.id, sourceDraftVersion: result.draft.revision, sourceMetadataRevision: result.metadataRevision, collectionId: payload.collectionId || undefined, media: payload.media.filter(value => value.role !== 'cover').map(value => selectedMedia.get(value.id)!), ...(metadata.coverMediaId && selectedMedia.has(metadata.coverMediaId) ? { cover: selectedMedia.get(metadata.coverMediaId)! } : {}) }
      for (const target of payload.targets) {
        const options = target.platform === 'xhs' ? { xhs: target.options.declaration ? { userDeclarationBind: { origin: target.options.declaration } } : {} } : target.platform === 'wxSph' ? { wxSph: { poiInfo: target.options.poiInfo, activity: target.options.event, extLink: target.options.extLink, isOriginal: target.options.postFlag === 1 } } : {}
        raw.targetOverrides[target.accountId] = { title: target.titleOverride, body: target.bodyOverride, topics: target.topicsOverride, mediaIds: target.mediaIds ? [...target.mediaIds] : undefined, publishAt: target.scheduledAt ?? '', options, ...(target.coverMediaId ? { cover: selectedMedia.get(target.coverMediaId) } : {}) }
      }
      const schedules = [...new Set(payload.targets.flatMap(value => value.scheduledAt ? [value.scheduledAt] : []))]
      if (schedules.length === 1) raw.publishAt = schedules[0]
      current()
      const targetIds = new Set(payload.targets.map(value => value.accountId)), nextAccounts = accountsRef.current.map(value => ({ ...value, selected: targetIds.has(value.id) }))
      accountsRef.current = nextAccounts; setAccounts(nextAccounts); replaceDraft(raw)
    } else {
      const value = await readStudioMedia({ id: crypto.randomUUID(), name: item.title, url: item.url, kind: item.kind, size: 0, status: 'reading' }); current()
      const selected = [...draftRef.current.media, value]
      if (new Set(selected.map(value => value.kind)).size > 1 || selected.length > 30) throw new Error('请先清空不同类型素材；素材池最多 30 份同类型内容')
      patchDraft({ contentType: item.kind, media: selected })
    }
    setImportOpen(false); setNotice('已将所选内容导入当前稿件，尚未保存或发布')
  }) }
  async function checkDraft() { await run('检查发布内容', async () => {
    invalidate()
    const owner = assertHostSession().user.id, sessionRevision = getHostSessionRevision(), editRevision = editing.current
    const current = () => guard(owner, sessionRevision, editRevision)
    if (readNativePending() || readStudioGenericPending() || readBrowserLocalPending() || readStudioLegacyPending() || readStudioCashPending()) throw new Error('有一笔原提交需要核对，请先核对原任务')
    const snapshot = copyStudioDraft(draftRef.current), selected = accountsRef.current.filter(value => value.selected).map(value => ({ ...value }))
    snapshot.targetOverrides = Object.fromEntries(selected.flatMap(account => snapshot.targetOverrides[account.id] ? [[account.id, snapshot.targetOverrides[account.id]]] : []))
    const selectedMediaIds = new Set(selected.flatMap(account => targetStudioMedia(snapshot, account.id).map(value => value.id)))
    snapshot.media = snapshot.media.filter(value => selectedMediaIds.has(value.id))
    if (snapshot.contentType === 'image') { snapshot.cover = undefined; for (const value of Object.values(snapshot.targetOverrides)) value.cover = undefined }
    else if (selected.length && selected.every(account => snapshot.targetOverrides[account.id]?.cover)) snapshot.cover = undefined
    const live = await readStudioWorkspace(); current()
    for (const account of selected) if (account.kind === 'generic' && snapshot.targetOverrides[account.id]?.providerOptions === undefined) snapshot.targetOverrides[account.id] = { ...snapshot.targetOverrides[account.id], providerOptions: structuredClone(live.platforms.find(p => p.key === account.platform)?.defaultOption ?? {}) }
    assertSameAccounts(selected, live.accounts); installWorkspace(live)
    const loaded = await freezeStudioDraft(snapshot, current); current()
    assertStudioPreflight(loaded, selected, live.platforms, live.bootstrap)
    const contentHash = await studioContentHash(loaded, selected); current()
    await openCashReview(loaded, selected, selected.map(a => a.id), live, contentHash, owner, sessionRevision, editRevision, current, false, resumePlan.current ?? undefined)
  }) }
  async function openCashReview(loaded: StudioDraft, allAccounts: StudioAccount[], remainingIds: string[], live: Awaited<ReturnType<typeof readStudioWorkspace>>, contentHash: string, owner: string, sessionRevision: number, editRevision: number, current: () => void, recovery: boolean, resume?: z.infer<typeof PublishingStudioPlanSchema>) {
    const selected = allAccounts.filter(a => remainingIds.includes(a.id))
    const input = await buildStudioCashInput(loaded, selected, live.platforms, contentHash, current)
    const original = readStudioCashPending()
    if (recovery && (!original || input.targets.some(t => !original.quoteInput.targets.some(old => old.accountId === t.accountId && old.accountKind === t.accountKind && old.accountRevision === t.accountRevision && old.contentDigest === t.contentDigest)))) throw new Error('原发布内容与费用摘要不一致，请保留原记录核对')
    const cashQuote = await readStudioCashQuote(input, current); current()
    const id = crypto.randomUUID(); frozen.current = { id, owner, sessionRevision, editRevision, draft: loaded, accounts: allAccounts, contentHash, cashQuote, remainingIds, recovery, ...(resume ? { resume } : {}) }
    setChecks([{ id: 'content', label: '素材与平台规则', status: 'pass', detail: '实际文件和逐账号参数已核对' }, { id: 'cash', label: '本次现金费用', status: cashQuote.canExecute ? 'pass' : 'error', detail: `本次 ${selected.length} 个账号，费用 ¥${(cashQuote.estimatedChargeCents / 100).toFixed(2)}` }])
    setReview({ id, title: loaded.title, accountNames: selected.map(value => value.name), mediaCount: new Set(allDraftMedia(loaded).map(value => value.id)).size, contentHash, cashQuote, recovery, scheduledAt: loaded.publishAt, targets: selected.map(account => { const value = loaded.targetOverrides[account.id] || {}; return { accountId: account.id, accountName: account.name, platform: account.platform, ...effectiveStudioTargetContent(loaded, account, live.platforms.find(p => p.key === account.platform)), mediaNames: targetStudioMedia(loaded, account.id).map(value => value.name), coverName: (value.cover || loaded.cover)?.name, options: structuredClone(account.kind === 'generic' ? value.providerOptions ?? {} : value.options ?? {}), publishAt: value.publishAt ?? loaded.publishAt, transport: account.kind === 'browser' ? 'browser_plugin' : 'official_api', quota: 1 } }) })
  }
  function assertSameAccounts(selected: StudioAccount[], live: StudioAccount[]) { for (const account of selected) { const found = live.find(value => value.id === account.id); if (!found || found.uid !== account.uid || found.kind !== account.kind || found.platform !== account.platform || found.revision !== account.revision || found.metadataRevision !== account.metadataRevision || found.status !== account.status) throw new Error('发布账号或授权版本已变化，请重新选择并检查') } }
  async function ownerLock<T>(owner: string, action: () => Promise<T>) {
    if (!navigator.locks?.request) throw new Error('当前浏览器无法保护多个页面的发布操作，请使用支持的桌面浏览器')
    return navigator.locks.request(`aitoearn-native:publish:${owner}`, { ifAvailable: true }, async lock => { if (!lock) throw new Error('另一个页面正在执行发布，请回到原页面核对'); return action() })
  }
  async function publish(reviewId: string) { await run('确认并提交发布', async () => {
    const approved = frozen.current
    if (!approved || approved.id !== reviewId) throw new Error('原确认已失效，请重新检查内容')
    frozen.current = null; setReview(null)
    const current = () => guard(approved.owner, approved.sessionRevision, approved.editRevision)
    try { await ownerLock(approved.owner, async () => {
      current(); if (readNativePending() || !approved.recovery && (readStudioGenericPending() || readBrowserLocalPending() || readStudioLegacyPending() || readStudioCashPending())) throw new Error('原提交尚待核对，不会创建新的发布')
      const funding = { kind: 'cash' as const, proof: publishingCashQuoteProof(approved.cashQuote) }
      if (!approved.cashQuote.canExecute || approved.cashQuote.reasonCode !== 'ready') throw new Error('本次现金费用尚不能执行，请重新核对')
      assertStudioCashFresh(funding)
      if (approved.legacyCash) {
        const context = approved.legacyCash, live = await readStudioWorkspace(); current(); assertSameAccounts(approved.accounts, live.accounts)
        if (context.generic) await executeStudioGeneric((await observeStudioGeneric(current))!.prepared, current, funding)
        if (context.prepared || context.plan) {
          const prepared = context.local ? await recoverBrowserLocalPending(current) : context.plan ? verifyStudioLegacyPrepared(context.plan, await prepareNativePublishing(context.plan, current)) : context.prepared
          if (!prepared) throw new Error('原发布准备尚未查询到')
          const files = context.local ? await cashLocalFiles(readBrowserLocalPending()!.plan.draft.media, draftRef.current, current) : await readNativePlanFiles(context.plan!, current)
          await executeNativePublishing(prepared, files, () => {}, current, { funding, continueAfterKnownFailure: true })
        }
        current(); completeBrowserLocalPlan(current); completeStudioLegacyPlan(current); completeStudioGeneric(); setNotice('已继续原发布中的剩余账号，请核对平台结果'); await loadHistory(); await refreshWorkspace(); return
      }
      const live = await readStudioWorkspace(); current(); assertSameAccounts(approved.accounts.filter(a => approved.remainingIds.includes(a.id)), live.accounts); installWorkspace(live)
      assertStudioPreflight(approved.draft, approved.accounts.filter(a => approved.remainingIds.includes(a.id)), live.platforms, live.bootstrap)
      if (!approved.recovery && await studioContentHash(approved.draft, approved.accounts) !== approved.contentHash) throw new Error('实际文件与已确认内容不一致，已停止提交')
      current()
      if (!approved.recovery) await rememberStudioCashPending(approved.draft, approved.accounts, funding.proof.input, approved.contentHash, current, approved.resume)
      else if (readStudioCashPending()?.contentHash !== approved.contentHash) throw new Error('原发布已变化，请重新核对')
      if (approved.resume) {
        const actual = PublishingStudioPlanSchema.parse(await studioRequest(`studio/plans/${approved.resume.schedule.id}`)); current()
        if (actual.schedule.revision !== approved.resume.schedule.revision || actual.schedule.state !== 'planned' || JSON.stringify(actual.content) !== JSON.stringify(approved.resume.content)) throw new Error('原计划或内容已变化，请重新恢复')
        await executeNativeScheduledPublish(actual, { files: new Map(allDraftMedia(approved.draft).map(m => [m.id, m.file!])), assets: new Map() }, current, funding); current(); completeStudioCashPending()
        resumePlan.current = null; setNotice('原本地计划已领取并保存浏览器报告，请到平台核对作品'); await loadHistory(); await refreshWorkspace(); return
      }
      if (approved.accounts.every(a => a.kind === 'browser')) {
        const old = readBrowserLocalPending()
        const local = old ? { plan: old.plan, files: await cashLocalFiles(old.plan.draft.media, approved.draft, current) } : await buildStudioBrowserLocalPlan(approved.draft, approved.accounts, current)
        const prepared = old ? await recoverBrowserLocalPending(current) : await prepareStudioBrowserLocal(local.plan, current); current()
        if (!prepared) throw new Error('原发布准备尚未确认')
        await executeNativePublishing(prepared, local.files, () => {}, current, { funding, continueAfterKnownFailure: approved.recovery }); current(); completeBrowserLocalPlan(current); completeStudioCashPending()
        setNotice('已保存浏览器发布报告，请在平台核对实际作品'); await loadHistory(); await refreshWorkspace(); return
      }
      if (approved.recovery && (readStudioGenericPending() || readStudioLegacyPending())) {
        const generic = await observeStudioGeneric(current), legacy = await recoverStudioLegacyPending(current); current()
        if (generic) await executeStudioGeneric(generic.prepared, current, funding)
        if (legacy) await executeNativePublishing(legacy.prepared, await readNativePlanFiles(legacy.plan, current), () => {}, current, { funding, continueAfterKnownFailure: true })
        else if (generic?.legacyPlan) { const prepared = verifyStudioLegacyPrepared(generic.legacyPlan, await prepareNativePublishing(generic.legacyPlan, current)); await executeNativePublishing(prepared, await readNativePlanFiles(generic.legacyPlan, current), () => {}, current, { funding, continueAfterKnownFailure: true }) }
        current(); completeStudioLegacyPlan(current); completeStudioGeneric(); completeStudioCashPending(); setNotice('已继续原提交中的剩余账号，请到发布记录核对结果'); await loadHistory(); await refreshWorkspace(); return
      }
      const materialized = await materializeStudioDraft(approved.draft, current); current()
      const items = studioPlanItems(materialized, approved.accounts)
      await confirmNativeOfficialMainMedia(items, { assertCurrent: current, confirm: value => new Promise(resolve => { current(); bridgeResolver.current = resolve; setBridgeConfirmation(value) }) }); current()
      const genericAccounts = approved.accounts.filter(account => account.kind === 'generic'), legacyItems = items.filter(item => item.account.nativeAccountKind !== 'generic')
      const built = legacyItems.length ? await buildNativePublishPlan({ items: legacyItems, common: { title: materialized.title, des: materialized.body, topics: materialized.topics, option: {} }, publishAt: materialized.publishAt, collectionId: materialized.collectionId, sourceDraftId: materialized.sourceDraftId, sourceDraftVersion: materialized.sourceDraftVersion }) : null; current()
      if (genericAccounts.length) {
        const saved = await saveStudioDraft(materialized, approved.accounts, current, live.platforms); current()
        const prepared = await prepareStudioGeneric({ draftId: saved.id, draftVersion: saved.version, profileRevision: saved.metadataRevision, targetIds: genericAccounts.map(account => account.id), contentHash: approved.contentHash, legacyPending: legacyItems.length > 0, ...(built ? { legacyPlan: built.plan } : {}) }, current); current()
        await executeStudioGeneric(prepared, current, funding); current()
        if (!legacyItems.length) { completeStudioGeneric(); completeStudioCashPending(); setNotice('已提交官方发布任务；请在任务记录核对平台结果'); await refreshWorkspace(); return }
      }
      if (!built) throw new Error('原浏览器计划缺失')
      if (await nativeSha256(new Blob([nativePreparePlanCanonical(built.plan)], { type: 'text/plain' })) !== built.plan.planHash) throw new Error('执行计划摘要不一致，已停止准备')
      const approvedHashes = new Set(await Promise.all(allDraftMedia(approved.draft).map(value => nativeSha256(value.file!))))
      const planHashes = new Set(await Promise.all([...built.files.files.values()].map(value => nativeSha256(value))))
      if ((!genericAccounts.length && approvedHashes.size !== planHashes.size) || [...planHashes].some(value => !approvedHashes.has(value))) throw new Error('计划素材与最终确认的实际文件不一致，已停止准备')
      current()
      const latest = await readStudioWorkspace(); current(); assertSameAccounts(approved.accounts, latest.accounts); assertStudioPreflight(materialized, approved.accounts.filter(account => account.kind !== 'generic'), latest.platforms, latest.bootstrap)
      const prepared = genericAccounts.length ? verifyStudioLegacyPrepared(built.plan, await prepareNativePublishing(built.plan, current)) : await prepareStudioLegacyPlan(built.plan, current); current()
      await executeNativePublishing(prepared, built.files, value => {
        current()
        setHistory(previous => [{ id: value.recordId || value.targetId, title: approved.draft.title || '当前发布', platform: '', state: value.state, url: value.receipt?.shareLink, message: value.message, evidence: value.state === 'browser_reported' ? 'browser_reported' : 'provider_reported' }, ...previous.filter(item => item.id !== value.recordId && item.id !== value.targetId)])
      }, current, { funding, continueAfterKnownFailure: approved.recovery }); current()
      setNotice('已保存本次提交记录。浏览器报告和官方手机接力结果，请在发布记录中继续核对。')
      if (!genericAccounts.length) completeStudioLegacyPlan(current)
      if (!readNativePending()) { completeStudioGeneric(); completeStudioCashPending() }
      await refreshWorkspace()
    }) } catch (reason) {
      if (!approved.recovery && reason instanceof Error && 'prepareNotCreated' in reason && reason.prepareNotCreated === true && getHostSession()?.user.id === approved.owner && getHostSessionRevision() === approved.sessionRevision && !readNativePending() && !readStudioGenericPending() && !readBrowserLocalPending() && !readStudioLegacyPending() && readStudioCashPending()?.contentHash === approved.contentHash) completeStudioCashPending()
      throw reason
    }
  }) }

  async function saveDraft() { await run('保存草稿', async () => {
    const owner = assertHostSession().user.id, revision = getHostSessionRevision(), edit = editing.current, current = () => guard(owner, revision, edit)
    const input = copyStudioDraft(draftRef.current), selected = accountsRef.current.filter(value => value.selected)
    input.targetOverrides = Object.fromEntries(selected.flatMap(value => input.targetOverrides[value.id] ? [[value.id, input.targetOverrides[value.id]]] : []))
    await ownerLock(owner, async () => {
      const loaded = await freezeStudioDraft(input, current), saved = await materializeStudioDraft(loaded, current); current()
      const result = await saveStudioDraft(saved, selected, current, platformsRef.current); current()
      const uploadedIds = new Map(input.media.map((value, index) => [value.id, saved.media[index]?.id]))
      const retainedOverrides = Object.fromEntries(Object.entries(draftRef.current.targetOverrides).map(([id, value]) => [id, { ...value, mediaIds: value.mediaIds?.map(mediaId => uploadedIds.get(mediaId) || mediaId) }]))
      replaceDraft({ ...saved, targetOverrides: { ...retainedOverrides, ...saved.targetOverrides }, studioDraftId: result.id, studioDraftVersion: result.version })
      setNotice('稿件与所选账号的素材、发布参数和排期已完整保存')
    })
  }) }
  const loadHistory = useCallback(async (query: StudioHistoryQuery = {}) => {
    const sequence = ++historyRequest.current, actor = assertHostSession(), revision = getHostSessionRevision()
    const current = () => mounted.current && sequence === historyRequest.current && getHostSession()?.user.id === actor.user.id && getHostSessionRevision() === revision
    setHistoryLoading(true); setError(null)
    try { const values = await readStudioHistoryPage(query); if (!current()) return; setHistory(values.items); setHistoryPage({ page: values.page, pageSize: values.pageSize, total: values.total, hasMore: values.hasMore }) }
    catch (reason) { if (current()) setError(message(reason)) }
    finally { if (current()) setHistoryLoading(false) }
  }, [])
  function installRecord(value: StudioHistoryItem) { setRecordDetail(value); setHistory(previous => [value, ...previous.filter(item => item.id !== value.id)]) }
  async function resumeRecord(id: string, expectedRevision: number) { let restoredSuccessfully = false; await run('恢复原本地计划', async () => {
    const owner = assertHostSession().user.id, revision = getHostSessionRevision(), value = PublishingStudioPlanSchema.parse(await studioRequest(`studio/plans/${z.string().uuid().parse(id)}`)); guard(owner, revision)
    if (value.schedule.revision !== expectedRevision || value.schedule.state !== 'planned' || Date.parse(value.schedule.scheduledAt) > Date.now()) throw new Error('原计划状态已变化或尚未到期')
    const target = value.content.draft.payload.targets.find(t => t.id === value.schedule.targetId)!, restored = restoreStudioLegacyDraft(value.content)
    restored.publishAt = ''; restored.targetOverrides = { [target.accountId]: { ...restored.targetOverrides[target.accountId], publishAt: '' } }
    const mediaIds = new Set(target.mediaIds ?? value.content.draft.payload.media.filter(m => m.role !== 'cover').map(m => m.id)); restored.media = restored.media.filter(m => mediaIds.has(m.id))
    replaceDraft(restored); resumePlan.current = value
    const next = accountsRef.current.map(a => ({ ...a, selected: a.id === target.accountId && a.kind === 'browser' })); accountsRef.current = next; setAccounts(next); setRecordDetail(null)
    setNotice('已恢复原计划。原本机文件需要重新选择，系统会核对内容摘要；检查并最终确认后才会执行。修改文案、账号或素材选择将退出原计划恢复。')
    restoredSuccessfully = true
  }); return restoredSuccessfully }
  const recordMarkerSchema = z.object({ requestKey: z.string().regex(/^studio-record:[a-f\d-]{36}$/i), action: z.enum(['cancel', 'reschedule', 'publish_now']), revision: z.number().int().positive(), publishAt: z.string().optional() }).strict()
  async function refreshRecord(id: string) { await run('核对原发布记录', async () => {
    z.string().uuid().parse(id)
    const owner = assertHostSession().user.id, revision = getHostSessionRevision()
    if (history.find(item => item.id === id)?.transport === 'generic_api' || recordDetail?.id === id && recordDetail.transport === 'generic_api') {
      const key = hostStorageKey(`studio-record:${id}`)!, markerRaw = localStorage.getItem(key)
      let target = projectStudioGenericRecord(await studioRequest(`publishing/generic?resource=record&id=${id}`)); guard(owner, revision)
      const parameters = markerRaw ? `requestKey=${encodeURIComponent(recordMarkerSchema.parse(JSON.parse(markerRaw)).requestKey)}` : `id=${target.operationId}`
      const value = await studioRequest(`publishing/generic?resource=operation&${parameters}`); guard(owner, revision)
      if (value) {
        const original = PublishingGenericMutationSchema.parse(value)
        for (const op of original.operations) if (op.grantUsed && !['succeeded', 'blocked'].includes(op.state)) { await studioRequest('publishing/generic', 'POST', { action: 'reconcile', operationId: op.id, expectedRevision: op.revision }); guard(owner, revision) }
        const latest = PublishingGenericMutationSchema.parse(await studioRequest(`publishing/generic?resource=operation&${parameters}`)); guard(owner, revision)
        if (markerRaw && latest.operations.some(op => op.kind === 'task_change' && op.requestKey === recordMarkerSchema.parse(JSON.parse(markerRaw)).requestKey && op.targetIds.includes(id) && ['succeeded', 'blocked'].includes(op.state))) localStorage.removeItem(key)
      }
      target = projectStudioGenericRecord(await studioRequest(`publishing/generic?resource=record&id=${id}`)); guard(owner, revision); installRecord(target); return
    }
    // The existing record refresh may reconcile the original provider task; never run on mount.
    const value = projectStudioHistory(await studioRequest(`v2/channels/publish/records/${id}`)); guard(owner, revision)
    const key = hostStorageKey(`studio-record:${id}`)!, raw = localStorage.getItem(key)
    if (raw) {
      const marker = recordMarkerSchema.parse(JSON.parse(raw))
      if (value.transport === 'local_plan') {
        if (value.revision && value.revision > marker.revision && (marker.action === 'cancel' && value.state === 'cancelled' || marker.action === 'reschedule' && value.publishAt === marker.publishAt)) localStorage.removeItem(key)
      } else {
        const page = PublishingV3PageSchema.parse(await studioRequest(`publishing/v3?resource=operations&requestKey=${encodeURIComponent(marker.requestKey)}&pageSize=1`)); guard(owner, revision)
        const operation = page.items.map(item => PublishingV3OperationSchema.parse(item)).find(item => item.requestKey === marker.requestKey)
        if (operation && operation.kind === 'task_change' && operation.subjectId === id && ['settled', 'blocked'].includes(operation.dispatchState) && operation.outcome !== 'unknown') localStorage.removeItem(key)
      }
    }
    installRecord(value)
  }) }
  async function readUserAction(id: string) { await run('读取官方手机接力', async () => {
    const original = history.find(item => item.id === id)
    if (!original?.availableActions?.includes('user_action')) throw new Error('原任务尚未进入手机接力状态，请先核对原记录')
    const owner = assertHostSession().user.id, revision = getHostSessionRevision()
    const value = PublishingV3UserActionSchema.omit({ operationId: true }).extend({ recordId: z.string().uuid(), platform: z.literal('douyin') }).strict().parse(await studioRequest(`v2/channels/publish/records/${id}/user-action`)); guard(owner, revision)
    if (value.recordId !== id || value.expiresAt && Date.parse(value.expiresAt) <= Date.now()) throw new Error('官方接力入口已过期或不匹配，请核对原任务')
    setRecordDetail(original); setUserAction({ recordId: id, shortLink: value.shortLink, schemeUrl: value.schemeUrl, ...(value.expiresAt ? { expiresAt: value.expiresAt } : {}) })
  }) }
  async function mutateRecord(action: 'cancel' | 'reschedule' | 'publish_now', id: string, expectedRevision: number, publishAt?: string) { await run('更新原发布任务', async () => {
    z.string().uuid().parse(id); z.number().int().positive().parse(expectedRevision)
    const owner = assertHostSession().user.id, revision = getHostSessionRevision()
    await ownerLock(owner, async () => {
      if (history.find(item => item.id === id)?.transport === 'generic_api' || recordDetail?.id === id && recordDetail.transport === 'generic_api') {
        const target = projectStudioGenericRecord(await studioRequest(`publishing/generic?resource=record&id=${id}`)); guard(owner, revision)
        if (target.revision !== expectedRevision || !target.availableActions?.includes(action)) throw new Error('原任务状态已变化，请重新核对')
        const key = hostStorageKey(`studio-record:${id}`)!
        if (localStorage.getItem(key)) throw new Error('原任务操作尚待核对，不会重复发起')
        const marker = recordMarkerSchema.parse({ requestKey: `studio-record:${crypto.randomUUID()}`, action, revision: expectedRevision, ...(action === 'reschedule' ? { publishAt } : {}) })
        localStorage.setItem(key, JSON.stringify(marker)); guard(owner, revision)
        const result = PublishingGenericMutationSchema.parse(await studioRequest('publishing/generic', 'POST', { action: 'change-task', requestKey: marker.requestKey, targetId: id, expectedRevision, change: action, ...(action === 'reschedule' ? { publishAt } : {}) })); guard(owner, revision)
        const confirmed = result.operations.find(op => op.requestKey === marker.requestKey && op.kind === 'task_change' && op.targetIds.includes(id))
        if (!confirmed || !['succeeded', 'blocked'].includes(confirmed.state)) throw new Error('原任务操作结果尚待核对，已保留原标识')
        localStorage.removeItem(key)
        const updated = result.targets.find(target => target.id === id); if (updated) installRecord(projectStudioGenericRecord(updated))
        setNotice('已核对原任务状态；已发起发布的执行额度不会因取消而退回'); return
      }
      const current = (await readStudioHistory()).find(item => item.id === id); guard(owner, revision)
      if (!current || current.revision !== expectedRevision || !current.availableActions?.includes(action)) throw new Error('原任务状态或版本已变化，请重新核对后确认')
      if (action === 'reschedule' && (!publishAt || !Number.isFinite(Date.parse(publishAt)) || Date.parse(publishAt) <= Date.now())) throw new Error('请选择未来的新发布时间')
      const key = hostStorageKey(`studio-record:${id}`)!
      if (localStorage.getItem(key)) throw new Error('这条任务的原操作结果尚待核对，请先点击核对原记录；不会重复发起')
      const marker = recordMarkerSchema.parse({ requestKey: `studio-record:${crypto.randomUUID()}`, action, revision: expectedRevision, ...(action === 'reschedule' ? { publishAt } : {}) })
      localStorage.setItem(key, JSON.stringify(marker)); guard(owner, revision)
      const path = `v2/channels/publish/tasks/${id}${action === 'reschedule' ? '/publish-at' : action === 'publish_now' ? '/publish-now' : ''}`
      const result = await studioRequest(path, action === 'cancel' ? 'DELETE' : action === 'reschedule' ? 'PATCH' : 'POST', { expectedRevision, requestKey: marker.requestKey, ...(action === 'reschedule' ? { publishAt } : {}) }); guard(owner, revision)
      if (current.transport === 'local_plan') {
        const confirmed = PublishingV2MutationSchema.parse(result).schedule
        if (!confirmed || confirmed.id !== id || confirmed.revision <= expectedRevision || action === 'cancel' && confirmed.state !== 'cancelled' || action === 'reschedule' && (confirmed.state !== 'planned' || confirmed.scheduledAt !== publishAt)) throw new Error('原计划操作回执不完整，已保留请求标识，请核对原记录')
      } else {
        const confirmed = PublishingV3MutationSchema.parse(result).operation
        if (!confirmed || confirmed.kind !== 'task_change' || confirmed.subjectId !== id || confirmed.requestKey !== marker.requestKey || !['settled', 'blocked'].includes(confirmed.dispatchState) || confirmed.outcome === 'unknown') throw new Error('原任务操作仍待核对，已保留请求标识')
      }
      localStorage.removeItem(key); setUserAction(null)
      const updated = (await readStudioHistory()).find(item => item.id === id); guard(owner, revision)
      if (updated) installRecord(updated)
      setNotice('已读取原任务操作回执，请以平台实际状态为准')
    })
  }) }
  function projectAuthorization(value: NonNullable<typeof authRef.current>) {
    authRef.current = value
    if (!authorizationVisible.current) return
    const rawUrl = 'authUrl' in value ? value.authUrl : 'url' in value ? value.url : undefined
    const url = rawUrl?.startsWith('data:') && value.platform === 'douyin' ? PublishingV3AuthSessionSchema.shape.url.parse(rawUrl) : safeNativeAuthorizationUrl(rawUrl)
    setAuthorization({ platform: value.platform, sessionId: value.id, state: value.state, url, expiresAt: value.expiresAt, choices: 'choices' in value ? value.choices.map(choice => ({ id: choice.id, name: choice.displayName })) : (value.selectableAccounts || []).map(choice => ({ id: choice.platformUid, name: choice.displayName })) })
  }
  function authorizationWork(platform: string, phase: 'starting' | 'checking' | 'selecting', work: (current: () => void) => Promise<void>, transport?: 'browser_plugin' | 'official_api') { return async () => {
    const owner = getHostSession()?.user.id, revision = getHostSessionRevision()
    const generation = phase === 'starting' ? ++authorizationGeneration.current : authorizationGeneration.current
    const selectedTransport = transport ?? authorizationFlow?.transport
    authorizationVisible.current = true; setAuthorizationFlow({ platform, transport: selectedTransport, phase }); if (phase === 'starting') { setAuthorization(null); authRef.current = null }
    const visible = () => mounted.current && authorizationVisible.current && authorizationGeneration.current === generation && getHostSession()?.user.id === owner && getHostSessionRevision() === revision
    const current = () => { if (!visible()) throw new Error('账号授权窗口已变化，请查看当前授权会话') }
    try { await work(current); if (visible()) setAuthorizationFlow(authRef.current?.platform === platform ? { platform, transport: selectedTransport, phase: 'ready' } : null) }
    catch (reason) { if (visible()) setAuthorizationFlow({ platform, transport: selectedTransport, phase: 'error', error: message(reason), errorCode: reason && typeof reason === 'object' && 'code' in reason && typeof reason.code === 'string' ? reason.code : 'AUTHORIZATION_UNCONFIRMED' }); throw reason }
  } }
  async function connectAccount(platform: string, transport?: 'browser_plugin' | 'official_api') { await run('连接发布账号', authorizationWork(platform, 'starting', async current => {
    invalidate(); const config = platformsRef.current.find(value => value.key === platform)
    if (!config?.connectionAllowed) throw new Error(config?.reason || '该平台暂未开放账号连接')
    const channel = config.channels?.find(value => value.transport === (transport ?? (platform === 'douyin' ? 'official_api' : 'browser_plugin')))
    if (channel && !channel.connectionAllowed) throw new Error(channel.reason)
    const owner = assertHostSession().user.id, revision = getHostSessionRevision()
    if (platform === 'xhs' || platform === 'wxSph' || platform === 'douyin' && transport === 'browser_plugin') {
      let detected; try { detected = await inspectPublishingPlugin(platform) } catch (reason) { throw new Error(publishingPluginMessage(reason)) }
      guard(owner, revision); current()
      await studioRequest('v2/channels/accounts', 'POST', { type: platform, uid: detected.account.uid, nickname: detected.account.nickname, ...(detected.account.avatar ? { avatar: detected.account.avatar } : {}) }); guard(owner, revision); current()
      await refreshWorkspace(); setNotice('已读取并保存当前浏览器平台账号摘要')
    } else if (platform === 'douyin') {
      const started = await startNativeAuthorization(); guard(owner, revision); current()
      const value = PublishingV3AuthSessionSchema.parse(await studioRequest(`publishing/v3?resource=auth-session&id=${started.sessionId}`)); guard(owner, revision); current(); projectAuthorization(value)
    } else if (isNativeOAuthPlatform(platform)) { const value = await startNativeOAuth(platform); guard(owner, revision); current(); projectAuthorization(value) }
  }, transport ?? (platform === 'xhs' || platform === 'wxSph' ? 'browser_plugin' : 'official_api'))) }
  async function refreshAuthorization() { await run('核对账号授权', authorizationWork(authRef.current?.platform || authorizationFlow?.platform || '', 'checking', async current => {
    const original = authRef.current; if (!original) return
    const owner = assertHostSession().user.id, revision = getHostSessionRevision()
    const value = original.platform === 'douyin' ? PublishingV3AuthSessionSchema.parse(await studioRequest(`publishing/v3?resource=auth-session&id=${original.id}`)) : await readNativeOAuthSession(original.id)
    guard(owner, revision); current(); if (authRef.current?.id !== original.id || value.id !== original.id) throw new Error('原授权会话已变化，请查看当前会话'); projectAuthorization(value); if (value.state === 'completed') await refreshWorkspace()
  })) }
  async function selectAuthorization(ids: string[]) { await run('确认授权账号', authorizationWork(authRef.current?.platform || '', 'selecting', async current => {
    const value = authRef.current; if (!value || value.state !== 'requires_selection') throw new Error('此授权会话已不可选择，请核对原会话')
    const owner = assertHostSession().user.id, revision = getHostSessionRevision()
    if (value.platform === 'douyin') {
      const selected = (value.selectableAccounts || []).filter(account => ids.includes(account.platformUid))
      if (!selected.length || selected.length !== ids.length) throw new Error('请选择当前授权会话返回的账号')
      await selectNativeAuthorization(value.id, value.revision, selected.map(({ platformUid, account }) => ({ platformUid, account })))
      guard(owner, revision); current(); const updated = PublishingV3AuthSessionSchema.parse(await studioRequest(`publishing/v3?resource=auth-session&id=${value.id}`)); current(); projectAuthorization(updated)
    } else { const selected = await selectNativeOAuth(value, ids); guard(owner, revision); current(); projectAuthorization(selected) }
    await refreshWorkspace()
  })) }
  async function cashLocalFiles(media: Array<{ id: string; hash?: string; size: number; type: string }>, source: StudioDraft, current: () => void) {
    const candidates = await Promise.all(allDraftMedia(source).filter(m => !!m.file).map(async m => ({ file: m.file!, hash: await nativeSha256(m.file!) }))); current()
    const files = new Map<string, File>()
    for (const m of media) { const match = candidates.find(v => v.hash === m.hash && v.file.size === m.size && v.file.type === m.type); if (!match) throw new Error('请重新选择原发布相同内容的素材'); files.set(m.id, match.file) }
    return { files, assets: new Map() }
  }
  async function reviewCashRecovery(owner: string, revision: number, edit: number, current: () => void) {
    const marker = readStudioCashPending(); if (!marker) return false
    let remainingIds = marker.accounts.map(a => a.id)
    const local = readBrowserLocalPending(), legacy = readStudioLegacyPending(), generic = readStudioGenericPending()
    if (marker.resume) {
      const schedule = PublishingStudioPlanSchema.parse(await studioRequest(`studio/plans/${marker.resume.schedule.id}`)); current()
      if (schedule.schedule.state === 'claimed') remainingIds = []
      else if (schedule.schedule.state !== 'planned' || schedule.schedule.revision !== marker.resume.schedule.revision) throw new Error('原本地计划状态已变化，请核对原记录')
    } else if (local) { const prepared = await recoverBrowserLocalPending(current); if (!prepared) throw new Error('原本地准备尚未查询到'); remainingIds = await readNativeUnclaimedAccountIds(prepared, current) }
    else if (generic) {
      const observed = await observeStudioGeneric(current); if (!observed) throw new Error('原官方准备尚未查询到')
      remainingIds = [...observed.remainingIds]
      if (observed.legacyPlan) { const raw = NativePreparedPublishSchema.nullable().parse(await studioRequest(`publishing/prepare?requestKey=${encodeURIComponent(observed.legacyPlan.requestKey)}`)); current(); remainingIds.push(...(raw ? await readNativeUnclaimedAccountIds(verifyStudioLegacyPrepared(observed.legacyPlan, raw), current) : marker.accounts.filter(a => a.kind !== 'generic').map(a => a.id))) }
    } else if (legacy) { const original = await recoverStudioLegacyPending(current); if (!original) throw new Error('原发布准备尚未查询到'); remainingIds = await readNativeUnclaimedAccountIds(original.prepared, current) }
    if (!remainingIds.length) { completeBrowserLocalPlan(current); completeStudioLegacyPlan(current); completeStudioGeneric(); completeStudioCashPending(); setNotice('原账号均已有明确记录，没有新的执行费用或重复提交'); await loadHistory(); await refreshWorkspace(); return true }
    const restored = await restoreStudioCashPending(marker, draftRef.current, current), live = await readStudioWorkspace(); current()
    assertSameAccounts(restored.accounts.filter(a => remainingIds.includes(a.id)), live.accounts); installWorkspace(live)
    assertStudioPreflight(restored.draft, restored.accounts.filter(a => remainingIds.includes(a.id)), live.platforms, live.bootstrap)
    await openCashReview(restored.draft, restored.accounts, remainingIds, live, marker.contentHash, owner, revision, edit, current, true, marker.resume)
    setNotice('已核对原提交。仅列出尚未开始执行的账号，请确认当前费用后继续。'); return true
  }
  async function recoverPending() { await run('核对原发布任务', async () => {
    const owner = assertHostSession().user.id, revision = getHostSessionRevision(); invalidate(); const edit = editing.current, current = () => guard(owner, revision, edit)
    await ownerLock(owner, async () => {
      await recoverNativePublish(); current()
      if (await reviewCashRecovery(owner, revision, edit, current)) return
      const local = readBrowserLocalPending(), legacy = await recoverStudioLegacyPending(current), generic = await observeStudioGeneric(current); current()
      let prepared = local ? await recoverBrowserLocalPending(current) : legacy?.prepared
      const plan = legacy?.plan ?? generic?.legacyPlan
      if (!prepared && plan) { const raw = NativePreparedPublishSchema.nullable().parse(await studioRequest(`publishing/prepare?requestKey=${encodeURIComponent(plan.requestKey)}`)); current(); if (raw) prepared = verifyStudioLegacyPrepared(plan, raw) }
      const genericPayload = generic?.remainingIds.length ? await readStudioGenericOriginalDraft(generic.prepared, current) : undefined
      const remainingIds = [...(generic?.remainingIds ?? []), ...(prepared ? await readNativeUnclaimedAccountIds(prepared, current) : plan ? plan.groups.flatMap(group => [...group.draft.targets.map(t => t.accountId), ...group.officialTargets.map(t => t.bindingId)]) : [])]
      if (!remainingIds.length) { completeBrowserLocalPlan(current); completeStudioLegacyPlan(current); completeStudioGeneric(); setNotice('原账号均已有明确记录，没有新的执行费用或重复提交'); await loadHistory(); await refreshWorkspace(); return }
      const live = await readStudioWorkspace(); current(); installWorkspace(live)
      const original = await legacyStudioCashInput({ prepared: prepared ?? undefined, plan, generic: genericPayload, remainingIds, accounts: live.accounts }, current)
      const cashQuote = await readStudioCashQuote(original.input, current); current(); const id = crypto.randomUUID()
      frozen.current = { id, owner, sessionRevision: revision, editRevision: edit, draft: emptyStudioDraft(), accounts: live.accounts.filter(a => remainingIds.includes(a.id)), contentHash: original.input.reviewHash, cashQuote, remainingIds, recovery: true, legacyCash: { prepared: prepared ?? undefined, plan, generic: generic?.prepared, local: !!local } }
      setReview({ id, title: original.targets[0]?.title || '原发布', accountNames: original.targets.map(t => t.accountName), mediaCount: original.targets.reduce((sum, t) => sum + (t.mediaNames?.length ?? 0), 0), contentHash: original.input.reviewHash, targets: original.targets, cashQuote, recovery: true })
      setNotice('已保留原内容和已执行账号。请确认剩余账号的现金费用后继续。')
    });
  }) }
  const selected = accounts.filter(value => value.selected), remaining = bootstrap?.entitlements.filter(value => Date.parse(value.expiresAt) > Date.now()).reduce((sum, value) => sum + Math.max(0, value.quota - value.used), 0)
  const canPublish = !!bootstrap?.schemaReady && bootstrap.access.allowed && bootstrap.config.executionEnabled && selected.length > 0 && selected.every(account => platforms.some(platform => platform.key === account.platform && platform.available)) && !pending
  return { session, workspace, publishing: bootstrap ? { executionEnabled: bootstrap.config.executionEnabled, announcement: bootstrap.config.announcement, enabledPlatforms: [...bootstrap.config.enabledPlatforms], mode: bootstrap.config.mode } : null, draft, accounts, platforms, checks, quota: { remaining, cost: selected.length, label: '主站发布额度', canPublish, reason: !bootstrap?.schemaReady ? '发布服务尚未就绪' : !bootstrap.config.executionEnabled ? '发布通道尚未开放' : pending ? '请先核对原提交' : !selected.length ? '请选择发布账号' : undefined }, busy, error, notice, review, pending, history, historyLoading, historyPage, recordDetail, userAction, importItems, importLoading, importOpen, bridgeConfirmation, authorization, authorizationFlow,
    patchDraft, patchTarget, addFiles, setCover: file => cover(file), setTargetCover: (id, file) => cover(file, id), removeMedia, toggleAccount, connectAccount,
    refreshAccounts: () => run('刷新账号', async () => { invalidate(); await refreshWorkspace() }), openImport, closeImport: () => { importRevision.current++; setImportOpen(false); setImportLoading(false) }, loadImport, importItem, checkDraft, saveDraft, publish,
    cancelReview: () => { frozen.current = null; setReview(null) }, confirmBridge: approved => { const resolve = bridgeResolver.current; bridgeResolver.current = null; setBridgeConfirmation(null); resolve?.(approved) }, refreshAuthorization, selectAuthorization, closeAuthorization: () => { authorizationGeneration.current++; authorizationVisible.current = false; setAuthorization(null); setAuthorizationFlow(null) }, loadHistory, recoverPending,
    refreshRecord, readUserAction, resumeRecord, mutateRecord, closeRecordDetail: () => { setRecordDetail(null); setUserAction(null) },
    resetDraft: () => { revokeBlobs(); replaceDraft(emptyStudioDraft()); setNotice(null); setError(null) }, dismissMessage: () => { setNotice(null); setError(null) },
  }
}
