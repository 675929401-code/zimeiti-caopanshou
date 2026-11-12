import type { PublishingPlatformMetadata, PublishingTargetProfile } from './publishing-generic-contract'

const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
export const studioProviderContentMode = (mode: 'text' | 'image' | 'video') => ({ text: 'article2', image: 'article', video: 'video' })[mode]
export interface GenericPublishingFieldPolicy { allowedValues: Record<string, readonly unknown[]>; blockedFields: Record<string, string>; executionReason?: string }
/** Fixed 47e5a6 execution evidence, additional to dynamic schema validation. */
export function genericPublishingFieldPolicy(platform: string): GenericPublishingFieldPolicy {
  if (platform === 'linkedin') return { allowedValues: { visibility: ['PUBLIC'], distribution: ['MAIN_FEED'] }, blockedFields: {} }
  if (platform === 'facebook') return { allowedValues: { video_state: ['PUBLISHED'] }, blockedFields: { feed_targeting: '当前通道不能保证仅向指定受众展示，请移除受众限制后再确认，或到平台完成发布' } }
  if (platform === 'instagram') return { allowedValues: {}, blockedFields: { caption: '请将这段文字填写到本账号正文，并移除重复的说明选项', product_tags: '当前通道暂不能添加商品标记，请移除此设置，发布后到平台补充', user_tags: '当前通道暂不能添加用户标记，请移除此设置，发布后到平台补充', collaborators: '当前通道暂不能邀请协作者，请移除此设置，发布后到平台补充' } }
  // 公众号按官方 optionSchema 走 draftOnly 草稿模式：服务端在组装发布参数时
  // 强制 draftOnly=true、massSend=false，作品只进公众号后台草稿箱，由客户在
  // 公众号后台核对后手动群发，不再整平台阻断。
  if (platform === 'wxGzh') return { allowedValues: {}, blockedFields: {} }
  return { allowedValues: {}, blockedFields: {} }
}
export function validateGenericPublishingPolicy(platform: string, options: Record<string, unknown>): string[] {
  const policy = genericPublishingFieldPolicy(platform), errors: string[] = policy.executionReason ? [policy.executionReason] : []
  for (const [key, values] of Object.entries(policy.allowedValues)) if (options[key] !== undefined && !values.includes(options[key])) errors.push(key === 'visibility' || key === 'distribution' ? '此通道仅支持公开展示，请修改可见范围后重新确认，或到平台发布' : '此通道不能保存为平台草稿，请改为发布作品后重新确认，或到平台操作')
  for (const [key, reason] of Object.entries(policy.blockedFields)) if (options[key] !== undefined && options[key] !== null && options[key] !== '' && !(Array.isArray(options[key]) && !(options[key] as unknown[]).length)) errors.push(reason)
  return errors
}
export function effectiveGenericPublishingContent(platform: string, title: string, body: string, topics: string[], options: Record<string, unknown>) {
  const replacement = platform === 'linkedin' ? options.commentary : undefined
  return { title, body: typeof replacement === 'string' ? replacement : genericPublishingBody(body, topics), topics: typeof replacement === 'string' ? [] : topics }
}
/** The fixed upstream content builder places normalized topics in the body. */
export function genericPublishingBody(body: string, topics: string[]): string {
  const found = [...body.matchAll(/#([^\s#]+)(?:\[话题\])?#?/gu)].map(match => match[1])
  const clean = body.replace(/#([^\s#]+)(?:\[话题\])?#?/gu, '').trim()
  const unique = new Map<string, string>()
  for (const raw of [...found, ...topics]) { const topic = raw.replace(/\[话题\]/gu, '').replace(/^#+|#+$/gu, '').trim(); if (topic && !unique.has(topic.toLowerCase())) unique.set(topic.toLowerCase(), topic) }
  return [clean, [...unique.values()].map(topic => `#${topic}`).join(' ')].filter(Boolean).join('\n')
}
export function validateGenericPublishingContent(metadata: PublishingPlatformMetadata, mode: 'text' | 'image' | 'video', target: Pick<PublishingTargetProfile, 'title' | 'body' | 'topics' | 'mediaIds' | 'coverMediaId'>, media: Array<{ id: string; type: string; size: number; fileName: string; duration?: number; width?: number; height?: number }>): string[] {
  const limits = record(metadata.contentLimits), rules = record(metadata.mediaRules), topic = record(metadata.topic), errors: string[] = []
  const selected = target.mediaIds.map(id => media.find(m => m.id === id)).filter((m): m is typeof media[number] => !!m)
  const body = genericPublishingBody(target.body, target.topics)
  const max = (key: string, actual: number, message: string) => { if (typeof limits[key] === 'number' && actual > Number(limits[key])) errors.push(`${message}（上限 ${limits[key]}）`) }
  if (selected.length !== target.mediaIds.length) errors.push('目标素材未完整读取')
  if (Array.isArray(limits.modes) && !limits.modes.includes(studioProviderContentMode(mode))) errors.push('平台当前不支持此内容类型')
  if (mode === 'text' && (!body.trim() || selected.length)) errors.push('文字稿需要正文且不附带素材')
  if (mode !== 'text' && !selected.length) errors.push('请选择目标素材')
  if (Number(limits.maxTitleLength) !== 0) max('maxTitleLength', target.title.length, '标题过长')
  max('maxBodyLength', body.length, '正文过长'); max('maxTotalTextLength', (Number(limits.maxTitleLength) === 0 ? 0 : target.title.length) + body.length, '标题与正文总长度过长')
  max('maxMediaCount', selected.length, '素材数量超限'); max('maxImages', selected.filter(m => m.type.startsWith('image/')).length, '图片数量超限'); max('maxVideos', selected.filter(m => m.type.startsWith('video/')).length, '视频数量超限')
  if (topic.supported === false && target.topics.length) errors.push('平台当前不支持话题，请清除该目标话题')
  if (typeof topic.maxCount === 'number' && target.topics.length > topic.maxCount) errors.push(`话题不能超过 ${topic.maxCount} 个`)
  if (typeof topic.maxTotalLength === 'number' && target.topics.join(',').length > topic.maxTotalLength) errors.push('话题总长度超限')
  for (const item of media) {
    const video = item.type.startsWith('video/'), formats = rules[video ? 'videoFormats' : 'imageFormats'], size = rules[video ? 'maxVideoSize' : 'maxImageSize']
    const extension = item.fileName.split('.').at(-1)?.toLowerCase()
    if (Array.isArray(formats) && !formats.includes(extension)) errors.push(`${item.fileName} 的文件格式不符合平台要求`)
    if (typeof size === 'number' && item.size > size) errors.push(`${item.fileName} 的文件大小超限`)
    if (video && typeof rules.maxVideoDuration === 'number' && (typeof item.duration !== 'number' || item.duration > rules.maxVideoDuration)) errors.push(`${item.fileName} 的时长未确认或超限`)
    if (video && typeof rules.minVideoDuration === 'number' && (typeof item.duration !== 'number' || item.duration < rules.minVideoDuration)) errors.push(`${item.fileName} 的时长未确认或过短`)
    const aspect = record(rules.aspectRatio)
    if (typeof aspect.min === 'number' || typeof aspect.max === 'number') {
      const ratio = item.width && item.height ? item.width / item.height : NaN
      if (!Number.isFinite(ratio) || typeof aspect.min === 'number' && ratio < aspect.min || typeof aspect.max === 'number' && ratio > aspect.max) errors.push(`${item.fileName} 的画面比例未确认或不符合平台要求`)
    }
  }
  return [...new Set(errors)]
}
/** Identity/media options cannot bypass owner bindings or the asset manifest. */
export function validateGenericReservedOptions(options: Record<string, unknown>, platformUid: string, ownedUrls: ReadonlySet<string>): boolean {
  const visit = (value: unknown, key: string): boolean => {
    if (key === 'authorUrn') return value === platformUid || value === `urn:li:person:${platformUid}`
    if (typeof value === 'string' && /(?:cover|image|video|media).*(?:url|uri)|^(?:cover|image|video)$/iu.test(key)) return ownedUrls.has(value)
    if (Array.isArray(value)) return value.every(item => visit(item, key))
    return !value || typeof value !== 'object' || Object.entries(value).every(([child, item]) => visit(item, child))
  }
  return visit(options, '')
}
