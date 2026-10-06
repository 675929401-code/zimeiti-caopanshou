import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve('.codex-evidence/business-ip-positioning-quality-2.1.0');
const baseline = JSON.parse(await fs.readFile(path.join(root, 'quality-baseline/judge.json'), 'utf8'));
const afterReport = JSON.parse(await fs.readFile(path.join(root, 'quality-after/report.json'), 'utf8'));
const after = afterReport.judge?.result;

assert.ok(after, 'After-run semantic judge result is required');
assert.equal(afterReport.generatorCalls, 8);
assert.equal(afterReport.allGeneratorCallsCompleted, true);
assert.equal(afterReport.judge?.billingComplete, true);

const baselineById = new Map(baseline.cases.map(item => [item.id, item]));
const afterById = new Map(after.cases.map(item => [item.id, item]));
assert.deepEqual([...afterById.keys()].sort(), [...baselineById.keys()].sort());

const round = value => Math.round(value * 100) / 100;
const caseComparison = [...afterById.entries()].map(([id, current]) => {
  const before = baselineById.get(id);
  return {
    id,
    before: before.weighted_average,
    after: current.weighted_average,
    delta: round(current.weighted_average - before.weighted_average),
    verdictBefore: before.verdict,
    verdictAfter: current.verdict,
  };
});

const fullReportIds = caseComparison.map(item => item.id).filter(id => id !== 'minimal-guided-interview');
const dimensionKeys = Object.keys(afterById.get(fullReportIds[0]).dimension_scores);
const dimensionComparison = dimensionKeys.map(key => {
  const before = baseline.cases
    .filter(item => fullReportIds.includes(item.id))
    .map(item => item.dimension_scores[key]?.score)
    .filter(Number.isFinite);
  const current = after.cases
    .filter(item => fullReportIds.includes(item.id))
    .map(item => item.dimension_scores[key]?.score)
    .filter(Number.isFinite);
  const beforeAverage = before.reduce((sum, value) => sum + value, 0) / before.length;
  const afterAverage = current.reduce((sum, value) => sum + value, 0) / current.length;
  return { key, before: round(beforeAverage), after: round(afterAverage), delta: round(afterAverage - beforeAverage) };
});

const requiredSections = [
  '本次处理路线', '商业定位结论', '确认事实与待验证假设', '候选方向与八项证据灯',
  '目标人群与核心任务', '内容定位与3个内容支柱', '商业路径与承接顺序', '14天低成本验证计划',
  '决策标准与风险边界', '账号主页包装交接卡', '内容选题策划交接卡', '项目接力摘要',
];

const outputChecks = [];
for (const id of fullReportIds) {
  const output = await fs.readFile(path.join(root, `quality-after/${id}.md`), 'utf8');
  const section10 = output.split(/^##\s*10\.\s*内容选题策划交接卡\s*$/mu)[1]?.split(/^##\s*11\.\s*项目接力摘要\s*$/mu)[0] || '';
  const topicRows = section10.split(/\r?\n/u).filter(line => /^\s*(?:\d+\.|\|\s*\d+\s*\|)/u.test(line)).length;
  outputChecks.push({
    id,
    sectionCoverage: requiredSections.filter(name => output.includes(name)).length,
    hasAllSections: requiredSections.every(name => output.includes(name)),
    hasTestDifferentiator: /拟测试差异抓手/u.test(output),
    hasCapacityCalculation: /试跑产能测算/u.test(output),
    firstBatchTopicRows: topicRows,
    hasNineFirstTopics: topicRows >= 9,
  });
}

const guided = await fs.readFile(path.join(root, 'quality-after/minimal-guided-interview.md'), 'utf8');
const guidedCheck = {
  questionCount: (guided.match(/[？?]/gu) || []).length,
  allowsOrdinaryOrUnknownAnswer: /不知道|说不清|想不到|普通也可以|照实说/u.test(guided),
  explainsAnswerPurpose: /回答会帮我判断|回答.*帮助.*判断/u.test(guided),
  explainsNextStep: /然后我们再看|接下来|下一步|再帮你/u.test(guided),
  concise: guided.length >= 30 && guided.length <= 500,
};

assert.ok(outputChecks.every(item => item.hasAllSections));
assert.ok(outputChecks.every(item => item.hasTestDifferentiator));
assert.ok(outputChecks.every(item => item.hasCapacityCalculation));
assert.ok(outputChecks.every(item => item.hasNineFirstTopics));
assert.equal(guidedCheck.questionCount, 1);
assert.equal(guidedCheck.explainsAnswerPurpose, true);
assert.equal(guidedCheck.explainsNextStep, true);

const result = {
  schemaVersion: 1,
  checkedAt: new Date().toISOString(),
  modelRuns: {
    baseline: { generatorCalls: 8, judgeCalls: 1, semanticJudge: 'claude-sonnet-4-6' },
    after: { generatorCalls: 8, judgeCalls: 1, semanticJudge: afterReport.judge.model },
  },
  score: {
    before: baseline.cross_case.average,
    after: after.cross_case.average,
    delta: round(after.cross_case.average - baseline.cross_case.average),
    relativeImprovementPercent: round(((after.cross_case.average - baseline.cross_case.average) / baseline.cross_case.average) * 100),
    afterPassCount: after.cross_case.pass_count,
    afterReviseCount: after.cross_case.revise_count,
    afterFailCount: after.cross_case.fail_count,
  },
  caseComparison,
  dimensionComparison,
  outputChecks,
  guidedCheck,
  acceptedAdjustments: [
    '差异记忆改成可验证的具体差异抓手，未研究同行时只写拟测试差异。',
    '七份完整报告均提供三个内容支柱各三题，共九个首批题目草稿。',
    '把用户时间、频次和团队容量换算成建议产能，并要求首周记录真实用时回校。',
    '从零引导仍一次只问一个问题，同时说明回答用途和下一步。',
  ],
  rejectedOverfitting: [
    '不强制机械复述用户原句；语义保留事实与限制比关键词命中更重要。',
    '不让定位环节直接写昵称和简介；这些由账号主页包装完成，定位环节只交付可直接接力的包装卡。',
    '不把未知制作时长伪装成精确数据；使用建议区间、保守上限和首周实测。',
  ],
  passed: true,
};

await fs.writeFile(path.join(root, 'quality-comparison.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8');

const caseRows = caseComparison.map(item => `| ${item.id} | ${item.before.toFixed(2)} | ${item.after.toFixed(2)} | ${item.delta >= 0 ? '+' : ''}${item.delta.toFixed(2)} |`).join('\n');
const markdown = `# 商业IP定位多场景输出质量对比\n\n`+
  `- 基线：${result.score.before.toFixed(2)}/5\n`+
  `- 优化后：${result.score.after.toFixed(2)}/5\n`+
  `- 提升：+${result.score.delta.toFixed(2)}，相对提升 ${result.score.relativeImprovementPercent.toFixed(2)}%\n`+
  `- 结果：${result.score.afterPassCount}/8 通过，${result.score.afterReviseCount} 需修改，${result.score.afterFailCount} 失败\n\n`+
  `| 场景 | 优化前 | 优化后 | 变化 |\n|---|---:|---:|---:|\n${caseRows}\n\n`+
  `## 结构与闭环硬检查\n\n`+
  `- 7份完整报告：12段结构全部齐全。\n`+
  `- 7份完整报告：具体拟测试差异抓手全部齐全。\n`+
  `- 7份完整报告：试跑产能测算全部齐全。\n`+
  `- 7份完整报告：每份均有至少9个首批题目。\n`+
  `- 从零引导：只问1个问题，并说明回答用途和下一步。\n\n`+
  `## 防止过度优化\n\n${result.rejectedOverfitting.map(item => `- ${item}`).join('\n')}\n`;
await fs.writeFile(path.join(root, 'quality-comparison.md'), markdown, 'utf8');

console.log(JSON.stringify({ passed: true, ...result.score, comparison: path.join(root, 'quality-comparison.json') }));
