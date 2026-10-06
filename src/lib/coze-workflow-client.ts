import { CozeWorkflowExecutionError, parseCozeWorkflowResult, type CozeWorkflowOutput } from '@/lib/coze-extraction-result';
import { checkpointExtractionProviderTask } from '@/lib/extraction-exactly-once';

export type CozeExtractMode = "single_video" | "creator_page" | "search";

export function detectCozeCaptionMode(shareText: string): CozeExtractMode {
  const text = shareText.trim();
  if (text.includes("/user/")) return "creator_page";
  if (/更多作品|TA的更多/.test(text) && /v\.douyin\.com/.test(text)) return "creator_page";
  if (text.includes("/video/") || /https?:\/\//.test(text)) return "single_video";
  return "search";
}

export async function runCozeCaptionWorkflow(
  config: { apiUrl: string; apiToken: string }, shareText: string, mode?: string, minLikes?: number, maxCount?: number
): Promise<CozeWorkflowOutput> {
  const detectedMode = detectCozeCaptionMode(shareText);
  const modeMap: Record<string, string> = { single_video: 'video', creator_page: 'homepage', search: 'search' };
  const requestBody = { share_text: shareText, min_likes: minLikes ?? 0, max_count: maxCount ?? 10, mode: mode || modeMap[detectedMode] };
  const baseUrl = config.apiUrl.replace(/\/run$/, '').replace(/\/$/, '');
  const submitResponse = await fetch(baseUrl + '/async_run', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + config.apiToken },
    body: JSON.stringify(requestBody), signal: AbortSignal.timeout(30000),
  });
  if (!submitResponse.ok) throw new CozeWorkflowExecutionError('工作流提交失败(' + submitResponse.status + ')', submitResponse.status >= 400 && submitResponse.status < 500 && submitResponse.status !== 408);
  const submitted = await submitResponse.json() as { task_id?: string };
  const taskId = submitted.task_id;
  if (!taskId || !/^[A-Za-z0-9_-]{1,128}$/.test(taskId)) throw new CozeWorkflowExecutionError('工作流未返回有效任务编号');
  try { await checkpointExtractionProviderTask(taskId); }
  catch { throw new CozeWorkflowExecutionError('原工作流任务编号的保存结果暂未确认', false, taskId); }
  console.log('[Extract-Coze] original task:', taskId);
  const startedAt = Date.now();
  try {
    while (Date.now() - startedAt < 300000) {
      await new Promise(resolve => setTimeout(resolve, 3000));
      let polled: Response;
      try {
        polled = await fetch(baseUrl + '/task/' + encodeURIComponent(taskId), {
          headers: { Authorization: 'Bearer ' + config.apiToken }, signal: AbortSignal.timeout(10000),
        });
      } catch { continue; } // Only repeat this read; never repeat async_run.
      if (!polled.ok) {
        if ([401, 403, 404].includes(polled.status)) throw new CozeWorkflowExecutionError('暂时无法查询原工作流任务', false, taskId);
        continue;
      }
      const task = await polled.json() as { status?: string; task_id?: string; result?: unknown; error?: unknown };
      if (task.task_id && task.task_id !== taskId) throw new CozeWorkflowExecutionError('工作流返回的任务编号不一致', false, taskId);
      if (task.status === 'completed') {
        if (task.error || !task.result) throw new CozeWorkflowExecutionError('工作流未成功返回文案', true, taskId);
        try { return { ...parseCozeWorkflowResult(task.result), provider_task_id: taskId }; }
        catch { throw new CozeWorkflowExecutionError('工作流已结束，但结果格式无效', true, taskId); }
      }
      if (['failed', 'cancelled', 'canceled'].includes(task.status || '')) throw new CozeWorkflowExecutionError('工作流未成功完成识别', true, taskId);
    }
    throw new CozeWorkflowExecutionError('工作流结果暂未确认', false, taskId);
  } catch (error) {
    if (error instanceof CozeWorkflowExecutionError) throw error;
    throw new CozeWorkflowExecutionError('工作流结果暂未确认', false, taskId);
  }
}

