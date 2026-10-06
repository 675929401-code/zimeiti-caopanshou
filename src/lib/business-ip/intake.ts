import { bipStep } from './catalog';

export type PositioningChoice = { value: string; label: string };

export const POSITIONING_SITUATIONS: PositioningChoice[] = [
  { value: '从零找个人方向', label: '从零找个人方向' },
  { value: '有几个方向拿不准', label: '有几个方向，拿不准' },
  { value: '有职业或技能想做IP', label: '有职业或技能' },
  { value: '有实体店或本地生意', label: '有实体店或本地生意' },
  { value: '已有账号或线上业务但定位模糊', label: '已有账号或线上业务' },
];

export const POSITIONING_GOALS: PositioningChoice[] = [
  { value: '找到能长期做的内容方向', label: '找到能长期做的方向' },
  { value: '为副业或变现做准备', label: '为副业或变现做准备' },
  { value: '给现有职业或生意引流', label: '给现有职业或生意引流' },
  { value: '还没想好', label: '还没想好' },
];

export const POSITIONING_TEMPLATE_LABELS = [
  '我做过哪些工作或生活角色',
  '别人常夸我或找我帮忙什么',
  '哪些事情我愿意反复讲',
  '我手里有什么经历或现成资源',
  '我愿不愿出镜、每周能花多少时间',
  '我坚决不想做或不能做什么',
] as const;

export const POSITIONING_TEMPLATE = POSITIONING_TEMPLATE_LABELS.map((label) => `${label}：`).join('\n');

export const POSITIONING_PROFESSIONAL_TEMPLATE = [
  '我做过什么工作、会什么技能：',
  '别人经常拿什么问题来问我：',
  '我手里有哪些案例、作品或过程可以讲：',
  '我愿意长期讲什么、不想讲什么：',
  '我愿不愿出镜、每周能花多少时间：',
  '我做账号最想得到什么：',
].join('\n');

export const POSITIONING_LOCAL_BUSINESS_TEMPLATE = [
  '我做的是什么生意、在哪个城市：',
  '顾客通常因为什么事来找我：',
  '顾客下单前最常问什么、担心什么：',
  '我能拍到哪些真实产品、现场或服务过程：',
  '谁愿意出镜、每周能拍多少：',
  '服务范围、接单能力和不能承诺什么：',
].join('\n');

export const POSITIONING_EXISTING_ACCOUNT_TEMPLATE = [
  '现在做的账号或业务是什么：',
  '目前主要发什么内容：',
  '来的是什么人、他们常问什么：',
  '哪些内容、咨询或成交比较有效：',
  '我觉得最卡的地方是什么：',
  '每周能投入多少、不能改变什么：',
].join('\n');

const POSITIONING_TEMPLATE_MAP: Record<string, string> = {
  '从零找个人方向': POSITIONING_TEMPLATE,
  '有几个方向拿不准': POSITIONING_TEMPLATE,
  '有职业或技能想做IP': POSITIONING_PROFESSIONAL_TEMPLATE,
  '有实体店或本地生意': POSITIONING_LOCAL_BUSINESS_TEMPLATE,
  '已有账号或线上业务但定位模糊': POSITIONING_EXISTING_ACCOUNT_TEMPLATE,
};

export function positioningTemplateForSituation(situation?: string): string {
  return POSITIONING_TEMPLATE_MAP[situation || ''] || POSITIONING_TEMPLATE;
}

export const POSITIONING_REPORT_SECTIONS = [
  '本次处理路线',
  '商业定位结论',
  '确认事实与待验证假设',
  '候选方向与八项证据灯',
  '目标人群与核心任务',
  '内容定位与3个内容支柱',
  '商业路径与承接顺序',
  '14天低成本验证计划',
  '决策标准与风险边界',
  '账号主页包装交接卡',
  '内容选题策划交接卡',
  '咨询回复业务数据基础卡',
  '给下一步用的资料',
] as const;

export const POSITIONING_FULL_REPORT_REQUEST = `资料足够时，请直接按这十三段给我完整报告，不要另换结构或漏项：${POSITIONING_REPORT_SECTIONS.join(' → ')}。验证期按14天安排，不要自行换成四周或30天；每段都用大白话写出可执行内容。推荐方向要给具体的拟测试差异抓手；把我的时间换算成试跑产能；在选题交接卡里按3个内容支柱各给3个首批题目草稿；在咨询回复业务数据基础卡中只整理已经知道的会员身份、业务方向、目标顾客、核心问题、价值、证据、承接目标和禁说边界，把价格、案例、周期、交付、退改等尚未确认的经营事实逐项标为待补充，供“咨询回复与跟进”继续补齐标准会员业务数据。`;

export const POSITIONING_GUIDED_START = `我现在没有明确方向，也说不清自己的优势。请一次只问我一个简单问题，从我做过的事、比较拿手的事、愿意长期分享的内容和现实条件开始；每次问题后告诉我这个回答能帮助判断什么、回答后下一步做什么。资料够用后不要再让我重复填写，${POSITIONING_FULL_REPORT_REQUEST}`;

export function positioningTemplateHasAnswers(value: string): boolean {
  return value.split(/\r?\n/u).some((rawLine) => {
    const line = rawLine.trim();
    if (!line) return false;
    const separator = line.search(/[：:]/u);
    if (separator < 0) return true;
    return line.slice(separator + 1).trim().length > 0;
  });
}

export function buildPositioningIntakeText(input: {
  situation?: string;
  goal?: string;
  profile: string;
  supplement?: boolean;
}): string {
  const details = positioningTemplateHasAnswers(input.profile)
    ? input.profile.trim()
    : '暂时说不清，希望你通过简单提问帮我梳理。';
  const lines = [
    input.situation ? `我现在的状态：${input.situation}` : '',
    input.goal ? `我做自媒体最想得到的结果：${input.goal}` : '',
  ].filter(Boolean);
  return `${input.supplement ? '我想补充或更正自己的情况。' : '我想请你帮我做好商业IP定位。'}\n\n${lines.join('\n')}\n\n关于我：\n${details}\n\n请先识别我属于从零个人、职业技能、实体本地生意、线上业务还是已有账号重定位，再按对应路线判断。给我一个推荐主方向，最多两个备选，并说明为什么适合、可以先讲什么、接下来怎样低成本试一试。不清楚的地方标成待验证；没有提供的产品、客户、价格、成绩或服务承诺不要自行补写。\n\n${POSITIONING_FULL_REPORT_REQUEST}`;
}

export function buildBusinessIpStepIntakeText(input: {
  agentId: string;
  action?: string;
  secondaryAction?: string;
  description: string;
  fields?: Array<{ label: string; value: string }>;
  supplement?: boolean;
}): string {
  const step = bipStep(input.agentId);
  if (!step) throw new Error('未知的商业IP环节');
  const parts = [
    input.action ? `这次想做：${input.action}` : '',
    input.secondaryAction ? `研究深度：${input.secondaryAction}` : '',
    input.description.trim() ? `我提供的主要资料：\n${input.description.trim()}` : '',
    ...(input.fields || []).filter(item => item.value.trim()).map(item => `${item.label}：${item.value.trim()}`),
  ].filter(Boolean);
  const details = parts.length > 0 ? parts.join('\n\n') : '我暂时说不清，请先用一个简单问题带我开始。';
  return `${input.supplement ? '本项目新增或更正的资料（未提及的已确认信息保持不变）' : `请由${step.name}处理本次任务`}：\n\n${details}\n\n请直接吸收本项目已经确认的资料，不要让我重复填写。信息足够就交付；只有缺少会改变本环节结果的关键事实时，先问1个大白话问题。未知内容标为待验证，不得补写产品、价格、成绩、客户故事、服务政策或平台数据。完整交付后给一段“给下一步用的资料”，只写自然中文，不显示内部编号、字段名或数据格式。`;
}
