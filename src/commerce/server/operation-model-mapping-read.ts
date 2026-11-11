import { NextResponse } from 'next/server';
import {
  UNCONFIGURED_MODEL_LABEL,
  buildOperationModelMapping,
  type OperationRegistryItem,
  type OperationRouteLike,
} from '../shared/operation-model-mapping';

type AuthorizationOutcome = { actor: unknown } | { response: Response };

export interface OperationModelMappingReadDependencies {
  /** 生产接 requireCommerceAdmin；非管理员返回 401/403 响应。 */
  authorize: (request: Request) => Promise<AuthorizationOutcome>;
  /** 代码内功能登记表（只取 id/label/kind，不取代码里的默认模型）。 */
  loadRegistry: () => OperationRegistryItem[];
  /** 当前已发布的 commerce_operation_routes；无已发布版本时 routes 为 null。 */
  loadPublishedRoutes: () => Promise<{ releaseId: string | null; routes: OperationRouteLike[] | null }>;
}

const noStore = { 'Cache-Control': 'no-store' };

/** 管理员专用只读接口：功能→模型映射。依赖注入只为本机夹具测试，生产用路由文件里的默认实现。 */
export function createOperationModelMappingReadHandler(dependencies: OperationModelMappingReadDependencies) {
  return async function readOperationModelMapping(request: Request): Promise<Response> {
    const authorization = await dependencies.authorize(request);
    if ('response' in authorization) return authorization.response;
    try {
      const registry = dependencies.loadRegistry();
      const published = await dependencies.loadPublishedRoutes();
      const entries = buildOperationModelMapping({ registry, publishedRoutes: published.routes });
      return NextResponse.json({
        ok: true,
        source: 'commerce_operation_routes',
        releaseId: published.releaseId,
        published: published.routes !== null,
        unconfiguredLabel: UNCONFIGURED_MODEL_LABEL,
        configuredCount: entries.filter((entry) => entry.configured).length,
        entries,
      }, { headers: noStore });
    } catch {
      return NextResponse.json({ ok: false, code: 'OPERATION_MODEL_MAPPING_UNAVAILABLE', error: '功能→模型映射暂不可读取' }, { status: 503, headers: noStore });
    }
  };
}
