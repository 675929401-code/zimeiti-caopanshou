import { mkdir, mkdtemp, writeFile, readFile, unlink, rmdir } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { safeFetch } from '@/lib/safe-fetch';
import { resolveAppRuntimeDir } from '@/lib/runtime-paths';
import { resolveFfmpegExecutable } from '@/lib/video-postprocess';
import { probeGeneratedAudioDuration } from '@/lib/digital-human-media';

const run = promisify(execFile);
const MAX_BYTES = 50 * 1024 * 1024;
export type JoinedVoicePart = { audioUrl: string; subtitles?: Array<{ text: string; startMs: number; endMs: number }> };

export async function joinVoiceAudio(parts: JoinedVoicePart[], format = 'mp3', sampleRate = 24000) {
  if (!parts.length || parts.length > 2) throw new Error('VOICE_JOIN_PART_COUNT_INVALID');
  const output = ({ mp3: { extension: 'mp3', mime: 'audio/mpeg', codec: 'libmp3lame' }, wav: { extension: 'wav', mime: 'audio/wav', codec: 'pcm_s16le' }, ogg_opus: { extension: 'ogg', mime: 'audio/ogg', codec: 'libopus' } } as const)[format as 'mp3' | 'wav' | 'ogg_opus'];
  if (!output || ![8000, 16000, 22050, 24000, 32000, 44100, 48000].includes(sampleRate)) throw new Error('VOICE_JOIN_FORMAT_INVALID');
  if (format === 'ogg_opus' && ![8000, 16000, 24000, 48000].includes(sampleRate)) throw new Error('OGG音频请选择8、16、24或48kHz采样率');
  const base = path.join(/* turbopackIgnore: true */ resolveAppRuntimeDir(), 'voice-audio-join');
  await mkdir(base, { recursive: true });
  const directory = await mkdtemp(path.join(base, 'job-'));
  const files: string[] = [];
  const durations: number[] = [];
  const subtitles: Array<{ text: string; startMs: number; endMs: number }> = [];
  try {
    for (const part of parts) {
      const data = /^data:(audio\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/iu.exec(part.audioUrl);
      let buffer: Buffer;
      if (data) {
        if (data[2].length > MAX_BYTES * 1.4) throw new Error('VOICE_JOIN_INPUT_TOO_LARGE');
        buffer = Buffer.from(data[2], 'base64');
      } else {
        const downloaded = await safeFetch(part.audioUrl, { maxBytes: MAX_BYTES, timeoutMs: 30000, maxRedirects: 3 });
        buffer = downloaded.buffer;
      }
      if (!buffer.length || buffer.length > MAX_BYTES) throw new Error('VOICE_JOIN_INPUT_SIZE_INVALID');
      const duration = await probeGeneratedAudioDuration(buffer, '.audio');
      const offsetMs = Math.round(durations.reduce((sum, seconds) => sum + seconds, 0) * 1000);
      for (const subtitle of part.subtitles || []) {
        if (Number.isFinite(subtitle.startMs) && Number.isFinite(subtitle.endMs)) subtitles.push({ ...subtitle, startMs: subtitle.startMs + offsetMs, endMs: subtitle.endMs + offsetMs });
      }
      durations.push(duration);
      const file = path.join(directory, 'part-' + files.length + '.audio');
      files.push(file);
      await writeFile(file, buffer, { flag: 'wx' });
    }
    const file = path.join(directory, 'joined.' + output.extension);
    const args = ['-nostdin', '-v', 'error', '-threads', '1'];
    for (const input of files) args.push('-protocol_whitelist', 'file,pipe', '-i', input);
    const inputs = files.map((_, index) => '[' + index + ':a]aresample=' + sampleRate + ',aformat=channel_layouts=mono[a' + index + ']');
    const labels = files.map((_, index) => '[a' + index + ']').join('');
    args.push('-filter_complex_threads', '1', '-filter_complex', inputs.join(';') + ';' + labels + 'concat=n=' + files.length + ':v=0:a=1[out]', '-map', '[out]', '-c:a', output.codec, '-ar', String(sampleRate), '-ac', '1', '-threads', '1', '-fs', String(MAX_BYTES), file);
    files.push(file);
    await run(resolveFfmpegExecutable(), args, { windowsHide: true, timeout: 120000, maxBuffer: 1024 * 1024 });
    const buffer = await readFile(file);
    if (buffer.length >= MAX_BYTES) throw new Error('VOICE_JOIN_OUTPUT_TOO_LARGE');
    const duration = await probeGeneratedAudioDuration(buffer, '.' + output.extension);
    const expected = durations.reduce((sum, seconds) => sum + seconds, 0);
    if (Math.abs(duration - expected) > Math.max(0.4, expected * 0.015)) throw new Error('VOICE_JOIN_DURATION_MISMATCH');
    return { audioUrl: 'data:' + output.mime + ';base64,' + buffer.toString('base64'), duration, partDurations: durations, subtitles };
  } catch (error) {
    if (error instanceof Error && /^VOICE_JOIN_|^VOICE_RESULT_AUDIO_DURATION_INVALID|^OGG音频/u.test(error.message)) throw error;
    throw new Error('双人音频合并暂未完成，请稍后重试；本次失败费用会自动退回');
  } finally {
    for (const file of files) await unlink(file).catch(() => {});
    await rmdir(directory).catch(() => {});
  }
}
