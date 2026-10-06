import {
  parseGeneralScriptRequest,
  parseGeneralScriptResult,
  type GeneralScriptRequest,
  type GeneralScriptResult,
} from "./general-script-contract";
import type { ShortDramaDatabase } from "./permissions";

const SCRIPT_REQUEST_LIST_SELECT = [
  "id", "user_id", "client_request_id", "request_hash",
  "surface", "profile_id", "display_title", "episode_count", "state", "result_hash",
  "billing_snapshot", "error_code", "error_message", "submitted_at",
  "updated_at", "completed_at",
].join(",");

const SCRIPT_REQUEST_DETAIL_SELECT = `${SCRIPT_REQUEST_LIST_SELECT},request_snapshot,result_payload`;

const LLM_ATTEMPT_SELECT = [
  "record_id", "client_request_id", "state", "provider_call_started_at",
  "error_code", "created_at", "updated_at",
].join(",");

const SURFACE_PATTERN = /^[a-z0-9_-]{1,40}$/u;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

export type GeneralScriptHistorySurface = "general" | "formal" | "youcai" | "api";
export type GeneralScriptHistoryState =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "reconciliation_required";

export interface GeneralScriptHistoryItem {
  id: string;
  clientRequestId: string;
  surface: string;
  profileId: string;
  title: string;
  episodeCount: number | null;
  hasResult: boolean;
  state: GeneralScriptHistoryState;
  retrySafe: boolean;
  billingState: "pending" | "settled" | "not_charged" | "refunded" | "reconciliation_required";
  creditsCharged: number | null;
  projectHref?: string;
  requestSnapshot?: GeneralScriptRequest;
  result?: GeneralScriptResult;
  errorMessage?: string;
  submittedAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface GeneralScriptHistoryPage {
  items: GeneralScriptHistoryItem[];
  total: number;
  offset: number;
  limit: number;
  nextOffset: number | null;
}

interface ScriptRequestRow {
  id: unknown;
  user_id: unknown;
  client_request_id: unknown;
  request_hash: unknown;
  request_snapshot: unknown;
  surface: unknown;
  profile_id: unknown;
  display_title: unknown;
  episode_count: unknown;
  state: unknown;
  result_payload: unknown;
  result_hash: unknown;
  billing_snapshot: unknown;
  error_code: unknown;
  error_message: unknown;
  submitted_at: unknown;
  updated_at: unknown;
  completed_at: unknown;
}

interface LlmAttemptRow {
  record_id: unknown;
  client_request_id: unknown;
  state: unknown;
  provider_call_started_at: unknown;
  error_code: unknown;
  created_at: unknown;
  updated_at: unknown;
}

interface WalletOperationRow {
  idempotency_key: unknown;
  status: unknown;
  amount: unknown;
}

interface ProjectRow {
  id: unknown;
  client_request_id: unknown;
}

export interface GeneralScriptRequestClaimRecord {
  id: string;
  state: "submitted" | "succeeded" | "failed" | "reconciliation_required";
  result: GeneralScriptResult | null;
  billingSnapshot: Record<string, unknown>;
}

export interface GeneralScriptRequestClaim {
  action: "execute" | "resume" | "replay" | "failed" | "reconciliation_required";
  record: GeneralScriptRequestClaimRecord;
}

export class GeneralScriptHistoryError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 503,
  ) {
    super(message);
    this.name = "GeneralScriptHistoryError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function databaseDiagnostic(error: unknown): string {
  if (!isRecord(error)) return String(error || "");
  return [error.code, error.message, error.details, error.hint].map(String).join(" ");
}

function mapDatabaseError(error: unknown): never {
  const diagnostic = databaseDiagnostic(error);
  if (/short_drama_script_requests|claim_short_drama_script_request_atomic|finalize_short_drama_script_request_atomic|PGRST20[245]|42P01|42883|schema cache|does not exist|could not find/iu.test(diagnostic)) {
    throw new GeneralScriptHistoryError(
      "GENERAL_SCRIPT_HISTORY_MIGRATION_NOT_READY",
      "剧本任务历史服务正在准备中，本次未提交生成或产生费用。",
    );
  }
  if (/SHORT_DRAMA_SCRIPT_REQUEST_CONFLICT|SHORT_DRAMA_SCRIPT_TERMINAL_CONFLICT/iu.test(diagnostic)) {
    throw new GeneralScriptHistoryError(
      "GENERAL_SCRIPT_HISTORY_REQUEST_CONFLICT",
      "同一请求编号已绑定其他剧本内容，请重新确认后提交。",
      409,
    );
  }
  throw new GeneralScriptHistoryError(
    "GENERAL_SCRIPT_HISTORY_UNAVAILABLE",
    "剧本任务历史暂时不可用，本次未调用模型也未扣费。",
  );
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function billingRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function parseClaimRecord(value: unknown): GeneralScriptRequestClaimRecord {
  if (!isRecord(value)) {
    throw new GeneralScriptHistoryError("GENERAL_SCRIPT_HISTORY_RECEIPT_INVALID", "剧本任务占位回执无效。", 503);
  }
  const state = stringValue(value.state);
  if (!["submitted", "succeeded", "failed", "reconciliation_required"].includes(state)) {
    throw new GeneralScriptHistoryError("GENERAL_SCRIPT_HISTORY_RECEIPT_INVALID", "剧本任务占位状态无效。", 503);
  }
  let result: GeneralScriptResult | null = null;
  if (state === "succeeded") {
    try {
      result = parseGeneralScriptResult(value.result_payload);
    } catch {
      throw new GeneralScriptHistoryError("GENERAL_SCRIPT_HISTORY_RECEIPT_INVALID", "已保存的剧本结果未通过结构校验。", 503);
    }
  }
  return {
    id: stringValue(value.id),
    state: state as GeneralScriptRequestClaimRecord["state"],
    result,
    billingSnapshot: billingRecord(value.billing_snapshot),
  };
}

function parseRpcEnvelope(value: unknown): GeneralScriptRequestClaim {
  if (!isRecord(value)) {
    throw new GeneralScriptHistoryError("GENERAL_SCRIPT_HISTORY_RECEIPT_INVALID", "剧本任务占位回执无效。", 503);
  }
  const action = stringValue(value.action);
  if (!["execute", "resume", "replay", "failed", "reconciliation_required"].includes(action)) {
    throw new GeneralScriptHistoryError("GENERAL_SCRIPT_HISTORY_RECEIPT_INVALID", "剧本任务占位动作无效。", 503);
  }
  return {
    action: action as GeneralScriptRequestClaim["action"],
    record: parseClaimRecord(value.record),
  };
}

function isoValue(value: unknown): string {
  const text = stringValue(value);
  const time = Date.parse(text);
  return Number.isFinite(time) ? new Date(time).toISOString() : "1970-01-01T00:00:00.000Z";
}

function optionalIsoValue(value: unknown): string | null {
  return typeof value === "string" && Number.isFinite(Date.parse(value))
    ? new Date(value).toISOString()
    : null;
}

function safeErrorMessage(state: GeneralScriptHistoryState, rowMessage: unknown): string | undefined {
  const stored = stringValue(rowMessage).trim();
  if (stored) return stored.slice(0, 240);
  if (state === "failed") return "本次生成明确未完成且未扣费，可载入原参数后手动重新提交。";
  if (state === "reconciliation_required") return "任务执行或账务终态尚未确认，请勿重复提交。";
  return undefined;
}

function historyTitle(request: GeneralScriptRequest | null, result: GeneralScriptResult | null): string {
  const title = result?.summary.title.trim() || request?.content.title.trim();
  if (title) return title.slice(0, 80);
  const brief = request?.content.brief.trim() || request?.content.requirements.trim() || "";
  return brief ? brief.replace(/\s+/gu, " ").slice(0, 40) : "未命名剧本";
}

function requestDisplayTitle(request: GeneralScriptRequest): string {
  return historyTitle(request, null).slice(0, 120);
}

export function deriveGeneralScriptHistoryState(input: {
  outerState: string;
  attemptState: string;
  billingState: string;
  walletSettled: boolean;
  hasValidResult: boolean;
}): GeneralScriptHistoryState {
  if (input.outerState === "succeeded") {
    return input.hasValidResult && input.attemptState === "succeeded" && input.billingState === "settled"
      ? "succeeded"
      : "reconciliation_required";
  }
  if (input.walletSettled && input.billingState !== "refunded") return "reconciliation_required";
  if (input.outerState === "reconciliation_required") {
    // The inner LLM attempt is the provider-boundary authority. A definitive
    // failed attempt, or no attempt at all, proves no provider result was
    // delivered and no wallet operation was completed.
    if (!input.attemptState || input.attemptState === "failed") return "failed";
    return "reconciliation_required";
  }
  if (input.outerState === "failed" && input.billingState === "refunded") return "failed";
  if (["failed_unknown", "reconciliation_required"].includes(input.attemptState)) return "reconciliation_required";
  if (input.outerState === "failed") return "failed";
  if (input.attemptState === "failed") return "failed";
  if (input.attemptState === "running") return "running";
  if (input.attemptState === "succeeded") return "reconciliation_required";
  return "queued";
}

export function normalizeGeneralScriptHistorySurface(value: string | null | undefined): string {
  const surface = (value || "api").trim().toLowerCase();
  return SURFACE_PATTERN.test(surface) ? surface : "api";
}

export class GeneralScriptHistoryRepository {
  constructor(private readonly db: ShortDramaDatabase) {}

  async claim(input: {
    userId: string;
    clientRequestId: string;
    requestHash: string;
    requestSnapshot: GeneralScriptRequest;
    surface: string;
  }): Promise<GeneralScriptRequestClaim> {
    if (!REQUEST_ID_PATTERN.test(input.clientRequestId) || !SHA256_PATTERN.test(input.requestHash)) {
      throw new GeneralScriptHistoryError("GENERAL_SCRIPT_HISTORY_INPUT_INVALID", "剧本请求编号或摘要无效。", 400);
    }
    const { data, error } = await this.db.rpc("claim_short_drama_script_request_atomic", {
      p_user_id: input.userId,
      p_client_request_id: input.clientRequestId,
      p_request_hash: input.requestHash,
      p_request_snapshot: input.requestSnapshot,
      p_surface: normalizeGeneralScriptHistorySurface(input.surface),
      p_profile_id: input.requestSnapshot.profile.id,
      p_display_title: requestDisplayTitle(input.requestSnapshot),
    });
    if (error) mapDatabaseError(error);
    return parseRpcEnvelope(data);
  }

  async finalize(input: {
    userId: string;
    clientRequestId: string;
    requestHash: string;
    state: "succeeded" | "failed" | "reconciliation_required";
    result?: GeneralScriptResult;
    resultHash?: string;
    billingSnapshot: Record<string, unknown>;
    errorCode?: string;
    errorMessage?: string;
  }): Promise<void> {
    const { data, error } = await this.db.rpc("finalize_short_drama_script_request_atomic", {
      p_user_id: input.userId,
      p_client_request_id: input.clientRequestId,
      p_request_hash: input.requestHash,
      p_state: input.state,
      p_result_payload: input.result || null,
      p_result_hash: input.resultHash || null,
      p_billing_snapshot: input.billingSnapshot,
      p_display_title: input.result?.summary.title.trim().slice(0, 120) || null,
      p_episode_count: input.result?.episodes.length || null,
      p_error_code: input.errorCode || null,
      p_error_message: input.errorMessage || null,
    });
    if (error) mapDatabaseError(error);
    if (!isRecord(data) || !isRecord(data.record) || data.record.state !== input.state) {
      throw new GeneralScriptHistoryError("GENERAL_SCRIPT_HISTORY_RECEIPT_INVALID", "剧本任务终态回执无效。", 503);
    }
  }

  async list(input: {
    userId: string;
    surface: string;
    profileId?: string;
    offset: number;
    limit: number;
    id?: string;
  }): Promise<GeneralScriptHistoryPage> {
    let query = this.db
      .from("short_drama_script_requests")
      .select(input.id ? SCRIPT_REQUEST_DETAIL_SELECT : SCRIPT_REQUEST_LIST_SELECT, { count: "exact" })
      .eq("user_id", input.userId)
      .eq("surface", normalizeGeneralScriptHistorySurface(input.surface))
      .order("submitted_at", { ascending: false })
      .order("id", { ascending: false });
    if (input.profileId) query = query.eq("profile_id", input.profileId);
    if (input.id) query = query.eq("id", input.id);
    const { data, error, count } = await query.range(input.offset, input.offset + input.limit - 1);
    if (error) mapDatabaseError(error);
    const rows = (data || []) as ScriptRequestRow[];
    const clientRequestIds = rows.map((row) => stringValue(row.client_request_id)).filter(Boolean);

    const attemptByRequestId = new Map<string, LlmAttemptRow>();
    const chargedKeys = new Set<string>();
    const chargedTotalByRequestId = new Map<string, number>();
    const projectByRequestId = new Map<string, string>();
    if (clientRequestIds.length > 0) {
      const [attemptResult, walletResult, projectResult] = await Promise.all([
        this.db
          .from("llm_request_attempts")
          .select(LLM_ATTEMPT_SELECT)
          .eq("user_id", input.userId)
          .in("client_request_id", clientRequestIds),
        this.db
          .from("wallet_operations")
          .select("idempotency_key,status,amount")
          .eq("user_id", input.userId)
          .eq("operation_kind", "credit_charge")
          .in("idempotency_key", clientRequestIds.flatMap((id) => [
            `llm:${id}:thinking`,
            `llm:${id}:answer`,
          ])),
        this.db
          .from("short_drama_projects")
          .select("id,client_request_id")
          .eq("user_id", input.userId)
          .is("deleted_at", null)
          .in("client_request_id", clientRequestIds),
      ]);
      if (attemptResult.error) mapDatabaseError(attemptResult.error);
      if (walletResult.error) mapDatabaseError(walletResult.error);
      if (projectResult.error) mapDatabaseError(projectResult.error);
      for (const attempt of (attemptResult.data || []) as LlmAttemptRow[]) {
        attemptByRequestId.set(stringValue(attempt.client_request_id), attempt);
      }
      for (const operation of (walletResult.data || []) as WalletOperationRow[]) {
        if (operation.status !== "completed") continue;
        const operationKey = stringValue(operation.idempotency_key);
        chargedKeys.add(operationKey);
        const match = operationKey.match(/^llm:(.+):(thinking|answer)$/u);
        const amount = Number(operation.amount);
        if (match && Number.isFinite(amount) && amount > 0) {
          chargedTotalByRequestId.set(match[1], (chargedTotalByRequestId.get(match[1]) || 0) + amount);
        }
      }
      for (const project of (projectResult.data || []) as ProjectRow[]) {
        const projectId = stringValue(project.id);
        if (projectId) projectByRequestId.set(stringValue(project.client_request_id), projectId);
      }
    }

    const items = rows.map((row): GeneralScriptHistoryItem => {
      let request: GeneralScriptRequest | null = null;
      let result: GeneralScriptResult | null = null;
      try { request = parseGeneralScriptRequest(row.request_snapshot); } catch { request = null; }
      try { result = row.result_payload ? parseGeneralScriptResult(row.result_payload) : null; } catch { result = null; }
      const clientRequestId = stringValue(row.client_request_id);
      const attempt = attemptByRequestId.get(clientRequestId);
      const billing = billingRecord(row.billing_snapshot);
      const storedBillingState = stringValue(billing.state);
      const walletSettled = chargedKeys.has(`llm:${clientRequestId}:answer`)
        || chargedKeys.has(`llm:${clientRequestId}:thinking`);
      const chargedTotal = chargedTotalByRequestId.get(clientRequestId) || 0;
      const projectId = projectByRequestId.get(clientRequestId);
      const storedHasResult = SHA256_PATTERN.test(stringValue(row.result_hash))
        && Number(row.episode_count) > 0;
      const state = deriveGeneralScriptHistoryState({
        outerState: stringValue(row.state),
        attemptState: stringValue(attempt?.state),
        billingState: storedBillingState,
        walletSettled,
        hasValidResult: Boolean(result) || (!input.id && storedHasResult),
      });
      const retrySafe = state === "failed"
        && (!walletSettled || storedBillingState === "refunded")
        && (input.id ? Boolean(request) : SHA256_PATTERN.test(stringValue(row.request_hash)));
      const credits = Number(billing.creditsCharged);
      const episodeCount = Number(row.episode_count);
      const hasResult = state === "succeeded" && storedHasResult;
      return {
        id: stringValue(row.id),
        clientRequestId,
        surface: stringValue(row.surface),
        profileId: stringValue(row.profile_id),
        title: stringValue(row.display_title) || historyTitle(request, result),
        episodeCount: Number.isInteger(episodeCount) && episodeCount > 0 ? episodeCount : null,
        hasResult,
        state,
        retrySafe,
        billingState: state === "succeeded"
          ? "settled"
          : state === "failed"
            ? storedBillingState === "refunded" ? "refunded" : "not_charged"
            : state === "reconciliation_required"
              ? "reconciliation_required"
              : "pending",
        creditsCharged: state === "succeeded"
          ? chargedTotal > 0
            ? Number(chargedTotal.toFixed(6))
            : Number.isFinite(credits) && credits >= 0 ? credits : null
          : null,
        ...(projectId
          ? { projectHref: `/tools/film-studio/projects/${encodeURIComponent(projectId)}?step=script` }
          : {}),
        ...(retrySafe && request ? { requestSnapshot: request } : {}),
        ...(state === "succeeded" && result ? { result } : {}),
        ...(safeErrorMessage(state, row.error_message) ? { errorMessage: safeErrorMessage(state, row.error_message) } : {}),
        submittedAt: isoValue(row.submitted_at),
        updatedAt: isoValue(attempt?.updated_at || row.updated_at),
        completedAt: optionalIsoValue(row.completed_at),
      };
    });

    const total = Number(count || 0);
    const nextOffset = input.offset + rows.length < total ? input.offset + rows.length : null;
    return { items, total, offset: input.offset, limit: input.limit, nextOffset };
  }
}
