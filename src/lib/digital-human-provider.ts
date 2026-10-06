import { videoProviderFetch as fetch } from './video-provider-request-audit';
import type { VideoGenerateParams, VideoModelConfig, VideoTaskResult } from './video-adapter';

function videoRetalkSubmissionUnknown(): VideoTaskResult {
  return {
    taskId: '',
    status: 'processing',
    progress: null,
    submissionOutcome: 'unknown',
    error: '上游提交结果尚未确认，请保留原任务，暂不要重复生成',
  };
}

/** Alibaba VideoRetalk: the original video and replacement audio are separate inputs. */
export async function submitVideoRetalk(config: VideoModelConfig, input: VideoGenerateParams): Promise<VideoTaskResult> {
  const audio = input.audioUrl || input.audioUrls?.find(Boolean);
  if (!input.sourceVideoUrl || !audio) return { taskId: '', status: 'failed', error: '请上传人物视频和配音音频' };
  let response: Response;
  try {
    response = await fetch(config.api_endpoint, {
      method: 'POST', headers: { Authorization: `Bearer ${config.api_key}`, 'Content-Type': 'application/json', 'X-DashScope-Async': 'enable' },
      body: JSON.stringify({ model: config.model_name || 'videoretalk', input: { video_url: input.sourceVideoUrl, audio_url: audio }, parameters: { video_extension: input.videoExtension === true } }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    // The provider may have accepted the POST before the connection was lost.
    return videoRetalkSubmissionUnknown();
  }
  let data: Record<string, unknown>;
  try {
    const parsed: unknown = await response.json();
    data = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    if (response.ok || response.status >= 500) return videoRetalkSubmissionUnknown();
    data = {};
  }
  if (response.status >= 500) return videoRetalkSubmissionUnknown();
  if (!response.ok) {
    const providerCode = String(data.code || 'UNKNOWN_PROVIDER_ERROR').slice(0, 80);
    const providerMessage = String(data.message || '上游未返回错误原因').slice(0, 200);
    return { taskId: '', status: 'failed', error: `阿里视频改口型提交失败 (${response.status}) [${providerCode}]: ${providerMessage}` };
  }
  const output = data.output && typeof data.output === 'object' && !Array.isArray(data.output)
    ? data.output as Record<string, unknown>
    : {};
  const taskId = typeof output.task_id === 'string' || typeof output.task_id === 'number'
    ? String(output.task_id).trim()
    : '';
  if (!taskId) return videoRetalkSubmissionUnknown();
  return { taskId, status: 'queued', progress: 0 };
}
