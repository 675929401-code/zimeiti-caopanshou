export const REFERENCE_AUDIO_MIN_DURATION_SECONDS = 14;
export const REFERENCE_AUDIO_MAX_DURATION_SECONDS = 30;
export const REFERENCE_AUDIO_DEFAULT_DURATION_SECONDS = 20;
export const REFERENCE_AUDIO_DURATION_OPTIONS = [15, 20, 30] as const;
export const MAX_REFERENCE_AUDIO_BYTES = 15 * 1024 * 1024;
export const MAX_SEED_AUDIO_REFERENCES = 3;

export function normalizeReferenceAudioDuration(value: unknown): number {
  const duration = Number(value);
  if (!Number.isFinite(duration)) return REFERENCE_AUDIO_DEFAULT_DURATION_SECONDS;
  const rounded = Math.round(duration);
  if (rounded < REFERENCE_AUDIO_MIN_DURATION_SECONDS || rounded > REFERENCE_AUDIO_MAX_DURATION_SECONDS) {
    throw new Error(
      `参考音频截取时长必须在 ${REFERENCE_AUDIO_MIN_DURATION_SECONDS}-${REFERENCE_AUDIO_MAX_DURATION_SECONDS} 秒之间`,
    );
  }
  return rounded;
}
