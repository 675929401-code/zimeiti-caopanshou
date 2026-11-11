import { PublishingV2WxOptionsSchema, PublishingV2XhsOptionsSchema } from '@/lib/publishing-v2-contract'
import { PublishingV3OptionsSchema, preparePublishingV3Content, validatePublishingV3Media } from '@/lib/publishing-v3-contract'
import { prepareNativePluginContent, validateNativePublishingMedia } from '@/lib/publishing-native'
import type { PublishingStudioBootstrap } from '@/lib/publishing-studio-contract'
import { effectiveGenericPublishingContent, validateGenericPublishingContent, validateGenericPublishingPolicy } from '@/lib/publishing-generic-validation'
import { validatePublishingProviderOptions } from '@/lib/publishing-option-schema'
import { nativeSha256, uploadNativeAsset } from './native-assets'
import { probeNativePublishingFile, readNativePublishingMedia } from './native-readable-media'
import type { StudioAccount, StudioDraft, StudioMedia, StudioPlanItem, StudioPlatform } from './types'

export const emptyStudioDraft = (): StudioDraft => ({ contentType: 'image', title: '', body: '', topics: [], media: [], targetOverrides: {} })
export function effectiveStudioTargetContent(draft: StudioDraft, account: StudioAccount, platform?: StudioPlatform) {
  const override = draft.targetOverrides[account.id] || {}, title = override.title ?? draft.title, body = override.body ?? draft.body, topics = override.topics ?? draft.topics
  return account.kind === 'generic' ? effectiveGenericPublishingContent(account.platform, title, body, topics, override.providerOptions ?? platform?.defaultOption ?? {}) : { title, body, topics }
}
export function copyStudioDraft(draft: StudioDraft): StudioDraft {
  const copy = (media: StudioMedia) => ({ ...media, originalFile: media.originalFile ? { ...media.originalFile } : undefined })
  return { ...draft, topics: [...draft.topics], media: draft.media.map(copy), cover: draft.cover ? copy(draft.cover) : undefined, targetOverrides: Object.fromEntries(Object.entries(draft.targetOverrides).map(([id, value]) => [id, { ...value, topics: value.topics ? [...value.topics] : undefined, mediaIds: value.mediaIds ? [...value.mediaIds] : undefined, cover: value.cover ? copy(value.cover) : undefined, options: value.options ? structuredClone(value.options) : undefined, providerOptions: value.providerOptions ? structuredClone(value.providerOptions) : undefined }])) }
}
export function targetStudioMedia(draft: StudioDraft, accountId: string): StudioMedia[] {
  const selected = draft.targetOverrides[accountId]?.mediaIds
  if (selected === undefined) return draft.media
  if (new Set(selected).size !== selected.length) throw new Error('账号素材不能重复，请重新选择')
  return selected.map(id => { const value = draft.media.find(media => media.id === id); if (!value) throw new Error('账号选择的素材已变化，请重新核对'); return value })
}
export function allDraftMedia(draft: StudioDraft) { return [...draft.media, ...(draft.cover ? [draft.cover] : []), ...Object.values(draft.targetOverrides).flatMap(value => value.cover ? [value.cover] : [])] }
export async function readStudioMedia(media: StudioMedia): Promise<StudioMedia> {
  const verify = async (file: File) => {
    const original = media.originalFile
    if (original && (file.size !== original.size || file.type !== original.type || original.sha256 && await nativeSha256(file) !== original.sha256 || media.stage === 'local' && !original.sha256)) throw new Error('原计划文件的摘要、大小或格式不一致，已停止恢复')
  }
  if (media.stage === 'local' && media.file) {
    await verify(media.file)
    const metadata = await probeNativePublishingFile(media.file)
    return { ...media, ...metadata, size: media.file.size, status: 'ready' }
  }
  if (!media.url || media.url.startsWith('blob:')) throw new Error(media.error || '素材尚未保存为本站受控记录，请重新选择文件')
  const result = await readNativePublishingMedia(media.url)
  await verify(result.file)
  return { ...media, id: media.originalFile ? media.id : result.mediaId, name: media.originalFile ? media.name : result.file.name, file: result.file, size: result.file.size, ...result.metadata, status: 'ready', stage: result.kind === 'main' ? 'main' : 'provider' }
}
export async function freezeStudioDraft(input: StudioDraft, current: () => void) {
  const draft = copyStudioDraft(input), seen = new Map<string, StudioMedia>()
  const read = async (media: StudioMedia) => {
    let value = seen.get(media.id)
    if (!value) { value = await readStudioMedia(media); current(); seen.set(media.id, value) }
    return value
  }
  draft.media = await Promise.all(draft.media.map(read)); current()
  if (draft.cover) draft.cover = await read(draft.cover)
  for (const override of Object.values(draft.targetOverrides)) if (override.cover) override.cover = await read(override.cover)
  for (const override of Object.values(draft.targetOverrides)) if (override.mediaIds) override.mediaIds = override.mediaIds.map(id => { const value = seen.get(id); if (!value) throw new Error('账号素材引用不完整'); return value.id })
  current(); return draft
}
export async function studioContentHash(draft: StudioDraft, accounts: StudioAccount[]) {
  const media = await Promise.all(allDraftMedia(draft).map(async item => {
    if (!item.file) throw new Error('无法核对实际素材文件')
    return { id: item.id, source: item.stage, url: item.stage === 'local' ? undefined : item.url, name: item.name, size: item.file.size, type: item.file.type, sha256: await nativeSha256(item.file) }
  }))
  const describe = (item?: StudioMedia) => item ? { id: item.id, stage: item.stage } : undefined
  const value = { ...draft, media: draft.media.map(describe), cover: describe(draft.cover), targetOverrides: Object.fromEntries(Object.entries(draft.targetOverrides).map(([id, value]) => [id, { ...value, cover: describe(value.cover) }])), files: media, accounts: accounts.map(({ id, platform, uid, kind, revision, metadataRevision }) => ({ id, platform, uid, kind, revision, metadataRevision })) }
  return nativeSha256(new Blob([JSON.stringify(value)], { type: 'text/plain' }))
}
export function studioPlanItems(draft: StudioDraft, accounts: StudioAccount[]): StudioPlanItem[] {
  const selection = (item: StudioMedia) => ({ ossUrl: item.url, filename: item.name, file: item.file, nativeMediaEntryId: item.nativeMediaEntryId })
  return accounts.map(account => {
    const override = draft.targetOverrides[account.id] || {}, cover = override.cover || draft.cover, media = targetStudioMedia(draft, account.id)
    if (draft.contentType !== 'text' && (!media.length || draft.contentType === 'video' && media.length !== 1)) throw new Error(`${account.name}请选择一份成片，或至少一张图片`)
    return { publishAt: override.publishAt, account: { id: account.id, type: account.platform, nickname: account.name, nativeAccountKind: account.kind, nativeRevision: account.revision, nativeConnectionCurrent: true }, params: { title: override.title ?? draft.title, des: override.body ?? draft.body, topics: override.topics ?? draft.topics, option: override.options ?? {}, ...(draft.contentType === 'video' ? { video: { ...selection(media[0]), cover: cover ? selection(cover) : {} } } : { images: media.map(selection) }) } }
  })
}
export function assertStudioPreflight(draft: StudioDraft, accounts: StudioAccount[], platforms: StudioPlatform[], bootstrap: PublishingStudioBootstrap) {
  if (!bootstrap.schemaReady || !bootstrap.access.allowed) throw new Error(bootstrap.access.message || '发布服务存储尚未就绪')
  if (!bootstrap.config.executionEnabled) throw new Error('发布服务尚未开放，可以先保存草稿')
  if (!accounts.length) throw new Error('请先选择要发布的账号')
  if (draft.contentType !== 'text' && !draft.media.length || draft.contentType === 'video' && draft.media.some(value => value.kind !== 'video')) throw new Error('请选择图片素材，或完整的视频成片')
  if (draft.contentType === 'image' && draft.media.some(media => media.kind !== 'image')) throw new Error('图文内容只能选择图片')
  if (draft.publishAt && (!Number.isFinite(Date.parse(draft.publishAt)) || Date.parse(draft.publishAt) <= Date.now())) throw new Error('请重新选择未来的发布时间')
  for (const account of accounts) {
    const platform = platforms.find(value => value.key === account.platform)
    if (!platform?.available || account.status !== 'ready') throw new Error(`${account.name}：${platform?.reason || '账号尚不可发布'}`)
    const channel = platform.channels?.find(value => value.transport === (account.kind === 'browser' ? 'browser_plugin' : 'official_api'))
    if (channel && !channel.publishAllowed) throw new Error(`${account.name}：${channel.reason}`)
    const override = draft.targetOverrides[account.id] || {}, cover = override.cover || draft.cover, selectedMedia = targetStudioMedia(draft, account.id)
    if (draft.contentType !== 'text' && (!selectedMedia.length || draft.contentType === 'video' && selectedMedia.length !== 1)) throw new Error(`${account.name}需要选择一份视频，或至少一张图片`)
    const facts = selectedMedia.map(item => ({ role: item.kind, fileName: item.name, type: item.file?.type || '', size: item.size, width: item.width, height: item.height, duration: item.duration }))
    const coverFact = cover ? { role: 'cover', fileName: cover.name, type: cover.file?.type || '', size: cover.size, width: cover.width, height: cover.height } : undefined
    const { title, body, topics } = effectiveStudioTargetContent(draft, account, platform)
    const publishAt = override.publishAt ?? draft.publishAt
    if (publishAt && (!Number.isFinite(Date.parse(publishAt)) || Date.parse(publishAt) <= Date.now())) throw new Error(`${account.name}的计划时间已过，请重新选择`)
    let errors: string[]
    if (account.kind === 'generic') {
      errors = validateGenericPublishingContent(platform, draft.contentType, { title, body, topics, mediaIds: selectedMedia.map(m => m.id), coverMediaId: cover?.id }, [...selectedMedia, ...(cover ? [cover] : [])].map(m => ({ id: m.id, fileName: m.name, type: m.file?.type ?? '', size: m.size, width: m.width, height: m.height, duration: m.duration })))
      if (!platform.optionSchema || !validatePublishingProviderOptions(platform.optionSchema, override.providerOptions ?? platform.defaultOption ?? {})) errors.push('请补齐当前平台要求的发布参数')
      errors.push(...validateGenericPublishingPolicy(account.platform, override.providerOptions ?? platform.defaultOption ?? {}))
      if (draft.contentType === 'video' && ['KWAI', 'pinterest'].includes(account.platform) && !cover) errors.push('此平台视频发布需要上传封面')
    } else if (draft.contentType === 'text') {
      errors = ['此通道当前不支持纯文字内容']
    } else if (account.platform === 'douyin' && account.kind === 'official') {
      const options = PublishingV3OptionsSchema.parse(override.options?.douyin || {})
      errors = [...preparePublishingV3Content({ title, body, topics, options }).errors, ...validatePublishingV3Media(draft.contentType, facts, coverFact)]
    } else {
      const platformKey = account.platform as 'xhs' | 'wxSph' | 'douyin'
      if (platformKey === 'xhs') PublishingV2XhsOptionsSchema.parse(override.options?.xhs?.userDeclarationBind ? { declaration: override.options.xhs.userDeclarationBind.origin } : {})
      else if (platformKey === 'wxSph') { const option = override.options?.wxSph; PublishingV2WxOptionsSchema.parse({ ...(option?.poiInfo ? { poiInfo: option.poiInfo } : {}), ...(option?.activity ? { event: option.activity } : {}), ...(option?.extLink ? { extLink: option.extLink } : {}), postFlag: option?.isOriginal ? 1 : 0 }) }
      errors = [...prepareNativePluginContent(platformKey, title, body, topics).errors, ...validateNativePublishingMedia(platformKey, draft.contentType, facts, coverFact, publishAt)]
      if (platformKey === 'douyin') { const option = override.options?.douyin; if (option && (option.short_title || option.cover_tsp || option.private_status || option.download_type !== undefined && option.download_type !== 1)) errors.push('所选抖音参数仅官方接口通道使用，请清除或切换通道；浏览器发布当前仅支持公开作品') }
    }
    if (errors.length) throw new Error(`${account.name}：${errors.join('；')}`)
  }
}
/** This function is called only after the user confirms the frozen content. */
export async function materializeStudioDraft(input: StudioDraft, current: () => void) {
  const draft = copyStudioDraft(input), completed = new Map<string, StudioMedia>(), identities = new Map<string, string>()
  const upload = async (media: StudioMedia) => {
    const existing = completed.get(media.id); if (existing) return existing
    if (media.stage !== 'local') { identities.set(media.id, media.id); return media }
    current(); if (!media.file) throw new Error('本地文件已不可读取，请重新选择')
    const url = await uploadNativeAsset(media.file, { assertCurrent: current }); current()
    const value = await readStudioMedia({ ...media, url, stage: 'provider' }); current(); completed.set(media.id, value); identities.set(media.id, value.id); return value
  }
  // Sequential uploads make an uncertain first upload stop later side effects.
  for (let index = 0; index < draft.media.length; index++) draft.media[index] = await upload(draft.media[index])
  if (draft.cover) draft.cover = await upload(draft.cover)
  for (const override of Object.values(draft.targetOverrides)) if (override.cover) override.cover = await upload(override.cover)
  for (const override of Object.values(draft.targetOverrides)) if (override.mediaIds) override.mediaIds = override.mediaIds.map(id => { const mapped = identities.get(id); if (!mapped) throw new Error('账号素材上传映射不完整'); return mapped })
  return draft
}
