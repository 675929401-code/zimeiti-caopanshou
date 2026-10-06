/**
 * 技能注册表 — 独立模块
 *
 * 职责：
 * 1. 从数据库获取智能体关联的技能（带内存缓存）
 * 2. 生成技能调度系统提示词（注入到 system prompt）
 * 3. 生成 OpenAI Function Calling 的 tools 定义
 *
 * 隔离原则：
 * - 不依赖任何现有模块的内部实现
 * - 不修改任何现有模块
 * - 对无技能的智能体零开销（缓存 miss 时一次 DB 查询，hit 时纯内存）
 */

import { getSupabaseClient } from "@/storage/database/supabase-client";

// ── 类型定义 ──

export interface SkillRecord {
  id: string;
  name: string;
  display_name: string;
  description: string;
  icon: string;
  category: string;
  skill_type: string;
  config: Record<string, unknown>;
  tool_definition: {
    type: "function";
    function: {
      name: string;
      description: string;
      parameters: {
        type: "object";
        properties: Record<string, unknown>;
        required?: string[];
      };
    };
  };
  trigger_signals: string;
  is_active: boolean;
  sort_order: number;
}

export interface AgentSkillRecord {
  id: string;
  agent_id: string;
  skill_id: string;
  is_enabled: boolean;
  sort_order: number;
  skills: SkillRecord; // Supabase join
}

export interface SkillInjectionResult {
  /** 追加到 system prompt 末尾的技能调度指令 */
  skillPromptSuffix: string;
  /** OpenAI Function Calling tools 数组 */
  tools: unknown[];
}

// ── 内存缓存（与 agentConfigCache 同模式）──

const CACHE_TTL = 60_000; // 1分钟缓存

const agentSkillsCache = new Map<string, {
  data: SkillRecord[];
  expiry: number;
}>();

function getCached(agentId: string): SkillRecord[] | null {
  const cached = agentSkillsCache.get(agentId);
  if (cached && cached.expiry > Date.now()) return cached.data;
  if (cached) agentSkillsCache.delete(agentId);
  return null;
}

function setCache(agentId: string, data: SkillRecord[]): void {
  agentSkillsCache.set(agentId, { data, expiry: Date.now() + CACHE_TTL });
}

/** 清除指定智能体的技能缓存（管理员修改技能后调用） */
export function invalidateSkillCache(agentId?: string): void {
  if (agentId) {
    agentSkillsCache.delete(agentId);
  } else {
    agentSkillsCache.clear();
  }
}

// ── 核心函数 ──

/**
 * 获取智能体关联的技能列表
 *
 * 性能保证：
 * - 缓存命中 → 纯内存，0ms DB 开销
 * - 缓存未命中 → 1次 DB 查询（agent_skills JOIN skills），通常 <5ms
 * - 无技能的智能体 → 缓存空数组，后续请求零开销
 */
export async function getSkillsForAgent(agentId: string): Promise<SkillRecord[]> {
  // 缓存命中
  const cached = getCached(agentId);
  if (cached) return cached;

  try {
    const client = getSupabaseClient();
    const { data, error } = await client
      .from("agent_skills")
      .select("skills(*)")
      .eq("agent_id", agentId)
      .eq("is_enabled", true)
      .eq("skills.is_active", true)
      .order("sort_order", { ascending: true });

    if (error) {
      console.error("[SkillRegistry] 查询技能失败:", error);
      // 查询失败时缓存空数组，避免反复重试
      setCache(agentId, []);
      return [];
    }

    // 提取 join 的 skills 记录，过滤掉 null（外键约束不应有 null，但防御性编程）
    const skills = (data || [])
      .map((row: AgentSkillRecord) => row.skills as SkillRecord | null)
      .filter((s: SkillRecord | null): s is SkillRecord => s != null && s.is_active);

    setCache(agentId, skills);
    return skills;
  } catch (err) {
    console.error("[SkillRegistry] 获取技能异常:", err);
    throw err;
  }
}

/**
 * 生成技能调度系统提示词
 *
 * 注入到 system prompt 末尾，告知 LLM 它有哪些技能、如何调度
 * 遵循用户定义的「LLM智能体通用技能调度协议」
 */
function generateSkillSystemPrompt(skills: SkillRecord[]): string {
  const skillEntries = skills.map((skill, i) => {
    const funcDef = skill.tool_definition.function;
    const paramsDesc = Object.entries(funcDef.parameters.properties)
      .map(([key, val]) => {
        const v = val as { type?: string; description?: string; enum?: string[] };
        let desc = v.description || key;
        if (v.enum) desc += `（可选值: ${v.enum.join("/")}）`;
        return `    - ${key}: ${desc}`;
      })
      .join("\n");

    return `[技能${i + 1}]
- 名称: ${funcDef.name}
- 能力: ${skill.description}
- 触发信号: ${skill.trigger_signals}
- 输入参数:
${paramsDesc}
- 调用方式: 工具调用 ${funcDef.name}(${funcDef.parameters.required?.join(", ") || ""})`;
  }).join("\n\n");

  return `

## 技能调度系统

你是一个具备多技能调度能力的智能体。你的核心职责是：理解用户意图，匹配并调度技能，整合结果，输出给用户。

### 技能注册表

${skillEntries}

### 调度规则

规则1 - 意图识别:
从用户输入中识别三要素：目标对象（分析谁）、动作意图（做什么）、约束条件（什么要求）。不要求用户按固定格式输入。信息不足时主动追问，不要猜测。

规则2 - 技能匹配:
根据意图信号匹配技能注册表中最合适的技能。单个需求可能涉及多个技能。无匹配技能时，用自身能力直接回答。

规则3 - 参数提取:
从自然语言中提取技能所需参数。缺省参数使用默认值。模糊表达做合理推断。

规则4 - 执行与协同:
- 单技能：直接调用，获取结果
- 多技能串联：前一个技能的输出作为后一个的输入
- 多技能并行：无依赖关系的技能可同时调用

规则5 - 结果处理:
技能返回的原始数据（如JSON）不直接展示给用户。你对数据进行理解、分析、整合，以用户能理解的方式输出最终结果。

规则6 - 多轮对话:
用户可基于上一轮结果继续追问。保持上下文连贯，不需要用户重复提供信息。已获取的数据在后续对话中直接复用，不需要重新调用技能。`;
}

/**
 * 为智能体生成技能注入内容
 *
 * 这是 LLM 路由调用的唯一入口：
 * - 输入：agentId
 * - 输出：{ skillPromptSuffix, tools } 或 null（无技能时）
 *
 * 零影响保证：
 * - 无技能 → 返回 null，调用方跳过所有技能逻辑
 * - 有技能 → 返回提示词 + tools，调用方追加即可
 */
export async function injectSkillsForAgent(
  agentId: string
): Promise<SkillInjectionResult | null> {
  const skills = await getSkillsForAgent(agentId);
  if (skills.length === 0) return null;

  // 生成系统提示词追加内容
  const skillPromptSuffix = generateSkillSystemPrompt(skills);

  // 生成 OpenAI Function Calling tools
  const tools = skills
    .filter((s) => s.tool_definition?.function)
    .map((s) => s.tool_definition);

  return {
    skillPromptSuffix,
    tools: tools.length > 0 ? tools : [],
  };
}
