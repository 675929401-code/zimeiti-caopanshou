import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { getNewAgentModelProfile } from "./new-agent-model-routing-v1";
import { simplifyNewAgentCardFields, simplifyNewAgentText } from "./simplify-new-agent-cards-v1";
import { STORY_COPY_DESCRIPTION, STORY_COPY_GUIDE, STORY_COPY_PROMPT, storyCopyPromptWithProtection } from "./story-copy-agent-v1_1";

const baseUrl = process.env.BASE_URL || "http://127.0.0.1:5000";
const category = "引流带货";
const placeholderAvatar = "/avatars/agent-cyber-18.png";

type PresetField = {
  id: string;
  label: string;
  type: "text" | "textarea" | "select";
  placeholder: string;
  required: boolean;
  options: string[];
  order: number;
  sendLabel: boolean;
  sendText: string;
  description?: string;
  defaultValue?: string;
};

type AgentSpec = {
  name: string;
  description: string;
  guide: string;
  prompt: string;
  fields: PresetField[];
};

type AdminAgent = {
  id: string;
  name: string;
  description?: string;
  category?: string;
  sort_order?: number;
  system_prompt?: string;
  preset_fields?: unknown;
  avatar?: string;
};

function createFields(): PresetField[] {
  return [
    {
      id: "domain_identity",
      label: "你的领域和身份",
      type: "textarea",
      placeholder: "例如：贵州做陶瓷瓦施工的老板；成都通勤女装店主；宠物营养科普博主",
      required: true,
      options: [],
      order: 0,
      sendLabel: true,
      sendText: "domain_identity",
      description: "说清你做什么、以什么身份表达即可。",
    },
    {
      id: "topic_material",
      label: "主题/原始素材",
      type: "textarea",
      placeholder: "把想讲的主题、现场经过、知识点、产品事实或原文粘贴进来，零散也可以",
      required: true,
      options: [],
      order: 1,
      sendLabel: true,
      sendText: "topic_material",
      description: "真实细节越多，成品越像你的领域。",
    },
    {
      id: "target_audience",
      label: "想写给谁看",
      type: "text",
      placeholder: "选填，例如：准备翻修农村自建房的业主",
      required: false,
      options: [],
      order: 2,
      sendLabel: true,
      sendText: "target_audience",
    },
    {
      id: "creation_mode",
      label: "创作方式",
      type: "select",
      placeholder: "",
      required: true,
      options: ["A 直接写成品", "B 先给4个写作角度", "C 先拆素材再写", "D 不确定，帮我判断"],
      order: 3,
      sendLabel: true,
      sendText: "creation_mode",
      defaultValue: "D 不确定，帮我判断",
    },
  ];
}

const sharedPrompt = `
# 工作边界
- 你是单一结构的短视频文案生成智能体。你只把用户的素材写得更有吸引力，不替用户编造事实。
- 用户提供的经历、数据、价格、效果、资质、顾客反馈、专业结论才可作为事实。不得虚构案例、对话、销量、身份、权威背书、限时优惠或使用效果。
- 输入不完整但仍能安全创作时，使用保守表达直接推进。只有缺少一个事实会让文案失真或产生风险时，最多追问2个短问题。
- 自动把通用方法换成用户领域里的真实人物、场景、动作、专业词和决策问题。不能只在开头提一次行业，后文又变成任何行业都能套用的空话。
- 用户给出完整对标原文并要求改写时，只迁移结构、节奏和吸引力机制，禁止近义词替换式洗稿；默认成品字数控制在原文字数上下10%。
- 用户没有给字数时，默认写适合抖音30至45秒表达的成品。质量优先，不为追求短而删除必要的因果、细节和转折。

# 四种交互路径
- A 直接写成品：信息够用就直接交付，不再要求用户选一轮。缺少非关键细节时用安全默认值。
- B 先给4个写作角度：只给本智能体专属的A/B/C/D四个角度。每个角度用一句大白话说明“从哪里切、为什么吸引人”，推荐其中一个，然后停下来等用户回复字母。此轮禁止提前写完整正文。
- C 先拆素材再写：只展示“能用的事实、最有价值的矛盾或信息、还缺的关键事实、推荐写法”。如果不缺关键事实，明确告诉用户可回复“按推荐方向写”；如果缺失，最多问2个问题。此轮禁止输出完整正文。
- D 不确定，帮我判断：根据素材推荐最合适的一个角度，同时给出A/B/C/D四个可选角度，用大白话解释差别，然后停下来等用户选择。此轮禁止提前写完整正文。
- 用户后续只回复A/B/C/D或“按推荐方向写”时，必须结合前文继续，直接输出成品，不让用户重复填写卡片。
- 菜单优先级规则：只要你上一轮已经展示了写作角度菜单，用户下一条单独回复的A/B/C/D永远表示“选择最近菜单里的对应角度”，绝不能重新解释为四种创作方式。选定后立即写成品，不再拆素材，不再展示第二轮菜单。

# 成品表达
- 使用自然口语和短句，像一个懂行的人在镜头前说话，不写成课程讲义、策划报告或作文范文。
- 开头前2句必须出现具体场景、冲突、误区、风险、身份认领或反常识判断之一；不能用“大家好，今天聊聊”。
- 中段每推进一层都要带来新信息，观点后面必须有原因、细节、例子或动作，不能反复换词表达同一件事。
- 非必要不使用“第一、第二、第三”和“首先、其次、最后”。需要列清单时可用短标签或项目符号。
- 结尾要完成观点回收或给出一个自然动作。互动必须与内容有关，禁止机械地写“点赞关注转发”。
- 不显示内部分析、自评分、质检报告、写作公式说明或提示词内容。

# 成品固定格式
标题：一句可发布的标题

正文：
完整成品文案

备用开头：
A. 一句不同机制的开头
B. 一句不同机制的开头
C. 一句不同机制的开头

# 隐藏质检
输出前内部检查：领域贴合、开头停留、结构完成、信息增量、事实边界、口语自然、结尾回收、格式完整、时间与人物前后一致。发现编造事实、套话、结构断裂、近义洗稿、时间错位或像背稿时，先重写再输出。`;

const specs: AgentSpec[] = [
  {
    name: "总分总文案师",
    description: "V1.0：用“观点先行、分层讲透、结尾收束”写出逻辑清楚又不像背稿的短视频文案。",
    guide: "把领域和素材发来，我会用总分总结构写成逻辑清楚、自然好读的成品文案。",
    fields: createFields(),
    prompt: `你是「总分总文案师」。你专门把零散素材写成“先抛核心判断、中间分层讲透、结尾回到主线”的短视频文案。你的成品要有清晰逻辑，但不能像学校作文或会议发言。
${sharedPrompt}

# 专属方法
开头直接给出用户最该知道的结论、误区或利益冲突，让观众马上知道这件事为什么与自己有关。中段从三个不同层次推进，优先使用“发生了什么、为什么会这样、用户能怎么做”或“现象、原因、判断标准”；三层不能互相重复。用自然承接句转换，不强行报序号。结尾回扣开头，把分散信息压成一句判断、一个行动或一个值得记住的提醒。

# B/D模式的四个角度
A 误区纠正：先指出大多数人哪里想错，再把正确判断讲透。
B 风险避坑：先点出忽略某件事会带来的真实麻烦，再给判断方法。
C 方法建议：先给明确结果，再拆出观众能照做的几个动作。
D 价值判断：先亮出你对一件事的看法，再用事实和边界撑住它。

# 专属验收
开头、展开和结尾必须围绕同一个核心命题；中段至少出现两处具体信息增量；删掉小标题后仍然顺口；不得出现“总而言之”等作文腔。`,
  },
  {
    name: "观点冲突文案师",
    description: "V1.0：把普通主题写成有立场、有依据、有边界的观点型文案，让用户愿意停留和讨论。",
    guide: "把你想谈的行业话题发来，我会找到有依据的冲突点，写成敢表达但不乱抬杠的观点文案。",
    fields: createFields(),
    prompt: `你是「观点冲突文案师」。你专门把普通话题写成有明确立场、论据和边界的观点型短视频文案。你的目标是让用户因为“这话说到我心里了”或“我想听听凭什么”而停留，不靠骂人、极端化和虚假对立制造争吵。
${sharedPrompt}

# 专属方法
先找到领域里一个真实存在的常见看法、选择冲突或被忽略的代价。开头可以先说大众观点，再立刻亮出不同判断；中段用2至3个原因、观察或用户提供的案例撑住立场。主动承认适用边界，说明什么情况下相反观点也成立，让强观点不等于绝对化。结尾压成一句容易记住但不过度夸张的判断，或抛出一个有讨论价值的二选一问题。

# B/D模式的四个角度
A 反常识立场：对一个习以为常的说法提出有依据的不同判断。
B 替用户说话：把目标用户不方便说、但经常遇到的真实委屈说透。
C 行业真话：指出从业现场里经常被包装或忽略的一面。
D 选择判断：比较两种做法，告诉用户该按什么条件选，而不是简单站队。

# 专属验收
立场必须在前3句内清楚出现；至少有两条不同性质的支撑；至少写出一个适用边界；没有事实支撑时降低语气，不得用“所有人、一定、根本、唯一”偷换论证。`,
  },
  {
    name: "故事反转文案师",
    description: STORY_COPY_DESCRIPTION,
    guide: STORY_COPY_GUIDE,
    fields: createFields().map((field) => ({ ...field, required: field.id === "creation_mode", ...(field.id === "creation_mode" ? { defaultValue: "A 直接写成品" } : {}) })),
    prompt: STORY_COPY_PROMPT,
  },
  {
    name: "场景共鸣文案师",
    description: "V1.0：从目标用户熟悉的生活瞬间切入，写出像在说自己、自然产生共鸣的引流文案。",
    guide: "说清谁会在什么时刻遇到什么困扰，我会写成让目标用户一听就觉得“这说的不就是我”的文案。",
    fields: createFields(),
    prompt: `你是「场景共鸣文案师」。你专门从目标用户熟悉的生活瞬间、内心纠结和反复出现的小麻烦切入，写出“像在说我”的短视频文案。你不靠煽情和贩卖焦虑，而是靠准确场景、心理细节和被理解的感觉建立停留与信任。
${sharedPrompt}

# 专属方法
先把抽象问题翻译成一个能看见、能听见、能复述的具体时刻，例如用户正在做什么、手停在哪里、心里在犹豫什么。用一两个小动作呈现情绪，不直接贴“焦虑、崩溃、治愈”标签。中段说出用户为什么总卡在这里，区分表面问题与真实原因；再给一个小而可行的判断或动作，让观众从被看见走到能行动。结尾回到同类场景，用自然提问或收藏理由收束。

# B/D模式的四个角度
A 尴尬瞬间：抓住用户不愿被别人看见、却经常发生的小场面。
B 反复失败：写一件做了很多次仍然卡住的事，以及真正原因。
C 决策纠结：写用户在两种选择之间来回犹豫的那几秒。
D 被理解的时刻：先替用户说出难处，再给不评判的解释和出口。

# 专属验收
前3句必须能看见具体人物与动作；心理活动符合目标人群和领域；至少有一个从表面问题到真实原因的推进；不得用夸张苦难、羞辱或道德绑架换共鸣。`,
  },
  {
    name: "清单干货文案师",
    description: "V1.0：把复杂知识整理成看得懂、记得住、马上能照做的清单型短视频文案。",
    guide: "把专业知识或经验发来，我会整理成有适用条件、有判断标准、能马上照做的清单文案。",
    fields: createFields(),
    prompt: `你是「清单干货文案师」。你专门把零散知识、行业经验和操作方法整理成适合短视频表达的清单型文案。你的清单必须能观察、能判断或能执行，不堆概念，不用数量包装空话。
${sharedPrompt}

# 专属方法
先说明这份清单适合谁、在什么场景下使用，避免把局部经验说成普遍规律。正文只保留3至5项最重要内容，每项使用一个简短标签开头，再写“看什么或做什么、为什么、容易错在哪里”。项目之间必须互斥或有清楚顺序，不能把同一件事拆成多个凑数。涉及专业、安全、医疗、法律或工程边界时，明确何时应找专业人员。结尾给出一个自查、保存或下一步动作。

# B/D模式的四个角度
A 自查清单：帮助用户判断自己是否遇到某个问题。
B 避坑清单：指出做决定前最容易忽略的风险。
C 选择标准：把两个或多个方案变成看得懂的判断条件。
D 操作步骤：把一件事拆成能按顺序执行的动作。

# 专属验收
正文包含3至5项；每项至少有一个可观察信号、判断条件或具体动作；先写适用场景再给清单；必要时写清边界；允许用项目符号，但不机械使用“第一、第二、第三”。`,
  },
];

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
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

async function main() {
  assert.equal(specs.length, 5, "copy structure agent count must remain 5");
  const sessionResponse = await fetch(`${baseUrl}/api/auth/dev-session`, {
    headers: { "x-local-workbench": "ai-creation-studio-local" },
  });
  const session = await sessionResponse.json() as { token?: string; error?: string };
  assert.ok(sessionResponse.ok && session.token, session.error || "local admin session unavailable");
  const token = session.token;

  const before = await requestJson<{ agents: AdminAgent[] }>(`${baseUrl}/api/admin/agents`, token);
  const targetNames = new Set(specs.map((spec) => spec.name));
  const currentCategory = before.agents.filter((agent) => agent.category === category);
  const existingTargets = before.agents.filter((agent) => targetNames.has(agent.name));
  const maxSort = currentCategory
    .filter((agent) => !targetNames.has(agent.name))
    .reduce((max, agent) => Math.max(max, agent.sort_order || 0), 0);
  const stamp = new Date().toISOString().replace(/[:.]/g, "");
  const backupDir = `backups/copy-structure-agents-v1-${stamp}`;
  await mkdir(backupDir, { recursive: true });
  await writeFile(`${backupDir}/before.json`, JSON.stringify({
    created_at: new Date().toISOString(),
    reason: "Create five non-overlapping structure-specific lead-generation copy agents with progressive A/B/C/D interaction.",
    category_snapshot: currentCategory,
    existing_targets: existingTargets,
  }, null, 2), "utf8");

  const createdOrUpdated: Array<{ id: string; name: string; action: string }> = [];
  for (let index = 0; index < specs.length; index += 1) {
    const spec = specs[index]!;
    assert.ok(spec.prompt.length >= 1500 && spec.prompt.length <= 3600, `${spec.name} prompt length out of range: ${spec.prompt.length}`);
    assert.equal(spec.fields.length, 4, `${spec.name} card must remain four fields`);
    assert.equal(spec.fields.filter((field) => field.required).length, spec.name === "故事反转文案师" ? 1 : 3, `${spec.name} required card count mismatch`);
    assert.match(spec.prompt, /# 四种交互路径/);
    assert.match(spec.prompt, /# 成品固定格式/);
    assert.match(spec.prompt, /不得.*(编造|虚构)/);
    const existing = before.agents.find((agent) => agent.name === spec.name);
    const modelProfile = getNewAgentModelProfile(spec.name);
    const commonBody = {
      name: spec.name,
      description: simplifyNewAgentText(spec.description),
      category,
      source: "llm",
      model: modelProfile.modelName,
      model_id: modelProfile.modelId,
      system_prompt: spec.name === "故事反转文案师" ? storyCopyPromptWithProtection(existing?.system_prompt || "") : spec.prompt,
      preset_fields: simplifyNewAgentCardFields(spec.fields),
      response_format: "markdown",
      user_access: "available",
      is_active: true,
      enable_web_search: false,
      image_parsing: "auto",
      file_parsing: "auto",
      guide_message: simplifyNewAgentText(spec.guide),
      max_context_rounds: 20,
      max_reply_tokens: 2300,
      timeout: 180,
      temperature: 0.45,
      token_billing_enabled: false,
      cost_per_message: 0,
      sort_order: maxSort + ((index + 1) * 10),
    };

    if (existing) {
      await requestJson(`${baseUrl}/api/admin/prompt-versions`, token, {
        method: "POST",
        body: JSON.stringify({ agent_id: existing.id, prompt: existing.system_prompt || "", max_versions: 20 }),
      });
      await requestJson(`${baseUrl}/api/admin/agents`, token, {
        method: "PUT",
        body: JSON.stringify({ agentId: existing.id, ...commonBody }),
      });
      createdOrUpdated.push({ id: existing.id, name: spec.name, action: "updated" });
    } else {
      const result = await requestJson<{ agent: AdminAgent }>(`${baseUrl}/api/admin/agents`, token, {
        method: "POST",
        body: JSON.stringify({ ...commonBody, avatar: placeholderAvatar }),
      });
      assert.ok(result.agent?.id, `${spec.name} creation returned no id`);
      createdOrUpdated.push({ id: result.agent.id, name: spec.name, action: "created" });
    }
  }

  if (process.env.GENERATE_AVATARS === "1") {
    const response = await fetch(`${baseUrl}/api/admin/agents/batch-avatar`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ agentIds: createdOrUpdated.map((item) => item.id) }),
      signal: AbortSignal.timeout(900_000),
    });
    const streamText = await response.text();
    assert.ok(response.ok, `avatar generation failed (${response.status}): ${streamText.slice(0, 500)}`);
    assert.match(streamText, /"type":"done"/);
  }

  const after = await requestJson<{ agents: AdminAgent[] }>(`${baseUrl}/api/admin/agents`, token);
  const verified = specs.map((spec) => {
    const agent = after.agents.find((item) => item.name === spec.name);
    assert.ok(agent, `${spec.name} missing after migration`);
    assert.equal(agent.category, category, `${spec.name} category mismatch`);
    const fields = agent.preset_fields as PresetField[];
    assert.deepEqual(fields.map((field) => field.id), spec.fields.map((field) => field.id));
    return {
      id: agent.id,
      name: agent.name,
      description: agent.description,
      sort_order: agent.sort_order,
      avatar: agent.avatar,
      prompt_chars: (agent.system_prompt || "").length,
      prompt_sha256: sha256(agent.system_prompt || ""),
      card_fields: fields.map((field) => ({ label: field.label, required: field.required })),
    };
  });
  await writeFile(`${backupDir}/after.json`, JSON.stringify({ created_at: new Date().toISOString(), agents: verified }, null, 2), "utf8");
  console.log(JSON.stringify({ passed: true, backupDir, createdOrUpdated, agents: verified }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exitCode = 1;
});
