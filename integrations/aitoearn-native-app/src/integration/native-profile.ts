import { isUserProfileAvatarReference } from '@host-publishing/user-profile-avatar'
import { assertHostSession, getHostSessionRevision } from './host-session'
import { nativeBffFetch } from './host-transport'

/** The main-site avatar handler persists the upload; no pub3 asset is created. */
export async function uploadNativeProfileAvatar(file: File): Promise<string> {
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size < 1 || file.size > 5 * 1024 * 1024) throw new Error('头像须为5MB以内的PNG、JPEG或WebP图片')
  const owner = assertHostSession().user.id
  const revision = getHostSessionRevision()
  const form = new FormData()
  form.set('file', file)
  const response = await nativeBffFetch('profile-avatar', { method: 'POST', body: form })
  const result: unknown = await response.json()
  assertHostSession(owner, revision)
  const envelope = result && typeof result === 'object' ? result as Record<string, unknown> : {}
  const data = envelope.data && typeof envelope.data === 'object' ? envelope.data as Record<string, unknown> : {}
  if (!response.ok || envelope.code !== 0 || typeof data.avatarUrl !== 'string' || !isUserProfileAvatarReference(data.avatarUrl)) throw new Error(typeof envelope.message === 'string' && envelope.message ? envelope.message : '头像结果暂不可确认，请刷新个人资料核对后继续')
  return data.avatarUrl
}
