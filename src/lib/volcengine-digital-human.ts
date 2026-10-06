import { createHash, createHmac } from 'node:crypto';
import { videoProviderFetch as fetch } from './video-provider-request-audit';
import type { VideoGenerateParams, VideoModelConfig, VideoTaskResult } from './video-adapter';

type Credentials = { accessKeyId: string; secretAccessKey: string };
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const hmac = (key: string | Buffer, value: string) => createHmac('sha256', key).update(value).digest();
// Official CV signature: date -> region -> service -> request (no AWS4 prefix).
export function signVisualRequest(url: URL, body: string, credential: Credentials, date = new Date()) {
  const timestamp = date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const day = timestamp.slice(0, 8), scope = day + '/cn-north-1/cv/request';
  url.searchParams.sort();
  const headers: Record<string, string> = { 'content-type': 'application/json', host: url.host, 'x-content-sha256': sha(body), 'x-date': timestamp };
  const signed = Object.keys(headers).sort().join(';');
  const canonical = ['POST', url.pathname || '/', url.search.slice(1).replace(/\+/g, '%20'), Object.keys(headers).sort().map(key => key + ':' + headers[key] + '\n').join(''), signed, sha(body)].join('\n');
  const signingKey = hmac(hmac(hmac(hmac(credential.secretAccessKey, day), 'cn-north-1'), 'cv'), 'request');
  const signature = hmac(signingKey, ['HMAC-SHA256', timestamp, scope, sha(canonical)].join('\n')).toString('hex');
  headers.authorization = 'HMAC-SHA256 Credential=' + credential.accessKeyId + '/' + scope + ', SignedHeaders=' + signed + ', Signature=' + signature;
  return headers;
}
function credentials(config: VideoModelConfig): Credentials {
  try {
    const value = JSON.parse(config.api_key);
    if (typeof value.accessKeyId === 'string' && typeof value.secretAccessKey === 'string' && /^[a-zA-Z0-9_-]{8,128}$/.test(value.accessKeyId) && /^[^\s]{8,256}$/.test(value.secretAccessKey)) return value;
  } catch { /* Never include credential contents in errors. */ }
  throw new Error('请在数字人后台配置火山视觉服务 Access Key ID 和 Secret Access Key');
}
export const OMNI_HUMAN_V15 = 'jimeng_realman_avatar_picture_omni_v15';
function reqKey(config: VideoModelConfig) {
  return String((config.api_protocol_config as Record<string, unknown> | undefined)?.req_key || 'realman_change_lips');
}
/** API Explorer (2024) wraps business data in Result; CV (2022) returns it directly. */
export function visualBusinessResponse(value: unknown): Record<string, any> {
  if (!value || typeof value !== 'object') return {};
  const envelope = value as Record<string, any>;
  return envelope.Result && typeof envelope.Result === 'object' ? envelope.Result : envelope;
}
async function callVisual(config: VideoModelConfig, action: string, input: Record<string, unknown>, version = '2024-06-06') {
  const endpoint = new URL(config.api_endpoint || 'https://visual.volcengineapi.com/');
  if (endpoint.protocol !== 'https:' || endpoint.hostname !== 'visual.volcengineapi.com' || endpoint.username || endpoint.password || endpoint.port) throw new Error('火山数字人接口须使用官方视觉服务地址');
  endpoint.pathname = '/'; endpoint.search = new URLSearchParams({ Action: action, Version: version }).toString();
  const body = JSON.stringify(input);
  const response = await fetch(endpoint, { method: 'POST', headers: signVisualRequest(endpoint, body, credentials(config)), body, signal: AbortSignal.timeout(30_000) });
  const data = visualBusinessResponse(await response.json());
  return { response, data };
}
export async function submitVolcDigitalHuman(config: VideoModelConfig, params: VideoGenerateParams): Promise<VideoTaskResult> {
  const audio = params.audioUrl || params.audioUrls?.find(Boolean);
  if (reqKey(config) === OMNI_HUMAN_V15) {
    const image = params.imageUrl || params.imageUrls?.find(Boolean) || params.referenceImageUrl;
    if (!image || !audio) return { taskId: '', status: 'failed', error: '请上传人物照片和配音音频' };
    const resolution = Number(String(params.resolutionTier || params.resolution || '1080p').replace(/p$/i, ''));
    if (![720, 1080].includes(resolution)) return { taskId: '', status: 'failed', error: 'OmniHuman1.5 支持 720p 或 1080p' };
    const { response, data } = await callVisual(config, 'CVSubmitTask', {
      req_key: OMNI_HUMAN_V15, image_url: image, audio_url: audio,
      output_resolution: resolution, pe_fast_mode: resolution === 720,
      ...(params.prompt ? { prompt: params.prompt.slice(0, 300) } : {}),
    }, '2022-08-31');
    return submittedResult(response, data, '即梦 OmniHuman1.5');
  }
  if (!params.sourceVideoUrl || !audio) return { taskId: '', status: 'failed', error: '请上传人物视频和配音音频' };
  const key = reqKey(config);
  if (!['realman_change_lips', 'realman_change_lips_basic_chimera'].includes(key)) return { taskId: '', status: 'failed', error: '火山改口型服务标识配置不正确' };
  if (key !== 'realman_change_lips' && params.videoExtension) return { taskId: '', status: 'failed', error: '保留较长配音需要选择火山改口型 Lite' };
  const { response, data } = await callVisual(config, 'RealmanChangeLipsSubmitTask', {
    req_key: key, url: params.sourceVideoUrl, pure_audio_url: audio,
    // The user chooses the output duration. Never silently loop a trimmed job.
    ...(key === 'realman_change_lips' ? { align_audio: params.videoExtension === true, align_audio_reverse: params.videoExtension === true } : {}),
  });
  return submittedResult(response, data, '火山视频改口型');
}
function submittedResult(response: Response, data: Record<string, any>, label: string): VideoTaskResult {
  if (response.status >= 500) throw new Error('火山暂未确认提交结果，请继续查询原任务');
  if (response.ok && (data.code == null || !Number.isFinite(Number(data.code)))) throw new Error('火山提交响应格式暂无法确认，请查询原请求');
  if (!response.ok || Number(data.code) !== 10000) return { taskId: '', status: 'failed', error: label + '提交失败 (' + response.status + '): ' + String(data.message || data.ResponseMetadata?.Error?.Message || data.code || '服务暂不可用').slice(0, 200) };
  if (!data.data?.task_id) throw new Error('火山提交未返回任务编号，请查询原请求');
  return { taskId: String(data.data.task_id), status: 'queued', progress: 0 };
}
export async function pollVolcDigitalHuman(config: VideoModelConfig, taskId: string): Promise<VideoTaskResult> {
  const omni = reqKey(config) === OMNI_HUMAN_V15;
  const { response, data } = await callVisual(config, omni ? 'CVGetResult' : 'RealmanChangeLipsGetResult', { req_key: reqKey(config), task_id: taskId }, omni ? '2022-08-31' : '2024-06-06');
  // These documented business responses establish input/moderation rejection, unlike a query outage.
  if ([50215, 50411, 50412, 50413, 50511, 50512, 50513, 50514, 60208].includes(Number(data.code))) return { taskId, status: 'failed', error: String(data.message || '火山未能处理当前素材').slice(0, 200) };
  // Query/authentication failures do not establish that the original generation failed.
  if (!response.ok || Number(data.code) !== 10000) return { taskId, status: 'processing', progress: null };
  const state = data.data || {};
  const status = String(state.status).toLowerCase();
  if (omni && status === 'done' && typeof state.video_url === 'string' && /^https:\/\//i.test(state.video_url)) return { taskId, status: 'success', videoUrl: state.video_url, progress: 100 };
  let result: Record<string, unknown> | undefined;
  try { result = typeof state.resp_data === 'string' ? JSON.parse(state.resp_data) : state.resp_data; }
  catch { /* An incomplete query response must not fail or resubmit the paid job. */ }
  const done = status === 'done' || Number(result?.progress) === 100;
  if (done && Number(result?.code) === 0 && typeof result?.url === 'string' && /^https?:\/\//i.test(result.url)) return { taskId, status: 'success', videoUrl: result.url, progress: 100 };
  if (['failed', 'error'].includes(status) || done && Number.isFinite(Number(result?.code)) && Number(result?.code) !== 0) return { taskId, status: 'failed', error: String(result?.msg || state.message || '火山视频改口型未完成').slice(0, 200) };
  const progress = typeof result?.progress === 'number' && Number.isFinite(result.progress) ? Math.max(0, Math.min(99, result.progress)) : null;
  return { taskId, status: 'processing', progress };
}
