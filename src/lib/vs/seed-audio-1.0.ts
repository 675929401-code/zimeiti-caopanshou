// Seed-Audio-1.0 音频生成模型接口封装
import { getActiveApiKey, generateRequestId, API_BASE } from './volcengine';

const MODEL = 'seed-audio-1.0';

export interface SeedAudioParams {
  textPrompt: string;           // 提示词（支持 @音频N 语法，最大3000字符）
  audioData?: string;           // 单个参考音频 base64
  audioUrl?: string;            // 单个参考音频 URL
  speaker?: string;             // 音色ID
  references?: Array<{          // 多个参考资源（speaker / audioData / audioUrl 互斥）
    speaker?: string;           // 音色ID（TTS2.0音色或复刻音色）
    audioData?: string;
    audioUrl?: string;
  }>;
  imageData?: string;           // 参考图片 base64
  imageUrl?: string;            // 参考图片 URL
  audioConfig?: {
    format?: string;            // mp3 / wav
    sampleRate?: number;        // 采样率
    speechRate?: number;
    loudnessRate?: number;
    pitchRate?: number;
    enableSubtitle?: boolean;
  };
}

export interface SeedAudioResult {
  audioUrl: string;
  audioBase64?: string;
  duration: number;             // 处理后时长（秒）
  originalDuration: number;     // 模型原始时长（秒），计费以此为准
  subtitles?: Array<{ text: string; startMs: number; endMs: number }>;
  logId?: string;
}

export async function generateAudio(params: SeedAudioParams): Promise<SeedAudioResult> {
  const apiKey = await getActiveApiKey();
  const requestId = generateRequestId();

  const body: Record<string, unknown> = { model: MODEL };

  // text_prompt（必填）
  if (!params.textPrompt) throw new Error('text_prompt 不能为空');
  body.text_prompt = params.textPrompt;

  // 参考音频（speaker / audio_data / audio_url 三种互斥）
  if (params.speaker) {
    body.speaker = params.speaker;
  } else if (params.audioData) {
    body.audio_data = params.audioData;
  } else if (params.audioUrl) {
    body.audio_url = params.audioUrl;
  }

  // 多个参考资源（每个 reference 中 speaker / audio_data / audio_url 互斥）
  if (params.references && params.references.length > 0) {
    const refs: Record<string, unknown>[] = [];
    for (const ref of params.references) {
      const r: Record<string, unknown> = {};
      if (ref.speaker) r.speaker = ref.speaker;
      else if (ref.audioData) r.audio_data = ref.audioData;
      else if (ref.audioUrl) r.audio_url = ref.audioUrl;
      if (Object.keys(r).length > 0) refs.push(r);
    }
    if (refs.length > 0) body.references = refs;
  }

  // 参考图片（不能与音频混用）
  if (params.imageData) {
    body.image_data = params.imageData;
  } else if (params.imageUrl) {
    body.image_url = params.imageUrl;
  }

  // 输出配置
  if (params.audioConfig && Object.keys(params.audioConfig).length > 0) {
    body.audio_config = params.audioConfig;
  }

  const response = await fetch(`${API_BASE}/api/v3/tts/create`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Api-Key': apiKey,
      'X-Api-Request-Id': requestId,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(300000), // 5分钟超时（生成最长120秒音频）
  });

  if (!response.ok) {
    const text = await response.text();
    let msg = `HTTP ${response.status}`;
    try { const j = JSON.parse(text); msg = j.message || msg; } catch {}
    throw new Error(msg);
  }

  const data = await response.json();

  // Seed-Audio-1.0 返回格式：{"audio":"base64wav...", "url":"https://...", "duration":xxx}
  // 没有外层 code 字段（与标准TTS不同）。优先用 url（CDN），兜底用 audio base64
  const logId = response.headers.get('X-Tt-Logid') || '';
  const audioBase64 = data.audio || '';
  const audioUrl = data.url || (audioBase64 ? `data:audio/wav;base64,${audioBase64}` : '');

  if (!audioUrl) {
    throw new Error('音频生成成功但返回为空，请检查 prompt 或重试。API返回: ' + JSON.stringify(data).slice(0, 200));
  }

  return {
    audioUrl,
    audioBase64,
    duration: data.duration || 0,
    originalDuration: data.original_duration || 0,
    subtitles: data.subtitle?.sentences || undefined,
    logId,
  };
}
