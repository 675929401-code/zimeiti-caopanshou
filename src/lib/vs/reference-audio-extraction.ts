'use client';

import {
  buildClientRequestFingerprint,
  clearBrowserClientAttempt,
  isDefinitiveExtractionFailure,
  readExtractionJsonResponse,
  resolveBrowserClientAttempt,
} from '@/lib/extract-client-attempt';
import { isActiveTemporaryExtractVideo, type DeliverableExtractVideo } from '@/lib/extract-client-result';
import { normalizeReferenceAudioDuration } from '@/lib/vs/reference-audio-contract';

type ExtractedVideo = DeliverableExtractVideo & { title?: string; cover?: string; platform?: string };
type ExtractResponse = {
  success?: boolean;
  videos?: ExtractedVideo[];
  provider_call_started?: boolean;
  charged?: boolean | null;
  attempt_id?: string;
  error?: string;
  message?: string;
};
type AudioExtractionResponse = {
  success?: boolean;
  code?: string;
  message?: string;
  data?: {
    title?: string;
    duration?: number;
    platform?: string;
    voice?: { id?: string; url?: string; name?: string; size?: number; createdAt?: string; format?: string };
  };
};

export type ExtractedReferenceAudio = {
  assetId: string;
  url: string;
  name: string;
  size: number;
  createdAt: string;
  format: string;
  duration: number;
  platform: string;
};

function terminalMessage(payload: ExtractResponse, fallback: string) {
  return String(payload.error || payload.message || fallback).trim().slice(0, 300);
}

export async function extractReferenceAudioFromShareLink(input: {
  shareText: string;
  duration: number;
  userId: string;
  token: string;
}): Promise<ExtractedReferenceAudio> {
  const shareText = input.shareText.trim();
  if (!shareText) throw new Error('请粘贴抖音或小红书分享链接');
  if (!/(?:douyin\.com|xiaohongshu\.com|xhslink\.com)/iu.test(shareText)) {
    throw new Error('当前仅支持抖音或小红书分享链接');
  }
  const duration = normalizeReferenceAudioDuration(input.duration);
  const extractPayload = { links: [shareText], extraction_mode: 'video', douyin_share_text: shareText };
  const fingerprint = await buildClientRequestFingerprint(extractPayload);
  const storageKey = `voice-reference-video:${input.userId}`;
  const attempt = resolveBrowserClientAttempt({ storageKey, fingerprint, prefix: 'voice-reference-video' });

  const extractResponse = await fetch('/api/extract', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${input.token}`,
      'Idempotency-Key': attempt.clientRequestId,
    },
    body: JSON.stringify({ ...extractPayload, client_request_id: attempt.clientRequestId }),
  });
  const extracted = await readExtractionJsonResponse<ExtractResponse>(extractResponse);
  const definitiveFailure = isDefinitiveExtractionFailure(extractResponse.status, extracted);
  if (!extractResponse.ok || extracted.success !== true) {
    if (definitiveFailure) clearBrowserClientAttempt(storageKey, attempt.clientRequestId);
    throw new Error(definitiveFailure
      ? terminalMessage(extracted, '视频提取失败，请检查链接后重试')
      : `${terminalMessage(extracted, '视频提取状态尚未确认')}。原请求已保留，再次操作不会重复调用插件。`);
  }

  const video = Array.isArray(extracted.videos)
    ? extracted.videos.find(candidate => isActiveTemporaryExtractVideo(candidate))
    : undefined;
  if (!video?.temporary_url) {
    throw new Error('视频已解析，但安全临时文件尚未准备完成。原请求已保留，请稍后重试。');
  }

  const audioResponse = await fetch('/api/voice/link-clone/extract-audio', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${input.token}` },
    body: JSON.stringify({
      temporaryVideoUrl: video.temporary_url,
      duration,
      title: video.title,
      cover: video.cover,
      platform: video.platform,
      extractionRequestId: attempt.clientRequestId,
    }),
  });
  const audio = await audioResponse.json().catch(() => ({})) as AudioExtractionResponse;
  const voice = audio.data?.voice;
  if (!audioResponse.ok || audio.success !== true || !voice?.id || !voice.url) {
    throw new Error(String(audio.message || '音频提取失败，请稍后用同一链接重试').slice(0, 300));
  }

  clearBrowserClientAttempt(storageKey, attempt.clientRequestId);
  return {
    assetId: String(voice.id),
    url: String(voice.url),
    name: String(voice.name || audio.data?.title || '参考音频'),
    size: Number(voice.size || 0),
    createdAt: String(voice.createdAt || new Date().toISOString()),
    format: String(voice.format || 'WAV'),
    duration: Number(audio.data?.duration || duration),
    platform: String(audio.data?.platform || video.platform || '短视频'),
  };
}
