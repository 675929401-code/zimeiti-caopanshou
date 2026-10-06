import { safeFetch } from '@/lib/safe-fetch';
import { loadVolcanoVoiceProviderConfig } from '@/lib/server/voice-provider-config';
import { findVoiceBySpeakerId } from '@/lib/vs/voices-data';
const PREVIEW_AUDIO_MAX_BYTES = 5 * 1024 * 1024;

export class PreviewRateLimitError extends Error {
  constructor(readonly retryAfter: number) { super('Preview synthesis rate limited'); }
}

export class PreviewSynthesisError extends Error {
  constructor(message: string, readonly allowModelFallback = false) {
    super(message);
  }
}

function isModelCompatibilityRejection(message: string) {
  return /not granted|mismatch|not support|invalid|forbidden|450000(?:30|01|11|12)/iu.test(message);
}

function decodePreviewAudioChunk(value: string): Buffer {
  const encoded = value.replace(/\s/gu, '');
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded) || encoded.length % 4 === 1) {
    throw new PreviewSynthesisError('试听音频分片格式无效');
  }
  const decoded = Buffer.from(encoded, 'base64');
  if (!decoded.length || decoded.toString('base64').replace(/=+$/u, '') !== encoded.replace(/=+$/u, '')) {
    throw new PreviewSynthesisError('试听音频分片格式无效');
  }
  return decoded;
}

export async function resolvePreviewApiKey(): Promise<string> {
  // Use the same protected server-side provider resolver as paid speech synthesis.
  const provider = await loadVolcanoVoiceProviderConfig().catch(() => null);
  return provider?.apiKey || '';
}

async function downloadPreviewAudio(url: string): Promise<string> {
  const downloaded = await safeFetch(url, {
    timeoutMs: 15_000,
    maxBytes: PREVIEW_AUDIO_MAX_BYTES,
    maxRedirects: 2,
    allowedContentTypes: ['audio/*', 'application/octet-stream', 'binary/octet-stream'],
  });
  const contentType = downloaded.contentType.startsWith('audio/')
    ? downloaded.contentType
    : 'audio/mpeg';
  return `data:${contentType};base64,${downloaded.buffer.toString('base64')}`;
}

/**
 * 使用指定 model 进行试听合成（支持 standard 回退）
 */
export async function previewSynthesizeWithModel(speakerId: string, text: string, resourceId: string, apiKey: string, model: string) {
  const apiBase = process.env.VOLCENGINE_API_BASE || 'https://openspeech.bytedance.com';
  const requestId = crypto.randomUUID();

  const body = {
    req_params: {
      text,
      speaker: speakerId,
      model,
      audio_params: {
        format: 'mp3',
        sample_rate: 16000,
        speech_rate: 0,
        loudness_rate: 0,
      },
      post_process: { pitch: 0 },
    },
  };

  const response = await fetch(`${apiBase}/api/v3/tts/unidirectional`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Api-Key': apiKey,
      'X-Api-Resource-Id': resourceId,
      'X-Api-Request-Id': requestId,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60000),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new PreviewSynthesisError(
      `火山API HTTP ${response.status}: ${errText.slice(0, 200)}`,
      [400, 401, 403, 404, 422].includes(response.status) && isModelCompatibilityRejection(errText),
    );
  }

  const rawText = await response.text();

  // 尝试 JSON 解析
  let data: Record<string, unknown> | null = null;
  try {
    data = JSON.parse(rawText) as Record<string, unknown>;
  } catch {
    // 非 JSON，可能是 NDJSON 流
  }

  if (data) {
    // 错误检查
    if (data.code !== undefined && data.code !== 20000000 && data.code !== 0) {
      const errMsg = String(data.message || data.msg || '未知错误');
      const message = `火山API错误: ${errMsg} (code: ${data.code})`;
      throw new PreviewSynthesisError(message, !data.data && !data.url && isModelCompatibilityRejection(message));
    }

    // 情况1: data.url 直接返回 URL → SSRF 安全下载并限制大小
    const dataPayload = typeof data.data === 'object' && data.data !== null ? data.data as Record<string, unknown> : null;
    const directUrlValue = data.url || dataPayload?.url;
    const directUrl = typeof directUrlValue === 'string' ? directUrlValue : '';
    if (directUrl && !directUrl.startsWith('SUQ') && directUrl.startsWith('http')) {
      const audioUrl = await downloadPreviewAudio(directUrl);
      return { audioUrl, duration: Number(data.duration || dataPayload?.duration || 0) };
    }

    // 情况2: data.data 是 base64 音频
    const audioBase64 = typeof data.data === 'string' ? data.data : '';
    if (audioBase64 && audioBase64.length > 100) {
      const audio = decodePreviewAudioChunk(audioBase64);
      if (audio.length > PREVIEW_AUDIO_MAX_BYTES) throw new PreviewSynthesisError('试听音频超过大小限制');
      const dataUrl = `data:audio/mp3;base64,${audio.toString('base64')}`;
      return { audioUrl: dataUrl, duration: Number(data.duration || 0) };
    }
  }

  // 情况3: NDJSON 流式响应，按行解析
  const lines = rawText.split('\n').filter(Boolean);
  let audioUrl = '';
  let duration = 0;
  const audioChunks: Buffer[] = [];
  let audioBytes = 0;

  for (const line of lines) {
    let evt;
    try {
      evt = JSON.parse(line);
    } catch {
      // 跳过非 JSON 行
      continue;
    }
    if (!evt || typeof evt !== 'object') continue;
    // Provider errors must not be swallowed by the JSON syntax catch. Once
    // audio has arrived, a failure is unresolved and cannot trigger another model.
    if (evt.code && evt.code !== 20000000 && evt.code !== 0) {
      const message = `火山合成错误: ${evt.message || ''} (code: ${evt.code})`;
      throw new PreviewSynthesisError(message,
        !audioBytes && !audioUrl && !evt.data && !evt.url && isModelCompatibilityRejection(message));
    }
    if (typeof evt.url === 'string' && evt.url.startsWith('http')) audioUrl = evt.url;
    if (evt.duration) duration = evt.duration;
    if (typeof evt.data === 'string' && evt.data.length > 0) {
      // Each provider fragment is independently Base64-encoded; concatenating
      // padded strings truncates decoding at the first fragment's padding.
      const chunk = decodePreviewAudioChunk(evt.data);
      audioBytes += chunk.length;
      if (audioBytes > PREVIEW_AUDIO_MAX_BYTES) throw new PreviewSynthesisError('试听音频超过大小限制');
      audioChunks.push(chunk);
    }
  }

  if (audioUrl) {
    return { audioUrl: await downloadPreviewAudio(audioUrl), duration };
  }
  if (audioChunks.length) {
    return { audioUrl: `data:audio/mp3;base64,${Buffer.concat(audioChunks).toString('base64')}`, duration };
  }

  throw new PreviewSynthesisError('火山API未返回可确认的有效音频数据');
}


export async function synthesizeConfiguredVoicePreview(speakerId: string, previewText: string, apiKey: string) {
    // 多模型自动重试策略（实测 2026-07-28 更新）：
    // 根据音色类型动态排序 model+resource 组合：
    //   - ICL 音色（ICL_/icl_/S_ 前缀）：优先 seed-icl-2.0
    //   - saturn 旗舰音色：seed-tts-2.0-expressive → seed-tts-2.0-standard
    //   - uranus 标准音色：seed-tts-2.0-expressive → seed-tts-2.0-standard
    //   - 使用音色自带的 resourceId（如有）作为首选
    // 策略：按音色类型智能排序 → 依次尝试直到成功
    const voiceInfo = findVoiceBySpeakerId(speakerId);
    const voiceResourceId = voiceInfo?.resourceId;
    const isICL = speakerId.startsWith('ICL_') || speakerId.startsWith('icl_') || speakerId.startsWith('S_');

    // 构建重试列表：音色自带 resourceId 优先，然后按类型排序
    const modelOptions: { model: string; resourceId: string }[] = [];

    if (isICL) {
      // ICL 音色：icl 优先
      modelOptions.push({ model: 'seed-icl-2.0', resourceId: voiceResourceId || 'seed-icl-2.0' });
      modelOptions.push({ model: 'seed-tts-2.0-expressive', resourceId: 'seed-tts-2.0' });
      modelOptions.push({ model: 'seed-tts-2.0-standard', resourceId: 'seed-tts-2.0' });
    } else {
      // saturn/uranus/其他：expressive 优先
      if (voiceResourceId && voiceResourceId !== 'seed-tts-2.0') {
        // 音色指定了非默认 resourceId，优先使用
        modelOptions.push({ model: 'seed-tts-2.0-expressive', resourceId: voiceResourceId });
      }
      modelOptions.push({ model: 'seed-tts-2.0-expressive', resourceId: 'seed-tts-2.0' });
      modelOptions.push({ model: 'seed-tts-2.0-standard', resourceId: 'seed-tts-2.0' });
      modelOptions.push({ model: 'seed-icl-2.0', resourceId: 'seed-icl-2.0' });
    }

    // 去重（相同 model+resourceId 不重复尝试）
    const seen = new Set<string>();
    const dedupedOptions = modelOptions.filter(opt => {
      const key = `${opt.model}|${opt.resourceId}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    let result;
    let lastErr: unknown;
    for (const opt of dedupedOptions) {
      try {
        result = await previewSynthesizeWithModel(speakerId, previewText, opt.resourceId, apiKey, opt.model);
        break;
      } catch (err: unknown) {
        lastErr = err;
        const msg = err instanceof Error ? err.message : String(err || '');
        // 429 限流：直接返回，不重试（避免雪崩）
        if (msg.includes('429')) {
          throw new PreviewRateLimitError(30);
        }
        // Only an explicit compatibility rejection before any audio was
        // returned may choose another model. Timeouts, 5xx, download failures
        // and partial audio have an unknown supplier outcome.
        if (err instanceof PreviewSynthesisError && err.allowModelFallback) {
          console.warn(`[Preview] model=${opt.model} resource=${opt.resourceId} failed for ${speakerId}: ${msg.slice(0, 100)}, trying next...`);
          continue;
        }
        throw err;
      }
    }
    if (!result) {
      throw lastErr || new Error('所有模型组合均失败');
    }

    return result;
}
