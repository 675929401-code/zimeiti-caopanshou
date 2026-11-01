import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { processLocalMedia } from "../src/lib/local-media-processor";
import { resolveFfmpegExecutable } from "../src/lib/video-postprocess";

function run(executable: string, args: string[]) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve(stdout.trim()) : reject(new Error(stderr)));
  });
}

async function main() {
  // Windows Codex runners can deny writes under the system temp directory even
  // though the ffmpeg binary itself is usable. Keep Linux/CI on the normal
  // system temp path, while allowing the runner to provide a writable project
  // temp root explicitly or use the ignored project-local fallback.
  const configuredRoot = process.env.CODEX_VIDEO_VERIFY_TMP?.trim();
  const tempRoot = configuredRoot
    ? path.resolve(configuredRoot)
    : process.platform === "win32"
      ? path.join(process.cwd(), ".codex-temp", "video-verify")
      : os.tmpdir();
  await fs.mkdir(tempRoot, { recursive: true });
  const directory = await fs.mkdtemp(path.join(tempRoot, "verify-local-video-"));
  const tempEnvironment = ["TMPDIR", "TMP", "TEMP", "VIDEO_TEMP_DIR"] as const;
  const previousEnvironment = new Map(tempEnvironment.map((name) => [name, process.env[name]]));
  if (configuredRoot || process.platform === "win32") {
    for (const name of tempEnvironment) process.env[name] = tempRoot;
  }
  const source = path.join(directory, "source.mp4");
  const ffprobe = path.join(process.cwd(), "node_modules", "ffprobe-static", "bin", process.platform, process.arch, process.platform === "win32" ? "ffprobe.exe" : "ffprobe");
  try {
    await run(resolveFfmpegExecutable(), [
      "-y", "-f", "lavfi", "-i", "testsrc=size=640x360:rate=24", "-f", "lavfi", "-i", "sine=frequency=880:sample_rate=44100",
      "-t", "3", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", source,
    ]);
    const input = { bytes: await fs.readFile(source), extension: ".mp4" };
    const trimmed = await processLocalMedia({ action: "trim", inputs: [input], startSeconds: 0.5, endSeconds: 2.2 });
    const trimmedPath = path.join(directory, "trimmed.mp4"); await fs.writeFile(trimmedPath, trimmed.bytes);
    const duration = Number(await run(ffprobe, ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", trimmedPath]));
    assert.ok(duration > 1.5 && duration < 1.9, `unexpected trimmed duration ${duration}`);
    const muted = await processLocalMedia({ action: "mute", inputs: [input] }); assert.ok(muted.bytes.length > 10_000);
    const audio = await processLocalMedia({ action: "extract-audio", inputs: [input] }); assert.equal(audio.contentType, "audio/mpeg"); assert.ok(audio.bytes.length > 1_000);
    const subtitle = await processLocalMedia({ action: "subtitle-region", inputs: [input], subtitleRegion: "bottom" }); assert.ok(subtitle.bytes.length > 10_000);
    const gif = await processLocalMedia({ action: "gif", inputs: [input], startSeconds: 0, endSeconds: 1.5 }); assert.equal(gif.contentType, "image/gif"); assert.equal(gif.bytes.subarray(0, 3).toString("ascii"), "GIF");
    const concat = await processLocalMedia({ action: "concat", inputs: [input, input] }); assert.ok(concat.bytes.length > input.bytes.length);
    console.log(JSON.stringify({ ok: true, duration, outputs: { trim: trimmed.bytes.length, mute: muted.bytes.length, audio: audio.bytes.length, subtitle: subtitle.bytes.length, gif: gif.bytes.length, concat: concat.bytes.length } }, null, 2));
  } finally {
    for (const name of tempEnvironment) {
      const previous = previousEnvironment.get(name);
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    }
    await fs.rm(directory, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exit(1); });
