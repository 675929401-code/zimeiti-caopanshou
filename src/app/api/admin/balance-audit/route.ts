/**
 * Balance audit query — administrator only.
 *
 * Raw database source codes remain visible, while the response adds a stable
 * Chinese business taxonomy, account identity, exact-event IP provenance and
 * a separately labelled most-recent-login IP. A login IP is never presented
 * as the IP of a historical balance change.
 */
import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdminClient } from "@/storage/database/supabase-client";
import { getTokenFromHeaders } from "@/lib/auth";
import { verifyAdminToken } from "@/lib/admin-auth";
import {
  getAccountGovernanceInfo,
  normalizeAccountDisplayName,
} from "@/lib/account-governance";
import {
  BILLING_SOURCE_CATEGORIES,
  normalizeBillingSource,
} from "@/lib/billing-source-catalog";
import { authorizeAdminCapability } from "@/lib/server/admin-governance-authority";

type UnknownRecord = Record<string, unknown>;

function integerParam(value: string | null, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isInteger(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}

function safeRecord(value: unknown): UnknownRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : {};
}

function stringOrNull(value: unknown): string | null {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

function walletOperationId(sourceId: unknown): string | null {
  const matched = String(sourceId || "").match(/^wallet:(\d+)$/u);
  return matched?.[1] || null;
}

export async function GET(request: NextRequest) {
  const authorization = await authorizeAdminCapability(request, "billing.view", {
    operation: "balance_audit_view",
  });
  if (!authorization.ok) return authorization.response;
  const token = getTokenFromHeaders(request.headers);
  if (!token) return NextResponse.json({ error: "未登录" }, { status: 401 });
  const payload = await verifyAdminToken(token);
  if (!payload || payload.role !== "admin") {
    return NextResponse.json({ error: "无权限" }, { status: 403 });
  }

  const url = new URL(request.url);
  const userId = stringOrNull(url.searchParams.get("userId"));
  const requestedField = stringOrNull(url.searchParams.get("field"));
  const field = requestedField === "credits" || requestedField === "cash_balance" ? requestedField : null;
  const source = stringOrNull(url.searchParams.get("source"));
  const pageSize = integerParam(url.searchParams.get("pageSize") || url.searchParams.get("limit"), 20, 1, 200);
  const page = integerParam(url.searchParams.get("page"), 1, 1, 1_000_000);
  const explicitOffset = url.searchParams.has("offset")
    ? integerParam(url.searchParams.get("offset"), 0, 0, 100_000_000)
    : null;
  const offset = explicitOffset ?? (page - 1) * pageSize;
  const db = getSupabaseAdminClient();

  let query = db
    .from("balance_audit_log")
    .select("id,user_id,field,old_value,new_value,delta,source,source_id,operator_id,ip_address,context,created_at", { count: "exact" })
    .order("created_at", { ascending: false })
    .range(offset, offset + pageSize - 1);
  if (userId) query = query.eq("user_id", userId);
  if (field) query = query.eq("field", field);
  if (source) query = query.eq("source", source);

  const [logResult, statsResult, facetsResult] = await Promise.all([
    query,
    db.from("balance_audit_log")
      .select("field,source,delta")
      .gte("created_at", new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()),
    (db as unknown as { rpc(name: string): Promise<{ data: unknown; error: { message?: string } | null }> })
      .rpc("balance_audit_source_facets"),
  ]);

  if (logResult.error) {
    return NextResponse.json({ error: `审计日志查询失败：${logResult.error.message}` }, { status: 503 });
  }
  if (statsResult.error) {
    return NextResponse.json({ error: `24小时统计查询失败：${statsResult.error.message}` }, { status: 503 });
  }
  if (facetsResult.error || !Array.isArray(facetsResult.data)) {
    return NextResponse.json({ error: "来源目录查询失败，请先应用计费审计来源迁移" }, { status: 503 });
  }

  const rows = (logResult.data || []) as UnknownRecord[];
  const userIds = [...new Set(rows.map((row) => stringOrNull(row.user_id)).filter((value): value is string => Boolean(value)))];
  const operationIds = [...new Set(rows.map((row) => walletOperationId(row.source_id)).filter((value): value is string => Boolean(value)))];

  const [usersResult, loginResult, walletResult] = await Promise.all([
    userIds.length
      ? db.from("users")
        .select("id,username,display_name,email,phone,role,status,member_status,last_sign_in_at,allowed_categories")
        .in("id", userIds)
      : Promise.resolve({ data: [], error: null }),
    userIds.length
      ? db.from("login_logs")
        .select("user_id,ip_address,status,created_at")
        .in("user_id", userIds)
        .order("created_at", { ascending: false })
        .limit(Math.min(1_000, Math.max(100, userIds.length * 20)))
      : Promise.resolve({ data: [], error: null }),
    operationIds.length
      ? db.from("wallet_operations")
        .select("id,user_id,operation_kind,idempotency_key,description,metadata,created_at")
        .in("id", operationIds)
      : Promise.resolve({ data: [], error: null }),
  ]);

  const enrichmentError = usersResult.error || loginResult.error || walletResult.error;
  if (enrichmentError) {
    return NextResponse.json({ error: `审计身份或凭证查询失败：${enrichmentError.message}` }, { status: 503 });
  }

  const users = (usersResult.data || []) as UnknownRecord[];
  const userById = new Map(users.map((user) => [String(user.id), user]));
  const latestLoginByUser = new Map<string, UnknownRecord>();
  for (const login of (loginResult.data || []) as UnknownRecord[]) {
    const id = String(login.user_id || "");
    if (id && !latestLoginByUser.has(id)) latestLoginByUser.set(id, login);
  }
  const walletById = new Map(
    ((walletResult.data || []) as UnknownRecord[]).map((operation) => [String(operation.id), operation]),
  );

  const operatorIds = [...new Set(rows.flatMap((row) => {
    const operation = walletById.get(walletOperationId(row.source_id) || "");
    const metadata = safeRecord(operation?.metadata);
    const operatorId = stringOrNull(row.operator_id) || stringOrNull(metadata.admin_user_id);
    return operatorId ? [operatorId] : [];
  }))];
  const missingOperatorIds = operatorIds.filter((id) => !userById.has(id));
  if (missingOperatorIds.length) {
    const operatorResult = await db.from("users")
      .select("id,username,display_name,email,phone,role,status,member_status,last_sign_in_at,allowed_categories")
      .in("id", missingOperatorIds);
    if (operatorResult.error) {
      return NextResponse.json({ error: `操作者身份查询失败：${operatorResult.error.message}` }, { status: 503 });
    }
    for (const operator of (operatorResult.data || []) as UnknownRecord[]) userById.set(String(operator.id), operator);
  }

  const logs = rows.map((row) => {
    const auditUserId = String(row.user_id || "");
    const user = userById.get(auditUserId) || {};
    const governance = getAccountGovernanceInfo(user);
    const sourceOperationId = walletOperationId(row.source_id);
    const walletOperation = walletById.get(sourceOperationId || "");
    const walletMetadata = safeRecord(walletOperation?.metadata);
    const effectiveRawSource = row.source === "unknown" && stringOrNull(walletMetadata.source)
      ? walletMetadata.source
      : row.source;
    const normalizedSource = normalizeBillingSource({
      rawSource: effectiveRawSource,
      sourceId: row.source_id,
      accountIsFixture: governance.isFixture,
    });
    const operatorId = stringOrNull(row.operator_id) || stringOrNull(walletMetadata.admin_user_id);
    const operator = operatorId ? userById.get(operatorId) || {} : {};
    const latestLogin = latestLoginByUser.get(auditUserId);
    const exactEventIp = stringOrNull(row.ip_address) || stringOrNull(walletMetadata.request_ip);
    const rowContext = safeRecord(row.context);

    return {
      id: String(row.id),
      userId: auditUserId,
      field: String(row.field || ""),
      oldValue: Number(row.old_value),
      newValue: Number(row.new_value),
      delta: Number(row.delta),
      createdAt: String(row.created_at || ""),
      identity: {
        displayLabel: governance.isFixture ? "系统测试" : normalizeAccountDisplayName(user, "已删除用户"),
        displayName: normalizeAccountDisplayName(user, "已删除用户"),
        username: stringOrNull(user.username),
        email: stringOrNull(user.email),
        phone: stringOrNull(user.phone),
        role: stringOrNull(user.role),
        accountKind: governance.isFixture ? "fixture" : governance.isSuspicious ? "suspicious" : "normal",
        accountNote: governance.label,
        accountReasons: governance.reasons,
      },
      source: {
        category: normalizedSource.key,
        label: normalizedSource.label,
        tone: normalizedSource.tone,
        rawSource: normalizedSource.rawSource,
        sourceId: stringOrNull(row.source_id),
        explanation: normalizedSource.explanation,
      },
      network: {
        eventIp: exactEventIp,
        eventIpStatus: exactEventIp ? "recorded" : "not_recorded",
        eventIpExplanation: exactEventIp
          ? "本笔余额变更请求记录的 IP。"
          : "本笔旧记录没有保存 IP；系统不会拿登录 IP 冒充操作 IP。",
        lastLoginIp: stringOrNull(latestLogin?.ip_address),
        lastLoginAt: stringOrNull(latestLogin?.created_at),
        lastLoginStatus: stringOrNull(latestLogin?.status),
      },
      operator: operatorId ? {
        id: operatorId,
        displayName: normalizeAccountDisplayName(operator, "已删除操作者"),
      } : null,
      context: {
        route: stringOrNull(rowContext.route) || stringOrNull(walletMetadata.request_route),
        writer: stringOrNull(rowContext.writer),
        walletOperationId: sourceOperationId,
        walletOperationKind: stringOrNull(walletOperation?.operation_kind),
        walletIdempotencyKey: stringOrNull(walletOperation?.idempotency_key),
      },
    };
  });

  const summary = {
    creditsIn24h: 0,
    creditsOut24h: 0,
    cashIn24h: 0,
    cashOut24h: 0,
    topRawSources: {} as Record<string, number>,
  };
  for (const row of (statsResult.data || []) as UnknownRecord[]) {
    const delta = Number(row.delta);
    if (row.field === "credits") {
      if (delta > 0) summary.creditsIn24h += delta;
      else summary.creditsOut24h += Math.abs(delta);
    } else if (row.field === "cash_balance") {
      if (delta > 0) summary.cashIn24h += delta;
      else summary.cashOut24h += Math.abs(delta);
    }
    const rawSource = String(row.source || "unknown");
    summary.topRawSources[rawSource] = (summary.topRawSources[rawSource] || 0) + 1;
  }

  const rawSourceFacets = (facetsResult.data as UnknownRecord[]).map((facet) => {
    const rawSource = String(facet.raw_source || "unknown");
    const normalized = normalizeBillingSource({ rawSource });
    return {
      rawSource,
      recordCount: Number(facet.record_count || 0),
      category: normalized.key,
      label: normalized.label,
      explanation: normalized.explanation,
    };
  });

  return NextResponse.json({
    total: logResult.count || 0,
    page,
    pageSize,
    offset,
    logs,
    summary,
    sourceInventory: {
      observedRawSourceCount: rawSourceFacets.length,
      observedRecordCount: rawSourceFacets.reduce((sum, item) => sum + item.recordCount, 0),
      standardCategoryCount: BILLING_SOURCE_CATEGORIES.length,
      rawSources: rawSourceFacets,
      standardCategories: BILLING_SOURCE_CATEGORIES.map((category) => ({
        key: category.key,
        label: category.label,
        description: category.description,
        rawSources: category.rawSources,
        contextual: category.contextual === true,
      })),
      note: "原始来源值用于对账且不改写；标准类别用于中文展示。系统测试按账号上下文标注，其他类必须保留原始代码和解释。",
    },
  }, {
    headers: { "Cache-Control": "private, no-store", Vary: "Authorization, Cookie" },
  });
}
