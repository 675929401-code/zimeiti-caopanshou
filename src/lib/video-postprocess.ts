import { spawn } from "child_process";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { safeMediaFetch } from "@/lib/safe-media-fetch";

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const DEFAULT_MAX_VIDEO_BYTES = 512 * 1024 * 1024;

type VideoDownloadOptions = {
  trustedHostnames?: string[];
  trustedInternalOrigin?: string;
  maxBytes?: number;
  timeoutMs?: number;
};

const PACKAGED_FFMPEG_EXECUTABLE = process.platform === "win32"
  ? "runtime-tools\\ffmpeg.exe"
  : "runtime-tools/ffmpeg";
const DEVELOPMENT_FFMPEG_EXECUTABLE = process.platform === "win32"
  ? "node_modules\\ffmpeg-static\\ffmpeg.exe"
  : "node_modules/ffmpeg-static/ffmpeg";

export function resolveFfmpegExecutable() {
  const configured = process.env.FFMPEG_PATH?.trim();
  if (configured) return configured;

  // Production artifacts always materialize this exact path during
  // prepare-next-standalone-assets. Do not probe or recursively scan the
  // checkout here: Node File Trace interprets a dynamic readdir/stat lookup as
  // a request to package the whole repository into instrumentation.js.
  if (process.env.NODE_ENV === "production") {
    return PACKAGED_FFMPEG_EXECUTABLE;
  }

  // Development runs from the project root, where pnpm exposes this package
  // through node_modules. Keeping this as a literal prevents ffmpeg-static's
  // dynamic package entrypoint from entering the server instrumentation trace.
  return DEVELOPMENT_FFMPEG_EXECUTABLE;
}

function trustedInternalOrigin(value?: string): URL | null {
  if (!value) return null;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("TRUSTED_INTERNAL_VIDEO_ORIGIN_INVALID");
  }
  const hostname = parsed.hostname.toLowerCase();
  const isLoopback = hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";
  if (parsed.protocol !== "http:" || !isLoopback || parsed.username || parsed.password || !parsed.port) {
    throw new Error("TRUSTED_INTERNAL_VIDEO_ORIGIN_FORBIDDEN");
  }
  return parsed;
}

function isAllowedInternalVideoUrl(candidate: URL, trustedOrigin: URL | null): boolean {
  return Boolean(
    trustedOrigin
    && candidate.origin === trustedOrigin.origin
    && candidate.pathname.startsWith("/api/video/"),
  );
}

async function fetchVideoResponse(videoUrl: string, options: VideoDownloadOptions): Promise<Response> {
  const internalOrigin = trustedInternalOrigin(options.trustedInternalOrigin);
  let current = new URL(videoUrl);
  const timeoutMs = Math.max(1_000, Math.min(options.timeoutMs ?? 120_000, 300_000));

  for (let redirectCount = 0; redirectCount <= 3; redirectCount += 1) {
    if (!isAllowedInternalVideoUrl(current, internalOrigin)) {
      const { response } = await safeMediaFetch(current, {
        timeoutMs,
        maxRedirects: 3 - redirectCount,
        trustedHostnames: options.trustedHostnames,
      });
      return response;
    }

    const response = await fetch(current, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!REDIRECT_STATUSES.has(response.status)) return response;
    await response.body?.cancel().catch(() => undefined);
    const location = response.headers.get("location");
    if (!location) throw new Error("VIDEO_DOWNLOAD_REDIRECT_LOCATION_MISSING");
    if (redirectCount >= 3) throw new Error("VIDEO_DOWNLOAD_TOO_MANY_REDIRECTS");
    current = new URL(location, current);
  }

  throw new Error("VIDEO_DOWNLOAD_FAILED");
}

async function writeBoundedVideoResponse(
  response: Response,
  destination: string,
  maxBytes: number,
): Promise<void> {
  if (!response.ok) throw new Error(`Video download failed (${response.status})`);
  const contentType = (response.headers.get("content-type") || "")
    .split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  if (!contentType.startsWith("video/") && contentType !== "application/octet-stream") {
    throw new Error(`Video download content type rejected (${contentType || "missing"})`);
  }
  const declaredLength = Number(response.headers.get("content-length") || 0);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new Error("Video download exceeds size limit");
  }
  if (!response.body) throw new Error("Video download returned an empty body");

  const reader = response.body.getReader();
  const output = await fs.open(/* turbopackIgnore: true */ destination, "w");
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error("Video download exceeds size limit");
      }
      await output.write(value);
    }
    if (total === 0) throw new Error("Video download returned an empty body");
  } finally {
    reader.releaseLock();
    await output.close();
  }
}

export function runFfmpeg(args: string[], timeoutMs = 5 * 60_000) {
  const executable = resolveFfmpegExecutable();
  return new Promise<void>((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true });
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("FFmpeg processing timed out"));
    }, timeoutMs);

    child.stderr.on("data", (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString()}`.slice(-4000);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new Error(`FFmpeg is unavailable: ${error.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`FFmpeg processing failed (${code}): ${stderr}`));
    });
  });
}

export async function downloadAndTrimVideo(
  videoUrl: string,
  targetDurationSeconds: number,
  options: VideoDownloadOptions = {},
) {
  const duration = Math.max(0.5, Math.round(targetDurationSeconds * 10) / 10);
  const tempDir = await fs.mkdtemp(/* turbopackIgnore: true */ path.join(/* turbopackIgnore: true */ os.tmpdir(), "video-trim-"));
  const inputPath = path.join(/* turbopackIgnore: true */ tempDir, "source.mp4");
  const outputPath = path.join(/* turbopackIgnore: true */ tempDir, "trimmed.mp4");

  try {
    const response = await fetchVideoResponse(videoUrl, options);
    const maxBytes = Math.max(1, Math.min(options.maxBytes ?? DEFAULT_MAX_VIDEO_BYTES, DEFAULT_MAX_VIDEO_BYTES));
    await writeBoundedVideoResponse(response, inputPath, maxBytes);
    try {
      await runFfmpeg([
        "-y",
        "-i", inputPath,
        "-t", String(duration),
        "-map", "0:v:0",
        "-map", "0:a?",
        "-c", "copy",
        "-avoid_negative_ts", "make_zero",
        "-movflags", "+faststart",
        outputPath,
      ], 60_000);
    } catch {
      await fs.rm(/* turbopackIgnore: true */ outputPath, { force: true });
      await runFfmpeg([
        "-y",
        "-i", inputPath,
        "-t", String(duration),
        "-map", "0:v:0",
        "-map", "0:a?",
        "-c:v", "libx264",
        "-preset", "veryfast",
        "-crf", "18",
        "-c:a", "aac",
        "-b:a", "192k",
        "-movflags", "+faststart",
        outputPath,
      ]);
    }
    return { outputPath, tempDir };
  } catch (error) {
    await fs.rm(/* turbopackIgnore: true */ tempDir, { recursive: true, force: true });
    throw error;
  }
}

export async function extractVideoThumbnail(
  videoUrl: string,
  options: VideoDownloadOptions = {},
): Promise<Buffer> {
  const tempDir = await fs.mkdtemp(/* turbopackIgnore: true */ path.join(/* turbopackIgnore: true */ os.tmpdir(), "video-thumb-"));
  const inputPath = path.join(/* turbopackIgnore: true */ tempDir, "source.mp4");
  const outputPath = path.join(/* turbopackIgnore: true */ tempDir, "thumbnail.jpg");

  try {
    const response = await fetchVideoResponse(videoUrl, options);
    const maxBytes = Math.max(1, Math.min(options.maxBytes ?? 256 * 1024 * 1024, DEFAULT_MAX_VIDEO_BYTES));
    await writeBoundedVideoResponse(response, inputPath, maxBytes);
    await runFfmpeg([
      "-y",
      "-ss", "0.25",
      "-i", inputPath,
      "-frames:v", "1",
      "-an",
      "-vf", "scale=640:-2:force_original_aspect_ratio=decrease",
      "-q:v", "3",
      outputPath,
    ], 60_000);
    const thumbnail = await fs.readFile(/* turbopackIgnore: true */ outputPath);
    if (thumbnail.length < 256) throw new Error("VIDEO_THUMBNAIL_EMPTY");
    return thumbnail;
  } finally {
    await fs.rm(/* turbopackIgnore: true */ tempDir, { recursive: true, force: true });
  }
}

export async function removeVideoTempDir(tempDir: string) {
  await fs.rm(/* turbopackIgnore: true */ tempDir, { recursive: true, force: true });
}
