export const DETAIL_QUALITY_OPTIONS = [
  { value: 'medium', label: '标准' },
  { value: 'high', label: '高' },
  { value: 'xhigh', label: '超高' },
] as const;
export type DetailImageQuality = typeof DETAIL_QUALITY_OPTIONS[number]['value'];

export function isDetailImageQuality(value: unknown): value is DetailImageQuality {
  return DETAIL_QUALITY_OPTIONS.some(option => option.value === value);
}

export function detailJobQuality(value: DetailImageQuality | undefined, capabilities: Record<string, unknown>) {
  const options = capabilities.detailImageQualities;
  if (value !== undefined && (!isDetailImageQuality(value) || !Array.isArray(options) || !options.includes(value))) {
    throw Error('当前出图模型不支持已选画质，请回到图片设置使用模型默认画质。');
  }
  if (value !== undefined) return value;
  const preset = capabilities.detailDefaultQuality;
  return Array.isArray(options) && options.length && (isDetailImageQuality(preset) || preset==='low' || preset==='max') ? preset : undefined;
}

export function supportsWorkspaceQuality(capabilities:Record<string,unknown>, value:unknown): value is DetailImageQuality {
  return isDetailImageQuality(value) && Array.isArray(capabilities.detailImageQualities) && capabilities.detailImageQualities.includes(value);
}

export function assertWorkspaceImageQuality(kind:string, value:unknown, capabilities:Record<string,unknown>) {
  if(value!==undefined && (kind!=='image' || !supportsWorkspaceQuality(capabilities,value))) {
    throw Error('当前模型不支持选定的图片画质，请重新选择画质或模型。');
  }
}
