// Voice nest ticket API.  Price selection, wallet deduction and slot creation
// are one database transaction in purchase_voice_nest_slots_atomic.
import { NextRequest, NextResponse } from 'next/server';
import { withAuth, AuthUser } from '@/lib/api-middleware';
import { getSupabaseClient } from '@/storage/database/supabase-client';

type PriceRow = {
  id: number | string;
  version: string;
  unit_price_cash: number | string;
  currency: string;
  effective_at: string;
};

type NestSlotView = {
  id: unknown;
  slotType: unknown;
  status: string;
  voiceId: unknown;
  purchasedAt: unknown;
  usedAt: unknown;
  price: unknown;
};

type NestPurchaseResult = {
  success?: boolean;
  already_fulfilled?: boolean;
  purchase_request_id?: number | string;
  quantity?: number | string;
  price_snapshot?: {
    version?: string;
    unit_price_cash?: number | string;
    total_price_cash?: number | string;
    currency?: string;
  };
  wallet_operation_id?: string;
  wallet?: {
    operation_id?: number | string;
    balance_before?: number | string;
    balance_after?: number | string;
  };
  slot_ids?: Array<number | string>;
};

function migrationNotReady(message: string | undefined): boolean {
  return /purchase_voice_nest_slots_atomic|voice_nest_(price_versions|purchase_requests).*?(schema cache|does not exist)|schema cache.*?voice_nest|function .*? does not exist/i.test(message || '');
}

function cleanIdempotencyKey(request: NextRequest, body?: Record<string, unknown>): string {
  const header = request.headers.get('Idempotency-Key')?.trim() || '';
  const fromBody = typeof body?.clientRequestId === 'string'
    ? body.clientRequestId.trim()
    : typeof body?.idempotencyKey === 'string'
      ? body.idempotencyKey.trim()
      : '';
  return header || fromBody;
}

export async function GET(request: NextRequest) {
  return withAuth(request, async (user: AuthUser) => {
    const db = getSupabaseClient();
    try {
      const [{ data: slotRows, error: slotError }, { data: userRow, error: userError }, offerResponse] = await Promise.all([
        db
          .from('voice_nest_slots')
          .select('id, slot_type, status, voice_id, purchased_at, used_at, price')
          .eq('user_id', user.id)
          .order('created_at', { ascending: false }),
        db
          .from('users')
          .select('voice_clone_authorized, cash_balance')
          .eq('id', user.id)
          .single(),
        db
          .from('voice_nest_price_versions')
          .select('id, version, unit_price_cash, currency, effective_at')
          .eq('status', 'active')
          .lte('effective_at', new Date().toISOString())
          .order('effective_at', { ascending: false })
          .order('id', { ascending: false })
          .limit(1)
          .maybeSingle(),
      ]);

      if (slotError || userError) {
        return NextResponse.json(
          {
            success: false,
            code: 'MIGRATION_NOT_READY',
            message: '音槽服务正在准备中，请稍后重试',
          },
          { status: 503 },
        );
      }

      if (offerResponse.error || !offerResponse.data) {
        return NextResponse.json(
          {
            success: false,
            code: offerResponse.error && migrationNotReady(offerResponse.error.message)
              ? 'MIGRATION_NOT_READY'
              : 'VOICE_NEST_PRICE_NOT_CONFIGURED',
            message: '音槽售价版本尚未配置并发布，已禁用购买',
          },
          { status: 503 },
        );
      }

      const offer = offerResponse.data as PriceRow;
      const unitPrice = Number(offer.unit_price_cash);
      if (!Number.isFinite(unitPrice) || unitPrice <= 0) {
        return NextResponse.json(
          {
            success: false,
            code: 'VOICE_NEST_PRICE_INVALID',
            message: '音槽售价快照无效，已禁用购买',
          },
          { status: 503 },
        );
      }

      const slots: NestSlotView[] = (slotRows || []).map((row: Record<string, unknown>) => ({
        id: row.id,
        slotType: row.slot_type,
        status: String(row.status ?? ''),
        voiceId: row.voice_id,
        purchasedAt: row.purchased_at,
        usedAt: row.used_at,
        price: row.price,
      }));

      return NextResponse.json({
        success: true,
        data: {
          slots,
          authorized: userRow?.voice_clone_authorized === true,
          cashBalance: Number(userRow?.cash_balance ?? 0),
          unusedCount: slots.filter((slot) => slot.status === 'unused').length,
          usedCount: slots.filter((slot) => slot.status === 'used').length,
          nestPrice: unitPrice,
          priceSnapshot: {
            id: String(offer.id),
            version: offer.version,
            unitPriceCash: unitPrice,
            currency: offer.currency,
            effectiveAt: offer.effective_at,
          },
        },
      });
    } catch (error) {
      console.error('[voice/nest] GET error:', error);
      return NextResponse.json(
        { success: false, code: 'VOICE_NEST_QUERY_FAILED', message: '查询音槽失败' },
        { status: 500 },
      );
    }
  });
}

export async function POST(request: NextRequest) {
  return withAuth(request, async (user: AuthUser) => {
    const db = getSupabaseClient();
    try {
      const body = await request.json() as Record<string, unknown>;
      const quantity = body.quantity;
      const idempotencyKey = cleanIdempotencyKey(request, body);

      if (typeof quantity !== 'number' || !Number.isSafeInteger(quantity) || quantity < 1 || quantity > 10) {
        return NextResponse.json(
          {
            success: false,
            code: 'VOICE_NEST_QUANTITY_INVALID',
            message: 'quantity 必须是 1..10 之间的安全整数',
          },
          { status: 400 },
        );
      }
      if (!idempotencyKey || idempotencyKey.length > 220) {
        return NextResponse.json(
          {
            success: false,
            code: 'VOICE_NEST_IDEMPOTENCY_KEY_REQUIRED',
            message: '购买音槽必须提供 1..220 字符的稳定 Idempotency-Key 或 clientRequestId',
          },
          { status: 400 },
        );
      }

      const { data, error } = await db.rpc('purchase_voice_nest_slots_atomic', {
        p_user_id: user.id,
        p_quantity: quantity,
        p_idempotency_key: idempotencyKey,
      });

      if (error) {
        const message = error.message || '';
        const code = migrationNotReady(message)
          ? 'MIGRATION_NOT_READY'
          : /PRICE_NOT_CONFIGURED/.test(message)
            ? 'VOICE_NEST_PRICE_NOT_CONFIGURED'
            : /AUTHORIZATION_REQUIRED/.test(message)
              ? 'VOICE_NEST_AUTHORIZATION_REQUIRED'
              : /INSUFFICIENT_CASH/.test(message)
                ? 'INSUFFICIENT_CASH'
                : /IDEMPOTENCY_CONFLICT/.test(message)
                  ? 'VOICE_NEST_IDEMPOTENCY_CONFLICT'
                  : /IN_PROGRESS/.test(message)
                    ? 'VOICE_NEST_PURCHASE_IN_PROGRESS'
                    : 'VOICE_NEST_PURCHASE_FAILED';
        const status = code === 'MIGRATION_NOT_READY' || code === 'VOICE_NEST_PRICE_NOT_CONFIGURED'
          ? 503
          : code === 'VOICE_NEST_AUTHORIZATION_REQUIRED'
            ? 403
            : code === 'INSUFFICIENT_CASH'
              ? 402
              : code.includes('CONFLICT') || code.includes('IN_PROGRESS')
                ? 409
                : 500;
        return NextResponse.json(
          { success: false, code, message: '购买音槽未完成' },
          { status },
        );
      }

      const result = data as NestPurchaseResult | null;
      const price = result?.price_snapshot;
      const unitPrice = Number(price?.unit_price_cash);
      const totalPrice = Number(price?.total_price_cash);
      const resultQuantity = Number(result?.quantity);
      const slotIds = Array.isArray(result?.slot_ids) ? result.slot_ids.map(String) : [];
      const balanceAfter = Number(result?.wallet?.balance_after);
      const walletOperationId = result?.wallet_operation_id || result?.wallet?.operation_id;
      const purchaseRequestId = result?.purchase_request_id == null
        ? ''
        : String(result.purchase_request_id);
      if (
        !result?.success
        || !purchaseRequestId
        || resultQuantity !== quantity
        || !price?.version
        || !Number.isFinite(unitPrice)
        || unitPrice <= 0
        || !Number.isFinite(totalPrice)
        || totalPrice <= 0
        || !Number.isFinite(balanceAfter)
        || walletOperationId == null
        || slotIds.length !== quantity
      ) {
        return NextResponse.json(
          {
            success: false,
            code: 'VOICE_NEST_PURCHASE_RESULT_INVALID',
            message: '原子购买返回结果无效，未交付音槽',
          },
          { status: 503 },
        );
      }

      return NextResponse.json({
        success: true,
        message: `成功购买 ${quantity} 个音槽`,
        data: {
          purchaseRequestId,
          purchasedCount: quantity,
          totalCost: totalPrice,
          balanceAfter,
          slotIds,
          walletOperationId: String(walletOperationId),
          alreadyFulfilled: result.already_fulfilled === true,
          priceSnapshot: {
            version: price.version,
            unitPriceCash: unitPrice,
            totalPriceCash: totalPrice,
            currency: price.currency || 'CNY',
          },
        },
      });
    } catch (error) {
      console.error('[voice/nest] POST error:', error);
      return NextResponse.json(
        { success: false, code: 'VOICE_NEST_PURCHASE_FAILED', message: '购买音槽失败' },
        { status: 500 },
      );
    }
  });
}
