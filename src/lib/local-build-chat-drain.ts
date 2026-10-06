import fs from "node:fs";
import path from "node:path";

export const LOCAL_BUILD_LOCK_FILENAME = ".codex-build.lock";

export function isLocalBuildChatDrainActive(input?: {
  environment?: NodeJS.ProcessEnv;
  projectRoot?: string;
  fileExists?: (target: string) => boolean;
}): boolean {
  const environment = input?.environment || process.env;
  if (environment.LOCAL_ACCEPTANCE_PREVIEW !== "true") return false;

  const projectRoot = input?.projectRoot
    || environment.LOCAL_ACCEPTANCE_SOURCE_ROOT?.trim()
    || process.cwd();
  const fileExists = input?.fileExists || fs.existsSync;
  return fileExists(path.join(projectRoot, LOCAL_BUILD_LOCK_FILENAME));
}

export function localBuildChatDrainResponse(): Response {
  return new Response(JSON.stringify({
    error: "本地版本正在更新，当前未调用模型或扣费。请等待更新完成后再发送。",
    code: "LOCAL_BUILD_DRAINING",
    retryable: true,
    retry_safe: true,
    provider_call_started: false,
    charged: false,
  }), {
    status: 503,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "Retry-After": "5",
    },
  });
}
