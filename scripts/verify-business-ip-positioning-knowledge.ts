import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  POSITIONING_DECISION_DIMENSIONS,
  POSITIONING_KNOWLEDGE_PROMPT,
  POSITIONING_KNOWLEDGE_UPDATED_AT,
  POSITIONING_KNOWLEDGE_VERSION,
  POSITIONING_NEW_ACCOUNT_STRATEGY,
  POSITIONING_OPPORTUNITY_FAMILIES,
  POSITIONING_AUTOMATION_STAGES,
  POSITIONING_CREATOR_SAMPLE_LEARNINGS,
  POSITIONING_PLATFORM_LEARNINGS,
  POSITIONING_RESEARCH_DOMAINS,
  POSITIONING_ROUTE_PROFILES,
  POSITIONING_TRANSCRIPT_FIELDS,
} from '../src/lib/business-ip/positioning-knowledge';

assert.equal(POSITIONING_KNOWLEDGE_VERSION, 'douyin-positioning-kb.v2.1.1');
assert.equal(POSITIONING_KNOWLEDGE_UPDATED_AT, '2026-09-22');
assert.equal(POSITIONING_RESEARCH_DOMAINS.length, 6);
assert.equal(POSITIONING_OPPORTUNITY_FAMILIES.length, 7);
assert.equal(POSITIONING_ROUTE_PROFILES.length, 5);
assert.equal(POSITIONING_PLATFORM_LEARNINGS.length, 7);
assert.equal(POSITIONING_CREATOR_SAMPLE_LEARNINGS.length, 12);
assert.equal(POSITIONING_AUTOMATION_STAGES.length, 8);
assert.equal(POSITIONING_DECISION_DIMENSIONS.length, 8);
assert.equal(POSITIONING_NEW_ACCOUNT_STRATEGY.length, 8);
assert.equal(POSITIONING_TRANSCRIPT_FIELDS.length, 12);

for (const family of POSITIONING_OPPORTUNITY_FAMILIES) {
  assert.ok(family.id && family.name && family.bestFor && family.evidence && family.risk);
}

for (const marker of [
  '不是“热门赛道榜”',
  '抖音是本系统主要经营平台，不是用户类型',
  '从零个人创作者',
  '实体与本地服务商家',
  '看到内容→对内容感兴趣→了解商家或商品→咨询/到店/购买',
  '全自动处理顺序',
  '创业与知识博主公开样本只反哺可迁移机制',
  '不露脸无法变现',
  '5位万粉以上',
  '深读50条',
  '互相冲突的说法',
  '作者观点',
  '七类可起步资产',
  '30题续航',
  '14天最小试跑',
  '3—6条',
  '每条只改一个主要变量',
  '同账号普通作品',
  '不复制独特句子',
  '无真实工具时给研究计划并标待验证',
]) assert.ok(POSITIONING_KNOWLEDGE_PROMPT.includes(marker), marker);

const promptsSource = fs.readFileSync(path.resolve('src/lib/business-ip/prompts.ts'), 'utf8');
assert.match(promptsSource, /POSITIONING_KNOWLEDGE_PROMPT/);
assert.match(promptsSource, /index===0/);
for (const marker of [
  '标准商业定位报告｜唯一输出骨架',
  '先搭起下面十三个标题',
  '候选方向与八项证据灯',
  '账号主页包装交接卡',
  '内容选题策划交接卡',
  '咨询回复业务数据基础卡',
  '项目接力摘要',
]) assert.ok(promptsSource.includes(marker), marker);

const reportDirectory = path.resolve('.codex-evidence/business-ip-positioning-knowledge-2.1.0');
fs.mkdirSync(reportDirectory, { recursive: true });
const report = {
  passed: true,
  version: POSITIONING_KNOWLEDGE_VERSION,
  updatedAt: POSITIONING_KNOWLEDGE_UPDATED_AT,
  researchDomains: POSITIONING_RESEARCH_DOMAINS.length,
  opportunityFamilies: POSITIONING_OPPORTUNITY_FAMILIES.length,
  routeProfiles: POSITIONING_ROUTE_PROFILES.length,
  platformLearnings: POSITIONING_PLATFORM_LEARNINGS.length,
  creatorSampleLearnings: POSITIONING_CREATOR_SAMPLE_LEARNINGS.length,
  automationStages: POSITIONING_AUTOMATION_STAGES.length,
  decisionDimensions: POSITIONING_DECISION_DIMENSIONS.length,
  newAccountSteps: POSITIONING_NEW_ACCOUNT_STRATEGY.length,
  transcriptFields: POSITIONING_TRANSCRIPT_FIELDS.length,
  paidRequests: 0,
};
fs.writeFileSync(path.join(reportDirectory, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(JSON.stringify(report));
