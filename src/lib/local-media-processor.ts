import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runFfmpeg } from "@/lib/video-postprocess";

export type LocalMediaAction =
  | "trim"
  | "concat"
  | "mute"
  | "extract-audio"
  | "replace-audio"
  | "subtitle-region"
  | "gif";

export type SubtitleRegion = "bottom" | "middle-bottom" | "middle-top" | "top";

export interface LocalMediaInput {
  bytes: Buffer;
  extension: string;
}

export interface LocalMediaProcessOptions {
  action: LocalMediaAction;
  inputs: LocalMediaInput[];
  audio?: LocalMediaInput;
  startSeconds?: number;
  endSeconds?: number;
  subtitleRegion?: SubtitleRegion;
  targetWidth?: number;
  targetHeight?: number;
}

export interface LocalMediaProcessResult {
  bytes: Buffer;
  contentType: string;
  extension: string;
  filename: string;
}

const REGION_FILTERS: Record<SubtitleRegion, { cropY: string; overlayY: string }> = {
  top: { cropY: "0", overlayY: "0" },
  "middle-top": { cropY: "ih/4", overlayY: "main_h/4" },
  "middle-bottom": { cropY: "ih/2", overlayY: "main_h/2" },
  bottom: { cropY: "3*ih/4", overlayY: "main_h-overlay_h" },
};

function safeNumber(value: number | undefined, fallback: number, min: number, max: number) {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Number(value)));
}

function safeEvenDimension(value: number | undefined, fallback: number) {
  const bounded = Math.round(safeNumber(value, fallback, 240, 3_840));
  return bounded % 2 === 0 ? bounded : bounded - 1;
}

async function hasAudioStream(inputPath: string): Promise<boolean> {
  try {
    await runFfmpeg([
      "-hide_banner", "-loglevel", "error", "-i", inputPath,
      "-map", "0:a:0", "-t", "0.05", "-f", "null", "-",
    ], 30_000);
    return true;
  } catch {
    return false;
  }
}

function subtitleFilterPath(filePath: string): string {
  return filePath
    .replace(/\\/g, "/")
    .replace(/:/g, "\\:")
    .replace(/'/g, "\\'");
}

async function writeInput(directory: string, input: LocalMediaInput, index: number) {
  const extension = /^\.[a-z0-9]{1,10}$/i.test(input.extension) ? input.extension : ".bin";
  const target = path.join(directory, `input-${index}${extension}`);
  await fs.writeFile(target, input.bytes);
  return target;
}

export async function processLocalMedia(options: LocalMediaProcessOptions): Promise<LocalMediaProcessResult> {
  if (!options.inputs.length) throw new Error("至少需要一个视频文件");
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "local-media-"));

  try {
    const inputPaths = await Promise.all(options.inputs.map((input, index) => writeInput(tempDir, input, index)));
    const action = options.action;
    let outputPath = path.join(tempDir, "output.mp4");
    let contentType = "video/mp4";
    let extension = ".mp4";
    let filename = `本地媒体-${Date.now()}.mp4`;

    if (action === "trim") {
      const start = safeNumber(options.startSeconds, 0, 0, 14_400);
      const end = safeNumber(options.endSeconds, start + 5, start + 0.1, 14_400);
      await runFfmpeg([
        "-y", "-ss", String(start), "-i", inputPaths[0], "-t", String(end - start),
        "-map", "0:v:0", "-map", "0:a?", "-c:v", "libx264", "-preset", "veryfast",
        "-crf", "20", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", outputPath,
      ]);
      filename = `裁剪视频-${Date.now()}.mp4`;
    } else if (action === "mute") {
      await runFfmpeg([
        "-y", "-i", inputPaths[0], "-map", "0:v:0", "-c:v", "libx264", "-preset", "veryfast",
        "-crf", "20", "-an", "-movflags", "+faststart", outputPath,
      ]);
      filename = `静音视频-${Date.now()}.mp4`;
    } else if (action === "extract-audio") {
      outputPath = path.join(tempDir, "output.mp3");
      contentType = "audio/mpeg";
      extension = ".mp3";
      filename = `提取音频-${Date.now()}.mp3`;
      await runFfmpeg(["-y", "-i", inputPaths[0], "-vn", "-c:a", "libmp3lame", "-q:a", "2", outputPath]);
    } else if (action === "replace-audio") {
      if (!options.audio) throw new Error("音视频合成需要一个音频文件");
      const audioPath = await writeInput(tempDir, options.audio, 999);
      await runFfmpeg([
        "-y", "-i", inputPaths[0], "-i", audioPath, "-map", "0:v:0", "-map", "1:a:0",
        "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-shortest", "-movflags", "+faststart", outputPath,
      ]);
      filename = `音视频合成-${Date.now()}.mp4`;
    } else if (action === "subtitle-region") {
      const region = REGION_FILTERS[options.subtitleRegion || "bottom"];
      const filter = `[0:v]split[base][blur];[blur]crop=iw:ih/4:0:${region.cropY},gblur=sigma=22[patch];[base][patch]overlay=0:${region.overlayY}[outv]`;
      await runFfmpeg([
        "-y", "-i", inputPaths[0], "-filter_complex", filter, "-map", "[outv]", "-map", "0:a?",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-c:a", "aac",
        "-movflags", "+faststart", outputPath,
      ]);
      filename = `固定区域去字幕-${Date.now()}.mp4`;
    } else if (action === "gif") {
      outputPath = path.join(tempDir, "output.gif");
      contentType = "image/gif";
      extension = ".gif";
      filename = `动态封面-${Date.now()}.gif`;
      const start = safeNumber(options.startSeconds, 0, 0, 14_400);
      const end = safeNumber(options.endSeconds, start + 3, start + 0.5, start + 6);
      await runFfmpeg([
        "-y", "-ss", String(start), "-i", inputPaths[0], "-t", String(end - start),
        "-filter_complex", "fps=8,scale=480:-1:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse",
        "-loop", "0", outputPath,
      ]);
    } else if (action === "concat") {
      if (inputPaths.length < 2) throw new Error("拼接至少需要两个视频文件");
      const targetWidth = safeEvenDimension(options.targetWidth, 1280);
      const targetHeight = safeEvenDimension(options.targetHeight, 720);
      const videoFilter = `scale=${targetWidth}:${targetHeight}:force_original_aspect_ratio=decrease,pad=${targetWidth}:${targetHeight}:(ow-iw)/2:(oh-ih)/2,fps=30,format=yuv420p`;
      const normalized: string[] = [];
      for (let index = 0; index < inputPaths.length; index += 1) {
        const segment = path.join(tempDir, `segment-${index}.mp4`);
        const inputHasAudio = await hasAudioStream(inputPaths[index]);
        const commonOutput = [
          "-vf", videoFilter,
          "-c:v", "libx264", "-preset", "veryfast", "-crf", "21",
          "-c:a", "aac", "-ar", "48000", "-ac", "2",
          "-shortest", "-movflags", "+faststart", segment,
        ];
        if (inputHasAudio) {
          await runFfmpeg([
            "-y", "-i", inputPaths[index], "-map", "0:v:0", "-map", "0:a:0",
            ...commonOutput,
          ]);
        } else {
          await runFfmpeg([
            "-y", "-i", inputPaths[index],
            "-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=48000",
            "-map", "0:v:0", "-map", "1:a:0", ...commonOutput,
          ]);
        }
        normalized.push(segment);
      }
      const concatList = path.join(tempDir, "concat.txt");
      await fs.writeFile(concatList, normalized.map((item) => `file '${item.replace(/'/g, "'\\''")}'`).join("\n"), "utf8");
      await runFfmpeg(["-y", "-f", "concat", "-safe", "0", "-i", concatList, "-c", "copy", "-movflags", "+faststart", outputPath]);
      filename = `拼接视频-${Date.now()}.mp4`;
    } else {
      throw new Error("不支持的媒体操作");
    }

    const bytes = await fs.readFile(outputPath);
    if (!bytes.length) throw new Error("媒体处理没有生成有效文件");
    return { bytes, contentType, extension, filename };
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

export async function burnSrtSubtitles(
  video: LocalMediaInput,
  subtitles: string,
): Promise<LocalMediaProcessResult> {
  if (!video.bytes.length) throw new Error("字幕合成需要有效视频");
  if (!subtitles.trim()) throw new Error("字幕内容不能为空");
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "local-subtitle-"));
  const inputPath = path.join(tempDir, `input${/^\.[a-z0-9]{1,10}$/i.test(video.extension) ? video.extension : ".mp4"}`);
  const subtitlePath = path.join(tempDir, "captions.srt");
  const outputPath = path.join(tempDir, "output.mp4");
  try {
    await Promise.all([
      fs.writeFile(inputPath, video.bytes),
      fs.writeFile(subtitlePath, `\uFEFF${subtitles}`, "utf8"),
    ]);
    const filter = `subtitles='${subtitleFilterPath(subtitlePath)}':charenc=UTF-8:force_style='FontSize=18,PrimaryColour=&H00FFFFFF,OutlineColour=&H90000000,BorderStyle=1,Outline=2,Shadow=0,MarginV=42,Alignment=2'`;
    await runFfmpeg([
      "-y", "-i", inputPath, "-vf", filter,
      "-map", "0:v:0", "-map", "0:a?",
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
      "-c:a", "copy", "-movflags", "+faststart", outputPath,
    ]);
    const bytes = await fs.readFile(outputPath);
    if (!bytes.length) throw new Error("字幕合成没有生成有效文件");
    return {
      bytes,
      contentType: "video/mp4",
      extension: ".mp4",
      filename: `字幕成片-${Date.now()}.mp4`,
    };
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}
