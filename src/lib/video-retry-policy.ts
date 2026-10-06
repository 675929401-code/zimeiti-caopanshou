export function shouldAutomaticallyRetryVideoFailure(input: {
  errorMessage: unknown;
  automaticRetryAllowed?: unknown;
  hasRetried: boolean;
}) {
  return input.automaticRetryAllowed !== false
    && !input.hasRetried
    && /task_failed|视频生成失败，请重试/i.test(String(input.errorMessage || ""));
}
