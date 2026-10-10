import { NextResponse } from "next/server";
import { readFileSync, existsSync, statSync } from "fs";
import { join } from "path";

// 开发环境下缓存版本号，避免每次请求返回不同的值导致 VersionChecker 反复刷新页面
let devVersionCache: string | null = null;
let devHashCache: string | null = null;

function safeDeployCommitSha(value: unknown) {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return /^[0-9a-f]{7,64}$/u.test(normalized) ? normalized : null;
}

function safeReleaseId(value: unknown) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(normalized) ? normalized : null;
}

function safeBuildOutputDigest(value: unknown) {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return /^[a-f0-9]{64}$/u.test(normalized) ? normalized : null;
}

function readReleaseMetadata(fileData?: { deployCommitSha?: unknown; releaseId?: unknown }) {
  const deployCommitSha = safeDeployCommitSha(process.env.DEPLOY_COMMIT_SHA)
    || safeDeployCommitSha(fileData?.deployCommitSha);
  const releaseId = safeReleaseId(process.env.RELEASE_ID)
    || safeReleaseId(fileData?.releaseId);
  const buildOutputDigest = safeBuildOutputDigest(process.env.RELEASE_BUILD_OUTPUT_DIGEST);
  return {
    ...(deployCommitSha ? { deployCommitSha } : {}),
    ...(releaseId ? { releaseId } : {}),
    ...(buildOutputDigest ? { buildOutputDigest } : {}),
  };
}

function runtimeBuildDirectory() {
  const isolatedDirectory = process.env.LOCAL_ACCEPTANCE_PREVIEW === "true"
    ? process.env.LOCAL_VALIDATION_DIST_DIR?.trim()
    : "";
  const allowedIsolatedDirectories = new Set([
    ".next-local-acceptance",
    ".next-local-acceptance-next",
  ]);
  if (
    isolatedDirectory
    && allowedIsolatedDirectories.has(isolatedDirectory)
    && existsSync(join(process.cwd(), isolatedDirectory, "BUILD_ID"))
  ) {
    return isolatedDirectory;
  }
  return ".next";
}

function readCurrentBuild() {
  try {
    const buildIdPath = join(process.cwd(), runtimeBuildDirectory(), "BUILD_ID");
    if (!existsSync(buildIdPath)) return { id: "", builtAt: null as Date | null };
    return {
      id: readFileSync(buildIdPath, "utf-8").trim(),
      builtAt: statSync(buildIdPath).mtime,
    };
  } catch {
    return { id: "", builtAt: null as Date | null };
  }
}

function formatDeployTime(value: Date) {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(value);
}

export async function GET() {
  // COZE_PROJECT_ENV is explicit on the server, but older deployments may not
  // have it in their protected env file. Infer the safe production label from
  // Next's runtime mode instead of falsely reporting a live release as DEV.
  const env = process.env.COZE_PROJECT_ENV || (process.env.NODE_ENV === "production" ? "PROD" : "DEV");
  const currentBuild = env === "PROD"
    ? readCurrentBuild()
    : { id: "", builtAt: null as Date | null };
  const buildId = currentBuild.id;
  const environmentReleaseMetadata = readReleaseMetadata();

  try {
    const filePath = join(process.cwd(), "public", "version.json");
    if (!existsSync(filePath)) {
      if (buildId) {
        return NextResponse.json({
          version: buildId,
          hash: environmentReleaseMetadata.deployCommitSha
            ? `${buildId}:${environmentReleaseMetadata.deployCommitSha}`
            : buildId,
          buildId,
          ...environmentReleaseMetadata,
          timestamp: new Date().toISOString(),
          env,
        }, {
          headers: {
            "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
            "Pragma": "no-cache",
            "Expires": "0",
          },
        });
      }
      // 开发环境：首次生成缓存版本号，后续返回同一个值
      if (!devVersionCache) {
        devVersionCache = String(Date.now());
        devHashCache = "dev";
      }
      return NextResponse.json({
        version: devVersionCache,
        hash: devHashCache,
        ...environmentReleaseMetadata,
        timestamp: new Date().toISOString(),
        env,
      }, {
        headers: {
          "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
          "Pragma": "no-cache",
          "Expires": "0",
        },
      });
    }
    const content = readFileSync(filePath, "utf-8");
    const data = JSON.parse(content) as {
      hash?: unknown;
      version?: unknown;
      deployCommitSha?: unknown;
      releaseId?: unknown;
      [key: string]: unknown;
    };
    const compatibleData = { ...data };
    delete compatibleData.deployCommitSha;
    delete compatibleData.releaseId;
    const releaseMetadata = readReleaseMetadata(data);
    const declaredHash = typeof data.hash === "string" && data.hash.trim()
      ? data.hash.trim()
      : "unknown";
    const releaseIdentity = releaseMetadata.deployCommitSha || declaredHash;
    const runtimeHash = buildId ? `${buildId}:${releaseIdentity}` : releaseIdentity;
    // 始终注入 env 字段，确保 VersionChecker 能正确识别开发环境
    // 如果缺少 hash 字段，使用 "unknown" 避免前端判断异常
    return NextResponse.json({
      ...compatibleData,
      ...(buildId ? { version: buildId } : {}),
      hash: runtimeHash,
      ...(buildId ? { buildId } : {}),
      ...releaseMetadata,
      ...(currentBuild.builtAt
        ? {
            timestamp: currentBuild.builtAt.toISOString(),
            deployTime: formatDeployTime(currentBuild.builtAt),
          }
        : {}),
      env,
    }, {
      headers: {
        // 禁止浏览器和 CDN 缓存版本接口，确保 VersionChecker 每次轮询都能拿到最新值
        "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
        "Pragma": "no-cache",
        "Expires": "0",
      },
    });
  } catch {
    return NextResponse.json({
      version: "0",
      hash: "dev",
      ...environmentReleaseMetadata,
      env,
    }, {
      headers: {
        "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
        "Pragma": "no-cache",
        "Expires": "0",
      },
    });
  }
}
