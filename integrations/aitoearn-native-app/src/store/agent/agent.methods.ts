import { NativeAgentMemberStartSchema } from '@host-publishing/native-agent-contract'
import { assertHostSession, getHostSessionRevision } from '@/integration/host-session'
import { nativeAssetId } from '@/integration/native-assets'
import { submitNativeAgentTurn, readNativeAgentPending } from '@/integration/native-agent-client'
import { nativeAgentMemberRuntime, useNativeAgentComposer } from '@/integration/native-agent-composer'
import { createNativeAgentTranscript, reduceNativeAgentTranscript, nativeAgentTranscriptMessages, nativeAgentRunning, nativeAgentCanContinue } from '@/integration/native-agent-protocol'
import { confirm } from '@/utils/ui/confirm'
/**
 * Agent Store - 核心方法
 * 包含创建任务、继续任务等核心逻辑
 * 支持按任务ID隔离消息数据
 *
 * 使用 TaskInstance 架构：每个任务有独立的实例，消除多任务竞态条件
 */

import type {
  IActionContext,
  IAgentState,
  ICreateTaskParams,
  IPendingTask,
  ITaskMessageData,
} from './agent.types'
import type { MessageUtils } from './utils/message'
import type { IAgentRefs } from './utils/refs'
import { useUserStore } from '@/store/user'
import { toast } from '@/utils/ui/toast'
import { getDefaultTaskData, getInitialState } from './agent.state'

// ============ 常量配置 ============

/** 最大缓存任务数量 */
const MAX_CACHED_TASKS = 10

// ============ TaskInstance 管理 ============

/** 任务实例映射表 */


// ============ 方法工厂上下文 ============

export interface IMethodsContext {
  refs: IAgentRefs
  set: (partial: Partial<IAgentState> | ((state: IAgentState) => Partial<IAgentState>)) => void
  get: () => IAgentState
  messageUtils: MessageUtils
  resetRefs: () => void
}

// ============ 创建 Store 方法 ============

export function createStoreMethods(ctx: IMethodsContext) {
  const { refs, set, get, messageUtils, resetRefs } = ctx

  // ============ 任务数据操作辅助方法 ============

  /**
   * 获取指定任务的消息数据
   */
  function getTaskData(taskId: string): ITaskMessageData {
    const state = get()
    return state.taskMessages[taskId] || getDefaultTaskData()
  }

  /**
   * 更新指定任务的消息数据
   */
  function updateTaskData(
    taskId: string,
    updater: (data: ITaskMessageData) => Partial<ITaskMessageData>,
  ) {
    if (!taskId) {
      console.warn('[AgentStore] updateTaskData called without taskId')
      return
    }
    set((state) => {
      const currentData = state.taskMessages[taskId] || getDefaultTaskData()
      const updates = updater(currentData)
      return {
        taskMessages: {
          ...state.taskMessages,
          [taskId]: {
            ...currentData,
            ...updates,
            lastUpdated: Date.now(),
          },
        },
      }
    })
  }

  /**
   * 初始化任务数据
   */
  function initTaskData(taskId: string, initialData?: Partial<ITaskMessageData>) {
    set(state => ({
      taskMessages: {
        ...state.taskMessages,
        [taskId]: {
          ...getDefaultTaskData(),
          ...initialData,
          lastUpdated: Date.now(),
        },
      },
    }))
  }

  /**
   * 清理过期任务缓存
   */
  function cleanupTaskCache() {
    set((state) => {
      const entries = Object.entries(state.taskMessages)

      // 如果未超过最大数量，不清理
      if (entries.length <= MAX_CACHED_TASKS)
        return {}

      // 按最后更新时间排序
      const sorted = entries.sort((a, b) => (b[1].lastUpdated || 0) - (a[1].lastUpdated || 0))

      // 保留最近的 N 个任务
      const tasksToKeep = sorted.slice(0, MAX_CACHED_TASKS)
      const newTaskMessages: Record<string, ITaskMessageData> = {}

      for (const [taskId, data] of tasksToKeep) {
        newTaskMessages[taskId] = data
      }

      // 确保当前任务不被清理
      if (state.currentTaskId && !newTaskMessages[state.currentTaskId]) {
        newTaskMessages[state.currentTaskId] = state.taskMessages[state.currentTaskId]
      }

      return { taskMessages: newTaskMessages }
    })
  }

  async function startOwnedTurn(params: ICreateTaskParams, existingTaskId?: string) {
    const actor = assertHostSession().user.id, revision = getHostSessionRevision()
    if (readNativeAgentPending()) throw new Error('存在待核对原任务，请先读取原记录，不会重新创建请求')
    const prompt = params.prompt.trim(); if (!prompt) throw new Error('请输入本轮任务')
    if (existingTaskId && (!nativeAgentCanContinue(params.nativeStatus) || !params.expectedRevision || !Number.isSafeInteger(params.nativeLastSeq))) throw new Error('本轮结果尚未确认，请读取原任务，不能继续或重发')
    await useNativeAgentComposer.getState().load()
    assertHostSession(actor, revision)
    const runtime = nativeAgentMemberRuntime()
    const assetIds = (params.medias || []).map(media => { if (media.progress !== undefined && media.progress < 100) throw new Error('请等待素材上传确认'); return nativeAssetId(media.url) })
    const context = structuredClone(useNativeAgentComposer.getState().context)
    context.assetIds = [...new Set([...context.assetIds, ...assetIds])]
    if (context.assetIds.length && !runtime.capabilities.media) throw new Error('当前助手支持草稿文字处理，图片和视频请在发布编辑器处理')
    if (context.draftIds.length && !runtime.capabilities.readDraft) throw new Error('当前助手暂不能读取已有草稿，请稍后刷新状态')
    const operations = [runtime.capabilities.readDraft ? '读取您选择的草稿' : '', runtime.capabilities.saveDraft ? '按需求保存新草稿' : ''].filter(Boolean).join('、')
    const accepted = await confirm({ title: '确认本轮创作费用', content: '本轮最多使用 ' + runtime.budget.maxCreditsPerTurn + ' 积分，完成后按实际用量结算。' + (operations ? '助手可' + operations + '。' : '') + (!runtime.capabilities.media || !runtime.capabilities.publish ? '图片、视频和发布请在相应编辑器完成。' : ''), okText: '确认发送' })
    assertHostSession(actor, revision); if (!accepted) throw new Error('已保留本轮输入，尚未发送')
    if (nativeAgentMemberRuntime() !== runtime) throw new Error('助手状态已更新，请核对本轮费用后重新发送')
    if (readNativeAgentPending()) throw new Error('已有原任务等待确认，请先查看原任务')
    const requestKey = 'native-agent:' + crypto.randomUUID()
    const input = NativeAgentMemberStartSchema.parse({ requestKey, prompt, context, runtimeApproval: structuredClone(runtime.approval), ...(existingTaskId ? { taskId: existingTaskId, expectedRevision: params.expectedRevision } : {}) })
    let activeId = existingTaskId || requestKey
    let transcript = createNativeAgentTranscript(existingTaskId ? getTaskData(existingTaskId).messages : [], prompt, requestKey)
    const sync = () => {
      assertHostSession(actor, revision)
      updateTaskData(activeId, () => ({ messages: nativeAgentTranscriptMessages(transcript), streamingText: transcript.text, workflowSteps: transcript.workflowSteps, nativeStatus: transcript.state, isGenerating: nativeAgentRunning(transcript.state), progress: transcript.state === 'completed' ? 100 : 0 }))
    }
    set({ currentTaskId: activeId }); initTaskData(activeId); sync()
    const operation = await submitNativeAgentTurn(input, {
      afterSeq: existingTaskId ? params.nativeLastSeq : 0,
      expectedTaskId: existingTaskId,
      onTaskId(id) {
        assertHostSession(actor, revision)
        if (id !== activeId) {
          const old = activeId; activeId = id
          set(state => { const values = { ...state.taskMessages }; const original = values[old]; delete values[old]; if (original) values[id] = original; return { currentTaskId: id, taskMessages: values } })
        }
        params.onTaskIdReady?.(id)
      },
      onEvent(event) { assertHostSession(actor, revision); transcript = reduceNativeAgentTranscript(transcript, event); sync(); if (transcript.state === 'completed' || transcript.state === 'failed' || transcript.state === 'cancelled') void useUserStore.getState().fetchCreditsBalance() },
      onUnknown(message) { assertHostSession(actor, revision); transcript = { ...transcript, state: 'unknown' }; sync(); toast.info(message) },
    })
    refs.sseAbort.value = operation.abort
    void operation.completion.finally(() => { try { assertHostSession(actor, revision); refs.sseAbort.value = null } catch {} })
    return operation.acknowledged
  }

  // ============ 返回 Store 方法 ============

  return {
    // ============ 任务数据 Getters ============

    /** 获取指定任务的数据 */
    getTaskData,

    /** 更新指定任务的数据 */
    updateTaskData,

    /** 初始化任务数据 */
    initTaskData,

    /** 清理任务缓存 */
    cleanupTaskCache,

    // ============ 核心方法：创建任务 ============

    /**
     * 创建 AI 生成任务
     * 使用 TaskInstance 架构：创建独立实例，SSE 回调绑定到实例
     */
    async createTask(params: ICreateTaskParams): Promise<string | null> {
      if (!useUserStore.getState().isAuthenticated) { params.onLoginRequired?.(); return null }
      return startOwnedTurn(params)
    },

    async continueTask(params: ICreateTaskParams & { taskId: string }): Promise<void> {
      await startOwnedTurn(params, params.taskId)
    },

    // ============ 任务控制 ============

    /** 停止当前任务 */
    stopTask() {
      refs.sseAbort.value?.(); refs.sseAbort.value = null
      const taskId = get().currentTaskId
      if (taskId) updateTaskData(taskId, () => ({ isGenerating: false, nativeStatus: 'unknown' }))
    },

    /** 重置状态 */
    reset() {
      if (refs.sseAbort.value) {
        refs.sseAbort.value()
        refs.sseAbort.value = null
      }
      resetRefs()
      refs.t.value = null
      refs.actionContext.value = null
      set(getInitialState())
    },

    // ============ 消息管理 ============

    setMessages: messageUtils.setMessages.bind(messageUtils),
    appendMessage: messageUtils.addMessage.bind(messageUtils),

    // ============ 待处理任务管理 ============

    /** 设置待处理任务（从首页跳转时使用） */
    setPendingTask(task: IPendingTask) {
      set({ pendingTask: task })
    },

    /** 获取并清除待处理任务 */
    consumePendingTask(): IPendingTask | null {
      const task = get().pendingTask
      if (task) {
        set({ pendingTask: null })
      }
      return task
    },

    // ============ Action 上下文管理 ============

    /** 设置 Action 上下文 */
    setActionContext(context: IActionContext) {
      refs.actionContext.value = context
    },

    /** 获取 Action 上下文 */
    getActionContext(): IActionContext | null {
      return refs.actionContext.value
    },

    // ============ Debug 模式管理 ============

    /**
     * 设置 debug 文件列表
     * @param files debug 文件名数组（如 ['sse1.txt', 'sse2.txt']）
     */
    setDebugFiles(_files: string[]) { void _files; throw new Error('会员工作台不开放调试文件回放') },
    consumeDebugFile(): string | null { return null },
    isDebugMode(): boolean { return false },
    hasMoreDebugFiles(): boolean { return false },
    clearDebugMode() { set({ debugFiles: [], debugMessageIndex: 0 }) },

  }
}
