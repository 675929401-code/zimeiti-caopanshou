'use client'

import type { SocialAccount } from '@/api/accounts/account.types'
import { Info, Loader2, RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { getAccountDetailApi } from '@/api/accounts/account.api'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { useAccountStore } from '@/store/account'
import { assertHostSession, getHostSessionRevision } from './host-session'
import { mutateNativeOAuthBinding, readNativeOAuthSession, recoverNativeOAuthBinding } from './native-oauth'

export function NativeOAuthAccountDetails({ account }: { account: SocialAccount }) {
  const groups = useAccountStore(state => state.accountGroupList)
  const [open, setOpen] = useState(false)
  const [loaded, setLoaded] = useState(account)
  const [groupId, setGroupId] = useState(account.groupId || '')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [authorization, setAuthorization] = useState('')
  const refresh = useCallback(async () => {
    const owner = assertHostSession().user.id
    const revision = getHostSessionRevision()
    setBusy(true)
    try {
      await recoverNativeOAuthBinding(account.id)
      const result = await getAccountDetailApi(account.id)
      assertHostSession(owner, revision)
      if (result.data.id !== account.id || result.data.nativeAccountKind !== 'generic') throw new Error('官方绑定详情不匹配')
      setLoaded(result.data)
      setGroupId(result.data.groupId || '')
      if (result.data.nativeAuthSessionId) {
        const session = await readNativeOAuthSession(result.data.nativeAuthSessionId)
        assertHostSession(owner, revision)
        setAuthorization(session.state === 'completed' ? '原授权已完成；不代表发布通道已开放' : `原授权状态：${session.state}`)
      }
    }
    catch (reason) { if (revision === getHostSessionRevision()) setNotice(reason instanceof Error ? reason.message : '官方绑定详情待核对') }
    finally { if (revision === getHostSessionRevision()) setBusy(false) }
  }, [account.id])
  useEffect(() => { if (open) void refresh() }, [open, refresh])
  return <Dialog open={open} onOpenChange={setOpen}><DialogTrigger asChild><Button variant="outline" size="sm" className="h-9 shrink-0 rounded-lg" aria-label={`查看 ${account.nickname} 的官方绑定详情`}><Info className="mr-1 h-4 w-4" />详情与分组</Button></DialogTrigger><DialogContent className="max-w-xl"><DialogHeader><DialogTitle>官方绑定详情</DialogTitle><DialogDescription>本站保存的官方授权绑定；发布、统计和互动能力分别准入。</DialogDescription></DialogHeader><div className="space-y-4 text-sm"><dl className="grid grid-cols-[7rem_minmax(0,1fr)] gap-3"><dt className="text-muted-foreground">账号名称</dt><dd className="break-all">{loaded.nickname}</dd><dt className="text-muted-foreground">平台账号</dt><dd className="break-all">{loaded.uid}</dd><dt className="text-muted-foreground">连接状态</dt><dd>{loaded.nativeBindingStatus === 'disconnected' ? '已从本工作台断开' : loaded.nativeBindingStatus === 'unknown' ? '结果待核对' : '官方已绑定'}</dd><dt className="text-muted-foreground">发布能力</dt><dd>当前绑定尚未开放发布</dd></dl>{authorization && <p className="rounded-lg border border-border bg-muted/30 p-3 text-muted-foreground">{authorization}</p>}<label className="block space-y-2"><span className="font-medium">所属分组</span><select aria-label="官方绑定所属分组" value={groupId} disabled={busy || loaded.nativeDisconnected || loaded.nativeConnectionCurrent !== true} onChange={event => setGroupId(event.target.value)} className="h-10 w-full rounded-md border border-input bg-background px-3 text-foreground"><option value="">未分组</option>{groups.filter(group => !group.nativeSynthetic).map(group => <option key={group.id} value={group.id}>{group.name}</option>)}</select></label>{notice && <p role="status" className="text-muted-foreground">{notice}</p>}<div className="flex justify-end gap-3"><Button variant="outline" disabled={busy} onClick={() => void refresh()}><RefreshCw className="mr-2 h-4 w-4" />只读核对</Button><Button disabled={busy || groupId === (loaded.groupId || '') || !loaded.nativeBindingRevision || loaded.nativeDisconnected || loaded.nativeConnectionCurrent !== true} onClick={async () => {
    const owner = assertHostSession().user.id; const revision = getHostSessionRevision()
    const target = groupId ? groups.find(group => group.id === groupId && !group.nativeSynthetic) : undefined
    if (groupId && !target?.nativeRevision) { setNotice('目标分组版本尚未加载，请刷新分组后再移动'); return }
    setBusy(true); setNotice('')
    try {
      await mutateNativeOAuthBinding({ action: 'move-binding', bindingId: loaded.id, expectedRevision: loaded.nativeBindingRevision!, groupId: target?.id || null, ...(target ? { expectedGroupRevision: target.nativeRevision! } : {}), requestKey: `native-oauth-move:${crypto.randomUUID()}` })
      assertHostSession(owner, revision)
      await useAccountStore.getState().getAccountList()
      assertHostSession(owner, revision)
      await refresh()
      assertHostSession(owner, revision)
      setNotice('已核对账号分组；原授权及发布能力保持独立。')
    }
    catch (reason) { if (revision === getHostSessionRevision()) setNotice(reason instanceof Error ? reason.message : '原分组操作待核对，请勿重复提交') }
    finally { if (revision === getHostSessionRevision()) setBusy(false) }
  }}>{busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}保存分组</Button></div></div></DialogContent></Dialog>
}
