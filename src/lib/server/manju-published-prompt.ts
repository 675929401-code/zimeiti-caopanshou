import "server-only";

import {
  MANGA_CREATIVE_AGENT_FALLBACK_PROMPT_ID,
  MANGA_CREATIVE_AGENT_FALLBACK_PROMPT_VERSION,
  MANGA_CREATIVE_AGENT_SYSTEM_PROMPT,
} from "@/lib/server/manga-creative-agent-system-prompt";
import {
  loadManjuCompatAdmin,
  loadManjuStorageStates,
} from "@/lib/server/manju-platform-settings-store";
import {
  validateManjuConfigPayload,
  validateManjuDomainContract,
} from "@/lib/server/manju-runtime-config";
import { getSupabaseAdminClient } from "@/storage/database/supabase-client";

export interface PublishedMangaPrompt {
  id: string;
  version: string;
  content: string;
  source: "published-native" | "published-compat" | "source-fallback";
  releaseId: string | null;
}

interface PromptRecord {
  version?: unknown;
  content?: unknown;
}

interface PromptPayload {
  runtime_prompts?: Record<string, PromptRecord>;
}

const FALLBACK_PROMPT: PublishedMangaPrompt = {
  id: MANGA_CREATIVE_AGENT_FALLBACK_PROMPT_ID,
  version: MANGA_CREATIVE_AGENT_FALLBACK_PROMPT_VERSION,
  content: MANGA_CREATIVE_AGENT_SYSTEM_PROMPT,
  source: "source-fallback",
  releaseId: null,
};

export class ManjuPublishedPromptUnavailableError extends Error {
  readonly code = "MANJU_PUBLISHED_PROMPT_UNAVAILABLE";

  constructor(message = "漫剧运行提示词暂时不可用") {
    super(message);
    this.name = "ManjuPublishedPromptUnavailableError";
  }
}

let cached: { cacheKey: string; expiresAt: number; value: PublishedMangaPrompt } | null = null;

function cacheTtlMs(): number {
  const configured = Number(process.env.MANJU_PROMPT_CACHE_TTL_MS ?? "5000");
  if (!Number.isFinite(configured)) return 5_000;
  return Math.max(0, Math.min(60_000, Math.trunc(configured)));
}

function readCachedPrompt(cacheKey: string): PublishedMangaPrompt | null {
  if (!cached || cached.cacheKey !== cacheKey || cached.expiresAt <= Date.now()) return null;
  return cached.value;
}

function rememberPrompt(cacheKey: string, value: PublishedMangaPrompt): PublishedMangaPrompt {
  cached = { cacheKey, value, expiresAt: Date.now() + cacheTtlMs() };
  return value;
}

function promptFromPayload(
  payload: unknown,
  source: PublishedMangaPrompt["source"],
  releaseId: string | null,
): PublishedMangaPrompt | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const runtimePrompts = (payload as PromptPayload).runtime_prompts;
  if (!runtimePrompts || typeof runtimePrompts !== "object" || Array.isArray(runtimePrompts)) {
    return null;
  }
  const record = runtimePrompts[MANGA_CREATIVE_AGENT_FALLBACK_PROMPT_ID];
  if (!record || typeof record !== "object" || Array.isArray(record)) return null;
  const content = typeof record.content === "string" ? record.content.trim() : "";
  const version = typeof record.version === "string" ? record.version.trim() : "";
  if (content.length < 200 || content.length > 240_000 || !version || version.length > 80) {
    return null;
  }
  return {
    id: MANGA_CREATIVE_AGENT_FALLBACK_PROMPT_ID,
    version,
    content,
    source,
    releaseId,
  };
}

async function loadCompatPrompt(
  database: ReturnType<typeof getSupabaseAdminClient>,
  generation: number,
): Promise<PublishedMangaPrompt> {
  const view = await loadManjuCompatAdmin(database, "production", "prompt");
  if (!view.active) {
    if (generation !== 0) {
      throw new ManjuPublishedPromptUnavailableError("兼容配置已纳入权威存储，但尚未发布漫剧运行提示词");
    }
    const cacheKey = "compat:0:none";
    return readCachedPrompt(cacheKey) ?? rememberPrompt(cacheKey, FALLBACK_PROMPT);
  }
  const cacheKey = [
    "compat",
    generation,
    view.active.release.id,
    view.active.revision.id,
    view.active.release.etag,
  ].join(":");
  const cacheHit = readCachedPrompt(cacheKey);
  if (cacheHit) return cacheHit;
  const prompt = promptFromPayload(
    view.active.revision.payload,
    "published-compat",
    view.active.release.id,
  );
  if (!prompt) {
    throw new ManjuPublishedPromptUnavailableError("兼容存储中的已发布漫剧提示词结构无效");
  }
  return rememberPrompt(cacheKey, prompt);
}

async function loadUncached(): Promise<PublishedMangaPrompt> {
  if (!process.env.COZE_SUPABASE_SERVICE_ROLE_KEY?.trim()) {
    throw new ManjuPublishedPromptUnavailableError("漫剧提示词服务缺少数据库服务凭据");
  }

  const database = getSupabaseAdminClient();
  const storage = (await loadManjuStorageStates(database, "production", ["prompt"])).prompt;
  if (storage.mode === "compat") {
    return loadCompatPrompt(database, storage.generation);
  }

  const activeResult = await database
    .from("manju_config_active")
    .select("environment,domain,active_release_id,active_revision_id,etag")
    .eq("environment", "production")
    .eq("domain", "prompt")
    .maybeSingle();

  if (activeResult.error) throw new ManjuPublishedPromptUnavailableError("原生漫剧提示词活动指针读取失败");

  const active = activeResult.data;
  if (!active) throw new ManjuPublishedPromptUnavailableError("原生漫剧提示词缺少活动版本");
  if (active.environment !== "production" || active.domain !== "prompt") {
    throw new ManjuPublishedPromptUnavailableError("原生漫剧提示词活动指针超出请求范围");
  }
  const cacheKey = [
    "native",
    storage.generation,
    active.active_release_id,
    active.active_revision_id,
    active.etag,
  ].join(":");
  const cacheHit = readCachedPrompt(cacheKey);
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
    throw new ManjuPublishedPromptUnavailableError("原生漫剧提示词发布记录读取失败");
  }
  const release = releaseResult.data;
  const revision = revisionResult.data;
  const consistent = Boolean(
    release &&
      revision &&
      active.environment === "production" &&
      active.domain === "prompt" &&
      release.environment === "production" &&
      release.domain === "prompt" &&
      release.id === active.active_release_id &&
      release.revision_id === active.active_revision_id &&
      (release.release_kind === "publish" || release.release_kind === "rollback") &&
      revision.environment === "production" &&
      revision.domain === "prompt" &&
      revision.id === active.active_revision_id &&
      revision.status === "published" &&
      Boolean(revision.published_at) &&
      release.etag === active.etag &&
      release.etag === `${revision.payload_hash}:${release.release_number}`,
  );
  if (!consistent || !release || !revision) {
    throw new ManjuPublishedPromptUnavailableError("原生漫剧提示词活动版本不一致");
  }

  const validated = validateManjuConfigPayload(revision.payload);
  validateManjuDomainContract("prompt", validated.payload, revision.schema_version);
  if (validated.payloadHash !== revision.payload_hash) {
    throw new ManjuPublishedPromptUnavailableError("原生漫剧提示词内容哈希不一致");
  }

  const prompt = promptFromPayload(validated.payload, "published-native", release.id);
  if (!prompt) throw new ManjuPublishedPromptUnavailableError("原生漫剧提示词结构无效");
  return rememberPrompt(cacheKey, prompt);
}

/**
 * Returns the private prompt used by the manga Agent. It never returns data to
 * a browser-facing endpoint. Source fallback is limited to the legacy compat
 * state with no published prompt; native-state corruption throws before any
 * provider call or billing action.
 */
export async function loadPublishedMangaPrompt(): Promise<PublishedMangaPrompt> {
  try {
    return await loadUncached();
  } catch (error) {
    if (error instanceof ManjuPublishedPromptUnavailableError) throw error;
    throw new ManjuPublishedPromptUnavailableError();
  }
}

export function clearPublishedMangaPromptCacheForTests(): void {
  cached = null;
}
