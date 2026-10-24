import { canonicalAgentModelBinding } from '@/lib/agent-model-binding';
import {
  configurationSourceStatus,
  sharedConfigurationEnabled,
} from '@/storage/database/configuration-source';
// [v2.5.1-patch] integer bug fix + hybrid image routing - 2026-08-04
import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseClient } from '@/storage/database/supabase-client';
import {
  AgentImageReferenceError,
  persistAvatar,
  verifyOwnedAgentImageReference,
} from '@/lib/storage';
import { invalidateBotsCache } from '@/lib/bots-cache';
import { normalizeAgentPresetFields } from '@/lib/agent-preset-schema';
import { visibleAdminAgentRows } from '@/lib/admin-agent-catalog-visibility';
import { normalizeStoryboardDirectorContractActivation, StoryboardDirectorContractActivationError, STORYBOARD_DIRECTOR_CONTRACT_FIELDS } from '@/lib/storyboard-director-contract-activation';
import { authorizeAdminCapability } from '@/lib/server/admin-governance-authority';
import { invalidateAgentConfigCache } from '@/app/api/llm/llm-state';
import {
  agentRevisionConflict,
  deleteAgentByRevision,
  expectedAgentRevisionRequired,
  parseExpectedAgentRevision,
  updateAgentByRevision,
} from '@/lib/server/agent-config-cas';

const MASKED_SECRET = /^(?:[*•●·]+|已配置)$/u;

const AGENT_PUBLIC_COLUMNS = [
  'id',
  'name',
  'description',
  'avatar',
  'category',
  'source',
  'cost_per_message',
  'base_fee',
  'sort_order',
  'is_active',
  'user_access',
  'preset_fields',
  'deleted_at',
  'frequency_limit',
  'image_parsing',
  'file_parsing',
  'cover_url',
  'guide_message',
  'config_revision',
] as const;

const AGENT_CONFIGURATION_COLUMNS = [
  'bot_id',
  'model',
  'coze_coding_api_url',
  'coze_coding_api_token',
  'coze_coding_project_id',
  'output_style',
  'enable_think_tags',
  'proxy_url',
  'deep_thinking_type',
  'deduct_deep_think',
  'max_context_rounds',
  'max_context_tokens',
  'max_reply_tokens',
  'timeout',
  'enable_web_search',
  'temperature',
  'response_format',
  'token_billing_enabled',
  'input_cost_per_million',
  'output_cost_per_million',
  'cached_cost_per_million',
  'profit_margin',
  'token_rounding_unit',
  'model_id',
  'enable_knowledge_base',
  'knowledge_base_id',
] as const;

const AGENT_MODEL_BINDING_COLUMNS = [
  'id',
  'name',
  'model_name',
  'description',
  'category',
  'is_active',
  'is_hidden',
  'user_access',
  'api_key',
] as const;

const AGENT_PROMPT_INPUT_KEYS = [
  'system_prompt',
  'systemPrompt',
  'directorContractAction',
] as const;

const AGENT_CONFIGURATION_INPUT_KEYS = [
  'source',
  'bot_id', 'botId',
  'model', 'model_id', 'modelId',
  'coze_coding_api_url', 'cozeCodingApiUrl',
  'coze_coding_api_token', 'cozeCodingApiToken',
  'coze_coding_project_id', 'cozeCodingProjectId',
  'credential_source_agent_id', 'credentialSourceAgentId',
  'output_style', 'outputStyle',
  'directorContractAction',
  'enable_think_tags', 'enableThinkTags',
  'proxy_url', 'proxyUrl',
  'deep_thinking_type', 'deepThinkingType',
  'deduct_deep_think', 'deductDeepThink',
  'max_context_rounds', 'maxContextRounds',
  'max_context_tokens', 'maxContextTokens',
  'max_reply_tokens', 'maxReplyTokens',
  'timeout',
  'enable_web_search', 'enableWebSearch',
  'temperature',
  'response_format', 'responseFormat',
  'cost_per_message', 'costPerMessage',
  'base_fee', 'baseFee',
  'token_billing_enabled', 'tokenBillingEnabled',
  'input_cost_per_million', 'inputCostPerMillion',
  'output_cost_per_million', 'outputCostPerMillion',
  'cached_cost_per_million', 'cachedCostPerMillion',
  'profit_margin', 'profitMargin',
  'token_rounding_unit', 'tokenRoundingUnit',
  'enable_knowledge_base', 'enableKnowledgeBase',
  'knowledge_base_id', 'knowledgeBaseId',
] as const;

const AGENT_REVISION_SCHEMA_ERROR_CODES = new Set([
  '42703',
  'PGRST204',
]);

function isAgentRevisionSchemaMissing(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const record = error as Record<string, unknown>;
  const code = String(record.code || '');
  const diagnostic = [record.message, record.details, record.hint]
    .map((value) => String(value || ''))
    .join(' ');
  return AGENT_REVISION_SCHEMA_ERROR_CODES.has(code)
    || /config_revision.*(?:schema cache|does not exist|could not find)|(?:schema cache|does not exist|could not find).*config_revision/iu.test(diagnostic);
}

function controlledLegacyAgentWritesEnabled(): boolean {
  return !sharedConfigurationEnabled()
    && process.env.LOCAL_ACCEPTANCE_PREVIEW === 'true'
    && process.env.ALLOW_LEGACY_AGENT_CONFIG_WRITES === '1';
}

function agentRevisionMigrationRequired(): NextResponse {
  return NextResponse.json({
    error: '共享智能体配置版本字段尚未就绪，已阻止可能覆盖他人修改的保存。',
    code: 'AGENT_CONFIG_REVISION_MIGRATION_REQUIRED',
  }, { status: 503 });
}

function hasOwnInput(body: Record<string, unknown>, keys: readonly string[]): boolean {
  return keys.some((key) => Object.prototype.hasOwnProperty.call(body, key));
}

async function authorizeAgentFieldChanges(
  request: NextRequest,
  body: Record<string, unknown>,
): Promise<NextResponse | null> {
  if (hasOwnInput(body, AGENT_PROMPT_INPUT_KEYS)) {
    const promptAccess = await authorizeAdminCapability(request, 'prompts.edit', {
      requireStepUp: true,
      operation: 'agent_prompt_edit',
    });
    if (!promptAccess.ok) return promptAccess.response;
  }
  if (hasOwnInput(body, AGENT_CONFIGURATION_INPUT_KEYS)) {
    const configurationAccess = await authorizeAdminCapability(request, 'models.manage', {
      requireStepUp: true,
      operation: 'agent_model_configuration_edit',
    });
    if (!configurationAccess.ok) return configurationAccess.response;
  }
  return null;
}

function copySelectedFields(
  agent: Record<string, unknown>,
  columns: readonly string[],
): Record<string, unknown> {
  return Object.fromEntries(
    columns
      .filter((column) => Object.prototype.hasOwnProperty.call(agent, column))
      .map((column) => [column, agent[column]]),
  );
}

function replacementSecret(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed && !MASKED_SECRET.test(trimmed) ? trimmed : undefined;
}

function publicAgent(
  agent: Record<string, unknown>,
  options: { includeConfiguration?: boolean; includePrompt?: boolean } = {},
) {
  const safe = copySelectedFields(agent, AGENT_PUBLIC_COLUMNS);
  const configuration = options.includeConfiguration
    ? copySelectedFields(agent, AGENT_CONFIGURATION_COLUMNS.filter((column) => column !== 'coze_coding_api_token'))
    : {};
  return {
    ...safe,
    ...configuration,
    ...(options.includeConfiguration
      ? { coze_coding_api_token_configured: Boolean(String(agent.coze_coding_api_token || '').trim()) }
      : {}),
    ...(options.includePrompt ? { system_prompt: agent.system_prompt || '' } : {}),
    configuration_access: options.includeConfiguration ? 'visible' : 'protected',
    prompt_access: options.includePrompt ? 'visible' : 'protected',
  };
}

async function authorizeAgentMutation(request: NextRequest, operation: string) {
  return authorizeAdminCapability(request, 'agents.manage', {
    operation,
    requireStepUp: true,
  });
}

async function authorizeInternalAgentMutation(request: NextRequest, operation: string) {
  return authorizeAdminCapability(request, 'internal_tools.manage', {
    operation,
    requireStepUp: true,
  });
}

async function categoryRequiresInternalAccess(category: unknown): Promise<boolean> {
  const categoryName = typeof category === 'string' ? category.trim() : '';
  if (!categoryName) return false;
  if (categoryName === '自用') return true;
  const { data, error } = await getSupabaseClient()
    .from('categories')
    .select('visibility,is_active')
    .eq('name', categoryName)
    .maybeSingle();
  if (error) throw error;
  return Boolean(data && (data.visibility === 'private' || data.is_active !== true));
}

/**
 * If avatar is an external URL (http/https), download and persist locally.
 * Returns the local path or storage key. If already stored or is emoji, returns as-is.
 */
async function storeAvatarIfNeeded(avatar: string, agentId: string, actorId: string): Promise<string> {
  const normalized = typeof avatar === 'string' ? avatar.trim() : '';
  if (!normalized) return '';
  if (/^(?:https?:|data:)/iu.test(normalized)) {
    const stored = await persistAvatar(normalized, agentId, {
      allowOriginalUrlFallback: false,
      ownerUserId: actorId,
      source: 'agent-avatar-transfer',
    });
    if (!stored || stored === normalized) {
      throw new AgentImageReferenceError('头像未能转存到平台对象存储', 'AGENT_IMAGE_TRANSFER_FAILED', 502);
    }
    return stored;
  }
  if (normalized.startsWith('agent-images/')) {
    return verifyOwnedAgentImageReference(normalized, actorId, 'avatar');
  }
  // Empty/emoji placeholders and bundled immutable avatars are not storage keys.
  // They remain compatible, but ordinary saves never turn them into paid jobs.
  if (/^\/avatars\/[a-zA-Z0-9/_-]+\.(?:png|jpe?g|webp)$/u.test(normalized)
    || (normalized.length <= 8 && !/[/.\\]/u.test(normalized))) {
    return normalized;
  }
  throw new AgentImageReferenceError('头像必须先上传到平台托管存储', 'AGENT_AVATAR_REFERENCE_FORBIDDEN', 400);
}

async function assertManagedCoverReference(value: unknown, actorId: string): Promise<string | null> {
  const cover = typeof value === 'string' ? value.trim() : '';
  if (!cover) return null;
  if (!cover.startsWith('agent-images/cover/')) {
    throw new AgentImageReferenceError('背景图必须先上传到平台托管存储', 'AGENT_COVER_REFERENCE_FORBIDDEN', 400);
  }
  return verifyOwnedAgentImageReference(cover, actorId, 'cover');
}

function agentImageFailure(error: unknown, fallback: string): NextResponse | null {
  if (!(error instanceof AgentImageReferenceError)) return null;
  return NextResponse.json({ error: error.message || fallback, code: error.code }, { status: error.status });
}

// GET - List all agents
export async function GET(request: NextRequest) {
  const listingAccess = await authorizeAdminCapability(request, 'agents.view', {
    operation: 'agents_read',
    requireStepUp: false,
  });
  if (!listingAccess.ok) return listingAccess.response;

  try {
    const { searchParams } = new URL(request.url);
    const includeInternal = searchParams.get('include_internal') === '1';
    if (includeInternal) {
      const internalAccess = await authorizeAdminCapability(request, 'internal_tools.manage', {
        operation: 'internal_agents_read',
        requireStepUp: true,
      });
      if (!internalAccess.ok) return internalAccess.response;
    }
    const includeConfiguration = searchParams.get('include_configuration') === '1';
    const includePrompt = searchParams.get('include_prompt') === '1';
    let promptAuthorizationMode: 'protected' | 'step_up' | 'maintenance' = 'protected';
    if (includeConfiguration) {
      const agentManagementAccess = await authorizeAdminCapability(request, 'agents.manage', {
        requireStepUp: true,
        operation: 'agent_configuration_view',
      });
      if (!agentManagementAccess.ok) return agentManagementAccess.response;
      const configurationAccess = await authorizeAdminCapability(request, 'models.manage', {
        requireStepUp: true,
        operation: 'agent_model_configuration_view',
      });
      if (!configurationAccess.ok) return configurationAccess.response;
    }
    if (includePrompt) {
      const promptAccess = await authorizeAdminCapability(request, 'prompts.view', {
        requireStepUp: true,
        operation: 'agent_prompt_view',
      });
      if (!promptAccess.ok) return promptAccess.response;
      promptAuthorizationMode = promptAccess.maintenanceLock?.enabled ? 'maintenance' : 'step_up';
    }
    const trash = searchParams.get('trash');
    const showTrash = trash === '1' || trash === 'true' || searchParams.get('trashed') === 'true';
    const client = getSupabaseClient();

    const selectedColumns = [
      ...AGENT_PUBLIC_COLUMNS,
      ...(includeConfiguration ? AGENT_CONFIGURATION_COLUMNS : []),
      ...(includePrompt ? ['system_prompt'] : []),
    ];
    let query = client.from('agents').select(Array.from(new Set(selectedColumns)).join(','));
    if (showTrash) {
      // 回收站只显示已删除记录。
      query = query.not('deleted_at', 'is', null);
    } else {
      // 正常列表排除已删除记录。
      query = query.is('deleted_at', null);
    }
    query = query.order('sort_order', { ascending: true });

    let categoryRows: Array<{ name: string; visibility?: string | null; is_active?: boolean | null }> = [];
    if (!includeInternal) {
      const categoryResult = await client
        .from('categories')
        .select('name,visibility,is_active');
      if (categoryResult.error) {
        console.error('List agent categories Supabase error:', categoryResult.error);
        return NextResponse.json({ error: '获取智能体列表失败' }, { status: 500 });
      }
      categoryRows = categoryResult.data || [];
    }

    let queryResult = await query;
    if (queryResult.error && isAgentRevisionSchemaMissing(queryResult.error)) {
      if (!controlledLegacyAgentWritesEnabled()) return agentRevisionMigrationRequired();

      const legacyColumns = selectedColumns.filter((column) => column !== 'config_revision');
      let legacyQuery = client.from('agents').select(Array.from(new Set(legacyColumns)).join(','));
      legacyQuery = showTrash
        ? legacyQuery.not('deleted_at', 'is', null)
        : legacyQuery.is('deleted_at', null);
      queryResult = await legacyQuery.order('sort_order', { ascending: true });
    }
    const { data, error } = queryResult;

    if (error) {
      console.error('List agents Supabase error:', error);
      return NextResponse.json({ error: '获取智能体列表失败' }, { status: 500 });
    }

    const visibleAgents = visibleAdminAgentRows(data || [], categoryRows, includeInternal);
    return NextResponse.json({
      agents: visibleAgents.map((agent: Record<string, unknown>) => publicAgent(agent, {
        includeConfiguration,
        includePrompt,
      })),
      configurationAccess: includeConfiguration ? 'visible' : 'protected',
      promptAccess: includePrompt ? 'visible' : 'protected',
      promptAuthorizationMode,
      ...(includeConfiguration ? { dataSource: configurationSourceStatus() } : {}),
    }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (err) {
    console.error('List agents error:', err);
    return NextResponse.json({ error: '获取智能体列表失败' }, { status: 500 });
  }
}

async function persistPromptVersion(
  client: ReturnType<typeof getSupabaseClient>,
  agentId: string,
  prompt: string,
  maxVersions = 10,
): Promise<void> {
  const normalizedPrompt = prompt.trim();
  if (!normalizedPrompt) return;

  const { data: latest } = await client
    .from('prompt_versions')
    .select('prompt')
    .eq('agent_id', agentId)
    .order('created_at', { ascending: false })
    .limit(1);
  if (latest?.[0]?.prompt === normalizedPrompt) return;

  const { error: insertError } = await client
    .from('prompt_versions')
    .insert({ agent_id: agentId, prompt: normalizedPrompt });
  if (insertError) {
    console.error('[prompt-versions] automatic persistence failed:', insertError);
    return;
  }

  const { data: versions } = await client
    .from('prompt_versions')
    .select('id')
    .eq('agent_id', agentId)
    .order('created_at', { ascending: false });
  const staleIds = (versions ?? []).slice(maxVersions).map((row: { id: string }) => row.id);
  if (staleIds.length > 0) {
    await client.from('prompt_versions').delete().in('id', staleIds);
  }
}

// POST - Create agent
export async function POST(request: NextRequest) {
  const managementAccess = await authorizeAgentMutation(request, 'agent_create');
  if (!managementAccess.ok) return managementAccess.response;
  const admin = managementAccess.actor;

  try {
    const body = await request.json();
    const fieldAccessFailure = await authorizeAgentFieldChanges(request, body as Record<string, unknown>);
    if (fieldAccessFailure) return fieldAccessFailure;
    if (
      body.user_access === 'hidden'
      || body.userAccess === 'hidden'
      || await categoryRequiresInternalAccess(body.category)
    ) {
      const internalAccess = await authorizeInternalAgentMutation(request, 'internal_agent_create');
      if (!internalAccess.ok) return internalAccess.response;
    }
    if (body.source === 'coze_coding') {
      return NextResponse.json({
        error: '旧版 Coding 智能体通道已停用，请绑定统一 LLM 模型',
        code: 'LEGACY_CODING_AGENT_RETIRED',
      }, { status: 410 });
    }
    if ((body.source || 'llm') === 'llm') {
      const { data: linked } = await getSupabaseClient()
        .from('llm_models')
        .select(AGENT_MODEL_BINDING_COLUMNS.join(','))
        .eq('id', body.model_id || '')
        .maybeSingle();
      try { Object.assign(body, canonicalAgentModelBinding(body.model_id, linked)); }
      catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : '模型绑定无效', code: 'AGENT_MODEL_BINDING_INVALID' }, { status: 400 }); }
    }
    const { name, description, avatar, category, source, botId, bot_id, model, systemPrompt, system_prompt, costPerMessage, cost_per_message, sortOrder, sort_order, cozeCodingApiUrl, coze_coding_api_url, cozeCodingApiToken, coze_coding_api_token, cozeCodingProjectId, coze_coding_project_id, isActive, is_active, presetFields, preset_fields, outputStyle, output_style, enableThinkTags, enable_think_tags, proxyUrl, proxy_url, deepThinkingType, deep_thinking_type, deductDeepThink, deduct_deep_think, maxContextRounds, max_context_rounds, maxContextTokens, max_context_tokens, maxReplyTokens, max_reply_tokens, timeout, enableWebSearch, enable_web_search, temperature, responseFormat, response_format, tokenBillingEnabled, token_billing_enabled, inputCostPerMillion, input_cost_per_million, outputCostPerMillion, output_cost_per_million, cachedCostPerMillion, cached_cost_per_million, profitMargin, profit_margin, tokenRoundingUnit, token_rounding_unit, userAccess, user_access, model_id, frequencyLimit, frequency_limit, imageParsing, image_parsing, fileParsing, file_parsing, cover_url, guideMessage, guide_message, enableKnowledgeBase, enable_knowledge_base, knowledgeBaseId, knowledge_base_id, credential_source_agent_id } = body;

    if (!name || !category) {
      return NextResponse.json({ error: '名称和分类不能为空' }, { status: 400 });
    }

    // 数据库中的部分数值列要求整数，统一清理前端传入的浮点值。
    // "invalid input syntax for type integer: '0.35'"
    const safeInt = (val: unknown, fallback: number | null = null): number | null => {
      if (val === null || val === undefined || val === '') return fallback;
      const n = Number(val);
      return isNaN(n) ? fallback : Math.round(n);
    };
    const safeFloatOrNull = (val: unknown): number | null => {
      if (val === null || val === undefined || val === '') return null;
      const n = Number(val);
      return isNaN(n) ? null : n;
    };

    const client = getSupabaseClient();
    const revisionProbe = await client.from('agents').select('config_revision').limit(1);
    if (revisionProbe.error) {
      if (isAgentRevisionSchemaMissing(revisionProbe.error)) {
        if (!controlledLegacyAgentWritesEnabled()) return agentRevisionMigrationRequired();
      } else {
        return NextResponse.json({ error: '读取智能体配置版本失败' }, { status: 500 });
      }
    }

    // Auto-store external avatar URL to object storage
    const agentId = `agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const storedAvatar = await storeAvatarIfNeeded(avatar || '', agentId, admin.userId);
    const storedCover = await assertManagedCoverReference(cover_url, admin.userId);

    let inheritedApiToken = '';
    if (credential_source_agent_id) {
      const { data: sourceAgent } = await client
        .from('agents')
        .select('coze_coding_api_token')
        .eq('id', credential_source_agent_id)
        .maybeSingle();
      inheritedApiToken = String(sourceAgent?.coze_coding_api_token || '');
    }

    // 新智能体默认排到分类末尾。
    let autoSortOrder = sort_order || sortOrder || 0;
    if (!sort_order && !sortOrder) {
      const { data: maxSortData } = await client
        .from('agents')
        .select('sort_order')
        .eq('category', category)
        .is('deleted_at', null)
        .order('sort_order', { ascending: false })
        .limit(1);
      autoSortOrder = (maxSortData?.[0]?.sort_order || 0) + 10;
    }

    // 未绑定模型预设时，根据模型名称补充合理的默认参数。
    const agentModel = model || 'deepseek-v4-flash';
    const REASONING_PATTERNS = [
      /\bdeepseek-r\b/, /\bdeepseek-reasoner\b/, /\bdeepseek-v4-pro\b/, /\bdeepseek-v4-flash\b/,
      /\bo1\b/, /\bo1-mini\b/, /\bo1-preview\b/, /\bo3\b/, /\bo3-mini\b/, /\bo4-mini\b/,
      /\bqwq\b/, /\bqwen-qwq\b/,
      /\bglm-5\b/, /\bglm-5\.1\b/, /\bglm-5\.2\b/,
      /\bgpt-5\.4-pro\b/, /\bgpt-5\.4\b/,
      /\bqwen3\b/,
      /\bthink\b/, /\breasoning\b/, /\bthinker\b/,
    ];
    const isReasoningModel = REASONING_PATTERNS.some(p => p.test(agentModel.toLowerCase()));
    // 仅在没有 model_id 且请求未显式设置时自动推断。
    const autoDtt = !model_id && (deep_thinking_type === undefined && deepThinkingType === undefined)
      ? (isReasoningModel ? 2 : 0) : (deep_thinking_type ?? deepThinkingType ?? 0);
    const autoMaxReply = !model_id && (max_reply_tokens === undefined && maxReplyTokens === undefined)
      ? (isReasoningModel ? 65536 : 16384) : (max_reply_tokens ?? maxReplyTokens ?? 16384);
    const autoTimeout = !model_id && timeout === undefined
      ? (isReasoningModel ? 300 : 120) : (timeout ?? 300);
    const autoDeduct = !model_id && (deduct_deep_think === undefined && deductDeepThink === undefined)
      ? (isReasoningModel ? 2 : 1) : (deduct_deep_think ?? deductDeepThink ?? 1);

    const { data, error } = await client
      .from('agents')
      .insert({
        id: agentId,
        name,
        description: description || '',
        avatar: storedAvatar,
        category,
        source: source || 'llm',
        bot_id: bot_id || botId || '',
        model: agentModel,
        system_prompt: system_prompt || systemPrompt || '',
        cost_per_message: safeInt(cost_per_message || costPerMessage, 10),
        sort_order: safeInt(autoSortOrder, 0),
        is_active: is_active ?? isActive ?? false,
        coze_coding_api_url: coze_coding_api_url || cozeCodingApiUrl || '',
        coze_coding_api_token: replacementSecret(coze_coding_api_token)
          || replacementSecret(cozeCodingApiToken)
          || inheritedApiToken,
        coze_coding_project_id: coze_coding_project_id || cozeCodingProjectId || bot_id || botId || '',
        preset_fields: normalizeAgentPresetFields(preset_fields ?? presetFields ?? []),
        base_fee: body.base_fee || body.baseFee || 0,
        output_style: output_style || outputStyle || {},
        enable_think_tags: enable_think_tags ?? enableThinkTags ?? false,
        proxy_url: proxy_url || proxyUrl || '',
        deep_thinking_type: autoDtt,
        deduct_deep_think: autoDeduct,
        max_context_rounds: max_context_rounds ?? maxContextRounds ?? 30,
        max_context_tokens: max_context_tokens ?? maxContextTokens ?? 0,
        max_reply_tokens: autoMaxReply,
        timeout: autoTimeout,
        enable_web_search: enable_web_search ?? enableWebSearch ?? false,
        temperature: safeFloatOrNull(temperature),
        response_format: response_format ?? responseFormat ?? null,
        token_billing_enabled: token_billing_enabled ?? tokenBillingEnabled ?? false,
        input_cost_per_million: input_cost_per_million ?? inputCostPerMillion ?? null,
        output_cost_per_million: output_cost_per_million ?? outputCostPerMillion ?? null,
        cached_cost_per_million: cached_cost_per_million ?? cachedCostPerMillion ?? null,
        profit_margin: safeFloatOrNull(profit_margin ?? profitMargin),
        token_rounding_unit: token_rounding_unit ?? tokenRoundingUnit ?? 0,
        user_access: user_access || userAccess || 'available',
        model_id: model_id || null,
        frequency_limit: frequency_limit ?? frequencyLimit ?? 50,
        image_parsing: image_parsing || imageParsing || 'none',
        file_parsing: file_parsing || fileParsing || 'none',
        cover_url: storedCover,
        guide_message: guide_message || guideMessage || '',
        enable_knowledge_base: enable_knowledge_base ?? enableKnowledgeBase ?? false,
        knowledge_base_id: knowledge_base_id || knowledgeBaseId || '',
      })
      .select()
      .single();

    if (error) {
      return NextResponse.json({ error: `创建智能体失败: ${error.message}` }, { status: 500 });
    }

    // The revision migration records the prompt inside the same transaction as
    // the agent insert. Only an explicitly enabled local legacy database keeps
    // the old best-effort application-side history path.
    if (!Number.isSafeInteger(Number(data.config_revision))) {
      if (!controlledLegacyAgentWritesEnabled()) return agentRevisionMigrationRequired();
      await persistPromptVersion(client, agentId, String(data.system_prompt || ''));
    }

    // 新建智能体后失效前台缓存。
    invalidateAgentConfigCache(agentId);
    invalidateBotsCache();

    return NextResponse.json({ success: true, agent: publicAgent(data as Record<string, unknown>) });
  } catch (err) {
    console.error('Create agent error:', err);
    const imageFailure = agentImageFailure(err, '智能体图片无效');
    if (imageFailure) return imageFailure;
    return NextResponse.json({ error: '创建智能体失败' }, { status: 500 });
  }
}

// PUT - Update agent
export async function PUT(request: NextRequest) {
  const managementAccess = await authorizeAgentMutation(request, 'agent_update');
  if (!managementAccess.ok) return managementAccess.response;
  const admin = managementAccess.actor;

  try {
    const body = await request.json();
    const fieldAccessFailure = await authorizeAgentFieldChanges(request, body as Record<string, unknown>);
    if (fieldAccessFailure) return fieldAccessFailure;
    const { agentId, ...updateData } = body;

    if (updateData.source === 'coze_coding') {
      return NextResponse.json({
        error: '旧版 Coding 智能体通道已停用，请绑定统一 LLM 模型',
        code: 'LEGACY_CODING_AGENT_RETIRED',
      }, { status: 410 });
    }

    if (!agentId) {
      return NextResponse.json({ error: '智能体 ID 不能为空' }, { status: 400 });
    }

    const client = getSupabaseClient();
    let revisionManaged = true;
    let currentAgentResult = await client
      .from('agents')
      .select('id,category,user_access,avatar,cover_url,config_revision,system_prompt,output_style')
      .eq('id', agentId)
      .maybeSingle();
    if (currentAgentResult.error && isAgentRevisionSchemaMissing(currentAgentResult.error)) {
      if (!controlledLegacyAgentWritesEnabled()) return agentRevisionMigrationRequired();
      revisionManaged = false;
      currentAgentResult = await client
        .from('agents')
        .select('id,category,user_access,avatar,cover_url,system_prompt,output_style')
        .eq('id', agentId)
        .maybeSingle();
    }
    const { data: currentAgent, error: currentAgentError } = currentAgentResult;
    if (currentAgentError) {
      return NextResponse.json({ error: '读取智能体图片状态失败' }, { status: 500 });
    }
    if (!currentAgent) {
      return NextResponse.json({ error: '智能体不存在' }, { status: 404 });
    }
    if (
      currentAgent.user_access === 'hidden'
      || updateData.user_access === 'hidden'
      || updateData.userAccess === 'hidden'
      || await categoryRequiresInternalAccess(currentAgent.category)
      || await categoryRequiresInternalAccess(updateData.category)
    ) {
      const internalAccess = await authorizeInternalAgentMutation(request, 'internal_agent_update');
      if (!internalAccess.ok) return internalAccess.response;
    }
    const expectedRevision = parseExpectedAgentRevision(body as Record<string, unknown>);
    if (revisionManaged && expectedRevision === null) {
      return expectedAgentRevisionRequired(currentAgent.config_revision);
    }
    if (revisionManaged && expectedRevision !== Number(currentAgent.config_revision)) {
      return agentRevisionConflict(expectedRevision as number, currentAgent.config_revision);
    }
    const savedAt = new Date();
    const fields: Record<string, unknown> = { updated_at: savedAt.toISOString() };

    // 更新路径沿用相同的数值清理规则。
    const toSafeInt = (val: unknown): number | null => {
      if (val === null || val === undefined || val === '') return null;
      const n = Number(val);
      return isNaN(n) ? null : Math.round(n);
    };
    const toSafeFloat = (val: unknown): number | null => {
      if (val === null || val === undefined || val === '') return null;
      const n = Number(val);
      return isNaN(n) ? null : n;
    };

    if (updateData.name !== undefined) fields.name = updateData.name;
    if (updateData.description !== undefined) fields.description = updateData.description;
    if (updateData.category !== undefined) fields.category = updateData.category;
    if (updateData.source !== undefined) fields.source = updateData.source;
    if (updateData.botId !== undefined) fields.bot_id = updateData.botId;
    if (updateData.bot_id !== undefined) fields.bot_id = updateData.bot_id;
    if (updateData.model !== undefined) fields.model = updateData.model;
    if (updateData.systemPrompt !== undefined) fields.system_prompt = updateData.systemPrompt;
    if (updateData.system_prompt !== undefined) fields.system_prompt = updateData.system_prompt;
    if (updateData.costPerMessage !== undefined) fields.cost_per_message = toSafeInt(updateData.costPerMessage);
    if (updateData.cost_per_message !== undefined) fields.cost_per_message = toSafeInt(updateData.cost_per_message);
    if (updateData.sortOrder !== undefined) fields.sort_order = toSafeInt(updateData.sortOrder);
    if (updateData.sort_order !== undefined) fields.sort_order = toSafeInt(updateData.sort_order);
    if (updateData.isActive !== undefined) fields.is_active = updateData.isActive;
    if (updateData.is_active !== undefined) fields.is_active = updateData.is_active;
    if (updateData.cozeCodingApiUrl !== undefined) fields.coze_coding_api_url = updateData.cozeCodingApiUrl;
    if (updateData.coze_coding_api_url !== undefined) fields.coze_coding_api_url = updateData.coze_coding_api_url;
    const nextApiToken = replacementSecret(updateData.coze_coding_api_token)
      || replacementSecret(updateData.cozeCodingApiToken);
    if (nextApiToken !== undefined) fields.coze_coding_api_token = nextApiToken;
    if (updateData.cozeCodingProjectId !== undefined) fields.coze_coding_project_id = updateData.cozeCodingProjectId;
    if (updateData.coze_coding_project_id !== undefined) fields.coze_coding_project_id = updateData.coze_coding_project_id;
    if (updateData.presetFields !== undefined) fields.preset_fields = normalizeAgentPresetFields(updateData.presetFields);
    if (updateData.preset_fields !== undefined) fields.preset_fields = normalizeAgentPresetFields(updateData.preset_fields);
    if (updateData.base_fee !== undefined) fields.base_fee = updateData.base_fee;
    if (updateData.baseFee !== undefined) fields.base_fee = updateData.baseFee;
    if (updateData.outputStyle !== undefined) fields.output_style = updateData.outputStyle;
    if (updateData.output_style !== undefined) fields.output_style = updateData.output_style;
    if (updateData.enableThinkTags !== undefined) fields.enable_think_tags = updateData.enableThinkTags;
    if (updateData.enable_think_tags !== undefined) fields.enable_think_tags = updateData.enable_think_tags;
    if (updateData.proxyUrl !== undefined) fields.proxy_url = updateData.proxyUrl;
    if (updateData.proxy_url !== undefined) fields.proxy_url = updateData.proxy_url;
    if (updateData.deepThinkingType !== undefined) fields.deep_thinking_type = updateData.deepThinkingType;
    if (updateData.deep_thinking_type !== undefined) fields.deep_thinking_type = updateData.deep_thinking_type;
    if (updateData.deductDeepThink !== undefined) fields.deduct_deep_think = updateData.deductDeepThink;
    if (updateData.deduct_deep_think !== undefined) fields.deduct_deep_think = updateData.deduct_deep_think;
    if (updateData.maxContextRounds !== undefined) fields.max_context_rounds = updateData.maxContextRounds;
    if (updateData.max_context_rounds !== undefined) fields.max_context_rounds = updateData.max_context_rounds;
    if (updateData.maxContextTokens !== undefined) fields.max_context_tokens = updateData.maxContextTokens;
    if (updateData.max_context_tokens !== undefined) fields.max_context_tokens = updateData.max_context_tokens;
    if (updateData.maxReplyTokens !== undefined) fields.max_reply_tokens = updateData.maxReplyTokens;
    if (updateData.max_reply_tokens !== undefined) fields.max_reply_tokens = updateData.max_reply_tokens;
    if (updateData.timeout !== undefined) fields.timeout = updateData.timeout;
    if (updateData.enableWebSearch !== undefined) fields.enable_web_search = updateData.enableWebSearch;
    if (updateData.enable_web_search !== undefined) fields.enable_web_search = updateData.enable_web_search;
    if (updateData.temperature !== undefined) fields.temperature = toSafeFloat(updateData.temperature);
    if (updateData.responseFormat !== undefined) fields.response_format = updateData.responseFormat;
    if (updateData.response_format !== undefined) fields.response_format = updateData.response_format;
    if (updateData.tokenBillingEnabled !== undefined) fields.token_billing_enabled = updateData.tokenBillingEnabled;
    if (updateData.token_billing_enabled !== undefined) fields.token_billing_enabled = updateData.token_billing_enabled;
    if (updateData.inputCostPerMillion !== undefined) fields.input_cost_per_million = updateData.inputCostPerMillion;
    if (updateData.input_cost_per_million !== undefined) fields.input_cost_per_million = updateData.input_cost_per_million;
    if (updateData.outputCostPerMillion !== undefined) fields.output_cost_per_million = updateData.outputCostPerMillion;
    if (updateData.output_cost_per_million !== undefined) fields.output_cost_per_million = updateData.output_cost_per_million;
    if (updateData.cachedCostPerMillion !== undefined) fields.cached_cost_per_million = updateData.cachedCostPerMillion;
    if (updateData.cached_cost_per_million !== undefined) fields.cached_cost_per_million = updateData.cached_cost_per_million;
    if (updateData.profitMargin !== undefined) fields.profit_margin = toSafeFloat(updateData.profitMargin);
    if (updateData.profit_margin !== undefined) fields.profit_margin = toSafeFloat(updateData.profit_margin);
    if (updateData.tokenRoundingUnit !== undefined) fields.token_rounding_unit = updateData.tokenRoundingUnit;
    if (updateData.token_rounding_unit !== undefined) fields.token_rounding_unit = updateData.token_rounding_unit;
    if (updateData.userAccess !== undefined) fields.user_access = updateData.userAccess;
    if (updateData.user_access !== undefined) fields.user_access = updateData.user_access;
    if (updateData.model_id !== undefined) fields.model_id = updateData.model_id || null;
    // 空 model_id 转成 null，避免 PostgreSQL UUID 类型错误。
    if (updateData.frequencyLimit !== undefined) fields.frequency_limit = toSafeInt(updateData.frequencyLimit);
    if (updateData.frequency_limit !== undefined) fields.frequency_limit = toSafeInt(updateData.frequency_limit);
    if (updateData.imageParsing !== undefined) fields.image_parsing = updateData.imageParsing;
    if (updateData.image_parsing !== undefined) fields.image_parsing = updateData.image_parsing;
    if (updateData.fileParsing !== undefined) fields.file_parsing = updateData.fileParsing;
    if (updateData.file_parsing !== undefined) fields.file_parsing = updateData.file_parsing;
    if (updateData.cover_url !== undefined && updateData.cover_url !== currentAgent.cover_url) {
      fields.cover_url = await assertManagedCoverReference(updateData.cover_url, admin.userId);
    }
    if (updateData.guideMessage !== undefined) fields.guide_message = updateData.guideMessage;
    if (updateData.guide_message !== undefined) fields.guide_message = updateData.guide_message;
    if (updateData.enableKnowledgeBase !== undefined) fields.enable_knowledge_base = updateData.enableKnowledgeBase;
    if (updateData.enable_knowledge_base !== undefined) fields.enable_knowledge_base = updateData.enable_knowledge_base;
    if (updateData.knowledgeBaseId !== undefined) fields.knowledge_base_id = updateData.knowledgeBaseId;
    if (updateData.knowledge_base_id !== undefined) fields.knowledge_base_id = updateData.knowledge_base_id;

    if (fields.system_prompt !== undefined || fields.output_style !== undefined || hasOwnInput(updateData, ['directorContractAction'])) {
      const previousStyle = currentAgent.output_style && typeof currentAgent.output_style === 'object'
        ? currentAgent.output_style as Record<string, unknown> : {};
      const nextStyle = fields.output_style !== undefined ? fields.output_style : currentAgent.output_style;
      const submittedStyle = nextStyle && typeof nextStyle === 'object' ? nextStyle as Record<string, unknown> : {};
      const contractChanged = STORYBOARD_DIRECTOR_CONTRACT_FIELDS.some((key) =>
        Object.prototype.hasOwnProperty.call(previousStyle, key) !== Object.prototype.hasOwnProperty.call(submittedStyle, key)
        || previousStyle[key] !== submittedStyle[key]);
      if (contractChanged && !hasOwnInput(updateData, AGENT_PROMPT_INPUT_KEYS)) {
        const contractAccess = await authorizeAdminCapability(request, 'prompts.edit', {
          requireStepUp: true,
          operation: 'agent_director_contract_edit',
        });
        if (!contractAccess.ok) return contractAccess.response;
      }
      // 旧提示词与合同配置来自同一条持久记录，并由下方版本条件原子保存。
      const normalizedStyle = normalizeStoryboardDirectorContractActivation({
        agentId,
        prompt: fields.system_prompt !== undefined ? fields.system_prompt : currentAgent.system_prompt,
        previousPrompt: currentAgent.system_prompt,
        previousValue: currentAgent.output_style,
        nextValue: fields.output_style !== undefined ? fields.output_style : currentAgent.output_style,
        action: updateData.directorContractAction as 'activate' | 'preserve' | 'rollback' | undefined,
        now: savedAt,
      });
      if (normalizedStyle !== undefined) fields.output_style = normalizedStyle;
    }

    // Auto-store external avatar URL to object storage
    if (updateData.avatar !== undefined && updateData.avatar !== currentAgent.avatar) {
      const requestedAvatar = typeof updateData.avatar === 'string' ? updateData.avatar.trim() : '';
      fields.avatar = await storeAvatarIfNeeded(requestedAvatar, agentId, admin.userId);
    }

    // 分类变更时自动排到新分类末尾。
    if (updateData.category !== undefined && updateData.category !== currentAgent.category && updateData.sort_order === undefined && updateData.sortOrder === undefined) {
      const { data: maxSortData } = await client
        .from('agents')
        .select('sort_order')
        .eq('category', updateData.category)
        .is('deleted_at', null)
        .order('sort_order', { ascending: false })
        .limit(1);
      fields.sort_order = (maxSortData?.[0]?.sort_order || 0) + 10;
    }

    if (fields.model_id !== undefined || fields.model !== undefined || fields.source === 'llm') {
      const { data: previous } = await client.from('agents').select('source,model_id').eq('id', agentId).maybeSingle();
      if ((fields.source || previous?.source) === 'llm') {
        const bindingId = fields.model_id !== undefined ? fields.model_id : previous?.model_id;
        const { data: linked } = await client
          .from('llm_models')
          .select(AGENT_MODEL_BINDING_COLUMNS.join(','))
          .eq('id', bindingId || '')
          .maybeSingle();
        try {
          const binding = canonicalAgentModelBinding(bindingId, linked);
          if (fields.model_id === undefined && fields.model !== undefined && fields.model !== binding.model) {
            throw new Error('模型名称与绑定不一致，请在模型下拉框中重新选择');
          }
          Object.assign(fields, binding);
        } catch (error) {
          return NextResponse.json({ error: error instanceof Error ? error.message : '模型绑定无效', code: 'AGENT_MODEL_BINDING_INVALID' }, { status: 400 });
        }
      }
    }

    // Preserve the prompt that is about to be replaced. This keeps the
    // administrator's cloud history usable even when the agent had no prior
    // prompt_versions rows.
    if (!revisionManaged && fields.system_prompt !== undefined) {
      const { data: previousAgent, error: previousAgentError } = await client
        .from('agents')
        .select('system_prompt')
        .eq('id', agentId)
        .single();

      if (previousAgentError) {
        return NextResponse.json({ error: `读取旧提示词失败: ${previousAgentError.message}` }, { status: 500 });
      }

      await persistPromptVersion(client, agentId, String(previousAgent?.system_prompt || ''));
    }

    let updateQuery = client
      .from('agents')
      .update(fields)
      .eq('id', agentId);
    if (revisionManaged) {
      updateQuery = updateQuery.eq('config_revision', expectedRevision);
    }
    const { data, error } = await updateQuery
      .select()
      .maybeSingle();

    if (error) {
      return NextResponse.json({ error: `更新智能体失败: ${error.message}` }, { status: 500 });
    }
    if (!data) {
      const latest = await client
        .from('agents')
        .select('config_revision')
        .eq('id', agentId)
        .maybeSingle();
      return agentRevisionConflict(expectedRevision as number, latest.data?.config_revision ?? null);
    }

    // 数据库写入成功后先失效 LLM 运行缓存，确保名称、系统提示词及其他配置
    // 在下一次请求中重新读取；失效函数不读取、返回或记录提示词明文。
    invalidateAgentConfigCache(agentId);

    if (!revisionManaged && fields.system_prompt !== undefined) {
      await persistPromptVersion(client, agentId, String(data.system_prompt || ''));
    }

    // 排序、分类或配置变更后失效前台缓存。
    if (
      fields.sort_order !== undefined ||
      fields.category !== undefined ||
      fields.avatar !== undefined ||
      fields.cover_url !== undefined ||
      fields.system_prompt !== undefined ||
      fields.model !== undefined ||
      fields.model_id !== undefined ||
      fields.preset_fields !== undefined ||
      fields.output_style !== undefined ||
      fields.response_format !== undefined ||
      fields.is_active !== undefined ||
      fields.user_access !== undefined
    ) {
      invalidateBotsCache();
    }

    return NextResponse.json({ success: true, agent: publicAgent(data as Record<string, unknown>) });
  } catch (err) {
    if (err instanceof StoryboardDirectorContractActivationError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: 400 });
    }
    console.error('Update agent error:', err);
    const imageFailure = agentImageFailure(err, '智能体图片无效');
    if (imageFailure) return imageFailure;
    return NextResponse.json({ error: '更新智能体失败' }, { status: 500 });
  }
}

// DELETE - Delete agent
export async function DELETE(request: NextRequest) {
  const managementAccess = await authorizeAgentMutation(request, 'agent_delete');
  if (!managementAccess.ok) return managementAccess.response;

  try {
    const { searchParams } = new URL(request.url);
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const agentId = searchParams.get('id') || body.agentId || body.id;
    const permanentParam = searchParams.get('permanent');
    const permanent = permanentParam === '1' || permanentParam === 'true' || body.permanent === true;

    if (typeof agentId !== 'string' || !agentId) {
      return NextResponse.json({ error: '智能体 ID 不能为空' }, { status: 400 });
    }

    const client = getSupabaseClient();
    const { data: currentAgent, error: currentAgentError } = await client
      .from('agents')
      .select('id,category,user_access,config_revision')
      .eq('id', agentId)
      .maybeSingle();
    if (currentAgentError) return NextResponse.json({ error: '读取智能体失败' }, { status: 500 });
    if (!currentAgent) return NextResponse.json({ error: '智能体不存在或已删除' }, { status: 404 });
    const expectedRevision = parseExpectedAgentRevision({
      ...body,
      expected_revision: searchParams.get('expected_revision') ?? body.expected_revision,
    });
    if (expectedRevision === null) return expectedAgentRevisionRequired(currentAgent.config_revision);
    if (
      currentAgent.user_access === 'hidden'
      || await categoryRequiresInternalAccess(currentAgent.category)
    ) {
      const internalAccess = await authorizeInternalAgentMutation(request, 'internal_agent_delete');
      if (!internalAccess.ok) return internalAccess.response;
    }
    const mutation = permanent
      ? await deleteAgentByRevision({ agentId, expectedRevision, deletedScope: 'deleted' })
      : await updateAgentByRevision({
          agentId,
          expectedRevision,
          fields: { deleted_at: new Date().toISOString(), updated_at: new Date().toISOString() },
          deletedScope: 'active',
        });
    const { data, error } = mutation;

    if (error) {
      return NextResponse.json({ error: `${permanent ? '永久删除' : '删除'}智能体失败: ${error.message}` }, { status: 500 });
    }

    if (!data) {
      return agentRevisionConflict(expectedRevision, mutation.currentRevision, {
        operation: permanent ? 'permanent_delete' : 'soft_delete',
      });
    }

    invalidateAgentConfigCache(agentId);
    invalidateBotsCache();

    return NextResponse.json({ success: true, message: permanent ? '已永久删除' : '已移入回收站' });
  } catch (err) {
    console.error('Delete agent error:', err);
    return NextResponse.json({ error: '删除智能体失败' }, { status: 500 });
  }
}
