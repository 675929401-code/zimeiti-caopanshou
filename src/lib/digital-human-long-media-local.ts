import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import ffmpegStatic from 'ffmpeg-static';

const run = promisify(execFile);

function ffmpegPath() {
  const executable = process.env.FFMPEG_PATH?.trim() || ffmpegStatic || '';
  if (!executable) throw new Error('DIGITAL_HUMAN_LONG_FFMPEG_UNAVAILABLE');
  return executable;
}

export async function cutLongDigitalHumanMediaFiles(input: {
  videoPath: string;
  audioPath: string;
  videoDurationSeconds: number;
  startSeconds: number;
  durationSeconds: number;
  outputVideoPath: string;
  outputAudioPath: string;
}) {
  if (![input.videoDurationSeconds, input.startSeconds, input.durationSeconds].every(Number.isFinite)
      || input.videoDurationSeconds <= 2 || input.startSeconds < 0
      || input.durationSeconds <= 2 || input.durationSeconds > 115) {
    throw new Error('DIGITAL_HUMAN_LONG_CUT_RANGE_INVALID');
  }
  const videoOffset = input.startSeconds % input.videoDurationSeconds;
  await Promise.all([
    run(ffmpegPath(), [
      '-hide_banner', '-loglevel', 'error', '-y', '-stream_loop', '-1', '-ss', videoOffset.toFixed(3),
      '-i', input.videoPath, '-t', input.durationSeconds.toFixed(3), '-map', '0:v:0', '-an',
      '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
      input.outputVideoPath,
    ], { windowsHide: true, timeout: 10 * 60_000, maxBuffer: 2 * 1024 * 1024 }),
    run(ffmpegPath(), [
      '-hide_banner', '-loglevel', 'error', '-y', '-ss', input.startSeconds.toFixed(3),
      '-i', input.audioPath, '-t', input.durationSeconds.toFixed(3), '-map', '0:a:0', '-vn',
      '-ar', '24000', '-ac', '1', '-c:a', 'pcm_s16le', input.outputAudioPath,
    ], { windowsHide: true, timeout: 5 * 60_000, maxBuffer: 2 * 1024 * 1024 }),
  ]);
}

export async function mergeLongDigitalHumanVideoFiles(inputPaths: string[], outputPath: string) {
  if (inputPaths.length < 2 || inputPaths.length > 1000) throw new Error('DIGITAL_HUMAN_LONG_MERGE_INPUT_INVALID');
  const directory = path.dirname(outputPath);
  const normalized: string[] = [];
  for (const [index, source] of inputPaths.entries()) {
    const target = path.join(directory, `normalized-${String(index).padStart(4, '0')}.mp4`);
    await run(ffmpegPath(), [
      '-hide_banner', '-loglevel', 'error', '-y', '-i', source,
      '-map', '0:v:0', '-map', '0:a:0?', '-c:v', 'libx264', '-preset', 'veryfast',
      '-pix_fmt', 'yuv420p', '-r', '25', '-c:a', 'aac', '-ar', '48000', '-ac', '2',
      '-avoid_negative_ts', 'make_zero', target,
    ], { windowsHide: true, timeout: 15 * 60_000, maxBuffer: 4 * 1024 * 1024 });
    normalized.push(target);
  }
  const listPath = path.join(directory, 'concat-list.txt');
  const escapePath = (value: string) => value.replace(/'/gu, `'\\''`);
  await writeFile(listPath, normalized.map((item) => `file '${escapePath(item)}'`).join('\n'), 'utf8');
  await run(ffmpegPath(), [
    '-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', listPath,
    '-c', 'copy', '-movflags', '+faststart', outputPath,
  ], { windowsHide: true, timeout: 15 * 60_000, maxBuffer: 4 * 1024 * 1024 });
}

