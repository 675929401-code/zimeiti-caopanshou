import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdminClient, isSupabaseAvailable } from '@/storage/database/supabase-client';
import { storageManager } from '@/storage/object';
import { getCozeConfig } from '@/lib/coze-api';
import { probeProductionDatabaseReadiness } from '@/lib/production-database-readiness';
import { ADMIN_ACTIVITY_LOG_COLUMNS, adminActivityLogLimit, normalizeAdminActivityLog } from '@/lib/admin-activity-display';
import {
  isAuthorizedInternalHealthRequest,
  isHealthCheckConfigured,
} from '@/lib/health-check-auth';
import { authorizeAdminCapability } from '@/lib/server/admin-governance-authority';
import { classifyHealthErrorTrend, unavailableHealthErrorTrend } from '@/lib/health-error-trend';
import { readExactCountEvidence } from '@/lib/health-query-evidence';

const HEALTH_RESPONSE_HEADERS = {
  'Cache-Control': 'private, no-store, max-age=0',
  Pragma: 'no-cache',
  Vary: 'Authorization, Cookie',
};

function healthJson(body: unknown, init?: ResponseInit) {
  return NextResponse.json(body, {
    ...init,
    headers: {
      ...HEALTH_RESPONSE_HEADERS,
      ...(init?.headers || {}),
    },
  });
}

function withHealthResponseHeaders(response: NextResponse) {
  for (const [key, value] of Object.entries(HEALTH_RESPONSE_HEADERS)) {
    response.headers.set(key, value);
  }
  return response;
}

function concealedHealthDetailsDenial(response: NextResponse) {
  if (response.status === 403) {
    return healthJson(
      { error: '当前管理员未获此项后台权限', code: 'ADMIN_PERMISSION_DENIED' },
      { status: 403 },
    );
  }
  return withHealthResponseHeaders(response);
}

// Lazy init: avoid calling at build time when env vars are absent
function getSupabase() {
  if (!isSupabaseAvailable()) {
    throw new Error('Supabase not configured');
  }
  return getSupabaseAdminClient();
}

// ============ 健康检查核心逻辑 ============

interface HealthCheckResult {
  name: string;
  status: 'healthy' | 'degraded' | 'unhealthy';
  message: string;
  latency?: number;
  details?: Record<string, unknown>;
}

async function checkDatabase(): Promise<HealthCheckResult> {
  const start = Date.now();
  try {
    const { data, error } = await getSupabase().from('users').select('id').limit(1);
    if (error) throw error;
    return { name: '数据库连接', status: 'healthy', message: 'Supabase连接正常', latency: Date.now() - start, details: { response: !!data } };
  } catch (e) {
    return { name: '数据库连接', status: 'unhealthy', message: `数据库连接失败: ${(e as Error).message}`, latency: Date.now() - start };
  }
}

async function checkCozeConfiguration(): Promise<HealthCheckResult> {
  const start = Date.now();
  try {
    const config = await getCozeConfig();
    if (!config.apiToken) {
      return {
        name: 'Coze 配置',
        status: 'degraded',
        message: '未配置 Coze 服务端凭据；健康概览未执行外部供应商请求',
        latency: Date.now() - start,
        details: { credentialConfigured: false, externalProbeExecuted: false },
      };
    }
    return {
      name: 'Coze 配置',
      status: 'healthy',
      message: 'Coze 服务端凭据已配置；健康概览未执行外部供应商请求',
      latency: Date.now() - start,
      details: { credentialConfigured: true, externalProbeExecuted: false },
    };
  } catch {
    return {
      name: 'Coze 配置',
      status: 'unhealthy',
      message: 'Coze 配置状态不可读；未执行外部供应商请求',
      latency: Date.now() - start,
      details: { credentialConfigured: null, externalProbeExecuted: false },
    };
  }
}

async function checkLLMAPI(): Promise<HealthCheckResult> {
  const start = Date.now();
  try {
    const { data, error } = await getSupabase()
      .from('llm_models')
      .select('id, name, model_name, is_active, is_hidden, user_access')
      .eq('is_active', true)
      .neq('is_hidden', true)
      .neq('user_access', 'hidden')
      .limit(100);
    if (error) throw error;
    const visibleModels = data || [];
    if (visibleModels.length === 0) {
      return {
        name: 'LLM 模型目录',
        status: 'unhealthy',
        message: '后台没有可供用户选择的启用文案模型',
        latency: Date.now() - start,
      };
    }
    return {
      name: 'LLM 模型目录',
      status: 'healthy',
      message: `${visibleModels.length}个启用文案模型已从后台配置加载`,
      latency: Date.now() - start,
      details: { activeVisibleModels: visibleModels.length },
    };
  } catch (e) {
    return { name: 'LLM 模型目录', status: 'unhealthy', message: `模型目录不可用: ${(e as Error).message}`, latency: Date.now() - start };
  }
}

async function checkDatabaseIntegrity(): Promise<HealthCheckResult> {
  try {
    const readiness = await probeProductionDatabaseReadiness();
    const details = {
      contractId: readiness.contractId,
      contractVersion: readiness.contractVersion,
      tableCount: readiness.tableCount,
      rpcCount: readiness.rpcCount,
      missingTableCount: readiness.missingTables.length,
      missingColumnCount: readiness.missingColumns.length,
      missingRpcCount: readiness.missingRpcs.length,
      missingRpcArgumentCount: readiness.missingRpcArguments.length,
      forbiddenRpcCount: readiness.forbiddenRpcsPresent.length,
      probeMode: 'read-only-openapi-metadata',
    };
    if (!readiness.ok) {
      return {
        name: '数据库完整性',
        status: 'unhealthy',
        message: '生产数据库与当前版本化合同不匹配',
        details,
      };
    }
    return {
      name: '数据库完整性',
      status: 'healthy',
      message: '生产数据库表、列、RPC 与参数合同完整',
      details,
    };
  } catch (e) {
    return { name: '数据库完整性', status: 'unhealthy', message: `检查失败: ${(e as Error).message}` };
  }
}

async function checkRecentErrors(): Promise<HealthCheckResult> {
  try {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const [errorResult, criticalResult] = await Promise.all([
      getSupabase()
        .from('system_logs')
        .select('id', { count: 'exact', head: true })
        .eq('level', 'error')
        .gte('created_at', cutoff),
      getSupabase()
        .from('system_logs')
        .select('id', { count: 'exact', head: true })
        .eq('level', 'critical')
        .gte('created_at', cutoff),
    ]);
    return classifyHealthErrorTrend(errorResult, criticalResult);
  } catch {
    return unavailableHealthErrorTrend();
  }
}

async function checkFlightRecorder(): Promise<HealthCheckResult> {
  const start = Date.now();
  try {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1_000).toISOString();
    const [eventResult, errorResult, { data: latest, error: latestError }] = await Promise.all([
      getSupabase().from('operation_flight_events').select('id', { count: 'exact', head: true }).gte('occurred_at', cutoff),
      getSupabase().from('operation_flight_events').select('id', { count: 'exact', head: true }).eq('outcome', 'error').gte('occurred_at', cutoff),
      getSupabase().from('operation_flight_events').select('occurred_at,source,domain,outcome').order('occurred_at', { ascending: false }).limit(1).maybeSingle(),
    ]);
    const eventEvidence = readExactCountEvidence(eventResult);
    const errorEvidence = readExactCountEvidence(errorResult);
    if (!eventEvidence.available || !errorEvidence.available || latestError) {
      return {
        name: '运行飞行日志',
        status: 'unhealthy',
        message: '统一事件账本证据不可用，未将缺失计数按 0 展示',
        latency: Date.now() - start,
        details: {
          availability: 'unavailable',
          events24h: eventEvidence.count,
          errors24h: errorEvidence.count,
          eventCountReason: eventEvidence.available ? null : eventEvidence.reason,
          errorCountReason: errorEvidence.available ? null : errorEvidence.reason,
          latestReadAvailable: !latestError,
        },
      };
    }
    return {
      name: '运行飞行日志',
      status: 'healthy',
      message: `独立事件账本可读，24小时 ${eventEvidence.count} 条、异常 ${errorEvidence.count} 条`,
      latency: Date.now() - start,
      details: {
        availability: 'available',
        events24h: eventEvidence.count,
        errors24h: errorEvidence.count,
        latestAt: latest?.occurred_at || null,
        latestSource: latest?.source || null,
        latestDomain: latest?.domain || null,
      },
    };
  } catch (e) {
    return {
      name: '运行飞行日志',
      status: 'unhealthy',
      message: `统一事件账本不可用: ${(e as Error).message}`,
      latency: Date.now() - start,
    };
  }
}

async function checkUserActivity(): Promise<HealthCheckResult> {
  try {
    const [studentResult, adminResult, agentResult] = await Promise.all([
      getSupabase()
        .from('users')
        .select('id', { count: 'exact', head: true })
        .eq('role', 'student'),
      getSupabase()
        .from('users')
        .select('id', { count: 'exact', head: true })
        .eq('role', 'admin'),
      getSupabase()
        .from('agents')
        .select('id', { count: 'exact', head: true })
        .eq('is_active', true)
        .is('deleted_at', null),
    ]);
    const students = readExactCountEvidence(studentResult);
    const admins = readExactCountEvidence(adminResult);
    const agents = readExactCountEvidence(agentResult);
    const unavailable = [
      ['users', students],
      ['admins', admins],
      ['activeAgents', agents],
    ].filter(([, evidence]) => !(evidence as ReturnType<typeof readExactCountEvidence>).available);

    if (unavailable.length > 0) {
      return {
        name: '系统概览',
        status: 'unhealthy',
        message: '用户或智能体统计证据不可用，未将缺失计数按 0 展示',
        details: {
          availability: 'unavailable',
          users: students.count,
          admins: admins.count,
          activeAgents: agents.count,
          unavailableSources: unavailable.map(([name]) => name),
        },
      };
    }

    return {
      name: '系统概览',
      status: 'healthy',
      message: `${students.count}名学员, ${admins.count}名管理员, ${agents.count}个活跃智能体`,
      details: {
        availability: 'available',
        users: students.count,
        admins: admins.count,
        activeAgents: agents.count,
      },
    };
  } catch {
    return {
      name: '系统概览',
      status: 'unhealthy',
      message: '用户与智能体统计证据不可用',
      details: { availability: 'unavailable', users: null, admins: null, activeAgents: null },
    };
  }
}

// ============ 自动修复逻辑 ============

interface AutoFixResult {
  issue: string;
  action: string;
  success: boolean;
  message: string;
}

async function autoFix(
  checkResults: HealthCheckResult[],
  options: { allowSafeWrites: boolean },
): Promise<AutoFixResult[]> {
  const fixes: AutoFixResult[] = [];

  for (const check of checkResults) {
    if (check.status === 'healthy') continue;

    // Schema changes must only run through reviewed, versioned migrations.
    if (check.name === '数据库完整性' && check.details?.issues) {
      const issues = check.details.issues as string[];
      for (const issue of issues) {
        if (issue.includes('不存在') || issue.includes('缺少') || issue.includes('不可读')) {
          fixes.push({
            issue,
            action: '执行受控数据库迁移',
            success: false,
            message: '健康检查不会自动修改数据库结构；请由管理员执行 supabase/migrations 中的版本化迁移',
          });
        }
      }
    }

    // Fix: Mark old errors as resolved
    if (options.allowSafeWrites && check.name === '错误趋势' && (check.details?.errors as number || 0) > 0) {
      try {
        const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
        await getSupabase()
          .from('system_logs')
          .update({ resolved: true })
          .eq('resolved', false)
          .lt('created_at', cutoff)
          .in('level', ['info', 'warn']);
        fixes.push({ issue: '旧日志未标记', action: '自动标记48小时前的info/warn日志为已解决', success: true, message: '旧日志已清理' });
      } catch {
        fixes.push({ issue: '旧日志清理', action: '标记旧日志', success: false, message: '清理失败' });
      }
    }
  }

  return fixes;
}

type StoragePersistenceEvidence = {
  state: 'recorded' | 'absent' | 'unavailable';
  recordedAt: string | null;
  provider: string;
};

async function readLatestStoragePersistenceEvidence(provider: string): Promise<StoragePersistenceEvidence> {
  try {
    const { data, error } = await getSupabase()
      .from('user_files')
      .select('created_at,storage_provider')
      .eq('storage_provider', provider)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    const recordedAt = typeof data?.created_at === 'string' ? data.created_at : null;
    return {
      state: recordedAt ? 'recorded' : 'absent',
      recordedAt,
      provider,
    };
  } catch {
    return {
      state: 'unavailable',
      recordedAt: null,
      provider,
    };
  }
}

async function checkObjectStorage(): Promise<HealthCheckResult> {
  const start = Date.now();
  try {
    const status = await storageManager.getStatus();
    const commonDetails = {
      defaultProvider: status.defaultProvider,
      fallbackProvider: status.fallbackProvider,
      initializedProviders: status.initializedProviders,
      runtimeMode: status.runtimeMode,
      externalProbeExecuted: false,
      connectivityState: 'unknown',
    };

    if (!status.productionSafe) {
      return {
        name: '对象存储',
        status: 'unhealthy',
        message: `${status.issues.join('；') || '对象存储不满足生产持久化要求'}；未执行外部供应商请求`,
        latency: Date.now() - start,
        details: {
          ...commonDetails,
          configurationState: 'invalid',
          persistenceEvidence: {
            state: 'not_read',
            recordedAt: null,
            provider: status.defaultProvider,
            confirmsCurrentConnectivity: false,
          },
        },
      };
    }

    const evidence = await readLatestStoragePersistenceEvidence(status.defaultProvider);
    const evidenceMessage = evidence.state === 'recorded'
      ? `最近一条持久化记录时间：${evidence.recordedAt}（仅历史证据）`
      : evidence.state === 'absent'
        ? '暂无持久化记录可供参考'
        : '最近持久化证据当前不可读';

    return {
      name: '对象存储',
      status: 'degraded',
      message: `${status.defaultProvider} 配置已加载；${evidenceMessage}；当前外部连通性未知，未执行供应商请求`,
      latency: Date.now() - start,
      details: {
        ...commonDetails,
        configurationState: 'configured',
        persistenceEvidence: {
          ...evidence,
          confirmsCurrentConnectivity: false,
        },
      },
    };
  } catch {
    return {
      name: '对象存储',
      status: 'unhealthy',
      message: '对象存储配置状态不可读；当前外部连通性未知，未执行供应商请求',
      latency: Date.now() - start,
      details: {
        configurationState: 'unavailable',
        connectivityState: 'unknown',
        externalProbeExecuted: false,
      },
    };
  }
}

async function runHealthChecks(): Promise<HealthCheckResult[]> {
  return Promise.all([
    checkDatabase(),
    checkCozeConfiguration(),
    checkLLMAPI(),
    checkObjectStorage(),
    checkDatabaseIntegrity(),
    checkRecentErrors(),
    checkFlightRecorder(),
    checkUserActivity(),
  ]);
}

function summarizeHealth(checks: HealthCheckResult[]) {
  const unhealthy = checks.filter((check) => check.status === 'unhealthy').length;
  const degraded = checks.filter((check) => check.status === 'degraded').length;
  return {
    status: unhealthy > 0 ? 'unhealthy' as const : degraded > 0 ? 'degraded' as const : 'healthy' as const,
    summary: {
      total: checks.length,
      healthy: checks.filter((check) => check.status === 'healthy').length,
      degraded,
      unhealthy,
    },
  };
}

function monitoringConfiguration() {
  return {
    internalTriggerConfigured: isHealthCheckConfigured(),
    scheduleMode: 'external' as const,
    automaticRepairEnabled: false,
    maintenanceScope: 'L0仅做无费用重连；L1由管理员触发可逆维护；L2导出脱敏问题包回到F盘修复。数据库结构、代码、模型、会员资产、账务与付费任务不会自动修改或重放。',
    flightRecorderRetentionDays: 90,
    codexDiagnosticBundleEnabled: true,
  };
}

// ============ 日志记录 ============

async function logSystemEvent(level: string, source: string, message: string, details?: Record<string, unknown>) {
  try {
    await getSupabase().from('system_logs').insert({ level, source, message, details });
  } catch {
    // Silently fail — don't create infinite loops
  }
}

// ============ API 路由 ============

// GET /api/health — 健康状态概览
export async function GET(req: NextRequest) {
  try {
    // Allow basic liveness probe without auth (for monitoring/load balancers)
    const url = new URL(req.url);
    const isLivenessProbe = url.searchParams.get('liveness') === 'true';
    if (isLivenessProbe) {
      return healthJson({ status: 'ok', timestamp: Date.now() });
    }

    // Allow internal cron calls without admin auth
    const isInternal = isAuthorizedInternalHealthRequest(req.headers);
    
    if (!isInternal) {
      const authorization = await authorizeAdminCapability(req, 'logs.view', {
        operation: url.searchParams.get('logs') === 'true'
          ? 'system_logs_read'
          : 'system_health_read',
        requireStepUp: false,
      });
      if (!authorization.ok) {
        return concealedHealthDetailsDenial(authorization.response);
      }
    }

    // The admin log list is a read-only query, separate from health/provider probes.
    if (url.searchParams.get('logs') === 'true') {
      const limit = adminActivityLogLimit(url.searchParams.get('limit'));
      const { data, error } = await getSupabase()
        .from('system_logs')
        .select(ADMIN_ACTIVITY_LOG_COLUMNS)
        .order('created_at', { ascending: false })
        .limit(limit);
      if (error) {
        return healthJson({ error: '日志暂时不可用，请稍后重试' }, { status: 503 });
      }
      return healthJson({ logs: (data || []).map(normalizeAdminActivityLog), limit });
    }

    const checks = await runHealthChecks();
    const [latestResult, logsResult, fixesResult] = await Promise.all([
      getSupabase()
        .from('health_checks')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
      getSupabase()
        .from('system_logs')
        .select(ADMIN_ACTIVITY_LOG_COLUMNS)
        .order('created_at', { ascending: false })
        .limit(20),
      getSupabase()
        .from('auto_fixes')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(10),
    ]);
    const unavailableEvidence = [
      latestResult.error ? 'latestCheck' : null,
      logsResult.error ? 'recentLogs' : null,
      fixesResult.error ? 'recentFixes' : null,
    ].filter((name): name is string => Boolean(name));
    if (unavailableEvidence.length > 0) {
      checks.push({
        name: '运维证据读取',
        status: 'unhealthy',
        message: '部分近期运维证据不可用，界面不会将查询失败冒充为空记录',
        details: { availability: 'unavailable', unavailableSources: unavailableEvidence },
      });
    }
    const health = summarizeHealth(checks);

    return healthJson({
      status: health.status,
      checks,
      latestCheck: latestResult.error ? null : latestResult.data || null,
      recentLogs: logsResult.error ? [] : (logsResult.data || []).map(normalizeAdminActivityLog),
      recentFixes: fixesResult.error ? [] : fixesResult.data || [],
      evidenceAvailability: {
        latestCheck: latestResult.error ? 'unavailable' : latestResult.data ? 'available' : 'absent',
        recentLogs: logsResult.error ? 'unavailable' : 'available',
        recentFixes: fixesResult.error ? 'unavailable' : 'available',
      },
      summary: health.summary,
      monitoring: monitoringConfiguration(),
      timestamp: new Date().toISOString(),
    });
  } catch {
    return healthJson({ error: '健康检查失败，运行证据不可用' }, { status: 500 });
  }
}

// POST /api/health — 执行诊断或明确范围的安全维护
export async function POST(req: NextRequest) {
  try {
    // Allow internal cron calls without admin auth
    const isInternal = isAuthorizedInternalHealthRequest(req.headers);
    
    if (!isInternal) {
      const authorization = await authorizeAdminCapability(req, 'logs.view', {
        operation: 'system_health_diagnose',
        requireStepUp: false,
      });
      if (!authorization.ok) {
        return concealedHealthDetailsDenial(authorization.response);
      }
    }

    const body = await req.json().catch(() => ({}));
    const action = body.action || 'diagnose';

    if (action === 'diagnose') {
      const checks = await runHealthChecks();
      const health = summarizeHealth(checks);

      // Save health check
      const { data: savedCheck } = await getSupabase()
        .from('health_checks')
        .insert({
          status: health.status,
          checks: checks,
          error_count: health.summary.unhealthy,
          warning_count: health.summary.degraded,
          auto_fixed_count: 0,
        })
        .select()
        .single();

      // Diagnose is deliberately read-only apart from persisting the diagnostic record.
      const fixes: AutoFixResult[] = [];

      return NextResponse.json({
        status: health.status,
        checks,
        fixes,
        healthCheckId: savedCheck?.id,
        summary: health.summary,
        monitoring: monitoringConfiguration(),
        timestamp: new Date().toISOString(),
      });
    }

    if (action === 'fix') {
      if (!isInternal) {
        const authorization = await authorizeAdminCapability(req, 'security.manage', {
          operation: 'health_manual_fix',
          requireStepUp: true,
          auditAllowed: true,
        });
        if (!authorization.ok) return authorization.response;
      }

      // Manual trigger: run diagnostics first, then fix
      const checks = await runHealthChecks();
      const health = summarizeHealth(checks);

      const fixes = await autoFix(checks, { allowSafeWrites: true });

      // Save fixes
      if (fixes.length > 0) {
        await getSupabase().from('auto_fixes').insert(
          fixes.map(f => ({
            issue_type: f.issue,
            description: f.issue,
            fix_action: f.action,
            fix_result: { success: f.success, message: f.message },
            success: f.success,
          }))
        );
      }

      await logSystemEvent('info', 'system', `手动修复: ${fixes.filter(f => f.success).length}/${fixes.length}项成功`);

      return NextResponse.json({
        status: health.status,
        checks,
        fixes,
        summary: health.summary,
        monitoring: monitoringConfiguration(),
        timestamp: new Date().toISOString(),
      });
    }

    if (action === 'log') {
      if (!isInternal) {
        const authorization = await authorizeAdminCapability(req, 'security.manage', {
          operation: 'system_log_create',
          requireStepUp: true,
          auditAllowed: true,
        });
        if (!authorization.ok) return withHealthResponseHeaders(authorization.response);
      }

      // Log a system event
      const { level, source, message, details } = body;
      if (!level || !message) {
        return NextResponse.json({ error: '缺少level或message' }, { status: 400 });
      }
      await logSystemEvent(level, source || 'system', message, details);
      return NextResponse.json({ success: true });
    }

    return NextResponse.json({ error: '未知操作' }, { status: 400 });
  } catch (e) {
    return NextResponse.json({ error: `操作失败: ${(e as Error).message}` }, { status: 500 });
  }
}
