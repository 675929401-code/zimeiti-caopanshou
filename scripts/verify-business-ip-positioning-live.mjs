import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const origin = String(process.env.LOCAL_NAV_ORIGIN || 'http://127.0.0.1:5000').replace(/\/$/u, '');
const token = String(process.env.LOCAL_NAV_ADMIN_TOKEN || '').trim();
const phase = String(process.argv.find((argument) => argument.startsWith('--phase='))?.slice(8) || 'current');
const caseId = String(process.argv.find((argument) => argument.startsWith('--case='))?.slice(7) || '');
const modelVariant = String(process.argv.find((argument) => argument.startsWith('--model='))?.slice(8) || 'agent');
const agentId = 'agent-1787079707230-h0sdiq';
const outputDirectory = path.resolve('.codex-evidence/business-ip-positioning-live-2.1.0', phase);
const modelOverrides = {
  terra: { model: 'gpt-5.6-terra', modelId: '673aef26-e373-4876-ad0c-41041a5d35ae' },
  'sol-long': { model: 'gpt-5.6-sol', modelId: 'ca7d18b2-198c-4b78-8a95-0228a722436e' },
};
const modelOverride = modelVariant === 'agent' ? null : modelOverrides[modelVariant];

assert.ok(token, 'LOCAL_NAV_ADMIN_TOKEN is required');
assert.match(phase, /^[a-z0-9-]+$/u, 'Safe phase name required');
assert.ok(modelVariant === 'agent' || modelOverride, `Unknown model variant: ${modelVariant}`);
await fs.mkdir(outputDirectory, { recursive: true });

const cases = [
  {
    id: 'creator-zero',
    route: '从零个人创作者',
    prompt: `我想做抖音，但完全没有方向。我做过8年幼师，现在主要在家带娃。朋友常问我孩子不听话、亲子沟通怎么办，我愿意真人口播，但不让孩子出镜，每周能投入6小时。我没有产品、客户或课程，想先做成一个能长期更新、以后有副业可能的账号。请直接完成正式定位报告，不要继续问我；信息不足处标成待验证。`,
  },
  {
    id: 'creator-choice',
    route: '职业技能型创作者',
    prompt: `我做过5年财务，Excel用得比较熟，也喜欢做家常菜，现在在“Excel职场技巧”和“普通人做饭”之间拿不准。手里有自己整理的Excel表格案例，没有学员成绩、课程和定价；不想露脸，可以录屏和配音；每周能投入8小时，希望先选一个更适合长期做的方向。请直接完成正式定位报告，不要继续问我；信息不足处标成待验证。`,
  },
  {
    id: 'creator-card',
    route: '商业IP定位卡片任务稿',
    prompt: `我想请你帮我做好商业IP定位。

我现在的状态：有职业或技能想做IP
我做自媒体最想得到的结果：为副业或变现做准备

关于我：
我做过什么工作、会什么技能：做过5年财务，Excel比较熟
别人经常拿什么问题来问我：表格汇总和对账
我手里有哪些案例、作品或过程可以讲：有自己整理的脱敏Excel案例
我愿意长期讲什么、不想讲什么：愿意讲真实工作问题，不讲未经核实的财税结论
我愿不愿出镜、每周能花多少时间：不露脸，可录屏配音，每周8小时
我做账号最想得到什么：先找到能长期做的方向，再验证副业可能

请先识别我属于从零个人、职业技能、实体本地生意、线上业务还是已有账号重定位，再按对应路线判断。给我一个推荐主方向，最多两个备选。不清楚的地方标成待验证；没有提供的产品、客户、价格、成绩或服务承诺不要自行补写。

资料足够时，请直接按这十三段给我完整报告，不要另换结构或漏项：本次处理路线 → 商业定位结论 → 确认事实与待验证假设 → 候选方向与八项证据灯 → 目标人群与核心任务 → 内容定位与3个内容支柱 → 商业路径与承接顺序 → 14天低成本验证计划 → 决策标准与风险边界 → 账号主页包装交接卡 → 内容选题策划交接卡 → 咨询回复业务数据基础卡 → 项目接力摘要。验证期按14天安排，不要自行换成四周或30天；每段都用大白话写出可执行内容。`,
  },
  {
    id: 'local-merchant',
    route: '实体与本地服务商家',
    prompt: `我在无锡做开荒保洁和入住保洁，3个人的小团队，主要服务无锡市区，报价要看面积和现场情况。客户最常问多少钱、顽固污渍能不能处理干净。我们有一些可匿名使用的前后对比照片和工具过程，每周能拍3条，老板可以出镜，但不能保证所有污渍都能去掉，也没有固定优惠。想用抖音获得同城有效咨询。请直接完成正式定位报告，不要继续问我；信息不足处标成待验证。`,
  },
  {
    id: 'creator-myths',
    route: '职业技能型创作者与博主观点核验',
    prompt: `我做过5年财务，手里有自己整理的Excel案例，不露脸，每周能投入8小时。我看创业博主说“不露脸就无法变现”“新号7天必须打好标签”“Excel不如美食赛道好变现”“粉丝到5万自然有人来咨询”。请你把这些说法和可用方法分开，基于我的真实条件做正式定位报告，并明确哪些只是博主观点、哪些可以转成低成本验证。不要继续问我。`,
  },
];
const selectedCases = caseId ? cases.filter((testCase) => testCase.id === caseId) : cases;
assert.ok(selectedCases.length > 0, `Unknown case: ${caseId}`);

const criteria = {
  route: ['从零个人', '职业技能', '实体本地', '实体与本地', '线上业务', '已有账号重定位', '处理路线'],
  conclusion: ['主方向', '推荐方向', '一句话定位', '定位结论'],
  evidence: ['事实', '依据', '待验证', '假设'],
  eightDimensions: ['八项证据灯', '真实积累', '差异记忆'],
  audience: ['人群', '用户', '顾客', '客户', '场景'],
  content: ['内容支柱', '内容方向', '选题', '30'],
  business: ['变现', '商业路径', '承接', '咨询'],
  trial: ['14天', '试跑', '验证'],
  packagingHandoff: ['账号包装', '包装师', '昵称', '简介'],
  topicHandoff: ['内容策划', '选题师', '选题交接', '创作简报'],
  risk: ['风险', '边界', '不能承诺', '不建议'],
};

function scoreOutput(content) {
  const checks = Object.fromEntries(Object.entries(criteria).map(([key, alternatives]) => [
    key,
    alternatives.some((marker) => content.includes(marker)),
  ]));
  return { checks, passed: Object.values(checks).filter(Boolean).length, total: Object.keys(checks).length };
}

async function callModel(testCase) {
  const clientRequestId = `bip-positioning-${randomUUID()}`;
  const conversationId = `bip-positioning-live-${phase}-${randomUUID()}`;
  const response = await fetch(`${origin}/api/llm`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Origin: origin,
    },
    body: JSON.stringify({
      agentId,
      conversationId,
      stream: true,
      ...(modelOverride ? {
        model: modelOverride.model,
        modelId: modelOverride.modelId,
        model_overridden: true,
        maxReplyTokens: 8192,
        temperature: 0.2,
      } : {}),
      client_request_id: clientRequestId,
      messages: [{ role: 'user', content: testCase.prompt }],
    }),
    signal: AbortSignal.timeout(300_000),
  });
  const raw = await response.text();
  let content = '';
  let done = false;
  let billingComplete = false;
  let modelError = '';
  for (const line of raw.split(/\r?\n/u)) {
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (data === '[DONE]') {
      done = true;
      continue;
    }
    try {
      const event = JSON.parse(data);
      content += event.choices?.[0]?.delta?.content || event.content || '';
      if (event.billing_complete) billingComplete = true;
      if (event.error) modelError = `${event.code || 'MODEL_ERROR'}:${event.error}`;
    } catch {
      // Ignore keepalive or non-JSON SSE events.
    }
  }
  await fs.writeFile(path.join(outputDirectory, `${testCase.id}.md`), content || raw, 'utf8');
  const result = {
    id: testCase.id,
    route: testCase.route,
    httpStatus: response.status,
    completed: done,
    billingComplete,
    chars: content.length,
    modelError,
    ...scoreOutput(content),
  };
  assert.ok(response.ok && done && !modelError && content.length > 200, `${testCase.id} generation failed`);
  return result;
}

const agentsResponse = await fetch(`${origin}/api/bots?shape=agents`, {
  headers: { Authorization: `Bearer ${token}` },
  signal: AbortSignal.timeout(20_000),
});
assert.equal(agentsResponse.ok, true, `Agent readback failed: ${agentsResponse.status}`);
const agentsPayload = await agentsResponse.json();
const agent = (agentsPayload.agents || agentsPayload || []).find((candidate) => candidate.id === agentId);
assert.equal(agent?.name, '商业IP定位');

const report = {
  checkedAt: new Date().toISOString(),
  phase,
  modelVariant,
  origin,
  agent: { id: agentId, name: agent.name, model: agent.model || agent.model_id || null },
  paidModelRequests: selectedCases.length,
  results: [],
};

for (const testCase of selectedCases) {
  const result = await callModel(testCase);
  report.results.push(result);
  console.log(JSON.stringify(result));
}

report.averageContractCoverage = report.results.reduce((sum, result) => sum + result.passed / result.total, 0) / report.results.length;
report.allCallsCompleted = report.results.every((result) => result.completed && !result.modelError);
report.contractPassed = report.results.every((result) => result.passed === result.total);
await fs.writeFile(path.join(outputDirectory, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ phase, paidModelRequests: report.paidModelRequests, averageContractCoverage: report.averageContractCoverage, allCallsCompleted: report.allCallsCompleted }));
assert.equal(report.contractPassed, true, `Output contract incomplete: ${report.results.map((result) => `${result.id}=${result.passed}/${result.total}`).join(', ')}`);
