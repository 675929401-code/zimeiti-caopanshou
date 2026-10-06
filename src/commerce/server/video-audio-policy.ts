import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveFfmpegExecutable } from '@/lib/video-postprocess';
import { assetBytes, readAsset, validateMediaBytes } from './assets';

type DownloadedVideo = { bytes: Buffer; type: string };

function ffmpeg(args: string[], timeoutMs = 60_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(resolveFfmpegExecutable(), args, { windowsHide: true, shell: false, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      error ? reject(error) : resolve(stderr);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(Error('视频声音规则处理超时'));
    }, timeoutMs);
    child.stderr.on('data', (chunk: Buffer) => { stderr = `${stderr}${chunk.toString()}`.slice(-32_000); });
    child.on('error', error => finish(Error(`视频声音规则处理程序无法启动：${error.message}`)));
    child.on('close', code => finish(code === 0 ? undefined : Error(`视频声音规则处理失败（${code}）`)));
  });
}

function extension(type: string) {
  if (type === 'video/webm') return 'webm';
  if (type === 'video/quicktime') return 'mov';
  return 'mp4';
}

/** A silent request is enforced on the saved deliverable even when an upstream provider ignores its audio flag. */
export async function enforceVideoAudioPolicy(downloaded: DownloadedVideo, generateAudio: boolean | undefined): Promise<DownloadedVideo> {
  if (generateAudio !== false) return downloaded;
  if (!['video/mp4', 'video/webm', 'video/quicktime'].includes(downloaded.type)) throw Error('视频结果格式不支持声音规则处理');
  const suffix = extension(downloaded.type);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'commerce-video-audio-'));
  const input = path.join(directory, `input.${suffix}`);
  const output = path.join(directory, `silent.${suffix}`);
  try {
    await fs.writeFile(input, downloaded.bytes, { flag: 'wx', mode: 0o600 });
    await ffmpeg([
      '-hide_banner', '-nostdin', '-y', '-protocol_whitelist', 'file,pipe', '-i', input,
      '-map', '0:v:0', '-c:v', 'copy', '-an', '-map_metadata', '-1',
      ...(suffix === 'mp4' || suffix === 'mov' ? ['-movflags', '+faststart'] : []), output,
    ]);
    const bytes = await fs.readFile(output);
    validateMediaBytes(bytes, downloaded.type);
    return { bytes, type: downloaded.type };
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

export async function inspectSavedVideoAudioPolicy(owner: string, assetId: string) {
  const asset = readAsset(assetId, owner);
  if (!asset || !asset.type.startsWith('video/')) throw Error('视频 canary 结果资产不存在');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'commerce-video-probe-'));
  const input = path.join(directory, `input.${extension(asset.type)}`);
  try {
    const bytes = await assetBytes(asset);
    validateMediaBytes(bytes, asset.type);
    await fs.writeFile(input, bytes, { flag: 'wx', mode: 0o600 });
    const log = await ffmpeg(['-hide_banner', '-nostdin', '-i', input, '-map', '0:v:0', '-an', '-frames:v', '1', '-f', 'null', '-'], 30_000);
    const hasAudio = /Stream #0:\d+(?:\([^\r\n)]*\))?: Audio:/u.test(log);
    return { hasAudio, assetId: asset.id, mimeType: asset.type, bytes: asset.size };
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}
