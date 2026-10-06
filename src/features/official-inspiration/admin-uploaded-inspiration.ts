import type { OfficialInspirationItem, InspirationMaterialCategory } from './inspiration-data';

const CATEGORY_LABELS: Record<string, InspirationMaterialCategory> = {
  character: '角色', scene: '场景', prop: '道具', style: '风格', shot: '分镜',
  film: '成片', music: '音乐', voice: '语音', audio: '音频', 'sound-effect': '音效',
  image: '图片', video: '视频', other: '其他',
};
const MEDIA_LABELS = { image: '图片', video: '视频', audio: '音频' } as const;
const FALLBACK_COVER = '/official-home/hero-eye-original.png';

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export function mapAdminUploadedInspiration(value: unknown): OfficialInspirationItem | null {
  const item = record(value);
  if (item?.origin !== 'admin-upload') return null;
  const metadata = record(item.metadata);
  if (typeof item.id !== 'string' || !/^manju-[a-z0-9][a-z0-9_-]{8,120}$/u.test(item.id)
    || item.url !== `/api/youcai/public-assets/${item.id}`
    || typeof item.type !== 'string' || !Object.hasOwn(MEDIA_LABELS, item.type)
    || typeof metadata?.title !== 'string' || !metadata.title.trim()
    || typeof metadata.summary !== 'string' || typeof item.prompt !== 'string'
    || typeof item.createdAt !== 'string' || !Number.isFinite(Date.parse(item.createdAt))) {
    throw new Error('ADMIN_INSPIRATION_FORMAT_INVALID');
  }
  const type = item.type as keyof typeof MEDIA_LABELS;
  const title = metadata.title;
  const mediaPath = item.url as string;
  const imagePath = type === 'image' ? mediaPath : FALLBACK_COVER;
  const author = record(item.author);
  return {
    id: item.id, title, summary: metadata.summary, mediaType: MEDIA_LABELS[type],
    category: typeof item.category === 'string' ? CATEGORY_LABELS[item.category] || '其他' : '其他',
    previewPath: imagePath, imagePath, imageAlt: title,
    imageRatio: metadata.imageRatio === 'portrait' || metadata.imageRatio === 'square' ? metadata.imageRatio : 'landscape',
    prompt: item.prompt, createdAt: item.createdAt, popularity: 0, availability: 'ready', mediaPath,
    availabilityNote: '平台素材已就绪；浏览不会触发生成。',
    sourceNote: '本站提供的公共创作素材。',
    authorName: typeof author?.nickname === 'string' ? author.nickname : '漫剧工作台',
    likes: typeof item.likes === 'number' && Number.isFinite(item.likes) ? Math.max(0, item.likes) : 0,
  };
}

/** Read the existing public search contract, which includes the upload toolSlug. */
export async function loadAdminUploadedInspiration(signal: AbortSignal, fetcher: typeof fetch = fetch): Promise<OfficialInspirationItem[]> {
  const output: OfficialInspirationItem[] = [];
  const ids = new Set<string>();
  let pages = 1;
  let expectedTotal: number | undefined;
  let received = 0;
  for (let page = 1; page <= pages; page++) {
    const response = await fetcher(`/api/inspiration?search=manju-admin-upload&limit=100&page=${page}&sort=latest`, { cache: 'no-store', signal });
    if (!response.ok) throw new Error('ADMIN_INSPIRATION_UNAVAILABLE');
    const payload = record(await response.json());
    const pagination = record(payload?.pagination);
    if (payload?.success !== true || !Array.isArray(payload.data)
      || !Number.isSafeInteger(pagination?.totalPages) || Number(pagination?.totalPages) < 0 || Number(pagination?.totalPages) > 100
      || !Number.isSafeInteger(pagination?.total) || Number(pagination?.total) < 0) {
      throw new Error('ADMIN_INSPIRATION_FORMAT_INVALID');
    }
    if (expectedTotal !== undefined && pagination?.total !== expectedTotal) throw new Error('ADMIN_INSPIRATION_CHANGED');
    expectedTotal = Number(pagination?.total);
    pages = Math.max(1, Number(pagination?.totalPages));
    received += payload.data.length;
    for (const raw of payload.data) {
      const item = mapAdminUploadedInspiration(raw);
      if (!item) continue;
      if (ids.has(item.id)) throw new Error('ADMIN_INSPIRATION_DUPLICATE');
      ids.add(item.id);
      output.push(item);
    }
  }
  if (received !== expectedTotal) throw new Error('ADMIN_INSPIRATION_INCOMPLETE');
  return output;
}
