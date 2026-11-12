import { create } from 'zustand'
import { z } from 'zod'
import { NativeAgentContextSchema, NativeAgentRuntimeApprovalSchema, type NativeAgentMemberStart } from '@host-publishing/native-agent-contract'
import http from '@/utils/request'
import { assertHostSession, getHostSession, getHostSessionRevision, subscribeHostSession } from './host-session'
export type NativeAgentContext = NativeAgentMemberStart['context']
export const NativeAgentMemberRuntimeSchema = z.object({
  ready: z.boolean(),
  message: z.string().max(2000),
  budget: z.object({
    maxCreditsPerTurn: z.string().regex(/^(?:0|[1-9]\d{0,11})(?:\.\d{1,6})?$/u),
    maxCallsPerTurn: z.number().int().min(0).max(24),
  }).strict(),
  approval: NativeAgentRuntimeApprovalSchema.nullable(),
  capabilities: z.object({ readDraft: z.boolean(), saveDraft: z.boolean(), media: z.boolean(), publish: z.boolean() }).strict(),
}).strict().refine(value => !value.ready || value.approval !== null && value.budget.maxCallsPerTurn > 0
  && value.approval.maxCreditsPerTurn === value.budget.maxCreditsPerTurn, { message: '助手费用上限尚未就绪' })
export type NativeAgentMemberRuntime = z.infer<typeof NativeAgentMemberRuntimeSchema>
const emptyContext = (): NativeAgentContext => ({ accountIds: [], collectionIds: [], draftIds: [], assetIds: [] })
interface Composer { runtime: NativeAgentMemberRuntime | null, context: NativeAgentContext, loading: boolean, issue: string, load: () => Promise<void>, setContext: (value: NativeAgentContext) => void }
let pending: Promise<void> | null = null
export const useNativeAgentComposer = create<Composer>(set => ({
  runtime: null, context: emptyContext(), loading: false, issue: '',
  async load() {
    if (pending) return pending
    const actor = assertHostSession().user.id, revision = getHostSessionRevision(); set({ loading: true, issue: '', runtime: null })
    const request = (async () => {
      try {
        const result = await http.get<unknown>('agent/runtime', undefined, true); assertHostSession(actor, revision)
        const runtime = NativeAgentMemberRuntimeSchema.parse(result.data)
        set({ runtime, issue: runtime.ready ? '' : runtime.message || '助手暂不可用，请稍后刷新状态' })
      } catch (error) { try { assertHostSession(actor, revision); set({ runtime: null, issue: error instanceof Error ? error.message : '助手状态尚未读取，请稍后重试' }) } catch {} }
      finally { try { assertHostSession(actor, revision); set({ loading: false }) } catch {} }
    })()
    pending = request; try { await request } finally { if (pending === request) pending = null }
  },
  setContext(context) { set({ context: NativeAgentContextSchema.parse(context) }) },
}))
let ownerRevision = getHostSessionRevision()
subscribeHostSession(() => {
  const next = getHostSessionRevision()
  if (next !== ownerRevision) { ownerRevision = next; pending = null; useNativeAgentComposer.setState({ runtime: null, context: emptyContext(), loading: false, issue: '' }) }
  const state = useNativeAgentComposer.getState()
  if (getHostSession() && !state.runtime && !state.loading) void state.load()
})
export function nativeAgentMemberRuntime(): NativeAgentMemberRuntime {
  const state = useNativeAgentComposer.getState()
  if (state.loading || !state.runtime?.ready || !state.runtime.approval) throw new Error(state.issue || '助手暂不可用，请稍后刷新状态')
  return state.runtime
}
