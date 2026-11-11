import { NextRequest } from 'next/server';
import { requireCommerceAdmin } from '@/lib/commerce-admin-auth';
import { baselineOperations } from '@/commerce/server/operation-routing';
import { currentPublishedCommerceConfiguration, primePublishedCommerceConfiguration } from '@/commerce/server/configuration-platform';
import { createOperationModelMappingReadHandler } from '@/commerce/server/operation-model-mapping-read';

export const runtime = 'nodejs'; export const dynamic = 'force-dynamic';

const readOperationModelMapping = createOperationModelMappingReadHandler({
  authorize: (request) => requireCommerceAdmin(request as NextRequest, {
    requiredPermissions: ['models.view'],
    operation: 'commerce_operation_model_mapping_view',
  }),
  loadRegistry: () => baselineOperations().map(({ id, label, kind }) => ({ id, label, kind })),
  loadPublishedRoutes: async () => {
    await primePublishedCommerceConfiguration({ required: false });
    const published = currentPublishedCommerceConfiguration();
    return { releaseId: published?.releaseId ?? null, routes: published ? published.routes : null };
  },
});

/** 管理员专用：功能→模型映射（只读，来源 commerce_operation_routes 已发布版本）。 */
export async function GET(request: NextRequest) {
  return readOperationModelMapping(request);
}
