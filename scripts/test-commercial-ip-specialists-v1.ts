import assert from "node:assert/strict";
import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";

const baseUrl = process.env.BASE_URL || "http://127.0.0.1:5000";
const runId = new Date().toISOString().replace(/[:.]/g, "");
const outDir = path.join("research-output", `commercial-ip-specialists-v1-${runId}`);
const requestedCaseIds = new Set(
  (process.env.TEST_CASE_IDS || "").split(",").map((value) => value.trim()).filter(Boolean),
);

type AdminAgent = { id: string; name: string; category?: string };
type TestCase = {
  id: string;
  agentName: string;
  message: string;
  requiredHeadings: string[];
  specificityTerms: string[];
  forbiddenPatterns: RegExp[];
};

const cases: TestCase[] = [
  {
    id: "asset-roofing-owner",
    agentName: "个人优势盘点助手",
    message: `目前状态：已有账号，定位不清
经历与做过的事：我在贵州农村做陶瓷瓦销售和施工10年，从量房、选瓦、排瓦到脊瓦和檐口收边都在现场干。账号现在常拍工地，但视频像流水账。
技能与现有资源：每天能进工地；认识本地师傅和自建房业主；会用大白话解释檩条、挂瓦条、搭接和坡度；每周能拍4次，但不擅长剪辑。
已有证明：有真实工地过程、完工照片、厂家培训记录和部分业主允许公开的反馈；没有国家级专家资质，也没有整理成案例。
目标与限制：希望获得贵州自建房业主咨询；不夸大使用年限，不远程给统一施工尺寸。`,
    requiredHeadings: ["一句话判断", "真实资产清单", "三条资产组合路线", "推荐主路线", "证据缺口", "7天行动单", "交给下一位"],
    specificityTerms: ["陶瓷瓦", "工地", "贵州", "檩条", "搭接"],
    forbiddenPatterns: [/我是国家级专家/, /拥有国家级.{0,6}资质/, /保证.{0,8}年/, /统一给出.{0,8}(间距|尺寸)/],
  },
  {
    id: "benchmark-pet-science",
    agentName: "对标账号差异分析",
    message: `你的账号与业务：我是宠物营养师助理，想做新手养犬知识账号，未来承接宠物用品选购咨询。没有兽医执业资格。
对标账号/内容：账号甲常用“你以为是爱它，其实在害它”的反常识开头，内容多为喂养误区；账号乙用真实养犬日记开场，再请兽医解释；账号丙主页全是用品测评，优点是对比清楚，缺点是广告感重。
可核验表现：只观察到甲的误区类内容评论问题多，乙的故事内容收藏多；没有记录具体点赞和粉丝数据。
本次重点：找差异化定位
不想做的方向：不冒充兽医、不做疾病诊断、不靠吓人标题、不复制对标原句。`,
    requiredHeadings: ["拆解结论", "对标逐个看", "赛道已经挤满的地方", "你的三条差异化路线", "推荐路线", "需要补证的判断", "下一步"],
    specificityTerms: ["宠物", "新手", "兽医", "测评", "喂养"],
    forbiddenPatterns: [/粉丝.{0,8}[万亿]/, /点赞.{0,8}[万亿]/, /执业兽医身份/],
  },
  {
    id: "facade-restaurant-owner",
    agentName: "账号主页优化助手",
    message: `核心定位：成都开社区川菜馆的老板，专门讲一道家常川菜为什么这样选料、下锅和定价。
本人特点与可信经历：开店8年，老板本人出镜，说话直接但不骂人；每天在后厨，可拍备菜和出锅；没有厨师大师头衔。
受众与业务：周边3公里想吃家常川菜的上班族和家庭客；希望带来到店与团购，不做加盟。
平台：抖音
偏好与禁区：名称最好带“老周”，不要“餐饮教父、大师、全成都第一”，简介只要一句。`,
    requiredHeadings: ["门面诊断", "名称候选", "推荐主页成品", "头像与封面方向", "三条置顶内容", "主页一致性检查", "上线清单"],
    specificityTerms: ["老周", "川菜", "成都", "后厨", "到店"],
    forbiddenPatterns: [/餐饮教父/, /全成都第一/, /厨师大师/],
  },
  {
    id: "trust-home-renovation",
    agentName: "专业信任素材助手",
    message: `定位与业务：合肥做旧房局部改造的夫妻店，主要承接厨房、卫生间和墙面翻新。
现有证据：营业执照；开工保护、拆除、水电、闭水和完工照片；三份客户书面评价但没有授权公开姓名；报价单模板；没有行业大奖。
顾客最不放心什么：怕临时加价、怕隐蔽工程看不见、怕工期拖延、售后找不到人。
行业风险：工程与安全
可拍条件与限制：可以拍工地和夫妻本人；客户家门牌、人脸和联系方式不能出现；部分水电环节由持证合作师傅施工。`,
    requiredHeadings: ["信任缺口", "现有证据盘点", "证据链设计", "7天采证任务", "内容化方案", "不能说的话", "信任资产摘要"],
    specificityTerms: ["闭水", "报价", "工地", "加价", "打码"],
    forbiddenPatterns: [/零增项/, /绝不延期/, /百分之百/, /(获得|拥有).{0,8}行业大奖/],
  },
  {
    id: "ladder-pet-service",
    agentName: "产品与变现设计助手",
    message: `受众与核心问题：第一次养狗的上班族，不知道怎么选日常用品、建立喂养记录，也分不清普通行为问题和需要就医的异常信号。
现有产品/服务：目前只有一次60分钟线上用品清单咨询，定价199元；不卖药，不做诊断。
能稳定交付什么：能根据主人提供的品种、年龄、生活场景和预算整理用品选择框架，提供记录表和复盘；每周最多服务10人；有宠物营养相关课程结业证，但不是兽医。
主要目标：多层产品组合
价格与限制：核心咨询暂不降价；不能承诺改善疾病、减肥或行为治疗；出现持续呕吐、呼吸异常等情况只建议就医。`,
    requiredHeadings: ["商业判断", "问题与能力匹配", "产品阶梯", "内容到成交路径", "单句介绍", "交付与售后风险", "本周最小测试"],
    specificityTerms: ["199", "用品", "记录", "兽医", "就医"],
    forbiddenPatterns: [/治愈/, /治疗行为/, /保证减肥/, /每周.{0,4}(二十|20)人/],
  },
  {
    id: "validation-clothing-store",
    agentName: "账号定位试跑助手",
    message: `候选定位：成都通勤女装店主，帮助梨形身材上班族看懂版型，不制造身材焦虑，用真实试穿帮她少买压箱底的衣服。
账号阶段与现有数据：老号，最近30天发了12条；多数播放在900到1800，最高一条4800；评论多问尺码，私信每周约3到5个，但到店来源没记录。
可投入资源：每周能发4条，店主可露脸，有两位不同身材店员可试穿；自己剪辑，每条制作不超过2小时；可连续测试30天。
优先验证：全链路验证
不能改变的条件：门店在成都高新区，只卖现有选品，不用身材羞辱，不承诺显瘦多少斤。`,
    requiredHeadings: ["当前判断", "四个核心假设", "14天最小实验", "测试内容包", "记录表口径", "决策规则", "第30天复盘", "交接结果"],
    specificityTerms: ["梨形", "试穿", "尺码", "到店", "成都"],
    forbiddenPatterns: [/行业平均/, /必爆/, /保证显瘦/, /显瘦\s*\d+\s*(斤|公斤)/, /保证到店/],
  },
];

function evaluate(testCase: TestCase, output: string) {
  const headingHits = testCase.requiredHeadings.filter((heading) => output.includes(heading));
  const specificityHits = testCase.specificityTerms.filter((term) => output.includes(term));
  const forbiddenHits = testCase.forbiddenPatterns.filter((pattern) => pattern.test(output)).map((pattern) => String(pattern));
  const numberedLecture = /(首先|其次|再次|最后)[，,：:]|第一[，,：:]|第二[，,：:]|第三[，,：:]/;
  const vagueAdvice = /(提升影响力|打造个人品牌|持续输出优质内容|增强用户粘性|赋能账号|形成闭环)(。|；|$)/;
  const promptLeak = /system prompt|系统提示词|内部推理|隐藏质检|共同工作纪律|作为AI/;
  const selfScore = /(自评|质检分|得分)[：:]?\s*\d+/;
  const inventedCertainty = /(保证|百分之百|绝对|必然|全网第一|行业第一).{0,12}(成交|成功|有效|爆|增长|解决)/;
  const actionSignals = ["拍", "记录", "替换", "更换", "设置", "置顶", "上线", "收集", "测试", "核验", "打码", "发布", "咨询", "复盘"].filter((term) => output.includes(term));
  const checks = {
    completeFormat: headingHits.length === testCase.requiredHeadings.length,
    substantiveLength: output.replace(/\s+/g, "").length >= 850,
    specific: specificityHits.length >= 3,
    actionable: actionSignals.length >= 2,
    noUnsupportedClaims: forbiddenHits.length === 0 && !inventedCertainty.test(output),
    plainLanguage: !numberedLecture.test(output) && !vagueAdvice.test(output),
    noPromptLeak: !promptLeak.test(output) && !selfScore.test(output),
  };
  const weights: Record<keyof typeof checks, number> = {
    completeFormat: 20,
    substantiveLength: 10,
    specific: 15,
    actionable: 20,
    noUnsupportedClaims: 20,
    plainLanguage: 10,
    noPromptLeak: 5,
  };
  const score = (Object.keys(checks) as Array<keyof typeof checks>).reduce((sum, key) => sum + (checks[key] ? weights[key] : 0), 0);
  return {
    score,
    passed: score >= 90 && checks.completeFormat && checks.noUnsupportedClaims && checks.noPromptLeak,
    chars: output.replace(/\s+/g, "").length,
    headingHits,
    specificityHits,
    actionSignals,
    forbiddenHits,
    checks,
  };
}

async function main() {
  await mkdir(outDir, { recursive: true });
  const sessionResponse = await fetch(`${baseUrl}/api/auth/dev-session`, {
    headers: { "x-local-workbench": "ai-creation-studio-local" },
  });
  const session = await sessionResponse.json() as { token?: string; error?: string; user?: { id?: string } };
  assert.ok(sessionResponse.ok && session.token, session.error || "local admin session unavailable");
  const agentsResponse = await fetch(`${baseUrl}/api/admin/agents`, { headers: { Authorization: `Bearer ${session.token}` } });
  const agentsPayload = await agentsResponse.json() as { agents?: AdminAgent[]; error?: string };
  assert.ok(agentsResponse.ok && agentsPayload.agents, agentsPayload.error || "agent list unavailable");

  const results = [];
  const selectedCases = requestedCaseIds.size > 0 ? cases.filter((item) => requestedCaseIds.has(item.id)) : cases;
  assert.ok(selectedCases.length > 0, "no matching TEST_CASE_IDS were found");
  for (const testCase of selectedCases) {
    const agent = agentsPayload.agents.find((item) => item.name === testCase.agentName && item.category === "商业定位IP");
    assert.ok(agent, `${testCase.agentName} not found`);
    const conversationId = `conv_commercial_ip_${testCase.id}_${Date.now()}`;
    const response = await fetch(`${baseUrl}/api/llm`, {
      method: "POST",
      headers: { Authorization: `Bearer ${session.token}`, "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({
        messages: [{ role: "user", content: testCase.message }],
        agentId: agent.id,
        agentName: agent.name,
        stream: false,
        userId: session.user?.id,
        conversationId,
        maxContextRounds: 0,
        timeout: 180,
        enableWebSearch: false,
        responseFormat: "markdown",
      }),
      signal: AbortSignal.timeout(240_000),
    });
    const payload = await response.json() as { error?: string; choices?: Array<{ message?: { content?: string } }> };
    assert.ok(response.ok, `${testCase.id}: ${payload.error || `HTTP ${response.status}`}`);
    const output = String(payload.choices?.[0]?.message?.content || "").trim();
    assert.ok(output, `${testCase.id}: empty output`);
    await writeFile(path.join(outDir, `${testCase.id}.md`), `${output}\n`, "utf8");
    const evaluation = evaluate(testCase, output);
    results.push({ id: testCase.id, agentId: agent.id, agentName: agent.name, conversationId, ...evaluation });
    console.log(JSON.stringify({ type: "case", id: testCase.id, agentName: agent.name, ...evaluation }));
  }

  const averageScore = Math.round(results.reduce((sum, item) => sum + item.score, 0) / results.length);
  const report = {
    passed: results.every((item) => item.passed),
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
