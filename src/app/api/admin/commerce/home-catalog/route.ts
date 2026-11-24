import { NextRequest, NextResponse } from 'next/server';
import { requireCommerceAdmin } from '@/lib/commerce-admin-auth';
import {
  homeCatalogAdminOverview,
  publishHomeCatalogEntry,
  resetHomeCatalogEntry,
  saveHomeCatalogDraft,
  setHomeCatalogEntryStatus,
} from '@/commerce/server/home-catalog';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const auth = await requireCommerceAdmin(request, { requiredPermissions: ['agents.view'], operation: 'commerce_home_catalog_view' });
  if ('response' in auth) return auth.response;
  try {
    return NextResponse.json({ ok: true, overview: await homeCatalogAdminOverview() }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : '读取失败' }, { status: 503 });
  }
}

export async function POST(request: NextRequest) {
  const auth = await requireCommerceAdmin(request, { mutation: true, requiredPermissions: ['agents.manage'], stepUpPermissions: ['agents.manage'], operation: 'commerce_home_catalog_update' });
  if ('response' in auth) return auth.response;
  try {
    const body = await request.json();
    const action = String(body.action || '');
    const actorId = String(auth.actor.userId || '');
    if (action === 'saveDraft') return NextResponse.json({ ok: true, entry: await saveHomeCatalogDraft(actorId, body) });
    if (action === 'publish') return NextResponse.json({ ok: true, entry: await publishHomeCatalogEntry(actorId, body) });
    if (action === 'setStatus') return NextResponse.json({ ok: true, entry: await setHomeCatalogEntryStatus(actorId, body) });
    if (action === 'reset') return NextResponse.json({ ok: true, entry: await resetHomeCatalogEntry(actorId, body) });
    throw Error('不支持的操作');
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : '保存失败' }, { status: 400 });
  }
}
