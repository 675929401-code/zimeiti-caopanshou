import { z } from 'zod'
import { projectPublishingAccount } from '@host-publishing/publishing-plugin'
import type { AIToEarnPluginAPI, PlatformRequestParams } from '@/store/plugin/types/baseTypes'
import { assertHostSession, getHostSession, getHostSessionRevision } from './host-session'
import { projectPluginAccount } from './plugin-account'

const denied = () => new Error('此插件操作尚未取得主站确认与执行许可，未调用插件；发布请使用原发布确认窗口')
const unavailable = () => new Error('当前插件不提供所需能力，请更新并重新授权')
const valueText = z.string().max(2048).refine(value => !/[\u0000-\u001f\u007f]/u.test(value))
const request = z.object({ path: z.string().min(1).max(12000), method: z.enum(['GET', 'POST']), data: z.unknown().optional() }).strict()
const feed = z.object({ cursor_score: valueText, num: z.number().int().min(1).max(100), refresh_type: z.union([z.literal(1), z.literal(3)]), note_index: z.number().int().min(0).max(10000000), unread_begin_note_id: z.literal(''), unread_end_note_id: z.literal(''), unread_note_count: z.literal(0), category: z.literal('homefeed_recommend'), search_key: z.literal(''), need_num: z.number().int().min(1).max(10), image_formats: z.tuple([z.literal('jpg'), z.literal('webp'), z.literal('avif')]), need_filter_image: z.literal(false) }).strict()
const douyinKeys = new Set(['device_platform', 'aid', 'channel', 'module_id', 'count', 'filterGids', 'presented_ids', 'refresh_index', 'refer_id', 'refer_type', 'pull_type', 'awemePcRecRawData', 'Seo-Flag', 'tag_id', 'active_id', 'is_active_tab', 'use_lite_type', 'xigua_user', 'pc_client_type', 'pc_libra_divert', 'update_version_code', 'support_h265', 'support_dash', 'version_code', 'version_name', 'cookie_enabled', 'screen_width', 'screen_height', 'browser_language', 'browser_platform', 'browser_name', 'browser_version', 'browser_online', 'engine_name', 'engine_version', 'os_name', 'os_version', 'cpu_core_num', 'device_memory', 'platform', 'downlink', 'effective_type', 'round_trip_time'])
function readableRequest(platform: 'xhs' | 'douyin', raw: PlatformRequestParams): PlatformRequestParams {
 const parsed = request.safeParse(raw)
 if (!parsed.success) throw denied()
 const input = parsed.data
 if (platform === 'xhs' && input.path === '/api/sns/web/v1/homefeed' && input.method === 'POST') {
  const body = feed.safeParse(input.data); if (!body.success) throw denied(); return { path: input.path, method: 'POST', data: body.data }
 }
 let url: URL; try { url = new URL(input.path, 'https://www.xiaohongshu.com') } catch { throw denied() }
 if (platform === 'xhs') {
  const sub = url.pathname === '/api/sns/web/v2/comment/sub/page'
  if (!input.path.startsWith('/api/sns/web/v2/comment/') || input.method !== 'GET' || input.data !== undefined || url.origin !== 'https://www.xiaohongshu.com' || url.hash || !sub && url.pathname !== '/api/sns/web/v2/comment/page') throw denied()
  const allowed = new Set(['note_id', 'cursor', 'top_comment_id', 'image_formats', 'xsec_token', ...(sub ? ['root_comment_id', 'num'] : [])]), seen = new Set<string>()
  for (const [key, value] of url.searchParams) { if (!allowed.has(key) || seen.has(key) || !valueText.safeParse(value).success) throw denied(); seen.add(key) }
  if (!/^[A-Za-z0-9_-]{1,160}$/u.test(url.searchParams.get('note_id') || '') || url.searchParams.get('top_comment_id') !== '' || url.searchParams.get('image_formats') !== 'jpg,webp,avif' || !url.searchParams.has('cursor') || sub && (!/^[A-Za-z0-9_-]{1,160}$/u.test(url.searchParams.get('root_comment_id') || '') || !/^(?:[1-9]|[1-9][0-9]|100)$/u.test(url.searchParams.get('num') || ''))) throw denied()
  return { path: url.pathname + url.search, method: 'GET' }
 }
 if (input.method !== 'POST' || input.data !== undefined || url.origin !== 'https://www.douyin.com' || url.pathname !== '/aweme/v2/web/module/feed/' || url.hash || url.username || url.password) throw denied()
 const seen = new Set<string>(); for (const [key, value] of url.searchParams) { if (!douyinKeys.has(key) || seen.has(key) || !valueText.safeParse(value).success) throw denied(); seen.add(key) }
 if (url.searchParams.get('device_platform') !== 'webapp' || url.searchParams.get('aid') !== '6383' || url.searchParams.get('module_id') !== '3003101' || !/^(?:[1-9]|[1-9][0-9]|100)$/u.test(url.searchParams.get('count') || '') || !/^[1-9][0-9]{0,6}$/u.test(url.searchParams.get('refresh_index') || '')) throw denied()
 return { path: url.href, method: 'POST' }
}

/** All original consumers receive this closed facade. The raw global is private to this adapter and the audited publish runner. */
export function nativePluginApi(): AIToEarnPluginAPI | undefined {
 const raw = typeof window === 'undefined' ? undefined : window.AIToEarnPlugin
 if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
 const methods = raw as Record<string, unknown>, createdOwner = getHostSession()?.user.id, createdRevision = getHostSessionRevision()
 async function call(name: keyof AIToEarnPluginAPI, args: unknown[]): Promise<unknown> {
  const actor = assertHostSession(createdOwner, createdRevision), revision = getHostSessionRevision()
  if (window.AIToEarnPlugin !== raw || typeof methods[name] !== 'function') throw unavailable()
  let value: unknown; try { value = await Reflect.apply(methods[name] as (...values: unknown[]) => unknown, raw, args) } catch { assertHostSession(actor.user.id, revision); throw unavailable() }
  assertHostSession(actor.user.id, revision); return value
 }
 async function blocked(): Promise<never> { assertHostSession(createdOwner, createdRevision); throw denied() }
 const facade: AIToEarnPluginAPI = {
  checkPermission: async () => z.object({ granted: z.boolean(), hostAccess: z.boolean().optional(), permissions: z.array(z.string().max(120)).max(100).optional() }).strip().parse(await call('checkPermission', [])),
  login: async platform => { if (platform !== 'xhs' && platform !== 'wxSph') throw denied(); const rawAccount = await call('login', [platform]), identity = projectPublishingAccount(rawAccount, platform), result = projectPluginAccount(platform, rawAccount); if (!result) throw unavailable(); return { ...result, uid: identity.uid, nickname: identity.nickname, account: identity.account, avatar: identity.avatar || '' } },
  publish: blocked, proxyRequest: blocked, unifiedInteraction: blocked, douyinInteraction: blocked, douyinDirectMessage: blocked, remoteAutomationRun: blocked, wxSphStartLinkPolling: blocked,
  xhsRequest: async <T = unknown>(params: PlatformRequestParams): Promise<T> => await call('xhsRequest', [readableRequest('xhs', params)]) as T,
  douyinRequest: async <T = unknown>(params: PlatformRequestParams): Promise<T> => await call('douyinRequest', [readableRequest('douyin', params)]) as T,
  ...(typeof methods.getVersion === 'function' ? { getVersion: async () => z.object({ version: z.string().max(80).regex(/^v?\d+(?:\.\d+){1,3}(?:[-+][A-Za-z0-9.-]+)?$/u) }).strip().parse(await call('getVersion', [])) } : {}),
  ...(typeof methods.wxSphSearchLocation === 'function' ? { wxSphSearchLocation: async (params: Parameters<NonNullable<AIToEarnPluginAPI['wxSphSearchLocation']>>[0]) => { const query = z.object({ query: valueText.min(1).max(120), longitude: z.number().min(-180).max(180).optional(), latitude: z.number().min(-90).max(90).optional() }).strict().parse(params); return z.array(z.object({ uid: valueText, name: valueText, longitude: z.number().min(-180).max(180), latitude: z.number().min(-90).max(90), address: valueText.optional(), province: valueText.optional(), city: valueText.optional(), region: valueText.optional(), fullAddress: valueText.optional(), poiCheckSum: valueText.optional() }).strip()).max(100).parse(await call('wxSphSearchLocation', [query])) } } : {}),
  ...(typeof methods.wxSphSearchActivity === 'function' ? { wxSphSearchActivity: async (params: { query: string }) => { const query = z.object({ query: valueText.min(1).max(120) }).strict().parse(params); return z.array(z.object({ eventTopicId: valueText, eventName: valueText, eventCreatorNickname: valueText.optional(), eventAttendCount: z.number().int().nonnegative().optional() }).strip()).max(100).parse(await call('wxSphSearchActivity', [query])) } } : {}),
 }
 return Object.freeze(facade)
}
export function nativePluginMethod<K extends keyof AIToEarnPluginAPI>(name: K): NonNullable<AIToEarnPluginAPI[K]> {
 assertHostSession(); const plugin = nativePluginApi(), method = plugin?.[name]
 if (!plugin || typeof method !== 'function') throw unavailable()
 return method.bind(plugin) as NonNullable<AIToEarnPluginAPI[K]>
}
