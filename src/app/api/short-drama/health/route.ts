import { NextResponse } from "next/server";
import {
  ShortDramaJobStageSchema,
  ShortDramaJobStateSchema,
  ShortDramaProjectStatusSchema,
} from "@/lib/short-drama/contracts";
import {
  probeShortDramaStorageReadiness,
  SHORT_DRAMA_SCHEMA_VERSION,
} from "@/lib/short-drama/readiness";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function healthPayload(paidModelCallsEnabled: boolean) {
  return {
    module: "short-drama-core",
    schemaVersion: SHORT_DRAMA_SCHEMA_VERSION,
    paidModelCallsEnabled,
    paidModelGate: "database-schema-only",
    modelChannelsVerified: false,
    productionReady: false,
    projectStatuses: ShortDramaProjectStatusSchema.options,
    jobStages: ShortDramaJobStageSchema.options,
    jobStates: ShortDramaJobStateSchema.options,
  };
}

export async function GET() {
  const readiness = await probeShortDramaStorageReadiness();
  if (!readiness.ok) {
    return NextResponse.json(
      {
        ok: false,
        ...healthPayload(false),
        storageMode: readiness.storageMode,
        nativeSchemaReady: readiness.nativeSchemaReady,
        migrationStatus: readiness.migrationStatus,
        compatibilityStatus: readiness.compatibilityStatus,
        nativeBlockerCode: readiness.nativeBlockerCode,
        nativeBlocker: readiness.nativeBlocker,
        code: readiness.code,
        error: readiness.error,
      },
      {
        status: 503,
        headers: { "Cache-Control": "no-store" },
      },
    );
  }

  if (readiness.storageMode === "compat") {
    return NextResponse.json(
      {
        ok: true,
        ...healthPayload(false),
        storageMode: "compat",
        nativeSchemaReady: false,
        migrationStatus: readiness.migrationStatus,
        compatibilityStatus: readiness.compatibilityStatus,
        compatibilityContract: readiness.compatibilityContract,
        nativeBlockerCode: readiness.nativeBlockerCode,
        nativeBlocker: readiness.nativeBlocker,
        code: "MIGRATION_NOT_READY",
        error: "当前仅启用明确标识的兼容存储；项目、角色、场景、道具与分镜草稿可真实保存，但付费生成、任务、资产和结算继续关闭。",
      },
      {
        status: 200,
        headers: { "Cache-Control": "no-store" },
      },
    );
  }

  return NextResponse.json(
    {
      ok: true,
      ...healthPayload(true),
      storageMode: "native",
      nativeSchemaReady: true,
      migrationStatus: "ready",
      compatibilityStatus: "not-needed",
    },
    {
      status: 200,
      headers: { "Cache-Control": "no-store" },
    },
  );
}
