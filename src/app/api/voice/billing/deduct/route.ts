import { NextRequest, NextResponse } from 'next/server';
import { applyAtomicWalletOperation } from '@/lib/billing';
import { getServerSecret, safeCompareSecret } from '@/lib/server-secrets';

type DeductBody = {
  userId?: unknown;
  amount?: unknown;
  description?: unknown;
  charCount?: unknown;
  model?: unknown;
  referenceId?: unknown;
  idempotencyKey?: unknown;
  priceSnapshot?: unknown;
};

function cleanString(value: unknown, maxLength: number): string {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

/**
 * Authenticated service-to-service cash deduction for Voice Studio.
 *
 * The caller must provide one stable request/task reference. The endpoint
 * never reads then writes users.cash_balance itself; every mutation is
 * delegated to apply_wallet_operation_atomic and fails closed when that RPC is
 * unavailable.
 */
export async function POST(request: NextRequest) {
  try {
    const expectedKey = getServerSecret('SITE_API_KEY');
    if (!expectedKey) {
      return NextResponse.json(
        {
          success: false,
          code: 'VOICE_BILLING_AUTH_NOT_CONFIGURED',
          message: '智音工坊服务认证尚未配置，已拒绝扣费',
        },
        { status: 503 },
      );
    }

    if (!safeCompareSecret(request.headers.get('X-Site-API-Key'), expectedKey)) {
      return NextResponse.json(
        { success: false, code: 'VOICE_BILLING_UNAUTHENTICATED', message: '认证失败' },
        { status: 401 },
      );
    }

    const body = (await request.json()) as DeductBody;
    const userId = typeof body.userId === 'string' ? body.userId.trim() : '';
    const amount = typeof body.amount === 'number' ? body.amount : Number.NaN;
    const headerValue = request.headers.get('Idempotency-Key');
    const headerKey = typeof headerValue === 'string'
      ? headerValue.trim()
      : '';
    const rawBodyKey = body.idempotencyKey ?? body.referenceId;
    const bodyKey = typeof rawBodyKey === 'string' ? rawBodyKey.trim() : '';
    const referenceId = headerKey || bodyKey;
    const description = cleanString(body.description, 900)
      || `智音工坊语音服务 (${Number.isSafeInteger(body.charCount) ? body.charCount : 0} 字符)`;
    const model = cleanString(body.model, 160) || 'voice-studio';
    const charCount = Number.isSafeInteger(body.charCount) && Number(body.charCount) >= 0
      ? Number(body.charCount)
      : null;
    const priceSnapshot = body.priceSnapshot && typeof body.priceSnapshot === 'object'
      && !Array.isArray(body.priceSnapshot)
      ? body.priceSnapshot as Record<string, unknown>
      : null;

    if (
      !userId
      || userId.length > 128
      || !Number.isFinite(amount)
      || amount <= 0
      || !referenceId
      || referenceId.length > 220
    ) {
      return NextResponse.json(
        {
          success: false,
          code: 'VOICE_BILLING_REQUEST_INVALID',
          message: 'userId、有效正数 amount 和 1..220 字符的稳定 Idempotency-Key/referenceId 均为必填',
        },
        { status: 400 },
      );
    }

    const result = await applyAtomicWalletOperation({
      userId,
      operationKind: 'cash_charge',
      idempotencyKey: `voice:service:${referenceId}`,
      amount,
      description,
      metadata: {
        source: 'voice-studio',
        operation: 'service_deduction',
        reference_id: referenceId,
        char_count: charCount,
        model,
        price_snapshot: priceSnapshot,
      },
    });

    if (!result.success) {
      const migrationMissing = /原子钱包迁移/.test(result.error || '');
      return NextResponse.json(
        {
          success: false,
          code: migrationMissing ? 'MIGRATION_NOT_READY' : 'VOICE_BILLING_REJECTED',
          message: result.error || '扣费失败',
        },
        { status: migrationMissing ? 503 : 409 },
      );
    }

    return NextResponse.json({
      success: true,
      alreadyFulfilled: result.alreadyFulfilled,
      operationId: result.operationId,
      balance: result.balanceAfter,
      amount: result.amount,
      referenceId,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json(
      { success: false, code: 'VOICE_BILLING_INTERNAL_ERROR', message },
      { status: 500 },
    );
  }
}
