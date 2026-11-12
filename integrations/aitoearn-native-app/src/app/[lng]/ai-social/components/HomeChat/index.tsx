/**
 * HomeChat - 首页Chat组件
 * 功能：大尺寸聊天输入框，使用全局 AgentStore 发起 SSE 任务，获取 taskId 后跳转到对话详情页
 */

'use client'

import { useParams, useRouter, useSearchParams } from 'next/navigation'
import { forwardRef, useCallback, useEffect, useImperativeHandle, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useTransClient } from '@/app/i18n/client'
import { useChannelManagerStore } from '@/components/ChannelManager'
import { ChatInput } from '@/components/Chat/ChatInput'
import { PlatformIcon } from '@/components/common/PlatformIcon'
import { useMediaUpload } from '@/hooks/useMediaUpload'
import { usePlatformInfoList } from '@/hooks/usePlatformMetadata'
import { useAgentStore } from '@/store/agent'
import { useUserStore } from '@/store/user'

import { navigateToLogin } from '@/utils/auth'
import { cn } from '@/utils/className'
import { toast } from '@/utils/ui/toast'
import './style.css'

export interface IHomeChatProps {
  /** 登录检查回调 */
  onLoginRequired?: () => void
  /** 自定义类名 */
  className?: string
  /** 外部设置的提示词 */
  externalPrompt?: string
  /** 外部设置的素材图片列表 */
  externalMaterials?: string[]
  /** 清除外部提示词的回调 */
  onClearExternalPrompt?: () => void
  /** 从任务页面跳转带来的任务ID，优先显示在输入框 */
  agentTaskId?: string
}

/** HomeChat 组件的 ref 接口 */
export interface IHomeChatRef {
  /** 处理文件拖拽上传 */
  handleFileDrop: (files: FileList) => void
}

/**
 * HomeChat - 首页Chat组件
 */
export const HomeChat = forwardRef<IHomeChatRef, IHomeChatProps>(
  ({ onLoginRequired, className, externalPrompt, externalMaterials, onClearExternalPrompt, agentTaskId }, ref) => {
    const { t } = useTransClient('chat')
    const { t: tHome } = useTransClient('home')
    const router = useRouter()
    const platformList = usePlatformInfoList('all')
    const { lng } = useParams()
    const isAuthenticated = useUserStore(state => state.isAuthenticated)

    // 获取默认提示文本
    const defaultPrompt
      = t('input.placeholder') || 'Help me create a cat dancing video and post it directly on YouTube'

    // 状态 - 初始为空，使用 placeholder 显示提示文本
    const [inputValue, setInputValue] = useState('')

    useEffect(() => {
      if (externalPrompt) setInputValue(externalPrompt)
      if (agentTaskId) setInputValue(previous => (externalPrompt || previous) + ' · 关联任务 ' + agentTaskId)
      if (externalMaterials?.length) toast.info('画廊示例仅供预览与提示参考；请自行选择当前会员的本站资料记录')
      if (externalPrompt || externalMaterials?.length) onClearExternalPrompt?.()
    }, [externalPrompt, externalMaterials, onClearExternalPrompt, agentTaskId])
    const [isSubmitting, setIsSubmitting] = useState(false)

    // 频道管理器
    const { openConnectList } = useChannelManagerStore(
      useShallow(state => ({
        openConnectList: state.openConnectList,
      })),
    )

    // 处理添加账号点击 - 未登录时跳转登录页
    const handleAddChannelClick = useCallback(() => {
      if (!isAuthenticated) {
        navigateToLogin()
        return
      }
      openConnectList()
    }, [isAuthenticated, openConnectList])

    // 使用媒体上传 Hook
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

    // 暴露方法给父组件（用于全屏拖拽上传）
    useImperativeHandle(
      ref,
      () => ({
        handleFileDrop: (files: FileList) => {
          handleMediasChange(files)
        },
      }),
      [handleMediasChange],
    )

    const searchParams = useSearchParams()
    useEffect(() => { const value = searchParams.get('prompt') || searchParams.get('description'); if (value) setInputValue(value) }, [searchParams])

    // 全局 Store
    const { createTask, setActionContext } = useAgentStore()

    /**
     * 设置 Action 上下文（用于处理任务结果的 action）
     */
    useEffect(() => {
      setActionContext({
        router,
        lng: lng as string,
        t: tHome,
      })
    }, [router, lng, tHome, setActionContext])

    const handleSend = useCallback(async () => {
      if (!isAuthenticated) { onLoginRequired?.(); navigateToLogin(); return }
      if (!inputValue.trim() || isSubmitting) return
      setIsSubmitting(true)
      try {
        const taskId = await createTask({ prompt: inputValue, medias: [...medias], t: t as (key: string) => string, onTaskIdReady: id => router.push('/' + lng + '/chat/' + id) })
        if (taskId) { setInputValue(''); clearMedias() }
      } catch (error) { toast.info(error instanceof Error ? error.message : '原任务结果待核对，已保留输入') }
      finally { setIsSubmitting(false) }
    }, [isAuthenticated, onLoginRequired, inputValue, medias, isSubmitting, createTask, t, router, lng, clearMedias])

    return (
      <div className={cn('w-full max-w-3xl mx-auto', className)}>
        {/* 标题区域 */}
        <div className="text-center mb-6 px-4">
          <h1 className="text-[32px] text-foreground font-semibold leading-[1.35] tracking-tight">
            {tHome('agentGenerator.subtitle')}
          </h1>
          <p className="mt-3 text-sm leading-6 text-muted-foreground">{t('input.helper')}</p>
        </div>

        {/* 聊天输入框 */}
        <ChatInput
          value={inputValue}
          onChange={setInputValue}
          onSend={handleSend}
          medias={medias}
          onMediasChange={handleMediasChange}
          onMediaRemove={handleMediaRemove}
          onMediaUpdate={handleMediaUpdate}
          isGenerating={isSubmitting}
          isUploading={isUploading}
          placeholder={defaultPrompt}
          mode="large"
        />

        {/* 平台工具链接提示 */}
        <button
          type="button"
          aria-label={t('input.manageChannels')}
          className="mt-4 flex w-full items-center gap-3 rounded-xl border border-border/60 bg-muted/30 px-4 py-3 text-left transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30"
          onClick={handleAddChannelClick}
        >
          <span className="text-sm text-muted-foreground whitespace-nowrap">
            {t('home.connectTools')}
          </span>
          <div className="flex items-center gap-1.5 flex-wrap">
            {platformList.map(platformInfo => (
              <PlatformIcon
                platform={platformInfo.type}
                key={platformInfo.type}
                width={24}
                height={24}
                className="w-6 h-6 rounded-full object-contain hover:scale-110 hover:opacity-80 transition-all"
                title={platformInfo.name}
              />
            ))}
          </div>
        </button>

      </div>
    )
  },
)

export default HomeChat

HomeChat.displayName = 'HomeChat'
