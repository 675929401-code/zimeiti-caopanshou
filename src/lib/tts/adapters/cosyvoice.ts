// 阿里云 CosyVoice 适配器
// 文档: https://help.aliyun.com/zh/model-studio/developer-reference/cosyvoice
import type {
  CloneRequest,
  CloneResponse,
  TTSRequest,
  TTSResponse,
} from '@/lib/types';

interface CosyVoiceConfig {
  apiKey: string;
  extraConfig: Record<string, string>;
}

const BASE_URL = 'https://dashscope.aliyuncs.com/api/v1';

/**
 * 声音克隆 - CosyVoice
 */
export async function clone(
  req: CloneRequest,
  config: CosyVoiceConfig,
): Promise<CloneResponse> {
  try {
    if (!config.apiKey) {
      return { success: false, message: 'CosyVoice 缺少 DashScope API Key' };
    }
    const res = await fetch(`${BASE_URL}/services/audio/tts/voice-cloning`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
        'X-DashScope-Async': 'enable',
      },
      body: JSON.stringify({
        model: config.extraConfig.model || 'cosyvoice-v1',
        input: {
          action: 'create_task',
          voice_name: req.voiceName,
          audio_data: req.audioData,
          audio_format: req.audioFormat,
          language: req.language,
        },
      }),
    });
    if (!res.ok) {
      return { success: false, message: `CosyVoice 克隆请求失败: ${res.status}` };
    }
    const data = await res.json();
    if (data?.status !== 'PENDING' && !data?.output?.task_id) {
      return { success: false, message: data?.message || 'CosyVoice 克隆失败' };
    }
    return {
      success: true,
      message: '克隆任务已提交',
      data: {
        cloneId: data?.output?.task_id || `cosy_${Date.now()}`,
        speakerId: req.voiceName,
        status: 'training',
        estimatedTime: 90,
      },
    };
  } catch (err) {
    return { success: false, message: `CosyVoice 克隆异常: ${(err as Error).message}` };
  }
}

/**
 * 语音合成
 */
export async function tts(
  req: TTSRequest,
  speakerId: string,
  config: CosyVoiceConfig,
): Promise<TTSResponse> {
  try {
    if (!config.apiKey) {
      return { success: false, message: 'CosyVoice 未配置 API Key' };
    }
    const res = await fetch(`${BASE_URL}/services/audio/tts/text-to-speech`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.extraConfig.model || 'cosyvoice-v1',
        input: { text: req.text },
        parameters: {
          voice: speakerId,
          format: req.outputFormat || 'mp3',
          sample_rate: 22050,
          speed: req.speedRatio || 1.0,
          emotion: req.emotion || 'neutral',
        },
      }),
    });
    if (!res.ok) {
      return { success: false, message: `CosyVoice TTS 请求失败: ${res.status}` };
    }
    const data = await res.json();
    if (data?.code !== '200' && !data?.output?.audio) {
      return { success: false, message: data?.message || 'CosyVoice TTS 失败' };
    }
    return {
      success: true,
      message: '合成成功',
      data: {
        generationId: `gen_${Date.now()}`,
        audioData: data?.output?.audio?.data,
        audioUrl: data?.output?.audio?.url,
        duration: Number(data?.output?.duration || 0),
        format: req.outputFormat || 'mp3',
        cost: req.text.length,
      },
    };
  } catch (err) {
    return { success: false, message: `CosyVoice TTS 异常: ${(err as Error).message}` };
  }
}

export default { clone, tts };
