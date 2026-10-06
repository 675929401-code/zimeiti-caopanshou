import "server-only";

import { models, type Kind, type Model } from "../../commerce/server/models";
import type { ModelCapabilityProfile } from "../domain/contracts";

function positiveInteger(value: unknown, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.trunc(number) : fallback;
}

function strings(value: unknown) {
  return Array.isArray(value) ? [...new Set(value.map(String).map((item) => item.trim()).filter(Boolean))] : [];
}

function numbers(value: unknown) {
  return Array.isArray(value)
    ? [...new Set(value.map(Number).filter((item) => Number.isFinite(item) && item > 0))].sort((left, right) => left - right)
    : [];
}

function publicModel(model: Model): ModelCapabilityProfile {
  const capabilities = model.capabilities || {};
  const available = capabilities.available !== false;
  const executionReady = available
    && capabilities.executionSupported === true
    && Boolean(model.configHash)
    && Boolean(model.verifiedAt);
  const publicPrice = Number(model.publicPrice);
  return {
    id: model.id,
    displayName: model.displayName,
    configHash: model.configHash,
    available,
    executionReady,
    readinessMessage: executionReady
      ? "执行链已验收"
      : String(capabilities.availabilityMessage || "模型尚未完成凭据、协议和真实生成验收"),
    billingUnit: model.billingUnit,
    publicPrice: Number.isFinite(publicPrice) && publicPrice >= 0 ? publicPrice : null,
    capabilities: {
      supportsImageInput: capabilities.supportsImageInput === true || capabilities.supportsReferenceInput === true,
      maxReferenceImages: positiveInteger(capabilities.maxReferenceImages),
      minReferenceImages: positiveInteger(capabilities.minReferenceImages),
      supportsSourceVideoInput: capabilities.supportsSourceVideoInput === true,
      maxReferenceVideos: positiveInteger(capabilities.maxReferenceVideos, capabilities.supportsSourceVideoInput === true ? 1 : 0),
      requiresSourceVideo: capabilities.requiresSourceVideo === true,
      supportsAudioInput: capabilities.supportsAudioInput === true,
      maxReferenceAudios: positiveInteger(capabilities.maxReferenceAudios),
      supportsGenerateAudioToggle: capabilities.supportsGenerateAudioToggle === true,
      aspectRatios: strings(capabilities.aspectRatios),
      resolutionOptions: strings(capabilities.resolutionOptions),
      nativeDurations: numbers(capabilities.nativeDurations ?? capabilities.durationOptions),
      supportsRollingContinuation: capabilities.supportsRollingContinuation === true,
    },
  };
}

export async function commerceV2Models(kind: Kind) {
  return (await models(kind)).map(publicModel);
}
