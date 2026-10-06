import { NextRequest } from 'next/server';
import { queryLongTextTask, localizeError } from '@/lib/volcengine';
import { getUserFromRequest } from '@/lib/auth';
import { successResponse, errorResponse } from '@/lib/response';
import { prisma } from '@/lib/prisma';
import { deductBalance } from '@/lib/billing';

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const { taskId, speaker, text } = body;

  if (!taskId) return errorResponse('taskId 参数不能为空', 'VALIDATION_ERROR', 400);

  try {
    const result = await queryLongTextTask(taskId);

    // 任务完成时扣费
    if (result.taskStatus === 2 && result.audioUrl) {
      const authUser = await getUserFromRequest(request);
      if (authUser && text) {
        const charCount = text.length;
        const deductResult = await deductBalance(
          authUser.userId, charCount, taskId,
          `长文本TTS扣费 (${charCount}字符, ${speaker || 'unknown'})`,
        );
        return successResponse({
          taskStatus: result.taskStatus,
          audioUrl: result.audioUrl,
          sentences: result.sentences,
          reqTextLength: result.reqTextLength,
          synthesizeTextLength: result.synthesizeTextLength,
          urlExpireTime: result.urlExpireTime,
          billing: deductResult.success
            ? { cost: deductResult.cost, balance: deductResult.balance }
            : { billingError: deductResult.error },
        }, '长文本合成完成');
      }
    }

    const statusMap: Record<number, string> = { 1: '合成中', 2: '成功', 3: '失败' };
    return successResponse({
      taskStatus: result.taskStatus,
      audioUrl: result.audioUrl,
      sentences: result.sentences,
      reqTextLength: result.reqTextLength,
      synthesizeTextLength: result.synthesizeTextLength,
      urlExpireTime: result.urlExpireTime,
    }, statusMap[result.taskStatus] || '未知状态');
  } catch (error: any) {
    return errorResponse(localizeError(error), 'TTS_ERROR', 500);
  }
}
