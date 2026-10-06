import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  POSITIONING_GUIDED_START,
  POSITIONING_FULL_REPORT_REQUEST,
  POSITIONING_LOCAL_BUSINESS_TEMPLATE,
  POSITIONING_PROFESSIONAL_TEMPLATE,
  buildPositioningIntakeText,
  positioningTemplateForSituation,
} from '../src/lib/business-ip/intake';

const promptSource = fs.readFileSync(
  path.resolve('src/lib/business-ip/prompts.ts'),
  'utf8',
);

const cases = [
  {
    id: 'no-direction',
    label: '完全无方向',
    input: {
      situation: '从零找个人方向',
      goal: '为副业或变现做准备',
      profile: [
        '我做过哪些工作或生活角色：幼师八年，也是两个孩子的妈妈',
        '别人常夸我或找我帮忙什么：亲子沟通、带低龄孩子做游戏',
        '哪些事情我愿意反复讲：家庭沟通和低成本陪伴',
        '我愿不愿出镜、每周能花多少时间：自己可以出镜，孩子不出镜，每周6小时',
        '我坚决不想做或不能做什么：不编专家头衔，不晒孩子隐私',
      ].join('\n'),
    },
    expectedFacts: ['幼师八年', '亲子沟通', '孩子不出镜', '每周6小时'],
    expectedRoute: '从经历、反复被问的问题和现实边界提炼候选方向，不要求先有产品或客户。',
  },
  {
    id: 'multiple-ideas',
    label: '多个想法拿不准',
    input: {
      situation: '有几个方向拿不准',
      goal: '找到能长期做的内容方向',
      profile: [
        '我做过哪些工作或生活角色：做过行政，也长期给同事做Excel表',
        '别人常夸我或找我帮忙什么：Excel、流程整理、做饭',
        '哪些事情我愿意反复讲：职场效率，也喜欢家常菜',
        '我手里有什么经历或现成资源：大量自己做过的表格案例',
        '我愿不愿出镜、每周能花多少时间：不露脸，每周8小时',
      ].join('\n'),
    },
    expectedFacts: ['Excel', '家常菜', '表格案例', '不露脸'],
    expectedRoute: '最多比较三个候选，用证据灯解释取舍，并推荐一个主方向而非只列赛道。',
  },
  {
    id: 'existing-business-reposition',
    label: '已有业务想转型',
    input: {
      situation: '有实体店或本地生意',
      goal: '给现有职业或生意引流',
      profile: [
        '我做过哪些工作或生活角色：在无锡经营一家小型开荒保洁团队',
        '别人常夸我或找我帮忙什么：新房开荒、入住前清洁避坑',
        '哪些事情我愿意反复讲：不同污渍怎么判断和处理',
        '我手里有什么经历或现成资源：真实施工前后照片和常见问题记录',
        '我愿不愿出镜、每周能花多少时间：可以出镜，每周拍3条',
        '我坚决不想做或不能做什么：不承诺所有污渍都能去掉',
      ].join('\n'),
    },
    expectedFacts: ['无锡', '开荒保洁', '施工前后照片', '不承诺所有污渍都能去掉'],
    expectedRoute: '从真实业务、购买任务和本地承接倒推定位，不虚构价格、流程或服务承诺。',
  },
] as const;

const report = {
  checkedAt: new Date().toISOString(),
  version: '2.1.0',
  paidRequests: 0,
  guidedStart: POSITIONING_GUIDED_START,
  cases: [] as Array<Record<string, unknown>>,
};

assert.match(POSITIONING_GUIDED_START, /一次只问我一个简单问题/);
assert.match(POSITIONING_GUIDED_START, /每次问题后告诉我这个回答能帮助判断什么、回答后下一步做什么/);
assert.match(promptSource, /支持五种入口：从零个人创作者、几个方向取舍、职业技能型创作者、实体与本地服务商家、已有账号或线上业务重定位/);
assert.match(promptSource, /本次按××路线处理/);
assert.match(promptSource, /抖音是主要经营平台，不是用户类型/);
assert.match(promptSource, /一次问1个，最多连续3轮后必须给阶段性判断/);
assert.match(promptSource, /最多比较3个候选方向/);
assert.match(promptSource, /抖音赛道证据卡/);
assert.match(promptSource, /15—20条/);
assert.match(promptSource, /平台官方或规则参照/);
assert.match(promptSource, /低粉高表现作品/);
assert.match(promptSource, /普通\/对照作品/);
assert.match(promptSource, /公开智能文稿/);
assert.match(promptSource, /前三句钩子类型/);
assert.match(promptSource, /不输出人人通用的热门赛道排行榜/);
assert.match(promptSource, /至少能规划30个不重复问题/);
assert.match(promptSource, /八项证据灯/);
assert.match(promptSource, /拟测试差异抓手/);
assert.match(promptSource, /试跑产能测算/);
assert.match(promptSource, /每条预计耗时、每周可持续条数和必要留白/);
assert.match(promptSource, /首批9个题目草稿/);
assert.match(promptSource, /每次提问后用一句大白话说明/);
assert.match(promptSource, /14天低成本验证计划/);
assert.match(promptSource, /账号主页包装交接卡/);
assert.match(promptSource, /内容选题策划交接卡/);
assert.match(POSITIONING_FULL_REPORT_REQUEST, /拟测试差异抓手/);
assert.match(POSITIONING_FULL_REPORT_REQUEST, /试跑产能/);
assert.match(POSITIONING_FULL_REPORT_REQUEST, /各给3个首批题目草稿/);

for (const item of cases) {
  const message = buildPositioningIntakeText({ ...item.input, supplement: false });
  assert.match(message, new RegExp(`我现在的状态：${item.input.situation}`));
  assert.match(message, new RegExp(`我做自媒体最想得到的结果：${item.input.goal}`));
  for (const fact of item.expectedFacts) assert.ok(message.includes(fact), `${item.id}: ${fact}`);
  assert.match(message, /没有提供的产品、客户、价格、成绩或服务承诺不要自行补写/);
  report.cases.push({
    id: item.id,
    label: item.label,
    inputMessage: message,
    expectedRoute: item.expectedRoute,
    expectedInteraction: '先复述已知事实，再只问一个会改变方向的关键问题；最多连续三轮后给阶段性判断。',
    expectedDeliverable: '一个主方向、最多两个备选、八项证据灯、拟测试差异抓手、14天试跑与产能测算、账号主页包装交接卡、含首批9题的内容选题策划交接卡。',
    passed: true,
  });
}

assert.equal(positioningTemplateForSituation('有职业或技能想做IP'), POSITIONING_PROFESSIONAL_TEMPLATE);
assert.equal(positioningTemplateForSituation('有实体店或本地生意'), POSITIONING_LOCAL_BUSINESS_TEMPLATE);
assert.match(POSITIONING_LOCAL_BUSINESS_TEMPLATE, /顾客下单前最常问什么、担心什么/);
assert.doesNotMatch(POSITIONING_LOCAL_BUSINESS_TEMPLATE, /我做过哪些工作或生活角色/);

const outputDirectory = path.resolve('.codex-evidence/business-ip-positioning-cases-2.1.0');
fs.mkdirSync(outputDirectory, { recursive: true });
fs.writeFileSync(
  path.join(outputDirectory, 'report.json'),
  `${JSON.stringify({ ...report, passed: true }, null, 2)}\n`,
  'utf8',
);

console.log(JSON.stringify({
  passed: true,
  cases: report.cases.length,
  paidRequests: report.paidRequests,
  report: path.join(outputDirectory, 'report.json'),
}));
