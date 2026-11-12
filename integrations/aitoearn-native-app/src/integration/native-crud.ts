import { z } from 'zod'
import { request } from '@/utils/request'
import { assertHostSession, getHostSessionRevision, hostStorageKey } from './host-session'
import { nativeSha256 } from './native-assets'
import { nativeExpectedRevisions } from './native-revisions'
const keyMapSchema = z.record(z.string(), z.string().regex(/^native-crud:[a-f\d-]{36}$/i))
/** Lost responses retain an opaque request key and payload hash, never upload/auth URLs. */
export async function nativeCrud<T = unknown>(method: 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, payload: object) {
  const owner = assertHostSession().user.id; const revision = getHostSessionRevision(); const storage = hostStorageKey('pending-crud-keys'); if (!storage) throw new Error('主站会话已停止')
  const hash = await nativeSha256(new Blob([JSON.stringify({ method, path, payload })], { type: 'text/plain' })); assertHostSession(owner, revision)
  let keys: Record<string, string>
  try { keys = keyMapSchema.parse(JSON.parse(localStorage.getItem(storage) || '{}')) } catch { throw new Error('原数据操作恢复标记格式待核对，请保留浏览器数据') }
  const key = keys[hash] || `native-crud:${crypto.randomUUID()}`; keys[hash] = key; localStorage.setItem(storage, JSON.stringify(keys))
  const result = await request<T>({ method, url: path, data: { ...payload, requestKey: key } }); assertHostSession(owner, revision)
  if (result.code === 0) { const latest = keyMapSchema.parse(JSON.parse(localStorage.getItem(storage) || '{}')); if (latest[hash] === key) { delete latest[hash]; localStorage.setItem(storage, JSON.stringify(latest)) } }
  return result
}
export const nativeBulkItems = (ids: string[]) => ids.map(id => { const value = nativeExpectedRevisions(id); if (value.expectedRevision === undefined) throw new Error('所选条目没有读取时版本，请刷新再操作'); return { id, expectedRevision: value.expectedRevision, expectedMetadataRevision: value.expectedMetadataRevision } })
export const NativeDeletePreviewSchema = z.object({ items: z.array(z.object({ id: z.string().uuid(), expectedRevision: z.number().int().positive(), expectedMetadataRevision: z.number().int().nonnegative(), expectedUsageFingerprint: z.string() }).strict()).max(100), count: z.number().int().nonnegative(), selectionHash: z.string().nullable(), hasMore: z.boolean(), canApply: z.boolean() }).passthrough()
export type NativeDeletePreview = z.infer<typeof NativeDeletePreviewSchema>
