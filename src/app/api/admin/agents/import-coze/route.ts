import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseClient } from '@/storage/database/supabase-client';
import { listBots, getBotInfo } from '@/lib/coze-api';
import { authorizeAdminCapability } from '@/lib/server/admin-governance-authority';
import { agentBatchConflict, isAgentBatchConflict, parseExpectedAgentRevision } from '@/lib/server/agent-config-cas';
import { invalidateBotsCache } from '@/lib/bots-cache';
import { invalidateAgentConfigCache } from '@/app/api/llm/llm-state';
import { scheduleAutoAvatarForCreatedAgents } from '@/lib/auto-avatar/schedule';

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
  const managementAccess = await authorizeAdminCapability(request, 'agents.manage', {
    operation: 'agent_coze_import',
    requireStepUp: true,
  });
  if (!managementAccess.ok) return managementAccess.response;

  try {
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const overwrite = body.overwrite === true;
    const expectedRevisions = body.expected_revisions && typeof body.expected_revisions === 'object'
      ? body.expected_revisions as Record<string, unknown>
      : {};
    if (overwrite) {
      const promptAccess = await authorizeAdminCapability(request, 'prompts.edit', {
        operation: 'agent_coze_prompt_overwrite',
        requireStepUp: true,
      });
      if (!promptAccess.ok) return promptAccess.response;
    }

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
      .select('id, bot_id, name, config_revision')
      .is('deleted_at', null);
    
    const existingBotIds = new Map<string, string>();
    const existingRevisions = new Map<string, number>();
    (existingAgents || []).forEach((a: Record<string, unknown>) => {
      if (a.bot_id) {
        existingBotIds.set(a.bot_id as string, a.id as string);
        existingRevisions.set(a.id as string, Number(a.config_revision));
      }
    });

    type CozeMutationEntry = {
      operation: 'insert' | 'update';
      id: string;
      bot_id: string;
      name: string;
      description: string;
      avatar: string;
      system_prompt: string;
      sort_order?: number;
      expected_revision?: number;
    };
    const mutations: CozeMutationEntry[] = [];
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
          const agentId = existingBotIds.get(botId)!;
          const expectedRevision = parseExpectedAgentRevision({ expected_revision: expectedRevisions[agentId] });
          if (expectedRevision === null) {
            return NextResponse.json({
              error: '覆盖导入必须为每个实际覆盖的智能体提供 expected_revisions。',
              code: 'AGENT_EXPECTED_REVISION_REQUIRED',
              agent_id: agentId,
              current_revision: existingRevisions.get(agentId) ?? null,
            }, { status: 400 });
          }
          mutations.push({
            operation: 'update',
            id: agentId,
            bot_id: botId,
            name,
            description,
            avatar: String(iconUrl || ''),
            system_prompt: systemPrompt,
            expected_revision: expectedRevision,
          });
          details.push({ name, status: 'updated' });
        } else {
          const agentId = `agent-coze-${crypto.randomUUID()}`;
          mutations.push({
            operation: 'insert',
            id: agentId,
            bot_id: botId,
            name,
            description,
            avatar: String(iconUrl || ''),
            system_prompt: systemPrompt,
            sort_order: mutations.filter((entry) => entry.operation === 'insert').length + 1,
          });
          existingBotIds.set(botId, agentId);
          details.push({ name, status: 'imported' });
        }

        // 避免请求过快
        await new Promise(resolve => setTimeout(resolve, 200));

      } catch (err) {
        const errMsg = err instanceof Error ? err.message : '未知错误';
        details.push({ name: botName || botId, status: 'failed', error: errMsg });
        failed++;
      }
    }

    // The database transaction must cover the entire advertised upstream
    // batch. A partial upstream read is not a successful import and must never
    // reach the mutation RPC.
    if (failed > 0) {
      return NextResponse.json({
        success: false,
        error: '部分 Coze 智能体详情读取失败，本批次零写入。',
        code: 'COZE_IMPORT_UPSTREAM_BATCH_INCOMPLETE',
        imported: 0,
        updated: 0,
        skipped,
        failed,
        total: botList.length,
        details,
      }, { status: 502 });
    }

    const imported = mutations.filter((entry) => entry.operation === 'insert').length;
    const updated = mutations.filter((entry) => entry.operation === 'update').length;
    if (mutations.length > 0) {
      const { error: mutationError } = await client.rpc('apply_coze_agent_import_cas_v1', {
        p_entries: mutations,
      });
      if (mutationError) {
        if (isAgentBatchConflict(mutationError)) return agentBatchConflict({ imported: 0, updated: 0 });
        return NextResponse.json({
          error: '导入事务未提交，本次零写入。',
          code: 'COZE_IMPORT_TRANSACTION_FAILED',
          imported: 0,
          updated: 0,
        }, { status: 500 });
      }
      for (const entry of mutations) invalidateAgentConfigCache(entry.id);
      invalidateBotsCache();
      scheduleAutoAvatarForCreatedAgents(
        mutations
          .filter((entry) => entry.operation === 'insert')
          .map((entry) => ({
            agentId: entry.id,
            name: entry.name,
            description: entry.description || '',
            avatar: entry.avatar as string | null,
          })),
        managementAccess.actor.userId,
      );
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
