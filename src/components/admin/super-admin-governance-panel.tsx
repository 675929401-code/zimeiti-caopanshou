"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  CheckCircle2,
  ChevronRight,
  Copy,
  KeyRound,
  LockKeyhole,
  Plus,
  RefreshCw,
  Save,
  Search,
  ShieldAlert,
  ShieldCheck,
  UserCog,
  Users,
  X,
} from "lucide-react";
import {
  type AdminAccessClientState,
  type AdminPermissionDefinition,
} from "@/lib/admin-governance";
import {
  ADMIN_CORE_TECH_PERMISSION_KEYS,
  ADMIN_JOB_TEMPLATES,
  ADMIN_OWNER_ONLY_PERMISSION_KEYS,
  ADMIN_PERMISSION_DEPENDENCIES,
  normalizeDelegableAdminPermissionKeys,
  visibleAdminPermissionSurfaces,
} from "@/lib/admin-permission-design";
import { ADMIN_LOGIN_PATH } from "@/lib/admin-entry";
import { useAdminStepUpReady } from "@/components/admin/admin-sensitive-unlock-control";

type AdministratorRow = {
  user_id: string;
  admin_level: "super_admin" | "admin";
  permission_keys: string[];
  revision: number;
  checksum: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
  user: {
    id: string;
    username: string;
    display_name: string;
    phone?: string | null;
    email?: string | null;
    is_active: boolean;
    status?: string | null;
    last_sign_in_at?: string | null;
    created_at?: string | null;
  } | null;
};

type GovernanceAudit = {
  id: string;
  actor_id?: string | null;
  actor_level?: string | null;
  target_user_id?: string | null;
  permission_key?: string | null;
  action: string;
  result: string;
  reason_code?: string | null;
  request_ip?: string | null;
  created_at: string;
};

type RegisteredMemberCandidate = {
  id: string;
  username: string;
  display_name: string;
  phone?: string | null;
  email?: string | null;
  role: string;
  is_active: boolean;
  status: string;
  member_status: string;
  last_sign_in_at?: string | null;
  created_at?: string | null;
  has_password: boolean;
  eligible: boolean;
};

type GovernancePayload = {
  administrators: AdministratorRow[];
  candidates: RegisteredMemberCandidate[];
  audit: GovernanceAudit[];
  health: {
    healthy: boolean;
    active_super_count: number;
    missing_profile_count: number;
    invalid_checksum_count: number;
    noncanonical_profile_count: number;
    orphan_profile_count: number;
    expired_session_count: number;
    catalog_invalid_dependency_count: number;
    catalog_cycle_count: number;
  };
  catalog: AdminPermissionDefinition[];
  catalogCoverage: {
    healthy: boolean;
    codeCount: number;
    databaseCount: number;
    missingCount: number;
    inactiveCount: number;
    unknownCount: number;
    contractMismatchCount: number;
    codeContractMismatchCount: number;
    fieldMismatchCounts: Record<string, number>;
  };
};

const ACTION_LABELS: Record<string, string> = {
  super_admin_bootstrap: "建立超级管理员",
  admin_account_create: "新增管理员",
  admin_account_promote: "授权已注册会员为管理员",
  admin_account_update: "修改管理员资料",
  admin_permissions_update: "调整管理员权限",
  admin_permission_policy_v2_migration: "升级权限策略",
  admin_step_up_unlock: "敏感操作解锁",
  admin_step_up_lock: "主动锁定",
  management_password_generate: "生成管理密码",
  management_password_set: "设置管理密码",
  management_password_change: "修改管理密码",
  management_password_remove: "移除管理密码",
};

function formatDate(value?: string | null) {
  if (!value) return "暂无";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "暂无";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(date).replaceAll("/", "-");
}

function permissionGroups(catalog: readonly AdminPermissionDefinition[]) {
  const groups = new Map<string, AdminPermissionDefinition[]>();
  for (const permission of catalog) {
    const current = groups.get(permission.group) || [];
    current.push(permission);
    groups.set(permission.group, current);
  }
  return Array.from(groups.entries());
}

function permissionDependencyKeys(permissionKeys: readonly string[]) {
  const selected = new Set(normalizeDelegableAdminPermissionKeys(permissionKeys));
  const dependencies = new Set<string>();
  const visit = (permissionKey: string, trail: Set<string>) => {
    if (trail.has(permissionKey)) return;
    const nextTrail = new Set(trail).add(permissionKey);
    for (const dependency of ADMIN_PERMISSION_DEPENDENCIES[permissionKey] || []) {
      if (!selected.has(dependency)) continue;
      dependencies.add(dependency);
      visit(dependency, nextTrail);
    }
  };
  for (const permissionKey of selected) visit(permissionKey, new Set());
  return dependencies;
}

function permissionDependents(permissionKeys: readonly string[], dependencyKey: string) {
  const selected = new Set(normalizeDelegableAdminPermissionKeys(permissionKeys));
  return [...selected].filter((permissionKey) => {
    const pending = [...(ADMIN_PERMISSION_DEPENDENCIES[permissionKey] || [])];
    const visited = new Set<string>();
    while (pending.length > 0) {
      const candidate = pending.shift();
      if (!candidate || visited.has(candidate)) continue;
      if (candidate === dependencyKey) return true;
      visited.add(candidate);
      pending.push(...(ADMIN_PERMISSION_DEPENDENCIES[candidate] || []));
    }
    return false;
  });
}

function samePermissionKeys(left: readonly string[], right: readonly string[]) {
  const normalizedLeft = normalizeDelegableAdminPermissionKeys(left);
  const normalizedRight = normalizeDelegableAdminPermissionKeys(right);
  return normalizedLeft.length === normalizedRight.length
    && normalizedLeft.every((permissionKey, index) => permissionKey === normalizedRight[index]);
}

export function filterAdminPermissionCatalog(
  catalog: readonly AdminPermissionDefinition[],
  search: string,
  groupFilter: string,
) {
  const query = search.trim().toLowerCase();
  return catalog.filter((permission) => {
    if (groupFilter && permission.group !== groupFilter) return false;
    if (!query) return true;
    return [permission.label, permission.description, permission.group, permission.key]
      .some((value) => value.toLowerCase().includes(query));
  });
}

function PermissionCatalogMatrix({
  catalog,
  selectedKeys,
  search,
  groupFilter,
  onSearchChange,
  onGroupFilterChange,
  onToggle,
  columns,
  testIdPrefix,
}: {
  catalog: readonly AdminPermissionDefinition[];
  selectedKeys: readonly string[];
  search: string;
  groupFilter: string;
  onSearchChange: (value: string) => void;
  onGroupFilterChange: (value: string) => void;
  onToggle: (permissionKey: string) => void;
  columns: 2 | 3;
  testIdPrefix: string;
}) {
  const groupOptions = permissionGroups(catalog).map(([group]) => group);
  const visibleCatalog = filterAdminPermissionCatalog(catalog, search, groupFilter);
  const selected = new Set(normalizeDelegableAdminPermissionKeys(selectedKeys));
  const dependencies = permissionDependencyKeys(selectedKeys);

  return (
    <div data-testid={`${testIdPrefix}-catalog`}>
      <div className="mb-4 grid grid-cols-[minmax(0,1fr)_220px_auto] items-center gap-3">
        <label className="relative block">
          <span className="sr-only">搜索权限</span>
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#98a2b3]" />
          <input
            value={search}
            onChange={(event) => onSearchChange(event.target.value)}
            placeholder="搜索权限名称、说明或内部键"
            className="h-10 w-full rounded-xl border border-[#d0d5dd] bg-white pl-10 pr-3 text-sm outline-none focus:border-[#079455]"
            data-testid={`${testIdPrefix}-search`}
          />
        </label>
        <label>
          <span className="sr-only">按权限分组筛选</span>
          <select
            value={groupFilter}
            onChange={(event) => onGroupFilterChange(event.target.value)}
            className="h-10 w-full rounded-xl border border-[#d0d5dd] bg-white px-3 text-sm text-[#344054] outline-none focus:border-[#079455]"
            data-testid={`${testIdPrefix}-group-filter`}
          >
            <option value="">全部分组</option>
            {groupOptions.map((group) => <option key={group} value={group}>{group}</option>)}
          </select>
        </label>
        <p className="whitespace-nowrap text-xs font-bold text-[#667085]">显示 {visibleCatalog.length} / {catalog.length}</p>
      </div>

      {visibleCatalog.length === 0 ? (
        <div className="rounded-xl border border-dashed border-[#d0d5dd] bg-[#f9fafb] p-6 text-center text-sm text-[#667085]">没有匹配的权限</div>
      ) : (
        <div className="space-y-4">
          {permissionGroups(visibleCatalog).map(([group, permissions]) => (
            <div key={group}>
              <p className="mb-2 text-xs font-black text-[#475467]">{group} · {permissions.length}</p>
              <div className={`grid gap-2 ${columns === 3 ? "grid-cols-3" : "grid-cols-2"}`}>
                {permissions.map((permission) => {
                  const ownerOnly = ADMIN_OWNER_ONLY_PERMISSION_KEYS.includes(
                    permission.key as (typeof ADMIN_OWNER_ONLY_PERMISSION_KEYS)[number],
                  );
                  const checked = selected.has(permission.key);
                  const dependency = dependencies.has(permission.key);
                  return (
                    <button
                      key={permission.key}
                      type="button"
                      disabled={ownerOnly}
                      aria-pressed={ownerOnly ? undefined : checked}
                      onClick={() => onToggle(permission.key)}
                      className={`rounded-xl border p-3 text-left transition ${ownerOnly ? "cursor-not-allowed border-[#d0d5dd] bg-[#f2f4f7]" : checked ? "border-[#079455] bg-[#ecfdf3]" : "border-[#d0d5dd] bg-white hover:border-[#98a2b3]"}`}
                      data-permission-key={permission.key}
                    >
                      <span className="flex items-start justify-between gap-2">
                        <span className="text-sm font-black">{permission.label}</span>
                        <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold ${ownerOnly ? "bg-[#101828] text-white" : permission.risk === "critical" ? "bg-rose-50 text-rose-700" : permission.risk === "sensitive" ? "bg-amber-50 text-amber-700" : "bg-[#f2f4f7] text-[#667085]"}`}>
                          {ownerOnly ? "所有者专属" : dependency ? "依赖保留" : permission.stepUpRequired ? "需密码" : "直接访问"}
                        </span>
                      </span>
                      <span className="mt-1 block text-xs leading-5 text-[#667085]">{permission.description}</span>
                      <span className="mt-2 block break-all font-mono text-[10px] text-[#98a2b3]">{permission.key}</span>
                      {ownerOnly && <span className="mt-2 block text-[11px] font-bold text-[#475467]">已加载用于目录核验，不可委派给普通管理员</span>}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function SuperAdminGovernancePanel({
  token,
  state,
  onRequestUnlock,
  onAccessChanged,
}: {
  token: string;
  state: AdminAccessClientState;
  onRequestUnlock: () => void;
  onAccessChanged: () => Promise<void> | void;
}) {
  const [payload, setPayload] = useState<GovernancePayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [selectedId, setSelectedId] = useState("");
  const [permissionDraft, setPermissionDraft] = useState<string[]>([]);
  const [permissionSearch, setPermissionSearch] = useState("");
  const [permissionGroupFilter, setPermissionGroupFilter] = useState("");
  const [coreGrantConfirmation, setCoreGrantConfirmation] = useState("");
  const [activeDraft, setActiveDraft] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [createMode, setCreateMode] = useState<"promote" | "create">("promote");
  const [candidateSearch, setCandidateSearch] = useState("");
  const [selectedCandidateId, setSelectedCandidateId] = useState("");
  const [createPermissionSearch, setCreatePermissionSearch] = useState("");
  const [createPermissionGroupFilter, setCreatePermissionGroupFilter] = useState("");
  const [createCoreGrantConfirmation, setCreateCoreGrantConfirmation] = useState("");
  const [showAccountEditor, setShowAccountEditor] = useState(false);
  const [saving, setSaving] = useState(false);
  const [createForm, setCreateForm] = useState({ username: "", displayName: "", phone: "", email: "", password: "", permissionKeys: [] as string[] });
  const [accountForm, setAccountForm] = useState({ displayName: "", phone: "", email: "", newPassword: "" });
  const [managementForm, setManagementForm] = useState({ action: (state.managementPasswordSet ? "change" : "set") as "generate" | "set" | "change" | "remove", currentPassword: "", newPassword: "" });
  const [maintenanceReason, setMaintenanceReason] = useState("");
  const [maintenanceDuration, setMaintenanceDuration] = useState(30);
  const [generatedPassword, setGeneratedPassword] = useState("");
  const isSuper = state.access.adminLevel === "super_admin";
  const unlocked = useAdminStepUpReady(state.stepUp.status, state.stepUp.expiresAt);
  const unlockedRef = useRef(unlocked);
  const loadSequenceRef = useRef(0);
  const loadAbortRef = useRef<AbortController | null>(null);
  const managementPasswordSequenceRef = useRef(0);
  const managementPasswordAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    unlockedRef.current = isSuper && unlocked;
  }, [isSuper, unlocked]);

  const load = useCallback(async () => {
    if (!isSuper || !unlocked) return false;
    const requestSequence = ++loadSequenceRef.current;
    loadAbortRef.current?.abort();
    const controller = new AbortController();
    loadAbortRef.current = controller;
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/admin/access-control", {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
        signal: controller.signal,
      });
      const data = await response.json().catch(() => ({}));
      if (controller.signal.aborted || requestSequence !== loadSequenceRef.current || !unlockedRef.current) return false;
      if (!response.ok) throw new Error(data.error || "超级管理员数据读取失败");
      setPayload(data);
      setSelectedId((current) => current || data.administrators?.[0]?.user_id || "");
      return true;
    } catch (loadError) {
      if (loadError instanceof DOMException && loadError.name === "AbortError") return false;
      setError(loadError instanceof Error ? loadError.message : "超级管理员数据读取失败");
      return false;
    } finally {
      if (requestSequence === loadSequenceRef.current) {
        loadAbortRef.current = null;
        setLoading(false);
      }
    }
  }, [isSuper, token, unlocked]);

  useEffect(() => {
    if (isSuper && unlocked) return;
    loadSequenceRef.current += 1;
    loadAbortRef.current?.abort();
    loadAbortRef.current = null;
    managementPasswordSequenceRef.current += 1;
    managementPasswordAbortRef.current?.abort();
    managementPasswordAbortRef.current = null;
    setPayload(null);
    setSelectedId("");
    setPermissionDraft([]);
    setPermissionSearch("");
    setPermissionGroupFilter("");
    setCoreGrantConfirmation("");
    setSelectedCandidateId("");
    setCandidateSearch("");
    setCreatePermissionSearch("");
    setCreatePermissionGroupFilter("");
    setCreateCoreGrantConfirmation("");
    setShowCreate(false);
    setShowAccountEditor(false);
    setCreateForm({ username: "", displayName: "", phone: "", email: "", password: "", permissionKeys: [] });
    setAccountForm({ displayName: "", phone: "", email: "", newPassword: "" });
    setManagementForm((current) => ({ ...current, currentPassword: "", newPassword: "" }));
    setMaintenanceReason("");
    setGeneratedPassword("");
    setNotice("");
    setError("");
    setLoading(false);
    setSaving(false);
  }, [isSuper, unlocked]);

  useEffect(() => () => {
    loadAbortRef.current?.abort();
    managementPasswordAbortRef.current?.abort();
  }, []);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    setManagementForm((current) => {
      if (state.managementPasswordSet && current.action === "set") return { ...current, action: "change" };
      if (!state.managementPasswordSet && (current.action === "change" || current.action === "remove")) return { ...current, action: "set" };
      return current;
    });
  }, [state.managementPasswordSet]);

  const selected = payload?.administrators.find((administrator) => administrator.user_id === selectedId) || null;
  useEffect(() => {
    if (!selected) return;
    setPermissionDraft(normalizeDelegableAdminPermissionKeys(selected.permission_keys));
    setCoreGrantConfirmation("");
    setActiveDraft(selected.is_active);
    setAccountForm({
      displayName: selected.user?.display_name || "",
      phone: selected.user?.phone || "",
      email: selected.user?.email || "",
      newPassword: "",
    });
    setShowAccountEditor(false);
  }, [selected]);

  const catalog = useMemo(
    () => isSuper && payload?.catalog ? payload.catalog : [],
    [isSuper, payload],
  );
  const delegableCatalog = useMemo(
    () => catalog.filter((permission) =>
      !ADMIN_OWNER_ONLY_PERMISSION_KEYS.includes(
        permission.key as (typeof ADMIN_OWNER_ONLY_PERMISSION_KEYS)[number],
      ),
    ),
    [catalog],
  );
  const ownerOnlyCatalog = useMemo(
    () => catalog.filter((permission) =>
      ADMIN_OWNER_ONLY_PERMISSION_KEYS.includes(
        permission.key as (typeof ADMIN_OWNER_ONLY_PERMISSION_KEYS)[number],
      ),
    ),
    [catalog],
  );
  const catalogReady = Boolean(
    payload?.catalogCoverage.healthy
    && payload.catalogCoverage.codeCount === 31
    && payload.catalogCoverage.databaseCount === 31
    && catalog.length === 31,
  );
  const administratorNames = useMemo(() => new Map((payload?.administrators || []).map((row) => [row.user_id, row.user?.display_name || row.user?.username || row.user_id])), [payload]);
  const filteredCandidates = useMemo(() => {
    const query = candidateSearch.trim().toLowerCase();
    const candidates = payload?.candidates || [];
    if (!query) return candidates;
    return candidates.filter((candidate) => [candidate.display_name, candidate.username, candidate.phone, candidate.email]
      .some((value) => String(value || "").toLowerCase().includes(query)));
  }, [candidateSearch, payload?.candidates]);
  const selectedCandidate = useMemo(
    () => (payload?.candidates || []).find((candidate) => candidate.id === selectedCandidateId) || null,
    [payload?.candidates, selectedCandidateId],
  );
  const draftVisibleSurfaces = useMemo(
    () => visibleAdminPermissionSurfaces(permissionDraft),
    [permissionDraft],
  );
  const draftCoreTechnologyPermissions = useMemo(
    () => delegableCatalog.filter((permission) =>
      ADMIN_CORE_TECH_PERMISSION_KEYS.includes(
        permission.key as (typeof ADMIN_CORE_TECH_PERMISSION_KEYS)[number],
      ) && permissionDraft.includes(permission.key),
    ),
    [delegableCatalog, permissionDraft],
  );
  const draftDependencyPermissions = useMemo(() => {
    const dependencyKeys = permissionDependencyKeys(permissionDraft);
    return delegableCatalog.filter((permission) => dependencyKeys.has(permission.key));
  }, [delegableCatalog, permissionDraft]);
  const draftCoreFingerprint = useMemo(
    () => draftCoreTechnologyPermissions.map((permission) => permission.key).join("|"),
    [draftCoreTechnologyPermissions],
  );
  const draftCoreConfirmed = draftCoreTechnologyPermissions.length === 0
    || coreGrantConfirmation === draftCoreFingerprint;
  const activeDraftTemplate = useMemo(
    () => ADMIN_JOB_TEMPLATES.find((template) => samePermissionKeys(template.permissionKeys, permissionDraft))?.id || "",
    [permissionDraft],
  );
  const createVisibleSurfaces = useMemo(
    () => visibleAdminPermissionSurfaces(createForm.permissionKeys),
    [createForm.permissionKeys],
  );
  const createCoreTechnologyPermissions = useMemo(
    () => delegableCatalog.filter((permission) =>
      ADMIN_CORE_TECH_PERMISSION_KEYS.includes(
        permission.key as (typeof ADMIN_CORE_TECH_PERMISSION_KEYS)[number],
      ) && createForm.permissionKeys.includes(permission.key),
    ),
    [createForm.permissionKeys, delegableCatalog],
  );
  const createDependencyPermissions = useMemo(() => {
    const dependencyKeys = permissionDependencyKeys(createForm.permissionKeys);
    return delegableCatalog.filter((permission) => dependencyKeys.has(permission.key));
  }, [createForm.permissionKeys, delegableCatalog]);
  const createCoreFingerprint = useMemo(
    () => createCoreTechnologyPermissions.map((permission) => permission.key).join("|"),
    [createCoreTechnologyPermissions],
  );
  const createCoreConfirmed = createCoreTechnologyPermissions.length === 0
    || createCoreGrantConfirmation === createCoreFingerprint;
  const activeCreateTemplate = useMemo(
    () => ADMIN_JOB_TEMPLATES.find((template) => samePermissionKeys(template.permissionKeys, createForm.permissionKeys))?.id || "",
    [createForm.permissionKeys],
  );
  const permissionDirty = Boolean(selected && selected.admin_level !== "super_admin" && (
    !samePermissionKeys(permissionDraft, normalizeDelegableAdminPermissionKeys(selected.permission_keys))
    || activeDraft !== selected.is_active
  ));
  const accountDirty = Boolean(selected && (
    accountForm.displayName !== (selected.user?.display_name || "")
    || accountForm.newPassword.length > 0
  ));
  const governanceDirty = permissionDirty || accountDirty;

  const discardGovernanceDraft = () => {
    if (!selected) return;
    setPermissionDraft(normalizeDelegableAdminPermissionKeys(selected.permission_keys));
    setActiveDraft(selected.is_active);
    setCoreGrantConfirmation("");
    setAccountForm({
      displayName: selected.user?.display_name || "",
      phone: selected.user?.phone || "",
      email: selected.user?.email || "",
      newPassword: "",
    });
    setError("");
    setNotice("已撤销当前未保存修改，恢复到最近一次数据库读回状态。");
  };

  useEffect(() => {
    if (!governanceDirty) return;
    const warnBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warnBeforeUnload);
    return () => window.removeEventListener("beforeunload", warnBeforeUnload);
  }, [governanceDirty]);

  const togglePermission = (key: string, target: "edit" | "create") => {
    const toggle = (current: string[]) => {
      if (ADMIN_OWNER_ONLY_PERMISSION_KEYS.includes(
        key as (typeof ADMIN_OWNER_ONLY_PERMISSION_KEYS)[number],
      )) return current;
      if (!current.includes(key)) {
        const next = normalizeDelegableAdminPermissionKeys([...current, key]);
        const automaticallyAdded = next.filter((permissionKey) =>
          permissionKey !== key && !current.includes(permissionKey),
        );
        setError("");
        setNotice(automaticallyAdded.length > 0
          ? `已自动补齐依赖：${automaticallyAdded.map((permissionKey) => catalog.find((permission) => permission.key === permissionKey)?.label || permissionKey).join("、")}`
          : "权限草稿已更新，保存前请核对生效入口。"
        );
        return next;
      }
      const dependents = permissionDependents(current, key);
      if (dependents.length > 0) {
        const labels = dependents.map((permissionKey) =>
          catalog.find((permission) => permission.key === permissionKey)?.label || permissionKey,
        );
        const dependencyLabel = catalog.find((permission) => permission.key === key)?.label || key;
        setError(`“${dependencyLabel}”正被这些权限依赖，请先取消：${labels.join("、")}`);
        return current;
      }
      setError("");
      setNotice("权限草稿已更新，保存前请核对生效入口。");
      return normalizeDelegableAdminPermissionKeys(current.filter((item) => item !== key));
    };
    if (target === "edit") setPermissionDraft(toggle);
    else setCreateForm((current) => ({ ...current, permissionKeys: toggle(current.permissionKeys) }));
  };

  const applyJobTemplate = (templateId: string, target: "edit" | "create") => {
    const template = ADMIN_JOB_TEMPLATES.find((item) => item.id === templateId);
    if (!template) return;
    const permissionKeys = normalizeDelegableAdminPermissionKeys(template.permissionKeys);
    if (target === "edit") setPermissionDraft(permissionKeys);
    else setCreateForm((current) => ({ ...current, permissionKeys }));
    setError("");
    setNotice(`已载入“${template.label}”岗位草稿（${permissionKeys.length} 项，依赖已自动补齐），请核对生效入口后再保存。`);
  };

  const savePermissions = async () => {
    if (!selected || selected.admin_level === "super_admin" || saving) return;
    if (!catalogReady) {
      setError("31 项权限目录尚未完整加载，当前禁止保存授权。");
      return;
    }
    if (!draftCoreConfirmed) {
      setError("请先确认本次核心技术权限授权风险。");
      return;
    }
    setSaving(true);
    setError("");
    try {
      const response = await fetch("/api/admin/access-control", {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({ action: "permissions", userId: selected.user_id, permissionKeys: normalizeDelegableAdminPermissionKeys(permissionDraft), isActive: activeDraft, expectedRevision: selected.revision, reason: "超级管理员在权限矩阵中保存" }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "权限保存失败");
      const reloaded = await load();
      if (reloaded) setNotice("管理员权限已保存并完成数据库权威读回；旧敏感会话已撤销，新功能不会自动加入其权限。");
      else setError("保存已返回成功，但数据库权威读回失败；请勿重复保存，先重新刷新核对。");
    } catch (saveError) { setError(saveError instanceof Error ? saveError.message : "权限保存失败"); }
    finally { setSaving(false); }
  };

  const createAdministrator = async () => {
    if (saving) return;
    if (!catalogReady) {
      setError("31 项权限目录尚未完整加载，当前禁止新增管理员。");
      return;
    }
    if (!createCoreConfirmed) {
      setError("请先确认本次核心技术权限授权风险。");
      return;
    }
    if (createMode === "promote" && !selectedCandidateId) {
      setError("请先选择一位已注册会员");
      return;
    }
    setSaving(true);
    setError("");
    try {
      const response = await fetch("/api/admin/access-control", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify(createMode === "promote"
          ? { mode: "promote", existingUserId: selectedCandidateId, permissionKeys: normalizeDelegableAdminPermissionKeys(createForm.permissionKeys) }
          : { ...createForm, mode: "create", permissionKeys: normalizeDelegableAdminPermissionKeys(createForm.permissionKeys) }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "管理员创建失败");
      setShowCreate(false);
      setCreateForm({ username: "", displayName: "", phone: "", email: "", password: "", permissionKeys: [] });
      setCreateCoreGrantConfirmation("");
      setCandidateSearch("");
      setSelectedCandidateId("");
      const reloaded = await load();
      if (reloaded) setNotice(createMode === "promote"
        ? "已注册会员已授权为管理员并完成数据库权威读回；原登录会话已撤销，请从后台专用入口重新登录。"
        : "管理员已创建并完成数据库权威读回；账号默认只拥有你勾选的后台权限。");
      else setError("创建已返回成功，但数据库权威读回失败；请勿重复提交，先重新刷新核对。");
    } catch (createError) { setError(createError instanceof Error ? createError.message : "管理员创建失败"); }
    finally { setSaving(false); }
  };

  const copyAdminLoginAddress = async () => {
    const address = `${window.location.origin}${ADMIN_LOGIN_PATH}`;
    try {
      await navigator.clipboard.writeText(address);
      setNotice("后台专用登录地址已复制。已授权管理员可使用本人账号登录。");
    } catch {
      setNotice(`后台专用登录地址：${address}`);
    }
  };

  const saveAccount = async () => {
    if (!selected || saving) return;
    setSaving(true);
    setError("");
    try {
      const response = await fetch("/api/admin/access-control", {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({ action: "account", userId: selected.user_id, ...accountForm, newPassword: accountForm.newPassword || undefined }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "管理员资料保存失败");
      setShowAccountEditor(false);
      if (data.reauthRequired) window.setTimeout(() => window.location.assign(ADMIN_LOGIN_PATH), 1200);
      else {
        const reloaded = await load();
        if (reloaded) setNotice("管理员资料已保存并完成数据库权威读回；如修改密码，旧登录会话已全部撤销。");
        else setError("保存已返回成功，但数据库权威读回失败；请勿重复保存，先重新刷新核对。");
      }
      if (data.reauthRequired) setNotice("超级管理员资料已更新；密码已修改，请重新登录。");
    } catch (saveError) { setError(saveError instanceof Error ? saveError.message : "管理员资料保存失败"); }
    finally { setSaving(false); }
  };

  const updateManagementPassword = async () => {
    if (saving) return;
    const requestSequence = ++managementPasswordSequenceRef.current;
    managementPasswordAbortRef.current?.abort();
    const controller = new AbortController();
    managementPasswordAbortRef.current = controller;
    setSaving(true);
    setError("");
    setGeneratedPassword("");
    try {
      const response = await fetch("/api/settings/operation-password", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ action: managementForm.action, oldPassword: managementForm.currentPassword, newPassword: managementForm.newPassword }),
        signal: controller.signal,
      });
      const data = await response.json().catch(() => ({}));
      if (controller.signal.aborted || requestSequence !== managementPasswordSequenceRef.current || !unlockedRef.current) return;
      if (!response.ok) throw new Error(data.error || "管理密码操作失败");
      if (data.password) setGeneratedPassword(data.password);
      setManagementForm((current) => ({ ...current, currentPassword: "", newPassword: "" }));
      setNotice(data.password ? "随机管理密码已生成，只显示这一次，请安全保存。" : "平台管理密码设置已更新。");
      await onAccessChanged();
    } catch (updateError) {
      if (!(updateError instanceof DOMException && updateError.name === "AbortError")) {
        setError(updateError instanceof Error ? updateError.message : "管理密码操作失败");
      }
    } finally {
      if (requestSequence === managementPasswordSequenceRef.current) {
        managementPasswordAbortRef.current = null;
        setSaving(false);
      }
    }
  };

  const updateMaintenanceLock = async (enabled: boolean) => {
    if (saving) return;
    const reason = maintenanceReason.trim() || (enabled ? "超级管理员执行本地限时维护" : "超级管理员立即恢复所有二次验证锁");
    if (reason.length < 3) {
      setError("请填写至少 3 个字的维护原因。");
      return;
    }
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch("/api/admin/access-control/maintenance-lock", {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
          "Idempotency-Key": crypto.randomUUID(),
        },
        body: JSON.stringify({
          enabled,
          reason,
          durationMinutes: maintenanceDuration,
          expectedRevision: state.maintenanceLock.revision,
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "维护模式状态更新失败");
      setMaintenanceReason("");
      setNotice(enabled
        ? `已暂停二次验证锁 ${maintenanceDuration} 分钟；岗位权限、账务门禁与审计继续生效。`
        : "已立即恢复所有二次验证锁；旧解锁会话已撤销。"
      );
      await onAccessChanged();
    } catch (maintenanceError) {
      setError(maintenanceError instanceof Error ? maintenanceError.message : "维护模式状态更新失败");
    } finally {
      setSaving(false);
    }
  };

  if (!isSuper) {
    return (
      <div data-testid="super-admin-locked" className="grid min-h-[560px] place-items-center rounded-3xl border border-[#d0d5dd] bg-white p-8 shadow-sm">
        <div className="max-w-xl text-center"><div className="mx-auto grid h-16 w-16 place-items-center rounded-2xl bg-amber-50 text-amber-700"><LockKeyhole className="h-8 w-8" /></div><h1 className="mt-5 text-2xl font-black text-[#101828]">此区域仅平台所有者可进入</h1><p className="mt-3 text-sm leading-7 text-[#667085]">你的账号没有访问此区域的资格，受保护的数据不会加载或显示。本次拒绝访问会按后台安全规则记录。</p><div className="mt-5 rounded-xl border border-[#eaecf0] bg-[#f9fafb] p-4 text-left text-sm text-[#475467]">如需调整工作范围，请联系平台所有者。页面入口和前端状态都不会替代服务端授权校验。</div></div>
      </div>
    );
  }

  if (!unlocked) {
    return (
      <div data-testid="super-admin-step-up-required" className="grid min-h-[560px] place-items-center rounded-3xl border border-[#d0d5dd] bg-white p-8 shadow-sm">
        <div className="max-w-xl text-center"><div className="mx-auto grid h-16 w-16 place-items-center rounded-2xl bg-emerald-50 text-emerald-700"><ShieldCheck className="h-8 w-8" /></div><h1 className="mt-5 text-2xl font-black text-[#101828]">超级管理员身份已确认</h1><p className="mt-3 text-sm leading-7 text-[#667085]">管理员账号、权限矩阵、操作审计和管理密码属于最高敏感区。请用你的登录密码或平台管理密码二次确认，可选择 10 或 20 分钟，到期自动上锁。</p><button type="button" onClick={onRequestUnlock} className="mt-6 inline-flex h-11 items-center gap-2 rounded-xl bg-[#079455] px-5 text-sm font-bold text-white"><KeyRound className="h-4 w-4" />验证密码并进入</button></div>
      </div>
    );
  }

  return (
    <section data-testid="super-admin-governance" className="space-y-5 text-[#101828]">
      <div className="flex flex-wrap items-start justify-between gap-4"><div><p className="text-xs font-bold text-[#067647]">SUPER ADMIN CONTROL PLANE</p><h1 className="mt-1 text-2xl font-black">超级管理与内部人员授权</h1><p className="mt-2 text-sm text-[#667085]">一人一账号、一项一授权、敏感操作二次确认；所有成功、失败和拒绝均可追溯。</p>{governanceDirty && <span data-testid="admin-governance-dirty" className="mt-2 inline-flex rounded-full bg-amber-100 px-2.5 py-1 text-[11px] font-black text-amber-800">有未保存修改</span>}</div><div className="flex gap-2">{governanceDirty && <button type="button" onClick={discardGovernanceDraft} className="h-10 rounded-xl border border-amber-300 bg-amber-50 px-3 text-sm font-bold text-amber-800">撤销修改</button>}<button type="button" data-testid="admin-governance-refresh" title={governanceDirty ? "请先保存或撤销当前修改" : "重新读取数据库权威状态"} onClick={() => void load()} disabled={loading || governanceDirty} className="inline-flex h-10 items-center gap-2 rounded-xl border border-[#d0d5dd] px-4 text-sm font-bold text-[#475467] disabled:cursor-not-allowed disabled:opacity-50"><RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />刷新回读</button><button type="button" onClick={() => { setCreateCoreGrantConfirmation(""); setShowCreate(true); }} disabled={!catalogReady || governanceDirty} className="inline-flex h-10 items-center gap-2 rounded-xl bg-[#079455] px-4 text-sm font-bold text-white disabled:cursor-not-allowed disabled:opacity-50"><Plus className="h-4 w-4" />添加管理员</button></div></div>

      {error && <div role="alert" className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm font-bold text-rose-700">{error}</div>}
      {notice && <div role="status" className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm font-bold text-emerald-700">{notice}</div>}

      <div className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-[#b2ddff] bg-[#eff8ff] p-4" data-testid="admin-login-entry-card">
        <div>
          <p className="text-sm font-black text-[#175cd3]">后台专用登录入口</p>
          <p className="mt-1 font-mono text-sm font-bold text-[#101828]">{ADMIN_LOGIN_PATH}</p>
          <p className="mt-1 text-xs leading-5 text-[#475467]">已授权管理员可直接打开此地址，使用本人管理账号登录后台。</p>
        </div>
        <button type="button" onClick={() => void copyAdminLoginAddress()} className="inline-flex h-10 items-center gap-2 rounded-xl border border-[#84caff] bg-white px-4 text-sm font-bold text-[#175cd3]">
          <Copy className="h-4 w-4" />复制后台地址
        </button>
      </div>

      <div className="grid grid-cols-4 gap-3">
        <div className="rounded-2xl border border-[#d0d5dd] bg-white p-4"><Users className="h-5 w-5 text-[#175cd3]" /><p className="mt-4 text-2xl font-black">{payload ? payload.administrators.length : "—"}</p><p className="mt-1 text-xs text-[#667085]">后台管理员</p></div>
        <div className="rounded-2xl border border-[#d0d5dd] bg-white p-4"><ShieldCheck className="h-5 w-5 text-[#067647]" /><p className="mt-4 text-2xl font-black">{payload?.health?.active_super_count ?? "—"}</p><p className="mt-1 text-xs text-[#667085]">有效超级管理员</p></div>
        <div className="rounded-2xl border border-[#d0d5dd] bg-white p-4"><Activity className="h-5 w-5 text-[#7f56d9]" /><p className="mt-4 text-2xl font-black">{payload ? payload.audit.length : "—"}</p><p className="mt-1 text-xs text-[#667085]">最近审计事件</p></div>
        <div
          data-testid="admin-governance-health"
          data-health={payload ? String(payload.health.healthy && payload.catalogCoverage.healthy) : "loading"}
          className={`rounded-2xl border p-4 ${!payload ? "border-[#d0d5dd] bg-[#f9fafb]" : payload.health.healthy && payload.catalogCoverage.healthy ? "border-emerald-200 bg-emerald-50" : "border-rose-200 bg-rose-50"}`}
        ><ShieldAlert className={`h-5 w-5 ${!payload ? "text-[#667085]" : payload.health.healthy && payload.catalogCoverage.healthy ? "text-emerald-700" : "text-rose-700"}`} /><p className="mt-4 text-lg font-black">{!payload ? "正在核验" : payload.health.healthy && payload.catalogCoverage.healthy ? "权限链正常" : "需要立即处理"}</p><p className="mt-1 text-xs text-[#667085]">{payload ? `目录 ${payload.catalogCoverage.databaseCount}/${payload.catalogCoverage.codeCount} · 档案/校验和/API 门禁` : "核对代码、数据库目录与授权档案"}</p></div>
      </div>

      <div
        data-testid="admin-permission-catalog-summary"
        data-catalog-ready={String(catalogReady)}
        className={`grid grid-cols-4 gap-3 rounded-2xl border p-4 ${catalogReady ? "border-emerald-200 bg-emerald-50" : "border-rose-200 bg-rose-50"}`}
      >
        <div><p className="text-xs font-bold text-[#667085]">完整权限目录</p><p className="mt-1 text-lg font-black">{catalog.length} / 31</p></div>
        <div><p className="text-xs font-bold text-[#667085]">可委派权限</p><p className="mt-1 text-lg font-black">{delegableCatalog.length}</p></div>
        <div><p className="text-xs font-bold text-[#667085]">所有者专属</p><p className="mt-1 text-lg font-black">{ownerOnlyCatalog.length}</p></div>
        <div><p className="text-xs font-bold text-[#667085]">分组 / 岗位模板</p><p className="mt-1 text-lg font-black">{permissionGroups(catalog).length} / {ADMIN_JOB_TEMPLATES.length}</p></div>
      </div>

      {payload && !payload.catalogCoverage.healthy && (
        <div role="alert" data-testid="admin-permission-catalog-drift" className="rounded-2xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">
          <p className="font-black">权限目录未完整加载，已禁止把当前界面视为可发布状态</p>
          <p className="mt-1 text-xs leading-5">
            缺失 {payload.catalogCoverage.missingCount} · 停用 {payload.catalogCoverage.inactiveCount} · 未知 {payload.catalogCoverage.unknownCount} · 合同不一致 {payload.catalogCoverage.contractMismatchCount + payload.catalogCoverage.codeContractMismatchCount}
          </p>
        </div>
      )}

      {payload && !payload.health.healthy && (
        <div role="alert" data-testid="admin-permission-profile-drift" className="rounded-2xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">
          <p className="font-black">授权档案或依赖图异常，普通管理员权限已按失败关闭处理</p>
          <p className="mt-1 text-xs leading-5">
            缺档 {payload.health.missing_profile_count} · 校验和异常 {payload.health.invalid_checksum_count} · 非规范档案 {payload.health.noncanonical_profile_count || 0} · 孤立档案 {payload.health.orphan_profile_count} · 无效依赖 {payload.health.catalog_invalid_dependency_count || 0} · 循环依赖 {payload.health.catalog_cycle_count || 0}
          </p>
        </div>
      )}

      <div className="grid grid-cols-[340px_minmax(0,1fr)] gap-5">
        <div className="overflow-hidden rounded-2xl border border-[#d0d5dd] bg-white">
          <div className="border-b border-[#eaecf0] px-4 py-3"><p className="font-black">内部人员</p><p className="mt-1 text-xs text-[#667085]">选择一人编辑；超级管理员档案不可降级。</p></div>
          <div className="divide-y divide-[#eaecf0]">
            {(payload?.administrators || []).map((administrator) => (
              <button key={administrator.user_id} type="button" disabled={governanceDirty && selectedId !== administrator.user_id} title={governanceDirty && selectedId !== administrator.user_id ? "请先保存或撤销当前修改" : undefined} onClick={() => setSelectedId(administrator.user_id)} className={`flex w-full items-center gap-3 px-4 py-4 text-left disabled:cursor-not-allowed disabled:opacity-40 ${selectedId === administrator.user_id ? "bg-[#ecfdf3]" : "hover:bg-[#f9fafb]"}`}>
                <span className={`grid h-10 w-10 shrink-0 place-items-center rounded-xl ${administrator.admin_level === "super_admin" ? "bg-[#101828] text-white" : "bg-[#f2f4f7] text-[#475467]"}`}><UserCog className="h-5 w-5" /></span>
                <span className="min-w-0 flex-1"><span className="block truncate text-sm font-black">{administrator.user?.display_name || administrator.user?.username || "管理员"}</span><span className="mt-1 block truncate text-xs text-[#667085]">{administrator.admin_level === "super_admin" ? "超级管理员" : `${administrator.permission_keys.length} 项授权`} · {administrator.is_active ? "启用" : "停用"}</span></span><ChevronRight className="h-4 w-4 text-[#98a2b3]" />
              </button>
            ))}
          </div>
        </div>

        <div className="rounded-2xl border border-[#d0d5dd] bg-white p-5">
          {!selected ? <div className="grid min-h-80 place-items-center text-sm text-[#667085]">请选择一位管理员</div> : <>
            <div className="flex flex-wrap items-start justify-between gap-3 border-b border-[#eaecf0] pb-4"><div><div className="flex items-center gap-2"><h2 className="text-xl font-black">{selected.user?.display_name || selected.user?.username}</h2><span className={`rounded-full px-2.5 py-1 text-xs font-bold ${selected.admin_level === "super_admin" ? "bg-[#101828] text-white" : "bg-[#ecfdf3] text-[#067647]"}`}>{selected.admin_level === "super_admin" ? "超级管理员" : "管理员"}</span></div><p className="mt-2 text-xs text-[#667085]">账号 {selected.user?.username} · 最近登录 {formatDate(selected.user?.last_sign_in_at)} · 权限版本 R{selected.revision}</p></div><button type="button" onClick={() => setShowAccountEditor((value) => !value)} className="rounded-xl border border-[#d0d5dd] px-3 py-2 text-sm font-bold text-[#475467]">修改资料/密码</button></div>

            {showAccountEditor && <div className="mt-4 grid grid-cols-2 gap-3 rounded-2xl border border-[#d0d5dd] bg-[#f9fafb] p-4"><label className="text-xs font-bold text-[#475467]">姓名<input value={accountForm.displayName} onChange={(event) => setAccountForm((current) => ({ ...current, displayName: event.target.value }))} className="mt-1.5 h-10 w-full rounded-xl border border-[#d0d5dd] bg-white px-3 text-sm" /></label><label className="text-xs font-bold text-[#475467]">手机号（需本人邮箱验证）<input value={accountForm.phone} readOnly aria-readonly="true" className="mt-1.5 h-10 w-full cursor-not-allowed rounded-xl border border-[#d0d5dd] bg-[#eef2f6] px-3 text-sm text-[#667085]" /></label><label className="text-xs font-bold text-[#475467]">安全邮箱（不可更改）<input value={accountForm.email} readOnly aria-readonly="true" className="mt-1.5 h-10 w-full cursor-not-allowed rounded-xl border border-[#d0d5dd] bg-[#eef2f6] px-3 text-sm text-[#667085]" /></label><label className="text-xs font-bold text-[#475467]">新密码（不修改请留空）<input type="password" value={accountForm.newPassword} onChange={(event) => setAccountForm((current) => ({ ...current, newPassword: event.target.value }))} className="mt-1.5 h-10 w-full rounded-xl border border-[#d0d5dd] bg-white px-3 text-sm" /></label><p className="col-span-2 rounded-xl border border-[#b2ddff] bg-[#eff8ff] px-3 py-2 text-xs leading-5 text-[#175cd3]">管理员如需更换手机号，请登录本人个人中心，并使用当前QQ安全邮箱验证码完成。</p><div className="col-span-2 flex items-center justify-between gap-3">{accountDirty ? <span className="text-xs font-bold text-amber-700">资料有未保存修改</span> : <span className="text-xs text-[#667085]">当前内容与数据库读回一致</span>}<button type="button" disabled={saving || !accountDirty} onClick={() => void saveAccount()} className="inline-flex items-center gap-2 rounded-xl bg-[#101828] px-4 py-2.5 text-sm font-bold text-white disabled:cursor-not-allowed disabled:opacity-50"><Save className="h-4 w-4" />保存管理员资料</button></div></div>}

            {selected.admin_level === "super_admin" ? <div className="mt-5 rounded-2xl border border-[#d0d5dd] bg-[#f9fafb] p-5"><p className="font-black">超级管理员拥有全部当前及未来后台权限</p><p className="mt-2 text-sm leading-6 text-[#667085]">权限来自唯一超级管理员身份，不依赖前端勾选项。该身份不能在页面中降级或停用，避免误操作导致整个平台失去所有者。</p></div> : <>
              <div className="mt-5 flex items-center justify-between"><div><h3 className="font-black">后台权限矩阵</h3><p className="mt-1 text-xs text-[#667085]">新增功能默认不授权；保存后会撤销该管理员旧的敏感操作解锁。</p></div><label className="flex items-center gap-2 text-sm font-bold"><input type="checkbox" checked={activeDraft} onChange={(event) => setActiveDraft(event.target.checked)} className="h-4 w-4 accent-[#079455]" />账号启用</label></div>
              <div className="mt-4 rounded-2xl border border-[#d0d5dd] bg-[#f9fafb] p-4" data-testid="admin-job-template-drafts">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="text-sm font-black">岗位模板</p>
                    <p className="mt-1 text-xs text-[#667085]">模板只生成可审阅草稿，不会自动保存或授予核心技术权限。</p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {ADMIN_JOB_TEMPLATES.map((template) => (
                      <button
                        key={template.id}
                        type="button"
                        title={template.description}
                        onClick={() => applyJobTemplate(template.id, "edit")}
                        className={`rounded-lg border px-3 py-2 text-xs font-bold ${activeDraftTemplate === template.id ? "border-[#079455] bg-[#ecfdf3] text-[#067647]" : "border-[#d0d5dd] bg-white text-[#344054] hover:border-[#079455] hover:text-[#067647]"}`}
                      >
                        {template.label} · {normalizeDelegableAdminPermissionKeys(template.permissionKeys).length}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
              <div className="mt-4 grid grid-cols-3 gap-3" data-testid="admin-permission-effect-preview">
                <div className="rounded-2xl border border-[#b2ddff] bg-[#eff8ff] p-4">
                  <p className="text-xs font-black text-[#175cd3]">保存后可见入口 · {draftVisibleSurfaces.length}</p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {draftVisibleSurfaces.length > 0
                      ? draftVisibleSurfaces.map((surface) => (
                        <span key={surface.id} className="rounded-full bg-white px-2.5 py-1 text-[11px] font-bold text-[#175cd3]">{surface.label}</span>
                      ))
                      : <span className="text-xs text-[#475467]">暂无后台入口；该账号登录后只能看到未分配提示。</span>}
                  </div>
                </div>
                <div className={`rounded-2xl border p-4 ${draftCoreTechnologyPermissions.length > 0 ? "border-amber-200 bg-amber-50" : "border-emerald-200 bg-emerald-50"}`}>
                  <p className={`text-xs font-black ${draftCoreTechnologyPermissions.length > 0 ? "text-amber-800" : "text-emerald-800"}`}>核心技术与密钥可见性</p>
                  <p className="mt-2 text-sm font-black">{draftCoreTechnologyPermissions.length > 0 ? "已开放部分核心能力" : "完全隐藏"}</p>
                  <p className="mt-1 text-xs leading-5 text-[#667085]">
                    {draftCoreTechnologyPermissions.length > 0
                      ? draftCoreTechnologyPermissions.map((permission) => permission.label).join("、")
                      : "内部提示词、Skill 源、工具定义和模型密钥入口均不显示，也不会预加载。"}
                  </p>
                </div>
                <div className="rounded-2xl border border-[#d0d5dd] bg-[#f9fafb] p-4" data-testid="admin-permission-dependency-preview">
                  <p className="text-xs font-black text-[#475467]">依赖自动补齐 · {draftDependencyPermissions.length}</p>
                  <p className="mt-2 text-xs leading-5 text-[#667085]">
                    {draftDependencyPermissions.length > 0
                      ? draftDependencyPermissions.map((permission) => permission.label).join("、")
                      : "当前草稿没有附加依赖；选择高级权限时会自动补齐基础查看能力。"}
                  </p>
                </div>
              </div>
              {draftCoreTechnologyPermissions.length > 0 && (
                <label role="alert" className="mt-4 flex items-start gap-3 rounded-2xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-900" data-testid="admin-core-technology-warning">
                  <input
                    type="checkbox"
                    checked={draftCoreConfirmed}
                    onChange={(event) => setCoreGrantConfirmation(event.target.checked ? draftCoreFingerprint : "")}
                    className="mt-0.5 h-4 w-4 shrink-0 accent-rose-700"
                  />
                  <span><strong className="block">确认开放核心技术权限</strong><span className="mt-1 block text-xs leading-5">该账号将获得：{draftCoreTechnologyPermissions.map((permission) => permission.label).join("、")}。这可能允许查看或修改平台内部资产、连接配置或发布控制；未确认前不能保存。</span></span>
                </label>
              )}
              <div className="mt-4">
                <PermissionCatalogMatrix
                  catalog={catalog}
                  selectedKeys={permissionDraft}
                  search={permissionSearch}
                  groupFilter={permissionGroupFilter}
                  onSearchChange={setPermissionSearch}
                  onGroupFilterChange={setPermissionGroupFilter}
                  onToggle={(permissionKey) => togglePermission(permissionKey, "edit")}
                  columns={2}
                  testIdPrefix="edit-admin-permission"
                />
              </div>
              <div className="mt-5 flex items-center justify-between gap-3">{permissionDirty ? <span className="text-xs font-bold text-amber-700">权限或账号状态有未保存修改</span> : <span className="text-xs text-[#667085]">当前权限与数据库读回一致</span>}<button type="button" disabled={saving || !catalogReady || !draftCoreConfirmed || !permissionDirty} onClick={() => void savePermissions()} className="inline-flex h-11 items-center gap-2 rounded-xl bg-[#079455] px-5 text-sm font-bold text-white disabled:cursor-not-allowed disabled:opacity-50"><Save className="h-4 w-4" />保存权限与账号状态</button></div>
            </>}
          </>}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-5">
        <div className={`col-span-2 rounded-2xl border p-5 ${state.maintenanceLock.enabled ? "border-amber-300 bg-amber-50" : "border-[#d0d5dd] bg-white"}`} data-testid="admin-maintenance-lock-card">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="max-w-3xl">
              <div className="flex items-center gap-3">
                <span className={`grid h-10 w-10 place-items-center rounded-xl ${state.maintenanceLock.enabled ? "bg-amber-900 text-white" : "bg-[#f2f4f7] text-[#475467]"}`}><ShieldAlert className="h-5 w-5" /></span>
                <div>
                  <h2 className="font-black">超级管理员维护模式：暂停二次验证锁</h2>
                  <p className="mt-1 text-xs leading-5 text-[#667085]">只暂停登录密码/管理密码的二次确认；岗位权限、资源作用域、账务规则、业务状态机和审计一项不减。</p>
                </div>
              </div>
              {state.maintenanceLock.enabled && (
                <div className="mt-4 rounded-xl border border-amber-200 bg-white/70 p-3 text-xs leading-5 text-amber-950">
                  <p className="font-black">当前已开启，到期时间 {formatDate(state.maintenanceLock.expiresAt)}</p>
                  <p className="mt-1">原因：{state.maintenanceLock.enableReason || "本地限时维护"}</p>
                </div>
              )}
            </div>
            <span className={`rounded-full px-3 py-1.5 text-xs font-black ${state.maintenanceLock.enabled ? "bg-amber-900 text-white" : "bg-emerald-50 text-emerald-700"}`}>{state.maintenanceLock.enabled ? "二次验证已暂停" : "所有锁正常"}</span>
          </div>
          <div className="mt-4 grid grid-cols-[minmax(0,1fr)_140px_auto] gap-3">
            <input
              value={maintenanceReason}
              onChange={(event) => setMaintenanceReason(event.target.value)}
              maxLength={300}
              placeholder={state.maintenanceLock.enabled ? "填写恢复原因（留空使用默认原因）" : "填写本次限时维护原因"}
              className="h-10 min-w-0 rounded-xl border border-[#d0d5dd] bg-white px-3 text-sm outline-none focus:border-[#079455]"
            />
            {!state.maintenanceLock.enabled && (
              <select value={maintenanceDuration} onChange={(event) => setMaintenanceDuration(Number(event.target.value))} className="h-10 rounded-xl border border-[#d0d5dd] bg-white px-3 text-sm">
                <option value={10}>10 分钟</option>
                <option value={20}>20 分钟</option>
                <option value={30}>30 分钟（上限）</option>
              </select>
            )}
            <button
              type="button"
              disabled={saving || (!state.maintenanceLock.enabled && maintenanceReason.trim().length < 3)}
              onClick={() => void updateMaintenanceLock(!state.maintenanceLock.enabled)}
              className={`h-10 rounded-xl px-4 text-sm font-black text-white disabled:cursor-not-allowed disabled:opacity-50 ${state.maintenanceLock.enabled ? "bg-amber-950" : "bg-[#079455]"}`}
            >
              {saving ? "处理中…" : state.maintenanceLock.enabled ? "立即恢复所有锁" : "限时暂停二次验证"}
            </button>
          </div>
          {!state.maintenanceLock.enabled && <p className="mt-2 text-xs text-[#667085]">首次开启必须已完成当前有效的二次验证，最长 30 分钟；不能永久绕过。</p>}
        </div>
        <div className="rounded-2xl border border-[#d0d5dd] bg-white p-5"><div className="flex items-center gap-3"><span className="grid h-10 w-10 place-items-center rounded-xl bg-amber-50 text-amber-700"><KeyRound className="h-5 w-5" /></span><div><h2 className="font-black">平台管理密码</h2><p className="text-xs text-[#667085]">可与管理员自己的登录密码二选一完成敏感操作确认。</p></div></div><div className="mt-4 grid grid-cols-2 gap-3"><select value={managementForm.action} onChange={(event) => setManagementForm((current) => ({ ...current, action: event.target.value as typeof current.action }))} className="h-10 rounded-xl border border-[#d0d5dd] px-3 text-sm"><option value="generate">生成随机管理密码</option><option value={state.managementPasswordSet ? "change" : "set"}>{state.managementPasswordSet ? "修改管理密码" : "设置管理密码"}</option>{state.managementPasswordSet && <option value="remove">移除管理密码</option>}</select>{managementForm.action !== "generate" && <input type="password" placeholder={state.managementPasswordSet ? "当前管理密码" : "当前无需填写"} value={managementForm.currentPassword} onChange={(event) => setManagementForm((current) => ({ ...current, currentPassword: event.target.value }))} className="h-10 rounded-xl border border-[#d0d5dd] px-3 text-sm" />}{managementForm.action !== "generate" && managementForm.action !== "remove" && <input type="password" placeholder="新管理密码（字母+数字，至少8位）" value={managementForm.newPassword} onChange={(event) => setManagementForm((current) => ({ ...current, newPassword: event.target.value }))} className="col-span-2 h-10 rounded-xl border border-[#d0d5dd] px-3 text-sm" />}</div>{generatedPassword && <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 p-3"><p className="text-xs font-bold text-amber-800">仅显示一次</p><p className="mt-1 select-all break-all font-mono text-base font-black text-[#101828]">{generatedPassword}</p></div>}<button type="button" onClick={() => void updateManagementPassword()} disabled={saving} className="mt-4 rounded-xl bg-[#101828] px-4 py-2.5 text-sm font-bold text-white">确认管理密码操作</button></div>
        <div className="rounded-2xl border border-[#d0d5dd] bg-white p-5"><div className="flex items-center gap-3"><span className="grid h-10 w-10 place-items-center rounded-xl bg-emerald-50 text-emerald-700"><CheckCircle2 className="h-5 w-5" /></span><div><h2 className="font-black">升级后权限体检</h2><p className="text-xs text-[#667085]">数据库独立保存，不随代码覆盖；每次读取都重新校验。</p></div></div><div className="mt-4 grid grid-cols-2 gap-2 text-xs"><div className="rounded-xl bg-[#f9fafb] p-3">授权档案缺失 <strong className="float-right">{payload?.health?.missing_profile_count ?? "—"}</strong></div><div className="rounded-xl bg-[#f9fafb] p-3">校验和异常 <strong className="float-right">{payload?.health?.invalid_checksum_count ?? "—"}</strong></div><div className="rounded-xl bg-[#f9fafb] p-3">孤儿档案 <strong className="float-right">{payload?.health?.orphan_profile_count ?? "—"}</strong></div><div className="rounded-xl bg-[#f9fafb] p-3">过期解锁会话 <strong className="float-right">{payload?.health?.expired_session_count ?? "—"}</strong></div></div></div>
      </div>

      <div className="overflow-hidden rounded-2xl border border-[#d0d5dd] bg-white"><div className="border-b border-[#eaecf0] px-5 py-4"><h2 className="font-black">管理员操作审计</h2><p className="mt-1 text-xs text-[#667085]">允许、拒绝、密码失败、资料与权限变更均只追加不可修改；不记录密码、密钥或提示词正文。</p></div><div className="max-h-[430px] overflow-auto"><table className="w-full text-left text-xs"><thead className="sticky top-0 bg-[#f9fafb] text-[#667085]"><tr><th className="px-4 py-3">时间</th><th className="px-4 py-3">操作者</th><th className="px-4 py-3">动作</th><th className="px-4 py-3">结果</th><th className="px-4 py-3">权限/原因</th><th className="px-4 py-3">IP</th></tr></thead><tbody className="divide-y divide-[#eaecf0]">{(payload?.audit || []).map((audit) => <tr key={audit.id} className="hover:bg-[#f9fafb]"><td className="whitespace-nowrap px-4 py-3">{formatDate(audit.created_at)}</td><td className="px-4 py-3 font-bold">{administratorNames.get(audit.actor_id || "") || audit.actor_id || "系统"}</td><td className="px-4 py-3">{ACTION_LABELS[audit.action] || audit.action}</td><td className="px-4 py-3"><span className={`rounded-full px-2 py-1 font-bold ${audit.result === "success" || audit.result === "allowed" ? "bg-emerald-50 text-emerald-700" : "bg-rose-50 text-rose-700"}`}>{audit.result === "success" ? "成功" : audit.result === "allowed" ? "放行" : audit.result === "denied" ? "拒绝" : "失败"}</span></td><td className="px-4 py-3 text-[#667085]">{audit.permission_key || audit.reason_code || "—"}</td><td className="px-4 py-3 font-mono text-[#667085]">{audit.request_ip || "—"}</td></tr>)}</tbody></table></div></div>

      {showCreate && (
        <div
          className="fixed inset-0 z-[170] grid place-items-center bg-black/45 p-6 backdrop-blur-[2px]"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setShowCreate(false);
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="create-admin-title"
            className="max-h-[calc(100vh-48px)] w-full max-w-5xl overflow-y-auto rounded-2xl bg-white shadow-2xl"
            data-testid="add-administrator-dialog"
          >
            <div className="sticky top-0 z-10 flex items-start justify-between border-b border-[#eaecf0] bg-white px-6 py-5">
              <div>
                <p className="text-xs font-bold text-[#067647]">内部人员账号</p>
                <h2 id="create-admin-title" className="mt-1 text-xl font-black">添加管理员并一次性授权</h2>
                <p className="mt-1 text-xs text-[#667085]">优先从已注册会员中选择；也可为尚未注册的内部人员新建独立账号。</p>
              </div>
              <button type="button" aria-label="关闭" onClick={() => setShowCreate(false)} className="grid h-9 w-9 place-items-center rounded-xl border border-[#d0d5dd]">
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="space-y-5 p-6">
              <div className="grid grid-cols-2 gap-2 rounded-xl bg-[#f2f4f7] p-1" role="tablist" aria-label="添加管理员方式">
                <button
                  type="button"
                  role="tab"
                  aria-selected={createMode === "promote"}
                  onClick={() => setCreateMode("promote")}
                  className={`rounded-lg px-4 py-2.5 text-sm font-black ${createMode === "promote" ? "bg-white text-[#067647] shadow-sm" : "text-[#667085]"}`}
                >
                  从已注册会员添加
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={createMode === "create"}
                  onClick={() => setCreateMode("create")}
                  className={`rounded-lg px-4 py-2.5 text-sm font-black ${createMode === "create" ? "bg-white text-[#067647] shadow-sm" : "text-[#667085]"}`}
                >
                  新建内部管理员账号
                </button>
              </div>

              {createMode === "promote" ? (
                <div className="rounded-2xl border border-[#d0d5dd] p-4" data-testid="registered-member-admin-picker">
                  <div className="relative">
                    <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#98a2b3]" />
                    <input
                      value={candidateSearch}
                      onChange={(event) => setCandidateSearch(event.target.value)}
                      placeholder="搜索姓名、账号、手机号或邮箱"
                      className="h-11 w-full rounded-xl border border-[#d0d5dd] pl-10 pr-3 text-sm outline-none focus:border-[#079455]"
                    />
                  </div>
                  <div className="mt-3 max-h-64 divide-y divide-[#eaecf0] overflow-y-auto rounded-xl border border-[#eaecf0]">
                    {filteredCandidates.length === 0 ? (
                      <div className="p-6 text-center text-sm text-[#667085]">没有匹配的已注册会员</div>
                    ) : filteredCandidates.map((candidate) => (
                      <button
                        key={candidate.id}
                        type="button"
                        disabled={!candidate.eligible}
                        onClick={() => setSelectedCandidateId(candidate.id)}
                        className={`flex w-full items-center gap-3 p-3 text-left transition ${selectedCandidateId === candidate.id ? "bg-[#ecfdf3]" : "bg-white hover:bg-[#f9fafb]"} disabled:cursor-not-allowed disabled:opacity-55`}
                      >
                        <span className={`grid h-9 w-9 shrink-0 place-items-center rounded-xl ${selectedCandidateId === candidate.id ? "bg-[#079455] text-white" : "bg-[#f2f4f7] text-[#475467]"}`}>
                          <Users className="h-4 w-4" />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-black">{candidate.display_name || candidate.username || "未命名会员"}</span>
                          <span className="mt-0.5 block truncate text-xs text-[#667085]">{candidate.phone || candidate.email || candidate.username} · 注册 {formatDate(candidate.created_at)}</span>
                        </span>
                        <span className={`rounded-full px-2.5 py-1 text-[11px] font-bold ${candidate.eligible ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-700"}`}>
                          {candidate.eligible ? (candidate.member_status === "active" ? "正式会员 · 可授权" : "已注册 · 可授权") : !candidate.has_password ? "未设登录密码" : "账号不可用"}
                        </span>
                      </button>
                    ))}
                  </div>
                  {selectedCandidate && (
                    <div className="mt-3 rounded-xl border border-[#b2ddff] bg-[#eff8ff] p-3 text-xs leading-5 text-[#175cd3]">
                      将把“{selectedCandidate.display_name || selectedCandidate.username}”授权为普通管理员并撤销其旧登录会话；会员资产不会删除。其后可使用原账号密码登录后台。
                    </div>
                  )}
                </div>
              ) : (
                <div className="grid grid-cols-2 gap-3">
                  <label className="text-xs font-bold text-[#475467]">姓名
                    <input value={createForm.displayName} onChange={(event) => setCreateForm((current) => ({ ...current, displayName: event.target.value }))} className="mt-1.5 h-10 w-full rounded-xl border border-[#d0d5dd] px-3 text-sm" />
                  </label>
                  <label className="text-xs font-bold text-[#475467]">登录账号
                    <input value={createForm.username} onChange={(event) => setCreateForm((current) => ({ ...current, username: event.target.value }))} className="mt-1.5 h-10 w-full rounded-xl border border-[#d0d5dd] px-3 text-sm" />
                  </label>
                  <label className="text-xs font-bold text-[#475467]">手机号
                    <input value={createForm.phone} onChange={(event) => setCreateForm((current) => ({ ...current, phone: event.target.value }))} className="mt-1.5 h-10 w-full rounded-xl border border-[#d0d5dd] px-3 text-sm" />
                  </label>
                  <label className="text-xs font-bold text-[#475467]">邮箱
                    <input value={createForm.email} onChange={(event) => setCreateForm((current) => ({ ...current, email: event.target.value }))} className="mt-1.5 h-10 w-full rounded-xl border border-[#d0d5dd] px-3 text-sm" />
                  </label>
                  <label className="col-span-2 text-xs font-bold text-[#475467]">初始密码
                    <input type="password" autoComplete="new-password" value={createForm.password} onChange={(event) => setCreateForm((current) => ({ ...current, password: event.target.value }))} placeholder="至少8位，同时包含字母和数字" className="mt-1.5 h-10 w-full rounded-xl border border-[#d0d5dd] px-3 text-sm" />
                  </label>
                </div>
              )}

              <div>
                <div className="mb-3">
                  <h3 className="text-sm font-black">勾选后台权限</h3>
                  <p className="mt-1 text-xs text-[#667085]">不勾选即不授权；以后新增的后台能力不会自动加入。</p>
                </div>
                <div className="mb-4 rounded-2xl border border-[#d0d5dd] bg-[#f9fafb] p-4">
                  <p className="text-xs font-black text-[#475467]">从岗位草稿开始</p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {ADMIN_JOB_TEMPLATES.map((template) => (
                      <button
                        key={template.id}
                        type="button"
                        title={template.description}
                        onClick={() => applyJobTemplate(template.id, "create")}
                        className={`rounded-lg border px-3 py-2 text-xs font-bold ${activeCreateTemplate === template.id ? "border-[#079455] bg-[#ecfdf3] text-[#067647]" : "border-[#d0d5dd] bg-white text-[#344054] hover:border-[#079455] hover:text-[#067647]"}`}
                      >
                        {template.label} · {normalizeDelegableAdminPermissionKeys(template.permissionKeys).length}
                      </button>
                    ))}
                  </div>
                  <div className="mt-3 grid grid-cols-3 gap-2 text-xs">
                    <div className="rounded-xl bg-[#eff8ff] p-3 text-[#175cd3]">
                      <p className="font-black">生效入口 · {createVisibleSurfaces.length}</p>
                      <p className="mt-1 leading-5 text-[#475467]">{createVisibleSurfaces.length > 0 ? createVisibleSurfaces.map((surface) => surface.label).join("、") : "暂无后台入口"}</p>
                    </div>
                    <div className={`rounded-xl p-3 ${createCoreTechnologyPermissions.length > 0 ? "bg-amber-50 text-amber-800" : "bg-emerald-50 text-emerald-800"}`}>
                      <p className="font-black">核心技术 · {createCoreTechnologyPermissions.length > 0 ? "部分开放" : "完全隐藏"}</p>
                      <p className="mt-1 leading-5 text-[#475467]">{createCoreTechnologyPermissions.length > 0 ? createCoreTechnologyPermissions.map((permission) => permission.label).join("、") : "不加载受保护能力"}</p>
                    </div>
                    <div className="rounded-xl bg-white p-3 text-[#475467]" data-testid="create-admin-permission-dependency-preview">
                      <p className="font-black">依赖自动补齐 · {createDependencyPermissions.length}</p>
                      <p className="mt-1 leading-5">{createDependencyPermissions.length > 0 ? createDependencyPermissions.map((permission) => permission.label).join("、") : "选择高级权限后自动显示"}</p>
                    </div>
                  </div>
                </div>
                {createCoreTechnologyPermissions.length > 0 && (
                  <label role="alert" className="mb-4 flex items-start gap-3 rounded-2xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-900" data-testid="create-admin-core-technology-warning">
                    <input
                      type="checkbox"
                      checked={createCoreConfirmed}
                      onChange={(event) => setCreateCoreGrantConfirmation(event.target.checked ? createCoreFingerprint : "")}
                      className="mt-0.5 h-4 w-4 shrink-0 accent-rose-700"
                    />
                    <span><strong className="block">确认向新管理员开放核心技术权限</strong><span className="mt-1 block text-xs leading-5">将开放：{createCoreTechnologyPermissions.map((permission) => permission.label).join("、")}。确认前不能创建或授权管理员。</span></span>
                  </label>
                )}
                <PermissionCatalogMatrix
                  catalog={catalog}
                  selectedKeys={createForm.permissionKeys}
                  search={createPermissionSearch}
                  groupFilter={createPermissionGroupFilter}
                  onSearchChange={setCreatePermissionSearch}
                  onGroupFilterChange={setCreatePermissionGroupFilter}
                  onToggle={(permissionKey) => togglePermission(permissionKey, "create")}
                  columns={3}
                  testIdPrefix="create-admin-permission"
                />
              </div>

              <div className="flex justify-end gap-2 border-t border-[#eaecf0] pt-4">
                <button type="button" onClick={() => setShowCreate(false)} className="rounded-xl border border-[#d0d5dd] px-4 py-2.5 text-sm font-bold">取消</button>
                <button
                  type="button"
                  disabled={saving || !catalogReady || !createCoreConfirmed || (createMode === "promote" && !selectedCandidateId)}
                  onClick={() => void createAdministrator()}
                  className="rounded-xl bg-[#079455] px-5 py-2.5 text-sm font-bold text-white disabled:cursor-not-allowed disabled:opacity-50"
                  data-testid="confirm-add-administrator"
                >
                  {saving ? "处理中…" : createMode === "promote" ? "授权为管理员" : "创建管理员"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
