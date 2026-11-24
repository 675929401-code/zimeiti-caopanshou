import { assets, assetBytes, deleteAsset, publicAsset, readAsset, storeAsset, type PublicAsset } from './assets';
import { getSupabaseAdminClient } from '@/storage/database/supabase-client';

/**
 * 带货共享素材库：归平台所有的图片/视频，供卡片图标、首页封面、演示引用。
 * 与会员私有素材隔离在固定 owner 下；读取走公开路由（内容不可变、URL 含随机 UUID）。
 */
export const SHARED_MEDIA_OWNER = 'commerce-shared-media';

export function sharedMediaUrl(id: string) { return `/api/commerce/shared-media/${id}`; }

export type SharedMediaAsset = PublicAsset & { url: string };

function present(asset: Parameters<typeof publicAsset>[0]): SharedMediaAsset {
  return { ...publicAsset(asset), url: sharedMediaUrl(asset.id) };
}

export function listSharedMedia(): SharedMediaAsset[] {
  return assets(SHARED_MEDIA_OWNER).map(present).sort((left, right) => right.createdAt - left.createdAt);
}

export function readSharedMedia(id: string) { return readAsset(id, SHARED_MEDIA_OWNER); }

export async function sharedMediaBytes(id: string) {
  const asset = readSharedMedia(id);
  if (!asset) return undefined;
  return { asset, bytes: await assetBytes(asset) };
}

export async function storeSharedMedia(bytes: Buffer, type: string, name: string): Promise<SharedMediaAsset> {
  const asset = await storeAsset(SHARED_MEDIA_OWNER, bytes, type, name, 'upload');
  return present(asset);
}

/** 返回引用此素材的卡片名称列表；有引用时禁止删除，避免线上卡片破图。 */
export async function sharedMediaReferences(id: string): Promise<string[]> {
  const db = getSupabaseAdminClient();
  const { data, error } = await db.from('commerce_card_versions').select('display').like('display->>icon', `%${id}%`);
  if (error) throw Error(`引用核对失败：${error.message}`);
  return (data || []).map((row: { display: unknown }) => String((row.display as Record<string, unknown>)?.name || '未命名卡片'));
}

export async function deleteSharedMedia(id: string) {
  const referencedBy = await sharedMediaReferences(id);
  if (referencedBy.length) throw Error(`素材正被卡片引用（${referencedBy.join('、')}），请先更换这些卡片的图标`);
  await deleteAsset(SHARED_MEDIA_OWNER, id);
}
