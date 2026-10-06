import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

// 检测单个coze_coding智能体（使用stream_run格式，与/api/chat/coding一致）
async function checkCozeCodingAgent(
  agent: { id: string; name: string; coze_coding_api_url: string; coze_coding_api_token: string; coze_coding_project_id: string },
  timeout = 30000
): Promise<{ id: string; name: string; status: "ok" | "fail" | "timeout"; latency: number; error?: string; reply?: string }> {
  const start = Date.now();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    // 使用与/api/chat/coding完全相同的stream_run格式
    const apiBaseUrl = agent.coze_coding_api_url.replace(/\/stream_run$/, "");
    const streamRunUrl = `${apiBaseUrl}/stream_run`;
    const sessionId = `hc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    const res = await fetch(streamRunUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${agent.coze_coding_api_token}`,
        Accept: "text/event-stream",
      },
      body: JSON.stringify({
        content: {
          query: {
            prompt: [
              {
                type: "text",
                content: {
                  text: "你好，请用一句话介绍你的功能",
                },
              },
            ],
          },
        },
        type: "query",
        session_id: sessionId,
        project_id: Number(agent.coze_coding_project_id),
      }),
      signal: controller.signal,
    });

    clearTimeout(timer);
    const latency = Date.now() - start;

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { id: agent.id, name: agent.name, status: "fail", latency, error: `HTTP ${res.status}: ${body.substring(0, 80)}` };
    }

    const text = await res.text();
    // 解析SSE流 - Coze Coding stream_run格式
    let fullContent = "";
    let hasMessageEnd = false;
    let hasContent = false;

    for (const line of text.split("\n")) {
      if (line.startsWith("data: ")) {
        try {
          const d = JSON.parse(line.substring(6));
          // type=answer → content是对象，文字在content.answer中（增量片段）
          if (d.type === "answer" && d.content) {
            const answerText = typeof d.content === "string" ? d.content : (d.content.answer || "");
            fullContent += answerText;
            if (answerText) hasContent = true;
          }
          // type=content → 另一种格式
          if (d.type === "content" && d.content) {
            const contentText = typeof d.content === "string" ? d.content : (d.content.answer || d.content.text || "");
            fullContent += contentText;
            if (contentText) hasContent = true;
          }
          // 结束标记
          if (d.type === "message_end" || d.finish === true) {
            hasMessageEnd = true;
            if (d.content?.answer) {
              fullContent = d.content.answer;
              hasContent = true;
            }
          }
          // 错误事件
          if (d.type === "error" || d.error) {
            return { id: agent.id, name: agent.name, status: "fail", latency, error: d.error?.message || d.msg || "智能体返回错误" };
          }
        } catch {
          // skip malformed JSON
        }
      }
    }

    if (!hasMessageEnd) {
      return { id: agent.id, name: agent.name, status: "fail", latency, error: "未收到完整响应（可能超时或Coze平台异常）" };
    }

    if (!hasContent || !fullContent.trim()) {
      return { id: agent.id, name: agent.name, status: "fail", latency, error: "智能体返回空内容（Coze平台侧可能配置有误）" };
    }

    return {
      id: agent.id,
      name: agent.name,
      status: "ok",
      latency,
      reply: fullContent.trim().substring(0, 100),
    };
  } catch (err: unknown) {
    const latency = Date.now() - start;
    if (err instanceof Error && err.name === "AbortError") {
      return { id: agent.id, name: agent.name, status: "timeout", latency, error: `超时（${timeout / 1000}秒）` };
    }
    return { id: agent.id, name: agent.name, status: "fail", latency, error: (err as Error).message?.substring(0, 100) };
  }
}

// 检测Coze平台智能体
async function checkCozeAgent(
  agent: { id: string; name: string; bot_id: string },
  cozeConfig: { apiUrl: string; apiToken: string; workspaceId: string },
  timeout = 15000
): Promise<{ id: string; name: string; status: "ok" | "fail" | "timeout"; latency: number; error?: string; reply?: string }> {
  const start = Date.now();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    const res = await fetch(`${cozeConfig.apiUrl}/v1/bots/${agent.bot_id}`, {
      headers: {
        Authorization: `Bearer ${cozeConfig.apiToken}`,
        "Content-Type": "application/json",
      },
      signal: controller.signal,
    });

    clearTimeout(timer);
    const latency = Date.now() - start;

    if (res.status === 404) {
      return { id: agent.id, name: agent.name, status: "fail", latency, error: "Bot不存在（404）" };
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { id: agent.id, name: agent.name, status: "fail", latency, error: `HTTP ${res.status}: ${body.substring(0, 80)}` };
    }

    return { id: agent.id, name: agent.name, status: "ok", latency, reply: "Bot配置验证通过" };
  } catch (err: unknown) {
    const latency = Date.now() - start;
    if (err instanceof Error && err.name === "AbortError") {
      return { id: agent.id, name: agent.name, status: "timeout", latency, error: `超时（${timeout / 1000}秒）` };
    }
    return { id: agent.id, name: agent.name, status: "fail", latency, error: (err as Error).message?.substring(0, 100) };
  }
}

// 检测LLM智能体
async function checkLLMAgent(
  agent: { id: string; name: string; system_prompt?: string; proxy_url?: string; coze_coding_api_token?: string; model?: string },
  llmConfig: { apiUrl: string; apiKey: string; model: string },
  timeout = 15000
): Promise<{ id: string; name: string; status: "ok" | "fail" | "timeout"; latency: number; error?: string; reply?: string }> {
  const start = Date.now();
  try {
    // 优先使用per-agent配置，回退到全局配置
    const apiUrl = agent.proxy_url || llmConfig.apiUrl;
    const apiKey = agent.coze_coding_api_token || llmConfig.apiKey;
    const model = agent.model || llmConfig.model;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    // 防止 /v1 双重拼接：如果 apiUrl 已包含 /v1 或 /v4 等版本路径，不再重复追加
    const normalizedApiUrl = apiUrl.replace(/\/+$/, "");
    const chatUrl = /\/v\d+$/.test(normalizedApiUrl)
      ? `${normalizedApiUrl}/chat/completions`
      : `${normalizedApiUrl}/v1/chat/completions`;
    const res = await fetch(chatUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: agent.system_prompt || "你是一个有用的AI助手" },
          { role: "user", content: "你好，请用一句话介绍你的功能" },
        ],
        max_tokens: 100,
        stream: false,
      }),
      signal: controller.signal,
    });

    clearTimeout(timer);
    const latency = Date.now() - start;

    // 429 表示密钥有效，仅频率超限，视为连接成功
    if (res.status === 429) {
      return { id: agent.id, name: agent.name, status: "ok", latency, reply: "密钥有效（API频率超限）" };
    }

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      let errorDetail = `HTTP ${res.status}`;
      if (res.status === 401 || res.status === 403) errorDetail = "API密钥无效或已过期";
      else if (res.status === 404) errorDetail = `模型 ${llmConfig.model} 不存在或API地址不正确`;
      else if (body) errorDetail += `: ${body.substring(0, 80)}`;
      return { id: agent.id, name: agent.name, status: "fail", latency, error: errorDetail };
    }

    const data = await res.json();
    const reply = data.choices?.[0]?.message?.content || "";

    if (!reply.trim()) {
      return { id: agent.id, name: agent.name, status: "fail", latency, error: "LLM返回空内容" };
    }

    return { id: agent.id, name: agent.name, status: "ok", latency, reply: reply.trim().substring(0, 100) };
  } catch (err: unknown) {
    const latency = Date.now() - start;
    if (err instanceof Error && err.name === "AbortError") {
      return { id: agent.id, name: agent.name, status: "timeout", latency, error: `超时（${timeout / 1000}秒）` };
    }
    return { id: agent.id, name: agent.name, status: "fail", latency, error: (err as Error).message?.substring(0, 100) };
  }
}

export async function POST(request: NextRequest) {
  try {
    // 验证管理员
    const authHeader = request.headers.get("authorization");
    if (!authHeader) {
      return NextResponse.json({ error: "请先登录" }, { status: 401 });
    }

    const { verifyAdminToken } = await import("@/lib/admin-auth");
    const payload = await verifyAdminToken(authHeader.replace("Bearer ", ""));
    if (!payload || payload.role !== "admin") {
      return NextResponse.json({ error: "需要管理员权限" }, { status: 403 });
    }

    // 从数据库获取所有活跃智能体
    const supabase = createClient(
      process.env.COZE_SUPABASE_URL!,
      process.env.COZE_SUPABASE_SERVICE_ROLE_KEY!
    );

    const { data: agents, error: agentsError } = await supabase
      .from("agents")
      .select("id, name, source, coze_coding_api_url, coze_coding_api_token, coze_coding_project_id, bot_id, system_prompt, proxy_url, model")
      .eq("is_active", true);

    if (agentsError) {
      return NextResponse.json({ error: "获取智能体列表失败" }, { status: 500 });
    }

    if (!agents || agents.length === 0) {
      return NextResponse.json({ results: [], summary: { total: 0, ok: 0, fail: 0, timeout: 0 } });
    }

    // 获取平台设置（Coze API配置）
    const { data: settings } = await supabase.from("platform_settings").select("*").limit(1).single();
    const cozeApiUrl = settings?.coze_api_base_url || process.env.COZE_API_BASE_URL || "https://api.coze.cn";
    const cozeApiToken = settings?.coze_api_token || process.env.COZE_WORKLOAD_API_TOKEN || "";
    const cozeWorkspaceId = settings?.coze_workspace_id || process.env.COZE_PROJECT_SPACE_ID || "";

    // LLM配置
    const llmApiUrl = process.env.LLM_API_BASE_URL || "";
    const llmApiKey = process.env.LLM_API_KEY || "";
    const llmModel = process.env.LLM_DEFAULT_MODEL || "deepseek-v4-flash";

    // 并行检测所有智能体（最多3个并发，避免Coze平台限流）
    const results: Array<{
      id: string;
      name: string;
      source: string;
      status: "ok" | "fail" | "timeout";
      latency: number;
      error?: string;
      reply?: string;
    }> = [];

    const batchSize = 3;
    for (let i = 0; i < agents.length; i += batchSize) {
      const batch = agents.slice(i, i + batchSize);
      const batchResults = await Promise.all(
        batch.map(async (agent) => {
          if (agent.source === "coze_coding") {
            if (!agent.coze_coding_api_url || !agent.coze_coding_api_token || !agent.coze_coding_project_id) {
              return { id: agent.id, name: agent.name, source: agent.source, status: "fail" as const, latency: 0, error: "缺少编程API配置" };
            }
            const r = await checkCozeCodingAgent(agent);
            return { ...r, source: agent.source };
          } else if (agent.source === "coze") {
            if (!agent.bot_id) {
              return { id: agent.id, name: agent.name, source: agent.source, status: "fail" as const, latency: 0, error: "缺少Bot ID" };
            }
            if (!cozeApiToken) {
              return { id: agent.id, name: agent.name, source: agent.source, status: "fail" as const, latency: 0, error: "Coze API Token未配置" };
            }
            const r = await checkCozeAgent(agent, { apiUrl: cozeApiUrl, apiToken: cozeApiToken, workspaceId: cozeWorkspaceId });
            return { ...r, source: agent.source };
          } else if (agent.source === "llm") {
            const apiUrl = agent.proxy_url || llmApiUrl;
            const apiKey = agent.coze_coding_api_token || llmApiKey;
            const model = agent.model || llmModel;
            if (!apiUrl || !apiKey) {
              return { id: agent.id, name: agent.name, source: agent.source, status: "fail" as const, latency: 0, error: "LLM API未配置" };
            }
            const r = await checkLLMAgent(agent, { apiUrl, apiKey, model });
            return { ...r, source: agent.source };
          }
          return { id: agent.id, name: agent.name, source: agent.source, status: "fail" as const, latency: 0, error: "未知智能体类型" };
        })
      );
      results.push(...batchResults);
    }

    const summary = {
      total: results.length,
      ok: results.filter((r) => r.status === "ok").length,
      fail: results.filter((r) => r.status === "fail").length,
      timeout: results.filter((r) => r.status === "timeout").length,
    };

    return NextResponse.json({ results, summary });
  } catch (err) {
    console.error("Health check error:", err);
    return NextResponse.json({ error: "检测失败" }, { status: 500 });
  }
}
