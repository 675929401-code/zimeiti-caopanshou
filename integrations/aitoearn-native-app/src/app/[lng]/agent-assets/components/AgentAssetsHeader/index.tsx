/**
 * AgentAssetsHeader - AI 生成素材页顶部组件
 * 包含返回按钮、标题（只读模式，无上传按钮）
 */

'use client'

import { useGetClientLng } from '@/hooks/useSystem'
import { ArrowLeft, Bot } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useCallback } from 'react'
import { useTransClient } from '@/app/i18n/client'
import { Button } from '@/components/ui/button'

interface AgentAssetsHeaderProps {
  /** 总数量 */
  total: number | null
}

export function AgentAssetsHeader({ total }: AgentAssetsHeaderProps) {
  const { t } = useTransClient('material')
  const router = useRouter()
  const lng = useGetClientLng()

  // 返回内容管理
  const handleBack = useCallback(() => {
    router.push('/' + lng + '/draft-box')
  }, [router, lng])

  return (
    <header className="sticky top-0 z-10 flex items-center justify-between px-4 py-3 bg-card border-b border-border">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" onClick={handleBack} className="w-8 h-8 cursor-pointer">
          <ArrowLeft className="w-5 h-5" />
        </Button>

        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-lg bg-gradient-back text-gradient-foreground flex items-center justify-center shadow-sm shadow-primary/20">
            <Bot className="w-4 h-4" />
          </div>
          <h1 className="text-lg font-semibold text-foreground">{t('agentAssets.title')}</h1>
        </div>

        {total !== null && total > 0 && (
          <span className="text-sm text-muted-foreground">
            (
            {total}
            )
          </span>
        )}
      </div>

      {/* 只读模式：无上传按钮 */}
    </header>
  )
}
