import { DEPTH_MODEL_CAPABILITY_REQUIREMENTS, DEPTH_PURPOSE } from './depth-video-clone-schema';
import { baselineDirectorCatalog, directorCatalog, findDirectorCard } from './director-catalog';
import observedBase from '../components/commerce-agent/observed-catalog.json';
import { IMAGE_SKILLS } from '../components/commerce-agent/catalog';
import { get, put } from './store';
import { modelMatchesIdentifier,models, type Kind } from './models';
import { currentPublishedCommerceConfiguration } from './configuration-platform';
import { sharedConfigurationEnabled } from '../../storage/database/configuration-source';
import {isCuratedConfigurationSelectable,sameCuratedModelProfile} from './commerce-curated-model-profiles';
import {DIRECTOR_FALLBACK_MODEL_ID,DIRECTOR_PRIMARY_MODEL_ID,orderedModelCandidateIds} from './prequote-model-selection';

export type Operation = {
  id: string;
  label: string;
  kind: Kind;
  promptId: string;
  modelId: string;
  revision: number;
  stages: string[];
  observedKey?: string;
  userSelectable?: boolean;
  fallbackModelIds?: string[];
  capabilityRequirements?: Record<string, unknown>;
};

function operationRows(directors = directorCatalog()): Operation[] {
  const rows: Operation[] = [
    { id: 'agent.chat', label: 'Agent 多轮创作', kind: 'agent', promptId: 'agent', modelId: '', revision: 1, stages: ['整理需求与参考', '读取对话历史', '模型回复', '保存会话'], userSelectable: true },
    { id: 'video.generate', label: '视频生成', kind: 'video', promptId: 'video.generate', modelId: '', revision: 1, stages: ['核对素材与模型能力', '编译视频要求', '提交视频任务', '查询原任务', '保存视频资产'], userSelectable: true },
    { id: DEPTH_PURPOSE, label: '深度复刻：源视频与角色素材', kind: 'video', promptId: DEPTH_PURPOSE, modelId: '', revision: 1, stages: ['核对源视频与角色素材', '准备原片开头区间', '独立费用确认', '原生参考视频生成', '恢复原任务', '保存视频资产'], userSelectable: true, capabilityRequirements: DEPTH_MODEL_CAPABILITY_REQUIREMENTS },
    { id: 'detail-set.analyze', label: '商详套图：商品分析', kind: 'agent', promptId: 'detail-set.analyze', modelId: '', revision: 1, stages: ['商品参考与配置', '独立分析任务', '严格校验1–12屏', '逐屏编辑并保存'] },
    { id: 'detail-set.generate', label: '商详套图：逐屏生成', kind: 'image', promptId: 'detail-set.generate', modelId: '', revision: 1, stages: ['绑定分析与最终逐屏表', '确认报价', '逐屏创建图片任务', '原任务恢复', '资产保存与单屏版本'] },
    { id: 'prompt-assist.analyze', label: '帮我写：素材分析', kind: 'agent', promptId: 'prompt-assist.analyze', modelId: '', revision: 1, stages: ['素材校验', '费用确认', '模型分析', '校验商品洞察结构', '保存分析快照'] },
    { id: 'prompt-assist.script', label: '帮我写：创作脚本', kind: 'agent', promptId: 'prompt-assist.script', modelId: '', revision: 1, stages: ['读取用户确认的商品洞察', '绑定创作配置', '费用确认', '生成脚本', '预览并应用脚本'] },
    { id: 'prompt-assist.breakdown', label: '创意复刻：参考视频拆解', kind: 'agent', promptId: 'prompt-assist.breakdown', modelId: '', revision: 1, stages: ['本地视频证据', '独立费用确认', '参考结构拆解', '严格JSON与来源核对'] },
    { id: 'prompt-assist.remix-script', label: '创意复刻：新商品脚本', kind: 'agent', promptId: 'prompt-assist.remix-script', modelId: '', revision: 1, stages: ['确认商品事实与参考结构', '独立费用确认', '按目标时长改写', '校验时间轴和引用', '保存版本并应用'] },
  ];
  for (const skill of IMAGE_SKILLS) {
    rows.push({
      id: `image.${skill.id}`, label: skill.name, kind: 'image', promptId: skill.id, modelId: '', revision: 1,
      observedKey: observedBase.images.find((entry: { name: string; default?: boolean }) => entry.name === skill.name || skill.id === 'default' && entry.default)?.key,
      stages: ['核对素材角色与数量', '加载技能提示词版本', '绑定图片角色与参数', '图片生成/编辑', '转换导出格式', '保存图片资产'],
      userSelectable: true,
    });
  }
  for (const director of directors) {
    rows.push({
      id: `director.${director.key}`, label: director.name === '默认' ? '默认编导' : `${director.name}编导`, kind: 'agent',
      promptId: `director.${director.key}`, modelId: DIRECTOR_PRIMARY_MODEL_ID, revision: 1, observedKey: director.key,
      stages: ['核对编导参考槽位', '读取编导历史', '加载专项提示词', '组装语言和脚本时长', '生成/修订脚本', '用户确认脚本', '进入视频生成'],
      userSelectable: false,
      fallbackModelIds: [DIRECTOR_FALLBACK_MODEL_ID],
    });
  }
  return rows;
}

export function baselineOperations(): Operation[] {
  return operationRows(baselineDirectorCatalog());
}

export function operations(): Operation[] {
  const baseline = operationRows();
  const published = currentPublishedCommerceConfiguration();
  if (published) {
    return published.routes.map((policy) => {
      const original = baseline.find((row) => row.id === policy.operationId);
      return {
        id: policy.operationId, label: policy.label, kind: policy.modelKind, promptId: original?.promptId || policy.operationId,
        modelId: policy.primaryModelId, revision: policy.version, stages: original?.stages || [], observedKey: original?.observedKey,
        userSelectable: policy.userSelectable, fallbackModelIds: policy.fallbackModelIds, capabilityRequirements: { ...policy.capabilityRequirements, ...(original?.capabilityRequirements || {}) },
      };
    });
  }
  // Shared configuration is the sole runtime authority when enabled. If it
  // has no published release, expose the safe baseline for drafting but never
  // fall back to the superseded local operation-route overlay.
  if (sharedConfigurationEnabled()) return baseline;
  return baseline.map((row) => {
    const saved = get<{ modelId: string; revision: number }>('operation-routes', row.id, 'system');
    return saved ? { ...row, ...saved } : row;
  });
}

export function operationFor(input: { kind: Kind; skillId?: string; purpose?: string; director?: string }) {
  const id = input.purpose === DEPTH_PURPOSE ? DEPTH_PURPOSE
    : input.purpose?.startsWith('detail-set.') ? input.purpose
    : input.kind === 'image' ? `image.${input.skillId || 'default'}`
    : input.kind === 'video' ? 'video.generate'
    : input.purpose?.startsWith('prompt-assist.') ? input.purpose
    : input.purpose === 'director' ? `director.${findDirectorCard(input.director || '')?.key || 'default-director'}`
    : 'agent.chat';
  const row = operations().find((entry) => entry.id === id);
  if (!row || row.kind !== input.kind) throw Error('创作功能路由不存在或类型不匹配');
  return row;
}

export function resolveOperation(input: { kind: Kind; modelId?: string; skillId?: string; purpose?: string; director?: string }) {
  const route = operationFor(input);
  const published = currentPublishedCommerceConfiguration();
  const defaults = published?.defaultModels || get<Record<string, string>>('settings', 'defaults', 'system') || {};
  const suppliedModelId=String(input.modelId||'').trim();
  const ordered=orderedModelCandidateIds({requestedModelId:suppliedModelId,userSelectable:route.userSelectable,primaryModelId:route.modelId,fallbackModelIds:route.fallbackModelIds,kindDefaultModelId:defaults[input.kind]});
  const requestedModelId = ordered.selection==='user-selection' ? suppliedModelId : '';
  if(requestedModelId&&(route.kind==='agent'||route.kind==='image')&&!isCuratedConfigurationSelectable(route.kind,requestedModelId))throw Error('所选模型不在带货 Agent 已审核白名单');
  if(requestedModelId&&published&&route.kind==='video'){
    const allowed=[route.modelId,...(route.fallbackModelIds||[])].filter(Boolean);
    if(!allowed.some(id=>id===requestedModelId||sameCuratedModelProfile(route.kind,id,requestedModelId)))throw Error('所选模型尚未发布用于此功能，请重新选择');
  }
  const modelId = ordered.candidateIds[0];
  if (!modelId) throw Error('此功能尚未发布默认模型，请联系管理员');
  if((route.kind==='agent'||route.kind==='image')&&ordered.candidateIds.some(id=>!isCuratedConfigurationSelectable(route.kind,id)))throw Error('此功能绑定的模型候选不在带货 Agent 已审核白名单');
  return { ...route, modelId, modelCandidateIds:ordered.candidateIds, selection:ordered.selection };
}

/** Legacy draft writer retained only for migration; published runtime reads commerce_operation_routes. */
export async function saveOperation(id: string, modelId: string) {
  const row = operations().find((entry) => entry.id === id);
  if (!row) throw Error('功能路由不存在');
  if (modelId && !(await models(row.kind)).some((model) => modelMatchesIdentifier(model,modelId) && model.capabilities.available !== false)) throw Error('模型不存在或暂不可用');
  const value = { modelId, revision: row.revision + 1 };
  put('operation-routes', id, 'system', value);
  return { ...row, ...value };
}

export function validateDirector(input: { purpose?: string; director?: string; spokenLanguage?: string; scriptDuration?: number; references?: { id: string; slot: string }[] }, refs: { id: string; type: string }[]) {
  if (input.purpose !== 'director') return;
  const spec = findDirectorCard(input.director || '');
  if (!spec) throw Error('请选择有效的编导技能');
  for (const slot of spec.slots) {
    const selected = (input.references || []).filter((reference) => reference.slot === slot.key);
    if (selected.length < slot.min || selected.length > slot.max) throw Error(`${slot.label}需要 ${slot.min}–${slot.max} 个素材`);
    if (selected.some((reference) => !slot.kinds.some((kind) => refs.find((asset) => asset.id === reference.id)?.type.startsWith(`${kind}/`)))) throw Error(`${slot.label}素材类型不符`);
  }
  if ((input.references || []).some((reference) => !spec.slots.some((slot) => slot.key === reference.slot))) throw Error('请将参考素材分配到当前编导对应的槽位');
}
