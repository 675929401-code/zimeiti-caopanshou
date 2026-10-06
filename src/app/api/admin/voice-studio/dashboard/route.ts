import { NextResponse } from 'next/server';
import { readVoiceCatalog } from '@/lib/voice-studio/catalog';
import { getSupabaseClient } from '@/storage/database/supabase-client';
import { withAdminAuth } from '@/lib/api-middleware';
import { inspectVolcanoVoiceProviderConfig } from '@/lib/server/voice-provider-config';

export const dynamic = 'force-dynamic';
function shanghaiDayStart(now: Date) {
  const day = new Date(now.getTime() + 8 * 3600000).toISOString().slice(0, 10);
  return new Date(day + 'T00:00:00+08:00').toISOString();
}

export async function GET(request: Request) {
  return withAdminAuth(request, async () => {
    try {
      const db = getSupabaseClient(), now = new Date(), since = shanghaiDayStart(now), asOf = now.toISOString();
      const [users, jobs, recent, licenses, providerConfig] = await Promise.all([
        db.from('users').select('id', { count: 'exact', head: true }),
        db.from('voice_generation_requests').select('id', { count: 'exact', head: true }).eq('state', 'completed').gte('completed_at', since).lte('completed_at', asOf),
        db.from('voice_generation_requests').select('id,model_id,state,charge_credits,refunded_credits,started_at,generation_id').order('started_at', { ascending: false }).limit(10),
        db.from('voice_clone_licenses').select('id', { count: 'exact', head: true }).eq('status', 'active'),
        inspectVolcanoVoiceProviderConfig(),
      ]);
      for (const result of [users, jobs, recent, licenses]) if (result.error) throw new Error('VOICE_DASHBOARD_QUERY_FAILED');
      const voices = readVoiceCatalog();
      let revenue = 0, cursor = '';
      // Cursor pagination avoids the REST default row cap; every task uses its
      // own frozen exchange rate. It does not read an upstream wallet balance.
      while (true) {
        let query = db.from('voice_generation_requests').select('id,charge_credits,refunded_credits,price_snapshot').eq('state', 'completed').gte('completed_at', since).lte('completed_at', asOf).order('id', { ascending: true }).limit(500);
        if (cursor) query = query.gt('id', cursor);
        const page = await query;
        if (page.error) throw new Error('VOICE_DASHBOARD_BILLING_UNAVAILABLE');
        const rows = page.data || [];
        for (const row of rows) {
          const credits = Math.max(0, Number(row.charge_credits) - Number(row.refunded_credits));
          if (credits === 0) continue;
          const rate = Number(row.price_snapshot?.creditsPerYuan);
          if (!Number.isFinite(credits) || !Number.isFinite(rate) || rate <= 0) throw new Error('VOICE_DASHBOARD_SNAPSHOT_INVALID');
          revenue += credits / rate;
        }
        if (rows.length < 500) break;
        const next = String(rows[rows.length - 1].id);
        if (!next || next === cursor) throw new Error('VOICE_DASHBOARD_CURSOR_INVALID');
        cursor = next;
      }
      return NextResponse.json({ success: true, data: {
        totalUsers: users.count || 0, totalVoices: voices.length, todayJobs: jobs.count || 0,
        activeApiKeys: providerConfig.configured ? 1 : 0, providerConfig, activeLicenses: licenses.count || 0,
        todayRevenue: (Math.round(revenue * 1e6) / 1e6).toFixed(2), timezone: 'Asia/Shanghai', since, asOf,
        recentJobs: (recent.data || []).map((row: { id:string; model_id:string; state:string; charge_credits:number; refunded_credits:number; started_at:string; generation_id:string|null }) => ({ id: row.id, model: row.model_id, status: row.state, cost: Math.max(0, Number(row.charge_credits) - Number(row.refunded_credits)), createdAt: row.started_at, generationId: row.generation_id })),
      } }, { headers: { 'Cache-Control': 'no-store' } });
    } catch (error) {
      console.error('[voice-studio dashboard]', error instanceof Error ? error.message : 'statistics failed');
      return NextResponse.json({ success: false, code: 'VOICE_DASHBOARD_UNAVAILABLE', message: '语音统计暂时无法读取，请稍后刷新。' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
    }
  });
}
