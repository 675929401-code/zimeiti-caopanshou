import { mutateNativeOAuthBinding } from '@/integration/native-oauth'
import { nativeCrud } from '@/integration/native-crud'
import { NATIVE_UNASSIGNED_GROUP } from '@/integration/account-groups'
import { nativeExpectedRevisions } from '@/integration/native-revisions'
import type { AccountGroupItem, AccountListData, CreateChannelAccountParams, SocialAccount, SortRankRequest } from './account.types'
import http from '@/utils/request'

// Source: account.ts

/**
 * 创建账号
 * 仅支持插件授权平台创建账号
 */
export function createChannelAccountApi(data: CreateChannelAccountParams) {
  return http.post<SocialAccount>('v2/channels/accounts', data)
}

/**
 * 账号列表
 */
export function getAccountListApi(silent = false) {
  return http.get<AccountListData>('v2/channels/accounts', undefined, silent)
}

/**
 * 账号详情
 */
export function getAccountDetailApi(id: string) {
  return http.get<SocialAccount>(`v2/channels/accounts/${id}`)
}

/**
 * 账号数据
 */
export function refreshAccountFansApi(id: string) {
  return http.get(`v2/channels/accounts/${encodeURIComponent(id)}/analytics`)
}

/**
 * 删除账号
 */
export async function deleteAccountApi(id: string, loaded: SocialAccount) {
  if (loaded.id !== id || !loaded.nativeAccountKind) throw new Error('请重新读取此账号的连接类型和版本')
  if (loaded.nativeAccountKind === 'generic') {
    if (!loaded.nativeBindingRevision || loaded.nativeConnectionCurrent !== true) throw new Error('请重新读取此账号的官方绑定版本')
    await mutateNativeOAuthBinding({ action: 'disconnect', bindingId: id, expectedRevision: loaded.nativeBindingRevision, requestKey: `native-oauth-disconnect:${crypto.randomUUID()}` })
    return { code: 0 as const, data: true, message: '', url: '' }
  }
  const expected = nativeExpectedRevisions(id, loaded)
  return nativeCrud<boolean>('DELETE', `v2/channels/accounts/${id}`, { accountKind: loaded.nativeAccountKind, expectedMetadataRevision: expected.expectedMetadataRevision, ...(loaded.nativeAccountKind === 'official' ? { expectedBindingRevision: loaded.nativeRevision } : {}) })
}

/**
 * 创建账号分组
 */
export function createAccountGroupApi(data: Partial<AccountGroupItem>) {
  return nativeCrud<AccountGroupItem>('POST', 'v2/channels/account-groups', data)
}

/**
 * 更新账号分组
 */
export function updateAccountGroupApi(data: Partial<AccountGroupItem> & { expectedRevision?: number, expectedMetadataRevision?: number }) {
  const { id, expectedRevision, expectedMetadataRevision, ...payload } = data
  return nativeCrud<AccountGroupItem>('PATCH', `v2/channels/account-groups/${id}`, { ...payload, ...(expectedMetadataRevision !== undefined ? { expectedMetadataRevision, ...(expectedRevision !== undefined ? { expectedRevision } : {}) } : nativeExpectedRevisions(id!)) })
}

/**
 * 删除账号分组
 */
export function deleteAccountGroupApi(ids: string[], loaded: AccountGroupItem[]) {
  const items = ids.map(id => { const row = loaded.find(item => item.id === id); if (!row || row.nativeSynthetic) throw new Error('请重新读取真实分组版本'); return { id, ...nativeExpectedRevisions(id, row) } })
  return nativeCrud<boolean>('DELETE', 'v2/channels/account-groups', { items })
}

/**
 * 账号分组列表
 */
export function getAccountGroupApi() {
  return http.get<AccountGroupItem[]>('v2/channels/account-groups')
}

/**
 * 更新分组排序
 * @param data 排序数据
 * @returns 排序更新结果
 */
export async function apiUpdateAccountGroupSortRank(data: SortRankRequest) {
  const items = data.list.filter(item => item.id !== NATIVE_UNASSIGNED_GROUP).map(item => ({
    id: item.id, rank: item.rank, expectedRevision: nativeExpectedRevisions(item.id).expectedMetadataRevision,
  }))
  if (!items.length) return { code: 0, data: true, message: '', url: '' }
  return nativeCrud('POST', 'metadata', { action: 'reorder-groups', items })
}
