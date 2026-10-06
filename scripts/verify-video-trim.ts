import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createReadStream, existsSync, promises as fs } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import ffmpegStatic from "ffmpeg-static";
import { downloadAndTrimVideo, removeVideoTempDir } from "../src/lib/video-postprocess";

const ffmpeg = ffmpegStatic && existsSync(ffmpegStatic) ? ffmpegStatic : "ffmpeg";

function runFfmpeg(args: string[]) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(ffmpeg, args, { windowsHide: true });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stderr);
      else reject(new Error(`FFmpeg failed (${code}): ${stderr.slice(-2000)}`));
    });
  });
}

async function main() {
  const sourceDir = await fs.mkdtemp(path.join(os.tmpdir(), "video-trim-source-"));
  const sourcePath = path.join(sourceDir, "source.mp4");
  let trimmedTempDir = "";

  try {
    await runFfmpeg([
      "-y",
      "-f", "lavfi",
      "-i", "color=c=blue:s=640x360:r=30:d=5",
      "-c:v", "libx264",
      "-pix_fmt", "yuv420p",
      sourcePath,
    ]);

    const server = createServer((request, response) => {
      if (request.url !== "/api/video/source.mp4") {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, { "Content-Type": "video/mp4" });
      createReadStream(sourcePath).pipe(response);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

    try {
      const address = server.address();
      assert.ok(address && typeof address !== "string", "本地视频测试服务启动失败");
      const internalOrigin = `http://127.0.0.1:${address.port}`;
      const trimmed = await downloadAndTrimVideo(
        `${internalOrigin}/api/video/source.mp4`,
        3.5,
        { trustedInternalOrigin: internalOrigin },
      );
      trimmedTempDir = trimmed.tempDir;
      const output = await runFfmpeg(["-i", trimmed.outputPath, "-f", "null", "-"]);
      const match = output.match(/Duration:\s*\d{2}:\d{2}:(\d{2}\.\d{2})/);
      assert.ok(match, "无法读取裁剪后的视频时长");
      const duration = Number(match[1]);
      assert.ok(duration >= 3.45 && duration <= 3.6, `目标3.5秒，实际得到${duration}秒`);
      console.log(`Video trim verification passed: target=3.5s, actual=${duration.toFixed(2)}s.`);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  } finally {
    if (trimmedTempDir) await removeVideoTempDir(trimmedTempDir);
    await fs.rm(sourceDir, { recursive: true, force: true });
  }
}

void main();
