import { readVoiceCatalog } from '@/lib/voice-studio/catalog';
// 语音合成 API
// POST /api/voice/tts
// 
// 支持两种模式：
//   A) 传统 TTS：text + speaker → seed-tts-2.0 语音合成
//   B) 音频生成：textPrompt + (speaker/audioUrl/references) → seed-audio-1.0 AI音频生成
//
// 扣费链路（v2 — 字符数/分钟计价）：
//   1. 解析用户身份（withAuth）
//   2. 计算预计费用：字符数 × ModelConfig定价 × (1+利润率) 或 按分钟计价
//   3. 检查余额并扣减积分（CAS原子模式）
//   4. 调用 TTS 引擎合成 或 Seed-Audio 生成
//   5. 成功 → 写入 voice_billing_records；失败 → 退款
import { NextResponse } from 'next/server';
import { joinVoiceAudio } from '@/lib/voice-audio-join';
import { TTSEngine } from '@/lib/types';
import { routeTTS } from '@/lib/tts/router';
import { getAllVoices, getAllEngineConfigs } from '@/lib/voice-store';
import { withAuth, AuthUser } from '@/lib/api-middleware';
import { calculateVoiceCost, inferModelId, roundVoiceAccounting } from '@/lib/vs/pricing';
import { getDefaultModelBySpeaker } from '@/lib/vs/voices-data';
import { storageManager, type StorageProviderType } from '@/storage/object';
import { safeUploadFileName, validateUploadBuffer } from '@/lib/file-upload-security';
import { safeFetch } from '@/lib/safe-fetch';
import { createHash } from 'crypto';
import { getBillingConfig } from '@/lib/billing';
import { probeGeneratedAudioDuration } from '@/lib/digital-human-media';
import { publicVoiceResponse } from '@/lib/public-voice-response';
import {
  beginVoiceGenerationAtomic,
  finalizeVoiceGenerationAtomic,
  refundVoiceGenerationAtomic,
  VoiceGenerationLifecycleError,
  type VoiceGenerationRecord,
} from '@/lib/voice-generation-lifecycle';
import { createVoiceHistorySnapshot } from '@/lib/voice-generation-history-mapper';
import { translateForEngine } from '@/lib/tts/markers';
import { recordRevenue } from '@/lib/revenue';
import { readOwnedCustomVoiceAudio } from '@/lib/server/custom-voice-assets';
import { MAX_SEED_AUDIO_REFERENCES } from '@/lib/vs/reference-audio-contract';
import { resolveAuthorizedVoiceSpeaker } from '@/lib/vs/speaker-authorization';

type PersistedAudio = {
  duration: number;
  assetId: string;
  signedUrl: string;
  objectUri: string;
  storageKey: string;
  storageProvider: StorageProviderType;
  contentType: string;
  size: number;
};

function toAudioObjectUri(provider: StorageProviderType, key: string) {
  return `object://${provider}/${encodeURIComponent(key)}`;
}

async function persistGeneratedAudio(
  audioUrl: string,
  taskId: string,
  userId: string,
): Promise<PersistedAudio> {
  let buffer: Buffer;
  let declaredContentType: string;
  const dataMatch = /^data:([^;,]+);base64,([A-Za-z0-9+/=\s]+)$/u.exec(audioUrl);
  if (dataMatch) {
    declaredContentType = dataMatch[1].toLowerCase();
    buffer = Buffer.from(dataMatch[2].replace(/\s/gu, ''), 'base64');
  } else {
    const downloaded = await safeFetch(audioUrl, {
      maxBytes: 100 * 1024 * 1024,
      timeoutMs: 30_000,
      maxRedirects: 3,
    });
    declaredContentType = downloaded.contentType;
    buffer = downloaded.buffer;
  }
  // Some voice adapters use legacy MIME aliases. Normalize the declaration,
  // then retain the shared binary signature/active-content validation.
  const mimeType = declaredContentType.split(';', 1)[0].trim().toLowerCase();
  const canonicalContentType = mimeType === 'audio/mp3' ? 'audio/mpeg'
    : mimeType === 'audio/x-wav' ? 'audio/wav' : mimeType;
  const validated = validateUploadBuffer(buffer, canonicalContentType);
  if (!validated.contentType.startsWith('audio/')) {
    throw new Error(`VOICE_RESULT_CONTENT_FORBIDDEN:${validated.contentType}`);
  }
  const fileName = safeUploadFileName(validated.extension);
  const duration = await probeGeneratedAudioDuration(buffer, validated.extension);
  const stored = await storageManager.upload(buffer, fileName, validated.contentType, {
    category: 'audio',
    prefix: 'audio/generated/',
    fileName,
    userId,
    source: 'voice-generation',
    requireOwnershipRecord: true,
    meta: { taskId, duration: String(duration) },
  });
  const signedUrl = await storageManager.getSignedUrl(
    stored.key,
    {
      expireTime: 3600,
      responseFileName: fileName,
      responseContentType: stored.contentType,
    },
    stored.provider,
  );
  const ownedAsset = (await storageManager.listUserFiles(userId, {
    category: 'audio',
    limit: 100,
    offset: 0,
  })).find((item) => item.storage_key === stored.key);
  if (!ownedAsset?.id) throw new Error('VOICE_ASSET_RECORD_MISSING');
  return {
    duration,
    assetId: ownedAsset.id,
    signedUrl,
    objectUri: toAudioObjectUri(stored.provider, stored.key),
    storageKey: stored.key,
    storageProvider: stored.provider,
    contentType: stored.contentType,
    size: stored.size,
  };
}

const CLIENT_REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u;

type VoiceBillingPhase = 'seed-audio' | 'mix' | 'dual' | 'tts';
type VoiceCostBreakdown = NonNullable<ReturnType<typeof calculateVoiceCost>>;

type VoiceBillingOperation = {
  clientRequestId: string;
  phase: VoiceBillingPhase;
  modelId: string;
  creditsPerYuan: number;
  payloadFingerprint: string;
  costBreakdown?: VoiceCostBreakdown | null;
  providerCandidates?: string[];
  historySnapshot: Record<string, unknown>;
};

type VoiceLifecycleContext = {
  requestId: string;
  userId: string;
  clientRequestId: string;
  phase: VoiceBillingPhase;
  modelId: string;
  payloadFingerprint: string;
  quotedCredits: number;
  chargeCredits: number;
  refundedCredits: number;
  billingExempt: boolean;
  userRole: AuthUser['role'];
  costPriceRmb: number;
  creditsPerYuan: number;
};

type VoiceLifecycleClaim = {
  success: boolean;
  remaining: number;
  error?: string;
  code?: string;
  status?: number;
  alreadyFulfilled?: boolean;
  response?: Record<string, unknown> | null;
  lifecycle?: VoiceLifecycleContext;
};

function resolveClientRequestId(
  request: Request,
  body: Record<string, any>,
): { clientRequestId?: string; errorResponse?: NextResponse } {
  const headerValue = request.headers.get('Idempotency-Key')?.trim() || '';
  const bodyValue = typeof body.client_request_id === 'string' ? body.client_request_id.trim() : '';
  if (headerValue && bodyValue && headerValue !== bodyValue) {
    return {
      errorResponse: NextResponse.json({
        success: false,
        code: 'CLIENT_REQUEST_ID_MISMATCH',
        message: 'Idempotency-Key 与 client_request_id 不一致，本次未调用上游、未扣费。',
      }, { status: 409 }),
    };
  }
  const clientRequestId = headerValue || bodyValue;
  if (!clientRequestId) {
    return {
      errorResponse: NextResponse.json({
        success: false,
        code: 'CLIENT_REQUEST_ID_REQUIRED',
        message: '缺少稳定的 client_request_id，本次未调用上游、未扣费。',
      }, { status: 400 }),
    };
  }
  if (!CLIENT_REQUEST_ID_PATTERN.test(clientRequestId)) {
    return {
      errorResponse: NextResponse.json({
        success: false,
        code: 'CLIENT_REQUEST_ID_INVALID',
        message: 'client_request_id 格式无效，本次未调用上游、未扣费。',
      }, { status: 400 }),
    };
  }
  return { clientRequestId };
}

function buildVoiceTraceId(clientRequestId: string, phase: VoiceBillingPhase): string {
  const digest = createHash('sha256').update(clientRequestId).digest('hex').slice(0, 32);
  return `voice_${phase.replace(/-/gu, '_')}_${digest}`;
}

function canonicalizeVoicePayload(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeVoicePayload);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => key !== 'client_request_id')
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalizeVoicePayload(nested)]),
    );
  }
  if (typeof value === 'number' && !Number.isFinite(value)) return String(value);
  return value;
}

function buildVoicePayloadFingerprint(
  phase: VoiceBillingPhase,
  modelId: string,
  body: Record<string, any>,
): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalizeVoicePayload({ phase, modelId, body })))
    .digest('hex');
}

function voiceLifecycleErrorResponse(error: unknown, fallbackMessage?: string): NextResponse {
  const lifecycleError = error instanceof VoiceGenerationLifecycleError
    ? error
    : new VoiceGenerationLifecycleError(
      'VOICE_LIFECYCLE_UNAVAILABLE',
      fallbackMessage || '语音任务服务暂时不可用，已停止生成以避免重复扣费',
      503,
    );
  return NextResponse.json({
    success: false,
    code: lifecycleError.code,
    message: lifecycleError.message,
    data: {
      terminalStatus: 'blocked',
      upstreamSubmitted: false,
      creditsChargedThisAttempt: 0,
    },
  }, { status: lifecycleError.status });
}

function replayCompletedVoiceResponse(
  response: Record<string, unknown> | null | undefined,
  lifecycle: VoiceLifecycleContext,
): NextResponse {
  if (!response || response.success !== true) {
    return NextResponse.json({
      success: false,
      code: 'VOICE_LIFECYCLE_REPLAY_INVALID',
      message: '原语音任务已完成，但持久化响应不可用；已禁止重复调用上游。',
      data: {
        requestId: lifecycle.requestId,
        clientRequestId: lifecycle.clientRequestId,
        phase: lifecycle.phase,
        upstreamSubmitted: false,
        creditsChargedThisAttempt: 0,
      },
    }, { status: 503 });
  }
  const originalData = response.data && typeof response.data === 'object' && !Array.isArray(response.data)
    ? response.data as Record<string, unknown>
    : {};
  return NextResponse.json({
    ...response,
    replayed: true,
    data: {
      ...originalData,
      requestId: lifecycle.requestId,
      clientRequestId: lifecycle.clientRequestId,
      lifecycleState: 'completed',
      replayed: true,
      upstreamSubmitted: false,
      creditsChargedThisAttempt: 0,
    },
  });
}

async function ensureVoiceRevenue(
  lifecycle: VoiceLifecycleContext,
  response: Record<string, unknown> | null | undefined,
) {
  const responseData = response?.data && typeof response.data === 'object' && !Array.isArray(response.data)
    ? response.data as Record<string, unknown>
    : {};
  const billing = responseData.billing && typeof responseData.billing === 'object' && !Array.isArray(responseData.billing)
    ? responseData.billing as Record<string, unknown>
    : {};
  const responseCost = Number(billing.costPriceRmb);
  const netCredits = Math.max(0, lifecycle.chargeCredits - lifecycle.refundedCredits);
  const sellingPrice = lifecycle.creditsPerYuan > 0 ? netCredits / lifecycle.creditsPerYuan : 0;
  try {
    await recordRevenue({
      userId: lifecycle.userId,
      userRole: lifecycle.userRole === 'admin' ? 'admin' : 'student',
      modelId: `voice:${lifecycle.modelId}`,
      taskId: lifecycle.requestId,
      costPrice: Number.isFinite(responseCost) && responseCost >= 0 ? responseCost : lifecycle.costPriceRmb,
      sellingPrice,
      recordType: 'voice',
      creditsCharged: netCredits,
    });
  } catch {
    throw new VoiceGenerationLifecycleError(
      'VOICE_REVENUE_PENDING',
      '语音资产与钱包终态已确认，但收益流水尚未确认；请重试原请求，系统不会重复扣费',
      503,
    );
  }
}

// ─── 原子任务 + 主站钱包计费 ───
async function deductCredits(
  userId: string,
  quotedAmount: number,
  operation: VoiceBillingOperation,
  userRole: AuthUser['role'],
): Promise<VoiceLifecycleClaim> {
  try {
    const breakdown = operation.costBreakdown;
    const requestId = buildVoiceTraceId(operation.clientRequestId, operation.phase);
    const effectiveExemption = quotedAmount <= 0;
    const chargeCredits = effectiveExemption ? 0 : quotedAmount;
    const result = await beginVoiceGenerationAtomic({
      requestId,
      userId,
      clientRequestId: operation.clientRequestId,
      phase: operation.phase,
      payloadFingerprint: operation.payloadFingerprint,
      modelId: operation.modelId,
      billingIdempotencyKey: `voice:${operation.clientRequestId}:${operation.phase}:charge`,
      quotedCredits: quotedAmount,
      chargeCredits,
      billingExempt: effectiveExemption,
      priceSnapshot: breakdown ? {
        creditsToCharge: breakdown.creditsToCharge,
        costPriceRmb: breakdown.costPriceRmb,
        sellPriceRmb: breakdown.sellPriceRmb,
        profitRmb: breakdown.profitRmb,
        profitMargin: breakdown.pricing.profitMargin,
        creditsPerYuan: operation.creditsPerYuan,
      } : {},
      metadata: {
        route: '/api/voice/tts',
        client_request_id: operation.clientRequestId,
        billing_phase: operation.phase,
        provider_candidates: operation.providerCandidates || [],
        history_snapshot: operation.historySnapshot,
      },
    });
    const walletBalance = Number(result.wallet?.balance_after);
    const lifecycle: VoiceLifecycleContext = {
      requestId: result.record.requestId,
      userId,
      clientRequestId: operation.clientRequestId,
      phase: operation.phase,
      modelId: operation.modelId,
      payloadFingerprint: operation.payloadFingerprint,
      quotedCredits: result.record.quotedCredits,
      chargeCredits: result.record.chargeCredits,
      refundedCredits: result.record.refundedCredits,
      billingExempt: result.record.billingExempt,
      userRole,
      costPriceRmb: Number(result.record.priceSnapshot.costPriceRmb || breakdown?.costPriceRmb || 0),
      creditsPerYuan: Number(result.record.priceSnapshot.creditsPerYuan || operation.creditsPerYuan || 0),
    };
    if (result.alreadyFulfilled && result.record.state === 'completed') {
      await ensureVoiceRevenue(lifecycle, result.response);
    }
    return {
      success: result.success,
      remaining: Number.isFinite(walletBalance) ? walletBalance : 0,
      error: result.success ? undefined : '该语音任务正在处理或终态未知，已禁止重复调用上游。',
      code: result.code || undefined,
      status: result.success ? 200 : 409,
      alreadyFulfilled: result.alreadyFulfilled,
      response: result.response,
      lifecycle,
    };
  } catch (error) {
    console.error('[voice-tts] 原子任务占位或扣费失败:', error);
    const lifecycleError = error instanceof VoiceGenerationLifecycleError
      ? error
      : new VoiceGenerationLifecycleError(
        'VOICE_LIFECYCLE_UNAVAILABLE',
        '语音任务服务暂时不可用，已停止生成以避免重复扣费',
        503,
      );
    return {
      success: false,
      remaining: 0,
      error: lifecycleError.message,
      code: lifecycleError.code,
      status: lifecycleError.status,
    };
  }
}

async function refundCredits(
  lifecycle: VoiceLifecycleContext,
  amount: number,
  scope: string,
  reason: string,
  error: Record<string, unknown>,
  terminal = true,
): Promise<VoiceGenerationRecord> {
  try {
    const result = await refundVoiceGenerationAtomic({
      requestId: lifecycle.requestId,
      userId: lifecycle.userId,
      payloadFingerprint: lifecycle.payloadFingerprint,
      refundCredits: amount,
      refundScope: scope,
      refundIdempotencyKey: `voice:${lifecycle.clientRequestId}:${lifecycle.phase}:${scope}:refund`,
      reason,
      error,
      terminal,
    });
    lifecycle.refundedCredits = result.record.refundedCredits;
    return result.record;
  } catch (errorValue) {
    console.error('[voice-tts] 原子退款失败:', errorValue);
    if (errorValue instanceof VoiceGenerationLifecycleError) throw errorValue;
    throw new VoiceGenerationLifecycleError(
      'VOICE_REFUND_FAILED',
      '扣费退回失败，请保留语音任务标识联系客服',
      503,
    );
  }
}

async function finalizeVoiceLifecycle(
  lifecycle: VoiceLifecycleContext,
  assetId: string,
  generationId: string,
  providerTaskId: string,
  response: Record<string, unknown>,
  metadata: Record<string, unknown> = {},
) {
  const result = await finalizeVoiceGenerationAtomic({
    requestId: lifecycle.requestId,
    userId: lifecycle.userId,
    payloadFingerprint: lifecycle.payloadFingerprint,
    assetId,
    generationId,
    providerTaskId,
    response,
    metadata,
  });
  await ensureVoiceRevenue(lifecycle, result.response);
  return result.response;
}

function voiceClaimFailureResponse(
  claim: VoiceLifecycleClaim,
  insufficientMessage?: string,
): NextResponse {
  const message = claim.code === 'INSUFFICIENT_CREDITS' && insufficientMessage
    ? insufficientMessage
    : claim.error || '语音任务未能安全进入原子执行状态';
  return NextResponse.json({
    success: false,
    code: claim.code || 'VOICE_LIFECYCLE_UNAVAILABLE',
    message,
    data: {
      terminalStatus: claim.status === 409 ? 'in_progress_or_unknown' : 'blocked',
      upstreamSubmitted: false,
      creditsChargedThisAttempt: 0,
      remainingCredits: claim.remaining,
    },
  }, { status: claim.status || 503 });
}

async function isVolcanoConfigured(): Promise<boolean> {
  try {
    const { getActiveApiKey } = await import('@/lib/vs/volcengine');
    const apiKey = await getActiveApiKey();
    return Boolean(apiKey && String(apiKey).trim());
  } catch (error) {
    console.error('[voice-tts] 火山引擎本地配置检查失败:', error);
    return false;
  }
}

function volcanoUnavailableResponse(): NextResponse {
  return NextResponse.json({
    success: false,
    code: 'VOICE_PROVIDER_UNAVAILABLE',
    message: '火山引擎未配置 API Key，当前不可用；本次未调用上游、未扣费。',
    data: {
      provider: 'volcano',
      available: false,
      canSubmit: false,
      upstreamSubmitted: false,
      creditsCharged: 0,
    },
  }, { status: 503 });
}

type VoiceBillingQuoteResult = {
  costBreakdown: VoiceCostBreakdown;
  creditsPerYuan: number;
} | {
  errorResponse: NextResponse;
};

async function resolveVoiceBillingQuote(
  charCount: number,
  modelId: string,
  durationSeconds?: number,
  frozenCreditsPerYuan?: number,
): Promise<VoiceBillingQuoteResult> {
  try {
    // creditsPerYuan is only the shared recharge conversion. The model's
    // configured cost and profit margin still determine the selling price.
    const creditsPerYuan = frozenCreditsPerYuan ?? (await getBillingConfig()).creditsPerYuan;
    if (!Number.isFinite(creditsPerYuan) || creditsPerYuan <= 0) {
      throw new Error('credits_per_yuan is invalid');
    }
    const costBreakdown = calculateVoiceCost(charCount, modelId, creditsPerYuan, durationSeconds);
    if (!costBreakdown
      || !Number.isFinite(costBreakdown.costPriceRmb)
      || costBreakdown.costPriceRmb < 0
      || !Number.isFinite(costBreakdown.sellPriceRmb)
      || costBreakdown.sellPriceRmb <= 0
      || !Number.isFinite(costBreakdown.creditsToCharge)
      || costBreakdown.creditsToCharge <= 0) {
      throw new Error(`active pricing is missing for ${modelId}`);
    }
    return { costBreakdown, creditsPerYuan };
  } catch (error) {
    console.error('[voice-tts] 语音模型计价不可用:', error);
    return {
      errorResponse: NextResponse.json({
        success: false,
        code: 'VOICE_PRICE_NOT_CONFIGURED',
        message: '当前语音模型未配置有效成本价和利润率，本次未调用上游、未扣费。',
        data: {
          modelId,
          upstreamSubmitted: false,
          creditsCharged: 0,
        },
      }, { status: 503 }),
    };
  }
}

type FrozenVolcanoVoiceTarget = {
  providerModelId: string;
  providerResourceId: string;
  billingModelId: string;
};

function resolvePublishedVoiceModelId(providerModelId: string): string {
  const normalized = String(providerModelId || '').trim();
  if (/^seed-tts-2\.0(?:-|$)/u.test(normalized)) return 'seed-tts-2.0';
  if (/^seed-icl-2\.0(?:-|$)/u.test(normalized)) return 'seed-icl-2.0';
  return normalized;
}

type PreparedSeedAudioReference = { speaker?: string; audioData?: string };

async function isAuthorizedSpeaker(
  userId: string,
  speakerId: string,
  supabase: any,
): Promise<boolean> {
  const resolved = await resolveAuthorizedVoiceSpeaker({
    userId,
    speakerId,
    publicCatalog: readVoiceCatalog(true).map((voice) => ({ speakerId: voice.speakerId, isActive: voice.isActive === true })),
    findCompletedOwnedSpeaker: async (ownerId, providerSpeakerId) => {
      const owned = await supabase
        .from('voice_training_authorization_jobs')
        .select('id')
        .eq('user_id', ownerId)
        .eq('provider_speaker_id', providerSpeakerId)
        .eq('status', 'completed')
        .limit(1);
      return !owned.error && Array.isArray(owned.data) && owned.data.length > 0;
    },
  });
  return resolved === speakerId;
}

async function rejectUnauthorizedSpeakers(
  user: AuthUser,
  supabase: any,
  body: Record<string, any>,
): Promise<NextResponse | null> {
  const requestedVoiceId = typeof body.voiceId === 'string' ? body.voiceId.trim() : '';
  const voiceIdSpeaker = requestedVoiceId
    ? readVoiceCatalog(true).find((voice) => voice.id === requestedVoiceId || voice.adminId === requestedVoiceId)?.speakerId
      || getAllVoices().find((voice) => voice.id === requestedVoiceId)?.speakerId
      || ''
    : '';
  const selected = [
    voiceIdSpeaker,
    body.speaker,
    body.speakerId,
    body.speaker2,
    ...(Array.isArray(body.mixSpeakers) ? body.mixSpeakers.map((value: any) => value?.speaker) : []),
    ...(Array.isArray(body.references) ? body.references.map((value: any) => value?.speaker) : []),
  ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .map((value) => value.trim());
  for (const speakerId of new Set(selected)) {
    if (!await isAuthorizedSpeaker(user.id, speakerId, supabase)) {
      return NextResponse.json({
        success: false,
        code: 'VOICE_SPEAKER_FORBIDDEN',
        message: '所选音色不存在、已下架或不属于当前账号，本次未调用上游、未扣费。',
        data: { upstreamSubmitted: false, creditsCharged: 0 },
      }, { status: 403 });
    }
  }
  return null;
}

async function prepareSeedAudioReferences(
  userId: string,
  body: Record<string, any>,
): Promise<PreparedSeedAudioReference[]> {
  const provided = Array.isArray(body.references)
    ? body.references
    : [
      ...(body.speaker ? [{ speaker: body.speaker }] : []),
      ...(body.assetId ? [{ assetId: body.assetId }] : []),
      ...(body.audioData ? [{ audioData: body.audioData }] : []),
      ...(body.audioUrl ? [{ audioUrl: body.audioUrl }] : []),
    ];
  if (provided.length > MAX_SEED_AUDIO_REFERENCES) {
    throw new Error(`最多支持 ${MAX_SEED_AUDIO_REFERENCES} 条参考音频`);
  }

  const prepared: PreparedSeedAudioReference[] = [];
  for (const candidate of provided) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      throw new Error('参考音频参数无效');
    }
    const speaker = typeof candidate.speaker === 'string' ? candidate.speaker.trim() : '';
    const assetId = typeof candidate.assetId === 'string' ? candidate.assetId.trim() : '';
    const audioDataValue = typeof candidate.audioData === 'string' ? candidate.audioData.trim() : '';
    const audioUrl = typeof candidate.audioUrl === 'string' ? candidate.audioUrl.trim() : '';
    const supplied = [speaker, assetId, audioDataValue, audioUrl].filter(Boolean);
    if (supplied.length !== 1) throw new Error('每条参考音频必须且只能指定一种来源');

    if (speaker) {
      if (!/^[A-Za-z0-9_.:-]{1,160}$/u.test(speaker)) throw new Error('参考音色标识无效');
      prepared.push({ speaker });
      continue;
    }
    if (audioUrl) {
      // Signed object URLs can expire between quote and paid submission and
      // arbitrary remote URLs create an SSRF boundary. Clients must submit the
      // stable owned asset id returned by /api/voice/upload.
      throw new Error('参考音频链接不再直接接收，请重新选择已保存音频');
    }

    if (assetId) {
      if (!/^custom_[0-9a-f-]{36}$/iu.test(assetId)) throw new Error('参考音频资产标识无效');
      let owned;
      try {
        owned = await readOwnedCustomVoiceAudio(userId, assetId);
      } catch {
        throw new Error('参考音频不存在、已过期或不属于当前账号');
      }
      prepared.push({
        audioData: owned.bytes.toString('base64'),
      });
      continue;
    }

    if (audioDataValue) {
      throw new Error('参考音频必须先上传并选择当前账号的已保存音频');
    }
  }
  return prepared;
}

function freezeVolcanoVoiceTarget(
  speakerId: string,
  requestedModel?: string,
  requestedResourceId?: string,
): FrozenVolcanoVoiceTarget {
  const providerModelId = String(!requestedModel || requestedModel === 'auto' ? getDefaultModelBySpeaker(speakerId) : requestedModel).trim();
  const billingModelId = resolvePublishedVoiceModelId(providerModelId);
  const providerResourceId = String(requestedResourceId
    || (billingModelId === 'seed-icl-2.0' ? 'seed-icl-2.0' : 'seed-tts-2.0')).trim();
  return { providerModelId, providerResourceId, billingModelId };
}

// ─── Seed-Audio-1.0 音频生成处理 ───
async function handleSeedAudio(
  user: AuthUser,
  supabase: any,
  body: Record<string, any>,
  clientRequestId: string,
): Promise<Response> {
  const { textPrompt, format, sampleRate, pitchRate, speechRate, loudnessRate } = body;

  // 1. 校验
  if (!textPrompt || textPrompt.trim().length === 0) {
    return NextResponse.json({ success: false, message: '提示词不能为空' }, { status: 400 });
  }
  if (textPrompt.length > 3000) {
    return NextResponse.json({ success: false, message: '提示词长度不能超过3000字符' }, { status: 400 });
  }
  let preparedReferences: PreparedSeedAudioReference[];
  try {
    preparedReferences = await prepareSeedAudioReferences(user.id, body);
  } catch (error) {
    return NextResponse.json({
      success: false,
      code: 'VOICE_REFERENCE_INVALID',
      message: error instanceof Error ? error.message : '参考音频参数无效',
      data: { upstreamSubmitted: false, creditsCharged: 0 },
    }, { status: 400 });
  }
  if (!(await isVolcanoConfigured())) return volcanoUnavailableResponse();

  const charCount = textPrompt.length;
  const modelId = 'seed-audio-1.0';
  const taskId = buildVoiceTraceId(clientRequestId, 'seed-audio');
  const payloadFingerprint = buildVoicePayloadFingerprint('seed-audio', modelId, body);

  // 2. 计算费用（按分钟计价：seed-audio-1.0 的 unit = '分钟'）
  const billingQuote = await resolveVoiceBillingQuote(1, modelId, 120);
  if ('errorResponse' in billingQuote) return billingQuote.errorResponse;
  const { costBreakdown, creditsPerYuan } = billingQuote;
  const creditsToCharge = costBreakdown.creditsToCharge;
  let costPrice = costBreakdown.costPriceRmb;
  let retailPrice = creditsToCharge / creditsPerYuan;

  if (body.operation === 'quote') return voiceQuoteResponse(user, modelId, charCount, costBreakdown, creditsPerYuan, 120);

  // 3. 原子建立任务并按主站钱包协议扣费；角色不改变价格。
  const deductResult = await deductCredits(user.id, creditsToCharge, {
    clientRequestId,
    phase: 'seed-audio',
    modelId,
    creditsPerYuan,
    payloadFingerprint,
    costBreakdown,
    historySnapshot: createVoiceHistorySnapshot({
      voiceModelName: '音频生成 1.0',
      inputText: textPrompt,
      textLength: charCount,
      outputFormat: format || 'mp3',
      speedRatio: 1,
      emotion: 'neutral',
      engine: 'volcano',
    }),
  }, user.role);
  if (!deductResult.success) {
    return voiceClaimFailureResponse(
      deductResult,
      `积分不足，本次需要${creditsToCharge}积分（最长120秒预留，完成后按实际时长结算），当前余额${deductResult.remaining}积分，请充值`,
    );
  }
  const lifecycle = deductResult.lifecycle!;
  if (deductResult.alreadyFulfilled) {
    return replayCompletedVoiceResponse(deductResult.response, lifecycle);
  }
  let deducted = lifecycle.chargeCredits > 0;

  // 4. 调用 Seed-Audio-1.0 生成
  let audioResult: { audioUrl: string; duration: number; originalDuration: number; subtitles?: any[] } | null = null;
  let persistedAudio: PersistedAudio | null = null;
  let errorMsg = '';

  try {
    const { generateAudio } = await import('@/lib/vs/volcengine');

    audioResult = await generateAudio({
      textPrompt,
      references: preparedReferences.length > 0 ? preparedReferences : undefined,
      format: format || 'mp3',
      sampleRate: sampleRate || 48000,
      pitchRate: pitchRate || 0,
      speechRate: speechRate || 0,
      loudnessRate: loudnessRate || 0,
    });
  } catch (e: any) {
    errorMsg = e.message || '音频生成失败';
  }

  if (audioResult) {
    try {
      persistedAudio = await persistGeneratedAudio(audioResult.audioUrl, taskId, user.id);
      audioResult.audioUrl = persistedAudio.signedUrl;
      audioResult.duration = persistedAudio.duration;
      audioResult.originalDuration = audioResult.originalDuration || persistedAudio.duration;
    } catch (e: any) {
      errorMsg = `音频结果入库失败: ${e.message || 'unknown error'}`;
      audioResult = null;
    }
  }

  if(!audioResult) {
    console.error('[voice-imitation] generation failed', {taskId, error: errorMsg.slice(0,500)});
    errorMsg = /MultilingualAUCRecognizeFailed|clone speaker register|invalid.*audio|audio.*invalid/i.test(errorMsg) ? '参考音频未能识别，请换一段清晰的人声录音后重试。本次未扣费。' : /401|403|unauthoriz|not granted/i.test(errorMsg) ? '语音服务授权暂不可用，请联系管理员。本次未扣费。' : '音色模仿暂未完成，请稍后重试。本次未扣费。';
  }
  // 5. 生成或资产持久化失败：原子写失败终态并退回本任务全部实扣。
  if (!audioResult) {
    try {
      await refundCredits(
        lifecycle,
        lifecycle.chargeCredits - lifecycle.refundedCredits,
        'terminal',
        'Seed Audio 生成失败退款',
        { code: 'VOICE_GENERATION_FAILED', message: errorMsg },
      );
    } catch (refundError) {
      return voiceLifecycleErrorResponse(refundError);
    }
    deducted = false;
  }
  let actualCreditsCharged = deducted ? lifecycle.chargeCredits-lifecycle.refundedCredits : 0;
  if (audioResult) {
    const seconds=Math.min(120,Math.max(1,Number(audioResult.duration)||0));
    const actualRmb=Math.max(0.01,Math.round(costBreakdown.pricing.costPrice*(1+costBreakdown.pricing.profitMargin/100)*seconds/60*100)/100);
    const actualCredits=Math.min(creditsToCharge,Math.ceil(actualRmb*creditsPerYuan));
    costPrice=roundVoiceAccounting(costBreakdown.pricing.costPrice*seconds/60);retailPrice=actualCredits/creditsPerYuan;
    if (deducted && lifecycle.chargeCredits-lifecycle.refundedCredits>actualCredits) {
      try {await refundCredits(lifecycle,lifecycle.chargeCredits-lifecycle.refundedCredits-actualCredits,'duration_settlement','音色模仿按实际时长结算退回差额',{code:'VOICE_DURATION_SETTLED',durationSeconds:seconds},false);}
      catch(error){return voiceLifecycleErrorResponse(error);}
    }
    actualCreditsCharged=deducted ? lifecycle.chargeCredits-lifecycle.refundedCredits : 0;
  }

  // 6. voice_generation_requests 是账号历史事实源；不再依赖单机 generations.json。
  const generationId = lifecycle.requestId;

  if (!audioResult || !persistedAudio) {
    return NextResponse.json({
      success: false,
      code: 'VOICE_GENERATION_FAILED',
      message: errorMsg,
      data: {
        requestId: lifecycle.requestId,
        terminalStatus: 'refunded',
        persisted: false,
        upstreamSubmitted: true,
        creditsCharged: 0,
      },
    }, { status: 502 });
  }

  const responsePayload: Record<string, unknown> = {
    success: true,
    message: '音频生成成功',
    data: {
      requestId: lifecycle.requestId,
      clientRequestId,
      lifecycleState: 'completed',
      terminalStatus: 'completed',
      persisted: true,
      generationId,
      providerTaskId: taskId,
      audioUrl: audioResult.audioUrl,
      duration: audioResult.duration,
      originalDuration: audioResult.originalDuration,
      subtitles: audioResult.subtitles,
      cost: actualCreditsCharged,
      quotedCredits: creditsToCharge,
      costPrice,
      retailPrice,
      asset: {
        id: persistedAudio.assetId,
        storageKey: persistedAudio.storageKey,
        storageProvider: persistedAudio.storageProvider,
        contentType: persistedAudio.contentType,
        size: persistedAudio.size,
      },
      billing: {
        charCount,
        modelId,
        modelName: costBreakdown.pricing.name,
        unit: costBreakdown.pricing.unit,
        sellPriceRmb: retailPrice,
        costPriceRmb: costPrice,
        profitRmb: roundVoiceAccounting(retailPrice-costPrice),
        creditsCharged: actualCreditsCharged,
        profitMargin: costBreakdown.pricing.profitMargin,
      },
    },
  };
  let finalizedResponse: Record<string, unknown>;
  try {
    finalizedResponse = await finalizeVoiceLifecycle(
      lifecycle,
      persistedAudio.assetId,
      generationId,
      taskId,
      responsePayload,
      { route: '/api/voice/tts', mode: 'seed-audio' },
    );
  } catch (finalizeError) {
    if (finalizeError instanceof VoiceGenerationLifecycleError && finalizeError.code === 'VOICE_REVENUE_PENDING') {
      return voiceLifecycleErrorResponse(finalizeError);
    }
    try {
      await refundCredits(
        lifecycle,
        lifecycle.chargeCredits - lifecycle.refundedCredits,
        'terminal',
        'Seed Audio 成功终态保存失败退款',
        {
          code: 'VOICE_LIFECYCLE_FINALIZE_FAILED',
          message: finalizeError instanceof Error ? finalizeError.message : 'unknown error',
        },
      );
    } catch (refundError) {
      return voiceLifecycleErrorResponse(refundError);
    }
    return voiceLifecycleErrorResponse(finalizeError);
  }

  // 7. 写入计费记录
  if (deducted && costBreakdown) {
    try {
      const balanceBefore = user.credits;
      const { data: userAfter } = await supabase
        .from('users')
        .select('credits')
        .eq('id', user.id)
        .single();
      const balanceAfter = userAfter ? Number(userAfter.credits) : balanceBefore;

      await supabase.from('voice_billing_records').insert({
        user_id: user.id,
        model_id: modelId,
        model_name: costBreakdown.pricing.name,
        voice_type: 'audio_gen',
        total_char: charCount,
        text_char: charCount,
        instruction_char: 0,
        cost_per_10k: Math.round(costBreakdown.pricing.costPrice * 100) / 100,
        profit_rate: costBreakdown.pricing.profitMargin,
        real_cost: costPrice,
        charge_amount: actualCreditsCharged / creditsPerYuan,
        profit: roundVoiceAccounting(actualCreditsCharged / creditsPerYuan - costPrice),
        balance_before: balanceBefore,
        balance_after: balanceAfter,
        status: 'success',
        voice_id: preparedReferences.find((reference) => reference.speaker)?.speaker || null,
      });
    } catch (e) {
      console.error('[voice-tts] 音频生成计费记录写入失败:', e);
    }
  }

  return NextResponse.json(finalizedResponse);
}

// ─── 混音合成处理 ───
async function handleMixSynthesize(
  user: AuthUser,
  supabase: any,
  body: Record<string, any>,
  clientRequestId: string,
): Promise<Response> {
  const { text, mixSpeakers, format, sampleRate, speed, volume } = body;

  if (!text || text.trim().length === 0) {
    return NextResponse.json({ success: false, message: '文案内容不能为空' }, { status: 400 });
  }
  if (!Array.isArray(mixSpeakers) || mixSpeakers.length < 2 || mixSpeakers.length > 3) {
    return NextResponse.json({ success: false, message: '混音需要 2-3 个有效音色' }, { status: 400 });
  }
  if (!(await isVolcanoConfigured())) return volcanoUnavailableResponse();

  const charCount = text.length;
  const modelId = 'seed-tts-1.0'; // 混音仅 TTS 1.0 支持
  const payloadFingerprint = buildVoicePayloadFingerprint('mix', modelId, body);

  // 计费
  const billingQuote = await resolveVoiceBillingQuote(charCount, modelId);
  if ('errorResponse' in billingQuote) return billingQuote.errorResponse;
  const { costBreakdown, creditsPerYuan } = billingQuote;
  const creditsToCharge = costBreakdown.creditsToCharge;
  const costPrice = costBreakdown.costPriceRmb;
  const retailPrice = creditsToCharge / creditsPerYuan;

  const requestTraceId = buildVoiceTraceId(clientRequestId, 'mix');
  if (body.operation === 'quote') return voiceQuoteResponse(user, modelId, charCount, costBreakdown, creditsPerYuan);
  const deductResult = await deductCredits(user.id, creditsToCharge, {
    clientRequestId,
    phase: 'mix',
    modelId,
    creditsPerYuan,
    payloadFingerprint,
    costBreakdown,
    historySnapshot: createVoiceHistorySnapshot({
      voiceModelName: '混音合成',
      inputText: text,
      textLength: charCount,
      outputFormat: format || 'mp3',
      speedRatio: speed ?? 1,
      emotion: 'neutral',
      engine: 'volcano',
    }),
  }, user.role);
  if (!deductResult.success) {
    return voiceClaimFailureResponse(
      deductResult,
      `积分不足，本次需要${creditsToCharge}积分（${retailPrice}元），当前余额${deductResult.remaining}积分，请充值`,
    );
  }
  const lifecycle = deductResult.lifecycle!;
  if (deductResult.alreadyFulfilled) {
    return replayCompletedVoiceResponse(deductResult.response, lifecycle);
  }
  let deducted = lifecycle.chargeCredits > 0;

  // 调用混音合成
  let mixResult: { audioUrl: string; duration: number } | null = null;
  let persistedAudio: PersistedAudio | null = null;
  let errorMsg = '混音合成失败';
  try {
    const { synthesizeMixSpeech } = await import('@/lib/vs/volcengine');
    mixResult = await synthesizeMixSpeech({
      text,
      speakers: mixSpeakers.map((s: { speaker: string; factor: number }) => ({
        sourceSpeaker: s.speaker,
        mixFactor: s.factor,
      })),
      audioParams: {
        format: format || 'mp3',
        sample_rate: sampleRate || 24000,
        speech_rate: speed ?? 0,
        loudness_rate: volume ?? 0,
      },
    });
  } catch (e: any) {
    errorMsg = e.message || '混音合成引擎调用失败';
    console.error('[voice-tts] 混音合成失败:', e);
  }

  if (mixResult) {
    try {
      persistedAudio = await persistGeneratedAudio(mixResult.audioUrl, requestTraceId, user.id);
      mixResult.audioUrl = persistedAudio.signedUrl;
    } catch (error) {
      errorMsg = `混音结果入库失败: ${error instanceof Error ? error.message : 'unknown error'}`;
      mixResult = null;
    }
  }

  // 生成或入库失败都必须写入终态并退回本任务全部实扣。
  if (!mixResult || !persistedAudio) {
    try {
      await refundCredits(
        lifecycle,
        lifecycle.chargeCredits - lifecycle.refundedCredits,
        'terminal',
        '混音生成失败退款',
        { code: 'VOICE_RESULT_NOT_DELIVERABLE', message: errorMsg },
      );
    } catch (refundError) {
      return voiceLifecycleErrorResponse(refundError);
    }
    deducted = false;
    return NextResponse.json({
      success: false,
      code: 'VOICE_RESULT_NOT_DELIVERABLE',
      message: errorMsg,
      data: {
        requestId: lifecycle.requestId,
        terminalStatus: 'refunded',
        persisted: false,
        upstreamSubmitted: true,
        creditsCharged: 0,
      },
    }, { status: 502 });
  }

  const actualCreditsCharged = deducted ? creditsToCharge : 0;
  const generationId = lifecycle.requestId;

  const responsePayload: Record<string, unknown> = {
    success: true,
    message: '混音合成成功',
    data: {
      requestId: lifecycle.requestId,
      clientRequestId,
      lifecycleState: 'completed',
      terminalStatus: 'completed',
      persisted: true,
      requestTraceId,
      generationId,
      audioUrl: mixResult.audioUrl,
      duration: mixResult.duration,
      cost: actualCreditsCharged,
      quotedCredits: creditsToCharge,
      costPrice,
      retailPrice,
      asset: {
        id: persistedAudio.assetId,
        storageKey: persistedAudio.storageKey,
        storageProvider: persistedAudio.storageProvider,
        contentType: persistedAudio.contentType,
        size: persistedAudio.size,
      },
      billing: {
        charCount,
        modelId,
        modelName: costBreakdown.pricing.name,
        unit: costBreakdown.pricing.unit,
        sellPriceRmb: retailPrice,
        costPriceRmb: costBreakdown.costPriceRmb,
        profitRmb: roundVoiceAccounting(actualCreditsCharged / creditsPerYuan - costBreakdown.costPriceRmb),
        creditsCharged: actualCreditsCharged,
        profitMargin: costBreakdown.pricing.profitMargin,
      },
    },
  };
  let finalizedResponse: Record<string, unknown>;
  try {
    finalizedResponse = await finalizeVoiceLifecycle(
      lifecycle,
      persistedAudio.assetId,
      generationId,
      requestTraceId,
      responsePayload,
      { route: '/api/voice/tts', mode: 'mix' },
    );
  } catch (finalizeError) {
    if (finalizeError instanceof VoiceGenerationLifecycleError && finalizeError.code === 'VOICE_REVENUE_PENDING') {
      return voiceLifecycleErrorResponse(finalizeError);
    }
    try {
      await refundCredits(
        lifecycle,
        lifecycle.chargeCredits - lifecycle.refundedCredits,
        'terminal',
        '混音成功终态保存失败退款',
        {
          code: 'VOICE_LIFECYCLE_FINALIZE_FAILED',
          message: finalizeError instanceof Error ? finalizeError.message : 'unknown error',
        },
      );
    } catch (refundError) {
      return voiceLifecycleErrorResponse(refundError);
    }
    return voiceLifecycleErrorResponse(finalizeError);
  }

  // 仅在终态、资产和历史都成功后记录成功计费。
  if (deducted && costBreakdown) {
    try {
      const { data: userAfter } = await supabase.from('users').select('credits').eq('id', user.id).single();
      await supabase.from('voice_billing_records').insert({
        user_id: user.id,
        model_id: modelId,
        model_name: costBreakdown.pricing.name,
        voice_type: 'mix',
        total_char: charCount,
        text_char: charCount,
        instruction_char: 0,
        cost_per_10k: Math.round(costBreakdown.pricing.costPrice * 100) / 100,
        profit_rate: costBreakdown.pricing.profitMargin,
        real_cost: costBreakdown.costPriceRmb,
        charge_amount: actualCreditsCharged / creditsPerYuan,
        profit: roundVoiceAccounting(actualCreditsCharged / creditsPerYuan - costBreakdown.costPriceRmb),
        balance_before: user.credits,
        balance_after: userAfter ? Number(userAfter.credits) : user.credits,
        status: 'success',
        voice_id: 'custom_mix_bigtts',
      });
    } catch (e) {
      console.error('[voice-tts] 混音计费记录写入失败:', e);
    }
  }

  return NextResponse.json(finalizedResponse);
}

// ─── 双人对话合成 ───
async function handleDualTTS(
  user: AuthUser,
  supabase: any,
  body: Record<string, any>,
  clientRequestId: string,
): Promise<Response> {
  const {
    text, speaker, text2, speaker2,
    speechRate, loudnessRate, pitchRate,
    speed: bodySpeed, volume: bodyVolume, pitch: bodyPitch,
    emotion, format, sampleRate, model: modelVersion, resourceId,
    subtitle: bodySubtitle, enableSubtitle,
    emotionIntensity, silenceFinal, language, dialect,
    voiceInstruction, subtitleTimestamp, aigcTag,
    useCache, silenceSeg, latex, langDetect, filterMd, filterEmoji,
  } = body;

  // 统一参数名
  const finalSpeed = speechRate ?? bodySpeed;
  const finalVolume = loudnessRate ?? bodyVolume ?? 0;
  const finalPitch = pitchRate ?? bodyPitch ?? 0;
  const finalSubtitle = enableSubtitle ?? bodySubtitle ?? false;

  // 1. 校验
  if (!text?.trim() || !text2?.trim()) {
    return NextResponse.json({ success: false, message: '双人模式需要两个角色的文本' }, { status: 400 });
  }
  if (!speaker || !speaker2) {
    return NextResponse.json({ success: false, message: '双人模式需要两个角色的音色' }, { status: 400 });
  }
  if (!(await isVolcanoConfigured())) return volcanoUnavailableResponse();

  const totalCharCount = text.length + text2.length;
  const requestTraceId = buildVoiceTraceId(clientRequestId, 'dual');

  // 2. 调用前冻结两个角色各自的实际上游模型与公开计价模型。
  // 禁止在扣费后跨计价产品降级，避免“按 A 价格、由 B 模型交付”。
  const target1 = freezeVolcanoVoiceTarget(speaker, modelVersion, resourceId);
  const target2 = freezeVolcanoVoiceTarget(speaker2, modelVersion, resourceId);
  const quote1 = await resolveVoiceBillingQuote(text.length, target1.billingModelId);
  if ('errorResponse' in quote1) return quote1.errorResponse;
  const quote2 = await resolveVoiceBillingQuote(text2.length, target2.billingModelId, undefined, quote1.creditsPerYuan);
  if ('errorResponse' in quote2) return quote2.errorResponse;
  const creditsPerYuan = quote1.creditsPerYuan;
  const modelId = target1.billingModelId === target2.billingModelId
    ? target1.billingModelId
    : `dual:${target1.billingModelId}+${target2.billingModelId}`;
  const costBreakdown: VoiceCostBreakdown = {
    charCount: totalCharCount,
    pricing: {
      ...quote1.costBreakdown.pricing,
      id: `dual:${quote1.costBreakdown.pricing.id}+${quote2.costBreakdown.pricing.id}`,
      name: `${quote1.costBreakdown.pricing.name}+${quote2.costBreakdown.pricing.name}`,
      modelId,
    },
    sellPriceRmb: quote1.costBreakdown.sellPriceRmb + quote2.costBreakdown.sellPriceRmb,
    costPriceRmb: quote1.costBreakdown.costPriceRmb + quote2.costBreakdown.costPriceRmb,
    profitRmb: quote1.costBreakdown.profitRmb + quote2.costBreakdown.profitRmb,
    creditsToCharge: quote1.costBreakdown.creditsToCharge + quote2.costBreakdown.creditsToCharge,
  };
  let creditsToCharge = costBreakdown.creditsToCharge;
  let costPrice = costBreakdown.costPriceRmb;
  let retailPrice = creditsToCharge / creditsPerYuan;
  const payloadFingerprint = buildVoicePayloadFingerprint('dual', modelId, body);

  if (body.operation === 'quote') return voiceQuoteResponse(user, modelId, totalCharCount, costBreakdown, creditsPerYuan);

  // 3. 原子建立持久任务并按主站钱包规则扣费；角色不改变价格。
  const deductResult = await deductCredits(user.id, creditsToCharge, {
    clientRequestId,
    phase: 'dual',
    modelId,
    creditsPerYuan,
    payloadFingerprint,
    costBreakdown,
    providerCandidates: [target1.providerModelId, target2.providerModelId],
    historySnapshot: createVoiceHistorySnapshot({
      voiceModelName: `双人:${speaker}+${speaker2}`,
      inputText: `${text}\n---\n${text2}`,
      textLength: totalCharCount,
      outputFormat: format || 'mp3',
      speedRatio: finalSpeed ?? 1,
      emotion: emotion || 'neutral',
      engine: 'volcano',
    }),
  }, user.role);
  if (!deductResult.success || !deductResult.lifecycle) {
    return voiceClaimFailureResponse(
      deductResult,
      `积分不足，本次需要${creditsToCharge}积分（${retailPrice}元），当前余额${deductResult.remaining}积分，请充值`,
    );
  }
  const lifecycle = deductResult.lifecycle;
  if (deductResult.alreadyFulfilled) {
    return replayCompletedVoiceResponse(deductResult.response, lifecycle);
  }
  let deducted = lifecycle.chargeCredits > lifecycle.refundedCredits;

  // 4. 并行调用两次 TTS（API Key 已在扣费前检查）
  try {
    const { synthesizeSpeech, getActiveApiKey } = await import('@/lib/vs/volcengine');
    const apiKeyResult = await getActiveApiKey();
    if (!apiKeyResult) {
      try {
        await refundCredits(
          lifecycle,
          Math.max(0, lifecycle.chargeCredits - lifecycle.refundedCredits),
          'dual-provider-unavailable',
          '火山引擎 API Key 在任务占位后不可用',
          { code: 'VOICE_PROVIDER_UNAVAILABLE' },
        );
        deducted = false;
      } catch (refundError) {
        return voiceLifecycleErrorResponse(refundError);
      }
      return volcanoUnavailableResponse();
    }

    // 构建完整 audioParams（只发送非默认值）
    const audioParams: Record<string, any> = {
      format: format || 'mp3',
      sample_rate: sampleRate || 24000,
      speech_rate: finalSpeed ?? 0,
      loudness_rate: finalVolume ?? 0,
      enable_subtitle: finalSubtitle,
    };
    if (emotion && emotion !== 'none') audioParams.emotion = emotion;
    if (emotionIntensity && emotionIntensity > 0.5) {
      audioParams.emotion_scale = Math.min(5, Math.max(1, Math.round(emotionIntensity * 2.5)));
    }
    if (subtitleTimestamp) audioParams.enable_timestamp = true;

    // 构建完整 additions
    const additions: Record<string, any> = {};
    if (voiceInstruction) {
      additions.context_texts = Array.isArray(voiceInstruction) ? voiceInstruction : [voiceInstruction];
    }
    if (silenceFinal && silenceFinal > 0) additions.silence_duration = silenceFinal;
    if (language && language !== 'auto') additions.explicit_language = language;
    if (dialect && dialect !== 'mandarin' && dialect !== 'auto') additions.explicit_dialect = dialect;
    if (langDetect) additions.enable_language_detector = true;
    if (filterMd) additions.disable_markdown_filter = true;
    if (filterEmoji) additions.disable_emoji_filter = true;
    if (latex) additions.enable_latex_tn = true;
    if (useCache) additions.cache_config = { text_type: 1, use_cache: true };
    if (aigcTag) additions.aigc_watermark = true;
    if (silenceSeg) additions.mute_cut_threshold = '200';
    const finalAdditions = Object.keys(additions).length > 0 ? additions : undefined;

    // 翻标记
    let processedText1 = text;
    let processedText2 = text2;
    let processedEmotion = emotion;
    try {
      const t1 = translateForEngine(text, 'volcano');
      processedText1 = t1.text;
      if (t1.emotion) processedEmotion = t1.emotion;
      const t2 = translateForEngine(text2, 'volcano');
      processedText2 = t2.text;
    } catch {}

    const audioParamsWithEmotion = { ...audioParams, emotion: processedEmotion || undefined };
    // 仅调用扣费前冻结的模型。跨公开计价模型 fallback 明确禁用。
    const synthFrozen = async (params: {
      text: string; speaker: string; model: string; resourceId: string;
      audioParams: Record<string, any>; additions?: Record<string, any>; pitch: number;
    }) => {
      return synthesizeSpeech(params);
    };

    const [result1, result2] = await Promise.all([
      synthFrozen({
        text: processedText1, speaker, model: target1.providerModelId, resourceId: target1.providerResourceId,
        audioParams: audioParamsWithEmotion, additions: finalAdditions, pitch: finalPitch ?? 0,
      }).catch(e => ({ error: e.message || '角色一合成失败' })),
      synthFrozen({
        text: processedText2, speaker: speaker2, model: target2.providerModelId, resourceId: target2.providerResourceId,
        audioParams: audioParamsWithEmotion, additions: finalAdditions, pitch: finalPitch ?? 0,
      }).catch(e => ({ error: e.message || '角色二合成失败' })),
    ]);

    // 6. 检查结果
    const hasError1 = 'error' in result1;
    const hasError2 = 'error' in result2;
    if (hasError1 && hasError2) {
      try {
        await refundCredits(
          lifecycle,
          Math.max(0, lifecycle.chargeCredits - lifecycle.refundedCredits),
          'dual-generation-failed',
          '双人合成两路上游均失败',
          { role1: (result1 as any).error, role2: (result2 as any).error },
        );
        deducted = false;
      } catch (refundError) {
        return voiceLifecycleErrorResponse(refundError);
      }
      return NextResponse.json({
        success: false,
        code: 'VOICE_GENERATION_FAILED',
        message: `双人合成均失败：角色一${(result1 as any).error}，角色二${(result2 as any).error}`,
        data: {
          terminalStatus: 'refunded',
          requestId: lifecycle.requestId,
          clientRequestId,
          persisted: false,
          upstreamSubmitted: true,
          creditsCharged: 0,
        },
      }, { status: 502 });
    }

    // 部分成功 → 仅退还失败角色冻结报价，不按“一半”猜测。
    if (hasError1 || hasError2) {
      const failedQuote = hasError1 ? quote1.costBreakdown : quote2.costBreakdown;
      const failedRefundCredits = lifecycle.billingExempt ? 0 : failedQuote.creditsToCharge;
      try {
        await refundCredits(
          lifecycle,
          failedRefundCredits,
          hasError1 ? 'dual-role1' : 'dual-role2',
          hasError1 ? '双人合成角色一失败' : '双人合成角色二失败',
          { message: hasError1 ? (result1 as any).error : (result2 as any).error },
          false,
        );
      } catch (refundError) {
        return voiceLifecycleErrorResponse(refundError);
      }
      creditsToCharge = Math.max(0, creditsToCharge - failedQuote.creditsToCharge);
      costPrice = Math.max(0, costPrice - failedQuote.costPriceRmb);
      retailPrice = Math.max(0, retailPrice - failedQuote.creditsToCharge / creditsPerYuan);
      deducted = lifecycle.chargeCredits > lifecycle.refundedCredits;
    }

    // Decode each returned container and produce one complete playable audio file.
    const parts = [!hasError1 ? result1 : null, !hasError2 ? result2 : null]
      .filter((part): part is Awaited<ReturnType<typeof synthesizeSpeech>> => Boolean(part && 'audioUrl' in part));
    const joined = await joinVoiceAudio(parts, format || 'mp3', sampleRate || 24000);
    const combinedAudioUrl = joined.audioUrl;
    let combinedDuration = joined.duration;
    const combinedSubtitles = joined.subtitles;

    if (!combinedAudioUrl) {
      try {
        await refundCredits(
          lifecycle,
          Math.max(0, lifecycle.chargeCredits - lifecycle.refundedCredits),
          'dual-result-undeliverable',
          '双人合成未取得可入库音频',
          { code: 'VOICE_RESULT_NOT_DELIVERABLE' },
        );
        deducted = false;
      } catch (refundError) {
        return voiceLifecycleErrorResponse(refundError);
      }
      return NextResponse.json({
        success: false,
        code: 'VOICE_RESULT_NOT_DELIVERABLE',
        message: '双人合成未取得可入库音频，本次已按失败处理。',
        data: {
          terminalStatus: 'refunded',
          requestId: lifecycle.requestId,
          clientRequestId,
          persisted: false,
          upstreamSubmitted: true,
          creditsCharged: 0,
        },
      }, { status: 502 });
    }

    let persistedAudio: PersistedAudio;
    try {
      persistedAudio = await persistGeneratedAudio(combinedAudioUrl, requestTraceId, user.id);
    } catch (persistError) {
      try {
        await refundCredits(
          lifecycle,
          Math.max(0, lifecycle.chargeCredits - lifecycle.refundedCredits),
          'dual-persist-failed',
          '双人音频结果入库失败',
          { message: persistError instanceof Error ? persistError.message : 'unknown error' },
        );
        deducted = false;
      } catch (refundError) {
        return voiceLifecycleErrorResponse(refundError);
      }
      return NextResponse.json({
        success: false,
        code: 'VOICE_RESULT_NOT_DELIVERABLE',
        message: `双人音频结果入库失败: ${persistError instanceof Error ? persistError.message : 'unknown error'}`,
        data: {
          terminalStatus: 'refunded',
          requestId: lifecycle.requestId,
          clientRequestId,
          persisted: false,
          upstreamSubmitted: true,
          creditsCharged: 0,
        },
      }, { status: 500 });
    }

    combinedDuration = persistedAudio.duration;
    const actualCreditsCharged = Math.max(0, lifecycle.chargeCredits - lifecycle.refundedCredits);
    const generationId = lifecycle.requestId;

    const r1Final = !hasError1 ? result1 as { audioUrl: string; duration: number } : null;
    const r2Final = !hasError2 ? result2 as { audioUrl: string; duration: number } : null;
    const successResponse: Record<string, unknown> = {
      success: true,
      message: hasError1 || hasError2 ? '部分音频已生成，失败角色费用已退回' : '双人合成成功',
      data: {
        terminalStatus: 'completed',
        lifecycleState: 'completed',
        requestId: lifecycle.requestId,
        clientRequestId,
        persisted: true,
        requestTraceId,
        generationId,
        audioUrl: persistedAudio.signedUrl,
        duration: combinedDuration,
        subtitles: finalSubtitle && combinedSubtitles.length > 0 ? combinedSubtitles : undefined,
        duration1: r1Final ? joined.partDurations[0] : 0,
        duration2: r2Final ? joined.partDurations[hasError1 ? 0 : 1] : 0,
        partialSuccess: hasError1 || hasError2,
        warnings: hasError1 || hasError2 ? ['仅保留合成成功的角色音频，失败角色的费用已退回。'] : [],
        cost: actualCreditsCharged,
        costPrice,
        retailPrice,
        asset: {
          id: persistedAudio.assetId,
          storageKey: persistedAudio.storageKey,
          storageProvider: persistedAudio.storageProvider,
          contentType: persistedAudio.contentType,
          size: persistedAudio.size,
        },
        billing: {
          charCount: totalCharCount,
          modelId,
          modelName: costBreakdown.pricing.name,
          unit: costBreakdown.pricing.unit,
          quotedCredits: costBreakdown.creditsToCharge,
          sellPriceRmb: retailPrice,
          costPriceRmb: costPrice,
          profitRmb: roundVoiceAccounting(retailPrice - costPrice),
          creditsCharged: actualCreditsCharged,
          profitMargin: costBreakdown.pricing.profitMargin,
          roles: [
            { speaker, providerModelId: target1.providerModelId, billingModelId: target1.billingModelId, quotedCredits: quote1.costBreakdown.creditsToCharge, succeeded: !hasError1 },
            { speaker: speaker2, providerModelId: target2.providerModelId, billingModelId: target2.billingModelId, quotedCredits: quote2.costBreakdown.creditsToCharge, succeeded: !hasError2 },
          ],
        },
      },
    };

    let finalizedResponse: Record<string, unknown>;
    try {
      finalizedResponse = await finalizeVoiceLifecycle(
        lifecycle,
        persistedAudio.assetId,
        generationId,
        requestTraceId,
        successResponse,
        {
          provider: 'volcano',
          provider_models: [target1.providerModelId, target2.providerModelId],
          partial_success: hasError1 || hasError2,
        },
      );
    } catch (finalizeError) {
      if (finalizeError instanceof VoiceGenerationLifecycleError && finalizeError.code === 'VOICE_REVENUE_PENDING') {
        return voiceLifecycleErrorResponse(finalizeError);
      }
      try {
        await refundCredits(
          lifecycle,
          Math.max(0, lifecycle.chargeCredits - lifecycle.refundedCredits),
          'dual-finalize-failed',
          '双人音频终态保存失败',
          {
            code: 'VOICE_LIFECYCLE_FINALIZE_FAILED',
            message: finalizeError instanceof Error ? finalizeError.message : 'unknown error',
          },
        );
      } catch (refundError) {
        return voiceLifecycleErrorResponse(refundError);
      }
      return voiceLifecycleErrorResponse(finalizeError);
    }

    // 8. 仅在终态、资产和历史都成功后写入成功计费。
    if (deducted && costBreakdown) {
      try {
        const balanceBefore = user.credits;
        const { data: userAfter } = await supabase.from('users').select('credits').eq('id', user.id).single();
        const balanceAfter = userAfter ? Number(userAfter.credits) : balanceBefore;
        const chargeAmountRmb = actualCreditsCharged / creditsPerYuan;
        const actualCostRmb = costPrice;
        await supabase.from('voice_billing_records').insert({
          user_id: user.id, model_id: modelId, model_name: costBreakdown.pricing.name,
          voice_type: 'tts_dual', total_char: totalCharCount, text_char: totalCharCount, instruction_char: 0,
          cost_per_10k: Math.round(costBreakdown.pricing.costPrice * 100) / 100,
          profit_rate: costBreakdown.pricing.profitMargin, real_cost: actualCostRmb,
          charge_amount: chargeAmountRmb, profit: roundVoiceAccounting(chargeAmountRmb - actualCostRmb),
          balance_before: balanceBefore, balance_after: balanceAfter,
          status: 'success', voice_id: `${speaker}+${speaker2}`,
        });
      } catch (e) { console.error('[voice-tts] 双人计费记录写入失败:', e); }
    }

    // 9. 返回已原子固化的可交付资产，不暴露临时的单路上游地址。
    return NextResponse.json(finalizedResponse);
  } catch (error: any) {
    try {
      await refundCredits(
        lifecycle,
        Math.max(0, lifecycle.chargeCredits - lifecycle.refundedCredits),
        'dual-unhandled-failure',
        '双人合成未处理异常',
        { message: error?.message || 'unknown error' },
      );
      deducted = false;
    } catch (refundError) {
      return voiceLifecycleErrorResponse(refundError);
    }
    return NextResponse.json({
      success: false,
      code: 'VOICE_GENERATION_FAILED',
      message: `双人合成异常: ${error.message}`,
      data: {
        terminalStatus: 'refunded',
        requestId: lifecycle.requestId,
        clientRequestId,
        persisted: false,
        upstreamSubmitted: true,
        creditsCharged: 0,
      },
    }, { status: 500 });
  }
}

function voiceQuoteResponse(user: AuthUser, modelId: string, charCount: number, breakdown: VoiceCostBreakdown, creditsPerYuan: number, reservationSeconds?: number) {
  void user;
  return NextResponse.json({ success: true, data: {
    quoteOnly: true, modelId, charCount, unit: breakdown.pricing.unit,
    quotedCredits: breakdown.creditsToCharge,
    retailPrice: breakdown.creditsToCharge / creditsPerYuan,
    ...(reservationSeconds ? { reservationSeconds, settlement: 'actual_output_seconds' } : {}),
  } }, { headers: { 'Cache-Control': 'private, no-store' } });
}

// ─── 内部处理函数 ───
async function handleTTS(user: AuthUser, supabase: any, req: Request): Promise<Response> {
  let activeLifecycle: VoiceLifecycleContext | null = null;
  try {
    const body = await req.json() as Record<string, any>;
    const quoteOnly = body.operation === 'quote';
    if (!body.textPrompt && body.mixSpeakers === undefined && (!body.engine || body.engine === 'volcano') && body.model !== undefined && !['auto', 'seed-tts-2.0-standard', 'seed-tts-2.0-expressive', 'seed-icl-2.0'].includes(body.model)) return NextResponse.json({ success: false, code: 'VOICE_MODEL_VERSION_INVALID', message: '请选择语音模型的具体版本（标准版或表现力增强版），当前参数未调用上游、未扣费。', data: { upstreamSubmitted: false, creditsCharged: 0 } }, { status: 400 });
    if (body.format !== undefined && !['mp3', 'wav', 'ogg_opus'].includes(body.format)) return NextResponse.json({ success: false, message: '请选择MP3、WAV或OGG音频格式' }, { status: 400 });
    if (body.sampleRate !== undefined && ![8000,16000,22050,24000,32000,44100,48000].includes(body.sampleRate)) return NextResponse.json({ success: false, message: '音频采样率不受支持' }, { status: 400 });
    if (body.format === 'ogg_opus' && body.sampleRate !== undefined && ![8000,16000,24000,48000].includes(body.sampleRate)) return NextResponse.json({ success: false, message: 'OGG音频请选择8、16、24或48kHz采样率' }, { status: 400 });
    for (const field of ['text', 'text2']) if (body[field] !== undefined && (typeof body[field] !== 'string' || body[field].length > 5000)) return NextResponse.json({ success: false, message: '每个角色的文本最多5000字符' }, { status: 400 });
    if (body.ssml !== undefined && (typeof body.ssml !== 'string' || body.ssml.length > 10_000)) return NextResponse.json({ success: false, message: 'SSML 内容最多 10000 字符' }, { status: 400 });
    if (body.mode === 'dual' && body.textPrompt) return NextResponse.json({ success: false, message: '双人合成与音频生成参数不能混用' }, { status: 400 });
    const clientIdentity = resolveClientRequestId(req, quoteOnly ? { ...body, client_request_id: 'voice-quote-validation' } : body);
    if (clientIdentity.errorResponse) return clientIdentity.errorResponse;
    const clientRequestId = clientIdentity.clientRequestId!;
    const speakerRejection = await rejectUnauthorizedSpeakers(user, supabase, body);
    if (speakerRejection) return speakerRejection;

    // ─── Seed-Audio-1.0 音频生成分支 ───
    // 当请求包含 textPrompt 时，走 Seed-Audio-1.0 路径
    if (body.textPrompt) {
      return handleSeedAudio(user, supabase, body, clientRequestId);
    }

    // ─── 双人对话合成分支 ───
    // 当 mode === 'dual' 且包含 text2 + speaker2 时，走双人合成路径
    if (body.mode === 'dual') {
      return handleDualTTS(user, supabase, body, clientRequestId);
    }

    // ─── 混音合成分支 ───
    // 当请求包含 mixSpeakers 时，走混音合成路径（仅 TTS 1.0 支持）
    if (body.mixSpeakers !== undefined) {
      return handleMixSynthesize(user, supabase, body, clientRequestId);
    }

    const { text, ssml, voiceId, speakerId: explicitSpeakerId, speaker, engine: engineOverride, speed, emotion, format, model: requestedModel, resourceId: customResourceId } = body;
    const directSpeakerId = explicitSpeakerId || speaker;

    // 1. 校验
    const normalizedSsml = typeof ssml === 'string' ? ssml.trim() : '';
    const normalizedText = typeof text === 'string' ? text.trim() : '';
    const billingText = normalizedSsml
      ? normalizedSsml.replace(/<[^>]*>/gu, ' ').replace(/\s+/gu, ' ').trim()
      : normalizedText;
    if (!billingText) {
      return NextResponse.json({ success: false, message: '文案内容不能为空' }, { status: 400 });
    }
    if (billingText.length > 5000) {
      return NextResponse.json({ success: false, message: '文案长度不能超过5000字' }, { status: 400 });
    }

    const charCount = billingText.length;

    // 2. 查找声音
    const voices = getAllVoices();
    let voice: any = voiceId ? voices.find((v: any) => v.id === voiceId) : null;

    if (!voice && directSpeakerId) {
      const catalogVoice = readVoiceCatalog().find((candidate) => candidate.speakerId === directSpeakerId);
      voice = catalogVoice || {
        id: `owned-${directSpeakerId}`,
        name: '我的定制音色',
        engine: 'volcano',
        speakerId: directSpeakerId,
        category: 'custom',
        styleTags: [],
        gender: 'neutral',
        language: 'zh',
        description: '',
      };
    }

    if (!voice) {
      return NextResponse.json({ success: false, message: '请选择声音' }, { status: 400 });
    }

    // 3. 确定引擎和模型
    const engine: TTSEngine = (engineOverride || voice.engine || 'volcano') as TTSEngine;
    if (normalizedSsml && engine !== 'volcano') {
      return NextResponse.json({ success: false, message: '当前音色引擎不支持 SSML，请切换普通文本输入' }, { status: 400 });
    }
    const speakerId = voice?.speakerId || directSpeakerId || '';
    const frozenVolcanoTarget = engine === 'volcano'
      ? freezeVolcanoVoiceTarget(
        speakerId,
        requestedModel,
        customResourceId,
      )
      : null;
    if (frozenVolcanoTarget && customResourceId
      && resolvePublishedVoiceModelId(customResourceId) !== frozenVolcanoTarget.billingModelId) {
      return NextResponse.json({
        success: false,
        code: 'VOICE_MODEL_RESOURCE_CONFLICT',
        message: '所选模型与语音资源不匹配，请重新选择；未调用上游、未扣费。',
        data: { upstreamSubmitted: false, creditsCharged: 0 },
      }, { status: 400 });
    }
    const modelId = frozenVolcanoTarget?.billingModelId || inferModelId(speakerId, engine);
    const requestTraceId = buildVoiceTraceId(clientRequestId, 'tts');

    // 4. 获取引擎配置（API Key等）
    const configs = getAllEngineConfigs();
    const config = configs.find((c: any) => c.engine === engine && c.enabled) ||
                   configs.find((c: any) => c.engine === 'volcano');
    // Volcano uses getActiveApiKey() from the realtime database below. The
    // legacy engine-configs.json gate only applies to engines that still pass
    // this config object into routeTTS().
    if (engine !== 'volcano' && !config) {
      return NextResponse.json({
        success: false,
        message: `引擎「${engine}」未配置或未启用，请先在后台「引擎配置」页面填写API Key`
      }, { status: 400 });
    }
    if (engine === 'volcano' && !(await isVolcanoConfigured())) return volcanoUnavailableResponse();

    // 5. 计算费用（按字符数 + ModelConfig 定价）
    const billingQuote = await resolveVoiceBillingQuote(charCount, modelId);
    if ('errorResponse' in billingQuote) return billingQuote.errorResponse;
    const { costBreakdown, creditsPerYuan } = billingQuote;
    const creditsToCharge = costBreakdown.creditsToCharge;
    const costPrice = costBreakdown.costPriceRmb;
    const retailPrice = creditsToCharge / creditsPerYuan;
    if (quoteOnly) return voiceQuoteResponse(user, modelId, charCount, costBreakdown, creditsPerYuan);
    const payloadFingerprint = buildVoicePayloadFingerprint('tts', modelId, body);

    // 6. 原子建立持久任务并按主站钱包规则扣费；角色不改变价格。
    const deductResult = await deductCredits(user.id, creditsToCharge, {
      clientRequestId,
      phase: 'tts',
      modelId,
      creditsPerYuan,
      payloadFingerprint,
      costBreakdown,
      providerCandidates: frozenVolcanoTarget ? [frozenVolcanoTarget.providerModelId] : [modelId],
      historySnapshot: createVoiceHistorySnapshot({
        voiceModelName: voice?.name || directSpeakerId || voiceId,
        inputText: normalizedSsml || normalizedText,
        textLength: charCount,
        outputFormat: format || 'mp3',
        speedRatio: body.speechRate ?? speed ?? 1,
        emotion: emotion || 'neutral',
        engine,
      }),
    }, user.role);
    if (!deductResult.success || !deductResult.lifecycle) {
      return voiceClaimFailureResponse(
        deductResult,
        `积分不足，本次需要${creditsToCharge}积分（${retailPrice}元），当前余额${deductResult.remaining}积分，请充值`,
      );
    }
    const lifecycle = deductResult.lifecycle;
    activeLifecycle = lifecycle;
    if (deductResult.alreadyFulfilled) {
      return replayCompletedVoiceResponse(deductResult.response, lifecycle);
    }
    let deducted = lifecycle.chargeCredits > lifecycle.refundedCredits;

    // 7. 提取高级参数（兼容前端两种命名 + 全量转发到火山引擎）
    const {
      // 兼容前端 speechRate/loudnessRate/pitchRate 和后端 speed/volume/pitch
      speechRate, loudnessRate, pitchRate,
      volume: bodyVolume, pitch: bodyPitch, speed: bodySpeed,
      sampleRate, contextTexts, sectionId,
      subtitle: bodySubtitle, enableSubtitle,
      // 高级参数
      emotionIntensity, silenceFinal, language, dialect,
      voiceInstruction, subtitleTimestamp, aigcTag,
      useCache, silenceSeg, latex, langDetect, filterMd, filterEmoji,
    } = body;

    // 统一参数名（前端发送 speechRate/loudnessRate/pitchRate，兼容后端 speed/volume/pitch）
    const finalSpeed = speechRate ?? bodySpeed ?? speed;
    const finalVolume = loudnessRate ?? bodyVolume ?? 0;
    const finalPitch = pitchRate ?? bodyPitch ?? 0;
    const finalSubtitle = enableSubtitle ?? bodySubtitle ?? false;

    // 8. 翻标记 → 调用引擎
    let processedText = normalizedText;
    let processedEmotion = emotion;
    try {
      const translated = normalizedSsml
        ? { text: normalizedText, emotion: undefined }
        : translateForEngine(normalizedText, engine);
      processedText = translated.text;
      if (translated.emotion) processedEmotion = translated.emotion;
    } catch (e) {
      console.error('[voice-tts] 标记翻译失败，使用原始文本:', e);
    }

    // ─── 火山引擎走 volcengine.synthesizeSpeech()（全参数支持）───
    let ttsResult: { success: boolean; message?: string; data?: any } | undefined;

    if (engine === 'volcano') {
      const inferredModel = frozenVolcanoTarget!.providerModelId;
      let audioParams: Record<string, any> = {};
      let additions: Record<string, any> = {};
      try {
        const { synthesizeSpeech, getActiveApiKey } = await import('@/lib/vs/volcengine');
        const apiKeyResult = await getActiveApiKey();
        if (!apiKeyResult) {
          try {
            await refundCredits(
              lifecycle,
              Math.max(0, lifecycle.chargeCredits - lifecycle.refundedCredits),
              'tts-provider-unavailable',
              '火山引擎 API Key 在任务占位后不可用',
              { code: 'VOICE_PROVIDER_UNAVAILABLE' },
            );
            deducted = false;
          } catch (refundError) {
            return voiceLifecycleErrorResponse(refundError);
          }
          return volcanoUnavailableResponse();
        } else {
          // 构建完整 additions（只发送非默认值的参数）
          additions = {};
          if (sectionId) additions.section_id = sectionId;
          // 语音指令（context_texts）
          const ctxTexts = voiceInstruction
            ? (Array.isArray(voiceInstruction) ? voiceInstruction : [voiceInstruction])
            : (contextTexts && Array.isArray(contextTexts) && contextTexts.length > 0 ? contextTexts : null);
          if (ctxTexts) additions.context_texts = ctxTexts;
          // 句尾静音（silence_duration 0-30000ms，默认0=不发送）
          if (silenceFinal && silenceFinal > 0) additions.silence_duration = silenceFinal;
          // 语种指定（默认'auto'=不发送）
          if (language && language !== 'auto') additions.explicit_language = language;
          // 方言（默认'mandarin'=不发送，让引擎自动识别）
          if (dialect && dialect !== 'mandarin' && dialect !== 'auto') additions.explicit_dialect = dialect;
          // 自动语种识别（默认false=不发送）
          if (langDetect) additions.enable_language_detector = true;
          // Markdown过滤（默认false=不发送，true表示禁用过滤）
          if (filterMd) additions.disable_markdown_filter = true;
          // Emoji过滤（默认false=不发送，true表示禁用过滤）
          if (filterEmoji) additions.disable_emoji_filter = true;
          // LaTeX公式（默认false=不发送）
          if (latex) additions.enable_latex_tn = true;
          // 缓存（默认false=不发送）
          if (useCache) additions.cache_config = { text_type: 1, use_cache: true };
          // AIGC水印（默认false=不发送）
          if (aigcTag) additions.aigc_watermark = true;
          // 句段静音裁剪（默认false=不发送）
          if (silenceSeg) additions.mute_cut_threshold = '200';

          // 构建完整 audioParams（只发送非默认值的参数）
          audioParams = {
            format: format || 'mp3',
            sample_rate: sampleRate || 24000,
            speech_rate: finalSpeed ?? 0,
            loudness_rate: finalVolume ?? 0,
          };
          if (processedEmotion && processedEmotion !== 'none') {
            audioParams.emotion = processedEmotion;
          }
          // 情绪强度（emotion_scale 1-5，默认0.5=不发送）
          if (emotionIntensity && emotionIntensity > 0.5) {
            audioParams.emotion_scale = Math.min(5, Math.max(1, Math.round(emotionIntensity * 2.5)));
          }
          if (finalSubtitle) audioParams.enable_subtitle = true;
          if (subtitleTimestamp) audioParams.enable_timestamp = true;

          const audioResult = await synthesizeSpeech({
            text: normalizedSsml ? undefined : processedText,
            ssml: normalizedSsml || undefined,
            speaker: speakerId,
            model: inferredModel,
            resourceId: frozenVolcanoTarget!.providerResourceId,
            audioParams,
            additions: Object.keys(additions).length > 0 ? additions : undefined,
            pitch: finalPitch ?? 0,
          });

          ttsResult = {
            success: true,
            message: '合成成功',
            data: {
              generationId: requestTraceId,
              audioUrl: audioResult.audioUrl,
              duration: audioResult.duration,
              originalDuration: audioResult.originalDuration,
              subtitles: audioResult.subtitles,
              providerTraceId: audioResult.logId,
              providerModelId: inferredModel,
              billingModelId: modelId,
            },
          };
        }
      } catch (e: any) {
        // 跨公开计价模型自动降级会造成错价交付，因此按冻结模型失败处理并退款。
        ttsResult = { success: false, message: e.message || '火山引擎合成失败' };
      }
    } else {
      // ─── 其他引擎走旧 routeTTS 路径 ───
      try {
        ttsResult = await routeTTS({
          text: processedText,
          voiceModelId: voiceId || voice.id,
          speedRatio: finalSpeed ?? 1.0,
          emotion: processedEmotion,
          outputFormat: format || 'mp3',
          engine,
        } as any, engine, speakerId, config!);
      } catch (routeError) {
        ttsResult = {
          success: false,
          message: routeError instanceof Error ? routeError.message : '语音合成引擎调用失败',
        };
      }
    }

    // 安全兜底：确保 ttsResult 有值
    if (!ttsResult) {
      ttsResult = { success: false, message: '合成失败：未知错误' };
    }

    const providerTaskId = String(ttsResult.data?.generationId || requestTraceId);
    let persistedAudio: PersistedAudio | null = null;
    if (ttsResult.success) {
      const providerAudioUrl = String(ttsResult.data?.audioUrl || '');
      if (!providerAudioUrl) {
        ttsResult = { success: false, message: '合成成功但未返回音频地址' };
      } else {
        try {
          persistedAudio = await persistGeneratedAudio(providerAudioUrl, providerTaskId, user.id);
          ttsResult.data = {
            ...ttsResult.data,
            duration: persistedAudio.duration,
            originalDuration: Number(ttsResult.data?.originalDuration) || persistedAudio.duration,
            audioUrl: persistedAudio.signedUrl,
            providerTaskId,
            asset: {
              id: persistedAudio.assetId,
              storageKey: persistedAudio.storageKey,
              storageProvider: persistedAudio.storageProvider,
              contentType: persistedAudio.contentType,
              size: persistedAudio.size,
            },
          };
        } catch (e: any) {
          ttsResult = { success: false, message: `音频结果入库失败: ${e.message || 'unknown error'}` };
        }
      }
    }

    // 8. 任何生成或持久化失败都原子退回尚未退的积分，并固化失败终态。
    if (ttsResult && !ttsResult.success) {
      try {
        await refundCredits(
          lifecycle,
          Math.max(0, lifecycle.chargeCredits - lifecycle.refundedCredits),
          'tts-generation-failed',
          '普通 TTS 生成或结果入库失败',
          { message: ttsResult.message || 'unknown error' },
        );
        deducted = false;
      } catch (refundError) {
        return voiceLifecycleErrorResponse(refundError);
      }
    }
    let actualCreditsCharged = Math.max(0, lifecycle.chargeCredits - lifecycle.refundedCredits);

    // 9. 成功与失败历史都由原子生命周期表记录；不再写单机 JSON。
    const generationId = lifecycle.requestId;

    // 失败任务已原子退款；保留本地失败历史后返回可恢复的任务标识。
    if (!ttsResult.success) {
      return NextResponse.json({
        ...ttsResult,
        code: 'VOICE_GENERATION_FAILED',
        data: {
          terminalStatus: 'refunded',
          requestId: lifecycle.requestId,
          clientRequestId,
          persisted: false,
          upstreamSubmitted: true,
          creditsCharged: 0,
        },
      }, { status: 502 });
    }

    const successResponse: Record<string, unknown> = {
      ...ttsResult,
      data: ttsResult.data ? {
        ...ttsResult.data,
        terminalStatus: 'completed',
        lifecycleState: 'completed',
        requestId: lifecycle.requestId,
        clientRequestId,
        persisted: true,
        generationId,
        providerTaskId,
        cost: actualCreditsCharged,
        quotedCredits: costBreakdown.creditsToCharge,
        costPrice,
        retailPrice,
        billing: {
          charCount,
          modelId,
          modelName: costBreakdown.pricing.name,
          unit: costBreakdown.pricing.unit,
          sellPriceRmb: retailPrice,
          costPriceRmb: costBreakdown.costPriceRmb,
          profitRmb: roundVoiceAccounting(actualCreditsCharged / creditsPerYuan - costBreakdown.costPriceRmb),
          creditsCharged: actualCreditsCharged,
          profitMargin: costBreakdown.pricing.profitMargin,
        },
      } : null,
    };

    let finalizedResponse: Record<string, unknown>;
    try {
      finalizedResponse = await finalizeVoiceLifecycle(
        lifecycle,
        persistedAudio!.assetId,
        generationId,
        providerTaskId,
        successResponse,
        {
          provider: engine,
          provider_model: frozenVolcanoTarget?.providerModelId || modelId,
        },
      );
    } catch (finalizeError) {
      if (finalizeError instanceof VoiceGenerationLifecycleError && finalizeError.code === 'VOICE_REVENUE_PENDING') {
        return voiceLifecycleErrorResponse(finalizeError);
      }
      try {
        await refundCredits(
          lifecycle,
          Math.max(0, lifecycle.chargeCredits - lifecycle.refundedCredits),
          'tts-finalize-failed',
          '普通 TTS 终态保存失败',
          {
            code: 'VOICE_LIFECYCLE_FINALIZE_FAILED',
            message: finalizeError instanceof Error ? finalizeError.message : 'unknown error',
          },
        );
        deducted = false;
      } catch (refundError) {
        return voiceLifecycleErrorResponse(refundError);
      }
      return voiceLifecycleErrorResponse(finalizeError);
    }

    // 10. 写入计费记录（voice_billing_records）
    if (deducted && costBreakdown) {
      try {
        const balanceBefore = user.credits;
        const { data: userAfter } = await supabase
          .from('users')
          .select('credits')
          .eq('id', user.id)
          .single();
        const balanceAfter = userAfter ? Number(userAfter.credits) : balanceBefore;

        await supabase.from('voice_billing_records').insert({
          user_id: user.id,
          model_id: modelId,
          model_name: costBreakdown.pricing.name,
          voice_type: 'tts',
          total_char: charCount,
          text_char: charCount,
          instruction_char: 0,
          cost_per_10k: Math.round(costBreakdown.pricing.costPrice * 100) / 100,
          profit_rate: costBreakdown.pricing.profitMargin,
          real_cost: costBreakdown.costPriceRmb,
          charge_amount: actualCreditsCharged / creditsPerYuan,
          profit: roundVoiceAccounting(actualCreditsCharged / creditsPerYuan - costBreakdown.costPriceRmb),
          balance_before: balanceBefore,
          balance_after: balanceAfter,
          status: 'success',
          voice_id: voiceId || null,
        });
      } catch (e) {
        console.error('[voice-tts] 计费记录写入失败:', e);
      }
    }

    // 11. 返回已原子固化的结果。
    activeLifecycle = null;
    return NextResponse.json(finalizedResponse);

  } catch (error: any) {
    if (activeLifecycle) {
      try {
        await refundCredits(
          activeLifecycle,
          Math.max(0, activeLifecycle.chargeCredits - activeLifecycle.refundedCredits),
          'tts-unhandled-failure',
          '普通 TTS 未处理异常',
          { message: error?.message || 'unknown error' },
        );
      } catch (refundError) {
        return voiceLifecycleErrorResponse(refundError);
      }
    }
    return NextResponse.json({
      success: false,
      code: 'VOICE_GENERATION_FAILED',
      message: `服务器异常: ${error.message}`,
      data: activeLifecycle ? {
        terminalStatus: 'refunded',
        requestId: activeLifecycle.requestId,
        clientRequestId: activeLifecycle.clientRequestId,
        persisted: false,
        upstreamSubmitted: true,
        creditsCharged: 0,
      } : undefined,
    }, { status: 500 });
  }
}

// ─── 路由导出 ───
export async function POST(request: Request) {
  return withAuth(request, async (user, client, req) => {
    const response = await handleTTS(user, client, req);
    return NextResponse.json(publicVoiceResponse(await response.json()), { status: response.status, headers: response.headers });
  });
}
