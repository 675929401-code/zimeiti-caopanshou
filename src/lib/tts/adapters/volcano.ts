// 火山引擎语音适配器
// 文档: https://www.volcengine.com/docs/6561/79823
// 支持 v1 API（旧 BV_* 音色）和 v3 unidirectional API（2.0 uranus/saturn/ICL 音色）
import type {
  CloneRequest,
  CloneResponse,
  TTSRequest,
  TTSResponse,
  OutputFormat,
} from '@/lib/types';

interface VolcanoConfig {
  apiKey: string;
  extraConfig: Record<string, string>;
}

const DEFAULT_TTS_ENDPOINT = 'https://openspeech.bytedance.com/api/v1/tts';
const DEFAULT_CLONE_ENDPOINT = 'https://openspeech.bytedance.com/api/v1/mega_tts/audio/upload';
const V3_TTS_ENDPOINT = 'https://openspeech.bytedance.com/api/v3/tts/unidirectional';

/** 判断是否为 2.0 新音色（需要 v3 API） */
function isV2Speaker(speakerId: string): boolean {
  return (
    speakerId.includes('_uranus_') ||
    speakerId.includes('_saturn_') ||
    speakerId.startsWith('ICL_') ||
    speakerId.startsWith('saturn_zh_') ||
    speakerId.startsWith('en_') // 多语种英文音色
  );
}

/** 根据 speakerId 获取 v3 API 的 resource_id */
function getResourceIdForSpeaker(speakerId: string): string {
  // 所有 2.0 音色统一用 seed-tts-2.0
  return 'seed-tts-2.0';
}

/** 根据 speakerId 获取 v3 API 的默认 model */
function getDefaultModelForSpeaker(speakerId: string): string {
  if (speakerId.endsWith('_uranus_bigtts')) {
    return 'seed-tts-2.0-standard';
  }
  return 'seed-tts-2.0-expressive';
}

/**
 * v3 unidirectional API 合成（2.0 音色）
 */
async function ttsV3(
  req: TTSRequest,
  speakerId: string,
  config: VolcanoConfig,
): Promise<TTSResponse> {
  const apiKey = config.apiKey;
  if (!apiKey) {
    return { success: false, message: '火山引擎未配置 API Key' };
  }

  const resourceId = getResourceIdForSpeaker(speakerId);
  const model = getDefaultModelForSpeaker(speakerId);
  const requestId = crypto.randomUUID();

  const body = {
    req_params: {
      text: req.text,
      speaker: speakerId,
      model,
      audio_params: {
        format: req.outputFormat || 'mp3',
        sample_rate: 24000,
        speech_rate: Math.round((req.speedRatio || 1.0) * 100) / 100 - 1, // v3: -1 ~ 1 范围，1.0 → 0
        loudness_rate: 0,
      },
      post_process: { pitch: 0 },
    },
  };

  const response = await fetch(V3_TTS_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Api-Key': apiKey,
      'X-Api-Resource-Id': resourceId,
      'X-Api-Request-Id': requestId,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120000),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    return { success: false, message: `火山 v3 API HTTP ${response.status}: ${errText.slice(0, 200)}` };
  }

  const rawText = await response.text();

  // 尝试 JSON 解析
  let data: any = null;
  try {
    data = JSON.parse(rawText);
  } catch {
    // 非 JSON，可能是 NDJSON 流
  }

  if (data) {
    if (data.code !== undefined && data.code !== 20000000 && data.code !== 0) {
      const errMsg = data.message || data.msg || '未知错误';
      return { success: false, message: `火山 v3 错误: ${errMsg} (code: ${data.code})` };
    }

    // data.url 直接返回 URL
    const directUrl = data.url || data.data?.url;
    if (directUrl && !directUrl.startsWith('SUQ') && directUrl.startsWith('http')) {
      return {
        success: true,
        message: '合成成功',
        data: {
          generationId: `gen_${Date.now()}`,
          audioUrl: directUrl,
          duration: data.duration || data.data?.duration || 0,
          format: req.outputFormat || 'mp3',
          cost: req.text.length,
        },
      };
    }

    // data.data 是 base64 音频
    const audioBase64 = typeof data.data === 'string' ? data.data : '';
    if (audioBase64 && audioBase64.length > 100) {
      return {
        success: true,
        message: '合成成功',
        data: {
          generationId: `gen_${Date.now()}`,
          audioData: audioBase64,
          duration: data.duration || 0,
          format: req.outputFormat || 'mp3',
          cost: req.text.length,
        },
      };
    }
  }

  // NDJSON 流式响应
  const lines = rawText.split('\n').filter(Boolean);
  let audioUrl = '';
  let duration = 0;
  let combinedBase64 = '';

  for (const line of lines) {
    try {
      const evt = JSON.parse(line);
      if (evt.url && evt.url.startsWith('http')) audioUrl = evt.url;
      if (evt.duration) duration = evt.duration;
      if (typeof evt.data === 'string' && evt.data.length > 0) {
        combinedBase64 += evt.data;
      }
      if (evt.code && evt.code !== 20000000 && evt.code !== 0) {
        return { success: false, message: `火山 v3 合成错误: ${evt.message || ''} (code: ${evt.code})` };
      }
    } catch {
      // 跳过非 JSON 行
    }
  }

  if (audioUrl) {
    return {
      success: true,
      message: '合成成功',
      data: { generationId: `gen_${Date.now()}`, audioUrl, duration, format: req.outputFormat || 'mp3', cost: req.text.length },
    };
  }
  if (combinedBase64) {
    return {
      success: true,
      message: '合成成功',
      data: { generationId: `gen_${Date.now()}`, audioData: combinedBase64, duration, format: req.outputFormat || 'mp3', cost: req.text.length },
    };
  }

  return { success: false, message: `火山 v3 API 未返回有效音频数据` };
}

/**
 * 声音克隆 - 火山引擎 MegaTTS
 */
export async function clone(
  req: CloneRequest,
  config: VolcanoConfig,
): Promise<CloneResponse> {
  try {
    const appId = config.extraConfig.appId;
    if (!appId) {
      return { success: false, message: '火山引擎缺少 AppID 配置' };
    }
    const token = config.apiKey;
    if (!token) {
      return { success: false, message: '火山引擎缺少 Token 配置' };
    }

    const res = await fetch(DEFAULT_CLONE_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer; ${token}`,
        'Resource-Id': 'volc.megatts.voiceclone',
      },
      body: JSON.stringify({
        app: { appid: appId, token, cluster: 'volcano_mega' },
        audio: { audio_data: req.audioData, audio_format: req.audioFormat, sample_rate: 16000 },
        speaker: { speaker_name: req.voiceName, language: req.language },
      }),
    });

    if (!res.ok) {
      return { success: false, message: `火山引擎克隆请求失败: ${res.status}`, code: 'CLONE_REQ_FAIL' };
    }
    const data = await res.json();
    if (data?.BaseResp?.StatusCode !== 0) {
      return {
        success: false,
        message: data?.BaseResp?.StatusMessage || '火山引擎克隆失败',
        code: 'CLONE_FAIL',
      };
    }
    return {
      success: true,
      message: '克隆任务已提交，训练中',
      data: {
        cloneId: data?.speaker?.speaker_id || `volcano_${Date.now()}`,
        speakerId: data?.speaker?.speaker_id || '',
        status: 'training',
        estimatedTime: 60,
      },
    };
  } catch (err) {
    return {
      success: false,
      message: `火山引擎克隆异常: ${(err as Error).message}`,
      code: 'CLONE_ERROR',
    };
  }
}

/**
 * 查询克隆状态
 */
export async function cloneStatus(
  speakerId: string,
  config: VolcanoConfig,
): Promise<CloneResponse> {
  try {
    const token = config.apiKey;
    const appId = config.extraConfig.appId;
    const res = await fetch('https://openspeech.bytedance.com/api/v1/mega_tts/audio/status', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer; ${token}`,
        'Resource-Id': 'volc.megatts.voiceclone',
      },
      body: JSON.stringify({ app: { appid: appId, token, cluster: 'volcano_mega' }, speaker: { speaker_id: speakerId } }),
    });
    if (!res.ok) {
      return { success: false, message: `状态查询失败: ${res.status}` };
    }
    const data = await res.json();
    const stateMap: Record<string, 'pending' | 'training' | 'ready' | 'failed'> = {
      0: 'training',
      1: 'ready',
      '-1': 'failed',
    };
    const status = stateMap[String(data?.BaseResp?.StatusCode)] || 'pending';
    return {
      success: true,
      message: status === 'ready' ? '克隆完成' : '训练中',
      data: { cloneId: speakerId, speakerId, status, estimatedTime: status === 'ready' ? 0 : 30 },
    };
  } catch (err) {
    return { success: false, message: `状态查询异常: ${(err as Error).message}` };
  }
}

/**
 * 语音合成
 * 自动判断：2.0 音色 → v3 unidirectional API，旧 BV_* 音色 → v1 API
 */
export async function tts(
  req: TTSRequest,
  speakerId: string,
  config: VolcanoConfig,
): Promise<TTSResponse> {
  // 2.0 新音色：使用 v3 unidirectional API
  if (isV2Speaker(speakerId)) {
    return ttsV3(req, speakerId, config);
  }

  // 旧 BV_* 音色：使用 v1 API
  try {
    const token = config.apiKey;
    const appId = config.extraConfig.appId;
    const cluster = config.extraConfig.cluster || 'volcano_tts';
    if (!token || !appId) {
      return { success: false, message: '火山引擎未配置 Token 或 AppID' };
    }
    const formatMap: Record<OutputFormat, number> = { mp3: 3, wav: 1, ogg: 4, flac: 2 };
    const res = await fetch(DEFAULT_TTS_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer; ${token}`,
      },
      body: JSON.stringify({
        app: { appid: appId, token, cluster },
        user: { uid: 'voice-studio' },
        audio: {
          voice_type: speakerId,
          encoding: formatMap[req.outputFormat || 'mp3'],
          speed_ratio: req.speedRatio || 1.0,
          emotion: req.emotion || 'neutral',
        },
        request: {
          reqid: `${Date.now()}`,
          text: req.text,
          text_type: 'plain',
          operation: 'query',
        },
      }),
    });
    if (!res.ok) {
      return { success: false, message: `TTS 请求失败: ${res.status}` };
    }
    const data = await res.json();
    if (data?.code !== 3000) {
      return { success: false, message: data?.message || 'TTS 合成失败', code: 'TTS_FAIL' };
    }
    return {
      success: true,
      message: '合成成功',
      data: {
        generationId: `gen_${Date.now()}`,
        audioData: data?.data,
        duration: Number(data?.duration || 0),
        format: req.outputFormat || 'mp3',
        cost: req.text.length,
      },
    };
  } catch (err) {
    return { success: false, message: `火山引擎 TTS 异常: ${(err as Error).message}` };
  }
}

export default { clone, cloneStatus, tts };
