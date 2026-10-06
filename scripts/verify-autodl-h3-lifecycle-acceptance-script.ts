import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  assertLifecycleAcceptanceArguments,
  assertLifecycleAcceptanceEnvironment,
  AUTODL_H3_LIFECYCLE_ACCEPTANCE_CONSTANTS,
  parseLifecycleFfmpegMediaLog,
  resolveLifecycleMediaInspector,
  runAutodlH3LifecycleAcceptance,
  type LifecycleAcceptanceDependencies,
} from "./validate-autodl-h3-lifecycle-cycle";

const constants = AUTODL_H3_LIFECYCLE_ACCEPTANCE_CONSTANTS;
const scriptPath = path.join(process.cwd(), "scripts", "validate-autodl-h3-lifecycle-cycle.ts");

function validEnvironment() {
  return {
    AUTODL_H3_INSTANCE_UUID: constants.instanceUuid,
    AUTODL_H3_LIFECYCLE_ENABLED: "true",
    AUTODL_H3_LIFECYCLE_DRY_RUN: "false",
    AUTODL_H3_LIFECYCLE_ALLOW_POWER_ACTIONS: "true",
    AUTODL_H3_ATOMIC_FINALIZER_ENABLED: "true",
    AUTODL_H3_IDLE_SECONDS: "300",
    AUTODL_H3_SSH_EXECUTABLE: "C:\\Windows\\System32\\OpenSSH\\ssh.exe",
    AUTODL_H3_SSH_KEY_PATH: "C:\\Users\\acceptance\\.ssh\\h3_ed25519",
    AUTODL_H3_SSH_KNOWN_HOSTS_PATH: "C:\\Users\\acceptance\\.ssh\\known_hosts_h3",
  };
}

function verifyStaticSafetyContract() {
  const source = readFileSync(scriptPath, "utf8");
  assert.ok(source.includes('generationAck: "--ack-real-generation"'));
  assert.ok(source.includes('powerCycleAck: "--ack-real-power-cycle"'));
  assert.ok(source.includes('baseUrl: "http://127.0.0.1:5000"'));
  assert.ok(source.includes('instanceUuid: "pro-7872645dd0a7"'));
  assert.ok(source.includes('resolution: "480p"'));
  assert.ok(source.includes('aspectRatio: "16:9"'));
  assert.ok(source.includes('durationSeconds: 5'));
  assert.ok(source.includes("/^h3q_[a-f0-9]+$/u"));
  assert.ok(source.includes('credential_source: "windows_dpapi_resolver"'));
  assert.ok(source.includes('from "ffmpeg-static"'), "真实验收必须安全回退项目现有 ffmpeg-static");
  assert.ok(!source.includes(".powerOn("), "验收脚本禁止直接开机");
  assert.ok(!source.includes(".powerOff("), "验收脚本禁止直接关机");
  assert.ok(!source.includes("power_on"), "验收脚本禁止嵌入开机端点");
  assert.ok(!source.includes("power_off"), "验收脚本禁止嵌入关机端点");
  assert.ok(!source.includes("/release"), "验收脚本禁止嵌入释放端点");
  assert.ok(!source.includes("image_url"), "纯文生视频验收禁止提交 image_url");
  assert.ok(!source.includes("imageUrl"), "纯文生视频验收禁止把图片参数传入 SSE");
  assert.equal((source.match(/\/api\/video\/generate/g) || []).length, 1, "源码只能包含一个视频提交端点");
}

function verifyMediaInspectorFallback() {
  const installedFallback = resolveLifecycleMediaInspector({ environment: {} });
  assert.equal(installedFallback.kind, "ffmpeg-static", "本机未配置 ffprobe 时必须解析到实际安装的 ffmpeg-static");
  assert.ok(path.isAbsolute(installedFallback.command));

  const fallback = resolveLifecycleMediaInspector({
    environment: {},
    bundledFfmpegPath: "C:\\project\\node_modules\\ffmpeg-static\\ffmpeg.exe",
    fileExists: () => true,
  });
  assert.deepEqual(fallback, {
    kind: "ffmpeg-static",
    command: "C:\\project\\node_modules\\ffmpeg-static\\ffmpeg.exe",
  });

  const explicit = resolveLifecycleMediaInspector({
    environment: { H3_LIFECYCLE_ACCEPTANCE_FFPROBE_PATH: "C:\\tools\\ffprobe.exe" },
    bundledFfmpegPath: "C:\\project\\node_modules\\ffmpeg-static\\ffmpeg.exe",
    fileExists: () => true,
  });
  assert.deepEqual(explicit, { kind: "ffprobe", command: "C:\\tools\\ffprobe.exe" });

  const parsed = parseLifecycleFfmpegMediaLog([
    "Duration: 00:00:05.17, start: 0.000000, bitrate: 7258 kb/s",
    "Stream #0:0: Video: h264 (High), yuv420p, 864x480, 7120 kb/s, 24 fps, 24 tbr",
    "Stream #0:1: Audio: aac (LC), 32000 Hz, stereo, fltp, 128 kb/s",
    "frame=  124 fps=0.0 q=-0.0 Lsize=N/A time=00:00:05.16 bitrate=N/A speed=84x",
  ].join("\n"));
  assert.deepEqual(parsed, {
    codec: "h264",
    audioCodec: "aac",
    width: 864,
    height: 480,
    durationSeconds: 5.17,
    frameRate: "24/1",
    frameCount: 124,
    inspector: "ffmpeg-static",
  });
}

function verifyGates() {
  assert.throws(
    () => assertLifecycleAcceptanceArguments(["node", "script"]),
    /--ack-real-generation/u,
  );
  assert.throws(
    () => assertLifecycleAcceptanceArguments(["node", "script", constants.generationAck]),
    /--ack-real-power-cycle/u,
  );
  assert.doesNotThrow(() => assertLifecycleAcceptanceArguments([
    "node",
    "script",
    constants.generationAck,
    constants.powerCycleAck,
  ]));

  assert.doesNotThrow(() => assertLifecycleAcceptanceEnvironment(validEnvironment()));
  assert.throws(
    () => assertLifecycleAcceptanceEnvironment({ ...validEnvironment(), AUTODL_H3_INSTANCE_UUID: "pro-wrong000000" }),
    /固定的现有 PRO6000/u,
  );
  assert.throws(
    () => assertLifecycleAcceptanceEnvironment({ ...validEnvironment(), AUTODL_H3_IDLE_SECONDS: "299" }),
    /300 秒/u,
  );
  assert.throws(
    () => assertLifecycleAcceptanceEnvironment({ ...validEnvironment(), AUTODL_DEVELOPER_TOKEN: "must-not-be-used" }),
    /DPAPI/u,
  );
}

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function verifyMockedFullCycle() {
  let clock = 0;
  let submitted = false;
  let terminalDelivered = false;
  let generationPosts = 0;
  let submittedBody: Record<string, unknown> | undefined;
  let writtenEvidence: Record<string, unknown> | undefined;
  const localToken = "LocalSessionTokenForMockOnly_123456";
  const fakeMp4 = Buffer.alloc(12_000);
  fakeMp4.write("ftyp", 4, "ascii");

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.origin, constants.baseUrl, "Mock 验收发现非本地站内请求");
    if (url.pathname === "/api/auth/dev-session") {
      return jsonResponse({ token: localToken, user: { role: "admin" } });
    }
    if (url.pathname === "/api/video/models") {
      return jsonResponse({
        models: [{
          id: "pm_mock_h3_public",
          displayName: constants.publicModelDisplayName,
          capabilities: {
            resolutionOptions: ["480p", "1080p", "2K"],
            nativeDurations: [5, 10, 15],
            aspectRatios: ["16:9"],
            requiresImage: false,
            available: true,
          },
        }],
      });
    }
    if (url.pathname === "/api/video/generate") {
      generationPosts += 1;
      submitted = true;
      submittedBody = JSON.parse(String(init?.body || "{}")) as Record<string, unknown>;
      return jsonResponse({
        task_id: "h3q_0123456789abcdef",
        model_id: "pm_mock_h3_public",
        status: "queued",
        content_url: "",
      });
    }
    if (url.pathname === "/api/video/stream") {
      terminalDelivered = true;
      const body = `event: completed\ndata: ${JSON.stringify({ videoUrl: "/api/video/proxy?ticket=mock" })}\n\n`;
      return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    }
    if (url.pathname === "/api/video/access-ticket" && url.searchParams.get("scope") === "playback") {
      return jsonResponse({ url: "/api/video/proxy?ticket=playback" });
    }
    if (url.pathname === "/api/video/access-ticket" && url.searchParams.get("scope") === "download") {
      return jsonResponse({ url: "/api/video/proxy-download?ticket=download" });
    }
    if (url.pathname === "/api/video/proxy") {
      return new Response(Buffer.from("mock-range"), { status: 206 });
    }
    if (url.pathname === "/api/video/proxy-download") {
      return new Response(fakeMp4, { status: 200 });
    }
    throw new Error(`Unexpected mock route: ${url.pathname}`);
  };

  const dependencies: LifecycleAcceptanceDependencies = {
    fetchImpl,
    async getOfficialPowerState() {
      if (!submitted) return "stopped";
      if (!terminalDelivered && clock < 10_000) return "starting";
      if (!terminalDelivered) return "running";
      return clock >= 310_000 ? "stopped" : "running";
    },
    now: () => clock,
    async sleep(milliseconds) {
      clock += milliseconds;
    },
    async writeMedia() {
      return "C:\\mock-evidence\\minimax-h3-t2v-5s-480p.mp4";
    },
    async inspectMedia() {
      return {
        codec: "h264",
        audioCodec: "aac",
        width: 864,
        height: 480,
        durationSeconds: 5.167,
        frameRate: "24/1",
        frameCount: 124,
        inspector: "ffmpeg-static",
      };
    },
    async writeEvidence(_runId, evidence) {
      writtenEvidence = evidence;
      return "C:\\mock-evidence\\lifecycle-acceptance.json";
    },
    log() {},
  };

  const result = await runAutodlH3LifecycleAcceptance(dependencies);
  assert.equal(generationPosts, 1, "Mock 验收必须只有一次视频 POST");
  assert.ok(submittedBody, "Mock 验收没有捕获提交体");
  assert.equal(submittedBody?.duration, 5);
  assert.equal(submittedBody?.resolution, "480p");
  assert.equal(submittedBody?.resolution_tier, "480p");
  assert.equal(submittedBody?.aspect_ratio, "16:9");
  assert.equal(submittedBody?.surface, "video-page");
  assert.ok(!Object.hasOwn(submittedBody || {}, "image_url"), "Mock 验收提交体意外包含 image_url");
  assert.equal(result.evidence.status, "passed");
  assert.equal(result.evidence.direct_power_calls, false);
  assert.equal(result.evidence.release_calls, false);
  assert.equal((result.evidence.request as Record<string, unknown>).generation_posts, 1);
  assert.ok(writtenEvidence, "Mock 验收未生成脱敏证据对象");
  assert.ok(!JSON.stringify(writtenEvidence).includes(localToken), "脱敏证据泄露本地会话 token");
  assert.ok(!JSON.stringify(writtenEvidence).includes("h3q_0123456789abcdef"), "脱敏证据泄露任务 ID");
  assert.ok(clock >= 310_000, "Mock 验收未等待完整 300 秒空闲期并观察 stopped");
}

async function main() {
  verifyStaticSafetyContract();
  verifyGates();
  verifyMediaInspectorFallback();
  await verifyMockedFullCycle();
  console.log("AutoDL H3 lifecycle acceptance script zero-network verification passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
