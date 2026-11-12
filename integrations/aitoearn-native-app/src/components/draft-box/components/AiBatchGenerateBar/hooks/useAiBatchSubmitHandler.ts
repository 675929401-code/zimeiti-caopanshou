import { useDraftGenerationPricing } from '@/hooks/useDraftGenerationPricing'
import { confirm } from '@/utils/ui/confirm'
import type { getVideoModelsCommonStaticConfig } from '../utils/constants'
import type { DraftContentType, ImageModelPricing, ImageModelType, ImageTextDraftType, VideoDraftType, VideoModelType } from '@/api/ai/ai.types'
import type { PlatType } from '@/app/config/platConfig'
import type { IUploadedMedia } from '@/components/Chat/MediaUpload'
import type { VideoModelParams } from '@/store/draft-box/draftBoxConfigStore'
import { createElement, useCallback } from 'react'
import { NativeAiBatchPanel, type NativeAiBatchDraft } from '@/integration/NativeAiBatchPanel'
import { NativePlatformSchema } from '@host-publishing/native-operations-contract'
import { toast } from '@/utils/ui/toast'

type Translate = (key: string, options?: Record<string, number | string | undefined>) => string
type VideoModelConfig = ReturnType<typeof getVideoModelsCommonStaticConfig>

interface BatchGenerationResult {
  success: boolean
  successCount: number
  failedCount: number
  errorMessage?: string
}

interface VideoModelInput {
  modelType: VideoModelType
  resolution?: string
  duration?: number
  aspectRatio?: string
}

interface UseAiBatchSubmitHandlerParams {
  isUploading: boolean
  promptValue: string
  isDraftMode: boolean
  captionSystemPrompt: string
  localImages: IUploadedMedia[]
  localVideos: IUploadedMedia[]
  localAudios: IUploadedMedia[]
  contentType: DraftContentType
  selectedImageModels: ImageModelType[]
  selectedVideoModels: VideoModelType[]
  videoModelSelectionMode: 'single' | 'multiple'
  currentImageAspectRatios: string[]
  imagePricing: ImageModelPricing[]
  currentVideoModelConfig: VideoModelConfig
  resolvedVideoModelParams: Record<string, VideoModelParams>
  effectiveQuantity: number
  imageCount: number
  aspectRatio: string
  duration: number
  groupId?: string
  imageSize: string
  effectiveSelectedPlatforms: PlatType[]
  createImageTextBatchGenerationWithModels: (
    quantity: number,
    models: ImageModelType[],
    prompt: string,
    imageCount: number,
    aspectRatio: string,
    imageUrls: string[] | undefined,
    groupId: string | undefined,
    imageSize: string,
    platforms: PlatType[] | undefined,
    mode: ImageTextDraftType,
    captionPrompt: string | undefined,
  ) => Promise<BatchGenerationResult>
  createBatchGenerationWithModels: (
    quantity: number,
    modelInputs: VideoModelInput[],
    duration: number,
    aspectRatio: string,
    prompt: string | undefined,
    imageUrls: string[] | undefined,
    videoUrls: string[] | undefined,
    audioUrls: string[] | undefined,
    groupId: string | undefined,
    platforms: PlatType[] | undefined,
    mode: VideoDraftType,
    captionPrompt: string | undefined,
  ) => Promise<BatchGenerationResult>
  onGenerated?: () => void
  t: Translate
}

export function useAiBatchSubmitHandler(params: UseAiBatchSubmitHandlerParams) {
  const { pricingData } = useDraftGenerationPricing()
  return useCallback(async () => {
    if (params.isUploading) { toast.warning(params.t('detail.mediaUploading')); return }
    if (!params.promptValue.trim()) { toast.warning(params.t('detail.promptRequired')); return }
    if (!params.groupId) { toast.warning('请先选择要保存内容的草稿箱'); return }
    if (params.localImages.length || params.localVideos.length || params.localAudios.length) { toast.warning('本次内容计划按文字生成。所选参考素材尚未纳入计划，请先移除后继续，避免遗漏您的参考要求。'); return }
    if (!Number.isInteger(params.effectiveQuantity) || params.effectiveQuantity < 1 || params.effectiveQuantity > 10) { toast.warning('每个模型批次支持1到10份内容，请调整数量'); return }
    const platforms = params.effectiveSelectedPlatforms.map(value => NativePlatformSchema.parse(value))
    const drafts: NativeAiBatchDraft[] = []
    if (params.contentType === 'image_text') {
      if (!params.selectedImageModels.length) { toast.warning(params.t('detail.selectModelRequired')); return }
      if (!Number.isInteger(params.imageCount) || params.imageCount < 1 || params.imageCount > 9 || !params.aspectRatio || !params.imageSize) { toast.warning('请先选择有效的图片数量、比例和尺寸'); return }
      for (const name of [...new Set(params.selectedImageModels)]) {
        const model = pricingData?.imageModels.find(item => item.model === name)
        if (!model?.nativeModelId || model.generationReady !== true || model.priceReady !== true) { toast.warning(`${model?.displayName || name}的报价或生成服务尚未就绪，目录仍会保留，请调整选择后继续`); return }
        drafts.push({ mode: 'image_text', collectionId: params.groupId, prompt: params.promptValue.trim(), captionPrompt: params.isDraftMode ? params.captionSystemPrompt.trim() : '', quantity: params.effectiveQuantity, imageCount: params.imageCount, generationModelId: model.nativeModelId, modelName: model.displayName || name, options: { aspectRatio: params.aspectRatio, resolution: params.imageSize, duration: null }, platforms })
      }
    } else {
      if (!params.selectedVideoModels.length) { toast.warning(params.t('detail.selectModelRequired')); return }
      for (const name of [...new Set(params.selectedVideoModels)]) {
        const model = pricingData?.videoModels?.find(item => item.name === name), selected = params.resolvedVideoModelParams[name]
        if (!model?.nativeModelId || model.generationReady !== true || model.priceReady !== true) { toast.warning(`${name}的报价或生成服务尚未就绪，目录仍会保留，请调整选择后继续`); return }
        const resolution = selected?.resolution || model.defaults?.resolution, duration = selected?.duration ?? params.duration, aspectRatio = selected?.aspectRatio || params.aspectRatio
        if (!resolution || !aspectRatio || !duration || !Number.isInteger(duration) || duration < 1 || duration > 120) { toast.warning('请为每个视频模型选择有效的比例、时长和分辨率'); return }
        drafts.push({ mode: 'video', collectionId: params.groupId, prompt: params.promptValue.trim(), captionPrompt: params.isDraftMode ? params.captionSystemPrompt.trim() : '', quantity: params.effectiveQuantity, imageCount: null, generationModelId: model.nativeModelId, modelName: name, options: { aspectRatio, resolution, duration }, platforms })
      }
    }
    await confirm({ title: '预览批量内容计划', content: createElement(NativeAiBatchPanel, { drafts, onCompleted: params.onGenerated }), okText: '关闭计划窗口', cancelText: null, className: 'max-w-4xl' })
  }, [params, pricingData])
}
