'use client'
import { useCallback, useEffect, useRef, useState } from 'react'
import { NativeAiActionDtoSchema } from '@host-publishing/native-ai-contract'
import { NativeOwnedMediaRefSchema, nativeMainMediaPath } from '@host-publishing/native-main-media-contract'
import { Button } from '@/components/ui/button'
import { confirm } from '@/utils/ui/confirm'
import { assertHostSession, getHostSessionRevision, subscribeHostSession } from './host-session'
import { nativeAiClient, subscribeNativeAiPending, type NativeAiActionDto } from './native-ai-client'
import { NativeAiPublishHandoff } from './NativeAiPublishHandoff'

export const nativeAiStateLabel: Record<NativeAiActionDto['state'], string> = {
  proposed: '等待您确认', approved: '已批准，等待执行', rejected: '已拒绝', dispatch_claimed: '已受理，正在核对',
  awaiting_result: '正在等待原任务结果', succeeded: '本项已完成', failed_known: '原任务已确认失败', unknown: '结果待核对',
}
const titles: Record<NativeAiActionDto['kind'], string> = { plan_text: '文案规划', generate_image: '生成图片', generate_video: '生成视频', save_draft: '保存完整草稿', propose_publish: '准备发布确认' }
export function nativeAiUnitLabel(unit: string) { return unit === 'CNY' ? '元现金' : unit === 'credits' ? '积分' : unit === 'publish_count' ? '次发布额度' : '本地内容操作' }
export function NativeAiActionDetails({ action }: { action: NativeAiActionDto }) {
  const args = action.args
  const prompt = action.kind === 'plan_text' ? '' : typeof args.prompt === 'string' ? args.prompt : typeof args.body === 'string' ? args.body : ''
  return <div className="space-y-2 text-sm">
    <div className="flex flex-wrap items-center justify-between gap-2"><strong className="text-foreground">{titles[action.kind]}{action.kind === 'generate_image' ? ` · ${String(args.count)}张` : action.kind === 'generate_video' ? ` · ${String(args.duration)}秒` : ''}</strong><span className="text-xs text-muted-foreground">{nativeAiStateLabel[action.state]}</span></div>
    {typeof args.title === 'string' && <p className="font-medium text-foreground">{args.title}</p>}
    {(typeof args.aspectRatio === 'string' || typeof args.resolution === 'string') && <p className="text-xs text-muted-foreground">{[args.aspectRatio, args.resolution].filter(value => typeof value === 'string').join(' · ')}</p>}
    {prompt && <details><summary className="cursor-pointer text-xs text-muted-foreground">核对本项内容</summary><p className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words text-foreground">{prompt}</p></details>}
    <div className="rounded-md bg-muted/50 px-3 py-2 text-xs text-foreground">本项预留报价：{action.quote.quotedAmount} {nativeAiUnitLabel(action.quote.unit)}；确认上限：{action.quote.maxAmount} {nativeAiUnitLabel(action.quote.unit)}。{action.quote.unit === 'metadata_write' ? '不收取模型生成费。' : '实际费用以主站原任务结算为准。'}</div>
    {action.state === 'proposed' && <p className="text-xs text-muted-foreground">报价有效至 {new Date(action.quote.expiresAt).toLocaleString('zh-CN')}。确认后按当前内容执行。</p>}
    {action.kind === 'propose_publish' && <p className="text-xs text-muted-foreground">此项只整理待发布内容。真实发布仍需您在发布窗口核对账号、素材和额度后确认。</p>}
  </div>
}
export function NativeAiActionPanel({ action: input, onChange }: { action: NativeAiActionDto, onChange?: (action: NativeAiActionDto) => void }) {
  const [action, setAction] = useState(input), [busy, setBusy] = useState(false), [issue, setIssue] = useState(''), [version, setVersion] = useState(0), [validOwner, setValidOwner] = useState(true)
  useEffect(() => { setAction(input) }, [input])
  useEffect(() => {
    const owner = assertHostSession().user.id, epoch = getHostSessionRevision()
    return subscribeHostSession(() => { try { assertHostSession(owner, epoch) } catch { setValidOwner(false); setIssue('主站会话已变化，请重新进入后核对') } })
  }, [])
  useEffect(() => subscribeNativeAiPending(() => setVersion(value => value + 1)), [])
  void version
  let pending: ReturnType<typeof nativeAiClient.pending> = []
  try { pending = nativeAiClient.pending().filter(item => item.actionId === action.id) } catch { /* The next user operation reports invalid recovery data. */ }
  const update = (value: NativeAiActionDto) => { setAction(value); onChange?.(value) }
  const run = async (operation: () => Promise<NativeAiActionDto>) => {
    const owner = assertHostSession().user.id, epoch = getHostSessionRevision(); setBusy(true); setIssue('')
    try { const value = await operation(); assertHostSession(owner, epoch); update(value) }
    catch (error) { try { assertHostSession(owner, epoch); setIssue(error instanceof Error ? error.message : '原操作结果待核对') } catch {} }
    finally { try { assertHostSession(owner, epoch); setBusy(false) } catch {} }
  }
  const approve = async () => {
    if (!await confirm({ title: `确认${titles[action.kind]}`, content: `本项预留报价 ${action.quote.quotedAmount} ${nativeAiUnitLabel(action.quote.unit)}，您确认的上限为 ${action.quote.maxAmount} ${nativeAiUnitLabel(action.quote.unit)}。将执行卡片中已核对的内容。`, okText: '确认本项', cancelText: '继续检查' })) return
    await run(() => nativeAiClient.decideAction(action, 'approve'))
  }
  const refs = action.slots.flatMap(slot => slot.receipt?.resultRefs ?? [])
  if (!validOwner) return <p role="status" className="p-3 text-sm text-muted-foreground">{issue}</p>
  return <section className="space-y-3 rounded-lg border border-border bg-card p-4 text-card-foreground" data-native-action={action.id}>
    <NativeAiActionDetails action={action} />
    <div className="flex flex-wrap gap-2">
      {action.state === 'proposed' && <><Button type="button" size="sm" disabled={busy || pending.length > 0} onClick={() => { void approve() }}>确认本项并继续</Button><Button type="button" size="sm" variant="ghost" disabled={busy || pending.length > 0} onClick={() => { void run(() => nativeAiClient.decideAction(action, 'reject')) }}>拒绝本项</Button></>}
      {action.slots.some(slot => slot.state === 'approved' && slot.dispatchId === null) && <Button type="button" size="sm" variant="outline" disabled={busy || pending.length > 0} onClick={() => { void run(() => nativeAiClient.dispatchAction(action)) }}>执行已批准的动作</Button>}
      {action.slots.some(slot => ['dispatch_claimed', 'awaiting_result', 'unknown'].includes(slot.state)) && <Button type="button" size="sm" variant="outline" disabled={busy || pending.length > 0} onClick={() => { void run(() => nativeAiClient.reconcileAction(action)) }}>核对原任务结果</Button>}
      <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => { void run(() => nativeAiClient.readAction(action.id)) }}>刷新记录</Button>
      {refs.map(ref => { const parsed = NativeOwnedMediaRefSchema.safeParse(ref); return parsed.success ? <a key={`${ref.kind}:${ref.id}`} className="inline-flex items-center text-xs underline underline-offset-4" href={nativeMainMediaPath(parsed.data)} target="_blank" rel="noopener noreferrer">查看已交付{ref.kind === 'video_task' ? '视频' : '图片'}</a> : null })}
    </div>
    {action.state === 'succeeded' && action.kind === 'propose_publish' && <NativeAiPublishHandoff action={action} />}
    {pending.length > 0 && <div className="space-y-2 rounded-md border border-border bg-muted/30 p-3 text-xs"><p>上次请求尚未确认。请读取原记录，当前不会重复提交。</p>{pending.map(marker => <Button type="button" key={marker.requestKey} size="sm" variant="outline" disabled={busy} onClick={() => { void run(async () => { const recovered = await nativeAiClient.recover(marker); if (!recovered || !('kind' in recovered)) throw new Error('原操作仍待核对，请稍后再读取；没有发起新的执行'); return NativeAiActionDtoSchema.parse(recovered) }) }}>读取原操作</Button>)}</div>}
    {issue && <p role="status" className="text-xs text-destructive">{issue}</p>}
  </section>
}
export function NativeAiTaskActions({ taskId }: { taskId: string }) {
  const [actions, setActions] = useState<NativeAiActionDto[]>([]), [issue, setIssue] = useState(''), [page, setPage] = useState(1), [total, setTotal] = useState(0)
  const generation = useRef(0)
  const load = useCallback(async (next = 1) => {
    const owner = assertHostSession().user.id, epoch = getHostSessionRevision(), current = generation.current
    try { const result = await nativeAiClient.taskActions(taskId, next); assertHostSession(owner, epoch); if (current !== generation.current) return; setActions(previous => next === 1 ? result.items : [...previous.filter(item => !result.items.some(fresh => fresh.id === item.id)), ...result.items]); setPage(next); setTotal(result.total); setIssue('') }
    catch (error) { try { assertHostSession(owner, epoch); if (current === generation.current) setIssue(error instanceof Error ? error.message : '建议操作暂不可读取') } catch {} }
  }, [taskId])
  useEffect(() => {
    const owner = assertHostSession().user.id, epoch = getHostSessionRevision(); ++generation.current
    setActions([]); setIssue(''); void load()
    const timer = setInterval(() => { try { assertHostSession(owner, epoch); void load() } catch {} }, 5000)
    const stop = subscribeHostSession(() => { try { assertHostSession(owner, epoch) } catch { ++generation.current; setActions([]); setIssue('主站会话已变化，请重新进入后核对') } })
    return () => { clearInterval(timer); stop(); ++generation.current }
  }, [load])
  if (!actions.length) return issue ? <p role="status" className="px-4 py-2 text-xs text-muted-foreground">{issue}</p> : null
  return <div className="max-h-[42vh] space-y-3 overflow-auto border-b border-border px-4 py-3" data-testid="native-ai-task-actions"><p className="text-xs text-muted-foreground">以下为本站已保存的建议操作；每项都需您明确确认。</p>{actions.map(action => <NativeAiActionPanel key={action.id} action={action} onChange={fresh => setActions(previous => previous.map(item => item.id === fresh.id ? fresh : item))} />)}{actions.length < total && <Button type="button" size="sm" variant="ghost" onClick={() => { void load(page + 1) }}>读取更多操作</Button>}{issue && <p role="status" className="text-xs text-muted-foreground">{issue}</p>}</div>
}
