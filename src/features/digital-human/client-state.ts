import { getVideoDurationCapabilities } from '@/lib/video-model-capabilities';
export type HumanMode = 'photo' | 'video';
export type HumanAsset = { id: string; category: 'image' | 'audio' | 'video'; url: string; duration: number; width: number; height: number; size: number };
export type HumanRetrySource = {
  personAssetId: string;
  audioAssetId: string;
  durationChoice?: '' | 'preserve_audio' | 'trim_audio';
};
export type HumanJob = {
  requestId: string;
  taskId: string;
  businessId: string;
  modelId: string;
  modelName: string;
  mode: HumanMode;
  status: string;
  error: string;
  createdAt: string;
  resolution: string;
  duration: number;
  price: number;
  videoUrl?: string;
  canRetry?: boolean;
  canHide?: boolean;
  retrySource?: HumanRetrySource;
};
export const humanJobPending = (job: HumanJob) => !['completed', 'failed', 'cancelled', 'expired'].includes(job.status);
const prefix = (userId: string) => `digital-human:pending:v1:${userId}:`;
export function saveHumanJob(storage: Storage, userId: string, job: HumanJob) {
  const key = prefix(userId) + job.requestId;
  if (!humanJobPending(job)) { storage.setItem(key, JSON.stringify({ userId, settled: true })); return; }
  if (JSON.parse(storage.getItem(key) || 'null')?.settled === true) return;
  // Signed playback URLs are short-lived; only save the original task receipt.
  const value = JSON.stringify({ userId, job: { ...job, videoUrl: undefined } });
  storage.setItem(key, value);
  if (storage.getItem(key) !== value) throw new Error('浏览器暂时无法保存任务，本次尚未提交');
}
export function readHumanJobs(storage: Storage, userId: string): HumanJob[] {
  const result: HumanJob[] = [];
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i); if (!key?.startsWith(prefix(userId))) continue;
    const value = JSON.parse(storage.getItem(key) || 'null');
    if (value?.userId === userId && value.settled === true) continue;
    if (value?.userId !== userId || !value.job?.requestId || !value.job?.modelId || !['photo', 'video'].includes(value.job.mode)) throw new Error('原任务记录暂时无法读取，请保留本页并稍后重试');
    result.push({ ...value.job, status: value.job.taskId ? value.job.status : 'unknown' });
  }
  return result;
}
export type HumanPriceModel = { publicPrice: number; capabilities: Record<string, unknown> };
export function humanUnitPrice(model: HumanPriceModel | undefined, resolution: string) {
  if (!model) return 0;
  const prices = Array.isArray(model.capabilities.resolutionPrices) ? Object.fromEntries(model.capabilities.resolutionPrices.map(String).map(item => item.split('='))) : {};
  return Number(prices[resolution] ?? model.publicPrice);
}
export function humanBillingSeconds(model: HumanPriceModel | undefined, seconds: number) {
  if (!model || !seconds) return 0;
  const source = { ...model, ...model.capabilities, durationSeconds: model.capabilities.defaultDuration };
  const caps = getVideoDurationCapabilities(source);
  // A digital person's speech must never round down to a shorter task.
  if (caps.mode === 'fixed') return seconds <= caps.defaultDuration ? caps.defaultDuration : 0;
  if (caps.mode === 'discrete') return caps.nativeDurations.find(value => value + 1e-8 >= seconds) ?? 0;
  const protocol = (model as HumanPriceModel & { api_protocol_config?: Record<string, unknown> }).api_protocol_config;
  const step = Number(model.capabilities.durationStep ?? protocol?.duration_step ?? 0.1);
  const target = Math.round((caps.minDuration + Math.ceil((seconds - caps.minDuration - 1e-8) / step) * step) * 10) / 10;
  return target <= caps.maxDuration ? Math.max(caps.minDuration, target) : 0;
}
export function humanQuote(model: HumanPriceModel | undefined, resolution: string, seconds: number) {
  if (!model) return 0;
  const quantity = model.capabilities.billingUnit === 'output_second' ? humanBillingSeconds(model, seconds) : 1;
  // Match resolveVideoCharge (4 decimals) and the terminal wallet snapshot (cents).
  const amount = Math.round(humanUnitPrice(model, resolution) * quantity * 10000) / 10000;
  return Math.round((amount + Number.EPSILON) * 100) / 100;
}
