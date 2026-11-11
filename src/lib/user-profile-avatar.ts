export const USER_PROFILE_AVATAR_PRESETS = [
  { id: 'inspiration-strategist', label: '灵感策划师', src: '/avatars/profile-generated/profile-avatar-01.webp' },
  { id: 'operations-analyst', label: '运营分析师', src: '/avatars/profile-generated/profile-avatar-02.webp' },
  { id: 'visual-director', label: '影像导演', src: '/avatars/profile-generated/profile-avatar-03.webp' },
  { id: 'copy-creator', label: '文案创作者', src: '/avatars/profile-generated/profile-avatar-04.webp' },
  { id: 'topic-researcher', label: '选题研究员', src: '/avatars/profile-generated/profile-avatar-05.webp' },
  { id: 'brand-promoter', label: '品牌推广官', src: '/avatars/profile-generated/profile-avatar-06.webp' },
  { id: 'story-writer', label: '故事编剧', src: '/avatars/profile-generated/profile-avatar-07.webp' },
  { id: 'scene-designer', label: '场景设计师', src: '/avatars/profile-generated/profile-avatar-08.webp' },
] as const;

export type UserProfileAvatarPreset = (typeof USER_PROFILE_AVATAR_PRESETS)[number]['src'];

export const USER_PROFILE_AVATAR_STORAGE_PROVIDERS = ['coze_s3', 'tencent_cos', 'local'] as const;
export type UserProfileAvatarStorageProvider = (typeof USER_PROFILE_AVATAR_STORAGE_PROVIDERS)[number];

export function isUserProfileAvatarStorageProvider(value: unknown): value is UserProfileAvatarStorageProvider {
  return typeof value === 'string'
    && USER_PROFILE_AVATAR_STORAGE_PROVIDERS.some((provider) => provider === value);
}

export function userProfileAvatarProxyUrl(
  storageKey: string,
  storageProvider: UserProfileAvatarStorageProvider,
): string {
  const query = new URLSearchParams({ key: storageKey, provider: storageProvider });
  return `/api/avatars?${query.toString()}`;
}

export function isUserProfileAvatarPreset(value: unknown): value is UserProfileAvatarPreset {
  return typeof value === 'string'
    && USER_PROFILE_AVATAR_PRESETS.some((preset) => preset.src === value);
}

/** Address shape only. The caller must separately verify the avatar's owner. */
export function isUserProfileAvatarReference(value: unknown): boolean {
  if (isUserProfileAvatarPreset(value)) return true;
  if (typeof value !== 'string' || value.length > 2048 || !value.startsWith('/api/avatars?')) return false;
  try {
    const url = new URL(value, 'https://profile-avatar.invalid');
    if (url.pathname !== '/api/avatars' || url.hash || [...url.searchParams.keys()].length !== 2) return false;
    const key = url.searchParams.get('key');
    const provider = url.searchParams.get('provider');
    if (!isUserProfileAvatarStorageProvider(provider) || !key || !/^user-profile-avatars\/[A-Za-z0-9/_-]+\.webp$/.test(key)) return false;
    if (key.split('/').some(segment => !segment || segment === '.' || segment === '..')) return false;
    return value === userProfileAvatarProxyUrl(key, provider);
  } catch {
    return false;
  }
}

/** Read compatibility for the two historical writers; ownership is checked by the caller. */
export function isLegacyUserProfileAvatarReference(value: unknown, ownerId?: string): boolean {
  if (typeof value !== 'string' || value.length > 2048 || !value.startsWith('/api/avatars?')) return false;
  try {
    const url = new URL(value, 'https://profile-avatar.invalid');
    if (url.pathname !== '/api/avatars' || url.hash || [...url.searchParams.keys()].length !== 2) return false;
    const key = url.searchParams.get('key'), provider = url.searchParams.get('provider');
    if (!key || !isUserProfileAvatarStorageProvider(provider) || provider === 'local') return false;
    const match = key.match(provider === 'tencent_cos'
      ? /^user-profile-avatars\d{4}\/(?:0[1-9]|1[0-2])\/(?:0[1-9]|[12]\d|3[01])\/([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})-[a-f0-9]{16}\.webp$/
      : /^user-profile-avatars([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})-[a-f0-9]{16}\.webp$/);
    return !!match && (!ownerId || match[1] === ownerId) && value === userProfileAvatarProxyUrl(key, provider);
  } catch {
    return false;
  }
}
