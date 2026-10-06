import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { NEW_AGENT_MODEL_ROUTES } from "./new-agent-model-routing-v1";

const baseUrl = process.env.BASE_URL || "http://127.0.0.1:5000";
const apply = process.argv.includes("--apply");

type CardField = {
  id: string;
  label?: string;
  placeholder?: string;
  description?: string;
  options?: string[];
  [key: string]: unknown;
};

type AdminAgent = {
  id: string;
  name: string;
  description?: string;
  guide_message?: string;
  preset_fields?: CardField[];
  deleted_at?: string | null;
};

const TEXT_REPLACEMENTS: ReadonlyArray<readonly [string, string]> = [
  ["例如：贵州做陶瓷瓦施工的老板；成都通勤女装店主；宠物营养科普博主", "例如：餐饮店老板、女装店主、宠物知识博主"],
  ["选填，例如：准备翻修农村自建房的业主", "选填，例如：准备装修的业主、附近上班族、新手养宠人"],
  ["例如：10年农村自建房陶瓷瓦施工者，帮贵州业主看懂选瓦与施工", "例如：做了10年门窗安装，专门帮业主避开选购和施工误区"],
  ["你的领域和身份", "你是做什么的"],
  ["主题/原始素材", "你想讲什么"],
  ["想写给谁看", "主要给谁看"],
  ["创作方式", "你想怎么写"],
  ["原始内容/参考文案/旧稿", "把现有内容发来"],
  ["发布平台", "准备发到哪里"],
  ["这条最想得到什么", "最想让这条内容带来什么"],
  ["门店与顾客", "你的店和顾客"],
  ["可用证据/价格/限制", "能用的资料和限制"],
  ["账号定位/赛道", "账号主要讲什么"],
  ["赛道/品类", "你做的行业或内容方向"],
  ["填写你的赛道、经历和商业方向", "说说你做的行业、经历和想实现的目标"],
  ["受众与核心问题", "顾客遇到的问题"],
  ["受众与业务", "顾客和业务"],
  ["受众", "顾客"],
  ["可核验表现", "看得到的数据"],
  ["可核验", "能确认"],
  ["常见异议", "常见疑问"],
  ["当前承接方式", "现在怎么接待顾客"],
  ["自然承接", "自然引导顾客下一步行动"],
  ["承接咨询", "获得咨询"],
  ["咨询留资", "让顾客咨询"],
  ["真实权益", "真实优惠和使用条件"],
  ["权益", "优惠和条件"],
  ["CTA", "结尾引导"],
  ["对比基线", "原来的数据"],
  ["没有基线", "没有原来的数据"],
  ["复盘", "回看效果"],
  ["高转化", "更容易促成行动"],
  ["偏转化", "更重成交"],
  ["价格/优惠/机制", "价格、优惠和活动规则"],
  ["选择本条素材承接的动作", "选择看完后最希望顾客做什么"],
  ["商业承接弱", "不容易带来生意"],
  ["变现路径", "赚钱方式"],
  ["核心定位", "一句话介绍你是谁"],
  ["本人特点与真实经历", "你的特点和真实经历"],
  ["偏好与禁区", "喜欢和不想要的风格"],
  ["目标用户", "想吸引的人"],
  ["引流文案", "吸引顾客的文案"],
  ["当前版本与表现", "现在怎么做，效果怎样"],
  ["可测试素材/方案", "准备对比的内容"],
  ["流量与测试周期", "有多少数据，准备测多久"],
  ["日均线索", "每天大约有多少人咨询"],
  ["线索来源", "顾客从哪里来"],
  ["有效线索", "真正有需求的顾客"],
  ["产品/服务与价格", "你卖什么，多少钱"],
  ["可用证据", "能证明的资料"],
  ["承诺边界", "哪些话不能保证"],
  ["经历与做过的事", "你以前做过什么"],
  ["技能与现有资源", "你会什么，手里有什么"],
  ["已有证明", "能证明你做过的资料"],
  ["目标与限制", "想达到什么，还有哪些限制"],
  ["候选定位", "准备尝试的账号方向"],
  ["账号阶段与现有数据", "账号现在的数据"],
  ["可投入资源", "每周能投入什么"],
  ["优先验证", "这次最想先看什么"],
  ["定位与业务", "你是谁，卖什么"],
  ["现有证据", "手里有哪些证明"],
  ["行业风险", "你做的行业类型"],
  ["可拍条件与限制", "哪些能拍，哪些不能拍"],
  ["对标账号/内容", "想参考的账号或内容"],
  ["本次重点", "这次主要想看什么"],
  ["现有产品/服务", "现在卖什么"],
  ["能稳定交付什么", "你能稳定做好什么"],
  ["主要目标", "最想实现什么"],
  ["本月经营目标", "这个月最想做到什么"],
  ["业务与主要顾客", "你卖什么，主要顾客是谁"],
  ["业务与目标顾客", "你卖什么，主要顾客是谁"],
  ["现有素材与栏目", "手里有哪些内容"],
  ["更新能力", "每周能发多少"],
  ["节点与限制", "重要日期和限制"],
  ["活动目标", "这次活动想达到什么"],
  ["产品与真实优惠和使用条件", "卖什么，有什么真实优惠"],
  ["目标顾客与场景", "想吸引谁，什么时候会需要"],
  ["时间与渠道", "什么时候做，发到哪里"],
  ["预算、资源与限制", "预算、人员和限制"],
  ["本周期目标", "这段时间原本想做到什么"],
  ["实际数据", "最后做出了多少"],
  ["做过的动作与异常", "这段时间做了什么，有什么特殊情况"],
  ["下周期限制", "接下来有哪些限制"],
  ["人员与工具", "谁来做，用什么记录"],
  ["隐私与禁区", "哪些信息不能收，哪些话不能说"],
];

const EXACT_OPTIONS: Readonly<Record<string, string>> = Object.freeze({
  "A 我有想表达的内容": "A 我有想说的内容",
  "D 我有现场素材/故事": "D 我有现场经历或素材",
  "F 我只知道顾客问题": "F 我只知道顾客在问什么",
  "同城到店": "吸引附近顾客到店",
  "团购成交": "促进团购成交",
  "老板人设": "让大家认识老板",
  "专业信任": "让顾客更信任",
  "B 先给4个写作角度": "B 先给我4个方向",
  "C 先拆素材再写": "C 先帮我理清素材",
  "D 不确定，帮我判断": "D 我不确定，帮我选",
  "找差异化定位": "找到自己的不同",
  "找内容结构": "学习内容怎么写",
  "找主页包装": "优化账号主页",
  "找商业机会": "寻找赚钱机会",
  "私信咨询": "让顾客私信咨询",
  "多层产品组合": "设计不同价位的产品",
  "全链路验证": "从内容到成交都试一遍",
  "冷流量": "冷流量（还不了解产品的人）",
  "暖流量": "暖流量（已经看过内容的人）",
  "重定向": "再次触达（已经咨询或访问过的人）",
});

export function simplifyNewAgentText(value: string | undefined): string {
  let next = value || "";
  for (const [from, to] of TEXT_REPLACEMENTS) next = next.replaceAll(from, to);
  return next;
}

export function simplifyNewAgentCardFields(fields: CardField[] | undefined): CardField[] {
  return (fields || []).map((field) => ({
    ...field,
    label: simplifyNewAgentText(field.label),
    placeholder: simplifyNewAgentText(field.placeholder),
    description: field.description ? simplifyNewAgentText(field.description) : field.description,
    options: (field.options || []).map((option) => EXACT_OPTIONS[option] || simplifyNewAgentText(option)),
  }));
}

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

function changedCard(agent: AdminAgent) {
  return {
    description: simplifyNewAgentText(agent.description),
    guide_message: simplifyNewAgentText(agent.guide_message),
    preset_fields: simplifyNewAgentCardFields(agent.preset_fields),
  };
}

async function main() {
  const sessionResponse = await fetch(`${baseUrl}/api/auth/dev-session`, {
    headers: { "x-local-workbench": "ai-creation-studio-local" },
  });
  const session = await sessionResponse.json() as { token?: string; error?: string };
  assert.ok(sessionResponse.ok && session.token, session.error || "local admin session unavailable");
  const token = session.token;
  const beforePayload = await requestJson<{ agents: AdminAgent[] }>(`${baseUrl}/api/admin/agents`, token);
  const scope = new Set(Object.keys(NEW_AGENT_MODEL_ROUTES));
  const agents = beforePayload.agents.filter((agent) => scope.has(agent.name) && !agent.deleted_at);
  assert.equal(agents.length, scope.size, "new agent card scope is incomplete");

  const updates = agents.map((agent) => {
    const next = changedCard(agent);
    const changed = JSON.stringify({
      description: agent.description || "",
      guide_message: agent.guide_message || "",
      preset_fields: agent.preset_fields || [],
    }) !== JSON.stringify(next);
    return { agent, next, changed };
  }).filter((item) => item.changed);

  const stamp = new Date().toISOString().replace(/[:.]/g, "");
  const outDir = path.join("research-output", `simplify-new-agent-cards-v1-${stamp}`);
  await mkdir(outDir, { recursive: true });
  await writeFile(path.join(outDir, "report.json"), `${JSON.stringify({
    created_at: new Date().toISOString(),
    mode: apply ? "apply" : "dry-run",
    total_agents: agents.length,
    changed_agents: updates.map((item) => item.agent.name),
    rules: {
      location_neutral_examples: true,
      plain_language_labels: true,
      plain_language_options: true,
      interaction_logic_unchanged: true,
      system_prompts_unchanged: true,
      model_bindings_unchanged: true,
    },
  }, null, 2)}\n`, "utf8");
  console.log(`Mode: ${apply ? "apply" : "dry-run"}; target=${agents.length}; changes=${updates.length}`);
  for (const item of updates) console.log(`- ${item.agent.name}`);
  console.log(`Report: ${outDir}`);
  if (!apply) return;

  const backupDir = path.join("backups", `simplify-new-agent-cards-v1-${stamp}`);
  await mkdir(backupDir, { recursive: true });
  await writeFile(path.join(backupDir, "before.json"), `${JSON.stringify({
    created_at: new Date().toISOString(),
    agents,
  }, null, 2)}\n`, "utf8");

  for (const item of updates) {
    await requestJson(`${baseUrl}/api/admin/agents`, token, {
      method: "PUT",
      body: JSON.stringify({ agentId: item.agent.id, ...item.next }),
    });
  }

  const afterPayload = await requestJson<{ agents: AdminAgent[] }>(`${baseUrl}/api/admin/agents`, token);
  for (const item of updates) {
    const after = afterPayload.agents.find((agent) => agent.id === item.agent.id);
    assert.ok(after, `${item.agent.name} missing after update`);
    assert.deepEqual(changedCard(after), item.next, `${item.agent.name} card copy mismatch after update`);
  }
  console.log(`Applied and verified ${updates.length} card copy updates.`);
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("/simplify-new-agent-cards-v1.ts")) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack || error.message : error);
    process.exitCode = 1;
  });
}
