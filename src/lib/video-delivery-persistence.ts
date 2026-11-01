import "server-only";

import { getSupabaseAdminClient } from "@/storage/database/supabase-client";
import { persistStableVideoFromUrl } from "@/lib/video-persistence";

const PERSISTENT_VIDEO_URI_PATTERN = /^object:\/\/tencent_cos\/[^?#]+$/u;
const deliveryPersistenceGlobal = globalThis as typeof globalThis & {
  __videoDeliveryPersistenceInflight?: Set<string>;
};
const inflight = deliveryPersistenceGlobal.__videoDeliveryPersistenceInflight
  ?? (deliveryPersistenceGlobal.__videoDeliveryPersistenceInflight = new Set<string>());

/**
 * 普通视频交付也需要一份平台自有副本。
 *
 * 供应商结果 CDN（例如 media-r2-pg-us.quillbox.win）可能在数小时内失效，
 * 只保留上游 URL 会让历史记录在一夜之间变成无法播放的空壳。这里在终态
 * 交付后异步落一份腾讯 COS 副本，并把 storage_url/video_url 指向 object URI。
 *
 * 约束：
 * - 尽力而为：失败只记录日志，不阻塞交付、不改变计费结果；
 * - 幂等：同一 taskId 同时只跑一次（进程内去重）；
 * - 不覆盖已过期/已隐藏的记录，避免把已失效任务重新变成可播。
 */
export function scheduleVideoDeliveryPersistence(input: {
  taskId: string;
  userId: string;
  providerResultUrl: string;
  providerTaskId?: string;
  providerProtocol?: string;
  providerEndpoint?: string;
  providerApiKey?: string;
  trustedProviderResultHostname?: string;
}) {
  const taskId = String(input.taskId || "").trim();
  const userId = String(input.userId || "").trim();
  const sourceUrl = String(input.providerResultUrl || "").trim();
  if (!taskId || !userId || !/^https?:\/\//iu.test(sourceUrl) || inflight.has(taskId)) return false;
  inflight.add(taskId);
  void (async () => {
    try {
      // Storyboard deliveries are exclusively owned by the transaction-enqueued
      // durable archive worker; never start the legacy fire-and-forget copy.
      const { data: task, error: taskError } = await getSupabaseAdminClient().from('video_tasks')
        .select('task_label').eq('id', taskId).eq('user_id', userId).maybeSingle();
      if (taskError || !task || String(task.task_label || '').startsWith('分镜工作台')) return;
      const persisted = await persistStableVideoFromUrl(sourceUrl, taskId, userId, {
        storageScope: "video-delivery",
        providerProtocol: input.providerProtocol,
        providerEndpoint: input.providerEndpoint,
        providerApiKey: input.providerApiKey,
        providerTaskId: input.providerTaskId,
        trustedProviderResultHostname: input.trustedProviderResultHostname,
      });
      if (!PERSISTENT_VIDEO_URI_PATTERN.test(persisted)) return;
      const { error } = await getSupabaseAdminClient()
        .from("video_tasks")
        .update({ storage_url: persisted, video_url: persisted })
        .eq("id", taskId)
        .eq("user_id", userId)
        .is("source_expired_at", null)
        .is("history_hidden_at", null);
      if (error) {
        console.warn("[视频交付] 平台副本地址写入失败", {
          taskId,
          code: String(error.code || "UNKNOWN").slice(0, 40),
        });
      }
    } catch (error) {
      console.warn("[视频交付] 平台副本持久化失败", {
        taskId,
        code: error instanceof Error ? error.message.slice(0, 120) : "UNKNOWN",
      });
    } finally {
      inflight.delete(taskId);
    }
  })();
  return true;
}
