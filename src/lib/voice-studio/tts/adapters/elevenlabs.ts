// ElevenLabs 适配器
// 文档: https://elevenlabs.io/docs
import type {
  CloneRequest,
  CloneResponse,
  TTSRequest,
  TTSResponse,
  OutputFormat,
} from '../../types';

interface ElevenLabsConfig {
  apiKey: string;
  extraConfig: Record<string, string>;
}

const BASE_URL = 'https://api.elevenlabs.io/v1';

const FORMAT_MAP: Record<OutputFormat, string> = {
  mp3: 'mp3_44100_128',
  wav: 'pcm_44100',
  ogg: 'ogg_44100_128',
  flac: 'flac_44100',
  ogg_opus: 'ogg_44100_128',
  pcm: 'pcm_44100',
};

/**
 * 声音克隆 - ElevenLabs Instant Voice Clone
 */
export async function clone(
  req: CloneRequest,
  config: ElevenLabsConfig,
): Promise<CloneResponse> {
  try {
    if (!config.apiKey) {
      return { success: false, message: 'ElevenLabs 缺少 API Key' };
    }
    const formData = new FormData();
    formData.append('name', req.voiceName);
    formData.append('description', `Cloned voice for ${req.voiceName}`);
    const audioBlob = new Blob([Buffer.from(req.audioData, 'base64')], { type: `audio/${req.audioFormat}` });
    formData.append('files', audioBlob, `sample.${req.audioFormat}`);

    const res = await fetch(`${BASE_URL}/voices/add`, {
      method: 'POST',
      headers: {
        'xi-api-key': config.apiKey,
      },
      body: formData,
    });
    if (!res.ok) {
      return { success: false, message: `ElevenLabs 克隆请求失败: ${res.status}` };
    }
    const data = await res.json();
    return {
      success: true,
      message: '克隆完成，可立即使用',
      data: {
        cloneId: data?.voice_id || `eleven_${Date.now()}`,
        speakerId: data?.voice_id || '',
        status: 'ready',
        estimatedTime: 0,
      },
    };
  } catch (err) {
    return { success: false, message: `ElevenLabs 克隆异常: ${(err as Error).message}` };
  }
}

/**
 * 语音合成
 */
export async function tts(
  req: TTSRequest,
  speakerId: string,
  config: ElevenLabsConfig,
): Promise<TTSResponse> {
  try {
    if (!config.apiKey) {
      return { success: false, message: 'ElevenLabs 未配置 API Key' };
    }
    const model = config.extraConfig.model || 'eleven_multilingual_v2';
    const format = FORMAT_MAP[req.outputFormat || 'mp3'];
    const res = await fetch(
      `${BASE_URL}/text-to-speech/${speakerId}?output_format=${format}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'xi-api-key': config.apiKey,
        },
        body: JSON.stringify({
          text: req.text,
          model_id: model,
          voice_settings: {
            stability: 0.5,
            similarity_boost: 0.75,
            style: 0.0,
            use_speaker_boost: true,
            speed: req.speedRatio || 1.0,
          },
        }),
      },
    );
    if (!res.ok) {
      return { success: false, message: `ElevenLabs TTS 请求失败: ${res.status}` };
    }
    const audioBuffer = await res.arrayBuffer();
    const audioData = Buffer.from(audioBuffer).toString('base64');
    const duration = Math.ceil(req.text.length / 14); // 粗略估算
    return {
      success: true,
      message: '合成成功',
      data: {
        generationId: `gen_${Date.now()}`,
        audioData,
        duration,
        format: req.outputFormat || 'mp3',
        cost: req.text.length,
      },
    };
  } catch (err) {
    return { success: false, message: `ElevenLabs TTS 异常: ${(err as Error).message}` };
  }
}

export default { clone, tts };
