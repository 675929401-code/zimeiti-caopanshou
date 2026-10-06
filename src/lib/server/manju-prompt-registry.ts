import "server-only";

import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { MANGA_CREATIVE_AGENT_PROMPT_VERSION } from "@/lib/manga-creative-agent-prompt";
import {
  loadManjuCompatAdmin,
  loadManjuStorageStates,
} from "@/lib/server/manju-platform-settings-store";
import { MANGA_CREATIVE_AGENT_SYSTEM_PROMPT } from "@/lib/server/manga-creative-agent-system-prompt";
import {
  loadPublishedMangaPrompt,
  type PublishedMangaPrompt,
} from "@/lib/server/manju-published-prompt";
import {
  validateManjuConfigPayload,
  validateManjuDomainContract,
} from "@/lib/server/manju-runtime-config";

export const MANJU_PROMPT_REGISTRY_VERSION = "manju-prompt-registry.v2.manju-only";

export type ManjuPromptKind =
  | "manga_base"
  | "manga_effective"
  | "manju_prompt_policy";

export interface ManjuPromptEditTarget {
  type: "admin_route" | "source_file";
  label: string;
  value: string;
}

export interface ManjuPromptRecord {
  id: string;
  name: string;
  source: string;
  version: string;
  hash: string;
  editable: boolean;
  runtime_authoritative: boolean;
  content: string;
  kind: ManjuPromptKind;
  edit_target: ManjuPromptEditTarget;
  runtime_effect: string;
  release_id?: string | null;
  enabled?: boolean;
}

export interface ManjuPromptSourceStatus {
  id:
    | "manga_base"
    | "effective_manga_prompt"
    | "published_prompt_domain";
  name: string;
  state: "ready" | "fallback" | "unavailable";
  count: number;
  message: string;
}

export interface ManjuPromptRegistrySnapshot {
  ok: boolean;
  state: "ready" | "degraded";
  registry_version: string;
  generated_at: string;
  prompts: ManjuPromptRecord[];
  sources: ManjuPromptSourceStatus[];
}

interface NativePromptPointerRow {
  environment: string;
  domain: string;
  active_revision_id: string;
  active_release_id: string;
  etag: string;
}

interface NativePromptRevisionRow {
  id: string;
  environment: string;
  domain: string;
  version: number;
  payload: Record<string, unknown>;
  payload_hash: string;
  schema_version: string;
  status: string;
  published_at: string | null;
}

interface NativePromptReleaseRow {
  id: string;
  environment: string;
  domain: string;
  release_number: number;
  revision_id: string;
  release_kind: string;
  etag: string;
}

function promptHash(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function sourceFileTarget(label: string, value: string): ManjuPromptEditTarget {
  return { type: "source_file", label, value };
}

function adminRouteTarget(label: string, value: string): ManjuPromptEditTarget {
  return { type: "admin_route", label, value };
}

function createMangaBasePrompt(): ManjuPromptRecord {
  const content = MANGA_CREATIVE_AGENT_SYSTEM_PROMPT;
  return {
    id: "manga:creative-agent:base",
    name: "漫剧工作台创作 Agent · 代码回退基线",
    source: "source:src/lib/server/manga-creative-agent-system-prompt.data.ts",
    version: MANGA_CREATIVE_AGENT_PROMPT_VERSION,
    hash: promptHash(content),
    editable: false,
    runtime_authoritative: false,
    content,
    kind: "manga_base",
    edit_target: sourceFileTarget(
      "源码版本管理",
      "src/lib/server/manga-creative-agent-system-prompt.data.ts",
    ),
    runtime_effect: "这是受审的代码回退基线；仅在尚未建立权威存储状态且没有已发布提示词的 legacy 初始化阶段使用。显式 compat/native 异常会直接停止 LLM 调用。",
    enabled: true,
  };
}

function createEffectiveMangaPrompt(
  effective: PublishedMangaPrompt,
): ManjuPromptRecord {
  const fromPublishedRelease = effective.source !== "source-fallback";
  const runtimeEffect = effective.source === "published-native"
    ? "LLM 当前通过原生 production/prompt 活动发布使用此内容。"
    : effective.source === "published-compat"
      ? "LLM 当前通过 platform_settings 兼容活动发布使用此内容。"
      : "没有可通过服务端校验的已发布运行提示词；LLM 当前使用受审代码回退基线。";

  return {
    id: `manga:creative-agent:effective:${effective.id}`,
    name: "漫剧工作台创作 Agent · 当前实际生效提示词",
    source: effective.source,
    version: effective.version,
    hash: promptHash(effective.content),
    editable: fromPublishedRelease,
    runtime_authoritative: true,
    content: effective.content,
    kind: "manga_effective",
    edit_target: fromPublishedRelease
      ? adminRouteTarget("漫剧配置中心", "/admin?tab=manju-workbench")
      : sourceFileTarget(
        "源码回退基线",
        "src/lib/server/manga-creative-agent-system-prompt.data.ts",
      ),
    runtime_effect: runtimeEffect,
    release_id: effective.releaseId,
    enabled: true,
  };
}

function publishedPromptDomainRecord(
  contentValue: Record<string, unknown>,
  source: string,
  version: string,
  releaseId: string,
): ManjuPromptRecord {
  const content = JSON.stringify(contentValue, null, 2);
  return {
    id: "manju:production:prompt:published",
    name: "Manju prompt 域 · 当前已发布内容",
    source,
    version,
    hash: promptHash(content),
    editable: true,
    runtime_authoritative: false,
    content,
    kind: "manju_prompt_policy",
    edit_target: adminRouteTarget("漫剧配置中心", "/admin?tab=manju-workbench"),
    runtime_effect: "这是完整 production/prompt 治理信封；服务端只会校验并选取 runtime_prompts.manga_virtual_agent_prompt 作为 LLM 正文，当前实际生效结果以“当前实际生效提示词”记录为准。",
    release_id: releaseId,
    enabled: true,
  };
}

async function loadCompatPublishedPromptDomain(
  client: SupabaseClient,
): Promise<{
  prompts: ManjuPromptRecord[];
  status: ManjuPromptSourceStatus;
}> {
  try {
    const compat = await loadManjuCompatAdmin(client, "production", "prompt");
    const active = compat.active;
    if (!active) {
      return {
        prompts: [],
        status: {
          id: "published_prompt_domain",
          name: "已发布 prompt 域",
          state: "unavailable",
          count: 0,
          message: "兼容存储中没有 production/prompt 活动版本。",
        },
      };
    }
    return {
      prompts: [publishedPromptDomainRecord(
        active.revision.payload as Record<string, unknown>,
        "database:platform_settings.manju.config.v1.production.prompt",
        String(active.revision.version),
        active.release.id,
      )],
      status: {
        id: "published_prompt_domain",
        name: "已发布 prompt 域",
        state: "ready",
        count: 1,
        message: "当前从 platform_settings 兼容活动版本读取完整域；其中通过校验的 runtime prompt 可能成为 LLM 实际正文。",
      },
    };
  } catch {
    return {
      prompts: [],
      status: {
        id: "published_prompt_domain",
        name: "已发布 prompt 域",
        state: "unavailable",
        count: 0,
        message: "production/prompt 兼容活动版本暂时无法读取。",
      },
    };
  }
}

async function loadPublishedPromptDomain(client: SupabaseClient): Promise<{
  prompts: ManjuPromptRecord[];
  status: ManjuPromptSourceStatus;
}> {
  let storageMode: "compat" | "native";
  try {
    storageMode = (await loadManjuStorageStates(client, "production", ["prompt"])).prompt.mode;
  } catch {
    return {
      prompts: [],
      status: {
        id: "published_prompt_domain",
        name: "已发布 prompt 域",
        state: "unavailable",
        count: 0,
        message: "production/prompt 权威存储状态不可用，已停止猜测配置来源。",
      },
    };
  }

  if (storageMode === "compat") {
    return loadCompatPublishedPromptDomain(client);
  }

  const pointerResult = await client
    .from("manju_config_active")
    .select("environment,domain,active_revision_id,active_release_id,etag")
    .eq("environment", "production")
    .eq("domain", "prompt")
    .maybeSingle();

  if (pointerResult.error) {
    return {
      prompts: [],
      status: {
        id: "published_prompt_domain",
        name: "已发布 prompt 域",
        state: "unavailable",
        count: 0,
        message: "production/prompt 活动指针暂时无法读取。",
      },
    };
  }

  const pointer = (pointerResult.data ?? null) as NativePromptPointerRow | null;
  if (!pointer) {
    return {
      prompts: [],
      status: {
        id: "published_prompt_domain",
        name: "已发布 prompt 域",
        state: "unavailable",
        count: 0,
        message: "权威状态为原生存储，但 production/prompt 缺少活动指针。",
      },
    };
  }

  const [releaseResult, revisionResult] = await Promise.all([
    client
      .from("manju_config_releases")
      .select("id,environment,domain,release_number,revision_id,release_kind,etag")
      .eq("id", pointer.active_release_id)
      .maybeSingle(),
    client
      .from("manju_config_revisions")
      .select("id,environment,domain,version,payload,payload_hash,schema_version,status,published_at")
      .eq("id", pointer.active_revision_id)
      .maybeSingle(),
  ]);
  const release = (releaseResult.data ?? null) as NativePromptReleaseRow | null;
  const revision = (revisionResult.data ?? null) as NativePromptRevisionRow | null;
  if (
    releaseResult.error
    || revisionResult.error
    || !release
    || !revision
    || pointer.environment !== "production"
    || pointer.domain !== "prompt"
    || release.id !== pointer.active_release_id
    || release.environment !== "production"
    || release.domain !== "prompt"
    || release.revision_id !== pointer.active_revision_id
    || (release.release_kind !== "publish" && release.release_kind !== "rollback")
    || revision.id !== pointer.active_revision_id
    || revision.environment !== "production"
    || revision.domain !== "prompt"
    || revision.status !== "published"
    || !revision.published_at
    || pointer.etag !== release.etag
    || release.etag !== `${revision.payload_hash}:${release.release_number}`
  ) {
    return {
      prompts: [],
      status: {
        id: "published_prompt_domain",
        name: "已发布 prompt 域",
        state: "unavailable",
        count: 0,
        message: "production/prompt 活动指针与已发布修订不一致。",
      },
    };
  }

  let validatedPayload: Record<string, unknown>;
  try {
    const validated = validateManjuConfigPayload(revision.payload);
    validateManjuDomainContract("prompt", validated.payload, revision.schema_version);
    if (validated.payloadHash !== revision.payload_hash) throw new Error("payload hash mismatch");
    validatedPayload = validated.payload;
  } catch {
    return {
      prompts: [],
      status: {
        id: "published_prompt_domain",
        name: "已发布 prompt 域",
        state: "unavailable",
        count: 0,
        message: "production/prompt 活动修订未通过结构或内容哈希校验。",
      },
    };
  }

  return {
    prompts: [publishedPromptDomainRecord(
      validatedPayload,
      "database:manju_config_revisions.production.prompt",
      `${revision.version} / schema ${revision.schema_version}`,
      release.id,
    )],
    status: {
      id: "published_prompt_domain",
      name: "已发布 prompt 域",
      state: "ready",
      count: 1,
      message: "当前从原生 production/prompt 活动修订读取完整域；其中通过校验的 runtime prompt 可能成为 LLM 实际正文。",
    },
  };
}

interface EffectiveMangaPromptDiagnostic {
  value: PublishedMangaPrompt | null;
  status: ManjuPromptSourceStatus;
}

async function loadEffectiveMangaPromptDiagnostic(): Promise<EffectiveMangaPromptDiagnostic> {
  try {
    const value = await loadPublishedMangaPrompt();
    return {
      value,
      status: {
        id: "effective_manga_prompt",
        name: "漫剧 Agent 当前实际生效提示词",
        state: value.source === "source-fallback" ? "fallback" : "ready",
        count: 1,
        message: value.source === "source-fallback"
          ? "当前使用受审源码回退基线。"
          : `当前使用 ${value.source} 的已校验发布内容，release ${value.releaseId || "未记录"}。`,
      },
    };
  } catch {
    return {
      value: null,
      status: {
        id: "effective_manga_prompt",
        name: "漫剧 Agent 当前实际生效提示词",
        state: "unavailable",
        count: 0,
        message: "运行时提示词未通过权威存储校验；LLM 已停止调用，但其余后台事实源仍可检查和修复。",
      },
    };
  }
}

async function loadConsistentPublishedPromptInspection(client: SupabaseClient): Promise<{
  effective: EffectiveMangaPromptDiagnostic;
  domain: Awaited<ReturnType<typeof loadPublishedPromptDomain>>;
}> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const [effective, domain] = await Promise.all([
      loadEffectiveMangaPromptDiagnostic(),
      loadPublishedPromptDomain(client),
    ]);
    const domainReleaseId = domain.prompts[0]?.release_id ?? null;
    const effectiveReleaseId = effective.value?.releaseId ?? null;
    const mustMatch = effective.value?.source !== "source-fallback" || domain.prompts.length > 0;
    if (!effective.value || !mustMatch || effectiveReleaseId === domainReleaseId) {
      return { effective, domain };
    }
  }
  return {
    effective: {
      value: null,
      status: {
        id: "effective_manga_prompt",
        name: "漫剧 Agent 当前实际生效提示词",
        state: "unavailable",
        count: 0,
        message: "发布指针在检查期间发生变化，请刷新后重试；本次不展示可能错配的运行提示词。",
      },
    },
    domain: {
      prompts: [],
      status: {
        id: "published_prompt_domain",
        name: "已发布 prompt 域",
        state: "unavailable",
        count: 0,
        message: "发布指针在检查期间发生变化，请刷新后重试。",
      },
    },
  };
}

export async function loadManjuPromptRegistry(
  client: SupabaseClient,
): Promise<ManjuPromptRegistrySnapshot> {
  const mangaPrompt = createMangaBasePrompt();
  const publishedInspection = await loadConsistentPublishedPromptInspection(client);
  const effectiveMangaPrompt = publishedInspection.effective;
  const publishedPromptDomain = publishedInspection.domain;

  const sources: ManjuPromptSourceStatus[] = [
    {
      id: "manga_base",
      name: "漫剧创作 Agent 代码回退基线",
      state: "ready",
      count: 1,
      message: "受审源码回退基线；它不代表每次都是当前实际生效内容。",
    },
    effectiveMangaPrompt.status,
    publishedPromptDomain.status,
  ];
  const degraded = sources.some((sourceStatus) => sourceStatus.state !== "ready");

  return {
    ok: !sources.some((sourceStatus) => sourceStatus.state === "unavailable"),
    state: degraded ? "degraded" : "ready",
    registry_version: MANJU_PROMPT_REGISTRY_VERSION,
    generated_at: new Date().toISOString(),
    prompts: [
      mangaPrompt,
      ...(effectiveMangaPrompt.value ? [createEffectiveMangaPrompt(effectiveMangaPrompt.value)] : []),
      ...publishedPromptDomain.prompts,
    ],
    sources,
  };
}
