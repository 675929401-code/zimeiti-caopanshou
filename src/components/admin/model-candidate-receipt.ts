export interface ModelCandidateReceipt {
  id: string;
  version: number | null;
  replayed?: boolean;
  published?: boolean;
  isCurrent?: boolean;
}

/** A successful HTTP response alone does not prove that a candidate was saved. */
export function readModelCandidateReceipt(value: unknown): ModelCandidateReceipt {
  const body = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const result = body.result && typeof body.result === "object" ? body.result as Record<string, unknown> : {};
  const release = result.release && typeof result.release === "object" ? result.release as Record<string, unknown> : {};
  const id = typeof release.id === "string" ? release.id : "";
  const replayedPublished = body.replayed === true && body.published === true
    && (release.status === "published" || release.status === "superseded" || release.is_current === true);
  if (body.staged !== true || (body.published !== false && !replayedPublished) || !/^[a-z0-9_-]{1,128}$/iu.test(id)) {
    throw new Error("保存回执缺少可核对的候选编号，请先刷新版本列表核对结果，避免重复创建。");
  }
  const version = Number(release.release_version);
  return { id, version: Number.isSafeInteger(version) && version > 0 ? version : null,
    ...(body.replayed === true ? { replayed: true, published: replayedPublished, isCurrent: release.is_current === true } : {}) };
}

export function modelCandidateSaveMessage(receipt: ModelCandidateReceipt, draftMessage: string): string {
  if (!receipt.replayed) return draftMessage;
  if (!receipt.published) return "已读取原操作保存的候选，请核对该候选的当前状态并完成后续步骤。";
  return receipt.isCurrent
    ? "原操作对应的模型池版本已发布且为当前版本。请继续核对真实验证和工作台分配状态。"
    : "原操作对应历史已发布版本。请核对当前版本，避免重新发布历史配置。";
}

export function modelCandidateRequestUncertain(status?: number, code?: string): boolean {
  return status == null || status >= 500 || status === 408 || /READBACK|RESULT_UNKNOWN/iu.test(code || "");
}
