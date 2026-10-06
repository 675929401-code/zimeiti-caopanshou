import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseClient } from '@/storage/database/supabase-client';
import { getTokenFromHeaders, verifyToken } from '@/lib/auth';

// GET /api/trial-plans - 鑾峰彇鍙敤鐨勮瘯鐢ㄥ椁愬垪琛紙鍏叡鎺ュ彛锛?
export async function GET(request: NextRequest) {
  try {
    const client = getSupabaseClient();

    // 鑾峰彇鎵€鏈夋縺娲荤殑璇曠敤濂楅
    const { data: plans, error } = await client
      .from('trial_plans')
      .select('*')
      .eq('is_active', true)
      .order('sort_order', { ascending: true });

    if (error) return NextResponse.json({ error: '实时试用套餐数据暂不可用', code: 'REALTIME_DATA_UNAVAILABLE' }, { status: 503 });

    // 鑾峰彇姣忎釜濂楅鍏宠仈鐨勬櫤鑳戒綋鍚嶇О
    const plansWithDetails = await Promise.all((plans || []).map(async (plan: Record<string, unknown>) => {
      const { data: agentLinks } = await client
        .from('trial_plan_agents')
        .select('agent_id')
        .eq('plan_id', plan.id);

      const agentIds = (agentLinks || []).map((link: { agent_id: string }) => link.agent_id);

      // 鑾峰彇鏅鸿兘浣撳悕绉?
      let agentNames: string[] = [];
      if (agentIds.length > 0) {
        const { data: agents } = await client
          .from('agents')
          .select('name')
          .in('id', agentIds);
        agentNames = (agents || []).map((a: { name: string }) => a.name);
      }

      return {
        id: plan.id,
        name: plan.name,
        description: plan.description || '',
        credits: plan.credits,
        duration_days: plan.duration_days,
        agent_ids: agentIds,
        agent_names: agentNames,
      };
    }));

    // 妫€鏌ョ敤鎴锋槸鍚﹀凡婵€娲昏繃璇曠敤
    let hasUsedTrial = false;
    try {
      const token = getTokenFromHeaders(request.headers);
      if (token) {
        const payload = await verifyToken(token);
        if (payload) {
          const { data: activations } = await client
            .from('user_trial_activations')
            .select('id')
            .eq('user_id', payload.userId)
            .limit(1);
          hasUsedTrial = (activations || []).length > 0;
        }
      }
    } catch {
      // token楠岃瘉澶辫触涓嶅奖鍝?
    }

    return NextResponse.json({ plans: plansWithDetails, hasUsedTrial });
  } catch (err) {
    console.error('Get trial plans error:', err);
    return NextResponse.json({ error: '实时试用套餐数据暂不可用', code: 'REALTIME_DATA_UNAVAILABLE' }, { status: 503 });
  }
}
