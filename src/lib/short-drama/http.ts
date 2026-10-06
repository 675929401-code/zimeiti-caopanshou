import { NextResponse } from "next/server";
import { z } from "zod";
import { ShortDramaAccessError } from "./permissions";
import { ShortDramaRepositoryError } from "./repository";

export class ShortDramaHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ShortDramaHttpError";
  }
}

export async function parseShortDramaJson<T extends z.ZodType>(
  request: Request,
  schema: T,
): Promise<z.output<T>> {
  let value: unknown;
  try {
    value = await request.json();
  } catch {
    throw new ShortDramaHttpError(400, "INVALID_JSON", "请求正文必须是有效 JSON");
  }
  return schema.parse(value);
}

export function shortDramaErrorResponse(error: unknown, routeTag: string): NextResponse {
  if (
    error instanceof ShortDramaAccessError ||
    error instanceof ShortDramaRepositoryError ||
    error instanceof ShortDramaHttpError
  ) {
    return NextResponse.json(
      { error: error.message, code: error.code },
      { status: error.status },
    );
  }

  if (error instanceof z.ZodError) {
    return NextResponse.json(
      {
        error: "请求参数不符合要求",
        code: "VALIDATION_ERROR",
        issues: error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      },
      { status: 400 },
    );
  }

  // 不输出底层数据库、环境变量或供应商错误详情。
  console.error(`[short-drama:${routeTag}] unexpected error type`,
    error instanceof Error ? error.name : typeof error);
  return NextResponse.json(
    { error: "影视工坊服务暂时不可用", code: "SHORT_DRAMA_INTERNAL_ERROR" },
    { status: 500 },
  );
}

