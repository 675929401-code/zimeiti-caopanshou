const API_BASE = process.env.VOLCENGINE_API_BASE || 'https://openspeech.bytedance.com';

// 资源ID → 对应的 model 默认值映射
// 注意：uranus 系列音色仅支持 standard，saturn/ICL 支持 expressive
// 实际 model 应通过 getDefaultModelBySpeaker(speakerId) 确定，此映射仅作兜底参考
const RESOURCE_ID_DEFAULT_MODEL: Record<string, string> = {
  'seed-tts-2.0': 'seed-tts-2.0-standard',  // 改为 standard（更安全，uranus/saturn 都兼容）
  'seed-tts-1.0': '',
  'seed-tts-1.0-concurr': '',
  'seed-icl-2.0': 'seed-tts-2.0-expressive',
  'seed-icl-1.0': '',
  'seed-icl-1.0-concurr': '',
};

async function getActiveApiKey(): Promise<string> {
  // 优先从环境变量读取火山引擎 API Key
  return process.env.VOLCENGINE_API_KEY_1 || '';
}

function generateRequestId(): string {
  return crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

// 通用请求：支持自定义 X-Api-Resource-Id
async function volcRequest(
  endpoint: string,
  body: Record<string, unknown>,
  options: { resourceId?: string; raw?: boolean } = {}
) {
  const apiKey = await getActiveApiKey();
  const requestId = generateRequestId();
  const resourceId = options.resourceId || 'seed-tts-2.0';

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Api-Key': apiKey,
    'X-Api-Resource-Id': resourceId,
    'X-Api-Request-Id': requestId,
  };

  const response = await fetch(`${API_BASE}${endpoint}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(300000), // 5 min timeout
  });

  // 统一用 text() 读取完整响应体，再 JSON 解析
  // 火山 unidirectional 是流式响应（NDJSON多行），每行一个JSON事件：
  //   第一行通常是头事件(含code/message)
  //   后续行包含 data(base64音频分片)、duration、url 等字段
  // 需要：①校验code ②拼接所有data分片 ③提取duration/url
  const rawText = await response.text();
  let data: any = null;
  let combinedBase64 = '';

  // 先尝试整体 JSON 解析（非流式响应的兜底）
  try {
    data = JSON.parse(rawText);
  } catch {
    // 流式 NDJSON 响应：按行解析并合并
    const lines = rawText.split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const evt = JSON.parse(line);
        // 错误码校验（code=0 或 20000000 表示成功）
        if (evt.code !== undefined && evt.code !== 20000000 && evt.code !== 0) {
          throw new Error(`火山合成错误: ${evt.message || ''} (code: ${evt.code})`);
        }
        // 拼接 base64 音频分片
        if (typeof evt.data === 'string' && evt.data.length > 0) {
          combinedBase64 += evt.data;
        }
        // 提取其他字段
        if (evt.url) data = data || {}, data.url = evt.url;
        if (evt.duration !== undefined) data = data || {}, data.duration = evt.duration;
        if (evt.original_duration !== undefined) data = data || {}, data.original_duration = evt.original_duration;
        if (evt.usage) data = data || {}, data.usage = evt.usage;
        if (evt.subtitles) data = data || {}, data.subtitles = evt.subtitles;
      } catch (e) {
        // 跳过非 JSON 行（可能是空行或心跳）
      }
    }
    // 流式响应：把拼接的 base64 放到 data.data
    if (combinedBase64 && !data) data = {};
    if (combinedBase64) data.data = combinedBase64;
  }

  if (!response.ok) {
    throw new Error(
      `火山引擎API HTTP错误: ${response.status} ${response.statusText} (logid: ${response.headers.get('X-Tt-Logid')}) body: ${rawText.slice(0, 200)}`
    );
  }

  // 检查业务错误码（code=0 或 code=20000000 表示成功）
  if (data && data.code !== undefined && data.code !== 20000000 && data.code !== 0) {
    throw new Error(
      `火山引擎API错误: ${data.message || response.statusText} (code: ${data.code}, logid: ${response.headers.get('X-Tt-Logid')})`
    );
  }

  return { data, logId: response.headers.get('X-Tt-Logid') };
}

// ============ 完整 additions 参数类型 ============
export interface TtsAdditions {
  // 文本处理
  silence_duration?: number;            // 0-30000ms
  enable_language_detector?: boolean;
  disable_markdown_filter?: boolean;
  disable_emoji_filter?: boolean;
  enable_latex_tn?: boolean;
  latex_parser?: 'v2';
  max_length_to_filter_parenthesis?: number;  // 0-100
  unsupported_char_ratio_thresh?: number;     // 0-1.0
  // 语种/方言
  explicit_language?: string;
  context_language?: string;
  explicit_dialect?: string;            // dongbei/shaanxi/sichuan
  // 静音裁剪（仅 TTS1.0/ICL1.0）
  mute_cut_threshold?: string;
  mute_cut_remain_ms?: string;
  // TTS2.0/ICL2.0 高级
  context_texts?: string[];             // 语音指令/标签Cot统一用此字段（格式 "[#指令#]"，仅第一个有效，不计费）
  section_id?: string;                  // 多轮会话ID
  // 缓存
  cache_config?: { text_type: 1; use_cache: boolean; use_segment_cache?: boolean };
  // 水印
  aigc_watermark?: boolean;
  aigc_metadata?: {
    enable: boolean;
    content_producer?: string;
    produce_id?: string;
    content_propagator?: string;
    propagate_id?: string;
  };
}

// ============ 完整 audio_params 类型 ============
export interface TtsAudioParams {
  format?: 'mp3' | 'wav' | 'pcm' | 'ogg_opus';
  sample_rate?: 8000 | 16000 | 22050 | 24000 | 32000 | 44100 | 48000;
  bit_rate?: number;
  emotion?: string;          // happy/sad/angry/surprised/neutral（仅部分音色支持）
  emotion_scale?: number;    // 1-5
  speech_rate?: number;      // -50 ~ 100（100=2.0倍速，-50=0.5倍速）
  loudness_rate?: number;    // -50 ~ 100
  enable_timestamp?: boolean; // 仅 TTS1.0/ICL1.0
  enable_subtitle?: boolean;  // 仅 TTS2.0/ICL2.0
}

// ============ 语音合成（完整参数版）============
export async function synthesizeSpeech(params: {
  text?: string;
  ssml?: string;
  speaker: string;
  model?: string;              // seed-tts-2.0-standard / seed-tts-2.0-expressive
  resourceId?: string;         // X-Api-Resource-Id
  audioParams?: TtsAudioParams;
  additions?: TtsAdditions;
  pitch?: number;              // -12 ~ 12（post_process.pitch）
}): Promise<{
  audioUrl: string;
  duration: number;
  originalDuration: number;
  tokensUsed?: number;
  subtitles?: Array<{ text: string; startMs: number; endMs: number }>;
  logId?: string;
}> {
  const {
    text,
    ssml,
    speaker,
    model = 'seed-tts-2.0-standard',
    resourceId = 'seed-tts-2.0',
    audioParams = {},
    additions,
    pitch = 0,
  } = params;

  if (!text && !ssml) {
    throw new Error('text 和 ssml 至少需要传入一个');
  }

  const reqParams: Record<string, any> = {
    speaker,
    model,
    audio_params: {
      format: audioParams.format || 'mp3',
      sample_rate: audioParams.sample_rate || 24000,
      speech_rate: audioParams.speech_rate ?? 0,
      loudness_rate: audioParams.loudness_rate ?? 0,
    },
    post_process: { pitch },
  };

  // 文本输入（ssml 优先，2.0音色不支持ssml但不报错）
  if (ssml) {
    reqParams.ssml = ssml;
  } else {
    reqParams.text = text;
  }

  // 可选 audio_params 字段
  if (audioParams.bit_rate !== undefined) reqParams.audio_params.bit_rate = audioParams.bit_rate;
  if (audioParams.emotion) reqParams.audio_params.emotion = audioParams.emotion;
  if (audioParams.emotion_scale !== undefined) reqParams.audio_params.emotion_scale = audioParams.emotion_scale;
  if (audioParams.enable_timestamp !== undefined) reqParams.audio_params.enable_timestamp = audioParams.enable_timestamp;
  if (audioParams.enable_subtitle !== undefined) reqParams.audio_params.enable_subtitle = audioParams.enable_subtitle;

  // 可选 additions（火山API要求 additions 是 JSON 字符串，不是 object）
  if (additions && Object.keys(additions).length > 0) {
    reqParams.additions = JSON.stringify(additions);
  }

  const body: Record<string, unknown> = {
    req_params: reqParams,
  };

  // 使用 HTTP Chunked 单向流式接口
  const { data, logId } = await volcRequest('/api/v3/tts/unidirectional', body, { resourceId });

  // 提取字幕信息（如果开启了 enable_subtitle）
  const subtitles: Array<{ text: string; startMs: number; endMs: number }> = [];
  const dataAny = data as any;
  if (Array.isArray(dataAny?.subtitles)) {
    for (const s of dataAny.subtitles) {
      subtitles.push({
        text: s.text || s.sentence || '',
        startMs: s.start_ms || s.begin_time || 0,
        endMs: s.end_ms || s.end_time || 0,
      });
    }
  }

  // 火山 unidirectional 接口返回 base64 音频数据（data.data），不是 URL
  // 同时兼容返回 URL 的情况（data.url）
  const audioUrl = dataAny?.url || dataAny?.data?.url || '';
  const audioBase64 = typeof dataAny?.data === 'string' ? dataAny.data : '';

  const finalAudioUrl = audioUrl || (audioBase64 ? `data:audio/mp3;base64,${audioBase64}` : '');
  if (!finalAudioUrl) {
    // 诊断信息：输出原始响应结构帮助排查
    const rawKeys = dataAny ? Object.keys(dataAny).join(',') : 'null';
    const rawDataPreview = dataAny ? JSON.stringify(dataAny).slice(0, 500) : 'null';
    throw new Error(
      `火山API返回成功但音频为空。speaker=${speaker}, model=${model}, resourceId=${resourceId}. ` +
      `响应字段: [${rawKeys}], 预览: ${rawDataPreview}. ` +
      `可能原因：1)音色未授权 2)model不匹配 3)context_texts不兼容. ` +
      `建议：检查API Key是否已授权该音色，或尝试 model=seed-tts-2.0-standard.`
    );
  }

  return {
    audioUrl: finalAudioUrl,
    duration: dataAny?.duration || 0,
    originalDuration: dataAny?.original_duration || 0,
    tokensUsed: dataAny?.usage?.total_tokens || dataAny?.usage?.text_words,
    subtitles: subtitles.length > 0 ? subtitles : undefined,
    logId: logId || undefined,
  };
}

// ============ 音频生成 (seed-audio-1.0) ============
export async function generateAudio(params: {
  textPrompt: string;
  model?: string;
  references?: Array<{ speaker?: string; audioData?: string; audioUrl?: string }>;
  format?: string;
  sampleRate?: number;
  pitchRate?: number;
  speechRate?: number;
  loudnessRate?: number;
}): Promise<{ audioUrl: string; duration: number; originalDuration: number }> {
  const {
    textPrompt,
    model = 'seed-audio-1.0',
    references,
    format = 'mp3',
    sampleRate = 48000,
    pitchRate = 0,
    speechRate = 0,
    loudnessRate = 0,
  } = params;

  const body: Record<string, unknown> = {
    model,
    text_prompt: textPrompt,
    audio_config: {
      format,
      sample_rate: sampleRate,
      pitch_rate: pitchRate,
      speech_rate: speechRate,
      loudness_rate: loudnessRate,
    },
  };

  if (references?.length) {
    body.references = references.map((ref) => ({
      speaker: ref.speaker,
      audio_data: ref.audioData,
      audio_url: ref.audioUrl,
    }));
  }

  const { data } = await volcRequest('/api/v3/tts/create', body);

  return {
    audioUrl: (data as any).url || '',
    duration: (data as any).duration || 0,
    originalDuration: (data as any).original_duration || 0,
  };
}

// ============ 声音复刻/克隆 ============
export async function cloneVoice(params: {
  speakerId: string;
  audioBase64: string;
  audioFormat: string;
  language?: number;
  text?: string;
  extraParams?: Record<string, unknown>;
}): Promise<{
  speakerId: string;
  status: number;
  availableTrainingTimes?: number;
  speakerStatus?: Array<{ modelType: number; demoAudio?: string }>;
}> {
  const { speakerId, audioBase64, audioFormat, language = 0, text, extraParams } = params;

  const body: Record<string, unknown> = {
    speaker_id: speakerId,
    audio: {
      data: audioBase64,
      format: audioFormat,
    },
    language,
  };

  if (text) body.text = text;
  if (extraParams) body.extra_params = extraParams;

  // 声音复刻接口用 seed-icl-2.0 resource_id
  const { data } = await volcRequest('/api/v3/tts/voice_clone', body, { resourceId: 'seed-icl-2.0' });

  return {
    speakerId: (data as any).speaker_id || speakerId,
    status: (data as any).status || 0,
    availableTrainingTimes: (data as any).available_training_times,
    speakerStatus: (data as any).speaker_status,
  };
}

// ============ 声音设计 ============
export async function designVoice(params: {
  speakerId: string;
  text: string;
  prompt: { textPrompt?: string; imageUrl?: string; imageBytes?: string };
  language?: number;
}): Promise<{
  speakerId: string;
  status: number;
  demoAudio?: string;
  availableTrainingTimes?: number;
}> {
  const { speakerId, text, prompt, language = 0 } = params;

  const promptObj: Record<string, unknown> = {};
  if (prompt.textPrompt) promptObj.text_prompt = prompt.textPrompt;

  if (prompt.imageUrl || prompt.imageBytes) {
    const imagePrompt: Record<string, unknown> = {};
    if (prompt.imageUrl) imagePrompt.image_url = prompt.imageUrl;
    if (prompt.imageBytes) imagePrompt.image_bytes = prompt.imageBytes;
    promptObj.image_prompt = imagePrompt;
  }

  const body: Record<string, unknown> = {
    speaker_id: speakerId,
    text,
    prompt: promptObj,
    language,
  };

  // 声音设计接口用 seed-icl-2.0 resource_id
  const { data } = await volcRequest('/api/v3/tts/voice_design', body, { resourceId: 'seed-icl-2.0' });

  return {
    speakerId: (data as any).speaker_id || speakerId,
    status: (data as any).status || 0,
    demoAudio: (data as any).demo_audio,
    availableTrainingTimes: (data as any).available_training_times,
  };
}

// ============ 查询音色状态 ============
export async function getVoiceStatus(
  speakerId: string,
  customSpeakerId?: string
): Promise<{
  status: number;
  speakerStatus: Array<{ modelType: number; demoAudio?: string }>;
  language?: number;
  createTime?: number;
}> {
  const body: Record<string, unknown> = { speaker_id: speakerId };
  if (customSpeakerId) body.custom_speaker_id = customSpeakerId;

  // 根据音色ID自动判断 resource_id
  // ICL 角色音色和用户复刻音色用 seed-icl-2.0，TTS官方音色（uranus/saturn）用 seed-tts-2.0
  const resourceId = (speakerId.startsWith('ICL_') || speakerId.startsWith('icl_') || speakerId.startsWith('S_'))
    ? 'seed-icl-2.0'
    : 'seed-tts-2.0';

  const { data } = await volcRequest('/api/v3/tts/get_voice', body, { resourceId });

  return {
    status: (data as any).status || 0,
    speakerStatus: (data as any).speaker_status || [],
    language: (data as any).language,
    createTime: (data as any).create_time,
  };
}

// ============ 升级复刻音色 ============
export async function upgradeVoice(speakerId: string, customSpeakerId?: string): Promise<{
  speakerId: string;
  status: number;
}> {
  const body: Record<string, unknown> = { speaker_id: speakerId };
  if (customSpeakerId) body.custom_speaker_id = customSpeakerId;

  const { data } = await volcRequest('/api/v3/tts/upgrade_voice', body, { resourceId: 'seed-icl-2.0' });

  return {
    speakerId: (data as any).speaker_id || speakerId,
    status: (data as any).status || 0,
  };
}

// ============ 长文本自动切分工具 ============
// 火山单次合成限制：5000字符。超过自动切分为多段，逐段合成后拼接。
export function splitLongText(text: string, maxCharsPerSegment = 4500): string[] {
  if (text.length <= maxCharsPerSegment) return [text];

  const segments: string[] = [];
  // 优先按段落切，再按句子切
  const paragraphs = text.split(/\n\n+/);

  let current = '';
  for (const para of paragraphs) {
    if ((current + '\n\n' + para).length > maxCharsPerSegment && current) {
      segments.push(current);
      current = para;
    } else {
      current = current ? current + '\n\n' + para : para;
    }

    // 单段仍然过长，按句号切
    while (current.length > maxCharsPerSegment) {
      const cut = current.lastIndexOf('。', maxCharsPerSegment);
      const cutPos = cut > maxCharsPerSegment * 0.5 ? cut + 1 : maxCharsPerSegment;
      segments.push(current.slice(0, cutPos));
      current = current.slice(cutPos);
    }
  }
  if (current) segments.push(current);
  return segments;
}

// ============ SSE 流式合成（音频边生成边播放）============
// 端点: POST /api/v3/tts/unidirectional/sse
// 返回 ReadableStream，前端用 fetch + ReadableStream 消费
export async function synthesizeSpeechSSE(params: {
  text?: string;
  ssml?: string;
  speaker: string;
  model?: string;
  resourceId?: string;
  audioParams?: TtsAudioParams;
  additions?: TtsAdditions;
  pitch?: number;
}): Promise<ReadableStream<Uint8Array>> {
  const {
    text, ssml, speaker,
    model = 'seed-tts-2.0-standard',
    resourceId = 'seed-tts-2.0',
    audioParams = {},
    additions,
    pitch = 0,
  } = params;

  if (!text && !ssml) throw new Error('text 和 ssml 至少需要传入一个');

  const apiKey = await getActiveApiKey();
  const requestId = generateRequestId();

  const reqParams: Record<string, any> = {
    speaker, model,
    audio_params: {
      format: audioParams.format || 'mp3',
      sample_rate: audioParams.sample_rate || 24000,
      speech_rate: audioParams.speech_rate ?? 0,
      loudness_rate: audioParams.loudness_rate ?? 0,
    },
    post_process: { pitch },
  };
  if (ssml) reqParams.ssml = ssml;
  else reqParams.text = text;
  if (audioParams.bit_rate !== undefined) reqParams.audio_params.bit_rate = audioParams.bit_rate;
  if (audioParams.emotion) reqParams.audio_params.emotion = audioParams.emotion;
  if (audioParams.emotion_scale !== undefined) reqParams.audio_params.emotion_scale = audioParams.emotion_scale;
  if (audioParams.enable_subtitle !== undefined) reqParams.audio_params.enable_subtitle = audioParams.enable_subtitle;
  if (additions && Object.keys(additions).length > 0) reqParams.additions = JSON.stringify(additions);

  const body = JSON.stringify({ req_params: reqParams });

  const response = await fetch(`${API_BASE}/api/v3/tts/unidirectional/sse`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Api-Key': apiKey,
      'X-Api-Resource-Id': resourceId,
      'X-Api-Request-Id': requestId,
    },
    body,
    signal: AbortSignal.timeout(300000),
  });

  if (!response.ok || !response.body) {
    const errText = await response.text().catch(() => '');
    throw new Error(`SSE请求失败: ${response.status} ${response.statusText} ${errText.slice(0, 200)}`);
  }

  // 将火山的SSE流转换为前端可消费的SSE流
  // 火山SSE事件格式: event: 352\ndata: {"data":"base64..."}\n\n
  // 我们转发原始SSE流，前端用EventSource或ReadableStream解析
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const reader = response.body.getReader();
  let buffer = '';
  let audioBase64 = '';

  return new ReadableStream({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        // 流结束，发送完成事件
        controller.enqueue(encoder.encode(`event: done\ndata: ${JSON.stringify({ audioBase64: audioBase64.slice(0, 50) + '...', length: audioBase64.length })}\n\n`));
        controller.close();
        return;
      }

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (line.startsWith('event:')) {
          const eventType = line.slice(6).trim();
          // 351=TTSSentenceEnd, 352=TTSResponse(音频), 152=SessionFinish, 153=SessionFailed
          if (eventType === '153') {
            controller.enqueue(encoder.encode(`event: error\ndata: ${JSON.stringify({ error: 'SessionFailed' })}\n\n`));
            controller.close();
            return;
          }
          controller.enqueue(encoder.encode(line + '\n'));
        } else if (line.startsWith('data:')) {
          const dataStr = line.slice(5).trim();
          if (dataStr) {
            try {
              const evt = JSON.parse(dataStr);
              if (evt.code !== undefined && evt.code !== 20000000 && evt.code !== 0) {
                controller.enqueue(encoder.encode(`event: error\ndata: ${JSON.stringify({ error: evt.message || '合成失败', code: evt.code })}\n\n`));
                controller.close();
                return;
              }
              // 收集音频base64分片
              if (typeof evt.data === 'string' && evt.data.length > 0) {
                audioBase64 += evt.data;
              }
            } catch {}
          }
          controller.enqueue(encoder.encode(line + '\n'));
        } else if (line === '') {
          controller.enqueue(encoder.encode('\n'));
        } else {
          controller.enqueue(encoder.encode(line + '\n'));
        }
      }
    },
    cancel() {
      reader.cancel();
    },
  });
}

// ============ 异步长文本合成 - 提交任务 ============
// 端点: POST /api/v3/tts/submit (支持10万字)
// 鉴权: X-Api-App-Id + X-Api-Access-Key (旧版鉴权)
export async function submitLongTextTask(params: {
  text: string;
  speaker: string;
  model?: string;
  resourceId?: string;
  audioParams?: TtsAudioParams;
  additions?: TtsAdditions;
  uid?: string;
}): Promise<{ taskId: string; taskStatus: number; reqTextLength: number }> {
  const {
    text, speaker,
    model = 'seed-tts-2.0-standard',
    resourceId = 'seed-tts-2.0',
    audioParams = {},
    additions,
    uid = 'web_user',
  } = params;

  const apiKey = await getActiveApiKey();

  const reqParams: Record<string, any> = {
    text, speaker, model,
    audio_params: {
      format: audioParams.format || 'mp3',
      sample_rate: audioParams.sample_rate || 24000,
      speech_rate: audioParams.speech_rate ?? 0,
      loudness_rate: audioParams.loudness_rate ?? 0,
    },
  };
  if (audioParams.emotion) reqParams.audio_params.emotion = audioParams.emotion;
  if (audioParams.emotion_scale !== undefined) reqParams.audio_params.emotion_scale = audioParams.emotion_scale;
  if (audioParams.enable_timestamp !== undefined) reqParams.audio_params.enable_timestamp = audioParams.enable_timestamp;
  if (additions && Object.keys(additions).length > 0) reqParams.additions = JSON.stringify(additions);

  const body = JSON.stringify({
    user: { uid },
    unique_id: generateRequestId(),
    req_params: reqParams,
  });

  const response = await fetch(`${API_BASE}/api/v3/tts/submit`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Api-Key': apiKey,
      'X-Api-Resource-Id': resourceId,
      'X-Api-Request-Id': generateRequestId(),
    },
    body,
    signal: AbortSignal.timeout(30000),
  });

  const data = await response.json();
  if (data.code !== 20000000 && data.code !== 0) {
    throw new Error(`异步任务提交失败: ${data.message || ''} (code: ${data.code})`);
  }

  return {
    taskId: data.data?.task_id || '',
    taskStatus: data.data?.task_status || 0,
    reqTextLength: data.data?.req_text_length || text.length,
  };
}

// ============ 异步长文本合成 - 查询结果 ============
// 端点: POST /api/v3/tts/query
// taskStatus: 1=Running, 2=Success, 3=Failure
export async function queryLongTextTask(taskId: string): Promise<{
  taskStatus: number;
  audioUrl?: string;
  sentences?: Array<{ text: string; startTime: number; endTime: number; words?: Array<{ word: string; startTime: number; endTime: number; confidence: number }> }>;
  reqTextLength?: number;
  synthesizeTextLength?: number;
  urlExpireTime?: number;
}> {
  const apiKey = await getActiveApiKey();

  const response = await fetch(`${API_BASE}/api/v3/tts/query`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Api-Key': apiKey,
      'X-Api-Resource-Id': 'seed-tts-2.0',
      'X-Api-Request-Id': generateRequestId(),
    },
    body: JSON.stringify({ task_id: taskId }),
    signal: AbortSignal.timeout(15000),
  });

  const data = await response.json();
  if (data.code !== 20000000 && data.code !== 0) {
    throw new Error(`任务查询失败: ${data.message || ''} (code: ${data.code})`);
  }

  return {
    taskStatus: data.data?.task_status || 0,
    audioUrl: data.data?.audio_url,
    sentences: data.data?.sentences,
    reqTextLength: data.data?.req_text_length,
    synthesizeTextLength: data.data?.synthesize_text_length,
    urlExpireTime: data.data?.url_expire_time,
  };
}

// ============ 混音合成 ============
// 端点: POST /api/v3/tts/unidirectional (同合成接口，speaker设为custom_mix_bigtts)
// 限制: 仅TTS 1.0音色支持，最多3个音色，mix_factor之和=1
export async function synthesizeMixSpeech(params: {
  text: string;
  speakers: Array<{ sourceSpeaker: string; mixFactor: number }>;
  resourceId?: string;
  audioParams?: TtsAudioParams;
}): Promise<{ audioUrl: string; duration: number }> {
  const { text, speakers, resourceId = 'seed-tts-1.0', audioParams = {} } = params;

  if (speakers.length < 2 || speakers.length > 3) {
    throw new Error('混音需要2-3个音色');
  }
  const factorSum = speakers.reduce((sum, s) => sum + s.mixFactor, 0);
  if (Math.abs(factorSum - 1) > 0.001) {
    throw new Error(`混音因子之和必须为1，当前为${factorSum.toFixed(3)}`);
  }

  const apiKey = await getActiveApiKey();

  const reqParams: Record<string, any> = {
    text,
    speaker: 'custom_mix_bigtts',
    audio_params: {
      format: audioParams.format || 'mp3',
      sample_rate: audioParams.sample_rate || 24000,
      speech_rate: audioParams.speech_rate ?? 0,
      loudness_rate: audioParams.loudness_rate ?? 0,
    },
    mix_speaker: {
      speakers: speakers.map(s => ({
        source_speaker: s.sourceSpeaker,
        mix_factor: s.mixFactor,
      })),
    },
  };

  const body = JSON.stringify({ req_params: reqParams });

  const response = await fetch(`${API_BASE}/api/v3/tts/unidirectional`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Api-Key': apiKey,
      'X-Api-Resource-Id': resourceId,
      'X-Api-Request-Id': generateRequestId(),
    },
    body,
    signal: AbortSignal.timeout(300000),
  });

  const rawText = await response.text();
  let combinedBase64 = '';
  let duration = 0;

  try {
    const data = JSON.parse(rawText);
    if (data.code !== undefined && data.code !== 20000000 && data.code !== 0) {
      throw new Error(`混音合成错误: ${data.message || ''} (code: ${data.code})`);
    }
    if (typeof data.data === 'string') combinedBase64 = data.data;
    duration = data.duration || 0;
  } catch {
    const lines = rawText.split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const evt = JSON.parse(line);
        if (evt.code !== undefined && evt.code !== 20000000 && evt.code !== 0) {
          throw new Error(`混音合成错误: ${evt.message || ''} (code: ${evt.code})`);
        }
        if (typeof evt.data === 'string') combinedBase64 += evt.data;
        if (evt.duration) duration = evt.duration;
      } catch (e) {
        if (e instanceof Error && e.message.includes('合成错误')) throw e;
      }
    }
  }

  if (!combinedBase64) throw new Error('混音合成返回空音频');
  return {
    audioUrl: `data:audio/mp3;base64,${combinedBase64}`,
    duration,
  };
}

// ============ 状态枚举映射 ============
export const VOICE_STATUS_MAP: Record<number, string> = {
  0: 'NotFound',
  1: 'Training',
  2: 'Success',
  3: 'Failed',
  4: 'Active',
};

export const MODEL_TYPE_MAP: Record<number, string> = {
  1: 'ICL V1',
  2: 'DiT Standard',
  3: 'DiT Premium',
  4: 'ICL V2',
  5: 'ICL V3',
};

// ============ 错误码本地化 ============
export const ERROR_CODE_MAP: Record<string, string> = {
  '20000000': '合成成功',
  '40402003': '文本长度超过限制（单段最长 5000 字符）',
  '45000000': '音色鉴权失败：speaker 未授权或音色 ID 错误',
  '45001001': '请求参数有误：请检查必填字段和枚举值',
  '45001123': '达到音色设计次数上限，请更换 speaker_id',
  '55000000': '火山服务端错误，请稍后重试',
  '55001308': '音色设计失败（下游超时），请重试',
};

export function localizeError(error: Error): string {
  const msg = error.message || '';
  // 匹配 code: xxx
  const codeMatch = msg.match(/code:\s*(\d+)/);
  if (codeMatch && ERROR_CODE_MAP[codeMatch[1]]) {
    return `${ERROR_CODE_MAP[codeMatch[1]]}（原始错误：${msg}）`;
  }
  return msg;
}
