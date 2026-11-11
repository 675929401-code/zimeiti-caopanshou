/**
 * 功能→模型映射位（第一批，只读）。
 *
 * 映射存放在现有表 commerce_operation_routes（按 operationId 一条路由），
 * 运行时以当前已发布版本为准（configuration-platform.ts 的 route()）。
 * primary_model_id 为空字符串即「未配置模型」。本文件不建表、不写迁移，
 * 也不含任何模型 id 或单价；所有模型 id 都来自配置。
 */
import type { CommerceModelKind } from './configuration-types';

export const UNCONFIGURED_MODEL_LABEL = '未配置模型';

export type OperationModelSource = 'published-route' | 'none';

export interface OperationModelMappingEntry {
  operationId: string;
  label: string;
  modelKind: CommerceModelKind | null;
  configured: boolean;
  primaryModelId: string;
  fallbackModelIds: string[];
  /** 已配置时为主模型 id，未配置时为「未配置模型」。 */
  displayModel: string;
  routeVersion: number | null;
  source: OperationModelSource;
}

export interface OperationRegistryItem {
  id: string;
  label: string;
  kind: CommerceModelKind;
}

export interface OperationRouteLike {
  operationId: string;
  label?: string;
  modelKind?: CommerceModelKind;
  primaryModelId?: string | null;
  fallbackModelIds?: string[];
  version?: number;
}

export function operationModelDisplay(primaryModelId: unknown): { configured: boolean; primaryModelId: string; displayModel: string } {
  const id = typeof primaryModelId === 'string' ? primaryModelId.trim() : '';
  return { configured: id !== '', primaryModelId: id, displayModel: id || UNCONFIGURED_MODEL_LABEL };
}

function entryFromRoute(route: OperationRouteLike, registry?: OperationRegistryItem): OperationModelMappingEntry {
  const display = operationModelDisplay(route.primaryModelId);
  return {
    operationId: route.operationId,
    label: String(route.label || registry?.label || route.operationId),
    modelKind: route.modelKind || registry?.kind || null,
    ...display,
    fallbackModelIds: display.configured && Array.isArray(route.fallbackModelIds) ? route.fallbackModelIds.filter((id) => typeof id === 'string' && id.trim() !== '') : [],
    routeVersion: Number.isFinite(Number(route.version)) ? Number(route.version) : null,
    source: 'published-route',
  };
}

/**
 * 以代码里的功能登记表（operation-routing.ts 的 operationRows）为行，
 * 用已发布路由填主模型；没有已发布路由或主模型为空的功能显示「未配置模型」。
 * 已发布但不在登记表里的路由追加在末尾，不丢弃。
 */
export function buildOperationModelMapping(input: { registry: OperationRegistryItem[]; publishedRoutes: OperationRouteLike[] | null }): OperationModelMappingEntry[] {
  const routes = new Map<string, OperationRouteLike>();
  for (const route of input.publishedRoutes || []) {
    if (route && typeof route.operationId === 'string' && route.operationId && !routes.has(route.operationId)) routes.set(route.operationId, route);
  }
  const seen = new Set<string>();
  const entries: OperationModelMappingEntry[] = [];
  for (const item of input.registry) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    const route = routes.get(item.id);
    entries.push(route ? entryFromRoute(route, item) : {
      operationId: item.id,
      label: item.label,
      modelKind: item.kind,
      ...operationModelDisplay(''),
      fallbackModelIds: [],
      routeVersion: null,
      source: 'none',
    });
  }
  for (const [operationId, route] of routes) {
    if (seen.has(operationId)) continue;
    seen.add(operationId);
    entries.push(entryFromRoute(route));
  }
  return entries;
}
