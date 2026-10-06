export type UserVoiceKind = 'clone' | 'design';

export interface UserVoiceDto {
  /** Runtime voice identifier used by TTS and preview APIs. */
  id: string;
  /** Durable account record identifier used for owner-scoped management. */
  recordId: string;
  speakerId: string;
  name: string;
  description: string;
  category: '克隆' | '设计';
  tags: string[];
  styleTags: string[];
  gender: string;
  type: 'cloned' | 'designed';
  engine: string;
  language: string;
  demoAudioUrl?: string;
  createdAt?: string;
}

export interface UserVoiceRecord {
  id: string | number;
  voice_type: string;
  voice_name: string;
  speaker_id: string;
  language?: string | null;
  source_info?: unknown;
  created_at?: string | null;
  updated_at?: string | null;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function toUserVoiceDto(row: UserVoiceRecord): UserVoiceDto {
  const sourceInfo = record(row.source_info);
  const kind: UserVoiceKind = row.voice_type === 'clone' ? 'clone' : 'design';
  const speakerId = text(row.speaker_id);
  const category = kind === 'clone' ? '克隆' : '设计';
  const demoAudioUrl = text(sourceInfo.demoAudioUrl) || text(sourceInfo.demo_audio_url);

  return {
    id: speakerId,
    recordId: String(row.id),
    speakerId,
    name: text(row.voice_name) || (kind === 'clone' ? '我的克隆音色' : '我的设计音色'),
    description: text(sourceInfo.description) || `用户${category}音色`,
    category,
    tags: [category],
    styleTags: [category],
    gender: text(sourceInfo.gender) || 'neutral',
    type: kind === 'clone' ? 'cloned' : 'designed',
    engine: text(sourceInfo.engine) || 'volcano',
    language: text(row.language) || 'zh',
    ...(demoAudioUrl ? { demoAudioUrl } : {}),
    ...(text(row.created_at) ? { createdAt: text(row.created_at) } : {}),
  };
}
