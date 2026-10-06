export class AudioDownloadError extends Error {}

export async function fetchAudioDownload(options: {
  origin: string; audioUrl: string; assetId?: string; token?: string | null; signal: AbortSignal;
}): Promise<Blob> {
  if (options.assetId && !/^[A-Za-z0-9_-]{1,160}$/.test(options.assetId)) {
    throw new AudioDownloadError('音频资产编号无效，请刷新历史后重试');
  }
  const url = new URL(options.assetId
    ? `/api/storage/files/${encodeURIComponent(options.assetId)}/content?download=1`
    : options.audioUrl, options.origin);
  if (!['https:', 'http:'].includes(url.protocol)) throw new AudioDownloadError('音频链接无效，请刷新历史后重试');
  const owned = url.origin === new URL(options.origin).origin;
  const response = await fetch(url.href, {
    headers: owned && options.token ? { Authorization: `Bearer ${options.token}` } : {},
    credentials: owned ? 'same-origin' : 'omit',
    redirect: 'error',
    cache: 'no-store',
    signal: options.signal,
  });
  if (response.status === 401) throw new AudioDownloadError('登录已过期，请重新登录后下载');
  if (response.status === 403 || response.status === 404) throw new AudioDownloadError('音频不存在或没有访问权限，请刷新历史后重试');
  if (!response.ok) throw new AudioDownloadError('音频下载失败，请稍后重试');
  const blob = await response.blob();
  if (!blob.size || !/^(audio\/|application\/(octet-stream|ogg)(;|$))/i.test(blob.type)) {
    throw new AudioDownloadError('未取得有效音频文件，请刷新历史后重试');
  }
  return blob;
}
