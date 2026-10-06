import { getVideoDurationCapabilities } from '@/lib/video-model-capabilities';

type Source = Record<string, unknown>;
export type HumanDurationChoice = '' | 'preserve_audio' | 'trim_audio';

/** Public facts only; the same limits are applied to each input on the server. */
export function humanDurationCapabilities(model: Source) {
  const config = (model.api_protocol_config || {}) as Source;
  const duration = getVideoDurationCapabilities(model);
  const retalk = model.protocol_type === 'dashscope_video_retalk';
  const wan = model.protocol_type === 'dashscope_wan_s2v';
  const volc = model.protocol_type === 'volcengine_digital_human';
  const omni = volc && config.req_key === 'jimeng_realman_avatar_picture_omni_v15';
  const volcLite = volc && String(config.req_key || 'realman_change_lips') === 'realman_change_lips';
  const maximum = Math.min(duration.maxDuration, retalk ? 120 : wan ? 20 : omni ? 60 : Infinity);
  return {
    humanInputMin: Math.max(duration.minDuration, retalk ? 2 : 0),
    humanInputMax: maximum,
    humanInputMinExclusive: retalk && duration.minDuration <= 2,
    humanInputMaxExclusive: retalk && maximum === 120 || wan && maximum === 20 || omni && maximum === 60,
    ...(volc && !omni ? {
      humanAudioMin: 1, humanAudioMinExclusive: true,
      humanAudioMax: Math.min(maximum, volcLite ? 240 : 210), humanAudioMaxExclusive: false,
      humanVideoMin: 3, humanVideoMax: 350,
    } : {}),
    supportsVideoExtension: retalk || volcLite,
    // The durable segmentation worker currently implements the Retalk protocol only.
    supportsLongVideoSegmentation: retalk,
    // Uploaded audio must meet the provider's own byte limit too.
    humanAudioMaxBytes: wan ? 15 * 1024 * 1024 - 1 : 30 * 1024 * 1024,
  };
}

function inputLimits(capabilities: Source, kind: 'audio' | 'video') {
  const prefix = kind === 'video' ? 'humanVideo' : 'humanAudio';
  return {
    min: Number(capabilities[prefix + 'Min'] ?? capabilities.humanInputMin ?? capabilities.minDuration ?? 2),
    max: Number(capabilities[prefix + 'Max'] ?? capabilities.humanInputMax ?? capabilities.maxDuration ?? 15),
    minExclusive: Boolean(capabilities[prefix + 'MinExclusive'] ?? capabilities.humanInputMinExclusive),
    maxExclusive: Boolean(capabilities[prefix + 'MaxExclusive'] ?? capabilities.humanInputMaxExclusive),
  };
}

export function humanDurationRange(capabilities: Source, kind: 'audio' | 'video' = 'audio') {
  const { min, max, minExclusive, maxExclusive } = inputLimits(capabilities, kind);
  const minText = minExclusive ? `大于 ${min}` : `至少 ${min}`;
  const maxText = maxExclusive ? `小于 ${max}` : `不超过 ${max}`;
  return `${minText} 秒、${maxText} 秒`;
}

export function planHumanDuration(capabilities: Source, mode: 'photo' | 'video', personSeconds: number, audioSeconds: number, choice: HumanDurationChoice = '', audioBytes = 0) {
  const inputs: ['audio' | 'video', number][] = mode === 'video' ? [['video', personSeconds], ['audio', audioSeconds]] : [['audio', audioSeconds]];
  const invalid = inputs.find(([kind, seconds]) => {
    const { min, max, minExclusive, maxExclusive } = inputLimits(capabilities, kind);
    return !Number.isFinite(seconds) || seconds <= 0 || (minExclusive ? seconds <= min : seconds < min) || (maxExclusive ? seconds >= max : seconds > max);
  });
  const base = { seconds: 0, videoExtension: false, needsChoice: false, lostAudioSeconds: 0, error: '', code: '' };
  if (invalid) {
    const over = invalid[1] >= inputLimits(capabilities, invalid[0]).max;
    return { ...base, code: 'DIGITAL_HUMAN_INPUT_DURATION', error: `${invalid[0] === 'video' ? '人物视频' : '配音'}为 ${Number.isFinite(invalid[1]) ? invalid[1].toFixed(1) : '未知'} 秒，当前模型要求${humanDurationRange(capabilities, invalid[0])}。${over ? '请将长素材按完整语句分段，分别生成后合并；系统不会自动截断或提交多次。' : '请调整素材时长。'}本次尚未提交，不收视频费。` };
  }
  if (audioBytes > Number(capabilities.humanAudioMaxBytes || Infinity)) return { ...base, code: 'DIGITAL_HUMAN_AUDIO_SIZE', error: '配音文件超过当前模型的大小限制，请压缩音频后再提交。本次不收视频费。' };
  const needsChoice = mode === 'video' && audioSeconds > personSeconds + 0.1;
  if (needsChoice && choice !== 'preserve_audio' && choice !== 'trim_audio') return { ...base, needsChoice, code: 'DIGITAL_HUMAN_DURATION_CHOICE', error: '配音长于人物视频，请先选择保留完整配音或按视频长度截短配音。' };
  if (needsChoice && choice === 'preserve_audio' && capabilities.supportsVideoExtension !== true) return { ...base, needsChoice, code: 'DIGITAL_HUMAN_EXTENSION_UNSUPPORTED', error: '当前模型不支持延展画面，请上传足够长的人物视频，或选择截短配音。' };
  const videoExtension = needsChoice && choice === 'preserve_audio';
  const seconds = mode === 'photo' || videoExtension ? audioSeconds : Math.min(personSeconds, audioSeconds);
  return { ...base, seconds, videoExtension, needsChoice, lostAudioSeconds: Math.max(0, audioSeconds - seconds) };
}

export function shouldSegmentHumanVideo(capabilities: Source | undefined, mode: string, audioSeconds: number) {
  return mode === 'video' && capabilities?.supportsLongVideoSegmentation === true && Number.isFinite(audioSeconds) && audioSeconds > 115;
}
