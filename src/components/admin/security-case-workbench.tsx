"use client";

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  SECURITY_CASE_ACTION_LABELS,
  SECURITY_CASE_AUTO_REFRESH_MS,
  SECURITY_CASE_ENTITY_LABELS,
  SECURITY_CASE_READ_COOLDOWN_MS,
  SECURITY_CASE_RISK_LABELS,
  SECURITY_CASE_SOURCE_LABELS,
  SECURITY_CASE_STATUS_LABELS,
  SECURITY_CASE_WORKBENCH_PAGE_SIZE,
  createSecurityCaseRequestKey,
  isSecurityCaseActionPreview,
  isSecurityCaseDetailResponse,
  isSecurityCaseListResponse,
  nextSecurityCaseStatuses,
  retryAfterDeadlineMs,
  securityCaseActionStatusLabel,
  type SecurityCaseAction,
  type SecurityCaseActionPreview,
  type SecurityCaseDetailResponse,
  type SecurityCaseLink,
  type SecurityCaseListResponse,
  type SecurityCaseSummary,
} from "@/lib/security-case-workbench-domain";
import type {
  SecurityCaseEntityType,
  SecurityCaseRiskLevel,
  SecurityCaseStatus,
} from "@/lib/security-case-contracts";

import styles from "./security-case-workbench.module.css";

export interface SecurityCaseWorkbenchProps {
  token: string | null;
  canManage: boolean;
  stepUpReady: boolean;
  onRequestUnlock?: () => void;
  endpoint?: string;
  autoRefresh?: boolean;
  className?: string;
}

interface Filters {
  status: "" | SecurityCaseStatus;
  riskLevel: "" | SecurityCaseRiskLevel;
  assignedTo: string;
}

type MutationBody = Record<string, string | number>;

const EMPTY_FILTERS: Filters = { status: "", riskLevel: "", assignedTo: "" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function errorMessage(body: unknown, fallback: string): string {
  return isRecord(body) && typeof body.error === "string" ? body.error : fallback;
}

function formatTime(value: string | null | undefined): string {
  if (!value) return "时间不可用";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "时间不可用";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);
}

function shortReference(value: string | null | undefined, head = 8, tail = 5): string {
  if (!value) return "未分配";
  if (value.length <= head + tail + 3) return value;
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}

function readableValue(value: unknown): string {
  if (value == null || value === "") return "—";
  if (typeof value === "boolean") return value ? "是" : "否";
  if (typeof value === "string" || typeof value === "number") return String(value).slice(0, 220);
  try {
    return JSON.stringify(value).slice(0, 220);
  } catch {
    return "结构化证据不可读";
  }
}

function actionTargetLabel(link: SecurityCaseLink): string {
  return `${SECURITY_CASE_ENTITY_LABELS[link.entity_type]} · ${link.entity_label || shortReference(link.entity_ref)}`;
}

function actionTypeForLink(link: SecurityCaseLink | undefined) {
  return link?.entity_type === "session" ? "revoke_session" as const : "disable_user" as const;
}

function actionBoundary(action: SecurityCaseAction): string {
  if (action.status === "pending_executor") return "请求已保存，但没有执行账号停用或会话撤销";
  if (action.status === "cancelled") return action.cancellation_reason || "待执行请求已取消";
  return "状态来自案件事实源，请核对执行器审计后再判断结果";
}

export function SecurityCaseWorkbench({
  token,
  canManage,
  stepUpReady,
  onRequestUnlock,
  endpoint = "/api/admin/security-events/cases",
  autoRefresh = true,
  className = "",
}: SecurityCaseWorkbenchProps) {
  const instanceId = useId().replaceAll(":", "");
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [assigneeDraft, setAssigneeDraft] = useState("");
  const [page, setPage] = useState(1);
  const [listSnapshot, setListSnapshot] = useState<SecurityCaseListResponse | null>(null);
  const [detail, setDetail] = useState<SecurityCaseDetailResponse | null>(null);
  const [selectedCaseId, setSelectedCaseId] = useState("");
  const [listLoading, setListLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [mutationBusy, setMutationBusy] = useState(false);
  const [listError, setListError] = useState("");
  const [detailError, setDetailError] = useState("");
  const [operationError, setOperationError] = useState("");
  const [operationNotice, setOperationNotice] = useState("");
  const [reason, setReason] = useState("");
  const [transitionTarget, setTransitionTarget] = useState<SecurityCaseStatus | "">("");
  const [entityType, setEntityType] = useState<SecurityCaseEntityType>("user");
  const [entityRef, setEntityRef] = useState("");
  const [entityLabel, setEntityLabel] = useState("");
  const [actionLinkId, setActionLinkId] = useState("");
  const [actionPreview, setActionPreview] = useState<SecurityCaseActionPreview | null>(null);
  const [pageVisible, setPageVisible] = useState(true);
  const [online, setOnline] = useState(true);
  const [availabilityReady, setAvailabilityReady] = useState(false);
  const [nextReadAtMs, setNextReadAtMs] = useState(0);
  const [autoRefreshAtMs, setAutoRefreshAtMs] = useState(0);
  const [clockMs, setClockMs] = useState(0);
  const listAbortRef = useRef<AbortController | null>(null);
  const detailAbortRef = useRef<AbortController | null>(null);
  const nextReadAtRef = useRef(0);
  const selectedCaseIdRef = useRef("");
  const loadedQueryRef = useRef("");

  const pauseReason = !token
    ? "缺少有效管理员会话，案件读取已暂停"
    : !availabilityReady
      ? "正在确认页面与网络状态"
      : !pageVisible
        ? "页面位于后台，案件读取已暂停"
        : !online
          ? "浏览器离线，案件读取已暂停"
          : "";
  const readsAvailable = !pauseReason;
  const coolingDown = nextReadAtMs > clockMs;
  const totalPages = Math.max(1, Math.ceil((listSnapshot?.total || 0) / SECURITY_CASE_WORKBENCH_PAGE_SIZE));
  const currentDetail = detail?.case.id === selectedCaseId ? detail : null;
  const selectedCase = currentDetail?.case || listSnapshot?.cases.find((item) => item.id === selectedCaseId) || null;
  const transitions = selectedCase ? nextSecurityCaseStatuses(selectedCase.status) : [];
  const actionableLinks = useMemo(
    () => currentDetail?.links.filter((link) => link.entity_type === "user" || link.entity_type === "session") || [],
    [currentDetail?.links],
  );
  const selectedActionLink = actionableLinks.find((link) => link.id === actionLinkId);
  const pendingActions = useMemo(
    () => currentDetail?.actions.filter((action) => action.status === "pending_executor") || [],
    [currentDetail?.actions],
  );
  const listQueryKey = `${page}|${filters.status}|${filters.riskLevel}|${filters.assignedTo}`;

  const applyRateLimit = useCallback((response: Response, body: unknown) => {
    const nextAt = retryAfterDeadlineMs(
      response.headers.get("Retry-After"),
      isRecord(body) ? body.nextRefreshAt : null,
      Date.now(),
    );
    setNextReadAtMs(nextAt);
    nextReadAtRef.current = nextAt;
    setAutoRefreshAtMs(nextAt);
    setClockMs(Date.now());
  }, []);

  const loadList = useCallback(async (force = false): Promise<SecurityCaseSummary[] | null> => {
    if (!token) return null;
    if (typeof document !== "undefined" && document.hidden) return null;
    if (typeof navigator !== "undefined" && !navigator.onLine) return null;
    const now = Date.now();
    if (!force && nextReadAtRef.current > now) return null;

    listAbortRef.current?.abort();
    const controller = new AbortController();
    listAbortRef.current = controller;
    setListLoading(true);
    setListError("");
    try {
      const url = new URL(endpoint, window.location.origin);
      url.searchParams.set("page", String(page));
      url.searchParams.set("pageSize", String(SECURITY_CASE_WORKBENCH_PAGE_SIZE));
      if (filters.status) url.searchParams.set("status", filters.status);
      if (filters.riskLevel) url.searchParams.set("riskLevel", filters.riskLevel);
      if (filters.assignedTo.trim()) url.searchParams.set("assignedTo", filters.assignedTo.trim());
      const response = await fetch(url, {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
        credentials: "same-origin",
        cache: "no-store",
        signal: controller.signal,
      });
      const body: unknown = await response.json().catch(() => null);
      if (response.status === 429) {
        applyRateLimit(response, body);
        setListError(errorMessage(body, "案件读取过于频繁，请按服务端时间重试"));
        return null;
      }
      if (!response.ok) throw new Error(errorMessage(body, "安全案件列表暂不可用"));
      if (!isSecurityCaseListResponse(body)) throw new Error("案件列表响应合同不完整，本次数据未采用");
      setListSnapshot(body);
      const currentSelection = selectedCaseIdRef.current;
      const nextId = body.cases.some((item) => item.id === currentSelection)
        ? currentSelection
        : body.cases[0]?.id || "";
      setSelectedCaseId(nextId);
      const completedAt = Date.now();
      setNextReadAtMs(completedAt + SECURITY_CASE_READ_COOLDOWN_MS);
      nextReadAtRef.current = completedAt + SECURITY_CASE_READ_COOLDOWN_MS;
      setAutoRefreshAtMs(completedAt + SECURITY_CASE_AUTO_REFRESH_MS);
      setClockMs(completedAt);
      return body.cases;
    } catch (caught) {
      if (caught instanceof Error && caught.name === "AbortError") return null;
      setListError(caught instanceof Error ? caught.message : "安全案件列表暂不可用");
      setAutoRefreshAtMs(Date.now() + SECURITY_CASE_AUTO_REFRESH_MS);
      return null;
    } finally {
      if (listAbortRef.current === controller) {
        listAbortRef.current = null;
        setListLoading(false);
      }
    }
  }, [applyRateLimit, endpoint, filters.assignedTo, filters.riskLevel, filters.status, page, token]);

  const loadDetail = useCallback(async (caseId: string) => {
    if (!token || !caseId) return;
    if (typeof document !== "undefined" && document.hidden) return;
    if (typeof navigator !== "undefined" && !navigator.onLine) return;
    detailAbortRef.current?.abort();
    const controller = new AbortController();
    detailAbortRef.current = controller;
    setDetailLoading(true);
    setDetailError("");
    try {
      const response = await fetch(`${endpoint}/${encodeURIComponent(caseId)}`, {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
        credentials: "same-origin",
        cache: "no-store",
        signal: controller.signal,
      });
      const body: unknown = await response.json().catch(() => null);
      if (response.status === 429) {
        applyRateLimit(response, body);
        setDetailError(errorMessage(body, "案件详情读取过于频繁，请按服务端时间重试"));
        return;
      }
      if (!response.ok) throw new Error(errorMessage(body, "安全案件详情暂不可用"));
      if (!isSecurityCaseDetailResponse(body)) throw new Error("案件详情响应合同不完整，本次数据未采用");
      if (body.case.id !== caseId) throw new Error("案件详情与当前选择不一致，本次数据未采用");
      setDetail(body);
      const targets = body.links.filter((link) => link.entity_type === "user" || link.entity_type === "session");
      setActionLinkId((current) => targets.some((link) => link.id === current) ? current : targets[0]?.id || "");
    } catch (caught) {
      if (caught instanceof Error && caught.name === "AbortError") return;
      setDetailError(caught instanceof Error ? caught.message : "安全案件详情暂不可用");
    } finally {
      if (detailAbortRef.current === controller) {
        detailAbortRef.current = null;
        setDetailLoading(false);
      }
    }
  }, [applyRateLimit, endpoint, token]);

  const refreshAll = useCallback(async (force = false) => {
    if (!readsAvailable) return;
    const cases = await loadList(force);
    const caseId = cases?.some((item) => item.id === selectedCaseId)
      ? selectedCaseId
      : cases?.[0]?.id || selectedCaseId;
    if (caseId) await loadDetail(caseId);
  }, [loadDetail, loadList, readsAvailable, selectedCaseId]);

  useEffect(() => {
    selectedCaseIdRef.current = selectedCaseId;
  }, [selectedCaseId]);

  useEffect(() => {
    const syncAvailability = () => {
      const visible = !document.hidden;
      const connected = navigator.onLine;
      setPageVisible(visible);
      setOnline(connected);
      setAvailabilityReady(true);
      setClockMs(Date.now());
      if (!visible || !connected) {
        listAbortRef.current?.abort();
        detailAbortRef.current?.abort();
      }
    };
    syncAvailability();
    document.addEventListener("visibilitychange", syncAvailability);
    window.addEventListener("online", syncAvailability);
    window.addEventListener("offline", syncAvailability);
    return () => {
      document.removeEventListener("visibilitychange", syncAvailability);
      window.removeEventListener("online", syncAvailability);
      window.removeEventListener("offline", syncAvailability);
      listAbortRef.current?.abort();
      detailAbortRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    if (!readsAvailable) return;
    const queryChanged = loadedQueryRef.current !== listQueryKey;
    const snapshotDue = !listSnapshot || autoRefreshAtMs <= Date.now();
    if (!queryChanged && !snapshotDue) return;
    loadedQueryRef.current = listQueryKey;
    const timer = window.setTimeout(() => void loadList(true), 0);
    return () => window.clearTimeout(timer);
  }, [autoRefreshAtMs, listQueryKey, listSnapshot, loadList, readsAvailable]);

  useEffect(() => {
    if (!readsAvailable || !selectedCaseId) {
      if (!selectedCaseId) setDetail(null);
      return;
    }
    if (currentDetail) return;
    const timer = window.setTimeout(() => void loadDetail(selectedCaseId), 0);
    return () => window.clearTimeout(timer);
  }, [currentDetail, loadDetail, readsAvailable, selectedCaseId]);

  useEffect(() => {
    setOperationError("");
    setOperationNotice("");
    setActionPreview(null);
    setTransitionTarget("");
  }, [selectedCaseId]);

  useEffect(() => {
    setActionPreview(null);
  }, [actionLinkId]);

  useEffect(() => {
    if (!readsAvailable || !autoRefresh || autoRefreshAtMs <= 0) return;
    const delay = Math.max(100, autoRefreshAtMs - Date.now());
    const timer = window.setTimeout(() => void refreshAll(true), delay);
    return () => window.clearTimeout(timer);
  }, [autoRefresh, autoRefreshAtMs, readsAvailable, refreshAll]);

  useEffect(() => {
    const nextTick = Math.min(...[nextReadAtMs, autoRefreshAtMs].filter((value) => value > clockMs));
    if (!Number.isFinite(nextTick)) return;
    const timer = window.setTimeout(() => setClockMs(Date.now()), Math.max(100, nextTick - clockMs + 50));
    return () => window.clearTimeout(timer);
  }, [autoRefreshAtMs, clockMs, nextReadAtMs]);

  const ensureWritable = useCallback((): boolean => {
    setOperationError("");
    setOperationNotice("");
    if (!canManage) {
      setOperationError("当前管理员没有 security.manage 权限");
      return false;
    }
    if (!stepUpReady) {
      setOperationError("敏感操作尚未解锁，请重新验证管理员密码");
      onRequestUnlock?.();
      return false;
    }
    return true;
  }, [canManage, onRequestUnlock, stepUpReady]);

  const writeRequest = useCallback(async (
    url: string,
    method: "PATCH" | "POST",
    body: MutationBody,
    requestKey: string,
  ): Promise<Record<string, unknown> | null> => {
    if (!token || !ensureWritable() || mutationBusy) return null;
    setMutationBusy(true);
    try {
      const response = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "Idempotency-Key": requestKey,
        },
        credentials: "same-origin",
        cache: "no-store",
        body: JSON.stringify(body),
      });
      const payload: unknown = await response.json().catch(() => null);
      if (response.status === 428 || (isRecord(payload) && payload.code === "ADMIN_STEP_UP_REQUIRED")) {
        onRequestUnlock?.();
        throw new Error("敏感操作解锁已失效，请重新验证管理员密码");
      }
      if (response.status === 429) applyRateLimit(response, payload);
      if (!response.ok) throw new Error(errorMessage(payload, "安全案件写入失败"));
      if (!isRecord(payload) || payload.ok !== true) throw new Error("安全案件写入响应合同不完整");
      return payload;
    } catch (caught) {
      setOperationError(caught instanceof Error ? caught.message : "安全案件写入失败");
      return null;
    } finally {
      setMutationBusy(false);
    }
  }, [applyRateLimit, ensureWritable, mutationBusy, onRequestUnlock, token]);

  const reloadAfterMutation = useCallback(async (caseId: string) => {
    setActionPreview(null);
    await Promise.all([loadList(true), loadDetail(caseId)]);
  }, [loadDetail, loadList]);

  const claimCase = async () => {
    if (!selectedCase || reason.trim().length < 3) {
      setOperationError("请填写至少 3 个字符的操作原因");
      return;
    }
    const payload = await writeRequest(
      `${endpoint}/${encodeURIComponent(selectedCase.id)}`,
      "PATCH",
      { operation: "claim", expectedRevision: selectedCase.revision, reason: reason.trim() },
      createSecurityCaseRequestKey("case-claim", selectedCase.id),
    );
    if (!payload) return;
    setOperationNotice("案件已认领；状态与审计记录已从控制面重新读取");
    setReason("");
    await reloadAfterMutation(selectedCase.id);
  };

  const transitionCase = async () => {
    if (!selectedCase || !transitionTarget || reason.trim().length < 3) {
      setOperationError("请选择允许的目标状态，并填写至少 3 个字符的原因");
      return;
    }
    const payload = await writeRequest(
      `${endpoint}/${encodeURIComponent(selectedCase.id)}`,
      "PATCH",
      { operation: "transition", expectedRevision: selectedCase.revision, targetStatus: transitionTarget, reason: reason.trim() },
      createSecurityCaseRequestKey("case-transition", selectedCase.id),
    );
    if (!payload) return;
    setOperationNotice(`案件状态已更新为“${SECURITY_CASE_STATUS_LABELS[transitionTarget]}”`);
    setReason("");
    setTransitionTarget("");
    await reloadAfterMutation(selectedCase.id);
  };

  const linkEntity = async () => {
    if (!selectedCase || entityRef.trim().length < 1 || reason.trim().length < 3) {
      setOperationError("请填写实体引用和至少 3 个字符的操作原因");
      return;
    }
    const payload = await writeRequest(
      `${endpoint}/${encodeURIComponent(selectedCase.id)}`,
      "PATCH",
      {
        operation: "link-entity",
        expectedRevision: selectedCase.revision,
        entityType,
        entityRef: entityRef.trim(),
        entityLabel: entityLabel.trim(),
        reason: reason.trim(),
      },
      createSecurityCaseRequestKey("case-link", selectedCase.id),
    );
    if (!payload) return;
    setOperationNotice("实体已关联；新的证据关系与审计记录已重新读取");
    setEntityRef("");
    setEntityLabel("");
    setReason("");
    await reloadAfterMutation(selectedCase.id);
  };

  const previewAction = async () => {
    if (!selectedCase || !selectedActionLink || reason.trim().length < 3) {
      setOperationError("请选择案件已关联的用户或会话，并填写至少 3 个字符的申请原因");
      return;
    }
    const actionType = actionTypeForLink(selectedActionLink);
    const payload = await writeRequest(
      `${endpoint}/${encodeURIComponent(selectedCase.id)}/actions`,
      "POST",
      {
        operation: "preview",
        expectedRevision: selectedCase.revision,
        actionType,
        targetRef: selectedActionLink.entity_ref,
        reason: reason.trim(),
      },
      createSecurityCaseRequestKey("action-preview", selectedCase.id),
    );
    if (!payload || !isSecurityCaseActionPreview(payload.preview)) {
      if (payload) setOperationError("处置影响预演响应合同不完整，本次结果未采用");
      return;
    }
    setActionPreview(payload.preview);
    setOperationNotice("影响预演完成；尚未保存请求，也没有执行任何处置");
  };

  const requestAction = async () => {
    if (!selectedCase || !selectedActionLink || !actionPreview || reason.trim().length < 3) {
      setOperationError("必须先完成当前目标的影响预演");
      return;
    }
    if (actionPreview.targetRef !== selectedActionLink.entity_ref || actionPreview.executorStatus !== "unavailable") {
      setOperationError("影响预演已失效，请重新预演");
      setActionPreview(null);
      return;
    }
    const actionType = actionTypeForLink(selectedActionLink);
    const payload = await writeRequest(
      `${endpoint}/${encodeURIComponent(selectedCase.id)}/actions`,
      "POST",
      {
        operation: "request",
        expectedRevision: selectedCase.revision,
        actionType,
        targetRef: selectedActionLink.entity_ref,
        reason: reason.trim(),
      },
      createSecurityCaseRequestKey("action-request", selectedCase.id),
    );
    if (!payload) return;
    const boundary = isRecord(payload.boundary) ? payload.boundary : {};
    if (boundary.executed !== false || boundary.status !== "pending_executor") {
      setOperationError("服务端未返回“待执行且未执行”边界，本次结果未采信");
      return;
    }
    setOperationNotice("待执行处置请求已保存；执行器未接入，没有停用账号或撤销会话");
    setReason("");
    await reloadAfterMutation(selectedCase.id);
  };

  const cancelAction = async (action: SecurityCaseAction) => {
    if (!selectedCase || reason.trim().length < 3) {
      setOperationError("取消待执行请求前，请填写至少 3 个字符的操作原因");
      return;
    }
    const payload = await writeRequest(
      `${endpoint}/${encodeURIComponent(selectedCase.id)}/actions`,
      "POST",
      {
        operation: "cancel",
        actionId: action.id,
        expectedActionRevision: action.revision,
        reason: reason.trim(),
      },
      createSecurityCaseRequestKey("action-cancel", selectedCase.id),
    );
    if (!payload) return;
    setOperationNotice("待执行处置请求已取消；审计记录已重新读取");
    setReason("");
    await reloadAfterMutation(selectedCase.id);
  };

  return (
    <section
      className={`${styles.workbench} ${className}`.trim()}
      aria-labelledby={`${instanceId}-title`}
      data-testid="security-case-workbench"
      data-read-state={pauseReason ? "paused" : listLoading || detailLoading ? "loading" : "ready"}
      data-executor="unavailable"
    >
      <header className={styles.header}>
        <div>
          <div className={styles.titleRow}>
            <h3 id={`${instanceId}-title`}>安全案件工作台</h3>
            <span className={styles.schemaBadge}>security-case/v1</span>
            <span className={styles.executorBadge}>执行器未接入</span>
          </div>
          <p>从真实安全事实聚合案件，按版本认领和流转，并把证据、实体与审计记录放在同一条调查链上。</p>
        </div>
        <button
          type="button"
          className={styles.refreshButton}
          onClick={() => void refreshAll(false)}
          disabled={!readsAvailable || coolingDown || listLoading || detailLoading}
        >
          {!readsAvailable ? "读取已暂停" : listLoading || detailLoading ? "刷新中…" : coolingDown ? "刷新冷却中" : "刷新案件快照"}
        </button>
      </header>

      <div className={styles.boundaryBanner} role="status">
        <strong>处置边界：</strong>当前只能影响预演、保存或取消 <code>pending_executor</code> 请求；不会自动停用账号，也不会撤销会话。
      </div>
      {pauseReason && <div className={styles.pauseNotice} role="status">{pauseReason}；恢复可见且联网后才会继续读取。</div>}
      {listError && <div className={styles.errorNotice} role="alert">{listError}</div>}

      <div className={styles.toolbar} aria-label="案件筛选">
        <label>
          <span>状态</span>
          <select value={filters.status} onChange={(event) => { setPage(1); setFilters((current) => ({ ...current, status: event.target.value as Filters["status"] })); }}>
            <option value="">全部状态</option>
            {Object.entries(SECURITY_CASE_STATUS_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
        <label>
          <span>风险</span>
          <select value={filters.riskLevel} onChange={(event) => { setPage(1); setFilters((current) => ({ ...current, riskLevel: event.target.value as Filters["riskLevel"] })); }}>
            <option value="">全部风险</option>
            {Object.entries(SECURITY_CASE_RISK_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
        <label className={styles.assigneeFilter}>
          <span>负责人 ID（精确）</span>
          <input
            value={assigneeDraft}
            onChange={(event) => setAssigneeDraft(event.target.value)}
            onBlur={() => { setPage(1); setFilters((current) => ({ ...current, assignedTo: assigneeDraft.trim() })); }}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return;
              setPage(1);
              setFilters((current) => ({ ...current, assignedTo: assigneeDraft.trim() }));
            }}
            placeholder="留空查看全部"
            maxLength={200}
          />
        </label>
        <div className={styles.toolbarMeta}>
          <span>共 {listSnapshot?.total ?? "—"} 个案件</span>
          <span>自动刷新 {SECURITY_CASE_AUTO_REFRESH_MS / 1_000} 秒</span>
          <span>服务端单进程门禁 {listSnapshot?.rateLimit.windowSeconds ?? 10} 秒/查询</span>
          <span>快照 {listSnapshot ? formatTime(listSnapshot.asOf) : "尚未读取"}</span>
          <span>新鲜度 {listSnapshot ? `${listSnapshot.freshnessSeconds} 秒` : "—"}</span>
          <span>缓存 {listSnapshot?.cacheStatus || "—"}</span>
        </div>
      </div>

      <div className={styles.workspaceGrid}>
        <aside className={styles.caseRail} aria-label="安全案件列表">
          <div className={styles.railHeading}>
            <strong>案件队列</strong>
            <span>第 {page}/{totalPages} 页</span>
          </div>
          <div className={styles.caseList}>
            {!listLoading && (listSnapshot?.cases.length || 0) === 0 && (
              <div className={styles.emptyState}>当前筛选下没有案件。这里不会用示例数据填充。</div>
            )}
            {listSnapshot?.cases.map((item) => (
              <button
                key={item.id}
                type="button"
                className={`${styles.caseCard} ${selectedCaseId === item.id ? styles.caseCardActive : ""}`.trim()}
                aria-pressed={selectedCaseId === item.id}
                onClick={() => setSelectedCaseId(item.id)}
              >
                <span className={styles.caseCardTop}>
                  <span className={`${styles.riskBadge} ${styles[`risk_${item.risk_level}`]}`}>{SECURITY_CASE_RISK_LABELS[item.risk_level]} · {item.risk_score}</span>
                  <span className={styles.statusBadge}>{SECURITY_CASE_STATUS_LABELS[item.status]}</span>
                </span>
                <strong>{item.title}</strong>
                <span className={styles.caseSummary}>{item.summary}</span>
                <span className={styles.caseMeta}>事件 {item.event_count} · 最近 {formatTime(item.last_seen_at)}</span>
                <span className={styles.caseMeta}>负责人：{shortReference(item.assigned_to)}</span>
              </button>
            ))}
          </div>
          <div className={styles.pagination}>
            <button type="button" onClick={() => setPage((current) => Math.max(1, current - 1))} disabled={page <= 1 || listLoading}>上一页</button>
            <span>{page} / {totalPages}</span>
            <button type="button" onClick={() => setPage((current) => Math.min(totalPages, current + 1))} disabled={page >= totalPages || listLoading}>下一页</button>
          </div>
        </aside>

        <main className={styles.detailSurface} key={selectedCaseId || "empty"} aria-live="polite">
          {!selectedCaseId && <div className={styles.emptyDetail}>选择一个案件查看真实证据链。</div>}
          {selectedCaseId && detailLoading && !currentDetail && <div className={styles.emptyDetail}>正在读取案件详情…</div>}
          {detailError && <div className={styles.errorNotice} role="alert">{detailError}</div>}
          {currentDetail && selectedCase && (
            <>
              <section className={styles.caseHeader}>
                <div>
                  <div className={styles.titleRow}>
                    <span className={`${styles.riskBadge} ${styles[`risk_${selectedCase.risk_level}`]}`}>{SECURITY_CASE_RISK_LABELS[selectedCase.risk_level]} · {selectedCase.risk_score}</span>
                    <span className={styles.statusBadge}>{SECURITY_CASE_STATUS_LABELS[selectedCase.status]}</span>
                    <span className={styles.revisionBadge}>rev {selectedCase.revision}</span>
                  </div>
                  <h4>{selectedCase.title}</h4>
                  <p>{selectedCase.summary}</p>
                </div>
                <dl className={styles.caseFacts}>
                  <div><dt>案件 ID</dt><dd title={selectedCase.id}>{shortReference(selectedCase.id, 10, 8)}</dd></div>
                  <div><dt>负责人</dt><dd title={selectedCase.assigned_to || undefined}>{shortReference(selectedCase.assigned_to, 10, 8)}</dd></div>
                  <div><dt>首次发现</dt><dd>{formatTime(selectedCase.first_seen_at)}</dd></div>
                  <div><dt>最近发生</dt><dd>{formatTime(selectedCase.last_seen_at)}</dd></div>
                </dl>
              </section>

              {operationError && <div className={styles.errorNotice} role="alert">{operationError}</div>}
              {operationNotice && <div className={styles.successNotice} role="status">{operationNotice}</div>}

              {canManage && (
                <section className={styles.controlPanel} aria-labelledby={`${instanceId}-controls`}>
                  <div className={styles.sectionHeading}>
                    <div><h4 id={`${instanceId}-controls`}>案件控制</h4><p>所有写操作要求 security.manage、二次验证和当前 revision。</p></div>
                    {!stepUpReady && <button type="button" className={styles.unlockButton} onClick={onRequestUnlock}>解锁敏感操作</button>}
                  </div>
                  <label className={styles.reasonField}>
                    <span>本次操作原因</span>
                    <input value={reason} onChange={(event) => setReason(event.target.value)} maxLength={500} placeholder="至少 3 个字符，将进入不可变审计" />
                  </label>
                  <div className={styles.controlRows}>
                    {selectedCase.status === "triaged" && !selectedCase.assigned_to && (
                      <div className={styles.controlRow}>
                        <div><strong>认领案件</strong><span>将案件分配给当前管理员并进入“已认领”。</span></div>
                        <button type="button" onClick={() => void claimCase()} disabled={!stepUpReady || mutationBusy}>认领</button>
                      </div>
                    )}
                    {transitions.length > 0 && (
                      <div className={styles.controlRow}>
                        <div><strong>状态流转</strong><span>只显示数据库状态机允许的下一步。</span></div>
                        <select value={transitionTarget} onChange={(event) => setTransitionTarget(event.target.value as SecurityCaseStatus)}>
                          <option value="">选择目标状态</option>
                          {transitions.map((status) => <option key={status} value={status}>{SECURITY_CASE_STATUS_LABELS[status]}</option>)}
                        </select>
                        <button type="button" onClick={() => void transitionCase()} disabled={!stepUpReady || !transitionTarget || mutationBusy}>确认流转</button>
                      </div>
                    )}
                    <div className={styles.controlRow}>
                      <div><strong>关联调查实体</strong><span>实体关系会进入证据链；敏感值应使用稳定哈希或内部 ID。</span></div>
                      <select value={entityType} onChange={(event) => setEntityType(event.target.value as SecurityCaseEntityType)}>
                        {Object.entries(SECURITY_CASE_ENTITY_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                      </select>
                      <input value={entityRef} onChange={(event) => setEntityRef(event.target.value)} maxLength={200} placeholder="实体引用" />
                      <input value={entityLabel} onChange={(event) => setEntityLabel(event.target.value)} maxLength={120} placeholder="可选标签" />
                      <button type="button" onClick={() => void linkEntity()} disabled={!stepUpReady || mutationBusy || !entityRef.trim()}>关联</button>
                    </div>
                  </div>
                </section>
              )}

              <div className={styles.detailGrid}>
                <section className={styles.detailCard} aria-labelledby={`${instanceId}-events`}>
                  <div className={styles.sectionHeading}><div><h4 id={`${instanceId}-events`}>证据时间线</h4><p>{currentDetail.events.length} 条关联事实</p></div></div>
                  <ol className={styles.timeline}>
                    {currentDetail.events.length === 0 && <li className={styles.emptyState}>没有可展示的案件证据。</li>}
                    {currentDetail.events.map((event) => (
                      <li key={event.id}>
                        <span className={styles.timelineDot} aria-hidden="true" />
                        <div className={styles.timelineTop}><strong>{event.event_type}</strong><time>{formatTime(event.occurred_at)}</time></div>
                        <p>{event.summary}</p>
                        <div className={styles.inlineMeta}>{SECURITY_CASE_SOURCE_LABELS[event.source_kind]} · 风险 {event.risk_score} · 来源 ID {shortReference(event.source_event_id)}</div>
                        {event.evidence && (
                          <dl className={styles.evidenceGrid}>
                            {Object.entries(event.evidence).slice(0, 12).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{readableValue(value)}</dd></div>)}
                          </dl>
                        )}
                      </li>
                    ))}
                  </ol>
                </section>

                <section className={styles.detailCard} aria-labelledby={`${instanceId}-entities`}>
                  <div className={styles.sectionHeading}><div><h4 id={`${instanceId}-entities`}>关联实体</h4><p>{currentDetail.links.length} 条调查关系</p></div></div>
                  <ul className={styles.entityList}>
                    {currentDetail.links.length === 0 && <li className={styles.emptyState}>尚未建立实体关系。</li>}
                    {currentDetail.links.map((link) => (
                      <li key={link.id}>
                        <span className={styles.entityBadge}>{SECURITY_CASE_ENTITY_LABELS[link.entity_type]}</span>
                        <div><strong>{link.entity_label || "未命名实体"}</strong><code title={link.entity_ref}>{shortReference(link.entity_ref, 12, 8)}</code></div>
                        <time>{formatTime(link.linked_at)}</time>
                      </li>
                    ))}
                  </ul>
                </section>
              </div>

              <section className={styles.actionPanel} aria-labelledby={`${instanceId}-actions`}>
                <div className={styles.sectionHeading}>
                  <div><h4 id={`${instanceId}-actions`}>待执行处置队列</h4><p>{pendingActions.length} 条待执行 · executor unavailable</p></div>
                  <span className={styles.executorBadge}>不会自动执行</span>
                </div>
                {canManage && (
                  <div className={styles.actionComposer}>
                    <label>
                      <span>案件已关联目标</span>
                      <select value={actionLinkId} onChange={(event) => setActionLinkId(event.target.value)}>
                        <option value="">选择用户或会话</option>
                        {actionableLinks.map((link) => <option key={link.id} value={link.id}>{actionTargetLabel(link)}</option>)}
                      </select>
                    </label>
                    <div className={styles.actionIntent}>
                      {selectedActionLink ? SECURITY_CASE_ACTION_LABELS[actionTypeForLink(selectedActionLink)] : "先选择目标"}
                    </div>
                    <button type="button" onClick={() => void previewAction()} disabled={!stepUpReady || mutationBusy || !selectedActionLink || reason.trim().length < 3}>影响预演</button>
                    <button type="button" className={styles.pendingButton} onClick={() => void requestAction()} disabled={!stepUpReady || mutationBusy || !actionPreview}>创建待执行请求</button>
                  </div>
                )}
                {actionPreview && (
                  <div className={styles.previewCard} data-testid="security-case-action-preview">
                    <strong>影响预演 · 未保存 · 未执行</strong>
                    <span>目标状态：{actionPreview.currentState}</span>
                    <span>最多影响：{actionPreview.affectedRowsMax} 行</span>
                    <span>执行器：不可用</span>
                    <ul>{actionPreview.notes.map((note) => <li key={note}>{note}</li>)}</ul>
                  </div>
                )}
                <div className={styles.actionQueue}>
                  {currentDetail.actions.length === 0 && <div className={styles.emptyState}>没有处置请求。工作台不会伪造执行记录。</div>}
                  {currentDetail.actions.map((action) => (
                    <article key={action.id}>
                      <div className={styles.actionTop}>
                        <div><strong>{SECURITY_CASE_ACTION_LABELS[action.action_type]}</strong><span>{securityCaseActionStatusLabel(action.status)}</span></div>
                        <time>{formatTime(action.requested_at)}</time>
                      </div>
                      <p>{action.reason}</p>
                      <div className={styles.inlineMeta}>目标：{action.target_type} · {shortReference(action.target_ref, 12, 8)} · revision {action.revision}</div>
                      <div className={styles.actionBoundary}>{actionBoundary(action)}</div>
                      {canManage && action.status === "pending_executor" && (
                        <button type="button" className={styles.cancelButton} onClick={() => void cancelAction(action)} disabled={!stepUpReady || mutationBusy || reason.trim().length < 3}>取消待执行请求</button>
                      )}
                    </article>
                  ))}
                </div>
              </section>

              <section className={styles.auditPanel} aria-labelledby={`${instanceId}-audit`}>
                <div className={styles.sectionHeading}><div><h4 id={`${instanceId}-audit`}>不可变审计时间线</h4><p>{currentDetail.audit.length} 条控制面记录</p></div></div>
                <ol className={styles.auditList}>
                  {currentDetail.audit.length === 0 && <li className={styles.emptyState}>暂无审计记录。</li>}
                  {currentDetail.audit.map((entry) => (
                    <li key={String(entry.id)}>
                      <time>{formatTime(entry.created_at)}</time>
                      <strong>{entry.event_type}</strong>
                      <span>{entry.from_status ? SECURITY_CASE_STATUS_LABELS[entry.from_status] : "—"} → {entry.to_status ? SECURITY_CASE_STATUS_LABELS[entry.to_status] : "—"}</span>
                      <p>{entry.reason || entry.reason_code}</p>
                      <code title={entry.actor_id || undefined}>操作者 {shortReference(entry.actor_id)}</code>
                    </li>
                  ))}
                </ol>
              </section>
            </>
          )}
        </main>
      </div>
    </section>
  );
}

export default SecurityCaseWorkbench;
