// 扣子三合一工作流客户端（同步 /run 模式）
// 协议: POST {base}/run
// 请求: {share_text, min_likes, max_count, mode, extract_caption}
// 响应: {final_result, mode, success_count, captions:[{url,video_url,cover,aweme_id,desc,nickname,digg_count,caption,error}]}
import type { CozeWorkflowOutput } from '@/lib/coze-extraction-result';

export type CozeExtractMode = "single_video" | "creator_page" | "search" | "";

export function detectCozeCaptionMode(shareText: string): CozeExtractMode {
  const text = shareText.trim();
  if (text.includes("/user/")) return "creator_page";
  if (/更多作品|TA的更多/.test(text) && /v\.douyin\.com/.test(text)) return "creator_page";
  if (text.includes("/video/") || /https?:\/\//.test(text)) return "single_video";
  return "search";
}

const modeMap: Record<string, string> = { single_video: 'video', creator_page: 'homepage', search: 'search' };

export interface CozeRunResult {
  success: boolean;
  final_result: string;
  mode: string;
  success_count: number;
  captions: {
    url: string; video_url: string; cover: string; aweme_id: string;
    desc: string; nickname: string; digg_count: number; caption: string; error: string;
  }[];
  raw: unknown;
}

/** 同步调用扣子工作流 POST /run，180秒超时 */
export async function runCozeSync(
  config: { apiUrl: string; apiToken: string },
  shareText: string,
  opts: { min_likes?: number; max_count?: number; mode?: string; extract_caption?: boolean } = {},
): Promise<CozeRunResult> {
  const baseUrl = config.apiUrl.replace(/\/run$/, '').replace(/\/$/, '');
  const body = {
    share_text: shareText,
    min_likes: opts.min_likes ?? 0,
    max_count: opts.max_count ?? 10,
    mode: opts.mode ?? '',
    extract_caption: opts.extract_caption ?? true,
  };
  const response = await fetch(baseUrl + '/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + config.apiToken },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(180_000),
  });
  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(`扣子工作流返回 HTTP ${response.status}: ${errText.slice(0, 200)}`);
  }
  const data = await response.json();
  return {
    success: data.success_count > 0,
    final_result: data.final_result || '',
    mode: data.mode || '',
    success_count: data.success_count || 0,
    captions: (data.captions || []).map((c: Record<string, unknown>) => ({
      url: String(c.url || ''),
      video_url: String(c.video_url || ''),
      cover: String(c.cover || ''),
      aweme_id: String(c.aweme_id || ''),
      desc: String(c.desc || ''),
      nickname: String(c.nickname || ''),
      digg_count: Number(c.digg_count || 0),
      caption: String(c.caption || ''),
      error: String(c.error || ''),
    })),
    raw: data,
  };
}

/** 兼容旧接口: 提交+轮询改为同步/run调用 */
export async function runCozeCaptionWorkflow(
  config: { apiUrl: string; apiToken: string }, shareText: string, mode?: string, minLikes?: number, maxCount?: number
): Promise<CozeWorkflowOutput> {
  const result = await runCozeSync(config, shareText, { mode: mode || '', min_likes: minLikes ?? 0, max_count: maxCount ?? 10, extract_caption: true });
  const captions = result.captions.map(c => ({
    url: c.url, desc: c.desc, cover: c.cover, aweme_id: c.aweme_id,
    nickname: c.nickname, digg_count: c.digg_count, caption: c.caption, error: c.error,
  }));
  return {
    success: result.success,
    final_result: result.final_result,
    mode: result.mode,
    success_count: result.success_count,
    captions,
    summary: `成功提取${result.success_count}条`,
    texts: result.captions.filter(c => c.caption).map((c, i) => ({ row: i + 1, col: 1, platform: 'douyin', success: true, content: c.caption, title: c.desc })),
    videos: result.captions.filter(c => c.video_url).map((c, i) => ({ row: i + 1, col: 0, platform: 'douyin', success: true, url: c.url, download_url: c.video_url, cover: c.cover, title: c.desc })),
  };
}
