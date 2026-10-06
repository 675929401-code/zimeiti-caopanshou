import { NextRequest, NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { withAuth } from '@/lib/api-middleware';
import { extractionBillingPrefix } from '@/lib/extraction-status-billing';
import { extractionRetryInputFromSnapshot, sanitizeOwnedExtractionResponse } from '@/lib/extraction-history';

export const dynamic = 'force-dynamic';
/** Reads the original request and current platform ledger; never submits work. */

type AttemptStatusRow = {
  record_id: string;
  client_request_id: string;
  request_kind: 'single' | 'batch' | 'search' | 'coze';
  state: 'running' | 'failed_unknown' | 'failed' | 'succeeded';
  billing_evidence: Record<string, unknown> | null;
  response: Record<string, unknown> | null;
  request_snapshot?: unknown;
  updated_at: string;
};

export async function GET(request: NextRequest) {
  return withAuth(request, async (user, authenticatedDb) => {
    const db = authenticatedDb as SupabaseClient;
    const attemptId = request.nextUrl.searchParams.get('attempt_id')?.trim().toLowerCase() || '';
    const clientRequestId = request.nextUrl.searchParams.get('client_request_id')?.trim() || '';
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
        .select('record_id,client_request_id,request_kind,state,billing_evidence,response,request_snapshot,updated_at')
        .eq('user_id', user.id).in('request_kind', ['single','batch','search','coze']);
      const primaryResult = await (attemptId
        ? primaryQuery.eq('record_id', attemptId)
        : primaryQuery.eq('client_request_id', clientRequestId)).maybeSingle();
      let resultError = primaryResult.error;
      let row = primaryResult.data as unknown as AttemptStatusRow | null;
      if (resultError && /request_snapshot|schema cache|does not exist|could not find/i.test(resultError.message || '')) {
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
      const retryInput = extractionRetryInputFromSnapshot(row.request_snapshot ?? null);
      const canResubmit = retryReady && row.state === 'failed' && netCharged === 0 && !pending
        && responseBody.retry_safe === true && responseBody.billing_unknown !== true && Boolean(retryInput);
      return NextResponse.json({ attemptId: row.record_id, clientRequestId: row.client_request_id, state: row.state, netCharged, billingMessage,
        platformChargeRecorded: charged > 0, platformRefundRecorded: refunded > 0,
        platformWalletOperationCount: walletOperations.length, quoteSnapshotPresent,
        billingConfirmed: !historicalChargeUnconfirmed && !unknownBilling && !pending,
        requiresReconciliation, canResubmit, retryReady,
        ...(canResubmit && retryInput ? { retryInput } : {}),
        ...(!retryReady ? { retryUnavailableReason: '失败记录恢复服务正在准备中，请稍后重试。' } : {}),
        checkedAt: new Date().toISOString(), updatedAt: row.updated_at,
        ...(['succeeded', 'failed'].includes(row.state) && row.response ? { response: sanitizeOwnedExtractionResponse(row.response) } : {}),
      }, { headers: { 'Cache-Control': 'private, no-store' } });
    } catch {
      return NextResponse.json({ error: '状态暂时无法读取，请稍后刷新' }, { status: 503 });
    }
  });
}
