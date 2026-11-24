import { NextRequest, NextResponse } from 'next/server';
import { requireCommerceAdmin } from '@/lib/commerce-admin-auth';
import { baselineOperations } from '@/commerce/server/operation-routing';
import { currentPublishedCommerceConfiguration, primePublishedCommerceConfiguration } from '@/commerce/server/configuration-platform';
import { listPromptCards } from '@/commerce/server/prompt-cards';
import { PROMPT_CARD_FIELD_NAMES_STATUS, projectPromptCardForAdmin } from '@/commerce/shared/prompt-card-registry';

export const runtime = 'nodejs'; export const dynamic = 'force-dynamic';
const noStore = { 'Cache-Control': 'no-store' };

/** 管理员专用、只读：提示词卡片列表（含 operationId 与 id 状态）。匿名 401，非管理员 403。 */
export async function GET(request: NextRequest) {
  const auth = await requireCommerceAdmin(request, { requiredPermissions: ['prompts.view'], operation: 'commerce_prompt_card_view' });
  if ('response' in auth) return auth.response;
  try {
    const rows = await listPromptCards();
    await primePublishedCommerceConfiguration({ required: false });
    const published = currentPublishedCommerceConfiguration();
    const routes = published ? published.routes : null;
    const allowed = new Set([...baselineOperations().map((item) => item.id), ...(routes || []).map((route) => route.operationId)]);
    const items = rows.map((row) => projectPromptCardForAdmin(row, routes, allowed));
    return NextResponse.json({ ok: true, fieldNamesStatus: PROMPT_CARD_FIELD_NAMES_STATUS, releaseId: published?.releaseId ?? null, items }, { headers: noStore });
  } catch {
    return NextResponse.json({ ok: false, code: 'PROMPT_CARDS_UNAVAILABLE', error: '提示词卡片暂不可读取' }, { status: 503, headers: noStore });
  }
}
