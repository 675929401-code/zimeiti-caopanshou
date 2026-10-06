// Fish Audio 适配器
// 文档: https://docs.fish.audio
import type {
  CloneRequest,
  CloneResponse,
  TTSRequest,
  TTSResponse,
} from '../../types';

interface FishAudioConfig {
  apiKey: string;
  extraConfig: Record<string, string>;
}

function baseUrl(config: FishAudioConfig): string {
  return config.extraConfig.baseUrl || 'https://api.fish.audio';
}

/**
 * 声音克隆 - Fish Audio
 */
export async function clone(
  req: CloneRequest,
  config: FishAudioConfig,
): Promise<CloneResponse> {
  try {
    if (!config.apiKey) {
      return { success: false, message: 'Fish Audio 缺少 API Key' };
    }
    const res = await fetch(`${baseUrl(config)}/v1/tts/clone`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        name: req.voiceName,
        language: req.language,
        audio_data: req.audioData,
        audio_format: req.audioFormat,
      }),
    });
    if (!res.ok) {
      return { success: false, message: `Fish Audio 克隆请求失败: ${res.status}` };
    }
    const data = await res.json();
    return {
      success: true,
      message: '克隆任务已提交',
      data: {
        cloneId: data?.model_id || `fish_${Date.now()}`,
        speakerId: data?.model_id || '',
        status: 'ready',
        estimatedTime: 0,
      },
    };
  } catch (err) {
    return { success: false, message: `Fish Audio 克隆异常: ${(err as Error).message}` };
  }
}

/**
 * 语音合成
 */
export async function tts(
  req: TTSRequest,
  speakerId: string,
  config: FishAudioConfig,
): Promise<TTSResponse> {
  try {
    if (!config.apiKey) {
      return { success: false, message: 'Fish Audio 未配置 API Key' };
    }
    const res = await fetch(`${baseUrl(config)}/v1/tts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        text: req.text,
        reference_id: speakerId,
        format: req.outputFormat || 'mp3',
        speed: req.speedRatio || 1.0,
        emotion: req.emotion || 'neutral',
      }),
    });
    if (!res.ok) {
      return { success: false, message: `Fish Audio TTS 请求失败: ${res.status}` };
    }
    const audioBuffer = await res.arrayBuffer();
    const audioData = Buffer.from(audioBuffer).toString('base64');
    return {
      success: true,
      message: '合成成功',
      data: {
        generationId: `gen_${Date.now()}`,
        audioData,
        duration: Number(res.headers.get('x-audio-duration') || 0),
        format: req.outputFormat || 'mp3',
        cost: req.text.length,
      },
    };
  } catch (err) {
    return { success: false, message: `Fish Audio TTS 异常: ${(err as Error).message}` };
  }
}

export default { clone, tts };
