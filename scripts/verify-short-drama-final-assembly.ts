import { strict as assert } from "node:assert";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  burnSrtSubtitles,
  processLocalMedia,
} from "../src/lib/local-media-processor";
import {
  buildShortDramaSrt,
  resolveAssemblyFrameSize,
  totalShotDuration,
} from "../src/lib/short-drama/final-assembly";
import { runFfmpeg } from "../src/lib/video-postprocess";

const workspace = process.cwd();
let checks = 0;

function ok(condition: unknown, message: string) {
  assert.ok(condition, message);
  checks += 1;
}

async function source(relativePath: string) {
  return fs.readFile(path.join(workspace, relativePath), "utf8");
}

async function main() {
  const route = await source("src/app/api/short-drama/projects/[projectId]/production/route.ts");
  const contracts = await source("src/lib/short-drama/production-contracts.ts");
  const service = await source("src/lib/short-drama/production-service.ts");
  const panel = await source("src/features/film-studio-project/film-studio-production-panel.tsx");

  ok(contracts.includes('"assemble_final"'), "production contract must expose assemble_final");
  ok(route.includes("assembleProductionFinal"), "production route must dispatch final assembly");
  ok(service.includes("FINAL_ASSEMBLY_INCOMPLETE"), "service must fail closed when a shot video is missing");
  ok(service.includes("claimLocalJobExecution"), "service must claim one local assembly executor");
  ok(service.includes("requireOwnershipRecord: true"), "final assets must be ownership-recorded before success");
  ok(service.includes('assetRole: "subtitle"'), "assembly must persist an SRT sidecar asset");
  ok(service.includes('assetRole: "export"'), "assembly must persist one export asset");
  ok(service.includes('billingMode: "free_local_assembly"'), "assembly must record its explicit free billing mode");
  ok(panel.includes('data-testid="film-studio-final-master"'), "final step must render the durable master asset");
  ok(!panel.includes("全片拼接、转场、字幕、音轨混合与统一成片任务尚未接入"), "stale single-clip limitation must be removed");

  const shots = [
    { sequence: 1, title: "开场", narration: "第一句旁白", durationSeconds: 1.2 },
    { sequence: 2, title: "结尾", narration: "第二句旁白", durationSeconds: 1.3 },
  ];
  const srt = buildShortDramaSrt(shots);
  ok(srt.includes("00:00:00,000 --> 00:00:01,200"), "SRT must start at zero and honor shot duration");
  ok(srt.includes("00:00:01,200 --> 00:00:02,500"), "SRT blocks must be contiguous");
  ok(srt.includes("第一句旁白") && srt.includes("第二句旁白"), "SRT must retain Chinese narration");
  ok(totalShotDuration(shots) === 2.5, "total duration must be deterministic");
  ok(resolveAssemblyFrameSize("9:16").height > resolveAssemblyFrameSize("9:16").width, "vertical projects must not be flattened to 16:9");

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "verify-final-assembly-"));
  try {
    const withAudioPath = path.join(tempDir, "with-audio.mp4");
    const silentPath = path.join(tempDir, "silent.mp4");
    await runFfmpeg([
      "-y",
      "-f", "lavfi", "-i", "color=c=0x4f46e5:s=320x180:d=0.7",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=0.7",
      "-map", "0:v:0", "-map", "1:a:0", "-c:v", "libx264", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-shortest", withAudioPath,
    ], 60_000);
    await runFfmpeg([
      "-y", "-f", "lavfi", "-i", "color=c=0x059669:s=320x180:d=0.7",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-an", silentPath,
    ], 60_000);
    const concatenated = await processLocalMedia({
      action: "concat",
      inputs: [
        { bytes: await fs.readFile(withAudioPath), extension: ".mp4" },
        { bytes: await fs.readFile(silentPath), extension: ".mp4" },
      ],
      targetWidth: 360,
      targetHeight: 640,
    });
    ok(concatenated.bytes.length > 10_000, "mixed audio/silent clips must concatenate to a real MP4");
    const concatenatedPath = path.join(tempDir, "concatenated.mp4");
    await fs.writeFile(concatenatedPath, concatenated.bytes);
    await runFfmpeg([
      "-hide_banner", "-loglevel", "error", "-i", concatenatedPath,
      "-map", "0:a:0", "-t", "0.05", "-f", "null", "-",
    ], 30_000);
    checks += 1;

    const captioned = await burnSrtSubtitles(
      { bytes: concatenated.bytes, extension: ".mp4" },
      srt,
    );
    ok(captioned.bytes.length > 10_000, "Chinese SRT burn must produce a real MP4");
    const captionedPath = path.join(tempDir, "captioned.mp4");
    await fs.writeFile(captionedPath, captioned.bytes);
    await runFfmpeg([
      "-hide_banner", "-loglevel", "error", "-i", captionedPath,
      "-map", "0:v:0", "-map", "0:a:0", "-f", "null", "-",
    ], 30_000);
    checks += 1;
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }

  console.log(`PASS verify-short-drama-final-assembly (${checks} checks)`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
