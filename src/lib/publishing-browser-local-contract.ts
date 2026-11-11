import { z } from 'zod'
import { PublishingV2DraftInputSchema } from './publishing-v2-contract'

const account = z.object({ id: z.string().uuid(), platform: z.enum(['xhs', 'wxSph', 'douyin']), uid: z.string().min(1).max(200), revision: z.number().int().positive(), metadataRevision: z.number().int().nonnegative() }).strict()
export const BrowserLocalPlanSchema = z.object({
  requestKey: z.string().min(8).max(160).regex(/^[A-Za-z0-9_.:-]+$/u),
  planHash: z.string().regex(/^[a-f0-9]{64}$/u),
  accounts: z.array(account).min(1).max(100), draft: PublishingV2DraftInputSchema,
}).strict().superRefine((value, context) => {
  if (new Set(value.accounts.map(item => item.id)).size !== value.accounts.length) context.addIssue({ code: 'custom', path: ['accounts'], message: '浏览器账号标识不可重复' })
  if (value.accounts.length !== value.draft.targets.length || value.accounts.some(item => value.draft.targets.filter(target => target.accountId === item.id && target.platform === item.platform).length !== 1)) context.addIssue({ code: 'custom', path: ['draft', 'targets'], message: '每个浏览器账号必须且只能对应一个发布目标' })
  const used = new Set<string>()
  for (const [index, target] of value.draft.targets.entries()) {
    const selection = target.mediaIds ?? value.draft.media.filter(item => item.role !== 'cover').map(item => item.id)
    if (!selection.length || (value.draft.contentType === 'video' && selection.length !== 1)) context.addIssue({ code: 'custom', path: ['draft', 'targets', index, 'mediaIds'], message: '每个账号必须选定实际图片或单个成片' })
    for (const id of selection) {
      used.add(id); const media = value.draft.media.find(item => item.id === id)
      if (!media || media.role !== value.draft.contentType) context.addIssue({ code: 'custom', path: ['draft', 'targets', index, 'mediaIds'], message: '目标素材类型不一致' })
    }
    if (target.coverMediaId) used.add(target.coverMediaId)
    if (target.platform === 'douyin') {
      const selectedMedia = [...selection, ...(target.coverMediaId ? [target.coverMediaId] : [])].map(id => value.draft.media.find(item => item.id === id))
      if (selectedMedia.some(media => media && media.role !== 'video' && !['image/jpeg', 'image/png'].includes(media.type))) context.addIssue({ code: 'custom', path: ['draft', 'targets', index, 'mediaIds'], message: '抖音账号使用的图片和封面须为 JPG 或 PNG，请为该账号更换素材' })
    }
    if (target.platform === 'douyin' && target.options.privacyLevel && target.options.privacyLevel !== 'public') context.addIssue({ code: 'custom', path: ['draft', 'targets', index, 'options'], message: '当前抖音浏览器通道不支持指定私密可见范围' })
  }
  for (const [index, media] of value.draft.media.entries()) {
    if (media.source !== 'local_file' || media.requiresReselection !== true || !media.hash || media.size <= 0 || !used.has(media.id)) context.addIssue({ code: 'custom', path: ['draft', 'media', index], message: '浏览器本地计划只保存实际使用的文件摘要，必须包含哈希且不可携带远程来源' })
    if (media.role === 'video' ? media.type !== 'video/mp4' : !['image/jpeg', 'image/png', 'image/webp'].includes(media.type)) context.addIssue({ code: 'custom', path: ['draft', 'media', index, 'type'], message: '本地媒体支持 JPG、PNG、WebP 图片和 MP4 视频；图片格式还需符合所选平台要求' })
    if (/[\\/\u0000-\u001f]/u.test(media.fileName)) context.addIssue({ code: 'custom', path: ['draft', 'media', index, 'fileName'], message: '只可保存文件名称，不可保存本机路径' })
  }
})
export type BrowserLocalPlan = z.infer<typeof BrowserLocalPlanSchema>

/** Stable JSON shared by browser and server; request identity is excluded. */
export function browserLocalPlanCanonical(input: BrowserLocalPlan): string {
  const value = BrowserLocalPlanSchema.parse(input)
  const sorted = (entry: unknown): unknown => Array.isArray(entry) ? entry.map(sorted) : entry && typeof entry === 'object' ? Object.fromEntries(Object.entries(entry).filter(([, child]) => child !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, child]) => [key, sorted(child)])) : entry
  return JSON.stringify(sorted({ accounts: value.accounts, draft: value.draft }))
}
