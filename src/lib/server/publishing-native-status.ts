import "server-only";
import type { getSupabase } from "@/lib/api-middleware";
import { PublishingNativeStatusSchema, type PublishingNativeStatus } from "@/lib/publishing-native-status";
import { publishingProviderStatus } from "./publishing-provider";
import { PublishingError } from "./publishing-service";
export async function readPublishingNativeStatus(database: ReturnType<typeof getSupabase>, options: { ownerId?: string; includeCounts: boolean }): Promise<PublishingNativeStatus> {
  const tables = { collections: "pub2_collections", drafts: "pub2_drafts", groups: "pub2_groups", schedules: "pub2_schedules", batches: "pub2_batches", attempts: "pub2_attempts" } as const;
  const results = await Promise.all(Object.entries(tables).map(async ([key, table]) => {
    let query = database.from(table).select("id", { ...(options.includeCounts ? { count: "exact" as const } : {}), head: true });
    if (!options.includeCounts) query = query.limit(1);
    if (options.ownerId) query = query.eq("user_id", options.ownerId);
    const result = await query;
    if (result.error && !["42P01", "PGRST205"].includes(result.error.code)) throw new PublishingError("PUBLISH_NATIVE_STATUS_UNAVAILABLE", "原生工作台状态暂不可读取", 503);
    return { key, ready: !result.error, count: result.count ?? 0 };
  }));
  const schemaReady = results.every(result => result.ready);
  let official = null;
  if (options.includeCounts) {
    const reads = await Promise.all(["pub3_account_bindings", "pub3_assets", "pub3_operations"].map(async table => {
      const result = await database.from(table).select("id", { count: "exact", head: true });
      if (result.error && !["42P01", "PGRST205"].includes(result.error.code)) throw new PublishingError("PUBLISH_NATIVE_STATUS_UNAVAILABLE", "官方连接状态暂不可读取", 503);
      return { ready: !result.error, count: result.count ?? 0 };
    }));
    const unknown = reads.every(item => item.ready) ? await database.from("pub3_operations").select("id", { count: "exact", head: true }).eq("dispatch_state", "unknown") : null;
    if (unknown?.error) throw new PublishingError("PUBLISH_NATIVE_STATUS_UNAVAILABLE", "官方任务状态暂不可读取", 503);
    official = { schemaReady: reads.every(item => item.ready), bindings: reads[0].count, assets: reads[1].count, operations: reads[2].count, unknown: unknown?.count ?? 0 };
  }
  return PublishingNativeStatusSchema.parse({ schemaReady, provider: publishingProviderStatus(), counts: options.includeCounts && schemaReady ? Object.fromEntries(results.map(result => [result.key, result.count])) : null, official });
}
