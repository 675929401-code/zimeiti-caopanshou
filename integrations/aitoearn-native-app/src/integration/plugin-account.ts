import type { PlatAccountInfo } from '@/store/plugin/types/plat.type'
import type { PluginPlatformType } from '@/store/plugin/types/baseTypes'
/** Keep account identity and login-status booleans only; raw cookie/password fields never enter stores. */
export function projectPluginAccount(platform: PluginPlatformType, value: unknown): PlatAccountInfo | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  if (typeof raw.uid !== 'string' || !raw.uid || raw.uid.length > 160) return null
  const clean = (value: unknown, maximum: number) => typeof value === 'string' ? value.slice(0, maximum) : ''
  const avatar = typeof raw.avatar === 'string' && /^https:\/\//.test(raw.avatar) && raw.avatar.length <= 2048 ? raw.avatar : ''
  const result: PlatAccountInfo = { type: platform, uid: raw.uid, account: clean(raw.account, 160), nickname: clean(raw.nickname, 200) || raw.uid, avatar }
  if (raw.xhsLoginStatus && typeof raw.xhsLoginStatus === 'object') { const status = raw.xhsLoginStatus as Record<string, unknown>; if (typeof status.home === 'boolean' && typeof status.creator === 'boolean') result.xhsLoginStatus = { home: status.home, creator: status.creator } }
  if (raw.wxSphLoginStatus && typeof raw.wxSphLoginStatus === 'object') { const status = raw.wxSphLoginStatus as Record<string, unknown>; if (typeof status.channels === 'boolean') result.wxSphLoginStatus = { channels: status.channels } }
  if (typeof raw.fansCount === 'number' && Number.isFinite(raw.fansCount) && raw.fansCount >= 0) result.fansCount = raw.fansCount
  return result
}
