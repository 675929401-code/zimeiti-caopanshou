import { readableExtractionError, sanitizeExtractionErrorFields } from '@/lib/extraction-provider-error';
import { signedTemporaryExtractVideoExpiry } from '@/lib/extract-client-result';

type JsonObject = Record<string, unknown>;
const object = (value: unknown): JsonObject => value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {};
const objects = (value: unknown): JsonObject[] => Array.isArray(value) ? value.map(object) : [];
const text = (value: unknown): string => typeof value === 'string' ? value : '';
const PROVIDER_MEDIA_FIELDS = [
  'url', 'download_url', 'downloadUrl', 'video_url', 'videoUrl', 'video_mp4', 'videoMp4',
  'play_url', 'playUrl', 'cover', 'cover_url', 'coverUrl', 'dynamic_cover', 'dynamicCover',
  'avatar', 'avatar_url', 'avatarUrl', 'music_url', 'musicUrl', 'images',
] as const;

function sanitizeVideoCandidate(value: unknown): JsonObject {
  const item = { ...object(value) };
  for (const field of PROVIDER_MEDIA_FIELDS) delete item[field];

  const assetId = text(item.asset_id).trim();
  if (assetId) item.asset_id = assetId;
  else delete item.asset_id;

  const temporaryUrl = text(item.temporary_url);
  const temporaryExpiresAt = Number(item.temporary_expires_at);
  const signedExpiresAt = signedTemporaryExtractVideoExpiry(temporaryUrl);
  if (
    signedExpiresAt
    && Number.isSafeInteger(temporaryExpiresAt)
    && temporaryExpiresAt > 0
  ) {
    item.temporary_url = temporaryUrl;
    item.temporary_expires_at = Math.min(signedExpiresAt, temporaryExpiresAt);
  } else {
    delete item.temporary_url;
    delete item.temporary_expires_at;
  }
  return item;
}

export type ExtractionRetryInput =
  | { requestKind: 'single'; mode: 'video' | 'text'; links: string[]; douyinShareText?: string }
  | { requestKind: 'batch'; creatorUrl: string; likesThreshold: number; maxCount: number }
  | { requestKind: 'search'; keyword: string; likesThreshold: number; maxCount: number }
  | { requestKind: 'coze'; shareText: string; mode?: 'video' | 'homepage' | 'search'; minLikes: number; maxCount: number };

export function sanitizeOwnedExtractionResponse(value: unknown): unknown {
  const sanitized = sanitizeExtractionErrorFields(value);
  if (!sanitized || typeof sanitized !== 'object' || Array.isArray(sanitized)) return sanitized;
  const response = sanitized as JsonObject;
  return {
    ...response,
    ...(Array.isArray(response.videos)
      ? { videos: response.videos.map(sanitizeVideoCandidate) }
      : {}),
    ...(Array.isArray(response.results)
      ? { results: response.results.map(candidate => {
        const result = { ...object(candidate) };
        if (result.video && typeof result.video === 'object') {
          result.video = sanitizeVideoCandidate(result.video);
        }
        return result;
      }) }
      : {}),
  };
}

export function extractionRetryInputFromSnapshot(value: unknown): ExtractionRetryInput | null {
  const snapshot = object(value);
  if (snapshot.schema !== 'extraction_request_snapshot.v1') return null;
  const payload = object(snapshot.payload);
  const requestKind = text(snapshot.request_kind);
  if (requestKind === 'single') {
    const mode = text(payload.extraction_mode);
    const links = Array.isArray(payload.links)
      ? payload.links.filter((link): link is string => typeof link === 'string' && Boolean(link.trim())).slice(0, 30)
      : [];
    if (!['video', 'text'].includes(mode) || links.length === 0) return null;
    const douyinShareText = text(payload.douyin_share_text);
    return { requestKind, mode: mode as 'video' | 'text', links, ...(douyinShareText ? { douyinShareText } : {}) };
  }
  if (requestKind === 'batch') {
    const creatorUrl = text(payload.creator_url).trim();
    if (!creatorUrl) return null;
    return { requestKind, creatorUrl, likesThreshold: Math.max(0, Number(payload.likes_threshold) || 0), maxCount: Math.max(1, Math.min(50, Number(payload.max_count) || 10)) };
  }
  if (requestKind === 'search') {
    const keyword = text(payload.keyword).trim();
    if (!keyword) return null;
    return { requestKind, keyword, likesThreshold: Math.max(0, Number(payload.likes_threshold) || 0), maxCount: Math.max(1, Math.min(50, Number(payload.max_count) || 10)) };
  }
  if (requestKind === 'coze') {
    const shareText = text(payload.share_text).trim();
    if (!shareText) return null;
    const mode = text(payload.mode);
    return { requestKind, shareText, ...(['video', 'homepage', 'search'].includes(mode) ? { mode: mode as 'video' | 'homepage' | 'search' } : {}), minLikes: Math.max(0, Number(payload.min_likes) || 0), maxCount: Math.max(1, Math.min(50, Number(payload.max_count) || 10)) };
  }
  return null;
}

/** Rebuild display history only from an authenticated owner's persisted request. */
export function extractionHistoryEntry(row: JsonObject) {
  const response = object(sanitizeOwnedExtractionResponse(row.response));
  let videos = objects(response.videos), texts = objects(response.texts);
  if (response.source === 'douyin_wtf') {
    videos = objects(response.results).filter(item => item.success !== false && item.video).map(item => {
      const video = object(item.video);
      return {
        success: true,
        title: text(video.desc),
        asset_id: text(video.asset_id),
        temporary_url: text(video.temporary_url),
        temporary_expires_at: Number(video.temporary_expires_at) || undefined,
      };
    });
    texts = objects(response.results).filter(item => item.success !== false && text(item.transcript).trim()).map(item => ({ success: true, content: text(item.transcript) }));
  } else if ((row.request_kind === 'coze' || response.source === 'coze_workflow') && !texts.length) {
    texts = objects(response.results).filter(item => item.success === true && text(item.content).trim()).map(item => ({ success: true, content: text(item.content), title: text(item.title), author: text(item.author) }));
  }
  // Legacy search responses use caption/text; titles are never transcript evidence.
  texts = texts.map(item => {
    const content = text(item.corrected_content).trim() || text(item.content).trim() || text(item.caption).trim() || text(item.text).trim();
    return { ...item, content, success: item.success !== false && !text(item.error).trim() && Boolean(content),
      title: text(item.title) || text(item.desc), author: text(item.author) || text(item.nickname) };
  });
  const usableVideos = videos.filter(item => item.success !== false && (text(item.temporary_url) || text(item.asset_id)));
  const usableTexts = texts.filter(item => item.success !== false && (text(item.corrected_content).trim() || text(item.content).trim()));
  const title = text(usableVideos[0]?.title) || text(usableTexts[0]?.title);
  const requestedVideo = /(?:^|[-_:])video(?:[-_:]|$)/i.test(text(row.client_request_id));
  const originalResponse = object(row.response);
  const hadPersistedVideoRecord = objects(originalResponse.videos).length > 0
    || objects(originalResponse.results).some(item => Boolean(item.video));
  const mode = usableVideos.length || requestedVideo ? 'video' : 'text';
  const pending = row.state === 'running' || row.state === 'failed_unknown';
  const success = row.state === 'succeeded' && (mode === 'video' ? usableVideos.length > 0 : usableTexts.length > 0);
  const id = text(row.record_id);
  const billing = object(row.billing_evidence);
  const retryInput = extractionRetryInputFromSnapshot(row.request_snapshot);
  const retrySafe = row.state === 'failed'
    && response.retry_safe === true
    && response.billing_unknown !== true
    && (response.charged === false || billing.charged === false)
    && retryInput?.requestKind !== 'coze'
    && Boolean(retryInput);
  const failure = pending ? '结果暂未确认，原请求已保留。'
    : requestedVideo && row.state === 'succeeded' && hadPersistedVideoRecord && usableVideos.length === 0
      ? '历史临时视频已过期或未保存为站内资产，请重新提取。'
      : readableExtractionError(text(response.error) || text(response.message) || text(row.error_message) || '这次提取未成功取得内容。', mode);
  return {
    id, url: title || (mode === 'video' ? '视频提取记录' : '文案提取记录'),
    platform: text(usableVideos[0]?.platform) || text(usableTexts[0]?.platform) || '提取',
    mode, timestamp: Date.parse(text(row.created_at)), pending,
    attemptState: text(row.state),
    clientRequestId: text(row.client_request_id),
    status: success ? 'success' as const : 'error' as const,
    canLoadForRetry: retrySafe,
    ...(retrySafe && retryInput ? { retryInput } : {}),
    ...(!retrySafe && row.state === 'failed' ? { retryUnavailableReason: retryInput
      ? retryInput.requestKind === 'coze'
        ? '这条历史记录的输入格式暂不支持恢复。'
        : '原任务结果或费用尚未确认，请先刷新状态，勿重复提交。'
      : '这条历史记录未保存完整输入，暂时无法载入重试。' } : {}),
    ...(success ? { result: { success: true, videos: usableVideos, texts: usableTexts, summary: text(response.summary) || text(response.message) } }
      : { error: failure + '（请求号 ' + id + '）' }),
  };
}
