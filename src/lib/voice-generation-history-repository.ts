import "server-only";

import type { VoiceGeneration } from "@/lib/types";
import { getAllGenerations } from "@/lib/voice-store";
import {
  mapDurableVoiceHistoryRow,
  sanitizeLegacyVoiceHistory,
  type DurableVoiceHistoryRow,
  type OwnedVoiceHistoryAsset,
} from "@/lib/voice-generation-history-mapper";
import { getSupabaseAdminClient } from "@/storage/database/supabase-client";

const HISTORY_COLUMNS = "request_id,user_id,phase,model_id,charge_credits,refunded_credits,billing_exempt,state,wallet_operation_id,asset_id,generation_id,response,error,metadata,started_at,refunded_at";
const ASSET_COLUMNS = "id,storage_key,storage_provider,file_size,content_type";

export class VoiceGenerationHistoryError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 503,
  ) {
    super(message);
    this.name = "VoiceGenerationHistoryError";
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error) {
    return String((error as { message?: unknown }).message || "");
  }
  return String(error || "");
}

function historyDatabaseError(error: unknown): VoiceGenerationHistoryError {
  const message = errorMessage(error);
  if (/voice_generation_requests|42P01|PGRST20[245]|schema cache|does not exist|could not find/iu.test(message)) {
    return new VoiceGenerationHistoryError(
      "VOICE_HISTORY_MIGRATION_NOT_READY",
      "语音账号历史所需的持久任务表尚未部署，暂时无法读取历史",
    );
  }
  return new VoiceGenerationHistoryError(
    "VOICE_HISTORY_UNAVAILABLE",
    "语音账号历史暂时无法读取，请稍后重试",
  );
}

function loadLegacyHistory(userId: string, modelId?: string): VoiceGeneration[] {
  try {
    return getAllGenerations()
      .filter((item) => item.userId === userId && (!modelId || item.voiceModelId === modelId))
      .sort((left, right) => Date.parse(right.createdAt || "") - Date.parse(left.createdAt || ""));
  } catch (error) {
    // generations.json is a read-only compatibility source. Its absence must
    // never take the durable account history offline.
    console.warn("[voice-history] legacy compatibility data unavailable", errorMessage(error));
    return [];
  }
}

function addScope<T>(query: T, userId: string, modelId?: string): T {
  let scoped = (query as T & { eq: (column: string, value: string) => T }).eq("user_id", userId);
  if (modelId) scoped = (scoped as T & { eq: (column: string, value: string) => T }).eq("model_id", modelId);
  return scoped;
}

function safeCount(value: number | null): number {
  return Number.isInteger(value) && Number(value) >= 0 ? Number(value) : 0;
}

export async function getVoiceGenerationAccountHistory(input: {
  userId: string;
  page: number;
  pageSize: number;
  modelId?: string;
}) {
  const db = getSupabaseAdminClient();
  const offset = (input.page - 1) * input.pageSize;
  const localHistory = loadLegacyHistory(input.userId, input.modelId);

  const pageQuery = addScope(
    db.from("voice_generation_requests").select(HISTORY_COLUMNS, { count: "exact" }),
    input.userId,
    input.modelId,
  )
    .order("started_at", { ascending: false })
    .order("id", { ascending: false })
    .range(offset, offset + input.pageSize - 1);
  const oldestQuery = addScope(
    db.from("voice_generation_requests").select("started_at"),
    input.userId,
    input.modelId,
  ).order("started_at", { ascending: true }).order("id", { ascending: true }).limit(1).maybeSingle();
  const completedQuery = addScope(
    db.from("voice_generation_requests").select("id", { count: "exact", head: true }),
    input.userId,
    input.modelId,
  ).eq("state", "completed");
  const failedQuery = addScope(
    db.from("voice_generation_requests").select("id", { count: "exact", head: true }),
    input.userId,
    input.modelId,
  ).in("state", ["refunded", "failed_unknown"]);
  const processingQuery = addScope(
    db.from("voice_generation_requests").select("id", { count: "exact", head: true }),
    input.userId,
    input.modelId,
  ).in("state", ["submitting", "recovery_required"]);

  const [pageResult, oldestResult, completedResult, failedResult, processingResult] = await Promise.all([
    pageQuery,
    oldestQuery,
    completedQuery,
    failedQuery,
    processingQuery,
  ]);
  const queryError = pageResult.error
    || oldestResult.error
    || completedResult.error
    || failedResult.error
    || processingResult.error;
  if (queryError) throw historyDatabaseError(queryError);

  const durableTotal = safeCount(pageResult.count);
  const oldestDurableTime = Date.parse(String(oldestResult.data?.started_at || ""));
  const legacyHistory = durableTotal === 0
    ? localHistory
    : Number.isFinite(oldestDurableTime)
      ? localHistory.filter((item) => Date.parse(item.createdAt || "") < oldestDurableTime)
      : [];
  const durableRows = offset < durableTotal
    ? (pageResult.data || []) as DurableVoiceHistoryRow[]
    : [];
  const legacyOffset = Math.max(0, offset - durableTotal);
  const legacySlots = Math.max(0, input.pageSize - durableRows.length);
  const legacyRows = legacySlots > 0
    ? legacyHistory.slice(legacyOffset, legacyOffset + legacySlots)
    : [];

  const durableAssetIds = [...new Set(durableRows.map((row) => row.asset_id).filter((id): id is string => Boolean(id)))];
  const legacyStorageKeys = [...new Set(legacyRows.map((row) => row.outputStorageKey).filter((key): key is string => Boolean(key)))];
  const [durableAssetResult, legacyAssetResult] = await Promise.all([
    durableAssetIds.length
      ? db.from("user_files").select(ASSET_COLUMNS).eq("user_id", input.userId).in("id", durableAssetIds)
      : Promise.resolve({ data: [], error: null }),
    legacyStorageKeys.length
      ? db.from("user_files").select(ASSET_COLUMNS).eq("user_id", input.userId).in("storage_key", legacyStorageKeys)
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (durableAssetResult.error || legacyAssetResult.error) {
    throw new VoiceGenerationHistoryError(
      "VOICE_HISTORY_ASSET_OWNERSHIP_UNAVAILABLE",
      "历史音频资产归属暂时无法核对，已停止返回播放地址",
    );
  }

  const durableAssetById = new Map<string, OwnedVoiceHistoryAsset>(
    ((durableAssetResult.data || []) as OwnedVoiceHistoryAsset[]).map((asset) => [asset.id, asset]),
  );
  const legacyAssetByStorage = new Map<string, OwnedVoiceHistoryAsset>(
    ((legacyAssetResult.data || []) as OwnedVoiceHistoryAsset[]).map((asset) => [`${asset.storage_provider}:${asset.storage_key}`, asset]),
  );
  const localSnapshotById = new Map(localHistory.map((item) => [item.id, item]));
  const durableItems = durableRows.map((row) => mapDurableVoiceHistoryRow(
    row,
    row.asset_id ? durableAssetById.get(row.asset_id) : undefined,
    row.generation_id ? localSnapshotById.get(row.generation_id) : undefined,
  ));
  const legacyItems = legacyRows.map((item) => sanitizeLegacyVoiceHistory(
    item,
    item.outputStorageKey && item.outputStorageProvider
      ? legacyAssetByStorage.get(`${item.outputStorageProvider}:${item.outputStorageKey}`)
      : undefined,
  ));
  const legacySuccess = legacyHistory.filter((item) => item.status === "success").length;
  const legacyFailed = legacyHistory.filter((item) => item.status === "failed").length;
  const legacyProcessing = legacyHistory.length - legacySuccess - legacyFailed;

  return {
    total: durableTotal + legacyHistory.length,
    page: input.page,
    pageSize: input.pageSize,
    items: [...durableItems, ...legacyItems],
    stats: {
      total: durableTotal + legacyHistory.length,
      success: safeCount(completedResult.count) + legacySuccess,
      failed: safeCount(failedResult.count) + legacyFailed,
      processing: safeCount(processingResult.count) + legacyProcessing,
      totalChars: null,
      totalDuration: null,
    },
    source: "voice_generation_requests",
    legacyCompatibilityCount: legacyHistory.length,
  };
}
