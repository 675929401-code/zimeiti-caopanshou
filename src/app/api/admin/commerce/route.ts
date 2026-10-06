import { NextRequest, NextResponse } from 'next/server';
import { requireCommerceAdmin } from '@/lib/commerce-admin-auth';
import { commerceAdminOverview } from '@/commerce/server/configuration-admin';
import { commerceConfigurationStatus } from '@/commerce/server/configuration-platform';
import { configurationSourceStatus } from '@/storage/database/configuration-source';
import { models } from '@/commerce/server/models';
import { commerceModelAcceptanceIndex, commerceModelAcceptanceKey } from '@/commerce/server/model-acceptance';

export const runtime = 'nodejs'; export const dynamic = 'force-dynamic';
export async function GET(request: NextRequest) {
  const auth = await requireCommerceAdmin(request, {
    requiredPermissions: ['agents.view', 'prompts.view', 'models.view'],
    stepUpPermissions: ['prompts.view'],
    operation: 'commerce_configuration_overview',
  });
  if ('response' in auth) return auth.response;
  try { const [overview, agent, image, video, acceptance] = await Promise.all([commerceAdminOverview(), models('agent'), models('image'), models('video'), commerceModelAcceptanceIndex()]); const safeModels=[...agent,...image,...video].map(model=>{const evidence=acceptance.get(commerceModelAcceptanceKey(model.kind,model.id,model.configHash));return {id:model.id,displayName:model.displayName,kind:model.kind,publicPrice:model.publicPrice,costPrice:model.costPrice,billingUnit:model.billingUnit,configHash:model.configHash,verifiedAt:evidence?.verifiedAt||null,available:model.capabilities.available!==false,explicitlyFree:model.capabilities.explicitlyFree===true};}); return NextResponse.json({ ok: true, ...overview, models:safeModels, runtime: commerceConfigurationStatus(), storage: configurationSourceStatus() }, { headers: { 'Cache-Control': 'no-store' } }); }
  catch (error) { return NextResponse.json({ ok: false, code: 'COMMERCE_ADMIN_UNAVAILABLE', error: error instanceof Error ? error.message : '带货后台暂不可用' }, { status: 503 }); }
}
