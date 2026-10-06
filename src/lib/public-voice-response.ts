const supplierFields = new Set(['costPrice', 'costPriceRmb', 'profitRmb', 'profitMargin', 'real_cost', 'cost_per_10k', 'profit', 'rawError', 'providerDiagnostic', 'logId', 'logid']);

function memberVoiceMessage(message: string): string {
  if (/VOICE_PROVIDER_QUEUE_BUSY|quota exceeded for types: concurrency|45000292|too many requests|rate.?limit/iu.test(message)) return '当前语音请求较多，请稍后再试。';
  if (/arrearage|insufficient.?quota|quota.*(?:exceed|insufficient)|payment required/iu.test(message)) return '当前语音服务额度不足，暂时无法合成，请稍后再试。';
  if (/requested resource not granted|not authorized|unauthorized|forbidden|45000030/iu.test(message)) return '当前语音服务未获得该音色或功能的调用权限，请选择其他可用音色。';
  if (/InvalidModel|Invalid argument|45000001/iu.test(message)) return '所选音色与语音模型参数不匹配，请重新选择后提交。';
  if (/ETIMEDOUT|ECONNRESET|ECONNREFUSED|fetch failed|socket hang up|timed? ?out/iu.test(message)) return '语音服务连接暂时不稳定，请查看任务状态后再试。';
  if (/火山.*(?:API|错误:)|logid:|resource_id=/iu.test(message)) return '语音服务暂时无法完成本次合成，请稍后再试。';
  return message;
}

/** Keep supplier accounting in the durable receipt, but out of member responses. */
export function publicVoiceResponse(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(publicVoiceResponse);
  if (!value || typeof value !== 'object') return value;
  const record = value as Record<string, unknown>;
  const result = Object.fromEntries(Object.entries(record).filter(([key]) => !supplierFields.has(key)).map(([key, item]) => [key,
    (key === 'message' || key === 'error') && typeof item === 'string' ? memberVoiceMessage(item) : publicVoiceResponse(item)]));
  const data = record.data as Record<string, unknown> | undefined;
  if (result.message !== record.message && typeof result.message === 'string') {
    if (data?.terminalStatus === 'refunded') result.message += '本次费用已退回。';
    else if (data?.upstreamSubmitted === false && data?.creditsCharged === 0) result.message += '本次未扣费。';
  }
  return result;
}
