// 音色头像工具：只使用随部署包发布的本地素材，避免第三方头像服务
// 不可用、限流或下线时导致音色列表产生大面积破图。

const LOCAL_MALE_AVATARS = [
  '/avatars/optimized/man-1.webp',
  '/avatars/optimized/dachazi.webp',
  '/avatars/optimized/shuheng.webp',
  '/avatars/optimized/tiejun.webp',
  '/avatars/optimized/wentao.webp',
  '/avatars/optimized/xiaotian.webp',
] as const;

const LOCAL_FEMALE_AVATARS = [
  '/avatars/optimized/woman-1.webp',
  '/avatars/optimized/woman-2.webp',
  '/avatars/optimized/kexin.webp',
  '/avatars/optimized/ruoxi.webp',
  '/avatars/optimized/shiyun.webp',
  '/avatars/optimized/xiaowei.webp',
  '/avatars/optimized/xiaoyan.webp',
  '/avatars/optimized/yaomei.webp',
  '/avatars/optimized/yaqin.webp',
  '/avatars/optimized/zixuan.webp',
] as const;

const LOCAL_NEUTRAL_AVATARS = [
  ...LOCAL_FEMALE_AVATARS,
  ...LOCAL_MALE_AVATARS,
] as const;

export function getAgeRange(name: string): string {
  const youngPatterns = ['童', '少年', '少女', '萌娃', '奶气', '宝贝', '小孩', '正太', '萝莉', '萌宝', '奶萌', '娃娃', '稚嫩', '幼', '崽', '娃'];
  const seniorPatterns = ['大叔', '大爷', '爷爷', '奶奶', '婆婆', '老人', '老年', '老者', '长辈', '中年', '沧桑', '老头', '老奶奶', '老大爷', '伯', '叔', '婶', '姨'];
  const maturePatterns = ['御姐', '女友', '女神', '总裁', '老板', '性感', '成熟', '阿姨', '磁性', '知性', '干练', '稳重', '高冷'];

  const n = name.toLowerCase();
  for (const p of youngPatterns) { if (n.includes(p)) return '12-18'; }
  for (const p of seniorPatterns) { if (n.includes(p)) return '35-50'; }
  for (const p of maturePatterns) { if (n.includes(p)) return '26-35'; }
  return '19-25';
}

export function getAvatarUrl(speakerId: string, name?: string, gender?: string): string {
  const key = `${speakerId}:${name || ''}`;
  const seed = key.split('').reduce((acc, character) => ((acc * 31) + character.charCodeAt(0)) >>> 0, 0);
  const avatars = gender === 'male'
    ? LOCAL_MALE_AVATARS
    : gender === 'female'
      ? LOCAL_FEMALE_AVATARS
      : LOCAL_NEUTRAL_AVATARS;
  return avatars[seed % avatars.length];
}

export function getFallbackAvatarUrl(speakerId: string, name?: string, gender?: string): string {
  return getAvatarUrl(speakerId, name, gender);
}

export function getInitials(name: string): string {
  return name.slice(0, 2);
}

export function getGradient(gender?: string): string {
  return gender === 'male'
    ? 'from-blue-500 to-indigo-600'
    : 'from-pink-400 to-rose-500';
}

// Uniform fictional portrait atlas: female ages 20/30/50/70, male ages 20/30/50/70, girl/boy/teen girl/teen boy.
export function getVoicePortraitPosition(speakerId:string,name:string,gender:string) {
 const male=gender==='male'||(gender!=='female'&&speakerId.includes('_male_'));
 const child=/童|萌娃|奶气|小孩|正太|萝莉|萌宝|奶萌|娃娃|稚嫩|小朋友|小奶音/.test(name);
 const teen=/少年|少女/.test(name);
 const senior=/爷爷|奶奶|婆婆|老人|老年|老者|老头|老大爷/.test(name);
 const mature=/大叔|叔|婶|姨|中年|妈妈|沧桑/.test(name);
 const row=child||teen?2:male?1:0;
 const column=child?(male?1:0):teen?(male?3:2):senior?3:mature?2:((speakerId.length%2)===0?0:1);
 return {row,column};
}
