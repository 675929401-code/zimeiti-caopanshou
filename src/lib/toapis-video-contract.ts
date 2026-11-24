import type { VideoGenerateParams, VideoModelConfig } from './video-adapter';

export const TOAPIS_VIDEO_ENDPOINT = 'https://toapis.com/v1/videos/generations';

const seedance = new Set(['seedance-2-5', 'seedance-2-5-flash', 'seedance-2', 'seedance-2-fast', 'seedance-2-mini']);
const wan = new Set(['wan3.0-video', 'wan3.0-video-prime']);

export function toApisVideoBody(config: VideoModelConfig, input: VideoGenerateParams, businessId: string) {
  const model = config.model_name || '';
  const isSeedance = seedance.has(model), isWan = wan.has(model), isKling = model === 'kling-4.0';
  if (config.api_endpoint !== TOAPIS_VIDEO_ENDPOINT || !(isSeedance || isWan || isKling)) throw Error('ToAPIs 视频渠道或型号不匹配');
  const resolution = (input.resolutionTier || input.resolution || '720p').toLowerCase();
  const duration = Number(input.duration ?? config.duration_seconds);
  const cfg = config.api_protocol_config || {};
  if (!cfg.resolution_options?.includes(resolution) || !cfg.duration_options?.includes(duration)) throw Error('ToAPIs 未配置此分辨率或时长');
  const ratio = input.aspectRatio || '16:9';
  if (!cfg.aspect_ratios?.includes(ratio)) throw Error('ToAPIs 未配置此画幅');
  const images = [...new Set([...(input.imageUrls || []), input.referenceImageUrl].filter((v): v is string => !!v))];
  const audios = [...new Set([...(input.audioUrls || []), input.audioUrl].filter((v): v is string => !!v))];
  const first = input.imageUrl, last = input.lastFrameUrl, video = input.sourceVideoUrl;
  if (last && !first || (first || last) && (images.length || audios.length || video)) throw Error('首尾帧与多模态参考须分别提交');
  if (images.length > Number(cfg.max_reference_images ?? 0) || audios.length > Number(cfg.max_reference_audios ?? 0)) throw Error('参考素材数量超出当前型号限制');
  if (video && cfg.supports_source_video_input !== true) throw Error('此配置未开放视频参考报价');
  if (input.negativePrompt) throw Error('此配置未开放负面提示词');
  const body: Record<string, unknown> = { model, prompt: input.prompt, duration, resolution, aspect_ratio: first && isSeedance ? 'adaptive' : ratio, client_business_id: businessId };
  if (first) body.image_with_roles = [{url:first, role:'first_frame'}, ...(last ? [{url:last, role:'last_frame'}] : [])];
  if (images.length) {
    if (isWan) body.reference_images = images;
    else if (isKling) body.image_urls = images;
    else body.image_with_roles = images.map(url => ({url, role:'reference_image'}));
  }
  if (video) {
    if (isWan) body.video_list = [{video_url: video}];
    else if (isKling) body.video_urls = [video];
    else body.video_with_roles = [{url: video, role:'reference_video'}];
  }
  if (audios.length) body.audio_with_roles = audios.map(url => ({url, role:'reference_audio'}));
  if (typeof input.generateAudio === 'boolean') {
    if (!isKling) body[isWan ? 'audio' : 'generate_audio'] = input.generateAudio;
  }
  return body;
}
