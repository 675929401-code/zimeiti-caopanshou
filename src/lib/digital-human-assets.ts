import { getSupabaseClient } from '@/storage/database/supabase-client';
import { storageManager, type StorageProviderType } from '@/storage/object';
import { mediaMetadata } from '@/lib/digital-human-media';
import { validateUploadBuffer } from '@/lib/file-upload-security';

export async function ownedDigitalHumanAsset(userId: string, assetId: string) {
  if (!/^[0-9a-f-]{36}$/i.test(assetId)) throw new Error('请选择已上传的素材');
  const { data, error } = await getSupabaseClient().from('user_files')
    .select('id,file_category,file_size,storage_key,storage_provider,meta,source,content_type')
    .eq('id', assetId).eq('user_id', userId).in('source', ['digital-human-input', 'voice-generation']).maybeSingle();
  if (error || !data) throw new Error('素材不存在或不属于当前账号，请重新上传');
  if (data.source === 'voice-generation') {
    const { data: receipt, error: receiptError } = await getSupabaseClient().from('voice_generation_requests')
      .select('id').eq('user_id', userId).eq('asset_id', data.id).eq('state', 'completed').limit(1).maybeSingle();
    if (receiptError || !receipt || data.file_category !== 'audio') throw new Error('配音尚未完成，请稍后查询原任务');
    if (!Number(data.meta?.duration)) {
      if (Number(data.file_size) > 30 * 1024 * 1024) throw new Error('配音音频最大为 30 MB');
      const bytes = await storageManager.read(data.storage_key, data.storage_provider as StorageProviderType);
      const detected = validateUploadBuffer(bytes, data.content_type);
      if (!detected.contentType.startsWith('audio/')) throw new Error('配音文件格式不正确');
      const metadata = await mediaMetadata(bytes, detected.extension, 'audio');
      const meta = { ...data.meta, duration: String(metadata.duration) };
      const { error: updateError } = await getSupabaseClient().from('user_files').update({ meta }).eq('id', data.id).eq('user_id', userId);
      if (updateError) throw new Error('配音时长尚未保存，请稍后重试');
      data.meta = meta;
    }
  }
  const url = await storageManager.getSignedUrl(data.storage_key, { expireTime: 24 * 3600 }, data.storage_provider as StorageProviderType);
  return { id: data.id as string, category: data.file_category as 'image' | 'audio' | 'video', url,
    duration: Number(data.meta?.duration) || 0, width: Number(data.meta?.width) || 0, height: Number(data.meta?.height) || 0, size: Number(data.file_size) || 0 };
}
