import {
  getVideoDurationCapabilities,
  getVideoResolutionCapabilities,
  getVideoTargetDurationOptions,
  normalizeVideoResolution,
  type VideoModelCapabilitySource,
} from "@/lib/video-model-capabilities";

export const COMMERCE_VIDEO_MAX_TOTAL_DURATION = 80;
export const COMMERCE_ROLLING_SEGMENT_SECONDS = 15;

type DurationPlanOptions = {
  allowRolling?: boolean;
  minimum?: number;
  maximum?: number;
};

export type CommerceVideoDurationPlan = {
  requested: number;
  native: boolean;
  segments: number[];
  nativeOptions: number[];
  rollingOptions: number[];
};

function decimals(value: number) {
  const text = String(value);
  return text.includes(".") ? Math.min(3, text.length - text.indexOf(".") - 1) : 0;
}

function scaleFor(values: readonly number[]) {
  return 10 ** Math.max(0, ...values.map(decimals));
}

function uniquePositive(values: readonly number[]) {
  return [...new Set(values.map(Number).filter((value) => Number.isFinite(value) && value > 0))]
    .sort((left, right) => left - right);
}

export function commerceVideoNativeDurationOptions(source: VideoModelCapabilitySource = {}) {
  const raw = source as Record<string, unknown>;
  const direct = Array.isArray(raw.nativeDurations)
    ? raw.nativeDurations
    : Array.isArray(raw.durationOptions)
      ? raw.durationOptions
      : null;
  if (direct) return uniquePositive(direct.map(Number));
  const capabilities = getVideoDurationCapabilities(source);
  const values = getVideoTargetDurationOptions(source);
  return uniquePositive(values.length ? values : capabilities.nativeDurations.length
    ? capabilities.nativeDurations
    : [capabilities.defaultDuration]);
}

/**
 * Find the shortest exact rolling plan. The integer scale preserves declared
 * fractional steps (for example 0.5 seconds) without floating-point drift.
 */
export function planCommerceVideoSegments(
  requested: number,
  nativeDurations: readonly number[],
  maximum = COMMERCE_VIDEO_MAX_TOTAL_DURATION,
) {
  const options = uniquePositive(nativeDurations)
    .filter((value) => value <= COMMERCE_ROLLING_SEGMENT_SECONDS)
    .sort((left, right) => right - left);
  if (!Number.isFinite(requested) || requested <= 0 || requested > maximum || !options.length) return null;
  const scale = scaleFor([requested, ...options]);
  const target = Math.round(requested * scale);
  if (Math.abs(target / scale - requested) > 1e-8) return null;
  const units = options.map((value) => Math.round(value * scale));
  const plans: Array<number[] | null> = Array.from({ length: target + 1 }, () => null);
  plans[0] = [];
  const spread = (values: number[]) => Math.max(...values) - Math.min(...values);
  for (let total = 1; total <= target; total += 1) {
    for (let index = 0; index < units.length; index += 1) {
      const previous = plans[total - units[index]];
      if (!previous) continue;
      const candidate = [...previous, options[index]].sort((left, right) => right - left);
      const current = plans[total];
      const better = !current
        || candidate.length < current.length
        || candidate.length === current.length && spread(candidate) < spread(current);
      if (better) plans[total] = candidate;
    }
  }
  const result = plans[target];
  return result && result.length >= 2 ? result : null;
}

export function resolveCommerceVideoDurationPlan(
  source: VideoModelCapabilitySource,
  rawRequested: unknown,
  options: DurationPlanOptions = {},
): CommerceVideoDurationPlan {
  const nativeOptions = commerceVideoNativeDurationOptions(source);
  const minimum = Number(options.minimum ?? 1);
  const maximum = Number(options.maximum ?? COMMERCE_VIDEO_MAX_TOTAL_DURATION);
  const requested = Number(rawRequested);
  if (!Number.isFinite(requested) || requested < minimum || requested > maximum) {
    throw new Error(`视频时长需在 ${minimum}–${maximum} 秒内`);
  }
  const native = nativeOptions.some((value) => Math.abs(value - requested) < 1e-8);
  if (native) return { requested, native: true, segments: [requested], nativeOptions, rollingOptions: [] };
  const rollingOptions = nativeOptions.filter((value) => value <= COMMERCE_ROLLING_SEGMENT_SECONDS);
  const segments = options.allowRolling === false
    ? null
    : planCommerceVideoSegments(requested, rollingOptions, maximum);
  if (!segments) throw new Error(
    requested > Math.max(0, ...nativeOptions)
      ? "该时长无法用当前模型的原生时长稳定分段"
      : "请选择模型支持的时长",
  );
  return { requested, native: false, segments, nativeOptions, rollingOptions };
}

export function commerceVideoTargetDurations(
  source: VideoModelCapabilitySource,
  options: DurationPlanOptions = {},
) {
  const native = commerceVideoNativeDurationOptions(source);
  const minimum = Number(options.minimum ?? Math.min(...native));
  const maximum = Number(options.maximum ?? COMMERCE_VIDEO_MAX_TOTAL_DURATION);
  const scale = scaleFor(native);
  const values: number[] = [];
  for (let value = Math.ceil(minimum * scale); value <= Math.floor(maximum * scale); value += 1) {
    const seconds = value / scale;
    try {
      resolveCommerceVideoDurationPlan(source, seconds, options);
      values.push(seconds);
    } catch {
      // Unsupported gaps are intentionally omitted from the customer picker.
    }
  }
  return uniquePositive(values);
}

export function commerceVideoResolutionOptions(source: VideoModelCapabilitySource) {
  return getVideoResolutionCapabilities(source);
}

export function assertCommerceVideoResolution(source: VideoModelCapabilitySource, requested: unknown) {
  const capabilities = commerceVideoResolutionOptions(source);
  if (!capabilities.options.length) return;
  const normalized = normalizeVideoResolution(requested);
  if (!capabilities.options.some((value) => normalizeVideoResolution(value) === normalized)) {
    throw new Error("模型不支持该分辨率");
  }
}

export function assertCommerceVideoAudioSetting(source: VideoModelCapabilitySource, requested: unknown) {
  if (requested === undefined) return;
  if (typeof requested !== "boolean") throw new Error("视频声音设置无效");
  if ((source as Record<string, unknown>).supportsGenerateAudioToggle !== true) throw new Error("此模型不支持切换生成声音");
}

export function commerceVideoSupportsAudioToggle(source: VideoModelCapabilitySource) {
  return (source as Record<string, unknown>).supportsGenerateAudioToggle === true;
}
