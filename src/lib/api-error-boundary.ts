/**
 * API 错误隔离层
 *
 * 为每个 API 路由提供独立的错误处理边界，确保：
 * 1. 单个 API 异常不导致整个服务 crash
 * 2. 异常仅按脱敏类型记录到本地日志
 * 3. 返回统一格式的错误响应
 *
 * 用法：
 * ```ts
 * import { apiHandler } from "@/lib/api-error-boundary";
 *
 * export const GET = apiHandler(async (request) => {
 *   // 业务逻辑，throw 会被自动捕获
 *   return Response.json({ success: true });
 * });
 * ```
 */

type ApiHandler = (request: Request, ...args: unknown[]) => Promise<Response>;

interface ApiErrorResponse {
  error: string;
  code: string;
  detail?: string;
}

/**
 * 包裹 API 处理函数，提供统一错误隔离
 * - 非业务异常返回 500，不中断服务
 * - 业务异常（ApiError）返回对应状态码
 * - 未预期异常只记录请求方法和错误类型，不记录 URL、正文、消息或堆栈
 */
export function apiHandler(handler: ApiHandler): ApiHandler {
  return async (request: Request, ...args: unknown[]) => {
    try {
      return await handler(request, ...args);
    } catch (error) {
      // ApiError 是预期的业务错误
      if (error instanceof ApiError) {
        return Response.json(
          { error: error.message, code: error.code, detail: error.detail },
          { status: error.status },
        );
      }

      // 非预期异常 — 只保留本地、无用户内容的分类日志，不做远程上报。
      const method = /^[A-Z]{3,16}$/u.test(request.method) ? request.method : "UNKNOWN";
      const rawErrorName = error instanceof Error ? error.name : "NonErrorThrow";
      const errorName = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u.test(rawErrorName)
        ? rawErrorName
        : "Error";
      console.error(`[API隔离] method=${method} type=${errorName}`);

      // 生产环境返回通用错误，不暴露内部细节
      return Response.json(
        { error: "服务器内部错误", code: "INTERNAL_ERROR" } as ApiErrorResponse,
        { status: 500 },
      );
    }
  };
}

/**
 * 业务异常 — 可在 API handler 中抛出
 * 会被 apiHandler 自动捕获并返回对应状态码
 */
export class ApiError extends Error {
  constructor(
    message: string,
    public status: number = 400,
    public code: string = "BAD_REQUEST",
    public detail?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/**
 * 快速创建 400 错误
 */
export function badRequest(message: string, code = "BAD_REQUEST", detail?: string): ApiError {
  return new ApiError(message, 400, code, detail);
}

/**
 * 快速创建 404 错误
 */
export function notFound(message = "资源不存在", code = "NOT_FOUND"): ApiError {
  return new ApiError(message, 404, code);
}

/**
 * 快速创建 403 错误
 */
export function forbidden(message = "无权限访问", code = "FORBIDDEN"): ApiError {
  return new ApiError(message, 403, code);
}

/**
 * 快速创建 401 错误
 */
export function unauthorized(message = "请先登录", code = "UNAUTHORIZED"): ApiError {
  return new ApiError(message, 401, code);
}
