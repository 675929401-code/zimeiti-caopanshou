import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseClient } from '@/storage/database/supabase-client';
import { authorizeAdminCapability } from '@/lib/server/admin-governance-authority';
import { persistAvatar } from '@/lib/storage';
import { randomUUID } from 'crypto';

/**
 * POST /api/admin/coze-import
 * 
 * 从指定的 Coze 工作空间导入智能体为 LLM 类型
 * 
 * 流程：
 * 1. 使用 Coze API Token + 目标 workspace_id 列出该工作空间的所有 Bot
 * 2. 按名称筛选用户指定的 Bot
 * 3. 获取每个 Bot 的详情（含 system_prompt / prompt_info）
 * 4. 创建为 source=llm 的智能体（使用平台的 LLM API 调用，而非 Coze 代理）
 * 
 * Body: {
 *   workspace_id: string,        // 目标 Coze 工作空间 ID
 *   bot_names?: string[],        // 指定导入的 Bot 名称（不传则导入全部）
 *   category?: string,           // 目标分类名称
 *   model?: string,              // 默认模型名称
 *   cost_per_message?: number,   // 默认每次消息积分消耗
 *   is_active?: boolean,         // 是否启用
 * }
 */
export async function POST(request: NextRequest) {
  const agentAccess = await authorizeAdminCapability(request, 'agents.manage', {
    requireStepUp: true,
    operation: 'coze_agent_import',
  });
  if (!agentAccess.ok) return agentAccess.response;

  try {
    const body = await request.json();
    const { workspace_id, bot_names, category, model, cost_per_message, is_active } = body;

    if (!workspace_id) {
      return NextResponse.json({ error: '请提供目标工作空间 ID' }, { status: 400 });
    }

    // 读取 Coze API 配置（从数据库或环境变量）
    const supabase = getSupabaseClient();
    let apiBase = process.env.COZE_API_BASE_URL || 'https://api.coze.cn';
    let apiToken = process.env.COZE_WORKLOAD_API_TOKEN || '';

    try {
      const { data: settings } = await supabase
        .from('platform_settings')
        .select('setting_key, setting_value')
        .in('setting_key', ['coze_api_base_url', 'coze_api_token']);

      if (settings && settings.length > 0) {
        for (const row of settings) {
          if (row.setting_key === 'coze_api_base_url' && row.setting_value) apiBase = row.setting_value;
          if (row.setting_key === 'coze_api_token' && row.setting_value) apiToken = row.setting_value;
        }
      }
    } catch {
      // use env vars
    }

    if (!apiToken) {
      return NextResponse.json({ error: '请先在平台连接中配置 Coze API Token' }, { status: 400 });
    }

    // Step 1: 列出目标工作空间的所有 Bot
    console.log(`[coze-import] Listing bots from workspace ${workspace_id}...`);
    const listUrl = `${apiBase}/v1/bots?page_num=1&page_size=100&workspace_id=${workspace_id}`;
    const listResp = await fetch(listUrl, {
      headers: {
        Authorization: `Bearer ${apiToken}`,
        'Content-Type': 'application/json',
      },
    });

    if (!listResp.ok) {
      const errText = await listResp.text();
      return NextResponse.json({ error: `获取工作空间智能体列表失败: ${listResp.status} ${errText}` }, { status: 400 });
    }

    const listData = await listResp.json();
    const botList: Array<Record<string, unknown>> = Array.isArray(listData?.data)
      ? listData.data
      : listData?.data?.items || [];

    if (botList.length === 0) {
      return NextResponse.json({ error: '该工作空间中没有找到智能体' }, { status: 404 });
    }

    console.log(`[coze-import] Found ${botList.length} bots in workspace`);

    // Step 2: 按名称筛选
    const targetNames = bot_names && bot_names.length > 0 ? bot_names : null;
    const filteredBots = targetNames
      ? botList.filter((bot) => {
          const name = (bot.bot_name as string) || '';
          return targetNames.some((target: string) => name.includes(target) || target.includes(name));
        })
      : botList;

    if (targetNames && filteredBots.length === 0) {
      return NextResponse.json({ 
        error: '未找到匹配的智能体', 
        available: botList.map((b) => b.bot_name) 
      }, { status: 404 });
    }

    // Step 3: 获取或创建目标分类
    const targetCategoryName = category || '视频生成';
    let { data: catData } = await supabase.from('categories').select('id, name').eq('name', targetCategoryName).single();
    if (!catData) {
      const categoryAccess = await authorizeAdminCapability(request, 'internal_tools.manage', {
        requireStepUp: true,
        operation: 'coze_import_category_create',
      });
      if (!categoryAccess.ok) return categoryAccess.response;

      const catId = randomUUID();
      const { data: newCat } = await supabase.from('categories').insert({
        id: catId,
        name: targetCategoryName,
        icon: '🎬',
        sort_order: 200,
        is_active: true,
      }).select().single();
      catData = newCat;
    }

    // Step 4: 获取已有的 bot_id 列表用于去重
    const { data: existingAgents } = await supabase
      .from('agents')
      .select('id, bot_id, name')
      .is('deleted_at', null);
    
    const existingBotIds = new Set<string>();
    const existingNames = new Set<string>();
    (existingAgents || []).forEach((a: Record<string, unknown>) => {
      if (a.bot_id) existingBotIds.add(a.bot_id as string);
      if (a.name) existingNames.add(a.name as string);
    });

    // Step 5: 逐个获取详情并导入
    const defaultModel = model || 'deepseek-v4-flash';
    const defaultCost = cost_per_message || 10;
    const defaultActive = is_active !== undefined ? is_active : true;

    const results: Array<{ name: string; status: 'created' | 'skipped' | 'error'; error?: string }> = [];
    let sortOrder = (existingAgents || []).length > 0 
      ? Math.max(...(existingAgents || []).map((a: Record<string, unknown>) => (a as { sort_order?: number }).sort_order || 0)) + 10
      : 10;

    for (const bot of filteredBots) {
      const botId = bot.bot_id as string;
      const botName = (bot.bot_name as string) || '';

      try {
        // 检查是否已存在
        if (existingBotIds.has(botId)) {
          results.push({ name: botName, status: 'skipped', error: 'bot_id 已存在' });
          continue;
        }
        if (existingNames.has(botName)) {
          results.push({ name: botName, status: 'skipped', error: '同名智能体已存在' });
          continue;
        }

        // 获取 Bot 详情（含 prompt_info）
        console.log(`[coze-import] Fetching detail for bot: ${botName} (${botId})`);
        const detailUrl = `${apiBase}/v1/bots/${botId}`;
        const detailResp = await fetch(detailUrl, {
          headers: {
            Authorization: `Bearer ${apiToken}`,
            'Content-Type': 'application/json',
          },
        });

        let botDetail: Record<string, unknown> = bot;
        if (detailResp.ok) {
          const detailData = await detailResp.json();
          botDetail = detailData?.data || detailData || bot;
        } else {
          console.warn(`[coze-import] Failed to fetch detail for ${botId}, using list data`);
        }

        // 提取字段
        const name = ((botDetail.bot_name as string) || botName || '').trim();
        const description = ((botDetail.description as string) || (bot.description as string) || '').trim();
        const iconUrl = (botDetail.icon_url as string) || (bot.icon_url as string) || '';

        // 提取 system_prompt — Coze API 返回在 prompt_info 字段
        let systemPrompt = '';
        const promptInfo = botDetail.prompt_info;
        if (typeof promptInfo === 'string') {
          systemPrompt = promptInfo;
        } else if (promptInfo && typeof promptInfo === 'object') {
          systemPrompt = (promptInfo as Record<string, unknown>).prompt as string || '';
        }

        // 持久化头像
        let avatar = iconUrl;
        if (avatar && (avatar.startsWith('http://') || avatar.startsWith('https://'))) {
          try {
            avatar = await persistAvatar(avatar, `coze-import-${botId}`);
          } catch {
            // Keep original URL
          }
        }

        // 创建为 LLM 类型的智能体
        const agentId = `agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const { error } = await supabase.from('agents').insert({
          id: agentId,
          name,
          description,
          avatar,
          category: targetCategoryName,
          source: 'llm',            // 关键：创建为 LLM 类型
          bot_id: botId,             // 保留原始 bot_id 用于关联
          model: defaultModel,
          system_prompt: systemPrompt,
          cost_per_message: defaultCost,
          sort_order: sortOrder,
          is_active: defaultActive,
          preset_fields: [],
          deep_thinking_type: 0,
          max_context_rounds: 30,
          max_context_tokens: 0,
          max_reply_tokens: 16384,
          enable_web_search: false,
          timeout: 300,
          user_access: 'available',
          token_billing_enabled: false,
          token_rounding_unit: 0,
          frequency_limit: 50,
          image_parsing: 'none',
          file_parsing: 'none',
        });

        if (error) {
          results.push({ name, status: 'error', error: error.message });
        } else {
          existingBotIds.add(botId);
          existingNames.add(name);
          sortOrder += 10;
          results.push({ name, status: 'created' });
        }

        // 避免 API 限流
        await new Promise(resolve => setTimeout(resolve, 300));

      } catch (err) {
        const errMsg = err instanceof Error ? err.message : '未知错误';
        results.push({ name: botName || botId, status: 'error', error: errMsg });
      }
    }

    const created = results.filter(r => r.status === 'created').length;
    const skipped = results.filter(r => r.status === 'skipped').length;
    const errors = results.filter(r => r.status === 'error').length;

    console.log(`[coze-import] Done: created=${created}, skipped=${skipped}, errors=${errors}`);

    return NextResponse.json({
      success: true,
      summary: { total: filteredBots.length, created, skipped, errors },
      results,
    });

  } catch (err) {
    console.error('[coze-import] Error:', err);
    return NextResponse.json({ 
      error: `导入失败: ${err instanceof Error ? err.message : '未知错误'}` 
    }, { status: 500 });
  }
}

/**
 * GET /api/admin/coze-import?workspace_id=xxx
 * 
 * 列出指定 Coze 工作空间的所有 Bot（预览模式，不导入）
 */
export async function GET(request: NextRequest) {
  const agentAccess = await authorizeAdminCapability(request, 'agents.manage', {
    requireStepUp: true,
    operation: 'coze_agent_import_preview',
  });
  if (!agentAccess.ok) return agentAccess.response;

  try {
    const { searchParams } = new URL(request.url);
    const workspaceId = searchParams.get('workspace_id');

    if (!workspaceId) {
      return NextResponse.json({ error: '请提供 workspace_id 参数' }, { status: 400 });
    }

    // 读取 Coze API 配置
    const supabase = getSupabaseClient();
    let apiBase = process.env.COZE_API_BASE_URL || 'https://api.coze.cn';
    let apiToken = process.env.COZE_WORKLOAD_API_TOKEN || '';

    try {
      const { data: settings } = await supabase
        .from('platform_settings')
        .select('setting_key, setting_value')
        .in('setting_key', ['coze_api_base_url', 'coze_api_token']);

      if (settings && settings.length > 0) {
        for (const row of settings) {
          if (row.setting_key === 'coze_api_base_url' && row.setting_value) apiBase = row.setting_value;
          if (row.setting_key === 'coze_api_token' && row.setting_value) apiToken = row.setting_value;
        }
      }
    } catch {
      // use env vars
    }

    if (!apiToken) {
      return NextResponse.json({ error: '请先在平台连接中配置 Coze API Token' }, { status: 400 });
    }

    // 列出 Bot
    const listUrl = `${apiBase}/v1/bots?page_num=1&page_size=100&workspace_id=${workspaceId}`;
    const listResp = await fetch(listUrl, {
      headers: {
        Authorization: `Bearer ${apiToken}`,
        'Content-Type': 'application/json',
      },
    });

    if (!listResp.ok) {
      const errText = await listResp.text();
      return NextResponse.json({ error: `获取工作空间智能体列表失败: ${listResp.status} ${errText}` }, { status: 400 });
    }

    const listData = await listResp.json();
    const botList: Array<Record<string, unknown>> = Array.isArray(listData?.data)
      ? listData.data
      : listData?.data?.items || [];

    // 获取本地已有 bot_id 用于标记
    const { data: existingAgents } = await supabase
      .from('agents')
      .select('bot_id, name')
      .is('deleted_at', null);
    const existingBotIds = new Set<string>();
    (existingAgents || []).forEach((a: Record<string, unknown>) => {
      if (a.bot_id) existingBotIds.add(a.bot_id as string);
    });

    const bots = botList.map((bot) => ({
      bot_id: bot.bot_id as string,
      bot_name: (bot.bot_name as string) || '',
      description: (bot.description as string) || '',
      icon_url: (bot.icon_url as string) || '',
      already_imported: existingBotIds.has(bot.bot_id as string),
    }));

    return NextResponse.json({
      success: true,
      workspace_id: workspaceId,
      total: bots.length,
      bots,
    });

  } catch (err) {
    console.error('[coze-import] List error:', err);
    return NextResponse.json({ 
      error: `获取列表失败: ${err instanceof Error ? err.message : '未知错误'}` 
    }, { status: 500 });
  }
}
