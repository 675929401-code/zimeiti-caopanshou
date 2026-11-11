/** Provider messages may echo private compiler input. Only local copy is public. */
export function coverPublicImageIssue(value: unknown) {
  const payload = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const messages: Record<string, string> = {
    INSUFFICIENT_BALANCE: "余额不足，请核对原任务费用后补充余额。",
    INSUFFICIENT_CASH_BALANCE: "现金余额不足，请核对原任务费用后补充余额。",
    IMAGE_MODEL_NOT_READY: "当前图片模型暂不能生成，请保留方案并查询原任务。",
    IMAGE_MODEL_UNAVAILABLE: "当前图片模型暂不可用，请保留方案并查询原任务。",
    IMAGE_REQUEST_REJECTED: "图片请求已结束，请核对原任务及费用后调整方案。",
    COVER_ORIGINAL_TEXT_DOES_NOT_FIT: "完整原图的安全文字区放不下当前标题，请精简标题或副标题；原图未改动，本次未调用生图。",
    COVER_ORIGINAL_SOURCE_MISMATCH: "原图尺寸与确认方案不一致，请重新确认排版；原图未改动，本次未调用生图。",
  };
  const code = typeof payload.code === "string" && Object.hasOwn(messages, payload.code) ? payload.code : "COVER_IMAGE_RESULT_PENDING";
  return { code, message: messages[code] || "原图片任务结果尚未确认，请查询原单；系统不会重复提交。" };
}
export function coverPublicImageFailure(value: unknown, terminal = false) {
  const issue = coverPublicImageIssue(value);
  return { success: false, status: terminal ? "failed" : "unknown", code: issue.code, error: issue.message, retryable: false };
}
