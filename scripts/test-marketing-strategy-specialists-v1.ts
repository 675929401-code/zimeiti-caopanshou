import assert from "node:assert/strict";
import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";

const baseUrl = process.env.BASE_URL || "http://127.0.0.1:5000";
const runId = new Date().toISOString().replace(/[:.]/g, "");
const outDir = path.join("research-output", `marketing-strategy-specialists-v1-${runId}`);
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
    id: "calendar-roofing",
    agentName: "30天内容排期助手",
    message: `本月经营目标：获得贵州农村自建房业主的有效咨询，让账号不再只发工地流水账。
业务与目标顾客：做陶瓷瓦销售和施工，目标是正在选瓦、准备施工或担心返工的贵州自建房业主。
现有素材与栏目：每天能进工地；有量房、檩条、挂瓦条、搭接、脊瓦、檐口收边和完工素材；有部分业主反馈但需打码；目前没有固定栏目。
更新能力：每周4条，老板本人可出镜，每条制作不超过2小时。
节点与限制：本月有两个新工地开工；不统一给施工尺寸，不夸大使用年限，不公开业主门牌。`,
    requiredHeadings: ["本月主线", "内容结构", "营销日历", "素材准备", "批量生产节奏", "失衡提醒", "下轮复盘"],
    specificityTerms: ["贵州", "陶瓷瓦", "工地", "檩条", "搭接"],
    forbiddenPatterns: [/统一给出.{0,8}尺寸/, /保证.{0,8}使用年限/, /公开.{0,6}门牌/],
  },
  {
    id: "campaign-hotpot-weekend",
    agentName: "营销活动方案助手",
    message: `活动目标：周末增加贵阳观山湖门店到店，让第一次来的顾客愿意尝试鲜切牛肉火锅。
产品与真实权益：双人尝鲜套餐168元，包含锅底、吊龙一份、匙柄一份、时蔬一份；每天最多接待20桌套餐；套餐仅周六周日堂食使用，不与其他优惠同享。没有赠品，没有抽奖。
目标顾客与场景：周边朋友聚餐和情侣，两个人想吃牛肉火锅但担心点多浪费，也担心牛肉不新鲜。
时间与渠道：9月12日至13日；抖音短视频、门店海报、老客微信群。
预算、资源与限制：预算800元；老板和一名店员执行；可拍凌晨选肉、到店分切和上桌；不能宣传治疗、减肥或全城最低。`,
    requiredHeadings: ["活动核心", "机制设计", "三段节奏", "内容与物料", "执行时间线", "数据口径", "风险与补丁", "可直接发布的活动说明"],
    specificityTerms: ["168", "吊龙", "匙柄", "20桌", "堂食"],
    forbiddenPatterns: [/赠品.{0,4}(赠送|领取)/, /抽奖.{0,4}(参加|赢)/, /我们是全城最低|全城最低价/, /具有减肥.{0,6}(效果|功效)/],
  },
  {
    id: "objection-pet-brush",
    agentName: "顾客疑问回复助手",
    message: `产品/服务与价格：宠物日常梳毛刷59元，软硅胶梳齿，可拆洗，适合日常浮毛整理；不用于治疗皮肤病，不保证所有猫都接受。
顾客原话/常见异议：评论1“普通梳子十几块，凭什么卖59？”；评论2“会不会扯毛？”；私信“我家猫一拿梳子就跑，买了也白买”；还有人问“能不能解决掉毛”。
可用证据：有材质和尺寸资料；有梳齿弯曲演示、拆洗过程、同一只猫自愿靠近和离开的完整视频；没有兽医背书，没有治疗或减少掉毛比例的数据。
使用场景：全部场景
承诺边界：不能诊断皮肤问题；不能承诺猫一定配合；异常脱毛、红肿或疼痛建议咨询兽医。`,
    requiredHeadings: ["核心判断", "异议地图", "场景回应", "应该劝退的人", "补证清单", "异议内容化", "销售使用卡"],
    specificityTerms: ["59", "硅胶", "扯毛", "掉毛", "兽医"],
    forbiddenPatterns: [/本产品保证.{0,6}(配合|接受)/, /减少掉毛\s*\d+%/, /获得兽医推荐|兽医联合推荐/, /可以治疗.{0,6}皮肤病/],
  },
  {
    id: "private-renovation-leads",
    agentName: "客户跟进流程助手",
    message: `线索来源：抖音评论和私信，少量门店扫码；评论里常问“卫生间翻新多少钱”。
业务与目标顾客：合肥旧房局部改造，主要做厨房和卫生间；目标顾客是已有房屋、准备三个月内开工的本地业主，通常需要先看现场再报价。
当前承接方式：老板看到私信就加微信，直接问地址和预算；没有表格，经常忘记谁约过量房，也会重复问同样的问题。
人员与工具：夫妻两人；用微信和共享表格；工作日每天能处理15条线索；量房由老板负责。
隐私与禁区：公开评论不问具体住址；未授权不拉群；晚上9点后不主动跟进；不承诺未看现场的固定报价。`,
    requiredHeadings: ["当前断点", "承接路径", "线索分级", "场景话术", "最小记录表", "防骚扰与隐私", "7天落地", "交给复盘"],
    specificityTerms: ["合肥", "量房", "微信", "共享表格", "住址"],
    forbiddenPatterns: [/评论区.{0,12}(发送|留下|公开).{0,6}住址/, /保证.{0,6}固定报价/, /晚上9点后.{0,8}主动/],
  },
  {
    id: "ab-fashion-hook",
    agentName: "营销方案对比助手",
    message: `想优化什么：提高成都通勤女装短视频带来的有效私信，不只追播放。
当前版本与表现：最近8条都用“梨形身材这样穿更显瘦”开头，平均播放约1500，每条私信0到2个，多数只问价格；结尾都是“喜欢就来店里看看”。
可测试素材/方案：素材都有同一位店员试穿同一条高腰微阔直筒裤；可测试开头A“梨形身材别先看裤腿宽不宽”，开头B“上班坐一天，这条裤子最容易卡的不是腰”；CTA可另轮测试“私信发身高和常穿尺码”与“到店报通勤试穿”。
流量与测试周期：每周4条，可测试14天，不投流。
必须保持不变：同一款裤子、同一店员、相近时长、相近发布时间、价格不变；不承诺显瘦多少斤。`,
    requiredHeadings: ["测试结论", "基线检查", "主实验", "备选实验队列", "版本示例", "决策规则", "测试记录卡"],
    specificityTerms: ["梨形", "私信", "同一", "14天", "CTA"],
    forbiddenPatterns: [/保证.{0,6}私信/, /显瘦\s*\d+\s*斤/, /行业平均/],
  },
  {
    id: "review-restaurant-funnel",
    agentName: "经营数据复盘助手",
    message: `本周期目标：两周内用12条短视频带来30个有效咨询和15桌到店。
实际数据：实际发布10条，总播放32000；点赞860、收藏190、评论140；私信42条，其中明确问地址、套餐或预约的有效咨询18条；预约8桌，到店6桌，成交5桌；有1桌临时取消；未记录每桌来自哪条视频。无退款。
做过的动作与异常：前6条是后厨食材内容，后4条加入套餐与门店位置；第2周店员休息，私信平均4小时后才回复；周五一条视频播放12000，但评论多是讨论切肉，没有问门店。
对比基线：上一个两周周期发8条，总播放18000，有效咨询14条，到店5桌，成交4桌。
下周期限制：仍只能发每周5条；老板和一名店员；不增加投流预算；套餐和价格暂时不变。`,
    requiredHeadings: ["一句话诊断", "数据体检", "漏斗定位", "原因排序", "保留与停止", "下周期行动", "下周期看板", "复盘结论卡"],
    specificityTerms: ["32000", "18条", "6桌", "4小时", "12000"],
    forbiddenPatterns: [/行业平均/, /一定是.{0,12}(回复|内容|套餐)/, /保证.{0,8}(到店|成交)/],
  },
];

function evaluate(testCase: TestCase, output: string) {
  const headingHits = testCase.requiredHeadings.filter((heading) => output.includes(heading));
  const specificityHits = testCase.specificityTerms.filter((term) => output.includes(term));
  const forbiddenHits = testCase.forbiddenPatterns.filter((pattern) => pattern.test(output)).map((pattern) => String(pattern));
  const actionSignals = ["拍", "记录", "发布", "回复", "确认", "准备", "分级", "跟进", "停止", "保留", "测试", "复盘", "核验", "打码", "负责人", "建议", "补证", "先问"].filter((term) => output.includes(term));
  const numberedLecture = /(首先|其次|再次|最后)[，,：:]|第一[，,：:]|第二[，,：:]|第三[，,：:]/;
  const vagueAdvice = /(提升曝光|增强粘性|持续优化|形成闭环|赋能经营)(。|；|$)/;
  const promptLeak = /system prompt|系统提示词|内部推理|隐藏质检|共同规则|作为AI/;
  const selfScore = /(自评|质检分|得分)[：:]?\s*\d+/;
  const inventedCertainty = /(百分之百|绝对|必然|全网第一|行业第一).{0,12}(成交|成功|有效|爆|增长|解决)/;
  const checks = {
    completeFormat: headingHits.length === testCase.requiredHeadings.length,
    substantiveLength: output.replace(/\s+/g, "").length >= 800,
    specific: specificityHits.length >= 3,
    actionable: actionSignals.length >= 3,
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
  const selectedCases = requestedCaseIds.size > 0 ? cases.filter((item) => requestedCaseIds.has(item.id)) : cases;
  assert.ok(selectedCases.length > 0, "no matching TEST_CASE_IDS were found");

  const results = [];
  for (const testCase of selectedCases) {
    const agent = agentsPayload.agents.find((item) => item.name === testCase.agentName && item.category === "营销策略");
    assert.ok(agent, `${testCase.agentName} not found`);
    const conversationId = `conv_marketing_strategy_${testCase.id}_${Date.now()}`;
    let response: Response | undefined;
    let payload: { error?: string; choices?: Array<{ message?: { content?: string } }> } = {};
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      response = await fetch(`${baseUrl}/api/llm`, {
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
      payload = await response.json() as typeof payload;
      if (response.ok) break;
      if (![429, 502, 503, 504].includes(response.status) || attempt === 3) break;
      await new Promise((resolve) => setTimeout(resolve, attempt * 2000));
    }
    assert.ok(response?.ok, `${testCase.id}: ${payload.error || `HTTP ${response?.status || "unknown"}`}`);
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
