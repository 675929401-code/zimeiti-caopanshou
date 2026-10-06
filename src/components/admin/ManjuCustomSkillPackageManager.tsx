"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Archive,
  CheckCircle2,
  FileJson2,
  LoaderCircle,
  PackagePlus,
  RefreshCw,
  RotateCcw,
  Save,
  Send,
  ShieldCheck,
} from "lucide-react";

interface Props {
  token: string;
}

type JsonRecord = Record<string, unknown>;
type SkillOrigin = "builtin" | "open_source" | "community" | "custom";
type SkillVisibility = "private" | "tenant" | "public";
type SkillRuntimeKind = "prompt" | "tool" | "workflow" | "hybrid";
type SkillExecutionType = "prompt" | "tool" | "workflow" | "hybrid";

interface AdminSkillPackageRow {
  id: string;
  slug: string;
  display_name: string;
  summary: string;
  origin: SkillOrigin;
  visibility: SkillVisibility;
  runtime_kind: SkillRuntimeKind;
  lifecycle: "draft" | "published" | "archived";
  active_version_id: string | null;
  latest_version_number: number;
  updated_at: string;
  metadata?: JsonRecord;
  created_by?: string | null;
}

interface AdminSkillVersionRow {
  id: string;
  package_id: string;
  version_number: number;
  semver: string;
  status: "draft" | "released";
  payload: JsonRecord;
  payload_hash: string;
  schema_version: string;
  updated_at: string;
  published_at: string | null;
}

interface AdminSkillPackageView {
  package: AdminSkillPackageRow;
  versions: AdminSkillVersionRow[];
}

interface PackageResponse {
  ok?: boolean;
  packages?: AdminSkillPackageView[];
  count?: number;
  sourceAccess?: "visible" | "protected";
  code?: string;
  error?: string;
  operation?: string;
  result?: JsonRecord;
  issues?: Array<{ path?: string; message?: string }>;
}

interface PackageFormState {
  packageId: string;
  versionId: string;
  expectedUpdatedAt: string;
  slug: string;
  displayName: string;
  summary: string;
  commandName: string;
  category: string;
  tagsText: string;
  triggerText: string;
  author: string;
  semver: string;
  schemaVersion: string;
  origin: SkillOrigin;
  visibility: SkillVisibility;
  runtimeKind: SkillRuntimeKind;
  executionType: SkillExecutionType;
  autoInvoke: boolean;
  priceCredits: string;
  instructions: string;
  metadataText: string;
}

const DEFAULT_FORM: PackageFormState = {
  packageId: "",
  versionId: "",
  expectedUpdatedAt: "",
  slug: "",
  displayName: "",
  summary: "",
  commandName: "/",
  category: "漫剧创作",
  tagsText: "漫剧、提示词、工作流",
  triggerText: "",
  author: "漫剧工作台管理员",
  semver: "1.0.0",
  schemaVersion: "1.0.0",
  origin: "custom",
  visibility: "private",
  runtimeKind: "prompt",
  executionType: "prompt",
  autoInvoke: false,
  priceCredits: "0",
  instructions: "",
  metadataText: "{}",
};

function splitText(value: string, max: number): string[] {
  return Array.from(
    new Set(
      value
        .split(/[、，,;\n\r\t]+/u)
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ).slice(0, max);
}

function normalizeCommandName(value: string): string {
  const clean = value.trim().replace(/^\/+/u, "").toLowerCase();
  return `/${clean}`;
}

function normalizeSlug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 80);
}

function shortId(value: string | null | undefined): string {
  if (!value) return "—";
  return value.length > 18 ? `${value.slice(0, 8)}…${value.slice(-6)}` : value;
}

function formatTime(value: string | null | undefined): string {
  if (!value) return "未记录";
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toLocaleString("zh-CN") : value;
}

function parseMetadata(text: string): JsonRecord | null {
  try {
    const parsed = JSON.parse(text || "{}") as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as JsonRecord;
  } catch {
    return null;
  }
}

function payloadFromForm(form: PackageFormState, basePayload?: JsonRecord, baseForm?: PackageFormState): JsonRecord {
  const commandName = normalizeCommandName(form.commandName);
  const tags = splitText(form.tagsText, 32);
  const triggerSignals = splitText(form.triggerText, 64);
  const priceCredits = Number(form.priceCredits || 0);
  const created: JsonRecord = {
    manifest: {
      commandName,
      displayName: form.displayName.trim(),
      description: form.summary.trim(),
      category: form.category.trim() || "漫剧创作",
      tags,
      triggerSignals,
      negativeTriggerSignals: [],
      autoInvoke: form.autoInvoke,
      priority: 0,
      permissions: [],
      author: form.author.trim() || "漫剧工作台管理员",
      featured: false,
      priceCredits: Number.isFinite(priceCredits) && priceCredits >= 0 ? priceCredits : 0,
      installCount: 0,
      purchaseCount: 0,
    },
    instructions: form.instructions.trim(),
    input_schema: {
      type: "object",
      additionalProperties: true,
      description: "用户在漫剧工作台输入的创作需求。",
    },
    output_schema: {
      type: "object",
      additionalProperties: true,
      properties: {
        result: { type: "string", description: "Skill 输出结果" },
      },
    },
    execution_type: form.executionType,
    sanitized_config: {},
    routing: {
      explicitCommands: [commandName],
      triggerSignals,
      negativeTriggerSignals: [],
      autoInvoke: form.autoInvoke,
      priority: 0,
    },
    orchestration: {
      stages: [
        {
          id: "main",
          type: "prompt",
          title: "主提示词执行",
          dependsOn: [],
          instruction: "按 Skill 指令处理用户输入，并输出可直接使用的创作结果。",
          outputKey: "result",
          config: {},
        },
      ],
      missingInputPolicy: "ask",
      maxModelCalls: form.executionType === "prompt" ? 1 : 0,
      maxToolCalls: form.executionType === "tool" || form.executionType === "workflow" || form.executionType === "hybrid" ? 1 : 0,
    },
    tools: [],
    resources: [],
    provenance: {
      kind: "internal_original",
      sourceName: "漫剧工作台后台自建",
      license: "internal-use",
      attribution: "",
      publicBehaviorReference: "由管理员在漫剧工作台后台创建、校验并发布。",
    },
  };
  if (!basePayload || !baseForm) return created;

  const record = (value: unknown): JsonRecord => value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
  const manifest = { ...record(basePayload.manifest) };
  const generatedManifest = record(created.manifest);
  const manifestFields: Array<[keyof PackageFormState, string]> = [
    ["commandName", "commandName"], ["displayName", "displayName"], ["summary", "description"],
    ["category", "category"], ["tagsText", "tags"], ["triggerText", "triggerSignals"],
    ["author", "author"], ["autoInvoke", "autoInvoke"], ["priceCredits", "priceCredits"],
  ];
  for (const [field, key] of manifestFields) {
    if (form[field] !== baseForm[field]) manifest[key] = generatedManifest[key];
  }
  const routing = { ...record(basePayload.routing) };
  if (form.commandName !== baseForm.commandName) {
    const oldCommand = normalizeCommandName(baseForm.commandName);
    const aliases = Array.isArray(routing.explicitCommands) ? routing.explicitCommands : [];
    routing.explicitCommands = Array.from(new Set([commandName, ...aliases.filter((entry) => entry !== oldCommand)]));
  }
  if (form.triggerText !== baseForm.triggerText) routing.triggerSignals = triggerSignals;
  if (form.autoInvoke !== baseForm.autoInvoke) routing.autoInvoke = form.autoInvoke;
  return {
    ...basePayload,
    manifest,
    routing,
    ...(form.instructions !== baseForm.instructions ? { instructions: created.instructions } : {}),
    ...(form.executionType !== baseForm.executionType ? { execution_type: form.executionType } : {}),
  };
}

function formFromPackage(view: AdminSkillPackageView): PackageFormState {
  const version = view.versions[0];
  const payload = version?.payload || {};
  const manifest = (payload.manifest && typeof payload.manifest === "object" && !Array.isArray(payload.manifest))
    ? payload.manifest as JsonRecord
    : {};
  const routing = (payload.routing && typeof payload.routing === "object" && !Array.isArray(payload.routing))
    ? payload.routing as JsonRecord
    : {};
  return {
    ...DEFAULT_FORM,
    packageId: view.package.id,
    versionId: version?.status === "draft" ? version.id : "",
    expectedUpdatedAt: view.package.updated_at,
    slug: view.package.slug,
    displayName: String(manifest.displayName || view.package.display_name || ""),
    summary: String(manifest.description || view.package.summary || ""),
    commandName: String(manifest.commandName || "/"),
    category: String(manifest.category || DEFAULT_FORM.category),
    tagsText: Array.isArray(manifest.tags) ? manifest.tags.filter((item): item is string => typeof item === "string").join("、") : "",
    triggerText: Array.isArray(routing.triggerSignals) ? routing.triggerSignals.filter((item): item is string => typeof item === "string").join("、") : "",
    author: String(manifest.author || DEFAULT_FORM.author),
    semver: version?.semver || DEFAULT_FORM.semver,
    schemaVersion: version?.schema_version || DEFAULT_FORM.schemaVersion,
    origin: view.package.origin || "custom",
    visibility: view.package.visibility || "private",
    runtimeKind: view.package.runtime_kind || "prompt",
    executionType: (payload.execution_type as SkillExecutionType) || "prompt",
    autoInvoke: manifest.autoInvoke === true,
    priceCredits: String(manifest.priceCredits ?? 0),
    instructions: typeof payload.instructions === "string" ? payload.instructions : "",
    metadataText: JSON.stringify(view.package.metadata || {}, null, 2),
  };
}

function describePackageError(body: PackageResponse, fallback: string): string {
  const raw = body.error || fallback;
  if (body.code === "ADMIN_STEP_UP_REQUIRED") {
    return "需解锁敏感操作：请先重新验证管理员密码，再读取或编辑 Skill 核心源内容。";
  }
  if (body.code === "ADMIN_PERMISSION_DENIED") {
    return "无核心源权限：当前管理员只能查看 Skill 非敏感元数据，不能读取或编辑内部指令。";
  }
  if (body.code === "MIGRATION_NOT_READY" || /MIGRATION_NOT_READY|schema cache|could not find|does not exist/iu.test(raw)) {
    return "Skill 包数据库迁移尚未完成（MIGRATION_NOT_READY）：后台已具备新增/校验入口，但保存、发布、安装必须等 skill_packages runtime migration 落库后才能真实持久化。";
  }
  if (body.code === "SERVICE_ROLE_REQUIRED") {
    return "服务端缺少 service role，不能执行 Skill 包持久化。";
  }
  return raw;
}

export function ManjuCustomSkillPackageManager({ token }: Props) {
  const [actorId, setActorId] = useState("");
  const [packages, setPackages] = useState<AdminSkillPackageView[]>([]);
  const [form, setForm] = useState<PackageFormState>(DEFAULT_FORM);
  const [editBase, setEditBase] = useState<{ payload: JsonRecord; form: PackageFormState; versionId: string } | null>(null);
  const [saveIdentityMissing, setSaveIdentityMissing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [validation, setValidation] = useState<JsonRecord | null>(null);
  const [storeState, setStoreState] = useState<"unknown" | "ready" | "migration_not_ready" | "unavailable">("unknown");

  const headers = useMemo(() => ({
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  }), [token]);

  useEffect(() => {
    let current = true;
    void fetch("/api/auth/me", { headers, cache: "no-store" }).then(async (response) => {
      const body = await response.json();
      if (current && response.ok && body.user?.role === "admin") setActorId(String(body.user.id || ""));
    }).catch(() => { if (current) setActorId(""); });
    return () => { current = false; };
  }, [headers]);

  const clearProtectedPackageState = useCallback(() => {
    setPackages([]);
    setForm(DEFAULT_FORM);
    setEditBase(null);
    setSaveIdentityMissing(false);
    setValidation(null);
    setNotice("");
  }, []);

  const loadPackages = useCallback(async (options?: { preserveNotice?: boolean }) => {
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/admin/skill-packages?limit=80&include_source=1", {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
      });
      const body = await response.json().catch(() => ({})) as PackageResponse;
      if (!response.ok || body.ok === false) {
        clearProtectedPackageState();
        setStoreState(body.code === "MIGRATION_NOT_READY" ? "migration_not_ready" : "unavailable");
        throw new Error(describePackageError(body, "用户自建 Skill 包列表读取失败"));
      }
      if (body.sourceAccess !== "visible") {
        clearProtectedPackageState();
        setStoreState("unavailable");
        throw new Error("Skill 核心源未获授权，已停止载入编辑器，避免把非敏感元数据误当成完整包保存。");
      }
      setPackages(body.packages || []);
      setStoreState("ready");
      if (!options?.preserveNotice) setNotice(`已读取 ${body.count ?? body.packages?.length ?? 0} 个用户自建/导入 Skill 包。`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "用户自建 Skill 包列表读取失败");
    } finally {
      setLoading(false);
    }
  }, [clearProtectedPackageState, token]);

  useEffect(() => {
    void loadPackages();
  }, [loadPackages]);

  function patchForm(patch: Partial<PackageFormState>) {
    setForm((current) => ({ ...current, ...patch }));
    setValidation(null);
  }

  function startNew() {
    if (busy) return;
    setForm(DEFAULT_FORM);
    setEditBase(null);
    setSaveIdentityMissing(false);
    setValidation(null);
    setNotice("已切换到新增 Skill 包草稿；先填写命令、名称、摘要和提示词，再校验。");
  }

  function selectPackage(view: AdminSkillPackageView) {
    if (busy) return;
    const nextForm = formFromPackage(view);
    const version = view.versions[0];
    setForm(nextForm);
    setEditBase(version ? { payload: version.payload, form: nextForm, versionId: version.id } : null);
    setSaveIdentityMissing(false);
    setValidation(null);
    setNotice(view.package.lifecycle === "archived"
      ? `「${view.package.display_name}」已归档，版本记录仅供查看，不能安装、发布或回滚。`
      : `已载入「${view.package.display_name}」作为编辑起点；发布前仍需保存草稿。`);
  }

  async function postAction(action: "validate" | "save-draft", options?: { save?: boolean }) {
    if (action === "save-draft" && saveIdentityMissing) {
      setError("上次保存返回的版本信息不完整。请刷新列表并重新选择已保存的包后再修改，避免重复新建。");
      return null;
    }
    const metadata = parseMetadata(form.metadataText);
    if (!metadata) {
      setError("metadata 必须是 JSON 对象。");
      return null;
    }
    const payload = payloadFromForm(form, editBase?.payload, editBase?.form);
    setBusy(action);
    setError("");
    setNotice("");
    try {
      const body = {
        action,
        packageId: form.packageId || null,
        versionId: form.versionId || null,
        ...(editBase ? { baseVersionId: editBase.versionId } : {}),
        expectedUpdatedAt: form.expectedUpdatedAt || null,
        slug: normalizeSlug(form.slug),
        displayName: form.displayName.trim(),
        summary: form.summary.trim(),
        origin: form.origin,
        visibility: form.visibility,
        runtimeKind: form.runtimeKind,
        payload,
        semver: form.semver.trim(),
        schemaVersion: form.schemaVersion,
        metadata,
      };
      const response = await fetch("/api/admin/skill-packages", {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
      const result = await response.json().catch(() => ({})) as PackageResponse;
      if (!response.ok || result.ok === false) {
        throw new Error(describePackageError(result, options?.save ? "Skill 包草稿保存失败" : "Skill 包校验失败"));
      }
      setValidation((result.result || {
        ok: result.ok === true,
        count: result.count ?? 0,
        operation: result.operation || action,
      }) as JsonRecord);
      setNotice(action === "validate" ? "Skill 包结构校验通过；保存发布前不会进入前台。" : "Skill 包草稿已保存；发布后才允许用户安装/调用。");
      if (action === "save-draft") {
        const saved = result.result;
        const savedPackageId = typeof saved?.package_id === "string" ? saved.package_id : "";
        const savedVersionId = typeof saved?.version_id === "string" ? saved.version_id : "";
        const savedUpdatedAt = typeof saved?.updated_at === "string" ? saved.updated_at : "";
        if (!savedPackageId || !savedVersionId || !Number.isFinite(Date.parse(savedUpdatedAt))) {
          setSaveIdentityMissing(true);
          setNotice("");
          throw new Error("保存已返回，但缺少可确认的包 ID、草稿 ID 或更新时间。请刷新列表并重新选择已保存的包，避免重复新建。");
        }
        const savedIdentity = { packageId: savedPackageId, versionId: savedVersionId, expectedUpdatedAt: savedUpdatedAt };
        const savedForm = { ...form, ...savedIdentity };
        setForm((current) => ({ ...current, ...savedIdentity }));
        setEditBase({ payload, form: savedForm, versionId: savedVersionId });
        setSaveIdentityMissing(false);
        await loadPackages({ preserveNotice: true });
      }
      return result;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Skill 包操作失败");
      return null;
    } finally {
      setBusy("");
    }
  }

  async function publishVersion(version: AdminSkillVersionRow, activeVersionId?: string | null) {
    const confirmed = window.confirm(`确认发布 Skill 版本 ${version.semver}？发布后才会进入用户安装/调用链路。`);
    if (!confirmed) return;
    setBusy(`publish:${version.id}`);
    setError("");
    setNotice("");
    try {
      const response = await fetch("/api/admin/skill-packages", {
        method: "POST",
        headers,
        body: JSON.stringify({
          action: "publish",
          versionId: version.id,
          expectedActiveVersionId: activeVersionId || null,
        }),
      });
      const body = await response.json().catch(() => ({})) as PackageResponse;
      if (!response.ok || body.ok === false) throw new Error(describePackageError(body, "Skill 包发布失败"));
      setNotice("Skill 包已发布；前台 Skill 包列表和用户安装链路将读取当前发布版本。");
      await loadPackages();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Skill 包发布失败");
    } finally {
      setBusy("");
    }
  }

  async function rollbackPackage(view: AdminSkillPackageView, version: AdminSkillVersionRow) {
    const confirmed = window.confirm(`确认把「${view.package.display_name}」回滚到 ${version.semver}？这会生成可审计的发布指针，不硬删历史版本。`);
    if (!confirmed) return;
    setBusy(`rollback:${version.id}`);
    setError("");
    setNotice("");
    try {
      const response = await fetch("/api/admin/skill-packages", {
        method: "POST",
        headers,
        body: JSON.stringify({
          action: "rollback",
          packageId: view.package.id,
          targetVersionId: version.id,
          expectedActiveVersionId: view.package.active_version_id || null,
        }),
      });
      const body = await response.json().catch(() => ({})) as PackageResponse;
      if (!response.ok || body.ok === false) throw new Error(describePackageError(body, "Skill 包回滚失败"));
      setNotice("Skill 包已回滚到指定已发布版本。");
      await loadPackages();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Skill 包回滚失败");
    } finally {
      setBusy("");
    }
  }

  async function archivePackage(view: AdminSkillPackageView) {
    if (busy || view.package.lifecycle === "archived") return;
    if (!window.confirm(`确认归档「${view.package.display_name}」？归档后不能安装、编辑、发布或回滚，版本及审计记录会保留。请先卸载所有启用的安装。`)) return;
    setBusy(`archive:${view.package.id}`); setError(""); setNotice("");
    try {
      const response = await fetch("/api/admin/skill-packages", {
        method: "POST", headers,
        body: JSON.stringify({ action: "archive", packageId: view.package.id,
          expectedUpdatedAt: view.package.updated_at, expectedActiveVersionId: view.package.active_version_id }),
      });
      const body = await response.json().catch(() => ({})) as PackageResponse;
      if (!response.ok || body.ok === false) throw new Error(describePackageError(body, "Skill 包归档失败"));
      await loadPackages({ preserveNotice: true });
      setNotice("Skill 包已归档；历史版本与审计记录保留，不能继续安装、发布或回滚。");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "归档结果暂未确认，请刷新查看原包状态");
    } finally { setBusy(""); }
  }

  const canPersist = storeState === "ready";
  const selectedArchived = packages.find((view) => view.package.id === form.packageId)?.package.lifecycle === "archived";
  const normalizedSlug = normalizeSlug(form.slug);
  const normalizedCommand = normalizeCommandName(form.commandName);

  return (
    <section
      id="manju-custom-skill-packages"
      className="space-y-4 rounded-xl border border-[var(--border)] bg-[var(--card)] p-4"
      data-admin-section="manju-custom-skill-packages"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 text-sm font-semibold text-[var(--foreground)]">
            <PackagePlus size={18} className="text-cyan-500" />
            用户自建 / 导入 Skill 包
          </div>
          <p className="mt-1 max-w-4xl text-xs leading-5 text-[var(--muted-foreground)]">
            这里负责“用户可自建、管理员可审核发布”的 Skill 包生命周期；它和上方 36 张平台内置 Skill 卡片分离。内置 Skill 只能删覆盖/恢复默认；用户 Skill 走草稿、发布、安装、回滚，不把未发布内容硬塞进前台。
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" aria-label="新增 Skill" title="新增用户 Skill" className="inline-flex items-center gap-2 rounded-md border border-[var(--border)] px-3 py-2 text-sm" onClick={startNew}>
            <PackagePlus size={15} />新增用户 Skill
          </button>
          <button type="button" className="inline-flex items-center gap-2 rounded-md border border-[var(--border)] px-3 py-2 text-sm" onClick={() => void loadPackages()} disabled={loading}>
            <RefreshCw size={15} className={loading ? "animate-spin" : ""} />刷新
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <article className="rounded-md border border-blue-500/25 bg-blue-500/5 p-3">
          <small className="text-[var(--muted-foreground)]">控制面状态</small>
          <strong className="mt-1 block text-sm text-[var(--foreground)]">
            {storeState === "ready" ? "可持久化" : storeState === "migration_not_ready" ? "等待数据库迁移" : "待读取"}
          </strong>
          <p className="mt-1 text-xs leading-5 text-[var(--muted-foreground)]">保存/发布必须落到 skill_packages、skill_versions 与安装表。</p>
        </article>
        <article className="rounded-md border border-[var(--border)] bg-[var(--background)] p-3">
          <small className="text-[var(--muted-foreground)]">已登记包</small>
          <strong className="mt-1 block text-sm text-[var(--foreground)]">{packages.length}</strong>
          <p className="mt-1 text-xs leading-5 text-[var(--muted-foreground)]">只统计真实数据库返回，不用 localStorage 伪装安装。</p>
        </article>
        <article className="rounded-md border border-emerald-500/25 bg-emerald-500/5 p-3">
          <small className="text-[var(--muted-foreground)]">当前草稿命令</small>
          <strong className="mt-1 block text-sm text-[var(--foreground)]">{normalizedCommand}</strong>
          <p className="mt-1 text-xs leading-5 text-[var(--muted-foreground)]">发布后才允许进入前台用户安装链路。</p>
        </article>
      </div>

      {error ? (
        <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-xs leading-5 text-amber-700" role="alert">
          <AlertTriangle size={16} className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      ) : null}

      {storeState !== "ready" ? (
        <div className="grid grid-cols-1 gap-3 rounded-md border border-cyan-500/25 bg-cyan-500/5 p-3 text-xs leading-5 text-[var(--secondary-foreground)] lg:grid-cols-3">
          <article>
            <strong className="block text-sm text-[var(--foreground)]">现在能做</strong>
            <p className="mt-1">管理员可以填写用户 Skill 草稿、校验结构、复制字段规范，提前完成内容设计。</p>
          </article>
          <article>
            <strong className="block text-sm text-[var(--foreground)]">现在不能假装完成</strong>
            <p className="mt-1">数据库未迁移时不能保存、发布、安装或回滚用户自建 Skill；这些必须落到真实 skill_packages 表。</p>
          </article>
          <article>
            <strong className="block text-sm text-[var(--foreground)]">恢复条件</strong>
            <p className="mt-1">部署 <code>20260827093000_skill_packages_runtime.sql</code> 后，本面板会自动启用保存、发布和回滚按钮。</p>
          </article>
        </div>
      ) : null}

      {notice ? (
        <div className="flex items-start gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/5 p-3 text-xs leading-5 text-emerald-700" role="status">
          <CheckCircle2 size={16} className="mt-0.5 shrink-0" />
          <span>{notice}</span>
        </div>
      ) : null}

      <div className="grid grid-cols-1 gap-4 2xl:grid-cols-[380px_minmax(0,1fr)]">
        <aside className="space-y-3 rounded-md border border-[var(--border)] bg-[var(--background)] p-3">
          <div className="flex items-center justify-between gap-2">
            <strong className="text-sm text-[var(--foreground)]">真实 Skill 包列表</strong>
            {loading ? <LoaderCircle size={16} className="animate-spin text-[var(--muted-foreground)]" /> : null}
          </div>
          <div className="max-h-[520px] space-y-2 overflow-auto pr-1">
            {packages.length === 0 ? (
              <p className="rounded-md border border-dashed border-[var(--border)] p-4 text-xs leading-5 text-[var(--muted-foreground)]">
                暂无可读取 Skill 包。若这里提示迁移未就绪，说明数据库尚未落 `20260827093000_skill_packages_runtime.sql`，不能把“新增 Skill”伪装成已保存。
              </p>
            ) : null}
            {packages.map((view) => (
              <button
                key={view.package.id}
                type="button"
                className="w-full rounded-md border border-[var(--border)] bg-[var(--card)] p-3 text-left hover:border-[var(--primary)]"
                onClick={() => selectPackage(view)}
              >
                <span className="flex items-start justify-between gap-2">
                  <span>
                    <strong className="block text-sm text-[var(--foreground)]">{view.package.display_name}</strong>
                    <code className="mt-1 block text-xs text-blue-600">{view.package.slug}</code>
                  </span>
                  <em className="shrink-0 rounded-full bg-[var(--accent)] px-2 py-0.5 text-[10px] not-italic text-[var(--muted-foreground)]">{view.package.lifecycle}</em>
                </span>
                <small className="mt-2 block text-[var(--muted-foreground)]">{view.package.summary}</small>
              </button>
            ))}
          </div>
        </aside>

        <div className="space-y-4">
          <fieldset disabled={selectedArchived} className="min-w-0 space-y-3 rounded-md border border-[var(--border)] bg-[var(--background)] p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <strong className="text-sm text-[var(--foreground)]">{form.packageId ? "编辑 Skill 包草稿" : "新增 Skill 包草稿"}</strong>
                <p className="mt-1 text-xs text-[var(--muted-foreground)]">slug：{normalizedSlug || "待填写"}；命令：{normalizedCommand}</p>
              </div>
              <div className="flex flex-wrap gap-2">
                <button type="button" className="inline-flex items-center gap-2 rounded-md border border-[var(--border)] px-3 py-2 text-sm disabled:opacity-50" onClick={() => void postAction("validate")} disabled={Boolean(busy)}>
                  <ShieldCheck size={14} />{busy === "validate" ? "校验中…" : "校验结构"}
                </button>
                <button type="button" className="inline-flex items-center gap-2 rounded-md bg-[var(--primary)] px-3 py-2 text-sm font-semibold text-white disabled:opacity-50" onClick={() => void postAction("save-draft", { save: true })} disabled={Boolean(busy) || !canPersist || saveIdentityMissing}>
                  <Save size={14} />{busy === "save-draft" ? "保存中…" : canPersist ? "保存草稿" : "保存草稿（需迁移）"}
                </button>
              </div>
            </div>

            {!canPersist ? (
              <div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-xs leading-5 text-[var(--secondary-foreground)]">
                当前只允许“校验结构”，不允许假保存；管理员仍可编辑预览并提前整理字段。等数据库迁移完成后，同一面板会直接启用保存、发布、回滚。
              </div>
            ) : null}

            <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
              <label className="text-xs text-[var(--muted-foreground)]">
                Skill slug
                <input className="mt-1 w-full rounded-md border border-[var(--border)] bg-[var(--card)] px-3 py-2 text-sm text-[var(--foreground)]" value={form.slug} onChange={(event) => patchForm({ slug: event.target.value })} placeholder="manga-story-helper" />
              </label>
              <label className="text-xs text-[var(--muted-foreground)]">
                命令
                <input className="mt-1 w-full rounded-md border border-[var(--border)] bg-[var(--card)] px-3 py-2 text-sm text-[var(--foreground)]" value={form.commandName} onChange={(event) => patchForm({ commandName: event.target.value })} placeholder="/manga-story-helper" />
              </label>
              <label className="text-xs text-[var(--muted-foreground)]">
                版本
                <input className="mt-1 w-full rounded-md border border-[var(--border)] bg-[var(--card)] px-3 py-2 text-sm text-[var(--foreground)]" value={form.semver} onChange={(event) => patchForm({ semver: event.target.value })} placeholder="1.0.0" />
              </label>
              <label className="text-xs text-[var(--muted-foreground)]">
                名称
                <input className="mt-1 w-full rounded-md border border-[var(--border)] bg-[var(--card)] px-3 py-2 text-sm text-[var(--foreground)]" value={form.displayName} onChange={(event) => patchForm({ displayName: event.target.value })} placeholder="漫剧故事拆解助手" />
              </label>
              <label className="text-xs text-[var(--muted-foreground)]">
                分类
                <input className="mt-1 w-full rounded-md border border-[var(--border)] bg-[var(--card)] px-3 py-2 text-sm text-[var(--foreground)]" value={form.category} onChange={(event) => patchForm({ category: event.target.value })} />
              </label>
              <label className="text-xs text-[var(--muted-foreground)]">
                作者
                <input className="mt-1 w-full rounded-md border border-[var(--border)] bg-[var(--card)] px-3 py-2 text-sm text-[var(--foreground)]" value={form.author} onChange={(event) => patchForm({ author: event.target.value })} />
              </label>
              <label className="text-xs text-[var(--muted-foreground)]">
                来源
                <select className="mt-1 w-full rounded-md border border-[var(--border)] bg-[var(--card)] px-3 py-2 text-sm text-[var(--foreground)]" value={form.origin} onChange={(event) => patchForm({ origin: event.target.value as SkillOrigin })}>
                  <option value="custom">用户自建</option>
                  <option value="community">社区参考</option>
                  <option value="open_source">开源改造</option>
                  <option value="builtin">平台内置</option>
                </select>
              </label>
              <label className="text-xs text-[var(--muted-foreground)]">
                可见范围
                <select className="mt-1 w-full rounded-md border border-[var(--border)] bg-[var(--card)] px-3 py-2 text-sm text-[var(--foreground)]" value={form.visibility} onChange={(event) => patchForm({ visibility: event.target.value as SkillVisibility })}>
                  <option value="private">私有</option>
                  <option value="tenant">站内用户</option>
                  <option value="public">公开</option>
                </select>
              </label>
              <label className="text-xs text-[var(--muted-foreground)]">
                执行类型
                <select className="mt-1 w-full rounded-md border border-[var(--border)] bg-[var(--card)] px-3 py-2 text-sm text-[var(--foreground)]" value={form.executionType} onChange={(event) => patchForm({ executionType: event.target.value as SkillExecutionType, runtimeKind: event.target.value as SkillRuntimeKind })}>
                  <option value="prompt">提示词</option>
                  <option value="tool">工具</option>
                  <option value="workflow">工作流</option>
                  <option value="hybrid">混合</option>
                </select>
              </label>
            </div>

            <label className="block text-xs text-[var(--muted-foreground)]">
              摘要 / 前台说明
              <textarea className="mt-1 w-full rounded-md border border-[var(--border)] bg-[var(--card)] px-3 py-2 text-sm text-[var(--foreground)]" rows={2} value={form.summary} onChange={(event) => patchForm({ summary: event.target.value })} />
            </label>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <label className="block text-xs text-[var(--muted-foreground)]">
                标签
                <textarea className="mt-1 w-full rounded-md border border-[var(--border)] bg-[var(--card)] px-3 py-2 text-sm text-[var(--foreground)]" rows={2} value={form.tagsText} onChange={(event) => patchForm({ tagsText: event.target.value })} />
              </label>
              <label className="block text-xs text-[var(--muted-foreground)]">
                触发词
                <textarea className="mt-1 w-full rounded-md border border-[var(--border)] bg-[var(--card)] px-3 py-2 text-sm text-[var(--foreground)]" rows={2} value={form.triggerText} onChange={(event) => patchForm({ triggerText: event.target.value })} />
              </label>
            </div>
            <label className="block text-xs text-[var(--muted-foreground)]">
              Skill 提示词 / 指令正文
              <textarea className="mt-1 w-full rounded-md border border-[var(--border)] bg-[var(--card)] px-3 py-2 font-mono text-xs leading-5 text-[var(--foreground)]" rows={14} value={form.instructions} onChange={(event) => patchForm({ instructions: event.target.value })} placeholder="写入这个 Skill 的完整执行规则。不要粘贴 API Key、Token、Cookie 或账号密码。" />
            </label>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-[160px_minmax(0,1fr)]">
              <label className="flex items-center gap-2 text-sm text-[var(--foreground)]">
                <input type="checkbox" checked={form.autoInvoke} onChange={(event) => patchForm({ autoInvoke: event.target.checked })} />
                允许自动触发
              </label>
              <label className="text-xs text-[var(--muted-foreground)]">
                metadata JSON
                <textarea className="mt-1 w-full rounded-md border border-[var(--border)] bg-[var(--card)] px-3 py-2 font-mono text-xs leading-5 text-[var(--foreground)]" rows={3} value={form.metadataText} onChange={(event) => patchForm({ metadataText: event.target.value })} />
              </label>
            </div>
          </fieldset>

          {validation ? (
            <section className="rounded-md border border-emerald-500/30 bg-emerald-500/5 p-3">
              <div className="flex items-center gap-2 text-sm font-semibold text-[var(--foreground)]"><FileJson2 size={16} />校验结果</div>
              <pre className="mt-2 max-h-44 overflow-auto whitespace-pre-wrap rounded-md bg-[var(--card)] p-3 text-xs leading-5 text-[var(--secondary-foreground)]">{JSON.stringify(validation, null, 2)}</pre>
            </section>
          ) : null}

          {packages.length ? (
            <section className="rounded-md border border-[var(--border)] bg-[var(--background)] p-4">
              <strong className="text-sm text-[var(--foreground)]">版本发布与回滚</strong>
              <div className="mt-3 space-y-3">
                {packages.map((view) => (
                  <article key={view.package.id} data-skill-package-id={view.package.id} className="rounded-md border border-[var(--border)] bg-[var(--card)] p-3">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div>
                        <strong className="text-sm text-[var(--foreground)]">{view.package.display_name}</strong>
                        <p className="mt-1 text-xs text-[var(--muted-foreground)]">active {shortId(view.package.active_version_id)} · updated {formatTime(view.package.updated_at)}</p>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <button type="button" className="rounded-md border border-[var(--border)] px-3 py-1.5 text-xs" onClick={() => selectPackage(view)}>{view.package.lifecycle === "archived" ? "查看历史" : "编辑新草稿"}</button>
                        {view.package.lifecycle !== "archived" && view.package.visibility === "private" && view.package.origin !== "builtin" && view.package.created_by === actorId && <button type="button" className="inline-flex items-center gap-1 rounded-md border border-[var(--border)] px-3 py-1.5 text-xs disabled:opacity-50" disabled={Boolean(busy) || !canPersist} onClick={() => void archivePackage(view)}><Archive size={13} />归档</button>}
                      </div>
                    </div>
                    <div className="mt-3 grid grid-cols-1 gap-2 xl:grid-cols-2">
                      {view.versions.map((version) => {
                        const active = version.id === view.package.active_version_id;
                        return (
                          <div key={version.id} className="rounded-md border border-[var(--border)] bg-[var(--background)] p-3">
                            <span className="flex flex-wrap items-center justify-between gap-2">
                              <strong className="text-xs text-[var(--foreground)]">{version.semver} · v{version.version_number}</strong>
                              <em className="rounded-full bg-[var(--accent)] px-2 py-0.5 text-[10px] not-italic text-[var(--muted-foreground)]">{active ? "当前活动" : version.status}</em>
                            </span>
                            <p className="mt-1 text-[11px] text-[var(--muted-foreground)]">{shortId(version.id)} · {formatTime(version.published_at || version.updated_at)}</p>
                            <div className="mt-2 flex flex-wrap gap-2">
                              {view.package.lifecycle !== "archived" && version.status === "draft" ? (
                                <button type="button" className="inline-flex items-center gap-1 rounded-md bg-[var(--primary)] px-2 py-1.5 text-xs text-white disabled:opacity-50" onClick={() => void publishVersion(version, view.package.active_version_id)} disabled={Boolean(busy)}>
                                  <Send size={12} />发布
                                </button>
                              ) : null}
                              {view.package.lifecycle !== "archived" && version.status === "released" && !active ? (
                                <button type="button" className="inline-flex items-center gap-1 rounded-md border border-[var(--border)] px-2 py-1.5 text-xs disabled:opacity-50" onClick={() => void rollbackPackage(view, version)} disabled={Boolean(busy)}>
                                  <RotateCcw size={12} />回滚到此版本
                                </button>
                              ) : null}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </article>
                ))}
              </div>
            </section>
          ) : null}
        </div>
      </div>
    </section>
  );
}
