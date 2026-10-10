import { NextRequest, NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { withAuth } from '@/lib/api-middleware';
import { extractionBillingPrefix } from '@/lib/extraction-status-billing';
import { extractionRetryInputFromSnapshot, sanitizeOwnedExtractionResponse } from '@/lib/extraction-history';
import { createOperationPerformanceTrace } from '@/lib/operation-performance-trace';
import { recordServerOperationPerformanceEventBestEffort } from '@/lib/operation-flight-recorder';

export const dynamic = 'force-dynamic';
/** Reads the original request and current platform ledger; never submits work. */

type AttemptStatusRow = {
  record_id: string;
  client_request_id: string;
  request_kind: 'single' | 'batch' | 'search' | 'coze';
  state: 'running' | 'failed_unknown' | 'failed' | 'succeeded';
  billing_evidence: Record<string, unknown> | null;
  provider_evidence?: Record<string, unknown> | null;
  response: Record<string, unknown> | null;
  request_snapshot?: unknown;
  content_purged_at?: string | null;
  updated_at: string;
};

export async function GET(request: NextRequest) {
  const requestedAttemptId = request.nextUrl.searchParams.get('attempt_id')?.trim().toLowerCase() || '';
  const requestedClientRequestId = request.nextUrl.searchParams.get('client_request_id')?.trim() || '';
  const performanceTrace = createOperationPerformanceTrace({
    domain: 'extract',
    operation: 'extract.status_load',
    route: '/api/extract/status',
    requestId: requestedClientRequestId || requestedAttemptId || request.headers.get('x-client-trace-id'),
    traceId: request.headers.get('x-client-trace-id') || requestedClientRequestId || requestedAttemptId,
    taskId: requestedAttemptId || requestedClientRequestId,
  }, (event) => { void recordServerOperationPerformanceEventBestEffort(event); });
  performanceTrace.checkpoint('request.received', { outcome: 'in_progress' });
  return withAuth(request, async (user, authenticatedDb) => {
    performanceTrace.enrichIdentity({
      userId: user.id,
      accountId: user.id,
      taskId: requestedAttemptId || requestedClientRequestId,
    });
    performanceTrace.checkpoint('auth.permission');
    const db = authenticatedDb as SupabaseClient;
    const attemptId = requestedAttemptId;
    const clientRequestId = requestedClientRequestId;
    if (Boolean(attemptId) === Boolean(clientRequestId)) {
      return NextResponse.json({ error: '请只提供一种请求编号' }, { status: 400 });
    }
    if (attemptId && !/^[a-f0-9]{64}$/u.test(attemptId)) return NextResponse.json({ error: '请求编号无效' }, { status: 400 });
    if (clientRequestId && !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u.test(clientRequestId)) {
      return NextResponse.json({ error: '客户端请求编号无效' }, { status: 400 });
    }
    try {
      let retryReady = true;
      const primaryQuery = db.from('extraction_attempts')
        .select('record_id,client_request_id,request_kind,state,billing_evidence,provider_evidence,response,request_snapshot,content_purged_at,updated_at')
        .eq('user_id', user.id).in('request_kind', ['single','batch','search','coze']);
      const primaryResult = await (attemptId
        ? primaryQuery.eq('record_id', attemptId)
        : primaryQuery.eq('client_request_id', clientRequestId)).maybeSingle();
      let resultError = primaryResult.error;
      let row = primaryResult.data as unknown as AttemptStatusRow | null;
      if (resultError && /request_snapshot|provider_evidence|content_purged_at|schema cache|does not exist|could not find/i.test(resultError.message || '')) {
        retryReady = false;
        const fallbackQuery = db.from('extraction_attempts')
          .select('record_id,client_request_id,request_kind,state,billing_evidence,response,updated_at')
          .eq('user_id', user.id).in('request_kind', ['single','batch','search','coze']);
        const fallbackResult = await (attemptId
          ? fallbackQuery.eq('record_id', attemptId)
          : fallbackQuery.eq('client_request_id', clientRequestId)).maybeSingle();
        resultError = fallbackResult.error;
        row = fallbackResult.data as unknown as AttemptStatusRow | null;
      }
      if (resultError) throw resultError;
      if (!row) return NextResponse.json({ error: '请求不存在或无权访问' }, { status: 404 });
      const billing = await db.from('wallet_operations').select('amount,operation_kind,status')
        .eq('user_id', user.id).like('idempotency_key', extractionBillingPrefix(row.request_kind, row.client_request_id));
      if (billing.error) throw billing.error;
      performanceTrace.enrichIdentity({ taskId: row.record_id });
      performanceTrace.checkpoint('database.read');
      let charged = 0, refunded = 0, pending = false;
      for (const operation of billing.data || []) {
        if (operation.status !== 'completed') { pending = true; continue; }
        if (operation.operation_kind === 'cash_charge') charged += Number(operation.amount) || 0;
        if (operation.operation_kind === 'cash_refund') refunded += Number(operation.amount) || 0;
      }
      const walletOperations = billing.data || [];
      const netCharged = Math.max(0, Number((charged - refunded).toFixed(6)));
      const billingEvidence = row.billing_evidence && typeof row.billing_evidence === 'object' && !Array.isArray(row.billing_evidence)
        ? row.billing_evidence as Record<string, unknown>
        : {};
      const quoteSnapshotPresent = ['price', 'cost', 'chargeInfo'].some((key) => Object.hasOwn(billingEvidence, key));
      const historicalChargeUnconfirmed = billingEvidence.charged === true && walletOperations.length === 0;
      const requiresReconciliation = row.state === 'failed_unknown';
      const unknownBilling = requiresReconciliation && billingEvidence.charged !== false && walletOperations.length === 0;
      const billingMessage = historicalChargeUnconfirmed
        ? '历史返回曾标记已扣费，但用户钱包未发现对应扣费流水；待管理员核对，请勿重复提交'
        : unknownBilling
          ? `用户钱包未发现扣费记录；${quoteSnapshotPresent ? '' : '该旧请求未保存报价快照，'}结果待管理员结案，请勿重复提交`
          : pending
            ? '费用记录正在确认'
            : netCharged > 0
              ? '已扣费 ¥' + netCharged.toFixed(2)
              : charged > 0 && refunded >= charged
                ? '费用已退回，当前净扣费 ¥0.00'
                : billingEvidence.charged === false || row.state === 'failed'
                  ? '本次未扣费'
                  : '目前未扣费';
      const responseBody = row.response && typeof row.response === 'object' && !Array.isArray(row.response) ? row.response : {};
      const providerEvidence = row.provider_evidence && typeof row.provider_evidence === 'object' && !Array.isArray(row.provider_evidence)
        ? row.provider_evidence as Record<string, unknown>
        : {};
      const contentRetained = !row.content_purged_at;
      const contentUnavailableReason = !contentRetained
        ? providerEvidence.content_retention === 'video_transient'
          ? '视频提取结果仅供当次预览和下载，平台不保存文件或历史结果。'
          : '这条提取结果已超过保存期限，正文内容已按规则清理。'
        : '';
      const retryInput = extractionRetryInputFromSnapshot(row.request_snapshot ?? null);
      const canResubmit = contentRetained && retryReady && row.state === 'failed' && netCharged === 0 && !pending
        && responseBody.retry_safe === true && responseBody.billing_unknown !== true && Boolean(retryInput);
      performanceTrace.checkpoint('response.first_byte', { httpStatus: 200 });
      performanceTrace.checkpoint('response.terminal', { httpStatus: 200 });
      return NextResponse.json({ attemptId: row.record_id, clientRequestId: row.client_request_id, state: row.state, netCharged, billingMessage,
        platformChargeRecorded: charged > 0, platformRefundRecorded: refunded > 0,
        platformWalletOperationCount: walletOperations.length, quoteSnapshotPresent,
        billingConfirmed: !historicalChargeUnconfirmed && !unknownBilling && !pending,
        requiresReconciliation, canResubmit, retryReady, contentRetained,
        ...(contentUnavailableReason ? { contentUnavailableReason } : {}),
        ...(canResubmit && retryInput ? { retryInput } : {}),
        ...(!retryReady ? { retryUnavailableReason: '失败记录恢复服务正在准备中，请稍后重试。' } : {}),
        checkedAt: new Date().toISOString(), updatedAt: row.updated_at,
        ...(['succeeded', 'failed'].includes(row.state) && row.response ? { response: sanitizeOwnedExtractionResponse(row.response) } : {}),
      }, { headers: { 'Cache-Control': 'private, no-store' } });
    } catch {
      performanceTrace.checkpoint('response.terminal', {
        outcome: 'error',
        httpStatus: 503,
        errorCode: 'EXTRACT_STATUS_READ_FAILED',
      });
      return NextResponse.json({ error: '状态暂时无法读取，请稍后刷新' }, { status: 503 });
    }
  });
}
