/**
 * ConditionalDeleteDialog - 按条件删除草稿弹窗
 * 外层控制渲染，内层使用 hooks（避免 useTransClient 动态加载闪烁）
 */

'use client'

import type { NativeDeletePreview } from '@/integration/native-crud'

import type { MaterialListFilters } from '@/api/materials/material.types'
import { Loader2 } from 'lucide-react'
import { memo, useCallback, useEffect, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { apiPreviewDeleteMaterials } from '@/api/materials/material.api'
import { useTransClient } from '@/app/i18n/client'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { NumberInput } from '@/components/ui/number-input'
import { usePlanDetailStore } from '@/store/draft-box/planDetailStore'
import { toast } from '@/utils/ui/toast'

// 外层：控制渲染时机
const ConditionalDeleteDialog = memo(() => {
  const { open, closeDialog } = usePlanDetailStore(
    useShallow(state => ({
      open: state.conditionalDeleteDialogOpen,
      closeDialog: state.closeConditionalDeleteDialog,
    })),
  )

  if (!open)
    return null

  return (
    <ConditionalDeleteDialogContent onOpenChange={(v) => {
      if (!v)
        closeDialog()
    }}
    />
  )
})

ConditionalDeleteDialog.displayName = 'ConditionalDeleteDialog'

// 内层：使用 hooks
const ConditionalDeleteDialogContent = memo(({ onOpenChange }: { onOpenChange: (open: boolean) => void }) => {
  const { t } = useTransClient('brandPromotion')

  const { currentPlan, filterDeleteMaterials } = usePlanDetailStore(
    useShallow(state => ({
      currentPlan: state.currentPlan,
      filterDeleteMaterials: state.filterDeleteMaterials,
    })),
  )

  const [title, setTitle] = useState('')
  const [useCount, setUseCount] = useState<number | undefined>()
  const [matchCount, setMatchCount] = useState<number | null>(null)
  const [preview, setPreview] = useState<NativeDeletePreview | null>(null)
  const previewGeneration = useRef(0)
  const [querying, setQuerying] = useState(false)
  const [deleting, setDeleting] = useState(false)

  const hasCondition = title.trim() !== '' || useCount !== undefined

  // 构建筛选条件
  const buildFilters = useCallback((): MaterialListFilters => {
    const filters: MaterialListFilters = {}
    if (title.trim())
      filters.title = title.trim()
    if (useCount !== undefined)
      filters.useCount = useCount
    return filters
  }, [title, useCount])

  useEffect(() => {
    const generation = ++previewGeneration.current
    setPreview(null); setMatchCount(null)
    if (!currentPlan || !hasCondition) { setQuerying(false); return }
    setQuerying(true)
    const timer = setTimeout(async () => {
      try {
        const result = await apiPreviewDeleteMaterials(currentPlan.id, buildFilters())
        if (generation !== previewGeneration.current) return
        setPreview(result); setMatchCount(result.count)
      } catch { if (generation === previewGeneration.current) { setPreview(null); setMatchCount(null) } }
      finally { if (generation === previewGeneration.current) setQuerying(false) }
    }, 500)
    return () => { clearTimeout(timer); ++previewGeneration.current }
  }, [currentPlan, hasCondition, buildFilters])

  const handleDelete = useCallback(async () => {
    if (!preview?.canApply || preview.hasMore || !preview.selectionHash || preview.count === 0)
      return
    setDeleting(true)
    try {
      const success = await filterDeleteMaterials(preview)
      if (success) {
        toast.success(t('draftManage.conditionalDeleteSuccess'))
      }
      else {
        toast.error(t('draftManage.conditionalDeleteFailed'))
      }
    }
    finally {
      setDeleting(false)
    }
  }, [preview, filterDeleteMaterials, t])

  const deleteDisabled = querying || deleting || !preview?.canApply || preview.hasMore || !preview.selectionHash || preview.count === 0

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent data-testid="draftbox-cond-delete-dialog" className="max-w-[420px]">
        <DialogHeader>
          <DialogTitle>{t('draftManage.conditionalDeleteTitle')}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label>{t('draftManage.conditionTitle')}</Label>
            <Input
              data-testid="draftbox-cond-title-input"
              value={title}
              onChange={e => setTitle(e.target.value)}
              placeholder={t('draftManage.conditionTitlePlaceholder')}
            />
          </div>

          <div className="space-y-2">
            <Label>{t('draftManage.conditionUseCount')}</Label>
            <NumberInput
              data-testid="draftbox-cond-usecount-input"
              value={useCount}
              onValueChange={v => setUseCount(v)}
              decimalScale={0}
              allowNegative={false}
              placeholder={t('draftManage.conditionUseCountPlaceholder')}
            />
          </div>

          <p className="text-xs text-muted-foreground">使用次数按官方确认发布累计，筛选为大于或等于所填次数；浏览器报告另列，不作为官方确认。删除仅应用本次冻结预览。</p>
          {preview?.hasMore && <p className="text-sm text-destructive">匹配超过 100 条，请缩小条件后再确认。</p>}
          <div data-testid="draftbox-cond-match-count" className="rounded-md bg-muted p-3 text-sm">
            {!hasCondition && (
              <span className="text-muted-foreground">{t('draftManage.setConditionHint')}</span>
            )}
            {hasCondition && querying && (
              <span className="text-muted-foreground flex items-center gap-2">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                {t('draftManage.matchCountLoading')}
              </span>
            )}
            {hasCondition && !querying && matchCount !== null && (
              <span className={matchCount > 0 ? 'text-destructive font-medium' : 'text-muted-foreground'}>
                {t('draftManage.matchCount', { count: matchCount })}
              </span>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} className="cursor-pointer">
            {t('draftManage.cancel')}
          </Button>
          <Button
            data-testid="draftbox-cond-delete-confirm-btn"
            variant="destructive"
            onClick={handleDelete}
            disabled={deleteDisabled}
            className="cursor-pointer gap-1.5"
          >
            {deleting && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {t('common.delete')}
            {matchCount !== null && matchCount > 0 && ` (${matchCount})`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
})

ConditionalDeleteDialogContent.displayName = 'ConditionalDeleteDialogContent'

export { ConditionalDeleteDialog }
