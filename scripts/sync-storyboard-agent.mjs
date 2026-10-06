import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";

dotenv.config({ path: ".env.local", quiet: true });

const LEGACY_AGENT_NAME = "故事版导演｜4-5格连续故事板";
const STORYBOARD_MODEL_NAME = "GPT-5.6-Sol · 故事板长输出";
const SOURCE_MODEL_ID = "9b177ccc-4afc-4d49-96bb-fdd01f09bf89";
const PROMPT_PATH = new URL(
  "../docs/故事版导演智能体三卡一核-v5.0.md",
  import.meta.url,
);

const AGENT_DEFINITIONS = [
  {
    name: "故事版导演｜高能夸张",
    aliases: [LEGACY_AGENT_NAME],
    directorName: "高能夸张3D故事版导演",
    strategyBlock: 1,
    description: "把已分段口播逐段改编成高能夸张的4-5格3D故事板生图Prompt和整合视频Prompt。",
    guideMessage: "请选择3D风格，并提供已经分段的文案、画面尺寸和可选角色设定。",
  },
  {
    name: "故事版导演｜电影叙事",
    aliases: [],
    directorName: "电影叙事3D故事版导演",
    strategyBlock: 2,
    description: "把已分段口播改编成因果清楚、空间连续、镜头有动机的4-5格3D电影故事板。",
    guideMessage: "适合剧情与知识故事。请选择3D风格，并提供分段文案与画面尺寸。",
  },
  {
    name: "故事版导演｜抒情情感",
    aliases: [],
    directorName: "抒情情感3D故事版导演",
    strategyBlock: 3,
    description: "把已分段口播改编成依靠眼神、动作、空间和光线推进的4-5格3D情感故事板。",
    guideMessage: "适合陪伴、依恋、离别与治愈内容。请选择3D风格并提供分段文案。",
  },
];

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`缺少环境变量：${name}`);
  return value;
}

function extractBlock(source, language, fenceLength, occurrence = 0) {
  const fence = `\`{${fenceLength}}`;
  const expression = new RegExp(
    `${fence}${language}\\r?\\n([\\s\\S]*?)\\r?\\n${fence}`,
    "g",
  );
  const matches = [...source.matchAll(expression)];
  if (!matches[occurrence]?.[1]) {
    throw new Error(`未在提示词文档中找到第 ${occurrence + 1} 个 ${language} 代码块`);
  }
  return matches[occurrence][1].trim();
}

function withoutDatabaseMetadata(row) {
  const copy = { ...row };
  for (const key of ["id", "created_at", "updated_at", "deleted_at"]) {
    delete copy[key];
  }
  return copy;
}

async function loadConfiguration() {
  const source = await readFile(PROMPT_PATH, "utf8");
  const presetFields = JSON.parse(extractBlock(source, "json", 3));
  const promptTemplate = extractBlock(source, "text", 4);

  if (!Array.isArray(presetFields) || presetFields.length !== 5) {
    throw new Error("故事版智能体接收模板必须恰好包含 5 个字段");
  }
  if (!promptTemplate.includes("# 固定输出格式")) {
    throw new Error("系统提示词缺少固定输出格式协议");
  }
  if (!promptTemplate.includes("故事板分镜图文生图 Prompt")) {
    throw new Error("系统提示词缺少故事板生图输出接口");
  }
  if (!promptTemplate.includes("图生视频 Prompt")) {
    throw new Error("系统提示词缺少图生视频输出接口");
  }
  const styles = presetFields.find((field) => field.id === "storyboard_visual_style")?.options;
  if (!Array.isArray(styles) || styles.length !== 10 || styles.some((style) => !String(style).includes("3D"))) {
    throw new Error("故事版智能体必须提供恰好10种3D动画风格");
  }

  const agents = AGENT_DEFINITIONS.map((definition) => {
    const strategy = extractBlock(source, "text", 4, definition.strategyBlock);
    const systemPrompt = promptTemplate
      .replaceAll("{{DIRECTOR_NAME}}", definition.directorName)
      .replaceAll("{{DIRECTOR_PROFILE}}", strategy);
    if (systemPrompt.includes("{{DIRECTOR_")) {
      throw new Error(`${definition.name}仍包含未替换的导演占位符`);
    }
    return { ...definition, systemPrompt };
  });

  return { presetFields, agents };
}

async function inspect(client) {
  const { data: sourceModel, error: modelError } = await client
    .from("llm_models")
    .select("*")
    .eq("id", SOURCE_MODEL_ID)
    .single();
  if (modelError) throw modelError;

  const { data: existingAgents, error: agentError } = await client
    .from("agents")
    .select("id,name,category,model,model_id,max_reply_tokens,deep_thinking_type,is_active,sort_order")
    .in("name", [LEGACY_AGENT_NAME, ...AGENT_DEFINITIONS.map((item) => item.name)]);
  if (agentError) throw agentError;

  console.log(JSON.stringify({
    sourceModel: {
      id: sourceModel.id,
      name: sourceModel.name,
      model_name: sourceModel.model_name,
      provider: sourceModel.provider,
      is_active: sourceModel.is_active,
      max_reply_tokens: sourceModel.max_reply_tokens,
      deep_thinking_type: sourceModel.deep_thinking_type,
      availableColumns: Object.keys(sourceModel).sort(),
    },
    existingAgents,
  }, null, 2));
}

async function ensureLongOutputModel(client) {
  const { data: sourceModel, error: sourceError } = await client
    .from("llm_models")
    .select("*")
    .eq("id", SOURCE_MODEL_ID)
    .single();
  if (sourceError) throw sourceError;

  const { data: existing, error: existingError } = await client
    .from("llm_models")
    .select("*")
    .eq("name", STORYBOARD_MODEL_NAME)
    .maybeSingle();
  if (existingError) throw existingError;

  const now = new Date().toISOString();
  const base = withoutDatabaseMetadata(sourceModel);
  const payload = {
    ...base,
    name: STORYBOARD_MODEL_NAME,
    model_name: sourceModel.model_name,
    max_reply_tokens: 32768,
    is_active: true,
    is_hidden: true,
    updated_at: now,
  };

  if (existing) {
    const { data, error } = await client
      .from("llm_models")
      .update(payload)
      .eq("id", existing.id)
      .select("*")
      .single();
    if (error) throw error;
    return data;
  }

  const { data, error } = await client
    .from("llm_models")
    .insert({ ...payload, id: randomUUID(), created_at: now })
    .select("*")
    .single();
  if (error) throw error;
  return data;
}

async function ensureAgent(client, model, presetFields, definition, defaultSortOrder) {
  const { data: candidates, error: existingError } = await client
    .from("agents")
    .select("*")
    .in("name", [definition.name, ...definition.aliases])
    .is("deleted_at", null);
  if (existingError) throw existingError;
  const existing = candidates?.find((item) => item.name === definition.name) || candidates?.[0] || null;

  let sortOrder = existing?.sort_order;
  if (!Number.isFinite(sortOrder)) {
    sortOrder = defaultSortOrder;
  }

  const now = new Date().toISOString();
  const payload = {
    name: definition.name,
    description: definition.description,
    avatar: "",
    category: "引流带货",
    source: "llm",
    bot_id: "",
    model: model.model_name,
    model_id: model.id,
    system_prompt: definition.systemPrompt,
    preset_fields: presetFields,
    cost_per_message: 10,
    base_fee: 0,
    sort_order: sortOrder,
    is_active: true,
    output_style: {},
    enable_think_tags: false,
    deep_thinking_type: model.deep_thinking_type ?? 0,
    deduct_deep_think: model.deduct_deep_think ?? 1,
    max_context_rounds: 1,
    max_context_tokens: 0,
    max_reply_tokens: 32768,
    timeout: 120,
    enable_web_search: false,
    temperature: 0.6,
    response_format: "markdown",
    token_billing_enabled: false,
    user_access: "available",
    frequency_limit: 50,
    image_parsing: "none",
    file_parsing: "none",
    cover_url: null,
    guide_message: definition.guideMessage,
    enable_knowledge_base: false,
    knowledge_base_id: "",
    updated_at: now,
  };

  if (existing) {
    const { data, error } = await client
      .from("agents")
      .update(payload)
      .eq("id", existing.id)
      .select("*")
      .single();
    if (error) throw error;
    return data;
  }

  const { data, error } = await client
    .from("agents")
    .insert({
      ...payload,
      id: `agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      created_at: now,
    })
    .select("*")
    .single();
  if (error) throw error;
  return data;
}

async function main() {
  const client = createClient(
    required("COZE_SUPABASE_URL"),
    required("COZE_SUPABASE_SERVICE_ROLE_KEY"),
    { auth: { persistSession: false, autoRefreshToken: false } },
  );

  const configuration = await loadConfiguration();
  if (process.argv.includes("--inspect")) {
    await inspect(client);
    return;
  }

  const model = await ensureLongOutputModel(client);
  const { data: latest, error: sortError } = await client
    .from("agents")
    .select("sort_order")
    .eq("category", "引流带货")
    .is("deleted_at", null)
    .order("sort_order", { ascending: false })
    .limit(1);
  if (sortError) throw sortError;
  const legacy = await client
    .from("agents")
    .select("sort_order")
    .eq("name", LEGACY_AGENT_NAME)
    .is("deleted_at", null)
    .maybeSingle();
  if (legacy.error) throw legacy.error;
  const firstSortOrder = Number(legacy.data?.sort_order || latest?.[0]?.sort_order || 0);
  const agents = [];
  for (const [index, definition] of configuration.agents.entries()) {
    agents.push(await ensureAgent(
      client,
      model,
      configuration.presetFields,
      definition,
      firstSortOrder + index * 10,
    ));
  }
  console.log(JSON.stringify({
    success: true,
    agents: agents.map((agent) => ({
      id: agent.id,
      name: agent.name,
      category: agent.category,
      model: agent.model,
      model_id: agent.model_id,
      is_active: agent.is_active,
      sort_order: agent.sort_order,
      preset_field_count: agent.preset_fields?.length || 0,
      style_option_count: agent.preset_fields?.find((field) => field.id === "storyboard_visual_style")?.options?.length || 0,
      system_prompt_length: agent.system_prompt?.length || 0,
      max_reply_tokens: agent.max_reply_tokens,
    })),
    model: {
      id: model.id,
      name: model.name,
      model_name: model.model_name,
      max_reply_tokens: model.max_reply_tokens,
    },
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
