import { ImageProviderBindingError, resolveImageProviderContract } from './image-provider-contract';
import { buildSecureSkillImagePayload, SECURE_SKILL_GPT25_SYNC_V2_CONTRACT, validateSecureSkillGpt25SyncInput } from './secure-skill-image-adapter';
import { DETAIL_QUALITY_OPTIONS, isDetailImageQuality } from '../commerce/shared/detail-image-quality';
import type { ImageResolution } from './image-model-capabilities';

type ModelConfig = Parameters<typeof resolveImageProviderContract>[0];

export function commerceDetailQualityCapabilities(model: ModelConfig) {
  const config = model.api_protocol_config;
  if (config?.provider_contract !== SECURE_SKILL_GPT25_SYNC_V2_CONTRACT) return {};
  let contract: ReturnType<typeof resolveImageProviderContract>;
  try { contract = resolveImageProviderContract(model); }
  catch (error) { if (error instanceof ImageProviderBindingError) return {}; throw error; }
  const issue = validateSecureSkillGpt25SyncInput({
    providerContract: SECURE_SKILL_GPT25_SYNC_V2_CONTRACT, modelName: model.model_name || '', prompt: '',
    resolution: '1K', aspectRatio: '1:1', requestProtocol: contract.requestProtocol,
    referenceTransport: contract.referenceTransport, maxReferenceImages: 9, protocolConfig: config,
  });
  if (issue) return {};
  return { detailImageQualities: DETAIL_QUALITY_OPTIONS.map(option => option.value), detailDefaultQuality: config.quality || 'high' };
}

export function commerceDetailQualityPayload(model: ModelConfig, input: {
  prompt: string; resolution: string; aspectRatio: string; quality: unknown; references: string[];
}) {
  const caps = commerceDetailQualityCapabilities(model);
  const preset = input.quality === caps.detailDefaultQuality && (input.quality === 'low' || input.quality === 'max');
  if (!caps.detailImageQualities || (!isDetailImageQuality(input.quality) && !preset)) throw Error('DETAIL_IMAGE_QUALITY_UNSUPPORTED');
  return buildSecureSkillImagePayload({providerContract: SECURE_SKILL_GPT25_SYNC_V2_CONTRACT,
    modelName:model.model_name || '', prompt:input.prompt, resolution:input.resolution as ImageResolution,
    aspectRatio:input.aspectRatio, quality:String(input.quality), referenceImageUrls:input.references});
}
