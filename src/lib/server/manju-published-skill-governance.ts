import "server-only";

import {
  loadManjuCompatAdmin,
  loadManjuStorageStates,
} from "@/lib/server/manju-platform-settings-store";
import {
  validateManjuConfigPayload,
  validateManjuDomainContract,
} from "@/lib/server/manju-runtime-config";
import { getSupabaseAdminClient } from "@/storage/database/supabase-client";

export type ManjuSkillOverrideMode = "supplement" | "replace_full_instruction";

export interface ManjuSkillPromptOverride {
  enabled: boolean;
  title?: string;
  summary?: string;
  instructionOverride?: string;
  overrideMode: ManjuSkillOverrideMode;
  triggerTerms?: string[];
  updatedReason?: string;
  adminNote?: string;
}

export interface PublishedMangaSkillGovernance {
  source: "published-native" | "published-compat" | "source-fallback";
  releaseId: string | null;
  overrides: Record<string, ManjuSkillPromptOverride>;
}

interface RawSkillPromptOverride {
  enabled?: unknown;
  title?: unknown;
  summary?: unknown;
  instruction_override?: unknown;
  override_mode?: unknown;
  trigger_terms?: unknown;
  updated_reason?: unknown;
  admin_note?: unknown;
}

interface RawSkillPayload {
  skill_prompt_overrides?: Record<string, RawSkillPromptOverride>;
}

const FALLBACK_GOVERNANCE: PublishedMangaSkillGovernance = {
  source: "source-fallback",
  releaseId: null,
  overrides: {},
};

function fallbackGovernanceFor(cacheKey: string): PublishedMangaSkillGovernance {
  return readCached(cacheKey) ?? remember(cacheKey, FALLBACK_GOVERNANCE);
}

export class ManjuPublishedSkillGovernanceUnavailableError extends Error {
  readonly code = "MANJU_PUBLISHED_SKILL_GOVERNANCE_UNAVAILABLE";

  constructor(message = "漫剧 Skill 治理配置暂时不可用") {
    super(message);
    this.name = "ManjuPublishedSkillGovernanceUnavailableError";
  }
}

let cached: { cacheKey: string; expiresAt: number; value: PublishedMangaSkillGovernance } | null = null;

function cacheTtlMs(): number {
  const configured = Number(process.env.MANJU_SKILL_GOVERNANCE_CACHE_TTL_MS ?? "5000");
  if (!Number.isFinite(configured)) return 5_000;
  return Math.max(0, Math.min(60_000, Math.trunc(configured)));
}

function normalizeCommandName(value: string): string {
  return value.trim().replace(/^\/+/u, "").toLowerCase();
}

function readCached(cacheKey: string): PublishedMangaSkillGovernance | null {
  if (!cached || cached.cacheKey !== cacheKey || cached.expiresAt <= Date.now()) return null;
  return cached.value;
}

function remember(cacheKey: string, value: PublishedMangaSkillGovernance): PublishedMangaSkillGovernance {
  cached = { cacheKey, value, expiresAt: Date.now() + cacheTtlMs() };
  return value;
}

function textOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function triggerTerms(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const terms = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
  return terms.length > 0 ? terms : undefined;
}

function overrideFromRaw(raw: RawSkillPromptOverride): ManjuSkillPromptOverride {
  const mode = raw.override_mode === "replace_full_instruction"
    ? "replace_full_instruction"
    : "supplement";
  return {
    enabled: raw.enabled !== false,
    overrideMode: mode,
    ...(textOrUndefined(raw.title) ? { title: textOrUndefined(raw.title) } : {}),
    ...(textOrUndefined(raw.summary) ? { summary: textOrUndefined(raw.summary) } : {}),
    ...(textOrUndefined(raw.instruction_override) ? { instructionOverride: textOrUndefined(raw.instruction_override) } : {}),
    ...(triggerTerms(raw.trigger_terms) ? { triggerTerms: triggerTerms(raw.trigger_terms) } : {}),
    ...(textOrUndefined(raw.updated_reason) ? { updatedReason: textOrUndefined(raw.updated_reason) } : {}),
    ...(textOrUndefined(raw.admin_note) ? { adminNote: textOrUndefined(raw.admin_note) } : {}),
  };
}

function governanceFromPayload(
  payload: unknown,
  source: PublishedMangaSkillGovernance["source"],
  releaseId: string | null,
): PublishedMangaSkillGovernance | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const overridesRaw = (payload as RawSkillPayload).skill_prompt_overrides;
  if (!overridesRaw || typeof overridesRaw !== "object" || Array.isArray(overridesRaw)) return null;
  const overrides: Record<string, ManjuSkillPromptOverride> = {};
  for (const [command, raw] of Object.entries(overridesRaw)) {
    const normalized = normalizeCommandName(command);
    if (!normalized || !raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    overrides[normalized] = overrideFromRaw(raw);
  }
  return { source, releaseId, overrides };
}

async function loadCompatGovernance(
  database: ReturnType<typeof getSupabaseAdminClient>,
  generation: number,
): Promise<PublishedMangaSkillGovernance> {
  const view = await loadManjuCompatAdmin(database, "production", "skill");
  if (!view.active) {
    if (generation !== 0) {
      throw new ManjuPublishedSkillGovernanceUnavailableError("兼容配置已纳入权威存储，但尚未发布漫剧 Skill 治理配置");
    }
    return readCached("compat:0:none") ?? remember("compat:0:none", FALLBACK_GOVERNANCE);
  }
  const cacheKey = ["compat", generation, view.active.release.id, view.active.revision.id, view.active.release.etag].join(":");
  const cacheHit = readCached(cacheKey);
  if (cacheHit) return cacheHit;
  const validated = validateManjuConfigPayload(view.active.revision.payload);
  validateManjuDomainContract("skill", validated.payload, view.active.revision.schema_version);
  if (validated.payloadHash !== view.active.revision.payload_hash) {
    throw new ManjuPublishedSkillGovernanceUnavailableError("兼容存储中的已发布 Skill 治理哈希不一致");
  }
  const governance = governanceFromPayload(validated.payload, "published-compat", view.active.release.id);
  if (!governance) {
    if (generation === 0) {
      return fallbackGovernanceFor(["compat", generation, "legacy-skill-payload"].join(":"));
    }
    throw new ManjuPublishedSkillGovernanceUnavailableError("兼容存储中的已发布 Skill 治理结构无效");
  }
  return remember(cacheKey, governance);
}

async function loadUncached(): Promise<PublishedMangaSkillGovernance> {
  if (!process.env.COZE_SUPABASE_SERVICE_ROLE_KEY?.trim()) {
    throw new ManjuPublishedSkillGovernanceUnavailableError("漫剧 Skill 治理服务缺少数据库服务凭据");
  }

  const database = getSupabaseAdminClient();
  const storage = (await loadManjuStorageStates(database, "production", ["skill"])).skill;
  if (storage.mode === "compat") {
    return loadCompatGovernance(database, storage.generation);
  }

  const activeResult = await database
    .from("manju_config_active")
    .select("environment,domain,active_release_id,active_revision_id,etag")
    .eq("environment", "production")
    .eq("domain", "skill")
    .maybeSingle();
  if (activeResult.error) {
    throw new ManjuPublishedSkillGovernanceUnavailableError("原生漫剧 Skill 治理活动指针读取失败");
  }

  const active = activeResult.data;
  if (!active) throw new ManjuPublishedSkillGovernanceUnavailableError("原生漫剧 Skill 治理缺少活动版本");
  const cacheKey = ["native", storage.generation, active.active_release_id, active.active_revision_id, active.etag].join(":");
  const cacheHit = readCached(cacheKey);
  if (cacheHit) return cacheHit;

  const [releaseResult, revisionResult] = await Promise.all([
    database
      .from("manju_config_releases")
      .select("id,environment,domain,release_number,revision_id,release_kind,etag")
      .eq("id", active.active_release_id)
      .maybeSingle(),
    database
      .from("manju_config_revisions")
      .select("id,environment,domain,status,payload,payload_hash,schema_version,published_at")
      .eq("id", active.active_revision_id)
      .maybeSingle(),
  ]);
  if (releaseResult.error || revisionResult.error) {
    throw new ManjuPublishedSkillGovernanceUnavailableError("原生漫剧 Skill 治理发布记录读取失败");
  }
  const release = releaseResult.data;
  const revision = revisionResult.data;
  const consistent = Boolean(
    release
      && revision
      && active.environment === "production"
      && active.domain === "skill"
      && release.environment === "production"
      && release.domain === "skill"
      && release.id === active.active_release_id
      && release.revision_id === active.active_revision_id
      && (release.release_kind === "publish" || release.release_kind === "rollback")
      && revision.environment === "production"
      && revision.domain === "skill"
      && revision.id === active.active_revision_id
      && revision.status === "published"
      && Boolean(revision.published_at)
      && release.etag === active.etag
      && release.etag === `${revision.payload_hash}:${release.release_number}`,
  );
  if (!consistent || !release || !revision) {
    throw new ManjuPublishedSkillGovernanceUnavailableError("原生漫剧 Skill 治理活动版本不一致");
  }

  const validated = validateManjuConfigPayload(revision.payload);
  validateManjuDomainContract("skill", validated.payload, revision.schema_version);
  if (validated.payloadHash !== revision.payload_hash) {
    throw new ManjuPublishedSkillGovernanceUnavailableError("原生漫剧 Skill 治理内容哈希不一致");
  }
  const governance = governanceFromPayload(validated.payload, "published-native", release.id);
  if (!governance) throw new ManjuPublishedSkillGovernanceUnavailableError("原生漫剧 Skill 治理结构无效");
  return remember(cacheKey, governance);
}

export async function loadPublishedMangaSkillGovernance(): Promise<PublishedMangaSkillGovernance> {
  try {
    return await loadUncached();
  } catch (error) {
    if (error instanceof ManjuPublishedSkillGovernanceUnavailableError) throw error;
    throw new ManjuPublishedSkillGovernanceUnavailableError();
  }
}

export function clearPublishedMangaSkillGovernanceCacheForTests(): void {
  cached = null;
}
