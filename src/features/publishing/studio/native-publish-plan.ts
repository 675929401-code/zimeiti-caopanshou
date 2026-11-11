import { NativePreparePublishSchema, NativePlatformSchema, nativePreparePlanCanonical, type NativePreparePublish } from '@/lib/native-operations-contract'
import { PublishingV2DraftInputSchema, PublishingV2TargetSchema, type PublishingV2DraftInput, type PublishingV2Media } from '@/lib/publishing-v2-contract'
import { PublishingV3OptionsSchema, preparePublishingV3Content, validatePublishingV3Media } from '@/lib/publishing-v3-contract'
import { prepareNativePluginContent, validateNativePublishingMedia } from '@/lib/publishing-native'
import type { NativeMediaSource } from '@/lib/native-main-media-contract'
import type { StudioPlanParams as IPubParams, StudioPlanItem as PubItem } from './types'
import { assertHostSession, getHostSessionRevision } from './host-session'
import { nativeSha256, type NativeAsset } from './native-assets'
import { readNativePublishingMedia, type NativeReadablePublishingMedia } from './native-readable-media'
import { readReadyNativeMainMediaBridgeAsset } from './native-media-bridge-client'
import { nativeAssetPath } from '@/lib/native-operations-contract'
import { nativeMainMediaPath } from '@/lib/native-main-media-contract'

export interface NativePlanFiles { files: Map<string, File>, assets: Map<string, NativeAsset> }
export async function readNativePlanFiles(plan: NativePreparePublish, current: () => void): Promise<NativePlanFiles> {
  if (await nativeSha256(new Blob([nativePreparePlanCanonical(plan)], { type: 'text/plain' })) !== plan.planHash) throw new Error('原剩余计划摘要不一致')
  const files = new Map<string, File>(), assets = new Map<string, NativeAsset>()
  for (const group of plan.groups) for (const media of group.draft.media) {
    const mapping = group.metadata.media.find(m => m.mediaId === media.id); if (!mapping) throw new Error('原计划素材映射缺失')
    const source = 'source' in mapping ? mapping.source : { kind: 'provider_asset' as const, assetId: mapping.assetId }
    const loaded = await readNativePublishingMedia(source.kind === 'provider_asset' ? nativeAssetPath(source.assetId) : nativeMainMediaPath(source.reference)); current()
    if (loaded.mediaId !== media.id || loaded.sha256 !== media.hash || loaded.file.size !== media.size || loaded.file.type !== media.type) throw new Error('原计划素材已变化，不会从当前编辑重新生成')
    files.set(media.id, loaded.file); if (loaded.kind === 'provider') assets.set(media.id, loaded.asset)
  }
  return { files, assets }
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value).filter(([, child]) => child !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(',')}}`
  return JSON.stringify(value)
}
const hashText = (value: string) => nativeSha256(new Blob([value], { type: 'text/plain' }))
const uuidFrom = (digest: string) => `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`
type LoadedMedia = NativeReadablePublishingMedia & { media: PublishingV2Media }

/** Preserve each original PubItem; mixed media types become separate immutable execution drafts. */
export async function buildNativePublishPlan(input: { items: PubItem[], common: IPubParams, publishAt?: string, collectionId?: string, sourceDraftId?: string, sourceDraftVersion?: number }): Promise<{ plan: NativePreparePublish, files: NativePlanFiles }> {
  const owner = assertHostSession().user.id; const version = getHostSessionRevision()
  if (!input.items.length) throw new Error('请选择至少一个真实账号')
  if (new Set(input.items.map(item => item.account.id)).size !== input.items.length) throw new Error('同一账号不能在一次准备中重复出现')
  const publishAt = input.publishAt ? new Date(input.publishAt).toISOString() : null
  if (publishAt && Date.parse(publishAt) <= Date.now()) throw new Error('计划时间已过，请重新核对')
  const semantic = { ...(input.sourceDraftId && input.sourceDraftVersion ? { sourceDraftId: input.sourceDraftId, sourceDraftVersion: input.sourceDraftVersion } : {}), collectionId: input.collectionId || null, common: { title: input.common.title || '', body: input.common.des, topics: input.common.topics || [] }, publishAt, items: input.items.map(item => ({ accountId: item.account.id, publishAt: item.publishAt, accountKind: item.account.nativeAccountKind, platform: item.account.type, bindingRevision: item.account.nativeAccountKind === 'official' ? item.account.nativeRevision : undefined, title: item.params.title || '', body: item.params.des, topics: item.params.topics || [], options: item.params.option, media: item.params.video ? [item.params.video.ossUrl] : item.params.images?.map(image => image.ossUrl), cover: item.params.video?.cover.ossUrl })) }
  const seed = await hashText(canonical(semantic)); assertHostSession(owner, version)
  const files = new Map<string, File>(); const assets = new Map<string, NativeAsset>(); const loaded = new Map<string, Promise<LoadedMedia>>(); const sources = new Map<string, NativeMediaSource>()
  const load = async (url: string | undefined, role: 'image' | 'video' | 'cover') => {
    if (!url) throw new Error('请选择已保存的主站作品或已确认上传的素材；视频封面也需要明确的作品来源')
    let key: string
    try { key = new URL(url, window.location.origin).href } catch { throw new Error('素材来源无效，请重新选择') }
    let pending = loaded.get(key)
    if (!pending) {
      pending = (async () => {
        const result = await readNativePublishingMedia(url); assertHostSession(owner, version)
        const base = { id: result.mediaId, role, fileName: result.file.name, size: result.file.size, type: result.file.type, lastModified: 0, hash: result.sha256, ...result.metadata }
        const media: PublishingV2Media = result.kind === 'main' ? { ...base, source: 'main_asset', requiresReselection: false, reference: result.reference } : { ...base, source: 'local_file', requiresReselection: true }
        files.set(media.id, result.file); sources.set(media.id, result.source)
        if (result.kind === 'provider') assets.set(media.id, result.asset)
        return { ...result, media }
      })()
      loaded.set(key, pending)
    }
    const value = await pending; assertHostSession(owner, version)
    if ((role === 'video') !== value.file.type.startsWith('video/')) throw new Error('实际素材类型与所选用途不一致，请重新选择')
    if (role === 'image' && value.media.role === 'cover') value.media.role = 'image'
    if (role === 'video' && value.media.role !== 'video' || role !== 'video' && value.media.role === 'video') throw new Error('素材类型与所选用途不一致')
    return value
  }
  const groups: NativePreparePublish['groups'] = []
  for (const kind of ['image', 'video'] as const) {
    const items = input.items.filter(item => (item.params.video ? 'video' : 'image') === kind)
    if (!items.length) continue
    const draft: PublishingV2DraftInput = { schemaVersion: 2, collectionId: input.collectionId || null, contentType: kind, title: input.common.title || '', body: input.common.des || '', topics: input.common.topics || [], media: [], targets: [] }
    const media = new Map<string, PublishingV2Media>(); const officialTargets: NonNullable<NativePreparePublish['groups'][number]['officialTargets']> = []; const accountTypes: Array<'xhs' | 'wxSph' | 'douyin'> = []; const entryRefs = new Map<string, string>()
    for (const item of items) {
      const platform = item.account.type
      const targetPublishAt = item.publishAt === '' ? null : item.publishAt ? new Date(item.publishAt).toISOString() : publishAt
      if (targetPublishAt && Date.parse(targetPublishAt) <= Date.now()) throw new Error('账号排期已过，请重新核对')
      if (platform !== 'xhs' && platform !== 'wxSph' && platform !== 'douyin') throw new Error('此平台尚未接入主站实际发布通道，已保留原生平台目录')
      const selected = item.params.video ? [await load(item.params.video.ossUrl, 'video')] : await Promise.all((item.params.images || []).map(image => load(image.ossUrl, 'image')))
      if (!selected.length || new Set(selected.map(value => value.media.id)).size !== selected.length) throw new Error('请选择有序且不重复的已确认素材')
      const selections = item.params.video ? [item.params.video] : item.params.images || []
      selected.forEach((value, index) => {
        const entry = selections[index]?.nativeMediaEntryId
        if (!entry) return
        const prior = entryRefs.get(value.media.id)
        if (prior && prior !== entry) throw new Error('同一素材来自不同图库条目，请统一选择条目后再准备发布')
        entryRefs.set(value.media.id, entry)
      })
      const cover = item.params.video?.cover.ossUrl ? await load(item.params.video.cover.ossUrl, 'cover') : undefined
      for (const value of [...selected, ...(cover ? [cover] : [])]) media.set(value.media.id, value.media)
      const id = uuidFrom(await hashText(`${seed}:target:${platform}:${item.account.id}`)); const titleOverride = item.params.title || ''; const bodyOverride = item.params.des || ''; const topicsOverride = item.params.topics || []; const mediaIds = selected.map(value => value.media.id)
      if (platform === 'douyin' && item.account.nativeAccountKind === 'official') {
        if (item.account.nativeAccountKind !== 'official' || !item.account.nativeRevision) throw new Error('抖音必须使用独立的官方授权绑定，浏览器摘要不能替代')
        const officialAsset = async (value: LoadedMedia) => {
          const asset = value.kind === 'provider' ? value.asset : await readReadyNativeMainMediaBridgeAsset({ reference: value.reference, mediaId: value.mediaId, file: { mime: value.file.type, size: value.file.size, sha256: value.sha256 } })
          assets.set(value.media.id, asset)
          return { media: value.media, asset }
        }
        const providerSelected = await Promise.all(selected.map(officialAsset))
        const providerCover = cover ? await officialAsset(cover) : undefined
        const source = item.params.option.douyin || {}; const options = PublishingV3OptionsSchema.parse({ short_title: source.short_title ?? '', cover_tsp: source.cover_tsp ?? 0, download_type: source.download_type ?? 1, private_status: source.private_status ?? 0 })
        const prepared = preparePublishingV3Content({ title: titleOverride, body: bodyOverride, topics: topicsOverride, options }); const errors = [...prepared.errors, ...validatePublishingV3Media(kind, providerSelected.map(value => ({ ...value.media, ...value.asset.metadata, type: value.asset.mime, size: value.asset.size })), providerCover ? { fileName: providerCover.asset.fileName, type: providerCover.asset.mime, size: providerCover.asset.size } : undefined)]
        if (errors.length) throw new Error(`抖音：${errors.join('；')}`)
        officialTargets.push({ id, bindingId: item.account.id, bindingRevision: item.account.nativeRevision, titleOverride, bodyOverride, topicsOverride, mediaIds, ...(providerCover ? { coverMediaId: providerCover.media.id } : {}), assetIds: [...providerSelected, ...(providerCover && !providerSelected.some(value => value.asset.id === providerCover.asset.id) ? [providerCover] : [])].map(value => value.asset.id), publishAt: targetPublishAt, options })
      } else {
        if (item.account.nativeAccountKind === 'official') throw new Error('插件目标必须使用浏览器账号摘要')
        const nativeOptions = platform === 'douyin' ? { privacyLevel: 'public' } : platform === 'xhs' ? item.params.option.xhs?.userDeclarationBind ? { declaration: item.params.option.xhs.userDeclarationBind.origin } : {} : { ...(item.params.option.wxSph?.poiInfo ? { poiInfo: item.params.option.wxSph.poiInfo } : {}), ...(item.params.option.wxSph?.activity ? { event: item.params.option.wxSph.activity } : {}), ...(item.params.option.wxSph?.extLink ? { extLink: item.params.option.wxSph.extLink } : {}), postFlag: item.params.option.wxSph?.isOriginal ? 1 : 0 }
        const prepared = prepareNativePluginContent(platform, titleOverride, bodyOverride, topicsOverride); const errors = [...prepared.errors, ...validateNativePublishingMedia(platform, kind, selected.map(value => value.media), cover?.media, targetPublishAt)]
        if (errors.length) throw new Error(`${platform === 'xhs' ? '小红书' : '视频号'}：${errors.join('；')}`)
        draft.targets.push(PublishingV2TargetSchema.parse({ id, platform, accountId: item.account.id, scheduledAt: targetPublishAt, titleOverride, bodyOverride, topicsOverride, mediaIds, ...(cover ? { coverMediaId: cover.media.id } : {}), options: nativeOptions }))
      }
      if (!accountTypes.includes(platform as 'xhs' | 'wxSph' | 'douyin')) accountTypes.push(platform as 'xhs' | 'wxSph' | 'douyin')
    }
    draft.media = [...media.values()]
    const commonMetadata = { coverMediaId: kind === 'image' ? draft.media.find(item => item.role === 'image')?.id || null : draft.targets[0]?.coverMediaId || officialTargets[0]?.coverMediaId || null, accountTypes, maxUseCountByAccountType: Object.fromEntries(accountTypes.map(platform => [platform, 999999])) as Partial<Record<'xhs' | 'wxSph' | 'douyin', 999999>> }
    const metadata = draft.media.some(item => item.source === 'main_asset')
      ? { ...commonMetadata, schemaVersion: 2 as const, media: draft.media.map(item => ({ mediaId: item.id, source: sources.get(item.id)! })) }
      : { ...commonMetadata, schemaVersion: 1 as const, media: draft.media.map(item => ({ mediaId: item.id, assetId: assets.get(item.id)!.id })) }
    accountTypes.forEach(platform => NativePlatformSchema.parse(platform))
    groups.push({ key: kind, draft: PublishingV2DraftInputSchema.parse(draft), metadata, officialTargets, mediaEntryRefs: [...entryRefs].map(([mediaId, mediaEntryId]) => ({ mediaId, mediaEntryId })) })
  }
  const planBody = { ...(input.sourceDraftId && input.sourceDraftVersion ? { sourceDraftId: input.sourceDraftId, sourceDraftVersion: input.sourceDraftVersion } : {}), groups }
  const planHash = await hashText(nativePreparePlanCanonical(planBody)); assertHostSession(owner, version)
  return { plan: NativePreparePublishSchema.parse({ ...planBody, planHash, requestKey: `native-plan:${planHash}` }), files: { files, assets } }
}
