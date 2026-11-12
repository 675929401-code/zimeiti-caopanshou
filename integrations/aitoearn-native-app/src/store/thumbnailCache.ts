/** Owner-memory previews: blob URLs are never persisted or shared across members. */
import { create } from 'zustand'
import { getVideoThumbnail } from '@/api/materials/material.api'
import { assertHostSession, getHostSessionRevision, subscribeHostSession } from '@/integration/host-session'

export interface IThumbnailCacheState { cache: Record<string, string> }
type Task = { run: () => void, cancel: () => void }
let generation = 0
let activeCount = 0
const pending = new Map<string, Promise<string>>()
const queue: Task[] = []
function runNext() {
  while (activeCount < 3 && queue.length) { const next = queue.shift()!; activeCount++; next.run() }
}
export const useThumbnailCache = create<IThumbnailCacheState & { fetchThumbnail: (url: string) => Promise<string> }>((set, get) => ({
  cache: {},
  fetchThumbnail(videoUrl) {
    const owner = assertHostSession().user.id; const revision = getHostSessionRevision(); const epoch = generation
    if (get().cache[videoUrl]) return Promise.resolve(get().cache[videoUrl])
    const existing = pending.get(videoUrl); if (existing) return existing
    let finish!: (url: string) => void
    const promise = new Promise<string>(resolve => { finish = resolve })
    pending.set(videoUrl, promise)
    queue.push({ cancel: () => finish(''), run: async () => {
      let thumbnail = ''
      try {
        const result = await getVideoThumbnail(videoUrl); thumbnail = result.data.thumbnailUrl || ''
        assertHostSession(owner, revision)
        if (epoch !== generation) throw new Error('会话已变化')
        if (thumbnail) set(state => ({ cache: { ...state.cache, [videoUrl]: thumbnail } }))
        finish(thumbnail)
      } catch { if (thumbnail.startsWith('blob:')) URL.revokeObjectURL(thumbnail); finish('') }
      finally {
        if (epoch === generation) { activeCount--; if (pending.get(videoUrl) === promise) pending.delete(videoUrl); runNext() }
      }
    } })
    runNext(); return promise
  },
}))
let lastSessionRevision = getHostSessionRevision()
subscribeHostSession(() => {
  const nextRevision = getHostSessionRevision(); if (nextRevision === lastSessionRevision) return; lastSessionRevision = nextRevision
  generation++; activeCount = 0
  queue.splice(0).forEach(task => task.cancel()); pending.clear()
  for (const value of Object.values(useThumbnailCache.getState().cache)) if (value.startsWith('blob:')) URL.revokeObjectURL(value)
  useThumbnailCache.setState({ cache: {} })
})
