import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseRepairableJson } from './repair-llm-json-output.mjs';

const origin = String(process.env.LOCAL_NAV_ORIGIN || 'http://127.0.0.1:5000').replace(/\/$/u, '');
const token = String(process.env.LOCAL_NAV_ADMIN_TOKEN || '').trim();
const phase = String(process.argv.find(argument => argument.startsWith('--phase='))?.slice(8) || 'baseline');
const onlyScenario = String(process.argv.find(argument => argument.startsWith('--scenario='))?.slice(11) || '');
const skipJudge = process.argv.includes('--skip-judge');
const resume = process.argv.includes('--resume');
const outputDirectory = path.resolve('.codex-evidence/business-ip-six-agent-quality-2.2.0', phase);

assert.ok(token, 'LOCAL_NAV_ADMIN_TOKEN is required');
assert.match(phase, /^[a-z0-9-]+$/u, 'Safe phase name required');
await fs.mkdir(outputDirectory, { recursive: true });

const AGENTS = {
  packaging: { id: 'agent-1787158020109-cj3wnh', name: '账号主页包装' },
  benchmark: { id: 'agent-1787163731976-5xntwm', name: '对标账号拆解' },
  content: { id: 'agent-1787160182534-uk29g4', name: '内容选题策划' },
  script: { id: 'agent-bip-script-2', name: '短视频文案成稿' },
  consultation: { id: 'agent-1787160183236-5fi3w8', name: '咨询回复与跟进' },
  review: { id: 'agent-1787160184111-bj5hi3', name: '运营数据复盘' },
};

const judgeModel = {
  model: 'claude-sonnet-4-6',
  modelId: '06c15d07-9fbc-4034-9c1d-02b1c76aba30',
};

function makeCapture({ nickname, signature, followerCount, posts }) {
  return `DY_CAPTURE_V1\n${JSON.stringify({
    schema: 'douyin_public_capture_v1',
    captured_at: '2026-09-22T08:00:00.000Z',
    page_url: `https://www.douyin.com/user/${encodeURIComponent(nickname)}`,
    visible_page_text: `${nickname}\n${signature}\n以下为公开作品列表。`,
    loaded_post_count: posts.length,
    profile: {
      nickname,
      douyin_id: `fixture_${nickname}`,
      signature,
      follower_count: followerCount,
      following_count: 86,
      total_favorited: posts.reduce((sum, post) => sum + post.likes, 0),
      aweme_count: 186,
      ip_location: '江苏',
    },
    posts: posts.map((post, index) => ({
      aweme_id: `${8800000000000000000n + BigInt(index)}`,
      url: `https://www.douyin.com/video/${8800000000000000000n + BigInt(index)}`,
      description: post.description,
      create_time: 1789990000 - index * 86400,
      duration_ms: post.durationMs || 52000,
      hashtags: post.hashtags || [],
      statistics: {
        likes: post.likes,
        comments: Math.max(3, Math.round(post.likes * 0.06)),
        collects: Math.max(2, Math.round(post.likes * 0.13)),
        shares: Math.max(1, Math.round(post.likes * 0.025)),
        plays: null,
      },
    })),
  })}`;
}

const cleaningPosts = [
  ['开荒保洁报价差一倍，先看这4个现场变量', 18400], ['玻璃胶印别急着刮，先判断是哪一类残留', 13200],
  ['同样100平，为什么毛坯开荒和入住保洁不是一个价', 9700], ['厨房油垢处理前后，哪些能改善哪些不能保证', 8100],
  ['验收保洁别只摸地面，这5个位置更容易漏', 6900], ['工具不是越贵越好：刮水器的三个用法', 4200],
  ['新房开荒先做柜体还是先擦玻璃', 3100], ['无锡梅雨季做保洁，通风和返潮怎么安排', 2800],
  ['客户最常问：能不能当天全部做完', 2400], ['入住前一周，保洁和家具进场怎么排顺序', 1900],
  ['今天的三人开荒现场记录', 430], ['常用抹布颜色怎么分', 380], ['工具车收纳日常', 290], ['下班前清洗设备', 260],
  ['地面吸尘过程', 240], ['玻璃清洁片段', 220], ['团队出发记录', 190], ['普通住宅现场随拍', 170],
  ['清洁剂摆放', 150], ['一天工作结束', 120],
].map(([description, likes]) => ({ description, likes, hashtags: ['保洁', '无锡同城'] }));

const excelPosts = [
  ['对账总差几块钱？先查这3种格式错误', 22600], ['别背函数：先看懂VLOOKUP为什么返回N/A', 17100],
  ['两张表找差异，先统一这4列再开始', 13600], ['财务新人月底加班，常卡在这一步', 10100],
  ['一个脱敏案例讲清楚重复值怎么找', 8700], ['CSV导入后日期变乱码，原因通常在这里', 6100],
  ['不用露脸，录屏怎样让步骤看得清', 4200], ['老板临时要汇总表，先确定口径再做公式', 3500],
  ['筛选后求和为什么对不上', 2900], ['财务表格交接前的检查清单', 2300],
  ['今日快捷键练习', 510], ['Excel界面录屏', 440], ['表格配色分享', 390], ['鼠标操作演示', 350],
  ['一个常用函数', 320], ['下班前整理文件夹', 280], ['键盘桌面展示', 240], ['模板页面翻看', 210],
  ['公式输入过程', 180], ['今日学习打卡', 150],
].map(([description, likes]) => ({ description, likes, hashtags: ['Excel', '财务职场'] }));

const scenarios = [
  {
    id: 'local-cleaning',
    positioning: `项目：无锡开荒保洁商业IP v1\n确认事实：3人团队，只服务无锡市区；报价必须结合面积和现场；老板可出镜；每周可拍3条；有匿名前后对比图和工具过程；不能保证所有污渍去除；没有固定优惠。\n定位结论：以“无锡新房入住前的保洁决策说明者”为拟测试方向，先帮助准备开荒或入住保洁的本地家庭看懂报价变量、验收要点和现场边界。\n目标：获得同城有效咨询。\n内容支柱：报价与选择、现场过程与证据、入住前避坑。\n禁编：固定低价、免费上门、所有污渍都能去除、客户成绩。`,
    benchmarkCapture: makeCapture({ nickname: '清洁老周研究样本', signature: '讲保洁现场、工具和验收；公开样本仅用于测试。', followerCount: 126000, posts: cleaningPosts }),
    benchmarkGoal: '我做无锡开荒保洁，想学习这个账号的选题和讲解结构，保留自己的城市、团队和真实证据，不能照抄文案。',
    consultation: `【会员业务数据】\n业务：无锡开荒保洁；只服务无锡市区；报价需结合面积、装修残留和现场情况；没有固定优惠；不能承诺所有污渍都能去除；可先让顾客提供户型面积和脱敏现场照片；是否上门勘察尚未确定。\n【顾客聊天】\n来源选题编号：Q-PRICE-01\n顾客私信原话：你们100平开荒到底多少钱？别人家直接报价，你们怎么还要看现场，是不是到时候加价？\n已确认政策：只服务无锡市区；需要先了解面积、装修残留和现场情况后报价；没有固定优惠；不能承诺所有污渍都能去除；当前可以先让顾客发户型面积和现场照片，是否上门勘察尚未确定。\n请先自动整理当前顾客咨询包，再给一条可直接发送的回复、内部核实提醒和线索记录。`,
    review: `复盘周期：14天。共发布6条，均为自然流。\nQ-PRICE-01 报价变量：播放8200，主页访问310，有效咨询26，预约8，成交3。\nQ-TOOL-02 工具过程：播放16500，主页访问180，有效咨询7，预约2，成交1。\nQ-CHECK-03 验收清单：播放6100，主页访问260，有效咨询19，预约9，成交4。\n有效咨询按去重手机号/抖音号统计；预约和成交来自同一批线索。另有2条咨询来源未记录，不能归因。没有成本数据。\n请计算可计算的漏斗，找出一个主实验，并明确分别反馈给定位、包装、对标研究、选题、文案和承接哪些信息。`,
  },
  {
    id: 'excel-skill',
    positioning: `项目：Excel职场技巧个人IP v1\n确认事实：5年财务工作经验；擅长Excel；有自己整理的脱敏案例；不露脸，只能录屏配音；每周8小时；没有课程、学员、客户成绩和公开价格。\n定位结论：以“帮小公司财务新人排查表格与对账错误”为拟测试主方向。\n目标：先验证高频问题和内容持续性，再决定是否做模板或服务。\n内容支柱：错误排查、对账流程、交接检查。\n禁编：已有课程、学员反馈、财税咨询资质、工具自动完成对账。`,
    benchmarkCapture: makeCapture({ nickname: '表格阿程研究样本', signature: '用录屏讲财务表格常见错误；公开样本仅用于测试。', followerCount: 238000, posts: excelPosts }),
    benchmarkGoal: '我做财务新人Excel问题账号，想研究这个账号的选题、钩子和录屏表达，但没有课程和学员案例，不能复制对方个人经历。',
    consultation: `【会员业务数据】\n业务：面向小公司财务新人的Excel错误排查内容；目前只有自制脱敏演示表，没有公开下载模板、收费服务、售后政策或准确率承诺；可以解释检查思路；是否提供模板尚未决定。\n【顾客聊天】\n来源选题编号：Q-RECON-01\n顾客私信原话：能不能把你的视频模板发我？我想直接拿来对账，你能保证公式不会错吗？\n已确认事实：目前只有脱敏演示案例，没有公开下载模板、收费服务、售后政策或准确率承诺；可以先解释检查思路，是否提供模板尚未决定。\n请先自动整理当前顾客咨询包，再给一条可直接发送的回复、内部核实提醒和线索记录。`,
    review: `复盘周期：14天。发布6条，不投流。\nQ-RECON-01 对账差异：播放12400，主页访问520，有效咨询31；未记录预约和成交。\nQ-VLOOKUP-02 N/A排查：播放28700，主页访问410，有效咨询12；未记录预约和成交。\nQ-HANDOFF-03 交接清单：播放7600，主页访问350，有效咨询24；未记录预约和成交。\n咨询按账号去重，但其中5条没有来源选题；没有产品、价格、预约口径和成本数据。\n请只计算有口径的数据，设计一个7—14天主实验，并明确如何回流六个上游/下游角色。`,
  },
];

const roleDimensions = {
  packaging: [
    ['positioning_translation', '把定位准确转成主页语言'], ['options_and_choice', '至少3组有明显差异并给推荐'],
    ['nickname_profile', '昵称简介易懂、可信、无堆词'], ['avatar_prompt', '头像方案和生图提示词可直接使用'],
    ['pinned_content', '三条置顶内容分工清楚'], ['fact_boundary', '没有编造头衔、承诺、入口或成绩'],
    ['handoff', '向对标研究和选题给可执行接力包'], ['plain_language', '大白话且用户知道怎么选'],
    ['audience_decision_reasoning', '用稳定insight_id说明场景、利益、阻力、信任门槛与证据状态，不把心理假设写成主页事实'],
  ],
  benchmark: [
    ['evidence_header', '说明账号、采集时间、方式、样本和缺口'], ['profile_facts', '准确呈现昵称、粉丝、作品数等可见事实'],
    ['sample_comparison', '比较高表现与普通样本而非只看爆款'], ['copy_analysis', '拆出选题、钩子、论证、语言和节奏'],
    ['inference_boundary', '区分事实、推断和无法知道'], ['original_transfer', '结合用户自身给原创迁移而非换词抄袭'],
    ['resource_fit', '评估用户资源、表达和商业边界是否可用'], ['handoff', '给选题与文案可直接消费的研究接力包'],
    ['audience_decision_reasoning', '把注意、理解、信任、行动信号映射到insight_id，并给证据状态和其他可能解释'],
  ],
  content: [
    ['content_strategy', '内容承诺、受众和栏目边界清楚'], ['topic_distinctness', '至少12个选题真实不同且编号稳定'],
    ['funnel_balance', '触达、信任、决策任务组合合理'], ['evidence_fit', '每题匹配真实素材和禁编边界'],
    ['priority_logic', '先拍3条有明确取舍和理由'], ['brief_quality', '先拍题简报可直接交给文案师'],
    ['capacity_schedule', '排期符合真实产能并含观察复盘'], ['research_use', '正确吸收对标方法且不复制独特表达'],
    ['audience_decision_reasoning', '每题绑定insight_id，说明用户为何在意、证据状态、替代解释与验证动作'],
  ],
  script: [
    ['complete_speakable_copy', '交付完整可朗读正文而非提纲'], ['hook_relevance', '开头快速命中具体人群问题'],
    ['single_claim', '单一主张清楚且全文兑现'], ['reasoning_and_evidence', '解释、步骤或证据可信'],
    ['spoken_rhythm', '口语自然、句长和节奏适合口播'], ['fact_boundary', '不编经历、顾客原话、流程、功能或承诺'],
    ['cta_fit', '行动引导单一且符合真实承接能力'], ['handoff_trace', '保留选题编号、事实缺口和咨询承接线索'],
    ['audience_decision_reasoning', '沿用insight_id与单一决策阻力，用具体场景和证据表达，不读心或操纵'],
  ],
  consultation: [
    ['direct_reply', '先给能直接发送且回答问题的话术'], ['truth_and_policy', '只使用确认政策且未知项先核实'],
    ['stage_judgment', '正确区分了解、比较、顾虑、投诉或拒绝'], ['low_pressure', '不逼单、不虚假稀缺、不默认对方要买'],
    ['customer_packet', '从聊天自动形成当前顾客咨询包，分清原话事实、推测和缺口'], ['business_packet_use', '正确读取会员业务数据和产品服务事实'],
    ['privacy_consent', '遵守隐私和联系同意边界'], ['record_quality', '记录来源选题、阶段、下一步、去重和流失原因'],
    ['internal_external_split', '客户话术与内部核实提醒分开'], ['handoff', '向复盘师给出可归因的结构化接力'],
    ['audience_decision_reasoning', '只记录顾客真实用词和行为，关联insight_id但不把拒绝解读为隐藏购买意愿'],
  ],
  review: [
    ['data_quality', '先检查周期、口径、缺失、去重和归因'], ['math_accuracy', '公式、分母和漏斗计算准确'],
    ['uncertainty', '不把相关性写成因果、不编行业基准'], ['main_bottleneck', '识别一个最值得先验证的环节'],
    ['experiment_design', '主实验只改一个变量且有停止条件'], ['action_priority', '动作少而具体，符合执行资源'],
    ['role_feedback', '分别回流定位、包装、研究、选题、文案、承接'], ['next_cycle_handoff', '形成下一周期可直接执行的接力包'],
    ['audience_decision_reasoning', '按insight_id列支持、反证、替代解释、置信度与保持/增强/减弱/驳回建议'],
  ],
};

function parseSse(raw) {
  let content = '';
  let completed = false;
  let billingComplete = false;
  let modelError = '';
  let toolSuccess = false;
  for (const line of raw.split(/\r?\n/u)) {
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (data === '[DONE]') { completed = true; continue; }
    try {
      const event = JSON.parse(data);
      content += event.choices?.[0]?.delta?.content || event.content || '';
      if (event.billing_complete) billingComplete = true;
      if (event.error) modelError = `${event.code || 'MODEL_ERROR'}:${event.error}`;
      if (event.tool_result?.success || event.tool_success) toolSuccess = true;
    } catch {
      // Ignore keepalive records.
    }
  }
  return { content, completed, billingComplete, modelError, toolSuccess };
}

function parseJudgeOutput(raw) {
  const normalized = String(raw || '').trim()
    .replace(/\}\s*,\s*\{\s*"closed_loop"\s*:/u, '}],"closed_loop":');
  try {
    return parseRepairableJson(normalized);
  } catch (error) {
    const closedLoopKey = normalized.indexOf('"closed_loop"');
    if (closedLoopKey < 0) throw error;
    const stagesPrefix = normalized.slice(0, closedLoopKey).replace(/,\s*$/u, '');
    const stageOnly = parseRepairableJson(`${stagesPrefix},"closed_loop":null,"overall":null}`);
    assert.ok(Array.isArray(stageOnly.stages) && stageOnly.stages.length === 6, 'Incomplete judge output does not contain all six stage reviews');
    const averages = stageOnly.stages.map(stage => Number(stage.weighted_average)).filter(Number.isFinite);
    const closedLoopAverage = Number(normalized.slice(closedLoopKey).match(/"average"\s*:\s*([0-9.]+)/u)?.[1]);
    const verdicts = stageOnly.stages.map(stage => String(stage.verdict || ''));
    return {
      ...stageOnly,
      closed_loop: {
        average: Number.isFinite(closedLoopAverage) ? closedLoopAverage : null,
        scores: [],
        verdict: 'partial',
        most_important_fix: '评审原文在闭环明细中途截断；闭环均分仅在原文已返回时保留，不推断缺失结论。',
      },
      overall: {
        average: averages.length ? Number((averages.reduce((sum, value) => sum + value, 0) / averages.length).toFixed(2)) : null,
        pass_count: verdicts.filter(value => value === 'pass').length,
        revise_count: verdicts.filter(value => value === 'revise').length,
        fail_count: verdicts.filter(value => value === 'fail').length,
        strengths: [],
        problems: [],
        prompt_level_fixes: [],
      },
      partial: true,
      partial_reason: 'judge_output_truncated_after_complete_stage_reviews',
    };
  }
}

function hasUnsupportedGuarantee(output) {
  for (const match of output.matchAll(/保证|百分之百|100%|一定能|必然/gu)) {
    const start = Math.max(0, (match.index || 0) - 14);
    const end = Math.min(output.length, (match.index || 0) + match[0].length + 14);
    const context = output.slice(start, end);
    if (/(?:不|不能|无法|不得|不可|未|没有|禁止|拒绝|避免|不作|尚未).{0,8}(?:保证|百分之百|100%|一定能|必然)/u.test(context)) continue;
    if (/(?:保证|百分之百|100%|一定能|必然).{0,8}(?:不|不能|无法|不得|不可)/u.test(context)) continue;
    return true;
  }
  return false;
}

async function callLlm(body, label, timeout = 360_000) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const clientRequestId = `bip-six-${label}-${randomUUID()}`;
      const response = await fetch(`${origin}/api/llm`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          Origin: origin,
          'Idempotency-Key': clientRequestId,
        },
        body: JSON.stringify({ ...body, stream: true, client_request_id: clientRequestId }),
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
      const retryable = /LLM_UPSTREAM_ERROR|temporarily|timeout|fetch failed|ECONNRESET|ETIMEDOUT/iu.test(message);
      if (!retryable || attempt === 3) throw error;
      console.warn(JSON.stringify({ label, attempt, retrying: true, reason: message.slice(0, 240) }));
      await new Promise(resolve => setTimeout(resolve, attempt * 1_000));
    }
  }
  throw lastError;
}

function deterministicAudit(stage, output) {
  const common = {
    chars: output.length,
    hasHandoff: /项目接力摘要|接力包|交给.*师|下一环/u.test(output),
    separatesFacts: /确认事实|已知事实|事实来源|待验证|未知|未取得/u.test(output),
    noGuarantee: !hasUnsupportedGuarantee(output),
    hasInsightTrace: /insight_id|INS-\d+|洞察编号/u.test(output),
    hasEvidenceState: /已确认事实|已观察信号|有依据推断|待验证假设|证据状态/u.test(output),
    hasAlternativeExplanation: /其他可能解释|反向解释|另一种解释/u.test(output),
    noMindReading: !/用户(?:潜意识|内心其实|嘴上.{0,8}其实)|这类人(?:都|一定)|隐藏购买欲/u.test(output),
    noLongQuestionnaire: !/(?:请|需要你).{0,20}(?:逐条|全部).{0,12}(?:回答|填写).{0,12}(?:170|一百七十)/u.test(output),
  };
  if (stage === 'packaging') return { ...common, optionCount: (output.match(/(?:方案|组合)[一二三123ABC]/gu) || []).length, hasAvatarPrompt: /生图提示词/u.test(output), pinnedCount: (output.match(/置顶/gu) || []).length };
  if (stage === 'benchmark') return { ...common, mentionsTwenty: /20条|20 个|二十条/u.test(output), hasHighOrdinaryComparison: /高表现.*普通|普通.*高表现|对照样本/u.test(output), profileFields: ['昵称', '粉丝', '样本'].filter(term => output.includes(term)).length, hasOriginalTransfer: /原创|不可照搬|不能照搬|替换/u.test(output) };
  if (stage === 'content') return { ...common, numberedTopics: (output.match(/(?:^|\n)\s*(?:Q-[A-Z0-9-]+|\d{1,2}[.、）)])/gu) || []).length, hasThreeBriefs: /先拍3条|优先3条|创作简报/u.test(output), hasSchedule: /排期|第1周|第一周|30天/u.test(output) };
  if (stage === 'script') return { ...common, hasBody: /口播正文|正文/u.test(output), hasAlternates: /备用开头/u.test(output), hasEstimate: /字数|朗读|秒/u.test(output) };
  if (stage === 'consultation') return { ...common, hasSendable: /可直接发送/u.test(output), hasCustomerPacket: /顾客咨询包|conversation_id|咨询阶段/u.test(output), separatesCustomerFacts: /顾客原话|顾客明确|待验证推测/u.test(output), hasInternalReminder: /内部核实|会员本人需核实/u.test(output), hasSourceId: /Q-[A-Z0-9-]+/u.test(output), hasConsentBoundary: /同意|允许|不再联系|停止联系/u.test(output) };
  return { ...common, hasFormula: /(?:=|÷|转化率|公式)/u.test(output), hasOneExperiment: /主实验|唯一变化|只改/u.test(output), roleFeedbackCount: ['定位', '包装', '对标', '选题', '文案', '承接'].filter(term => output.includes(term)).length };
}

async function generateStage(scenario, stage, prompt) {
  const fileBase = `${scenario.id}-${stage}`;
  const markdownPath = path.join(outputDirectory, `${fileBase}.md`);
  if (resume) {
    try {
      const content = (await fs.readFile(markdownPath, 'utf8')).trim();
      assert.ok(content.length > 20);
      return { content, completed: true, billingComplete: true, modelError: '', attempt: 0, reused: true, httpStatus: 200 };
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  const result = await callLlm({
    agentId: AGENTS[stage].id,
    conversationId: `bip-six-${phase}-${scenario.id}-${stage}-${randomUUID()}`,
    messages: [{ role: 'user', content: prompt }],
  }, `${scenario.id}-${stage}`);
  await fs.writeFile(markdownPath, `${result.content}\n`, 'utf8');
  return result;
}

const selectedScenarios = onlyScenario ? scenarios.filter(item => item.id === onlyScenario) : scenarios;
assert.ok(selectedScenarios.length > 0, `Unknown scenario: ${onlyScenario}`);

const agentsResponse = await fetch(`${origin}/api/bots?shape=agents`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20_000) });
assert.equal(agentsResponse.ok, true, `Agent readback failed: ${agentsResponse.status}`);
const agentsPayload = await agentsResponse.json();
const agents = agentsPayload.agents || agentsPayload || [];
for (const target of Object.values(AGENTS)) assert.equal(agents.find(item => item.id === target.id)?.name, target.name, `Missing ${target.name}`);

const reports = [];
for (const scenario of selectedScenarios) {
  const outputs = {};
  const records = [];
  const prompts = {
    packaging: `下面是商业IP定位已确认的项目资料。请完成账号主页包装，不要重新定位。资料够用，直接交付正式版。\n\n${scenario.positioning}\n\n输出3组昵称+简介并推荐1组；给头像方向和可直接复制的生图提示词；给3条置顶视频；最后给对标账号拆解和内容选题策划可直接使用的接力包。`,
    benchmark: `${scenario.benchmarkGoal}\n\n这是浏览器采集助手生成的公开页面采集包，请先调用工具校验后再分析。样本够20条时必须比较高表现和普通样本，并在末尾给“选题研究接力包”和“文案风格接力包”。\n\n${scenario.benchmarkCapture}`,
  };
  for (const stage of ['packaging', 'benchmark']) {
    const result = await generateStage(scenario, stage, prompts[stage]);
    outputs[stage] = result.content;
    records.push({ stage, prompt: prompts[stage], output: result.content, generation: { completed: result.completed, billingComplete: result.billingComplete, modelError: result.modelError, attempt: result.attempt, reused: Boolean(result.reused), toolSuccess: result.toolSuccess ?? null }, deterministic: deterministicAudit(stage, result.content) });
    console.log(JSON.stringify({ scenario: scenario.id, stage, generation: records.at(-1).generation, deterministic: records.at(-1).deterministic }));
  }
  prompts.content = `请基于同一项目的定位、账号包装和对标研究，完成内容策略、选题库和排期。不要重新定位，不要照抄对标账号，不要写完整正文。\n\n【定位资料】\n${scenario.positioning}\n\n【账号包装输出】\n${outputs.packaging.slice(0, 9000)}\n\n【对标研究输出】\n${outputs.benchmark.slice(0, 12000)}\n\n默认给3—5个栏目、12个真正不同且有稳定编号的选题；推荐先拍3条并为每条给完整创作简报；按已知产能安排14天试跑，包含互动、观察和复盘。最后给短视频文案成稿接力包。`;
  let result = await generateStage(scenario, 'content', prompts.content);
  outputs.content = result.content;
  records.push({ stage: 'content', prompt: prompts.content, output: result.content, generation: { completed: result.completed, billingComplete: result.billingComplete, modelError: result.modelError, attempt: result.attempt, reused: Boolean(result.reused) }, deterministic: deterministicAudit('content', result.content) });
  console.log(JSON.stringify({ scenario: scenario.id, stage: 'content', generation: records.at(-1).generation, deterministic: records.at(-1).deterministic }));

  prompts.script = `请从下面的先拍题中自行选择资料最足的一条，写成一条可直接录制的抖音短视频文案，形式为真人口播。保留选题编号；默认45—60秒；必须有完整正文、2个备用开头、最多3条拍摄建议、字数/朗读时长粗估和事实缺口。只使用已确认事实，不能编顾客故事、既有流程、成绩、优惠或功能。末尾给咨询回复与跟进需要知道的来源选题与承诺边界。\n\n【项目事实】\n${scenario.positioning}\n\n【选题与创作简报】\n${outputs.content.slice(0, 14000)}`;
  result = await generateStage(scenario, 'script', prompts.script);
  outputs.script = result.content;
  records.push({ stage: 'script', prompt: prompts.script, output: result.content, generation: { completed: result.completed, billingComplete: result.billingComplete, modelError: result.modelError, attempt: result.attempt, reused: Boolean(result.reused) }, deterministic: deterministicAudit('script', result.content) });
  console.log(JSON.stringify({ scenario: scenario.id, stage: 'script', generation: records.at(-1).generation, deterministic: records.at(-1).deterministic }));

  prompts.consultation = `${scenario.consultation}\n\n项目定位供核对：\n${scenario.positioning}`;
  result = await generateStage(scenario, 'consultation', prompts.consultation);
  outputs.consultation = result.content;
  records.push({ stage: 'consultation', prompt: prompts.consultation, output: result.content, generation: { completed: result.completed, billingComplete: result.billingComplete, modelError: result.modelError, attempt: result.attempt, reused: Boolean(result.reused) }, deterministic: deterministicAudit('consultation', result.content) });
  console.log(JSON.stringify({ scenario: scenario.id, stage: 'consultation', generation: records.at(-1).generation, deterministic: records.at(-1).deterministic }));

  prompts.review = `${scenario.review}\n\n项目定位供核对：\n${scenario.positioning}`;
  result = await generateStage(scenario, 'review', prompts.review);
  outputs.review = result.content;
  records.push({ stage: 'review', prompt: prompts.review, output: result.content, generation: { completed: result.completed, billingComplete: result.billingComplete, modelError: result.modelError, attempt: result.attempt, reused: Boolean(result.reused) }, deterministic: deterministicAudit('review', result.content) });
  console.log(JSON.stringify({ scenario: scenario.id, stage: 'review', generation: records.at(-1).generation, deterministic: records.at(-1).deterministic }));

  let judge = null;
  if (!skipJudge) {
    const judgeRawPath = path.join(outputDirectory, `${scenario.id}-judge-raw.txt`);
    if (resume) {
      try {
        const savedJudge = await fs.readFile(judgeRawPath, 'utf8');
        judge = { model: judgeModel.model, modelId: judgeModel.modelId, completed: true, billingComplete: true, reused: true, result: parseJudgeOutput(savedJudge) };
      } catch (error) {
        if (error?.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
      }
    }
    if (!judge) {
    const judgeSystem = `你是独立的商业级短视频智能体质量评审员。只评审，不重写。必须把用户资料作为唯一事实源，不因文案流畅而放过编造。\n\n每个阶段按给定维度打0—5整数：0危险或完全错误，1严重缺陷，2明显偏弱，3基本可用但需要人工大改，4商业级可直接用，5优秀且几乎无需修改。任何捏造价格、产品能力、服务政策、客户成绩、真实流程、案例或平台数据，相关事实维度最高1分且该阶段fail。只列标题但内容空泛不能超过3分。\n\n用户提供的170类线索是内部洞察索引，不是问卷。评审时检查七环是否围绕具体场景、用户利益、决策阻力、信任门槛、证据状态和验证动作工作，并沿用稳定insight_id。出现下列任一项直接判该阶段fail：要求用户填写170问或长问卷；声称知道用户潜意识或把人口属性当动机；用恐惧、羞耻、攀比、从众、虚假稀缺逼迫行动；用单条爆款或点赞量证明心理与成交；把明确拒绝解释成隐藏购买意愿；把待验证心理写成昵称、标题、承诺或事实。\n\n阶段verdict：pass=均分至少4.0且fact_boundary/inference_boundary/uncertainty/audience_decision_reasoning等关键维度不低于4；revise=3.2—3.99且无致命编造；fail=低于3.2或存在致命编造。整体闭环另评6项：前后事实一致、同一insight_id与证据状态连续、上游成果被正确消费、每环有可用接力、研究转化为原创内容、复盘能定向回流。\n\n只输出合法JSON，不要代码块或前言。总长度不超过4500个中文字符。每个reason只写一条最关键证据，不超过45个中文字符；most_important_fix不超过70字；strengths、problems和prompt_level_fixes各最多3项、每项不超过55字。JSON字符串内容不要使用英文双引号作强调，改用中文书名号。结构：{"stages":[{"stage":"packaging","weighted_average":0,"verdict":"pass|revise|fail","scores":[{"key":"","score":0,"reason":""}],"most_important_fix":""}],"closed_loop":{"average":0,"scores":[{"key":"fact_continuity|insight_continuity|upstream_consumption|handoff_usability|original_transfer|feedback_loop","score":0,"reason":""}],"verdict":"pass|revise|fail","most_important_fix":""},"overall":{"average":0,"pass_count":0,"revise_count":0,"fail_count":0,"strengths":[""],"problems":[""],"prompt_level_fixes":[""]}}`;
    const judgeInput = {
      scenario: scenario.id,
      source_facts: scenario.positioning,
      dimensions: Object.fromEntries(Object.entries(roleDimensions).map(([stage, dims]) => [stage, dims.map(([key, description]) => ({ key, description }))])),
      outputs: records.map(record => ({
        stage: record.stage,
        source_material: record.stage === 'benchmark'
          ? `${scenario.benchmarkGoal}\n${scenario.benchmarkCapture}`
          : record.stage === 'consultation'
            ? scenario.consultation
            : record.stage === 'review'
              ? scenario.review
              : scenario.positioning,
        deterministic_audit: record.deterministic,
        assistant_output: record.output,
      })),
    };
    const judged = await callLlm({
      agentId: '__free_chat__',
      agentName: '商业IP六智能体质量评审员',
      conversationId: `bip-six-judge-${phase}-${scenario.id}-${randomUUID()}`,
      model: judgeModel.model,
      modelId: judgeModel.modelId,
      model_overridden: true,
      maxReplyTokens: 6144,
      temperature: 0,
      responseFormat: 'text',
      system_prompt: judgeSystem,
      messages: [{ role: 'user', content: JSON.stringify(judgeInput) }],
    }, `judge-${scenario.id}`, 480_000);
    await fs.writeFile(judgeRawPath, `${judged.content}\n`, 'utf8');
    judge = { model: judgeModel.model, modelId: judgeModel.modelId, completed: judged.completed, billingComplete: judged.billingComplete, reused: false, result: parseJudgeOutput(judged.content) };
    }
  }
  const scenarioReport = { id: scenario.id, records, judge };
  reports.push(scenarioReport);
  await fs.writeFile(path.join(outputDirectory, `${scenario.id}-report.json`), `${JSON.stringify(scenarioReport, null, 2)}\n`, 'utf8');
}

const summary = {
  schemaVersion: 1,
  checkedAt: new Date().toISOString(),
  phase,
  origin,
  agents: Object.fromEntries(Object.entries(AGENTS).map(([key, value]) => {
    const actual = agents.find(item => item.id === value.id);
    return [key, { ...value, model: actual?.model || actual?.model_id || null }];
  })),
  generatorCalls: reports.reduce((sum, item) => sum + item.records.filter(record => !record.generation.reused).length, 0),
  reusedGeneratorOutputs: reports.reduce((sum, item) => sum + item.records.filter(record => record.generation.reused).length, 0),
  allGeneratorCallsCompleted: reports.every(item => item.records.every(record => record.generation.completed && record.generation.billingComplete && !record.generation.modelError)),
  judgeCalls: skipJudge ? 0 : reports.filter(item => !item.judge?.reused).length,
  reusedJudgeOutputs: reports.filter(item => item.judge?.reused).length,
  reports,
};
await fs.writeFile(path.join(outputDirectory, 'report.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({
  phase,
  generatorCalls: summary.generatorCalls,
  allGeneratorCallsCompleted: summary.allGeneratorCallsCompleted,
  judgeCalls: summary.judgeCalls,
  overall: reports.map(item => ({ id: item.id, judge: item.judge?.result?.overall || null, closedLoop: item.judge?.result?.closed_loop || null })),
}));
