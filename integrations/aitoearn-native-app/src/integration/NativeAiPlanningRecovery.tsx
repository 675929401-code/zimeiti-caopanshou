'use client'
import { useEffect, useState } from 'react'
import type { NativeAgentPlanningTurn } from '@/api/ai/ai.types'
import { Button } from '@/components/ui/button'
import { assertHostSession, getHostSessionRevision } from './host-session'
import { nativeAiClient, subscribeNativeAiPending, type NativeAiPending } from './native-ai-client'

export function NativeAiPlanningRecovery({ taskId, turns, onChange }: { taskId: string, turns: NativeAgentPlanningTurn[], onChange: () => Promise<unknown> }) {
  const [busy, setBusy] = useState(false), [issue, setIssue] = useState(''), [markers, setMarkers] = useState<NativeAiPending[]>([])
  useEffect(() => { const read = () => { try { setMarkers(nativeAiClient.pending().filter(marker => marker.kind === 'plan_advance' && marker.taskId === taskId)) } catch (error) { setIssue(error instanceof Error ? error.message : '原规划标识待核对') } }; read(); return subscribeNativeAiPending(read) }, [taskId])
  if (!turns.length && !markers.length) return null
  const run = async (recover?: NativeAiPending) => {
    const owner = assertHostSession().user.id, epoch = getHostSessionRevision(); setBusy(true); setIssue('')
    try { if (recover) { if (!await nativeAiClient.recover(recover)) throw new Error('原规划结果仍待核对，请稍后读取；未重复生成') } else await nativeAiClient.advancePlan(taskId); assertHostSession(owner, epoch); await onChange() }
    catch (error) { try { assertHostSession(owner, epoch); setIssue(error instanceof Error ? error.message : '原规划结果仍待核对') } catch {} }
    finally { try { assertHostSession(owner, epoch); setBusy(false) } catch {} }
  }
  return <div className="space-y-2 border-b border-border px-4 py-3 text-xs text-muted-foreground" data-testid="native-ai-planning-recovery">
    {turns.flatMap(turn => [turn.parseError && <p key={`${turn.turnId}:parse`} role="status">{turn.parseError}</p>, ...turn.blockedCandidates.map(candidate => <p key={`${turn.turnId}:${candidate.index}`} role="status">建议第{candidate.index + 1}项尚未形成可执行卡片：{candidate.reason}</p>)])}
    <div className="flex flex-wrap items-center gap-2"><span>操作建议以本站保存的卡片为准；核对只读取原文案任务回执。</span>{markers.length ? markers.map(marker => <Button type="button" size="sm" variant="outline" disabled={busy} key={marker.requestKey} onClick={() => { void run(marker) }}>读取原规划记录</Button>) : <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => { void run() }}>核对规划并读取建议</Button>}</div>
    {issue && <p role="status" className="text-destructive">{issue}</p>}
  </div>
}
