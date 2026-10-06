export const ADMIN_CONCEALED_BUNDLE_SENTINELS = Object.freeze([
  "SUPER ADMIN CONTROL PLANE",
  "查看内部提示词",
  "带货 Agent 管理",
  "漫剧 Agent 私有 Prompt 来源",
  "迅虎支付（虎皮椒）配置",
  "SMTP 授权码",
  "凭据安全清单",
  "高/严重风险关联账号 Top10",
  "脱敏拦截摘要：",
  "灾备与恢复证据",
  "使用此版本",
]);

/**
 * Observe JavaScript that the browser actually downloads during an admin E2E
 * run. Only URL, byte size and sentinel matches are retained; response source
 * is never written to evidence.
 */
export function createLoadedJavaScriptSentinelAudit(page, {
  origin,
  sentinels = ADMIN_CONCEALED_BUNDLE_SENTINELS,
} = {}) {
  const expectedOrigin = new URL(origin).origin;
  const scripts = new Map();
  const failures = [];
  const pending = new Set();

  const onResponse = (response) => {
    let parsed;
    try {
      parsed = new URL(response.url());
    } catch {
      return;
    }
    if (parsed.origin !== expectedOrigin || !parsed.pathname.startsWith("/_next/") || !parsed.pathname.endsWith(".js")) return;

    const task = (async () => {
      try {
        const body = await response.body();
        const source = body.toString("utf8");
        const previous = scripts.get(parsed.pathname);
        const matchedSentinels = sentinels.filter((sentinel) => source.includes(sentinel));
        scripts.set(parsed.pathname, {
          path: parsed.pathname,
          bytes: Math.max(previous?.bytes || 0, body.byteLength),
          matchedSentinels: [...new Set([
            ...(previous?.matchedSentinels || []),
            ...matchedSentinels,
          ])],
        });
      } catch (error) {
        failures.push({
          path: parsed.pathname,
          message: error instanceof Error ? error.message.slice(0, 240) : "response body unavailable",
        });
      }
    })();
    pending.add(task);
    void task.finally(() => pending.delete(task));
  };

  page.on("response", onResponse);

  return {
    async finish() {
      page.off("response", onResponse);
      await Promise.allSettled([...pending]);
      const loadedScripts = [...scripts.values()].sort((left, right) => left.path.localeCompare(right.path));
      return {
        scriptCount: loadedScripts.length,
        totalBytes: loadedScripts.reduce((sum, script) => sum + script.bytes, 0),
        matchedSentinels: [...new Set(loadedScripts.flatMap((script) => script.matchedSentinels))].sort(),
        scripts: loadedScripts,
        failures,
      };
    },
  };
}
