import "server-only";

import {
  DOMAIN_RELEASE_SOURCE_BOUNDARIES,
  DomainReleaseError,
  domainReleaseSchemaUnavailable,
  normalizeDomainReleaseDatabaseStatus,
  type DomainReleaseStatus,
} from "@/lib/domain-tls-brand-release-control-plane";
import { getSupabaseAdminClient } from "@/storage/database/supabase-client";

type RpcClient = {
  rpc(name: string, args?: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }>;
};

export async function readDomainTlsBrandReleaseStatus(): Promise<DomainReleaseStatus> {
  const database = getSupabaseAdminClient() as unknown as RpcClient;
  const { data, error } = await database.rpc("get_domain_tls_brand_release_status");
  if (error) {
    if (domainReleaseSchemaUnavailable(error)) {
      throw new DomainReleaseError(
        "DOMAIN_RELEASE_SCHEMA_REQUIRED",
        "域名与贴牌发布控制平面迁移尚未应用",
        503,
      );
    }
    throw new DomainReleaseError(
      "DOMAIN_RELEASE_STATUS_UNAVAILABLE",
      "域名与贴牌发布控制平面暂不可用",
      503,
    );
  }
  return {
    schemaVersion: 1,
    controlPlane: "domain_tls_brand_release",
    phase: "foundation_only",
    migrationApplied: true,
    database: normalizeDomainReleaseDatabaseStatus(data),
    integration: {
      currentRuntimeChanged: false,
      dnsRecordsChanged: false,
      certificatesChanged: false,
      gatewayChanged: false,
      formalDomainChanged: false,
      realDomainVerificationRun: false,
      connectedSources: [],
      pendingSources: DOMAIN_RELEASE_SOURCE_BOUNDARIES,
    },
    hostRoutingPolicy: {
      targetPolicy: "unknown_host_hard_reject",
      requiredStatus: 421,
      enforcementActive: false,
      observedStatus: null,
      fallbackSiteAllowed: false,
    },
  };
}
