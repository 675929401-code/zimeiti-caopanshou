'use client'

import { AlertCircle, ArrowLeft, ExternalLink, Loader2, RefreshCw } from 'lucide-react'
import { useState } from 'react'
import { useChannelManagerStore } from '@/components/ChannelManager/channelManagerStore'
import { PlatformIcon } from '@/components/common/PlatformIcon'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { usePlatformInfo } from '@/hooks/usePlatformMetadata'
import { assertHostSession, getHostSessionRevision } from './host-session'
import { canRestartNativeOAuth, readNativeOAuthSession, safeNativeAuthorizationUrl, selectNativeOAuth } from './native-oauth'

const labels = { prepared: '授权请求已登记', pending: '等待平台授权', requires_selection: '选择本次授权的账号', completed: '授权完成，核对本站绑定', failed: '平台已返回授权失败', unknown: '授权结果待核对', expired: '原授权已过期' } as const

/** Keep the original authorization-page primitives and layout; server facts drive every action. */
export function NativeOAuthAuthorization() {
  const auth = useChannelManagerStore(state => state.authState)
  const targetSpaceId = useChannelManagerStore(state => state.targetSpaceId)
  const platformInfo = usePlatformInfo(auth.platform)
  const [selected, setSelected] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const session = auth.nativeAuthorization
  const selectable = session?.state === 'requires_selection' && session.continuationReady && session.connectionCurrent
  const restartAllowed = session && canRestartNativeOAuth(session)
  const continuationExpired = session?.state === 'requires_selection' && !session.continuationReady
  const applySession = async (select = false) => {
    const owner = assertHostSession().user.id
    const revision = getHostSessionRevision()
    const epoch = auth.nativeEpoch
    const current = () => { assertHostSession(owner, revision); return useChannelManagerStore.getState().authState.nativeEpoch === epoch }
    setBusy(true)
    setNotice('')
    try {
      if (!session) {
        await useChannelManagerStore.getState().startAuth(auth.platform!, targetSpaceId || undefined)
        return
      }
      const next = select ? await selectNativeOAuth(session, selected) : await readNativeOAuthSession(session.id)
      if (!current()) return
      useChannelManagerStore.setState({ authState: { ...useChannelManagerStore.getState().authState, nativeAuthorization: next, nativeRevision: next.revision, requiresSelection: next.state === 'requires_selection', authUrl: safeNativeAuthorizationUrl(next.authUrl) || null, error: null } })
      if (next.state === 'completed') await useChannelManagerStore.getState().startAuth(auth.platform!, targetSpaceId || undefined)
      else setNotice(select ? '账号选择已提交，正在核对原会话；不会重复提交。' : '已核对原会话。')
    }
    catch (reason) {
      if (revision === getHostSessionRevision() && useChannelManagerStore.getState().authState.nativeEpoch === epoch) setNotice(reason instanceof Error ? reason.message : '原授权结果待核对')
    }
    finally {
      if (revision === getHostSessionRevision() && useChannelManagerStore.getState().authState.nativeEpoch === epoch) setBusy(false)
    }
  }
  return (
    <div data-testid="cm-native-oauth" className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-3 border-b border-border px-4 py-3">
        <Button variant="ghost" size="sm" onClick={() => { useChannelManagerStore.getState().stopAuth(); useChannelManagerStore.getState().setCurrentView('connect-list') }}><ArrowLeft className="mr-1 h-4 w-4" />返回频道列表（原授权保留）</Button>
      </div>
      <div className="mx-auto flex w-full max-w-xl flex-1 flex-col items-center justify-center gap-5 overflow-y-auto p-8">
        {auth.platform && <div className="flex h-24 w-24 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-primary/10 to-primary/5"><PlatformIcon platform={auth.platform} width={56} height={56} className="h-14 w-14 object-contain" /></div>}
        <div className="text-center"><h2 className="text-xl font-semibold text-foreground">{platformInfo?.name} · {session ? labels[session.state] : auth.error ? '原授权请求待核对' : '正在准备官方授权'}</h2><p className="mt-2 text-sm leading-6 text-muted-foreground">连接仅登记官方授权账号；发布、数据统计和互动能力分别准入。</p></div>
        {session?.instructions && <p className="whitespace-pre-wrap text-center text-sm leading-6 text-muted-foreground">{session.instructions[typeof document !== 'undefined' && document.documentElement.lang === 'en-US' ? 'en-US' : 'zh-CN']}</p>}
        {session && <div className="w-full rounded-xl border border-border bg-card p-4 text-sm text-muted-foreground"><p>{session.expiresAt ? `授权有效期至 ${new Date(session.expiresAt).toLocaleString()}` : '授权有效期尚未确认'}</p>{!session.connectionCurrent && <p className="mt-2 text-destructive">服务连接已变化，原会话仅供历史核对。</p>}{continuationExpired && <p className="mt-2 text-destructive">选择账号所需的授权续传已失效，无法继续提交。可核对原会话后明确重新授权。</p>}{session.errorCode === 'AUTH_PROVIDER_UNAVAILABLE' && <p className="mt-2">官方状态暂不可读取，当前显示本站保留记录，不代表失败。</p>}{session.state === 'unknown' && <p className="mt-2">不会自动重建授权或重复提交，请使用下方按钮核对原请求。</p>}</div>}
        {selectable && <fieldset className="w-full space-y-3" disabled={busy}><legend className="mb-2 text-sm font-medium">只绑定本次明确勾选的账号</legend>{session.choices.map(choice => <label key={choice.id} className="flex cursor-pointer items-center gap-3 rounded-xl border border-border bg-card p-4"><Checkbox aria-label={`选择 ${choice.displayName}`} checked={selected.includes(choice.id)} onCheckedChange={checked => setSelected(previous => checked === true ? [...previous, choice.id] : previous.filter(id => id !== choice.id))} /><span className="min-w-0"><strong className="block text-sm text-foreground">{choice.displayName}</strong>{choice.parentDisplayName && <span className="text-xs text-muted-foreground">{choice.parentDisplayName}</span>}</span></label>)}</fieldset>}
        {(auth.error || notice) && <p role="status" className="flex items-start gap-2 text-sm leading-6 text-muted-foreground"><AlertCircle className="mt-1 h-4 w-4 shrink-0" />{notice || auth.error}</p>}
        <div className="flex flex-wrap justify-center gap-3">
          {auth.authUrl && session?.connectionCurrent && (session.state === 'pending' || session.state === 'requires_selection') && <Button variant="outline" onClick={() => useChannelManagerStore.getState().reopenAuthWindow()}><ExternalLink className="mr-2 h-4 w-4" />打开原授权页面</Button>}
          <Button variant="outline" disabled={busy} onClick={() => void applySession()}>{busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}只读核对原请求</Button>
          {selectable && <Button disabled={busy || !selected.length} onClick={() => void applySession(true)}>确认所选账号</Button>}
          {restartAllowed && <Button disabled={busy} onClick={() => void useChannelManagerStore.getState().startAuth(auth.platform!, targetSpaceId || undefined, true)}>明确重新授权</Button>}
        </div>
      </div>
    </div>
  )
}
