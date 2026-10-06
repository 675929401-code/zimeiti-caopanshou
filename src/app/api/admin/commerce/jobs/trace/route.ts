import { NextRequest, NextResponse } from 'next/server';
import { requireCommerceAdmin } from '@/lib/commerce-admin-auth';
import { job, type Job } from '@/commerce/server/jobs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function administratorTrace(value: Job) {
  return {
    id: value.id,
    owner: value.owner,
    route: value.route,
    input: value.input,
    prompt: {
      id: value.route?.promptId,
      version: value.promptVersion,
      compiled: value.compiledPrompt,
    },
    configuration: value.configurationSnapshot,
    model: {
      id: value.model.id,
      name: value.model.displayName,
      source: value.model.source,
      protocol: value.model.protocol || 'main-gateway',
      configHash: value.model.configHash,
    },
    context: value.conversationContext
      ? {
          version: value.conversationContext.version,
          sha256: value.conversationContext.sha256,
          capturedAt: value.conversationContext.capturedAt,
          messageCount: value.conversationContext.messages.length,
          textCharacters: value.conversationContext.textCharacters,
        }
      : null,
    status: value.status,
    events: value.events || [],
    providerTaskId: value.providerTaskId,
    usage: value.usage,
    assetIds: value.assetIds,
    error: value.error,
  };
}

export async function GET(request: NextRequest) {
  const auth = await requireCommerceAdmin(request, {
    requiredPermissions: ['logs.view', 'member_content.view', 'prompts.view', 'models.view'],
    stepUpPermissions: ['prompts.view'],
    operation: 'commerce_job_trace_view',
  });
  if ('response' in auth) return auth.response;
  const query = new URL(request.url).searchParams;
  const id = query.get('id') || '';
  const owner = query.get('owner') || '';
  if (!id || !owner) {
    return NextResponse.json(
      { ok: false, code: 'COMMERCE_ADMIN_TRACE_IDENTITY_REQUIRED', error: '缺少任务或所有者标识' },
      { status: 400, headers: { 'Cache-Control': 'no-store' } },
    );
  }
  const value = job(id, owner);
  if (!value) {
    return NextResponse.json(
      { ok: false, code: 'COMMERCE_ADMIN_TRACE_NOT_FOUND', error: '任务不存在' },
      { status: 404, headers: { 'Cache-Control': 'no-store' } },
    );
  }
  return NextResponse.json(
    { ok: true, trace: administratorTrace(value) },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
