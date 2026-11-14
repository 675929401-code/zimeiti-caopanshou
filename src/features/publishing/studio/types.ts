import type { NativePlatformSchema } from '@/lib/native-operations-contract'
import type { z } from 'zod'
import type { PublishingPlatformMetadata } from '@/lib/publishing-generic-contract'

export type StudioPlatformKey = z.infer<typeof NativePlatformSchema>
export interface StudioMedia {
  id: string; name: string; url?: string; kind: 'video' | 'image'; size: number
  width?: number; height?: number; duration?: number
  status: 'reading' | 'ready' | 'uploading' | 'error'; error?: string; progress?: number
  file?: File; nativeMediaEntryId?: string; stage?: 'local' | 'main' | 'provider'
  originalFile?: { sha256?: string; type: string; size: number }
}
export interface StudioDraft {
  contentType: 'text' | 'video' | 'image'; title: string; body: string; topics: string[]
  media: StudioMedia[]; cover?: StudioMedia; publishAt?: string
  sourceDraftId?: string; sourceDraftVersion?: number; sourceMetadataRevision?: number; collectionId?: string
  studioDraftId?: string; studioDraftVersion?: number
  targetOverrides: Record<string, StudioTargetOverride>
}
export interface StudioTargetOverride { title?: string; body?: string; topics?: string[]; cover?: StudioMedia; mediaIds?: string[]; publishAt?: string; options?: StudioPlanParams['option']; providerOptions?: Record<string, unknown> }
export interface StudioAccount {
  id: string; platform: StudioPlatformKey; name: string; avatar?: string; status: string
  selected: boolean; kind: 'browser' | 'official' | 'generic'; revision: number; metadataRevision: number; uid: string
}
export interface StudioPlatform extends PublishingPlatformMetadata {
  key: StudioPlatformKey; name: string; available: boolean; connectionAllowed: boolean; reason: string
  nativeReason?: string
  executionBlocked?: boolean
  reasonCode?: 'ready' | 'connection_unavailable' | 'execution_unavailable'
  rules?: string[]
  transport?: 'browser_plugin' | 'official_api'
  channels?: Array<{ transport: 'browser_plugin' | 'official_api'; connectionAllowed: boolean; publishAllowed: boolean; reason: string; reasonCode?: 'ready' | 'connection_unavailable' | 'execution_unavailable' }>
}
export interface StudioCheck { id: string; platform?: string; label: string; status: 'pass' | 'warning' | 'error' | 'pending'; detail?: string }
export interface StudioImportItem {
  id: string; kind: 'image' | 'video' | 'draft'; title: string; url?: string; thumbnail?: string; createdAt?: string
  storage?: 'studio' | 'legacy'; revision?: number
}
export interface StudioHistoryItem {
  id: string; title: string; platform: string; accountName?: string; state: string; createdAt?: string; url?: string
  evidence?: string; message?: string; revision?: number; transport?: string; publishAt?: string
  availableActions?: StudioRecordAction[]
  operationId?: string
}
export interface StudioHistoryQuery { page?: number; pageSize?: number; from?: string; to?: string }
export type StudioRecordAction = 'refresh' | 'user_action' | 'cancel' | 'reschedule' | 'publish_now' | 'resume'
export interface StudioUserAction { recordId: string; shortLink: string; schemeUrl: string; expiresAt?: string }
export interface StudioReview {
  id: string; title: string; accountNames: string[]; mediaCount: number; contentHash: string; scheduledAt?: string
  recovery?: boolean
  cashQuote?: import('@/lib/publishing-cash-contract').PublishingCashQuote
  targets: Array<{ accountId: string; accountName: string; platform: string; title: string; body: string; topics: string[]; mediaNames?: string[]; coverName?: string; options?: Record<string, unknown>; publishAt?: string; transport: 'browser_plugin' | 'official_api'; quota: number }>
}
export interface StudioBridgeConfirmation { title: string; message: string; items: Array<{ name: string; size: number; accounts: string[] }>; confirmLabel: string; blocked: boolean }
export interface StudioAuthorization { platform: string; url?: string; state: string; sessionId: string; expiresAt?: string | null; choices: Array<{ id: string; name: string }> }
export interface PublishingStudioController {
  session: { loading: boolean; authenticated: boolean; userName?: string; cashBalance?: number; credits?: number; error?: string }
  workspace: { loading: boolean; ready: boolean; error?: string }
  publishing: { executionEnabled: boolean; announcement: string; enabledPlatforms: string[]; mode: string } | null
  draft: StudioDraft; accounts: StudioAccount[]; platforms: StudioPlatform[]; checks: StudioCheck[]
  quota: { remaining?: number; cost?: number; label?: string; canPublish: boolean; reason?: string }
  busy: string | null; error: string | null; notice: string | null; review: StudioReview | null
  pending: boolean; history: StudioHistoryItem[]; historyLoading: boolean
  historyPage: { page: number; pageSize: number; total: number; hasMore: boolean }
  recordDetail: StudioHistoryItem | null; userAction: StudioUserAction | null
  importItems: StudioImportItem[]; importLoading: boolean; importOpen: boolean
  bridgeConfirmation: StudioBridgeConfirmation | null; authorization: StudioAuthorization | null
  authorizationFlow: { platform: string; transport?: 'browser_plugin' | 'official_api'; phase: 'starting' | 'ready' | 'checking' | 'selecting' | 'error'; error?: string; errorCode?: string } | null
  patchDraft(patch: Partial<StudioDraft>): void
  patchTarget(accountId: string, patch: StudioTargetOverride): void; setTargetCover(accountId: string, file: File): Promise<void>
  addFiles(files: File[]): Promise<void>; setCover(file: File): Promise<void>; removeMedia(id: string): void
  toggleAccount(id: string): void; connectAccount(platform: string, transport?: 'browser_plugin' | 'official_api', options?: { forceNew?: boolean }): Promise<void>; refreshAccounts(): Promise<void>
  openImport(): Promise<void>; closeImport(): void; loadImport(kind?: 'media' | 'draft'): Promise<void>; importItem(id: string): Promise<void>
  checkDraft(): Promise<void>; saveDraft(): Promise<void>; publish(reviewId: string): Promise<void>; cancelReview(): void
  confirmBridge(approved: boolean): void; refreshAuthorization(): Promise<void>; selectAuthorization(ids: string[]): Promise<void>; closeAuthorization(): void
  loadHistory(query?: StudioHistoryQuery): Promise<void>; recoverPending(): Promise<void>; resetDraft(): void; dismissMessage(): void
  refreshRecord(id: string): Promise<void>; readUserAction(id: string): Promise<void>
  resumeRecord(id: string, revision: number): Promise<boolean>
  mutateRecord(action: 'cancel' | 'reschedule' | 'publish_now', id: string, revision: number, publishAt?: string): Promise<void>
  closeRecordDetail(): void
}

/** Studio-owned input DTOs. They contain no upstream component/store dependency. */
export interface StudioPlanSelection { ossUrl?: string; filename?: string; file?: File; nativeMediaEntryId?: string }
export interface StudioPlanParams {
  title?: string; des: string; topics?: string[]
  video?: StudioPlanSelection & { cover: StudioPlanSelection }; images?: StudioPlanSelection[]
  option: {
    douyin?: { short_title?: string; cover_tsp?: number; download_type?: number; private_status?: number }
    xhs?: { userDeclarationBind?: { origin: 1 | 2 | 3 } }
    wxSph?: { poiInfo?: import('@/lib/publishing-native').NativeWxPoi; activity?: import('@/lib/publishing-native').NativeWxEvent; extLink?: string; isOriginal?: boolean }
  }
}
export interface StudioPlanItem {
  publishAt?: string
  account: { id: string; type: string; nickname: string; nativeAccountKind: 'browser' | 'official' | 'generic'; nativeRevision: number; nativeDisconnected?: boolean; nativeConnectionCurrent?: boolean }
  params: StudioPlanParams
}
