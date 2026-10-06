import { NextRequest, NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { withAuth } from '@/lib/api-middleware';
import { extractionHistoryEntry } from '@/lib/extraction-history';

export const dynamic = 'force-dynamic';
const PAGE_SIZE = 20;

export async function GET(request: NextRequest) {
  return withAuth(request, async (user, authenticatedDb) => {
    const before = request.nextUrl.searchParams.get('before');
    const beforeId = request.nextUrl.searchParams.get('before_id');
    if ((before || beforeId) && (!before || !beforeId || !Number.isFinite(Date.parse(before)) || !/^[a-f0-9]{64}$/.test(beforeId))) {
      return NextResponse.json({ error: '历史分页参数无效' }, { status: 400 });
    }
    const db = authenticatedDb as SupabaseClient;
    const snapshotReadiness = await db.from('extraction_attempts').select('request_snapshot').limit(1);
    const result = await db.rpc('read_extraction_account_history', { p_user_id: user.id, p_before: before, p_before_id: beforeId, p_limit: PAGE_SIZE + 1 });
    if (result.error || !Array.isArray(result.data)) return NextResponse.json({ error: '提取历史暂时无法读取，请稍后重试' }, { status: 503 });
    const rows = result.data.slice(0, PAGE_SIZE);
    const retryReady = !snapshotReadiness.error && rows.every(row => Object.prototype.hasOwnProperty.call(row, 'request_snapshot'));
    const last = rows.at(-1);
    return NextResponse.json({
      records: rows.map(extractionHistoryEntry),
      next: result.data.length > PAGE_SIZE && last ? { before: last.created_at, beforeId: last.record_id } : null,
      retryReady,
      ...(retryReady ? {} : { retryUnavailableReason: '暂时无法从失败记录恢复原输入。仍可查看历史和已有结果；结果未确认的请求请勿重复提交。' }),
    }, { headers: { 'Cache-Control': 'private, no-store' } });
  });
}

export async function DELETE(request: NextRequest) {
  return withAuth(request, async (user, authenticatedDb) => {
    let body: { recordId?: unknown; clearAll?: unknown };
    try { body = await request.json(); } catch { return NextResponse.json({ error: '删除请求无效' }, { status: 400 }); }
    if (!body || typeof body !== 'object' || (body.clearAll !== true && (typeof body.recordId !== 'string' || !/^[a-f0-9]{64}$/.test(body.recordId)))) {
      return NextResponse.json({ error: '请选择要删除的历史记录' }, { status: 400 });
    }
    const db = authenticatedDb as SupabaseClient;
    const result = await db.rpc('hide_extraction_account_history', { p_user_id: user.id, p_record_id: body.clearAll === true ? null : body.recordId });
    if (result.error) return NextResponse.json({ error: result.error.code === 'P0002' ? '记录不存在或无权访问' : '删除未成功，请稍后重试' }, { status: result.error.code === 'P0002' ? 404 : 503 });
    return NextResponse.json({ success: true }, { headers: { 'Cache-Control': 'private, no-store' } });
  });
}
