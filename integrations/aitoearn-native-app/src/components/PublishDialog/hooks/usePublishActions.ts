/** Original PublishDialog actions, adapted to durable main-site snapshots and execution grants. */
import type { PubItem, IPubParams } from '@/components/PublishDialog/publishDialog.type'
import type { PlatformPublishTask } from '@/store/plugin'
import { useCallback } from 'react'
import { PlatType } from '@/app/config/platConfig'
import { useCalendarTiming } from '@/app/[lng]/accounts/components/CalendarTiming/useCalendarTiming'
import { usePublishDialog } from '@/components/PublishDialog/usePublishDialog'
import { PlatformTaskStatus, PLUGIN_SUPPORTED_PLATFORMS, usePluginStore } from '@/store/plugin'
import { buildNativePublishPlan } from '@/integration/native-publish-plan'
import { confirmNativeOfficialMainMedia } from '@/integration/native-media-bridge-client'
import { assertNativeRemainingQuota, executeNativePublishing, prepareNativePublishing, readNativePending, readNativePublishingCenter, type NativePublishUpdate } from '@/integration/native-publishing'
import { assertHostSession, getHostSession, getHostSessionRevision } from '@/integration/host-session'
import { confirm } from '@/utils/ui/confirm'
import { toast } from '@/utils/ui/toast'

interface UsePublishActionsParams {
  pubListChoosed: PubItem[]; pubTime?: string; suppressAutoPublish?: boolean; taskIdForPublish?: string; materialGroupIdForPublish?: string; materialIdForPublish?: string; materialVersionForPublish?: number
  onPublishConfirmed?: (taskId?: string, publishRecordId?: string) => void; onPublishStart?: () => void; onClose(): void; onPubSuccess?: () => void
  setCreateLoading(value: boolean): void; setCurrentPublishTaskId(value: string | undefined): void; setPublishDetailVisible(value: boolean): void; t(key: string, params?: Record<string, string>): string
}
export function isPluginSupportedPlatform(platform: PlatType | string) { return PLUGIN_SUPPORTED_PLATFORMS.some(value => value === platform) }
function copyParams(params: IPubParams): IPubParams { return { ...params, topics: [...(params.topics || [])], option: structuredClone(params.option), ...(params.images ? { images: params.images.map(image => ({ ...image })) } : {}), ...(params.video ? { video: { ...params.video, cover: { ...params.video.cover } } } : {}) } }
export function usePublishActions({ pubListChoosed, pubTime, taskIdForPublish, materialGroupIdForPublish, materialIdForPublish, materialVersionForPublish, onPublishConfirmed, onPublishStart, onClose, onPubSuccess, setCreateLoading, setCurrentPublishTaskId, setPublishDetailVisible }: UsePublishActionsParams) {
  const pubClick = useCallback(async () => {
    const session = assertHostSession(); const generation = getHostSessionRevision()
    if (readNativePending()) { toast.warning('有一笔原提交需要核对，请在发布进度中核对原任务；不会再次发布'); return }
    const items = pubListChoosed.map(item => ({ account: { ...item.account }, params: copyParams(item.params) }))
    const common = copyParams(usePublishDialog.getState().commonPubParams)
    const approved = await confirm({ title: '核对本次发布', content: `将按当前内容为 ${items.length} 个账号分别准备执行，每个账号受理最多消耗 1 次主站发布额度。小红书/视频号会核对当前浏览器 UID；抖音受理后仍需手机接力。结果未知时只核对原任务。`, okText: '确认内容与账号，继续', cancelText: '返回检查' })
    if (!approved) return
    assertHostSession(session.user.id, generation)
    setCreateLoading(true)
    let taskId: string | undefined
    try {
      await confirmNativeOfficialMainMedia(items)
      const built = await buildNativePublishPlan({ items, common, ...(pubTime ? { publishAt: pubTime } : {}), ...(materialGroupIdForPublish ? { collectionId: materialGroupIdForPublish } : {}), ...(materialIdForPublish && materialVersionForPublish ? { sourceDraftId: materialIdForPublish, sourceDraftVersion: materialVersionForPublish } : {}) })
      const prepared = await prepareNativePublishing(built.plan)
      await assertNativeRemainingQuota(prepared, await readNativePublishingCenter())
      assertHostSession(session.user.id, generation)
      const platformTasks: PlatformPublishTask[] = prepared.groups.flatMap(group => [
        ...group.draft.payload.targets.map(target => ({ id: target.id, platform: target.platform as PlatType, accountId: target.accountId, publishMode: 'auto' as const, params: { platform: target.platform as PlatType, type: group.key, title: target.titleOverride ?? group.draft.payload.title, desc: target.bodyOverride ?? group.draft.payload.body, topics: target.topicsOverride ?? group.draft.payload.topics }, status: PlatformTaskStatus.PENDING, progress: null, result: null, startTime: null, endTime: null, error: null })),
        ...group.officialTargets.map(target => ({ id: target.targetId, platform: PlatType.Douyin, accountId: target.intent.payload.bindingId, publishMode: 'user_action' as const, params: { platform: PlatType.Douyin, type: group.key, title: target.intent.payload.titleOverride ?? group.draft.payload.title, desc: target.intent.payload.bodyOverride ?? group.draft.payload.body, topics: target.intent.payload.topicsOverride ?? group.draft.payload.topics }, status: PlatformTaskStatus.PENDING, progress: null, result: null, startTime: null, endTime: null, error: null })),
      ])
      const plugin = usePluginStore.getState()
      taskId = plugin.addPublishTask({ title: common.title || common.des.slice(0, 30) || '发布准备', description: '主站不可变版本与独立执行许可', platformTasks })
      const currentTaskId = taskId
      setCurrentPublishTaskId(taskId); setPublishDetailVisible(true); onPublishStart?.(); onClose()
      const states = new Map<string, NativePublishUpdate>()
      await executeNativePublishing(prepared, built.files, value => {
        assertHostSession(session.user.id, generation); states.set(value.targetId, value)
        const complete = value.state === 'browser_reported' || value.state === 'published'
        usePluginStore.getState().updatePlatformTask(currentTaskId, value.targetId, { status: complete ? PlatformTaskStatus.COMPLETED : value.state === 'publishing' ? PlatformTaskStatus.PUBLISHING : value.state === 'failed' ? PlatformTaskStatus.ERROR : value.state === 'unknown' ? PlatformTaskStatus.UNKNOWN : PlatformTaskStatus.PENDING, ...(value.recordId ? { publishRecordId: value.recordId } : {}), ...(value.userAction ? { userAction: value.userAction } : {}), error: value.message || null, progress: value.progress ? { ...value.progress, timestamp: Date.now(), message: value.message || '正在核对原执行' } : complete ? { stage: 'complete', progress: 100, timestamp: Date.now(), message: value.state === 'browser_reported' ? '浏览器报告已完成，请核对平台作品' : '官方报告作品已发布' } : null, result: value.receipt || null, endTime: complete || value.state === 'failed' ? Date.now() : null })
      })
      assertHostSession(session.user.id, generation)
      await useCalendarTiming.getState().getPubRecord()
      if ([...states.values()].length && [...states.values()].every(value => value.state === 'published')) { onPublishConfirmed?.(taskIdForPublish, [...states.values()][0]?.recordId); onPubSuccess?.() }
      toast.success('原提交记录已保存。浏览器报告与官方接力状态请在详情和发布日历中继续核对。')
    } catch (reason) {
      if (session.user.id === getHostSession()?.user.id && generation === getHostSessionRevision()) {
        const message = reason instanceof Error ? reason.message : '原提交结果待核对，请勿重发'
        toast.warning(message)
        if (taskId && readNativePending()) for (const target of usePluginStore.getState().getPublishTask(taskId)?.platformTasks || []) if (target.status === PlatformTaskStatus.PUBLISHING) usePluginStore.getState().updatePlatformTask(taskId, target.id, { status: PlatformTaskStatus.UNKNOWN, error: message })
      }
    } finally { if (generation === getHostSessionRevision()) setCreateLoading(false) }
  }, [pubListChoosed, pubTime, materialGroupIdForPublish, materialIdForPublish, materialVersionForPublish, taskIdForPublish, onPublishConfirmed, onPublishStart, onClose, onPubSuccess, setCreateLoading, setCurrentPublishTaskId, setPublishDetailVisible])
  return { pubClick, isPluginSupportedPlatform }
}
