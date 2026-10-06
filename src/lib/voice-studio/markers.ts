// 统一语音标记解析器
// 将 [pause:500ms]、[emphasis:strong]...[/emphasis] 等标记
// 翻译成各引擎支持的格式
//
// 支持的标记语法：
//   [pause:500ms]     — 停顿 500 毫秒
//   [pause:1000ms]    — 停顿 1 秒
//   [emphasis:strong]文字[/emphasis] — 加强语气
//   [emphasis:moderate]文字[/emphasis] — 适度加强
//   [slow]文字[/slow] — 局部放慢
//   [fast]文字[/fast] — 局部加快

export type TTSEngine = string;

interface ParsedSegment {
  text: string;
  type: 'text' | 'pause' | 'emphasis' | 'slow' | 'fast';
  duration?: number; // for pause
  level?: string; // for emphasis
}

/** 解析标记文本为段落数组 */
export function parseMarkedText(input: string): ParsedSegment[] {
  const segments: ParsedSegment[] = [];
  const regex = /\[pause:(\d+)ms\]|\[emphasis:(\w+)\](.*?)\[\/emphasis\]|\[slow\](.*?)\[\/slow\]|\[fast\](.*?)\[\/fast\]/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(input)) !== null) {
    // 前面的普通文本
    if (match.index > lastIndex) {
      segments.push({ text: input.slice(lastIndex, match.index), type: 'text' });
    }

    if (match[1]) {
      // [pause:500ms]
      segments.push({ text: '', type: 'pause', duration: parseInt(match[1]) });
    } else if (match[2] && match[3]) {
      // [emphasis:strong]text[/emphasis]
      segments.push({ text: match[3], type: 'emphasis', level: match[2] });
    } else if (match[4]) {
      // [slow]text[/slow]
      segments.push({ text: match[4], type: 'slow' });
    } else if (match[5]) {
      // [fast]text[/fast]
      segments.push({ text: match[5], type: 'fast' });
    }

    lastIndex = regex.lastIndex;
  }

  // 剩余文本
  if (lastIndex < input.length) {
    segments.push({ text: input.slice(lastIndex), type: 'text' });
  }

  return segments;
}

/**
 * 根据引擎类型转换标记文本为该引擎支持的格式
 */
export function translateForEngine(input: string, engine: TTSEngine): {
  text: string;
  emotion?: string;
  speedAdjustments?: { text: string; ratio: number }[];
} {
  const segments = parseMarkedText(input);

  switch (engine) {
    case 'volcano':
      return translateForVolcano(segments);
    case 'cosyvoice':
      return translateForCosyVoice(segments);
    case 'elevenlabs':
    case 'openai_tts':
      return translateForBasicEngines(segments);
    case 'fish_audio':
      return translateForFishAudio(segments);
    case 'gpt_sovits':
      return translateForGPTSoVITS(segments);
    default:
      return translateForBasicEngines(segments);
  }
}

/** 火山引擎：用标点符号控制停顿，emotion 参数控制情感 */
function translateForVolcano(segments: ParsedSegment[]) {
  let text = '';
  let hasStrongEmphasis = false;

  for (const seg of segments) {
    switch (seg.type) {
      case 'text':
        text += seg.text;
        break;
      case 'pause':
        // 火山引擎用逗号控制短停顿，句号控制长停顿
        text += (seg.duration ?? 500) >= 1000 ? '。' : '，';
        break;
      case 'emphasis':
        // 用书名号或加粗标点模拟强调
        text += seg.text;
        if (seg.level === 'strong') hasStrongEmphasis = true;
        break;
      case 'slow':
        text += seg.text;
        break;
      case 'fast':
        text += seg.text;
        break;
    }
  }

  return {
    text,
    emotion: hasStrongEmphasis ? 'happy' : undefined,
  };
}

/** CosyVoice：支持 SSML break 标签 */
function translateForCosyVoice(segments: ParsedSegment[]) {
  let text = '';

  for (const seg of segments) {
    switch (seg.type) {
      case 'text':
        text += seg.text;
        break;
      case 'pause':
        text += `<break time="${seg.duration}ms"/>`;
        break;
      case 'emphasis':
        text += `<emphasis level="${seg.level || 'moderate'}">${seg.text}</emphasis>`;
        break;
      case 'slow':
        text += `<prosody rate="slow">${seg.text}</prosody>`;
        break;
      case 'fast':
        text += `<prosody rate="fast">${seg.text}</prosody>`;
        break;
    }
  }

  return { text };
}

/** Fish Audio：支持 prosody 标签 */
function translateForFishAudio(segments: ParsedSegment[]) {
  let text = '';

  for (const seg of segments) {
    switch (seg.type) {
      case 'text':
        text += seg.text;
        break;
      case 'pause':
        text += `，`;
        break;
      case 'emphasis':
        text += `<prosody pitch="high">${seg.text}</prosody>`;
        break;
      case 'slow':
        text += `<prosody rate="0.8">${seg.text}</prosody>`;
        break;
      case 'fast':
        text += `<prosody rate="1.3">${seg.text}</prosody>`;
        break;
    }
  }

  return { text };
}

/** ElevenLabs / OpenAI：只支持标点符号控制 */
function translateForBasicEngines(segments: ParsedSegment[]) {
  let text = '';

  for (const seg of segments) {
    switch (seg.type) {
      case 'text':
        text += seg.text;
        break;
      case 'pause':
        // 用省略号或逗号模拟停顿
        text += (seg.duration ?? 500) >= 1000 ? '... ' : ', ';
        break;
      case 'emphasis':
        // 大写表示强调（OpenAI/ElevenLabs 会对大写字母加重语气）
        text += seg.level === 'strong' ? seg.text.toUpperCase() : seg.text;
        break;
      case 'slow':
        // 用逗号分隔来模拟放慢
        text += seg.text.split('').join('') + ', ';
        break;
      case 'fast':
        text += seg.text;
        break;
    }
  }

  return { text };
}

/** GPT-SoVITS：参数控制 */
function translateForGPTSoVITS(segments: ParsedSegment[]) {
  let text = '';
  const speedAdjustments: { text: string; ratio: number }[] = [];

  for (const seg of segments) {
    switch (seg.type) {
      case 'text':
        text += seg.text;
        break;
      case 'pause':
        text += '，';
        break;
      case 'emphasis':
        text += seg.text;
        break;
      case 'slow':
        text += seg.text;
        speedAdjustments.push({ text: seg.text, ratio: 0.8 });
        break;
      case 'fast':
        text += seg.text;
        speedAdjustments.push({ text: seg.text, ratio: 1.3 });
        break;
    }
  }

  return { text, speedAdjustments };
}

/** 清除所有标记（用于显示纯文本） */
export function stripMarkers(input: string): string {
  return input
    .replace(/\[pause:\d+ms\]/g, '')
    .replace(/\[\/?emphasis:\w+\]/g, '')
    .replace(/\[\/?slow\]/g, '')
    .replace(/\[\/?fast\]/g, '');
}

/** 检查文本是否包含标记 */
export function hasMarkers(input: string): boolean {
  return /\[pause:\d+ms\]|\[emphasis:|\[slow\]|\[fast\]/.test(input);
}
