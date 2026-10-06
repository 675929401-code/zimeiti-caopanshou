/** Policy for newly set credentials; existing password hashes remain valid for sign-in. */
export function adminPasswordError(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) return '请设置初始密码或新密码';
  if (value.length < 8) return '密码至少 8 个字符';
  if (new TextEncoder().encode(value).length > 72) return '密码过长，请控制在 72 字节以内';
  if (!/[A-Za-z]/.test(value) || !/\d/.test(value)) return '密码需同时包含字母和数字';
  return '';
}
