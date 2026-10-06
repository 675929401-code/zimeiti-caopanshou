import {
  isAutodlH3LifecycleEnabled,
  type AutodlH3Job,
  type AutodlH3JobProgressInput,
} from "@/lib/autodl-h3-lifecycle";
import {
  isPersistentVideoUri,
  withAutodlH3VideoFinalizationLock,
} from "@/lib/video-persistence";

if (typeof window !== "undefined") {
  throw new Error("AUTODL_H3_FINALIZER_SERVER_ONLY");
}

export interface AutodlH3VideoFinalizerContext {
  userId: string;
  userRole: "admin" | "student";
  modelId: string;
  modelName: string;
  videoTaskInternalId: string;
  publicTaskId: string;
  upstreamTaskId: string;
  providerProtocol: string;
  providerEndpoint: string;
  durationSeconds: number;
  priceYuan: number;
  costPrice: number;
  alreadyCompleted: boolean;
  existingStableAssetUrl?: string | null;
  existingPriceCharged?: number;
}

export interface AutodlH3AtomicSettlementResult {
  committed: boolean;
  alreadyCommitted: boolean;
  stableAssetUrl: string;
  chargedYuan: number;
}

export interface AutodlH3VideoFinalizerDependencies {
  /** Must verify task/user/model/public/upstream binding and return no secrets. */
  loadContext(job: AutodlH3Job): Promise<AutodlH3VideoFinalizerContext>;
  /** Must copy the loopback H3 result to durable storage and return object://tencent_cos/... . */
  persistResult(input: {
    context: AutodlH3VideoFinalizerContext;
    resultUrl: string;
  }): Promise<string>;
  /**
   * Must atomically perform exactly-once cash ledger settlement and the
   * video_tasks completed transition. An application-level read/CAS/insert
   * sequence is not sufficient and must return committed=false.
   */
  settleAtomically(input: {
    job: AutodlH3Job;
    context: AutodlH3VideoFinalizerContext;
    stableAssetUrl: string;
    responseMs: number;
  }): Promise<AutodlH3AtomicSettlementResult>;
  /**
   * Must preserve an active worker lease/fencing token and enforce monotonic
   * compare-and-set transitions. A plain read-then-update is not sufficient.
   */
  markProgress(input: AutodlH3JobProgressInput): Promise<unknown>;
}

export type AutodlH3VideoFinalizerResult =
  | {
      state: "SUCCEEDED";
      taskIdInternal: string;
      resultAssetUrl: string;
      chargedYuan: number;
    }
  | {
      state: "RECOVERY_REQUIRED";
      errorCode: string;
      errorMessage: string;
    };

const globalState = globalThis as typeof globalThis & {
  __autodlH3VideoFinalizerDependencies?: AutodlH3VideoFinalizerDependencies;
};

export function installAutodlH3VideoFinalizerDependencies(
  dependencies: AutodlH3VideoFinalizerDependencies,
) {
  globalState.__autodlH3VideoFinalizerDependencies = dependencies;
}

/** Capability probe only: it performs no I/O and never resolves credentials. */
export function hasAutodlH3VideoFinalizerDependencies(): boolean {
  const dependencies = globalState.__autodlH3VideoFinalizerDependencies;
  return Boolean(
    dependencies
      && typeof dependencies.loadContext === "function"
      && typeof dependencies.persistResult === "function"
      && typeof dependencies.settleAtomically === "function"
      && typeof dependencies.markProgress === "function",
  );
}

async function syncProgress(
  dependencies: AutodlH3VideoFinalizerDependencies | undefined,
  job: AutodlH3Job,
  input: AutodlH3JobProgressInput,
) {
  if (!dependencies) return;
  const updated = await dependencies.markProgress(input);
  if (!updated) throw new Error("AUTODL_H3_JOB_LEASE_LOST");
}

function claimedProgress(
  job: AutodlH3Job,
  input: Omit<AutodlH3JobProgressInput, "jobId" | "publicTaskId" | "userId" | "leaseOwner" | "leaseToken">,
): AutodlH3JobProgressInput {
  if (!job.leaseOwner || !job.leaseExpiresAt || job.leaseToken < 1) {
    throw new Error("AUTODL_H3_FINALIZER_REQUIRES_ACTIVE_JOB_LEASE");
  }
  return {
    ...input,
    jobId: job.id,
    publicTaskId: job.publicTaskId,
    userId: job.userId,
    leaseOwner: job.leaseOwner,
    leaseToken: job.leaseToken,
  };
}

async function markRecovery(
  job: AutodlH3Job,
  code: string,
  message: string,
  dependencies?: AutodlH3VideoFinalizerDependencies,
) {
  try {
    await syncProgress(dependencies, job, claimedProgress(job, {
      state: "RECOVERY_REQUIRED",
      upstreamTaskId: job.upstreamTaskId,
      progress: 99,
      errorCode: code,
      errorMessage: message,
    }));
  } catch {
    console.warn("[H3/Finalizer] recovery state sync unavailable; durable job remains blocking");
  }
  return { state: "RECOVERY_REQUIRED" as const, errorCode: code, errorMessage: message };
}

/**
 * The only lifecycle-enabled H3 success finalizer. It is server-only and can
 * be invoked by the background worker or a recovery route. A browser/SSE
 * connection is never required. Without an explicitly installed atomic
 * settlement adapter it stays at RECOVERY_REQUIRED and never reports success.
 */
export async function finalizeAutodlH3VideoSuccess(input: {
  job: AutodlH3Job;
  resultUrl: string;
  startedAt?: number;
}): Promise<AutodlH3VideoFinalizerResult> {
  const { job } = input;
  if (!isAutodlH3LifecycleEnabled() || process.env.AUTODL_H3_ATOMIC_FINALIZER_ENABLED !== "true") {
    return markRecovery(job, "H3_ATOMIC_FINALIZER_DISABLED", "H3 atomic finalizer is not enabled");
  }
  const dependencies = globalState.__autodlH3VideoFinalizerDependencies;
  if (!dependencies) {
    return markRecovery(job, "H3_ATOMIC_FINALIZER_UNAVAILABLE", "H3 atomic finalizer adapter is unavailable");
  }
  if (!job.upstreamTaskId || !job.videoTaskInternalId || !input.resultUrl) {
    return markRecovery(job, "H3_FINALIZER_INPUT_INCOMPLETE", "H3 finalizer input is incomplete", dependencies);
  }

  const locked = await withAutodlH3VideoFinalizationLock(`lifecycle:${job.publicTaskId}`, async () => {
    try {
      const context = await dependencies.loadContext(job);
      if (
        context.userId !== job.userId
        || context.modelId !== job.modelId
        || context.videoTaskInternalId !== job.videoTaskInternalId
        || context.publicTaskId !== job.publicTaskId
        || context.upstreamTaskId !== job.upstreamTaskId
      ) {
        return markRecovery(job, "H3_FINALIZER_BINDING_MISMATCH", "H3 finalizer binding mismatch", dependencies);
      }

      if (context.alreadyCompleted) {
        if (!isPersistentVideoUri(String(context.existingStableAssetUrl || ""))) {
          return markRecovery(job, "H3_COMPLETED_WITHOUT_STABLE_ASSET", "Completed H3 task has no stable asset", dependencies);
        }
        return {
          state: "SUCCEEDED" as const,
          taskIdInternal: context.videoTaskInternalId,
          resultAssetUrl: context.existingStableAssetUrl!,
          chargedYuan: Number(context.existingPriceCharged) || 0,
        };
      }

      // Only the claimed lifecycle worker may persist or settle. Route/SSE
      // readers can observe an already committed task above, but cannot race
      // the worker or reuse an expired fencing token.
      claimedProgress(job, { state: "PERSISTING" });

      await syncProgress(dependencies, job, claimedProgress(job, {
        state: "PERSISTING",
        upstreamTaskId: job.upstreamTaskId,
        progress: 99,
      }));
      const stableAssetUrl = await dependencies.persistResult({ context, resultUrl: input.resultUrl });
      if (!isPersistentVideoUri(stableAssetUrl)) {
        return markRecovery(job, "H3_RESULT_NOT_STABLE", "H3 persistence did not return a stable object asset", dependencies);
      }

      await syncProgress(dependencies, job, claimedProgress(job, {
        state: "FINALIZING",
        upstreamTaskId: job.upstreamTaskId,
        resultAssetUrl: stableAssetUrl,
        progress: 100,
      }));
      const settlement = await dependencies.settleAtomically({
        job,
        context,
        stableAssetUrl,
        responseMs: Math.max(0, Date.now() - (input.startedAt || Date.now())),
      });
      if (!settlement.committed || !isPersistentVideoUri(settlement.stableAssetUrl)) {
        return markRecovery(job, "H3_ATOMIC_SETTLEMENT_NOT_COMMITTED", "H3 atomic settlement was not committed", dependencies);
      }

      return {
        state: "SUCCEEDED" as const,
        taskIdInternal: context.videoTaskInternalId,
        resultAssetUrl: settlement.stableAssetUrl,
        chargedYuan: settlement.chargedYuan,
      };
    } catch {
      // SDK / database exceptions may embed headers, signed URLs or provider
      // responses. Never log the raw exception on this credentialed path.
      console.warn("[H3/Finalizer] fail-closed", "H3_FINALIZER_RECOVERY_REQUIRED");
      return markRecovery(job, "H3_FINALIZER_RECOVERY_REQUIRED", "H3 finalization requires recovery", dependencies);
    }
  });

  if (!locked.acquired) {
    return { state: "RECOVERY_REQUIRED", errorCode: "H3_FINALIZER_ALREADY_RUNNING", errorMessage: "H3 finalization is already running" };
  }
  return locked.value;
}
