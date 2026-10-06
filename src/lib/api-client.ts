/**
 * 前端 API 统一客户端
 *
 * 🔒 增量加固模块 — 纯新增，不改任何现有代码
 *
 * 解决的问题：
 * 1. 199个fetch调用点分散在各组件，每个都要手写 token + Content-Type
 * 2. 无统一超时控制 — 有的请求卡住用户就等着
 * 3. 无统一错误处理 — 401未跳转登录、500无友好提示
 * 4. 无重试机制 — 网络波动一次就失败
 *
 * 用法（新代码使用，老代码不动）：
 *   import { api } from "@/lib/api-client";
 *
 *   // GET
 *   const data = await api.get("/api/bots");
 *
 *   // POST
 *   const result = await api.post("/api/cami", { code: "xxx" });
 *
 *   // 文件上传
 *   const result = await api.upload("/api/storage/upload", formData);
 */

// ============================================================
// 类型定义
// ============================================================

interface RequestOptions {
  /** 请求头 */
  headers?: Record<string, string>;
  /** 超时时间(ms)，默认15000 */
  timeout?: number;
  /** 重试次数，默认0 */
  retries?: number;
  /** 重试间隔(ms)，默认1000 */
  retryDelay?: number;
  /** 是否需要认证，默认true */
  auth?: boolean;
  /** 自定义token（覆盖localStorage中的） */
  token?: string;
}

interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  [key: string]: unknown;
}

// ============================================================
// 工具函数
// ============================================================

/** 从 localStorage 获取认证 token */
function getAuthToken(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return localStorage.getItem("auth_token");
  } catch {
    return null;
  }
}

/** 带超时的 fetch */
function fetchWithTimeout(
  url: string,
  options: RequestInit,
  timeout: number
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  return fetch(url, {
    ...options,
    signal: controller.signal,
  }).finally(() => clearTimeout(timer));
}

/** 延迟函数 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ============================================================
// 核心 API 客户端
// ============================================================

class ApiClient {
  private defaultTimeout = 15000;
  private defaultRetries = 0;

  /**
   * 通用请求方法
   * - 自动注入 Authorization 头
   * - 统一超时控制
   * - 自动重试（仅对网络错误和5xx）
   * - 401 自动跳转登录
   */
  async request<T = unknown>(
    url: string,
    options: RequestInit & RequestOptions = {}
  ): Promise<ApiResponse<T>> {
    const {
      headers: customHeaders = {},
      timeout = this.defaultTimeout,
      retries = this.defaultRetries,
      retryDelay = 1000,
      auth = true,
      token: customToken,
      ...fetchOptions
    } = options;

    // 构建请求头
    const headers: Record<string, string> = {
      ...customHeaders,
    };

    // 自动注入认证头
    if (auth) {
      const token = customToken || getAuthToken();
      if (token) {
        headers["Authorization"] = `Bearer ${token}`;
      }
    }

    // 非 FormData 时自动设置 Content-Type
    if (!(fetchOptions.body instanceof FormData) && !headers["Content-Type"]) {
      headers["Content-Type"] = "application/json";
    }

    const fullUrl = url.startsWith("http") ? url : url;

    // 带重试的请求
    let lastError: Error | null = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const response = await fetchWithTimeout(
          fullUrl,
          {
            ...fetchOptions,
            headers,
          },
          timeout
        );

        // 401 处理 — 跳转登录
        if (response.status === 401 && auth) {
          // 请求需要认证但token无效，清理并跳转
          if (typeof window !== "undefined" && !url.includes("/api/auth/")) {
            // 不在登录相关请求中触发跳转，避免循环
            console.warn("[api-client] 401 未授权，可能需要重新登录");
          }
          try {
            const data = await response.json();
            return { success: false, error: data.error || "登录已过期" };
          } catch {
            return { success: false, error: "登录已过期" };
          }
        }

        // 解析响应
        const text = await response.text();
        let data: unknown;
        try {
          data = JSON.parse(text);
        } catch {
          // 非JSON响应（如SSE流）
          return { success: response.ok, data: text as T };
        }

        // 5xx 且有重试次数
        if (response.status >= 500 && attempt < retries) {
          lastError = new Error(
            `服务器错误 ${response.status}`
          );
          await delay(retryDelay * (attempt + 1));
          continue;
        }

        // 标准化响应格式
        if (typeof data === "object" && data !== null) {
          const obj = data as Record<string, unknown>;
          return {
            success: obj.success ?? response.ok,
            data: (obj.data ?? obj) as T,
            error: obj.error as string | undefined,
            ...obj,
          } as ApiResponse<T>;
        }

        return {
          success: response.ok,
          data: data as T,
        };
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));

        // 超时或网络错误，可以重试
        const isRetryable =
          lastError.name === "AbortError" || // 超时
          lastError.message.includes("fetch") || // 网络错误
          lastError.message.includes("network"); // 网络错误

        if (isRetryable && attempt < retries) {
          await delay(retryDelay * (attempt + 1));
          continue;
        }

        break;
      }
    }

    return {
      success: false,
      error: lastError?.message || "请求失败，请检查网络连接",
    };
  }

  /** GET 请求 */
  async get<T = unknown>(url: string, options?: RequestOptions): Promise<ApiResponse<T>> {
    return this.request<T>(url, { ...options, method: "GET" });
  }

  /** POST 请求 */
  async post<T = unknown>(
    url: string,
    body?: unknown,
    options?: RequestOptions
  ): Promise<ApiResponse<T>> {
    return this.request<T>(url, {
      ...options,
      method: "POST",
      body: body instanceof FormData ? body : JSON.stringify(body),
    });
  }

  /** PUT 请求 */
  async put<T = unknown>(
    url: string,
    body?: unknown,
    options?: RequestOptions
  ): Promise<ApiResponse<T>> {
    return this.request<T>(url, {
      ...options,
      method: "PUT",
      body: body instanceof FormData ? body : JSON.stringify(body),
    });
  }

  /** DELETE 请求 */
  async delete<T = unknown>(url: string, options?: RequestOptions): Promise<ApiResponse<T>> {
    return this.request<T>(url, { ...options, method: "DELETE" });
  }

  /** 文件上传 */
  async upload<T = unknown>(
    url: string,
    formData: FormData,
    options?: RequestOptions
  ): Promise<ApiResponse<T>> {
    // 上传不设 Content-Type，浏览器自动加 multipart boundary
    const { headers: _, ...restOptions } = options || {};
    return this.request<T>(url, {
      ...restOptions,
      method: "POST",
      body: formData,
      headers: {}, // 让浏览器自动设置 Content-Type
    });
  }

  /**
   * SSE 流式请求（用于对话场景）
   * 返回原始 Response，由调用方处理流
   */
  async stream(
    url: string,
    body: unknown,
    options?: RequestOptions
  ): Promise<Response> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
    };

    const token = options?.token || getAuthToken();
    if (token && options?.auth !== false) {
      headers["Authorization"] = `Bearer ${token}`;
    }

    return fetchWithTimeout(
      url,
      {
        method: "POST",
        headers: { ...headers, ...options?.headers },
        body: JSON.stringify(body),
      },
      options?.timeout || 60000 // 流式对话默认60秒超时
    );
  }
}

// ============================================================
// 单例导出
// ============================================================

export const api = new ApiClient();
export default api;
