import { nativeBulkItems, nativeCrud, NativeDeletePreviewSchema, type NativeDeletePreview } from '@/integration/native-crud'
import { assertHostSession, getHostSessionRevision } from '@/integration/host-session'
import { VideoGrabFrame } from '@/components/PublishDialog/PublishDialog.util'
import { nativeExpectedRevisions } from '@/integration/native-revisions'
import { uploadNativeAsset } from '@/integration/native-assets'
import type { CreateMaterialGroupParams, CreateMaterialGroupVo, CreateMaterialParams, GetMaterialGroupBySceneParams, MaterialGroupBySceneData, MaterialGroupListFilters, MaterialGroupListVo, MaterialGroupSceneVo, MaterialListFilters, MaterialListQueryParams, MaterialListVo, MaterialOpenApiResponse, MediaListFilters, MediaListResponse, OptimalMaterialVo, PromotionMaterial, TransferMaterialParams, TransferMediaParams, TransferMediaResult, UpdateMaterialGroupParams, UpdateMaterialParams, UploadToOssOptions } from './material.types'
import type { PlatType } from '@/app/config/platConfig'
import { optimizeImageForUpload } from '@/utils/media'
import http from '@/utils/request'

// Source: assets.ts
/**
 * Get Video Thumbnail
 * Get or extract thumbnail from a video by URL. If thumbnail already exists in metadata.cover, returns it directly. Otherwise extracts a new thumbnail.
 */
export async function getVideoThumbnail(url: string, timeInSeconds = 1) {
  const owner = assertHostSession().user.id; const revision = getHostSessionRevision()
  const frame = await VideoGrabFrame(url, timeInSeconds)
  assertHostSession(owner, revision)
  return { code: 0, data: { thumbnailUrl: frame.cover.imgUrl }, message: '', url: '' }
}

/** Original upload UI delegates to the main-site asset ledger, then verifies official confirmation. */
export async function uploadToOss(file: File | Blob, options?: UploadToOssOptions | ((prog: number) => void)): Promise<string> {
  const opts = typeof options === 'function' ? { onProgress: options } : options || {}
  if (opts.publicUploadId) throw new Error('本站原生工作台不开放匿名上传，请通过会员作品上传')
  const uploadFile = await optimizeImageForUpload(file, { signal: opts.signal })
  return uploadNativeAsset(uploadFile, opts)
}

/**
 * 批量删除媒体资源
 * 根据ID列表批量删除媒体资源。
 */
export function batchDeleteMedia(ids: string[]) {
  return nativeCrud('DELETE', 'media/ids', { items: nativeBulkItems(ids).map(({ id, expectedRevision }) => ({ id, expectedRevision })) })
}

/**
 * 媒体资源转移到其他分组
 * 将媒体资源移动或复制到目标媒体分组。move 模式直接移动，copy 模式复制并重置使用次数。
 */
export function transferMedia(data: TransferMediaParams) {
  const { ids, ...rest } = data
  return nativeCrud<TransferMediaResult>('POST', 'media/transfer', { ...rest, items: nativeBulkItems(ids).map(({ id, expectedRevision }) => ({ id, expectedRevision })), expectedTargetCollectionRevision: nativeExpectedRevisions(data.targetGroupId).expectedRevision })
}

/**
 * 获取媒体资源列表
 * 分页获取媒体资源列表。
 */
export function getMediaList(
  filter: MediaListFilters,
  pageNo: number,
  pageSize: number,
  type?: 'video' | 'img',
) {
  return http.get<MediaListResponse>(`media/list/${pageNo}/${pageSize}`, {
    ...filter,
    ...(type ? { type } : {}),
  })
}

// Source: material.ts
/**
 * 创建草稿分组
 * 使用提供的元数据创建新的草稿分组。
 */
export function apiCreateMaterialGroup(data: CreateMaterialGroupParams) {
  return nativeCrud<CreateMaterialGroupVo>('POST', 'material/group', {
    ...data,
  })
}

/**
 * 删除草稿分组
 * 根据ID删除草稿分组。
 */
export function apiDeleteMaterialGroup(id: string) {
  return nativeCrud('DELETE', `material/group/${id}`, nativeExpectedRevisions(id))
}

/**
 * 更新草稿分组信息
 * 更新草稿分组的详情。
 */
export function apiUpdateMaterialGroupInfo(
  id: string,
  data: UpdateMaterialGroupParams,
  loaded?: { nativeRevision?: number, nativeMetadataRevision?: number },
) {
  return nativeCrud('POST', `material/group/info/${id}`, { ...data, ...nativeExpectedRevisions(id, loaded) })
}

/**
 * 获取草稿分组列表
 * 分页获取草稿分组列表，包含关联的店铺信息。
 */
export function apiGetMaterialGroupList(pageNo: number, pageSize: number, filters?: MaterialGroupListFilters) {
  return http.get<MaterialGroupListVo>(`material/group/list/${pageNo}/${pageSize}`, filters)
}

/**
 * 获取草稿分组详情
 * 根据ID获取草稿分组详情。
 */
export function apiGetMaterialInfo(id: string) {
  return http.get(`material/group/info/${id}`)
}

/**
 * 创建草稿
 * 使用提供的媒体和元数据创建草稿。
 */
export function apiCreateMaterial(
  data: CreateMaterialParams,
  silent?: boolean,
) {
  void silent
  return nativeCrud('POST', 'material', data)
}

/**
 * 删除草稿
 * 根据ID删除草稿。
 */
export function apiDeleteMaterial(id: string) {
  return nativeCrud('DELETE', `material/${id}`, nativeExpectedRevisions(id))
}

/**
 * 批量删除草稿
 * 根据ID列表批量删除草稿。
 */
export function apiBatchDeleteMaterials(ids: string[]) {
  return nativeCrud('DELETE', 'material/list', { items: nativeBulkItems(ids) })
}

/**
 * 草稿转移到其他草稿箱
 * 将草稿移动或复制到目标草稿箱。move 模式直接移动，copy 模式复制并重置使用次数。
 */
export function apiTransferMaterials(data: TransferMaterialParams & { mediaIds?: string[], expectedTargetCollectionRevision?: number }) {
  const { ids, mediaIds = [], ...rest } = data
  return nativeCrud<TransferMediaResult>('POST', 'material/transfer', { ...rest, items: nativeBulkItems(ids), mediaItems: nativeBulkItems(mediaIds).map(({ id, expectedRevision }) => ({ id, expectedRevision })), expectedTargetCollectionRevision: data.expectedTargetCollectionRevision ?? nativeExpectedRevisions(data.targetGroupId).expectedRevision })
}

/**
 * 按条件删除草稿
 * 删除符合筛选条件的草稿。
 */
export function apiFilterDeleteMaterials(data: NativeDeletePreview) {
  if (!data.canApply || data.hasMore || !data.selectionHash) throw new Error('请先缩小筛选并读取完整删除预览')
  return nativeCrud('DELETE', 'material/filter', { items: data.items, selectionHash: data.selectionHash })
}
export async function apiPreviewDeleteMaterials(groupId: string, filters: MaterialListFilters) {
  const response = await http.get('material/filter/preview', { groupId, ...filters })
  return NativeDeletePreviewSchema.parse(response.data)
}

/**
 * 获取草稿列表
 * 分页获取草稿列表，支持筛选条件。
 */
export async function apiGetMaterialList(groupId: string, pageNo: number, pageSize: number, filters?: MaterialListFilters) {
  const params: MaterialListQueryParams = { groupId }
  if (filters?.title)
    params.title = filters.title
  if (filters?.useCount !== undefined)
    params.useCount = filters.useCount
  const res = await http.get<MaterialListVo>(`material/list/${pageNo}/${pageSize}`, params)

  const list = res?.data?.list
  // 兼容代码，图文草稿补封面
  if (list && list.length > 0) {
    list.map((item) => {
      if (item.mediaList?.[0]?.type === 'img') {
        item.coverUrl = item.mediaList[0].url
      }
    })
  }
  return res
}

/**
 * 获取草稿详情
 * 根据ID获取草稿详情。
 */
export function apiGetDraftInfo(id: string) {
  return http.get<PromotionMaterial>(`material/info/${id}`)
}

/**
 * 更新草稿信息
 * 根据ID更新草稿详情。
 */
export function apiUpdateMaterial(
  id: string,
  data: UpdateMaterialParams,
  loaded?: { nativeRevision?: number, nativeMetadataRevision?: number },
) {
  return nativeCrud('PUT', `material/info/${id}`, { ...data, ...nativeExpectedRevisions(id, loaded) })
}

/**
 * 通过素材组ID获取最优素材（公开接口，无需认证）
 * @param groupId 素材组ID（即推广码）
 * @param accountType 平台类型，用于筛选匹配的素材
 */
export function apiGetOptimalMaterial(groupId: string, accountType: PlatType) {
  return http.get<OptimalMaterialVo>('/material/optimal', { groupId, accountType })
}

/**
 * 按使用场景查询素材组
 * 公开接口，用于按使用场景与关联 ID 解析第一个素材组。
 */
export async function apiGetMaterialGroupByScene(
  params: GetMaterialGroupBySceneParams,
  silent?: boolean,
): Promise<MaterialOpenApiResponse<MaterialGroupSceneVo | null>> {
  const res = await http.get<MaterialGroupBySceneData>('/material/group/by-scene', params, silent)
  if (!res)
    return res

  return {
    ...res,
    data: Array.isArray(res.data) ? res.data[0] ?? null : res.data,
  }
}
