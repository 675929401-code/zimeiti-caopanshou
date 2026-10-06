import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseClient } from '@/storage/database/supabase-client';
import { getTokenFromHeaders } from '@/lib/auth';
import { verifyAdminToken } from "@/lib/admin-auth";
import { listBots, getBotInfo } from '@/lib/coze-api';

async function requireAdmin(request: NextRequest) {
  const token = getTokenFromHeaders(request.headers);
  if (!token) return null;
  const payload = await verifyAdminToken(token);
  if (!payload || payload.role !== 'admin') return null;
  return payload;
}

/**
 * POST /api/admin/agents/import-coze
 * 
 * 从扣子平台批量导入智能体到本地数据库
 * 步骤：
 * 1. 调用 Coze API 列出工作空间所有 Bot
 * 2. 对每个 Bot 获取详情（含 system_prompt）
 * 3. 检查本地是否已存在（按 bot_id 去重）
 * 4. 不存在则创建，存在则更新
 * 
 * Body: { overwrite?: boolean }  // overwrite=true 时覆盖已有的名称/描述
 */
export async function POST(request: NextRequest) {
  const admin = await requireAdmin(request);
  if (!admin) {
    return NextResponse.json({ error: '无管理员权限' }, { status: 403 });
  }

  try {
    const body = await request.json().catch(() => ({}));
    const overwrite = body.overwrite === true;

    // Step 1: 从 Coze API 获取所有 Bot 列表
    console.log('[import-coze] Fetching bot list from Coze...');
    const listResult = await listBots(1, 100);
    const botList: Array<Record<string, unknown>> = Array.isArray(listResult?.data)
      ? listResult.data
      : listResult?.data?.items || [];

    if (botList.length === 0) {
      return NextResponse.json({ 
        success: true, 
        imported: 0, 
        updated: 0, 
        skipped: 0,
        message: 'Coze 工作空间中没有找到智能体，请检查 API 配置' 
      });
    }

    console.log(`[import-coze] Found ${botList.length} bots on Coze`);

    // Step 2: 获取本地已有的 bot_id 列表
    const client = getSupabaseClient();
    const { data: existingAgents } = await client
      .from('agents')
      .select('id, bot_id, name')
      .is('deleted_at', null);
    
    const existingBotIds = new Map<string, string>();
    (existingAgents || []).forEach((a: Record<string, unknown>) => {
      if (a.bot_id) existingBotIds.set(a.bot_id as string, a.id as string);
    });

    let imported = 0;
    let updated = 0;
    let skipped = 0;
    let failed = 0;
    const details: Array<{ name: string; status: string; error?: string }> = [];

    // Step 3: 逐个获取详情并导入
    for (const bot of botList) {
      const botId = bot.bot_id as string;
      const botName = bot.bot_name as string;

      try {
        // 获取 Bot 详情（含 system_prompt）
        const detailResult = await getBotInfo(botId);
        const botDetail = detailResult?.data || bot;

        // 提取字段
        const name = (botDetail.bot_name || botName || '').trim();
        const description = (botDetail.description || bot.description || '').trim();
        const iconUrl = botDetail.icon_url || bot.icon_url || '';
        
        // 提取 system_prompt — Coze API 返回在 prompt_info 字段
        let systemPrompt = '';
        const promptInfo = botDetail.prompt_info;
        if (typeof promptInfo === 'string') {
          systemPrompt = promptInfo;
        } else if (promptInfo && typeof promptInfo === 'object') {
          systemPrompt = (promptInfo as Record<string, unknown>).prompt as string || '';
        }

        if (!name) {
          details.push({ name: `Bot-${botId}`, status: 'skipped', error: '名称为空' });
          skipped++;
          continue;
        }

        const isExisting = existingBotIds.has(botId);

        if (isExisting && !overwrite) {
          details.push({ name, status: 'skipped', error: '已存在' });
          skipped++;
          continue;
        }

        if (isExisting && overwrite) {
          // 更新已有的
          const agentId = existingBotIds.get(botId)!;
          const { error } = await client
            .from('agents')
            .update({
              name,
              description,
              avatar: iconUrl,
              system_prompt: systemPrompt,
              updated_at: new Date().toISOString(),
            })
            .eq('id', agentId);

          if (error) {
            details.push({ name, status: 'failed', error: error.message });
            failed++;
          } else {
            details.push({ name, status: 'updated' });
            updated++;
          }
        } else {
          // 新增
          const agentId = `agent-coze-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
          const { error } = await client
            .from('agents')
            .insert({
              id: agentId,
              name,
              description,
              avatar: iconUrl,
              category: '通用',
              source: 'coze',
              bot_id: botId,
              model: '',
              system_prompt: systemPrompt,
              cost_per_message: 10,
              sort_order: imported + 1,
              is_active: true,
            });

          if (error) {
            details.push({ name, status: 'failed', error: error.message });
            failed++;
          } else {
            existingBotIds.set(botId, agentId); // 防止重复
            details.push({ name, status: 'imported' });
            imported++;
          }
        }

        // 避免请求过快
        await new Promise(resolve => setTimeout(resolve, 200));

      } catch (err) {
        const errMsg = err instanceof Error ? err.message : '未知错误';
        details.push({ name: botName || botId, status: 'failed', error: errMsg });
        failed++;
      }
    }

    console.log(`[import-coze] Done: imported=${imported}, updated=${updated}, skipped=${skipped}, failed=${failed}`);

    return NextResponse.json({
      success: true,
      imported,
      updated,
      skipped,
      failed,
      total: botList.length,
      details,
    });

  } catch (err) {
    console.error('[import-coze] Error:', err);
    return NextResponse.json({ 
      error: `导入失败: ${err instanceof Error ? err.message : '未知错误'}` 
    }, { status: 500 });
  }
}
