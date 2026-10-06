import { config as loadEnv } from "dotenv";
import {
  MANJU_CONFIG_DOMAINS,
  validateManjuConfigPayload,
  validateManjuDomainContract,
  type ManjuConfigDomain,
} from "../src/lib/server/manju-runtime-config";
import { getSupabaseAdminClient } from "../src/storage/database/supabase-client";

loadEnv({ path: ".env.local", quiet: true });

const APPLY = process.argv.includes("--apply");
const CONFIRMED_TARGET_HOST = process.argv
  .find((argument) => argument.startsWith("--confirm-target-host="))
  ?.slice("--confirm-target-host=".length)
  .trim()
  .toLowerCase() ?? "";
const SAFE_HOST_ROOT = "aidap-global.cn-beijing.volces.com";
const ENVIRONMENT = "production";
const ACTOR = "system:manju-native-cutover:20260905";

type UnknownRecord = Record<string, unknown>;

function record(value: unknown, label: string): UnknownRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as UnknownRecord;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function safeHost(): string {
  const raw = process.env.COZE_SUPABASE_URL?.trim();
  if (!raw) throw new Error("COZE_SUPABASE_URL is required");
  const target = new URL(raw);
  const host = target.hostname.toLowerCase();
  if (target.protocol !== "https:" || (host !== SAFE_HOST_ROOT && !host.endsWith(`.${SAFE_HOST_ROOT}`))) {
    throw new Error(`Unexpected database host: ${host}`);
  }
  if (!process.env.COZE_SUPABASE_SERVICE_ROLE_KEY?.trim()) {
    throw new Error("COZE_SUPABASE_SERVICE_ROLE_KEY is required");
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
  if (!process.argv.slice(2).every((argument) => (
    argument === "--apply" || argument.startsWith("--confirm-target-host=")
  ))) throw new Error("Unexpected command argument");
}

async function requiredSingle<T>(
  operation: PromiseLike<{ data: T | null; error: { message?: string } | null }>,
  label: string,
): Promise<T> {
  const result = await operation;
  if (result.error || !result.data) throw new Error(`${label}: ${result.error?.message || "row not found"}`);
  return result.data;
}

async function main() {
  validateArguments();
  const host = safeHost();
  const database = getSupabaseAdminClient();
  const scopes: Array<{
    domain: ManjuConfigDomain;
    generation: number;
    storageRevision: string;
    compatReleaseId: string;
    compatRevisionId: string;
    payload: UnknownRecord;
    payloadHash: string;
    schemaVersion: string;
    state: string;
  }> = [];

  for (const domain of MANJU_CONFIG_DOMAINS) {
    const settingKey = `manju.config.v1.${ENVIRONMENT}.${domain}`;
    const setting = await requiredSingle(
      database.from("platform_settings").select("setting_value,updated_at").eq("setting_key", settingKey).maybeSingle(),
      `Unable to read compatibility config for ${domain}`,
    ) as { setting_value: unknown; updated_at: string };
    const envelope = record(
      typeof setting.setting_value === "string" ? JSON.parse(setting.setting_value) : setting.setting_value,
      `${domain} envelope`,
    );
    if (envelope.format !== "manju-platform-settings-v1" || envelope.environment !== ENVIRONMENT || envelope.domain !== domain) {
      throw new Error(`${domain} compatibility envelope identity is invalid`);
    }
    const active = record(envelope.active, `${domain} active`);
    const pointer = record(active.pointer, `${domain} active pointer`);
    const release = record(active.release, `${domain} active release`);
    const revision = record(active.revision, `${domain} active revision`);
    const payload = record(revision.payload, `${domain} active payload`);
    const payloadHash = text(revision.payload_hash, `${domain} payload hash`).toLowerCase();
    const schemaVersion = text(revision.schema_version, `${domain} schema version`);
    const validated = validateManjuConfigPayload(payload);
    validateManjuDomainContract(domain, validated.payload, schemaVersion);
    if (validated.payloadHash !== payloadHash) throw new Error(`${domain} payload hash is invalid`);
    const compatReleaseId = text(release.id, `${domain} release id`);
    const compatRevisionId = text(revision.id, `${domain} revision id`);
    const releaseNumber = Number(release.release_number);
    const expectedEtag = `${payloadHash}:${releaseNumber}`;
    if (
      pointer.active_release_id !== compatReleaseId
      || pointer.active_revision_id !== compatRevisionId
      || release.revision_id !== compatRevisionId
      || pointer.etag !== expectedEtag
      || release.etag !== expectedEtag
      || revision.status !== "published"
      || !revision.published_at
      || !Number.isSafeInteger(releaseNumber)
      || releaseNumber < 1
    ) throw new Error(`${domain} compatibility active chain is invalid`);
    const storage = await requiredSingle(
      database.from("manju_config_storage_state")
        .select("state,generation,native_active_release_id,native_active_revision_id,native_payload_hash")
        .eq("environment", ENVIRONMENT)
        .eq("domain", domain)
        .maybeSingle(),
      `Unable to read storage state for ${domain}`,
    ) as {
      state: string;
      generation: number;
      native_active_release_id: string | null;
      native_active_revision_id: string | null;
      native_payload_hash: string | null;
    };
    if (storage.state === "native") {
      if (storage.native_payload_hash !== payloadHash) throw new Error(`${domain} native storage payload diverged`);
      scopes.push({
        domain,
        generation: Number(storage.generation),
        storageRevision: setting.updated_at,
        compatReleaseId,
        compatRevisionId,
        payload: validated.payload,
        payloadHash,
        schemaVersion,
        state: "already-native",
      });
      continue;
    }
    if (storage.state !== "compat" || !Number.isSafeInteger(Number(storage.generation)) || Number(storage.generation) < 1) {
      throw new Error(`${domain} storage is not safely cutoverable`);
    }
    scopes.push({
      domain,
      generation: Number(storage.generation),
      storageRevision: setting.updated_at,
      compatReleaseId,
      compatRevisionId,
      payload: validated.payload,
      payloadHash,
      schemaVersion,
      state: "cutover-required",
    });
  }

  console.log(JSON.stringify({
    ok: true,
    mode: APPLY ? "apply" : "plan",
    targetHost: host,
    scopes: scopes.map(({ domain, generation, payloadHash, schemaVersion, state }) => ({
      domain,
      generation,
      payloadHash,
      schemaVersion,
      state,
    })),
  }, null, 2));
  if (!APPLY) return;

  const results: Array<Record<string, unknown>> = [];
  for (const scope of scopes) {
    if (scope.state === "already-native") {
      results.push({ domain: scope.domain, state: "unchanged" });
      continue;
    }
    const existingActiveResult = await database.from("manju_config_active")
      .select("active_release_id,active_revision_id,etag")
      .eq("environment", ENVIRONMENT)
      .eq("domain", scope.domain)
      .maybeSingle();
    if (existingActiveResult.error) throw new Error(`Unable to inspect native active ${scope.domain}: ${existingActiveResult.error.message}`);

    if (!existingActiveResult.data) {
      const draft = await requiredSingle(
        database.rpc("save_manju_config_draft", {
          p_environment: ENVIRONMENT,
          p_domain: scope.domain,
          p_payload: scope.payload,
          p_payload_hash: scope.payloadHash,
          p_schema_version: scope.schemaVersion,
          p_revision_id: null,
          p_expected_updated_at: null,
          p_actor_id: ACTOR,
        }),
        `Unable to create native draft for ${scope.domain}`,
      ) as UnknownRecord;
      const revisionId = text(draft.revision_id, `${scope.domain} native draft id`);
      await requiredSingle(
        database.rpc("publish_manju_config_revision", {
          p_revision_id: revisionId,
          p_expected_active_release_id: null,
          p_actor_id: ACTOR,
        }),
        `Unable to publish native revision for ${scope.domain}`,
      );
    }

    const nativeActive = await requiredSingle(
      database.from("manju_config_active")
        .select("active_release_id,active_revision_id,etag")
        .eq("environment", ENVIRONMENT)
        .eq("domain", scope.domain)
        .maybeSingle(),
      `Unable to read native active ${scope.domain}`,
    ) as { active_release_id: string; active_revision_id: string; etag: string };
    const nativeRevision = await requiredSingle(
      database.from("manju_config_revisions")
        .select("id,environment,domain,status,published_at,payload_hash,schema_version")
        .eq("id", nativeActive.active_revision_id)
        .maybeSingle(),
      `Unable to read native revision ${scope.domain}`,
    ) as { id: string; environment: string; domain: string; status: string; published_at: string | null; payload_hash: string; schema_version: string };
    if (
      nativeRevision.environment !== ENVIRONMENT
      || nativeRevision.domain !== scope.domain
      || nativeRevision.status !== "published"
      || !nativeRevision.published_at
      || nativeRevision.payload_hash !== scope.payloadHash
      || nativeRevision.schema_version !== scope.schemaVersion
    ) throw new Error(`${scope.domain} native active revision does not match compatibility payload`);

    await requiredSingle(
      database.rpc("cutover_manju_config_storage", {
        p_environment: ENVIRONMENT,
        p_domain: scope.domain,
        p_expected_generation: scope.generation,
        p_expected_compat_storage_revision: scope.storageRevision,
        p_expected_compat_active_release_id: scope.compatReleaseId,
        p_expected_compat_active_revision_id: scope.compatRevisionId,
        p_expected_compat_payload_hash: scope.payloadHash,
        p_expected_native_active_release_id: nativeActive.active_release_id,
        p_expected_native_active_revision_id: nativeActive.active_revision_id,
        p_expected_native_payload_hash: nativeRevision.payload_hash,
        p_actor_id: ACTOR,
      }),
      `Unable to cut over ${scope.domain}`,
    );
    results.push({
      domain: scope.domain,
      state: "native",
      payloadHash: scope.payloadHash,
      nativeReleaseId: nativeActive.active_release_id,
      nativeRevisionId: nativeActive.active_revision_id,
    });
  }

  console.log(JSON.stringify({ ok: true, mode: "apply-result", results }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
