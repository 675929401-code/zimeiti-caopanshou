import assert from "node:assert/strict";
import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";

const baseUrl = process.env.BASE_URL || "http://127.0.0.1:5000";
const runId = new Date().toISOString().replace(/[:.]/g, "");
const outDir = path.join("research-output", `copy-structure-agents-v1-${runId}`);

type AdminAgent = { id: string; name: string; category?: string };
type Method = "summary" | "opinion" | "story" | "empathy" | "checklist";
type TestCase = {
  id: string;
  agentName: string;
  method: Method;
  initialMessage: string;
  followUp?: string;
  firstStageType?: "menu" | "breakdown";
  specificityTerms: string[];
  forbiddenPatterns: RegExp[];
};

const cases: TestCase[] = [
  {
    id: "summary-roofing-direct",
    agentName: "总分总文案师",
    method: "summary",
    initialMessage: `你的领域和身份：贵州做农村自建房陶瓷瓦销售与施工的老板，平时在真实工地拍视频。
主题/原始素材：很多业主只盯着瓦片单价，却忽略檩条是否平整、挂瓦条间距是否按所用瓦型确定、脊瓦和檐口有没有收好。材料再贵，基层和节点没做好，后面也容易返工。不同屋面情况不同，具体尺寸必须按图纸、产品要求和现场复核，不能给统一数值。
想写给谁看：正在选瓦或准备开工的贵州农村自建房业主。
创作方式：A 直接写成品`,
    specificityTerms: ["贵州", "陶瓷瓦", "檩条", "挂瓦条", "脊瓦", "檐口"],
    forbiddenPatterns: [/统一.{0,6}(尺寸|间距)/, /保证.{0,8}(不漏|不返工)/, /使用寿命.{0,4}\d+/],
  },
  {
    id: "opinion-pet-interactive",
    agentName: "观点冲突文案师",
    method: "opinion",
    initialMessage: `你的领域和身份：做犬只日常行为科普的宠物店主，不做医疗诊断。
主题/原始素材：有人说狗在门口叫就是凶。我的观察是，门铃、陌生人靠近、兴奋和害怕都可能让狗叫，单看叫声不能判断攻击性。还要看身体僵不僵、是否后退、尾巴和耳朵状态、能不能被主人引导离开。若已经出现扑咬或主人控制不了，应找合格训犬师或兽医行为专业人员评估。
想写给谁看：一听狗叫就紧张的新手养狗人。
创作方式：B 先给4个写作角度`,
    followUp: "C",
    firstStageType: "menu",
    specificityTerms: ["门铃", "狗叫", "攻击性", "身体", "扑咬", "训犬师"],
    forbiddenPatterns: [/狗叫.{0,6}(一定|就是).{0,4}攻击/, /保证.{0,8}(不叫|不咬)/, /能够治疗|行为治疗效果/],
  },
  {
    id: "story-restaurant-interactive",
    agentName: "故事反转文案师",
    method: "story",
    initialMessage: `你的领域和身份：贵阳一家鲜切牛肉火锅店老板。
主题/原始素材：上周六中午，一位顾客进门先问有没有“越红越新鲜”的牛肉。店员没有直接反驳，而是把当天进货记录给他看，又让后厨现场切了一盘吊龙。顾客发现不同部位颜色会有差别，最后点了双人餐，但我们没有记录他之后的评价。这个故事只能使用这些真实经过，不能补顾客原话和反馈。
想写给谁看：喜欢牛肉火锅但不会判断食材的新顾客。
创作方式：C 先拆素材再写`,
    followUp: "按推荐方向写",
    firstStageType: "breakdown",
    specificityTerms: ["贵阳", "牛肉火锅", "进货记录", "吊龙", "颜色", "双人餐"],
    forbiddenPatterns: [/顾客说[：“\"]/, /吃完.{0,12}(夸|称赞|满意|回购)/, /最新鲜|百分之百新鲜/],
  },
  {
    id: "empathy-fashion-interactive",
    agentName: "场景共鸣文案师",
    method: "empathy",
    initialMessage: `你的领域和身份：成都通勤女装店主，擅长帮顾客按工作场景试穿，不承诺显瘦多少斤。
主题/原始素材：很多上班族早上站在衣柜前，拿起一件衬衫又放下。不是没衣服，而是担心坐地铁会皱、办公室空调冷、见客户不够利落。我们店里会先问通勤方式、坐班时长和当天有没有正式会面，再决定推荐衬衫、针织开衫还是外套。
想写给谁看：25到35岁、每天通勤又不想花太多时间搭配的女性。
创作方式：D 不确定，帮我判断`,
    followUp: "B",
    firstStageType: "menu",
    specificityTerms: ["成都", "衣柜", "地铁", "空调", "客户", "衬衫", "针织"],
    forbiddenPatterns: [/显瘦\s*\d+\s*斤/, /保证.{0,8}(不起皱|显瘦|高级)/, /所有上班族/],
  },
  {
    id: "checklist-renovation-direct",
    agentName: "清单干货文案师",
    method: "checklist",
    initialMessage: `你的领域和身份：合肥做旧房卫生间局部翻新的施工负责人。
主题/原始素材：想写一份“拆除前先确认什么”的清单。可用事实：确认物业允许施工的时间；关闭并确认水电位置；提前保护电梯、走道和不拆区域；和业主确认保留的洁具；拍照记录原有渗水、空鼓或破损。墙内情况拆开前不能保证，涉及结构和燃气不得自行处理。
想写给谁看：准备翻新老房卫生间、担心施工扯皮的本地业主。
创作方式：A 直接写成品`,
    specificityTerms: ["合肥", "卫生间", "物业", "水电", "电梯", "洁具", "渗水"],
    forbiddenPatterns: [/保证.{0,8}(没有增项|不渗水|不扯皮)/, /墙内.{0,8}(肯定|一定).{0,6}没问题/, /自行处理.{0,6}(结构|燃气)/],
  },
];

async function callAgent(token: string, userId: string | undefined, agent: AdminAgent, conversationId: string, messages: Array<{ role: "user" | "assistant"; content: string }>) {
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
        maxContextRounds: 20,
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
  assert.ok(response?.ok, payload.error || `HTTP ${response?.status || "unknown"}`);
  const output = String(payload.choices?.[0]?.message?.content || "").trim();
  assert.ok(output, `${agent.name} returned empty output`);
  return output;
}

function validateFirstStage(output: string, type: "menu" | "breakdown"): boolean {
  const noFinishedBody = !/^[#*\s]*正文[：:]/m.test(output);
  const concise = output.replace(/\s+/g, "").length <= 1200;
  if (type === "breakdown") {
    const hasBreakdown = /(能用的事实|可用事实)/.test(output)
      && /(矛盾|信息)/.test(output)
      && /(还缺|不缺关键事实)/.test(output)
      && /推荐写法/.test(output);
    return hasBreakdown && noFinishedBody && concise;
  }
  const hasChoices = ["A", "B", "C", "D"].every((choice) => new RegExp(`^.{0,16}${choice}[.、：:\\s]`, "m").test(output));
  return hasChoices && noFinishedBody && concise;
}

function validateMethod(method: Method, output: string): boolean {
  if (method === "summary") {
    const body = output.split(/备用开头/)[0] || output;
    const paragraphCount = body.split(/\n\s*\n/).filter((paragraph) => paragraph.replace(/[#*\s]/g, "").length >= 20).length;
    const ending = body.slice(-180);
    return paragraphCount >= 4 && /(所以|记住|别只|先看|真正|才)/.test(ending);
  }
  if (method === "opinion") {
    return /(不是|别急着|不能|真话|误会|判断)/.test(output) && /(如果|要是|一旦|除非|还要看|前提)/.test(output);
  }
  if (method === "story") {
    return /(上周六|中午|进门|店员|后厨)/.test(output) && /(其实|不是单靠|不同部位|所以|但|结果)/.test(output);
  }
  if (method === "empathy") {
    return /(早上|站在衣柜前|拿起|放下)/.test(output) && /(不是没衣服|担心|纠结|真正)/.test(output);
  }
  const bulletCount = (output.match(/^\s*[-•]\s+/gm) || []).length;
  const labelCount = (output.match(/^\s*[「【][^」】]{2,12}[」】]/gm) || []).length;
  return bulletCount + labelCount >= 3 && /(适合|准备|拆除前|先确认)/.test(output);
}

function evaluate(testCase: TestCase, finalOutput: string, firstStageOutput?: string) {
  const compactLength = finalOutput.replace(/\s+/g, "").length;
  const specificityHits = testCase.specificityTerms.filter((term) => finalOutput.includes(term));
  const forbiddenHits = testCase.forbiddenPatterns.filter((pattern) => pattern.test(finalOutput)).map(String);
  const fixedFormat = /^[#*\s]*标题(?:[：:]|[*\s]*$)/m.test(finalOutput)
    && /^[#*\s]*正文(?:[：:]|[*\s]*$)/m.test(finalOutput)
    && /^[#*\s]*备用开头(?:[：:]|[*\s]*$)/m.test(finalOutput)
    && ["A", "B", "C"].every((choice) => new RegExp(`^.{0,12}${choice}[.、]`, "m").test(finalOutput));
  const lectureStyle = /(首先|其次|再次|最后)[，,：:]|第一[，,：:]|第二[，,：:]|第三[，,：:]/;
  const promptLeak = /系统提示词|内部推理|隐藏质检|四种交互路径|作为AI|语言模型|自评分|质检分/;
  const unsupportedCertainty = /(百分之百|绝对|全网第一|行业第一|唯一选择|保证有效)/;
  const checks = {
    fixedFormat,
    methodComplete: validateMethod(testCase.method, finalOutput),
    domainSpecific: specificityHits.length >= 3,
    factSafe: forbiddenHits.length === 0 && !unsupportedCertainty.test(finalOutput),
    plainspoken: !lectureStyle.test(finalOutput),
    usefulLength: compactLength >= 260 && compactLength <= 1800,
    noPromptLeak: !promptLeak.test(finalOutput),
    interactionCorrect: firstStageOutput && testCase.firstStageType
      ? validateFirstStage(firstStageOutput, testCase.firstStageType)
      : !firstStageOutput,
  };
  const weights: Record<keyof typeof checks, number> = {
    fixedFormat: 20,
    methodComplete: 20,
    domainSpecific: 15,
    factSafe: 20,
    plainspoken: 10,
    usefulLength: 5,
    noPromptLeak: 5,
    interactionCorrect: 5,
  };
  const score = (Object.keys(checks) as Array<keyof typeof checks>).reduce((sum, key) => sum + (checks[key] ? weights[key] : 0), 0);
  return {
    score,
    passed: score >= 90 && checks.fixedFormat && checks.factSafe && checks.interactionCorrect && checks.noPromptLeak,
    chars: compactLength,
    specificityHits,
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
  for (const testCase of cases) {
    const agent = agentsPayload.agents.find((item) => item.name === testCase.agentName && item.category === "引流带货");
    assert.ok(agent, `${testCase.agentName} not found`);
    const conversationId = `conv_copy_structure_${testCase.id}_${Date.now()}`;
    const initialOutput = await callAgent(session.token, session.user?.id, agent, conversationId, [
      { role: "user", content: testCase.initialMessage },
    ]);
    let finalOutput = initialOutput;
    let firstStageOutput: string | undefined;
    if (testCase.followUp) {
      firstStageOutput = initialOutput;
      finalOutput = await callAgent(session.token, session.user?.id, agent, conversationId, [
        { role: "user", content: testCase.initialMessage },
        { role: "assistant", content: initialOutput },
        { role: "user", content: testCase.followUp },
      ]);
      await writeFile(path.join(outDir, `${testCase.id}-step1.md`), `${initialOutput}\n`, "utf8");
    }
    await writeFile(path.join(outDir, `${testCase.id}-final.md`), `${finalOutput}\n`, "utf8");
    const evaluation = evaluate(testCase, finalOutput, firstStageOutput);
    results.push({
      id: testCase.id,
      agentId: agent.id,
      agentName: agent.name,
      conversationId,
      interactionMode: testCase.followUp ? "progressive" : "direct",
      ...evaluation,
    });
    console.log(JSON.stringify({ type: "case", id: testCase.id, agentName: agent.name, ...evaluation }));
  }

  const averageScore = Math.round(results.reduce((sum, item) => sum + item.score, 0) / results.length);
  const report = {
    passed: results.every((item) => item.passed),
    averageScore,
    passCount: results.filter((item) => item.passed).length,
    total: results.length,
    progressiveCases: results.filter((item) => item.interactionMode === "progressive").length,
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
