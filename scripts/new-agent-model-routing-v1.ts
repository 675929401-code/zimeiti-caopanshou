import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const baseUrl = process.env.BASE_URL || process.env.LOCAL_NAV_ORIGIN || "http://127.0.0.1:5000";
const apply = process.argv.includes("--apply");

export type AgentModelProfile = {
  key: "claude_writing" | "gpt_reasoning";
  displayName: string;
  modelName: string;
  modelId: string;
  rationale: string;
};

export const CLAUDE_WRITING: AgentModelProfile = {
  key: "claude_writing",
  displayName: "claude-sonnet-4-6 渠道B",
  modelName: "claude-sonnet-4-6",
  modelId: "3a998bfc-aab4-4f8f-9128-b27498894a7b",
  rationale: "自然中文、情绪节奏、口语表达和成品文案是主要交付物",
};

export const GPT_REASONING: AgentModelProfile = {
  key: "gpt_reasoning",
  displayName: "GPT-5.6-Terra · 渠道A",
  modelName: "gpt-5.6-terra",
  modelId: "673aef26-e373-4876-ad0c-41041a5d35ae",
  rationale: "结构分析、事实约束、方案比较、流程编排或数据诊断是主要任务",
};

const CLAUDE_AGENT_NAMES = [
  "百事通",
  "爆单文案重构师",
  "爆款裂变选题",
  "爆款文案重构师",
  "宠物赛道口播策划助手",
  "带货营销助手",
  "抖音爆点钩子专家 v4.0",
  "泛流量选题师",
  "盖瓦小玲子智能体",
  "门店获客引擎",
  "命理星盘解码",
  "人群画像洞察",
  "赛道爆文嫁接师",
  "赛道爆文嫁接师2拆解版",
  "三维成交引擎",
  "实体号起盘师",
  "实体搜索霸屏",
  "文案质检专家",
  "象限选题军师",
  "心理学用户洞察",
  "知识爆款铸造",
  "SEO标题封面制作",
  "AI品牌铸造",
  "餐饮门店爆款编导",
  "服装门店种草编导",
  "建材装修获客编导",
  "小店零售引流编导",
  "美业门店获客编导",
  "汽车门店获客编导",
  "家政维修接单编导",
  "教培亲子招生编导",
  "酒店民宿获客编导",
  "宠物门店获客编导",
  "总分总文案师",
  "观点冲突文案师",
  "故事反转文案师",
  "场景共鸣文案师",
  "清单干货文案师",
  "顾客疑问回复助手",
  "账号主页优化助手",
  "网站功能推广师",
  "智能体命名包装师",
  "软植入带货编导",
  "千川投流文案师",
] as const;

const GPT_AGENT_NAMES = [
  "30天内容排期助手",
  "营销活动方案助手",
  "客户跟进流程助手",
  "营销方案对比助手",
  "经营数据复盘助手",
  "个人优势盘点助手",
  "对标账号差异分析",
  "专业信任素材助手",
  "产品与变现设计助手",
  "账号定位试跑助手",
  "课程架构优化师",
  "对标账号拆解",
  "IP定位策划师",
  "卖点证据提炼师",
] as const;

export const NEW_AGENT_MODEL_ROUTES: Readonly<Record<string, AgentModelProfile>> = Object.freeze({
  ...Object.fromEntries(CLAUDE_AGENT_NAMES.map((name) => [name, CLAUDE_WRITING])),
  ...Object.fromEntries(GPT_AGENT_NAMES.map((name) => [name, GPT_REASONING])),
});

export function getNewAgentModelProfile(agentName: string): AgentModelProfile {
  const profile = NEW_AGENT_MODEL_ROUTES[agentName];
  assert.ok(profile, `No model route declared for newly added agent: ${agentName}`);
  return profile;
}

type AdminModel = {
  id: string;
  name: string;
  model_name: string;
  is_active?: boolean;
};

type AdminAgent = {
  id: string;
  name: string;
  model?: string;
  model_id?: string;
  deleted_at?: string | null;
};

async function requestJson<T>(url: string, token: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init.body ? { "Content-Type": "application/json; charset=utf-8" } : {}),
      ...init.headers,
    },
  });
  const payload = await response.json().catch(() => ({})) as T & { error?: string };
  assert.ok(response.ok, payload.error || `${url} request failed (${response.status})`);
  return payload;
}

async function localSession(): Promise<{ token: string; user?: { id?: string } }> {
  const injectedToken = String(process.env.LOCAL_NAV_ADMIN_TOKEN || "").trim();
  if (injectedToken) {
    const identityResponse = await fetch(`${baseUrl}/api/auth/me`, {
      headers: { Authorization: `Bearer ${injectedToken}` },
      signal: AbortSignal.timeout(10_000),
    });
    const identity = await identityResponse.json() as { user?: { id?: string; role?: string }; error?: string };
    assert.ok(identityResponse.ok && identity.user?.role === "admin", identity.error || "verified local admin session unavailable");
    return { token: injectedToken, user: identity.user };
  }

  const sessionResponse = await fetch(`${baseUrl}/api/auth/dev-session`, {
    headers: { "x-local-workbench": "ai-creation-studio-local" },
  });
  const session = await sessionResponse.json() as { token?: string; error?: string; user?: { id?: string } };
  assert.ok(sessionResponse.ok && session.token, session.error || "local admin session unavailable");
  return { token: session.token, user: session.user };
}

export async function main() {
  const session = await localSession();
  const token = session.token;

  const [modelsPayload, agentsPayload] = await Promise.all([
    requestJson<{ models: AdminModel[] }>(`${baseUrl}/api/admin/models`, token),
    requestJson<{ agents: AdminAgent[] }>(`${baseUrl}/api/admin/agents`, token),
  ]);
  const models = modelsPayload.models.filter((model) => model.is_active !== false);
  const agents = agentsPayload.agents.filter((agent) => !agent.deleted_at);
  const profileModels = new Map<string, AdminModel>();
  for (const profile of [CLAUDE_WRITING, GPT_REASONING]) {
    const model = models.find((item) => item.name === profile.displayName && item.model_name === profile.modelName);
    assert.ok(model, `Configured model is unavailable: ${profile.displayName}`);
    assert.equal(model.id, profile.modelId, `${profile.displayName} model id changed; review routing before applying`);
    profileModels.set(profile.key, model);
  }

  const missingAgents: string[] = [];
  const changes: Array<{
    agentId: string;
    agentName: string;
    profile: string;
    rationale: string;
    from: { model?: string; model_id?: string };
    to: { model: string; model_id: string };
  }> = [];
  const unchanged: string[] = [];

  for (const [agentName, profile] of Object.entries(NEW_AGENT_MODEL_ROUTES)) {
    const agent = agents.find((item) => item.name === agentName);
    if (!agent) {
      missingAgents.push(agentName);
      continue;
    }
    const model = profileModels.get(profile.key)!;
    if (agent.model === model.model_name && agent.model_id === model.id) {
      unchanged.push(agentName);
      continue;
    }
    changes.push({
      agentId: agent.id,
      agentName,
      profile: profile.key,
      rationale: profile.rationale,
      from: { model: agent.model, model_id: agent.model_id },
      to: { model: model.model_name, model_id: model.id },
    });
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "");
  const outDir = path.join("research-output", `new-agent-model-routing-v1-${stamp}`);
  await mkdir(outDir, { recursive: true });
  const report = {
    created_at: new Date().toISOString(),
    mode: apply ? "apply" : "dry-run",
    no_fallback_policy: true,
    scope: Object.keys(NEW_AGENT_MODEL_ROUTES),
    changes,
    unchanged,
    missingAgents,
  };
  await writeFile(path.join(outDir, "routing-report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");

  console.log(`Mode: ${report.mode}`);
  console.log(`Target agents: ${report.scope.length}`);
  console.log(`Changes: ${changes.length}; unchanged: ${unchanged.length}; missing: ${missingAgents.length}`);
  for (const item of changes) {
    console.log(`- ${item.agentName}: ${item.from.model || "unset"} -> ${item.to.model} (${item.profile})`);
  }
  if (missingAgents.length) console.log(`Missing: ${missingAgents.join("、")}`);
  console.log(`Report: ${outDir}`);

  if (!apply) return;

  const backupDir = path.join("backups", `new-agent-model-routing-v1-${stamp}`);
  await mkdir(backupDir, { recursive: true });
  await writeFile(path.join(backupDir, "before.json"), `${JSON.stringify({
    created_at: new Date().toISOString(),
    agents: agents.filter((agent) => Object.hasOwn(NEW_AGENT_MODEL_ROUTES, agent.name)),
  }, null, 2)}\n`, "utf8");

  for (const item of changes) {
    await requestJson(`${baseUrl}/api/admin/agents`, token, {
      method: "PUT",
      body: JSON.stringify({ agentId: item.agentId, model: item.to.model, model_id: item.to.model_id }),
    });
  }

  const afterPayload = await requestJson<{ agents: AdminAgent[] }>(`${baseUrl}/api/admin/agents`, token);
  for (const [agentName, profile] of Object.entries(NEW_AGENT_MODEL_ROUTES)) {
    const agent = afterPayload.agents.find((item) => item.name === agentName && !item.deleted_at);
    if (!agent) continue;
    const expected = profileModels.get(profile.key)!;
    assert.equal(agent.model, expected.model_name, `${agentName} model mismatch after update`);
    assert.equal(agent.model_id, expected.id, `${agentName} model_id mismatch after update`);
  }
  await writeFile(path.join(outDir, "verified.json"), `${JSON.stringify({
    verified_at: new Date().toISOString(),
    verified_agents: Object.keys(NEW_AGENT_MODEL_ROUTES).length - missingAgents.length,
    missingAgents,
    no_fallback_policy: true,
  }, null, 2)}\n`, "utf8");
  console.log(`Applied and verified ${changes.length} model assignments.`);
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("/new-agent-model-routing-v1.ts")) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack || error.message : error);
    process.exitCode = 1;
  });
}
