/** Public states only. This observation never authorizes a generation. */
export type PersonAssetPreflight = {
  ownership: 'owned';
  version: 'matched' | 'unmatched' | 'unverified';
  content: 'unverified';
  cache: 'ready_record' | 'missing' | 'pending' | 'reconciliation_required' | 'failed' | 'unavailable';
  fee: 'verified' | 'unverified';
  generationAuthorized: false;
};

export function hasPersonAssetPreflightCandidate(models: Array<{ capabilities: Record<string, unknown> }>): boolean {
  return models.some(model => model.capabilities.supportsPersonAssetPreflight === true);
}

export const PERSON_ASSET_PREFLIGHT_COPY = {
  ready_record: '已有匹配当前素材版本的就绪登记记录；实际内容仍需在提交时核验。',
  missing: '当前素材尚无匹配的登记记录。',
  pending: '已有登记正在处理，请等待原操作确认，避免重复提交。',
  reconciliation_required: '原登记结果需要核对，请联系管理员确认后再继续。',
  failed: '原登记未完成，请联系管理员核对。',
  unavailable: '登记状态暂时无法读取，请稍后重试。',
} as const;
