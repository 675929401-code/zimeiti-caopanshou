import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const origin = String(process.env.LOCAL_NAV_ORIGIN || 'http://127.0.0.1:5000').replace(/\/$/u, '');
const token = String(process.env.LOCAL_NAV_ADMIN_TOKEN || '').trim();
const outputDirectory = path.resolve('.codex-evidence/business-ip-psychology-regression-2.3.0');
assert.ok(token, 'LOCAL_NAV_ADMIN_TOKEN is required');
await fs.mkdir(outputDirectory, { recursive: true });

const cases = [
  {
    key: 'script',
    agentId: 'agent-bip-script-2',
    name: '短视频文案成稿',
    prompt: `请根据下面的简报交付完整格式，不要只给正文。
topic_id：T-TEST-001
insight_id：INS-TEST-001
确认事实：我有5年财务工作经验，擅长Excel，有自制脱敏演示表；没有课程、学员、公开模板和准确率承诺；只能录屏配音。
【待验证假设，非顾客原话】：遇到对账差几块钱时，部分财务新人可能需要先排查格式和口径；另一种可能是观众只想直接拿公式，不想了解排查顺序。
题目：对账总差几块钱，先查哪一步？
要求：写45—60秒抖音口播，开头不能把待验证场景写成所有人的既定行为；正文给一个可执行排查起点；完整列出用户决策依据、另一种可能动机，以及出现什么评论或咨询反馈时应调整稿件策略。`,
  },
  {
    key: 'consultation',
    agentId: 'agent-1787160183236-5fi3w8',
    name: '咨询回复与跟进',
    prompt: `请按“会员业务数据 + 当前顾客聊天”的完整输出合同处理。
会员业务数据：面向财务新人的Excel错误排查内容；目前只有自制脱敏演示表，没有公开下载模板、收费服务、售后政策或准确率承诺；可以先解释检查思路；是否提供模板尚未决定。
顾客原话：能不能把你视频里的模板直接发我？我想拿来对账，你能保证公式不会错吗？
渠道：私信。
来源作品编号：未记录。
确认事实：目前只有自制脱敏演示表，没有公开下载模板、收费服务、售后政策或准确率承诺；可以先解释检查思路，是否提供模板尚未决定。
要求：先自动生成当前顾客咨询包，再给一条可直接发送的话术；因为上游没有提供insight_id，请建立临时INS，并在匿名记录和回流信号中写清证据状态、至少一个其他可能解释，以及归并已有INS或新建独立INS的条件。顾客原话、顾客明确事实、待验证推测与助手阶段判断必须分栏。`,
  },
];

function parseSse(raw) {
  let content = '';
  let completed = false;
  let billingComplete = false;
  let modelError = '';
  for (const line of raw.split(/\r?\n/u)) {
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (data === '[DONE]') { completed = true; continue; }
    try {
      const event = JSON.parse(data);
      content += event.choices?.[0]?.delta?.content || event.content || '';
      if (event.billing_complete) billingComplete = true;
      if (event.error) modelError = `${event.code || 'MODEL_ERROR'}:${event.error}`;
    } catch {
      // Ignore keepalive records.
    }
  }
  return { content, completed, billingComplete, modelError };
}

async function callAgent(testCase) {
  const requestId = `bip-psychology-${testCase.key}-${randomUUID()}`;
  const response = await fetch(`${origin}/api/llm`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Origin: origin,
      'Idempotency-Key': requestId,
    },
    body: JSON.stringify({
      agentId: testCase.agentId,
      conversationId: requestId,
      client_request_id: requestId,
      stream: true,
      messages: [{ role: 'user', content: testCase.prompt }],
    }),
    signal: AbortSignal.timeout(360_000),
  });
  const parsed = parseSse(await response.text());
  assert.ok(response.ok && parsed.completed && parsed.billingComplete && !parsed.modelError && parsed.content.length > 100,
    `${testCase.key} failed status=${response.status} complete=${parsed.completed} billing=${parsed.billingComplete} error=${parsed.modelError}`);
  return parsed.content;
}

function sharedChecks(output) {
  return {
    noMindReading: !/用户(?:潜意识|内心其实|嘴上.{0,8}其实)|这类人(?:都|一定)|隐藏购买欲/u.test(output),
    noLongQuestionnaire: !/(?:请|需要你).{0,20}(?:逐条|全部).{0,12}(?:回答|填写).{0,12}(?:170|一百七十)/u.test(output),
  };
}

const results = [];
for (const testCase of cases) {
  const output = await callAgent(testCase);
  const checks = testCase.key === 'script'
    ? {
        ...sharedChecks(output),
        insightId: /INS-TEST-001/u.test(output),
        evidenceState: /待验证/u.test(output),
        alternativeMotive: /其他可能|另一种|也可能/u.test(output),
        feedbackSwitch: /改稿|改写|调整.{0,10}策略|反馈.{0,12}调整|评论.{0,12}(?:改|调整)/u.test(output),
        conditionalHook: /如果|遇到.{0,12}时/u.test(output),
      }
    : {
        ...sharedChecks(output),
        temporaryInsight: /INS-TEMP-\d+/u.test(output),
        evidenceState: /单次已观察信号|待验证假设/u.test(output),
        alternativeExplanation: /其他可能解释|另一种解释|也可能/u.test(output),
        mergeCondition: /归并|新建.{0,12}INS/u.test(output),
        separatesCustomerWords: /顾客真实用词|顾客原话/u.test(output),
        customerPacket: /顾客咨询包|conversation_id|咨询阶段/u.test(output),
        separatesCustomerFacts: /顾客明确事实|待验证推测|顾客原话/u.test(output),
        separatesAssistantJudgment: /助手判断/u.test(output),
        refusesGuarantee: /(?:不能|无法|不).{0,10}保证|不能承诺/u.test(output),
      };
  for (const [key, value] of Object.entries(checks)) assert.equal(value, true, `${testCase.key}:${key}`);
  await fs.writeFile(path.join(outputDirectory, `${testCase.key}.md`), `${output}\n`, 'utf8');
  results.push({ key: testCase.key, agentId: testCase.agentId, name: testCase.name, chars: output.length, checks });
}

const report = { schemaVersion: 1, checkedAt: new Date().toISOString(), origin, paidGenerationCalls: results.length, passed: true, results };
await fs.writeFile(path.join(outputDirectory, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(JSON.stringify(report));
