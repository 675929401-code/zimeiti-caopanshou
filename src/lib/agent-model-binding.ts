import { isPublishedTextModelEligible } from './text-model-eligibility';

type Model = Record<string, unknown>;
export function canonicalAgentModelBinding(modelId: unknown, model: Model | null) {
  const id = typeof modelId === 'string' ? modelId.trim() : '';
  if (!id || !model || model.id !== id) throw new Error('请选择已配置的文字模型');
  if (!isPublishedTextModelEligible(model)) {
    throw new Error('所选文字模型未启用或不可供智能体使用');
  }
  if (!String(model.api_key || '').trim() || !String(model.model_name || '').trim()) throw new Error('所选模型缺少凭据或模型名称');
  return { model_id: id, model: String(model.model_name) };
}
