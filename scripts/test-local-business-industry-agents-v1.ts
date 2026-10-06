import assert from "node:assert/strict";
import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";

const baseUrl = process.env.BASE_URL || "http://127.0.0.1:5000";
const testModel = process.env.TEST_MODEL || "";
const requestedCaseIds = new Set(
  (process.env.TEST_CASE_IDS || process.env.TEST_CASE_ID || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
);
const runId = new Date().toISOString().replace(/[:.]/g, "");
const outDir = path.join("research-output", `local-business-industry-agents-v1-${runId}`);

type TestCase = {
  id: string;
  agentId: string;
  agentName: string;
  message: string;
  duration: "30秒" | "45秒" | "60秒";
  industryTerms: string[];
  goalTerms: string[];
};

const cases: TestCase[] = [
  {
    id: "restaurant-beef-hotpot",
    agentId: "agent-1787153460050-6nbk0a",
    agentName: "餐饮门店爆款编导",
    duration: "45秒",
    industryTerms: ["牛肉", "鲜切", "锅", "上桌", "后厨"],
    goalTerms: ["店", "来", "到店", "贵阳"],
    message: `今日素材/想说的事：今天凌晨五点，老板照常去市场看牛肉。有人问为什么不一次多进一点，老板说鲜切档口最怕的不是卖慢，是为了省事让肉在冰柜里等顾客。今天一位老顾客又点了吊龙和匙柄，看见师傅现切才坐下。\n细分类目/主营项目：潮汕鲜切牛肉火锅\n城市与顾客：贵阳观山湖，喜欢朋友聚餐、在意食材新鲜的顾客\n专业资料/术语：吊龙、匙柄是本店真实供应部位；牛肉到店后按部位现切；不宣传固定到店分钟数，不写销量；具体价格本次未提供。\n创作目标：同城到店\n文案时长：45秒`,
  },
  {
    id: "fashion-womens-pear-shape",
    agentId: "agent-1787153460424-bolgy6",
    agentName: "服装门店种草编导",
    duration: "45秒",
    industryTerms: ["梨形", "裤", "腰线", "垂感", "试穿"],
    goalTerms: ["试", "到店", "店里", "成都"],
    message: `今日素材/想说的事：今天一位梨形身材的顾客试了三条阔腿裤，前两条站着好看，一走路胯部就堆。第三条没有那么宽，但侧缝更直，她走了两圈后说终于不是拿裤腿遮身材了。\n细分类目/主营项目：通勤女装\n城市与顾客：成都高新区，25到38岁上班族\n专业资料/术语：第三条是高腰微阔直筒版，聚酯纤维与粘纤混纺，尺码以店内实测表为准；不写显瘦多少斤，不制造身材焦虑。\n创作目标：同城到店\n文案时长：45秒`,
  },
  {
    id: "building-roof-tile",
    agentId: "agent-1787153460725-uvpg57",
    agentName: "建材装修获客编导",
    duration: "60秒",
    industryTerms: ["瓦", "檩条", "搭接", "施工", "屋面"],
    goalTerms: ["咨询", "现场", "业主", "确认"],
    message: `今日素材/想说的事：今天在贵州一个农村自建房屋面盖陶瓷瓦，瓦刚摆上去，师傅就让大家先停。不是瓦有问题，是现场檩条排布和原施工方案对不上。如果硬往下盖，后面的搭接和收口会越来越别扭。师傅重新测量、和业主确认方案后才继续。\n细分类目/主营项目：农村自建房陶瓷瓦销售与施工\n城市与顾客：贵州，自建房业主\n专业资料/术语：檩条、顺水条、挂瓦条、搭接、脊瓦、檐口收边；具体间距必须按瓦型、坡度、厂家施工要求和现场方案确认，本次不提供统一数值。\n创作目标：咨询留资\n文案时长：60秒`,
  },
  {
    id: "retail-night-shift",
    agentId: "agent-1787153461118-iomt7t",
    agentName: "小店零售引流编导",
    duration: "30秒",
    industryTerms: ["小店", "夜班", "热饭", "货架", "邻居"],
    goalTerms: ["店", "路过", "来", "社区"],
    message: `今日素材/想说的事：附近工厂上夜班的人经常十点多才下班，今天老板把最后几份热饭单独留到十点半。不是活动，也没有打折，就是记得他们这个点附近不好买热乎的。\n细分类目/主营项目：社区便利店\n城市与顾客：社区居民和附近夜班工人\n创作目标：老板人设\n文案时长：30秒`,
  },
  {
    id: "beauty-hair-color-boundary",
    agentId: "agent-1787153461391-mvf2t9",
    agentName: "美业门店获客编导",
    duration: "45秒",
    industryTerms: ["发色", "底色", "染", "发质", "自然光"],
    goalTerms: ["预约", "咨询", "到店", "判断", "发张", "底色"],
    message: `今日素材/想说的事：今天一位顾客拿着浅金色网图来染发，但她之前染过深色，发尾也比较干。发型师没有直接开做，而是先看底色和发质，告诉她一次做到网图效果风险太高，最后一起改成更适合当前基础的暖棕方向。\n细分类目/主营项目：染发造型\n专业资料/术语：历史染深、发尾多孔、底色判断、褪色路径；不承诺和网图一模一样，不写永久维持。\n创作目标：专业信任\n文案时长：45秒`,
  },
  {
    id: "auto-inner-tire-wear",
    agentId: "agent-1787153461664-okmn6z",
    agentName: "汽车门店获客编导",
    duration: "45秒",
    industryTerms: ["轮胎", "内侧", "磨损", "举升", "检查"],
    goalTerms: ["检查", "到店", "咨询", "车主"],
    message: `今日素材/想说的事：今天一辆车来做常规检查，轮胎外侧看着还行，举升后才发现后轮内侧磨损明显。车主第一反应是马上换轮胎，师傅先说别急，轮胎要处理，但造成偏磨的原因也要继续检查，不然只换新胎可能还会重复。\n细分类目/主营项目：汽车轮胎与底盘检查\n专业资料/术语：偏磨、胎压、四轮定位、悬挂部件；本次没有完整检测数据，不能直接判断唯一原因。\n创作目标：咨询留资\n文案时长：45秒`,
  },
  {
    id: "home-service-air-conditioner",
    agentId: "agent-1787153461938-u3qwii",
    agentName: "家政维修接单编导",
    duration: "45秒",
    industryTerms: ["空调", "拆", "清洗", "滤网", "防护"],
    goalTerms: ["咨询", "上门", "检查", "预约", "私信", "评论"],
    message: `今日素材/想说的事：客户说空调每年都擦，看着挺干净。师傅上门后先铺防护，再拆开检查，表面的滤网不算脏，但风轮和内部积灰比较明显。今天就拍这个过程，不讲吓人的细菌数字。\n细分类目/主营项目：家电清洗\n城市与顾客：合肥家庭用户\n专业资料/术语：进门防护、断电确认、滤网、蒸发器、风轮；不提供检测菌落数据，不承诺清洗后治病。\n创作目标：咨询留资\n文案时长：45秒`,
  },
  {
    id: "education-shy-student",
    agentId: "agent-1787153462225-md7pdv",
    agentName: "教培亲子招生编导",
    duration: "45秒",
    industryTerms: ["课堂", "老师", "孩子", "提问", "尝试"],
    goalTerms: ["试听", "咨询", "课堂", "了解"],
    message: `今日素材/想说的事：今天课堂上有个孩子一直不举手。老师没有点名逼他回答，而是把问题拆成两个更小的选择，让全班先用动作选答案。第二轮他自己举手补了一句。只讲这个课堂片段，不讲孩子姓名和成绩。\n细分类目/主营项目：少儿表达与阅读课\n城市与顾客：7到10岁孩子家长\n创作目标：专业信任\n文案时长：45秒`,
  },
  {
    id: "hotel-rain-route",
    agentId: "agent-1787153462517-rw8z92",
    agentName: "酒店民宿获客编导",
    duration: "30秒",
    industryTerms: ["民宿", "下雨", "停车", "门口", "路线"],
    goalTerms: ["入住", "预订", "到店", "客人"],
    message: `今日素材/想说的事：今天景区下雨，店员发现导航会把自驾客人带到一段不好拖行李的石板路，于是重新拍了一条从停车点到民宿门口的避雨路线，发给今晚入住的客人。\n细分类目/主营项目：景区民宿\n专业资料/术语：停车点到门口步行约三分钟，该时间是店员今天实走记录；雨天路线与晴天路线不同。\n创作目标：老板人设\n文案时长：30秒`,
  },
  {
    id: "pet-grooming-anxious-dog",
    agentId: "agent-1787153462804-ph8kxr",
    agentName: "宠物门店获客编导",
    duration: "45秒",
    industryTerms: ["狗", "洗澡", "吹风", "美容师", "紧张"],
    goalTerms: ["咨询", "到店", "主人", "服务"],
    message: `今日素材/想说的事：今天一只第一次来洗澡的小狗进门后一直缩在主人腿后。美容师没有马上抱走，而是蹲下来让它闻毛巾和工具，等它愿意往前走一步后才进入洗护区。吹风时也根据它的反应分段停下来。\n细分类目/主营项目：宠物洗护\n专业资料/术语：低压力接触、行为观察、分段适应；不诊断焦虑症，不承诺所有宠物都能一次适应。\n创作目标：专业信任\n文案时长：45秒`,
  },
];

function extractSection(text: string, heading: string, nextHeadings: string[]): string {
  const start = text.indexOf(heading);
  if (start < 0) return "";
  const contentStart = start + heading.length;
  const ends = nextHeadings.map((item) => text.indexOf(item, contentStart)).filter((index) => index >= 0);
  const end = ends.length > 0 ? Math.min(...ends) : text.length;
  return text.slice(contentStart, end).trim();
}

function evaluate(testCase: TestCase, output: string) {
  const copy = extractSection(output, "【成品文案】", ["【现场怎么拍】", "【发布标题】", "【事实提醒】"]);
  const shots = extractSection(output, "【现场怎么拍】", ["【发布标题】", "【事实提醒】"]);
  const publishTitles = extractSection(output, "【发布标题】", ["【事实提醒】"]);
  const compactCopy = copy.replace(/\s+/g, "");
  const contentLines = (value: string) => value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => Boolean(line) && !/^-{3,}$/.test(line) && !/^#+$/.test(line));
  const shotLines = contentLines(shots);
  const titleLines = contentLines(publishTitles);
  const range = testCase.duration === "30秒" ? [100, 190] : testCase.duration === "45秒" ? [145, 270] : [210, 370];
  const hardMax = testCase.duration === "30秒" ? 220 : testCase.duration === "45秒" ? 310 : 410;
  const forbiddenClaims = /百分之百|全城第一|全网最低|保证有效|保证提分|保证治好|根治|永久维持|包治|绝对不会/;
  const unsupportedInvention = /地址.{0,8}(左下角|评论区)|检查表.{0,8}(发|送)|攻略.{0,8}(发|送)|三十年|三年就|几公分|半小时|十分钟|两分钟|带着体温|微微颤动|机器冻出来|大概率.{0,8}(焦|断)|肯定漏|一定漏/;
  const genericOpening = /^(大家好|家人们|今天给大家分享|随着.{0,12}(提高|发展)|你知道吗)/;
  const industryHits = testCase.industryTerms.filter((term) => output.includes(term));
  const goalHits = testCase.goalTerms.filter((term) => output.includes(term));
  const numberedLecture = /(首先|其次|再次|最后)[，,：:]|第一[，,：:]|第二[，,：:]|第三[，,：:]/;
  const hasTurn = /但|却|不是|原来|其实|没想到|结果|才发现|真正/.test(copy);
  const hasConcretePunctuation = (copy.match(/[，。！？；]/g) || []).length >= 6;
  const actionGroups = [
    /关注/,
    /评论区|评论/,
    /私信|发给我|发我|发张|把.{0,12}发来/,
    /到店|来店|进店|来我?们?店|来.{0,4}(试穿|尝尝|体验)/,
    /预约|团购|下单/,
  ];
  const actionCount = actionGroups.filter((pattern) => pattern.test(copy)).length;

  const checks = {
    format: output.includes("标题") && Boolean(copy) && Boolean(shots) && Boolean(publishTitles),
    copyLength: compactCopy.length >= range[0] && compactCopy.length <= range[1],
    hook: Boolean(copy) && !genericOpening.test(compactCopy),
    industryEvidence: industryHits.length >= 2,
    goalAlignment: goalHits.length >= 1,
    spokenStyle: !numberedLecture.test(copy),
    narrative: hasTurn && hasConcretePunctuation,
    safety: !forbiddenClaims.test(output),
    sourceFidelity: !unsupportedInvention.test(copy) && !output.includes("【最终执行校准】"),
    singleCTA: actionCount <= 1,
    shots: shotLines.length >= 4 && shotLines.length <= 6,
    titles: titleLines.length === 3,
  };
  const weights: Record<keyof typeof checks, number> = {
    format: 10,
    copyLength: 8,
    hook: 8,
    industryEvidence: 12,
    goalAlignment: 8,
    spokenStyle: 8,
    narrative: 8,
    safety: 10,
    sourceFidelity: 12,
    singleCTA: 8,
    shots: 4,
    titles: 4,
  };
  assert.equal(Object.values(weights).reduce((total, weight) => total + weight, 0), 100);
  const score = (Object.keys(checks) as Array<keyof typeof checks>)
    .reduce((total, key) => total + (checks[key] ? weights[key] : 0), 0);
  return {
    score,
    passed: score >= 90
      && checks.format
      && checks.safety
      && checks.sourceFidelity
      && checks.singleCTA
      && compactCopy.length <= hardMax,
    copyChars: compactCopy.length,
    shotLines: shotLines.length,
    titleLines: titleLines.length,
    industryHits,
    goalHits,
    checks,
  };
}

async function main() {
  await mkdir(outDir, { recursive: true });
  const selectedCases = requestedCaseIds.size > 0
    ? cases.filter((testCase) => requestedCaseIds.has(testCase.id))
    : cases;
  assert.ok(selectedCases.length > 0, "no matching TEST_CASE_IDS were found");
  const sessionResponse = await fetch(`${baseUrl}/api/auth/dev-session`, {
    headers: { "x-local-workbench": "ai-creation-studio-local" },
  });
  const session = await sessionResponse.json() as { token?: string; error?: string; user?: { id?: string } };
  assert.ok(sessionResponse.ok && session.token, session.error || "local admin session unavailable");

  const results = [];
  for (const testCase of selectedCases) {
    const conversationId = `conv_localbiz_${testCase.id}_${Date.now()}`;
    const response = await fetch(`${baseUrl}/api/llm`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${session.token}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({
        messages: [{ role: "user", content: testCase.message }],
        agentId: testCase.agentId,
        agentName: testCase.agentName,
        model: testModel || undefined,
        model_overridden: Boolean(process.env.TEST_MODEL),
        stream: false,
        userId: session.user?.id,
        conversationId,
        maxContextRounds: 0,
        maxReplyTokens: 4096,
        timeout: 180,
        enableWebSearch: false,
        responseFormat: "markdown",
      }),
      signal: AbortSignal.timeout(240_000),
    });
    const payload = await response.json() as { error?: string; choices?: Array<{ message?: { content?: string } }> };
    assert.ok(response.ok, `${testCase.id}: ${payload.error || `HTTP ${response.status}`}`);
    const output = String(payload.choices?.[0]?.message?.content || "").trim();
    assert.ok(output, `${testCase.id}: empty model output`);
    await writeFile(path.join(outDir, `${testCase.id}.md`), `${output}\n`, "utf8");
    const evaluation = evaluate(testCase, output);
    results.push({
      id: testCase.id,
      agentId: testCase.agentId,
      agentName: testCase.agentName,
      conversationId,
      ...evaluation,
    });
    console.log(JSON.stringify({ type: "case", id: testCase.id, agentName: testCase.agentName, ...evaluation }));
  }

  const averageScore = Math.round(results.reduce((sum, item) => sum + item.score, 0) / results.length);
  const report = {
    passed: results.every((item) => item.passed),
    model: testModel || "agent-default",
    averageScore,
    passCount: results.filter((item) => item.passed).length,
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
