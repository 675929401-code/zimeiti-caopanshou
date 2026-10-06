import { safeFetchStream, SafeFetchError, type SafeFetchDependencies } from "./safe-fetch";

/** Read an authenticated directory without redirects or unbounded response bodies. */
export async function readVideoModelCatalog(url: string, apiKey: string, dependencies: SafeFetchDependencies = {}): Promise<unknown> {
  const { response } = await safeFetchStream(url, {
    timeoutMs: 10000,
    headers: { Accept: "application/json" },
    authorization: { origin: new URL(url).origin, value: `Bearer ${apiKey}` },
  }, dependencies);
  if (!response.ok) {
    await response.body?.cancel();
    throw new SafeFetchError("模型目录请求失败", "UPSTREAM_STATUS", 502, { upstreamStatus: response.status });
  }
  if (!response.body) throw new Error("MODEL_CATALOG_EMPTY");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 2 * 1024 * 1024) {
        await reader.cancel();
        throw new Error("MODEL_CATALOG_TOO_LARGE");
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
