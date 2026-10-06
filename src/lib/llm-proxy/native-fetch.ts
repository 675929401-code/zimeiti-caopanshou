/**
 * 原生 HTTPS 流式请求模块
 * 
 * 用途：绕过 Next.js 对 fetch() 的拦截/缓存，实现直连 HTTP 流式请求
 * 
 * Next.js 在构建时 patch 了全局 fetch()，增加了请求缓存、重写等中间层。
 * 在 SSE 流式场景下，这些中间层会增加 4-10 秒的额外延迟。
 * 使用 Node.js 原生 https.request 可以消除这个延迟。
 * 
 * 这和 AIWeb（Express + 原生 HTTP）的架构一致。
 */

import https from "https";
import http from "http";
import { Readable } from "stream";

export interface NativeFetchOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeout?: number; // 秒
}

export interface NativeFetchResponse {
  ok: boolean;
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: ReadableStream<Uint8Array>;
  /** 读取完整响应体为文本 */
  text(): Promise<string>;
  /** 读取完整响应体并解析为 JSON */
  json(): Promise<any>;
}

/**
 * 原生 HTTPS/HTTP 流式请求
 * 
 * 特点：
 * 1. 零框架开销 — 直连目标服务器，无中间层
 * 2. 流式透传 — 响应体以 ReadableStream 返回
 * 3. 超时控制 — AbortController 兼容
 * 4. 自动选择 http/https — 根据 URL 协议
 */
export function nativeFetch(
  url: string,
  options: NativeFetchOptions = {}
): Promise<NativeFetchResponse> {
  return new Promise((resolve, reject) => {
    const { method = "GET", headers = {}, body, timeout } = options;

    const parsedUrl = new URL(url);
    const isHttps = parsedUrl.protocol === "https:";
    const lib = isHttps ? https : http;

    const reqOptions: https.RequestOptions = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (isHttps ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      method,
      headers: {
        ...headers,
        ...(body
          ? {
              "Content-Length": Buffer.byteLength(body),
            }
          : {}),
      },
      // 关键：不使用 Agent，避免连接池管理问题
      agent: false,
    };

    const req = lib.request(reqOptions, (res) => {
      const responseHeaders: Record<string, string> = {};
      for (const [key, value] of Object.entries(res.headers)) {
        if (typeof value === "string") {
          responseHeaders[key] = value;
        } else if (Array.isArray(value)) {
          responseHeaders[key] = value.join(", ");
        }
      }

      // 将 Node.js Readable 转换为 Web ReadableStream
      const readableStream = Readable.toWeb(res) as ReadableStream<Uint8Array>;

      // 辅助方法：读取完整响应体
      const text = async (): Promise<string> => {
        const chunks: Uint8Array[] = [];
        const reader = readableStream.getReader();
        try {
          // eslint-disable-next-line no-constant-condition
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value) chunks.push(value);
          }
        } finally {
          reader.releaseLock();
        }
        const total = chunks.reduce((s, c) => s + c.length, 0);
        const buf = new Uint8Array(total);
        let off = 0;
        for (const c of chunks) {
          buf.set(c, off);
          off += c.length;
        }
        return new TextDecoder().decode(buf);
      };

      resolve({
        ok: res.statusCode! >= 200 && res.statusCode! < 300,
        status: res.statusCode!,
        statusText: res.statusMessage || "",
        headers: responseHeaders,
        body: readableStream,
        text,
        json: async () => {
          const t = await text();
          return JSON.parse(t);
        },
      });
    });

    req.on("error", (err) => {
      reject(err);
    });

    // 超时控制
    if (timeout) {
      req.setTimeout(timeout * 1000, () => {
        req.destroy(new Error(`Request timeout after ${timeout}s`));
      });
    }

    if (body) {
      req.write(body);
    }
    req.end();
  });
}
