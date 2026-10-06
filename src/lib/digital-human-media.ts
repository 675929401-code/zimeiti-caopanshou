import { mkdtemp, writeFile, unlink, rmdir, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import sharp from 'sharp';
import { resolveAppRuntimeDir } from '@/lib/runtime-paths';

const run = promisify(execFile);

const PACKAGED_FFPROBE_EXECUTABLE = process.platform === 'win32'
  ? 'runtime-tools\\ffprobe.exe'
  : 'runtime-tools/ffprobe';
const DEVELOPMENT_FFPROBE_EXECUTABLE = process.platform === 'win32'
  ? 'node_modules\\ffprobe-static\\bin\\win32\\x64\\ffprobe.exe'
  : process.platform === 'darwin'
    ? `node_modules/ffprobe-static/bin/darwin/${process.arch}/ffprobe`
    : `node_modules/ffprobe-static/bin/linux/${process.arch}/ffprobe`;

function ffprobeExecutable() {
  const configured = process.env.FFPROBE_PATH?.trim();
  if (configured) return configured;
  return process.env.NODE_ENV === 'production'
    ? PACKAGED_FFPROBE_EXECUTABLE
    : DEVELOPMENT_FFPROBE_EXECUTABLE;
}

type ProbeStream = {
  codec_type?: string;
  codec_name?: string;
  duration?: string | number;
  width?: number;
  height?: number;
  avg_frame_rate?: string;
  r_frame_rate?: string;
};
type ProbeOutput = { format?: { duration?: string | number }; streams?: ProbeStream[] };

function validateProbeMetadata(probe: ProbeOutput, category: 'audio' | 'video') {
  const stream = probe.streams?.find(item => item.codec_type === category);
  const duration = Number(probe.format?.duration || stream?.duration);
  const min = category === 'video' ? 2 : 1;
  const max = category === 'video' ? 350 : 240;
  if (!stream || !Number.isFinite(duration) || duration < min || duration > max) {
    throw new Error(`请上传 ${min}–${max} 秒的${category === 'video' ? '人物视频' : '配音音频'}，具体时长以所选模型要求为准`);
  }
  if (category === 'video' && (!stream.width || !stream.height || Math.min(stream.width, stream.height) < 640 || Math.max(stream.width, stream.height) > 2048)) {
    throw new Error('人物视频宽高须在 640–2048 像素之间');
  }
  if (category === 'video') {
    const [n, d] = String(stream.avg_frame_rate || stream.r_frame_rate || '').split('/').map(Number);
    const fps = n / (d || 1);
    if (!Number.isFinite(fps) || fps < 15 || fps > 60 || !['h264', 'hevc'].includes(String(stream.codec_name || ''))) {
      throw new Error('人物视频须为 H.264/H.265 编码、15–60 帧/秒');
    }
  }
  return { duration, width: Number(stream.width) || 0, height: Number(stream.height) || 0 };
}

async function probeMediaBuffer(buffer: Buffer, extension: string): Promise<ProbeOutput> {
  const base = path.join(/* turbopackIgnore: true */ resolveAppRuntimeDir(), 'digital-human-probe');
  await mkdir(base, { recursive: true });
  const directory = await mkdtemp(path.join(base, 'upload-'));
  const file = path.join(directory, `input${extension}`);
  try {
    await writeFile(file, buffer, { flag: 'wx' });
    const executable = ffprobeExecutable();
    const { stdout } = await run(executable, ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-show_format', '-show_streams', '-of', 'json', file], { windowsHide: true, timeout: 20_000, maxBuffer: 1024 * 1024 });
    return JSON.parse(stdout) as ProbeOutput;
  } finally { await unlink(file).catch(() => {}); await rmdir(directory).catch(() => {}); }
}

export async function mediaMetadata(buffer: Buffer, extension: string, category: 'image' | 'audio' | 'video') {
  if (category === 'image') {
    const info = await sharp(buffer, { limitInputPixels: 40_000_000 }).metadata();
    if (!Number(info.width) || !Number(info.height) || Number(info.width) < 256 || Number(info.height) < 256) throw new Error('人物图片宽高至少为 256 像素');
    return { width: Number(info.width), height: Number(info.height), duration: 0 };
  }
  return validateProbeMetadata(await probeMediaBuffer(buffer, extension), category);
}

/** Generated speech can exceed the digital-human upload limits. */
export async function probeGeneratedAudioDuration(buffer: Buffer, extension: string): Promise<number> {
  const probe = await probeMediaBuffer(buffer, extension);
  const stream = probe.streams?.find(item => item.codec_type === 'audio');
  const duration = Number(probe.format?.duration || stream?.duration);
  if (!stream || !Number.isFinite(duration) || duration <= 0) throw new Error('VOICE_RESULT_AUDIO_DURATION_INVALID');
  return duration;
}

/** Probe private COS media without buffering the complete object in Next.js. */
export async function mediaMetadataFromCosUrl(value: string, category: 'audio' | 'video') {
  const target = new URL(value);
  if (target.protocol !== 'https:' || !target.hostname.toLowerCase().endsWith('.myqcloud.com')) {
    throw new Error('素材验证地址无效');
  }
  const executable = ffprobeExecutable();
  const { stdout } = await run(executable, [
    '-v', 'error',
    // HTTPS may use the explicitly configured HTTP CONNECT proxy on this host.
    // Keep input URLs restricted to private COS HTTPS; never enable file/data here.
    '-protocol_whitelist', 'https,tls,tcp,httpproxy',
    '-show_format', '-show_streams', '-of', 'json',
    target.toString(),
  ], { windowsHide: true, timeout: 30_000, maxBuffer: 1024 * 1024 });
  return validateProbeMetadata(JSON.parse(stdout) as ProbeOutput, category);
}
