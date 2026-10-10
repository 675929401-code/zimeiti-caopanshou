import type { AutodlH3Job, AutodlH3LifecycleStore } from "@/lib/autodl-h3-lifecycle";
import {
  assertAutodlH3SelfhostModelBinding,
  AUTODL_H3_SELFHOST_PROTOCOL,
  AUTODL_H3_SELFHOST_SECRET_REF,
} from "@/lib/autodl-h3-selfhost";
import type {
  AutodlH3AtomicSettlementResult,
  AutodlH3VideoFinalizerDependencies,
} from "@/lib/autodl-h3-video-finalizer";
import { persistStableVideoFromUrl } from "@/lib/video-persistence";
import { getSupabaseAdminClient } from "@/storage/database/supabase-client";

type DatabaseClient = ReturnType<typeof getSupabaseAdminClient>;

function finiteMoney(value: unknown, field: string): number {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0) throw new Error(`AUTODL_H3_${field}_INVALID`);
  return Math.round(amount * 10000) / 10000;
}

function rpcObject(value: unknown): Record<string, unknown> {
  const item = Array.isArray(value) ? value[0] : value;
  return item && typeof item === "object" ? item as Record<string, unknown> : {};
}

export function createAutodlH3ProductionFinalizerDependencies(options: {
  store: AutodlH3LifecycleStore;
  client?: DatabaseClient;
  persist?: typeof persistStableVideoFromUrl;
}): AutodlH3VideoFinalizerDependencies {
  const client = options.client || getSupabaseAdminClient();
  const persist = options.persist || persistStableVideoFromUrl;

  return {
    async loadContext(job: AutodlH3Job) {
      if (!job.videoTaskInternalId || !job.upstreamTaskId) throw new Error("AUTODL_H3_FINALIZER_BINDING_INCOMPLETE");
      const [taskResult, modelResult, userResult] = await Promise.all([
        client.from("video_tasks")
          .select("id,user_id,model_id,task_id_external,status,storage_url,video_url,price_charged,duration_seconds")
          .eq("id", job.videoTaskInternalId).eq("user_id", job.userId).maybeSingle(),
        client.from("video_models")
          .select("id,name,model_name,provider,protocol_type,api_endpoint,api_key,is_active,is_hidden")
          .eq("id", job.modelId).maybeSingle(),
        client.from("users").select("id,role").eq("id", job.userId).maybeSingle(),
      ]);
      if (taskResult.error || modelResult.error || userResult.error) throw new Error("AUTODL_H3_FINALIZER_CONTEXT_LOOKUP_FAILED");
      const task = taskResult.data as Record<string, unknown> | null;
      const model = modelResult.data as Record<string, unknown> | null;
      const user = userResult.data as Record<string, unknown> | null;
      if (!task || !model || !user) throw new Error("AUTODL_H3_FINALIZER_CONTEXT_MISSING");
      if (String(task.user_id) !== job.userId
        || String(task.model_id) !== job.modelId
        || String(task.task_id_external) !== job.publicTaskId) {
        throw new Error("AUTODL_H3_FINALIZER_CONTEXT_MISMATCH");
      }
      const exact = assertAutodlH3SelfhostModelBinding({
        kind: "video",
        provider: model.provider,
        protocolType: model.protocol_type,
        modelName: model.model_name || model.id,
        apiEndpoint: model.api_endpoint,
        apiKey: model.api_key,
      });
      if (!exact || model.is_active === false || model.is_hidden === true
        || String(model.api_key) !== AUTODL_H3_SELFHOST_SECRET_REF) {
        throw new Error("AUTODL_H3_FINALIZER_MODEL_BINDING_INVALID");
      }
      const priceYuan = finiteMoney(job.requestPayload.billingPriceYuan, "BILLING_PRICE");
      const costPrice = finiteMoney(job.requestPayload.billingCostPrice, "BILLING_COST");
      const stable = String(task.storage_url || task.video_url || "");
      return {
        userId: job.userId,
        userRole: String(user.role) === "admin" ? "admin" as const : "student" as const,
        modelId: job.modelId,
        modelName: String(model.name || model.model_name || model.id),
        videoTaskInternalId: job.videoTaskInternalId,
        publicTaskId: job.publicTaskId,
        upstreamTaskId: job.upstreamTaskId,
        providerProtocol: AUTODL_H3_SELFHOST_PROTOCOL,
        providerEndpoint: String(model.api_endpoint),
        durationSeconds: Math.max(1, Math.trunc(Number(task.duration_seconds) || 0)),
        priceYuan,
        costPrice,
        alreadyCompleted: String(task.status) === "completed",
        existingStableAssetUrl: stable || null,
        existingPriceCharged: finiteMoney(task.price_charged || 0, "EXISTING_CHARGE"),
      };
    },

    async persistResult({ context, resultUrl }) {
      return persist(resultUrl, context.videoTaskInternalId, context.userId, {
        storageScope: "autodl-h3",
        providerProtocol: context.providerProtocol,
        providerEndpoint: context.providerEndpoint,
      });
    },

    async settleAtomically({ job, context, stableAssetUrl, responseMs }) {
      if (!job.leaseOwner || job.leaseToken < 1) throw new Error("AUTODL_H3_FINALIZER_LEASE_REQUIRED");
      const { data, error } = await client.rpc("autodl_h3_finalize_video", {
        p_job_id: job.id,
        p_public_task_id: job.publicTaskId,
        p_video_task_internal_id: context.videoTaskInternalId,
        p_user_id: context.userId,
        p_model_id: context.modelId,
        p_upstream_task_id: context.upstreamTaskId,
        p_owner: job.leaseOwner,
        p_lease_token: job.leaseToken,
        p_result_asset_url: stableAssetUrl,
        p_price_yuan: context.priceYuan,
        p_cost_price: context.costPrice,
        p_response_ms: Math.max(0, Math.trunc(responseMs)),
      });
      if (error) throw new Error("AUTODL_H3_ATOMIC_SETTLEMENT_RPC_FAILED");
      if (data == null) throw new Error("AUTODL_H3_ATOMIC_SETTLEMENT_RPC_EMPTY");
      const result = rpcObject(data);
      const settlement: AutodlH3AtomicSettlementResult = {
        committed: result.committed === true,
        alreadyCommitted: result.already_committed === true || result.alreadyCommitted === true,
        stableAssetUrl: String(result.stable_asset_url || result.stableAssetUrl || ""),
        chargedYuan: finiteMoney(result.charged_yuan ?? result.chargedYuan ?? 0, "SETTLED_CHARGE"),
      };
      if (settlement.committed) {
        const expectedCharge = context.priceYuan;
        if (settlement.stableAssetUrl !== stableAssetUrl || settlement.chargedYuan !== expectedCharge) {
          throw new Error("AUTODL_H3_ATOMIC_SETTLEMENT_RESPONSE_INVALID");
        }
      }
      return settlement;
    },

    markProgress(input) {
      return options.store.markJobProgress(input);
    },
  };
}
