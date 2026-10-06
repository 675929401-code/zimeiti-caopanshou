import type { Job } from './jobs';

export type PublicJobTraceStage =
  | 'validated'
  | 'queued'
  | 'running'
  | 'processing'
  | 'saving'
  | 'succeeded'
  | 'failed'
  | 'unknown'
  | 'save_failed';

export type PublicJobErrorSummary = {
  code:
    | 'RESULT_CONFIRMING'
    | 'RESULT_SAVE_FAILED'
    | 'SERVICE_BALANCE_UNAVAILABLE'
    | 'PAYMENT_NOT_COMPLETED'
    | 'CONTENT_REJECTED'
    | 'RESPONSE_INTERRUPTED'
    | 'TASK_FAILED';
  message: string;
  retryable: boolean;
  retryOriginalOnly: boolean;
};

const PUBLIC_STAGES = new Set<PublicJobTraceStage>([
  'validated',
  'queued',
  'running',
  'processing',
  'saving',
  'succeeded',
  'failed',
  'unknown',
  'save_failed',
]);

function publicStage(stage: unknown): PublicJobTraceStage {
  if (stage === 'recovered-undispatched-billing') return 'queued';
  if (typeof stage === 'string' && PUBLIC_STAGES.has(stage as PublicJobTraceStage)) {
    return stage as PublicJobTraceStage;
  }
  return 'processing';
}

function errorSummary(value: Pick<Job, 'status' | 'error'>): PublicJobErrorSummary | null {
  if (value.status === 'unknown') {
    return {
      code: 'RESULT_CONFIRMING',
      message: '原任务结果仍在确认中，请稍后查看；系统不会重复提交。',
      retryable: false,
      retryOriginalOnly: true,
    };
  }
  if (value.status === 'save_failed') {
    return {
      code: 'RESULT_SAVE_FAILED',
      message: '结果已经生成，但保存尚未完成；请重试保存原结果。',
      retryable: true,
      retryOriginalOnly: true,
    };
  }
  if (value.status !== 'failed') return null;

  const diagnostic = String(value.error || '').toLowerCase();
  if (/upstream_balance_exhausted|insufficient[ _-]?(?:balance|funds)|余额不足/u.test(diagnostic)) {
    return {
      code: 'SERVICE_BALANCE_UNAVAILABLE',
      message: '创作服务余额暂时不足，请稍后重试。',
      retryable: true,
      retryOriginalOnly: false,
    };
  }
  if (/钱包|扣费|payment|billing/u.test(diagnostic)) {
    return {
      code: 'PAYMENT_NOT_COMPLETED',
      message: '本次费用处理未完成，请核对余额后重试。',
      retryable: true,
      retryOriginalOnly: false,
    };
  }
  if (/moderation|content[ _-]?policy|content[ _-]?filter|内容审核|违规|敏感/u.test(diagnostic)) {
    return {
      code: 'CONTENT_REJECTED',
      message: '内容未通过安全检查，请调整输入后重试。',
      retryable: true,
      retryOriginalOnly: false,
    };
  }
  if (/text_stream_(?:interrupted|incomplete)|断流|响应不完整/u.test(diagnostic)) {
    return {
      code: 'RESPONSE_INTERRUPTED',
      message: '创作响应未完整返回，请稍后重试。',
      retryable: true,
      retryOriginalOnly: false,
    };
  }
  return {
    code: 'TASK_FAILED',
    message: '任务未完成，请调整输入或稍后重试。',
    retryable: true,
    retryOriginalOnly: false,
  };
}

/**
 * The owner-facing trace is deliberately narrower than the ordinary job DTO.
 * Prompt compilation, routing, model/provider identity and diagnostics remain
 * available only through the main-site administrator namespace.
 */
export function publicJobTrace(value: Job) {
  const events = (value.events || [])
    .filter((event) => Number.isFinite(event.at) && event.at > 0)
    .slice(-100)
    .map((event) => ({ at: event.at, stage: publicStage(event.stage) }));
  return {
    schema: 'commerce-public-job-trace/v1' as const,
    id: value.id,
    kind: value.input.kind,
    status: value.status,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    ...(value.startedAt ? { startedAt: value.startedAt } : {}),
    events,
    errorSummary: errorSummary(value),
  };
}
