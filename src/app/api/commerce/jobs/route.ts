import { after } from 'next/server';
import { requireIdentity, sameOrigin } from '../../../../commerce/server/auth';
import { authorizeCurrentCommerceIdentity } from '../../../../commerce/server/main-account-access';
import {
  job,
  jobs,
  publicJob,
  retrySave,
  reconcileJobBilling,
} from '../../../../commerce/server/jobs';
import { retakeSegment, zeroCostRollingFixtureEnabled } from '../../../../commerce/server/rolling-video';
import { confirmCommerceQuote } from '../../../../commerce/server/quotes';
import { errorResponse, json } from '../../../../commerce/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function GET(request: Request) {
  try {
    const user = requireIdentity(request);
    const values = jobs(user.id);
    return json({ jobs: values.map(publicJob) });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    sameOrigin(request);
    const user = requireIdentity(request);
    const body = await request.json();

    // Recovery and reconciliation operate only on the original task. They
    // remain available after membership expiry so a completed provider result
    // or an uncertain wallet operation is never stranded.
    if (body.action === 'retry-save') {
      const value = await retrySave(body.id, user.id);
      return json({ job: publicJob(value) });
    }
    if (body.action === 'reconcile-billing') {
      const value = await reconcileJobBilling(String(body.id || ''), user.id);
      return json({ job: publicJob(value) });
    }

    await authorizeCurrentCommerceIdentity(user);

    if (body.action === 'rolling-retake') {
      if (!zeroCostRollingFixtureEnabled()) throw Error('长视频分段重拍需要单独报价，当前入口已停止无报价重拍');
      const value = job(body.id, user.id);
      if (!value || !value.input.rollingPlan) throw Error('滚动任务不存在');
      const segment = Number(body.segment);
      after(async () => {
        try {
          await retakeSegment(value, user.id, segment);
        } catch {
          // Background state is persisted by the rolling task implementation.
        }
      });
      return json({ ok: true, segment, started: true }, 202);
    }

    const value = await confirmCommerceQuote(user.id, {
      quoteId: body.quoteId,
      clientRequestId: body.clientRequestId,
      inputFingerprint: body.inputFingerprint,
    });
    // Quote confirmation durably creates the queued job. Only the dedicated
    // Commerce worker may claim and dispatch it, so concurrent web requests
    // cannot fan out into an unbounded number of provider calls.
    return json({ job: publicJob(value) }, 202);
  } catch (error) {
    return errorResponse(error);
  }
}
