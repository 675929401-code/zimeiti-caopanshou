"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  ArrowUpRight,
  CheckCircle2,
  Copy,
  Database,
  LoaderCircle,
  RefreshCw,
  Save,
  Search,
  Send,
  ShieldCheck,
  SlidersHorizontal,
  WandSparkles,
} from "lucide-react";

interface Props {
  token: string;
}

interface PackageStoreSummary {
  ok: boolean;
  state: string;
  code?: string;
  count: number;
  by_origin: Record<string, number>;
  by_lifecycle: Record<string, number>;
  message: string;
}

interface ConfigStoreSummary {
  ok: boolean;
  state: string;
  mode?: "native" | "compat";
  generation?: number;
  code?: string;
  message: string;
}

interface SkillGovernanceRow {
  id: string;
  order: number;
  title: string;
  commandName: string;
  categoryLabel: string;
  source: "official" | "community";
  sourceLabel: string;
  version: string;
  author: string;
  tags: string[];
  triggerTerms: string[];
  installedByDefault: boolean;
  agentAutoInvokeEnabled: boolean;
  summary: string;
  governance: {
    lane: string;
    adminEditable: boolean;
    userEditable: boolean;
    runtimeConnected: boolean;
    editTarget: string;
    frontRoute: string;
    configDomain: string;
  };
  instruction: {
    present: boolean;
    version: string;
    provenance: string;
    origin: string;
    length: number;
    hash: string;
  };
}

interface SkillGovernancePayload {
  ok?: boolean;
  version?: string;
  generatedAt?: string;
  counts?: {
    total: number;
    officialBuiltIn: number;
    publicReferenceBuiltIn: number;
    runtimeConnected: number;
    userEditableBuiltIn: number;
    adminEditableBuiltIn: number;
  };
  packageStore?: PackageStoreSummary;
  configStore?: ConfigStoreSummary;
  baselinePayload?: Record<string, unknown>;
  skills?: SkillGovernanceRow[];
  error?: string;
  code?: string;
}

interface ConfigRevision {
  id?: string;
  revision_id?: string;
  release_id?: string;
  active_release_id?: string;
  version?: number | string;
  status?: string;
  payload?: unknown;
  updated_at?: string;
  published_at?: string;
  pointer?: ConfigRevision | null;
  release?: ConfigRevision | null;
  revision?: ConfigRevision | null;
}

interface ConfigResponse {
  ok?: boolean;
  storage_mode?: "native" | "compat";
  storage_generation?: number;
  error?: string;
  code?: string;
  active?: ConfigRevision | null;
  drafts?: ConfigRevision[];
  history?: ConfigRevision[];
  revision?: ConfigRevision;
  release?: ConfigRevision;
}

interface SkillOverrideDraft {
  enabled: boolean;
  title: string;
  summary: string;
  override_mode: "supplement" | "replace_full_instruction";
  trigger_terms_text: string;
  instruction_override: string;
  updated_reason: string;
  admin_note: string;
}

const FILTERS = [
  { value: "all", label: "全部" },
  { value: "official", label: "平台官方" },
  { value: "community", label: "公开参考" },
] as const;

const ENVIRONMENT = "production";
const DOMAIN = "skill";
const SCHEMA_VERSION = "1.1.0";
function shortHash(value: string): string {
  if (!value) return "未生成";
  return `${value.slice(0, 8)}…${value.slice(-6)}`;
}

function formatTime(value?: string): string {
  if (!value) return "未读取";
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return value;
  return new Date(timestamp).toLocaleString("zh-CN");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function revisionValue(record: ConfigRevision | null | undefined): ConfigRevision {
  return record?.revision || record || {};
}

function revisionId(record: ConfigRevision | null | undefined): string {
  const revision = revisionValue(record);
  return String(record?.revision_id || record?.release?.revision_id || revision.revision_id || revision.id || "");
}

function releaseId(record: ConfigRevision | null | undefined): string {
  return String(record?.release_id || record?.active_release_id || record?.release?.id || record?.id || "");
}

function revisionPayload(record: ConfigRevision | null | undefined): Record<string, unknown> {
  const payload = revisionValue(record).payload;
  return isRecord(payload) ? JSON.parse(JSON.stringify(payload)) as Record<string, unknown> : {};
}

function activeReleaseId(record: ConfigRevision | null | undefined): string {
  return String(
    record?.pointer?.active_release_id
      || record?.active_release_id
      || record?.release?.id
      || "",
  );
}

function safeStringArrayText(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value.filter((item): item is string => typeof item === "string").join("、");
}

function splitTerms(value: string): string[] {
  return Array.from(new Set(
    value
      .split(/[、，,;\n\r\t]+/u)
      .map((item) => item.trim())
      .filter(Boolean),
  )).slice(0, 64);
}

function readOverrideRecord(basePayload: Record<string, unknown>, commandName: string): Record<string, unknown> {
  const root = basePayload.skill_prompt_overrides;
  if (!isRecord(root)) return {};
  const value = root[commandName];
  return isRecord(value) ? value : {};
}

function draftFromSkill(skill: SkillGovernanceRow, raw: Record<string, unknown>): SkillOverrideDraft {
  const instruction = typeof raw.instruction_override === "string" ? raw.instruction_override : "";
  const mode = raw.override_mode === "replace_full_instruction" ? "replace_full_instruction" : "supplement";
  return {
    enabled: raw.enabled !== false,
    title: typeof raw.title === "string" && raw.title.trim() ? raw.title : skill.title,
    summary: typeof raw.summary === "string" && raw.summary.trim() ? raw.summary : skill.summary,
    override_mode: mode,
    trigger_terms_text: safeStringArrayText(Array.isArray(raw.trigger_terms) ? raw.trigger_terms : skill.triggerTerms),
    instruction_override: instruction,
    updated_reason: typeof raw.updated_reason === "string" ? raw.updated_reason : "",
    admin_note: typeof raw.admin_note === "string" ? raw.admin_note : "",
  };
}

function cleanSkillOverride(draft: SkillOverrideDraft): Record<string, unknown> {
  const result: Record<string, unknown> = {
    enabled: draft.enabled,
    title: draft.title.trim(),
    summary: draft.summary.trim(),
    override_mode: draft.override_mode,
    trigger_terms: splitTerms(draft.trigger_terms_text),
  };
  const instruction = draft.instruction_override.trim();
  if (instruction) result.instruction_override = instruction;
  const reason = draft.updated_reason.trim();
  if (reason) result.updated_reason = reason;
  const note = draft.admin_note.trim();
  if (note) result.admin_note = note;
  return result;
}

function mergeSkillOverridePayload(
  basePayload: Record<string, unknown>,
  commandName: string,
  override: Record<string, unknown>,
): Record<string, unknown> {
  const overrides = isRecord(basePayload.skill_prompt_overrides)
    ? JSON.parse(JSON.stringify(basePayload.skill_prompt_overrides)) as Record<string, unknown>
    : {};
  overrides[commandName] = override;
  return {
    ...basePayload,
    skill_prompt_overrides: overrides,
  };
}

function removeSkillOverridePayload(
  basePayload: Record<string, unknown>,
  commandName: string,
): Record<string, unknown> {
  const overrides = isRecord(basePayload.skill_prompt_overrides)
    ? JSON.parse(JSON.stringify(basePayload.skill_prompt_overrides)) as Record<string, unknown>
    : {};
  delete overrides[commandName];
  return {
    ...basePayload,
    skill_prompt_overrides: overrides,
  };
}

function configErrorMessage(body: ConfigResponse, fallback: string): string {
  const raw = body.error || fallback;
  if (body.code === "MIGRATION_NOT_READY" || /MIGRATION_NOT_READY|relation .* does not exist|schema cache/iu.test(raw)) {
    return "配置控制平面迁移尚未部署（MIGRATION_NOT_READY）：管理员仍可展开卡片、编辑和复制配置 JSON，但暂不能把改动保存为可发布草稿。";
  }
  return raw;
}

async function copyText(value: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    return false;
  }
}

async function fetchSkillConfig(token: string): Promise<ConfigResponse> {
  const response = await fetch(`/api/admin/manju-config?environment=${ENVIRONMENT}&domain=${DOMAIN}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  const body = await response.json().catch(() => ({})) as ConfigResponse;
  if (!response.ok || body.ok === false) {
    throw new Error(configErrorMessage(body, "漫剧 Skill 配置中心读取失败"));
  }
  return body;
}

export function ManjuSkillManager({ token }: Props) {
  const [payload, setPayload] = useState<SkillGovernancePayload | null>(null);
  const [skillConfig, setSkillConfig] = useState<ConfigResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [configError, setConfigError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState("");
  const [editingCommand, setEditingCommand] = useState("");
  const [skillDrafts, setSkillDrafts] = useState<Record<string, SkillOverrideDraft>>({});
  const [query, setQuery] = useState("");
  const [source, setSource] = useState<(typeof FILTERS)[number]["value"]>("all");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    setConfigError("");
    setNotice("");
    try {
      if (!token) throw new Error("管理员会话缺失，请重新登录后再试。");
      const response = await fetch("/api/admin/manju-workbench/skills", {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
      });
      const body = await response.json().catch(() => ({})) as SkillGovernancePayload;
      if (!response.ok || body.ok === false) throw new Error(body.error || "漫剧 Skill 治理矩阵读取失败");
      setPayload(body);
      try {
        setSkillConfig(await fetchSkillConfig(token));
      } catch (reason) {
        setSkillConfig(null);
        setConfigError(reason instanceof Error ? reason.message : "漫剧 Skill 配置中心读取失败");
      }
    } catch (reason) {
      setPayload(null);
      setSkillConfig(null);
      setError(reason instanceof Error ? reason.message : "漫剧 Skill 治理矩阵读取失败");
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);

  const skills = payload?.skills || [];
  const visibleSkills = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase("zh-CN");
    return skills.filter((skill) => {
      if (source !== "all" && skill.source !== source) return false;
      if (!needle) return true;
      return [
        skill.title,
        skill.commandName,
        skill.categoryLabel,
        skill.sourceLabel,
        skill.summary,
        skill.tags.join(" "),
        skill.triggerTerms.join(" "),
      ].join(" ").toLocaleLowerCase("zh-CN").includes(needle);
    });
  }, [query, skills, source]);

  const basePayload = useMemo(() => {
    const latestDraft = skillConfig?.drafts?.[0];
    const draftPayload = revisionPayload(latestDraft);
    if (Object.keys(draftPayload).length > 0) return draftPayload;
    const activePayload = revisionPayload(skillConfig?.active);
    if (Object.keys(activePayload).length > 0) return activePayload;
    return payload?.baselinePayload
      ? JSON.parse(JSON.stringify(payload.baselinePayload)) as Record<string, unknown>
      : {};
  }, [payload?.baselinePayload, skillConfig]);

  const storageGeneration = useMemo(() => {
    if (Number.isSafeInteger(skillConfig?.storage_generation)) return skillConfig?.storage_generation;
    if (Number.isSafeInteger(payload?.configStore?.generation)) return payload?.configStore?.generation;
    return undefined;
  }, [payload?.configStore?.generation, skillConfig?.storage_generation]);

  const configReadyForWrite = Number.isSafeInteger(storageGeneration) && Object.keys(basePayload).length > 0;
  const writeStateLabel = configReadyForWrite ? "可保存发布" : "仅编辑预览";

  async function copyTarget(target: string) {
    const copied = await copyText(target);
    setNotice(copied ? `已复制配置键：${target}` : "复制失败，请手动复制配置键。");
  }

  function readDraft(skill: SkillGovernanceRow): SkillOverrideDraft {
    return skillDrafts[skill.commandName]
      || draftFromSkill(skill, readOverrideRecord(basePayload, skill.commandName));
  }

  async function copySkillDraftJson(skill: SkillGovernanceRow) {
    const draft = readDraft(skill);
    const patch = {
      domain: DOMAIN,
      environment: ENVIRONMENT,
      editTarget: skill.governance.editTarget,
      skill_prompt_overrides: {
        [skill.commandName]: cleanSkillOverride(draft),
      },
    };
    const copied = await copyText(`${JSON.stringify(patch, null, 2)}\n`);
    setNotice(copied
      ? `已复制 /${skill.commandName} 的管理员配置 JSON；数据库迁移完成后可直接保存发布。`
      : "复制失败，请手动复制当前卡片配置 JSON。");
  }

  function beginEdit(skill: SkillGovernanceRow) {
    setEditingCommand(skill.commandName);
    setSkillDrafts((current) => ({
      ...current,
      [skill.commandName]: current[skill.commandName]
        || draftFromSkill(skill, readOverrideRecord(basePayload, skill.commandName)),
    }));
    setNotice(`已展开 /${skill.commandName} 的管理员编辑面板；普通用户不能修改平台内置 Skill。`);
  }

  function patchDraft(commandName: string, patch: Partial<SkillOverrideDraft>) {
    const skill = skills.find((item) => item.commandName === commandName);
    if (!skill) return;
    setSkillDrafts((current) => ({
      ...current,
      [commandName]: {
        ...(current[commandName] || draftFromSkill(skill, readOverrideRecord(basePayload, commandName))),
        ...patch,
      },
    }));
  }

  async function saveSkillDraft(
    commandName: string,
    options: { publish?: boolean; draftOverride?: SkillOverrideDraft; removeOverride?: boolean } = {},
  ) {
    const skill = skills.find((item) => item.commandName === commandName);
    if (!skill) {
      setError("未找到要保存的 Skill 卡片。");
      return;
    }
    const draft = options.draftOverride || readDraft(skill);
    const title = draft.title.trim();
    const summary = draft.summary.trim();
    const instruction = draft.instruction_override.trim();
    if (!title || title.length > 120) {
      setConfigError("Skill 标题必须是 1-120 个字符。");
      return;
    }
    if (!summary || summary.length > 600) {
      setConfigError("Skill 摘要必须是 1-600 个字符。");
      return;
    }
    if (instruction && instruction.length < 20) {
      setConfigError("提示词覆盖正文如果填写，必须至少 20 个字符；不填则继续使用内置安全基线。");
      return;
    }
    if (!configReadyForWrite || !Number.isSafeInteger(storageGeneration)) {
      setConfigError("Skill 配置存储状态不可写：缺少当前存储代次或安全基线，请刷新后台后重试。");
      return;
    }

    const nextPayload = options.removeOverride
      ? removeSkillOverridePayload(basePayload, commandName)
      : mergeSkillOverridePayload(basePayload, commandName, cleanSkillOverride(draft));
    const saveBody = {
      action: "save-draft",
      environment: ENVIRONMENT,
      domain: DOMAIN,
      expected_storage_generation: storageGeneration,
      payload: nextPayload,
      schema_version: SCHEMA_VERSION,
    };

    setBusy(options.publish ? `publish:${commandName}` : `save:${commandName}`);
    setConfigError("");
    setNotice("");
    try {
      const response = await fetch("/api/admin/manju-config", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(saveBody),
      });
      const body = await response.json().catch(() => ({})) as ConfigResponse;
      if (!response.ok || body.ok === false) {
        throw new Error(configErrorMessage(body, "Skill 草稿保存失败"));
      }
      const savedRevisionId = revisionId(body.revision);
      let successMessage = `已保存「${title}」为 Skill 草稿，确认无误后可发布。`;
      if (options.publish) {
        if (!savedRevisionId) throw new Error("Skill 草稿保存成功，但未返回可发布的 revision_id。");
        const freshConfig = await fetchSkillConfig(token);
        const publishGeneration = Number.isSafeInteger(freshConfig.storage_generation)
          ? freshConfig.storage_generation
          : storageGeneration;
        const publishBody: Record<string, unknown> = {
          action: "publish",
          environment: ENVIRONMENT,
          domain: DOMAIN,
          expected_storage_generation: publishGeneration,
          revision_id: savedRevisionId,
        };
        const expectedActive = activeReleaseId(freshConfig.active);
        if (expectedActive) publishBody.expected_active_release_id = expectedActive;
        const publishResponse = await fetch("/api/admin/manju-config", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(publishBody),
        });
        const publishResult = await publishResponse.json().catch(() => ({})) as ConfigResponse;
        if (!publishResponse.ok || publishResult.ok === false) {
          throw new Error(configErrorMessage(publishResult, "Skill 草稿发布失败"));
        }
        successMessage = options.removeOverride
          ? `已删除「${skill.title}」的后台覆盖并发布，前台 Agent 将恢复读取内置安全基线。`
          : `已保存并发布「${title}」，前台 Agent 将读取新的 Skill 配置。`;
      }
      setEditingCommand("");
      await load();
      setNotice(successMessage);
    } catch (reason) {
      setConfigError(reason instanceof Error ? reason.message : "Skill 卡片保存失败");
    } finally {
      setBusy("");
    }
  }

  async function toggleSkillEnabled(skill: SkillGovernanceRow, enabled: boolean) {
    const draft = {
      ...readDraft(skill),
      enabled,
      updated_reason: enabled ? "后台重新启用该内置 Skill" : "后台下线该内置 Skill",
    };
    setSkillDrafts((current) => ({
      ...current,
      [skill.commandName]: draft,
    }));
    await saveSkillDraft(skill.commandName, { publish: true, draftOverride: draft });
  }

  async function resetSkillOverride(skill: SkillGovernanceRow) {
    const confirmed = window.confirm(
      `确认删除 /${skill.commandName} 的后台覆盖配置，并恢复内置安全基线？这不会删除平台内置 Skill 本体，只会生成一条可审计的恢复默认发布记录。`,
    );
    if (!confirmed) return;
    await saveSkillDraft(skill.commandName, {
      publish: true,
      draftOverride: draftFromSkill(skill, {}),
      removeOverride: true,
    });
  }

  return (
    <section
      id="manju-skill-manager"
      className="space-y-4 rounded-xl border border-[var(--border)] bg-[var(--card)] p-4"
      data-admin-section="manju-skill-manager"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 text-sm font-semibold text-[var(--foreground)]">
            <WandSparkles size={18} className="text-violet-500" />
            漫剧 Skill 治理矩阵
          </div>
          <p className="mt-1 max-w-4xl text-xs leading-5 text-[var(--muted-foreground)]">
            前台 Skill 专家的每张卡片都在这里映射为后台管理对象。平台内置 Skill 由管理员配置，普通用户只能调用；用户自建 Skill 走发布包生命周期，允许用户创建、导入、定制和安装。
          </p>
        </div>
        <button
          type="button"
          className="inline-flex items-center gap-2 rounded-md border border-[var(--border)] px-3 py-2 text-sm text-[var(--foreground)] disabled:opacity-50"
          onClick={() => void load()}
          disabled={loading}
        >
          <RefreshCw size={15} className={loading ? "animate-spin" : ""} />刷新矩阵
        </button>
      </div>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-5">
        <article className="rounded-md border border-blue-500/25 bg-blue-500/5 p-3">
          <small className="text-[var(--muted-foreground)]">内置运行目录</small>
          <strong className="mt-1 block text-lg text-[var(--foreground)]">{payload?.counts?.total ?? "—"} 张卡片</strong>
          <span className="text-xs text-blue-600">管理员可治理，用户不可改</span>
        </article>
        <article className="rounded-md border border-emerald-500/25 bg-emerald-500/5 p-3">
          <small className="text-[var(--muted-foreground)]">已接入 Agent</small>
          <strong className="mt-1 block text-lg text-[var(--foreground)]">{payload?.counts?.runtimeConnected ?? "—"} 项</strong>
          <span className="text-xs text-emerald-600">命令、指令、输出协议齐备</span>
        </article>
        <article className="rounded-md border border-violet-500/25 bg-violet-500/5 p-3">
          <small className="text-[var(--muted-foreground)]">用户可编辑内置</small>
          <strong className="mt-1 block text-lg text-[var(--foreground)]">{payload?.counts?.userEditableBuiltIn ?? "—"} 项</strong>
          <span className="text-xs text-violet-600">内置 Skill 不给普通用户改</span>
        </article>
        <article className="rounded-md border border-amber-500/25 bg-amber-500/5 p-3">
          <small className="text-[var(--muted-foreground)]">用户自建包</small>
          <strong className="mt-1 block text-lg text-[var(--foreground)]">{payload?.packageStore?.count ?? "—"} 个</strong>
          <span className="text-xs text-amber-600">{payload?.packageStore?.ok ? "包服务可读" : payload?.packageStore?.code || "等待读取"}</span>
        </article>
        <article className="rounded-md border border-cyan-500/25 bg-cyan-500/5 p-3">
          <small className="text-[var(--muted-foreground)]">配置写入链路</small>
          <strong className="mt-1 block text-lg text-[var(--foreground)]">
            {Number.isSafeInteger(storageGeneration) ? `代次 ${storageGeneration}` : "不可写"}
          </strong>
          <span className="text-xs text-cyan-600">
            {payload?.configStore?.ok ? `${payload.configStore.mode} 存储` : payload?.configStore?.code || "等待读取"}
          </span>
        </article>
      </div>

      <div className="grid grid-cols-1 gap-3 rounded-md border border-[var(--border)] bg-[var(--background)] p-3 text-xs leading-5 text-[var(--secondary-foreground)] lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="flex items-start gap-2">
          <ShieldCheck size={16} className="mt-0.5 shrink-0 text-emerald-500" />
          <p>
            <strong className="text-[var(--foreground)]">平台内置 Skill：</strong>
            后台可改标题、摘要、触发词、启停和提示词覆盖；用户只能调用，不能直接编辑平台基线。
          </p>
        </div>
        <div className="flex items-start gap-2">
          <Database size={16} className="mt-0.5 shrink-0 text-blue-500" />
          <p>
            <strong className="text-[var(--foreground)]">用户自建 Skill：</strong>
            走 Skill 包 API、版本、审核、发布、安装和回滚；未完成迁移时必须明示不可用，不伪装成已接通。
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 rounded-md border border-blue-500/25 bg-blue-500/5 p-3 text-xs leading-5 text-[var(--secondary-foreground)] lg:grid-cols-2">
        <article>
          <strong className="block text-sm text-[var(--foreground)]">内置 Skill 后台操作入口</strong>
          <p className="mt-1">
            下方 36 张卡片逐张对应前台 Skill 专家目录。展开任一卡片即可“直接编辑本卡”，支持标题、摘要、触发词、启停、提示词覆盖、保存草稿、保存并发布，以及“删除覆盖/恢复默认”。
          </p>
          <p className="mt-1">
            配置落点固定为 <code>production / skill / skill_prompt_overrides.&lt;command&gt;</code>，服务端 Agent 只读取已发布版本。
          </p>
        </article>
        <article>
          <strong className="block text-sm text-[var(--foreground)]">用户自建 Skill 与导入入口</strong>
          <p className="mt-1">
            用户自建 Skill 不覆盖平台内置基线，走独立 Skill 包生命周期：创建/导入 → 草稿版本 → 管理员审核 → 发布 → 用户安装/卸载。后台接口为 <code>/api/admin/skill-packages</code>，前台入口为 <code>/youcai/skills</code>。
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <a className="inline-flex items-center justify-center gap-2 rounded-md border border-blue-500/30 px-3 py-2 text-blue-600" href="/youcai/skills" target="_blank" rel="noreferrer">
              打开前台 Skill 入口<ArrowUpRight size={14} />
            </a>
            <a className="inline-flex items-center justify-center gap-2 rounded-md border border-[var(--border)] px-3 py-2 text-[var(--foreground)]" href="#manju-config-center">
              回到配置中心<SlidersHorizontal size={14} />
            </a>
          </div>
        </article>
      </div>

      <div className="grid grid-cols-1 gap-3 rounded-md border border-violet-500/25 bg-violet-500/5 p-3 text-xs leading-5 text-[var(--secondary-foreground)] lg:grid-cols-[1fr_1fr_1fr]">
        <article>
          <strong className="block text-sm text-[var(--foreground)]">管理员权限</strong>
          <p className="mt-1">管理员可以治理平台内置 Skill：改标题、摘要、触发词、启停和提示词覆盖；普通用户不可改平台基线。</p>
        </article>
        <article>
          <strong className="block text-sm text-[var(--foreground)]">当前写入状态</strong>
          <p className="mt-1">{writeStateLabel}。{configReadyForWrite ? "改动会进入草稿/发布链路。" : "编辑器仍可用，保存发布需先完成配置库迁移。"}</p>
        </article>
        <article>
          <strong className="block text-sm text-[var(--foreground)]">推荐操作</strong>
          <p className="mt-1">点开任意卡片 → 直接编辑本卡 → 保存草稿 → 发布；迁移未完成时先复制本卡配置 JSON，不做假保存。</p>
        </article>
      </div>

      {payload?.packageStore && !payload.packageStore.ok ? (
        <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-xs leading-5 text-amber-700">
          <AlertTriangle size={16} className="mt-0.5 shrink-0" />
          <span>
            用户自建 Skill 包控制面尚未完全可用：{payload.packageStore.message}
            {payload.packageStore.code ? `（${payload.packageStore.code}）` : ""}。这不影响下方 36 项内置 Skill 的 Agent 调用，但会影响“用户新增/导入/安装 Skill”的真实持久化。
          </span>
        </div>
      ) : null}

      {configError ? (
        <div className="flex items-start gap-2 rounded-md border border-red-500/30 bg-red-500/5 p-3 text-xs leading-5 text-red-600">
          <AlertTriangle size={16} className="mt-0.5 shrink-0" />
          <span>
            Skill 配置中心当前不可完整读取：{configError}
            {configReadyForWrite
              ? " 本面板仍可从内置安全基线新建干净草稿，并通过发布修复活动版本。"
              : " 当前可以编辑预览和复制配置 JSON，暂不能保存发布。"}
          </span>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-2">
          {FILTERS.map((item) => (
            <button
              key={item.value}
              type="button"
              className="rounded-full border px-3 py-1.5 text-xs"
              style={{
                borderColor: source === item.value ? "var(--primary)" : "var(--border)",
                color: source === item.value ? "var(--primary)" : "var(--muted-foreground)",
              }}
              onClick={() => setSource(item.value)}
            >
              {item.label}
            </button>
          ))}
        </div>
        <label className="flex min-w-72 items-center gap-2 rounded-md border border-[var(--border)] bg-[var(--background)] px-3 py-2 text-sm">
          <Search size={16} className="text-[var(--muted-foreground)]" />
          <input
            className="min-w-0 flex-1 bg-transparent outline-none"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索卡片、命令、分类、触发词"
          />
        </label>
      </div>

      {notice ? (
        <div className="flex items-center gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/5 p-3 text-xs text-emerald-600" role="status">
          <CheckCircle2 size={15} />{notice}
        </div>
      ) : null}

      {error ? (
        <div className="flex items-start gap-2 rounded-md border border-red-500/30 bg-red-500/5 p-3 text-sm text-red-600" role="alert">
          <AlertTriangle size={17} className="mt-0.5 shrink-0" />
          <div><strong>Skill 治理矩阵读取失败</strong><p className="mt-1 text-xs leading-5">{error}</p></div>
        </div>
      ) : null}

      {loading && !payload ? (
        <div className="flex min-h-32 items-center justify-center text-sm text-[var(--muted-foreground)]" role="status">
          <LoaderCircle size={18} className="mr-2 animate-spin" />正在读取 36 项 Skill 后台映射…
        </div>
      ) : null}

      {payload ? (
        <div className="overflow-hidden rounded-md border border-[var(--border)]">
          <div className="grid grid-cols-[48px_minmax(230px,1.3fr)_140px_150px_150px_150px] gap-0 bg-[var(--background)] px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-[var(--muted-foreground)]">
            <span>#</span>
            <span>Skill 卡片 / 命令</span>
            <span>来源</span>
            <span>运行状态</span>
            <span>权限边界</span>
            <span>配置入口</span>
          </div>
          <div className="max-h-[720px] overflow-auto">
            {visibleSkills.map((skill) => {
              const draft = readDraft(skill);
              const isEditing = editingCommand === skill.commandName;
              const commandBusy = busy.endsWith(`:${skill.commandName}`);
              return (
              <details
                key={skill.id}
                className="border-t border-[var(--border)] bg-[var(--card)] px-3 py-3"
                data-skill-command={skill.commandName}
                data-testid="manju-skill-row"
                open={skill.order === 1 || isEditing}
              >
                <summary className="grid cursor-pointer list-none grid-cols-[48px_minmax(230px,1.3fr)_140px_150px_150px_150px] items-start gap-0 text-sm">
                  <span className="text-[var(--muted-foreground)]">{skill.order}</span>
                  <span className="min-w-0">
                    <strong className="block truncate text-[var(--foreground)]">{draft.title || skill.title}</strong>
                    <code className="mt-1 block text-xs text-blue-600">/{skill.commandName}</code>
                    <small className="mt-1 block truncate text-[var(--muted-foreground)]">{draft.summary || skill.summary}</small>
                  </span>
                  <span className="text-xs text-[var(--secondary-foreground)]">
                    {skill.sourceLabel}
                    <small className="mt-1 block text-[var(--muted-foreground)]">{skill.categoryLabel}</small>
                  </span>
                  <span className="text-xs">
                    {draft.enabled === false ? (
                      <em className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-2 py-1 not-italic text-amber-600"><AlertTriangle size={13} />已下线</em>
                    ) : skill.governance.runtimeConnected ? (
                      <em className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-1 not-italic text-emerald-600"><CheckCircle2 size={13} />已接线</em>
                    ) : (
                      <em className="inline-flex items-center gap-1 rounded-full bg-red-500/10 px-2 py-1 not-italic text-red-600"><AlertTriangle size={13} />未接线</em>
                    )}
                    <small className="mt-1 block text-[var(--muted-foreground)]">v{skill.version}</small>
                  </span>
                  <span className="text-xs text-[var(--secondary-foreground)]">
                    管理员可改
                    <small className="mt-1 block text-[var(--muted-foreground)]">用户不可改内置</small>
                  </span>
                  <span className="text-xs text-[var(--secondary-foreground)]">
                    skill 域
                    <small className="mt-1 block truncate text-[var(--muted-foreground)]">{skill.governance.editTarget}</small>
                    <small className="mt-1 block text-violet-600">点击本行展开编辑</small>
                  </span>
                </summary>
                <div className="mt-3 grid grid-cols-1 gap-3 rounded-md border border-[var(--border)] bg-[var(--background)] p-3 text-xs leading-5 text-[var(--secondary-foreground)] lg:grid-cols-[minmax(0,1fr)_260px]">
                  <div className="space-y-2">
                    <p><strong className="text-[var(--foreground)]">后台修改方式：</strong>点击右侧“直接编辑本卡”，在本行内改标题、摘要、触发词、启停和提示词覆盖；也可复制 <code>{skill.governance.editTarget}</code> 到“配置中心”的 skill 域批量维护。发布后服务端 Agent 才读取。</p>
                    <p><strong className="text-[var(--foreground)]">触发词：</strong>{skill.triggerTerms.length ? skill.triggerTerms.join("、") : "未登记"}</p>
                    <p><strong className="text-[var(--foreground)]">标签：</strong>{skill.tags.length ? skill.tags.join("、") : "未登记"}</p>
                    <p><strong className="text-[var(--foreground)]">指令状态：</strong>{skill.instruction.present ? `已登记，${skill.instruction.length} 字符，hash ${shortHash(skill.instruction.hash)}` : "缺失，不能上线"}</p>
                  </div>
                  <div className="grid content-start gap-2">
                    <a className="inline-flex items-center justify-center gap-2 rounded-md border border-blue-500/30 px-3 py-2 text-blue-600" href={skill.governance.frontRoute} target="_blank" rel="noreferrer">
                      前台测试<ArrowUpRight size={14} />
                    </a>
                    <button type="button" className="inline-flex items-center justify-center gap-2 rounded-md border border-[var(--border)] px-3 py-2" onClick={() => void copyTarget(skill.governance.editTarget)}>
                      <Copy size={14} />复制配置键
                    </button>
                    <a className="inline-flex items-center justify-center gap-2 rounded-md border border-[var(--border)] px-3 py-2" href="#manju-config-center">
                      去配置中心<SlidersHorizontal size={14} />
                    </a>
                    <button type="button" className="inline-flex items-center justify-center gap-2 rounded-md border border-violet-500/30 px-3 py-2 text-violet-600" onClick={() => beginEdit(skill)}>
                      直接编辑本卡<Save size={14} />
                    </button>
                    <button
                      type="button"
                      className="inline-flex items-center justify-center gap-2 rounded-md border border-amber-500/30 px-3 py-2 text-amber-600 disabled:opacity-50"
                      onClick={() => void toggleSkillEnabled(skill, draft.enabled === false)}
                      disabled={!configReadyForWrite || Boolean(commandBusy)}
                    >
                      {draft.enabled === false ? "启用并发布" : "下线并发布"}
                    </button>
                    <button
                      type="button"
                      className="inline-flex items-center justify-center gap-2 rounded-md border border-red-500/30 px-3 py-2 text-red-600 disabled:opacity-50"
                      onClick={() => void resetSkillOverride(skill)}
                      disabled={!configReadyForWrite || Boolean(commandBusy)}
                    >
                      删除覆盖/恢复默认
                    </button>
                  </div>
                </div>
                {isEditing ? (
                  <div className="mt-3 space-y-3 rounded-md border border-violet-500/30 bg-violet-500/5 p-3 text-xs leading-5">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <strong className="text-sm text-[var(--foreground)]">编辑 /{skill.commandName}</strong>
                      <label className="flex items-center gap-2 text-[var(--secondary-foreground)]">
                        <input
                          type="checkbox"
                          checked={draft.enabled}
                          onChange={(event) => patchDraft(skill.commandName, { enabled: event.target.checked })}
                        />
                        前台启用
                      </label>
                    </div>
                    {!configReadyForWrite ? (
                      <div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-amber-700">
                        当前配置库暂不可写：管理员可以先完成编辑并复制本卡配置 JSON；保存草稿、发布、下线和恢复默认必须等迁移/服务端写入链路就绪后执行，系统不会伪造成功。
                      </div>
                    ) : null}
                    <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
                      <label className="block text-[var(--muted-foreground)]">
                        卡片标题
                        <input
                          className="mt-1 w-full rounded-md border border-[var(--border)] bg-[var(--card)] px-3 py-2 text-sm text-[var(--foreground)] outline-none"
                          maxLength={120}
                          value={draft.title}
                          onChange={(event) => patchDraft(skill.commandName, { title: event.target.value })}
                        />
                      </label>
                      <label className="block text-[var(--muted-foreground)]">
                        覆盖模式
                        <select
                          className="mt-1 w-full rounded-md border border-[var(--border)] bg-[var(--card)] px-3 py-2 text-sm text-[var(--foreground)] outline-none"
                          value={draft.override_mode}
                          onChange={(event) => patchDraft(skill.commandName, { override_mode: event.target.value === "replace_full_instruction" ? "replace_full_instruction" : "supplement" })}
                        >
                          <option value="supplement">补充内置提示词（推荐）</option>
                          <option value="replace_full_instruction">完全替换运行提示词</option>
                        </select>
                      </label>
                    </div>
                    <label className="block text-[var(--muted-foreground)]">
                      卡片摘要
                      <textarea
                        className="mt-1 w-full rounded-md border border-[var(--border)] bg-[var(--card)] px-3 py-2 text-sm text-[var(--foreground)] outline-none"
                        rows={2}
                        maxLength={600}
                        value={draft.summary}
                        onChange={(event) => patchDraft(skill.commandName, { summary: event.target.value })}
                      />
                    </label>
                    <label className="block text-[var(--muted-foreground)]">
                      触发词（用顿号、逗号或换行分隔）
                      <textarea
                        className="mt-1 w-full rounded-md border border-[var(--border)] bg-[var(--card)] px-3 py-2 text-sm text-[var(--foreground)] outline-none"
                        rows={2}
                        maxLength={3000}
                        value={draft.trigger_terms_text}
                        onChange={(event) => patchDraft(skill.commandName, { trigger_terms_text: event.target.value })}
                      />
                    </label>
                    <label className="block text-[var(--muted-foreground)]">
                      提示词覆盖正文（留空则继续读取内置安全基线）
                      <textarea
                        className="mt-1 w-full rounded-md border border-[var(--border)] bg-[var(--card)] px-3 py-2 font-mono text-xs leading-5 text-[var(--foreground)] outline-none"
                        rows={10}
                        maxLength={80_000}
                        value={draft.instruction_override}
                        onChange={(event) => patchDraft(skill.commandName, { instruction_override: event.target.value })}
                        placeholder="例如：在保持原 Skill 角色和输出协议不变的前提下，补充你的漫剧工作台专属规则、禁用项、格式要求、参考素材使用方法……"
                      />
                    </label>
                    <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
                      <label className="block text-[var(--muted-foreground)]">
                        修改原因
                        <input
                          className="mt-1 w-full rounded-md border border-[var(--border)] bg-[var(--card)] px-3 py-2 text-sm text-[var(--foreground)] outline-none"
                          maxLength={500}
                          value={draft.updated_reason}
                          onChange={(event) => patchDraft(skill.commandName, { updated_reason: event.target.value })}
                        />
                      </label>
                      <label className="block text-[var(--muted-foreground)]">
                        管理备注
                        <input
                          className="mt-1 w-full rounded-md border border-[var(--border)] bg-[var(--card)] px-3 py-2 text-sm text-[var(--foreground)] outline-none"
                          maxLength={800}
                          value={draft.admin_note}
                          onChange={(event) => patchDraft(skill.commandName, { admin_note: event.target.value })}
                        />
                      </label>
                    </div>
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="text-[var(--muted-foreground)]">
                        保存位置：<code>skill_prompt_overrides.{skill.commandName}</code>；发布后才会进入前台 Agent 运行链路。
                      </p>
                      <div className="flex flex-wrap gap-2">
                        <button
                          type="button"
                          className="rounded-md border border-[var(--border)] px-3 py-2 text-sm text-[var(--foreground)]"
                          onClick={() => setEditingCommand("")}
                          disabled={Boolean(commandBusy)}
                        >
                          取消
                        </button>
                        <button
                          type="button"
                          className="inline-flex items-center gap-2 rounded-md border border-violet-500/30 px-3 py-2 text-sm text-violet-600 disabled:opacity-50"
                          onClick={() => void copySkillDraftJson(skill)}
                          disabled={Boolean(commandBusy)}
                        >
                          <Copy size={14} />复制本卡配置 JSON
                        </button>
                        <button
                          type="button"
                          className="inline-flex items-center gap-2 rounded-md border border-[var(--border)] px-3 py-2 text-sm text-[var(--foreground)] disabled:opacity-50"
                          onClick={() => void saveSkillDraft(skill.commandName)}
                          disabled={!configReadyForWrite || Boolean(commandBusy)}
                        >
                          <Save size={14} />{busy === `save:${skill.commandName}` ? "保存中…" : configReadyForWrite ? "保存草稿" : "保存草稿（需迁移）"}
                        </button>
                        <button
                          type="button"
                          className="inline-flex items-center gap-2 rounded-md bg-[var(--primary)] px-3 py-2 text-sm text-white disabled:opacity-50"
                          onClick={() => void saveSkillDraft(skill.commandName, { publish: true })}
                          disabled={!configReadyForWrite || Boolean(commandBusy)}
                        >
                          <Send size={14} />{busy === `publish:${skill.commandName}` ? "发布中…" : configReadyForWrite ? "保存并发布" : "发布（需迁移）"}
                        </button>
                      </div>
                    </div>
                  </div>
                ) : null}
              </details>
              );
            })}
          </div>
        </div>
      ) : null}

      <p className="text-[11px] leading-5 text-[var(--muted-foreground)]">
        最近读取：{formatTime(payload?.generatedAt)}。本面板只做后台治理与配置，不会调用模型、不扣积分、不把未迁移的 Skill 包服务伪装成可用。
      </p>
    </section>
  );
}
