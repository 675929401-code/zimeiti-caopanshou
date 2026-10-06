"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { manjuJsonEditorChanged } from "@/lib/manju-admin-draft-state";
import {
  AlertTriangle,
  CheckCircle2,
  Database,
  FileJson2,
  History,
  LoaderCircle,
  RefreshCw,
  RotateCcw,
  Save,
  Send,
  ShieldCheck,
} from "lucide-react";

interface Props {
  token: string;
}

interface ConfigRevision {
  id?: string;
  revision_id?: string;
  release_id?: string;
  active_release_id?: string;
  release_number?: number;
  version?: number | string;
  status?: string;
  schema_version?: string;
  payload?: unknown;
  payload_hash?: string;
  etag?: string;
  created_at?: string;
  updated_at?: string;
  published_at?: string;
  pointer?: ConfigRevision | null;
  release?: ConfigRevision | null;
  revision?: ConfigRevision | null;
}

const LATEST_SCHEMA_VERSION = "1.1.0";

interface ConfigResponse {
  ok?: boolean;
  storage_mode?: "native" | "compat";
  storage_generation?: number;
  error?: string;
  code?: string;
  state?: string;
  message?: string;
  environment?: string;
  domain?: string;
  environments?: string[];
  domains?: string[];
  active?: ConfigRevision | null;
  revision?: ConfigRevision | null;
  drafts?: ConfigRevision[];
  history?: ConfigRevision[];
  valid?: boolean;
  issues?: unknown;
  warnings?: unknown;
  [key: string]: unknown;
}

const ENVIRONMENTS = ["production", "staging", "development"] as const;

const DOMAIN_OPTIONS = [
  { value: "prompt", label: "漫剧私有运行提示词", visibility: "仅服务端", effect: "发布后由漫剧创作 Agent 读取，控制漫剧自己的真实基础提示词；不读取主站智能体卡片 Prompt。" },
  { value: "skill", label: "漫剧内部 Skill 调度策略", visibility: "服务端管理", effect: "只保存漫剧工作台内部技能编排/路由治理元数据；不是主站 Skill 应用广场的上架清单。" },
  { value: "agent", label: "漫剧创作 Agent 治理策略", visibility: "服务端管理", effect: "只保存漫剧创作 Agent 的模式、入口与治理元数据；不是主站应用广场智能体卡片后台。" },
  { value: "workflow", label: "漫剧工作流治理", visibility: "服务端管理", effect: "保存脚本、角色、场景、分镜、生成与归档阶段的治理配置；当前不直接下发浏览器。" },
  { value: "content", label: "漫剧前台导航与文案", visibility: "前台可读", effect: "控制漫剧工作台导航、品牌文案和公开内容元数据，不存二进制素材。" },
  { value: "media", label: "漫剧示例与素材目录", visibility: "前台可读", effect: "只保存素材 ID、排序、启停和展示文案覆盖；文件本体走版本化 public 资产包或 COS/CDN。" },
  { value: "feature_flags", label: "漫剧功能开关", visibility: "前台可读", effect: "控制漫剧已发布功能是否对前台开放，未发布功能不会靠前端硬显示。" },
  { value: "model_policy", label: "漫剧模型策略", visibility: "仅服务端", effect: "保存漫剧模型选择边界；密钥、成本与结算始终由主站服务端管理，匿名前台不会读取。" },
  { value: "ui", label: "漫剧界面治理", visibility: "管理端预留", effect: "保存漫剧界面治理元数据；当前组件样式与画布参数不会因发布此域而自动改变。" },
] as const;

const SECRET_KEY_PATTERN = /^(?:api[_-]?key|secret(?:[_-]?key)?|client[_-]?secret|password|passwd|private[_-]?key|service[_-]?role[_-]?key|access[_-]?token|refresh[_-]?token|bearer[_-]?token|authorization|credential(?:s)?|cookie|webhook[_-]?secret)$/i;

function revisionValue(record: ConfigRevision | null | undefined): ConfigRevision {
  return record?.revision || record || {};
}

function revisionId(record: ConfigRevision | null | undefined): string {
  const revision = revisionValue(record);
  return String(
    record?.revision_id
      || record?.pointer?.revision_id
      || record?.release?.revision_id
      || revision.revision_id
      || revision.id
      || "",
  );
}

function releaseId(record: ConfigRevision | null | undefined): string {
  return String(
    record?.release_id
      || record?.active_release_id
      || record?.pointer?.active_release_id
      || record?.release?.id
      || record?.id
      || "",
  );
}

function revisionVersion(record: ConfigRevision | null | undefined): string {
  const revision = revisionValue(record);
  return revision.version === undefined || revision.version === null ? "—" : String(revision.version);
}

function revisionPayload(record: ConfigRevision | null | undefined): unknown {
  return revisionValue(record).payload ?? {};
}

function revisionSchemaVersion(record: ConfigRevision | null | undefined): string {
  return revisionValue(record).schema_version || LATEST_SCHEMA_VERSION;
}

function recordTime(record: ConfigRevision | null | undefined): string {
  const source = record?.published_at
    || record?.release?.published_at
    || record?.release?.created_at
    || revisionValue(record).published_at
    || record?.updated_at
    || record?.pointer?.updated_at
    || record?.created_at
    || revisionValue(record).created_at;
  if (!source) return "时间未记录";
  const parsed = new Date(source);
  return Number.isNaN(parsed.getTime()) ? source : parsed.toLocaleString("zh-CN");
}

function recordStatus(record: ConfigRevision | null | undefined): string {
  return record?.status || record?.release?.status || revisionValue(record).status || "历史版本";
}

function recordEtag(record: ConfigRevision | null | undefined): string {
  return record?.etag || record?.pointer?.etag || record?.release?.etag || "";
}

function shortId(value: string): string {
  if (!value) return "—";
  return value.length > 18 ? `${value.slice(0, 8)}…${value.slice(-6)}` : value;
}

function findSensitivePaths(value: unknown, path = "$", found: string[] = []): string[] {
  if (!value || typeof value !== "object") return found;
  if (Array.isArray(value)) {
    value.forEach((entry, index) => findSensitivePaths(entry, `${path}[${index}]`, found));
    return found;
  }
  Object.entries(value as Record<string, unknown>).forEach(([key, entry]) => {
    const nextPath = `${path}.${key}`;
    if (SECRET_KEY_PATTERN.test(key)) found.push(nextPath);
    findSensitivePaths(entry, nextPath, found);
  });
  return found;
}

function errorMessage(body: ConfigResponse, fallback: string): string {
  const raw = body.error || body.message || fallback;
  const migrationNotReady = body.code === "MIGRATION_NOT_READY"
    || body.state === "MIGRATION_NOT_READY"
    || /MIGRATION_NOT_READY|relation .* does not exist|schema cache/i.test(raw);
  if (migrationNotReady) {
    return "配置控制平面迁移尚未部署（MIGRATION_NOT_READY）。当前不会伪造保存或发布结果，请先由运维部署 20260825123000_manju_config_control_plane.sql。";
  }
  return raw;
}

export function ManjuConfigCenter({ token }: Props) {
  const [environment, setEnvironment] = useState("production");
  const [domain, setDomain] = useState("prompt");
  const [data, setData] = useState<ConfigResponse | null>(null);
  const [editor, setEditor] = useState("{}\n");
  const [schemaVersion, setSchemaVersion] = useState(LATEST_SCHEMA_VERSION);
  const [selectedDraftId, setSelectedDraftId] = useState("");
  const [editorBase, setEditorBase] = useState<{ payload: unknown; schemaVersion: string; updatedAt?: string } | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [validationResult, setValidationResult] = useState<ConfigResponse | null>(null);

  const headers = useMemo(() => ({
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  }), [token]);

  const loadConfig = useCallback(async (options?: { preserveEditor?: boolean; preferredDraftId?: string }) => {
    setBusy("load");
    setError("");
    try {
      if (!token) throw new Error("管理员会话缺失，请重新登录后再试。");
      const query = new URLSearchParams({ environment, domain });
      const response = await fetch(`/api/admin/manju-config?${query.toString()}`, {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
      });
      const body = await response.json().catch(() => ({})) as ConfigResponse;
      if (!response.ok || body.ok === false) throw new Error(errorMessage(body, "漫剧配置读取失败"));

      const drafts = Array.isArray(body.drafts) ? body.drafts : [];
      const history = Array.isArray(body.history) ? body.history : [];
      const normalized: ConfigResponse = { ...body, drafts, history };
      setData(normalized);
      setValidationResult(null);

      if (!options?.preserveEditor) {
        const preferredDraft = options?.preferredDraftId
          ? drafts.find((draft) => revisionId(draft) === options.preferredDraftId)
          : drafts[0];
        if (options?.preferredDraftId && !preferredDraft) {
          setError("已保存的草稿暂未出现在刷新结果中。当前编辑已保留，请刷新后核对版本再发布。");
          return;
        }
        const preferred = preferredDraft || body.active || null;
        setSelectedDraftId(preferredDraft ? revisionId(preferredDraft) : "");
        setEditor(`${JSON.stringify(revisionPayload(preferred), null, 2)}\n`);
        setSchemaVersion(revisionSchemaVersion(preferred));
        setEditorBase({ payload: revisionPayload(preferred), schemaVersion: revisionSchemaVersion(preferred), updatedAt: revisionValue(preferred).updated_at });
      }
    } catch (reason) {
      setData(null);
      setError(reason instanceof Error ? reason.message : "漫剧配置读取失败");
    } finally {
      setBusy("");
    }
  }, [domain, environment, token]);

  useEffect(() => {
    void loadConfig();
  }, [loadConfig]);

  function parseEditor(): Record<string, unknown> | null {
    setError("");
    try {
      const parsed = JSON.parse(editor) as unknown;
      if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
        throw new Error("配置根节点必须是 JSON 对象。");
      }
      const sensitivePaths = findSensitivePaths(parsed);
      if (sensitivePaths.length > 0) {
        throw new Error(`配置中检测到敏感字段：${sensitivePaths.slice(0, 4).join("、")}。密钥、令牌和密码必须留在服务端密钥管理中。`);
      }
      return parsed as Record<string, unknown>;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "JSON 解析失败");
      return null;
    }
  }

  async function postAction(action: "validate" | "save-draft" | "publish" | "rollback", fields: Record<string, unknown>) {
    setBusy(action);
    setError("");
    setNotice("");
    try {
      if (!token) throw new Error("管理员会话缺失，请重新登录后再试。");
      const response = await fetch("/api/admin/manju-config", {
        method: "POST",
        headers,
        body: JSON.stringify({
          action,
          environment,
          domain,
          ...(action !== "validate" && Number.isSafeInteger(data?.storage_generation)
            ? { expected_storage_generation: data?.storage_generation }
            : {}),
          ...fields,
        }),
      });
      const body = await response.json().catch(() => ({})) as ConfigResponse;
      if (!response.ok || body.ok === false) throw new Error(errorMessage(body, "配置操作失败"));
      return body;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "配置操作失败");
      return null;
    } finally {
      setBusy("");
    }
  }

  async function validateDraft() {
    const payload = parseEditor();
    if (!payload) return;
    const result = await postAction("validate", { payload, schema_version: schemaVersion });
    if (!result) return;
    setValidationResult(result);
    setNotice(result.valid === false ? "校验完成：仍有问题，请根据结果修正。" : "校验通过；仍需保存草稿后才能发布。");
  }

  async function saveDraft() {
    const payload = parseEditor();
    if (!payload) return;
    const result = await postAction("save-draft", {
      payload,
      schema_version: schemaVersion,
      ...(selectedDraftId ? { revision_id: selectedDraftId } : {}),
      ...(selectedDraftId && editorBase?.updatedAt ? { expected_updated_at: editorBase.updatedAt } : {}),
    });
    if (!result) return;
    setNotice("草稿已持久化；前台仍不会读取未发布内容。");
    await loadConfig({ preferredDraftId: revisionId(result.revision) || selectedDraftId });
  }

  async function publishDraft(record?: ConfigRevision) {
    if (hasUnsavedChanges) {
      setError("当前提示词或配置尚未保存，请先保存草稿，再发布最新内容。");
      return;
    }
    const targetId = revisionId(record) || selectedDraftId;
    if (!targetId) {
      setError("请先保存或选择一份草稿，再执行发布。");
      return;
    }
    const target = record || data?.drafts?.find((item) => revisionId(item) === targetId);
    const runtimeTarget = domain === "prompt" ? "服务端 Agent 链路" : "公开运行时";
    const confirmed = window.confirm(
      `确认将 ${domain} v${revisionVersion(target)} 发布到 ${environment}？发布后${runtimeTarget}只读取该已发布版本。`,
    );
    if (!confirmed) return;

    const result = await postAction("publish", {
      revision_id: targetId,
      expected_active_release_id: releaseId(data?.active) || null,
    });
    if (!result) return;
    setNotice(`发布成功，活动指针已更新；${runtimeTarget}将在短缓存到期或刷新后读取已发布配置。`);
    await loadConfig();
  }

  async function rollbackRelease(record: ConfigRevision) {
    if (hasUnsavedChanges) {
      setError("当前配置尚未保存，请先保存草稿，再切换发布版本。");
      return;
    }
    const targetReleaseId = releaseId(record);
    if (!targetReleaseId) {
      setError("该历史记录缺少 release_id，无法安全回滚。");
      return;
    }
    const confirmed = window.confirm(
      `确认把 ${environment}/${domain} 回滚到 v${revisionVersion(record)}？系统将新建可审计发布记录，不会篡改历史版本。`,
    );
    if (!confirmed) return;

    const result = await postAction("rollback", {
      target_release_id: targetReleaseId,
      expected_active_release_id: releaseId(data?.active) || null,
    });
    if (!result) return;
    setNotice("回滚成功，已重新读取当前活动版本。");
    await loadConfig();
  }

  async function loadPromptBaseline() {
    if (domain !== "prompt") return;
    setBusy("baseline");
    setError("");
    setNotice("");
    try {
      const response = await fetch("/api/admin/manju-workbench/prompts", {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
      });
      const body = await response.json().catch(() => ({})) as {
        prompts?: Array<{ kind?: string; id?: string; version?: string; content?: string }>;
        error?: string;
      };
      if (!response.ok) throw new Error(body.error || "服务端提示词基线读取失败");
      const baseline = body.prompts?.find((item) => item.kind === "manga_base");
      if (!baseline?.content || !baseline.version) {
        throw new Error("没有读取到可核验的漫剧提示词基线");
      }
      let current: Record<string, unknown> = {};
      try {
        const parsed = JSON.parse(editor) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          current = parsed as Record<string, unknown>;
        }
      } catch {
        current = {};
      }
      const previousRuntime = current.runtime_prompts && typeof current.runtime_prompts === "object" && !Array.isArray(current.runtime_prompts)
        ? current.runtime_prompts as Record<string, unknown>
        : {};
      const next = {
        ...current,
        version: "2026-08-29",
        policy: "private-server-runtime-prompts",
        runtime_prompts: {
          ...previousRuntime,
          manga_virtual_agent_prompt: {
            version: baseline.version,
            content: baseline.content,
          },
        },
      };
      setSelectedDraftId("");
      setSchemaVersion(LATEST_SCHEMA_VERSION);
      setEditor(`${JSON.stringify(next, null, 2)}\n`);
      setValidationResult(null);
      setNotice("已把服务端受审基线载入编辑器；请先校验、保存草稿，再发布，当前线上版本尚未改变。");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "服务端提示词基线读取失败");
    } finally {
      setBusy("");
    }
  }

  async function loadSkillBaseline() {
    if (domain !== "skill") return;
    setBusy("skill-baseline");
    setError("");
    setNotice("");
    try {
      const response = await fetch("/api/admin/manju-workbench/skills", {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
      });
      const body = await response.json().catch(() => ({})) as {
        baselinePayload?: Record<string, unknown>;
        error?: string;
      };
      if (!response.ok || !body.baselinePayload) {
        throw new Error(body.error || "Skill 治理模板读取失败");
      }
      setSelectedDraftId("");
      setSchemaVersion(LATEST_SCHEMA_VERSION);
      setEditor(`${JSON.stringify(body.baselinePayload, null, 2)}\n`);
      setValidationResult(null);
      setNotice("已载入 36 项 Skill 管理模板；请按命令名修改对应覆盖项，校验、保存草稿并发布后才会进入服务端 Agent 链路。");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Skill 治理模板读取失败");
    } finally {
      setBusy("");
    }
  }

  function chooseDraft(record: ConfigRevision) {
    setSelectedDraftId(revisionId(record));
    setEditor(`${JSON.stringify(revisionPayload(record), null, 2)}\n`);
    setSchemaVersion(revisionSchemaVersion(record));
    setEditorBase({ payload: revisionPayload(record), schemaVersion: revisionSchemaVersion(record), updatedAt: revisionValue(record).updated_at });
    setValidationResult(null);
    setNotice("已载入所选草稿；修改后请重新校验并保存。");
  }

  function chooseActive() {
    if (!data?.active) return;
    setSelectedDraftId("");
    setEditor(`${JSON.stringify(revisionPayload(data.active), null, 2)}\n`);
    setSchemaVersion(revisionSchemaVersion(data.active));
    setEditorBase({ payload: revisionPayload(data.active), schemaVersion: revisionSchemaVersion(data.active) });
    setValidationResult(null);
    setNotice("已载入当前线上版本作为新草稿起点；保存不会直接覆盖线上版本。");
  }

  const drafts = data?.drafts || [];
  const history = data?.history || [];
  const selectedDraft = drafts.find((item) => revisionId(item) === selectedDraftId);
  const activeReleaseId = releaseId(data?.active);
  const hasUnsavedChanges = editorBase !== null && (
    schemaVersion !== editorBase.schemaVersion || manjuJsonEditorChanged(editor, editorBase.payload)
  );
  const selectedDomain = DOMAIN_OPTIONS.find((item) => item.value === domain) || DOMAIN_OPTIONS[0];

  return (
    <section id="manju-config-center" className="space-y-4 rounded-xl border border-[var(--border)] bg-[var(--card)] p-4" data-admin-section="manju-config-center">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 text-sm font-semibold text-[var(--foreground)]">
            <ShieldCheck size={18} className="text-emerald-500" />
            漫剧配置中心
          </div>
          <p className="mt-1 max-w-3xl text-xs leading-5 text-[var(--muted-foreground)]">
            这是漫剧工作台自己的配置后台，不是主站应用广场、主站智能体卡片或通用画布 Prompt 后台。草稿与线上版本隔离；prompt 仅进入漫剧服务端 Agent 链路，前台匿名接口只发布 content、media、feature_flags 三个受控域。
          </p>
        </div>
        <button
          type="button"
          className="inline-flex items-center gap-2 rounded-md border border-[var(--border)] px-3 py-2 text-sm text-[var(--foreground)] disabled:opacity-50"
          onClick={() => void loadConfig({ preserveEditor: true })}
          disabled={Boolean(busy)}
        >
          <RefreshCw size={15} className={busy === "load" ? "animate-spin" : ""} />刷新配置
        </button>
      </div>

      <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-xs leading-5 text-[var(--secondary-foreground)]">
        <AlertTriangle size={16} className="mt-0.5 shrink-0 text-amber-500" />
        <span>铁律：漫剧工作台的提示词、示例、素材、导航与功能开关只能来自本配置域或已登记的本站素材目录；不得混入主站智能体卡片、Skill 应用广场或通用画布 Prompt。配置数据不存放 API Key、Token、密码或私钥。</span>
      </div>

      <div className="grid grid-cols-1 gap-2 rounded-md border border-blue-500/25 bg-blue-500/5 p-3 text-xs leading-5 text-[var(--secondary-foreground)] md:grid-cols-[180px_minmax(0,1fr)]">
        <div>
          <strong className="block text-[var(--foreground)]">{selectedDomain.label}</strong>
          <span className="text-blue-600">可见范围：{selectedDomain.visibility}</span>
        </div>
        <p>{selectedDomain.effect}</p>
      </div>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-[220px_260px_minmax(0,1fr)]">
        <label className="text-xs text-[var(--muted-foreground)]">
          运行环境
          <select
            className="mt-1 w-full rounded-md border border-[var(--border)] bg-[var(--background)] px-3 py-2 text-sm text-[var(--foreground)]"
            value={environment}
            onChange={(event) => setEnvironment(event.target.value)}
            disabled={Boolean(busy)}
          >
            {ENVIRONMENTS.map((item) => <option key={item} value={item}>{item}</option>)}
          </select>
        </label>
        <label className="text-xs text-[var(--muted-foreground)]">
          配置域
          <select
            className="mt-1 w-full rounded-md border border-[var(--border)] bg-[var(--background)] px-3 py-2 text-sm text-[var(--foreground)]"
            value={domain}
            onChange={(event) => setDomain(event.target.value)}
            disabled={Boolean(busy)}
          >
            {DOMAIN_OPTIONS.map((item) => <option key={item.value} value={item.value}>{item.label} · {item.value}</option>)}
          </select>
        </label>
        <div className="grid grid-cols-4 gap-2">
          <article className="rounded-md border border-[var(--border)] bg-[var(--background)] p-3">
            <small className="text-[var(--muted-foreground)]">活动版本</small>
            <strong className="mt-1 block text-sm text-[var(--foreground)]">v{revisionVersion(data?.active)}</strong>
          </article>
          <article className="rounded-md border border-[var(--border)] bg-[var(--background)] p-3">
            <small className="text-[var(--muted-foreground)]">草稿</small>
            <strong className="mt-1 block text-sm text-[var(--foreground)]">{drafts.length}</strong>
          </article>
          <article className="rounded-md border border-[var(--border)] bg-[var(--background)] p-3">
            <small className="text-[var(--muted-foreground)]">发布历史</small>
            <strong className="mt-1 block text-sm text-[var(--foreground)]">{history.length}</strong>
          </article>
          <article className="rounded-md border border-[var(--border)] bg-[var(--background)] p-3">
            <small className="text-[var(--muted-foreground)]">存储链路</small>
            <strong className="mt-1 block text-sm text-[var(--foreground)]">{data?.storage_mode === "compat" ? "兼容存储" : data?.storage_mode === "native" ? "原生版本库" : "未读取"}{Number.isSafeInteger(data?.storage_generation) ? ` · G${data?.storage_generation}` : ""}</strong>
          </article>
        </div>
      </div>

      {error ? (
        <div className="flex items-start gap-2 rounded-md border border-red-500/30 bg-red-500/5 p-3 text-sm text-red-600" role="alert">
          <AlertTriangle size={17} className="mt-0.5 shrink-0" />
          <div><strong>操作未完成</strong><p className="mt-1 text-xs leading-5">{error}</p></div>
        </div>
      ) : null}

      {notice ? (
        <div className="flex items-start gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/5 p-3 text-sm text-emerald-600" role="status">
          <CheckCircle2 size={17} className="mt-0.5 shrink-0" /><span>{notice}</span>
        </div>
      ) : null}

      {hasUnsavedChanges ? <p className="text-xs text-amber-600" role="status">当前编辑尚未保存。保存草稿后，即可发布这次修改。</p> : null}

      {busy === "load" && !data ? (
        <div className="flex min-h-32 items-center justify-center text-sm text-[var(--muted-foreground)]" role="status">
          <LoaderCircle size={18} className="mr-2 animate-spin" />正在读取配置控制平面…
        </div>
      ) : null}

      {data ? (
        <div className="grid grid-cols-1 gap-4 2xl:grid-cols-[minmax(0,1fr)_380px]">
          <div className="space-y-3">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <label className="text-xs text-[var(--muted-foreground)]">
                Schema 版本
                <input
                  className="mt-1 block w-40 rounded-md border border-[var(--border)] bg-[var(--background)] px-3 py-2 text-sm text-[var(--foreground)]"
                  value={schemaVersion}
                  onChange={(event) => setSchemaVersion(event.target.value)}
                  disabled={Boolean(busy)}
                />
              </label>
              <div className="flex flex-wrap gap-2">
                {domain === "prompt" ? (
                  <button type="button" className="inline-flex items-center gap-2 rounded-md border border-blue-500/30 px-3 py-2 text-sm text-blue-600 disabled:opacity-50" onClick={() => void loadPromptBaseline()} disabled={Boolean(busy)}>
                    {busy === "baseline" ? <LoaderCircle size={15} className="animate-spin" /> : <FileJson2 size={15} />}载入服务端基线
                  </button>
                ) : null}
                {domain === "skill" ? (
                  <button type="button" className="inline-flex items-center gap-2 rounded-md border border-violet-500/30 px-3 py-2 text-sm text-violet-600 disabled:opacity-50" onClick={() => void loadSkillBaseline()} disabled={Boolean(busy)}>
                    {busy === "skill-baseline" ? <LoaderCircle size={15} className="animate-spin" /> : <FileJson2 size={15} />}载入 36 项 Skill 管理模板
                  </button>
                ) : null}
                <button type="button" className="inline-flex items-center gap-2 rounded-md border border-[var(--border)] px-3 py-2 text-sm disabled:opacity-50" onClick={() => void validateDraft()} disabled={Boolean(busy)}>
                  <ShieldCheck size={15} />校验 JSON
                </button>
                <button type="button" className="inline-flex items-center gap-2 rounded-md border border-[var(--border)] px-3 py-2 text-sm disabled:opacity-50" onClick={() => void saveDraft()} disabled={Boolean(busy)}>
                  {busy === "save-draft" ? <LoaderCircle size={15} className="animate-spin" /> : <Save size={15} />}保存草稿
                </button>
                <button type="button" className="inline-flex items-center gap-2 rounded-md bg-[var(--primary)] px-3 py-2 text-sm font-semibold text-white disabled:opacity-50" onClick={() => void publishDraft(selectedDraft)} disabled={Boolean(busy) || !selectedDraftId || hasUnsavedChanges}>
                  {busy === "publish" ? <LoaderCircle size={15} className="animate-spin" /> : <Send size={15} />}发布所选草稿
                </button>
              </div>
            </div>

            <label className="block rounded-md border border-[var(--border)] bg-[var(--background)] p-3">
              <span className="flex flex-wrap items-center justify-between gap-2">
                <span className="inline-flex items-center gap-2 text-sm font-semibold text-[var(--foreground)]"><FileJson2 size={16} />JSON 配置草稿</span>
                <small className="text-[var(--muted-foreground)]">{selectedDraftId ? `正在编辑 ${shortId(selectedDraftId)}` : "将创建新草稿"}</small>
              </span>
              <textarea
                rows={28}
                spellCheck={false}
                className="mt-3 w-full resize-y rounded-md border border-[var(--border)] bg-[var(--card)] px-3 py-2 font-mono text-xs leading-5 text-[var(--foreground)]"
                value={editor}
                onChange={(event) => setEditor(event.target.value)}
                disabled={Boolean(busy)}
              />
            </label>

            {validationResult ? (
              <details className="rounded-md border border-[var(--border)] bg-[var(--background)] p-3" open={validationResult.valid === false}>
                <summary className="cursor-pointer text-sm font-medium text-[var(--foreground)]">服务端校验结果：{validationResult.valid === false ? "未通过" : "通过"}</summary>
                <pre className="mt-3 max-h-64 overflow-auto whitespace-pre-wrap rounded-md bg-[var(--card)] p-3 text-xs leading-5 text-[var(--secondary-foreground)]">{JSON.stringify({ valid: validationResult.valid, issues: validationResult.issues, warnings: validationResult.warnings }, null, 2)}</pre>
              </details>
            ) : null}
          </div>

          <aside className="space-y-3">
            <section className="rounded-md border border-emerald-500/30 bg-emerald-500/5 p-3">
              <div className="flex items-center gap-2 text-sm font-semibold text-[var(--foreground)]"><Database size={16} />当前活动指针</div>
              {data.active ? (
                <div className="mt-3 space-y-2 text-xs text-[var(--secondary-foreground)]">
                  <p><span className="text-[var(--muted-foreground)]">Release：</span>{shortId(activeReleaseId)}</p>
                  <p><span className="text-[var(--muted-foreground)]">Revision：</span>{shortId(revisionId(data.active))}</p>
                  <p><span className="text-[var(--muted-foreground)]">版本：</span>v{revisionVersion(data.active)} · schema {revisionSchemaVersion(data.active)}</p>
                  <p><span className="text-[var(--muted-foreground)]">ETag：</span>{shortId(recordEtag(data.active))}</p>
                  <p><span className="text-[var(--muted-foreground)]">发布时间：</span>{recordTime(data.active)}</p>
                  <button type="button" className="mt-2 w-full rounded-md border border-emerald-500/30 px-3 py-2 text-sm" onClick={chooseActive} disabled={Boolean(busy)}>载入线上版本作为草稿起点</button>
                </div>
              ) : <p className="mt-3 text-xs leading-5 text-[var(--muted-foreground)]">该环境与配置域尚无已发布版本；公开运行时应保持 fail-closed。</p>}
            </section>

            <section className="rounded-md border border-[var(--border)] bg-[var(--background)] p-3">
              <div className="flex items-center gap-2 text-sm font-semibold text-[var(--foreground)]"><Save size={16} />草稿列表</div>
              <div className="mt-3 space-y-2">
                {drafts.length === 0 ? <p className="text-xs text-[var(--muted-foreground)]">暂无草稿。编辑 JSON 后点击“保存草稿”。</p> : null}
                {drafts.map((record) => {
                  const id = revisionId(record);
                  const selected = id === selectedDraftId;
                  return (
                    <article key={id || `${record.version}-${record.created_at}`} className={`rounded-md border p-3 ${selected ? "border-[var(--primary)] bg-[var(--accent)]" : "border-[var(--border)] bg-[var(--card)]"}`}>
                      <div className="flex items-center justify-between gap-2">
                        <strong className="text-sm text-[var(--foreground)]">v{revisionVersion(record)}</strong>
                        <span className="text-[11px] text-[var(--muted-foreground)]">{recordTime(record)}</span>
                      </div>
                      <p className="mt-1 text-[11px] text-[var(--muted-foreground)]">{shortId(id)} · schema {revisionSchemaVersion(record)}</p>
                      <div className="mt-2 grid grid-cols-2 gap-2">
                        <button type="button" className="rounded border border-[var(--border)] px-2 py-1.5 text-xs" onClick={() => chooseDraft(record)} disabled={Boolean(busy)}>编辑</button>
                        <button type="button" className="rounded bg-[var(--primary)] px-2 py-1.5 text-xs font-medium text-white" onClick={() => void publishDraft(record)} disabled={Boolean(busy) || hasUnsavedChanges}>发布</button>
                      </div>
                    </article>
                  );
                })}
              </div>
            </section>

            <section className="rounded-md border border-[var(--border)] bg-[var(--background)] p-3">
              <div className="flex items-center gap-2 text-sm font-semibold text-[var(--foreground)]"><History size={16} />发布与回滚历史</div>
              <div className="mt-3 max-h-80 space-y-2 overflow-auto pr-1">
                {history.length === 0 ? <p className="text-xs text-[var(--muted-foreground)]">暂无发布历史。</p> : null}
                {history.map((record) => {
                  const id = releaseId(record);
                  const isActive = Boolean(id && id === activeReleaseId);
                  return (
                    <article key={id || `${record.version}-${record.published_at}`} className="rounded-md border border-[var(--border)] bg-[var(--card)] p-3">
                      <div className="flex items-center justify-between gap-2">
                        <strong className="text-sm text-[var(--foreground)]">v{revisionVersion(record)}</strong>
                        <span className={`rounded-full px-2 py-0.5 text-[10px] ${isActive ? "bg-emerald-500/10 text-emerald-600" : "bg-[var(--accent)] text-[var(--muted-foreground)]"}`}>{isActive ? "当前活动" : recordStatus(record)}</span>
                      </div>
                      <p className="mt-1 text-[11px] text-[var(--muted-foreground)]">{recordTime(record)} · {shortId(id)}</p>
                      <button type="button" className="mt-2 inline-flex w-full items-center justify-center gap-2 rounded border border-[var(--border)] px-2 py-1.5 text-xs disabled:opacity-50" onClick={() => void rollbackRelease(record)} disabled={Boolean(busy) || isActive}>
                        <RotateCcw size={13} />{isActive ? "当前版本" : "回滚到此版本"}
                      </button>
                    </article>
                  );
                })}
              </div>
            </section>
          </aside>
        </div>
      ) : null}
    </section>
  );
}
