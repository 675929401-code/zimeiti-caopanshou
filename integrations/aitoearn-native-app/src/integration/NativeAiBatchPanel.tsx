'use client'
import { useCallback, useEffect, useRef, useState } from 'react'
import { NativeAiDecimal6Schema, nativeAiCanonical, nativeAiDecimalMicros } from '@host-publishing/native-ai-contract'
import { Button } from '@/components/ui/button'
import { confirm } from '@/utils/ui/confirm'
import { NativeAiActionDetails, NativeAiActionPanel, nativeAiStateLabel } from './NativeAiActionPanel'
import { assertHostSession, getHostSessionRevision, subscribeHostSession } from './host-session'
import { nativeAiClient, subscribeNativeAiPending, type NativeAiActionDto, type NativeAiBatchProjection, type NativeAiBatchSnapshot, type NativeAiPending } from './native-ai-client'

export type NativeAiBatchDraft = Pick<NativeAiBatchSnapshot, 'mode' | 'collectionId' | 'prompt' | 'captionPrompt' | 'quantity' | 'imageCount' | 'generationModelId' | 'options' | 'platforms'> & { modelName: string }
const decimal = (value: bigint) => { const digits = value.toString().padStart(7, '0'); return `${digits.slice(0, -6)}.${digits.slice(-6)}`.replace(/\.?0+$/, '') || '0' }
export function nativeAiQuotedTotals(actions: NativeAiActionDto[], field: 'quotedAmount' | 'maxAmount' = 'quotedAmount') {
  return { credits: decimal(actions.filter(action => action.quote.unit === 'credits').reduce((sum, action) => sum + nativeAiDecimalMicros(action.quote[field]), BigInt(0))), CNY: decimal(actions.filter(action => action.quote.unit === 'CNY').reduce((sum, action) => sum + nativeAiDecimalMicros(action.quote[field]), BigInt(0))) }
}
export function NativeAiBatchStatus({ result }: { result: NativeAiBatchProjection }) {
  const completed = result.items.filter(item => item.workflowComplete).length
  return <div className="space-y-1"><h3 className="font-medium text-foreground">{result.workflowComplete ? '完整草稿已保存' : '内容计划 · 分阶段核对'}</h3><p className="text-xs text-muted-foreground">已保存完整草稿 {completed}/{result.items.length} 份。{result.workflowComplete ? '可回到草稿箱继续编辑和发布。' : result.batch.state === 'succeeded' ? '当前步骤已结束，请准备下一阶段；文案规划完成不会计为整份成稿。' : nativeAiStateLabel[result.batch.state]}</p></div>
}
function BatchReview({ initial, onChange }: { initial: NativeAiBatchProjection, onChange: (result: NativeAiBatchProjection) => void }) {
  const [result, setResult] = useState(initial), [busy, setBusy] = useState(false), [issue, setIssue] = useState(''), [markerVersion, setMarkerVersion] = useState(0)
  useEffect(() => { setResult(initial) }, [initial])
  useEffect(() => subscribeNativeAiPending(() => setMarkerVersion(value => value + 1)), [])
  void markerVersion
  const update = (value: NativeAiBatchProjection) => { setResult(value); onChange(value) }
  const run = async (operation: () => Promise<NativeAiBatchProjection>) => {
    const owner = assertHostSession().user.id, epoch = getHostSessionRevision(); setBusy(true); setIssue('')
    try { const value = await operation(); assertHostSession(owner, epoch); update(value) }
    catch (error) { try { assertHostSession(owner, epoch); setIssue(error instanceof Error ? error.message : '原计划尚未确认') } catch {} }
    finally { try { assertHostSession(owner, epoch); setBusy(false) } catch {} }
  }
  const proposals = result.actions.filter(action => action.state === 'proposed'), totals = nativeAiQuotedTotals(proposals), caps = nativeAiQuotedTotals(proposals, 'maxAmount')
  const unresolved = result.actions.some(action => ['dispatch_claimed', 'awaiting_result', 'unknown'].includes(action.state))
  const waiting = result.actions.some(action => action.state === 'approved')
  let pending: NativeAiPending[] = []
  try { pending = nativeAiClient.pending().filter(marker => marker.batchId === result.batch.id) } catch { /* User recovery displays invalid stored data. */ }
  const approve = async () => {
    if (!await confirm({ title: `确认当前${proposals.length}项操作`, content: <div className="max-h-[55vh] space-y-3 overflow-auto text-left"><p>当前文案预留 {totals.credits} 积分，上限 {caps.credits} 积分；生成现金预留 ¥{totals.CNY}，上限 ¥{caps.CNY}。两类费用分别结算。</p>{proposals.map(action => <div className="rounded-md border border-border p-3" key={action.id}><NativeAiActionDetails action={action} /></div>)}<p>本次只批准以上已列出的操作。下一阶段仍需再次核对并确认。</p></div>, okText: '确认本阶段并继续', cancelText: '返回核对', className: 'max-w-2xl' })) return
    await run(() => nativeAiClient.decideBatch(result, 'approve'))
  }
  return <section className="space-y-3 rounded-xl border border-border bg-card p-4 text-card-foreground" data-native-batch={result.batch.id}>
    <NativeAiBatchStatus result={result} />
    <p className="text-xs text-muted-foreground">本批上限：文案 {result.batch.snapshot.budget.credits} 积分 · 现金 ¥{result.batch.snapshot.budget.CNY}；{result.batch.quantity}份 × {result.batch.mode === 'image_text' ? `${result.batch.snapshot.imageCount}张图片` : `${result.batch.snapshot.options.duration}秒视频`}。</p>
    <div className="flex flex-wrap gap-2">
      {proposals.length > 0 && <><Button size="sm" type="button" disabled={busy || pending.length > 0} onClick={() => { void approve() }}>核对并确认本阶段（{proposals.length}项）</Button><Button size="sm" variant="ghost" type="button" disabled={busy || pending.length > 0} onClick={() => { void run(() => nativeAiClient.decideBatch(result, 'reject')) }}>拒绝本阶段</Button></>}
      {unresolved && <Button type="button" size="sm" variant="outline" disabled={busy || pending.length > 0} onClick={() => { void run(() => nativeAiClient.reconcileBatch(result.batch.id)) }}>核对原生成任务</Button>}
      {!proposals.length && !unresolved && !waiting && !result.workflowComplete && result.actions.some(action => action.state === 'succeeded') && <Button type="button" size="sm" variant="outline" disabled={busy || pending.length > 0} onClick={() => { void run(() => nativeAiClient.advanceBatch(result.batch.id)) }}>准备下一阶段</Button>}
      <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => { void run(() => nativeAiClient.readBatch(result.batch.id)) }}>刷新计划</Button>
    </div>
    {pending.map(marker => <div className="space-y-2 rounded-md bg-muted/40 p-3 text-xs" key={marker.requestKey}><p>上次操作尚未确认，先读取原计划；不会重复执行。</p><Button size="sm" variant="outline" disabled={busy} onClick={() => { void run(async () => { const recovered = await nativeAiClient.recover(marker); if (!recovered || !('batch' in recovered)) throw new Error('原计划仍待核对，尚未发起新的执行'); return recovered }) }}>读取原操作</Button></div>)}
    <details><summary className="cursor-pointer text-xs text-muted-foreground">查看本批所有操作与已交付内容（{result.actions.length}）</summary><div className="mt-3 space-y-3">{result.actions.map(action => <NativeAiActionPanel key={action.id} action={action} onChange={() => { void run(() => nativeAiClient.readBatch(result.batch.id)) }} />)}</div></details>
    {issue && <p role="status" className="text-xs text-destructive">{issue}</p>}
  </section>
}
export function NativeAiBatchPanel({ drafts, onCompleted }: { drafts: NativeAiBatchDraft[], onCompleted?: () => void }) {
  const [models, setModels] = useState<Awaited<ReturnType<typeof nativeAiClient.plannerModels>>>([]), [planner, setPlanner] = useState('')
  const [credits, setCredits] = useState(''), [cash, setCash] = useState(''), [batches, setBatches] = useState<NativeAiBatchProjection[]>([])
  const [loading, setLoading] = useState(false), [issue, setIssue] = useState(''), [markers, setMarkers] = useState<NativeAiPending[]>([]), [validOwner, setValidOwner] = useState(true)
  const completed = useRef(new Set<string>())
  const update = useCallback((value: NativeAiBatchProjection) => {
    setBatches(previous => [value, ...previous.filter(item => item.batch.id !== value.batch.id)])
    if (value.workflowComplete && !completed.current.has(value.batch.id)) { completed.current.add(value.batch.id); onCompleted?.() }
  }, [onCompleted])
  const readPending = useCallback(() => { try { setMarkers(nativeAiClient.pending().filter(marker => marker.kind === 'prepare_batch')) } catch (error) { setIssue(error instanceof Error ? error.message : '原请求恢复标识待核对') } }, [])
  useEffect(() => {
    const owner = assertHostSession().user.id, epoch = getHostSessionRevision(); let active = true
    readPending()
    void Promise.all([nativeAiClient.plannerModels(), nativeAiClient.batches()]).then(async ([catalog, list]) => {
      assertHostSession(owner, epoch); if (!active) return; setModels(catalog)
      const matching = list.items.filter(batch => batch.snapshot.collectionId === drafts[0]?.collectionId)
      for (const batch of matching) { const value = await nativeAiClient.readBatch(batch.id); assertHostSession(owner, epoch); if (active) update(value) }
    }).catch(error => { try { assertHostSession(owner, epoch); if (active) setIssue(error instanceof Error ? error.message : '原AI计划暂不可读取') } catch {} })
    const stopPending = subscribeNativeAiPending(readPending)
    const stopOwner = subscribeHostSession(() => { try { assertHostSession(owner, epoch) } catch { setBatches([]); setModels([]); setMarkers([]); setValidOwner(false) } })
    return () => { active = false; stopPending(); stopOwner() }
  }, [readPending, update, drafts])
  const prepare = async (draft: NativeAiBatchDraft) => {
    const owner = assertHostSession().user.id, epoch = getHostSessionRevision(); setLoading(true); setIssue('')
    try {
      if (!models.some(model => model.nativeModelId === planner && model.generationReady === true)) throw new Error('请明确选择当前可用的文案规划模型')
      const snapshot: NativeAiBatchSnapshot = { version: 'native-ai-batch.v1', mode: draft.mode, collectionId: draft.collectionId, prompt: draft.prompt, captionPrompt: draft.captionPrompt, quantity: draft.quantity, imageCount: draft.imageCount, plannerModelId: planner, generationModelId: draft.generationModelId, options: draft.options, platforms: draft.platforms, budget: { credits: NativeAiDecimal6Schema.parse(credits.trim()), CNY: NativeAiDecimal6Schema.parse(cash.trim()) }, savePolicy: 'confirm_resolved_drafts' }
      const previous = batches.find(batch => !batch.workflowComplete && !['rejected', 'failed_known'].includes(batch.batch.state) && nativeAiCanonical(batch.batch.snapshot) === nativeAiCanonical(snapshot))
      if (previous) { update(await nativeAiClient.readBatch(previous.batch.id)); throw new Error('已有相同参数的原计划，请先核对下方记录') }
      const result = await nativeAiClient.prepareBatch(snapshot); assertHostSession(owner, epoch); update(result)
    } catch (error) { try { assertHostSession(owner, epoch); setIssue(error instanceof Error ? error.message : '计划准备结果待核对，请读取原请求') } catch {} }
    finally { try { assertHostSession(owner, epoch); setLoading(false) } catch {} }
  }
  if (!validOwner) return <p role="status">主站会话已变化，请重新进入后核对原计划。</p>
  return <div className="max-h-[70vh] space-y-4 overflow-auto pr-1 text-left text-sm" data-testid="native-ai-batch-panel">
    <p className="text-muted-foreground">先预览文案计划，再分别确认生成与保存草稿。只有完整草稿实际保存后才计为完成。多模型分别建立计划，每批独立核对上限。</p>
    <div className="space-y-3 rounded-lg border border-border p-3"><label className="block text-xs">文案规划模型<select aria-label="批量文案规划模型" className="mt-1 block w-full rounded-md border border-input bg-background px-2 py-2 text-foreground" value={planner} onChange={event => setPlanner(event.target.value)} disabled={loading}><option value="">请选择文案规划模型</option>{models.map(model => <option key={model.nativeModelId || model.name} value={model.nativeModelId || ''} disabled={!model.nativeModelId || model.generationReady !== true}>{model.displayName || model.name}{model.generationReady !== true ? ' · 暂不可执行' : ''}</option>)}</select></label><div className="grid grid-cols-2 gap-3"><label className="text-xs">每个模型批次的文案积分上限<input aria-label="每批文案积分上限" inputMode="decimal" value={credits} onChange={event => setCredits(event.target.value)} className="mt-1 w-full rounded-md border border-input bg-background px-2 py-2 text-foreground" placeholder="请填写积分上限" disabled={loading} /></label><label className="text-xs">每个模型批次的现金总上限（元）<input aria-label="每批现金总上限" inputMode="decimal" value={cash} onChange={event => setCash(event.target.value)} className="mt-1 w-full rounded-md border border-input bg-background px-2 py-2 text-foreground" placeholder="请填写现金上限" disabled={loading} /></label></div>{drafts.map(draft => <div className="flex items-center justify-between gap-3 rounded-md bg-muted/40 p-3" key={`${draft.generationModelId}:${draft.options.resolution}:${draft.options.duration}`}><div><p className="font-medium text-foreground">{draft.modelName}</p><p className="text-xs text-muted-foreground">{draft.quantity}份 × {draft.mode === 'image_text' ? `${draft.imageCount}张图片` : `${draft.options.duration}秒视频`} · {draft.options.aspectRatio} · {draft.options.resolution}</p></div><Button type="button" size="sm" disabled={loading || !planner || !credits.trim() || !cash.trim()} onClick={() => { void prepare(draft) }}>预览本模型计划</Button></div>)}</div>
    {markers.map(marker => <div className="space-y-2 rounded-md border border-border bg-muted/30 p-3 text-xs" key={marker.requestKey}><p>有一项计划创建请求尚未确认。原记录未查到时仍保留标识，不会重新创建。</p><Button type="button" size="sm" variant="outline" disabled={loading} onClick={async () => { const owner = assertHostSession().user.id, epoch = getHostSessionRevision(); setLoading(true); try { const value = await nativeAiClient.recover(marker); assertHostSession(owner, epoch); if (!value || !('batch' in value)) throw new Error('尚未查到原计划，请稍后继续核对；未发起新请求'); update(value) } catch (error) { try { assertHostSession(owner, epoch); setIssue(error instanceof Error ? error.message : '原计划暂不可确认') } catch {} } finally { try { assertHostSession(owner, epoch); setLoading(false) } catch {} } }}>读取原计划</Button></div>)}
    {issue && <p role="status" className="text-xs text-destructive">{issue}</p>}
    {batches.map(batch => <BatchReview key={batch.batch.id} initial={batch} onChange={update} />)}
  </div>
}
