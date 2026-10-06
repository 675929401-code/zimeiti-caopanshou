/**
 * 技能执行器 — 独立模块
 *
 * 职责：
 * 1. 接收 LLM 的 tool_call，找到对应的技能
 * 2. 按技能类型执行（coze_workflow / api_call / built_in）
 * 3. 返回结构化结果供 LLM 整合
 *
 * 隔离原则：
 * - 不依赖任何现有模块的内部实现
 * - 每种技能类型独立处理函数
 * - 错误隔离：单个技能执行失败不影响其他技能
 * - 超时保护：所有执行都有超时限制
 */

import { getSkillsForAgent, type SkillRecord } from "./skill-registry";
import { importDouyinBrowserCapture } from "./douyin-browser-capture";
import { collectDouyinPublicBenchmark } from "./douyin-public-benchmark";

// ── 类型定义 ──

export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string; // JSON string
  };
}

export interface ToolResult {
  tool_call_id: string;
  role: "tool";
  content: string;
  /** 是否执行成功 */
  success: boolean;
  /** 执行耗时(ms) */
  duration_ms: number;
}

// ── 技能执行器 ──

/**
 * 批量执行 tool_calls
 *
 * 流程：
 * 1. 从缓存获取智能体的技能列表
 * 2. 按 tool_call 的 name 匹配技能
 * 3. 并行执行所有匹配的技能
 * 4. 返回结果数组（可直接追加到 LLM messages）
 */
export async function executeToolCalls(
  agentId: string,
  toolCalls: ToolCall[]
): Promise<ToolResult[]> {
  if (!toolCalls || toolCalls.length === 0) return [];

  const skills = await getSkillsForAgent(agentId);
  if (skills.length === 0) {
    // 没有注册技能却收到 tool_call → 返回错误
    return toolCalls.map((tc) => ({
      tool_call_id: tc.id,
      role: "tool" as const,
      content: JSON.stringify({ error: "该智能体未注册任何技能" }),
      success: false,
      duration_ms: 0,
    }));
  }

  // 构建 name → skill 映射
  const skillMap = new Map<string, SkillRecord>();
  for (const skill of skills) {
    const funcName = skill.tool_definition?.function?.name;
    if (funcName) skillMap.set(funcName, skill);
  }

  // 并行执行所有 tool_calls
  const results = await Promise.all(
    toolCalls.map(async (tc) => {
      const skill = skillMap.get(tc.function.name);
      if (!skill) {
        return {
          tool_call_id: tc.id,
          role: "tool" as const,
          content: JSON.stringify({ error: `未知技能: ${tc.function.name}` }),
          success: false,
          duration_ms: 0,
        };
      }

      // 解析参数
      let args: Record<string, unknown>;
      try {
        args = JSON.parse(tc.function.arguments);
      } catch {
        return {
          tool_call_id: tc.id,
          role: "tool" as const,
          content: JSON.stringify({ error: `参数解析失败: ${tc.function.arguments}` }),
          success: false,
          duration_ms: 0,
        };
      }

      // 按技能类型执行
      const startTime = Date.now();
      try {
        const result = await executeSkillByType(skill, args);
        const duration = Date.now() - startTime;
        return {
          tool_call_id: tc.id,
          role: "tool" as const,
          content: typeof result === "string" ? result : JSON.stringify(result),
          success: true,
          duration_ms: duration,
        };
      } catch (err) {
        const duration = Date.now() - startTime;
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error(`[SkillExecutor] 技能 ${skill.name} 执行失败:`, errMsg);
        return {
          tool_call_id: tc.id,
          role: "tool" as const,
          content: JSON.stringify({ error: getSkillErrorMessage(skill.name, errMsg) }),
          success: false,
          duration_ms: duration,
        };
      }
    })
  );

  return results;
}

// ── 按类型执行 ──

async function executeSkillByType(
  skill: SkillRecord,
  args: Record<string, unknown>
): Promise<unknown> {
  switch (skill.skill_type) {
    case "coze_workflow":
      return executeCozeWorkflow(skill, args);
    case "api_call":
      return executeApiCall(skill, args);
    case "built_in":
      return executeBuiltIn(skill, args);
    default:
      throw new Error(`不支持的技能类型: ${skill.skill_type}`);
  }
}

/**
 * 应用参数映射：将 tool_definition 的参数名映射为 Workflow 期望的参数名
 * 
 * 示例 config.param_mapping: { "input_text": "input_url" }
 * 表示将 LLM 传来的 input_text 映射为 input_url 发送给 Workflow
 */
function applyParamMapping(
  args: Record<string, unknown>,
  config: Record<string, unknown>
): Record<string, unknown> {
  const mapping = config.param_mapping as Record<string, string> | undefined;
  if (!mapping || Object.keys(mapping).length === 0) return args;

  const mapped: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    const targetKey = mapping[key] || key;
    mapped[targetKey] = value;
  }
  return mapped;
}

/**
 * 执行 Coze Workflow 技能
 *
 * 调用 Coze Workflow API（run 模式），传入参数，返回结果
 * 支持 sync 和 stream_run 两种模式
 * 
 * 配置项：
 * - param_format: "parameters"（默认，Coze 标准格式）或 "direct"（参数直接发送）
 * - param_mapping: 参数名映射，如 { "input_text": "input_url" }
 */
async function executeCozeWorkflow(
  skill: SkillRecord,
  args: Record<string, unknown>
): Promise<unknown> {
  const config = skill.config;
  const apiUrl = config.api_base_url as string;
  const apiToken = config.api_token as string;
  const timeoutMs = (config.timeout_ms as number) || 60000;
  const runMode = (config.run_mode as string) || "sync";
  const paramFormat = (config.param_format as string) || "parameters";

  if (!apiUrl || !apiToken) {
    throw new Error("技能配置缺少 api_base_url 或 api_token");
  }

  // 应用参数映射
  const mappedArgs = applyParamMapping(args, config);

  console.log(`[SkillExecutor] 调用 Coze Workflow: ${skill.name}, mode=${runMode}, paramFormat=${paramFormat}`);
  console.log(`[SkillExecutor] 原始参数:`, JSON.stringify(args));
  console.log(`[SkillExecutor] 映射后参数:`, JSON.stringify(mappedArgs));

  // 构建请求体
  // param_format="parameters": Coze 标准格式 { parameters: { key1: val1 } }
  // param_format="direct": 参数直接发送 { key1: val1 }
  const requestBody = paramFormat === "direct" ? mappedArgs : { parameters: mappedArgs };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiToken}`,
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      throw new Error(`Coze API 返回 ${response.status}: ${errText.slice(0, 300)}`);
    }

    // Coze Workflow 的 run 模式返回 JSON
    // stream_run 模式返回 SSE，这里先处理 run 模式
    if (runMode === "stream_run") {
      // stream_run 模式：读取 SSE 流，提取最终结果
      return await parseCozeStreamRun(response);
    }

    // sync run 模式：直接返回 JSON
    const result = await response.json();
    console.log(`[SkillExecutor] Coze Workflow ${skill.name} 执行成功, 返回键: ${Object.keys(result).join(',')}`);

    // Coze run API 返回格式: { data: "..." } 或 { output: "..." }
    // 也可能是自定义格式，如 { final_transcript: "..." }
    let extractedValue: unknown;
    if (result.data !== undefined) extractedValue = result.data;
    else if (result.output !== undefined) extractedValue = result.output;
    else if (result.final_transcript !== undefined) extractedValue = result.final_transcript;
    else if (result.formatted_output !== undefined) extractedValue = result.formatted_output;
    else extractedValue = result;

    // ★ 降级检测：如果文案提取工作流 ASR 失败，降级返回了视频描述（标题+标签）
    //   此时不应作为有效结果返回，应抛出错误让 LLM 告知用户
    if (typeof extractedValue === "string" && 
        (extractedValue.includes("语音识别未成功") || extractedValue.includes("以下为视频描述"))) {
      console.warn(`[SkillExecutor] Coze Workflow ${skill.name} ASR失败(降级返回视频描述)，视为提取失败`);
      throw new Error("语音识别未成功，无法提取口播文案。请稍后重试或尝试其他视频链接。");
    }

    return extractedValue;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * 解析 Coze stream_run SSE 响应
 */
async function parseCozeStreamRun(response: Response): Promise<unknown> {
  const text = await response.text();
  // 解析 SSE 事件，找到最终结果
  const lines = text.split("\n");
  let lastData = "";
  for (const line of lines) {
    if (line.startsWith("data:")) {
      const data = line.slice(5).trim();
      if (data && data !== "[DONE]") {
        try {
          const parsed = JSON.parse(data);
          // stream_run 完成事件包含 output
          if (parsed.output !== undefined) return parsed.output;
          if (parsed.data !== undefined) lastData = typeof parsed.data === "string" ? parsed.data : JSON.stringify(parsed.data);
          if (parsed.content !== undefined) lastData = parsed.content;
        } catch {
          // 非 JSON 数据，作为文本保存
          lastData = data;
        }
      }
    }
  }
  return lastData || text;
}

/**
 * 执行通用 API 调用技能
 */
async function executeApiCall(
  skill: SkillRecord,
  args: Record<string, unknown>
): Promise<unknown> {
  const config = skill.config;
  const apiUrl = config.api_base_url as string || config.api_url as string;
  const method = (config.method as string) || "POST";
  const headers = (config.headers as Record<string, string>) || {};
  const timeoutMs = (config.timeout_ms as number) || 30000;

  if (!apiUrl) {
    throw new Error("技能配置缺少 api_base_url");
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(apiUrl, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...headers,
      },
      body: method !== "GET" ? JSON.stringify(args) : undefined,
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`API 返回 ${response.status}`);
    }

    return await response.json();
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * 执行内置技能
 * 内置技能直接在代码中实现，不调用外部 API
 */
async function executeBuiltIn(
  skill: SkillRecord,
  args: Record<string, unknown>
): Promise<unknown> {
  // 内置技能根据 name 分发
  switch (skill.name) {
    case "douyin_public_benchmark_collector": {
      const capturePackage = String(args.capture_package || args.browser_capture || "").trim();
      const sampleLimit = Number(args.sample_limit || 20);
      if (capturePackage) {
        return importDouyinBrowserCapture(capturePackage, sampleLimit);
      }
      const url = String(args.url || args.share_url || "").trim();
      if (!url) throw new Error("缺少抖音主页链接或浏览器采集包");
      return collectDouyinPublicBenchmark(url, sampleLimit);
    }
    default:
      throw new Error(`未知内置技能: ${skill.name}`);
  }
}

// ── 错误消息人性化 ──

function getSkillErrorMessage(skillName: string, errMsg: string): string {
  if (errMsg.includes("abort") || errMsg.includes("timeout") || errMsg.includes("Timeout")) {
    return "数据获取超时，请稍后重试";
  }
  if (errMsg.includes("401") || errMsg.includes("403")) {
    return "技能鉴权失败，请联系管理员";
  }
  if (errMsg.includes("404")) {
    return "未找到指定资源，请检查链接是否正确";
  }
  if (errMsg.includes("429")) {
    return "请求过于频繁，请稍后重试";
  }
  if (errMsg.includes("500") || errMsg.includes("502") || errMsg.includes("503")) {
    return "数据服务暂时不可用，请稍后重试";
  }
  return `数据获取失败，请检查输入或稍后重试（${errMsg.slice(0, 50)}）`;
}
