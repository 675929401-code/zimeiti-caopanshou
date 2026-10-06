export interface CozeCaptionItem {  video_url?: string;
  url?: string; desc?: string; nickname?: string; digg_count?: number;
  caption?: string; cover?: string; aweme_id?: string; error?: string;
}
export interface CozeWorkflowOutput {
  final_result?: string; mode?: string; success_count?: number; success?: boolean;
  captions?: CozeCaptionItem[]; provider_task_id?: string;
  summary?: string;
  texts?: Array<{ row: number; col: number; platform: string; success: boolean; content: string; title: string }>;
  videos?: Array<{ row: number; col: number; platform: string; success: boolean; url: string; download_url: string; cover: string; title: string }>;
}
export interface CozeCaptionResult {
  row: number; url: string; title: string; author: string; likes: number;
  success: boolean; content?: string; error?: string;
}
const text = (value: unknown): string => typeof value === 'string' ? value.trim() : '';
const object = (value: unknown): Record<string, unknown> | null => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const ERROR_OR_REPORT = /提取失败|解析失败|无结果|出错了|请求失败|接口异常|Arrearage|ASR.*失败|仅有标题|仅获取到.*标题|\[提取失败|^【.*模式】|视频标题[:：]|口播文案[:：]|共提取\s*\d|成功\s*0\s*条/im;

/** Only actual captions count toward delivery and billing; summaries and titles never substitute. */
export function cozeCaptionResults(output: CozeWorkflowOutput, mode: string, limit = 30): CozeCaptionResult[] {
  const max = Math.max(1, Math.min(30, Number.isFinite(limit) ? Math.floor(limit) : 30));
  const captions = Array.isArray(output.captions) ? output.captions.slice(0, max) : [];
  if (captions.length) return captions.map((raw, index) => {
    const item = object(raw) || {};
    const content = text(item.caption);
    const error = typeof item.error === 'string' ? text(item.error) : item.error ? '这条视频识别未成功' : '';
    const invalidCount = output.success_count !== undefined && (!Number.isInteger(output.success_count) || output.success_count < 0);
    const explicitFailure = invalidCount || output.success === false || output.success_count === 0 || item.success === false || item.is_fallback === true;
    const success = Boolean(content && !error && !explicitFailure);
    return { row: index + 1, url: text(item.url), title: text(item.desc), author: text(item.nickname),
      likes: typeof item.digg_count === 'number' && Number.isFinite(item.digg_count) ? item.digg_count : 0,
      success, ...(success ? { content } : { error: error || '工作流未返回这条视频的有效口播文案' }) };
  });
  const finalText = text(output.final_result);
  // Legacy single-text responses require an explicit success claim and must not be a report.
  const success = output.success !== false && ['single_video', 'video'].includes(mode) && output.success_count === 1 && Boolean(finalText) && !ERROR_OR_REPORT.test(finalText);
  return [{ row: 1, url: '', title: '', author: '', likes: 0, success,
    ...(success ? { content: finalText } : { error: '工作流未返回有效口播文案' }) }];
}

export function parseCozeWorkflowResult(value: unknown, depth = 0): CozeWorkflowOutput {
  if (depth > 5) throw new Error('工作流返回的数据层级无效');
  if (typeof value === 'string') {
    try { return parseCozeWorkflowResult(JSON.parse(value), depth + 1); } catch { /* Try explicit SSE output. */ }
    let result: CozeWorkflowOutput | undefined;
    for (const frame of value.split(/\r?\n\r?\n/)) {
      const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
      if (!data || data === '[DONE]') continue;
      try { result = parseCozeWorkflowResult(JSON.parse(data), depth + 1); } catch { /* Ignore progress frames. */ }
    }
    if (result) return result;
    throw new Error('工作流未返回可确认的结构化结果');
  }
  const data = object(value);
  if (!data) throw new Error('工作流返回的数据格式无效');
  if (data.captions !== undefined && !Array.isArray(data.captions)) throw new Error('工作流返回的文案列表格式无效');
  if (typeof data.final_result === 'string' || Array.isArray(data.captions)) return data as CozeWorkflowOutput;
  if (data.output !== undefined) return parseCozeWorkflowResult(data.output, depth + 1);
  if (data.data !== undefined && (data.code === undefined || data.code === 0)) return parseCozeWorkflowResult(data.data, depth + 1);
  if (data.type === 'Message' && data.content !== undefined) return parseCozeWorkflowResult(data.content, depth + 1);
  throw new Error('工作流未返回可确认的结构化结果');
}

export class CozeWorkflowExecutionError extends Error {
  constructor(message: string, readonly terminal = false, readonly providerTaskId?: string) { super(message); this.name = 'CozeWorkflowExecutionError'; }
}
export function cozeWorkflowFailure(error: unknown) {
  const terminal = error instanceof CozeWorkflowExecutionError && error.terminal;
  return {
    success: false, charged: false, billing_unknown: false, provider_call_started: true,
    ...(terminal ? { upstream_completed: true } : { retry_safe: false }),
    ...(error instanceof CozeWorkflowExecutionError && error.providerTaskId ? { provider_task_id: error.providerTaskId } : {}),
    error: terminal ? '文案提取未成功，本次未扣费。' : '文案结果待确认，原请求已保留，本次未扣费。',
  };
}
