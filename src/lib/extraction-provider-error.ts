export type ExtractionDisplayMode = 'text' | 'video';

const SECRET_OR_INFRA_PATTERN = /(?:\b(?:api|http|endpoint|provider|token|secret|credential|authorization|bearer)\b|api[_ -]?key|client[_ -]?secret|clientSecretKey|sk-[A-Za-z0-9_-]{6,}|供应商|上游|渠道|密钥|数据库|迁移|作业键|预占)/iu;
const ERROR_FIELD_PATTERN = /(?:^|_)(?:error|message|detail|reason|failure|final_result)(?:$|_)/iu;

function genericExtractionFailure(mode: ExtractionDisplayMode) {
  return mode === 'video'
    ? '视频提取服务暂时无法完成本次请求，请稍后重试。'
    : '文案提取服务暂时无法完成本次请求，请稍后重试。';
}

export function extractionProviderProblem(error: unknown, mode: ExtractionDisplayMode = 'text'): { code: string; message: string } | undefined {
  if (typeof error !== 'string') return undefined;
  if (/\bArrearage\b/i.test(error)) return {
    code: 'EXTRACTION_PROVIDER_QUOTA',
    message: mode === 'video' ? '视频提取服务暂不可用，请稍后重试。' : '文案识别服务暂不可用，请稍后重试。',
  };
  return undefined;
}

export function readableExtractionError(error: string, mode: ExtractionDisplayMode = 'text'): string {
  const current = extractionProviderProblem(error, mode)?.message || String(error || '').trim();
  if (!current || SECRET_OR_INFRA_PATTERN.test(current)) return genericExtractionFailure(mode);
  return current.slice(0, 500);
}

/** Remove provider credentials and infrastructure details before output or persistence. */
export function sanitizeExtractionErrorFields(
  value: unknown,
  mode: ExtractionDisplayMode = 'text',
  fieldName = '',
): unknown {
  if (typeof value === 'string') {
    if (/sk-[A-Za-z0-9_-]{6,}/iu.test(value) || ERROR_FIELD_PATTERN.test(fieldName)) {
      return readableExtractionError(value, mode);
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(item => sanitizeExtractionErrorFields(item, mode, fieldName));
  }
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .map(([key, nested]) => [key, sanitizeExtractionErrorFields(nested, mode, key)]),
  );
}
