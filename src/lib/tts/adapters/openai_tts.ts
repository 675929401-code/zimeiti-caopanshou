// OpenAI TTS 适配器
// 文档: https://platform.openai.com/docs/guides/text-to-speech
import type {
  TTSRequest,
  TTSResponse,
  OutputFormat,
  TTSEngine,
} from '@/lib/types';

interface OpenAITTSConfig {
  apiKey: string;
  extraConfig: Record<string, string>;
}

const BASE_URL = 'https://api.openai.com/v1';

const FORMAT_MAP: Record<OutputFormat, string> = {
  mp3: 'mp3',
  wav: 'wav',
  ogg: 'opus',
  flac: 'flac',
};

const VOICE_MAP: Record<string, string> = {
  // OpenAI 预设6个音色
  alloy: 'alloy',
  echo: 'echo',
  fable: 'fable',
  onyx: 'onyx',
  nova: 'nova',
  shimmer: 'shimmer',
};

/**
 * 语音合成（OpenAI TTS 不支持克隆）
 */
export async function tts(
  req: TTSRequest,
  speakerId: string,
  config: OpenAITTSConfig,
): Promise<TTSResponse> {
  try {
    if (!config.apiKey) {
      return { success: false, message: 'OpenAI 未配置 API Key' };
    }
    const model = config.extraConfig.model || 'tts-1';
    const format = FORMAT_MAP[req.outputFormat || 'mp3'];
    const voice = VOICE_MAP[speakerId] || 'alloy';

    const res = await fetch(`${BASE_URL}/audio/speech`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model,
        input: req.text,
        voice,
        response_format: format,
        speed: req.speedRatio || 1.0,
      }),
    });
    if (!res.ok) {
      const errText = await res.text();
      return { success: false, message: `OpenAI TTS 请求失败: ${res.status} ${errText}` };
    }
    const audioBuffer = await res.arrayBuffer();
    const audioData = Buffer.from(audioBuffer).toString('base64');
    return {
      success: true,
      message: '合成成功',
      data: {
        generationId: `gen_${Date.now()}`,
        audioData,
        duration: Math.ceil(req.text.length / 15),
        format: req.outputFormat || 'mp3',
        cost: req.text.length,
      },
    };
  } catch (err) {
    return { success: false, message: `OpenAI TTS 异常: ${(err as Error).message}` };
  }
}

export default { tts };
