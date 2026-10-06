import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { processLocalMedia } from "../src/lib/local-media-processor";
import { runFfmpeg } from "../src/lib/video-postprocess";

async function createFixture(target: string, color: string) {
  await runFfmpeg([
    "-y",
    "-f", "lavfi", "-i", `color=c=${color}:s=320x180:d=1.2:r=24`,
    "-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=48000",
    "-shortest",
    "-c:v", "libx264", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-movflags", "+faststart",
    target,
  ], 60_000);
}

async function main() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "film-timeline-contract-"));
  try {
    const firstPath = path.join(directory, "first.mp4");
    const secondPath = path.join(directory, "second.mp4");
    await createFixture(firstPath, "red");
    await createFixture(secondPath, "blue");
    const first = await processLocalMedia({
      action: "trim",
      inputs: [{ bytes: await fs.readFile(firstPath), extension: ".mp4" }],
      startSeconds: 0.2,
      endSeconds: 0.8,
    });
    const second = await processLocalMedia({
      action: "trim",
      inputs: [{ bytes: await fs.readFile(secondPath), extension: ".mp4" }],
      startSeconds: 0.1,
      endSeconds: 0.9,
    });
    assert.ok(first.bytes.length > 1_000, "first timeline trim must produce a real MP4");
    assert.ok(second.bytes.length > 1_000, "second timeline trim must produce a real MP4");
    const assembled = await processLocalMedia({
      action: "concat",
      inputs: [
        { bytes: first.bytes, extension: first.extension },
        { bytes: second.bytes, extension: second.extension },
      ],
      targetWidth: 320,
      targetHeight: 180,
    });
    assert.equal(assembled.contentType, "video/mp4");
    assert.ok(assembled.bytes.length > Math.max(first.bytes.length, second.bytes.length), "timeline concat must contain both trimmed clips");
    const outputPath = path.join(directory, "timeline.mp4");
    await fs.writeFile(outputPath, assembled.bytes);
    await runFfmpeg(["-hide_banner", "-loglevel", "error", "-i", outputPath, "-map", "0:v:0", "-f", "null", "-"], 60_000);
    console.log(JSON.stringify({
      status: "PASS",
      checks: 4,
      clips: 2,
      outputBytes: assembled.bytes.length,
      paidModelCalls: 0,
      databaseWrites: 0,
      scope: "real local FFmpeg trim and ordered concat used by the film timeline",
    }, null, 2));
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
