import type { AccountGroupItem, SocialAccount } from '@/api/accounts/account.types'
export const NATIVE_UNASSIGNED_GROUP = '__native_unassigned__'
export function buildNativeAccountGroups(groups: AccountGroupItem[], accounts: SocialAccount[]) {
  const result = groups.filter(group => !group.nativeSynthetic).map(group => ({ ...group, children: accounts.filter(account => account.groupId === group.id) }))
  const known = new Set(result.map(group => group.id))
  const unassigned = accounts.filter(account => !account.groupId || !known.has(account.groupId))
  if (unassigned.length || result.length === 0) result.push({ id: NATIVE_UNASSIGNED_GROUP, name: '未分组', isDefault: false, nativeSynthetic: 'unassigned', children: unassigned })
  return result.sort((a, b) => a.nativeSynthetic ? 1 : b.nativeSynthetic ? -1 : (a.rank || 0) - (b.rank || 0))
}
