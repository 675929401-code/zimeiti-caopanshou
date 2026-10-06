import 'server-only';

import { createHash } from 'node:crypto';

import {
  ALI_LONG_VIDEO_SEGMENT_SECONDS,
  planAliLongDigitalHumanVideo,
  quoteAliLongDigitalHumanVideo,
  LongVideoPlanError,
  type LongVideoBoundary,
} from '@/features/digital-human/long-video-segmentation';
import { checkCashBalance } from '@/lib/billing-executor';
import { ownedDigitalHumanAsset } from '@/lib/digital-human-assets';
import { digitalModelHash, digitalProviderKey } from '@/lib/digital-video-dispatch';
import { DigitalHumanLongError, reserveLongDigitalHumanJob } from '@/lib/digital-human-long-repository';
import { findModelByPublicId } from '@/lib/public-model-dto';
import { resolveProviderSecret } from '@/lib/provider-secret';
import type { VideoModelConfig } from '@/lib/video-adapter';
import { isReleaseVerifiedVideoChannelHealth } from '@/lib/video-channel-health-release';
import { resolveVideoCharge } from '@/lib/video-model-capabilities';
import { isDigitalHumanWorkspaceModel } from '@/lib/video-model-surface';
import { inspectVideoModelActivationReadiness } from '@/lib/model-activation-gate';
import { getSupabaseAdminClient } from '@/storage/database/supabase-client';

type Json = Record<string, unknown>;

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
  }
  return value;
}

function hash(value: unknown) {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

function stableId(prefix: 'dhl' | 'dhls', value: unknown) {
  return `${prefix}_${hash(value).slice(0, 40)}`;
}

function boundaries(value: unknown): LongVideoBoundary[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 500).flatMap((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const raw = item as Json;
    const atSeconds = Number(raw.atSeconds);
    const kind = String(raw.kind || 'sentence');
    if (!Number.isFinite(atSeconds) || !['manual', 'silence', 'sentence'].includes(kind)) return [];
    return [{ atSeconds, kind: kind as LongVideoBoundary['kind'], confidence: Number(raw.confidence ?? 1) }];
  });
}

export type CreateLongDigitalHumanInput = {
  userId: string;
  publicModelId: string;
  clientRequestId: string;
  personAssetId: string;
  audioAssetId: string;
  durationChoice?: string;
  resolution?: string;
  boundaries?: unknown;
};

export async function createLongDigitalHumanJob(input: CreateLongDigitalHumanInput) {
  if (!/^digital-long-[a-zA-Z0-9-]{16,90}$/u.test(input.clientRequestId)) {
    throw new DigitalHumanLongError('DIGITAL_HUMAN_LONG_REQUEST_INVALID', '长视频任务编号无效', 400);
  }
  if (input.durationChoice !== 'preserve_audio') {
    throw new DigitalHumanLongError('DIGITAL_HUMAN_LONG_DURATION_CHOICE_REQUIRED', '超过两分钟的配音请选择“保留完整配音，自动分段合并”', 422);
  }
  if (input.resolution && input.resolution !== '720p') {
    throw new DigitalHumanLongError('DIGITAL_HUMAN_LONG_RESOLUTION_UNSUPPORTED', '长视频自动合并当前仅支持 720p', 422);
  }

  const db = getSupabaseAdminClient();
  const { data: models, error: modelError } = await db.from('video_models').select('*')
    .eq('is_active', true).eq('is_hidden', false).eq('protocol_type', 'dashscope_video_retalk');
  if (modelError) throw new DigitalHumanLongError('DIGITAL_HUMAN_LONG_MODELS_UNAVAILABLE', '数字人模型列表暂时无法读取');
  const raw = findModelByPublicId('video', (models || []) as Array<Json & { id?: unknown }>, input.publicModelId);
  if (!raw || !isDigitalHumanWorkspaceModel(raw)) {
    throw new DigitalHumanLongError('DIGITAL_HUMAN_LONG_MODEL_UNAVAILABLE', '请选择当前可用的阿里视频改口型模型', 422);
  }
  const activation = inspectVideoModelActivationReadiness({
    id: String(raw.id || ''), model_name: raw.model_name, provider: raw.provider,
    protocol_type: raw.protocol_type, api_endpoint: raw.api_endpoint,
    api_key: raw.api_key, api_protocol_config: raw.api_protocol_config,
  });
  if (!activation.ready) {
    throw new DigitalHumanLongError(
      'MODEL_ACCEPTANCE_EVIDENCE_INCOMPLETE',
      '该数字人模型尚未完成真实生成验收，本次任务未提交',
      409,
    );
  }
  const { data: health, error: healthError } = await db.from('video_channel_health').select('*')
    .eq('channel_id', String(raw.id)).maybeSingle();
  if (healthError || !isReleaseVerifiedVideoChannelHealth(health)) {
    throw new DigitalHumanLongError('DIGITAL_HUMAN_LONG_MODEL_UNVERIFIED', '该模型当前没有有效的可用性验收记录，请稍后再试', 503);
  }

  let person;
  let audio;
  try {
    [person, audio] = await Promise.all([
      ownedDigitalHumanAsset(input.userId, input.personAssetId),
      ownedDigitalHumanAsset(input.userId, input.audioAssetId),
    ]);
  } catch (error) {
    throw new DigitalHumanLongError(
      'DIGITAL_HUMAN_LONG_ASSET_UNAVAILABLE',
      error instanceof Error ? error.message : '人物素材或配音暂时无法读取，请重新上传',
      422,
    );
  }
  if (person.category !== 'video' || audio.category !== 'audio') {
    throw new DigitalHumanLongError('DIGITAL_HUMAN_LONG_ASSET_TYPE_INVALID', '请上传人物视频和配音音频', 422);
  }
  if (audio.duration <= ALI_LONG_VIDEO_SEGMENT_SECONDS) {
    throw new DigitalHumanLongError('DIGITAL_HUMAN_LONG_NOT_REQUIRED', '当前配音可直接使用普通视频改口型，无需自动分段', 422);
  }
  let plan;
  try {
    plan = planAliLongDigitalHumanVideo({ totalDurationSeconds: audio.duration, boundaries: boundaries(input.boundaries) });
  } catch (error) {
    if (error instanceof LongVideoPlanError) throw new DigitalHumanLongError(error.code, error.message, 422);
    throw error;
  }
  const unitCharge = resolveVideoCharge(raw, '720p', 1);
  if (!unitCharge.supported || unitCharge.resolution !== '720p') {
    throw new DigitalHumanLongError('DIGITAL_HUMAN_LONG_RESOLUTION_UNSUPPORTED', '该模型尚未发布 720p 长视频能力', 503);
  }
  if (unitCharge.billingUnit !== 'output_second' || !Number.isFinite(unitCharge.publicPrice) || unitCharge.publicPrice <= 0) {
    throw new DigitalHumanLongError('DIGITAL_HUMAN_LONG_PRICE_INVALID', '模型尚未配置有效的按秒售价', 503);
  }
  if (!Number.isFinite(unitCharge.costPrice) || unitCharge.costPrice < 0) {
    throw new DigitalHumanLongError('DIGITAL_HUMAN_LONG_COST_INVALID', '模型尚未配置有效的按秒成本价', 503);
  }
  const quote = quoteAliLongDigitalHumanVideo(plan, unitCharge.publicPrice);
  const lockedPriceYuan = quote.lockedTotalYuan;
  const lockedCostYuan = Math.round(plan.totalDurationSeconds * unitCharge.costPrice * 10_000) / 10_000;
  const wallet = await checkCashBalance(input.userId);
  if (!wallet.exists) throw new DigitalHumanLongError('DIGITAL_HUMAN_LONG_WALLET_UNAVAILABLE', '本站钱包暂时无法读取');
  if (wallet.balance + 0.0001 < lockedPriceYuan) {
    throw new DigitalHumanLongError('INSUFFICIENT_CASH_BALANCE', `本站钱包余额不足，本次预计费用 ¥${quote.lockedTotalYuan.toFixed(2)}`, 402);
  }

  const model = {
    ...raw,
    api_key: resolveProviderSecret(raw.api_key),
    model_name: raw.model_name || raw.id,
    api_protocol_config: raw.api_protocol_config || undefined,
  } as unknown as VideoModelConfig;
  const providerKey = digitalProviderKey(model);
  const modelHash = digitalModelHash(model);
  const parentId = stableId('dhl', [input.userId, input.clientRequestId]);
  const fingerprint = hash({
    userId: input.userId,
    publicModelId: input.publicModelId,
    internalModelId: model.id,
    modelHash,
    personAssetId: person.id,
    audioAssetId: audio.id,
    durationChoice: input.durationChoice,
    resolution: '720p',
    totalDurationSeconds: plan.totalDurationSeconds,
    segments: plan.segments,
    unitPriceYuan: quote.unitPriceYuan,
    lockedPriceYuan,
  });
  const billingIdempotencyKey = `digital-human-long:${parentId}:settle`;
  const parent = {
    id: parentId,
    userId: input.userId,
    clientRequestId: input.clientRequestId,
    requestFingerprint: fingerprint,
    modelId: model.id,
    protocolType: model.protocol_type,
    providerKey,
    modelHash,
    sourceVideoAssetId: person.id,
    sourceAudioAssetId: audio.id,
    sourceVideoDurationSeconds: person.duration,
    sourceAudioDurationSeconds: audio.duration,
    videoExtension: false,
    totalDurationSeconds: plan.totalDurationSeconds,
    plannedSegmentCount: plan.segmentCount,
    recommendedSegmentSeconds: plan.recommendedMaxSegmentSeconds,
    resolution: '720p',
    unitPriceYuan: quote.unitPriceYuan,
    unitCostYuan: unitCharge.costPrice,
    billingExempt: false,
    lockedPriceYuan,
    lockedCostYuan,
    billingIdempotencyKey,
  };
  const segments = plan.segments.map((segment) => ({
    id: stableId('dhls', [parentId, segment.ordinal, segment.startSeconds, segment.endSeconds]),
    ordinal: segment.ordinal,
    startSeconds: segment.startSeconds,
    endSeconds: segment.endSeconds,
    durationSeconds: segment.durationSeconds,
    boundaryKind: segment.endBoundary,
  }));
  const reservation = await reserveLongDigitalHumanJob(parent, segments);
  return {
    taskId: parentId,
    status: String(reservation.state || 'queued'),
    replayed: reservation.created === false,
    totalDurationSeconds: plan.totalDurationSeconds,
    segmentCount: plan.segmentCount,
    quotedPriceYuan: lockedPriceYuan,
    unitPriceYuan: quote.unitPriceYuan,
    billingUnit: 'output_second' as const,
    modelId: input.publicModelId,
  };
}
