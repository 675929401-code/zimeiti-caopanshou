import 'server-only';
import { getSupabaseAdminClient } from '@/storage/database/supabase-client';

export async function markVideoUpstreamSourceExpired(input: {
  taskId: string;
  userId: string;
  httpStatus: 404 | 410;
}) {
  const taskId = String(input.taskId || '').trim();
  const userId = String(input.userId || '').trim();
  if (!taskId || !userId || ![404, 410].includes(input.httpStatus)) return false;
  const { data, error } = await getSupabaseAdminClient().rpc('mark_video_upstream_source_expired', {
    p_task_id: taskId,
    p_user_id: userId,
    p_http_status: input.httpStatus,
  });
  if (error) {
    console.warn('[VideoSourceExpiry] definitive expiry could not be recorded', {
      taskId,
      code: String(error.code || 'UNKNOWN').slice(0, 40),
    });
    return false;
  }
  const result = (data || {}) as Record<string, unknown>;
  return result.marked === true;
}
