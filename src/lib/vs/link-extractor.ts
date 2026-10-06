/**
 * Convert an already-owned local extraction video into a clean mono WAV.
 * New voice flows resolve links through /api/extract before calling this code.
 */
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { resolveFfmpegExecutable } from '@/lib/video-postprocess';
import {
  REFERENCE_AUDIO_DEFAULT_DURATION_SECONDS,
  REFERENCE_AUDIO_MIN_DURATION_SECONDS,
  normalizeReferenceAudioDuration,
} from '@/lib/vs/reference-audio-contract';

const AUDIO_SAMPLE_RATE = 16_000;
const AUDIO_CHANNELS = 1;
const MAX_WAV_BYTES = 15 * 1024 * 1024;

function readWavDurationSeconds(wav: Buffer): number {
  if (wav.length < 44 || wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('处理后的参考音频格式无效');
  }
  let offset = 12;
  let byteRate = 0;
  let dataBytes = 0;
  while (offset + 8 <= wav.length) {
    const chunkId = wav.toString('ascii', offset, offset + 4);
    const chunkSize = wav.readUInt32LE(offset + 4);
    const chunkStart = offset + 8;
    if (chunkStart + chunkSize > wav.length) break;
    if (chunkId === 'fmt ' && chunkSize >= 12) byteRate = wav.readUInt32LE(chunkStart + 8);
    if (chunkId === 'data') { dataBytes = chunkSize; break; }
    offset = chunkStart + chunkSize + (chunkSize % 2);
  }
  if (!byteRate || !dataBytes) throw new Error('处理后的参考音频缺少有效音轨');
  return dataBytes / byteRate;
}

export interface LocalVideoAudioMetadata {
  title?: string;
  cover?: string;
  platform?: string;
}

export interface AudioProcessResult {
  wav: Buffer;
  duration: number;
  title: string;
  cover: string;
  platform: string;
}

async function runFfmpeg(inputPath: string, outputPath: string, duration: number): Promise<void> {
  const binary = resolveFfmpegExecutable();
  const args = [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-i', inputPath, '-t', String(duration),
    '-vn', '-ac', String(AUDIO_CHANNELS), '-ar', String(AUDIO_SAMPLE_RATE),
    '-sample_fmt', 's16', '-af', 'highpass=f=80,lowpass=f=7800,loudnorm', outputPath,
  ];

  await new Promise<void>((resolve, reject) => {
    const child = spawn(binary, args, { windowsHide: true });
    child.stdin.end();
    child.stdout.resume();
    let stderr = '';
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    timer = setTimeout(() => {
      child.kill();
      finish(new Error('音频预处理超时'));
    }, 45_000);
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < 2_000) stderr += chunk.toString('utf8');
    });
    child.once('error', (error: Error) => finish(error));
    child.once('close', (code: number | null) => {
      if (code === 0) finish();
      else finish(new Error(`音频预处理失败${stderr ? `：${stderr.trim().slice(0, 240)}` : ''}`));
    });
  });
}

export async function extractAudioFromLocalVideo(
  inputPath: string,
  requestedDuration: number = REFERENCE_AUDIO_DEFAULT_DURATION_SECONDS,
  metadata: LocalVideoAudioMetadata = {},
): Promise<AudioProcessResult> {
  const duration = normalizeReferenceAudioDuration(requestedDuration);
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'voice-reference-audio-'));
  const outputPath = path.join(tempDir, 'reference.wav');
  try {
    await runFfmpeg(inputPath, outputPath, duration);
    const wav = await readFile(outputPath);
    if (wav.length === 0 || wav.length > MAX_WAV_BYTES) {
      throw new Error('处理后的参考音频为空或超过 15MB 限制');
    }
    const actualDuration = readWavDurationSeconds(wav);
    if (actualDuration + 0.05 < REFERENCE_AUDIO_MIN_DURATION_SECONDS || actualDuration > 30.05) {
      throw new Error('原视频可用人声不足 14 秒，请选择更长的视频或上传 14-30 秒音频');
    }
    return {
      wav,
      duration: Math.round(Math.min(duration, actualDuration) * 100) / 100,
      title: String(metadata.title || '链接提取参考音频').trim().slice(0, 100),
      cover: String(metadata.cover || '').trim().slice(0, 2_000),
      platform: String(metadata.platform || '短视频').trim().slice(0, 40),
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
