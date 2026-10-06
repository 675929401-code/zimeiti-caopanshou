export type VideoDurationMode = "range" | "discrete" | "fixed";

export type VideoModelCapabilitySource = {
  id?: unknown;
  name?: unknown;
  provider?: unknown;
  modelName?: unknown;
  model_name?: unknown;
  protocol_type?: unknown;
  durationSeconds?: unknown;
  duration_seconds?: unknown;
  maxDuration?: unknown;
  max_duration?: unknown;
  durationMode?: unknown;
  minDuration?: unknown;
  nativeDurations?: unknown;
  durationStep?: unknown;
  duration_step?: unknown;
  resolutionOptions?: unknown;
  resolution_options?: unknown;
  defaultResolution?: unknown;
  default_resolution?: unknown;
  resolutionTier?: unknown;
  resolutionLabels?: unknown;
  resolution_labels?: unknown;
  resolutionPrices?: unknown;
  resolution_prices?: unknown;
  resolutionCostPrices?: unknown;
  resolution_cost_prices?: unknown;
  billingUnit?: unknown;
  billing_unit?: unknown;
  publicPrice?: unknown;
  pricePerUse?: unknown;
  price_per_use?: unknown;
  costPrice?: unknown;
  cost_price?: unknown;
  capabilities?: unknown;
  api_protocol_config?: unknown;
};

export type VideoDurationCapabilities = {
  mode: VideoDurationMode;
  minDuration: number;
  maxDuration: number;
  defaultDuration: number;
  nativeDurations: number[];
};

export type ResolvedVideoTiming = VideoDurationCapabilities & {
  target: number;
  submit: number;
  needsTrim: boolean;
  supported: boolean;
};

export type VideoResolutionCapabilities = {
  options: string[];
  defaultResolution: string;
  labels: Record<string, string>;
  publicPrices: Record<string, number>;
  costPrices: Record<string, number>;
};

export type ResolvedVideoResolution = VideoResolutionCapabilities & {
  resolution: string;
  supported: boolean;
  publicPrice: number;
  costPrice: number;
};

export type VideoBillingUnit = "per_use" | "output_second";

export type ResolvedVideoCharge = ResolvedVideoResolution & {
  billingUnit: VideoBillingUnit;
  billingQuantity: number;
};

// `lite` is a provider quality tier exposed in the same request field as
// resolution by Gaorui VEO components. Keep the exact provider value instead
// of mislabelling it as 480p.
const VIDEO_RESOLUTIONS = new Set(["lite", "480p", "720p", "768p", "1080p", "2K", "4K"]);

/** Only the Gaorui preview variant (or an explicit legacy flag) requires an input image. */
export function requiresGaoruiGrok15InputImage(model?: VideoModelCapabilitySource): boolean {
  const modelName = typeof model?.model_name === "string" ? model.model_name : "";
  const protocolConfig = objectValue(model?.api_protocol_config);
  return model?.protocol_type === "gaorui_video"
    && modelName.startsWith("grok")
    && modelName.includes("1.5")
    && (modelName.includes("preview") || protocolConfig.requires_image_v15 === true);
}

export function normalizeVideoResolution(value: unknown) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (text.toLowerCase() === "lite") return "lite";
  const normalized = /^\d{3,4}p$/iu.test(text) ? text.toLowerCase() : text.toUpperCase();
  return VIDEO_RESOLUTIONS.has(normalized) ? normalized : "";
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function normalizedResolutionList(...values: unknown[]) {
  for (const value of values) {
    if (!Array.isArray(value)) continue;
    const options = value.map(normalizeVideoResolution).filter(Boolean);
    if (options.length > 0) return [...new Set(options)];
  }
  return [];
}

function resolutionPriceMap(value: unknown) {
  const prices: Record<string, number> = {};
  if (Array.isArray(value)) {
    value.forEach((entry) => {
      const [rawResolution, rawPrice] = String(entry || "").split(/[:=]/u, 2);
      const resolution = normalizeVideoResolution(rawResolution);
      const price = Number(rawPrice);
      if (resolution && Number.isFinite(price) && price >= 0) prices[resolution] = price;
    });
    return prices;
  }
  Object.entries(objectValue(value)).forEach(([rawResolution, rawPrice]) => {
    const resolution = normalizeVideoResolution(rawResolution);
    const price = Number(rawPrice);
    if (resolution && Number.isFinite(price) && price >= 0) prices[resolution] = price;
  });
  return prices;
}

function resolutionLabelMap(value: unknown) {
  const labels: Record<string, string> = {};
  const assign = (rawResolution: unknown, rawLabel: unknown) => {
    const resolution = normalizeVideoResolution(rawResolution);
    const label = String(rawLabel || "").trim().slice(0, 40);
    if (resolution && label) labels[resolution] = label;
  };
  if (Array.isArray(value)) {
    value.forEach((entry) => {
      const [rawResolution, rawLabel] = String(entry || "").split("=", 2);
      assign(rawResolution, rawLabel);
    });
    return labels;
  }
  Object.entries(objectValue(value)).forEach(([resolution, label]) => assign(resolution, label));
  return labels;
}

function firstNonNegativeNumber(fallback: number, ...values: unknown[]) {
  for (const value of values) {
    if (value === null || value === undefined || value === "") continue;
    if (typeof value !== "number" && typeof value !== "string") continue;
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return fallback;
}

export function getVideoResolutionCapabilities(model?: VideoModelCapabilitySource): VideoResolutionCapabilities {
  if (!model) return { options: [], defaultResolution: "", labels: {}, publicPrices: {}, costPrices: {} };
  const publicCapabilities = objectValue(model.capabilities);
  const protocolConfig = objectValue(model?.api_protocol_config);
  let options = normalizedResolutionList(
    model.resolutionOptions,
    model.resolution_options,
    publicCapabilities.resolutionOptions,
    protocolConfig.resolution_options,
    protocolConfig.resolutions,
  );
  // A small set of legacy rows predate structured resolution fields but carry
  // an explicit tier in their administrator-visible identity. Treat only
  // those literal declarations as capability metadata; ambiguous rows remain
  // provider-auto instead of receiving an invented resolution.
  if (options.length === 0) {
    const identity = normalizedIdentity(model);
    options = ["lite", "480p", "720p", "768p", "1080p", "2K", "4K"]
      .filter((resolution) => {
        const escaped = resolution.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
        return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "iu").test(identity);
      });
  }
  const declaredDefault = normalizeVideoResolution(
    model.defaultResolution
      ?? model.default_resolution
      ?? model.resolutionTier
      ?? publicCapabilities.defaultResolution
      ?? publicCapabilities.resolutionTier
      ?? protocolConfig.default_resolution
      ?? protocolConfig.resolution,
  );
  if (options.length === 0 && declaredDefault) options = [declaredDefault];
  const defaultResolution = options.includes(declaredDefault) ? declaredDefault : options[0] || "";

  const labels = resolutionLabelMap(
    model.resolutionLabels
      ?? model.resolution_labels
      ?? publicCapabilities.resolutionLabels
      ?? publicCapabilities.resolution_labels
      ?? protocolConfig.resolution_labels,
  );
  options.forEach((resolution) => {
    if (!labels[resolution]) labels[resolution] = resolution;
  });

  const publicPrices = resolutionPriceMap(
    model.resolutionPrices
      ?? model.resolution_prices
      ?? publicCapabilities.resolutionPrices
      ?? protocolConfig.resolution_prices,
  );
  const costPrices = resolutionPriceMap(
    model.resolutionCostPrices
      ?? model.resolution_cost_prices
      ?? protocolConfig.resolution_cost_prices,
  );
  const fallbackPublicPrice = firstNonNegativeNumber(
    Number.NaN,
    model.publicPrice,
    model.pricePerUse,
    model.price_per_use,
  );
  const fallbackCostPrice = firstNonNegativeNumber(
    Number.NaN,
    model.costPrice,
    model.cost_price,
  );
  options.forEach((resolution) => {
    if (publicPrices[resolution] === undefined && Number.isFinite(fallbackPublicPrice)) {
      publicPrices[resolution] = fallbackPublicPrice;
    }
    if (costPrices[resolution] === undefined && Number.isFinite(fallbackCostPrice)) {
      costPrices[resolution] = fallbackCostPrice;
    }
  });
  return { options, defaultResolution, labels, publicPrices, costPrices };
}

export function resolveVideoResolution(
  model: VideoModelCapabilitySource | undefined,
  requestedResolution?: unknown,
): ResolvedVideoResolution {
  const capabilities = getVideoResolutionCapabilities(model);
  const requested = normalizeVideoResolution(requestedResolution);
  const supported = !requested || capabilities.options.length === 0 || capabilities.options.includes(requested);
  const resolution = supported && requested
    ? requested
    : capabilities.defaultResolution || requested;
  return {
    ...capabilities,
    resolution,
    supported,
    publicPrice: capabilities.publicPrices[resolution]
      ?? firstNonNegativeNumber(Number.NaN, model?.publicPrice, model?.pricePerUse, model?.price_per_use),
    costPrice: capabilities.costPrices[resolution]
      ?? firstNonNegativeNumber(Number.NaN, model?.costPrice, model?.cost_price),
  };
}

export function getVideoBillingUnit(model?: VideoModelCapabilitySource): VideoBillingUnit {
  if (!model) return "per_use";
  const publicCapabilities = objectValue(model.capabilities);
  const protocolConfig = objectValue(model?.api_protocol_config);
  const configured = model.billingUnit
    ?? model.billing_unit
    ?? publicCapabilities.billingUnit
    ?? protocolConfig.billing_unit;
  return configured === "output_second" ? "output_second" : "per_use";
}

function money(value: number) {
  return Number.isFinite(value)
    ? Math.round(value * 10_000) / 10_000
    : Number.NaN;
}

/** Resolve the actual charge for one request, including duration-based providers. */
export function resolveVideoCharge(
  model: VideoModelCapabilitySource | undefined,
  requestedResolution?: unknown,
  outputDurationSeconds?: unknown,
): ResolvedVideoCharge {
  const resolution = resolveVideoResolution(model, requestedResolution);
  const billingUnit = getVideoBillingUnit(model);
  const parsedDuration = Number(outputDurationSeconds);
  const billingQuantity = billingUnit === "output_second"
    ? Math.max(1, Number.isFinite(parsedDuration) ? parsedDuration : 1)
    : 1;
  return {
    ...resolution,
    billingUnit,
    billingQuantity,
    publicPrice: money(resolution.publicPrice * billingQuantity),
    costPrice: money(resolution.costPrice * billingQuantity),
  };
}

function positiveDuration(value: unknown, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed * 10) / 10 : fallback;
}

function positiveInteger(value: unknown, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : fallback;
}

function normalizedIdentity(model: VideoModelCapabilitySource) {
  return [model.id, model.name, model.provider, model.modelName, model.model_name]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .toLowerCase();
}

function declaredCapabilities(model: VideoModelCapabilitySource): VideoDurationCapabilities | null {
  const mode = model.durationMode;
  if (mode !== "range" && mode !== "discrete" && mode !== "fixed") return null;
  const fallbackDuration = positiveInteger(model.durationSeconds ?? model.duration_seconds, 10);
  const declaredDurations = Array.isArray(model.nativeDurations)
    ? model.nativeDurations.map(Number).filter((item) => Number.isInteger(item) && item > 0)
    : [];
  const nativeDurations = [...new Set(declaredDurations)].sort((left, right) => left - right);
  const minDuration = (mode === "range" ? positiveDuration : positiveInteger)(model.minDuration, nativeDurations[0] || (mode === "range" ? 1 : fallbackDuration));
  const maxDuration = Math.max(minDuration, (mode === "range" ? positiveDuration : positiveInteger)(
    model.maxDuration ?? model.max_duration,
    nativeDurations.at(-1) || fallbackDuration,
  ));
  return {
    mode,
    minDuration,
    maxDuration,
    defaultDuration: Math.max(minDuration, Math.min(fallbackDuration, maxDuration)),
    nativeDurations: mode === "range" ? [] : nativeDurations.length > 0 ? nativeDurations : [fallbackDuration],
  };
}

function configuredCapabilities(model: VideoModelCapabilitySource): VideoDurationCapabilities | null {
  const config = model.api_protocol_config;
  if (!config || typeof config !== "object") return null;
  const value = config as Record<string, unknown>;
  const configuredOptions = Array.isArray(value.duration_options)
    ? value.duration_options.map(Number).filter((item) => Number.isInteger(item) && item > 0)
    : [];
  if (configuredOptions.length > 0) {
    const nativeDurations = [...new Set(configuredOptions)].sort((a, b) => a - b);
    const requestedDefault = positiveInteger(model.durationSeconds ?? model.duration_seconds, nativeDurations[0]);
    const defaultDuration = nativeDurations.includes(requestedDefault) ? requestedDefault : nativeDurations[0];
    return {
      mode: nativeDurations.length === 1 ? "fixed" : "discrete",
      minDuration: nativeDurations[0],
      maxDuration: nativeDurations.at(-1)!,
      defaultDuration,
      nativeDurations,
    };
  }
  if (value.supports_duration === true && Number(value.min_duration) > 0) {
    const minDuration = positiveDuration(value.min_duration, 1);
    const maxDuration = positiveDuration(
      value.max_duration ?? model.maxDuration ?? model.max_duration,
      positiveInteger(model.durationSeconds ?? model.duration_seconds, 10),
    );
    return {
      mode: "range",
      minDuration,
      maxDuration: Math.max(minDuration, maxDuration),
      defaultDuration: Math.max(minDuration, Math.min(
        positiveInteger(model.durationSeconds ?? model.duration_seconds, maxDuration),
        Math.max(minDuration, maxDuration),
      )),
      nativeDurations: [],
    };
  }
  return null;
}

export function getVideoDurationCapabilities(model?: VideoModelCapabilitySource): VideoDurationCapabilities {
  const fallbackDuration = positiveInteger(model?.durationSeconds ?? model?.duration_seconds, 10);
  if (!model) {
    return { mode: "fixed", minDuration: fallbackDuration, maxDuration: fallbackDuration, defaultDuration: fallbackDuration, nativeDurations: [fallbackDuration] };
  }

  const identity = normalizedIdentity(model);
  const declared = declaredCapabilities(model);
  if (declared) return declared;
  const configured = configuredCapabilities(model);
  // Provider-specific configuration takes precedence over name-based legacy defaults.
  if (configured) return configured;
  if (identity.includes("grok-imagine-1.0-video-super-20s") || (identity.includes("1.0 super") && identity.includes("20"))) {
    return { mode: "discrete", minDuration: 6, maxDuration: 20, defaultDuration: 20, nativeDurations: [6, 10, 12, 16, 20] };
  }
  if (identity.includes("grok-imagine-image-pro")) {
    return { mode: "fixed", minDuration: 10, maxDuration: 10, defaultDuration: 10, nativeDurations: [10] };
  }
  if (
    identity.includes("grok-imagine-1.5")
    || identity.includes("grok-imagine-video-1.5")
    || identity.includes("grok-imagine-video-1-5")
    || identity.includes("grok-imagine-video")
  ) {
    return { mode: "range", minDuration: 1, maxDuration: 15, defaultDuration: Math.min(fallbackDuration, 15), nativeDurations: [] };
  }

  if (configured) return configured;

  const maxDuration = positiveInteger(model.maxDuration ?? model.max_duration, fallbackDuration);
  if (maxDuration > fallbackDuration) {
    return { mode: "range", minDuration: 1, maxDuration, defaultDuration: fallbackDuration, nativeDurations: [] };
  }
  return { mode: "fixed", minDuration: fallbackDuration, maxDuration: fallbackDuration, defaultDuration: fallbackDuration, nativeDurations: [fallbackDuration] };
}

export function resolveVideoDuration(model: VideoModelCapabilitySource | undefined, targetSeconds: number): ResolvedVideoTiming {
  const capabilities = getVideoDurationCapabilities(model);
  const target = positiveDuration(targetSeconds, capabilities.defaultDuration);
  const supported = target >= capabilities.minDuration && target <= capabilities.maxDuration;
  let submit = target;

  if (capabilities.mode === "fixed") {
    submit = capabilities.defaultDuration;
  } else if (capabilities.mode === "discrete") {
    submit = capabilities.nativeDurations.find((duration) => duration >= target) ?? capabilities.maxDuration;
  } else {
    submit = Math.ceil(Math.max(capabilities.minDuration, Math.min(target, capabilities.maxDuration)));
  }

  const protocolConfig = model?.api_protocol_config && typeof model.api_protocol_config === "object"
    ? model.api_protocol_config as Record<string, unknown>
    : null;
  const identity = model ? normalizedIdentity(model) : "";
  const observedMinimumSubmit = positiveInteger(
    protocolConfig?.min_submit_duration,
    identity.includes("minimax-h3") ? 5 : 0,
  );
  if (observedMinimumSubmit > 0) {
    submit = Math.max(submit, Math.min(observedMinimumSubmit, capabilities.maxDuration));
  }

  return {
    ...capabilities,
    target,
    submit,
    needsTrim: supported && submit > target,
    supported,
  };
}

export function getVideoTargetDurationOptions(model?: VideoModelCapabilitySource) {
  const capabilities = getVideoDurationCapabilities(model);
  if (capabilities.mode === "fixed") return [capabilities.defaultDuration];
  if (capabilities.mode === "discrete") return capabilities.nativeDurations;
  const publicCapabilities = objectValue(model?.capabilities);
  const protocolConfig = objectValue(model?.api_protocol_config);
  const configuredStep = Number(model?.durationStep ?? model?.duration_step ?? publicCapabilities.durationStep ?? protocolConfig.duration_step);
  const step = Number.isFinite(configuredStep) && configuredStep > 0 ? configuredStep : 0.5;
  const count = Math.max(1, Math.floor((capabilities.maxDuration - capabilities.minDuration) / step) + 1);
  return Array.from({ length: count }, (_, index) => Math.round((capabilities.minDuration + index * step) * 10) / 10);
}

export function coerceVideoTargetDuration(model: VideoModelCapabilitySource | undefined, value: number) {
  const capabilities = getVideoDurationCapabilities(model);
  if (capabilities.mode === "fixed") return capabilities.defaultDuration;
  const requested = positiveDuration(value, capabilities.defaultDuration);
  if (capabilities.mode === "discrete") {
    return capabilities.nativeDurations.reduce((closest, duration) => (
      Math.abs(duration - requested) < Math.abs(closest - requested) ? duration : closest
    ), capabilities.defaultDuration);
  }
  const publicCapabilities = objectValue(model?.capabilities);
  const protocolConfig = objectValue(model?.api_protocol_config);
  const configuredStep = Number(model?.durationStep ?? model?.duration_step ?? publicCapabilities.durationStep ?? protocolConfig.duration_step);
  const step = Number.isFinite(configuredStep) && configuredStep > 0 ? configuredStep : 0.5;
  const clamped = Math.max(capabilities.minDuration, Math.min(requested, capabilities.maxDuration));
  const stepped = capabilities.minDuration + Math.round((clamped - capabilities.minDuration) / step) * step;
  return Math.round(Math.max(capabilities.minDuration, Math.min(stepped, capabilities.maxDuration)) * 10) / 10;
}
