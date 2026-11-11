import { NextResponse } from "next/server";
import { z } from "zod";
import { CoverWorkbenchContractError } from "@/lib/cover-workbench-contract";
import { CoverReviewTitleError } from "@/lib/cover-review-contract";
import { CoverRequestBodyError } from "./cover-request-body";
import { CoverPrepareError } from "./cover-prepare-repository";
import { CoverReviewError } from "./cover-review-operations";
export const coverReviewJson = (value: unknown, status = 200) => NextResponse.json(value, { status, headers: { "Cache-Control": "private, no-store" } });
export function coverReviewFailure(error: unknown) {
  if (error instanceof CoverReviewTitleError) return coverReviewJson({ success: false, code: error.code, error: error.message }, 422);
  if (error instanceof CoverReviewError) return coverReviewJson({ success: false, code: error.code, error: error.message, ...error.publicData }, error.status);
  if (error instanceof CoverPrepareError) return coverReviewJson({ success: false, code: error.code, error: error.message,
    ...(error.code === "COVER_PREPARATION_STALE" ? { reprepareRequired: true } : {}) }, error.status);
  if (error instanceof CoverRequestBodyError) return coverReviewJson({ success: false, code: "COVER_INPUT_INVALID", error: error.message }, error.status);
  if (error instanceof CoverWorkbenchContractError) return coverReviewJson({ success: false, code: error.code, error: error.message }, 422);
  if (error instanceof z.ZodError) return coverReviewJson({ success: false, code: "COVER_REVIEW_INPUT_INVALID", error: "审核字段或操作参数无效，请检查后再继续" }, 422);
  return coverReviewJson({ success: false, code: "COVER_REVIEW_UNAVAILABLE", error: "原任务状态暂时无法确认，请查询原单；不会自动重复提交" }, 503);
}
