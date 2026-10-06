import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import {
  MANJU_PUBLIC_CONFIG_DOMAINS,
  MANJU_PUBLIC_ENVIRONMENT,
  MANJU_CONFIG_LATEST_SCHEMA_VERSION,
  isManjuMigrationNotReadyError,
  manjuHttpEtag,
  sanitizeManjuPublicPayload,
  validateManjuConfigPayload,
  validateManjuDomainContract,
  type ManjuConfigActiveRow,
  type ManjuConfigPayload,
  type ManjuPublicConfigDomain,
  type ManjuConfigReleaseRow,
  type ManjuConfigRevisionRow,
  type ManjuDatabaseErrorLike,
  type ManjuJsonValue,
} from "@/lib/server/manju-runtime-config";
import {
  ManjuCompatStoreError,
  loadManjuCompatPublic,
  loadManjuStorageStates,
} from "@/lib/server/manju-platform-settings-store";
import { getSupabaseAdminClient } from "@/storage/database/supabase-client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SUCCESS_CACHE_CONTROL = "public, max-age=0, s-maxage=15, must-revalidate";
const FAIL_CLOSED_HEADERS = { "Cache-Control": "no-store" } as const;

type PublicActiveRow = Pick<
  ManjuConfigActiveRow,
  "environment" | "domain" | "active_release_id" | "active_revision_id" | "etag"
>;
type PublicReleaseRow = Pick<
  ManjuConfigReleaseRow,
  "id" | "environment" | "domain" | "release_number" | "revision_id" | "release_kind" | "etag"
>;
type PublicRevisionRow = Pick<
  ManjuConfigRevisionRow,
  "id" | "environment" | "domain" | "status" | "payload" | "payload_hash" | "schema_version" | "published_at"
>;

function json(body: unknown, status: number, headers?: HeadersInit): NextResponse {
  return NextResponse.json(body, {
    status,
    headers: { ...FAIL_CLOSED_HEADERS, ...headers },
  });
}

function getRuntimeDatabase() {
  const database = getSupabaseAdminClient();
  if (!process.env.COZE_SUPABASE_SERVICE_ROLE_KEY?.trim()) {
    throw new Error("MANJU_SERVICE_ROLE_REQUIRED");
  }
  return database;
}

function storeFailure(error: ManjuDatabaseErrorLike | null | undefined): NextResponse {
  if (isManjuMigrationNotReadyError(error)) {
    return json(
      {
        ok: false,
        state: "unavailable",
        code: "MIGRATION_NOT_READY",
        error: "漫剧运行时配置尚未部署",
      },
      503,
    );
  }
  return json(
    {
      ok: false,
      state: "unavailable",
      code: "CONFIG_STORE_UNAVAILABLE",
      error: "漫剧运行时配置暂时不可用",
    },
    503,
  );
}

function indexById<T extends { id: string }>(rows: T[]): Map<string, T> {
  return new Map(rows.map((row) => [row.id, row]));
}

function requestAcceptsEtag(header: string | null, etag: string): boolean {
  if (!header) return false;
  return header
    .split(",")
    .map((candidate) => candidate.trim())
    .some((candidate) => candidate === "*" || candidate === etag);
}

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const environment = url.searchParams.get("environment") ?? MANJU_PUBLIC_ENVIRONMENT;
  if (environment !== MANJU_PUBLIC_ENVIRONMENT) {
    return json(
      {
        ok: false,
        code: "PUBLIC_ENVIRONMENT_FORBIDDEN",
        error: "公开端点只提供 production 环境的已发布配置",
      },
      400,
    );
  }

  let database: ReturnType<typeof getSupabaseAdminClient>;
  try {
    database = getRuntimeDatabase();
  } catch {
    return storeFailure(null);
  }

  let storageStates: Awaited<ReturnType<typeof loadManjuStorageStates>>;
  try {
    storageStates = await loadManjuStorageStates(
      database,
      MANJU_PUBLIC_ENVIRONMENT,
      MANJU_PUBLIC_CONFIG_DOMAINS,
    );
  } catch (error) {
    const correlationId = randomUUID();
    console.error("[manju-runtime-config] storage-state read failed", {
      correlationId,
      code: error instanceof ManjuCompatStoreError ? error.code : "CONFIG_STORE_UNAVAILABLE",
    });
    return json(
      {
        ok: false,
        state: "unavailable",
        code: error instanceof ManjuCompatStoreError ? error.code : "CONFIG_STORE_UNAVAILABLE",
        correlation_id: correlationId,
        error: "漫剧运行时配置存储状态暂时不可用",
      },
      503,
    );
  }

  const nativeDomains = MANJU_PUBLIC_CONFIG_DOMAINS.filter(
    (domain) => storageStates[domain].mode === "native",
  );
  const compatDomains = MANJU_PUBLIC_CONFIG_DOMAINS.filter(
    (domain) => storageStates[domain].mode === "compat",
  );
  const storageGenerations = Object.fromEntries(
    MANJU_PUBLIC_CONFIG_DOMAINS.map((domain) => [domain, storageStates[domain].generation]),
  ) as Record<ManjuPublicConfigDomain, number>;
  const storageMode: "compat" | "native" | "hybrid" = nativeDomains.length === 0
    ? "compat"
    : compatDomains.length === 0
      ? "native"
      : "hybrid";

  const activeResult = nativeDomains.length > 0
    ? await database
        .from("manju_config_active")
        .select("environment,domain,active_release_id,active_revision_id,etag")
        .eq("environment", MANJU_PUBLIC_ENVIRONMENT)
        .in("domain", nativeDomains)
    : { data: [], error: null };
  if (activeResult.error) return storeFailure(activeResult.error);

  const activeRows = (activeResult.data ?? []) as PublicActiveRow[];
  const releaseIds = Array.from(new Set(activeRows.map((row) => row.active_release_id).filter(Boolean)));
  const revisionIds = Array.from(new Set(activeRows.map((row) => row.active_revision_id).filter(Boolean)));

  const [releasesResult, revisionsResult] = await Promise.all([
    releaseIds.length > 0
      ? database
          .from("manju_config_releases")
          .select("id,environment,domain,release_number,revision_id,release_kind,etag")
          .in("id", releaseIds)
      : Promise.resolve({ data: [], error: null }),
    revisionIds.length > 0
      ? database
          .from("manju_config_revisions")
          .select("id,environment,domain,status,payload,payload_hash,schema_version,published_at")
          .in("id", revisionIds)
      : Promise.resolve({ data: [], error: null }),
  ]);
  const firstError = releasesResult.error ?? revisionsResult.error;
  if (firstError) return storeFailure(firstError);

  const activeByDomain = new Map(
    activeRows.map((row) => [row.domain, row] as const),
  );
  const releaseById = indexById((releasesResult.data ?? []) as PublicReleaseRow[]);
  const revisionById = indexById((revisionsResult.data ?? []) as PublicRevisionRow[]);
  const domains: Partial<Record<ManjuPublicConfigDomain, ManjuConfigPayload>> = {};
  const domainEtags: Partial<Record<ManjuPublicConfigDomain, string>> = {};
  const unresolvedDomains: ManjuPublicConfigDomain[] = [];

  for (const domain of nativeDomains) {
    const active = activeByDomain.get(domain);
    const release = active ? releaseById.get(active.active_release_id) : null;
    const revision = active ? revisionById.get(active.active_revision_id) : null;
    const isConsistent = Boolean(
      active &&
        release &&
        revision &&
        active.environment === MANJU_PUBLIC_ENVIRONMENT &&
        active.domain === domain &&
        release.environment === MANJU_PUBLIC_ENVIRONMENT &&
        release.domain === domain &&
        release.id === active.active_release_id &&
        release.revision_id === active.active_revision_id &&
        (release.release_kind === "publish" || release.release_kind === "rollback") &&
        revision.environment === MANJU_PUBLIC_ENVIRONMENT &&
        revision.domain === domain &&
        revision.id === active.active_revision_id &&
        revision.status === "published" &&
        Boolean(revision.published_at) &&
        active.etag === release.etag &&
        release.etag === `${revision.payload_hash}:${release.release_number}`,
    );

    if (!isConsistent || !release || !revision) {
      unresolvedDomains.push(domain);
      continue;
    }

    try {
      const validated = validateManjuConfigPayload(revision.payload);
      if (revision.schema_version !== MANJU_CONFIG_LATEST_SCHEMA_VERSION) {
        throw new Error("public schema upgrade required");
      }
      validateManjuDomainContract(domain, validated.payload, revision.schema_version);
      if (validated.payloadHash !== revision.payload_hash) throw new Error("payload hash mismatch");
      domains[domain] = sanitizeManjuPublicPayload(validated.payload);
      domainEtags[domain] = release.etag;
    } catch {
      unresolvedDomains.push(domain);
    }
  }

  if (compatDomains.length > 0) {
    try {
      const compat = await loadManjuCompatPublic(database, compatDomains);
      for (const domain of compatDomains) {
        const payload = compat.domains[domain];
        const domainEtag = compat.domainEtags[domain];
        if (compat.missingDomains.includes(domain) || !payload || !domainEtag) {
          unresolvedDomains.push(domain);
          continue;
        }
        domains[domain] = payload;
        domainEtags[domain] = domainEtag;
      }
    } catch (error) {
      return json(
        {
          ok: false,
          state: "unavailable",
          code: error instanceof ManjuCompatStoreError ? error.code : "CONFIG_STORE_UNAVAILABLE",
          error: "漫剧运行时兼容配置暂时不可用",
        },
        503,
      );
    }
  }

  const etagBasis = {
    environment: MANJU_PUBLIC_ENVIRONMENT,
    storage_mode: storageMode,
    storage_generations: storageGenerations,
    domains,
    domain_etags: domainEtags,
  };
  const etag = manjuHttpEtag(etagBasis as unknown as ManjuJsonValue);

  if (unresolvedDomains.length > 0) {
    return json(
      {
        ok: false,
        state: "degraded",
        code: "CONFIG_INCOMPLETE",
        storage_mode: storageMode,
        storage_generations: storageGenerations,
        environment: MANJU_PUBLIC_ENVIRONMENT,
        domains,
        missing_domains: unresolvedDomains,
        error: "漫剧运行时配置不完整，已拒绝使用未发布或伪造默认值",
      },
      503,
    );
  }

  if (requestAcceptsEtag(request.headers.get("if-none-match"), etag)) {
    return new NextResponse(null, {
      status: 304,
      headers: {
        ETag: etag,
        "Cache-Control": SUCCESS_CACHE_CONTROL,
        Vary: "Accept-Encoding",
      },
    });
  }

  return NextResponse.json(
    {
      ok: true,
      state: "ready",
      storage_mode: storageMode,
      storage_generations: storageGenerations,
      environment: MANJU_PUBLIC_ENVIRONMENT,
      domains,
      etag,
    },
    {
      headers: {
        ETag: etag,
        "Cache-Control": SUCCESS_CACHE_CONTROL,
        Vary: "Accept-Encoding",
      },
    },
  );
}
