import assert from "node:assert/strict";
import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";

const baseUrl = process.env.BASE_URL || "http://127.0.0.1:5000";
const runId = new Date().toISOString().replace(/[:.]/g, "");
const outDir = path.join("research-output", `local-business-industry-agents-v2-${runId}`);
const requestedCaseIds = new Set(
  (process.env.TEST_CASE_IDS || "").split(",").map((value) => value.trim()).filter(Boolean),
);

type Agent = { id: string; name: string; category?: string };
type ChatMessage = { role: "user" | "assistant"; content: string };
type Platform = "抖音" | "小红书" | "抖音+小红书";
type DirectCase = {
  id: string;
  agentName: string;
  platform: Platform;
  message: string;
  industryTerms: string[];
  customerTerms: string[];
  evidenceTerms: string[];
  forbiddenPhrases: string[];
};

const directCases: DirectCase[] = [
  {
    id: "restaurant-idea-douyin",
    agentName: "餐饮门店爆款编导",
    platform: "抖音",
    message: `你现在有什么：A 我有想表达的内容\n原始内容/参考文案/旧稿：我想告诉顾客，鲜切牛肉火锅不是切得越薄越好，部位不同，切法和涮的时间也不同。今天可以拍吊龙和匙柄现场切配、分别上桌，但不要编固定涮几秒。\n发布平台：抖音\n这条最想得到什么：同城到店\n门店与顾客：贵阳观山湖潮汕牛肉火锅；朋友聚餐、在意牛肉口感和新鲜度的人。\n可用证据/价格/限制：吊龙和匙柄是当天真实供应部位；可拍师傅切配、纹理和上桌；不写销量、排队、产地和套餐价格。`,
    industryTerms: ["吊龙", "匙柄", "鲜切", "切", "上桌"],
    customerTerms: ["顾客", "口感", "聚餐", "到店", "观山湖"],
    evidenceTerms: ["纹理", "切配", "部位", "现场"],
    forbiddenPhrases: ["固定涮8秒", "全城第一", "每天排队"],
  },
  {
    id: "fashion-question-xhs",
    agentName: "服装门店种草编导",
    platform: "小红书",
    message: `你现在有什么：F 我只知道顾客问题\n原始内容/参考文案/旧稿：通勤女装顾客总问，梨形身材是不是只能穿很宽的阔腿裤？我想解释不能只看裤腿宽，还要看腰线、侧缝、胯部余量和走动时的垂感。\n发布平台：小红书\n这条最想得到什么：点赞收藏\n门店与顾客：成都高新区通勤女装；25到38岁上班族，想穿得利落但不想制造身材焦虑。\n可用证据/价格/限制：能拍同一位店员试穿三条不同裤型的正侧背和走动效果；没有统一适合所有人的版型，不写显瘦多少斤。`,
    industryTerms: ["梨形", "裤", "腰线", "侧缝", "垂感"],
    customerTerms: ["通勤", "上班", "适合", "收藏"],
    evidenceTerms: ["试穿", "正侧背", "走动", "胯部"],
    forbiddenPhrases: ["显瘦10斤", "所有梨形都适合", "闭眼入"],
  },
  {
    id: "building-cross-douyin",
    agentName: "建材装修获客编导",
    platform: "抖音",
    message: `你现在有什么：C 我有跨行业爆款文案\n原始内容/参考文案/旧稿：参考文案来自服装行业，数据未提供：“很多人买衣服先看价格，拿起来又放下。真正让你不敢买的，不是贵，是怕买错。别急着看吊牌，先摸面料，再看走线，最后试一次活动量。”我想迁移这种“不是贵，是怕买错”的叙事，用来讲农村自建房选陶瓷瓦。今天工地可以拍瓦片截面、屋面坡度、檩条和搭接位置。\n发布平台：抖音\n这条最想得到什么：咨询留资\n门店与顾客：贵州农村自建房陶瓷瓦销售施工；准备选瓦、担心后期返工的业主。\n可用证据/价格/限制：可讲选瓦要结合瓦型、坡度、厂家施工要求和现场方案；没有统一檩条间距，没有使用年限数据，不贬低低价产品。`,
    industryTerms: ["陶瓷瓦", "坡度", "檩条", "搭接", "屋面"],
    customerTerms: ["业主", "选瓦", "返工", "咨询"],
    evidenceTerms: ["截面", "现场", "厂家", "方案"],
    forbiddenPhrases: ["别急着看吊牌，先摸面料", "保证30年不漏", "统一间距"],
  },
  {
    id: "retail-story-both",
    agentName: "小店零售引流编导",
    platform: "抖音+小红书",
    message: `你现在有什么：D 我有现场素材/故事\n原始内容/参考文案/旧稿：附近工厂夜班十点多下班，老板今天把最后六份热饭单独留到十点半。不是活动，也没有打折；只是这个时间周围很难买到热乎的。可以拍保温柜、时间牌、补货和夜里亮灯的门头，不拍顾客正脸。\n发布平台：抖音+小红书\n这条最想得到什么：老板人设\n门店与顾客：社区便利店；附近夜班工人和晚归居民。\n可用证据/价格/限制：六份、十点半是今天真实记录；不虚构每天都有，不写顾客评价和销量。`,
    industryTerms: ["夜班", "热饭", "十点半", "便利店", "保温柜"],
    customerTerms: ["晚归", "夜班", "附近", "顺路"],
    evidenceTerms: ["六份", "时间牌", "门头", "今天"],
    forbiddenPhrases: ["每天都留", "顾客感动哭了", "全城最暖"],
  },
  {
    id: "beauty-peer-xhs",
    agentName: "美业门店获客编导",
    platform: "小红书",
    message: `你现在有什么：B 我有同行爆款文案\n原始内容/参考文案/旧稿：同行参考文案，数据未提供：“拿着网图来染发，最怕的不是做不出来，是没人告诉你这张图建立在什么底色上。深染历史、发尾状态、褪色路径没看清，颜色越浅越容易和想象不一样。”我店里今天有位顾客拿浅金网图来，之前染过深色，发尾偏干。发型师先看底色和发质，说明一次做到网图效果风险高，最后一起改成暖棕方向。\n发布平台：小红书\n这条最想得到什么：专业信任\n门店与顾客：染发造型；想换浅发色但有历史染深的普通顾客。\n可用证据/价格/限制：可拍网图沟通、底色、发尾、色卡和自然光暖棕；不承诺完全还原网图，不写永久维持，不补顾客满意评价。`,
    industryTerms: ["染发", "底色", "发尾", "暖棕", "色卡"],
    customerTerms: ["顾客", "适合", "风险", "信任"],
    evidenceTerms: ["历史染深", "自然光", "发质", "网图"],
    forbiddenPhrases: ["最怕的不是做不出来", "永久不褪色", "顾客非常满意"],
  },
  {
    id: "home-service-old-douyin",
    agentName: "家政维修接单编导",
    platform: "抖音",
    message: `你现在有什么：E 我有旧稿想优化\n原始内容/参考文案/旧稿：旧稿：“夏天到了，空调一定要清洗，我们是合肥专业空调清洗，全网最低，洗完空气立刻变健康，欢迎大家联系我们。”真实素材是：客户每年擦滤网，师傅上门先铺防护、断电，再拆开检查；滤网不算脏，但风轮和内部积灰明显。\n发布平台：抖音\n这条最想得到什么：咨询留资\n门店与顾客：合肥家电清洗；家里空调看着干净但想确认内部状态的家庭用户。\n可用证据/价格/限制：能拍进门防护、断电、滤网、风轮和清洗过程；没有菌落检测，不承诺健康效果，不写最低价。`,
    industryTerms: ["空调", "滤网", "风轮", "断电", "清洗"],
    customerTerms: ["家庭", "检查", "咨询", "合肥"],
    evidenceTerms: ["防护", "积灰", "拆开", "过程"],
    forbiddenPhrases: ["全网最低", "立刻变健康", "一定要清洗"],
  },
  {
    id: "education-question-xhs",
    agentName: "教培亲子招生编导",
    platform: "小红书",
    message: `你现在有什么：F 我只知道顾客问题\n原始内容/参考文案/旧稿：家长问“孩子上课不举手，是不是表达能力差？”今天课堂有个孩子一直不举手，老师没有点名逼答，而是把问题拆成两个小选择，让全班先用动作选择；第二轮孩子自己举手补了一句。只讲教学方法，不讲姓名和成绩。\n发布平台：小红书\n这条最想得到什么：专业信任\n门店与顾客：7到10岁少儿表达与阅读课；担心孩子不敢说、不知道老师如何引导的家长。\n可用证据/价格/限制：可拍老师示范、全班动作选择和课堂任务，未成年人画面需授权或避开正脸；不承诺性格改变、提分和获奖。`,
    industryTerms: ["孩子", "课堂", "老师", "举手", "选择"],
    customerTerms: ["家长", "表达", "引导", "适合"],
    evidenceTerms: ["第二轮", "动作", "任务", "授权"],
    forbiddenPhrases: ["保证变自信", "孩子就是表达能力差", "一定提分"],
  },
  {
    id: "hotel-peer-xhs",
    agentName: "酒店民宿获客编导",
    platform: "小红书",
    message: `你现在有什么：B 我有同行爆款文案\n原始内容/参考文案/旧稿：同行参考文案，数据未提供：“订景区民宿别只看窗景，拖着行李走到门口那一段，才决定你第一晚累不累。先看停车点，再看石板路，最后看下雨有没有备用路线。”本店今天下雨，店员实走并重拍了从停车点到民宿门口的避雨路线，约三分钟；雨天路线和晴天不同。\n发布平台：小红书\n这条最想得到什么：同城到店\n门店与顾客：景区民宿；自驾、带行李、担心雨天抵达不方便的客人。\n可用证据/价格/限制：能拍停车点、路线、石板路和门口；三分钟是今天店员实走，不代表所有人；不写房价、景观和最低价。`,
    industryTerms: ["民宿", "停车点", "雨天", "路线", "门口"],
    customerTerms: ["自驾", "行李", "客人", "抵达"],
    evidenceTerms: ["三分钟", "实走", "石板路", "今天"],
    forbiddenPhrases: ["才决定你第一晚累不累", "全网最低", "所有人三分钟"],
  },
  {
    id: "pet-story-both",
    agentName: "宠物门店获客编导",
    platform: "抖音+小红书",
    message: `你现在有什么：D 我有现场素材/故事\n原始内容/参考文案/旧稿：今天一只第一次来洗澡的小狗进门后缩在主人腿后。美容师没有马上抱走，先蹲下来让它闻毛巾和工具，等它愿意往前一步后再进入洗护区；吹风时根据反应分段停下。\n发布平台：抖音+小红书\n这条最想得到什么：专业信任\n门店与顾客：宠物洗护；担心宠物紧张、不知道门店如何照顾情绪的主人。\n可用证据/价格/限制：可拍入店状态、闻嗅、工具、洗护和分段吹风；不诊断焦虑症，不承诺所有宠物一次适应，不补主人评价。`,
    industryTerms: ["小狗", "洗护", "美容师", "吹风", "闻"],
    customerTerms: ["主人", "紧张", "适应", "服务"],
    evidenceTerms: ["毛巾", "工具", "分段", "往前一步"],
    forbiddenPhrases: ["治好焦虑", "所有宠物都能适应", "主人夸我们"],
  },
];

function section(text: string, heading: string, next: string[]) {
  const start = text.indexOf(heading);
  if (start < 0) return "";
  const from = start + heading.length;
  const ends = next.map((item) => text.indexOf(item, from)).filter((index) => index >= 0);
  return text.slice(from, ends.length ? Math.min(...ends) : text.length).trim();
}

function evaluate(testCase: DirectCase, output: string) {
  const compact = output.replace(/\s+/g, "");
  const isDouyin = testCase.platform === "抖音" || testCase.platform === "抖音+小红书";
  const isXhs = testCase.platform === "小红书" || testCase.platform === "抖音+小红书";
  const format = (!isDouyin || ["【成品文案】", "【现场怎么拍】", "【发布标题】"].every((term) => output.includes(term)))
    && (!isXhs || ["【首图文案】", "【正文】", "【图片顺序】", "【搜索词】"].every((term) => output.includes(term)))
    && (testCase.platform !== "抖音+小红书" || ["【抖音版】", "【小红书版】"].every((term) => output.includes(term)));
  const relevant = testCase.industryTerms.filter((term) => output.includes(term)).length >= 3;
  const customer = testCase.customerTerms.filter((term) => output.includes(term)).length >= 2;
  const evidence = testCase.evidenceTerms.filter((term) => output.includes(term)).length >= 2;
  const safety = !/(百分之百|全城第一|全网最低|保证有效|保证提分|根治|永久维持|包治)/.test(output);
  const originality = testCase.forbiddenPhrases.every((phrase) => !output.includes(phrase));
  const noLeak = !/(系统提示词|隐藏成稿方法|爆款参考使用协议|内部评分|自评分)/.test(output);
  const plain = !/(首先|其次|再次|最后)[，,：:]|第一[，,：:]|第二[，,：:]|第三[，,：:]/.test(output);
  const nextStep = output.includes("【下一步】") && /A.+B.+C.+D/s.test(output);
  const hasHook = isDouyin
    ? !/【成品文案】\s*(大家好|家人们|今天给大家分享|你知道吗)/.test(output)
    : true;
  const oneAction = (() => {
    const publishable = isDouyin
      ? section(output, "【成品文案】", ["【现场怎么拍】", "【发布标题】", "【小红书版】"])
      : section(output, "【正文】", ["【图片顺序】", "【搜索词】", "【下一步】"]);
    const groups = [
      /(?:点|先|记得)?关注(?:我|账号|我们)/,
      /评论(?:区)?(?:告诉|留下|发)/,
      /私信|发给我|发我/,
      /(?:来|到|进)(?:我们|我)?店|到店(?:做|看|试|体验|检查|咨询)/,
      /预约|团购|下单/,
      /(?:先|记得|建议)?收藏(?:这|起来|一下)|收藏备用/,
    ];
    return groups.filter((pattern) => pattern.test(publishable)).length <= 1;
  })();
  const substantive = compact.length >= (testCase.platform === "抖音+小红书" ? 900 : testCase.platform === "小红书" ? 650 : 350);
  const checks = { format, relevant, customer, evidence, safety, originality, noLeak, plain, nextStep, hasHook, oneAction, substantive, clarification: true };
  const weights: Record<keyof typeof checks, number> = {
    format: 15,
    relevant: 12,
    customer: 10,
    evidence: 10,
    safety: 12,
    originality: 10,
    noLeak: 6,
    plain: 5,
    nextStep: 5,
    hasHook: 5,
    oneAction: 5,
    substantive: 5,
    clarification: 0,
  };
  const score = (Object.keys(checks) as Array<keyof typeof checks>).reduce((sum, key) => sum + (checks[key] ? weights[key] : 0), 0);
  return {
    score,
    passed: score >= 90 && format && safety && originality && noLeak,
    chars: compact.length,
    checks,
  };
}

async function chat(token: string, userId: string | undefined, agent: Agent, messages: ChatMessage[], conversationId: string) {
  let response: Response | undefined;
  let payload: { error?: string; choices?: Array<{ message?: { content?: string } }> } = {};
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    response = await fetch(`${baseUrl}/api/llm`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({
        messages,
        agentId: agent.id,
        agentName: agent.name,
        stream: false,
        userId,
        conversationId,
        maxContextRounds: 0,
        maxReplyTokens: 5000,
        timeout: 240,
        enableWebSearch: false,
        responseFormat: "markdown",
      }),
      signal: AbortSignal.timeout(300_000),
    });
    payload = await response.json() as typeof payload;
    if (response.ok) break;
    if (![429, 502, 503, 504].includes(response.status) || attempt === 3) break;
    await new Promise((resolve) => setTimeout(resolve, attempt * 2000));
  }
  assert.ok(response?.ok, payload.error || `HTTP ${response?.status || "unknown"}`);
  const output = String(payload.choices?.[0]?.message?.content || "").trim();
  assert.ok(output, `${agent.name}: empty output`);
  return output;
}

async function main() {
  await mkdir(outDir, { recursive: true });
  const sessionResponse = await fetch(`${baseUrl}/api/auth/dev-session`, {
    headers: { "x-local-workbench": "ai-creation-studio-local" },
  });
  const session = await sessionResponse.json() as { token?: string; error?: string; user?: { id?: string } };
  assert.ok(sessionResponse.ok && session.token, session.error || "local admin session unavailable");
  const token = session.token;
  const agentsResponse = await fetch(`${baseUrl}/api/admin/agents`, { headers: { Authorization: `Bearer ${token}` } });
  const agentsPayload = await agentsResponse.json() as { agents?: Agent[]; error?: string };
  assert.ok(agentsResponse.ok && agentsPayload.agents, agentsPayload.error || "agent list unavailable");
  const agents = agentsPayload.agents;
  const selectedDirect = requestedCaseIds.size > 0 ? directCases.filter((item) => requestedCaseIds.has(item.id)) : directCases;
  const results: Array<Record<string, unknown>> = [];

  for (const testCase of selectedDirect) {
    const agent = agents.find((item) => item.name === testCase.agentName && item.category === "实体引流");
    assert.ok(agent, `${testCase.agentName} not found`);
    const conversationId = `conv_localbiz_v2_${testCase.id}_${Date.now()}`;
    const output = await chat(token, session.user?.id, agent, [{ role: "user", content: testCase.message }], conversationId);
    await writeFile(path.join(outDir, `${testCase.id}.md`), `${output}\n`, "utf8");
    const evaluation = evaluate(testCase, output);
    results.push({ id: testCase.id, agentName: testCase.agentName, conversationId, ...evaluation });
    console.log(JSON.stringify({ type: "case", id: testCase.id, ...evaluation }));
  }

  const runInteractive = requestedCaseIds.size === 0 || requestedCaseIds.has("auto-missing-reference") || requestedCaseIds.has("restaurant-missing-offer");
  if (runInteractive) {
    const autoAgent = agents.find((item) => item.name === "汽车门店获客编导" && item.category === "实体引流");
    assert.ok(autoAgent, "汽车门店获客编导 not found");
    const autoInitial = `你现在有什么：B 我有同行爆款文案\n原始内容/参考文案/旧稿：我想写轮胎偏磨，但参考文案稍后再发。\n发布平台：抖音\n这条最想得到什么：咨询留资`;
    const autoConversation = `conv_localbiz_v2_auto_clarify_${Date.now()}`;
    const autoQuestion = await chat(token, session.user?.id, autoAgent, [{ role: "user", content: autoInitial }], autoConversation);
    const questionPassed = autoQuestion.includes("【还差一点信息】")
      && autoQuestion.includes("【请选择】")
      && !autoQuestion.includes("【成品文案】")
      && /A.+B.+C/s.test(autoQuestion);
    await writeFile(path.join(outDir, "auto-missing-reference-question.md"), `${autoQuestion}\n`, "utf8");
    const autoReply = `补充参考文案：“轮胎外面看着还能跑，不代表里面也安全。很多偏磨藏在内侧，举升后才看得见。只换轮胎不查原因，新胎也可能继续磨。”\n我的真实素材：今天一辆车常规检查，轮胎外侧看着还行，举升后发现后轮内侧磨损明显。轮胎需要处理，但偏磨原因还要继续检查；没有完整检测数据，不能直接说是四轮定位。门店做轮胎与底盘检查，服务本地车主。`;
    const autoOutput = await chat(token, session.user?.id, autoAgent, [
      { role: "user", content: autoInitial },
      { role: "assistant", content: autoQuestion },
      { role: "user", content: autoReply },
    ], `${autoConversation}_resolved`);
    await writeFile(path.join(outDir, "auto-missing-reference-result.md"), `${autoOutput}\n`, "utf8");
    const autoEvaluation = evaluate({
      id: "auto-missing-reference",
      agentName: autoAgent.name,
      platform: "抖音",
      message: `${autoInitial}\n${autoReply}`,
      industryTerms: ["轮胎", "内侧", "偏磨", "举升", "检查"],
      customerTerms: ["你的车", "车辆", "发来", "检查"],
      evidenceTerms: ["外侧", "后轮", "检测", "原因"],
      forbiddenPhrases: ["偏磨就是四轮定位的问题", "新胎一定继续磨", "轮胎外面看着还能跑，不代表里面也安全"],
    }, autoOutput);
    autoEvaluation.checks.clarification = questionPassed;
    if (!questionPassed) {
      autoEvaluation.score = Math.max(0, autoEvaluation.score - 20);
      autoEvaluation.passed = false;
    }
    results.push({ id: "auto-missing-reference", agentName: autoAgent.name, questionPassed, ...autoEvaluation });
    console.log(JSON.stringify({ type: "case", id: "auto-missing-reference", questionPassed, ...autoEvaluation }));

    const restaurantAgent = agents.find((item) => item.name === "餐饮门店爆款编导" && item.category === "实体引流");
    assert.ok(restaurantAgent, "餐饮门店爆款编导 not found");
    const offerInitial = `你现在有什么：A 我有想表达的内容\n原始内容/参考文案/旧稿：想推广周末双人鲜切牛肉火锅团购，能拍吊龙、匙柄、现切和上桌。\n发布平台：抖音\n这条最想得到什么：团购成交\n门店与顾客：贵阳观山湖，朋友或情侣两人聚餐。`;
    const offerConversation = `conv_localbiz_v2_offer_clarify_${Date.now()}`;
    const offerQuestion = await chat(token, session.user?.id, restaurantAgent, [{ role: "user", content: offerInitial }], offerConversation);
    const offerQuestionPassed = offerQuestion.includes("【还差一点信息】")
      && offerQuestion.includes("【请选择】")
      && !offerQuestion.includes("【成品文案】")
      && /(价格|套餐|规则|团购)/.test(offerQuestion);
    await writeFile(path.join(outDir, "restaurant-missing-offer-question.md"), `${offerQuestion}\n`, "utf8");
    const offerReply = "这次不写团购成交，改成咨询留资；不写价格和优惠。真实事实只有双人聚餐场景、吊龙、匙柄、现切和上桌。";
    const offerOutput = await chat(token, session.user?.id, restaurantAgent, [
      { role: "user", content: offerInitial },
      { role: "assistant", content: offerQuestion },
      { role: "user", content: offerReply },
    ], `${offerConversation}_resolved`);
    await writeFile(path.join(outDir, "restaurant-missing-offer-result.md"), `${offerOutput}\n`, "utf8");
    const offerEvaluation = evaluate({
      id: "restaurant-missing-offer",
      agentName: restaurantAgent.name,
      platform: "抖音",
      message: `${offerInitial}\n${offerReply}`,
      industryTerms: ["吊龙", "匙柄", "鲜切", "上桌", "牛肉"],
      customerTerms: ["两人", "聚餐", "咨询", "观山湖"],
      evidenceTerms: ["现切", "真实", "场景", "上桌"],
      forbiddenPhrases: ["168元", "限时团购", "全城最低"],
    }, offerOutput);
    offerEvaluation.checks.clarification = offerQuestionPassed;
    if (!offerQuestionPassed) {
      offerEvaluation.score = Math.max(0, offerEvaluation.score - 20);
      offerEvaluation.passed = false;
    }
    results.push({ id: "restaurant-missing-offer", agentName: restaurantAgent.name, questionPassed: offerQuestionPassed, ...offerEvaluation });
    console.log(JSON.stringify({ type: "case", id: "restaurant-missing-offer", questionPassed: offerQuestionPassed, ...offerEvaluation }));
  }

  assert.ok(results.length > 0, "no matching TEST_CASE_IDS were found");
  const averageScore = Math.round(
    (results.reduce((sum, item) => sum + Number(item.score || 0), 0) / results.length) * 10,
  ) / 10;
  const report = {
    passed: results.every((item) => item.passed === true),
    averageScore,
    passCount: results.filter((item) => item.passed === true).length,
    total: results.length,
    outDir,
    results,
  };
  await writeFile(path.join(outDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ type: "done", ...report }, null, 2));
  if (!report.passed) process.exitCode = 2;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exitCode = 1;
});
