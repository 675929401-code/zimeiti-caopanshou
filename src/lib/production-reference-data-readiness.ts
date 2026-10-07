import { MANJU_CONFIG_DOMAINS, MANJU_PUBLIC_ENVIRONMENT } from "@/lib/server/manju-runtime-config";
import { getSupabaseAdminClient } from "@/storage/database/supabase-client";
import { inspectVideoModelActivationReadiness, type VideoActivationBinding } from "@/lib/model-activation-gate";
import {
  VIDEO_CHANNEL_HEALTH_PROTOCOL_VERSION,
  isReleaseVerifiedVideoChannelHealth,
  type ReleaseVideoChannelHealthRow,
} from "@/lib/video-channel-health-release";

interface ActiveConfigRow {
  environment: string;
  domain: string;
  active_release_id: string;
  active_revision_id: string;
  etag: string;
}

interface ConfigReleaseRow {
  id: string;
  environment: string;
  domain: string;
  revision_id: string;
  release_kind: string;
  etag: string;
}

interface ConfigRevisionRow {
  id: string;
  environment: string;
  domain: string;
  status: string;
  published_at: string | null;
}

interface ManjuStorageStateRow {
  environment: string;
  domain: string;
  state: string;
  generation: number;
  native_active_release_id: string | null;
  native_active_revision_id: string | null;
  last_verified_at: string | null;
}

type ActiveVideoModelRow = VideoActivationBinding;

export type ProductionReferenceDataReadiness = {
  readonly ok: boolean;
  readonly state: "ready" | "reference-data-not-ready" | "probe-unavailable";
  readonly code: "REFERENCE_DATA_READY" | "REFERENCE_DATA_NOT_READY" | "REFERENCE_DATA_PROBE_UNAVAILABLE";
  readonly voiceActivePriceCount: number;
  readonly serviceRoleConfigured: boolean;
  readonly manjuRequiredDomainCount: number;
  readonly manjuReadyDomainCount: number;
  readonly missingManjuDomains: readonly string[];
  readonly manjuStorageReadyDomainCount: number;
  readonly missingManjuStorageDomains: readonly string[];
  readonly videoHealthProtocolVersion: string;
  readonly activeVideoModelCount: number;
  readonly verifiedVideoModelCount: number;
  readonly videoModelVerificationReady: boolean;
  readonly unverifiedVideoModelIds: readonly string[];
  readonly error?: string;
};

function unavailable(
  error: string,
  serviceRoleConfigured = Boolean(process.env.COZE_SUPABASE_SERVICE_ROLE_KEY?.trim()),
): ProductionReferenceDataReadiness {
  return {
    ok: false,
    state: "probe-unavailable",
    code: "REFERENCE_DATA_PROBE_UNAVAILABLE",
    voiceActivePriceCount: 0,
    serviceRoleConfigured,
    manjuRequiredDomainCount: MANJU_CONFIG_DOMAINS.length,
    manjuReadyDomainCount: 0,
    missingManjuDomains: [...MANJU_CONFIG_DOMAINS],
    manjuStorageReadyDomainCount: 0,
    missingManjuStorageDomains: [...MANJU_CONFIG_DOMAINS],
    videoHealthProtocolVersion: VIDEO_CHANNEL_HEALTH_PROTOCOL_VERSION,
    activeVideoModelCount: 0,
    verifiedVideoModelCount: 0,
    videoModelVerificationReady: false,
    unverifiedVideoModelIds: [],
    error,
  };
}

/**
 * Read only operational configuration rows. This never calls a database RPC,
 * mutates application data, touches member rows, or calls a model.
 */
export async function probeProductionReferenceDataReadiness(): Promise<ProductionReferenceDataReadiness> {
  // Exactly-once and reconciliation RPCs are service-role-only. Do not let a
  // deployment with only an anon key pass preflight and fail on first use.
  if (!process.env.COZE_SUPABASE_SERVICE_ROLE_KEY?.trim()) {
    return unavailable("production service-role database probe is not configured");
  }
  let database: ReturnType<typeof getSupabaseAdminClient>;
  try {
    database = getSupabaseAdminClient();
  } catch {
    return unavailable("production reference-data probe is not configured");
  }

  try {
    const now = new Date().toISOString();
    const [voicePriceResult, activeResult, storageStateResult, activeVideoResult] = await Promise.all([
      database
        .from("voice_nest_price_versions")
        .select("id,version,effective_at")
        .eq("status", "active")
        .lte("effective_at", now)
        .order("effective_at", { ascending: false })
        .order("id", { ascending: false })
        .limit(1),
      database
        .from("manju_config_active")
        .select("environment,domain,active_release_id,active_revision_id,etag")
        .eq("environment", MANJU_PUBLIC_ENVIRONMENT),
      database
        .from("manju_config_storage_state")
        .select("environment,domain,state,generation,native_active_release_id,native_active_revision_id,last_verified_at")
        .eq("environment", MANJU_PUBLIC_ENVIRONMENT),
      database
        .from("video_models")
        .select("id,model_name,provider,protocol_type,api_endpoint,api_key,api_protocol_config")
        .eq("is_active", true),
    ]);
    if (voicePriceResult.error || activeResult.error || storageStateResult.error || activeVideoResult.error) {
      return unavailable("production reference-data query failed");
    }

    const activeRows = (activeResult.data || []) as ActiveConfigRow[];
    const releaseIds = [...new Set(activeRows.map((row) => row.active_release_id).filter(Boolean))];
    const revisionIds = [...new Set(activeRows.map((row) => row.active_revision_id).filter(Boolean))];
    const activeVideoRows = (activeVideoResult.data || []) as ActiveVideoModelRow[];
    const activeVideoIds = [...new Set(activeVideoRows.map((row) => String(row.id || "").trim()).filter(Boolean))];
    const [releaseResult, revisionResult, videoHealthResult] = await Promise.all([
      releaseIds.length > 0
        ? database
            .from("manju_config_releases")
            .select("id,environment,domain,revision_id,release_kind,etag")
            .in("id", releaseIds)
        : Promise.resolve({ data: [], error: null }),
      revisionIds.length > 0
        ? database
            .from("manju_config_revisions")
            .select("id,environment,domain,status,published_at")
            .in("id", revisionIds)
        : Promise.resolve({ data: [], error: null }),
      activeVideoIds.length > 0
        ? database
            .from("video_channel_health")
            .select("channel_id,is_healthy,last_success_at,health_protocol_version,verification_state,verified_at,verification_evidence")
            .in("channel_id", activeVideoIds)
        : Promise.resolve({ data: [], error: null }),
    ]);
    if (releaseResult.error || revisionResult.error || videoHealthResult.error) {
      return unavailable("production reference-data relation query failed");
    }

    const activeByDomain = new Map(activeRows.map((row) => [row.domain, row] as const));
    const releaseById = new Map(
      ((releaseResult.data || []) as ConfigReleaseRow[]).map((row) => [row.id, row] as const),
    );
    const revisionById = new Map(
      ((revisionResult.data || []) as ConfigRevisionRow[]).map((row) => [row.id, row] as const),
    );
    const missingManjuDomains = MANJU_CONFIG_DOMAINS.filter((domain) => {
      const active = activeByDomain.get(domain);
      const release = active ? releaseById.get(active.active_release_id) : null;
      const revision = active ? revisionById.get(active.active_revision_id) : null;
      return !(
        active
        && release
        && revision
        && active.environment === MANJU_PUBLIC_ENVIRONMENT
        && active.domain === domain
        && release.environment === MANJU_PUBLIC_ENVIRONMENT
        && release.domain === domain
        && release.id === active.active_release_id
        && release.revision_id === active.active_revision_id
        && (release.release_kind === "publish" || release.release_kind === "rollback")
        && revision.environment === MANJU_PUBLIC_ENVIRONMENT
        && revision.domain === domain
        && revision.id === active.active_revision_id
        && revision.status === "published"
        && Boolean(revision.published_at)
        && active.etag === release.etag
      );
    });
    const storageByDomain = new Map(
      ((storageStateResult.data || []) as ManjuStorageStateRow[]).map((row) => [row.domain, row] as const),
    );
    const missingManjuStorageDomains = MANJU_CONFIG_DOMAINS.filter((domain) => {
      const active = activeByDomain.get(domain);
      const storage = storageByDomain.get(domain);
      return !(
        active
        && storage
        && storage.environment === MANJU_PUBLIC_ENVIRONMENT
        && storage.domain === domain
        && storage.state === "native"
        && Number.isSafeInteger(Number(storage.generation))
        && Number(storage.generation) >= 1
        && storage.native_active_release_id === active.active_release_id
        && storage.native_active_revision_id === active.active_revision_id
        && typeof storage.last_verified_at === "string"
        && Number.isFinite(Date.parse(storage.last_verified_at))
      );
    });
    const healthByChannel = new Map(
      ((videoHealthResult.data || []) as ReleaseVideoChannelHealthRow[])
        .map((row) => [String(row.channel_id || ""), row] as const),
    );
    const unverifiedVideoModelIds = activeVideoRows
      .filter((model) => !isReleaseVerifiedVideoChannelHealth(healthByChannel.get(model.id))
        || !inspectVideoModelActivationReadiness(model).ready)
      .map((model) => model.id)
      .sort();
    const voiceActivePriceCount = (voicePriceResult.data || []).length;
    const videoModelVerificationReady = activeVideoIds.length > 0 && unverifiedVideoModelIds.length === 0;
    // Deployment readiness protects shared infrastructure and required reference data.
    // Per-model paid acceptance remains visible here, but is enforced by that model's
    // own activation/generation policy and must never block an unrelated site release.
    const ok = voiceActivePriceCount === 1
      && missingManjuDomains.length === 0
      && missingManjuStorageDomains.length === 0
      && activeVideoIds.length > 0;
    return {
      ok,
      state: ok ? "ready" : "reference-data-not-ready",
      code: ok ? "REFERENCE_DATA_READY" : "REFERENCE_DATA_NOT_READY",
      voiceActivePriceCount,
      serviceRoleConfigured: true,
      manjuRequiredDomainCount: MANJU_CONFIG_DOMAINS.length,
      manjuReadyDomainCount: MANJU_CONFIG_DOMAINS.length - missingManjuDomains.length,
      missingManjuDomains,
      manjuStorageReadyDomainCount: MANJU_CONFIG_DOMAINS.length - missingManjuStorageDomains.length,
      missingManjuStorageDomains,
      videoHealthProtocolVersion: VIDEO_CHANNEL_HEALTH_PROTOCOL_VERSION,
      activeVideoModelCount: activeVideoIds.length,
      verifiedVideoModelCount: activeVideoIds.length - unverifiedVideoModelIds.length,
      videoModelVerificationReady,
      unverifiedVideoModelIds,
      ...(!ok ? { error: "production reference data is incomplete" } : {}),
    };
  } catch {
    return unavailable("production reference-data probe is unavailable");
  }
}
