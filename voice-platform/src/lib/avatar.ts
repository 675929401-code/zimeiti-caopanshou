// 音色头像生成工具 - 使用 tzador.com 免费真人照片API

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
  const ageRange = getAgeRange(name || '');
  const genderParam = gender === 'male' ? 'male' : gender === 'female' ? 'female' : '';
  const seed = speakerId.split('').reduce((acc, c) => acc + c.charCodeAt(0), 0);
  const params = new URLSearchParams();
  params.set('id', String(seed));
  if (genderParam) params.set('gender', genderParam);
  params.set('ethnicity', 'asian');
  params.set('age', ageRange);
  params.set('size', '256');
  return `https://avatars.tzador.com/face?${params.toString()}`;
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
