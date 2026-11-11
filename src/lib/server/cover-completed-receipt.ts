import type { NextRequest } from "next/server";
import { getSupabaseClient } from "@/storage/database/supabase-client";
import type { CoverAttemptRow } from "@/lib/cover-durable-attempt";
import { coverCompositionTextReceipt, type CoverCompositionPlan } from "@/lib/cover-composition";
import { CoverPrepareError, coverMaterialFingerprint } from "./cover-prepare-repository";
import { validatePreparedCoverGeneration } from "./cover-prepared-generation";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu;

export function deliveryBinding(request: NextRequest, userId: string, row: CoverAttemptRow) {
  return validatePreparedCoverGeneration({ userId, task: row.task, generationInput: row.generation_input,
    clientIdempotencyKey: row.client_idempotency_key, clientTraceId: row.client_trace_id,
    requestUrl: request.url, phase: "delivery" });
}

/** Reconstruct an already committed receipt; a GET must not render it again. */
export async function completedCoverResult(request: NextRequest, userId: string, row: CoverAttemptRow): Promise<Record<string, unknown>> {
  await deliveryBinding(request, userId, row);
  if (row.user_id !== userId || row.surface !== "cover-studio" || row.state !== "completed"
    || !UUID.test(row.result_asset_id || "") || !UUID.test(row.background_asset_id || "")
    || row.result_asset_id === row.background_asset_id || !row.history_record_id) {
    throw new CoverPrepareError("COVER_COMPLETED_RECEIPT_INVALID", "原封面保存凭据尚未确认，请查询原任务", 503);
  }
  const db = getSupabaseClient();
  const [files, saved, media] = await Promise.all([
    db.from("user_files").select("id,user_id,storage_key,storage_provider,file_category,content_type,file_size")
      .eq("user_id", userId).eq("file_category", "image").eq("storage_provider", "tencent_cos")
      .in("id", [row.result_asset_id, row.background_asset_id]),
    db.from("cover_generation_history").select("asset_id,user_id,background_asset_id,history_record_id,plan,output_width,output_height,source_width,source_height,task_no,created_at,hidden_at")
      .eq("user_id", userId).eq("asset_id", row.result_asset_id).eq("background_asset_id", row.background_asset_id)
      .eq("history_record_id", row.history_record_id).maybeSingle(),
    db.from("conversation_messages").select("id,user_id,agent_id,role")
      .eq("id", row.history_record_id).eq("user_id", userId).eq("agent_id", "image-workbench").eq("role", "assistant").maybeSingle(),
  ]);
  const assets = (files.data || []) as Array<{ id: string; user_id: string; storage_key: string; storage_provider: string; file_category: string; content_type: string; file_size: number }>;
  const history = saved.data as { asset_id: string; user_id: string; background_asset_id: string; history_record_id: string;
    plan: CoverCompositionPlan; output_width: number; output_height: number; source_width: number; source_height: number;
    task_no: number; created_at: string; hidden_at?: string | null } | null;
  const output = assets.find(asset => asset.id === row.result_asset_id);
  if (files.error || saved.error || media.error || !media.data || !history || assets.length !== 2 || !output
    || assets.some(asset => asset.user_id !== userId || asset.storage_provider !== "tencent_cos" || asset.file_category !== "image"
      || !asset.storage_key || !/^image\/(png|jpeg|webp)$/u.test(asset.content_type) || !Number.isSafeInteger(Number(asset.file_size)) || Number(asset.file_size) <= 0)
    || output.content_type !== "image/png" || history.user_id !== userId || history.asset_id !== row.result_asset_id
    || history.background_asset_id !== row.background_asset_id || history.history_record_id !== row.history_record_id
    || coverMaterialFingerprint(history.plan) !== coverMaterialFingerprint(row.task.renderPlan)
    || ![history.output_width, history.output_height, history.source_width, history.source_height, history.task_no].every(value => Number.isSafeInteger(value) && value > 0)
    || (row.task.renderPlan.planVersion === 2 && (history.output_width !== row.task.renderPlan.outputSpec?.width
      || history.output_height !== row.task.renderPlan.outputSpec?.height))) {
    throw new CoverPrepareError("COVER_COMPLETED_RECEIPT_INVALID", "原封面资产与保存历史尚未核对，请稍后查询原任务", 503);
  }
  const plan = row.task.renderPlan;
  return { status: "completed", persisted: true, cloudStored: true, assetId: output.id, key: output.storage_key,
    url: `/api/storage/files/${encodeURIComponent(output.id)}/content`, historyRecordId: history.history_record_id,
    outputKind: "cover-composition", sourceAssetId: history.background_asset_id,
    ...coverCompositionTextReceipt(plan),
    ...(plan.planVersion === 2 ? { planVersion: 2, outputSpec: plan.outputSpec, ...(plan.titleStyle ? { titleStyle: plan.titleStyle } : {}) } : {}),
    width: history.output_width, height: history.output_height, sourceWidth: history.source_width, sourceHeight: history.source_height,
    taskNo: history.task_no, createdAt: history.created_at, historyVisible: !history.hidden_at, nativeUpscaleApplied: false };
}

