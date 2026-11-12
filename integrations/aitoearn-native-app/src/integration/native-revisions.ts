import { getHostSession, subscribeHostSession } from './host-session'
const revisions = new Map<string, { expectedRevision?: number, expectedMetadataRevision: number }>()
let owner = ''
subscribeHostSession(() => { const next = getHostSession()?.user.id || ''; if (next !== owner) { owner = next; revisions.clear() } })
/** Only CAS metadata is retained; original payload and credentials are never cached here. */
export function observeNativeRevisions(value: unknown) {
  if (Array.isArray(value)) { value.forEach(observeNativeRevisions); return }
  if (!value || typeof value !== 'object') return
  const item = value as Record<string, unknown>
  const id = typeof item.id === 'string' ? item.id : item._id
  if (typeof id === 'string' && (typeof item.nativeMetadataRevision === 'number' && Number.isSafeInteger(item.nativeMetadataRevision) && item.nativeMetadataRevision >= 0 || typeof item.nativeRevision === 'number' && Number.isSafeInteger(item.nativeRevision) && item.nativeRevision > 0)) revisions.set(id, { expectedMetadataRevision: typeof item.nativeMetadataRevision === 'number' ? item.nativeMetadataRevision : 0, ...(typeof item.nativeRevision === 'number' && Number.isSafeInteger(item.nativeRevision) && item.nativeRevision > 0 ? { expectedRevision: item.nativeRevision } : {}) })
  for (const field of ['list', 'items', 'records']) if (Array.isArray(item[field])) observeNativeRevisions(item[field])
}
export function nativeExpectedRevisions(id: string, loaded?: { nativeRevision?: number, nativeMetadataRevision?: number }) {
  if (loaded) {
    if (!Number.isSafeInteger(loaded.nativeMetadataRevision) || loaded.nativeMetadataRevision! < 0) throw new Error('编辑时的元数据版本缺失，请关闭并刷新原记录')
    return { expectedMetadataRevision: loaded.nativeMetadataRevision!, ...(Number.isSafeInteger(loaded.nativeRevision) && loaded.nativeRevision! > 0 ? { expectedRevision: loaded.nativeRevision! } : {}) }
  }
  const value = revisions.get(id); if (!value) throw new Error('原版本信息尚未加载，请刷新原记录后再修改'); return { ...value }
}
