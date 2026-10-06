import { randomUUID } from "node:crypto";
import { config as loadEnv } from "dotenv";
import {
  MANJU_CONFIG_DOMAINS,
  MANJU_CONFIG_LATEST_SCHEMA_VERSION,
  isManjuMigrationNotReadyError,
  validateManjuConfigPayload,
  validateManjuDomainContract,
  type ManjuConfigActiveRow,
  type ManjuConfigDomain,
  type ManjuConfigReleaseRow,
  type ManjuConfigRevisionRow,
} from "../src/lib/server/manju-runtime-config";
import { MANJU_PRODUCTION_SEED } from "../src/lib/server/manju-production-seed";
import { getSupabaseAdminClient } from "../src/storage/database/supabase-client";

loadEnv({ path: ".env.local", quiet: true });

const APPLY = process.argv.includes("--apply");
const CONFIRMED_TARGET_HOST = process.argv
  .find((argument) => argument.startsWith("--confirm-target-host="))
  ?.slice("--confirm-target-host=".length)
  .trim()
  .toLowerCase() ?? "";
const ACTOR = "system:manju-production-seed:20260826";
const KEY_PREFIX = "manju.config.v1.production";
const SAFE_HOST_ROOT = "aidap-global.cn-beijing.volces.com";

interface SeedEnvelope {
  format: "manju-platform-settings-v1";
  environment: "production";
  domain: ManjuConfigDomain;
  active: {
    pointer: ManjuConfigActiveRow;
    release: ManjuConfigReleaseRow;
    revision: ManjuConfigRevisionRow;
  };
  drafts: [];
  history: Array<{ release: ManjuConfigReleaseRow; revision: ManjuConfigRevisionRow }>;
  updated_at: string;
}

function settingKey(domain: ManjuConfigDomain): string {
  return `${KEY_PREFIX}.${domain}`;
}

function safeHost(): string {
  const raw = process.env.COZE_SUPABASE_URL?.trim();
  if (!raw) throw new Error("COZE_SUPABASE_URL is required");
  let target: URL;
  try {
    target = new URL(raw);
  } catch {
    throw new Error("COZE_SUPABASE_URL is invalid");
  }
  const host = target.hostname.toLowerCase();
  if (
    target.protocol !== "https:"
    || (host !== SAFE_HOST_ROOT && !host.endsWith(`.${SAFE_HOST_ROOT}`))
  ) {
    throw new Error(`Unexpected database host: ${host}`);
  }
  const serviceRoleKey = process.env.COZE_SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!serviceRoleKey) {
    throw new Error("COZE_SUPABASE_SERVICE_ROLE_KEY is required");
  }
  const segments = serviceRoleKey.split(".");
  if (segments.length !== 3) throw new Error("COZE_SUPABASE_SERVICE_ROLE_KEY is not a JWT");
  try {
    const claims = JSON.parse(Buffer.from(segments[1], "base64url").toString("utf8")) as { role?: unknown };
    if (claims.role !== "service_role") throw new Error("SERVICE_ROLE_REQUIRED");
  } catch (error) {
    if (error instanceof Error && error.message === "SERVICE_ROLE_REQUIRED") {
      throw new Error("COZE_SUPABASE_SERVICE_ROLE_KEY must have service_role");
    }
    throw new Error("COZE_SUPABASE_SERVICE_ROLE_KEY JWT payload is invalid");
  }
  if (CONFIRMED_TARGET_HOST && CONFIRMED_TARGET_HOST !== host) {
    throw new Error(`Target confirmation does not match ${host}`);
  }
  if (APPLY && CONFIRMED_TARGET_HOST !== host) {
    throw new Error(`--apply requires --confirm-target-host=${host}`);
  }
  return host;
}

function validateArguments(): void {
  const allowed = process.argv.slice(2).every((argument) => (
    argument === "--apply" || argument.startsWith("--confirm-target-host=")
  ));
  if (!allowed) throw new Error("Unexpected command argument");
}

function parseExisting(
  value: unknown,
  expectedDomain: ManjuConfigDomain,
): { payloadHash: string; etagContract: "current" | "legacy"; schemaVersion: string } | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = JSON.parse(value) as {
    format?: unknown;
    environment?: unknown;
    domain?: unknown;
    active?: {
      pointer?: { etag?: unknown };
      release?: { etag?: unknown; release_number?: unknown };
      revision?: { payload?: unknown; payload_hash?: unknown; schema_version?: unknown };
    } | null;
  };
  if (
    parsed.format !== "manju-platform-settings-v1"
    || parsed.environment !== "production"
    || parsed.domain !== expectedDomain
  ) {
    throw new Error("Existing Manju compatibility config has an unexpected format");
  }
  const revision = parsed.active?.revision;
  if (!revision) return null;
  const schemaVersion = typeof revision.schema_version === "string" ? revision.schema_version : "";
  const validated = validateManjuConfigPayload(revision.payload);
  validateManjuDomainContract(expectedDomain, validated.payload, schemaVersion);
  if (validated.payloadHash !== revision.payload_hash) {
    throw new Error("Existing Manju compatibility config hash is invalid");
  }
  const releaseNumber = parsed.active?.release?.release_number;
  if (!Number.isInteger(releaseNumber) || Number(releaseNumber) < 1) {
    throw new Error("Existing Manju compatibility config release number is invalid");
  }
  const currentEtag = `${validated.payloadHash}:${releaseNumber}`;
  const legacyEtag = `"manju-${validated.payloadHash}"`;
  const pointerEtag = parsed.active?.pointer?.etag;
  const releaseEtag = parsed.active?.release?.etag;
  if (pointerEtag === currentEtag && releaseEtag === currentEtag) {
    return { payloadHash: validated.payloadHash, etagContract: "current", schemaVersion };
  }
  if (pointerEtag === legacyEtag && releaseEtag === legacyEtag) {
    return { payloadHash: validated.payloadHash, etagContract: "legacy", schemaVersion };
  }
  throw new Error("Existing Manju compatibility config ETag contract is invalid");
}

async function loadCompatStorageGenerations(
  database: ReturnType<typeof getSupabaseAdminClient>,
): Promise<Record<ManjuConfigDomain, number>> {
  const stateResult = await database
    .from("manju_config_storage_state")
    .select("environment,domain,state,generation")
    .eq("environment", "production")
    .in("domain", [...MANJU_CONFIG_DOMAINS]);
  if (stateResult.error) {
    if (!isManjuMigrationNotReadyError(stateResult.error)) {
      throw new Error(`Unable to inspect Manju storage state: ${stateResult.error.message}`);
    }
    const nativeResult = await database
      .from("manju_config_revisions")
      .select("id")
      .limit(1);
    if (nativeResult.error && isManjuMigrationNotReadyError(nativeResult.error)) {
      return Object.fromEntries(MANJU_CONFIG_DOMAINS.map((domain) => [domain, 0])) as Record<ManjuConfigDomain, number>;
    }
    if (nativeResult.error) {
      throw new Error(`Unable to verify legacy Manju storage: ${nativeResult.error.message}`);
    }
    throw new Error("Native Manju control plane exists without authoritative storage state");
  }

  const generations = new Map<ManjuConfigDomain, number>();
  for (const raw of stateResult.data ?? []) {
    const row = raw as { environment?: unknown; domain?: unknown; state?: unknown; generation?: unknown };
    const domain = row.domain as ManjuConfigDomain;
    const generation = Number(row.generation);
    if (
      row.environment !== "production"
      || !MANJU_CONFIG_DOMAINS.includes(domain)
      || row.state !== "compat"
      || !Number.isSafeInteger(generation)
      || generation < 1
      || generations.has(domain)
    ) {
      throw new Error(`Manju storage state is not seedable for domain ${String(row.domain)}`);
    }
    generations.set(domain, generation);
  }
  if (generations.size !== MANJU_CONFIG_DOMAINS.length) {
    throw new Error("Manju storage state is incomplete; refusing to guess missing domains");
  }
  return Object.fromEntries(generations) as Record<ManjuConfigDomain, number>;
}

function createPublishedEnvelope(domain: ManjuConfigDomain): SeedEnvelope {
  const now = new Date().toISOString();
  const revisionId = randomUUID();
  const releaseId = randomUUID();
  const validated = validateManjuConfigPayload(MANJU_PRODUCTION_SEED[domain]);
  const revision: ManjuConfigRevisionRow = {
    id: revisionId,
    environment: "production",
    domain,
    version: 1,
    status: "published",
    payload: validated.payload,
    payload_hash: validated.payloadHash,
    schema_version: MANJU_CONFIG_LATEST_SCHEMA_VERSION,
    parent_revision_id: null,
    created_by: ACTOR,
    created_at: now,
    updated_at: now,
    published_at: now,
  };
  const etag = `${revision.payload_hash}:1`;
  const release: ManjuConfigReleaseRow = {
    id: releaseId,
    environment: "production",
    domain,
    release_number: 1,
    revision_id: revisionId,
    previous_release_id: null,
    release_kind: "publish",
    rollback_of_release_id: null,
    etag,
    released_by: ACTOR,
    created_at: now,
  };
  const pointer: ManjuConfigActiveRow = {
    environment: "production",
    domain,
    active_release_id: releaseId,
    active_revision_id: revisionId,
    etag,
    updated_by: ACTOR,
    updated_at: now,
  };
  return {
    format: "manju-platform-settings-v1",
    environment: "production",
    domain,
    active: { pointer, release, revision },
    drafts: [],
    history: [{ release, revision }],
    updated_at: now,
  };
}

async function main() {
  validateArguments();
  const host = safeHost();
  const database = getSupabaseAdminClient();
  const storageGenerations = await loadCompatStorageGenerations(database);
  const plan: Array<{
    domain: ManjuConfigDomain;
    state: string;
    payloadHash: string;
    storageGeneration: number;
    schemaVersion: string | null;
  }> = [];

  for (const domain of MANJU_CONFIG_DOMAINS) {
    const validated = validateManjuConfigPayload(MANJU_PRODUCTION_SEED[domain]);
    const { data, error } = await database
      .from("platform_settings")
      .select("setting_value")
      .eq("setting_key", settingKey(domain))
      .maybeSingle();
    if (error) throw new Error(`Unable to inspect ${domain} config: ${error.message}`);
    const existing = parseExisting(data?.setting_value, domain);
    const state = existing?.payloadHash === validated.payloadHash
        && existing.etagContract === "current"
        && existing.schemaVersion !== MANJU_CONFIG_LATEST_SCHEMA_VERSION
      ? "schema-upgrade-required"
      : existing?.payloadHash === validated.payloadHash && existing.etagContract === "current"
      ? "current"
      : existing?.payloadHash === validated.payloadHash && existing.etagContract === "legacy"
        ? "etag-migration-required"
        : data
        ? "replace-required"
        : "create";
    plan.push({
      domain,
      state,
      payloadHash: validated.payloadHash,
      storageGeneration: storageGenerations[domain],
      schemaVersion: existing?.schemaVersion ?? null,
    });
  }

  console.log(JSON.stringify({ host, apply: APPLY, plan }, null, 2));
  if (!APPLY) return;
  if (plan.some((item) => item.storageGeneration < 1)) {
    throw new Error(
      "MANJU_PRODUCTION_SEED_STORAGE_STATE_MIGRATION_REQUIRED: apply "
      + "supabase/migrations/20260829223000_manju_config_storage_state.sql before --apply",
    );
  }
  if (plan.some((item) => item.state !== "current" && item.state !== "create")) {
    throw new Error("Existing production config requires an admin-reviewed draft or the dedicated ETag migration");
  }

  const applied: Array<{ domain: string; releaseId: string; state: string }> = [];
  for (const item of plan) {
    if (item.state === "current") {
      applied.push({ domain: item.domain, releaseId: "existing", state: "unchanged" });
      continue;
    }
    const envelope = createPublishedEnvelope(item.domain);
    if (!Number.isSafeInteger(item.storageGeneration) || item.storageGeneration < 1) {
      throw new Error(`Invalid writable storage generation for ${item.domain}`);
    }
    const result = await database.rpc("commit_manju_config_compat_envelope", {
      p_environment: "production",
      p_domain: item.domain,
      p_expected_generation: item.storageGeneration,
      p_expected_storage_revision: null,
      p_envelope: envelope,
    });
    const { error } = result;
    if (error) throw new Error(`Unable to publish ${item.domain} config: ${error.message}`);
    applied.push({ domain: item.domain, releaseId: envelope.active.release.id, state: "published" });
  }

  console.log(JSON.stringify({ ok: true, applied }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
