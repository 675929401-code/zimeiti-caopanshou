import { curatedMainCatalogExecutionReadiness } from './commerce-curated-model-profiles';
import { modelMatchesIdentifier, type Kind, type Model } from './models';

export const DIRECTOR_PRIMARY_MODEL_ID = '3a998bfc-aab4-4f8f-9128-b27498894a7b';
export const DIRECTOR_FALLBACK_MODEL_ID = '9b177ccc-4afc-4d49-96bb-fdd01f09bf89';

export type PrequoteCandidateFailureCode =
  | 'missing'
  | 'not-executable'
  | 'price-not-ready'
  | 'capability-mismatch';

export type PrequoteCandidateEvaluation = {
  configuredId: string;
  modelId: string | null;
  displayName: string | null;
  ready: boolean;
  failureCode: PrequoteCandidateFailureCode | null;
  reason: string;
};

export type PrequoteModelSelectionSnapshot = {
  schema: 'commerce-prequote-model-selection/v1';
  operationId: string;
  routeRevision: number;
  selectionSource: 'user-selection' | 'operation-default' | 'kind-default';
  candidateIds: string[];
  candidates: PrequoteCandidateEvaluation[];
  selectedConfiguredId: string;
  selectedModelId: string;
  selectedModelConfigHash: string;
  selectedIndex: number;
  fallbackUsed: boolean;
  reason: string;
};

export type PrequoteSelectionRoute = {
  id: string;
  kind: Kind;
  revision: number;
  modelId: string;
  modelCandidateIds?: string[];
  selection: 'user-selection' | 'operation-default' | 'kind-default';
};

export type PrequoteSelectionRequirements = {
  requireCuratedMainCatalog?: boolean;
  requireImageParsing?: boolean;
};

function unique(values: readonly string[]): string[] {
  return values.map((value) => String(value || '').trim()).filter((value, index, rows) => Boolean(value) && rows.indexOf(value) === index);
}

export function orderedModelCandidateIds(input: {
  requestedModelId?: string;
  userSelectable?: boolean;
  primaryModelId?: string;
  fallbackModelIds?: readonly string[];
  kindDefaultModelId?: string;
}): { candidateIds: string[]; selection: PrequoteModelSelectionSnapshot['selectionSource'] } {
  const requested = String(input.requestedModelId || '').trim();
  if (requested) {
    if (input.userSelectable !== true) throw Error('此功能不允许用户覆盖后台模型路由');
    return { candidateIds: [requested], selection: 'user-selection' };
  }
  const operationCandidates = unique([String(input.primaryModelId || ''), ...(input.fallbackModelIds || [])]);
  if (operationCandidates.length) return { candidateIds: operationCandidates, selection: 'operation-default' };
  const kindDefault = String(input.kindDefaultModelId || '').trim();
  return { candidateIds: kindDefault ? [kindDefault] : [], selection: 'kind-default' };
}

function priceReadiness(model: Model): { ready: boolean; reason: string } {
  const cost = Number(model.costPrice);
  const price = Number(model.publicPrice);
  if (model.costPrice == null || !Number.isFinite(cost) || cost < 0) return { ready: false, reason: '成本价尚未配置' };
  if (!Number.isFinite(price) || price < 0) return { ready: false, reason: '销售价尚未配置' };
  if (price < cost) return { ready: false, reason: '销售价低于成本价' };
  if (price === 0 && model.capabilities.explicitlyFree !== true) return { ready: false, reason: '零元模型未显式标记免费' };
  return { ready: true, reason: '计费配置完整' };
}

function evaluateCandidate(
  kind: Kind,
  configuredId: string,
  catalog: readonly Model[],
  requirements: PrequoteSelectionRequirements,
): { evaluation: PrequoteCandidateEvaluation; model?: Model } {
  const model = catalog.find((entry) => entry.kind === kind && modelMatchesIdentifier(entry, configuredId));
  if (!model) return {
    evaluation: { configuredId, modelId: null, displayName: null, ready: false, failureCode: 'missing', reason: '模型不在当前可执行目录' },
  };
  if (model.capabilities.available === false || model.enabled === false) return {
    evaluation: { configuredId, modelId: model.id, displayName: model.displayName, ready: false, failureCode: 'not-executable', reason: String(model.capabilities.availabilityMessage || '模型当前未启用') },
  };
  if (requirements.requireCuratedMainCatalog) {
    const readiness = curatedMainCatalogExecutionReadiness(model);
    if (!readiness.ready) return {
      evaluation: { configuredId, modelId: model.id, displayName: model.displayName, ready: false, failureCode: 'not-executable', reason: readiness.reason },
    };
  } else {
    if (model.capabilities.executionSupported === false) return {
      evaluation: { configuredId, modelId: model.id, displayName: model.displayName, ready: false, failureCode: 'not-executable', reason: '模型执行桥接尚未接通' },
    };
    if (!/^[a-f0-9]{64}$/i.test(String(model.configHash || ''))) return {
      evaluation: { configuredId, modelId: model.id, displayName: model.displayName, ready: false, failureCode: 'not-executable', reason: '模型配置哈希缺失' },
    };
  }
  if (requirements.requireImageParsing && model.capabilities.imageParsing !== true) return {
    evaluation: { configuredId, modelId: model.id, displayName: model.displayName, ready: false, failureCode: 'capability-mismatch', reason: '模型不支持当前素材所需的图片理解' },
  };
  const pricing = priceReadiness(model);
  if (!pricing.ready) return {
    evaluation: { configuredId, modelId: model.id, displayName: model.displayName, ready: false, failureCode: 'price-not-ready', reason: pricing.reason },
  };
  return {
    model,
    evaluation: { configuredId, modelId: model.id, displayName: model.displayName, ready: true, failureCode: null, reason: '报价前执行与计费检查通过' },
  };
}

export function selectPrequoteModel(
  route: PrequoteSelectionRoute,
  catalog: readonly Model[],
  requirements: PrequoteSelectionRequirements = {},
): { model: Model; snapshot: PrequoteModelSelectionSnapshot } {
  const candidateIds = unique(route.modelCandidateIds?.length ? route.modelCandidateIds : [route.modelId]);
  if (!candidateIds.length) throw Error('此功能尚未配置模型候选');
  const evaluated = candidateIds.map((candidateId) => evaluateCandidate(route.kind, candidateId, catalog, requirements));
  const selectedIndex = evaluated.findIndex((item) => item.evaluation.ready && item.model);
  if (selectedIndex < 0) {
    const details = evaluated.map(({ evaluation }, index) => `${index === 0 ? '主模型' : `候补${index}`}：${evaluation.reason}`).join('；');
    throw Error(`此功能没有可报价的模型：${details}`);
  }
  const selected = evaluated[selectedIndex];
  const precedingReasons = evaluated.slice(0, selectedIndex).map(({ evaluation }, index) => `${index === 0 ? '主模型' : `候补${index}`}不可用：${evaluation.reason}`);
  const reason = selectedIndex === 0 ? '主模型通过报价前检查' : `${precedingReasons.join('；')}；已在报价前选择候补${selectedIndex}`;
  const model = selected.model!;
  return {
    model,
    snapshot: {
      schema: 'commerce-prequote-model-selection/v1',
      operationId: route.id,
      routeRevision: route.revision,
      selectionSource: route.selection,
      candidateIds,
      candidates: evaluated.map((item) => item.evaluation),
      selectedConfiguredId: candidateIds[selectedIndex],
      selectedModelId: model.id,
      selectedModelConfigHash: model.configHash,
      selectedIndex,
      fallbackUsed: selectedIndex > 0,
      reason,
    },
  };
}

export function assertFrozenPrequoteSelection(
  snapshot: PrequoteModelSelectionSnapshot,
  route: Pick<PrequoteSelectionRoute, 'id' | 'revision' | 'modelCandidateIds' | 'modelId'>,
  model: Pick<Model, 'id' | 'configHash'>,
): void {
  const currentCandidates = unique(route.modelCandidateIds?.length ? route.modelCandidateIds : [route.modelId]);
  if (snapshot.operationId !== route.id || snapshot.routeRevision !== route.revision || JSON.stringify(snapshot.candidateIds) !== JSON.stringify(currentCandidates)) {
    throw Error('报价对应的模型候选路由已经变化，请重新报价');
  }
  if (snapshot.selectedModelId !== model.id || snapshot.selectedModelConfigHash !== model.configHash) {
    throw Error('报价选中的模型配置已经变化，请重新报价');
  }
}
