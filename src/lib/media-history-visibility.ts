import { getSupabaseClient } from '@/storage/database/supabase-client';

export async function hideMediaHistoryItem(userId: string, kind: 'image' | 'video', recordId: string, index: number | null = null): Promise<Response> {
  if (!recordId || recordId.length > 200 || (kind === 'image' && (!Number.isSafeInteger(index) || Number(index) < 0))) {
    return Response.json({ error: '历史记录无效' }, { status: 400 });
  }
  const { error } = await getSupabaseClient().rpc('hide_media_history_item', { p_user_id: userId, p_kind: kind, p_record_id: recordId, p_index: index });
  if (error) {
    if (error.message.includes('MEDIA_HISTORY_NOT_FOUND')) return Response.json({ error: '记录不存在或无权操作' }, { status: 404 });
    if (error.message.includes('MEDIA_HISTORY_TASK_PENDING')) return Response.json({ error: '任务仍在处理，请完成后再移除历史记录', code: 'TASK_STILL_PROCESSING' }, { status: 409 });
    console.error('[MediaHistory] hide failed:', error.code);
    return Response.json({ error: '历史记录暂时无法移除，请稍后重试' }, { status: 503 });
  }
  return Response.json({ success: true });
}

export function visibleGalleryIndex(message: Record<string, unknown>, index: number): boolean {
  return !Array.isArray(message.media_hidden_indices) || !message.media_hidden_indices.includes(index);
}
