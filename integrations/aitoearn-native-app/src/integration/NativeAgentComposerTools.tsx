'use client'
import { useEffect, useRef, useState } from 'react'
import { CircleAlert, FileText, Loader2, RefreshCw } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useNativeAgentComposer } from './native-agent-composer'
import { recoverNativeAgentPending, readNativeAgentPending, subscribeNativeAgentPending } from './native-agent-client'
import { nativeAgentStatusLabel } from './native-agent-protocol'
import { assertHostSession, getHostSessionRevision, subscribeHostSession } from './host-session'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import http from '@/utils/request'

type Resource = { id: string, label: string }
export function NativeAgentComposerTools({ disabled = false, statusId }: { disabled?: boolean, statusId?: string }) {
  const router = useRouter()
  const { runtime, context, issue, loading, load, setContext } = useNativeAgentComposer()
  const resourceGeneration = useRef(0)
  const [collections, setCollections] = useState<Resource[]>([])
  const [resources, setResources] = useState<Resource[]>([])
  const [collectionPage, setCollectionPage] = useState(1), [moreCollections, setMoreCollections] = useState(false)
  const [page, setPage] = useState(1), [hasMore, setHasMore] = useState(false), [reading, setReading] = useState(false)
  const [resourceIssue, setResourceIssue] = useState('')
  const [pending, setPending] = useState(false), [recovery, setRecovery] = useState('')
  useEffect(() => {
    void load()
    const update = () => { try { setPending(!!readNativeAgentPending()) } catch { setPending(true) } }
    update()
    return subscribeNativeAgentPending(update)
  }, [load])
  useEffect(() => subscribeHostSession(() => {
    resourceGeneration.current++
    setCollections([]); setResources([]); setReading(false); setResourceIssue(''); setRecovery('')
  }), [])
  const readCollections = async (nextPage = 1) => {
    const actor = assertHostSession().user.id, revision = getHostSessionRevision(), epoch = ++resourceGeneration.current
    setReading(true); setResourceIssue('')
    try {
      const response = await http.get<{ list: { id: string, name: string }[], total: number }>('material/group/list/' + nextPage + '/30')
      assertHostSession(actor, revision); if (epoch !== resourceGeneration.current) return
      const items = response.data.list.map(item => ({ id: item.id, label: item.name }))
      setCollections(previous => nextPage === 1 ? items : [...previous, ...items])
      setCollectionPage(nextPage); setMoreCollections(nextPage * 30 < response.data.total)
    } catch (error) { try { assertHostSession(actor, revision); if (epoch === resourceGeneration.current) setResourceIssue(error instanceof Error ? error.message : '草稿箱尚未读取') } catch {} }
    finally { try { assertHostSession(actor, revision); if (epoch === resourceGeneration.current) setReading(false) } catch {} }
  }
  const readDrafts = async (collectionId: string, nextPage = 1) => {
    const actor = assertHostSession().user.id, revision = getHostSessionRevision(), epoch = ++resourceGeneration.current
    setReading(true); setResourceIssue('')
    try {
      if (!collectionId) { setResources([]); setHasMore(false); return }
      const response = await http.get<{ list: { id: string, title: string }[], total: number }>('material/list/' + nextPage + '/30', { groupId: collectionId })
      assertHostSession(actor, revision); if (epoch !== resourceGeneration.current) return
      const items = response.data.list.map(item => ({ id: item.id, label: item.title || '未命名草稿' }))
      setResources(previous => nextPage === 1 ? items : [...previous, ...items])
      setPage(nextPage); setHasMore(nextPage * 30 < response.data.total)
    } catch (error) { try { assertHostSession(actor, revision); if (epoch === resourceGeneration.current) setResourceIssue(error instanceof Error ? error.message : '草稿尚未读取') } catch {} }
    finally { try { assertHostSession(actor, revision); if (epoch === resourceGeneration.current) setReading(false) } catch {} }
  }
  const chooseCollection = (id: string) => {
    setContext({ ...context, collectionIds: id ? [id] : [], draftIds: [] })
    setResources([]); setPage(1); setHasMore(false); void readDrafts(id)
  }
  const chooseDraft = (id: string) => {
    // The first draft slice uses a single source, with no technical association setup.
    setContext({ ...context, draftIds: context.draftIds.includes(id) ? [] : [id] })
  }
  return <div className="native-agent-composer__status space-y-3 text-sm text-muted-foreground" data-testid="native-agent-composer-tools">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex min-w-0 flex-1 items-start gap-2.5" role="status" aria-live="polite" aria-busy={loading} id={statusId}>
        {loading ? <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin" /> : runtime?.ready ? <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-emerald-500" /> : <CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />}
        <span className="min-w-0 leading-6">{loading ? '正在检查创作服务…' : issue || (runtime?.ready ? '创作助手已就绪' : runtime?.message) || '创作服务暂未就绪，请稍后重试'}</span>
      </div>
      <div className="flex shrink-0 items-center gap-2">
      {runtime?.capabilities.readDraft && <Popover><PopoverTrigger asChild><Button type="button" size="sm" variant="outline" className="h-9 gap-2 rounded-lg px-3 text-sm" disabled={disabled || !runtime.ready} onClick={() => { void readCollections() }}><FileText className="h-4 w-4" />{context.draftIds.length ? '已选择草稿' : '选择草稿'}</Button></PopoverTrigger>
        <PopoverContent className="w-[420px] space-y-3 p-3" align="start">
          <p className="text-sm font-medium text-foreground">选择一篇已有草稿</p>
          <p>也可以直接输入创作需求，无需先选择草稿。</p>
          <label className="flex items-center gap-2">草稿箱<select aria-label="选择草稿箱" className="min-w-0 flex-1 rounded-md border border-input bg-background px-2 py-1.5 text-foreground" value={context.collectionIds[0] || ''} disabled={reading} onChange={event => chooseCollection(event.target.value)}><option value="">请选择草稿箱</option>{collections.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
          {moreCollections && <Button type="button" variant="ghost" size="sm" disabled={reading} onClick={() => { void readCollections(collectionPage + 1) }}>加载更多草稿箱</Button>}
          <div className="max-h-64 space-y-2 overflow-auto">{resources.length ? resources.map(item => <label className="flex cursor-pointer items-center gap-2 text-sm" key={item.id}><Checkbox checked={context.draftIds.includes(item.id)} disabled={disabled || reading} onCheckedChange={() => chooseDraft(item.id)} /><span className="min-w-0 truncate">{item.label}</span></label>) : <p>{reading ? '正在读取草稿…' : context.collectionIds.length ? '当前草稿箱没有可选草稿' : '请先选择草稿箱'}</p>}</div>
          {hasMore && <Button type="button" variant="ghost" size="sm" disabled={reading} onClick={() => { void readDrafts(context.collectionIds[0] || '', page + 1) }}>加载更多草稿</Button>}
          {context.draftIds.length > 0 && <Button type="button" variant="ghost" size="sm" disabled={disabled} onClick={() => setContext({ ...context, draftIds: [], collectionIds: [] })}>取消选择</Button>}
          {resourceIssue && <p role="status">{resourceIssue}</p>}
        </PopoverContent>
      </Popover>}
      <Button size="icon" type="button" variant="ghost" className="h-9 w-9 rounded-lg" aria-label="重新检查创作服务" title="重新检查创作服务" disabled={disabled || loading} onClick={() => { void load() }}><RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} /></Button>
      </div>
    </div>
    {runtime?.ready ? <details className="rounded-lg bg-muted/40 px-3 py-2 text-[13px] leading-6"><summary className="cursor-pointer select-none font-medium text-foreground">每轮上限 {runtime.budget.maxCreditsPerTurn} 积分 · 费用与能力说明</summary><div className="mt-2 space-y-1"><p>发送前确认本轮费用上限，完成后按实际用量结算。</p><p>{runtime.capabilities.readDraft && runtime.capabilities.saveDraft ? '支持读取已有草稿、改写文字并保存新草稿。' : runtime.capabilities.saveDraft ? '支持按需求创作文字并保存新草稿。' : '请按助手当前可用能力提交需求。'}{!runtime.capabilities.media && ' 图片和视频处理暂未开放。'}{!runtime.capabilities.publish && ' 自动发布暂未开放，可前往发布编辑器处理。'}</p></div></details> : !loading && <p className="text-[13px] leading-6">您可以先整理创作需求，服务就绪后再发送。已有任务可在下方查看。</p>}
    {pending && <div className="flex flex-wrap items-center gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 p-2"><span>上一项任务还需确认结果，请先查看原任务。系统不会自动重新提交。</span><Button type="button" size="sm" variant="outline" onClick={async () => { try { const result = await recoverNativeAgentPending(); setRecovery(result?.task ? nativeAgentStatusLabel(result.task.nativeStatus) : '暂未查到原任务，请保留当前记录，稍后再查看'); if (result?.task) router.push('/' + document.documentElement.lang + '/chat/' + result.task.id) } catch (error) { setRecovery(error instanceof Error ? error.message : '原任务暂时无法查看') } }}>查看原任务</Button></div>}
    {recovery && <p role="status">{recovery}</p>}
  </div>
}
