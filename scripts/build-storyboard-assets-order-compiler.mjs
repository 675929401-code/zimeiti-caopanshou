import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { STORYBOARD_AGENT_PROMPT, STORYBOARD_AGENT_SETTING_KEY } from '../src/lib/storyboard-workbench.ts';

const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const candidatePath = process.argv[2];
assert.match(candidatePath || '', /^prompts\/storyboard-high-energy-assets-order-B-v[3456]\.md$/u);
const revisionSix = candidatePath.endsWith('-v6.md');
const refreshV6Candidate = process.argv[3] === '--refresh-v6-candidate';
assert.ok(process.argv.length <= 4 && (!process.argv[3] || refreshV6Candidate && revisionSix), '仅v6未冻结候选允许显式刷新');
const candidate = await fs.readFile(candidatePath, 'utf8');
const split = candidate.lastIndexOf('# 固定输出格式');
assert.ok(split > 0);
let methods = candidate.slice(0, split)
  .replace('全部结果直接作为最终文本返回完整Markdown', '全部结果直接作为最终文本返回完整JSON');
const start = STORYBOARD_AGENT_PROMPT.indexOf('# 输入变量');
const end = STORYBOARD_AGENT_PROMPT.indexOf('# 四层控制架构');
const protocolStart = STORYBOARD_AGENT_PROMPT.indexOf('# 固定输出格式');
assert.ok(start >= 0 && end > start && protocolStart > end);
let inputs = STORYBOARD_AGENT_PROMPT.slice(start, end);
let protocol = STORYBOARD_AGENT_PROMPT.slice(protocolStart);
let revisionSixMapping = '';
let revisionSixAudit = null;
if (revisionSix) {
  const replaceRequired = (text, before, after) => {
    assert.ok(text.includes(before), `v6映射原句缺失：${before}`);
    return text.replace(before, after);
  };
  methods = replaceRequired(methods, '只返回完整Markdown文字', '只返回一个完整合法JSON对象');
  methods = replaceRequired(methods, '每项人物/宠物资产对外只写“名称｜类别｜一句参考用途”，随后一个完整可复制的text代码框。',
    '每项实际人物/宠物资产写入visualAssetPlan.assets；名称、类别、用途分别映射name、role和referencePrompts[].purpose，完整身份参考内容写referencePrompts[].prompt，不输出text代码框。');
  methods = replaceRequired(methods, '每段两个代码框开头写选中风格及1至2个可见造型/材质指纹',
    '每段storyboardImagePrompt和首个beat.videoPrompt开头写选中风格及1至2个可见造型/材质指纹');
  methods = replaceRequired(methods, '每段视频框第一句包含选定风格与紧凑指纹、完整故事板为唯一图片参考、所选时长比例和全屏动画。',
    '每段首个beat.videoPrompt第一句包含选定风格与紧凑指纹、完整故事板为唯一图片参考、所选时长比例和全屏动画；其它beat只继续同一时间动作链，不重复整段开场。');
  methods = replaceRequired(methods, '每个视频代码框都必须独立携带声音禁止项，不能只写在框外、系统说明或省成“现场声”。中文路线固定末句逐字为：',
    '每段最后一个beat.videoPrompt必须在字符串末尾独立携带固定中文声音末句，不能只写在JSON字段外、系统说明或省成“现场声”。固定末句逐字为：');
  methods = replaceRequired(methods, '英文路线固定末句逐字为：\nNo dialogue. No narration. No background music. Humans and animals do not speak, read aloud, or make continuous speech-like mouth movements. Only scene-consistent natural ambience and physical action sounds.\n', '');
  methods = replaceRequired(methods, '这条末句位于视频代码框内、结束代码围栏之前，每段重复，不能因字数目标省略。',
    '这条末句位于每段最后一个beat.videoPrompt字符串末尾，每段恰好一次；其它beat不重复整段开场或末句，不能因字数目标省略。');
  const routesStart = methods.indexOf('# 同一故事的四种模型表达');
  const routesEnd = methods.indexOf('# 输出前核对与证据边界');
  assert.ok(routesStart >= 0 && routesEnd > routesStart);
  methods = `${methods.slice(0, routesStart)}# 本JSON入口的视频执行路线\n只采用自动通用中文执行路线，不输出聊天版其它视频模型的专用结构；将同一动作链按时间写入beats[].videoPrompt，最后一个beat以固定中文声音末句结束。\n\n${methods.slice(routesEnd)}`;
  methods = replaceRequired(methods, '每个视频框以对应语言固定声音句结尾', '每段最后一个beat.videoPrompt以固定中文声音句结尾');
  inputs = replaceRequired(inputs, '- referenceAssets：可选的角色或场景参考图；没有参考图时用描述锁定具体视觉资产。',
    '- referenceAssets：默认只用实际出场的人物、宠物身份参考；用户明确启用场景或其它参考时可追加，已有真实商品图可选。没有实际参考图时用文字锁定，不伪造图片或商品细节。');
  inputs = replaceRequired(inputs, '- visualAssetMode：视觉资产工作流开关。off 时只用文字资产锁定；selected 时先生成/确认角色、宠物、环境或道具资产，再把已确认资产绑定到对应分镜生图卡。',
    '- visualAssetMode：视觉资产工作流开关。off 时只用文字锁定，资产和引用数组为空；selected 时默认只为实际人物、宠物提出或沿用身份参考。普通场景、道具保持文字变量；用户在现有备注明确启用场景参考或主动选择已有场景图时，才额外纳入场景。其它道具参考同样须明确要求，真实商品图可选沿用。');
  const jsonStart = protocol.indexOf('\n{') + 1;
  assert.ok(jsonStart > 0, '原工作台JSON模板缺失');
  const example = JSON.parse(protocol.slice(jsonStart).trim());
  const assetFields = Object.keys(example.visualAssetPlan.assets[0]);
  example.visualAssetPlan = { mode: 'off', assets: [] };
  for (const segment of example.segments) segment.visualAssetRefs = [];
  let intro = protocol.slice(0, jsonStart);
  intro = replaceRequired(intro, '资产计划只负责提出人物、宠物、场景和必要道具的身份锁定与参考板提示词',
    '资产计划默认只提出实际人物、宠物身份参考；普通场景和道具写入文字变量，用户明确启用场景或额外道具参考时才追加；已有真实商品图按真实ID可选沿用');
  protocol = `${intro}${JSON.stringify(example, null, 2)}\n\n# selected模式资产字段合同\nvisualAssetMode=selected时每项资产保留现有字段${assetFields.join('、')}，role只用character/pet/environment/prop，referencePrompts保留kind、purpose、prompt。默认一人一宠各一个参考板；纯环境不补人宠。用户主动选择已有场景/道具资产等同明确启用该项，不能顺带自动增加其它资产。已选列表非空时，asset.id及visualAssetRefs[].assetId只沿用selectedVisualAssets真实ID。真实商品用role=prop；referencePrompts虽按现有schema必填，内容只写沿用该真实商品图的故事板融合指令、比例与接触关系，不要求生成替代商品参考，不编品牌、上传状态或费用。未实际读到商品图细节时以真实图为准，不杜撰外观。\n`;
  revisionSixMapping = '\n本JSON入口的首个beat.videoPrompt负责风格指纹、完整故事板唯一参考、时长比例及全屏动画开场；后续beat仅接续时间动作；最后一个beat.videoPrompt末尾逐字放固定中文声音末句。每段合并后只有一个开场和一个声音末句，不能每个beat复写整段。\n';
  assert.deepEqual(example.visualAssetPlan, { mode: 'off', assets: [] });
  assert.ok(example.segments.every(segment => segment.visualAssetRefs.length === 0));
  assert.ok(!methods.includes('只返回完整Markdown文字'));
  revisionSixAudit = { jsonExampleParsePassed: true, offExampleAssetsEmpty: true, offExampleRefsEmpty: true,
    selectedAssetFieldsPreserved: assetFields, optionalSceneAndRealProductPreserved: true, firstAndLastBeatResponsibilitiesMapped: true };
}
const prompt = `# 独立分镜编译器：JSON输出合同
这是服务端分镜编译器，输出与主站聊天版分开。使用下述同一导演方法，但机器响应始终只有一个合法JSON对象，不输出Markdown、代码框、框外原文或分析；“全局资产先行、每段生图框在前视频框在后”由宿主按JSON字段渲染。
输入sourceText/已给segments对应聊天版segmented_copy；targetDuration对应segment_duration；aspectRatio对应video_ratio；visualStyle对应animation_style。未提供主人/犬种时按原文识别后使用未指定项默认，不创建第二套接收卡。此入口没有video_model_profile时按自动通用编译。
${inputs}
下述方法中的“资产提示词代码框”在本入口映射为visualAssetPlan.assets[].referencePrompts[].prompt；段落原文映射为segments[].narration，生图正文为storyboardImagePrompt，视频执行正文分配到按时间排序的beats[].videoPrompt。不要将两个输出协议混用。
${revisionSixMapping}\
${methods}
${protocol}

# 最终机器门禁（本入口唯一输出协议）
上述Markdown/双代码框只描述宿主显示顺序；响应正文必须是JSON。严格使用模板字段、现行version、原文顺序和8/10/15秒参数。visualAssetMode=off时visualAssetPlan.mode=off、assets=[]、所有visualAssetRefs=[]，身份仍写入characterBible/environmentBible。selected且没有已确认资产时可以提出最小待确认计划，但所有visualAssetRefs=[]；已选资产非空时只引用其真实ID，不编造绑定、生成或费用。textLayoutMode=visual-only时图和视频均不要求生成文字；advanced-text-layout仅预留后置排版安全区。各beat的视频文字从同一动作链按时间分配，不重复生成整段故事，不漏原文核心操作。不要调用工具。
`;
assert.ok(prompt.length < 50000 && prompt.includes('visualAssetPlan') && prompt.includes('storyboardImagePrompt'));
const destination = candidatePath.replace('storyboard-high-energy-assets-order-B-', 'storyboard-workbench-assets-order-compiler-');
try { await fs.writeFile(destination, prompt, { flag: refreshV6Candidate ? 'w' : 'wx' }); }
catch (error) { if (error.code !== 'EEXIST') throw error; assert.equal(await fs.readFile(destination, 'utf8'), prompt); }
console.log(JSON.stringify({ path: destination, settingKey: STORYBOARD_AGENT_SETTING_KEY, parentPromptSha256: sha(candidate.trim()), sha256: sha(prompt.trim()), characters: prompt.trim().length, protocolFieldsPreserved: true,
  ...(revisionSixAudit ? { revisionSixMapping: revisionSixAudit } : {}), stableConfigurationWrites: 0, providerCalls: 0 }, null, 2));
