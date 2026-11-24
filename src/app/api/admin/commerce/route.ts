import { NextRequest, NextResponse } from 'next/server';
import { requireCommerceAdmin } from '@/lib/commerce-admin-auth';
import { commerceAdminOverview } from '@/commerce/server/configuration-admin';
import { commerceConfigurationStatus, currentPublishedCommerceConfiguration } from '@/commerce/server/configuration-platform';
import { configurationSourceStatus } from '@/storage/database/configuration-source';
import { models } from '@/commerce/server/models';
import { commerceModelAcceptanceIndex, commerceModelAcceptanceKey } from '@/commerce/server/model-acceptance';
import { scenePromptWorkbench } from '@/commerce/server/scene-prompt-workbench';
import {classifyDepthCloneModel} from '@/commerce/server/depth-video-clone-model-profiles';
import { directorCatalog } from '@/commerce/server/director-catalog';
import { operations } from '@/commerce/server/operation-routing';
import { resolveOperationPrompt } from '@/commerce/server/prompts';

export const runtime = 'nodejs'; export const dynamic = 'force-dynamic';
export async function GET(request: NextRequest) {
  const auth = await requireCommerceAdmin(request, {
    requiredPermissions: ['agents.view', 'prompts.view', 'models.view'],
    stepUpPermissions: ['prompts.view'],
    operation: 'commerce_configuration_overview',
  });
  if ('response' in auth) return auth.response;
  try {
    const [overview, agent, image, video, acceptance] = await Promise.all([commerceAdminOverview(), models('agent'), models('image'), models('video'), commerceModelAcceptanceIndex()]);
    const safeModels = [...agent, ...image, ...video].map(model => {
      const evidence = acceptance.get(commerceModelAcceptanceKey(model.kind, model.id, model.configHash));
      return { id: model.id, displayName: model.displayName, kind: model.kind, publicPrice: model.publicPrice, costPrice: model.costPrice,
        billingUnit: model.billingUnit, configHash: model.configHash, verifiedAt: evidence?.verifiedAt || null,
        sourceVideoProfile: model.kind==='video'&&model.capabilities.supportsGenerateAudioToggle===true?classifyDepthCloneModel(model):null,
        available: model.capabilities.available !== false, explicitlyFree: model.capabilities.explicitlyFree === true };
    });
    const configuration = currentPublishedCommerceConfiguration();
    const routes = new Map(operations().map(route => [route.id, route]));
    const directorBindings = directorCatalog().map(card => {
      const operationId = `director.${card.key}`;
      const route = routes.get(operationId);
      const releasedCard = configuration?.cards.find(item => item.stableKey === card.key);
      let prompt = null;
      try {
        const resolved = resolveOperationPrompt(route?.promptId || operationId, releasedCard?.promptVersionId, configuration);
        prompt = { ...resolved.prompt, versionId: resolved.publishedPrompt?.id ?? null };
      } catch { /* Keep cards with a missing binding visible so admins can repair them. */ }
      return { key: card.key, name: card.name, category: card.category, operationId, prompt, releaseId: configuration?.releaseId ?? null,
        cardVersionId: releasedCard?.id ?? null, primaryModelId: route?.modelId ?? '', fallbackModelIds: route?.fallbackModelIds ?? [],
        routeVersion: route?.revision ?? null, capabilityRequirements: route?.capabilityRequirements ?? {} };
    });
    return NextResponse.json({ ok: true, ...overview, directorBindings, scenePrompts:scenePromptWorkbench(), models: safeModels, runtime: commerceConfigurationStatus(), storage: configurationSourceStatus() }, { headers: { 'Cache-Control': 'no-store' } });
  }
  catch (error) { return NextResponse.json({ ok: false, code: 'COMMERCE_ADMIN_UNAVAILABLE', error: error instanceof Error ? error.message : '带货后台暂不可用' }, { status: 503 }); }
}
