export const DIRECTOR_LANGUAGES = ['中文', '英文', '泰国', '马来西亚', '巴西', '不限'] as const;
export const DIRECTOR_SCRIPT_MIN = 4;
export const DIRECTOR_SCRIPT_MAX = 60;
export const DIRECTOR_SCRIPT_DEFAULT = 15;

export function restoreDirectorDuration(value: unknown) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DIRECTOR_SCRIPT_DEFAULT;
  return Math.min(DIRECTOR_SCRIPT_MAX, Math.max(DIRECTOR_SCRIPT_MIN, Math.round(value)));
}
