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

export function isUserProfileAvatarPreset(value: unknown): value is UserProfileAvatarPreset {
  return typeof value === 'string'
    && USER_PROFILE_AVATAR_PRESETS.some((preset) => preset.src === value);
}
