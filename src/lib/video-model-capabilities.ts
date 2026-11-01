import { isDigitalHumanWorkspaceModel } from "./video-model-surface";

export type VideoDurationMode = "range" | "discrete" | "fixed";

export type VideoModelCapabilitySource = {
  id?: unknown;
  name?: unknown;
  provider?: unknown;
  modelName?: unknown;
  model_name?: unknown;
  protocol_type?: unknown;
  protocolType?: unknown;
  provider_billing_unit?: unknown;
  providerBillingUnit?: unknown;
  requires_source_video?: unknown;
  requiresSourceVideo?: unknown;
  workspaceSurfaces?: unknown;
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
  tokenPricing?: unknown;
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

export type VideoBillingUnit = "per_use" | "output_second" | "token";
export type VideoTokenPublicPricing = { salePricesPerMillion: Record<string, number>; priceVersion: string };
export type VideoTokenBillingRequest = { maxChargeYuan: number; priceVersion: string };
export type VideoTokenChargeConsent = { modelId: string; priceVersion: string; amount: string };

/** Accept public sales rates only; provider costs never enter this client contract. */
export function readVideoTokenPublicPricing(value: unknown): VideoTokenPublicPricing | undefined {
  const input = objectValue(value);
  const rates = objectValue(input.salePricesPerMillion);
  const keys = ["720p:no_reference_video", "720p:reference_video"];
  if (typeof input.priceVersion !== "string" || !input.priceVersion.trim()
    || !keys.every(key => typeof rates[key] === "number" && Number.isFinite(rates[key]) && Number(rates[key]) > 0)) return undefined;
  return { salePricesPerMillion: Object.fromEntries(keys.map(key => [key, Number(rates[key])])), priceVersion: input.priceVersion };
}

/** Explicit positive yuan amount, at most two decimals; never coerce empty input to zero. */
export function parseVideoTokenMaxCharge(value: string): number | undefined {
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/u.test(value)) return undefined;
  const amount = Number(value);
  const cents = Math.round(amount * 100);
  return amount > 0 && Number.isSafeInteger(cents) && cents > 0 ? cents / 100 : undefined;
}

export function videoTokenBudgetTotal(maxChargeYuan: number, taskCount: number): number {
  if (parseVideoTokenMaxCharge(String(maxChargeYuan)) === undefined) return Number.NaN;
  const totalCents = Math.round(maxChargeYuan * 100) * taskCount;
  return Number.isSafeInteger(totalCents) && Number.isSafeInteger(taskCount) && taskCount > 0 ? totalCents / 100 : Number.NaN;
}

export function resolveVideoTokenBillingConsent(model: VideoModelCapabilitySource | undefined, consent: VideoTokenChargeConsent | null): VideoTokenBillingRequest | undefined {
  const pricing = readVideoTokenPublicPricing(model?.tokenPricing);
  if (getVideoBillingUnit(model) !== "token" || !pricing || consent?.modelId !== model?.id || consent?.priceVersion !== pricing.priceVersion) return undefined;
  const maxChargeYuan = parseVideoTokenMaxCharge(consent.amount);
  return maxChargeYuan === undefined ? undefined : { maxChargeYuan, priceVersion: pricing.priceVersion };
}

export function videoTokenRateLabel(model?: VideoModelCapabilitySource, resolution = "720p", hasReferenceVideo = false): string {
  const pricing = readVideoTokenPublicPricing(model?.tokenPricing);
  const rate = pricing?.salePricesPerMillion[`${resolution}:${hasReferenceVideo ? "reference_video" : "no_reference_video"}`];
  return rate === undefined ? "Token 价格待配置" : `¥${rate.toLocaleString("zh-CN", { maximumFractionDigits: 6 })}/百万Token · 按实际用量结算`;
}

export type ResolvedVideoCharge = ResolvedVideoResolution & {
  billingUnit: VideoBillingUnit;
  billingQuantity: number;
};

// `lite` is a provider quality tier exposed in the same request field as
// resolution by Gaorui VEO components. Keep the exact provider value instead
// of mislabelling it as 480p.
const VIDEO_RESOLUTIONS = new Set(["lite", "480p", "720p", "768p", "1080p", "2K", "4K"]);

/** Gaorui's current 1.5 variants accept text or images; retain an explicit operator requirement. */
export function requiresGaoruiGrok15InputImage(model?: VideoModelCapabilitySource): boolean {
  const modelName = typeof model?.model_name === "string" ? model.model_name : "";
  const protocolConfig = objectValue(model?.api_protocol_config);
  return model?.protocol_type === "gaorui_video"
    && modelName.startsWith("grok")
    && modelName.includes("1.5")
    && protocolConfig.requires_image_v15 === true;
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

function requiresSourceVideoDuration(model?: VideoModelCapabilitySource) {
  return model?.requiresSourceVideo === true || model?.requires_source_video === true
    || objectValue(model?.capabilities).requiresSourceVideo === true
    || objectValue(model?.api_protocol_config).requires_source_video === true;
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
  return configured === "token" ? "token" : configured === "output_second" ? "output_second" : "per_use";
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
  // Token usage is unknown before completion. A legacy flat quote must never substitute for it.
  if (billingUnit === "token") return { ...resolution, billingUnit, billingQuantity: Number.NaN, publicPrice: Number.NaN, costPrice: Number.NaN };
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

  const publicCapabilities = objectValue(model.capabilities);
  const protocolConfig = objectValue(model.api_protocol_config);
  const registeredDuration = Number(model.durationSeconds ?? model.duration_seconds);
  const providerBillingUnit = String(model.providerBillingUnit ?? model.provider_billing_unit
    ?? publicCapabilities.providerBillingUnit ?? protocolConfig.provider_billing_unit ?? "").trim().toLowerCase();
  const followsSourceVideo = requiresSourceVideoDuration(model);
  const digitalHuman = isDigitalHumanWorkspaceModel({
    ...model,
    protocol_type: model.protocol_type ?? model.protocolType,
    api_protocol_config: {
      ...protocolConfig,
      workspace_surfaces: protocolConfig.workspace_surfaces ?? model.workspaceSurfaces ?? publicCapabilities.workspaceSurfaces,
    },
  });
  // Source-driven editing does not submit an output duration. Its registered
  // scalar/options describe the input ceiling, not a fixed-length product.
  // Honour the explicit source-input contract and stored bounds together;
  // optional source support alone must never exempt an ordinary fixed SKU.
  if (followsSourceVideo && protocolConfig.supports_duration === false) {
    const minimum = Number(protocolConfig.min_duration);
    const maximum = Number(protocolConfig.max_duration ?? model.maxDuration ?? model.max_duration);
    if (Number.isFinite(minimum) && minimum > 0 && Number.isFinite(maximum) && maximum >= minimum) {
      return { mode: "range", minDuration: minimum, maxDuration: maximum,
        defaultDuration: Math.max(minimum, Math.min(Number.isFinite(registeredDuration) && registeredDuration > 0
          ? registeredDuration : maximum, maximum)), nativeDurations: [] };
    }
  }
  // This is the registered per-use PRODUCT duration, not a claim that the
  // provider's underlying model cannot technically produce other durations.
  if (getVideoBillingUnit(model) === "per_use" && Number.isFinite(registeredDuration) && registeredDuration > 0
    && providerBillingUnit !== "token" && !digitalHuman && !followsSourceVideo) {
    return { mode: "fixed", minDuration: registeredDuration, maxDuration: registeredDuration,
      defaultDuration: registeredDuration, nativeDurations: [registeredDuration] };
  }
  const declared = declaredCapabilities(model);
  if (declared) return declared;
  const configured = configuredCapabilities(model);
  // Only explicit capability/protocol declarations enable variable duration.
  if (configured) return configured;
  return { mode: "fixed", minDuration: fallbackDuration, maxDuration: fallbackDuration, defaultDuration: fallbackDuration, nativeDurations: [fallbackDuration] };
}

/** Validate a new request without changing its native duration or scheduling a trim. */
export function resolveVideoDuration(model: VideoModelCapabilitySource | undefined, targetSeconds: number): ResolvedVideoTiming {
  const capabilities = getVideoDurationCapabilities(model);
  const requested = Number(targetSeconds);
  const validTarget = Number.isFinite(requested) && requested > 0;
  const target = validTarget ? requested : capabilities.defaultDuration;
  let supported = validTarget && target >= capabilities.minDuration && target <= capabilities.maxDuration;
  const protocolConfig = objectValue(model?.api_protocol_config);
  if (capabilities.mode === "fixed") {
    supported = supported && target === capabilities.defaultDuration;
  } else if (capabilities.mode === "discrete") {
    supported = supported && capabilities.nativeDurations.includes(target);
  } else if (!requiresSourceVideoDuration(model)) {
    const publicCapabilities = objectValue(model?.capabilities);
    const declaredStep = model?.durationStep ?? model?.duration_step ?? publicCapabilities.durationStep ?? protocolConfig.duration_step;
    if (declaredStep !== undefined && declaredStep !== null) {
      const step = Number(declaredStep);
      const offset = (target - capabilities.minDuration) / step;
      supported = supported && Number.isFinite(step) && step > 0
        && Math.abs(offset - Math.round(offset)) < 1e-9;
    }
  }
  const minimumSubmit = Number(protocolConfig.min_submit_duration);
  if (Number.isFinite(minimumSubmit) && minimumSubmit > 0) {
    supported = supported && target >= minimumSubmit;
  }
  return { ...capabilities, target, submit: target, supported };
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
  if (requiresSourceVideoDuration(model) && capabilities.mode === "range") {
    const sourceDuration = Number(value);
    return Number.isFinite(sourceDuration) && sourceDuration > 0 ? sourceDuration : capabilities.defaultDuration;
  }
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
