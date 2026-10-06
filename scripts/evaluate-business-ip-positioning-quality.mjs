import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseRepairableJson } from './repair-llm-json-output.mjs';

const origin = String(process.env.LOCAL_NAV_ORIGIN || 'http://127.0.0.1:5000').replace(/\/$/u, '');
const token = String(process.env.LOCAL_NAV_ADMIN_TOKEN || '').trim();
const phase = String(process.argv.find(argument => argument.startsWith('--phase='))?.slice(8) || 'quality-current');
const onlyCase = String(process.argv.find(argument => argument.startsWith('--case='))?.slice(7) || '');
const skipJudge = process.argv.includes('--skip-judge');
const resume = process.argv.includes('--resume');
const positioningAgentId = 'agent-1787079707230-h0sdiq';
const judgeModel = {
  model: 'claude-sonnet-4-6',
  modelId: '06c15d07-9fbc-4034-9c1d-02b1c76aba30',
};
const outputDirectory = path.resolve('.codex-evidence/business-ip-positioning-quality-2.1.0', phase);

assert.ok(token, 'LOCAL_NAV_ADMIN_TOKEN is required');
assert.match(phase, /^[a-z0-9-]+$/u, 'Safe phase name required');
await fs.mkdir(outputDirectory, { recursive: true });

const fullReportRequest = `资料够用，请直接给完整报告，不再追问。严格使用以下十三段，不改名、不合并、不漏项：
0. 本次处理路线
1. 商业定位结论
2. 确认事实与待验证假设
3. 候选方向与八项证据灯
4. 目标人群与核心任务
5. 内容定位与3个内容支柱
6. 商业路径与承接顺序
7. 14天低成本验证计划
8. 决策标准与风险边界
9. 账号主页包装交接卡
10. 内容选题策划交接卡
11. 咨询回复业务数据基础卡
12. 项目接力摘要
没有提供的产品、价格、客户成绩、服务流程、平台数据和承诺不能自行补写；不清楚的内容标待验证。推荐方向给具体的拟测试差异抓手；把已提供的每周时间或频次换算成试跑产能；在第10段按3个内容支柱各给3个不重复的首批题目草稿。`;

const cases = [
  {
    id: 'zero-direction-caregiver',
    mode: 'full-report',
    expectedRoute: ['从零个人', '职业技能'],
    profile: '8年幼师、现在在家带娃、亲友常问亲子沟通；本人可出镜但孩子不能出镜；每周6小时；没有产品客户课程。',
    prompt: `我现在完全不知道抖音应该做什么。做过8年幼师，现在在家带娃，亲友常问我孩子不听话、亲子沟通的问题。我本人可以出镜，但孩子不能出镜，每周最多6小时。我没有产品、客户、课程和学员案例，只想先找到一个能长期讲、以后可能形成副业的方向。\n\n${fullReportRequest}`,
    preserve: ['8年幼师', '孩子不能出镜', '每周6小时', '没有产品'],
    forbidden: ['已有课程', '学员反馈', '付费社群', '保证改善', '孩子出镜'],
  },
  {
    id: 'multi-direction-choice',
    mode: 'full-report',
    expectedRoute: ['职业技能'],
    profile: '5年财务、Excel熟练、喜欢家常菜；两个方向取舍；不露脸、录屏配音、每周8小时；没有课程学员和定价。',
    prompt: `我做过5年财务，Excel比较熟，也喜欢做家常菜，现在在“Excel职场技巧”和“普通人做饭”之间拿不准。手里只有自己整理的脱敏Excel案例，没有课程、学员成绩和定价；不想露脸，可以录屏和配音；每周8小时。请明确比较后选一个主方向，不要两边都说好。\n\n${fullReportRequest}`,
    preserve: ['5年财务', '不露脸', '录屏', '每周8小时', '脱敏'],
    forbidden: ['已有学员', '课程定价', '保证变现', '财税咨询服务'],
  },
  {
    id: 'professional-privacy-limit',
    mode: 'full-report',
    expectedRoute: ['职业技能'],
    profile: '制造业质检员7年；擅长发现流程错误；不能拍工厂、产品、客户资料；只能画示意图或讲通用方法；每周3小时。',
    prompt: `我在制造业做了7年质检，擅长从流程里找错误，朋友也会问我怎么做检查清单。但公司不允许拍工厂、产品、文件或客户资料，我也不能透露公司名称，只能画示意图、做桌面演示或讲通用方法。每周只有3小时，希望做一个不违反保密要求的知识账号。\n\n${fullReportRequest}`,
    preserve: ['7年质检', '不能拍工厂', '不能透露', '每周3小时'],
    forbidden: ['工厂实拍', '客户案例展示', '公司案例', '公开内部文件'],
  },
  {
    id: 'local-cleaning-merchant',
    mode: 'full-report',
    expectedRoute: ['实体本地'],
    profile: '无锡开荒/入住保洁、3人团队、服务无锡市区、现场报价、每周3条、老板出镜；不能保证所有污渍去除、无固定优惠。',
    prompt: `我在无锡做开荒保洁和入住保洁，3个人的小团队，只服务无锡市区。价格必须看面积和现场情况，不能先报固定价。客户最常问多少钱、顽固污渍能不能处理干净。我们有可匿名使用的前后对比照片和工具过程，老板能出镜，每周能拍3条，但不能保证所有污渍都能去掉，也没有固定优惠。目标是获得同城有效咨询。\n\n${fullReportRequest}`,
    preserve: ['无锡', '3个人', '现场情况', '每周3条', '不能保证'],
    forbidden: ['免费上门', '固定低价', '所有污渍', '全市免费', '无效退款'],
  },
  {
    id: 'online-b2b-product',
    mode: 'full-report',
    expectedRoute: ['线上业务'],
    profile: '小微企业对账工具；真实功能是CSV导入、差异标记、人工复核；无客户成功数据、无公开价格；创始人录屏不露脸，每周5小时。',
    prompt: `我们有一个给小微企业财务用的线上对账工具。现在确认的功能只有CSV导入、标记差异、再由人手复核；没有客户成功数据，也没有公开价格，不能宣传自动完成对账。创始人不露脸，可以录屏讲流程，每周5小时。想通过抖音先验证哪些对账问题最值得解决，再获取产品试用咨询。\n\n${fullReportRequest}`,
    preserve: ['CSV导入', '标记差异', '人工复核', '没有客户成功数据', '每周5小时'],
    forbidden: ['自动完成对账', '三秒对账', '客户提升', '免费试用', '准确率'],
  },
  {
    id: 'existing-homestay-account',
    mode: 'full-report',
    expectedRoute: ['已有账号重定位'],
    profile: '大理民宿账号6800粉；风景视频播放高但咨询少；房型和交通问答播放一般却有具体私信；老板出镜，每周4条；只做自家民宿，不做旅游团购。',
    prompt: `我有一个大理民宿抖音号，6800粉。过去主要发风景和日常，风景视频播放相对高但咨询少；介绍房型、交通和入住问题的视频播放一般，却会收到具体私信。老板愿意出镜，每周能拍4条。我们只经营自家民宿，不做旅游团购，也没有完整的成交归因数据。希望重新定位，但不要把原来账号全部推倒。\n\n${fullReportRequest}`,
    preserve: ['6800粉', '风景', '咨询少', '每周4条', '不做旅游团购'],
    forbidden: ['成交率', '旅游团购', '推倒重来', '保证入住率'],
  },
  {
    id: 'regulated-health-boundary',
    mode: 'full-report',
    expectedRoute: ['职业技能'],
    profile: '持证护士10年；只做大众就医准备和照护常识；不在线诊断、不展示患者、不承诺疗效；每周4小时。',
    prompt: `我是持证护士，工作10年，想做大众就医准备、住院物品和家属照护常识。我不能在线诊断、不能展示患者或工作单位内部信息，也不能承诺疗效；目前没有课程、商品和咨询服务，每周4小时。请帮我判断这条路怎么做才有价值又不越界。\n\n${fullReportRequest}`,
    preserve: ['持证护士', '10年', '不能在线诊断', '不能展示患者', '每周4小时'],
    forbidden: ['在线问诊', '保证疗效', '患者案例', '用药建议', '诊断服务'],
  },
  {
    id: 'minimal-guided-interview',
    mode: 'guided-interview',
    expectedRoute: [],
    profile: '用户只说想做抖音但完全没方向，没有其他事实。',
    prompt: '我想做抖音，但我完全不知道做什么，也不知道自己有什么优势。你先带着我梳理。',
    preserve: [],
    forbidden: ['产品是什么', '服务范围', '客户画像', '价格多少', '咨询入口'],
  },
];

const selectedCases = onlyCase ? cases.filter(testCase => testCase.id === onlyCase) : cases;
assert.ok(selectedCases.length > 0, `Unknown case: ${onlyCase}`);

const reportDimensions = [
  ['route_accuracy', '路线识别准确且理由成立', 1.2],
  ['main_direction', '主方向具体、明确、能做决定', 1.6],
  ['fact_grounding', '结论扎根用户真实经历与资源', 1.8],
  ['uncertainty', '事实、建议、假设和未知分开', 1.5],
  ['candidate_comparison', '候选比较有取舍而非都说好', 1.2],
  ['audience_task', '人群由场景与任务描述，不乱编人口属性', 1.5],
  ['differentiation', '差异来自真实资产，不是空泛人设词', 1.2],
  ['topic_endurance', '能证明30题续航及素材来源', 1.2],
  ['content_pillars', '三个内容支柱边界清楚且不重叠', 1.2],
  ['commercial_fit', '商业路径与当前能力和阶段匹配', 1.5],
  ['experiment_plan', '14天计划动作具体、工作量可执行', 1.5],
  ['decision_thresholds', '继续、调整、停止标准可观察', 1.3],
  ['resource_feasibility', '尊重时间、出镜、地域、产能和隐私限制', 1.5],
  ['compliance_safety', '行业、隐私、资质和承诺边界稳妥', 1.5],
  ['no_fabrication', '不编产品、价格、案例、成绩、数据或流程', 2],
  ['packaging_handoff', '包装接力卡可直接用于昵称简介头像', 1.1],
  ['topic_handoff', '选题接力卡可直接生成题库和简报', 1.1],
  ['plain_language', '大白话、重点清楚、没有术语堆砌', 1.2],
  ['internal_consistency', '各段结论一致，没有路线或承诺冲突', 1.5],
  ['decision_value', '用户看完知道先做什么及为什么', 1.8],
];

const guidedDimensions = [
  ['one_question', '一次只问一个决定性问题', 2],
  ['plain_language', '问题接地气且容易回答', 1.5],
  ['examples', '给简单例子或说明不知道也可以', 1],
  ['no_premature_answer', '资料不足时不武断定位', 1.5],
  ['no_business_presupposition', '不先逼问产品客户价格服务', 2],
  ['answer_flexibility', '允许自由回答而不是锁死选项', 1],
  ['warm_efficiency', '简短直接，不讲长篇方法', 1],
  ['next_step_clarity', '用户清楚回答后会发生什么', 1],
];

function parseSse(raw) {
  let content = '';
  let completed = false;
  let billingComplete = false;
  let modelError = '';
  for (const line of raw.split(/\r?\n/u)) {
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (data === '[DONE]') {
      completed = true;
      continue;
    }
    try {
      const event = JSON.parse(data);
      content += event.choices?.[0]?.delta?.content || event.content || '';
      if (event.billing_complete) billingComplete = true;
      if (event.error) modelError = `${event.code || 'MODEL_ERROR'}:${event.error}`;
    } catch {
      // Keepalive and non-JSON SSE records carry no answer text.
    }
  }
  return { content, completed, billingComplete, modelError };
}

async function callLlm(body, label, timeout = 300_000) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const clientRequestId = `bip-quality-${label}-${randomUUID()}`;
      const response = await fetch(`${origin}/api/llm`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          Origin: origin,
          'Idempotency-Key': clientRequestId,
        },
        body: JSON.stringify({
          ...body,
          stream: true,
          client_request_id: clientRequestId,
        }),
        signal: AbortSignal.timeout(timeout),
      });
      const raw = await response.text();
      const parsed = parseSse(raw);
      assert.ok(response.ok && parsed.completed && !parsed.modelError && parsed.content.length > 20,
        `${label} failed: status=${response.status} complete=${parsed.completed} error=${parsed.modelError}`);
      return { httpStatus: response.status, ...parsed, attempt };
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      const retryable = /LLM_UPSTREAM_ERROR|temporarily|timeout|fetch failed|ECONNRESET|ETIMEDOUT/u.test(message);
      if (!retryable || attempt === 3) throw error;
      console.warn(JSON.stringify({ label, attempt, retrying: true, reason: message.slice(0, 240) }));
      await new Promise(resolve => setTimeout(resolve, attempt * 1_000));
    }
  }
  throw lastError;
}

function deterministicAudit(testCase, output) {
  const sectionNames = [
    '本次处理路线', '商业定位结论', '确认事实与待验证假设', '候选方向与八项证据灯',
    '目标人群与核心任务', '内容定位与3个内容支柱', '商业路径与承接顺序', '14天低成本验证计划',
    '决策标准与风险边界', '账号主页包装交接卡', '内容选题策划交接卡', '咨询回复业务数据基础卡', '项目接力摘要',
  ];
  if (testCase.mode === 'guided-interview') {
    const questionCount = (output.match(/[？?]/gu) || []).length;
    return {
      questionCount,
      asksOneQuestion: questionCount === 1,
      avoidsFullReport: sectionNames.filter(name => output.includes(name)).length === 0,
      avoidsBusinessPresupposition: testCase.forbidden.every(term => !output.includes(term)),
      allowsUnknown: /不知道|说不清|想不到|都可以/u.test(output),
      explainsNextStep: /回答后|说完后|接下来|下一步|再帮你|再从|再一起|会帮我.{0,18}(?:判断|找出|筛选)/u.test(output),
      concise: output.length >= 30 && output.length <= 500,
    };
  }
  const exactSections = Object.fromEntries(sectionNames.map(name => [name, output.includes(name)]));
  const preserveHits = Object.fromEntries(testCase.preserve.map(term => [term, output.includes(term)]));
  const boundaryLanguage = /(?:禁用|禁止|不得|不能|不要|不应|不建议|不编造|不保证|避免|不可|不允许|不承诺|未提供|没有|尚无|未知|待核实|风险边界)/u;
  const outputLines = output.split(/\r?\n/u);
  const forbiddenMentions = testCase.forbidden.filter(term => output.includes(term));
  const forbiddenClaims = testCase.forbidden.filter(term => outputLines.some(line => line.includes(term) && !boundaryLanguage.test(line)));
  const routeHit = testCase.expectedRoute.some(route => output.includes(route));
  const certaintyPattern = /(保证|百分之百|100%|一定能|必然|零风险|绝对有效)/u;
  const unsupportedCertainty = outputLines.some(line => certaintyPattern.test(line) && !boundaryLanguage.test(line));
  const observationSignals = /(继续条件|调整条件|停止条件|观察信号|验证信号|判断标准)/u.test(output);
  const allEvidenceLights = ['真实积累', '需求证据', '30题续航', '生产可行', '信任证据', '差异记忆', '商业承接', '合规风险']
    .every(name => output.includes(name));
  return {
    exactSections,
    sectionCoverage: Object.values(exactSections).filter(Boolean).length / sectionNames.length,
    preserveHits,
    preserveCoverage: Object.values(preserveHits).filter(Boolean).length / Math.max(1, testCase.preserve.length),
    forbiddenMentions,
    forbiddenClaims,
    routeHit,
    allEvidenceLights,
    observationSignals,
    mentionsTestDifferentiator: /拟测试差异抓手|拟测试差异/u.test(output),
    mentionsCapacityCalculation: /试跑产能测算|产能测算|产能预算|每条预计耗时|每条.*分钟/u.test(output),
    mentionsFirstNineTopics: /首批9个题目|首批9题|9个题目草稿|下列9题|T-001[—-]T-009/u.test(output),
    unsupportedCertainty,
    mentionsPendingValidation: /待验证/u.test(output),
    charCount: output.length,
  };
}

function extractJson(text) {
  return parseRepairableJson(text);
}

const agentResponse = await fetch(`${origin}/api/bots?shape=agents`, {
  headers: { Authorization: `Bearer ${token}` },
  signal: AbortSignal.timeout(20_000),
});
assert.equal(agentResponse.ok, true, `Agent readback failed: ${agentResponse.status}`);
const agentsPayload = await agentResponse.json();
const agent = (agentsPayload.agents || agentsPayload || []).find(candidate => candidate.id === positioningAgentId);
assert.equal(agent?.name, '商业IP定位');

const generated = [];
for (const testCase of selectedCases) {
  const outputPath = path.join(outputDirectory, `${testCase.id}.md`);
  let result;
  if (resume) {
    try {
      const content = (await fs.readFile(outputPath, 'utf8')).trim();
      assert.ok(content.length > 20, `Incomplete resumed output: ${testCase.id}`);
      result = { httpStatus: 200, completed: true, billingComplete: true, content, modelError: '', attempt: 0, reused: true };
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  if (!result) {
    result = await callLlm({
      agentId: positioningAgentId,
      conversationId: `bip-quality-${phase}-${testCase.id}-${randomUUID()}`,
      messages: [{ role: 'user', content: testCase.prompt }],
    }, `generate-${testCase.id}`);
    await fs.writeFile(outputPath, `${result.content}\n`, 'utf8');
  }
  const record = {
    id: testCase.id,
    mode: testCase.mode,
    expectedRoute: testCase.expectedRoute,
    profile: testCase.profile,
    prompt: testCase.prompt,
    output: result.content,
    generation: {
      httpStatus: result.httpStatus,
      completed: result.completed,
      billingComplete: result.billingComplete,
      chars: result.content.length,
      modelError: result.modelError,
      attempt: result.attempt,
      reused: Boolean(result.reused),
    },
    deterministic: deterministicAudit(testCase, result.content),
  };
  generated.push(record);
  await fs.writeFile(path.join(outputDirectory, `${testCase.id}.json`), `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({ id: record.id, generation: record.generation, deterministic: record.deterministic }));
}

let judge = null;
if (!skipJudge) {
  const judgeSystem = `你是独立的商业IP定位质量评审员。你只评审，不重写答案。必须以用户已给事实为唯一事实源，不能因文案流畅而放过编造。

评分规则：0=危险或完全错误，1=严重缺陷，2=明显偏弱，3=基本可用，4=商业级扎实，5=优秀且可直接交付。严格拉开差距，普通完整答案最多3分；只有结论具体、有依据、有取舍、能执行且无编造才可4分；5分必须几乎无需修改。

完整报告按提供的20个维度评分。引导采访只按提供的8个维度评分。每个维度必须输出0—5整数和一句不超过35字的证据理由。任何捏造产品、价格、成绩、案例、客户原话、服务流程、政策、平台数据或保证效果，no_fabrication最高1分且总 verdict=fail。忽视用户明确的隐私、地域、产能、出镜、合规或不能承诺事项，相关维度最高2分。只有标题齐全但内容空泛不能超过3分。

verdict规则：pass=加权均分至少4.0且核心维度fact_grounding、no_fabrication、decision_value均不低于4；revise=加权均分3.2—3.99且无致命编造；fail=低于3.2、存在致命编造或方向明显错误。

只输出合法JSON，不要代码块、前言或Markdown。JSON结构：
{"cases":[{"id":"","dimension_scores":{"维度键":{"score":0,"reason":""}},"weighted_average":0,"verdict":"pass|revise|fail","top_strengths":[""],"priority_problems":[""],"most_important_fix":""}],"cross_case":{"average":0,"pass_count":0,"revise_count":0,"fail_count":0,"recurring_strengths":[""],"recurring_problems":[""],"prompt_level_fixes":[""]}}

weighted_average按提供的weight计算并保留两位小数。不要遗漏任何适用维度。`;
  const judgeInput = {
    dimensions: {
      full_report: reportDimensions.map(([key, description, weight]) => ({ key, description, weight })),
      guided_interview: guidedDimensions.map(([key, description, weight]) => ({ key, description, weight })),
    },
    cases: generated.map(record => ({
      id: record.id,
      mode: record.mode,
      expected_route: record.expectedRoute,
      user_profile: record.profile,
      user_request: record.prompt,
      deterministic_audit: record.deterministic,
      assistant_output: record.output,
    })),
  };
  const judged = await callLlm({
    agentId: '__free_chat__',
    agentName: '商业IP质量评审员',
    conversationId: `bip-quality-judge-${phase}-${randomUUID()}`,
    model: judgeModel.model,
    modelId: judgeModel.modelId,
    model_overridden: true,
    maxReplyTokens: 16384,
    temperature: 0,
    responseFormat: 'text',
    system_prompt: judgeSystem,
    messages: [{ role: 'user', content: JSON.stringify(judgeInput) }],
  }, 'judge', 420_000);
  await fs.writeFile(path.join(outputDirectory, 'judge-raw.txt'), `${judged.content}\n`, 'utf8');
  judge = {
    model: judgeModel.model,
    modelId: judgeModel.modelId,
    completed: judged.completed,
    billingComplete: judged.billingComplete,
    result: extractJson(judged.content),
  };
}

const report = {
  schemaVersion: 1,
  checkedAt: new Date().toISOString(),
  phase,
  origin,
  generator: { id: positioningAgentId, name: agent.name, model: agent.model || agent.model_id || null },
  generatorCalls: generated.length,
  allGeneratorCallsCompleted: generated.every(record => record.generation.completed && record.generation.billingComplete && !record.generation.modelError),
  judgeCalls: skipJudge ? 0 : 1,
  judge,
  cases: generated.map((record) => Object.fromEntries(
    Object.entries(record).filter(([key]) => key !== 'output' && key !== 'prompt'),
  )),
};
await fs.writeFile(path.join(outputDirectory, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({
  phase,
  generatorCalls: report.generatorCalls,
  allGeneratorCallsCompleted: report.allGeneratorCallsCompleted,
  judgeCalls: report.judgeCalls,
  judgeBillingComplete: report.judge?.billingComplete ?? null,
  crossCase: report.judge?.result?.cross_case ?? null,
}));
