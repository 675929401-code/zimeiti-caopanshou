/** Billing service keys consumed by the existing voice runtime, not provider model versions. */
export const VOICE_PRICING_SERVICES = [
  { modelId: 'seed-tts-2.0', name: '语音合成 2.0', resourceId: 'seed-tts-2.0', unit: '千字符', description: '标准版与表现力增强版共用此计价服务，具体版本在前台选择。' },
  { modelId: 'seed-tts-1.0', name: '多人混音合成', resourceId: 'seed-tts-1.0', unit: '千字符', description: '用于当前多人混音合成链路。' },
  { modelId: 'seed-icl-2.0', name: '已有复刻音色播放', resourceId: 'seed-icl-2.0', unit: '千字符', description: '用于已有授权复刻音色的合成播放，不开放新的声音训练。' },
  { modelId: 'seed-audio-1.0', name: '音频生成与音色模仿', resourceId: 'seed-tts-2.0', unit: '分钟', description: '用于音频生成和音色模仿，实际调用仍需供应商及音频授权就绪。' },
] as const;

export function voicePricingService(modelId: string) {
  return VOICE_PRICING_SERVICES.find(service => service.modelId === modelId);
}

export function voicePricingSupport(modelId: string) {
  const service = voicePricingService(modelId);
  if (service) return { status: 'supported', description: service.description };
  if (modelId === 'seed-icl-2.0-design') return { status: 'retired', description: '历史声音设计/复刻计价项；当前新增训练已关闭，训练授权计次不使用此计价项。保留记录不代表可以新增训练。' };
  return { status: 'unknown', description: '该计价项尚未接入运行服务；保留历史记录不代表可以生成。' };
}

export function voicePricingUnitMultiplier(unit: unknown): number {
  return unit === '千字符' ? 1000 : 1;
}

export class VoiceModelInputError extends Error {
  constructor(message: string, readonly code = 'VOICE_MODEL_INPUT_INVALID') { super(message); }
}

export function normalizeVoiceModelInput(body: Record<string, unknown>, previous: Record<string, unknown> = {}) {
  if (Object.hasOwn(body, 'costPrice')) throw new VoiceModelInputError('成本价由套餐价格和计费数量自动计算，请修改这两个字段');
  const value: Record<string, unknown> = { resourceId: '', unit: '千字符', profitMargin: 100, isActive: false, sort: 0, ...previous, ...body };
  const name = typeof value.name === 'string' ? value.name.trim() : '';
  const modelId = typeof value.modelId === 'string' ? value.modelId.trim() : '';
  const resourceId = typeof value.resourceId === 'string' ? value.resourceId.trim() || modelId : '';
  if (!name || name.length > 100 || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u.test(modelId) || !resourceId || resourceId.length > 160) throw new VoiceModelInputError('请填写有效的服务名称、计价服务标识和资源标识');
  if (previous.modelId && previous.modelId !== modelId) throw new VoiceModelInputError('现有计价服务标识不能修改，请新增支持的服务配置', 'VOICE_PRICING_SERVICE_ID_IMMUTABLE');
  if (![true, false, 0, 1].includes(value.isActive as boolean)) throw new VoiceModelInputError('服务启用状态无效');
  const active = value.isActive === true || value.isActive === 1;
  if (!voicePricingService(modelId) && (!previous.modelId || active)) throw new VoiceModelInputError(voicePricingSupport(modelId).status === 'retired' ? '该历史声音设计/复刻服务已停止新增训练，不能通过计价项重新启用；旧记录可明确停用后保留。' : '该语音服务尚未接入，不能通过添加计价项启用。请选择已支持的服务；旧记录可停用后保留编辑。', 'VOICE_PRICING_SERVICE_UNSUPPORTED');
  const number = (input: unknown) => typeof input === 'number' ? input : typeof input === 'string' && input.trim() ? Number(input) : NaN;
  const totalPrice = number(value.totalPrice), totalChars = number(value.totalChars), profitMargin = number(value.profitMargin), sort = number(value.sort);
  if (!Number.isFinite(totalPrice) || totalPrice <= 0 || !Number.isSafeInteger(totalChars) || totalChars <= 0) throw new VoiceModelInputError('请填写已确认的套餐价格和计费数量，二者必须大于0，计费数量必须是整数');
  if (!Number.isFinite(profitMargin) || profitMargin < 0 || profitMargin > 10000) throw new VoiceModelInputError('加价率必须在0%到10000%之间');
  if (!Number.isSafeInteger(sort) || Math.abs(sort) > 100000) throw new VoiceModelInputError('排序数值无效');
  if (!['千字符', '分钟', '次'].includes(String(value.unit))) throw new VoiceModelInputError('计费单位请选择千字符、分钟或次');
  const costPrice = totalPrice / totalChars * voicePricingUnitMultiplier(value.unit);
  if (!Number.isFinite(costPrice) || costPrice <= 0) throw new VoiceModelInputError('模型成本无效');
  return { name, modelId, resourceId, totalPrice, totalChars, costPrice, unit: value.unit, profitMargin, isActive: active ? 1 : 0, sort };
}
