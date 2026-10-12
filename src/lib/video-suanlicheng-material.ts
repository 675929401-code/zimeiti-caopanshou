import { safeFetch } from './safe-fetch';
import { trustedRelayHostnamesFromEnv } from './safe-media-fetch';
import { parseGeneratedImageReferenceUri } from './generated-image-reference';

type Kind = 'image' | 'audio';
type Material = { buffer: Buffer; contentType: string };
export interface SuanlichengMaterialDependencies {
  readOwned(url: string, userId: string, kind: Kind, maxBytes: number): Promise<Material>;
  readExternal(url: string, kind: Kind, maxBytes: number): Promise<Material>;
  readGenerated?(url: string, userId: string, maxBytes: number): Promise<Material>;
}
const defaults: SuanlichengMaterialDependencies = {
  async readOwned(url, userId, kind, maxBytes) {
    const { stabilizeAutodlH3InputAssets, parseAutodlH3AssetRef } = await import('./autodl-h3-assets');
    const stable = await stabilizeAutodlH3InputAssets({ userId, candidates: kind === 'image' ? { imageUrl: url } : { audioUrl: url } });
    const owned = parseAutodlH3AssetRef(kind === 'image' ? stable.imageAssetRef : stable.audioAssetRef);
    if (!owned) throw new Error('参考素材归属不可用，请重新上传');
    const { getSupabaseAdminClient } = await import('@/storage/database/supabase-client');
    const { data, error } = await getSupabaseAdminClient().from('user_files').select('content_type,file_size')
      .eq('user_id', userId).eq('storage_provider', owned.provider).eq('storage_key', owned.key).eq('file_category', kind).maybeSingle();
    if (error || !data) throw new Error('参考素材归属不可用，请重新上传');
    if (Number(data.file_size) > maxBytes) throw new Error('参考素材超过大小限制');
    const { storageManager } = await import('@/storage/object');
    return { buffer: await storageManager.readBounded(owned.key, maxBytes, 30_000, owned.provider), contentType: String(data.content_type || '') };
  },
  async readExternal(url, kind, maxBytes) {
    const result = await safeFetch(url, { maxBytes, timeoutMs: 30_000, maxRedirects: 3,
      allowedContentTypes: kind === 'image' ? ['image/jpeg','image/png','image/webp'] : ['audio/wav','audio/x-wav','audio/mpeg','audio/mp3'],
      trustedHostnames: trustedRelayHostnamesFromEnv(),
    });
    return { buffer: result.buffer, contentType: result.contentType };
  },
};

/** Owned COS inputs use authenticated storage, never an SSRF exception or cross-account fallback. */
export async function readSuanlichengMaterial(url: string, kind: Kind, userId?: string, dependencies = defaults): Promise<Material> {
  const generated = parseGeneratedImageReferenceUri(url);
  if (url.startsWith('generated-image:')) {
    if (!generated || kind !== 'image' || !userId) throw new Error('生成图片引用缺少有效账号归属');
    const maxBytes = 16 * 1024 * 1024;
    const material = dependencies.readGenerated
      ? await dependencies.readGenerated(url, userId, maxBytes)
      : await (await import('@/lib/server/generated-image-reference')).readGeneratedImageMaterial({ userId, reference: generated, maxBytes });
    if (!material.buffer.length || material.buffer.length > maxBytes || !['image/png','image/jpeg','image/webp'].includes(material.contentType)) throw new Error('生成图片字节不符合通道限制');
    return material;
  }
  const parsed = new URL(url);
  const owned = parsed.protocol === 'object:' || (parsed.protocol === 'https:'
    && /^[a-z0-9][a-z0-9-]{0,62}\.cos(?:-internal)?\.[a-z0-9-]+\.myqcloud\.com$/iu.test(parsed.hostname));
  const maxBytes = (kind === 'image' ? 16 : 20) * 1024 * 1024;
  if (owned && !userId) throw new Error('参考素材缺少账号归属，请重新上传');
  const material = owned ? await dependencies.readOwned(url, userId!, kind, maxBytes) : await dependencies.readExternal(url, kind, maxBytes);
  const contentType = material.contentType.split(';', 1)[0].trim().toLowerCase();
  const allowed = kind === 'image' ? ['image/jpeg','image/png','image/webp'] : ['audio/wav','audio/x-wav','audio/mpeg','audio/mp3'];
  if (!allowed.includes(contentType)) throw new Error('参考素材格式不支持，请重新上传');
  if (!material.buffer.length || material.buffer.length > maxBytes) throw new Error('参考素材为空或超过大小限制');
  return { buffer: material.buffer, contentType };
}
