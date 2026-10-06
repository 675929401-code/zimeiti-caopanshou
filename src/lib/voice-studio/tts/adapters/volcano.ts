// 火山引擎语音适配器
// 文档: https://www.volcengine.com/docs/6561/79823
import type {
  CloneRequest,
  CloneResponse,
  TTSRequest,
  TTSResponse,
  OutputFormat,
} from '../../types';

interface VolcanoConfig {
  apiKey: string;
  extraConfig: Record<string, string>;
}

const DEFAULT_TTS_ENDPOINT = 'https://openspeech.bytedance.com/api/v1/tts';
const DEFAULT_CLONE_ENDPOINT = 'https://openspeech.bytedance.com/api/v1/mega_tts/audio/upload';

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
 */
export async function tts(
  req: TTSRequest,
  speakerId: string,
  config: VolcanoConfig,
): Promise<TTSResponse> {
  try {
    const token = config.apiKey;
    const appId = config.extraConfig.appId;
    const cluster = config.extraConfig.cluster || 'volcano_tts';
    if (!token || !appId) {
      return { success: false, message: '火山引擎未配置 Token 或 AppID' };
    }
    const formatMap: Record<OutputFormat, number> = { mp3: 3, wav: 1, ogg: 4, flac: 2, ogg_opus: 4, pcm: 1 };
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

// ─── 向后兼容 ───
export class VolcanoAdapter {
  async getCloneStatus(speakerId: string, config: any) {
    return cloneStatus(speakerId, config);
  }
  async clone(req: any, config: any) {
    return clone(req, config);
  }
  async tts(req: any, config: any) {
    return tts(req, '', config);
  }
}
