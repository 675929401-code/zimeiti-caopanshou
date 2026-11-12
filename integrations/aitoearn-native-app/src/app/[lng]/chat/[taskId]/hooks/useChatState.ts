import type { TaskDetail } from '@/api/ai/ai.types'
import type { IDisplayMessage, IWorkflowStep } from '@/store/agent'
import { useCallback, useEffect, useRef, useState } from 'react'
import { readNativeAgentTask, replayNativeAgentTask } from '@/integration/native-agent-client'
import { nativeAgentHistory, nativeAgentRunning, createNativeAgentTranscript, reduceNativeAgentTranscript, nativeAgentTranscriptMessages } from '@/integration/native-agent-protocol'
import { assertHostSession, getHostSessionRevision } from '@/integration/host-session'
import { useAgentStore } from '@/store/agent'
import { getDefaultTaskData } from '@/store/agent/agent.state'
export interface IChatStateOptions { taskId: string, t: (key: string) => string }
export function useChatState({ taskId }: IChatStateOptions) {
  const taskMessages = useAgentStore(state => state.taskMessages), currentTaskId = useAgentStore(state => state.currentTaskId)
  const [task, setTask] = useState<TaskDetail | null>(null), [localMessages, setLocalMessages] = useState<IDisplayMessage[]>([])
  const [isLoading, setIsLoading] = useState(true), [localIsGenerating, setLocalIsGenerating] = useState(false)
  const generation = useRef(0)
  const [readIssue, setReadIssue] = useState('')
  const refreshTask = useCallback(async () => {
    if (!/^[a-f0-9-]{36}$/i.test(taskId)) return
    const actor = assertHostSession().user.id, revision = getHostSessionRevision(), epoch = generation.current
    const value = await readNativeAgentTask(taskId); assertHostSession(actor, revision)
    if (epoch !== generation.current) return
    setReadIssue('')
    setTask(value); setLocalMessages(nativeAgentHistory(value.messages, value.nativePlanningTurns, value.nativeWorkflowEvents)); setIsLoading(false)
    if (!nativeAgentRunning(value.nativeStatus)) {
      setLocalIsGenerating(false)
      const current = useAgentStore.getState().getTaskData(taskId)
      useAgentStore.getState().updateTaskData(taskId, () => ({ ...current, messages: nativeAgentHistory(value.messages, value.nativePlanningTurns, value.nativeWorkflowEvents), isGenerating: false, nativeStatus: value.nativeStatus }))
    }
    return value
  }, [taskId])
  useEffect(() => {
    ++generation.current; setTask(null); setLocalMessages([]); setIsLoading(taskId !== 'new')
    let active = true, reading = false
    const controller = new AbortController()
    let replayStarted = false
    const read = async () => {
      if (!active || reading) return
      reading = true
      try {
        const value = await refreshTask()
        if (!active || !value || replayStarted || !nativeAgentRunning(value.nativeStatus) || useAgentStore.getState().getTaskData(taskId).isGenerating) return
        replayStarted = true
        const actor = assertHostSession().user.id, revision = getHostSessionRevision(), epoch = generation.current
        const messages = nativeAgentHistory(value.messages, value.nativePlanningTurns, value.nativeWorkflowEvents)
        const planning = !!value.nativePlanningTurns?.some(turn => turn.turnId === value.turns?.[0]?.id)
        let userIndex = -1; for (let index = messages.length - 1; index >= 0; index--) if (messages[index].role === 'user') { userIndex = index; break }
        const user = messages[userIndex], assistant = messages.slice(userIndex + 1).find(message => message.role === 'assistant')
        let transcript = { ...createNativeAgentTranscript(userIndex >= 0 ? messages.slice(0, userIndex) : messages, user?.content || value.prompt || '', 'resume:' + taskId, planning), text: assistant?.content || '', userId: user?.id || 'resume:user', assistantId: assistant?.id || 'resume:assistant', state: value.nativeStatus || 'running', lastSeq: value.nativeLastSeq || 0, workflowSteps: assistant?.steps?.flatMap(step => step.workflowSteps || []) || [] }
        const sync = () => { assertHostSession(actor, revision); if (!active || epoch !== generation.current) return; useAgentStore.setState({ currentTaskId: taskId }); useAgentStore.getState().updateTaskData(taskId, () => ({ messages: nativeAgentTranscriptMessages(transcript), streamingText: transcript.text, workflowSteps: transcript.workflowSteps, isGenerating: nativeAgentRunning(transcript.state), nativeStatus: transcript.state })) }
        void replayNativeAgentTask(taskId, value.nativeLastSeq || 0, { afterSeq: value.nativeLastSeq || 0, expectedTaskId: taskId, expectedTurnId: value.turns?.[0]?.id, planningMode: planning, onTaskId() {}, onEvent(event) { transcript = reduceNativeAgentTranscript(transcript, event); sync() }, onUnknown() { transcript = { ...transcript, state: 'unknown' }; sync() } }, controller.signal).catch(() => { if (!active) return; try { assertHostSession(actor, revision); transcript = { ...transcript, state: 'unknown' }; sync() } catch {} })
      } catch { if (active) { setIsLoading(false); setReadIssue('主站任务记录暂不可确认，请重新核对原任务') } }
      finally { reading = false }
    }
    void read()
    const timer = setInterval(() => { void read() }, 3000)
    const focus = () => { void read() }; window.addEventListener('focus', focus)
    return () => { active = false; ++generation.current; controller.abort(); clearInterval(timer); window.removeEventListener('focus', focus) }
  }, [taskId, refreshTask])
  const current = taskMessages[taskId] || getDefaultTaskData(), isActiveTask = currentTaskId === taskId
  const isGenerating = nativeAgentRunning(task?.nativeStatus) || current.isGenerating || localIsGenerating
  const displayMessages = isActiveTask && current.messages.length && current.isGenerating ? current.messages : localMessages.length ? localMessages : current.messages
  const updateTaskTitle = useCallback((title: string) => setTask(previous => previous ? { ...previous, title } : previous), [])
  const workflowSteps: IWorkflowStep[] = isActiveTask ? current.workflowSteps : []
  return { task, displayMessages, workflowSteps, isLoading, isGenerating, progress: current.progress, isActiveTask, setLocalMessages, setLocalIsGenerating, updateTaskTitle, refreshTask, readIssue }
}

export type IChatStateReturn = ReturnType<typeof useChatState>
