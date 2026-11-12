/**
 * 对话详情页 - Chat Detail
 * 功能：支持实时模式（从 HomeChat 跳转）和历史模式（刷新或从任务列表进入）
 * 工作流状态实时显示在对应消息上
 */
'use client'

import { nativeAgentCanContinue, nativeAgentStatusLabel } from '@/integration/native-agent-protocol'
import { NativeAiTaskActions } from '@/integration/NativeAiActionPanel'
import { NativeAiPlanningRecovery } from '@/integration/NativeAiPlanningRecovery'
import { useParams, useRouter } from 'next/navigation'
import { useCallback, useEffect, useState } from 'react'
import { agentApi } from '@/api/ai/ai.api'
import { useTransClient } from '@/app/i18n/client'
import { ChatInput } from '@/components/Chat/ChatInput'
import EditTitleModal from '@/components/common/EditTitleModal'
import { PublishDetailModal } from '@/components/Plugin/PublishDetailModal'
import { useDocumentTitle, useMediaUpload } from '@/hooks'
import { useAgentStore } from '@/store/agent'
import { usePluginStore } from '@/store/plugin'
import { toast } from '@/utils/ui/toast'

// 页面私有组件
import { ChatHeader, ChatLoadingSkeleton, ChatMessageList } from './components'
// 页面私有 hooks
import { useChatState, useScrollControl } from './hooks'

export default function ChatDetailPage() {
  const { t } = useTransClient('chat')
  const { t: tHome } = useTransClient('home')
  const router = useRouter()
  const params = useParams()
  const taskId = params.taskId as string
  const lng = params.lng as string

  // Store 方法
  const { continueTask, stopTask, setActionContext }
    = useAgentStore()

  // 聊天状态管理
  const {
    task,
    displayMessages,
    workflowSteps,
    isLoading,
    isGenerating,
    progress,
    isActiveTask,
    setLocalIsGenerating,
    updateTaskTitle,
    refreshTask,
    readIssue,
  } = useChatState({
    taskId,
    t: t as (key: string) => string,
  })

  // 中断状态 - 用于强制隐藏工作流步骤
  const [isInterrupted, setIsInterrupted] = useState(false)

  // 本地评分状态 - 用于评分成功后立即更新 UI
  const [localRating, setLocalRating] = useState<number | null | undefined>(undefined)

  // 收藏状态（乐观更新）
  const [isFavorited, setIsFavorited] = useState(false)

  // 编辑标题状态
  const [editTitleOpen, setEditTitleOpen] = useState(false)

  // 发布详情弹框状态
  const [publishDetailVisible, setPublishDetailVisible] = useState(false)
  const [currentPublishTaskId, setCurrentPublishTaskId] = useState<string | undefined>(undefined)
  // 跟踪用户是否手动关闭了弹窗
  const [userClosedModal, setUserClosedModal] = useState(false)

  // 滚动控制
  const {
    containerRef,
    bottomRef,
    isNearBottom,
    showScrollButton,
    scrollToBottom,
    handleScroll,
    onContentReady,
  } = useScrollControl()

  // 输入状态
  const [inputValue, setInputValue] = useState('')

  // 媒体上传
  const {
    medias,
    setMedias,
    isUploading,
    handleMediasChange,
    handleMediaRemove,
    handleMediaUpdate,
    clearMedias,
  } = useMediaUpload({
    onError: () => toast.error(t('media.uploadFailed')),
  })

  // 监听发布任务创建
  const publishTasks = usePluginStore(state => state.publishTasks)

  // 动态更新页面标题
  useDocumentTitle(task?.title, t('task.newChat'))

  // 从 task 初始化收藏状态
  useEffect(() => {
    if (task) {
      setIsFavorited(!!task.favoritedAt)
    }
  }, [task])

  // 监听发布任务创建，显示发布详情弹框
  useEffect(() => {
    if (publishTasks.length > 0) {
      // 获取最新的发布任务（通常是刚创建的）
      const latestTask = publishTasks[0]
      if (latestTask && !publishDetailVisible && !userClosedModal) {
        setCurrentPublishTaskId(latestTask.id)
        setPublishDetailVisible(true)
        // 重置用户关闭状态，因为现在有新任务了
        setUserClosedModal(false)
      }
    }
  }, [publishTasks, publishDetailVisible, userClosedModal])

  /**
   * 设置 Action 上下文（用于处理任务结果的 action）
   */
  useEffect(() => {
    setActionContext({
      router,
      lng,
      t: tHome,
    })
  }, [router, lng, tHome, setActionContext])

  useEffect(() => { if (taskId === 'new') router.replace('/' + lng + '/ai-social') }, [taskId, lng, router])

  /**
   * 首次加载完成后，强制滚动到底部
   */
  useEffect(() => {
    // 当数据加载完成且有消息时，确保滚动到底部
    if (!isLoading && displayMessages.length > 0) {
      onContentReady()
    }
  }, [isLoading, displayMessages.length, onContentReady])

  /**
   * 智能滚动：用户在底部附近时自动滚动
   */
  useEffect(() => {
    if (isNearBottom) {
      scrollToBottom()
    }
  }, [displayMessages, workflowSteps, isNearBottom, scrollToBottom])

  /**
   * 发送消息（继续对话）
   */
  const handleSend = useCallback(async () => {
    if (!inputValue.trim() || isGenerating)
      return

    const currentPrompt = inputValue
    const currentMedias = [...medias]

    // 重置中断状态，开始新任务
    setIsInterrupted(false)
    setLocalIsGenerating(true)

    // 强制滚动到底部
    scrollToBottom(true)

    try {
      await continueTask({
        prompt: currentPrompt,
        medias: currentMedias,
        t: t as (key: string) => string,
        taskId,
        expectedRevision: task?.nativeRevision,
        nativeStatus: task?.nativeStatus,
        nativeLastSeq: task?.nativeLastSeq,
      })
      setInputValue(''); clearMedias()
    }
    catch (error: any) {
      console.error('Continue task failed:', error)
      toast.error(error.message || t('message.error'))
      // 恢复输入
      setInputValue(inputValue)
      setMedias(currentMedias)
    }
    finally {
      setLocalIsGenerating(false)
    }
  }, [
    inputValue,
    medias,
    isGenerating,
    taskId,
    task?.nativeRevision,
    task?.nativeStatus,
    task?.nativeLastSeq,
    t,
    continueTask,
    clearMedias,
    setMedias,
    scrollToBottom,
    setLocalIsGenerating,
  ])

  /**
   * 停止生成
   */
  const handleStop = useCallback(async () => {
    try {
      // 调用后端 API 中断任务
      await agentApi.abortTask(taskId, task?.nativeRevision)
      // 显示停止成功的提示
      toast.info('停止请求已登记，等待主站确认；不代表已取消或退款')
      await refreshTask()
    }
    catch (error: any) {
      console.error('[ChatPage] Failed to abort task:', error)
      toast.error(t('message.error'))
    }

  }, [taskId, task?.nativeRevision, t, refreshTask])

  /**
   * 返回首页
   */
  const handleBack = useCallback(() => {
    // 中断当前正在进行的任务，防止竞态条件
    if (isGenerating) {
      stopTask()
    }

    // If there's a previous entry in the history stack, go back.
    // Otherwise, navigate to the root homepage.
    if (typeof window !== 'undefined' && window.history.length > 1) {
      router.back()
    }
    else {
      router.push('/' + lng + '/ai-social')
    }
  }, [router, lng, isGenerating, stopTask])

  /**
   * 收藏切换 - 乐观更新
   */
  const handleFavoriteToggle = useCallback(async () => {
    const newValue = !isFavorited
    setIsFavorited(newValue) // 先更新 UI

    try {
      if (newValue) {
        await agentApi.favoriteTask(taskId, task?.nativeRevision)
      }
      else {
        await agentApi.unfavoriteTask(taskId, task?.nativeRevision)
      }
      await refreshTask()
    }
    catch {
      setIsFavorited(!newValue) // 失败回滚
      toast.error(t('message.error'))
    }
  }, [isFavorited, taskId, task?.nativeRevision, refreshTask, t])

  /**
   * 保存标题 - 乐观更新
   */
  const handleSaveTitle = useCallback(
    async (newTitle: string) => {
      const result = await agentApi.updateTaskTitle(taskId, newTitle, task?.nativeRevision)
      if (result && result.code === 0) {
        // 更新本地 task 状态，触发页面标题和 header 标题更新
        updateTaskTitle(newTitle)
        await refreshTask()
        toast.success(t('task.titleUpdated'))
      }
      else {
        throw new Error('Save failed')
      }
    },
    [taskId, task?.nativeRevision, t, updateTaskTitle, refreshTask],
  )

  // 加载中状态（仅非活跃任务显示骨架屏）
  if (isLoading && !isActiveTask) {
    return <ChatLoadingSkeleton />
  }

  return (
    <div className="flex flex-col h-full">
      {/* 顶部导航 */}
      <ChatHeader
        title={task?.title}
        defaultTitle={t('task.newChat')}
        isGenerating={isGenerating}
        progress={progress}
        thinkingText={t('message.thinking')}
        taskId={taskId}
        rating={task?.rating ?? null}
        isFavorited={isFavorited}
        onFavoriteToggle={handleFavoriteToggle}
        onEditTitle={() => setEditTitleOpen(true)}
        onBack={handleBack}
      />

      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2 text-xs text-muted-foreground" role="status"><span>{readIssue || nativeAgentStatusLabel(task?.nativeStatus)} · 规划建议须逐项确认，真实发布仍须在发布窗口确认。</span><button type="button" className="underline" onClick={() => { void refreshTask().catch(() => toast.info('原任务记录暂不可读取')) }}>核对原任务</button></div>
      <NativeAiPlanningRecovery taskId={taskId} turns={task?.nativePlanningTurns || []} onChange={refreshTask} />
      <NativeAiTaskActions taskId={taskId} />
      {/* 消息列表 */}
      <ChatMessageList
        messages={displayMessages}
        workflowSteps={isInterrupted ? [] : workflowSteps}
        isGenerating={isGenerating}
        containerRef={containerRef}
        bottomRef={bottomRef}
        showScrollButton={showScrollButton}
        onScroll={handleScroll}
        onScrollToBottom={() => scrollToBottom(true)}
        scrollToBottomText={t('detail.scrollToBottom')}
        taskId={taskId}
        rating={localRating !== undefined ? localRating : (task?.rating ?? null)}
        onRatingSaved={() => setLocalRating(1)}
      />

      {/* 底部输入区域 - 限宽居中 */}
      <div className="p-4 shrink-0">
        <div className="max-w-6xl mx-auto">
          <ChatInput
            value={inputValue}
            onChange={setInputValue}
            onSend={handleSend}
            onStop={handleStop}
            medias={medias}
            onMediasChange={handleMediasChange}
            onMediaRemove={handleMediaRemove}
            onMediaUpdate={handleMediaUpdate}
            isGenerating={isGenerating}
            isUploading={isUploading}
            placeholder={t('detail.continuePlaceholder')}
            mode="compact"
            disabled={!nativeAgentCanContinue(task?.nativeStatus)}
          />
        </div>
      </div>

      {/* 发布详情弹框 - 显示插件发布进度 */}
      <PublishDetailModal
        visible={publishDetailVisible}
        onClose={() => {
          setPublishDetailVisible(false)
          setCurrentPublishTaskId(undefined)
          setUserClosedModal(true)
        }}
        taskId={currentPublishTaskId}
      />

      {/* 编辑标题弹窗 */}
      <EditTitleModal
        open={editTitleOpen}
        onOpenChange={setEditTitleOpen}
        currentTitle={task?.title || ''}
        onSave={handleSaveTitle}
      />
    </div>
  )
}
