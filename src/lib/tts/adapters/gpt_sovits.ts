// GPT-SoVITS 适配器（自部署版本）
// 文档: https://github.com/RVC-Boss/GPT-SoVITS
import type {
  CloneRequest,
  CloneResponse,
  TTSRequest,
  TTSResponse,
} from '@/lib/types';

interface GPTSoVITSConfig {
  apiKey: string;
  extraConfig: Record<string, string>;
}

function baseUrl(config: GPTSoVITSConfig): string {
  const url = config.extraConfig.baseUrl || 'http://localhost:9880';
  return url.replace(/\/$/, '');
}

/**
 * 声音克隆 - GPT-SoVITS（本地训练，这里只做注册占位）
 */
export async function clone(
  req: CloneRequest,
  config: GPTSoVITSConfig,
): Promise<CloneResponse> {
  try {
    if (!config.extraConfig.baseUrl) {
      return { success: false, message: 'GPT-SoVITS 未配置服务地址' };
    }
    // GPT-SoVITS 通常需要本地训练，这里通过 API 触发训练任务
    const res = await fetch(`${baseUrl(config)}/clone_voice`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        voice_name: req.voiceName,
        audio_data: req.audioData,
        audio_format: req.audioFormat,
        language: req.language,
      }),
    });
    if (!res.ok) {
      return { success: false, message: `GPT-SoVITS 克隆请求失败: ${res.status}` };
    }
    const data = await res.json();
    return {
      success: true,
      message: '克隆任务已提交（本地训练）',
      data: {
        cloneId: data?.task_id || `gptsovits_${Date.now()}`,
        speakerId: req.voiceName,
        status: 'training',
        estimatedTime: 180,
      },
    };
  } catch (err) {
    return { success: false, message: `GPT-SoVITS 克隆异常: ${(err as Error).message}` };
  }
}

/**
 * 语音合成
 */
export async function tts(
  req: TTSRequest,
  speakerId: string,
  config: GPTSoVITSConfig,
): Promise<TTSResponse> {
  try {
    if (!config.extraConfig.baseUrl) {
      return { success: false, message: 'GPT-SoVITS 未配置服务地址' };
    }
    const res = await fetch(`${baseUrl(config)}/tts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: req.text,
        refer_wav_path: speakerId,
        prompt_text: '',
        prompt_language: 'zh',
        text_language: req.text.match(/[\u4e00-\u9fa5]/) ? 'zh' : 'en',
        speed: req.speedRatio || 1.0,
        emotion: req.emotion || 'neutral',
      }),
    });
    if (!res.ok) {
      return { success: false, message: `GPT-SoVITS TTS 请求失败: ${res.status}` };
    }
    const audioBuffer = await res.arrayBuffer();
    const audioData = Buffer.from(audioBuffer).toString('base64');
    return {
      success: true,
      message: '合成成功',
      data: {
        generationId: `gen_${Date.now()}`,
        audioData,
        duration: Math.ceil(req.text.length / 5),
        format: req.outputFormat || 'wav',
        cost: req.text.length,
      },
    };
  } catch (err) {
    return { success: false, message: `GPT-SoVITS TTS 异常: ${(err as Error).message}` };
  }
}

export default { clone, tts };
