import { NextRequest, NextResponse } from 'next/server';
import { authorizeCurrentApiUser } from '@/lib/current-api-user';
import { getSupabaseAdminClient } from '@/storage/database/supabase-client';
import { resolveProviderSecret } from '@/lib/provider-secret';
import { PersonAssetPreflightError, readPersonAssetPreflight } from '@/lib/server/digital-human-asset-preflight';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
const headers = { 'Cache-Control': 'private, no-store' };

export async function GET(request: NextRequest) {
  const auth = await authorizeCurrentApiUser(request);
  if (!auth.ok) return auth.response;
  try {
    const preflight = await readPersonAssetPreflight({ userId: auth.user.userId,
      assetId: request.nextUrl.searchParams.get('id') || '',
      publicModelId: request.nextUrl.searchParams.get('model') || '',
    }, { db: getSupabaseAdminClient(), resolveSecret: resolveProviderSecret });
    return NextResponse.json({ preflight }, { headers });
  } catch (cause) {
    const status = cause instanceof PersonAssetPreflightError ? cause.status : 503;
    return NextResponse.json(status === 404
      ? { code: 'ASSET_NOT_FOUND', error: '素材或模型暂不可用，请重新选择。' }
      : { code: 'PREFLIGHT_UNAVAILABLE', error: '素材预检暂时无法完成，请稍后重试。' }, { status, headers });
  }
}
