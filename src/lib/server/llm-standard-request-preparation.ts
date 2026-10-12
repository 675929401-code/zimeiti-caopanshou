import { createHash } from "node:crypto";
import { prepareContext, type ChatMessage } from "@/lib/llm-context";
import { resolveChatReplyLimit } from "@/lib/llm-reply-limit";
import { resolveAuthoritativeAgentPrompt, clientChatHistory } from "@/lib/server/agent-chat-prompt-authority";
import { wrapGlobalPresentationRules, applyAgentIdentityEnvelope } from "@/lib/agent-identity-envelope";
import { bipStep, bipAllowsSkills } from "@/lib/business-ip/catalog";
import { buildWebsitePromoterKnowledgeContext } from "@/lib/website-promoter-context";
import { shouldAutoEnableWebSearch } from "@/lib/free-chat-runtime-policy";
import { billingConfigFromSettingsRows, type BillingConfig } from "@/lib/billing";
import { buildSelectedModelBillingSnapshot } from "@/lib/llm-billing";
import { quoteLlmStreamReservation } from "@/lib/llm-credit-reservation";
import type { ChatRequest } from "@/lib/llm-proxy";

type Row = Record<string, any>;
export class LlmQuotePreparationError extends Error {
  constructor(readonly code: string) { super(code); this.name = "LlmQuotePreparationError"; }
}
function refuse(code: string): never { throw new LlmQuotePreparationError(code); }
export function quoteCanonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(quoteCanonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([,v])=>v!==undefined).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,quoteCanonical(v)]));
  return value;
}
export const quoteDigest = (value: unknown) => createHash("sha256").update(JSON.stringify(quoteCanonical(value))).digest("hex");
export const quoteTextDigest = (value: string) => createHash("sha256").update(value).digest("hex");
export type RuntimeParameters = { agentDeepThinkingType: number; agentDeductDeepThink: number; agentMaxContextRounds: number; agentMaxContextTokens: number; agentMaxReplyTokens: number; agentTimeout: number; agentEnableWebSearch: boolean; agentTemperature: number | undefined; agentResponseFormat: string | undefined };
export async function composeLlmRequestMessages(input: Row & RuntimeParameters) {
  let { agentDeepThinkingType, agentDeductDeepThink, agentMaxContextRounds, agentMaxContextTokens, agentMaxReplyTokens, agentTimeout, agentEnableWebSearch, agentTemperature, agentResponseFormat } = input;
  const { agentId, agentName, agentRow, mangaSkillOrchestration, isCanvasInternalWorkflow, verifiedUserId, body, globalPrefix, messages, useModel, loadProfileContext, loadSkills } = input;
  const beginPreparationStage = input.beginPreparationStage || (() => () => {});
  const onBasePrompt = input.onBasePrompt || (() => {});
  const logger = input.logger || { log() {}, warn() {} };
  const FAST_CONTEXT_ROUND_LIMIT = 24, FAST_CONTEXT_TOKEN_LIMIT = 32768, FAST_CONTEXT_TOKEN_TRIGGER = 48000;
    let effectiveSystemPrompt: string;
    try {
      effectiveSystemPrompt = resolveAuthoritativeAgentPrompt({
        hasPersistedAgent: Boolean(agentRow), serverPrompt: agentRow?.system_prompt,
        publishedPrompt: mangaSkillOrchestration?.systemPrompt,
        authorizedInternalWorkflow: isCanvasInternalWorkflow && Boolean(verifiedUserId),
        workflowPrompt: body.system_prompt,
      });
    } catch (error) {
      throw error;
    }
    onBasePrompt(effectiveSystemPrompt, agentRow?.config_revision);
    const globalPresentationRules = wrapGlobalPresentationRules(globalPrefix);
    if (globalPresentationRules) {
      effectiveSystemPrompt = effectiveSystemPrompt
        ? `${effectiveSystemPrompt}\n\n${globalPresentationRules}`
        : globalPresentationRules;
    }

    // 咨询回复与跟进始终由服务端按登录会员读取当前业务档案。
    // 会员维护的是自己的业务事实，不接触也不能替换平台通用调度底座。
    const finishProfileStage = beginPreparationStage("member_profile");
    const businessIpProfileContext = await loadProfileContext();
    finishProfileStage();
    if (businessIpProfileContext) {
      effectiveSystemPrompt += `\n\n${businessIpProfileContext}`;
    }

    // ── 格式与身份约束 ──
    // 平台通用前缀只负责呈现规则；专属智能体提示词才是角色与工作流权威。
    // 身份边界在所有动态知识和技能注入完成后统一包裹首尾，防止长提示词、
    // 历史消息或模型默认身份稀释当前智能体角色。
    const effectiveAgentName = mangaSkillOrchestration
      ? "漫剧工作台创作 Agent"
      : (typeof agentRow?.name === "string" ? agentRow.name : agentName);

    if (agentResponseFormat === "markdown" && effectiveSystemPrompt) {
      // 仅当智能体没有自定义格式时，补上商业产品通用的可读性底线；
      // 明确要求纯正文、口播稿或结构化协议的智能体仍以自身规范为准。
      const hasOwnFormat = effectiveSystemPrompt.includes("输出规范")
        || effectiveSystemPrompt.includes("输出格式")
        || effectiveSystemPrompt.includes("格式要求")
        || effectiveSystemPrompt.includes("输出模块")
        || /(?:JSON|XML|YAML|结构化协议|机器可读|固定字段|全文纯正文|可直接朗读|不(?:要|使用).{0,8}(?:标题|列表|Markdown)|(?:口播稿|纯正文).{0,12}(?:输出|交付)|(?:输出|交付).{0,12}(?:口播稿|纯正文))/iu.test(effectiveSystemPrompt);
      if (!hasOwnFormat && !effectiveSystemPrompt.includes("Markdown 格式输出")) {
        effectiveSystemPrompt += `\n\n请使用 Markdown 格式输出，并按商业交付标准组织阅读层级：先给直接结论；内容较长时使用简短标题分节，每段控制在 2 至 4 句；并列信息或步骤使用列表，确有对比维度时再使用表格；重点可适度加粗。避免整篇密集长段、连续堆叠小标题、无意义重复和装饰性符号。用户明确要求纯正文、口播稿或指定格式时，以用户要求为准。`;
      }
    } else if (agentResponseFormat === "text" && effectiveSystemPrompt) {
      const hasOwnFormat = effectiveSystemPrompt.includes("输出规范") || effectiveSystemPrompt.includes("输出格式") || effectiveSystemPrompt.includes("格式要求");
      if (!hasOwnFormat && !effectiveSystemPrompt.includes("纯文本格式输出")) {
        effectiveSystemPrompt += `\n\n请使用纯文本格式输出，不要使用 Markdown 排版语法（代码块除外）。`;
      }
    }

    // ── 技能系统：动态注入（零影响，仅 LLM 智能体 + 有技能时激活） ──
    // 动态 import 隔离：无技能时不加载 skill-registry 模块
    let skillInjection: { skillPromptSuffix: string; tools: unknown[] } | null = null;
    const finishSkillStage = beginPreparationStage("skills");
    let skillStageOutcome: "success" | "warning" = "success";
    if (agentId && agentRow?.source === "llm" && (!bipStep(agentId) || bipAllowsSkills(agentId))) {
      try {
        skillInjection = await loadSkills();
      } catch (err) {
        skillStageOutcome = "warning";
        logger.warn("[LLM Route] 技能注入失败（不影响正常流程）:", err);
      }
    }
    finishSkillStage(skillStageOutcome);
    // 将技能调度提示词追加到系统提示词末尾
    if (skillInjection?.skillPromptSuffix) {
      effectiveSystemPrompt += skillInjection.skillPromptSuffix;
    }

    // 网站功能推广师使用构建期生成的只读知识快照。只按当前用户问题
    // 召回少量 S1-S4 记录，不把 160 条痛点和全部样本常驻系统提示词。
    // 精确 agent ID 门禁位于 helper 内，其他智能体不会装载这份知识。
    const websitePromoterKnowledge = buildWebsitePromoterKnowledgeContext({
      agentId,
      messages,
    });
    if (websitePromoterKnowledge) {
      effectiveSystemPrompt += `\n\n${websitePromoterKnowledge.systemPromptSuffix}`;
      logger.log(
        `[WEBSITE_PROMOTER_KB] mode=${websitePromoterKnowledge.knowledgeMode} snapshot=${websitePromoterKnowledge.snapshotId} state=${websitePromoterKnowledge.topicSnapshotState} chars=${websitePromoterKnowledge.characterCount} selected=${Object.values(websitePromoterKnowledge.selectedIds).reduce((sum, ids) => sum + ids.length, 0)}`,
      );
    }

    effectiveSystemPrompt = applyAgentIdentityEnvelope(effectiveSystemPrompt, effectiveAgentName);

    // ── 上下文管理（不设上限，模型自身上下文窗口为天然限制） ──

    // ★ 记忆诊断日志：输出最终上下文参数，排查"无记忆"问题
    if (bipStep(agentId)) {
      // Model presets must not erase the suite's project limits or route it
      // through the separate global thinking pipeline (which has no BIP output guard).
      agentDeepThinkingType = agentDeepThinkingType === 2 ? 2 : 0;
      agentMaxContextRounds = Math.min(40, Math.max(1, Number(agentRow?.max_context_rounds) || 40));
      agentMaxContextTokens = Math.min(30000, Math.max(8192, Number(agentRow?.max_context_tokens) || 30000));
    }
    const historyMessageCount = messages.filter((m: { role: string }) => m.role !== "system").length;
    const estimatedInputTokens = messages.reduce((sum: number, msg: { content: unknown }) => {
      const content = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content ?? "");
      return sum + Math.ceil(content.length / 2);
    }, effectiveSystemPrompt ? Math.ceil(effectiveSystemPrompt.length / 2) : 0);
    if (agentMaxContextRounds <= 0 && historyMessageCount > FAST_CONTEXT_ROUND_LIMIT * 2) {
      agentMaxContextRounds = FAST_CONTEXT_ROUND_LIMIT;
    }
    if (agentMaxContextTokens <= 0 && estimatedInputTokens > FAST_CONTEXT_TOKEN_TRIGGER) {
      agentMaxContextTokens = FAST_CONTEXT_TOKEN_LIMIT;
    }

    const _sysPromptTokens = effectiveSystemPrompt ? Math.ceil(effectiveSystemPrompt.length / 2) + 4 : 0;
    const _historyBudget = agentMaxContextTokens > 0 ? Math.max(agentMaxContextTokens - _sysPromptTokens, 8192) : 0;
    logger.log(`[CONTEXT] agent=${agentName || agentId || "unknown"} rounds=${agentMaxContextRounds} maxTokens=${agentMaxContextTokens} sysPrompt=${_sysPromptTokens}tokens(${effectiveSystemPrompt?.length || 0}chars) historyBudget=${_historyBudget}tokens model=${useModel}`);

    const finishContextStage = beginPreparationStage("context");
    const finalMessages = await prepareContext(
      clientChatHistory(messages as ChatMessage[]),
      {
        maxContextRounds: agentMaxContextRounds,
        maxContextTokens: agentMaxContextTokens,
        systemPrompt: effectiveSystemPrompt || undefined,
      }
    );
    finishContextStage();


  return { effectiveSystemPrompt, skillInjection, finalMessages, agentDeepThinkingType, agentMaxContextRounds, agentMaxContextTokens };
}

// Transport adapters must supply these exact public-to-server facts without secret fields.
export const STANDARD_AGENT_FIELDS = ["id","name","source","is_active","deleted_at","model_id","model","system_prompt","config_revision","deep_thinking_type","deduct_deep_think","max_context_rounds","max_context_tokens","max_reply_tokens","timeout","enable_web_search","temperature","response_format","user_access","category"] as const;
export const STANDARD_MODEL_FIELDS = ["id","name","model_name","is_active","is_hidden","user_access","deep_thinking_type","deduct_deep_think","max_context_rounds","max_context_tokens","max_reply_tokens","timeout","enable_web_search","temperature","response_format","token_billing_enabled","input_cost_per_million","output_cost_per_million","cached_cost_per_million","profit_margin","token_rounding_unit"] as const;
export const STANDARD_SETTING_KEYS = ["global_system_prefix","input_cost_per_million","output_cost_per_million","cached_cost_per_million","profit_margin","credits_per_yuan","token_rounding_enabled","token_rounding_unit","token_rounding_min","token_rounding_max"] as const;
export interface StandardSnapshot { agent: Row; model: Row; settings: Array<{setting_key:string;setting_value:string}>; actor: Row; skills: Row[]; readsVerified: true }
export interface StrictPreparationReader { readAgent(id:string):Promise<Row[]>; readModel(id:string):Promise<Row[]>; readSettings():Promise<Array<{setting_key:string;setting_value:string}>>; readActor(id:string):Promise<Row[]>; readSkills(id:string):Promise<Row[]> }
export async function readStandardSnapshot(reader: StrictPreparationReader, actorId: string, agentId: string): Promise<StandardSnapshot> {
  try {
    const agents = await reader.readAgent(agentId); if (agents.length !== 1) refuse("LLM_QUOTE_AGENT_UNKNOWN");
    const agent = agents[0]; if (typeof agent.model_id !== "string" || !agent.model_id) refuse("LLM_QUOTE_LINKED_MODEL_REQUIRED");
    const [models, settings, actors, skills] = await Promise.all([reader.readModel(agent.model_id),reader.readSettings(),reader.readActor(actorId),reader.readSkills(agentId)]);
    if (models.length !== 1 || actors.length !== 1 || !Array.isArray(skills)) refuse("LLM_QUOTE_SNAPSHOT_UNKNOWN");
    if (new Set(settings.map(row=>row.setting_key)).size !== settings.length) refuse("LLM_QUOTE_SETTINGS_AMBIGUOUS");
    return {agent,model:models[0],settings,actor:actors[0],skills,readsVerified:true};
  } catch (error) { if (error instanceof LlmQuotePreparationError) throw error; refuse("LLM_QUOTE_READ_UNKNOWN"); }
}
export function resolveLinkedModelRuntime(body: Row, agent: Row, model: Row): RuntimeParameters {
  const isDeepThinkingOverridden = body.deep_thinking_overridden ?? body.deepThinkingOverridden ?? false;
  const isWebSearchOverridden = body.enable_web_search_overridden ?? body.enableWebSearchOverridden ?? false;
  const clamp = (value: unknown, fallback:number) => Number.isFinite(Number(value)) && Number(value)>0 ? Math.min(Number(value),120) : fallback;
  let agentDeepThinkingType = body.deep_thinking_type ?? body.deepThinkingType ?? 0;
  let agentDeductDeepThink = body.deduct_deep_think ?? body.deductDeepThink ?? 1;
  let agentMaxContextRounds = body.max_context_rounds ?? body.maxContextRounds ?? 0;
  let agentMaxContextTokens = body.max_context_tokens ?? body.maxContextTokens ?? 0;
  let agentMaxReplyTokens = body.max_reply_tokens ?? body.maxReplyTokens ?? 65536;
  let agentTimeout = clamp(body.timeout,120);
  let agentEnableWebSearch = body.enable_web_search ?? body.enableWebSearch ?? false;
  let agentTemperature = body.temperature ?? undefined;
  let agentResponseFormat = body.response_format ?? body.responseFormat ?? undefined;
  if (!isDeepThinkingOverridden && agent.deep_thinking_type != null) agentDeepThinkingType=agent.deep_thinking_type;
  if (agent.deduct_deep_think != null) agentDeductDeepThink=agent.deduct_deep_think;
  if (agent.max_context_rounds != null) agentMaxContextRounds=agent.max_context_rounds;
  if (agent.max_context_tokens != null) agentMaxContextTokens=agent.max_context_tokens;
  if (agent.max_reply_tokens != null && agent.max_reply_tokens>0) agentMaxReplyTokens=agent.max_reply_tokens;
  if (agent.timeout != null && agent.timeout>0) agentTimeout=clamp(agent.timeout,agentTimeout);
  if (!isWebSearchOverridden && agent.enable_web_search != null) agentEnableWebSearch=agent.enable_web_search;
  if (agent.temperature != null) agentTemperature=agent.temperature;
  if (agent.response_format != null) agentResponseFormat=agent.response_format;
  if (!isDeepThinkingOverridden && model.deep_thinking_type != null) agentDeepThinkingType=model.deep_thinking_type;
  if (model.deduct_deep_think != null) agentDeductDeepThink=model.deduct_deep_think;
  if (model.max_context_rounds != null && agentMaxContextRounds!==0) agentMaxContextRounds=model.max_context_rounds;
  if (model.max_context_tokens != null && agentMaxContextTokens!==0) agentMaxContextTokens=model.max_context_tokens;
  if (agent.max_reply_tokens==null && model.max_reply_tokens>0) agentMaxReplyTokens=model.max_reply_tokens;
  if (model.timeout!=null && model.timeout>0) agentTimeout=clamp(model.timeout,agentTimeout);
  if (!isWebSearchOverridden && model.enable_web_search!=null) agentEnableWebSearch=model.enable_web_search;
  if (agent.temperature==null && model.temperature!=null) agentTemperature=model.temperature;
  if (model.response_format!=null) agentResponseFormat=model.response_format;
  agentMaxReplyTokens=resolveChatReplyLimit(agent.max_reply_tokens,agentMaxReplyTokens);
  return {agentDeepThinkingType,agentDeductDeepThink,agentMaxContextRounds,agentMaxContextTokens,agentMaxReplyTokens,agentTimeout,agentEnableWebSearch,agentTemperature,agentResponseFormat};
}
const REQUEST_KEYS = new Set(["messages","modelId","model","model_overridden","stream","userId","agentName","agent_name","agentId","conversationId","client_request_id","deepThinkingType","deep_thinking_type","deepThinkingOverridden","deep_thinking_overridden","deductDeepThink","deduct_deep_think","maxContextRounds","max_context_rounds","maxContextTokens","max_context_tokens","maxReplyTokens","max_reply_tokens","timeout","enableWebSearch","enable_web_search","enableWebSearchOverridden","enable_web_search_overridden","temperature","responseFormat","response_format","quote_expectation"]);
export function assertStandardQuoteEligibility(body: Row, snapshot: StandardSnapshot, actorId: string) {
  const {agent,model,actor}=snapshot;
  if (!snapshot.readsVerified || actor.id!==actorId || actor.is_active!==true || (actor.status!=null && actor.status!=="active") || !["student","admin"].includes(actor.role)) refuse("LLM_QUOTE_ACTOR_UNSUPPORTED");
  if (Object.keys(body).some(key=>!REQUEST_KEYS.has(key))) refuse("LLM_QUOTE_REQUEST_UNSUPPORTED");
  if (body.model_overridden===true || body.modelId || body.model || body.stream===false) refuse("LLM_QUOTE_SELECTION_UNSUPPORTED");
  if (!agent.id || body.agentId!==agent.id || agent.source!=="llm" || agent.is_active!==true || agent.deleted_at || agent.model_id!==model.id || model.is_active!==true || model.is_hidden===true || model.user_access==="hidden" || agent.user_access==="hidden") refuse("LLM_QUOTE_SELECTION_UNSUPPORTED");
  if (!Number.isSafeInteger(Number(agent.config_revision)) || Number(agent.config_revision)<=0 || typeof agent.system_prompt!=="string" || !agent.system_prompt.trim()) refuse("LLM_QUOTE_PROMPT_UNKNOWN");
  if (!Array.isArray(body.messages) || !body.messages.length || body.messages.some((m:Row)=>!m || !["system","user","assistant"].includes(m.role) || typeof m.content!=="string" || Object.keys(m).some(key=>!["role","content","name"].includes(key)))) refuse("LLM_QUOTE_MULTIMODAL_UNSUPPORTED");
  if (snapshot.skills.length) refuse("LLM_QUOTE_ACTIVE_SKILLS_UNSUPPORTED");
  // Dynamic member context is only loaded for this BIP consultation identity; quote does not guess it empty.
  if (bipStep(agent.id)) refuse("LLM_QUOTE_DYNAMIC_CONTEXT_UNSUPPORTED");
  const parameters=resolveLinkedModelRuntime(body,agent,model);
  if (![0,2].includes(parameters.agentDeepThinkingType)) refuse("LLM_QUOTE_MULTISTAGE_UNSUPPORTED");
  const user=[...body.messages].reverse().find((m:Row)=>m.role==="user");
  if (parameters.agentEnableWebSearch || shouldAutoEnableWebSearch(user?.content || "")) refuse("LLM_QUOTE_SEARCH_UNSUPPORTED");
  return parameters;
}
export function buildLlmChatRequest(model: string, messages: ChatRequest["messages"], parameters: RuntimeParameters, stream:boolean, tools: any[] = []): ChatRequest {
  return { model, messages, max_tokens:parameters.agentMaxReplyTokens, temperature:parameters.agentTemperature,
    enable_thinking:parameters.agentDeepThinkingType===2,
    response_format:parameters.agentResponseFormat==="json_object"?{type:"json_object"}:undefined,
    stream_options:stream?{include_usage:true}:undefined, ...(tools.length?{tools}:{}) };
}
export type QuoteExecutionPins={sourceVersion:string;buildId:string};
export async function prepareStandardLlmRequest(body:Row,snapshot:StandardSnapshot,actorId:string,publicModelId:string,pins:QuoteExecutionPins) {
  const parameters=assertStandardQuoteEligibility(body,snapshot,actorId);
  if (!pins.sourceVersion || !pins.buildId || !/^pm_[A-Za-z0-9_-]+$/.test(publicModelId)) refuse("LLM_QUOTE_PINS_REQUIRED");
  const config=billingConfigFromSettingsRows(snapshot.settings);
  for (const key of ["creditsPerYuan","tokenRoundingMin","tokenRoundingMax"] as const) if (!Number.isFinite(config[key]) || config[key]<=0) refuse("LLM_QUOTE_PRICING_UNKNOWN");
  if (config.tokenRoundingMax<config.tokenRoundingMin) refuse("LLM_QUOTE_PRICING_UNKNOWN");
  // Existing permissive getter defaults are preserved. Strict quote mode rejects invalid explicit settings rather than treating parser fallback as proof.
  for (const row of snapshot.settings) if (["credits_per_yuan","token_rounding_min","token_rounding_max"].includes(row.setting_key) && (!Number.isFinite(Number(row.setting_value)) || Number(row.setting_value)<=0)) refuse("LLM_QUOTE_PRICING_UNKNOWN");
  const billing=buildSelectedModelBillingSnapshot(publicModelId,snapshot.model,config); if (!billing) refuse("LLM_QUOTE_PRICING_UNKNOWN");
  const globalPrefix=snapshot.settings.find(row=>row.setting_key==="global_system_prefix")?.setting_value || "";
  const composed=await composeLlmRequestMessages({...parameters,agentId:snapshot.agent.id,agentName:snapshot.agent.name,agentRow:snapshot.agent,
    mangaSkillOrchestration:null,isCanvasInternalWorkflow:false,verifiedUserId:actorId,body,globalPrefix,messages:body.messages,useModel:billing.modelName,
    loadProfileContext:async()=>"",loadSkills:async()=>null});
  const effective={...parameters,agentDeepThinkingType:composed.agentDeepThinkingType,agentMaxContextRounds:composed.agentMaxContextRounds,agentMaxContextTokens:composed.agentMaxContextTokens};
  const chatRequest=buildLlmChatRequest(billing.modelName,composed.finalMessages,effective,true);
  const reservation=quoteLlmStreamReservation(chatRequest,billing.config,effective.agentDeepThinkingType===2?effective.agentDeductDeepThink:1);
  if (!reservation) refuse("LLM_QUOTE_UNBOUNDED");
  const facts={agent:Object.fromEntries(STANDARD_AGENT_FIELDS.map(key=>[key,snapshot.agent[key]])),model:Object.fromEntries(STANDARD_MODEL_FIELDS.map(key=>[key,snapshot.model[key]])),settings:[...snapshot.settings].sort((a,b)=>a.setting_key.localeCompare(b.setting_key)),skills:[]};
  const expectation={schemaVersion:"llm_platform_reservation_expectation.v1",actorSha256:quoteTextDigest(actorId),agentId:snapshot.agent.id,
    publishedPromptSha256:quoteTextDigest(snapshot.agent.system_prompt),configRevision:Number(snapshot.agent.config_revision),publicModelId,
    preparedRequestSha256:quoteDigest({chatRequest,parameters:effective,factsSha256:quoteDigest(facts)}),priceSnapshotSha256:quoteDigest(billing.priceSnapshot),
    platformReservationCredits:reservation.amount,sourceVersion:pins.sourceVersion,buildId:pins.buildId};
  return {chatRequest,parameters:effective,billing,reservation,expectation,composedPromptSha256:quoteTextDigest(composed.effectiveSystemPrompt),
    platformReservationYuanEquivalent:reservation.amount/billing.config.creditsPerYuan};
}
export function assertQuoteExpectation(expected:unknown,actual:Awaited<ReturnType<typeof prepareStandardLlmRequest>>["expectation"]) {
  if (!expected || typeof expected!=="object" || Array.isArray(expected) || Object.keys(expected).sort().join("|")!==Object.keys(actual).sort().join("|") || quoteDigest(expected)!==quoteDigest(actual)) refuse("LLM_QUOTE_EXPECTATION_DRIFT");
}
