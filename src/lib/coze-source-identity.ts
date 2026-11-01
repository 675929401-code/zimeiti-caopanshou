import type { CozeWorkflowOutput } from '@/lib/coze-extraction-result';

export type CozeSourceIdentity = {
  status: 'verified' | 'unverified' | 'not_applicable' | 'mismatch';
  reason: 'matching_video_ids' | 'input_identity_unavailable' | 'caption_identity_unavailable' | 'multiple_input_videos' | 'collection_mode' | 'different_video_id';
};

// IDs remain strings: Douyin IDs exceed JavaScript's safe integer range.
function videoId(value: unknown): string | undefined {
  if (typeof value === 'string' && /^\d+$/u.test(value.trim())) return value.trim();
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value);
  return undefined;
}

function urlVideoId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return undefined;
    const host = url.hostname.toLowerCase();
    if (host === 'douyin.com' || host.endsWith('.douyin.com')) {
      return url.pathname.match(/^\/video\/(\d+)(?:\/|$)/u)?.[1];
    }
    if (host === 'iesdouyin.com' || host.endsWith('.iesdouyin.com')) {
      return url.pathname.match(/^\/share\/video\/(\d+)(?:\/|$)/u)?.[1];
    }
  } catch { /* Short links and unknown URL forms carry no confirmed video ID. */ }
  return undefined;
}

/** Identity agreement is not content verification. No redirect, lookup or retry occurs here. */
export function inspectCozeSourceIdentity(shareText: string, mode: string, output: CozeWorkflowOutput): CozeSourceIdentity {
  if (!['video', 'single_video'].includes(mode)) return { status: 'not_applicable', reason: 'collection_mode' };
  const urls = shareText.match(/https?:\/\/[^\s<>"'，。！？；]+/gu) || [];
  const expectedIds = new Set(urls.map(value => urlVideoId(value.replace(/[)\]}>]+$/u, ''))).filter((id): id is string => Boolean(id)));
  if (expectedIds.size !== 1) return { status: 'unverified', reason: expectedIds.size > 1 ? 'multiple_input_videos' : 'input_identity_unavailable' };
  const expectedId = [...expectedIds][0];
  const captions = Array.isArray(output.captions) ? output.captions : [];
  let allIdentified = captions.length > 0;
  for (const caption of captions) {
    if (!caption || typeof caption !== 'object') { allIdentified = false; continue; }
    const returnedIds = [videoId(caption.aweme_id), urlVideoId(caption.url), urlVideoId(caption.video_url)].filter((id): id is string => Boolean(id));
    if (returnedIds.some(id => id !== expectedId)) return { status: 'mismatch', reason: 'different_video_id' };
    if (!returnedIds.length) allIdentified = false;
  }
  return allIdentified ? { status: 'verified', reason: 'matching_video_ids' } : { status: 'unverified', reason: 'caption_identity_unavailable' };
}
