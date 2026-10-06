import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  buildBusinessIpStepIntakeText,
  buildPositioningIntakeText,
  POSITIONING_FULL_REPORT_REQUEST,
  POSITIONING_GUIDED_START,
  POSITIONING_REPORT_SECTIONS,
  POSITIONING_TEMPLATE,
  positioningTemplateHasAnswers,
} from '../src/lib/business-ip/intake';

const followupPromptSource = fs.readFileSync('src/lib/business-ip/followup-roles.ts','utf8');

assert.equal(positioningTemplateHasAnswers(POSITIONING_TEMPLATE), false);
assert.equal(positioningTemplateHasAnswers('我做过哪些工作或生活角色：幼师八年'), true);
assert.equal(positioningTemplateHasAnswers('我暂时只知道自己不想露脸'), true);

const filled = POSITIONING_TEMPLATE
  .replace('我做过哪些工作或生活角色：', '我做过哪些工作或生活角色：幼师八年，也带过自己的孩子')
  .replace('别人常夸我或找我帮忙什么：', '别人常夸我或找我帮忙什么：亲子沟通')
  .replace('我愿不愿出镜、每周能花多少时间：', '我愿不愿出镜、每周能花多少时间：不让孩子出镜，每周6小时');
const message = buildPositioningIntakeText({
  situation: '完全没方向',
  goal: '为副业或变现做准备',
  profile: filled,
});
assert.match(message, /我现在的状态：完全没方向/);
assert.match(message, /我做自媒体最想得到的结果：为副业或变现做准备/);
assert.match(message, /幼师八年/);
assert.match(message, /一个推荐主方向，最多两个备选/);
assert.match(message, /没有提供的产品、客户、价格、成绩或服务承诺不要自行补写/);
assert.equal(POSITIONING_REPORT_SECTIONS.length, 13);
for (const section of POSITIONING_REPORT_SECTIONS) assert.ok(message.includes(section), section);
assert.match(POSITIONING_FULL_REPORT_REQUEST, /验证期按14天安排/);
assert.match(POSITIONING_FULL_REPORT_REQUEST, /不要自行换成四周或30天/);
assert.doesNotMatch(message, /服务范围与接单能力|现有账号和咨询入口|已确定的收费/);
assert.match(POSITIONING_GUIDED_START, /一次只问我一个简单问题/);
assert.match(POSITIONING_GUIDED_START, /资料够用后不要再让我重复填写/);

const benchmarkMessage = buildBusinessIpStepIntakeText({
  agentId: 'agent-1787163731976-5xntwm',
  action: '我有点迷茫，请综合判断这个账号最值得我学什么，并给出行动方案',
  secondaryAction: '标准看20条，比较高表现与普通作品并给14天学习与验证计划',
  description: 'https://v.douyin.com/example/',
  fields: [
    { label: '你的账号/业务，以及现在最迷茫的地方', value: '宠物知识账号，不知道该学选题还是表达' },
    { label: '你能做到的方式和限制', value: '每周能做3条，有真实养狗素材，不方便真人出镜' },
  ],
});
assert.match(benchmarkMessage, /请由对标账号拆解处理本次任务/);
assert.match(benchmarkMessage, /这次想做：我有点迷茫/);
assert.match(benchmarkMessage, /研究深度：标准看20条/);
assert.match(benchmarkMessage, /宠物知识账号，不知道该学选题还是表达/);
assert.match(benchmarkMessage, /每周能做3条，有真实养狗素材，不方便真人出镜/);
assert.match(benchmarkMessage, /不知道的产品、价格|不得补写产品、价格/);
assert.match(benchmarkMessage, /只有缺少会改变本环节结果的关键事实时，先问1个大白话问题/);
assert.match(benchmarkMessage, /七环协议/);

const packagingMessage = buildBusinessIpStepIntakeText({
  agentId: 'agent-1787158020109-cj3wnh',
  action: '生成整套账号包装',
  description: '做过八年幼师，想分享亲子沟通，不让孩子出镜。',
  fields: [{ label: '喜欢或不想要的感觉', value: '' }],
});
assert.match(packagingMessage, /请由账号主页包装处理本次任务/);
assert.doesNotMatch(packagingMessage, /服务范围与接单能力|已确定的收费与服务边界/);

const uiSource = fs.readFileSync('src/components/chat/business-ip-intake.tsx','utf8');
for (const label of ['生成整套包装','智能判断','标准20条','从头规划','写一条新稿','整理/更新资料包','回复顾客','设计跟进','整理一批咨询','复盘现有数据']) assert.ok(uiSource.includes(label), label);
for (const benchmarkContract of ['真正值得学什么','72小时行动','账号风格方法库','你的账号/业务，以及现在最迷茫的地方','你能做到的方式和限制','3个原创练习题','7—14天验证计划']) assert.ok(uiSource.includes(benchmarkContract), benchmarkContract);
for (const boundary of ['我的业务资料包','已整理资料包或前面环节成果','产品、服务和交付资料','行业术语、材料、型号和规格','匿名顾客问题和真实反馈','《产品/服务卡》','《行业术语与材料清单》','《当前顾客咨询包》','平台通用调度底座始终隐藏']) assert.ok(uiSource.includes(boundary), boundary);
for (const binding of ['给当前顾客对话绑定哪项业务','请由你本人选择要用于当前顾客对话的业务','当前已绑定','conversation_id:conversationId','bound_profile_id']) assert.ok(uiSource.includes(binding), binding);
assert.ok(uiSource.includes("...(!isConsultation?config.fields.map"),'consultation intake must keep the full business pack out of the user chat message');
assert.ok(uiSource.includes("status:'draft'"),'manual raw profile saves must begin as draft');
for (const boundary of ['本环节负责栏目、选题、顺序和创作简报，不写完整文案','选中题目后再交给“短视频文案成稿”完成正文','真人口播、不露脸解说或字幕型文案','完整短视频文案']) assert.ok(uiSource.includes(boundary), boundary);
for (const oldLabel of ['业务与交付','目前能提供的产品或服务','服务范围与接单能力','已确定的收费与服务边界']) assert.equal(uiSource.includes(oldLabel), false, oldLabel);

for (const contract of [
  '先分流，两个工作模式不得混做',
  '平台行业专业知识层',
  'PROFESSIONAL-KNOWLEDGE-CARD v1',
  'professional_reference_to_confirm',
  '平台先主动补充能负责提供的行业知识',
  '不能替会员编造自家产品参数、价格、库存、资质、案例、政策或服务承诺',
]) assert.ok(followupPromptSource.includes(contract), contract);
assert.ok(followupPromptSource.indexOf('1. 业务数据包生成模式') < followupPromptSource.indexOf('2. 小助理咨询模式'), 'business-pack mode must be defined before customer-reply mode');

console.log(JSON.stringify({
  passed:true,
  verificationLevel:'static-contract',
  inspectedContracts:['positioning-intake-builder','benchmark-intake-builder','benchmark-ui-copy','consultation-source-boundaries'],
  benchmarkIntakeAssertions:{defaultConfusionRequest:true,depthDescription:true,userContext:true,resourceBoundary:true,actionPromise:true},
  limitations:['未打开浏览器','未提交聊天','未调用模型','未执行付费请求'],
  paidRequestsExecuted:0,
}));
