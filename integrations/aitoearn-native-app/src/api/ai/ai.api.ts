import { readNativeAgentTask, editNativeAgentTask } from '@/integration/native-agent-client'
import { nativeBffFetch } from '@/integration/host-transport'
import type { AgentTaskRatingResponse, AgentTaskShareVo, AiChatStreamParams, AiLogListParams, AiPaginationParams, ChatModel, CreateAgentTaskParams, CreateDraftFromVideoUrlDto, CreateDraftFromVideoUrlVo, CreateDraftGenerationVo, CreateImageTextDraftGenerationParams, CreateVideoDraftGenerationParams, DraftGenerationPricingVo, DraftGenerationStats, DraftGenerationTask, DraftGenerationTaskListVo, GetTaskListParams, SubmitAgentTaskRatingPayload, TaskDetail, TaskListResponse, TaskMessagesVo, VideoGenerationHistoryListVo } from './ai.types'
import type { AssetListVo } from '@/types/agent-asset'
import { useUserStore } from '@/store/user'
import http from '@/utils/request'

/** AI 生成任务、草稿生成、模型配置与任务消息接口。 */
export const agentApi = {
  /**
   * 创建AI生成任务并通过 SSE 接收实时消息
   * @param params
   * @param onMessage SSE 消息回调
   * @param onError 错误回调
   * @param onDone 完成回调
   * @returns 返回一个 abort 函数，用于中断 SSE 连接
   */
  async createTaskWithSSE(..._args: unknown[]): Promise<() => void> { void _args; throw new Error('请通过已确认的主站任务入口发送，旧自动请求入口已停止') },

  /**
   * 创建AI生成任务（旧方法，保留兼容性）
   * @param params
   */
  async createTask(_params: CreateAgentTaskParams): Promise<never> { void _params; throw new Error('请通过主站不可变请求入口发送任务') },

  /**
   * 获取任务详情
   * @param taskId 任务ID
   */
  async getTaskDetail(taskId: string) {
    return { code: 0 as const, data: await readNativeAgentTask(taskId), message: '', url: '' }
  },

  /**
   * 获取任务消息（增量）
   * @param taskId 任务ID
   * @param lastMessageId 上次获取的最后一条消息 UUID，可选
   */
  async getTaskMessages(taskId: string, lastMessageId?: string) {
    const params = lastMessageId ? { lastMessageId } : undefined
    const res = await http.get<TaskMessagesVo>(`agent/tasks/${taskId}/messages`, params)
    return res
  },

  /**
   * 获取任务评分
   * @param taskId 任务ID
   */
  async getTaskRating(taskId: string) {
    const res = await http.get<AgentTaskRatingResponse>(
      `agent/tasks/${taskId}/rating`,
    )
    return res
  },

  /**
   * 提交或更新任务评分
   * @param taskId 任务ID
   * @param payload 评分内容
   * @param payload.rating 评分值
   * @param payload.comment 评分备注
   */
  async submitTaskRating(taskId: string, payload: SubmitAgentTaskRatingPayload, expectedRevision?: number) {
    return editNativeAgentTask(taskId, 'POST', '/rating', payload, expectedRevision)
  },

  /**
   * 停止/取消任务
   * @param taskId 任务ID
   */
  async stopTask(taskId: string, expectedRevision?: number) {
    return editNativeAgentTask(taskId, 'POST', '/abort', {}, expectedRevision)
  },

  /**
   * 中断内容生成任务
   * @param taskId 任务ID
   */
  async abortTask(taskId: string, expectedRevision?: number) {
    return editNativeAgentTask(taskId, 'POST', '/abort', {}, expectedRevision)
  },

  /**
   * 获取任务列表
   * @param params 查询参数
   */
  async getTaskList(params: GetTaskListParams = {}) {
    const { page = 1, pageSize = 10, keyword, favoriteOnly } = params
    const queryParams: Record<string, string | number | boolean> = { page, pageSize }

    // 添加搜索关键词（截取前100字符）
    if (keyword?.trim()) {
      queryParams.keyword = keyword.trim().slice(0, 100)
    }
    // 添加收藏筛选
    if (favoriteOnly) {
      queryParams.favoriteOnly = true
    }

    const res = await http.get<TaskListResponse>('agent/tasks', queryParams)
    return res
  },

  /**
   * 删除任务
   * @param taskId 任务ID
   */
  async deleteTask(taskId: string, expectedRevision?: number) {
    return editNativeAgentTask(taskId, 'DELETE', '', {}, expectedRevision)
  },

  /**
   * 更新任务标题
   * @param taskId 任务ID
   * @param title 新标题
   */
  async updateTaskTitle(taskId: string, title: string, expectedRevision?: number) {
    return editNativeAgentTask(taskId, 'PATCH', '', { title }, expectedRevision)
  },
  /**
   * 为任务创建或更新评分
   * @param taskId 任务ID
   * @param rating 评分值（1-5）
   * @param comment 可选评论
   */
  async createRating(taskId: string, rating: number, comment?: string, expectedRevision?: number) {
    return editNativeAgentTask(taskId, 'POST', '/rating', { rating, comment }, expectedRevision)
  },
  /**
   * Create a public share token for a task
   * @param taskId
   * @param ttlSeconds optional validity in seconds
   */
  async createPublicShare(_taskId: string, _ttlSeconds?: number): Promise<{ code: 0, data: AgentTaskShareVo, message: string, url: string }> { void _taskId; void _ttlSeconds; throw new Error('公开分享尚未接入主站授权；本页可继续查看自己的任务记录') },

  /**
   * Get task by public share token (no authentication required)
   * @param token Share token
   */
  async getTaskByShareToken(_token: string): Promise<never> { void _token; throw new Error('此工作台只读取当前会员任务，公开分享尚未接入') },

  /**
   * 收藏任务
   * @param taskId 任务ID
   */
  async favoriteTask(taskId: string, expectedRevision?: number) {
    return editNativeAgentTask(taskId, 'POST', '/favorite', {}, expectedRevision)
  },

  /**
   * 取消收藏任务
   * @param taskId 任务ID
   */
  async unfavoriteTask(taskId: string, expectedRevision?: number) {
    return editNativeAgentTask(taskId, 'DELETE', '/favorite', {}, expectedRevision)
  },
}

// Source: ai.ts
/**
 * Get Chat Model Parameters
 */
export function getChatModels(scene?: 'comment' | 'web', silent?: boolean) {
  return http.get<ChatModel[]>(`ai/models/chat?scene=${scene || 'web'}`, undefined, silent)
}

/**
 * List Video Tasks
 */
export function getVideoGenerations(params?: AiPaginationParams) {
  return http.get<VideoGenerationHistoryListVo>('history/videos', params)
}

/**
 * 获取用户 AI 活动日志
 */
export function getLogs(params?: AiLogListParams) {
  return http.get('history/logs', params)
}

/**
 * AI聊天接口 - 支持流式和非流式响应
 */
export async function aiChatStream(data: AiChatStreamParams) {
  const lang = useUserStore.getState().lang

  const response = await nativeBffFetch('ai/chat', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept-Language': lang || 'en',
    },
    body: JSON.stringify({
      stream: false, // 使用非流式响应
      model: 'gpt-5.1-all',
      temperature: 1,
      presence_penalty: 0,
      frequency_penalty: 0,
      top_p: 1,
      max_tokens: 8000, // 增加到8000以支持更长的响应（包括base64图片）
      ...data,
    }),
  })

  if (!response.ok) {
    throw new Error(`HTTP error! status: ${response.status}`)
  }

  return response
}

/**
 * 获取 Agent 生成的素材列表
 * @param params - 分页参数
 * @param params.page - 页码
 * @param params.pageSize - 每页数量
 * @returns 素材列表
 */
export function getAgentAssets(params?: AiPaginationParams) {
  return http.get<AssetListVo>('history/assets', params)
}

/** 创建 AI 批量生成草稿任务 */
export function apiCreateDraftGeneration(data: CreateVideoDraftGenerationParams) {
  return http.post<CreateDraftGenerationVo>('ai/draft-generation/v2', data)
}

/** 创建 AI 图文草稿生成任务 */
export function apiCreateImageTextDraft(data: CreateImageTextDraftGenerationParams) {
  return http.post<CreateDraftGenerationVo>('ai/draft-generation/image-text', data)
}

/** 获取图片模型定价信息 */
export function apiGetDraftGenerationPricing() {
  return http.get<DraftGenerationPricingVo>('ai/draft-generation/pricing')
}

/** 根据视频 URL 生成草稿 */
export function apiCreateDraftFromVideoUrl(data: CreateDraftFromVideoUrlDto) {
  return http.post<CreateDraftFromVideoUrlVo>('ai/draft-generation/from-video-url', data)
}

/**
 * 获取生成中任务数量统计（轮询用，静默模式不弹错误提示）
 */
export function apiGetDraftGenerationStats() {
  return http.get<DraftGenerationStats>('ai/draft-generation/stats', undefined, true)
}

/**
 * 根据任务 ID 批量查询生成任务状态（轮询用，静默模式不弹错误提示）
 */
export function apiQueryDraftGenerationTasks(taskIds: string[]) {
  return http.post<DraftGenerationTask[]>('ai/draft-generation/query', { taskIds }, true)
}

/**
 * 获取生成任务列表（分页）
 * @param page 页码
 * @param pageSize 每页数量
 */
export function apiGetDraftGenerationList(page: number = 1, pageSize: number = 10) {
  return http.get<DraftGenerationTaskListVo>(
    'ai/draft-generation/',
    { page, pageSize },
  )
}
