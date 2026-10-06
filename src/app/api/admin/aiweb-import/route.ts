import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseClient } from '@/storage/database/supabase-client';
import { authorizeAdminCapability } from '@/lib/server/admin-governance-authority';
import { persistAvatar } from '@/lib/storage';
import { randomUUID } from 'crypto';

// AIWeb preset field format → our PresetField format
function convertAIWebPreset(aiwebPreset: Array<{ type: string; title: string; placeholder?: string; options?: string[] }>) {
  if (!Array.isArray(aiwebPreset)) return [];
  return aiwebPreset
    .filter((f: { type?: string; title?: string }) => f.title) // 过滤掉空标题
    .map((field: { type: string; title: string; placeholder?: string; options?: string[] }, index: number) => ({
      id: randomUUID(),
      label: field.title || '',
      type: field.type === 'input' ? 'text' : (field.type === 'select' ? 'select' : (field.type === 'textarea' ? 'textarea' : 'text')),
      placeholder: field.placeholder || '',
      required: false,
      options: field.type === 'select' ? (field.options || []).filter((o: string) => o) : [],
      order: index + 1,
      contentPrefix: '',
      sendLabel: true,
      description: '',
    }));
}

// AIWeb model name → our model mapping (by model family, not specific version)
function mapModelFamily(aiwebModel: string): string {
  const m = (aiwebModel || '').trim().toLowerCase();
  if (m.includes('deepseek') || m.includes('dpc')) return 'deepseek';
  if (m.includes('claude')) return 'claude';
  if (m.includes('gpt') || m.includes('o1') || m.includes('o3') || m.includes('o4')) return 'gpt';
  if (m.includes('glm') || m.includes('chatglm')) return 'glm';
  if (m.includes('qwen') || m.includes('tongyi')) return 'qwen';
  if (m.includes('gemini')) return 'gemini';
  if (m.includes('llama')) return 'llama';
  if (m.includes('mistral')) return 'mistral';
  if (m.includes('yi')) return 'yi';
  // Keep original if no mapping found
  return aiwebModel || 'deepseek';
}

// AIWeb deductType → our cost_per_message mapping
function mapDeductToCost(deductType: number, deduct: number): number {
  // AIWeb: deductType 1=普通积分, 2=高级积分, 3=绘画积分
  // Simple mapping: 高级模型(2) costs more
  if (deductType === 2) return Math.max(deduct * 2, 10); // 高级模型翻倍，最低10
  return Math.max(deduct, 5); // 普通模型最低5
}

// POST - Import agents from AIWeb platform
export async function POST(request: NextRequest) {
  const agentAccess = await authorizeAdminCapability(request, 'agents.manage', {
    requireStepUp: true,
    operation: 'aiweb_agent_import',
  });
  if (!agentAccess.ok) return agentAccess.response;

  try {
    const body = await request.json();
    const { aiwebUrl, aiwebUsername, aiwebPassword, targetCategory, importOptions } = body;

    if (!aiwebUrl || !aiwebUsername || !aiwebPassword) {
      return NextResponse.json({ error: '请提供AIWeb平台地址、用户名和密码' }, { status: 400 });
    }

    // Normalize URL
    let baseUrl = aiwebUrl.replace(/\/+$/, '');
    if (!baseUrl.startsWith('http')) baseUrl = `http://${baseUrl}`;

    // Step 1: Login to AIWeb
    console.log(`[aiweb-import] Logging in to ${baseUrl}...`);
    const loginResp = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: aiwebUsername, password: aiwebPassword }),
    });
    const loginData = await loginResp.json();

    if (loginData.code !== 200 || !loginData.data) {
      return NextResponse.json({ error: `AIWeb登录失败: ${loginData.message || '用户名或密码错误'}` }, { status: 400 });
    }

    const token = loginData.data;
    console.log('[aiweb-import] Login successful');

    // Step 2: Fetch app categories
    console.log('[aiweb-import] Fetching categories...');
    const catsResp = await fetch(`${baseUrl}/api/app/queryAppCats`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const catsData = await catsResp.json();
    const categories = catsData.data?.rows || catsData.data || [];

    // Step 3: Fetch all apps (paginated)
    console.log('[aiweb-import] Fetching apps...');
    let allApps: Record<string, unknown>[] = [];
    let page = 1;
    const pageSize = 50;
    let hasMore = true;

    while (hasMore) {
      const appsResp = await fetch(`${baseUrl}/api/app/queryApp?page=${page}&size=${pageSize}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const appsData = await appsResp.json();
      const rows = appsData.data?.rows || appsData.data || [];
      const count = appsData.data?.count || rows.length;
      allApps = allApps.concat(rows);
      hasMore = allApps.length < count;
      page++;
    }

    console.log(`[aiweb-import] Found ${allApps.length} apps in ${categories.length} categories`);

    // Step 4: Import apps to our database
    const client = getSupabaseClient();
    const results: { name: string; status: 'created' | 'skipped' | 'error'; error?: string }[] = [];
    const skipExisting = importOptions?.skipExisting !== false; // default true

    // Resolve target category
    const targetCategoryName = targetCategory || '文案/撰写';
    let { data: catData } = await client.from('categories').select('id, name').eq('name', targetCategoryName).single();
    if (!catData) {
      const categoryAccess = await authorizeAdminCapability(request, 'internal_tools.manage', {
        requireStepUp: true,
        operation: 'aiweb_import_category_create',
      });
      if (!categoryAccess.ok) return categoryAccess.response;

      // Try to create the category
      const catId = randomUUID();
      const { data: newCat } = await client.from('categories').insert({
        id: catId,
        name: targetCategoryName,
        icon: '✍️',
        sort_order: 300,
        is_active: true,
      }).select().single();
      catData = newCat;
    }
    const categoryId = catData?.id;

    if (!categoryId) {
      return NextResponse.json({ error: '无法创建或找到目标分类' }, { status: 500 });
    }

    for (const app of allApps) {
      try {
        const appName = (app.name as string) || '未命名';
        const appDes = (app.des as string) || '';
        const appStatus = (app.status as number) ?? 1;
        const appOrder = (app.order as number) || 0;
        const appCoverImg = (app.coverImg as string) || '';
        const appModel = (app.appModel as string) || (app.model as string) || '';
        const appPrompt = (app.prompt as string) || '';
        const appPreset = (app.preset as string) || '';
        const isGPTs = (app.isGPTs as number) || (app.isGpts as number) || 0;
        const gizmoID = (app.gizmoID as string) || (app.gizmoId as string) || '';
        const isFixedModel = (app.isFixedModel as number) || 0;
        const deductType = (app.deductType as number) || 1;
        const deduct = (app.deduct as number) || 1;
        const demoData = (app.demoData as string) || '';
        const isFlowith = (app.isFlowith as number) || 0;
        const deepThinkingType = (app.deepThinkingType as number) || 0;
        const maxRounds = (app.maxRounds as number) || 30;
        const maxTokens = (app.maxTokens as number) || (app.maxModelTokens as number) || 0;
        const maxReplyTokens = (app.max_tokens as number) || 16384;
        const isNetworkSearch = (app.isNetworkSearch as boolean) || false;
        const systemPrompt = (app.systemPrompt as string) || '';
        const systemPromptType = (app.systemPromptType as number) || 0;

        // Check if agent with same name already exists
        if (skipExisting) {
          const { data: existing } = await client.from('agents').select('id').eq('name', appName).is('deleted_at', null).maybeSingle();
          if (existing) {
            results.push({ name: appName, status: 'skipped', error: '已存在同名智能体' });
            continue;
          }
        }

        // Parse AIWeb preset JSON (prompt field contains template fields)
        let presetFields: unknown[] = [];
        if (appPrompt) {
          try {
            const parsed = JSON.parse(appPrompt);
            if (Array.isArray(parsed)) {
              presetFields = convertAIWebPreset(parsed);
            }
          } catch {
            // Not JSON - it's a plain text prompt, use as system_prompt supplement
          }
        }

        // Build system_prompt: combine preset text + system prompt
        let finalSystemPrompt = '';
        if (appPreset) {
          finalSystemPrompt += appPreset;
        }
        if (systemPrompt && systemPromptType === 1) {
          // systemPromptType 1 = append to preset
          finalSystemPrompt += (finalSystemPrompt ? '\n\n' : '') + systemPrompt;
        } else if (systemPrompt && !appPreset) {
          finalSystemPrompt = systemPrompt;
        }

        // Map model
        const mappedModel = isFixedModel && appModel ? appModel : mapModelFamily(appModel);

        // Determine source
        let source = 'llm';
        if (isGPTs === 1 || isFlowith === 1) {
          source = 'coze'; // Treat GPTs/Flowith as Coze-type
        }

        // Store avatar if it's an external URL
        let avatar = appCoverImg || '';
        if (avatar && (avatar.startsWith('http://') || avatar.startsWith('https://'))) {
          try {
            avatar = await persistAvatar(avatar, `aiweb-${appName}`);
          } catch {
            // Keep original URL as fallback
          }
        }

        const agentId = `agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

        const { error } = await client.from('agents').insert({
          id: agentId,
          name: appName,
          description: appDes,
          avatar,
          category: targetCategoryName,
          source,
          bot_id: gizmoID || '',
          model: mappedModel,
          system_prompt: finalSystemPrompt,
          cost_per_message: mapDeductToCost(deductType, deduct),
          sort_order: appOrder,
          is_active: appStatus === 1,
          preset_fields: presetFields,
          deep_thinking_type: deepThinkingType,
          max_context_rounds: maxRounds,
          max_context_tokens: maxTokens,
          max_reply_tokens: maxReplyTokens,
          enable_web_search: isNetworkSearch,
          timeout: 300,
          user_access: 'available',
          // Store original AIWeb model info for reference
          cover_url: demoData || null,
          // Token billing defaults (can be configured later per agent)
          token_billing_enabled: false,
          token_rounding_unit: 0,
        });

        if (error) {
          results.push({ name: appName, status: 'error', error: error.message });
        } else {
          results.push({ name: appName, status: 'created' });
        }
      } catch (err) {
        const name = (app as Record<string, unknown>).name as string || '未知';
        results.push({ name, status: 'error', error: String(err) });
      }
    }

    const created = results.filter(r => r.status === 'created').length;
    const skipped = results.filter(r => r.status === 'skipped').length;
    const errors = results.filter(r => r.status === 'error').length;

    console.log(`[aiweb-import] Done: ${created} created, ${skipped} skipped, ${errors} errors`);

    return NextResponse.json({
      success: true,
      summary: { total: allApps.length, created, skipped, errors },
      categories: categories.map((c: Record<string, unknown>) => ({ id: c.id, name: c.name })),
      results,
    });
  } catch (err) {
    console.error('[aiweb-import] Error:', err);
    return NextResponse.json({ error: `导入失败: ${String(err)}` }, { status: 500 });
  }
}
